'use strict';

// The screen relay of gc.remote (stage 5, docs/plugins.md "Remote access", docs/feature-remote-access.md):
// a phone shares its screen (MediaProjection + MediaCodec, H.264) and one helper watches it — in the
// browser (session page with WebCodecs) or later in an app. Both sides speak one protocol on one path:
//
//   /api/v1/remote/screen-relay   Sec-WebSocket-Protocol: gc-screen.v1, token.<token>
//
//   both → server   text {t:'hello', role:'sender'|'viewer', …}   first frame, within 10 s
//                        sender: { width, height, fps, scope: 'display'|'app', app: { platform, version } }
//                        viewer: { codecs: ['avc1'] }
//                        {t:'ping'} → {t:'pong'}            {t:'bye'} ends the session (both sides)
//   sender → viewer text {t:'config', codec, width, height}    before the first frame and on every change
//                        {t:'state', paused, reason?}
//                   bin  [1, flags (bit 0 key frame), 0, 0, timestamp µs uint64 BE] + one H.264 access unit, Annex B
//   viewer → sender text {t:'keyframe'}                         (throttled to one a second)
//   server → both   text {t:'ready', role, mode, peer: { name }, limits}   {t:'end', reason}   {t:'error', code}
//   server → viewer text {t:'waiting', reason?}                 no sender (yet / lost)
//   server → sender text {t:'viewer', state: 'joined'|'left', name}   {t:'keyframe'}   {t:'rate', bitrate}
//
// Stage 6 (version 5): a ticket of mode control lets the viewer operate the phone. The mode in force is
// control only when the ticket says control, the phone's hello says control: true (its accessibility service
// runs, the GitHub build) and the whole display is shared; anything else is view. The phone may go down to
// view at any time ({t:'mode', mode:'view', reason}) — for good: no frame brings control back (that takes a new
// request and a new answer at the phone). Only in control:
//   viewer → sender text {t:'input', k: 'tap'|'long'|'swipe'|'scroll'|'key'|'text', …}   coordinates 0…1 of the picture
//   sender → viewer text {t:'input_fail', k, reason}        server → both {t:'mode', mode, reason}
//   server → viewer text {t:'notice', code: 'view_only'|'input_rate'}
// The server passes on only the cleaned object (cleanInput), limits it (30 a second, text 5 a second and
// 4000 characters in 10 s) and logs none of it.
//
// The core never decodes or transcodes anything: it reads the flag byte of a frame (a viewer gets frames
// from the next key frame on, and a slow one loses delta frames until the next key frame) and counts bytes
// (a bucket per session). Key frames carry SPS/PPS in front (the phone sets KEY_PREPEND_HEADER_TO_SYNC_FRAMES),
// so nothing is cached but the last {t:'config'}. Nothing of a picture, no ref and no token is logged.
//
// A token (60 s, single use) is minted for a claimed side of a screen ticket (sessions.js): the viewer's
// ref by the session page or an app, the sender's ref only by the phone's own app token. A second
// connection of the same side (a reconnect after a network change) replaces the first.

const crypto = require('node:crypto');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

const PROTOCOL = 'gc-screen.v1';
const WS_PATH = '/api/v1/remote/screen-relay';
const TOKEN_TTL_MS = 60000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKENS_MAX = 2000;
const HELLO_MS = 10000;
const HEADER = 12;
const MAX_FRAME = 1024 * 1024;
const MAX_TEXT = 4096;
const TEXT_PER_S = 50;
const VIEWER_HIGH_WATER = 1024 * 1024;
const BUCKET_BYTES = 4 * 1024 * 1024;           // burst
const BUCKET_RATE = 6000000 / 8;                // 6 Mbit/s sustained, bytes per second
const OVER_LIMIT_MS = 30000;                    // that long over the bucket → rate_exceeded
const SENDER_GRACE_MS = 30000;                  // a lost sender may come back this long
const VIEWER_GRACE_MS = 60000;                  // a lost viewer may come back this long
const KEYFRAME_EVERY_MS = 1000;
const MAX_EDGE = 1920;
const MAX_SHORT = 1080;
const MAX_FPS = 30;
const MAX_BITRATE = 4000000;
const MIN_BITRATE = 300000;
const PER_VIEWER = 2;
const CODEC_RE = /^avc1\.[0-9A-Fa-f]{6}$/;
// the input of stage 6
const INPUT_PER_S = 30;
const TEXT_INPUTS_PER_S = 5;
const TEXT_CHARS_WINDOW_MS = 10000;
const TEXT_CHARS_PER_WINDOW = 4000;
const MAX_INPUT_TEXT = 500;
const MAX_PATH = 32;
const INPUT_FAILS_PER_S = 5;
const NOTICE_EVERY_MS = 1000;
const KEYS = Object.freeze(['back', 'home', 'recents', 'enter', 'backspace']);
const MODE_REASONS = Object.freeze(['sender', 'service_off', 'locked']);
const FAIL_REASONS = Object.freeze(['no_field', 'blocked', 'locked', 'secure']);
const LIMITS = Object.freeze({ maxBitrate: MAX_BITRATE, maxFps: MAX_FPS, maxEdge: MAX_EDGE, maxFrame: MAX_FRAME });

