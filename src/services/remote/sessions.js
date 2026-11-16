'use strict';

// Sessions of gc.remote (docs/plugins.md "Remote access"). The plugin decides
// WHO may connect WHERE; the core builds the session and owns the transport:
//
//   1. gc.remote.session({ user, target, protocol, mode, record, credential, options })
//      → a TICKET: a single-use address /remote/session/<ref> of a GateControl
//      page (never the plugin's frame — that one has connect-src 'none'). The
//      plugin hands `ref` to its frame, which opens the page with
//      GC.openSession(ref).
//   2. The person opens the page: only the person named in `user`, signed in
//      (web or portal session), and only in the browser session that opened it
//      first (the ticket is bound to it; another browser gets "not found").
//      Opened within `ttlS` (default 120 s) or never.
//   3. The page asks for a guacamole token (POST …/token): every time a fresh
//      single-use token of 60 s (services/guacToken.js — the same as the old
//      browser sessions), limits checked (config.guac: overall together with
//      the old RDP sessions, per person, per target), the password resolved
//      from the vault only now.
//   4. The tunnel (/api/v1/remote/guac-tunnel, tunnel/guacTunnel.js) checks the
//      token and the ticket again, then runs the session with the heartbeat of
//      the old sessions; each opened tunnel is a row of remote_sessions.
//   5. Hook `remoteSession` of the plugin: { phase: start | end | abort, … }.
//
// Stage 5 (version 4): gc.remote.screen({ viewer, sender: { user, device }, target }) → a screen ticket
// with two sides: `ref` (the viewer: the session page or an app) and `senderRef` (only the phone's own app
// token). Both turn into tokens of the relay gc-screen.v1 (screen.js); nothing goes through guacd.
//
// A ticket lives until gc.remote.end, until its plugin stops or loses its
// licence, or for maxTicketMs after it was opened (reconnects in between mint
// new tokens). Nothing of this is persisted: a restart ends every ticket (the
// rows of the open tunnels are closed as "server_restart").

const crypto = require('node:crypto');
const config = require('../../../config/default');
const logger = require('../../utils/logger');
const targets = require('./targets');
const vault = require('./vault');

class SessionError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const PROTOCOLS = Object.freeze(['rdp', 'vnc', 'ssh', 'telnet']);
const MODES = Object.freeze(['view', 'control']);
// version 3: guac (guacd, every protocol) | term (the SSH terminal of the core, term.js — ssh only)
const ENGINES = Object.freeze(['guac', 'term']);
const PLAY_TTL_S = 60;
const PLAY_MAX_MS = 2 * 60 * 60 * 1000;
const REF_RE = /^[A-Za-z0-9_-]{43}$/;
const TTL_DEFAULT_S = 120;
const TTL_MIN_S = 30;
const TTL_MAX_S = 600;
const MAX_TICKET_MS = 8 * 60 * 60 * 1000;
const TICKETS_MAX = 500;
const WS_PATH = '/api/v1/remote/guac-tunnel';

// options a plugin may set — the columns of the old rdp_routes with the same meaning
// (services/guacSettings.js builds the guacd settings from them, so a target taken over
// from an RDP route connects exactly as before)
const OPTION_RULES = Object.freeze({
  browser_clipboard: 'bool',
  color_depth: [8, 16, 24, 32],
  nla_enabled: 'bool',
  network_profile: ['lan', 'broadband', 'modem', 'auto'],
  disable_wallpaper: 'bool',
  disable_themes: 'bool',
  disable_animations: 'bool',
  redirect_printers: 'bool',
  rdp_disable_audio: 'bool',
  resolution_mode: ['fullscreen', 'fixed', 'dynamic'],
  resolution_width: 'dim',
  resolution_height: 'dim',
  domain: 'text',
});

const tickets = new Map(); // ref → ticket
const senderRefs = new Map(); // senderRef of a screen ticket → its ref
const live = new Map();    // remote_sessions.id → { close(reason) }

function db() { return require('../../db/connection').getDb(); }

function cleanOptions(o) {
  const out = {};
  if (o == null) return out;
  if (typeof o !== 'object' || Array.isArray(o)) throw new SessionError('invalid', 'options: an object');
  for (const [k, v] of Object.entries(o)) {
    if (k === 'tmux') continue; // the terminal's (create)
    const rule = OPTION_RULES[k];
    if (!rule) throw new SessionError('invalid', `options.${k}: unknown`);
    if (v == null) continue;
    if (rule === 'bool') { if (typeof v !== 'boolean') throw new SessionError('invalid', `options.${k}: true or false`); out[k] = v ? 1 : 0; }
    else if (rule === 'dim') { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 7680) throw new SessionError('invalid', `options.${k}: 1…7680`); out[k] = n; }
    else if (rule === 'text') { if (typeof v !== 'string' || v.length > 256) throw new SessionError('invalid', `options.${k}: ≤ 256 characters`); out[k] = v; }
    else if (!rule.includes(v)) throw new SessionError('invalid', `options.${k}: one of ${rule.join(', ')}`);
    else out[k] = v;
  }
  return out;
}

