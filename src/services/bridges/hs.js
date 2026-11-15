'use strict';

// The internal homeserver, as far as the server itself talks to it: over its
// Unix socket in /data/bridges/hs/run/hs.sock, as the application service
// "gatecontrol" (config.js), acting for the internal account of a GateControl
// person (`?user_id=@gc_<id>:gc.internal` — Matrix "identity assertion").
// Matrix client-server API v3, nothing else:
//
//   POST /register                         the account before the first link (m.login.application_service, no device)
//   POST /rooms/{room}/join                accept a bridge's invite
//   GET  /rooms/{room}/state               name, kind and members of a room once joined
//   GET  /rooms/{room}/messages            what was said before the account was in the room
//   PUT  /rooms/{room}/send/{type}/{txn}   a message, an edit, a reaction (idempotent by txn)
//   PUT  /rooms/{room}/redact/{event}/{txn}
//   POST /rooms/{room}/receipt/m.read/{event}
//   PUT  /rooms/{room}/typing/{user}
//   GET  /_matrix/client/v1/media/download/{server}/{id}   (stage 4) a file a bridge put into a room, streamed
//   POST /_matrix/media/v3/upload           (stage 4) a file of the person, streamed, before it is sent into a room
//   DELETE /_synapse/admin/v1/media/{server}/{id}   (stage 5) a file of a room, once the plugin took it over — as the
//                                           server's own bot (gcbot), the one administrator of the homeserver
//   POST /join/#admins:<server>             (stage 5) the bot takes the seat in the admin room it is invited to
//
// Every address is built here from checked parts; the token never leaves this
// module and nothing of an answer is passed on unchecked.

const http = require('node:http');
const path = require('node:path');

const TIMEOUT_MS = 10000;
const MAX_BODY = 64 * 1024;
const MAX_LIST = 1024 * 1024;
const SOCKET_RE = /^\/[A-Za-z0-9._/-]{1,90}\/hs\/run\/hs\.sock$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LOCAL_RE = /^gc_[0-9]{1,16}$/;
const MXID_RE = /^@gc_[0-9]{1,16}:[a-z0-9.-]{1,64}$/;
// the server's own bot (config.js CORE_BOT): only for the clean-up of files (stage 5)
const BOT_RE = /^@gcbot:[a-z0-9.-]{1,64}$/;
// room and event ids as the homeserver makes them (room versions 1…12: with or without a server part)
const ROOM_RE = /^![A-Za-z0-9._=/+-]{1,128}(:[a-z0-9.-]{1,64})?$/;
const EVENT_RE = /^\$[A-Za-z0-9._=/+-]{1,128}(:[a-z0-9.-]{1,64})?$/;
const TXN_RE = /^[A-Za-z0-9_-]{8,96}$/;
const TYPE_RE = /^[a-z][a-z0-9._]{2,64}$/;
// a file of this homeserver (no remote server: there is no federation)
const MXC_RE = /^mxc:\/\/([a-z0-9.-]{1,64})\/([A-Za-z0-9_-]{1,255})$/;
const MEDIA_TIMEOUT_MS = 120000;
const MIME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;

class HsError extends Error {
  constructor(code, message, reason) { super(message || code); this.code = code; if (reason) this.reason = reason; }
}

function socketOf(dir) { return path.join(dir, 'hs', 'run', 'hs.sock'); }

function checkTarget(target) {
  if (!target || !SOCKET_RE.test(String(target.socket || '')) || String(target.socket).includes('..') || !TOKEN_RE.test(String(target.token || ''))) {
    throw new HsError('ERR_INVALID', 'invalid homeserver request');
  }
}

/** A reason as the plugin runtime passes it on: M_FORBIDDEN → m_forbidden. */
function reasonWord(v) {
  const w = String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return /^[a-z]/.test(w) ? w : 'hs_error';
}