class ScreenError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const tokens = new Map(); // token → { ref, role, userId, via, exp }
const relays = new Map(); // ticket ref → relay

function sweepTokens(now = Date.now()) {
  for (const [k, v] of tokens) if (now >= v.exp) tokens.delete(k);
}

/** A single-use token of 60 s for one side of a claimed screen ticket → { token, wsPath, ttl, role } */
function mintToken(t, { role, via = 'browser' } = {}) {
  if (role !== 'sender' && role !== 'viewer') throw new ScreenError('invalid', 'role');
  sweepTokens();
  if (tokens.size >= TOKENS_MAX) throw new ScreenError('limit', 'too many open screen tokens');
  const token = crypto.randomBytes(32).toString('base64url');
  const userId = role === 'sender' ? t.sender.userId : t.userId;
  tokens.set(token, { ref: t.ref, role, userId, via: via === 'app' ? 'app' : 'browser', exp: Date.now() + TOKEN_TTL_MS });
  return { token, wsPath: WS_PATH, ttl: Math.floor(TOKEN_TTL_MS / 1000), role };
}

/** The token of an upgrade, used up → { ref, role, userId, via } | null */
function takeToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const e = tokens.get(token);
  if (!e) return null;
  tokens.delete(token);
  return now < e.exp ? e : null;
}

/** The token of a Sec-WebSocket-Protocol header ("gc-screen.v1, token.<t>") or null. */
function tokenOfProtocols(header) {
  const list = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.includes(PROTOCOL)) return null;
  const t = list.find((s) => s.startsWith('token.'));
  return t ? t.slice('token.'.length) : null;
}

/** The fixed head of a binary frame → { key, ts } | null (anything else is no frame of version 1). */
function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length <= HEADER || buf[0] !== 1) return null;
  return { key: (buf[1] & 1) === 1, ts: buf.readBigUInt64BE(4) };
}

/** A frame head (tests, documentation). */
function header({ key = false, ts = 0 } = {}) {
  const h = Buffer.alloc(HEADER);
  h[0] = 1;
  h[1] = key ? 1 : 0;
  h.writeBigUInt64BE(BigInt(ts), 4);
  return h;
}

function sizeOk(w, h) {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 16 || H < 16) return false;
  return Math.max(W, H) <= MAX_EDGE && Math.min(W, H) <= MAX_SHORT;
}

function cleanConfig(m) {
  if (typeof m.codec !== 'string' || !CODEC_RE.test(m.codec) || !sizeOk(m.width, m.height)) return null;
  return { t: 'config', codec: m.codec, width: Number(m.width), height: Number(m.height) };
}

function cleanSenderHello(m) {
  if (!sizeOk(m.width, m.height)) return null;
  const fps = m.fps == null ? 15 : Number(m.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > MAX_FPS) return null;
  return {
    width: Number(m.width), height: Number(m.height), fps,
    scope: m.scope === 'app' ? 'app' : 'display',
    platform: m.app && typeof m.app.platform === 'string' && /^[a-z]{1,16}$/.test(m.app.platform) ? m.app.platform : null,
  };
}

