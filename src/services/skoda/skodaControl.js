'use strict';

const accounts = require('./skodaAccounts');
const vehicles = require('./skodaVehicles');
const skoda = require('./index');

const TEMP_MIN = 15.5, TEMP_MAX = 30;
const CHARGE_STEPS = [50, 60, 70, 80, 90, 100];
const LOCK_LIMIT = 5, LOCK_WINDOW_MS = 15 * 60 * 1000;
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function err(message, code) { const e = new Error(message); e.code = code; return e; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : NaN; }

function reqTemp(a) {
  const t = num(a && a.temp);
  if (!Number.isFinite(t) || t < TEMP_MIN || t > TEMP_MAX) throw err('temp out of range', 'SKODA_VALIDATION');
  return { temp: t };
}

function reqTimer(a) {
  const id = num(a && a.id); // num() ist typeof-basiert: "1" oder true fallen durch
  if (!Number.isInteger(id) || id <= 0) throw err('timer id invalid', 'SKODA_VALIDATION');
  if (typeof (a && a.enabled) !== 'boolean') throw err('enabled must be a boolean', 'SKODA_VALIDATION');
  if (typeof (a && a.time) !== 'string' || !TIME_RE.test(a.time)) throw err('time must be HH:MM', 'SKODA_VALIDATION');
  if (!Array.isArray(a && a.days) || !a.days.length || a.days.length > WEEKDAYS.length) throw err('one to seven weekdays required', 'SKODA_VALIDATION');
  const days = [...new Set(a.days)];
  // Werte-Allowlist, kein Objektschlüssel — '__proto__' fällt hier durch.
  if (days.some((d) => !WEEKDAYS.includes(d))) throw err('unknown weekday', 'SKODA_VALIDATION');
  days.sort((x, y) => WEEKDAYS.indexOf(x) - WEEKDAYS.indexOf(y));
  return { id, enabled: a.enabled, time: a.time, days };
}

// Frischer Lesevorgang statt state_json: `type` darf NIE aus dem Request kommen
// (sonst schaltet ein Client einen Timer auf ONE_OFF um), und ein bis zu 15 min
// alter state_json würde eine zwischenzeitliche Änderung in der Skoda-App
// stillschweigend zurücksetzen. Ein GET pro Speichervorgang ist der Preis.
async function setTimer(c, vin, a) {
  const ac = await c.airConditioning(vin);
  const found = (ac && Array.isArray(ac.timers) ? ac.timers : []).find((t) => t && t.id === a.id);
  if (!found) throw err('timer slot not found', 'SKODA_TIMER_NOT_FOUND');
  // ponytail: ONE_OFF-Slots bleiben unangetastet — der Live-Spike hat nur
  // RECURRING gesehen, das Verhalten von selectedDays bei ONE_OFF ist unbekannt.
  if (found.type !== 'RECURRING') throw err('timer is not recurring', 'SKODA_TIMER_READONLY');
  return c.setAcTimer(vin, { id: a.id, enabled: a.enabled, time: a.time, type: found.type, selectedDays: a.days });
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
  timer_set: { needsSpin: false, validate: reqTimer, run: setTimer },
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