/** One request. → { status, json } — rejects only when the homeserver cannot be reached. */
function raw(target, method, urlPath, body, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      socketPath: target.socket, agent: false, method, path: urlPath, timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > max) { r.destroy(new HsError('ERR_BRIDGE', 'answer of the homeserver too large', 'too_large')); return; } chunks.push(c); });
      res.on('error', (e) => reject(new HsError('ERR_BRIDGE_UNREACHABLE', e.message, 'unreachable')));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('timeout', () => r.destroy(new HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver did not answer in time', 'timeout')));
    r.on('error', (e) => reject(e instanceof HsError ? e : new HsError('ERR_BRIDGE_UNREACHABLE', e.message, e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'unreachable')));
    if (data) r.write(data);
    r.end();
  });
}

function failure(r) {
  const errcode = r.json && typeof r.json.errcode === 'string' ? r.json.errcode : `http_${r.status}`;
  return new HsError('ERR_BRIDGE', `homeserver answered ${r.status} ${String(errcode).replace(/[^A-Za-z0-9_.]/g, '').slice(0, 40)}`, reasonWord(errcode));
}

/** A request as a person's internal account. → { status, json } of a 2xx answer; throws HsError otherwise. */
async function as(target, mxid, method, urlPath, body, max) {
  checkTarget(target);
  if (!MXID_RE.test(String(mxid || ''))) throw new HsError('ERR_INVALID', 'invalid account');
  const sep = urlPath.includes('?') ? '&' : '?';
  const r = await raw(target, method, `/_matrix/client/v3/${urlPath}${sep}user_id=${encodeURIComponent(mxid)}`, body, max);
  if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === 'object') return r.json;
  throw failure(r);
}

const room = (v) => { if (!ROOM_RE.test(String(v || ''))) throw new HsError('ERR_INVALID', 'invalid room'); return encodeURIComponent(v); };
const event = (v) => { if (!EVENT_RE.test(String(v || ''))) throw new HsError('ERR_INVALID', 'invalid event'); return encodeURIComponent(v); };
const txn = (v) => { if (!TXN_RE.test(String(v || ''))) throw new HsError('ERR_INVALID', 'invalid transaction id'); return v; };

/**
 * Make sure the internal account exists. → 'created' | 'exists'; throws when the homeserver does not answer or refuses.
 * @param {{socket:string, token:string}} target
 * @param {string} localpart gc_<user id>
 */
async function ensureUser(target, localpart) {
  try { checkTarget(target); } catch { throw new Error('invalid homeserver request'); }
  if (!LOCAL_RE.test(String(localpart || ''))) throw new Error('invalid homeserver request');
  const r = await raw(target, 'POST', '/_matrix/client/v3/register', { type: 'm.login.application_service', username: localpart, inhibit_login: true });
  if (r.status >= 200 && r.status < 300) return 'created';
  if (r.json && r.json.errcode === 'M_USER_IN_USE') return 'exists';
  throw new Error(`homeserver answered ${r.status}${r.json && typeof r.json.errcode === 'string' ? ' ' + r.json.errcode.replace(/[^A-Z_.]/g, '').slice(0, 40) : ''}`);
}

/** Accept an invite. */
async function join(target, mxid, roomId) { await as(target, mxid, 'POST', `rooms/${room(roomId)}/join`, {}); return { ok: true }; }

/** The current state events of a room the account is in → [event]. */
async function state(target, mxid, roomId) {
  const j = await as(target, mxid, 'GET', `rooms/${room(roomId)}/state`, undefined, MAX_LIST);
  if (!Array.isArray(j)) throw new HsError('ERR_BRIDGE', 'the homeserver sent no state', 'bad_answer');
  return j.slice(0, 2000);
}

/** The newest timeline events of a room, oldest first (at most `limit`, ≤ 50). */
async function recent(target, mxid, roomId, limit = 30) {
  const n = Math.max(1, Math.min(50, Number(limit) || 30));
  const j = await as(target, mxid, 'GET', `rooms/${room(roomId)}/messages?dir=b&limit=${n}`, undefined, MAX_LIST);
  return (Array.isArray(j.chunk) ? j.chunk : []).slice(0, n).reverse();
}

/** Send a timeline event (m.room.message, m.reaction). → the event id. */
async function send(target, mxid, roomId, type, txnId, content) {
  if (!TYPE_RE.test(String(type || ''))) throw new HsError('ERR_INVALID', 'invalid event type');
  const j = await as(target, mxid, 'PUT', `rooms/${room(roomId)}/send/${encodeURIComponent(type)}/${txn(txnId)}`, content);
  if (!EVENT_RE.test(String(j.event_id || ''))) throw new HsError('ERR_BRIDGE', 'the homeserver named no event', 'bad_answer');
  return j.event_id;
}

