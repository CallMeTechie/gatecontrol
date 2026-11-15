'use strict';

// Messenger bridges (docs/feature-messenger-bridges.md), stages 1 to 5.
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
//                    /data/.bridges-state.json. Their images are pinned
//                    (images.js), their configuration is written here
//                    (config.js) before anything starts.
//   no port          homeserver and bridges are reached over Unix sockets in
//                    /data/bridges/run only; nothing listens on a network.
//   secrets          one master key in /data/bridges/secrets.json (0600), made
//                    here once; the tokens are derived from it and never
//                    returned by any API. The bridge's session keys stay in
//                    the bridge's own database at the place it runs.
//   people           a person is addressed by their GateControl user id; the
//                    internal Matrix id never leaves this module. A login is
//                    named by a reference (loginRef, HMAC per person) — the
//                    bridge's own id is the person's phone number at WhatsApp.
//   messages         (stage 3) the homeserver pushes what happens in the rooms
//                    of the GateControl people to this process (appservice.js,
//                    a Unix socket behind the relay bruecken-core-relay);
//                    events.js turns it into neutral events a plugin pulls
//                    (events.pull / events.ack, woken by the hook
//                    bridgeEvents). Sending goes the other way through the
//                    homeserver's client API (hs.js) as the person's internal
//                    account — only while that person acts.
//   files            (stage 4) a file in a bridged chat reaches a plugin as a
//                    sealed reference (events.js); media.fetch streams it from
//                    the homeserver into the plugin's media (hostApi.js, with
//                    GateControl's virus scan) — never through memory. A file
//                    of the person goes the other way: read from the plugin's
//                    media (only when the scan let it through), streamed to the
//                    homeserver, sent as m.image / m.video / m.audio / m.file.
//   new chat         (stage 4) resolve / createDm ask the bridge about a phone
//                    number (provisioning API resolve_identifier / create_dm);
//                    the number is never logged and never stored here.
//   history          (stage 5) an administrator allows it (bridges.history, on by default); then the bridge keeps the
//                    phone's history at a new link and fills the rooms (config.js). Each person chooses what of it
//                    comes to GateControl (off, the last 30 days — the default — or everything): history.get / set.
//                    events.js keeps what they want in bridge_backlog; the plugin takes it at night in small portions.
//   backup           (stage 5) backup.js: a snapshot of the stopped containers' data, made by update.sh at night,
//                    encrypted here at once, carried by the GateControl backup (data.bridges) and put back on a restore.
//   clean-up         (stage 5) a file of a room is deleted at the homeserver once the plugin took it over (or nobody
//                    wanted it for 30 days) — as the server's bot, the homeserver's only administrator (hs.js).
//   health           (stage 5) health() tells a plugin, without a person's request, the state of each linked person's
//                    login (also "the phone was not seen for 12 days", the bridge's own warning) — no name, no number.
//   contacts         (stage 4c) contacts / matchNumbers / createDmByRef: the person's contacts at the bridge (its own
//                    store, GET /v3/contacts — no question to WhatsApp) with sealed references instead of numbers;
//                    held in memory for 10 minutes, never written, never logged.
//   images           (stage 5) the pins of images.js go to update.sh with every config file ("bridges_images"): a
//                    GateControl release with a new pin updates the containers at the next run of the script, without
//                    a new docker-compose.yml on the host. Nothing unpinned is ever pulled.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const settings = require('../settings');
const logger = require('../../utils/logger');
const provision = require('./provision');
const config = require('./config');
const images = require('./images');
const hs = require('./hs');
const appservice = require('./appservice');
const eventsMod = require('./events');
const backupMod = require('./backup');

const NETWORKS = Object.freeze(['whatsapp']);
const SERVER_NAME = config.SERVER_NAME;
const SCRIPT = 8; // update.sh marker that knows the profile "bruecken" with relays (also the server's own: bruecken-core-relay), the configuration revision, the probe — and (8) the pinned images, snapshots and their restore
const HOST_STATES = ['running', 'starting', 'failed', 'stopped'];
const HOST_ERRORS = ['compose_missing', 'config_missing', 'start_failed'];
const PROBE_RESULTS = ['ok', 'not_wanted', 'compose_missing', 'config_missing', 'start_failed', 'not_running'];
const WAIT_KEEP_MS = 5 * 60000;
const MAX_WAITS = 32;
// a new chat by number: the bridge asks WhatsApp for every number — at most this many per person and hour
const LOOKUPS_PER_HOUR = 20;
// a phone number as the bridge takes it (E.164 with +)
const NUMBER_RE = /^\+[1-9][0-9]{6,14}$/;
const SEND_KINDS = { image: 'm.image', video: 'm.video', audio: 'm.audio', voice: 'm.audio', file: 'm.file' };
const MIME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;
// stage 5: what a person may choose of the history (days; 0 none, -1 everything the bridge brings) and the default
const HISTORY_OPTIONS = Object.freeze([0, 30, -1]);
const HISTORY_DEFAULT = 30;
const TICK_MS = 5 * 60000;
const CLEAN_PER_RUN = 50;
const HEALTH_MAX = 100;

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
  // stage 5: older messages at a new link — on unless an administrator switched it off
  return { enabled: settings.get('bridges.enabled', '0') === '1', location: 'server', networks, history: settings.get('bridges.history', '1') !== '0' };
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

// One master key on disk; what goes over a socket is derived from it per purpose (HMAC-SHA-256), so the file's
// content itself is never sent anywhere and a token seen in one place says nothing about the others.
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

function derive(key, purpose) {
  return crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(`gatecontrol-bridges:${purpose}`).digest('base64url');
}

function readKey() {
  try {
    const s = JSON.parse(fs.readFileSync(secretsFile(), 'utf8'));
    if (s && typeof s.key === 'string' && KEY_RE.test(s.key)) return s.key;
  } catch { /* not made yet */ }
  return null;
}

function tokens(key) {
  return {
    asToken: derive(key, 'as_token'), hsToken: derive(key, 'hs_token'), provisionSecret: derive(key, 'provisioning'),
    // the server's own application service on the internal homeserver (config.js)
    coreAsToken: derive(key, 'core_as_token'), coreHsToken: derive(key, 'core_hs_token'),
    // a registration without address: the bridge acts with its token for the people's internal accounts ("double puppeting")
    puppetAsToken: derive(key, 'puppet_as_token'), puppetHsToken: derive(key, 'puppet_hs_token'),
  };
}

/** The tokens of the bridges (for this module and the container configuration only), or null before the first switch-on. */
function readSecrets() {
  const key = readKey();
  return key ? tokens(key) : null;
}

