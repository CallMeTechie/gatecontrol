'use strict';

// Ephemeral, in-memory LAN-discovery cache. Holds the latest scan result set per
// gateway peer with a `current_request_id` reconciliation rule (spec §5.2) and a
// lazy orphan-scan timeout (§5.4). NOT persisted — lost on restart by design.

const DISPLAY_TTL_MS = 10 * 60 * 1000;   // results shown for 10 min after last update
const SCAN_GRACE_MS = 60 * 1000;         // in-flight considered dead after start + grace (45s timeout + 15s)
const MAX_DEVICES = 2000;
const MAX_PORTS_PER_DEVICE = 64;
const INGEST_WINDOW_MS = 60 * 1000;
const INGEST_MAX_PER_WINDOW = 60;

const cache = new Map();      // peerId -> entry
const ingestLog = new Map();  // peerId -> number[] (recent ingest timestamps)

const _now = () => Date.now();
const _isIpv4 = (s) => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(o => Number(o) <= 255);
const _isMac = (s) => typeof s === 'string' && /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(s);

// Validate + clamp a raw device array from an (authenticated, but untrusted-LAN)
// gateway. Drops malformed entries; caps counts; length-limits strings. Strings
// are stored raw — the UI escapes them at render time (no HTML built here).
function sanitizeDevices(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw.slice(0, MAX_DEVICES)) {
    if (!d || !_isIpv4(d.ip)) continue;
    const ports = Array.isArray(d.ports) ? d.ports.slice(0, MAX_PORTS_PER_DEVICE)
      .filter(p => p && Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)
      .map(p => ({ port: p.port, source: String(p.source || '').slice(0, 16), service_hint: p.service_hint ? String(p.service_hint).slice(0, 128) : null }))
      : [];
    out.push({
      ip: d.ip,
      hostname: d.hostname ? String(d.hostname).slice(0, 255) : null,
      mac: _isMac(d.mac) ? d.mac.toLowerCase() : null,
      ports,
      sources: Array.isArray(d.sources) ? d.sources.slice(0, 4).map(s => String(s).slice(0, 16)) : [],
    });
  }
  return out;
}

function _mergeDevice(existing, incoming) {
  if (!existing) return { ...incoming, ports: [...incoming.ports] };
  const ports = existing.ports.slice();
  for (const p of incoming.ports) {
    if (!ports.some(q => q.port === p.port && q.source === p.source)) ports.push(p);
  }
  return {
    ip: existing.ip,
    hostname: existing.hostname || incoming.hostname || null,
    mac: existing.mac || incoming.mac || null,
    ports,
    sources: [...new Set([...(existing.sources || []), ...(incoming.sources || [])])],
  };
}

function _rateOk(peerId) {
  const now = _now();
  const arr = (ingestLog.get(peerId) || []).filter(t => now - t < INGEST_WINDOW_MS);
  arr.push(now);
  ingestLog.set(peerId, arr);
  return arr.length <= INGEST_MAX_PER_WINDOW;
}

// Server issues a scan (POST /:id/discover): set current request + mark in-flight.
// `graceMs` = the scan timeout sent to the gateway + 15s (§5.4); the route derives
// it so a longer-running gateway scan isn't declared orphaned prematurely.
function begin(peerId, requestId, graceMs = SCAN_GRACE_MS) {
  cache.set(peerId, { requestId, devices: new Map(), done: false, timedOut: false, startedAt: _now(), updatedAt: _now(), graceMs });
}

function inFlight(peerId) {
  const e = cache.get(peerId);
  if (!e || e.done) return false;
  if (_now() - e.startedAt > (e.graceMs || SCAN_GRACE_MS)) return false; // stale → not in flight
  return true;
}

function cancel(peerId) { cache.delete(peerId); ingestLog.delete(peerId); }

// Ingest a batch from the gateway (peerId already resolved from Bearer auth).
// Reconciliation (§5.2): matching request_id → merge; non-matching while an
// in-flight current scan exists → drop; no current → adopt (restart-safe).
function ingest(peerId, requestId, rawDevices, done) {
  if (!_rateOk(peerId)) return { accepted: false, reason: 'rate_limited' };
  const devices = sanitizeDevices(rawDevices);
  let e = cache.get(peerId);
  // Block only a still-in-flight scan: if the prior entry's grace window has
  // expired, it is effectively a tombstone and a new requestId may take over.
  if (e && !e.done && e.requestId && e.requestId !== requestId
      && (_now() - e.startedAt) <= (e.graceMs || SCAN_GRACE_MS)) {
    return { accepted: false, reason: 'stale_request' };
  }
  if (!e || e.requestId !== requestId) {
    e = { requestId, devices: new Map(), done: false, timedOut: false, startedAt: e ? e.startedAt : _now(), updatedAt: _now() };
    cache.set(peerId, e);
  }
  for (const d of devices) {
    if (!e.devices.has(d.ip) && e.devices.size >= MAX_DEVICES) break;
    e.devices.set(d.ip, _mergeDevice(e.devices.get(d.ip), d));
  }
  e.done = !!done;
  e.updatedAt = _now();
  return { accepted: true, count: e.devices.size };
}

function get(peerId) {
  const e = cache.get(peerId);
  if (!e) return null;
  if (_now() - e.updatedAt > DISPLAY_TTL_MS) { cache.delete(peerId); return null; }
  if (!e.done && _now() - e.startedAt > (e.graceMs || SCAN_GRACE_MS)) { e.done = true; e.timedOut = true; }
  return {
    request_id: e.requestId,
    devices: [...e.devices.values()],
    done: e.done,
    timed_out: e.timedOut,
    in_flight: !e.done,
    updated_at: e.updatedAt,
  };
}

function _reset() { cache.clear(); ingestLog.clear(); }

module.exports = { begin, inFlight, cancel, ingest, get, sanitizeDevices, _reset };