/** Redact (delete for everyone) an event. → the id of the redaction (null when the homeserver names none). */
async function redact(target, mxid, roomId, eventId, txnId) {
  const j = await as(target, mxid, 'PUT', `rooms/${room(roomId)}/redact/${event(eventId)}/${txn(txnId)}`, {});
  return EVENT_RE.test(String(j.event_id || '')) ? j.event_id : null;
}

/** The account read up to this event. */
async function read(target, mxid, roomId, eventId) { await as(target, mxid, 'POST', `rooms/${room(roomId)}/receipt/m.read/${event(eventId)}`, {}); return { ok: true }; }

/** "typing …" on or off. */
async function typing(target, mxid, roomId, on, timeoutMs = 8000) {
  await as(target, mxid, 'PUT', `rooms/${room(roomId)}/typing/${encodeURIComponent(mxid)}`, on ? { typing: true, timeout: Math.max(1000, Math.min(30000, timeoutMs)) } : { typing: false });
  return { ok: true };
}

// ─── files (stage 4) ───────────────────────────────────

/** The parts of an mxc:// address of this homeserver, or null. */
function mxcOf(v, serverName) {
  const m = MXC_RE.exec(String(v || ''));
  return m && (!serverName || m[1] === serverName) ? { server: m[1], id: m[2] } : null;
}

/**
 * Download a file as the person's internal account (authenticated media, Matrix v1.11). Nothing is held in memory:
 * → { stream, length, mime } — the caller reads `stream` to its end or destroys it. Refused before a byte is read
 * when the homeserver names more than `max` bytes (reason too_large); `length` null when it answers chunked (no
 * Content-Length) — then the caller stops at `max`.
 */
function download(target, mxid, mxc, { max, serverName } = {}) {
  checkTarget(target);
  if (!MXID_RE.test(String(mxid || ''))) throw new HsError('ERR_INVALID', 'invalid account');
  const m = mxcOf(mxc, serverName);
  if (!m) throw new HsError('ERR_INVALID', 'invalid file address');
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const r = http.request({
      socketPath: target.socket, agent: false, method: 'GET', timeout: MEDIA_TIMEOUT_MS,
      path: `/_matrix/client/v1/media/download/${encodeURIComponent(m.server)}/${encodeURIComponent(m.id)}?user_id=${encodeURIComponent(mxid)}`,
      headers: { Authorization: `Bearer ${target.token}`, Accept: '*/*' },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= 4096) chunks.push(c); });
        res.on('error', () => fail(new HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver broke off', 'unreachable')));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
          fail(failure({ status: res.statusCode, json }));
        });
        return;
      }
      // no Content-Length (an answer sent chunked): length null — the caller counts what arrives, at most `max`
      const raw = res.headers['content-length'];
      const length = raw == null && res.headers['transfer-encoding'] ? null : Number(raw);
      if (length !== null && (!Number.isSafeInteger(length) || length < 1)) { res.destroy(); fail(new HsError('ERR_BRIDGE', 'the homeserver named no length', 'bad_answer')); return; }
      if (length !== null && Number.isSafeInteger(max) && length > max) { res.destroy(); fail(new HsError('ERR_BRIDGE', 'the file is too large', 'too_large')); return; }
      const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      settled = true;
      resolve({ stream: res, length, mime: MIME_RE.test(ct) ? ct : 'application/octet-stream' });
    });
    r.on('timeout', () => r.destroy(new HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver did not answer in time', 'timeout')));
    r.on('error', (e) => fail(e instanceof HsError ? e : new HsError('ERR_BRIDGE_UNREACHABLE', e.message, e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'unreachable')));
    r.end();
  });
}

/**
 * Upload a file as the person's internal account: `length` bytes from `source` (an async iterable of Buffers),
 * written as they come. → the mxc:// address the homeserver made.
 */
