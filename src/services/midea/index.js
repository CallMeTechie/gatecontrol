'use strict';

const devices = require('./mideaDevices');
const { LanDevice, discover } = require('./mideaLan');
const { MideaCloud } = require('./mideaCloud');
const mideaAc = require('./mideaAc');
const eventBus = require('../eventBus');
const license = require('../license');
const logger = require('../../utils/logger');

const FEATURE = 'midea_integration';
const POLL_INTERVAL_MS = 30000;

const cache = new Map();          // deviceId -> { state, online, lastAt }
const locks = new Map();          // deviceId -> Promise chain tail
const lockDepth = new Map();      // deviceId -> active operation count
let pollTimer = null;
let lastPollAt = null;

// ── Per-device mutex ──────────────────────────────────────────────────────────

function withDeviceLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  lockDepth.set(id, (lockDepth.get(id) || 0) + 1);
  const done = () => {
    const n = (lockDepth.get(id) || 1) - 1;
    if (n <= 0) lockDepth.delete(id); else lockDepth.set(id, n);
  };
  const next = prev.then(fn, fn);
  next.then(done, done);
  locks.set(id, next.catch(() => {}));
  return next;
}

// ── LAN helpers ───────────────────────────────────────────────────────────────

function lanFor(d) {
  return new LanDevice({
    ip: d.ip,
    port: d.port,
    deviceId: d.device_id,
    protocolVersion: d.protocol_version,
    token: d.token,
    key: d.key,
  });
}

// ── Device state operations ───────────────────────────────────────────────────

async function getState(id) {
  const d = devices.getDevice(id);
  if (!d) throw new Error('device not found');

  if (d.transport === 'cloud') {
    return withDeviceLock(id, async () => {
      try {
        const resp = await withCloud((c) => c.sendCommand(d.cloud_appliance_id, mideaAc.buildQuery()));
        const state = mideaAc.parseState(resp);
        cache.set(id, { state, online: true, lastAt: Date.now() });
        return state;
      } catch (err) {
        logger.debug({ err: err.message, id }, 'midea getState (cloud) failed (offline)');
        cache.set(id, { state: null, online: false, lastAt: Date.now() });
        return { offline: true };
      }
    });
  }

  return withDeviceLock(id, async () => {
    try {
      const state = await lanFor(d).getState();
      cache.set(id, { state, online: true, lastAt: Date.now() });
      devices.updateDevice(id, { last_seen_at: new Date().toISOString() });
      return state;
    } catch (err) {
      logger.debug({ err: err.message, id }, 'midea getState failed (offline)');
      cache.set(id, { state: null, online: false, lastAt: Date.now() });
      return { offline: true };
    }
  });
}

async function setState(id, patch) {
  const d = devices.getDevice(id);
  if (!d) throw new Error('device not found');

  if (d.transport === 'cloud') {
    return withDeviceLock(id, async () => {
      try {
        // Inline read-modify-write inside the single lock (withDeviceLock is NOT
        // reentrant — never call the public getState() here).
        const cur = mideaAc.parseState(
          await withCloud((c) => c.sendCommand(d.cloud_appliance_id, mideaAc.buildQuery())),
        );
        const merged = { ...cur, ...patch };
        const resp = await withCloud((c) => c.sendCommand(d.cloud_appliance_id, mideaAc.buildSet(merged)));
        const state = mideaAc.parseState(resp);
        cache.set(id, { state, online: true, lastAt: Date.now() });
        eventBus.publish('midea:state', { deviceId: id, state });
        return state;
      } catch (err) {
        // Non-alarming: 2FA-specific handling lands in Task 5, do not throw here.
        logger.debug({ err: err.message, id }, 'midea setState (cloud) failed (offline)');
        cache.set(id, { state: null, online: false, lastAt: Date.now() });
        return { offline: true };
      }
    });
  }

  return withDeviceLock(id, async () => {
    const state = await lanFor(d).setState(patch);
    cache.set(id, { state, online: true, lastAt: Date.now() });
    eventBus.publish('midea:state', { deviceId: id, state });
    return state;
  });
}

async function testConnection(id) {
  const d = devices.getDevice(id);
  if (!d) throw new Error('device not found');
  const t0 = Date.now();
  const state = await withDeviceLock(id, () => lanFor(d).getState());
  return { ok: true, version: d.protocol_version, latencyMs: Date.now() - t0, state };
}

// ── Cloud operations ──────────────────────────────────────────────────────────

async function discoverLan(opts) { return discover(opts || {}); }

async function connectCloud(email, password, app = 'msmarthome') {
  const c = new MideaCloud(app);
  const res = await c.login(email, password);     // throws typed MideaCloudError (e.g. 2FA)
  devices.saveConfig({ app, email, password, session: c.getSession() });
  return res;
}

function cloudFromConfig() {
  const cfg = devices.loadConfig();
  if (!cfg.email) throw new Error('cloud not configured');
  const c = new MideaCloud(cfg.app);
  if (cfg.session) c.setSession(cfg.session);
  return { c, cfg };
}

async function withCloud(fn) {
  const { c, cfg } = cloudFromConfig();
  const ensure = async () => {
    if (!c.getSession()) {
      await c.login(cfg.email, cfg.password);
      devices.saveConfig({ ...cfg, session: c.getSession() });
    }
  };
  await ensure();
  try {
    return await fn(c, cfg);
  } catch (e) {
    if (e.code === 'MIDEA_CLOUD_ERROR') {
      c.setSession(null);
      await ensure();
      return fn(c, cfg);
    }
    throw e;
  }
}