const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const delta = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1;
const round4 = (v) => Math.round(v * 10000) / 10000;
const msIn = (v, min, max, dflt) => {
  if (v == null) return dflt;
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
};

/**
 * An input frame of the viewer → the cleaned object that goes to the phone, or null (dropped). Only the
 * fields of the contract, coordinates 0…1 of the picture, rounded; text without control characters.
 */
function cleanInput(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.k) {
    case 'tap':
      return unit(m.x) && unit(m.y) ? { t: 'input', k: 'tap', x: round4(m.x), y: round4(m.y) } : null;
    case 'long': {
      const ms = msIn(m.ms, 400, 3000, 650);
      return unit(m.x) && unit(m.y) && ms != null ? { t: 'input', k: 'long', x: round4(m.x), y: round4(m.y), ms } : null;
    }
    case 'swipe': {
      const ms = msIn(m.ms, 50, 5000, null);
      if (ms == null || !Array.isArray(m.pts) || m.pts.length < 2 || m.pts.length > MAX_PATH) return null;
      const pts = [];
      for (const p of m.pts) {
        if (!Array.isArray(p) || p.length !== 2 || !unit(p[0]) || !unit(p[1])) return null;
        pts.push([round4(p[0]), round4(p[1])]);
      }
      return { t: 'input', k: 'swipe', pts, ms };
    }
    case 'scroll':
      if (!unit(m.x) || !unit(m.y) || !delta(m.dx) || !delta(m.dy) || (m.dx === 0 && m.dy === 0)) return null;
      return { t: 'input', k: 'scroll', x: round4(m.x), y: round4(m.y), dx: round4(m.dx), dy: round4(m.dy) };
    case 'key':
      return KEYS.includes(m.key) ? { t: 'input', k: 'key', key: m.key } : null;
    case 'text': {
      if (typeof m.text !== 'string') return null;
      // no control characters (also no line breaks: enter is a key of its own)
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(m.text)) return null;
      const n = [...m.text].length;
      return n >= 1 && n <= MAX_INPUT_TEXT ? { t: 'input', k: 'text', text: m.text } : null;
    }
    default:
      return null;
  }
}

function send(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* gone */ }
}

function personName(userId) {
  try {
    const u = require('../../db/connection').getDb().prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId);
    return u ? (u.display_name || u.username) : null;
  } catch { return null; }
}

// ─── Admission ───

/** Live relays (for the limits). */
function activeRelays() { return [...relays.values()].filter((r) => !r.ended); }

/**
 * May this side of the ticket connect now? → { ok } | { ok: false, reason }
 * global (GC_REMOTE_SCREEN_MAX), one session per sending device, two per watching person.
 */
function admit(t, role) {
  const mine = relays.get(t.ref);
  if (mine && !mine.ended) return { ok: true }; // a side of a running session (or its reconnect)
  const live = activeRelays();
  if (live.length >= Math.max(1, config.remoteScreen.max)) return { ok: false, reason: 'global_limit' };
  if (role === 'sender' && live.some((r) => String(r.ticket.sender.deviceId) === String(t.sender.deviceId))) return { ok: false, reason: 'sender_busy' };
  if (role === 'viewer' && live.filter((r) => r.ticket.userId === t.userId).length >= PER_VIEWER) return { ok: false, reason: 'user_limit' };
  return { ok: true };
}

// ─── The relay of one ticket ───

function relayOf(t) {
  let r = relays.get(t.ref);
  if (r && !r.ended) return r;
  r = {
    ticket: t, sender: null, viewer: null, config: null, sid: null, ended: false, createdAt: Date.now(),
    bucket: BUCKET_BYTES, bucketAt: Date.now(), overSince: null, lastKeyAsk: 0, lastRate: 0, bitrate: null,
    senderLostTimer: null, viewerLostTimer: null, waitTimer: null, maxTimer: null, viewerVia: 'browser', viewerIp: null, senderSeen: false,
    // stage 6: the mode in force (control only with the phone's control: true), the input limits
    mode: t.mode === 'control' ? 'control' : 'view', modeReason: t.mode === 'control' ? null : 'viewer_only',
    inputs: INPUT_PER_S, inputsAt: Date.now(), textInputs: 0, textInputsAt: Date.now(), textChars: [], lastNotice: 0, fails: 0, failsAt: Date.now(),
  };
  relays.set(t.ref, r);
  // the longest session (GC_REMOTE_SCREEN_MAX_MIN)
  const left = Math.max(1000, (t.expiresAt || (Date.now() + config.remoteScreen.maxMinutes * 60000)) - Date.now());
  r.maxTimer = setTimeout(() => endRelay(r, 'max_duration'), left);
  if (r.maxTimer.unref) r.maxTimer.unref();
  // the other side must come before the ticket's open time is over (plus a little)
  armWait(r);
  return r;
}

