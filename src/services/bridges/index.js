'use strict';

// Messenger bridges (docs/feature-messenger-bridges.md), stage 1.
//
// A side service next to GateControl — a small internal Matrix homeserver and
// one bridge per outside messenger (first: WhatsApp) — lets the chat of the
// messenger plugin talk to people without a GateControl account. This module
// is the server's part of it and the only thing a plugin sees (host API
// gc.bridges, permissions.bridges). It is neutral about WHERE the bridges
// run: today only on this server (location "server"); a gateway comes later
// behind the same contract.
//
//   off by default   nothing exists until an administrator switches the
//                    bridges on. While the feature is a preview, even the
//                    switch is offered only with GC_BRIDGES_PREVIEW=1.
//   containers       this process has no Docker access. Like "ClamAV auf
//                    diesem Server" it writes its wish into
//                    /data/.auto-update-config.json ("bridges":"whatsapp");
//                    the host's update.sh (marker 5) starts the compose
//                    profile "bruecken" and reports to
//                    /data/.bridges-state.json.
//   no port          homeserver and bridges are reached over Unix sockets in
//                    /data/bridges/run only; nothing listens on a network.
//   secrets          /data/bridges/secrets.json (0600), made here once, never
//                    returned by any API. The bridge's session keys stay in
//                    the bridge's own database at the place it runs.
//   people           a person is addressed by their GateControl user id; the
//                    internal Matrix id never leaves this module.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const settings = require('../settings');
const logger = require('../../utils/logger');
const provision = require('./provision');

const NETWORKS = Object.freeze(['whatsapp']);
const SERVER_NAME = 'gc.internal';
const SCRIPT = 5; // update.sh marker that knows the profile "bruecken"
const HOST_STATES = ['running', 'starting', 'failed', 'stopped'];
const HOST_ERRORS = ['compose_missing', 'start_failed'];
const WAIT_KEEP_MS = 5 * 60000;
const MAX_WAITS = 32;

class BridgesError extends Error {
  constructor(code, message, reason) { super(message || code); this.code = code; if (reason) this.reason = reason; }
}

function dataDir() { return require('../autoUpdate').DATA_DIR; }
function dir() { return path.join(dataDir(), 'bridges'); }

/** The preview gate: without it the feature does not exist for anybody (status().available false). */
function previewOn() { return process.env.GC_BRIDGES_PREVIEW === '1'; }

function getConfig() {
  let nets = null;
  try { nets = JSON.parse(settings.get('bridges.networks', 'null')); } catch { nets = null; }
  const networks = {};
  for (const n of NETWORKS) networks[n] = !!(nets && typeof nets === 'object' && nets[n] === true);
  return { enabled: settings.get('bridges.enabled', '0') === '1', location: 'server', networks };
}

/** The bridges update.sh should run right now ([] = none). Read at boot too — never throws. */
function wanted() {
  try {
    if (!previewOn()) return [];
    const cfg = getConfig();
    return cfg.enabled ? NETWORKS.filter((n) => cfg.networks[n]) : [];
  } catch { return []; }
}

// ─── Secrets ───────────────────────────────────────────

function secretsFile() { return path.join(dir(), 'secrets.json'); }

function readSecrets() {
  try {
    const s = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(v);
    if (s && ok(s.asToken) && ok(s.hsToken) && ok(s.provisionSecret)) return s;
  } catch { /* not made yet */ }
  return null;
}

