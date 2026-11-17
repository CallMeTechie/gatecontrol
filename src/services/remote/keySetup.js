'use strict';

// GateControl's SSH key onto a device, from outside (gc.remote version 9, docs/plugins.md "Remote access"):
//
//   hostKeys.scan(target)            the host key of the target, without logging in
//   installKey(target, { … })        log in once with a password (only in memory), put GateControl's key line into
//                                    authorized_keys (an own account, or root through sudo), test it, store the key
//   testKey(target, { credential })  log in with the key of the vault only (after copying the line by hand)
//   removeKey(target, { credential }) log in with the key and take GateControl's line out again
//
// The line, valid only from where GateControl's connections come from (`from=`, the address of $SSH_CLIENT; for a
// listener of a gateway pool also the home network addresses of every gateway of the pool, so a switch-over does not
// lock out):
//
//   from="192.168.2.10",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 AAAA… gatecontrol:dev-12
//
// The comment `gatecontrol:<target id>` marks GateControl's own line: an old one is replaced, other lines stay.
//
// Rules: the host key is checked (or confirmed) before any password is sent; the password and the password of sudo
// live in memory for this call only — never in the vault, a log, an error, a command line or an answer; the script
// and the key line go to the device over stdin (`sh -s`), sudo reads its password with `-S` from stdin. At most
// RATE_MAX attempts per target in RATE_WINDOW_MS (a fail2ban on the device would lock GateControl out).

const net = require('node:net');
const { TermError, connectSsh, execOnce, secretOf } = require('./term');

const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const TOTAL_MS = 40000;
const LOGIN_MS = 15000;
const STEP_MS = 10000;
const MARKER = 'GC-KEY-SCRIPT';
const SHA256_RE = /^[A-Za-z0-9+/]{43}$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._@-]{0,63}\$?$/;
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const CODES = Object.freeze(['auth_failed', 'password_auth_off', 'unreachable', 'timeout', 'host_key_mismatch', 'host_key_rejected', 'host_key_unpinned',
  'sudo_password', 'sudo_denied', 'not_posix', 'write_failed', 'key_test_failed', 'rate_limited', 'own_key']);

// the POSIX check and the address the device sees GateControl's connection come from — the first word of $SSH_CLIENT
const PROBE = 'sh -c \'printf "gcposix %s\\n" "${SSH_CLIENT%% *}"\'';
const SUDO_CHECK = 'env LC_ALL=C sudo -n true';
const SUDO_VALIDATE = "env LC_ALL=C sudo -S -p '' -v";
// sudo reads its password from stdin (when it needs one); what follows the marker is the script. A password line that
// sudo did not read (a ticket of the -v before) is read and dropped here — never run by a shell.
const SUDO_RUN = `env LC_ALL=C sudo -H -S -p '' sh -c 'while IFS= read -r l; do [ "$l" = ${MARKER} ] && exec sh -s; done; exit 90'`;

function db() { return require('../../db/connection').getDb(); }

// ─── rate limit (installKey, testKey) ───

const attempts = new Map(); // plugin \0 target → [ms]

function rateTake(pluginId, targetId, now = Date.now()) {
  const k = pluginId + '\0' + targetId;
  const list = (attempts.get(k) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    attempts.set(k, list);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + RATE_WINDOW_MS - now) / 1000)) };
  }
  list.push(now);
  attempts.set(k, list);
  if (attempts.size > 5000) for (const [key, l] of attempts) if (!l.some((t) => now - t < RATE_WINDOW_MS)) attempts.delete(key);
  return { ok: true, left: RATE_MAX - list.length };
}

// ─── helpers ───

/** Text of the device for an answer: no control characters, no secret, short. */
function scrub(text, secrets) {
  const s = String(text || '').replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  // a message that echoes a secret is dropped as a whole — nothing of the answer is ever made from a password
  if (secrets.some((x) => typeof x === 'string' && x.length && (s.includes(x) || String(text || '').includes(x)))) return 'the message of the device was withheld';
  return s.slice(0, 200) || null;
}