function armWait(r) {
  clearTimeout(r.waitTimer);
  const t = r.ticket;
  const until = Math.max(t.openBy || 0, Date.now()) + SENDER_GRACE_MS;
  r.waitTimer = setTimeout(() => { if (!(r.sender && r.viewer) && !r.sid) endRelay(r, 'peer_timeout'); }, Math.max(1000, until - Date.now()));
  if (r.waitTimer.unref) r.waitTimer.unref();
}

function askKeyframe(r, force = false) {
  const now = Date.now();
  if (!r.sender || (!force && now - r.lastKeyAsk < KEYFRAME_EVERY_MS)) return;
  r.lastKeyAsk = now;
  send(r.sender.ws, { t: 'keyframe' });
}

/**
 * The mode in force goes down to view — for good (the ticket too: a reconnect cannot bring control back).
 * Both sides hear it; the row, the activity log and the plugin's hook (phase mode) follow.
 */
function downgrade(r, reason) {
  if (r.mode !== 'control') return;
  r.mode = 'view';
  r.modeReason = reason;
  r.ticket.mode = 'view';
  const m = { t: 'mode', mode: 'view', reason };
  if (r.sender) send(r.sender.ws, m);
  if (r.viewer && r.viewer.hello) send(r.viewer.ws, m);
  try { require('./sessions').screenMode(r.ticket, r.sid, 'view', reason); } catch (e) { logger.debug({ err: e.message }, 'remote screen: mode not recorded'); }
}

/** A refill bucket: true = one more may pass. */
function inputAllowed(r, now) {
  r.inputs = Math.min(INPUT_PER_S, r.inputs + ((now - r.inputsAt) / 1000) * INPUT_PER_S);
  r.inputsAt = now;
  if (r.inputs < 1) return false;
  r.inputs -= 1;
  return true;
}

function textAllowed(r, chars, now) {
  if (now - r.textInputsAt >= 1000) { r.textInputsAt = now; r.textInputs = 0; }
  if (r.textInputs >= TEXT_INPUTS_PER_S) return false;
  r.textChars = r.textChars.filter((e) => now - e.at < TEXT_CHARS_WINDOW_MS);
  const used = r.textChars.reduce((a, e) => a + e.n, 0);
  if (used + chars > TEXT_CHARS_PER_WINDOW) return false;
  r.textInputs++;
  r.textChars.push({ at: now, n: chars });
  return true;
}

function notice(r, code, now = Date.now()) {
  if (!r.viewer || now - r.lastNotice < NOTICE_EVERY_MS) return;
  r.lastNotice = now;
  send(r.viewer.ws, { t: 'notice', code });
}

/** The viewer's input (stage 6): only in control, cleaned and limited, then to the phone. Nothing of it is logged. */
function onInput(r, m) {
  const now = Date.now();
  if (r.mode !== 'control') { notice(r, 'view_only', now); return; }
  if (!r.sender || !r.sender.hello) return;
  const c = cleanInput(m);
  if (!c) return;
  if (!inputAllowed(r, now) || (c.k === 'text' && !textAllowed(r, [...c.text].length, now))) { notice(r, 'input_rate', now); return; }
  send(r.sender.ws, c);
}