function userOf(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new SessionError('invalid', 'user: a user id');
  const u = db().prepare('SELECT id, username, display_name, enabled FROM users WHERE id = ?').get(n);
  if (!u || u.enabled !== 1) throw new SessionError('not_found', 'no such enabled person');
  return u;
}

function licensed(plugin) {
  try { return !!require('../plugins/licensing').status(plugin).licensed; } catch { return false; }
}

function running(pluginId) {
  try { return require('../plugins/runtime').info(pluginId).state === 'running'; } catch { return false; }
}

function sweep(now = Date.now()) {
  for (const [ref, t] of tickets) {
    let dead;
    if (t.engine === 'screen') dead = now >= t.expiresAt || (!t.claimedBy && !t.senderClaimedAt && now >= t.openBy);
    else dead = t.claimedBy ? now >= t.expiresAt : now >= t.openBy;
    if (dead && !liveOf(ref).length) {
      tickets.delete(ref);
      if (t.senderRef) senderRefs.delete(t.senderRef);
    }
  }
}

function liveOf(ref) {
  const out = [];
  for (const [id, l] of live) if (l.ref === ref) out.push(id);
  return out;
}

// ─── Admission (shared guacd: the old RDP sessions count towards the overall limit) ───

function isStale(lastHeartbeat) {
  if (!lastHeartbeat) return false;
  return Date.now() - Date.parse(lastHeartbeat + 'Z') > config.guac.heartbeatMs * config.guac.heartbeatMisses;
}

function activeRows() {
  try { return db().prepare("SELECT id, plugin_id, target_id, user_id, last_heartbeat, engine FROM remote_sessions WHERE status = 'active'").all(); } catch { return []; }
}

/** Active remote sessions (for the overall limit of guacSessions.admitSession). */
function activeCount() { return activeRows().length; }

function admit({ pluginId, targetId, userId }) {
  for (const s of activeRows()) if (!live.has(s.id) && isStale(s.last_heartbeat)) end(s.id, 'reclaimed');
  const rows = activeRows();
  let rdp = 0;
  try { rdp = db().prepare("SELECT COUNT(*) AS c FROM rdp_sessions WHERE status = 'active'").get().c; } catch { rdp = 0; }
  // the overall limit is guacd's: terminal sessions of the core (engine term) do not use it
  if (rows.filter((s) => s.engine !== 'term').length + rdp >= config.guac.maxGlobal) return { ok: false, reason: 'global_limit' };
  if (rows.filter((s) => s.plugin_id === pluginId && s.target_id === targetId).length >= config.guac.maxPerRoute) return { ok: false, reason: 'target_limit' };
  if (rows.filter((s) => s.user_id === userId).length >= config.guac.maxPerUser) return { ok: false, reason: 'user_limit' };
  return { ok: true };
}

// ─── Tickets ─────────────────────────────────────

/**
 * gc.remote.session({ user, target, protocol, engine?, mode?, record?, credential?, options?, ttlS? })
 * → { ref, url, expiresAt, mode, protocol, engine, record, from }
 * engine term (ssh only, version 3): the terminal of the core; options.tmux { attach | create: name }.
 */