function cleanIp(v) {
  const s = String(v || '').trim();
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(s) || !net.isIP(s)) return null;
  return s;
}

function sha256Of(v) {
  const s = String(v || '').replace(/^SHA256:/, '').replace(/=+$/, '');
  return SHA256_RE.test(s) ? s : null;
}

function noNewline(v, what) {
  if (typeof v !== 'string' || !v.length || v.length > 1024 || /[\r\n\0]/.test(v)) throw new TermError('invalid', `${what}: 1…1024 characters, no line break`);
  return v;
}

/** The comment of GateControl's line for a target. */
function commentOf(t) { return 'gatecontrol:' + t.id; }

/** The key line. `from`: [] = no restriction. */
function keyLine(publicKey, from, comment) {
  const f = String(publicKey || '').trim().split(/\s+/);
  if (f.length < 2 || f[0] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/=]{20,200}$/.test(f[1])) throw new TermError('invalid', 'not an ed25519 key');
  const opts = ['no-agent-forwarding', 'no-X11-forwarding', 'no-port-forwarding'];
  if (from.length) opts.unshift(`from="${from.join(',')}"`);
  return `${opts.join(',')} ${f[0]} ${f[1]} ${comment}`;
}

/** The fingerprint of an authorized_keys line → { alg, sha256 } */
function fingerprintOfPublic(publicKey) {
  const f = String(publicKey || '').trim().split(/\s+/);
  return require('./sshkeys').fingerprint(Buffer.from(f[1] || '', 'base64'));
}

/**
 * The POSIX script: GateControl's old line(s) out (by the comment, the last word of a line), the new ones in, rights and
 * SELinux label. $HOME is the account's (for root: sudo -H). Prints the old lines (`gcold <line>`, public keys — to put
 * them back when the test fails) and `gcok <number of old lines> <file>`.
 */
function keyScript(comment, lines) {
  if (!/^gatecontrol:[A-Za-z0-9._:-]{1,64}$/.test(comment)) throw new TermError('invalid', 'comment');
  const add = lines == null ? [] : (Array.isArray(lines) ? lines : [lines]);
  // each line ends with the comment (so none is the end mark of the here-document) and has no line break
  if (add.some((l) => typeof l !== 'string' || /[\r\n]/.test(l) || l.trim().split(/\s+/).pop() !== comment)) throw new TermError('invalid', 'line');
  return [
    'umask 077',
    'H="$HOME"',
    'if [ -z "$H" ] || [ ! -d "$H" ]; then echo "no home directory" >&2; exit 3; fi',
    'D="$H/.ssh"; F="$D/authorized_keys"; T="$D/.gc_authorized_keys.$$"',
    'if [ -L "$D" ] || [ -L "$F" ]; then echo "symbolic link in .ssh refused" >&2; exit 4; fi',
    'mkdir -p "$D" || exit 4',
    'chmod 700 "$D" || exit 4',
    'if [ ! -f "$F" ]; then : > "$F" || exit 4; fi',
    `C='${comment}'`,
    'awk -v c="$C" \'$NF == c { print "gcold " $0 }\' "$F"',
    'N=$(awk -v c="$C" \'$NF == c\' "$F" | wc -l | tr -d " ")',
    'awk -v c="$C" \'$NF != c\' "$F" > "$T" || { rm -f "$T"; exit 4; }',
    ...(add.length ? ["cat >> \"$T\" <<'GC_KEY_LINE'", ...add, 'GC_KEY_LINE'] : []),
    'cat "$T" > "$F" || { rm -f "$T"; exit 4; }',
    'rm -f "$T"',
    'chmod 600 "$F" || exit 4',
    'if command -v restorecon >/dev/null 2>&1; then restorecon -R "$D" >/dev/null 2>&1; fi',
    'printf "gcok %s %s\\n" "$N" "$F"',
    '',
  ].join('\n');
}