/** Both sides are there for the first time: the row of remote_sessions and the hook start. */
function maybeStart(r) {
  if (r.sid || !r.sender || !r.viewer || r.ended) return;
  const sessions = require('./sessions');
  const t = r.ticket;
  try {
    r.sid = sessions.opened({
      remoteRef: t.ref, remotePlugin: t.pluginId, remoteTarget: t.target.id, remoteUser: t.userId, protocol: 'screen', remoteMode: t.mode,
    }, { clientIp: r.viewerIp, engine: 'screen', via: r.viewerVia, close: (why) => endRelay(r, why || 'ended_by_plugin', { fromSessions: true }) });
    sessions.started(r.sid, {});
  } catch (e) { logger.warn({ err: e.message }, 'remote screen: session row not written'); }
}

function clearTimers(r) {
  clearTimeout(r.senderLostTimer);
  clearTimeout(r.viewerLostTimer);
  clearTimeout(r.waitTimer);
  clearTimeout(r.maxTimer);
}

/** End the relay of a ticket: both sides get {t:'end', reason}, the ticket goes (no reconnect after it). */
function endRelay(r, reason, { fromSessions = false } = {}) {
  if (!r || r.ended) return;
  r.ended = true;
  clearTimers(r);
  for (const side of [r.sender, r.viewer]) {
    if (!side) continue;
    send(side.ws, { t: 'end', reason });
    closeSide(side);
  }
  r.sender = null;
  r.viewer = null;
  relays.delete(r.ticket.ref);
  const sessions = require('./sessions');
  sessions.dropScreenTicket(r.ticket.ref);
  // sender / viewer end a session normally (hook phase end), anything else is an abort (sessions.NORMAL_REASONS)
  if (r.sid && !fromSessions) { try { sessions.end(r.sid, reason); } catch { /* ended */ } }
  if (!r.sid) sessions.screenAborted(r.ticket, reason);
}

function closeSide(side, code = 1000) {
  clearInterval(side.hb);
  clearTimeout(side.helloTimer);
  try { side.ws.close(code); } catch { /* gone */ }
  const kill = setTimeout(() => { try { side.ws.terminate(); } catch { /* gone */ } }, 2000);
  if (kill.unref) kill.unref();
}

/** A side is gone without bye: the other waits (sender 30 s, viewer 60 s) for a reconnect. */
function lost(r, role) {
  if (r.ended) return;
  if (role === 'sender') {
    r.sender = null;
    if (r.viewer) send(r.viewer.ws, { t: 'waiting', reason: 'sender_lost' });
    clearTimeout(r.senderLostTimer);
    r.senderLostTimer = setTimeout(() => { if (!r.sender) endRelay(r, r.sid ? 'sender_lost' : 'peer_timeout'); }, SENDER_GRACE_MS);
    if (r.senderLostTimer.unref) r.senderLostTimer.unref();
  } else {
    r.viewer = null;
    if (r.sender) send(r.sender.ws, { t: 'viewer', state: 'left', name: personName(r.ticket.userId) });
    clearTimeout(r.viewerLostTimer);
    r.viewerLostTimer = setTimeout(() => { if (!r.viewer) endRelay(r, r.sid ? 'viewer_lost' : 'peer_timeout'); }, VIEWER_GRACE_MS);
    if (r.viewerLostTimer.unref) r.viewerLostTimer.unref();
  }
}

/** The byte bucket of a session: true = the frame may pass. */
function take(r, n, now = Date.now()) {
  r.bucket = Math.min(BUCKET_BYTES, r.bucket + ((now - r.bucketAt) / 1000) * BUCKET_RATE);
  r.bucketAt = now;
  if (r.bucket >= n) {
    r.bucket -= n;
    if (r.bucket > BUCKET_BYTES / 2) r.overSince = null;
    return true;
  }
  if (!r.overSince) r.overSince = now;
  return false;
}

/** Tell the sender to lower its bitrate (at most once a second). */
function suggestRate(r, now = Date.now()) {
  if (!r.sender || now - r.lastRate < 1000) return;
  r.lastRate = now;
  const cur = r.bitrate || MAX_BITRATE;
  r.bitrate = Math.max(MIN_BITRATE, Math.floor(cur * 0.7));
  send(r.sender.ws, { t: 'rate', bitrate: r.bitrate });
}