/** Make the folder and the master key once (0700 / 0600). → the tokens. */
function ensureSecrets() {
  const have = readKey();
  fs.mkdirSync(path.join(dir(), 'run'), { recursive: true, mode: 0o700 });
  if (have) return tokens(have);
  const key = crypto.randomBytes(32).toString('base64url');
  const tmp = `${secretsFile()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ key }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, secretsFile()); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
  return tokens(key);
}

/**
 * What update.sh shall run, with the configuration written first: { names, rev }.
 * rev changes with the configuration files — update.sh recreates the
 * containers then. Called whenever the host file is written (boot, switch).
 * Never throws: when the files cannot be written the wish stays, without rev.
 */
function wish() {
  const names = wanted();
  if (!names.length) return { names, rev: null, images: null, backup: null, restore: null };
  // stage 5: the images this GateControl pins, and what to do about snapshots
  const imgs = ['hs', 'core-relay', ...names.flatMap((n) => [n, `${n}-relay`])].filter((k) => images.IMAGES[k]).map((k) => `${k}=${images.ref(k)}`).join(',');
  const bk = backupMod.wish();
  try { return { names, rev: config.write(dir(), ensureSecrets(), names, { history: getConfig().history }).rev, images: imgs, ...bk }; }
  catch (err) { logger.warn({ err: err.message }, 'bridges: could not write the configuration of the containers'); return { names, rev: null, images: imgs, ...bk }; }
}

// ─── What the host did ─────────────────────────────────

function num(v, max) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null; }
function ver(v) { return typeof v === 'string' && /^[A-Za-z0-9._+-]{1,40}$/.test(v) ? v : null; }

/**
 * What update.sh wrote into .bridges-state.json (every run while the bridges
 * are wanted) — only known values.
 * → { state, error, checkedAt, services: { <name>: { running, memMb, limitMb, version, outdated } }, script, cron, probe }
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
    if (!s || typeof s !== 'object') { services[name] = { running: false, memMb: null, limitMb: null, version: null, outdated: null }; continue; }
    // the image the container really runs, against the pin of this GateControl (images.js)
    const img = s.running === true ? images.compare(name, s.image) : { version: null, outdated: null };
    services[name] = { running: s.running === true, memMb: num(s.mem_mb, 65536), limitMb: num(s.limit_mb, 65536), version: ver(s.version) || img.version, outdated: img.outdated };
  }
  return {
    state: ok && HOST_STATES.includes(file.state) ? file.state : null,
    error: ok && HOST_ERRORS.includes(file.error) ? file.error : null,
    checkedAt: ok && typeof file.checked_at === 'string' && !Number.isNaN(Date.parse(file.checked_at)) ? new Date(file.checked_at).toISOString() : null,
    services,
    script: { host, needed: SCRIPT },
    cron,
    probe: probeResult(au.DATA_DIR),
    // the relay that brings the homeserver's events to this server (docker-compose.yml since stage 3):
    // true/false as update.sh (marker 7) saw it, null when it did not say (older script)
    coreRelay: ok && file.services && typeof file.services === 'object' && file.services['core-relay'] && typeof file.services['core-relay'] === 'object'
      ? { present: file.services['core-relay'].present !== false, running: file.services['core-relay'].running === true } : null,
  };
}

/**
 * What `update.sh bridges-probe` measured on the host (.bridges-probe.json) — numbers only; the log lines in that
 * file are for the person who ran it and are not passed on.
 * → null | { at, result, windowSeconds, services: { <name>: { running, restarts, oomKilled, memMb, memPeakMb, limitMb, writtenKb } }, sockets: { <name>: boolean }, diskMb }
 */
function probeResult(dataDir) {
  let f = null;
  try { f = JSON.parse(fs.readFileSync(path.join(dataDir, '.bridges-probe.json'), 'utf8')); } catch { return null; }
  if (!f || typeof f !== 'object' || typeof f.probed_at !== 'string' || Number.isNaN(Date.parse(f.probed_at))) return null;
  const services = {};
  const sockets = {};
  for (const name of ['hs', ...NETWORKS, ...NETWORKS.map((n) => `${n}-relay`)]) {
    const s = f.services && typeof f.services === 'object' ? f.services[name] : null;
    if (!s || typeof s !== 'object') continue;
    services[name] = {
      running: s.running === true, restarts: num(s.restarts, 100000), oomKilled: s.oom === true,
      memMb: num(s.mem_mb, 65536), memPeakMb: num(s.mem_peak_mb, 65536), limitMb: num(s.limit_mb, 65536), writtenKb: num(s.write_kb, 1e9),
    };
  }
  for (const name of ['hs', ...NETWORKS]) sockets[name] = !!(f.sockets && typeof f.sockets === 'object' && f.sockets[name] === true);
  return {
    at: new Date(f.probed_at).toISOString(), result: PROBE_RESULTS.includes(f.result) ? f.result : null,
    windowSeconds: num(f.window_s, 86400), services, sockets, diskMb: num(f.disk_mb, 1e7),
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
  if (!previewOn()) return { available: false, reason: 'preview_off', enabled: false, location: 'server', locations: [], networks: [], host: null, history: { enabled: false }, version: 6 };
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
      // outdated: the container runs another image than this GateControl pins (wantVersion) — the
      // docker-compose.yml on the host is older (or newer) than the server
      // clientOutdated (stage 5): the messenger itself turned the bridge away as too old (WhatsApp "405 client outdated")
      // — only a newer pin helps, that is a GateControl update
      return { id, enabled: cfg.networks[id], state, version: s.version, memMb: s.memMb, limitMb: s.limitMb, outdated: s.outdated === true, wantVersion: images.IMAGES[id].version,
        clientOutdated: !!(clientOutdated.get(id) && Date.now() - clientOutdated.get(id) < 86400000) };
    }),
    host: {
      state: cfg.enabled ? host.state : 'stopped', error: cfg.enabled ? host.error : null, checkedAt: host.checkedAt,
      cron: host.cron, script: host.script,
      homeserver: { running: host.services.hs.running, memMb: host.services.hs.memMb, limitMb: host.services.hs.limitMb, version: host.services.hs.version, outdated: host.services.hs.outdated === true, wantVersion: images.IMAGES.hs.version },
      // the memory limits in docker-compose.yml are not measured yet: `update.sh bridges-probe` on the host delivers the numbers
      limitsProvisional: true, probe: host.probe,
    },
    // stage 3: the way of the messages. listening — this server waits for the homeserver's events; relay — the
    // container that hands them over (missing: the docker-compose.yml on the host is older than this server);
    // lastEventAt / pending — when the homeserver last delivered, and what no plugin has fetched yet. No contents.
    messages: messagesStatus(cfg, host),
    // stage 5: older messages — allowed or not, what a person gets by default, what waits for the night
    history: { enabled: cfg.history, default: HISTORY_DEFAULT, options: [...HISTORY_OPTIONS], pending: runtime.events ? runtime.events.historyPending() : 0,
      conversations: config.HISTORY.conversations, messages: config.HISTORY.messages, timeZone: backupMod.timeZone() },
    // stage 5: the nightly snapshot of the bridges' data (encrypted, in the GateControl backup)
    backup: backupMod.status(),
    // stage 5: the copies of files at the homeserver that went after the plugin took them over
    cleanup: { deleted: cleanup.deleted, lastAt: cleanup.lastAt ? new Date(cleanup.lastAt).toISOString() : null, error: cleanup.error, waiting: runtime.events ? runtime.events.mediaWaiting() : 0 },
    // the version of gc.bridges this server offers (child/bootstrap.js)
    version: 6,
  };
}

function messagesStatus(cfg, host) {
  const st = runtime.events ? runtime.events.stats : null;
  return {
    listening: !!runtime.listener,
    relay: !cfg.enabled ? null : (host.coreRelay ? (host.coreRelay.present ? (host.coreRelay.running ? 'running' : 'stopped') : 'missing') : 'unknown'),
    lastEventAt: st && st.lastAt ? new Date(st.lastAt).toISOString() : null,
    transactions: st ? st.transactions : 0,
    pending: runtime.events ? runtime.events.pending() : 0,
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
  for (const k of Object.keys(p)) if (!['enabled', 'networks', 'history', 'backupNow', 'backupTime'].includes(k)) throw new BridgesError('ERR_INVALID', `unknown key ${String(k).slice(0, 40)}`);
  const cur = getConfig();
  const next = { enabled: cur.enabled, networks: { ...cur.networks }, history: cur.history };
  // stage 5: older messages allowed at all; a snapshot now; the time of the nightly one
  if (p.history !== undefined) { if (typeof p.history !== 'boolean') throw new BridgesError('ERR_INVALID', 'history: a boolean'); next.history = p.history; }
  if (p.backupTime !== undefined) { try { backupMod.setBackupTime(p.backupTime); } catch { throw new BridgesError('ERR_INVALID', 'backupTime: HH:MM'); } }
  if (p.backupNow !== undefined) {
    if (p.backupNow !== true) throw new BridgesError('ERR_INVALID', 'backupNow: true');
    if (!wanted().length) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges do not run', 'off');
  }
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
  settings.set('bridges.history', next.history ? '1' : '0');
  if (p.backupNow === true && !backupMod.requested()) backupMod.request('now');
  require('../autoUpdate').syncConfigFile();
  // the listener for the homeserver's events follows the switch
  start().catch((err) => logger.warn({ err: err.message }, 'bridges: listener not started'));
  if (next.history !== cur.history) {
    try { require('../activity').log('bridges_changed', `Messenger-Brücken: älterer Verlauf ${next.history ? 'erlaubt' : 'abgeschaltet'}`, { source: 'admin', severity: 'info', details: { history: next.history, by: ctx && ctx.actor ? ctx.actor.name : null } }); }
    catch (err) { logger.debug({ err: err.message }, 'bridges: activity not written'); }
  }
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

/** stage 5: when a person's link was completed (events.js tells history from late messages by it). */
function linkedTimes() {
  let m = null;
  try { m = JSON.parse(settings.get('bridges.linked_at', '{}')); } catch { m = null; }
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
function linkedAt(userId, network) { const v = Number(linkedTimes()[`${userId}:${network}`]); return Number.isSafeInteger(v) && v > 0 ? v : 0; }
function noteLinked(userId, network, step) {
  if (!step || !step.step || step.step.type !== 'complete') return step;
  const m = linkedTimes();
  m[`${userId}:${network}`] = Date.now();
  try { settings.set('bridges.linked_at', JSON.stringify(m)); } catch (err) { logger.warn({ err: err.message }, 'bridges: link time not noted'); }
  return step;
}

async function loginStep(userId, network, processId, stepId, kind, input, opts) {
  return stepOut(userId, network, noteLinked(userId, network, await loginStepRaw(userId, network, processId, stepId, kind, input, opts)));
}

async function loginStepRaw(userId, network, processId, stepId, kind, input, { pollMs = 15000 } = {}) {
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

/** The person's internal account on the homeserver, made before the first link (the bridge invites it into its rooms). */
const accounts = new Set();
async function ensureAccount(userId) {
  if (accounts.has(userId)) return;
  const secrets = readSecrets();
  if (!secrets) return;
  try {
    await hs.ensureUser({ socket: hs.socketOf(dir()), token: secrets.coreAsToken }, `gc_${userId}`);
    accounts.add(userId);
  } catch (err) {
    // the link itself does not need the account; the bridge's log tells when an invite fails
    logger.warn({ err: err.message, userId }, 'bridges: internal account not made');
  }
}

const login = {
  flows: (userId, network) => clientFor(userId, network).flows(),
  start: async (userId, network, flowId) => {
    const c = clientFor(userId, network);
    await ensureAccount(userId);
    return stepOut(userId, network, noteLinked(userId, network, await c.start(flowId)));
  },
  step: loginStep,
  cancel: (userId, network, processId) => {
    for (const k of waits.keys()) if (k.startsWith(`${userId}:${network}:${processId}:`)) waits.delete(k);
    return clientFor(userId, network).cancel(processId);
  },
};

/** The person's logins on one bridge → [{ network, id, name, state, since, error }]. */
/**
 * The reference of a login a plugin gets instead of the bridge's id (WhatsApp names a login after the person's phone
 * number): HMAC per person and network, not reversible; the server maps it back by asking the bridge (logout).
 */
const LOGIN_REF_RE = /^l[A-Za-z0-9_-]{22}$/;
function loginRef(userId, network, raw) {
  const key = readKey();
  if (!key) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  const k = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update('gatecontrol-bridges:login-refs').digest();
  return 'l' + crypto.createHmac('sha256', k).update(`${userId}\0${network}\0${raw}`).digest('base64url').slice(0, 22);
}
/** A login step as a plugin gets it: a completed one names the login by its reference. */
function stepOut(userId, network, r) {
  if (r && r.step && r.step.type === 'complete' && r.step.loginId) return { ...r, step: { ...r.step, loginId: loginRef(userId, network, r.step.loginId) } };
  return r;
}

async function logins(userId, network) {
  const w = await clientFor(userId, network).whoami();
  noteLogins(network, w.logins);
  return w.logins.map((l) => ({ network, ...l, id: loginRef(userId, network, l.id) }));
}

// stage 5: WhatsApp turned a login away as too old (seen in any login of the last day)
const clientOutdated = new Map(); // network → when
function noteLogins(network, list) {
  if ((list || []).some((l) => l && l.clientOutdated)) clientOutdated.set(network, Date.now());
  else if ((list || []).some((l) => l && l.state === 'connected')) clientOutdated.delete(network);
}

/**
 * gc.bridges.health({ userIds, network }) → [{ userId, logins: [{ state, since, error, phoneOffline, clientOutdated }] | null }]
 * The state of each person's login — for a plugin's background run, without a person's request: it reads the bridge
 * and sends nothing. No id and no name of the login (WhatsApp names both after the person's number), no contact. At
 * most HEALTH_MAX people per call.
 */
async function health({ userIds, network } = {}) {
  if (!NETWORKS.includes(network)) throw new BridgesError('ERR_INVALID', 'unknown network');
  if (!Array.isArray(userIds) || userIds.length > HEALTH_MAX || userIds.some((u) => !Number.isSafeInteger(u) || u <= 0)) throw new BridgesError('ERR_INVALID', `userIds: up to ${HEALTH_MAX} people`);
  const out = [];
  for (const userId of [...new Set(userIds)]) {
    let list = null;
    try {
      const w = await clientFor(userId, network).whoami();
      noteLogins(network, w.logins);
      // no id: a WhatsApp login is named after the person's number
      list = w.logins.map((l) => ({ state: l.state, since: l.since, error: l.error, phoneOffline: !!l.phoneOffline, clientOutdated: !!l.clientOutdated }));
    } catch (e) {
      if (e && e.code === 'ERR_BRIDGES_UNAVAILABLE') throw e;
      list = null;
    }
    out.push({ userId, logins: list });
  }
  return out;
}

// ─── History a person wants (stage 5) ──────────────────

function historyPeople() {
  let m = null;
  try { m = JSON.parse(settings.get('bridges.history_people', '{}')); } catch { m = null; }
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
/** The days of history a person wants: 0 none, -1 everything, n the last n days — 0 while an administrator forbids it. */
function historyOf(userId) {
  if (!getConfig().history) return 0;
  const v = historyPeople()[String(userId)];
  return HISTORY_OPTIONS.includes(v) ? v : HISTORY_DEFAULT;
}

const history = {
  /** history.get(userId) → { allowed, days, default, options, pending } — inside a request of that person */
  get: (userId) => {
    mxidOf(userId);
    const cfg = getConfig();
    const v = historyPeople()[String(userId)];
    return { allowed: previewOn() && cfg.history, days: HISTORY_OPTIONS.includes(v) ? v : HISTORY_DEFAULT, default: HISTORY_DEFAULT, options: [...HISTORY_OPTIONS],
      pending: runtime.events ? runtime.events.historyPending(userId) : 0 };
  },
  /** history.set(userId, days) → get() — inside a changing request of that person; fewer days drop what waits and is not wanted */
  set: (userId, days) => {
    mxidOf(userId);
    if (!HISTORY_OPTIONS.includes(days)) throw new BridgesError('ERR_INVALID', `days: one of ${HISTORY_OPTIONS.join(', ')}`);
    const m = historyPeople();
    if (days === HISTORY_DEFAULT) delete m[String(userId)]; else m[String(userId)] = days;
    settings.set('bridges.history_people', JSON.stringify(m));
    if (runtime.events) { try { runtime.events.historyTrim(userId); } catch (err) { logger.warn({ err: err.message }, 'bridges: history not trimmed'); } }
    return history.get(userId);
  },
  /** history.pull({ limit?, chatId?, userId? }) → { events, more } — needs no person (the plugin files it at night) */
  pull: (o) => {
    if (!previewOn()) return { events: [], more: false };
    const ev = eventsOf();
    if (!ev) return { events: [], more: false };
    const a = o && typeof o === 'object' ? o : {};
    try { return ev.historyPull({ limit: a.limit, chatId: a.chatId == null ? null : a.chatId, userId: a.userId == null ? null : a.userId }); }
    catch (e) { throw new BridgesError('ERR_INVALID', e.message); }
  },
  /** history.ack(seqs) → { ok, pending } */
  ack: (seqs) => {
    const ev = eventsOf();
    if (!ev) return { ok: true, pending: 0 };
    try { return ev.historyAck(seqs); } catch (e) { throw new BridgesError('ERR_INVALID', e.message); }
  },
};

/** logout(userId, network, loginRef): the reference of logins() → the bridge's id of that login (asked, never stored). */
async function logout(userId, network, ref) {
  const c = clientFor(userId, network);
  if (typeof ref !== 'string' || !LOGIN_REF_RE.test(ref)) throw new BridgesError('ERR_INVALID', 'loginId: a login reference');
  const w = await c.whoami();
  const l = w.logins.find((x) => loginRef(userId, network, x.id) === ref);
  if (!l) throw new BridgesError('ERR_BRIDGE', 'no such login', 'not_found');
  return c.logout(l.id);
}

/**
 * Unlink somebody else's account: every login of `userId` on `network` is logged out at the bridge. The one thing
 * a person may do to another person's link — and only to end it (a parent taking a child's permission back). Who
 * may do it to whom is the plugin's rule; the host API checks that `ctx.actor` really acts right now, refuses
 * administrators as targets, and every call is written to the activity log.
 * ctx: { actor: { id, name }, pluginId } → { unlinked: <count> }
 */
async function unlinkFor(userId, network, ctx) {
  const c = clientFor(userId, network);
  const w = await c.whoami();
  let n = 0;
  for (const l of w.logins) { await c.logout(l.id); n++; }
  try {
    require('../activity').log('bridges_unlinked_for', `Messenger-Brücke ${network}: Verknüpfung von Konto ${userId} getrennt`, {
      source: 'plugin', severity: 'info',
      details: { network, userId, logins: n, by: ctx && ctx.actor ? ctx.actor.id : null, byName: ctx && ctx.actor ? ctx.actor.name : null, plugin: ctx ? ctx.pluginId : null },
    });
  } catch (err) { logger.debug({ err: err.message }, 'bridges: activity not written'); }
  return { unlinked: n };
}

// ─── Messages (stage 3) ────────────────────────────────

const runtime = { listener: null, events: null, key: null, starting: null, wake: null, timer: null };
const selfCache = new Map(); // `${userId}:${network}` → { at, ids }

function hsTarget() {
  const secrets = readSecrets();
  return secrets ? { socket: hs.socketOf(dir()), token: secrets.coreAsToken } : null;
}

/** The ids of a person's own logins on a bridge (kept 10 minutes): tells their own messages from a contact's when the bridge writes both through ghosts. */
async function selfIds(userId, network) {
  const k = `${userId}:${network}`;
  const c = selfCache.get(k);
  if (c && Date.now() - c.at < 600000) return c.ids;
  const secrets = readSecrets();
  if (!secrets) return [];
  let ids = [];
  try {
    const w = await provision.client({ socket: provision.socketOf(dir(), network), secret: secrets.provisionSecret }, mxidOf(userId)).whoami();
    ids = w.logins.map((l) => String(l.id));
  } catch { ids = c ? c.ids : []; }
  if (selfCache.size > 500) selfCache.clear();
  selfCache.set(k, { at: Date.now(), ids });
  return ids;
}

/** The translator of this installation (one per master key), or null before the bridges were ever switched on. */
function eventsOf() {
  const key = readKey();
  if (!key) return null;
  if (runtime.events && runtime.key === key) return runtime.events;
  runtime.key = key;
  runtime.events = eventsMod.create({
    serverName: SERVER_NAME, networks: [...NETWORKS],
    key: crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update('gatecontrol-bridges:events').digest(),
    target: hsTarget, selfIds, historyOf, linkedAt,
  });
  return runtime.events;
}

/** Tell the plugins that may use the bridges: there is something to fetch (and what is not kept: typing, read receipts). */
function wakePlugins(ephemeral) {
  let list = [];
  try { list = require('../plugins/registry').list(); } catch { return; }
  for (const p of list) {
    const perms = p.manifest && p.manifest.permissions;
    if (!perms || perms.bridges !== true || !p.enabled) continue;
    try {
      const rt = require('../plugins/runtime');
      if (rt.info(p.id).state !== 'running') continue;
      rt.call(p.id, 'bridgeEvents', { pending: runtime.events ? runtime.events.pending() : 0, ephemeral: ephemeral || [] }, 15000).catch(() => {});
    } catch { /* fetched at the plugin's next tick */ }
  }
}

async function onTransaction(txnId, body) {
  const ev = eventsOf();
  if (!ev) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up', 'not_running');
  const r = await ev.transaction(txnId, body);
  if (r.stored || r.ephemeral.length) (runtime.wake || wakePlugins)(r.ephemeral);
}

/**
 * Listen for the homeserver's events while the bridges are wanted, stop when they are not. Called at the server's
 * start and whenever the switch changes. Never throws for "nothing to do".
 */
function start() {
  // one after the other: a switch flipped twice in a row ends in the state of the last flip
  const run = (runtime.starting || Promise.resolve()).catch(() => {}).then(async () => {
    if (!wanted().length) { await stop(); return false; }
    if (runtime.listener) return true;
    const secrets = ensureSecrets();
    eventsOf();
    runtime.listener = await appservice.listen({ socket: appservice.socketOf(dir()), hsToken: secrets.coreHsToken, onTransaction });
    logger.info('bridges: listening for the homeserver');
    // stage 5: snapshots and the clean-up of the homeserver's copies, every few minutes
    if (!runtime.timer) {
      runtime.timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
      if (runtime.timer.unref) runtime.timer.unref();
    }
    return true;
  });
  runtime.starting = run;
  return run;
}

async function stop() {
  const l = runtime.listener;
  runtime.listener = null;
  if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = null; }
  if (l) { try { await l.close(); } catch { /* closed */ } }
}

/** The room behind a person's chat — only theirs, only on a bridge that is switched on. */
function roomFor(userId, network, chatId) {
  if (!NETWORKS.includes(network)) throw new BridgesError('ERR_INVALID', 'unknown network');
  mxidOf(userId);
  if (!previewOn()) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.networks[network]) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'this bridge is switched off', 'off');
  const ev = eventsOf();
  const target = hsTarget();
  if (!ev || !target) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  const row = ev.roomOf(userId, network, chatId);
  if (!row) throw new BridgesError('ERR_INVALID', 'unknown chat');
  // invited: a chat just made by number (createDm) — the bridge's join is on its way
  if (row.state !== 'joined' && row.state !== 'invited') throw new BridgesError('ERR_BRIDGE', 'this chat is closed', 'chat_closed');
  return { row, target, mxid: mxidOf(userId) };
}

const eventId = (v, what) => { if (!hs.EVENT_RE.test(String(v || ''))) throw new BridgesError('ERR_INVALID', `${what}: a message id`); return v; };
const txnOf = (v) => { if (!hs.TXN_RE.test(String(v || ''))) throw new BridgesError('ERR_INVALID', 'txnId: 8…96 characters of A-Z a-z 0-9 _ -'); return v; };

// what was uploaded for a file of a plugin (sending it again — "Erneut senden" — does not upload it twice)
const uploads = new Map(); // `${pluginId}:${mediaId}` → mxc

/**
 * The content of a file message: what mautrix-whatsapp reads (pkg/msgconv/from-matrix.go, constructMediaMessage /
 * reuploadFileToWhatsApp) — body = the caption (or the name), filename, info.mimetype / size / w / h / duration; a
 * voice message is m.audio with org.matrix.msc3245.voice (PTT at WhatsApp) and org.matrix.msc1767.audio
 * { duration, waveform }.
 */
function fileContent(m, text, mxc, file) {
  const kind = m.kind;
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.replace(/[\0-\x1f\x7f/\\]/g, ' ').trim().slice(0, 200) : `${kind}`;
  const int = (v, max) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : null; };
  const info = { mimetype: file.mime, size: file.length };
  const w = int(m.w, 100000);
  const h = int(m.h, 100000);
  if (w && h && (kind === 'image' || kind === 'video')) { info.w = w; info.h = h; }
  const duration = int(m.durationMs, 864e5);
  if (duration && kind !== 'image' && kind !== 'file') info.duration = duration;
  const content = { msgtype: SEND_KINDS[kind], body: text || name, filename: name, url: mxc, info };
  if (kind === 'voice') {
    content['org.matrix.msc3245.voice'] = {};
    const wave = Array.isArray(m.waveform) ? m.waveform.slice(0, 64).map((x) => Math.max(0, Math.min(255, Math.round(Number(x) || 0)))) : [];
    content['org.matrix.msc1767.audio'] = { ...(duration ? { duration } : {}), ...(wave.length ? { waveform: wave } : {}) };
  }
  return content;
}

/**
 * gc.bridges.send(userId, network, chatId, { txnId, text, replyTo?, edit? }) → { id }
 * A text message; `replyTo` quotes a message, `edit` replaces the text of one of the person's own. The same txnId
 * sends once (the homeserver keeps it). The bridge's word on it comes later as an event of type 'status'.
 * Since version 4 a file: { txnId, text? (caption), replyTo?, media: { kind: image | video | audio | voice | file,
 * name?, w?, h?, durationMs?, waveform? } } with `file` from the host API: { key, length, mime, source() } — the
 * plugin's stored file, already checked (its own, servable).
 */
async function send(userId, network, chatId, msg, file = null) {
  const { row, target, mxid } = roomFor(userId, network, chatId);
  const m = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
  if (!m) throw new BridgesError('ERR_INVALID', 'message: an object');
  const text = typeof m.text === 'string' ? m.text.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0b-\x1f\x7f]/g, '') : '';
  const txnId = txnOf(m.txnId);
  if (m.media != null) {
    const md = m.media && typeof m.media === 'object' && !Array.isArray(m.media) ? m.media : null;
    if (!md || !SEND_KINDS[md.kind] || !file || m.edit != null) throw new BridgesError('ERR_INVALID', 'media: { kind: image | video | audio | voice | file } with a file');
    if (text.length > eventsMod.TEXT_MAX) throw new BridgesError('ERR_INVALID', 'text: up to 16000 characters');
    if (!MIME_RE.test(String(file.mime || '')) || !Number.isSafeInteger(file.length) || file.length < 1) throw new BridgesError('ERR_INVALID', 'invalid file');
    let mxc = uploads.get(file.key);
    if (!mxc) {
      mxc = await hs.upload(target, mxid, { source: file.source(), length: file.length, mime: file.mime, name: md.name });
      if (uploads.size > 500) uploads.clear();
      uploads.set(file.key, mxc);
    }
    const content = fileContent(md, text.trim() ? text : null, mxc, file);
    if (m.replyTo != null) content['m.relates_to'] = { 'm.in_reply_to': { event_id: eventId(m.replyTo, 'replyTo') } };
    return { id: await hs.send(target, mxid, row.room_id, 'm.room.message', txnId, content) };
  }
  if (!text.trim() || text.length > eventsMod.TEXT_MAX) throw new BridgesError('ERR_INVALID', 'text: 1…16000 characters');
  let content = { msgtype: 'm.text', body: text };
  if (m.edit != null) {
    content = { msgtype: 'm.text', body: `* ${text}`, 'm.new_content': { msgtype: 'm.text', body: text }, 'm.relates_to': { rel_type: 'm.replace', event_id: eventId(m.edit, 'edit') } };
  } else if (m.replyTo != null) {
    content['m.relates_to'] = { 'm.in_reply_to': { event_id: eventId(m.replyTo, 'replyTo') } };
  }
  return { id: await hs.send(target, mxid, row.room_id, 'm.room.message', txnId, content) };
}

/** gc.bridges.react(userId, network, chatId, { txnId, target, emoji }) → { id } — take it back with redact(…, { target: id }). */
async function react(userId, network, chatId, r) {
  const { row, target, mxid } = roomFor(userId, network, chatId);
  const x = r && typeof r === 'object' ? r : {};
  if (typeof x.emoji !== 'string' || !x.emoji || x.emoji.length > 32 || /[\s\0-\x1f\x7f]/.test(x.emoji)) throw new BridgesError('ERR_INVALID', 'emoji: 1…32 characters');
  const content = { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId(x.target, 'target'), key: x.emoji } };
  return { id: await hs.send(target, mxid, row.room_id, 'm.reaction', txnOf(x.txnId), content) };
}

/** gc.bridges.redact(userId, network, chatId, { txnId, target }) → { ok } — delete a message for everyone, or take a reaction back. */
async function redact(userId, network, chatId, r) {
  const { row, target, mxid } = roomFor(userId, network, chatId);
  const x = r && typeof r === 'object' ? r : {};
  await hs.redact(target, mxid, row.room_id, eventId(x.target, 'target'), txnOf(x.txnId));
  return { ok: true };
}

/** gc.bridges.read(userId, network, chatId, messageId) → { ok } — the person read up to this message. */
async function read(userId, network, chatId, messageId) {
  const { row, target, mxid } = roomFor(userId, network, chatId);
  return hs.read(target, mxid, row.room_id, eventId(messageId, 'messageId'));
}

/** gc.bridges.typing(userId, network, chatId, on) → { ok } */
async function typing(userId, network, chatId, on) {
  const { row, target, mxid } = roomFor(userId, network, chatId);
  return hs.typing(target, mxid, row.room_id, on === true);
}

/** gc.bridges.chats(userId, network) → [{ id, kind, open }] — the person's chats on a bridge (no names: those travel with the events). */
function chats(userId, network) {
  if (!NETWORKS.includes(network)) throw new BridgesError('ERR_INVALID', 'unknown network');
  mxidOf(userId);
  const ev = previewOn() ? eventsOf() : null;
  return ev ? ev.chats(userId, network) : [];
}

// ─── Files (stage 4) ───────────────────────────────────

/**
 * A file a bridge delivered for a person (`ref` from an event: media.ref, chat.avatar, contact.avatar), opened as a
 * stream from the homeserver. No person needs to act — like events.pull, it reads what was delivered for them, and
 * only into the plugin's own media (hostApi.js). → { stream, length, mime }
 * @param {{ max: number }} o  the plugin's size limit: a larger file is refused before a byte is read (too_large)
 */
async function openFile(userId, network, ref, { max } = {}) {
  if (!NETWORKS.includes(network)) throw new BridgesError('ERR_INVALID', 'unknown network');
  mxidOf(userId);
  if (!previewOn()) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not offered on this server', 'preview_off');
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.networks[network]) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'this bridge is switched off', 'off');
  const ev = eventsOf();
  const target = hsTarget();
  if (!ev || !target) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  const r = ev.openMediaRef(ref);
  // a reference of another person (or of another installation) opens nothing
  if (!r || r.userId !== userId) throw new BridgesError('ERR_INVALID', 'unknown file');
  return hs.download(target, mxidOf(userId), r.mxc, { max, serverName: SERVER_NAME });
}

/** stage 5: the plugin took this file over (host API, after it was stored and scanned) — the homeserver's copy may go. */
function mediaFetched(userId, ref) {
  const ev = previewOn() ? eventsOf() : null;
  const r = ev ? ev.openMediaRef(ref) : null;
  if (r && r.userId === userId) { try { ev.mediaFetched(userId, r.mxc); } catch (err) { logger.debug({ err: err.message }, 'bridges: file not noted'); } }
}

// ─── Clean-up at the homeserver (stage 5) ──────────────

const cleanup = { deleted: 0, lastAt: null, error: null, running: false };
const BOT = `@${config.CORE_BOT}:${SERVER_NAME}`;

/**
 * Delete at the homeserver what the plugin took over, what nobody wanted, what nobody fetched for 30 days
 * (events.mediaToClean). The bot is the homeserver's administrator (config.js admin_execute); until it took its seat
 * in the admin room it is refused — then it joins once and tries again. → files deleted
 */
async function cleanupRun({ limit = CLEAN_PER_RUN } = {}) {
  if (cleanup.running || !previewOn() || !wanted().length) return 0;
  const ev = eventsOf();
  const target = hsTarget();
  if (!ev || !target) return 0;
  cleanup.running = true;
  let n = 0;
  try {
    let joined = false;
    for (const mxc of ev.mediaToClean(Date.now(), limit)) {
      try { await hs.deleteMedia(target, BOT, mxc, SERVER_NAME); }
      catch (e) {
        if (e && e.code === 'ERR_BRIDGE_UNREACHABLE') { cleanup.error = 'unreachable'; break; }
        if (e && e.reason === 'm_forbidden' && !joined) {
          joined = true;
          try { await hs.joinAdminRoom(target, BOT, SERVER_NAME); await hs.deleteMedia(target, BOT, mxc, SERVER_NAME); }
          catch (e2) { cleanup.error = e2 && e2.reason === 'm_forbidden' ? 'no_admin' : 'failed'; break; }
        } else { cleanup.error = e && e.reason === 'm_forbidden' ? 'no_admin' : 'failed'; break; }
      }
      ev.mediaCleaned(mxc);
      n++;
      cleanup.error = null;
    }
  } finally { cleanup.running = false; }
  cleanup.deleted += n;
  cleanup.lastAt = Date.now();
  return n;
}

/** Every TICK_MS while the bridges are wanted: snapshots (backup.js) and the clean-up. */
async function tick() {
  await backupMod.tick();
  try { await cleanupRun(); } catch (err) { logger.warn({ err: err.message }, 'bridges: clean-up failed'); }
}

/** The master key (backup.js) — never returned by any API. */
function masterKey() { return readKey(); }
/** A restore puts the master key back (backup.js). The one before is kept next to it. */
function writeMasterKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new BridgesError('ERR_INVALID', 'not a master key');
  const have = readKey();
  if (have === key) return false;
  fs.mkdirSync(path.join(dir(), 'run'), { recursive: true, mode: 0o700 });
  if (have) { try { fs.copyFileSync(secretsFile(), `${secretsFile()}.before-restore`); fs.chmodSync(`${secretsFile()}.before-restore`, 0o600); } catch { /* best effort */ } }
  const tmp = `${secretsFile()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ key }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, secretsFile()); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
  runtime.events = null;
  runtime.key = null;
  accounts.clear();
  return true;
}
function forget() { if (runtime.events) runtime.events._forget(); accounts.clear(); selfCache.clear(); contactLists.clear(); }