async function create(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  if (!licensed(plugin)) throw new SessionError('unlicensed', 'the plugin has no valid licence — no new sessions');
  const user = userOf(o.user);
  const protocol = String(o.protocol || '');
  if (!PROTOCOLS.includes(protocol)) throw new SessionError('invalid', `protocol: one of ${PROTOCOLS.join(', ')}`);
  const mode = o.mode == null ? 'control' : String(o.mode);
  if (!MODES.includes(mode)) throw new SessionError('invalid', 'mode: view or control');
  const engine = o.engine == null ? 'guac' : String(o.engine);
  if (!ENGINES.includes(engine)) throw new SessionError('invalid', 'engine: guac or term');
  if (engine === 'term' && protocol !== 'ssh') throw new SessionError('invalid', 'engine term: protocol ssh only');
  if (o.record != null && typeof o.record !== 'boolean') throw new SessionError('invalid', 'record: true or false');
  const record = o.record === true;
  if (record) {
    const why = require('./recordings').refusal(engine);
    if (why) throw new SessionError('recording_unavailable', why);
  }
  let tmux = null;
  if (o.options && typeof o.options === 'object' && !Array.isArray(o.options) && o.options.tmux != null) {
    if (engine !== 'term') throw new SessionError('invalid', 'options.tmux: engine term only');
    try { tmux = require('./term').cleanTmux(o.options.tmux); } catch (e) { throw new SessionError('invalid', e.message); }
  }
  const target = targets.normalise(o.target);
  const ep = await targets.endpoint(plugin, target);
  if (!ep.host) throw new SessionError('listener_required', 'a LAN target of a gateway needs a listener (gc.remote.listener)');
  const credential = o.credential == null ? null : String(o.credential);
  if (credential != null) {
    const meta = vault.isHandle(credential) ? vault.info(plugin.id, credential) : null;
    if (!meta) throw new SessionError('credential_not_found', 'no such vault entry of this plugin');
    if (!meta.readable) throw new SessionError('credential_unreadable', 'the vault entry cannot be read (server key changed) — enter it again');
    if (engine === 'term' && !(meta.has.username && (meta.has.password || meta.has.privateKey))) throw new SessionError('credential_required', 'the terminal needs a username and a password or a key');
  } else if (engine === 'term') throw new SessionError('credential_required', 'the terminal needs a vault entry (username and a password or a key)');
  const options = cleanOptions(o.options);
  const ttlS = o.ttlS == null ? TTL_DEFAULT_S : Number(o.ttlS);
  if (!Number.isInteger(ttlS) || ttlS < TTL_MIN_S || ttlS > TTL_MAX_S) throw new SessionError('invalid', `ttlS: ${TTL_MIN_S}…${TTL_MAX_S}`);
  const pre = admit({ pluginId: plugin.id, targetId: target.id, userId: user.id });
  if (!pre.ok) throw new SessionError('limit', pre.reason);
  sweep();
  if (tickets.size >= TICKETS_MAX) throw new SessionError('limit', 'too_many_tickets');
  const ref = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  tickets.set(ref, {
    kind: 'session', ref, pluginId: plugin.id, userId: user.id, target, protocol, engine, mode, record, tmux, credential, options,
    createdAt: now, openBy: now + ttlS * 1000, claimedBy: null, claimedAt: null, expiresAt: null, tokens: 0,
  });
  // from (version 2): where guacd's connection comes from — the hub address for a direct target, so a
  // Windows PC opens 3389 for exactly it (stage 2); a listener target is reached through its gateway
  // (the terminal of the core connects from the same address)
  const from = target.listener ? null : targets.hubIp();
  return { ref, url: '/remote/session/' + ref, expiresAt: new Date(now + ttlS * 1000).toISOString(), mode, protocol, engine, record, from };
}

function screenMaxMs() {
  return Math.max(1, Number(config.remoteScreen && config.remoteScreen.maxMinutes) || 240) * 60000;
}

/**
 * gc.remote.screen({ viewer, sender: { user, device }, target: { id, name? }, mode?, record?, ttlS? }) (version 4)
 * → { ref, url, expiresAt, senderRef, senderExpiresAt, mode, protocol: 'screen', engine: 'screen', record: false }
 * A phone shares its screen with one person: `viewer` watches (the session page or an app), the app device
 * `sender.device` of `sender.user` sends. Only watching in stage 5 (mode view); no recording yet.
 */
function createScreen(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  if (!licensed(plugin)) throw new SessionError('unlicensed', 'the plugin has no valid licence — no new sessions');
  const viewer = userOf(o.viewer);
  const s = o.sender && typeof o.sender === 'object' ? o.sender : {};
  const owner = userOf(s.user);
  const D = require('../plugins/devices');
  const deviceId = D.idOf(s.device);
  if (deviceId === null) throw new SessionError('invalid', 'sender.device: an app device id');
  if (!D.ownedBy([owner.id], [deviceId]).has(deviceId)) throw new SessionError('not_allowed', 'sender.device is no app device of sender.user');
  const mode = o.mode == null ? 'view' : String(o.mode);
  if (mode !== 'view') throw new SessionError('invalid', 'mode: view (control comes later)');
  if (o.record === true) throw new SessionError('recording_unavailable', 'a screen session is not recorded');
  if (o.record != null && typeof o.record !== 'boolean') throw new SessionError('invalid', 'record: true or false');
  const tg = o.target && typeof o.target === 'object' ? o.target : {};
  const tid = tg.id == null ? '' : String(tg.id);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(tid)) throw new SessionError('invalid', 'target.id: 1…64 of A-Z a-z 0-9 _ . : -');
  const tname = typeof tg.name === 'string' ? tg.name.slice(0, 100) : null;
  const ttlS = o.ttlS == null ? TTL_DEFAULT_S : Number(o.ttlS);
  if (!Number.isInteger(ttlS) || ttlS < TTL_MIN_S || ttlS > TTL_MAX_S) throw new SessionError('invalid', `ttlS: ${TTL_MIN_S}…${TTL_MAX_S}`);
  sweep();
  if (tickets.size >= TICKETS_MAX) throw new SessionError('limit', 'too_many_tickets');
  const ref = crypto.randomBytes(32).toString('base64url');
  const senderRef = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  tickets.set(ref, {
    kind: 'session', ref, senderRef, pluginId: plugin.id, userId: viewer.id, sender: { userId: owner.id, deviceId },
    target: { id: tid, name: tname }, protocol: 'screen', engine: 'screen', mode, record: false, tmux: null, credential: null, options: {},
    createdAt: now, openBy: now + ttlS * 1000, claimedBy: null, claimedAt: null, senderClaimedAt: null, expiresAt: now + screenMaxMs(), tokens: 0,
  });
  senderRefs.set(senderRef, ref);
  const exp = new Date(now + ttlS * 1000).toISOString();
  return { ref, url: '/remote/session/' + ref, expiresAt: exp, senderRef, senderExpiresAt: exp, mode, protocol: 'screen', engine: 'screen', record: false };
}

