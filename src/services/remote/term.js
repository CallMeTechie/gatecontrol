'use strict';

// The SSH terminal of gc.remote (stage 3, docs/plugins.md "Remote access"): ssh2 in the core,
// no guacd. The browser (session page with xterm.js) and the apps (native terminals) speak
// the same protocol on one WebSocket path:
//
//   /api/v1/remote/ssh-tunnel   Sec-WebSocket-Protocol: gc-term.v1, token.<token>
//
//   client → server   text  {t:'hello', cols, rows, term}   first frame, within 10 s
//                           {t:'resize', cols, rows}
//                           {t:'ping'}                       → {t:'pong'}
//                           {t:'trust'} | {t:'distrust'}     answer to {t:'hostkey'}
//                           {t:'bye'}                        end the session (→ exit)
//                     binary terminal input (ignored in view mode)
//   server → client   text  {t:'hostkey', hostKey:{alg,sha256}}   first connection: confirm it (60 s)
//                           {t:'ready', hostKey:{alg,sha256}, hostKeyNew, tmux:{available, session}, recording, mode}
//                           {t:'exit', code, reason}
//                           {t:'error', code}                then the socket closes
//                     binary terminal output
//
// A token (60 s, single use) is minted for a claimed ticket of sessions.js — by the session page
// (POST /remote/session/<ref>/token) or by an app (POST /api/v1/client/remote/term-token). The
// password and the private key are taken from the vault only here, when the connection is made;
// neither a key nor a password ever leaves the core, and none of them is logged.
//
// Host key: every connection is checked against the pin (hostKeys.js); without one the person
// confirms the fingerprint first, a different key blocks (host_key_mismatch).
// tmux: options.tmux { attach | create: <name> } runs `tmux new -A -s <name>` (the name checked
// strictly, quoted), without tmux on the target a normal shell (ready.tmux.available false).

const crypto = require('node:crypto');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

const PROTOCOL = 'gc-term.v1';
const WS_PATH = '/api/v1/remote/ssh-tunnel';
const TOKEN_TTL_MS = 60000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKENS_MAX = 2000;
// a tmux session name: letters, digits, _ and -, first a letter or digit — no "." or ":" (tmux targets), no quote
const TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const HELLO_MS = 10000;
const TRUST_MS = 60000;
const CONNECT_MS = 20000;
const MAX_FRAME = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;

class TermError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const tokens = new Map(); // token → { ref, userId, via, exp }

function sweepTokens(now = Date.now()) {
  for (const [k, v] of tokens) if (now >= v.exp) tokens.delete(k);
}

/** A single-use token of 60 s for a claimed ticket → { token, wsPath, ttl } */
function mintToken(t, { via = 'browser' } = {}) {
  sweepTokens();
  if (tokens.size >= TOKENS_MAX) throw new TermError('limit', 'too many open terminal tokens');
  const token = crypto.randomBytes(32).toString('base64url');
  tokens.set(token, { ref: t.ref, userId: t.userId, via: via === 'app' ? 'app' : 'browser', exp: Date.now() + TOKEN_TTL_MS });
  return { token, wsPath: WS_PATH, ttl: Math.floor(TOKEN_TTL_MS / 1000) };
}

/** The token of an upgrade, used up → { ref, userId, via } | null */
function takeToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const e = tokens.get(token);
  if (!e) return null;
  tokens.delete(token);
  return now < e.exp ? e : null;
}

/** The token of a Sec-WebSocket-Protocol header ("gc-term.v1, token.<t>") or null. */
function tokenOfProtocols(header) {
  const list = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.includes(PROTOCOL)) return null;
  const t = list.find((s) => s.startsWith('token.'));
  return t ? t.slice('token.'.length) : null;
}

/** options.tmux of a ticket → { attach } | { create } | null (throws on anything else). */
function cleanTmux(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new TermError('invalid', 'options.tmux: { attach } or { create }');
  const keys = Object.keys(v);
  if (keys.length !== 1 || (keys[0] !== 'attach' && keys[0] !== 'create')) throw new TermError('invalid', 'options.tmux: { attach } or { create }');
  const name = v[keys[0]];
  if (typeof name !== 'string' || !TMUX_NAME_RE.test(name)) throw new TermError('invalid', 'options.tmux: a name of 1…32 of A-Z a-z 0-9 _ - (first a letter or digit)');
  return { [keys[0]]: name };
}