function onFrame(r, side, data) {
  if (side.role !== 'sender' || !side.hello) return; // a viewer sends no pictures (its input is text)
  const h = parseHeader(data);
  if (!h) return;
  const now = Date.now();
  if (!take(r, data.length, now)) {
    if (r.viewer) r.viewer.needKey = true;
    suggestRate(r, now);
    if (r.overSince && now - r.overSince > OVER_LIMIT_MS) { send(side.ws, { t: 'error', code: 'rate_exceeded' }); endRelay(r, 'rate_exceeded'); }
    return;
  }
  const v = r.viewer;
  if (!v || !v.hello) return;
  if (v.needKey && !h.key) { askKeyframe(r); return; }
  if (v.ws.bufferedAmount > VIEWER_HIGH_WATER && !h.key) {
    // the viewer cannot keep up: drop until the next key frame, ask for one, a lower bitrate
    v.needKey = true;
    askKeyframe(r);
    suggestRate(r, now);
    return;
  }
  v.needKey = false;
  try { v.ws.send(data, { binary: true }); } catch { /* gone */ }
}

function onText(r, side, m) {
  if (m.t === 'ping') { send(side.ws, { t: 'pong' }); return; }
  if (m.t === 'bye') { endRelay(r, side.role); return; }
  if (!side.hello) return;
  if (side.role === 'sender') {
    if (m.t === 'config') {
      const c = cleanConfig(m);
      if (!c) { send(side.ws, { t: 'error', code: 'bad_frame' }); endRelay(r, 'bad_frame'); return; }
      r.config = c;
      if (r.viewer && r.viewer.hello) { r.viewer.needKey = true; send(r.viewer.ws, c); }
      return;
    }
    if (m.t === 'state' && typeof m.paused === 'boolean') {
      const reason = ['locked', 'secure', 'rotating'].includes(m.reason) ? m.reason : null;
      if (r.viewer) send(r.viewer.ws, { t: 'state', paused: m.paused, ...(reason ? { reason } : {}) });
      return;
    }
    // the phone goes down to view (its "Nur ansehen", the service went off, …) — never up
    if (m.t === 'mode') {
      if (m.mode === 'view') downgrade(r, MODE_REASONS.includes(m.reason) ? m.reason : 'sender');
      return;
    }
    // an input could not be carried out (no field, locked, …): the viewer hears it, at most 5 a second
    if (m.t === 'input_fail' && r.viewer && r.viewer.hello) {
      const now = Date.now();
      if (now - r.failsAt >= 1000) { r.failsAt = now; r.fails = 0; }
      if (++r.fails > INPUT_FAILS_PER_S) return;
      const k = ['tap', 'long', 'swipe', 'scroll', 'key', 'text'].includes(m.k) ? m.k : null;
      send(r.viewer.ws, { t: 'input_fail', ...(k ? { k } : {}), reason: FAIL_REASONS.includes(m.reason) ? m.reason : 'blocked' });
    }
    return;
  }
  // the viewer: a key frame, and (stage 6) its input — only in control mode
  if (m.t === 'keyframe') { if (r.viewer) r.viewer.needKey = true; askKeyframe(r); return; }
  if (m.t === 'input') onInput(r, m);
}

