'use strict';

// On-demand, read-only enrichment aggregator for the Skoda vehicle cards.
// Fetched lazily (on card expand), NOT part of the 15-min poller sync. Runs the
// cloud calls under the per-account lock (no refresh-token race with the poller)
// and dedupes concurrent expands so two tabs share one roundtrip.
//
// Live-verified field shapes (2026-07-23, both real cars). software/OTA,
// charging history and trip statistics return 500/403 for these vehicles and are
// deliberately NOT fetched here.

const accounts = require('./skodaAccounts');
const vehicles = require('./skodaVehicles');
const skoda = require('./index');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();    // vehicleId -> { at, value?, errCode? }
const inflight = new Map(); // vehicleId -> Promise<full admin-form value>

function err(message, code) { const e = new Error(message); e.code = code; return e; }
function maskVin(vin) { return vin && vin.length >= 4 ? '***' + vin.slice(-4) : null; }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null));

// Single endpoint failure → null, but account-level errors abort the whole call
// (same contract as skodaClient.fetchFullState).
async function tryPart(job) {
  try { return await job(); } catch (e) {
    if (e.code === 'SKODA_RATE_LIMITED' || e.code === 'SKODA_UNAUTHORIZED') throw e;
    return null;
  }
}

function normMeta(info, vin, forAdmin) {
  const spec = (info && info.vehicleSpecification) || null;
  if (!spec) return { model: null, title: null, modelYear: null, manufacturingDate: null, body: null, trimLevel: null, powerKw: null, batteryKwh: null, maxChargingKw: null, vin: forAdmin ? (vin || null) : maskVin(vin) };
  return {
    model: spec.model || null,
    title: spec.title || null,
    modelYear: spec.modelYear || null,
    manufacturingDate: spec.manufacturingDate || null,
    body: spec.body || null,
    trimLevel: spec.trimLevel || null,
    powerKw: num(spec.engine && spec.engine.powerInKW),
    batteryKwh: num(spec.battery && spec.battery.capacityInKWh),
    maxChargingKw: num(spec.maxChargingPowerInKW),
    vin: forAdmin ? (vin || null) : maskVin(vin),
  };
}

function normEquipment(equip) {
  const list = equip && Array.isArray(equip.equipment) ? equip.equipment : [];
  return list.map((e) => e && e.name).filter(Boolean).map(String).slice(0, 40);
}

function normConnection(conn) {
  if (!conn) return null;
  return {
    online: conn.unreachable != null ? !conn.unreachable : null,
    ignitionOn: conn.ignitionOn != null ? !!conn.ignitionOn : null,
    inMotion: conn.inMotion != null ? !!conn.inMotion : null,
  };
}

function normScore(score) {
  if (!score) return null;
  const pick = (p) => (p && p.main != null ? num(p.main) : null);
  const weekly = pick(score.weeklyScore), monthly = pick(score.monthlyScore);
  if (weekly == null && monthly == null) return null;
  return { weekly, monthly, lastCalculationDate: score.lastCalculationDate || null };
}

// Always fetch/cache the full ADMIN form (full VIN). Callers get redacted via serve().
async function fetchDetails(vehicleId, fetchImpl) {
  const accountId = vehicles.accountIdOf(vehicleId);
  if (!accountId) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');
  const row = vehicles.listRedacted().find((v) => v.id === vehicleId);
  const vin = row && row.vin;
  if (!vin) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');

  const account = accounts.getAccountWithSecrets(accountId);
  if (!account || !account.session || !account.session.accessToken) {
    throw err('account has no active session — re-sync/re-login required', 'SKODA_NO_SESSION');
  }

  return skoda.withAccountLock(accountId, async () => {
    const c = skoda.clientForAccount(accountId, fetchImpl);
    const info = await tryPart(() => c.vehicleInformation(vin));
    const equip = await tryPart(() => c.equipment(vin));
    const conn = await tryPart(() => c.connectionStatus(vin));
    const score = await tryPart(() => c.drivingScore(vin));
    return {
      meta: normMeta(info, vin, true),
      equipment: normEquipment(equip),
      connection: normConnection(conn),
      drivingScore: normScore(score),
    };
  });
}

// Redact to portal form. Returns a CLONE — never a live cache reference — so a
// downstream consumer can never mutate the cached admin entry.
function redactForPortal(full) {
  if (!full) return full;
  const meta = full.meta ? { ...full.meta, vin: maskVin(full.meta.vin) } : null;
  const equipment = Array.isArray(full.equipment) ? full.equipment.slice() : full.equipment;
  return { ...full, meta, equipment };
}

function serve(full, forAdmin) { return forAdmin ? full : redactForPortal(full); }

async function getDetails(vehicleId, { fetchImpl, forAdmin = false } = {}) {
  const hit = cache.get(vehicleId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (hit.errCode) throw err('rate limited', hit.errCode);
    return serve(hit.value, forAdmin);
  }
  if (inflight.has(vehicleId)) return serve(await inflight.get(vehicleId), forAdmin);

  const p = fetchDetails(vehicleId, fetchImpl)
    .then((value) => { cache.set(vehicleId, { at: Date.now(), value }); return value; })
    .catch((e) => {
      if (e.code === 'SKODA_RATE_LIMITED') cache.set(vehicleId, { at: Date.now(), errCode: e.code });
      throw e;
    })
    .finally(() => { inflight.delete(vehicleId); });
  inflight.set(vehicleId, p);
  return serve(await p, forAdmin);
}

function _resetForTest() { cache.clear(); inflight.clear(); }

module.exports = { getDetails, _resetForTest };