/** The command for tmux — only for a checked name, and single-quoted all the same. */
function tmuxCommand(name) {
  if (!TMUX_NAME_RE.test(String(name))) throw new TermError('invalid', 'tmux name');
  return `tmux new -A -s '${name}'`;
}

function clampSize(cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  return {
    cols: Number.isInteger(c) ? Math.max(10, Math.min(500, c)) : 80,
    rows: Number.isInteger(r) ? Math.max(5, Math.min(200, r)) : 24,
  };
}

function cleanTerm(v) {
  const s = String(v || 'xterm-256color');
  return /^[A-Za-z0-9._+-]{1,40}$/.test(s) ? s : 'xterm-256color';
}

// ─── ssh2 ───

function ssh2() { return require('ssh2'); }

/**
 * An SSH connection → Promise<Client> (ready). verify(fp) → Promise<boolean> decides on the host key.
 * Errors: TermError auth_failed | unreachable | timeout | host_key_* (set by verify via o.reject).
 * Version 9 (keySetup.js): `authHandler` — ssh2's, to decide on the methods the target offers; `readyTimeout` in ms.
 */
function connectSsh({ host, port, secret, verify, onClient, authHandler, readyTimeout }) {
  return new Promise((resolve, reject) => {
    const { Client } = ssh2();
    const { fingerprint } = require('./sshkeys');
    const c = new Client();
    let hostFail = null;
    let settled = false;
    const done = (err, v) => {
      if (settled) return;
      settled = true;
      if (err) { try { c.end(); } catch { /* closed */ } reject(err); } else resolve(v);
    };
    if (typeof onClient === 'function') onClient(c);
    c.on('ready', () => done(null, c));
    c.on('error', (e) => {
      if (hostFail) return done(hostFail);
      const lvl = e && e.level;
      if (lvl === 'client-authentication') return done(new TermError('auth_failed', 'authentication failed'));
      if (lvl === 'client-timeout') return done(new TermError('timeout', 'the target did not answer'));
      return done(new TermError('unreachable', 'the target could not be reached'));
    });
    c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      // a password asked for interactively: the stored one, never anything else
      finish((prompts || []).map(() => (secret.password ? String(secret.password) : '')));
    });
    const opts = {
      host, port: Number(port) || 22, username: String(secret.username || ''),
      readyTimeout: Number.isInteger(readyTimeout) && readyTimeout > 0 ? readyTimeout : CONNECT_MS, keepaliveInterval: 15000, keepaliveCountMax: 3, tryKeyboard: !!secret.password,
      hostVerifier: (key, cb) => {
        const fp = fingerprint(key);
        Promise.resolve().then(() => verify(fp)).then((ok) => { cb(ok === true); }, (e) => { hostFail = e; cb(false); });
        return undefined;
      },
    };
    if (typeof authHandler === 'function') opts.authHandler = authHandler;
    if (secret.password) opts.password = String(secret.password);
    if (secret.privateKey) {
      opts.privateKey = String(secret.privateKey);
      if (secret.passphrase) opts.passphrase = String(secret.passphrase);
    }
    try { c.connect(opts); } catch (e) {
      // a key ssh2 cannot read (wrong passphrase, unknown format) — never the key in the message
      done(new TermError(/passphrase|key/i.test(String(e && e.message)) ? 'key_unreadable' : 'unreachable', 'connect failed'));
    }
  });
}

/**
 * Run one command without a terminal → { code, out } (out capped). Version 9: `stdin` (string | Buffer) is written to
 * the command and closed (a script for `sh -s`, the password for `sudo -S` — never on the command line), `stderr: true`
 * also keeps the error output (`err`, ≤ 4 KiB) — the caller must not log it as it is.
 */