function upload(target, mxid, { source, length, mime, name }) {
  checkTarget(target);
  if (!MXID_RE.test(String(mxid || ''))) throw new HsError('ERR_INVALID', 'invalid account');
  if (!Number.isSafeInteger(length) || length < 1) throw new HsError('ERR_INVALID', 'invalid length');
  const type = MIME_RE.test(String(mime || '')) ? mime : 'application/octet-stream';
  const q = `${name ? `filename=${encodeURIComponent(String(name).slice(0, 200))}&` : ''}user_id=${encodeURIComponent(mxid)}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    const r = http.request({
      socketPath: target.socket, agent: false, method: 'POST', timeout: MEDIA_TIMEOUT_MS, path: `/_matrix/media/v3/upload?${q}`,
      headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json', 'Content-Type': type, 'Content-Length': length },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      res.on('error', () => fail(new HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver broke off', 'unreachable')));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) { fail(failure({ status: res.statusCode, json })); return; }
        if (!json || !mxcOf(json.content_uri)) { fail(new HsError('ERR_BRIDGE', 'the homeserver named no file', 'bad_answer')); return; }
        settled = true;
        resolve(json.content_uri);
      });
    });
    r.on('timeout', () => r.destroy(new HsError('ERR_BRIDGE_UNREACHABLE', 'the homeserver did not answer in time', 'timeout')));
    r.on('error', (e) => fail(e instanceof HsError ? e : new HsError('ERR_BRIDGE_UNREACHABLE', e.message, e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'unreachable')));
    (async () => {
      let sent = 0;
      for await (const chunk of source) {
        if (settled || r.destroyed) return;
        sent += chunk.length;
        if (sent > length) throw new Error('more bytes than announced');
        if (!r.write(chunk)) await new Promise((ok) => { r.once('drain', ok); r.once('close', ok); });
      }
      if (sent !== length) throw new Error('fewer bytes than announced');
      if (!r.destroyed) r.end();
    })().catch((e) => { r.destroy(); fail(e instanceof HsError ? e : new HsError('ERR_BRIDGE', 'the file could not be read', 'read_failed')); });
  });
}

// ─── clean-up (stage 5) ────────────────────────────────

/** A request as the server's bot. → { status, json } of a 2xx answer; throws HsError otherwise. */
async function asBot(target, bot, method, urlPath) {
  checkTarget(target);
  if (!BOT_RE.test(String(bot || ''))) throw new HsError('ERR_INVALID', 'invalid account');
  const sep = urlPath.includes('?') ? '&' : '?';
  const r = await raw(target, method, `${urlPath}${sep}user_id=${encodeURIComponent(bot)}`, method === 'POST' ? {} : undefined);
  if (r.status >= 200 && r.status < 300) return r.json || {};
  throw failure(r);
}

/**
 * Delete a file of this homeserver (Synapse admin API, which Tuwunel serves): → 'deleted' | 'gone' (not there any
 * more). Throws HsError m_forbidden while the bot is no administrator yet.
 */
async function deleteMedia(target, bot, mxc, serverName) {
  const m = mxcOf(mxc, serverName);
  if (!m) throw new HsError('ERR_INVALID', 'invalid file address');
  try {
    await asBot(target, bot, 'DELETE', `/_synapse/admin/v1/media/${encodeURIComponent(m.server)}/${encodeURIComponent(m.id)}`);
    return 'deleted';
  } catch (e) {
    if (e && e.reason === 'm_not_found') return 'gone';
    throw e;
  }
}

/** The bot joins the admin room it was invited to (config.js admin_execute "users make-user-admin"). */
async function joinAdminRoom(target, bot, serverName) {
  if (!/^[a-z0-9.-]{1,64}$/.test(String(serverName || ''))) throw new HsError('ERR_INVALID', 'invalid server name');
  await asBot(target, bot, 'POST', `/_matrix/client/v3/join/${encodeURIComponent(`#admins:${serverName}`)}`);
  return { ok: true };
}

module.exports = { deleteMedia, joinAdminRoom, BOT_RE, ensureUser, join, state, recent, send, redact, read, typing, download, upload, mxcOf, socketOf, HsError, ROOM_RE, EVENT_RE, MXID_RE, TXN_RE, MXC_RE };