/** Make the folder and the tokens once (0700 / 0600). → the secrets (for this module only). */
function ensureSecrets() {
  const have = readSecrets();
  fs.mkdirSync(path.join(dir(), 'run'), { recursive: true, mode: 0o700 });
  if (have) return have;
  const tok = () => crypto.randomBytes(32).toString('base64url');
  const s = { asToken: tok(), hsToken: tok(), provisionSecret: tok() };
  const tmp = `${secretsFile()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(s) + '\n', { mode: 0o600 }); fs.renameSync(tmp, secretsFile()); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
  return s;
}

// ─── What the host did ─────────────────────────────────

function num(v, max) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null; }
function ver(v) { return typeof v === 'string' && /^[A-Za-z0-9._+-]{1,40}$/.test(v) ? v : null; }

/**
 * What update.sh wrote into .bridges-state.json (every run while the bridges
 * are wanted) — only known values.
 * → { state, error, checkedAt, services: { <name>: { running, memMb, limitMb, version } }, script, cron }
 */
function hostStatus() {
  const au = require('../autoUpdate');
  let file = null;
  try { file = JSON.parse(fs.readFileSync(path.join(au.DATA_DIR, '.bridges-state.json'), 'utf8')); } catch { file = null; }
  let cron = 'not_configured';
  let host = null;
  try { const st = au.getStatus(); cron = st.status; host = st.update_sh ? st.update_sh.host_version : null; } catch { /* unknown */ }
  const ok = file && typeof file === 'object';
  const services = {};
  for (const name of ['hs', ...NETWORKS]) {
    const s = ok && file.services && typeof file.services === 'object' ? file.services[name] : null;
    services[name] = s && typeof s === 'object'
      ? { running: s.running === true, memMb: num(s.mem_mb, 65536), limitMb: num(s.limit_mb, 65536), version: ver(s.version) }
      : { running: false, memMb: null, limitMb: null, version: null };
  }
  return {
    state: ok && HOST_STATES.includes(file.state) ? file.state : null,
    error: ok && HOST_ERRORS.includes(file.error) ? file.error : null,
    checkedAt: ok && typeof file.checked_at === 'string' && !Number.isNaN(Date.parse(file.checked_at)) ? new Date(file.checked_at).toISOString() : null,
    services,
    script: { host, needed: SCRIPT },
    cron,
  };
}

function locations() {
  const mb = (b) => Math.round(b / 1048576);
  return [{ id: 'server', kind: 'server', cores: os.cpus().length, memMb: mb(os.totalmem()), freeMb: mb(os.freemem()) }];
}

/**
 * gc.bridges.status() — what the administration shows. No names, no numbers,
 * no contents: states, versions and memory only.
 */
function status() {
  if (!previewOn()) return { available: false, reason: 'preview_off', enabled: false, location: 'server', locations: [], networks: [], host: null, history: { enabled: false } };
  const cfg = getConfig();
  const host = hostStatus();
  const up = cfg.enabled && host.state === 'running' && host.services.hs.running;
  return {
    available: true,
    reason: null,
    enabled: cfg.enabled,
    location: cfg.location,
    locations: locations(),
    networks: NETWORKS.map((id) => {
      const s = host.services[id];
      let state = 'off';
      if (cfg.enabled && cfg.networks[id]) state = up && s.running ? 'running' : (host.state === 'failed' ? 'failed' : 'starting');
      return { id, enabled: cfg.networks[id], state, version: s.version, memMb: s.memMb, limitMb: s.limitMb };
    }),
    host: {
      state: cfg.enabled ? host.state : 'stopped', error: cfg.enabled ? host.error : null, checkedAt: host.checkedAt,
      cron: host.cron, script: host.script, homeserver: { running: host.services.hs.running, memMb: host.services.hs.memMb, limitMb: host.services.hs.limitMb, version: host.services.hs.version },
    },
    // older history is not loaded on the server (slow disk): a later stage does it in small portions at night
    history: { enabled: false },
  };
}

/**
 * gc.bridges.configure({ enabled?, networks?: { whatsapp?: boolean } }) — an administrator's switch.
 * ctx: { actor: { id, name }, pluginId }
 */
function configure(patch, ctx) {
  if (!previewOn()) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new BridgesError('ERR_INVALID', 'patch: an object');
  for (const k of Object.keys(p)) if (k !== 'enabled' && k !== 'networks') throw new BridgesError('ERR_INVALID', `unknown key ${String(k).slice(0, 40)}`);
  const cur = getConfig();
  const next = { enabled: cur.enabled, networks: { ...cur.networks } };
  if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') throw new BridgesError('ERR_INVALID', 'enabled: a boolean'); next.enabled = p.enabled; }
  if (p.networks !== undefined) {
    if (!p.networks || typeof p.networks !== 'object' || Array.isArray(p.networks)) throw new BridgesError('ERR_INVALID', 'networks: an object');
    for (const [n, v] of Object.entries(p.networks)) {
      if (!NETWORKS.includes(n) || typeof v !== 'boolean') throw new BridgesError('ERR_INVALID', 'networks: unknown network or not a boolean');
      next.networks[n] = v;
    }
  }
  if (next.enabled) ensureSecrets();
  settings.set('bridges.networks', JSON.stringify(next.networks));
  settings.set('bridges.enabled', next.enabled ? '1' : '0');
  require('../autoUpdate').syncConfigFile();
  if (next.enabled !== cur.enabled || NETWORKS.some((n) => next.networks[n] !== cur.networks[n])) {
    try {
      require('../activity').log('bridges_changed', `Messenger-Brücken ${next.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`, {
        source: 'admin', severity: 'info',
        details: { enabled: next.enabled, networks: NETWORKS.filter((n) => next.networks[n]), by: ctx && ctx.actor ? ctx.actor.name : null, plugin: ctx ? ctx.pluginId : null },
      });
    } catch (err) { logger.debug({ err: err.message }, 'bridges: activity not written'); }
  }
  return status();
}

// ─── A person's own link ───────────────────────────────

/** The internal Matrix id of a GateControl account (never returned to a plugin). */
function mxidOf(userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new BridgesError('ERR_INVALID', 'invalid user id');
  return `@gc_${userId}:${SERVER_NAME}`;
}

function clientFor(userId, network) {
  if (!NETWORKS.includes(network)) throw new BridgesError('ERR_INVALID', 'unknown network');
  const mxid = mxidOf(userId);
  if (!previewOn()) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.networks[network]) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'this bridge is switched off', 'off');
  const secrets = readSecrets();
  if (!secrets) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  return provision.client({ socket: provision.socketOf(dir(), network), secret: secrets.provisionSecret }, mxid);
}

// "display_and_wait" answers only when the person confirmed on the phone (or the code ran out). The bridge is asked
// once per step; callers poll and get { waiting: true } until the answer is there.
const waits = new Map(); // `${userId}:${network}:${processId}:${stepId}` → { at, done, value, error }

function sweepWaits(now) {
  for (const [k, w] of waits) if (now - w.at > WAIT_KEEP_MS) waits.delete(k);
}

async function loginStep(userId, network, processId, stepId, kind, input, { pollMs = 15000 } = {}) {
  const c = clientFor(userId, network);
  if (kind !== 'display_and_wait') return c.step(processId, stepId, kind, input);
  const now = Date.now();
  sweepWaits(now);
  const key = `${userId}:${network}:${processId}:${stepId}`;
  let w = waits.get(key);
  if (!w) {
    if (waits.size >= MAX_WAITS) throw new BridgesError('ERR_BUSY', 'too many logins are waiting right now');
    w = { at: now, done: false, value: null, error: null };
    w.promise = c.step(processId, stepId, kind).then((v) => { w.done = true; w.value = v; }, (e) => { w.done = true; w.error = e; });
    waits.set(key, w);
  }
  if (!w.done) {
    let timer;
    await Promise.race([w.promise, new Promise((r) => { timer = setTimeout(r, pollMs); if (timer.unref) timer.unref(); })]);
    clearTimeout(timer);
  }
  if (!w.done) return { processId, waiting: true };
  waits.delete(key);
  if (w.error) throw w.error;
  return w.value;
}

const login = {
  flows: (userId, network) => clientFor(userId, network).flows(),
  start: (userId, network, flowId) => clientFor(userId, network).start(flowId),
  step: loginStep,
  cancel: (userId, network, processId) => {
    for (const k of waits.keys()) if (k.startsWith(`${userId}:${network}:${processId}:`)) waits.delete(k);
    return clientFor(userId, network).cancel(processId);
  },
};

/** The person's logins on one bridge → [{ network, id, name, state, since, error }]. */
async function logins(userId, network) {
  const w = await clientFor(userId, network).whoami();
  return w.logins.map((l) => ({ network, ...l }));
}

function logout(userId, network, loginId) { return clientFor(userId, network).logout(loginId); }

function _reset() { waits.clear(); }

module.exports = {
  NETWORKS, SCRIPT, SERVER_NAME, BridgesError,
  previewOn, getConfig, wanted, status, configure, hostStatus, ensureSecrets, readSecrets, dir,
  login, logins, logout, mxidOf, _reset,
};
