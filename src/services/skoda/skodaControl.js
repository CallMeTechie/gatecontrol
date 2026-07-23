'use strict';

const accounts = require('./skodaAccounts');
const vehicles = require('./skodaVehicles');
const skoda = require('./index');

const TEMP_MIN = 15.5, TEMP_MAX = 30;
const CHARGE_STEPS = [50, 60, 70, 80, 90, 100];
const LOCK_LIMIT = 5, LOCK_WINDOW_MS = 15 * 60 * 1000;

function err(message, code) { const e = new Error(message); e.code = code; return e; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : NaN; }

function reqTemp(a) {
  const t = num(a && a.temp);
  if (!Number.isFinite(t) || t < TEMP_MIN || t > TEMP_MAX) throw err('temp out of range', 'SKODA_VALIDATION');
  return { temp: t };
}

const COMMANDS = {
  ac_start: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.startAc(vin, a.temp) },
  ac_stop: { needsSpin: false, validate: () => ({}), run: (c, vin) => c.stopAc(vin) },
  ac_temp: { needsSpin: false, validate: reqTemp, run: (c, vin, a) => c.setAcTemp(vin, a.temp) },
  window_heat_start: { needsSpin: false, validate: () => ({}), run: (c, vin) => c.startWindowHeating(vin) },
  window_heat_stop: { needsSpin: false, validate: () => ({}), run: (c, vin) => c.stopWindowHeating(vin) },
  charge_start: { needsSpin: false, validate: () => ({}), run: (c, vin) => c.startCharging(vin) },
  charge_stop: { needsSpin: false, validate: () => ({}), run: (c, vin) => c.stopCharging(vin) },
  charge_limit: { needsSpin: false, validate: (a) => { const l = num(a && a.limit); if (!CHARGE_STEPS.includes(l)) throw err('limit not allowed', 'SKODA_VALIDATION'); return { limit: l }; }, run: (c, vin, a) => c.setChargeLimit(vin, a.limit) },
  lock: { needsSpin: true, validate: () => ({}), run: (c, vin, a, spin) => c.lock(vin, spin) },
  unlock: { needsSpin: true, validate: () => ({}), run: (c, vin, a, spin) => c.unlock(vin, spin) },
};

// ponytail: grows one entry per account ever touched — same trade-off as
// index.js refreshCooldown/accountLocks; fine at household scale, prozesslokal.
const lockAttempts = new Map(); // accountId -> [timestamps]
function checkLockRate(accountId) {
  const now = Date.now();
  const arr = (lockAttempts.get(accountId) || []).filter((t) => now - t < LOCK_WINDOW_MS);
  if (arr.length >= LOCK_LIMIT) throw err('too many lock/unlock attempts', 'SKODA_COMMAND_RATE_LIMIT');
  arr.push(now);
  lockAttempts.set(accountId, arr);
}

async function runCommand(vehicleId, action, args, { fetchImpl } = {}) {
  // hasOwnProperty-Guard: kein Prototype-Key (constructor/…) als Action.
  const cmd = Object.prototype.hasOwnProperty.call(COMMANDS, action) ? COMMANDS[action] : null;
  if (!cmd) throw err(`unknown command ${action}`, 'SKODA_UNKNOWN_COMMAND');
  const normArgs = cmd.validate(args || {});

  const accountId = vehicles.accountIdOf(vehicleId);
  if (!accountId) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');
  const row = vehicles.listRedacted().find((v) => v.id === vehicleId);
  const vin = row && row.vin;
  if (!vin) throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');

  // Ohne aktive Session (neues Konto vor erstem Poll, oder login_failed/error mit
  // genullter Session): typisierter 409 statt untypisiertem TypeError im Client.
  const account = accounts.getAccountWithSecrets(accountId);
  if (!account || !account.session || !account.session.accessToken) {
    throw err('account has no active session — re-sync/re-login required', 'SKODA_NO_SESSION');
  }

  let spin = null;
  if (cmd.needsSpin) {
    spin = accounts.getSpin(accountId);
    if (!spin) throw err('S-PIN not set for this account', 'SKODA_SPIN_REQUIRED');
    checkLockRate(accountId); // count BEFORE the cloud call — a failed PIN still counts
  }

  // Unter der Konto-Lock (wie der Sync): serialisiert Command vs. Poller-Sync
  // → kein Session-Refresh-Race mit single-use Refresh-Token.
  await skoda.withAccountLock(accountId, async () => {
    const client = skoda.clientForAccount(accountId, fetchImpl);
    await cmd.run(client, vin, normArgs, spin);
  });

  // command-triggered refresh in its own 30s window (never blocks the response)
  skoda.refreshVehicle(vehicleId, { afterCommand: true }).catch(() => {});
  return { ok: true };
}

function _resetForTest() { lockAttempts.clear(); }

module.exports = { COMMANDS, runCommand, _resetForTest };
