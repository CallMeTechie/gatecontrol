'use strict';

// Open push streams (GET /api/v1/client/push): at most one per device token —
// a new stream ends the old one. Writes are framed as SSE; under
// backpressure nothing is written (the queue keeps the messages, a
// reconnect replays them) and a stream that does not drain within 30 s is
// closed, like the admin stream in routes/api/events.js.

const eventBus = require('../eventBus');
const logger = require('../../utils/logger');

const DRAIN_TIMEOUT_MS = 30000;
const conns = new Map(); // tokenId → conn

function count() { return conns.size; }
function get(tokenId) { return conns.get(tokenId) || null; }
function isConnected(tokenId) { return conns.has(tokenId); }
function list() { return [...conns.values()]; }

function presence(conn, state) {
  try { eventBus.publish('push_presence', { token_id: conn.tokenId, state, via: conn.via }); } catch { /* bus is best-effort */ }
}

/**
 * Register an open stream. conn: { tokenId, userId, via, res, connectedAt }.
 * Replaces (and ends) an older stream of the same token.
 */
function add(conn) {
  const old = conns.get(conn.tokenId);
  if (old) close(old, 'replaced');
  conn.lagging = false;
  conn.closed = false;
  conns.set(conn.tokenId, conn);
  presence(conn, 'connected');
  return conn;
}

/** End a stream (and forget it). */
function close(conn, reason) {
  if (!conn || conn.closed) return;
  conn.closed = true;
  if (conn.keepalive) clearInterval(conn.keepalive);
  if (conn.drainTimer) clearTimeout(conn.drainTimer);
  if (conns.get(conn.tokenId) === conn) {
    conns.delete(conn.tokenId);
    presence(conn, 'offline');
    if (typeof conn.onClose === 'function') { try { conn.onClose(reason); } catch { /* ignore */ } }
  }
  try { conn.res.end(); } catch { /* already gone */ }
  logger.debug({ tokenId: conn.tokenId, reason }, 'push stream closed');
}

function closeToken(tokenId, reason = 'closed') { const c = conns.get(tokenId); if (c) close(c, reason); }

function closeAll(filter = () => true, reason = 'closed') {
  for (const c of list()) if (filter(c)) close(c, reason);
}

/** Raw write with backpressure handling. Returns true when written. */
function rawWrite(conn, chunk) {
  if (!conn || conn.closed || conn.lagging) return false;
  let ok;
  try { ok = conn.res.write(chunk); } catch { close(conn, 'write_failed'); return false; }
  if (ok === false) {
    conn.lagging = true;
    conn.drainTimer = setTimeout(() => close(conn, 'drain_timeout'), DRAIN_TIMEOUT_MS);
    if (conn.drainTimer.unref) conn.drainTimer.unref();
    conn.res.once('drain', () => {
      conn.lagging = false;
      if (conn.drainTimer) { clearTimeout(conn.drainTimer); conn.drainTimer = null; }
      if (typeof conn.onDrain === 'function') { try { conn.onDrain(); } catch { /* ignore */ } }
    });
  }
  // The chunk itself is in the socket buffer even when write() said "full".
  return true;
}

/** Write one SSE event (`id` optional) to a connection. */
function writeEvent(conn, event, data, id) {
  const head = id != null ? `id: ${id}\n` : '';
  return rawWrite(conn, `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function send(tokenId, event, data, id) {
  const c = conns.get(tokenId);
  return c ? writeEvent(c, event, data, id) : false;
}

function ping(conn) { return rawWrite(conn, ': ping\n\n'); }

function _resetForTest() { closeAll(() => true, 'test'); conns.clear(); }

module.exports = { add, close, closeToken, closeAll, get, isConnected, list, count, writeEvent, send, ping, _resetForTest };