function execOnce(c, cmd, { maxBytes = 256 * 1024, timeoutMs = 15000, stdin = null, stderr = false } = {}) {
  return new Promise((resolve, reject) => {
    let stream = null;
    const timer = setTimeout(() => {
      try { if (stream) stream.close(); } catch { /* closed */ }
      reject(new TermError('timeout', 'the command did not finish'));
    }, timeoutMs);
    c.exec(cmd, (err, s) => {
      if (err) { clearTimeout(timer); reject(new TermError('exec_failed', 'command refused')); return; }
      stream = s;
      const parts = [];
      const errParts = [];
      let n = 0;
      let e = 0;
      s.on('data', (d) => { if (n < maxBytes) { parts.push(d); n += d.length; } });
      s.stderr.on('data', (d) => { if (stderr && e < 4096) { errParts.push(d); e += d.length; } /* else not kept: tmux's "no server running" */ });
      s.on('close', (code) => {
        clearTimeout(timer);
        const r = { code: code == null ? null : code, out: Buffer.concat(parts).toString('utf8').slice(0, maxBytes) };
        if (stderr) r.err = Buffer.concat(errParts).toString('utf8').slice(0, 4096);
        resolve(r);
      });
      if (stdin != null) { try { s.end(stdin); } catch { /* closed */ } }
    });
  });
}

const TMUX_LIST = "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}'";
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** The lines of `tmux ls -F` → [{ name, windows, attached, created, activity, attachable }] */
function parseTmuxList(out) {
  const num = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const isoOf = (v) => { const n = num(v); return n ? new Date(n * 1000).toISOString() : null; };
  const list = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 5) continue;
    const name = f[0].replace(CTRL_RE, '').slice(0, 64);
    if (!name) continue;
    list.push({ name, windows: num(f[1]), attached: num(f[2]) || 0, created: isoOf(f[3]), activity: isoOf(f[4]), attachable: TMUX_NAME_RE.test(name) });
    if (list.length >= 200) break;
  }
  return list;
}

// ─── The host API: gc.remote.tmux.list ───

function pluginTarget(plugin, target) {
  return require('./targets').endpoint(plugin, target);
}

function secretOf(pluginId, credential) {
  const vault = require('./vault');
  if (credential == null) throw new TermError('credential_required', 'an SSH session needs a vault entry with the username');
  if (!vault.isHandle(String(credential))) throw new TermError('credential_not_found', 'no such vault entry of this plugin');
  const s = vault.resolve(pluginId, String(credential));
  if (!s) {
    const meta = vault.info(pluginId, String(credential));
    throw new TermError(meta ? 'credential_unreadable' : 'credential_not_found', 'the vault entry cannot be used');
  }
  if (!s.username) throw new TermError('credential_required', 'the vault entry has no username');
  if (!s.password && !s.privateKey) throw new TermError('credential_required', 'the vault entry has neither a password nor a key');
  return s;
}

// Version 9: the ids of tmux — a session `$3`, a window `@7` — name a target in a command, never a name (no quoting
// problems, no prefix match of `-t name`); only exactly these shapes reach a command line.
const TMUX_SESSION_ID_RE = /^\$\d{1,6}$/;
const TMUX_WINDOW_ID_RE = /^@\d{1,6}$/;
const TMUX_LIST_IDS = "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{session_id}'";
const TMUX_WINDOWS = "tmux list-windows -a -F '#{session_id}\t#{window_id}\t#{window_index}\t#{window_active}\t#{window_panes}\t#{pane_current_command}\t#{window_name}'";

/** The lines of `tmux list-windows -a -F TMUX_WINDOWS` → Map session id → [{ id, index, name, active, panes, command }] */
function parseTmuxWindows(out) {
  const num = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const bySession = new Map();
  let total = 0;
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const sid = f[0];
    const wid = f[1];
    if (!TMUX_SESSION_ID_RE.test(sid) || !TMUX_WINDOW_ID_RE.test(wid)) continue;
    // a window name may hold a tab: everything after the sixth field is the name
    const name = f.slice(6).join('\t').replace(CTRL_RE, '').slice(0, 64);
    const command = f[5].replace(CTRL_RE, '').slice(0, 64) || null;
    if (!bySession.has(sid)) bySession.set(sid, []);
    const list = bySession.get(sid);
    if (list.length >= 100) continue;
    list.push({ id: wid, index: num(f[2]), name, active: f[3] === '1', panes: num(f[4]), command });
    if (++total >= 2000) break;
  }
  for (const list of bySession.values()) list.sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
  return bySession;
}

