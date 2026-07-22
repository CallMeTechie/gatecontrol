'use strict';

const skodaAuth = require('./skodaAuth');
const { SkodaClient } = require('./skodaClient');
const accounts = require('./skodaAccounts');
const vehicles = require('./skodaVehicles');
const owners = require('./skodaOwners');
const settings = require('../settings');
const license = require('../license');
const logger = require('../../utils/logger');

const FEATURE = 'skoda_integration';
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const BACKOFF_START_MIN = 60;
const BACKOFF_CAP_MIN = 240;

let pollTimer = null;
let pollRunning = false;
let lastSyncAt = null;
// ponytail: both maps grow one entry per vehicle/account ever touched — fine
// for a two-car household, add cleanup if the fleet ever grows.
const refreshCooldown = new Map(); // vehicleId -> ts
const accountLocks = new Map(); // accountId -> promise chain tail

// Serializes poller, manual refresh and account removal per account —
// mirrors midea's withDeviceLock. Prevents parallel syncs racing the
// session refresh (single-use refresh tokens) and delete-during-sync.
function withAccountLock(id, fn) {
  const prev = accountLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  accountLocks.set(id, next.catch(() => {}));
  return next;
}

function pollIntervalMs() {
  return Math.max(5, Number(settings.get('skoda_poll_interval_min', '15')) || 15) * 60000;
}

function clientFor(account, fetchImpl) {
  return new SkodaClient({
    getSession: () => accounts.getAccountWithSecrets(account.id).session,
    saveSession: (tokens) => accounts.saveSession(account.id, tokens),
    fetchImpl: fetchImpl || fetch,
  });
}

async function ensureSession(account, fetchImpl) {
  if (account.session && account.session.accessToken) return;
  const tokens = await skodaAuth.login(account.email, account.password, { fetchImpl: fetchImpl || fetch });
  accounts.saveSession(account.id, tokens);
}

function firstRenderUrl(vehicleInfo) {
  const renders = (vehicleInfo && vehicleInfo.compositeRenders) || [];
  for (const render of renders) {
    for (const layer of (render && render.layers) || []) {
      if (layer && layer.url) return layer.url;
    }
  }
  return null;
}

async function syncVehicle(client, accountId, garageEntry) {
  const row = vehicles.upsertVehicle(accountId, garageEntry);
  const { state } = await client.fetchFullState(garageEntry.vin);
  vehicles.saveState(row.id, state);

  // Render image: fetch once, refetch only when the url changes.
  try {
    const info = await client.vehicleInfo(garageEntry.vin);
    const url = firstRenderUrl(info);
    if (url && (!row.image || row.image_url !== url)) {
      vehicles.saveImage(row.id, await client.renderImage(url), url);
    }
  } catch (e) {
    logger.warn({ err: e.message, vin: garageEntry.vin }, 'skoda render image fetch failed');
  }
}

function syncAccount(accountId, { fetchImpl } = {}) {
  return withAccountLock(accountId, () => syncAccountLocked(accountId, { fetchImpl }));
}