/**
 * The sending side of a screen ticket for an app request (POST /api/v1/client/remote/screen-token):
 * only the person and the app device the plugin named, within the open time → the ticket or null.
 */
function claimSender(senderRef, userId, tokenId, now = Date.now()) {
  if (typeof senderRef !== 'string' || !REF_RE.test(senderRef) || tokenId == null) return null;
  const ref = senderRefs.get(senderRef);
  const t = ref ? tickets.get(ref) : null;
  if (!t || t.engine !== 'screen' || t.sender.userId !== userId || String(t.sender.deviceId) !== String(tokenId)) return null;
  if (now >= t.expiresAt) return null;
  if (!t.senderClaimedAt) {
    if (now >= t.openBy) return null;
    t.senderClaimedAt = now;
  }
  return t;
}

/** The screen ticket is over (screen.js ended its relay): neither side can connect again. */
function dropScreenTicket(ref) {
  const t = tickets.get(ref);
  if (!t || t.engine !== 'screen') return;
  tickets.delete(ref);
  senderRefs.delete(t.senderRef);
}

/** A screen session ended before both sides were there (no row): the plugin hears it as an abort. */
function screenAborted(t, reason) {
  emit(t.pluginId, {
    phase: 'abort', sessionId: null, ref: t.ref, targetId: t.target.id, userId: t.userId, protocol: 'screen', mode: t.mode,
    engine: 'screen', via: null, record: false, recordingId: null, startedAt: null, reason: String(reason || 'abort'), durationSeconds: 0, endedAt: new Date().toISOString(),
  });
}

/**
 * A playback ticket of a recording (recordings.stream) → { ref, url, expiresAt, format } — the same
 * page and the same rules as a session: only this person, the first browser session, opened
 * within 60 s, then for two hours (seeking and playing again).
 */
function createPlayback(plugin, { user, recording }) {
  const u = userOf(user);
  sweep();
  if (tickets.size >= TICKETS_MAX) throw new SessionError('limit', 'too_many_tickets');
  const ref = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  tickets.set(ref, {
    kind: 'play', ref, pluginId: plugin.id, userId: u.id, recording: { id: recording.id, format: recording.format, protocol: recording.protocol, targetId: recording.targetId },
    createdAt: now, openBy: now + PLAY_TTL_S * 1000, claimedBy: null, claimedAt: null, expiresAt: null,
  });
  return { ref, url: '/remote/session/' + ref, expiresAt: new Date(now + PLAY_TTL_S * 1000).toISOString(), format: recording.format };
}

/**
 * The ticket behind a page request: `userId` must be its person, `sid` the browser session that
 * opened it first (bound on first use). null for anything else — unknown, expired, another
 * person, another browser — always the same answer.
 */
function claim(ref, userId, sid, now = Date.now()) {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || !sid) return null;
  const t = tickets.get(ref);
  if (!t || t.userId !== userId) return null;
  if (!t.claimedBy) {
    if (now >= t.openBy) {
      // a screen ticket whose viewer never came: screen.js ends a waiting sender (peer_timeout)
      if (t.engine !== 'screen') tickets.delete(ref);
      return null;
    }
    t.claimedBy = sid;
    t.claimedAt = now;
    // a screen ticket keeps its end (GC_REMOTE_SCREEN_MAX_MIN from its creation)
    if (t.engine !== 'screen') t.expiresAt = now + (t.kind === 'play' ? PLAY_MAX_MS : MAX_TICKET_MS);
    if (t.kind === 'play') viewed(t);
  } else if (t.claimedBy !== sid || now >= t.expiresAt) return null;
  return t;
}