/** The sessions with their ids and windows from the lines of TMUX_LIST_IDS and TMUX_WINDOWS → [{ …session, id, windowList }] */
function parseTmuxListWindows(lsOut, winOut) {
  const num = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const isoOf = (v) => { const n = num(v); return n ? new Date(n * 1000).toISOString() : null; };
  const windows = parseTmuxWindows(winOut);
  const list = [];
  for (const line of String(lsOut || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 6) continue;
    // the numbers and the id are the last five fields: a session name with a tab cannot shift them
    const k = f.length - 5;
    const id = f[k + 4].trim();
    if (!TMUX_SESSION_ID_RE.test(id)) continue;
    const name = f.slice(0, k).join('\t').replace(CTRL_RE, '').slice(0, 64);
    if (!name) continue;
    list.push({ name, windows: num(f[k]), attached: num(f[k + 1]) || 0, created: isoOf(f[k + 2]), activity: isoOf(f[k + 3]), attachable: TMUX_NAME_RE.test(name), id, windowList: windows.get(id) || [] });
    if (list.length >= 200) break;
  }
  return list;
}

/** An SSH connection for tmux to a target whose host key is pinned → { c, t } (the caller ends c). */
async function tmuxConnect(plugin, target, o) {
  const t = require('./targets').normalise(target);
  const ep = await pluginTarget(plugin, t);
  if (!ep.host) throw new TermError('listener_required', 'a LAN target of a gateway needs a listener (gc.remote.listener)');
  const secret = secretOf(plugin.id, o.credential);
  const hostKeys = require('./hostKeys');
  const c = await connectSsh({
    host: ep.host, port: ep.port, secret,
    verify: (fp) => {
      const r = hostKeys.check(plugin.id, t.id, fp, { targetName: t.name });
      if (r === 'ok') return true;
      throw new TermError(r === 'mismatch' ? 'host_key_mismatch' : 'host_key_unpinned', r === 'mismatch' ? 'the host key changed' : 'no host key pinned yet — connect once in the terminal');
    },
  });
  return { c, t };
}

/** The sessions on an open connection → [session] (with ids and windows when `windows`). */
async function tmuxSessions(c, windows) {
  const r = await execOnce(c, windows ? TMUX_LIST_IDS : TMUX_LIST);
  if (r.code === 127) throw new TermError('tmux_unavailable', 'tmux is not installed on the target');
  if (r.code !== 0) return [];
  if (!windows) return parseTmuxList(r.out);
  const w = await execOnce(c, TMUX_WINDOWS);
  return parseTmuxListWindows(r.out, w.code === 0 ? w.out : '');
}

/** The answer form with windows: `windows` is the list of windows then, the number moves to `windowCount`. */
function viewWithWindows(s) {
  const { windowList, ...rest } = s;
  return { ...rest, windows: windowList, windowCount: s.windows };
}

/**
 * gc.remote.tmux.list(target, { credential, windows? }) → [{ name, windows, attached, created, activity, attachable }]
 * Only to a target whose host key is pinned (no person to confirm one here): ERR_REMOTE_HOST_KEY_UNPINNED.
 * Without tmux on the target: ERR_REMOTE_TMUX_UNAVAILABLE. No tmux server running: [].
 * Version 9, `windows: true`: each session also { id: '$n', windows: [{ id: '@n', index, name, active, panes, command }],
 * windowCount } — a second `tmux list-windows -a` in the same connection.
 */
async function tmuxList(plugin, target, a) {
  const o = a && typeof a === 'object' ? a : {};
  const { c } = await tmuxConnect(plugin, target, o);
  try {
    const list = await tmuxSessions(c, o.windows === true);
    return o.windows === true ? list.map(viewWithWindows) : list;
  } finally { try { c.end(); } catch { /* closed */ } }
}