async function syncAccountLocked(accountId, { fetchImpl } = {}) {
  let account = null;
  try {
    // Inside try: a corrupt session_enc (decrypt/JSON.parse throw) must mark
    // THIS account as broken, not blow up the whole syncAll loop.
    account = accounts.getAccountWithSecrets(accountId);
    if (!account) return { ok: false, error: 'not found' };
    await ensureSession(account, fetchImpl);
    const client = clientFor(account, fetchImpl);
    const garage = await client.garage();
    const entries = (garage && garage.vehicles) || [];
    for (const entry of entries) await syncVehicle(client, accountId, entry);
    accounts.setStatus(accountId, 'ok', null, { backoffMin: 0, nextRetryAt: null });
    lastSyncAt = new Date().toISOString();
    return { ok: true, vehicles: entries.length };
  } catch (e) {
    if (e.code === 'SKODA_RATE_LIMITED') {
      const prev = (account && account.backoff_min) || 0;
      const backoffMin = prev ? Math.min(prev * 2, BACKOFF_CAP_MIN) : BACKOFF_START_MIN;
      const nextRetryAt = new Date(Date.now() + backoffMin * 60000).toISOString();
      accounts.setStatus(accountId, 'rate_limited', 'HTTP 429', { backoffMin, nextRetryAt });
    } else if (e.code === 'SKODA_LOGIN_FAILED' || e.code === 'SKODA_TERMS_REQUIRED' || e.code === 'SKODA_AUTH_FLOW_CHANGED') {
      accounts.saveSession(accountId, null); // drop stale session, force fresh login after fix
      accounts.setStatus(accountId, 'login_failed', `${e.code}: ${e.message}`);
    } else if (e.code === 'SKODA_UNAUTHORIZED') {
      // expired/invalid session: drop it and let the next tick re-login with the stored password
      accounts.saveSession(accountId, null);
      accounts.setStatus(accountId, 'error', `${e.code}: ${e.message}`);
    } else {
      accounts.setStatus(accountId, 'error', e.message);
    }
    logger.warn({ err: e.message, code: e.code, accountId }, 'skoda sync failed');
    return { ok: false, error: e.message };
  }
}

async function syncAll({ fetchImpl, ignoreRetryAt = false } = {}) {
  for (const acc of accounts.listAccounts()) {
    if (acc.status === 'login_failed') continue;
    if (!ignoreRetryAt && acc.status === 'rate_limited' && acc.next_retry_at && new Date(acc.next_retry_at) > new Date()) continue;
    await syncAccount(acc.id, { fetchImpl });
  }
}

async function refreshVehicle(vehicleId, { fetchImpl } = {}) {
  const last = refreshCooldown.get(vehicleId) || 0;
  if (Date.now() - last < REFRESH_COOLDOWN_MS) {
    const e = new Error('refresh cooldown active');
    e.code = 'SKODA_REFRESH_COOLDOWN';
    throw e;
  }
  const accountId = vehicles.accountIdOf(vehicleId);
  if (!accountId) { const e = new Error('vehicle not found'); e.code = 'SKODA_VEHICLE_NOT_FOUND'; throw e; }
  refreshCooldown.set(vehicleId, Date.now());
  return syncAccount(accountId, { fetchImpl });
}

function removeAccount(accountId) {
  // Wait for any in-flight sync of this account before deleting, otherwise the
  // sync re-inserts vehicle rows for an account that no longer exists.
  return withAccountLock(accountId, () => accounts.removeAccount(accountId));
}

function getStatus() {
  const vehicleList = vehicles.listRedacted().map((v) => ({ ...v, owners: owners.ownersOf(v.id) }));
  return { accounts: accounts.listAccounts(), vehicles: vehicleList, lastSyncAt };
}

function getVehicleImage(vehicleId) {
  return vehicles.getImage(vehicleId);
}

function pollTick() {
  if (!license.hasFeature(FEATURE)) return;
  if (pollRunning) return; // skip tick while a previous run is still going
  if (!accounts.listAccounts().length) return;
  pollRunning = true;
  syncAll()
    .catch((e) => logger.warn({ err: e.message }, 'skoda poll failed'))
    .finally(() => { pollRunning = false; });
}

function startPolling() {
  if (pollTimer) return;
  if (!license.hasFeature(FEATURE)) return;
  pollTimer = setInterval(pollTick, pollIntervalMs());
  pollTimer.unref();
  pollTick();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function _resetForTest() { stopPolling(); refreshCooldown.clear(); accountLocks.clear(); pollRunning = false; lastSyncAt = null; }

module.exports = {
  syncAccount, syncAll, refreshVehicle, removeAccount, getStatus, getVehicleImage,
  startPolling, stopPolling, pollTick, pollIntervalMs, _resetForTest,
};