/** `gcok …` of the script → { removed, path, old: [lines it took out] } | null */
function parseOk(out, comment) {
  const text = String(out || '');
  const m = /^gcok (\d+) (.+)$/m.exec(text);
  if (!m) return null;
  const old = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('gcold ')) continue;
    const line = l.slice(6);
    if (old.length < 10 && line.length <= 8192 && !HAS_CTRL_RE.test(line) && line.trim().split(/\s+/).pop() === comment) old.push(line);
  }
  return { removed: Number(m[1]), path: m[2].replace(CTRL_RE, '').slice(0, 256), old };
}

/** The home network addresses of every gateway of a pool (gateway_meta.lan_ip, reported with the heartbeat). */
function poolAddresses(poolId) {
  if (!poolId) return [];
  try {
    return db().prepare(`SELECT gm.lan_ip FROM gateway_pool_members m JOIN gateway_meta gm ON gm.peer_id = m.peer_id
      WHERE m.pool_id = ? ORDER BY m.priority, m.peer_id`).all(poolId).map((r) => cleanIp(r.lan_ip)).filter(Boolean);
  } catch { return []; }
}

function gatewayAddress(peerId) {
  if (!peerId) return null;
  try { const r = db().prepare('SELECT lan_ip FROM gateway_meta WHERE peer_id = ?').get(peerId); return r ? cleanIp(r.lan_ip) : null; } catch { return null; }
}

/**
 * The addresses for `from=`: what the device saw ($SSH_CLIENT) and, for a listener of a pool, every gateway of the pool.
 * Without a login (`seen` null) the best guess: the gateway(s) of a listener, else the hub address.
 */
function fromAddresses(ep, seen) {
  const out = [];
  const add = (a) => { const ip = cleanIp(a); if (ip && !out.includes(ip)) out.push(ip); };
  add(seen);
  if (ep && ep.poolId) poolAddresses(ep.poolId).forEach(add);
  if (!out.length && ep) {
    if (ep.listener) add(gatewayAddress(ep.gatewayPeerId));
    else add(require('./targets').hubIp());
  }
  return out;
}

function step(id) { return { id, state: 'skip', ms: 0, detail: null }; }

function stepsOf() { return { connect: step('connect'), hostkey: step('hostkey'), install: step('install'), test: step('test') }; }

function hostVerifier(pluginId, t, confirm, state) {
  const hostKeys = require('./hostKeys');
  return (fp) => {
    const t0 = Date.now();
    state.hostKey = { alg: fp.alg, sha256: fp.sha256 };
    try {
      const r = hostKeys.check(pluginId, t.id, fp, { targetName: t.name });
      if (r === 'ok') { state.host = 'pinned'; return true; }
      if (r === 'mismatch') { state.host = 'mismatch'; throw new TermError('host_key_mismatch', 'the host key changed'); }
      if (confirm === undefined) { state.host = 'unpinned'; throw new TermError('host_key_unpinned', 'no host key pinned'); }
      if (confirm !== fp.sha256) { state.host = 'rejected'; throw new TermError('host_key_rejected', 'not the confirmed host key'); }
      hostKeys.pin(pluginId, { targetId: t.id, alg: fp.alg, sha256: fp.sha256 }, { source: 'trust' });
      state.host = 'confirmed';
      return true;
    } finally { state.hostMs = Date.now() - t0; }
  };
}

/** A login with the key of the vault only (no password) — for the test and for removeKey. */
function keyLogin(ep, t, pluginId, username, privateKey, passphrase, state, readyTimeout) {
  return connectSsh({
    host: ep.host, port: ep.port, secret: { username, privateKey, passphrase },
    readyTimeout,
    verify: hostVerifier(pluginId, t, undefined, state),
    authHandler: () => {
      if (state.keyTried) return false;
      state.keyTried = true;
      return { type: 'publickey', username, key: privateKey, ...(passphrase ? { passphrase } : {}) };
    },
  });
}

// ─── gc.remote.hostKeys.scan ───

