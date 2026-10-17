'use strict';

// Realtime events of plugins (docs/plugins.md "Realtime events"):
// gc.events.emit({ users, type, data }) — permissions.events.
//
// Ephemeral: never stored, not in the inbox, not in the push budget, no
// replay. Delivered right away to whatever is connected for those people:
//   * the apps' push stream (GET /api/v1/client/push, notify/stream.js) as
//     `event: plugin` with { plugin, type, data } — every open stream of a
//     listed person, without an SSE id (a reconnect replays nothing; the
//     apps fetch the current state from the plugin's API after one);
//   * the plugin's frames: the portal and the admin page hold one SSE per
//     plugin (GET /api/v1/portal/plugins/<id>/events, GET
//     /api/v1/plugins/<id>/events — the streams below) and hand each event
//     to the plugin's frames by postMessage (window.GC.on('event', fn)).
// A stream under backpressure drops the event (it is ephemeral).
// Limits: data ≤ 4 KB as JSON, ≤ 500 people per call, 600 calls per minute
// and plugin.

const logger = require('../../utils/logger');

const TYPE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const DATA_MAX_BYTES = 4096;
const USERS_MAX = 500;
const PER_MINUTE = 600;
const KEEPALIVE_MS = 25000;
const DRAIN_TIMEOUT_MS = 30000;
const STREAMS_PER_USER = 16;
const STREAMS_MAX = 2000;

class EventError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const windows = new Map(); // plugin id → [timestamps]
const streams = new Set(); // { plugin, userId, res, lagging, keepalive, drainTimer, closed }

/**
 * Validate a call → { users, type, data } (data as plain JSON).
 * @throws {EventError} ERR_INVALID
 */
function check(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const users = a.users;
  if (!Array.isArray(users) || !users.length || users.length > USERS_MAX || !users.every((u) => Number.isSafeInteger(u) && u > 0)) {
    throw new EventError('ERR_INVALID', `users must be 1…${USERS_MAX} user ids`);
  }
  if (typeof a.type !== 'string' || !TYPE_RE.test(a.type)) throw new EventError('ERR_INVALID', 'invalid type');
  let json;
  try { json = JSON.stringify(a.data === undefined ? null : a.data); } catch { throw new EventError('ERR_INVALID', 'data must be JSON'); }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > DATA_MAX_BYTES) throw new EventError('ERR_INVALID', 'data too large (max 4 KB)');
  return { users: [...new Set(users)], type: a.type, data: JSON.parse(json) };
}

/** Count one call against the plugin's budget per minute. */
function budget(pluginId) {
  const now = Date.now();
  const w = (windows.get(pluginId) || []).filter((t) => now - t < 60000);
  if (w.length >= PER_MINUTE) throw new EventError('ERR_RATE_LIMIT', 'too many events (600 per minute)');
  w.push(now);
  windows.set(pluginId, w);
}

// ─── Frame streams (portal / admin page) ───────

function writeFrame(s, chunk) {
  if (s.closed || s.lagging) return false;
  let ok;
  try { ok = s.res.write(chunk); } catch { closeStream(s); return false; }
  if (ok === false) {
    s.lagging = true;
    s.drainTimer = setTimeout(() => closeStream(s), DRAIN_TIMEOUT_MS);
    if (s.drainTimer.unref) s.drainTimer.unref();
    s.res.once('drain', () => {
      s.lagging = false;
      if (s.drainTimer) { clearTimeout(s.drainTimer); s.drainTimer = null; }
    });
  }
  return true;
}

function closeStream(s) {
  if (s.closed) return;
  s.closed = true;
  streams.delete(s);
  if (s.keepalive) clearInterval(s.keepalive);
  if (s.drainTimer) clearTimeout(s.drainTimer);
  try { s.res.end(); } catch { /* gone */ }
}

/**
 * Open the event stream of one plugin for one person (the route checked the
 * viewer and permissions.events). Answers 503 itself when too many are open.
 */
function openStream(req, res, pluginId, userId) {
  let mine = 0;
  for (const s of streams) if (s.userId === userId) mine++;
  if (mine >= STREAMS_PER_USER || streams.size >= STREAMS_MAX) {
    return res.status(503).json({ ok: false, code: 'too_many_streams' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const s = { plugin: pluginId, userId, res, lagging: false, closed: false, keepalive: null, drainTimer: null };
  streams.add(s);
  writeFrame(s, `event: hello\ndata: ${JSON.stringify({ plugin: pluginId })}\n\n`);
  s.keepalive = setInterval(() => writeFrame(s, ': ping\n\n'), module.exports._keepaliveMs || KEEPALIVE_MS);
  if (s.keepalive.unref) s.keepalive.unref();
  req.on('close', () => closeStream(s));
  return s;
}

/** End every frame stream of a plugin (stopped, uninstalled) or all (shutdown). */
function closeStreams(pluginId = null) {
  for (const s of [...streams]) if (pluginId == null || s.plugin === pluginId) closeStream(s);
}

// ─── Emit ───────────────────────────────────────

/**
 * gc.events.emit → { delivered } (number of streams written to: app
 * devices and frame streams). Throws ERR_INVALID / ERR_RATE_LIMIT.
 */
function emit(pluginId, args) {
  const ev = check(args);
  budget(pluginId);
  const payload = { plugin: pluginId, type: ev.type, data: ev.data };
  const who = new Set(ev.users);
  let delivered = 0;
  try {
    const pushStream = require('../notify/stream');
    for (const c of pushStream.list()) {
      if (c.closed || c.userId == null || !who.has(c.userId)) continue;
      if (pushStream.writeEvent(c, 'plugin', payload)) delivered++;
    }
  } catch (err) { logger.debug({ err: err.message, plugin: pluginId }, 'plugin event: push streams unavailable'); }
  const chunk = `event: plugin\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const s of [...streams]) {
    if (s.plugin === pluginId && who.has(s.userId) && writeFrame(s, chunk)) delivered++;
  }
  return { delivered };
}

function _resetForTest() {
  windows.clear();
  closeStreams();
}

function _streamCount() { return streams.size; }

module.exports = {
  EventError, TYPE_RE, DATA_MAX_BYTES, USERS_MAX, PER_MINUTE, STREAMS_PER_USER,
  check, emit, openStream, closeStreams, _resetForTest, _streamCount, _keepaliveMs: null,
};