function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v * 1000 : String(v));
  return Number.isNaN(d.getTime()) ? undefined : new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString();
}

/**
 * gc.remote.tmux.kill(target, { credential, session: { id, name, created }, window?: { id, index } }) (version 9)
 * → { killed: 'session' | 'window', session: '$n', window: '@n' | null, sessionEnded }
 * Lists anew in the same connection and checks that the session (id, name, created) and the window (id, index) are
 * still the ones the person saw: gone → ERR_REMOTE_TMUX_GONE, something else under the id (tmux restarted) →
 * ERR_REMOTE_TMUX_CHANGED — nothing is killed then. The target is the id only (`$n`, `@n`).
 */
async function tmuxKill(plugin, target, a) {
  const o = a && typeof a === 'object' ? a : {};
  const sess = o.session && typeof o.session === 'object' ? o.session : null;
  if (!sess || typeof sess.id !== 'string' || !TMUX_SESSION_ID_RE.test(sess.id)) throw new TermError('invalid', 'session.id: $<number>');
  if (typeof sess.name !== 'string' || !sess.name || sess.name.length > 64) throw new TermError('invalid', 'session.name: as listed');
  const created = isoOrNull(sess.created);
  if (created === undefined) throw new TermError('invalid', 'session.created: as listed (ISO) or null');
  let win = null;
  if (o.window != null) {
    if (typeof o.window !== 'object' || typeof o.window.id !== 'string' || !TMUX_WINDOW_ID_RE.test(o.window.id)) throw new TermError('invalid', 'window.id: @<number>');
    const idx = o.window.index == null ? null : Number(o.window.index);
    if (idx !== null && (!Number.isSafeInteger(idx) || idx < 0)) throw new TermError('invalid', 'window.index: a number');
    win = { id: o.window.id, index: idx };
  }
  const { c } = await tmuxConnect(plugin, target, o);
  try {
    const list = await tmuxSessions(c, true);
    const s = list.find((x) => x.id === sess.id);
    if (!s) throw new TermError('tmux_gone', 'the session is gone');
    if (s.name !== sess.name || (s.created || null) !== created) throw new TermError('tmux_changed', 'another session runs under this id now');
    if (win) {
      const w = s.windowList.find((x) => x.id === win.id);
      if (!w) throw new TermError('tmux_gone', 'the window is gone');
      if (win.index !== null && w.index !== win.index) throw new TermError('tmux_changed', 'another window runs under this id now');
    }
    // the id checked above (^\$\d+$ / ^@\d+$), single-quoted all the same
    const cmd = win ? `tmux kill-window -t '${win.id}'` : `tmux kill-session -t '${s.id}'`;
    const r = await execOnce(c, cmd, { maxBytes: 1024 });
    if (r.code !== 0) {
      // gone in between (the last window closed by itself): say so, the list is reloaded
      const again = await tmuxSessions(c, true);
      const still = again.find((x) => x.id === s.id);
      if (!still || (win && !still.windowList.some((x) => x.id === win.id))) throw new TermError('tmux_gone', 'the session is gone');
      throw new TermError('tmux_failed', 'tmux did not end it');
    }
    let sessionEnded = !win;
    if (win) {
      const after = await tmuxSessions(c, true);
      sessionEnded = !after.some((x) => x.id === s.id);
    }
    return { killed: win ? 'window' : 'session', session: s.id, window: win ? win.id : null, sessionEnded };
  } finally { try { c.end(); } catch { /* closed */ } }
}

// ─── A terminal session on a WebSocket ───

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* gone */ }
}

/**
 * Run the session of `ticket` on an accepted WebSocket. `entry` is the used-up token
 * ({ via }), clientIp for the log. Resolves when the session is over.
 */