/** The host key of host:port → { alg, sha256 } — the handshake is broken off at the host key, no login. */
function scanHostKey(host, port, timeoutMs = STEP_MS) {
  return new Promise((resolve, reject) => {
    const { Client } = require('ssh2');
    const { fingerprint } = require('./sshkeys');
    const c = new Client();
    let fp = null;
    let done = false;
    const finish = (err, v) => {
      if (done) return;
      done = true;
      try { c.end(); } catch { /* closed */ }
      if (err) reject(err); else resolve(v);
    };
    c.on('error', (e) => {
      if (fp) return finish(null, fp);
      return finish(new TermError(e && e.level === 'client-timeout' ? 'timeout' : 'unreachable', e && e.level === 'client-timeout' ? 'the target did not answer' : 'the target could not be reached'));
    });
    c.on('close', () => (fp ? finish(null, fp) : finish(new TermError('unreachable', 'the target could not be reached'))));
    c.on('ready', () => finish(null, fp));
    try {
      c.connect({
        host, port: Number(port) || 22, username: 'gatecontrol', readyTimeout: timeoutMs,
        hostVerifier: (key) => { fp = fingerprint(key); setImmediate(() => finish(null, fp)); return false; },
      });
    } catch { finish(new TermError('unreachable', 'connect failed')); }
  });
}

async function endpointOf(plugin, target) {
  const targets = require('./targets');
  const t = targets.normalise(target);
  const ep = await targets.endpoint(plugin, t);
  if (!ep.host) throw new TermError('listener_required', 'a LAN target of a gateway needs a listener (gc.remote.listener)');
  return { t, ep };
}

/** gc.remote.hostKeys.scan(target) → { alg, sha256, pinned, matches? } (version 9) */
async function scan(plugin, target) {
  const { t, ep } = await endpointOf(plugin, target);
  const fp = await scanHostKey(ep.host, ep.port);
  const pin = require('./hostKeys').get(plugin.id, t.id);
  const out = { alg: fp.alg, sha256: fp.sha256, pinned: !!pin };
  if (pin) out.matches = pin.alg === fp.alg && pin.sha256 === fp.sha256;
  return out;
}

// ─── gc.remote.installKey ───

function cleanInstall(a) {
  const o = a && typeof a === 'object' ? a : {};
  const login = o.login && typeof o.login === 'object' ? o.login : {};
  const account = o.account == null ? 'self' : o.account;
  if (account !== 'self' && account !== 'root') throw new TermError('invalid', "account: 'self' | 'root'");
  if (login.username != null && (typeof login.username !== 'string' || !USER_RE.test(login.username))) throw new TermError('invalid', 'login.username: an account name');
  const password = login.password == null ? null : noNewline(login.password, 'login.password');
  const sudoPassword = o.sudoPassword == null || o.sudoPassword === '' ? null : noNewline(o.sudoPassword, 'sudoPassword');
  if (sudoPassword && account !== 'root') throw new TermError('invalid', "sudoPassword: only with account 'root'");
  let confirm;
  if (o.hostKey != null) {
    const c = o.hostKey && typeof o.hostKey === 'object' ? o.hostKey.confirm : o.hostKey;
    confirm = sha256Of(c);
    if (!confirm) throw new TermError('invalid', 'hostKey.confirm: the SHA-256 fingerprint (43 base64 characters)');
  }
  for (const k of ['restrictFrom', 'replaceOwnKey', 'keepPassword']) {
    if (o[k] != null && typeof o[k] !== 'boolean') throw new TermError('invalid', `${k}: true | false`);
  }
  return {
    credential: o.credential == null ? null : String(o.credential), username: login.username || null, password, account, sudoPassword, confirm,
    restrictFrom: o.restrictFrom !== false, replaceOwnKey: o.replaceOwnKey === true, keepPassword: o.keepPassword === true,
  };
}