/** A session ticket opened by an app (POST /api/v1/client/remote/term-token): bound to that app token. */
function claimApp(ref, userId, tokenId, now = Date.now()) {
  if (tokenId == null) return null;
  const t = claim(ref, userId, 'app:' + String(tokenId), now);
  return t && t.kind === 'session' ? t : null;
}

/** A playback was opened: the activity log and the plugin (hook remoteSession, phase recording_viewed). */
function viewed(t) {
  try {
    require('../activity').log('remote_recording_viewed', `Remote recording viewed via plugin "${t.pluginId}"`, {
      source: 'plugin', severity: 'info', details: { plugin: t.pluginId, recording: t.recording.id, targetId: t.recording.targetId, userId: t.userId },
    });
  } catch { /* best-effort */ }
  emit(t.pluginId, { phase: 'recording_viewed', recordingId: t.recording.id, targetId: t.recording.targetId, userId: t.userId, at: new Date().toISOString() });
}

function pluginOf(pluginId) {
  try { return require('../plugins/registry').get(pluginId); } catch { return null; }
}

/**
 * A guacamole token for a claimed ticket (the session page asks for one per connect / reconnect)
 * → { ok: true, token, wsPath, ttl } | { ok: false, status, code }
 */
async function mint(t, { clientIp, via = 'browser', role = 'viewer' } = {}) {
  if (!t || t.kind !== 'session') return { ok: false, status: 404, code: 'not_found' };
  const plugin = pluginOf(t.pluginId);
  if (!plugin || !running(plugin.id)) return { ok: false, status: 503, code: 'plugin_unavailable' };
  if (!licensed(plugin)) return { ok: false, status: 403, code: 'unlicensed' };
  if (t.engine === 'screen') {
    // the relay of the core (screen.js): its own limits, nothing of guacd
    if (Date.now() >= t.expiresAt) return { ok: false, status: 404, code: 'not_found' };
    const screen = require('./screen');
    const adm = screen.admit(t, role);
    if (!adm.ok) return { ok: false, status: 429, code: 'limit_reached' };
    let r;
    try { r = screen.mintToken(t, { role, via }); } catch { return { ok: false, status: 429, code: 'limit_reached' }; }
    t.tokens++;
    return { ok: true, ...r, engine: 'screen' };
  }
  const adm = admit({ pluginId: t.pluginId, targetId: t.target.id, userId: t.userId });
  if (!adm.ok) return { ok: false, status: 429, code: 'limit_reached' };
  let ep;
  try { ep = await targets.endpoint(plugin, t.target); } catch (e) { return { ok: false, status: 409, code: 'target_' + ((e && e.code) || 'invalid') }; }
  if (!ep.host) return { ok: false, status: 409, code: 'listener_required' };
  if (t.engine === 'term') {
    // the terminal of the core: the secret is taken from the vault only when the connection is made
    const meta = t.credential ? vault.info(t.pluginId, t.credential) : null;
    if (!meta || !meta.readable) return { ok: false, status: 409, code: 'credential_unreadable' };
    let r;
    try { r = require('./term').mintToken(t, { via }); } catch { return { ok: false, status: 429, code: 'limit_reached' }; }
    t.tokens++;
    return { ok: true, ...r, engine: 'term' };
  }
  let secret = {};
  if (t.credential) {
    secret = vault.resolve(t.pluginId, t.credential);
    if (!secret) return { ok: false, status: 409, code: 'credential_unreadable' };
  }
  const route = {
    protocol: t.protocol, host: ep.host, port: ep.port, access_mode: 'internal',
    ...t.options,
    domain: secret.domain || t.options.domain || null,
  };
  const { buildConnectionSettings } = require('../guacSettings');
  const conn = buildConnectionSettings(route, {
    username: secret.username || null, password: secret.password || null,
    ssh_private_key: secret.privateKey || null, ssh_passphrase: secret.passphrase || null,
  });
  if (t.mode === 'view') conn.settings['read-only'] = 'true';
  // a recording: guacd writes it onto the drive (recordings.js); the row comes when the tunnel opens
  let remoteRecording = null;
  if (t.record) {
    let plan;
    try { plan = require('./recordings').planGuac(); } catch { return { ok: false, status: 409, code: 'recording_unavailable' }; }
    Object.assign(conn.settings, plan.settings);
    remoteRecording = plan.id;
  }
  const { token, ttlMs } = require('../guacToken').mint({
    ...conn,
    remoteRef: t.ref, remotePlugin: t.pluginId, remoteTarget: t.target.id, remoteUser: t.userId,
    remoteMode: t.mode, protocol: t.protocol, clientIp: clientIp || null, remoteRecording,
  }, { ttlMs: config.guac.tokenTtlMs });
  t.tokens++;
  return { ok: true, token, wsPath: WS_PATH, ttl: Math.floor(ttlMs / 1000), engine: 'guac' };
}