function onHello(r, side, m) {
  clearTimeout(side.helloTimer);
  if (m.role !== side.role) { send(side.ws, { t: 'error', code: 'role_mismatch' }); closeSide(side); return; }
  const t = r.ticket;
  if (side.role === 'sender') {
    const h = cleanSenderHello(m);
    if (!h) { send(side.ws, { t: 'error', code: 'bad_frame' }); closeSide(side); return; }
    side.info = h;
    side.hello = true;
    const back = r.senderSeen;
    r.senderSeen = true;
    const old = r.sender;
    r.sender = side;
    if (old && old !== side) { send(old.ws, { t: 'error', code: 'replaced' }); closeSide(old, 4000); }
    clearTimeout(r.senderLostTimer);
    // the mode in force: control only when the phone can carry input out and shares the whole display
    if (r.mode === 'control' && (m.control !== true || h.scope !== 'display')) downgrade(r, m.control !== true ? 'sender_no_control' : 'app_scope');
    send(side.ws, { t: 'ready', role: 'sender', mode: r.mode, ...(r.modeReason ? { modeReason: r.modeReason } : {}), peer: { name: personName(t.userId) }, limits: LIMITS });
    if (r.viewer) {
      send(side.ws, { t: 'viewer', state: 'joined', name: personName(t.userId) });
      // the phone is back after a lost connection: the viewer's "waiting" goes
      if (back) send(r.viewer.ws, { t: 'state', paused: false });
      r.viewer.needKey = true;
      askKeyframe(r, true);
    }
  } else {
    const codecs = Array.isArray(m.codecs) ? m.codecs.map(String) : ['avc1'];
    if (!codecs.some((c) => c === 'avc1' || c.startsWith('avc1.'))) { send(side.ws, { t: 'error', code: 'codec_unsupported' }); closeSide(side); return; }
    side.hello = true;
    side.needKey = true;
    const old = r.viewer;
    r.viewer = side;
    if (old && old !== side) { send(old.ws, { t: 'error', code: 'replaced' }); closeSide(old, 4000); }
    clearTimeout(r.viewerLostTimer);
    send(side.ws, { t: 'ready', role: 'viewer', mode: r.mode, ...(r.modeReason ? { modeReason: r.modeReason } : {}), peer: { name: t.target.name || null }, limits: LIMITS });
    if (r.config) send(side.ws, r.config);
    if (r.sender) {
      send(r.sender.ws, { t: 'viewer', state: 'joined', name: personName(t.userId) });
      askKeyframe(r, true);
    } else send(side.ws, { t: 'waiting' });
  }
  maybeStart(r);
}

/**
 * Run one side of a screen session on an accepted WebSocket. `entry` is the used-up token.
 * Resolves when this side is gone.
 */
function run(ws, ticket, entry, { clientIp = null } = {}) {
  return new Promise((resolve) => {
    const r = relayOf(ticket);
    const side = { ws, role: entry.role, hello: false, needKey: true, info: null, hb: null, helloTimer: null, texts: 0, textsAt: Date.now() };
    if (entry.role === 'viewer') { r.viewerVia = entry.via; r.viewerIp = clientIp; }
    let missed = 0;
    side.hb = setInterval(() => {
      if (missed >= config.guac.heartbeatMisses) { try { ws.terminate(); } catch { /* gone */ } return; }
      missed++;
      try { ws.ping(); } catch { /* gone */ }
    }, config.guac.heartbeatMs);
    if (side.hb.unref) side.hb.unref();
    ws.on('pong', () => { missed = 0; if (r.sid) require('./sessions').heartbeat(r.sid); });
    side.helloTimer = setTimeout(() => { send(ws, { t: 'error', code: 'hello_timeout' }); closeSide(side); }, HELLO_MS);

    ws.on('message', (data, isBinary) => {
      if (r.ended) return;
      if (isBinary) { onFrame(r, side, data); return; }
      if (data.length > MAX_TEXT) return;
      const now = Date.now();
      if (now - side.textsAt >= 1000) { side.textsAt = now; side.texts = 0; }
      if (++side.texts > TEXT_PER_S) return;
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      if (m.t === 'hello' && !side.hello) { onHello(r, side, m); return; }
      onText(r, side, m);
    });
    const gone = () => {
      clearInterval(side.hb);
      clearTimeout(side.helloTimer);
      if (!r.ended) {
        if (side.role === 'sender' && r.sender === side) lost(r, 'sender');
        else if (side.role === 'viewer' && r.viewer === side) lost(r, 'viewer');
      }
      resolve();
    };
    ws.on('close', gone);
    ws.on('error', () => { try { ws.terminate(); } catch { /* gone */ } });
  });
}

/** gc.remote.end / the plugin stopped: the relay of a ticket ends now. */
function endRef(ref, reason = 'ended_by_plugin') {
  const r = relays.get(ref);
  if (r) endRelay(r, reason);
}

/** Running relays (diagnostics, tests). */
function count() { return activeRelays().length; }

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  tokens.clear();
  for (const r of relays.values()) { r.ended = true; clearTimers(r); }
  relays.clear();
}

module.exports = {
  PROTOCOL, WS_PATH, HEADER, MAX_FRAME, LIMITS, ScreenError, mintToken, takeToken, tokenOfProtocols, parseHeader, header, admit, run, endRef, count, cleanInput,
  _resetForTest,
};