/**
 * gc.remote.installKey(target, { credential?, login: { username?, password? }, account?: 'self' | 'root', sudoPassword?,
 *   hostKey?: { confirm: sha256 }, restrictFrom?: true, replaceOwnKey?: false, keepPassword?: false }) (version 9)
 * → { ok, steps: [{ id: connect | hostkey | install | test, state: done | fail | skip, ms, detail }], account, user, path,
 *     from, fingerprint, hostKey, publicKey, line, credential, attemptsLeft, error?: { code, step }, retryAfter?, rolledBack? }
 * Codes in `error` (not thrown): see CODES. Thrown: ERR_INVALID, ERR_REMOTE_CREDENTIAL_*, ERR_REMOTE_LISTENER_REQUIRED, target errors.
 */
async function installKey(plugin, target, args) {
  const o = cleanInstall(args);
  const { t, ep } = await endpointOf(plugin, target);
  const vault = require('./vault');
  const sshkeys = require('./sshkeys');
  // the entry of the device: its username / password stand in for missing login fields; a key of GateControl is reused
  let secret = null;
  if (o.credential != null) {
    if (!vault.isHandle(o.credential) || !vault.info(plugin.id, o.credential)) throw new TermError('credential_not_found', 'no such vault entry of this plugin');
    secret = vault.resolve(plugin.id, o.credential);
    if (!secret) throw new TermError('credential_unreadable', 'the vault entry cannot be used');
  }
  const username = o.username || (secret && secret.username) || null;
  if (!username || !USER_RE.test(username)) throw new TermError('invalid', 'login.username required');
  const password = o.password || (secret && typeof secret.password === 'string' && !/[\r\n\0]/.test(secret.password) ? secret.password : null);
  if (!password) throw new TermError('invalid', 'login.password required');
  const sudoPassword = o.account === 'root' ? (o.sudoPassword || password) : null;
  const secrets = [password, sudoPassword];
  const accountUser = o.account === 'root' ? 'root' : username;
  const comment = commentOf(t);

  const steps = stepsOf();
  const res = {
    ok: false, steps: null, account: o.account, user: accountUser, path: null, from: [], fingerprint: null, hostKey: null, publicKey: null, line: null,
    credential: o.credential, attemptsLeft: null,
  };
  // codes and texts go in one object, not as arguments of their own (a code like 'sudo_password' is no password)
  const answer = ({ code = null, at = null, extra = {} } = {}) => {
    res.steps = [steps.connect, steps.hostkey, steps.install, steps.test];
    if (code) res.error = { code, step: at };
    else res.ok = true;
    return Object.assign(res, extra);
  };

  // the key: GateControl's (with its public half) is reused, an own key only replaced when asked; else a new one
  let pair = null;
  if (secret && secret.privateKey && secret.publicKey) {
    pair = { privateKey: secret.privateKey, passphrase: secret.passphrase || null, publicKey: secret.publicKey };
  } else if (secret && secret.privateKey && !o.replaceOwnKey) {
    return answer({ code: 'own_key' });
  } else {
    const g = sshkeys.generateEd25519(comment);
    pair = { privateKey: g.privateKey, passphrase: null, publicKey: g.publicKey };
  }
  res.publicKey = pair.publicKey.trim().split(/\s+/).slice(0, 2).concat(comment).join(' ');
  res.fingerprint = fingerprintOfPublic(pair.publicKey);
  const store = (extra) => {
    const meta = vault.storeKeyPair(plugin.id, {
      handle: o.credential || undefined, label: o.credential ? undefined : (t.name || t.id).slice(0, 120), username: accountUser,
      privateKey: pair.privateKey, passphrase: pair.passphrase, publicKey: res.publicKey, fingerprint: res.fingerprint, ...extra,
    });
    res.credential = meta.handle;
  };

  const rate = rateTake(plugin.id, t.id);
  if (!rate.ok) return answer({ code: 'rate_limited', extra: { attemptsLeft: 0, retryAfter: rate.retryAfter } });
  res.attemptsLeft = rate.left;
  const deadline = Date.now() + TOTAL_MS;
  const left = () => Math.max(1000, Math.min(STEP_MS, deadline - Date.now()));

  // 1 + 2: connect, the host key first, then the password (or keyboard-interactive) — only if the target offers one
  const state = { host: null, hostKey: null, hostMs: 0 };
  let method = null;
  let passwordOff = false;
  let c = null;
  const t0 = Date.now();
  try {
    c = await connectSsh({
      host: ep.host, port: ep.port, secret: { username }, readyTimeout: LOGIN_MS,
      verify: hostVerifier(plugin.id, t, o.confirm, state),
      authHandler: (methods) => {
        if (method === null) { method = 'none'; return { type: 'none', username }; }
        if (method === 'none') {
          const offered = Array.isArray(methods) ? methods : [];
          if (offered.includes('password')) { method = 'password'; return { type: 'password', username, password }; }
          if (offered.includes('keyboard-interactive')) {
            method = 'keyboard-interactive';
            return { type: 'keyboard-interactive', username, prompt: (name, instr, lang, prompts, finish) => finish((prompts || []).map(() => password)) };
          }
          passwordOff = true;
        }
        return false;
      },
    });
  } catch (e) {
    const code = (e && e.code) || 'unreachable';
    res.hostKey = state.hostKey;
    steps.connect.ms = Date.now() - t0;
    if (code.startsWith('host_key_')) {
      steps.connect.detail = 'not logged in, no password sent';
      Object.assign(steps.hostkey, { state: 'fail', ms: state.hostMs, detail: state.host });
      return answer({ code, at: 'hostkey' });
    }
    if (state.host) Object.assign(steps.hostkey, { state: 'done', ms: state.hostMs, detail: state.host });
    steps.connect.state = 'fail';
    if (code === 'auth_failed' && passwordOff) {
      // the device takes keys only: the line to put in by hand (and the key in the vault for testKey)
      steps.connect.detail = 'the target offers no password login';
      res.from = o.restrictFrom ? fromAddresses(ep, null) : [];
      res.line = keyLine(pair.publicKey, res.from, comment);
      store({});
      return answer({ code: 'password_auth_off', at: 'connect', extra: { fromGuessed: o.restrictFrom } });
    }
    steps.connect.detail = code === 'auth_failed' ? `login as ${username} refused` : null;
    return answer({ code: ['auth_failed', 'timeout'].includes(code) ? code : 'unreachable', at: 'connect' });
  }
  steps.connect.state = 'done';
  steps.connect.ms = Date.now() - t0;
  steps.connect.detail = method;
  Object.assign(steps.hostkey, { state: 'done', ms: state.hostMs, detail: state.host });
  res.hostKey = state.hostKey;

  // 3: put the line in
  const t1 = Date.now();
  const fail = ({ code, detail = null, at = 'install', since = t1 }) => {
    Object.assign(steps[at], { state: 'fail', ms: Date.now() - since, detail: detail == null ? null : scrub(detail, secrets) });
    return answer({ code, at });
  };
  const run = (script, maxBytes = 4096) => (o.account === 'root'
    ? execOnce(c, SUDO_RUN, { timeoutMs: left(), stderr: true, maxBytes, stdin: (state.sudoNeedsPw ? sudoPassword + '\n' : '') + MARKER + '\n' + script })
    : execOnce(c, 'sh -s', { timeoutMs: left(), stderr: true, maxBytes, stdin: script }));
  try {
    let probe;
    try { probe = await execOnce(c, PROBE, { timeoutMs: left(), maxBytes: 4096 }); } catch (e) { return fail({ code: e && e.code === 'timeout' ? 'timeout' : 'not_posix' }); }
    const m = /^gcposix ?(\S*)\s*$/m.exec(probe.out || '');
    if (!m || probe.code !== 0) {
      res.from = o.restrictFrom ? fromAddresses(ep, null) : [];
      res.line = keyLine(pair.publicKey, res.from, comment);
      store({});
      Object.assign(res, { fromGuessed: o.restrictFrom });
      return fail({ code: 'not_posix', detail: 'no POSIX shell (sh) on the target' });
    }
    res.from = o.restrictFrom ? fromAddresses(ep, m[1]) : [];
    if (o.restrictFrom && !cleanIp(m[1]) && !res.from.length) return fail({ code: 'write_failed', detail: 'the source address is unknown ($SSH_CLIENT empty)' });
    res.line = keyLine(pair.publicKey, res.from, comment);
    if (o.account === 'root') {
      const chk = await execOnce(c, SUDO_CHECK, { timeoutMs: left(), stderr: true, maxBytes: 1024 });
      if (chk.code === 127) return fail({ code: 'sudo_denied', detail: 'sudo is not installed' });
      if (chk.code !== 0) {
        if (/not in the sudoers|not allowed to|may not run/i.test(chk.err || '')) return fail({ code: 'sudo_denied', detail: chk.err });
        // a password is needed: check it on its own first, so a wrong one never meets the script
        const v = await execOnce(c, SUDO_VALIDATE, { timeoutMs: left(), stderr: true, maxBytes: 1024, stdin: sudoPassword + '\n' });
        if (v.code !== 0) {
          if (/not in the sudoers|not allowed to|may not run/i.test(v.err || '')) return fail({ code: 'sudo_denied', detail: v.err });
          return fail({ code: 'sudo_password', detail: 'sudo did not take the password' });
        }
        state.sudoNeedsPw = true;
      }
    }
    const w = await run(keyScript(comment, res.line), 64 * 1024);
    const ok = w.code === 0 ? parseOk(w.out, comment) : null;
    if (!ok) {
      if (o.account === 'root' && w.code === 1 && /sudo|password/i.test(w.err || '') && !/gcok/.test(w.out || '')) return fail({ code: 'sudo_password', detail: 'sudo did not take the password' });
      return fail({ code: 'write_failed', detail: w.err || (w.code === 90 ? 'the script did not reach the shell' : `exit ${w.code}`) });
    }
    res.path = ok.path;
    Object.assign(steps.install, { state: 'done', ms: Date.now() - t1, detail: ok.removed ? 'replaced the old line' : 'added' });

    // 4: log in with the key — on failure take the line out again and put back what was there (same password session)
    const t2 = Date.now();
    let tc = null;
    try {
      tc = await keyLogin(ep, t, plugin.id, accountUser, pair.privateKey, pair.passphrase, { host: null }, left());
    } catch (e) {
      let rolledBack = false;
      try {
        const r = await run(keyScript(comment, ok.old));
        rolledBack = r.code === 0 && !!parseOk(r.out, comment);
      } catch { rolledBack = false; }
      const why = e && e.code === 'auth_failed' ? 'the key was not accepted' : ((e && e.code) || 'failed');
      res.rolledBack = rolledBack;
      return fail({ code: 'key_test_failed', detail: `${why}; ${rolledBack ? 'line removed again' : 'the line could not be removed'}`, at: 'test', since: t2 });
    } finally { if (tc) { try { tc.end(); } catch { /* closed */ } } }
    Object.assign(steps.test, { state: 'done', ms: Date.now() - t2, detail: `logged in as ${accountUser} with the key` });
  } catch (e) {
    return fail({ code: e && e.code === 'timeout' ? 'timeout' : 'write_failed' });
  } finally { try { c.end(); } catch { /* closed */ } }

  // 5: the vault: the key (and the account) of the device, the password gone unless kept
  store(o.keepPassword ? {} : { password: null });
  return answer();
}