/** Admission at the tunnel (after the token checked out): the ticket still lives, the limits hold. */
function admitTunnel(conn) {
  const t = tickets.get(conn.remoteRef);
  if (!t || t.kind !== 'session' || t.engine === 'term' || t.engine === 'screen' || t.pluginId !== conn.remotePlugin || !t.claimedBy || Date.now() >= t.expiresAt) return { ok: false, reason: 'ticket_gone' };
  const plugin = pluginOf(t.pluginId);
  if (!plugin || !running(plugin.id) || !licensed(plugin)) return { ok: false, reason: 'plugin_unavailable' };
  return admit({ pluginId: t.pluginId, targetId: t.target.id, userId: t.userId });
}

/**
 * Admission of the terminal tunnel (tunnel/termTunnel.js) for a used-up token → { ok, ticket } | { ok: false, reason }
 */
function admitTerm(entry) {
  const t = entry ? tickets.get(entry.ref) : null;
  if (!t || t.kind !== 'session' || t.engine !== 'term' || t.userId !== entry.userId || !t.claimedBy || Date.now() >= t.expiresAt) return { ok: false, reason: 'ticket_gone' };
  const plugin = pluginOf(t.pluginId);
  if (!plugin || !running(plugin.id) || !licensed(plugin)) return { ok: false, reason: 'plugin_unavailable' };
  const a = admit({ pluginId: t.pluginId, targetId: t.target.id, userId: t.userId });
  return a.ok ? { ok: true, ticket: t } : a;
}

/**
 * Admission of the screen relay (tunnel/screenTunnel.js) for a used-up token → { ok, ticket } | { ok: false, reason }
 * The side must still be claimed by the same person (viewer: the ticket's person; sender: the phone's owner).
 */
function admitScreen(entry) {
  const t = entry ? tickets.get(entry.ref) : null;
  if (!t || t.kind !== 'session' || t.engine !== 'screen' || Date.now() >= t.expiresAt) return { ok: false, reason: 'ticket_gone' };
  if (entry.role === 'viewer' && (t.userId !== entry.userId || !t.claimedBy)) return { ok: false, reason: 'ticket_gone' };
  if (entry.role === 'sender' && (t.sender.userId !== entry.userId || !t.senderClaimedAt)) return { ok: false, reason: 'ticket_gone' };
  const plugin = pluginOf(t.pluginId);
  if (!plugin || !running(plugin.id) || !licensed(plugin)) return { ok: false, reason: 'plugin_unavailable' };
  const a = require('./screen').admit(t, entry.role);
  return a.ok ? { ok: true, ticket: t } : a;
}

/** The plugin of a ticket while it runs with a licence, else null. */
function pluginOfTicket(t) {
  const plugin = t ? pluginOf(t.pluginId) : null;
  return plugin && running(plugin.id) && licensed(plugin) ? plugin : null;
}

/** The playback ticket behind a page request (claim() checked person and browser) → its recording or null. */
function playbackOf(t) {
  return t && t.kind === 'play' && Date.now() < t.expiresAt ? t.recording : null;
}

// ─── Lifecycle (tunnel/guacTunnel.js, term.js) ────────────

function eventOf(row, phase, extra = {}) {
  return {
    phase, sessionId: row.id, ref: row.ref || null, targetId: row.target_id, userId: row.user_id, protocol: row.protocol, mode: row.mode,
    engine: row.engine || 'guac', via: row.via || 'browser', record: row.record === 1, recordingId: row.recording_id || null,
    startedAt: row.started_at ? new Date(row.started_at + 'Z').toISOString() : null, ...extra,
  };
}

/** Hook `remoteSession` of the plugin (never awaited; a failure lands in the plugin's log). */
function emit(pluginId, ev) {
  try {
    if (!running(pluginId)) return;
    require('../plugins/runtime').call(pluginId, 'remoteSession', ev, module.exports._hookMs || 5000).catch((e) => {
      try { require('../plugins/registry').addLog(pluginId, e && e.stopped ? 'debug' : 'warn', 'remoteSession failed: ' + String((e && e.message) || e).slice(0, 200)); } catch { /* db closed */ }
    });
  } catch (e) { logger.debug({ err: e.message }, 'remoteSession hook not delivered'); }
}