// ─── A new chat by number (stage 4) ────────────────────

const lookups = new Map(); // userId → [times of the last hour]

/** The number as the bridge takes it: + and 7…15 digits; spaces, dashes, dots, brackets and a leading 00 are allowed. */
function numberOf(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  let n = v.replace(/[\s\-./()]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  return NUMBER_RE.test(n) ? n : null;
}

function countLookup(userId) {
  const now = Date.now();
  const list = (lookups.get(userId) || []).filter((t) => now - t < 3600000);
  if (list.length >= LOOKUPS_PER_HOUR) throw Object.assign(new BridgesError('ERR_RATE_LIMIT', 'too many numbers asked for in the last hour'), { retryAfterS: Math.ceil((3600000 - (now - list[0])) / 1000) });
  list.push(now);
  if (lookups.size > 2000) lookups.clear();
  lookups.set(userId, list);
}

/** The bridge's refusals of a number, as a word — its text names the number and goes nowhere. */
function lookupError(e) {
  if (e && e.code === 'ERR_BRIDGE' && e.reason === 'not_found') return new BridgesError('ERR_BRIDGE', 'not found', 'not_found');
  if (e && e.code === 'ERR_BRIDGE') return new BridgesError('ERR_BRIDGE', 'the bridge refused', e.reason === 'refused' ? 'refused' : 'bridge_error');
  if (e && e.code === 'ERR_BRIDGE_UNREACHABLE') return new BridgesError('ERR_BRIDGE_UNREACHABLE', 'the bridge does not answer', e.reason);
  return e;
}

/**
 * gc.bridges.resolve(userId, network, number) → { found: true, name } | { found: false }
 * Is this number at the service (WhatsApp: "on WhatsApp"), and under which name? Inside a changing request of that
 * person; at most LOOKUPS_PER_HOUR per person and hour (ERR_RATE_LIMIT with retryAfterS). The answer carries no
 * address, no id and not the number.
 */
async function resolve(userId, network, number) {
  const c = clientFor(userId, network);
  const n = numberOf(number);
  if (!n) throw new BridgesError('ERR_INVALID', 'number: + and the country code', 'invalid_number');
  countLookup(userId);
  try {
    const r = await c.resolve(n);
    return r ? { found: true, name: r.name } : { found: false };
  } catch (e) {
    if (e && e.code === 'ERR_BRIDGE' && e.reason === 'not_found') return { found: false };
    throw lookupError(e);
  }
}

/**
 * gc.bridges.createDm(userId, network, number) → { chat: { id, kind: 'direct', name } }
 * The bridge opens (or finds) the direct chat with this number; the chat is known to the plugin at once — its name
 * and the first events follow as usual. Same rules as resolve().
 */
async function createDm(userId, network, number) {
  const c = clientFor(userId, network);
  const n = numberOf(number);
  if (!n) throw new BridgesError('ERR_INVALID', 'number: + and the country code', 'invalid_number');
  const ev = eventsOf();
  if (!ev) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  countLookup(userId);
  await ensureAccount(userId);
  let r;
  try { r = await c.createDm(n); } catch (e) { throw lookupError(e); }
  if (!r) throw new BridgesError('ERR_BRIDGE', 'not found', 'not_found');
  if (!r.roomId) throw new BridgesError('ERR_BRIDGE', 'the bridge opened no chat', 'bad_answer');
  let row;
  try { row = ev.adopt(userId, network, r.roomId); } catch (e) { throw new BridgesError('ERR_BRIDGE', e.message, e.reason || 'bad_answer'); }
  return { chat: { id: row.ref, kind: 'direct', name: r.name } };
}

// ─── A new chat with a contact (stage 4c) ────────────

// The person's contacts at the bridge (WhatsApp: the contact store the bridge keeps — listing them asks WhatsApp
// nothing). They stay in this process's memory for CONTACTS_KEEP_MS at most and are never written anywhere or logged;
// a plugin gets a name, a picture reference, the chat it already has, and a sealed reference — never a number, a
// WhatsApp id or a Matrix address. The reference is sealed with a key that exists only in this process (AES-256-GCM),
// names the person and the network, and runs out after CONTACT_REF_TTL_MS (and at every restart).
const CONTACTS_KEEP_MS = 10 * 60000;
const CONTACT_REF_TTL_MS = 30 * 60000;
const CONTACT_REF_RE = /^k[A-Za-z0-9_-]{40,1400}$/;
const MATCH_MAX = 2000;
const QUERY_MAX = 100;
const contactLists = new Map(); // `${userId}:${network}` → { at, list } (provision.contactsOut)
const contactKey = { key: null };

function contactSealKey() {
  if (!contactKey.key) contactKey.key = crypto.randomBytes(32);
  return contactKey.key;
}
function contactRefOf(userId, network, c, now) {
  const plain = Buffer.from(JSON.stringify({ u: userId, n: network, m: c.mxid || null, i: c.mxid ? null : c.id, t: now }), 'utf8');
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv('aes-256-gcm', contactSealKey(), iv);
  const ct = Buffer.concat([ci.update(plain), ci.final()]);
  return 'k' + Buffer.concat([iv, ci.getAuthTag(), ct]).toString('base64url');
}
/** → { mxid, id } of a reference made here for this person and network, still valid — else null. */
function openContactRef(userId, network, ref, now = Date.now()) {
  if (typeof ref !== 'string' || !CONTACT_REF_RE.test(ref) || !contactKey.key) return null;
  try {
    const b = Buffer.from(ref.slice(1), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', contactKey.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
    if (!o || o.u !== userId || o.n !== network || !Number.isFinite(o.t) || now - o.t > CONTACT_REF_TTL_MS || o.t > now + 60000) return null;
    return o.m || o.i ? { mxid: o.m || null, id: o.i || null } : null;
  } catch { return null; }
}

/** A contact of the bridge → what a plugin gets: { ref, name, avatar, chatId }. */
function contactView(userId, network, c, ev, now) {
  const chat = ev && c.roomId ? ev.chatOfRoom(userId, network, c.roomId) : null;
  // contactId: the contact's reference as the events name it (sender.id / contact.id — an HMAC of the ghost, stable)
  return { ref: contactRefOf(userId, network, c, now), contactId: ev && c.mxid ? ev.contactRef(network, c.mxid) : null, name: c.name,
    avatar: ev && c.avatarUrl ? ev.pictureRef(userId, c.avatarUrl) : null, chatId: chat };
}

async function contactList(userId, network, c) {
  const k = `${userId}:${network}`;
  const now = Date.now();
  const have = contactLists.get(k);
  if (have && now - have.at < CONTACTS_KEEP_MS) return have.list;
  let list;
  try { list = await c.contacts(); } catch (e) { throw lookupError(e); }
  for (const [x, v] of contactLists) if (now - v.at >= CONTACTS_KEEP_MS) contactLists.delete(x);
  if (contactLists.size > 200) contactLists.clear();
  contactLists.set(k, { at: now, list });
  return list;
}

/**
 * gc.bridges.contacts(userId, network, { query? }) → { contacts: [{ ref, contactId, name, avatar, chatId }] }
 * The person's contacts at the bridge (`query`: the bridge's own search over them, by name). Inside a request of that
 * person. No number, no id, no address: `ref` starts a chat (createDmByRef), `avatar` is a picture reference for
 * media.fetch, `chatId` the chat the person has with this contact already (null: none known), `contactId` the contact's
 * reference as the events name it (sender.id), stable — for merging and for its picture.
 */
async function contacts(userId, network, opts = {}) {
  const c = clientFor(userId, network);
  const query = opts && typeof opts.query === 'string' ? opts.query.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, QUERY_MAX) : '';
  let list;
  if (query) {
    try { list = await c.searchUsers(query); } catch (e) { throw lookupError(e); }
  } else list = await contactList(userId, network, c);
  const ev = eventsOf();
  const now = Date.now();
  return { contacts: list.map((x) => contactView(userId, network, x, ev, now)) };
}

/**
 * gc.bridges.matchNumbers(userId, network, numbers) → { matches: [{ index, ref, contactId, name, avatar, chatId }] }
 * Which of these numbers (the person's own, e.g. from their address book) are contacts at the bridge? Compared with
 * the contact list the bridge keeps — no question to WhatsApp, nothing counted. `index` is the place in `numbers`; a
 * number that is not one (+ and the country code) matches nothing. Inside a request of that person.
 */
async function matchNumbers(userId, network, numbers) {
  const c = clientFor(userId, network);
  if (!Array.isArray(numbers) || numbers.length > MATCH_MAX) throw new BridgesError('ERR_INVALID', `numbers: up to ${MATCH_MAX}`);
  const want = new Map();
  numbers.forEach((v, i) => { const n = numberOf(v); if (n) { if (!want.has(n)) want.set(n, []); want.get(n).push(i); } });
  if (!want.size) return { matches: [] };
  const list = await contactList(userId, network, c);
  const ev = eventsOf();
  const now = Date.now();
  const matches = [];
  for (const x of list) {
    for (const n of x.numbers) {
      const at = want.get(n);
      if (!at) continue;
      const view = contactView(userId, network, x, ev, now);
      for (const index of at) matches.push({ index, ...view });
      want.delete(n);
    }
  }
  return { matches: matches.sort((a, b) => a.index - b.index) };
}

/**
 * gc.bridges.createDmByRef(userId, network, ref) → { chat: { id, kind: 'direct', name } }
 * The direct chat with a contact of contacts() / matchNumbers() (made or found) — by the bridge's own contact, not by a
 * number: nothing is asked of WhatsApp about a number, nothing counted. Inside a changing request of that person;
 * a reference of another person, another network, an older process or older than 30 minutes → ERR_INVALID / expired_ref.
 */
async function createDmByRef(userId, network, ref) {
  const c = clientFor(userId, network);
  const who = openContactRef(userId, network, ref);
  if (!who) throw new BridgesError('ERR_INVALID', 'unknown or expired contact', 'expired_ref');
  const ev = eventsOf();
  if (!ev) throw new BridgesError('ERR_BRIDGES_UNAVAILABLE', 'the bridges are not set up yet', 'not_running');
  await ensureAccount(userId);
  let r;
  try { r = await c.createDmWith(who.mxid || who.id); } catch (e) { throw lookupError(e); }
  if (!r) throw new BridgesError('ERR_BRIDGE', 'not found', 'not_found');
  if (!r.roomId) throw new BridgesError('ERR_BRIDGE', 'the bridge opened no chat', 'bad_answer');
  let row;
  try { row = ev.adopt(userId, network, r.roomId); } catch (e) { throw new BridgesError('ERR_BRIDGE', e.message, e.reason || 'bad_answer'); }
  return { chat: { id: row.ref, kind: 'direct', name: r.name } };
}

const events = {
  /** events.pull({ after?, limit? }) → { events, more } */
  pull: (o) => {
    if (!previewOn()) return { events: [], more: false };
    const ev = eventsOf();
    return ev ? ev.pull(o && typeof o === 'object' ? o : {}) : { events: [], more: false };
  },
  /** events.ack(upTo) → { ok, pending } */
  ack: (upTo) => {
    const ev = eventsOf();
    if (!ev) return { ok: true, pending: 0 };
    try { return ev.ack(upTo); } catch (e) { throw new BridgesError('ERR_INVALID', e.message); }
  },
};

function _reset() {
  waits.clear(); accounts.clear(); selfCache.clear(); uploads.clear(); lookups.clear(); clientOutdated.clear(); contactLists.clear(); contactKey.key = null;
  runtime.events = null; runtime.key = null; runtime.wake = null;
  Object.assign(cleanup, { deleted: 0, lastAt: null, error: null, running: false });
}

module.exports = {
  NETWORKS, SCRIPT, SERVER_NAME, BridgesError,
  previewOn, getConfig, wanted, wish, status, configure, hostStatus, ensureSecrets, readSecrets, dir,
  login, logins, logout, unlinkFor, mxidOf, _reset,
  start, stop, send, react, redact, read, typing, chats, events, openFile, resolve, createDm, numberOf, contacts, matchNumbers, createDmByRef, _openContactRef: openContactRef,
  history, historyOf, linkedAt, health, mediaFetched, cleanupRun, tick, masterKey, writeMasterKey, _forget: forget, HISTORY_OPTIONS, HISTORY_DEFAULT,
  _onTransaction: onTransaction, _eventsOf: eventsOf, _runtime: runtime,
};