// ─── gc.remote.testKey / removeKey ───

function keyOf(pluginId, credential) {
  const s = secretOf(pluginId, credential);
  if (!s.privateKey) throw new TermError('credential_required', 'the vault entry has no key');
  return s;
}

/**
 * gc.remote.testKey(target, { credential }) → { ok, steps: [connect, hostkey], error?: { code, step }, attemptsLeft, retryAfter? }
 * (version 9) — a login with the key of the entry only (after the line was put in by hand). Codes: key_test_failed,
 * host_key_unpinned, host_key_mismatch, unreachable, timeout, rate_limited. Counts towards the limit of installKey.
 */
async function testKey(plugin, target, a) {
  const o = a && typeof a === 'object' ? a : {};
  const { t, ep } = await endpointOf(plugin, target);
  const s = keyOf(plugin.id, o.credential);
  const steps = stepsOf();
  const out = (code, at, extra = {}) => ({ ok: !code, steps: [steps.connect, steps.hostkey], ...(code ? { error: { code, step: at } } : {}), ...extra });
  const rate = rateTake(plugin.id, t.id);
  if (!rate.ok) return out('rate_limited', null, { attemptsLeft: 0, retryAfter: rate.retryAfter });
  const state = { host: null, hostMs: 0 };
  const t0 = Date.now();
  let c = null;
  try {
    c = await keyLogin(ep, t, plugin.id, s.username, s.privateKey, s.passphrase || null, state, LOGIN_MS);
  } catch (e) {
    const code = (e && e.code) || 'unreachable';
    steps.connect.ms = Date.now() - t0;
    if (code.startsWith('host_key_')) {
      Object.assign(steps.hostkey, { state: 'fail', ms: state.hostMs, detail: state.host });
      return out(code, 'hostkey', { attemptsLeft: rate.left });
    }
    if (state.host) Object.assign(steps.hostkey, { state: 'done', ms: state.hostMs, detail: state.host });
    steps.connect.state = 'fail';
    return out(code === 'auth_failed' ? 'key_test_failed' : (code === 'timeout' ? 'timeout' : 'unreachable'), 'connect', { attemptsLeft: rate.left });
  } finally { if (c) { try { c.end(); } catch { /* closed */ } } }
  Object.assign(steps.connect, { state: 'done', ms: Date.now() - t0, detail: 'publickey' });
  Object.assign(steps.hostkey, { state: 'done', ms: state.hostMs, detail: state.host });
  return out(null, null, { attemptsLeft: rate.left });
}

