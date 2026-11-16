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
 */
function connectSsh({ host, port, secret, verify, onClient }) {
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
      readyTimeout: CONNECT_MS, keepaliveInterval: 15000, keepaliveCountMax: 3, tryKeyboard: !!secret.password,
      hostVerifier: (key, cb) => {
        const fp = fingerprint(key);
        Promise.resolve().then(() => verify(fp)).then((ok) => { cb(ok === true); }, (e) => { hostFail = e; cb(false); });
        return undefined;
      },
    };
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

/** Run one command without a terminal → { code, out } (out capped). */
function execOnce(c, cmd, { maxBytes = 256 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TermError('timeout', 'the command did not finish')), timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); reject(new TermError('exec_failed', 'command refused')); return; }
      const parts = [];
      let n = 0;
      stream.on('data', (d) => { if (n < maxBytes) { parts.push(d); n += d.length; } });
      stream.stderr.on('data', () => { /* not kept: tmux's "no server running" */ });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? null : code, out: Buffer.concat(parts).toString('utf8').slice(0, maxBytes) }); });
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

/**
 * gc.remote.tmux.list(target, { credential }) → [{ name, windows, attached, created, activity, attachable }]
 * Only to a target whose host key is pinned (no person to confirm one here): ERR_REMOTE_HOST_KEY_UNPINNED.
 * Without tmux on the target: ERR_REMOTE_TMUX_UNAVAILABLE. No tmux server running: [].
 */
async function tmuxList(plugin, target, a) {
  const o = a && typeof a === 'object' ? a : {};
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
  try {
    const r = await execOnce(c, TMUX_LIST);
    if (r.code === 127) throw new TermError('tmux_unavailable', 'tmux is not installed on the target');
    if (r.code !== 0) return [];
    return parseTmuxList(r.out);
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
  PROTOCOL, WS_PATH, TMUX_NAME_RE, TermError, mintToken, takeToken, tokenOfProtocols, cleanTmux, tmuxCommand, parseTmuxList, tmuxList, run, connectSsh, execOnce, _resetForTest,
};