/**
 * A tunnel opened → the row; `close(reason)` ends it from here (gc.remote.end, plugin stopped).
 * engine term: the terminal (term.js) — it records itself (started); guac with
 * conn.remoteRecording: guacd records, sealed when the row ends.
 */
function opened(conn, { clientIp, close, engine = 'guac', via = 'browser' } = {}) {
  const t = tickets.get(conn.remoteRef) || null;
  const recId = engine === 'guac' && typeof conn.remoteRecording === 'string' ? conn.remoteRecording : null;
  const r = db().prepare(`INSERT INTO remote_sessions (plugin_id, target_id, target_name, user_id, protocol, mode, record, via, status, client_ip, last_heartbeat, engine, recording_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'), ?, ?)`)
    .run(conn.remotePlugin, conn.remoteTarget, t && t.target.name ? t.target.name : null, conn.remoteUser, conn.protocol, conn.remoteMode || 'control',
      recId ? 1 : 0, via === 'app' ? 'app' : 'browser', clientIp || null, ENGINE_ROWS.includes(engine) ? engine : 'guac', recId);
  const id = Number(r.lastInsertRowid);
  if (recId) {
    try {
      require('./recordings').startGuac(recId, { pluginId: conn.remotePlugin, sessionId: id, targetId: conn.remoteTarget, userId: conn.remoteUser, protocol: conn.protocol });
    } catch (e) { logger.warn({ err: e.message }, 'remote recording row not written'); }
  }
  live.set(id, { ref: conn.remoteRef, close: typeof close === 'function' ? close : () => {} });
  const row = { ...db().prepare('SELECT * FROM remote_sessions WHERE id = ?').get(id), ref: conn.remoteRef };
  try {
    require('../activity').log('remote_session_started', `Remote session started: "${row.target_name || row.target_id}" (${row.protocol}, ${row.mode}) via plugin "${row.plugin_id}"`, {
      source: 'plugin', severity: 'info', ipAddress: clientIp || null,
      details: { plugin: row.plugin_id, sessionId: id, targetId: row.target_id, userId: row.user_id, protocol: row.protocol, mode: row.mode, engine: row.engine, via: row.via, record: row.record === 1 },
    });
  } catch { /* best-effort */ }
  // the terminal reports its start once it is ready, the screen relay once both sides are there (started); guacd now
  if (engine === 'guac') emit(row.plugin_id, eventOf(row, 'start'));
  return id;
}

/** The terminal is connected (term.js): its recording (or none) is known now → hook start. */
function started(id, { recordingId = null, hostKey = null } = {}) {
  if (recordingId) {
    try {
      db().prepare('UPDATE remote_sessions SET recording_id = ?, record = 1 WHERE id = ?').run(recordingId, id);
      require('./recordings').setSession(recordingId, id);
    } catch { /* ended */ }
  }
  const row = db().prepare('SELECT * FROM remote_sessions WHERE id = ?').get(id);
  if (!row) return;
  const l = live.get(id);
  emit(row.plugin_id, eventOf({ ...row, ref: l ? l.ref : null }, 'start', hostKey ? { hostKey } : {}));
}

function heartbeat(id) {
  try { db().prepare("UPDATE remote_sessions SET last_heartbeat = datetime('now') WHERE id = ? AND status = 'active'").run(id); } catch { /* ended */ }
}

// a screen session ends normally by either side (sender: the phone's "Beenden", viewer: the helper)
const NORMAL_REASONS = new Set(['normal', 'ended_by_plugin', 'sender', 'viewer']);
const ENGINE_ROWS = ['guac', 'term', 'screen'];

/** A tunnel closed (or was ended) → the row ends, hook `remoteSession` end | abort. */
function end(id, reason = 'normal') {
  live.delete(id);
  const row = db().prepare('SELECT * FROM remote_sessions WHERE id = ?').get(id);
  if (!row || row.status !== 'active') return null;
  const dur = Math.max(0, Math.floor((Date.now() - Date.parse(row.started_at + 'Z')) / 1000));
  db().prepare("UPDATE remote_sessions SET status = 'ended', ended_at = datetime('now'), duration_seconds = ?, end_reason = ? WHERE id = ?").run(dur, reason, id);
  // guacd's recording of this tunnel is complete now: seal it (one file at a time, in the background)
  if (row.recording_id && row.engine !== 'term') { try { require('./recordings').finishGuac(row.recording_id, { durationSeconds: dur }); } catch { /* best-effort */ } }
  try {
    require('../activity').log('remote_session_ended', `Remote session ended: "${row.target_name || row.target_id}" (${dur}s, ${reason}) via plugin "${row.plugin_id}"`, {
      source: 'plugin', severity: 'info', details: { plugin: row.plugin_id, sessionId: id, targetId: row.target_id, userId: row.user_id, durationSeconds: dur, reason },
    });
  } catch { /* best-effort */ }
  emit(row.plugin_id, eventOf(row, NORMAL_REASONS.has(reason) ? 'end' : 'abort', { reason, durationSeconds: dur, endedAt: new Date().toISOString() }));
  return { id, durationSeconds: dur, reason };
}