/**
 * gc.remote.removeKey(target, { credential }) → { removedRemote: true, found, path } | { removedRemote: false, reason }
 * (version 9) — logs in with the key of the entry and takes GateControl's line (`gatecontrol:<target id>`) out of that
 * account's authorized_keys. Offline, a changed host key, a key no longer accepted: { removedRemote: false, reason }
 * with reason unreachable | timeout | auth_failed | host_key_unpinned | host_key_mismatch | not_posix | write_failed.
 * The vault entry stays — the plugin clears the key itself (vault.put({ handle, privateKey: null })).
 */
async function removeKey(plugin, target, a) {
  const o = a && typeof a === 'object' ? a : {};
  const { t, ep } = await endpointOf(plugin, target);
  const s = keyOf(plugin.id, o.credential);
  let c = null;
  try {
    c = await keyLogin(ep, t, plugin.id, s.username, s.privateKey, s.passphrase || null, { host: null }, LOGIN_MS);
  } catch (e) {
    const code = (e && e.code) || 'unreachable';
    return { removedRemote: false, reason: ['auth_failed', 'timeout', 'host_key_unpinned', 'host_key_mismatch'].includes(code) ? code : 'unreachable' };
  }
  try {
    const r = await execOnce(c, 'sh -s', { timeoutMs: STEP_MS, stderr: true, maxBytes: 64 * 1024, stdin: keyScript(commentOf(t), null) });
    const ok = r.code === 0 ? parseOk(r.out, commentOf(t)) : null;
    if (!ok) return { removedRemote: false, reason: r.code === 127 || /not recognized|not found/i.test(r.err || '') ? 'not_posix' : 'write_failed' };
    return { removedRemote: true, found: ok.removed > 0, path: ok.path };
  } catch (e) {
    return { removedRemote: false, reason: e && e.code === 'timeout' ? 'timeout' : 'write_failed' };
  } finally { try { c.end(); } catch { /* closed */ } }
}

function _resetForTest() { if (process.env.NODE_ENV === 'test') attempts.clear(); }

module.exports = {
  scan, scanHostKey, installKey, testKey, removeKey, keyScript, keyLine, fromAddresses, poolAddresses, rateTake, scrub, CODES, RATE_MAX, RATE_WINDOW_MS,
  _resetForTest,
};