async function listCloudDevices() {
  return withCloud((c) => c.listDevices());
}

// ── Add device (V3 transactional: token fetched BEFORE persistence) ───────────

async function addDevice({ sn, name, ip, transport, cloud_appliance_id }) {
  // ── Cloud-only path ───────────────────────────────────────────────────────
  if (transport === 'cloud') {
    if (!cloud_appliance_id) throw new Error('cloud_appliance_id required');
    const deviceSn = 'cloud-' + cloud_appliance_id;
    if (devices.listDevices().some((x) => x.device_sn === deviceSn)) {
      const e = new Error('device already added');
      e.code = 'MIDEA_DEVICE_EXISTS';
      throw e;
    }
    const d = devices.createDevice({
      name: name || `Midea Cloud ${cloud_appliance_id}`,
      device_sn: deviceSn,
      transport: 'cloud',
      cloud_appliance_id,
    });
    // No ensurePolling() for cloud devices (Task 5 handles cloud polling).
    const { token: _t, key: _k, ...redacted } = d;
    return { ...redacted, has_credentials: false };
  }

  if (!sn && !ip) throw new Error('sn or ip required');

  // Duplicate pre-check BEFORE expensive cloud calls
  if (sn && devices.listDevices().some((x) => x.device_sn === sn)) {
    const e = new Error('device already added');
    e.code = 'MIDEA_DEVICE_EXISTS';
    throw e;
  }

  // LAN-only onboarding (no sn): discover by IP
  let info = null;
  if (!sn && ip) {
    const found = await discover({});
    info = found.find((f) => f.ip === ip) || null;
  }

  // Cloud resolution (only when sn provided and cloud configured)
  const { c, cfg } = (() => {
    try { return cloudFromConfig(); } catch { return { c: null, cfg: null }; }
  })();

  let match = null;
  if (c && sn) {
    if (!c.getSession()) {
      await c.login(cfg.email, cfg.password);
      devices.saveConfig({ ...cfg, session: c.getSession() });
    }
    const cloudList = await c.listDevices();
    match = cloudList.find((x) => x.sn === sn);
    if (!match) throw new Error('device not found in cloud account');
    if (!ip) {
      const f = await discover({});
      info = f.find((x) => String(x.deviceId) === String(match.id)) || info;
    }
  }

  const protocolVersion = info ? info.version : (sn ? 3 : 2);
  const resolvedIp = ip || (info && info.ip) || null;
  if (!resolvedIp) throw new Error('device not found on LAN — power it on, same subnet, then retry');

  // ── TRANSACTIONAL BOUNDARY ──
  // For V3 devices, getToken MUST succeed BEFORE createDevice.
  // Any failure here leaves the DB untouched (Spec §5).
  let token = null;
  let key = null;
  if (protocolVersion === 3) {
    if (!c) throw new Error('cloud not configured — required for V3 token');
    const tk = await c.getToken(match ? match.id : info.deviceId);  // throws → nothing persisted
    token = tk.token;
    key = tk.key;
  }

  const d = devices.createDevice({
    name: name || (match && match.name) || `Midea ${sn || resolvedIp}`,
    device_sn: sn || `lan-${info ? info.deviceId : resolvedIp}`,
    device_id: String(match ? match.id : (info && info.deviceId) || ''),
    ip: resolvedIp,
    port: (info && info.port) || 6444,
    protocol_version: protocolVersion,
    token,
    key,
  });

  ensurePolling();

  const { token: _t, key: _k, ...redacted } = d;
  return { ...redacted, has_credentials: Boolean(token && key) };
}

// ── Registry ──────────────────────────────────────────────────────────────────

function getDevices() { return devices.listDevicesRedacted(); }

function removeDevice(id) {
  cache.delete(id);
  const res = devices.removeDevice(id);
  if (devices.listDevices().length === 0) stopPolling();
  return res;
}

function getStatus() {
  return {
    devices: devices.listDevicesRedacted().map((d) => {
      const c = cache.get(d.id) || {};
      return { id: d.id, name: d.name, enabled: d.enabled, online: Boolean(c.online), state: c.state || null };
    }),
    lastPollAt,
  };
}

// ── Poll loop (license-gated, unref'd) ───────────────────────────────────────

let pollRunning = false;

async function pollTick() {
  if (pollRunning) return;                          // no overlapping ticks
  if (!license.hasFeature(FEATURE)) {
    stopPolling();
    cache.clear();
    return;
  }
  pollRunning = true;
  lastPollAt = new Date().toISOString();
  try {
    for (const d of devices.listDevices()) {
      if (!d.enabled) continue;
      if (lockDepth.get(d.id)) continue;            // skip devices with active queue (Spec §8)
      try { await getState(d.id); } catch { /* offline handled internally */ }
    }
  } finally {
    pollRunning = false;
  }
}

function ensurePolling() {
  if (pollTimer) return;                            // idempotent
  if (!license.hasFeature(FEATURE)) return;
  if (devices.listDevices().length === 0) return;
  pollTimer = setInterval(() => { pollTick().catch(() => {}); }, POLL_INTERVAL_MS);
  if (pollTimer.unref) pollTimer.unref();           // never hold the process open
}

function startPolling() { ensurePolling(); }

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  connectCloud, listCloudDevices, addDevice, discoverLan,
  getDevices, getState, setState, testConnection, removeDevice,
  getStatus, startPolling, stopPolling, withDeviceLock,
};