/**
 * gc.remote.end({ ref } | { sessionId }) → { ended } — the ticket goes (no reconnect) and its open
 * tunnels close now; with sessionId only that tunnel.
 */
function endFor(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  let n = 0;
  if (o.ref != null) {
    if (typeof o.ref !== 'string' || !REF_RE.test(o.ref)) throw new SessionError('invalid', 'invalid ref');
    // a screen ticket ends by either of its refs
    const ref = tickets.has(o.ref) ? o.ref : (senderRefs.get(o.ref) || o.ref);
    const t = tickets.get(ref);
    if (!t || t.pluginId !== plugin.id) return { ended: 0 };
    for (const id of liveOf(ref)) { closeLive(id, 'ended_by_plugin'); n++; }
    tickets.delete(ref);
    if (t.engine === 'screen') {
      senderRefs.delete(t.senderRef);
      require('./screen').endRef(ref, 'ended_by_plugin');
    }
    return { ended: n };
  }
  const id = Number(o.sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new SessionError('invalid', 'ref or sessionId required');
  const row = db().prepare("SELECT plugin_id FROM remote_sessions WHERE id = ? AND status = 'active'").get(id);
  if (!row || row.plugin_id !== plugin.id) return { ended: 0 };
  closeLive(id, 'ended_by_plugin');
  return { ended: 1 };
}

function closeLive(id, reason) {
  const l = live.get(id);
  end(id, reason);
  if (l) { try { l.close(reason); } catch { /* gone */ } }
}

/** gc.remote.sessions({ active?, targetId?, limit? }) → [{ id, targetId, targetName, userId, protocol, mode, status, startedAt, endedAt, durationSeconds, endReason }] */
function list(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 100));
  const where = ['plugin_id = ?'];
  const params = [plugin.id];
  if (o.active === true) where.push("status = 'active'");
  if (o.targetId != null) { where.push('target_id = ?'); params.push(String(o.targetId)); }
  const iso = (v) => (v ? new Date(v + 'Z').toISOString() : null);
  return db().prepare(`SELECT * FROM remote_sessions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(...params).map((r) => ({
    id: r.id, targetId: r.target_id, targetName: r.target_name, userId: r.user_id, protocol: r.protocol, mode: r.mode, record: r.record === 1,
    engine: r.engine || 'guac', via: r.via || 'browser', recordingId: r.recording_id || null,
    status: r.status, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds, endReason: r.end_reason,
  }));
}

/** A plugin stopped, lost its licence or went: its tickets and tunnels end. */
function endAllFor(pluginId, reason = 'plugin_stopped') {
  for (const [ref, t] of tickets) {
    if (t.pluginId !== pluginId) continue;
    tickets.delete(ref);
    if (t.engine === 'screen') {
      senderRefs.delete(t.senderRef);
      require('./screen').endRef(ref, reason);
    }
  }
  for (const [id] of [...live]) {
    const row = db().prepare('SELECT plugin_id FROM remote_sessions WHERE id = ?').get(id);
    if (row && row.plugin_id === pluginId) closeLive(id, reason);
  }
}

/** Server start: rows of tunnels of the last run are closed. */
function closeLeftovers() {
  try { db().prepare("UPDATE remote_sessions SET status = 'ended', ended_at = datetime('now'), end_reason = 'server_restart' WHERE status = 'active'").run(); } catch { /* table missing */ }
}

const sweepTimer = setInterval(() => { try { sweep(); } catch { /* db closed */ } }, 60000);
if (sweepTimer.unref) sweepTimer.unref();

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  tickets.clear();
  senderRefs.clear();
  live.clear();
}
function _ticketForTest(ref) { return process.env.NODE_ENV === 'test' ? tickets.get(ref) || null : null; }

module.exports = {
  SessionError, create, createScreen, claimSender, dropScreenTicket, screenAborted, admitScreen, createPlayback, claim, claimApp, playbackOf, mint, admitTunnel, admitTerm, pluginOfTicket, opened, started, heartbeat, end, endFor, endAllFor, list,
  activeCount, closeLeftovers, PROTOCOLS, MODES, ENGINES, WS_PATH, REF_RE, OPTION_RULES, _resetForTest, _ticketForTest, _hookMs: null,
};