function run(ws, ticket, { via = 'browser', clientIp = null } = {}) {
  const sessions = require('./sessions');
  const hostKeys = require('./hostKeys');
  const recordings = require('./recordings');
  return new Promise((resolve) => {
    let sid = null;
    let client = null;
    let stream = null;
    let rec = null;
    let ended = false;
    let pendingTrust = null;
    let missed = 0;
    let paused = false;
    let reason = 'normal';
    const control = ticket.mode !== 'view';

    const hb = setInterval(() => {
      if (missed >= config.guac.heartbeatMisses) { reason = 'heartbeat'; finish(); return; }
      missed++;
      try { ws.ping(); } catch { /* gone */ }
    }, config.guac.heartbeatMs);
    if (hb.unref) hb.unref();
    const drain = setInterval(() => {
      if (paused && stream && ws.bufferedAmount < HIGH_WATER / 2) { paused = false; try { stream.resume(); } catch { /* closed */ } }
    }, 100);
    if (drain.unref) drain.unref();
    ws.on('pong', () => { missed = 0; if (sid) sessions.heartbeat(sid); });

    function fail(code) {
      send(ws, { t: 'error', code });
      if (reason === 'normal') reason = code;
      finish();
    }

    function finish(exit) {
      if (ended) return;
      ended = true;
      clearInterval(hb);
      clearInterval(drain);
      clearTimeout(helloTimer);
      if (pendingTrust) { pendingTrust(false); pendingTrust = null; }
      if (rec) { try { rec.close(); } catch { /* closed */ } }
      if (exit) send(ws, { t: 'exit', code: exit.code == null ? null : exit.code, reason: exit.reason || 'closed' });
      try { if (stream) stream.close(); } catch { /* closed */ }
      try { if (client) client.end(); } catch { /* closed */ }
      try { ws.close(1000); } catch { /* gone */ }
      const kill = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 2000);
      if (kill.unref) kill.unref();
      if (sid) { try { sessions.end(sid, reason); } catch { /* ended */ } }
      resolve();
    }

    const helloTimer = setTimeout(() => fail('hello_timeout'), HELLO_MS);
    let size = null;
    let termName = 'xterm-256color';

    ws.on('close', () => { if (!ended) { if (reason === 'normal' && !stream) reason = 'client_closed'; finish(); } });
    ws.on('error', () => { if (!ended) { reason = 'socket_error'; finish(); } });

    ws.on('message', (data, isBinary) => {
      if (ended) return;
      if (isBinary) {
        if (stream && control) {
          if (data.length > MAX_FRAME) return;
          try { stream.write(data); } catch { /* closed */ }
        }
        return;
      }
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') { send(ws, { t: 'pong' }); return; }
      if (m.t === 'hello' && !size) {
        clearTimeout(helloTimer);
        size = clampSize(m.cols, m.rows);
        termName = cleanTerm(m.term);
        start().catch((e) => fail((e && e.code) || 'connect_failed'));
        return;
      }
      if (m.t === 'resize' && size) {
        size = clampSize(m.cols, m.rows);
        try { if (stream) stream.setWindow(size.rows, size.cols, 0, 0); } catch { /* closed */ }
        if (rec) rec.resize(size.cols, size.rows);
        return;
      }
      if ((m.t === 'trust' || m.t === 'distrust') && pendingTrust) {
        const p = pendingTrust;
        pendingTrust = null;
        p(m.t === 'trust');
        return;
      }
      if (m.t === 'bye') { reason = 'normal'; finish({ code: null, reason: 'client' }); }
    });

    async function start() {
      const plugin = sessions.pluginOfTicket(ticket);
      if (!plugin) throw new TermError('plugin_unavailable');
      sid = sessions.opened({
        remoteRef: ticket.ref, remotePlugin: ticket.pluginId, remoteTarget: ticket.target.id, remoteUser: ticket.userId,
        protocol: 'ssh', remoteMode: ticket.mode,
      }, { clientIp, engine: 'term', via, close: (why) => { reason = why || 'ended_by_plugin'; finish({ code: null, reason: why || 'ended_by_plugin' }); } });
      let ep;
      try { ep = await pluginTarget(plugin, ticket.target); } catch (e) { throw new TermError('target_' + ((e && e.code) || 'invalid')); }
      if (!ep.host) throw new TermError('listener_required');
      const secret = secretOf(ticket.pluginId, ticket.credential);
      let hostKey = null;
      let hostKeyNew = false;
      client = await connectSsh({
        host: ep.host, port: ep.port, secret,
        onClient: (c) => { client = c; },
        verify: async (fp) => {
          hostKey = fp;
          if (ended) return false;
          const r = hostKeys.check(ticket.pluginId, ticket.target.id, fp, { userId: ticket.userId, targetName: ticket.target.name });
          if (r === 'ok') return true;
          if (r === 'mismatch') throw new TermError('host_key_mismatch');
          // first connection: the person confirms the fingerprint (view mode cannot)
          if (!control) throw new TermError('host_key_unpinned');
          send(ws, { t: 'hostkey', hostKey: fp });
          const ok = await new Promise((res) => {
            pendingTrust = res;
            const t = setTimeout(() => { if (pendingTrust === res) { pendingTrust = null; res(false); } }, TRUST_MS);
            if (t.unref) t.unref();
          });
          if (!ok) throw new TermError('host_key_rejected');
          hostKeys.pin(ticket.pluginId, { targetId: ticket.target.id, alg: fp.alg, sha256: fp.sha256 }, { source: 'trust', userId: ticket.userId });
          hostKeyNew = true;
          return true;
        },
      });
      if (ended) { try { client.end(); } catch { /* closed */ } return; }
      client.on('error', () => { if (!ended) { reason = 'connection_lost'; finish({ code: null, reason: 'connection_lost' }); } });
      client.on('close', () => { if (!ended) { reason = 'connection_lost'; finish({ code: null, reason: 'connection_lost' }); } });
      let tmuxOk = false;
      const want = ticket.tmux ? (ticket.tmux.attach || ticket.tmux.create) : null;
      if (want) {
        try { tmuxOk = (await execOnce(client, 'tmux -V', { maxBytes: 256, timeoutMs: 8000 })).code === 0; } catch { tmuxOk = false; }
      }
      const pty = { term: termName, cols: size.cols, rows: size.rows };
      stream = await new Promise((res, rej) => {
        const cb = (err, s) => (err ? rej(new TermError('shell_refused')) : res(s));
        if (want && tmuxOk) client.exec(tmuxCommand(want), { pty }, cb);
        else client.shell(pty, cb);
      });
      if (ended) { try { stream.close(); } catch { /* closed */ } return; }
      if (ticket.record) {
        try {
          rec = recordings.beginCast({ pluginId: ticket.pluginId, sessionId: sid, targetId: ticket.target.id, userId: ticket.userId, protocol: 'ssh', cols: size.cols, rows: size.rows, term: termName });
        } catch (e) {
          // recording was promised on the page: no recording, no session
          logger.warn({ err: e.message }, 'remote terminal: recording could not start');
          throw new TermError('recording_unavailable');
        }
      }
      const out = (d) => {
        if (ended) return;
        try { ws.send(d, { binary: true }); } catch { /* gone */ }
        if (rec) rec.output(d);
        if (!paused && ws.bufferedAmount > HIGH_WATER) { paused = true; try { stream.pause(); } catch { /* closed */ } }
      };
      stream.on('data', out);
      stream.stderr.on('data', out);
      stream.on('close', (code) => { if (!ended) { reason = 'normal'; finish({ code: Number.isInteger(code) ? code : null, reason: 'closed' }); } });
      sessions.started(sid, { recordingId: rec ? rec.id : null, hostKey });
      send(ws, { t: 'ready', hostKey, hostKeyNew, tmux: { available: want ? tmuxOk : null, session: want && tmuxOk ? want : null }, recording: !!rec, mode: ticket.mode });
    }
  });
}

function _resetForTest() { if (process.env.NODE_ENV === 'test') tokens.clear(); }

module.exports = {
  PROTOCOL, WS_PATH, TMUX_NAME_RE, TMUX_SESSION_ID_RE, TMUX_WINDOW_ID_RE, TermError, mintToken, takeToken, tokenOfProtocols, cleanTmux, tmuxCommand,
  parseTmuxList, parseTmuxWindows, parseTmuxListWindows, tmuxList, tmuxKill, run, connectSsh, execOnce, secretOf, _resetForTest,
};
