'use strict';

// Plugin processes (docs/plugins.md "Isolation"): one child process per
// running plugin, started with Node's permission model, restarted with
// backoff after a crash, stopped on disable/uninstall. The host talks to it
// over the IPC channel only (child/bootstrap.js has the other half).

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const EventEmitter = require('node:events');
const registry = require('./registry');
const hostApi = require('./hostApi');
const { LIMITS, TIMEOUTS, RESTART_BACKOFF_MS, STABLE_AFTER_MS, codeDir, filesDir } = require('./constants');
const logger = require('../../utils/logger');

const BOOTSTRAP = path.join(__dirname, 'child', 'bootstrap.js');
const MAX_HOST_CALLS = 32;
const LOG_LINES_PER_MIN = 120;
const PING_EVERY_MS = 30000;
const PING_DEAD_MS = 75000;

let backoff = RESTART_BACKOFF_MS;
const procs = new Map();
const events = new EventEmitter();

function flagIf(flag) {
  return process.allowedNodeEnvironmentFlags.has(flag) ? [flag] : [];
}

/** Node arguments of a plugin process (exported for tests and docs). */
function execArgvFor(plugin) {
  const code = codeDir(plugin.id, plugin.version);
  const files = filesDir(plugin.id);
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  return [
    permission,
    `--allow-fs-read=${BOOTSTRAP}`,
    `--allow-fs-read=${code}`,
    `--allow-fs-read=${files}`,
    `--allow-fs-write=${files}`,
    `--max-old-space-size=${LIMITS.memoryMb}`,
    ...flagIf('--no-experimental-sqlite'),
    ...flagIf('--disable-sigusr1'),
  ];
}

class PluginProcess {
  constructor(plugin) {
    this.plugin = plugin;
    this.id = plugin.id;
    this.state = 'stopped';     // stopped | starting | running | crashed | stopping
    this.wanted = false;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.hostCalls = 0;
    this.crashes = 0;
    this.backoffIdx = 0;
    this.restartTimer = null;
    this.restartAt = null;
    this.tickTimer = null;
    this.tickBusy = false;
    this.pingTimer = null;
    this.lastPong = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.logWindow = { start: 0, n: 0 };
  }

  log(level, message) {
    const now = Date.now();
    if (now - this.logWindow.start > 60000) this.logWindow = { start: now, n: 0 };
    if (++this.logWindow.n > LOG_LINES_PER_MIN) return;
    try { registry.addLog(this.id, level, message); } catch { /* db closed */ }
  }

  spawn() {
    if (this.child) return;
    const p = this.plugin;
    const code = codeDir(p.id, p.version);
    const files = filesDir(p.id);
    fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    const entry = path.join(code, p.manifest.entry);
    if (!entry.startsWith(code + path.sep)) throw new Error('entry outside the plugin folder');
    this.state = 'starting';
    this.startedAt = Date.now();
    this.lastPong = Date.now();
    let child;
    try {
      child = fork(BOOTSTRAP, [], {
        cwd: code,
        execArgv: execArgvFor(p),
        env: { NODE_ENV: 'production', GC_PLUGIN_ID: p.id, TZ: process.env.TZ || 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
      });
    } catch (e) {
      this.onExit(null, null, e);
      return;
    }
    this.child = child;
    const lines = (level) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && !/ExperimentalWarning|--trace-warnings/.test(line)) this.log(level, line);
        }
      };
    };
    child.stdout.on('data', lines('info'));
    child.stderr.on('data', lines('error'));
    child.on('message', (m) => this.onMessage(m));
    child.on('error', (e) => { this.lastError = e.message; });
    child.on('exit', (code2, sig) => this.onExit(code2, sig, null, child));
    const readyTimer = setTimeout(() => {
      if (this.child === child && this.state === 'starting') {
        this.lastError = 'start timeout';
        this.log('error', 'plugin did not start in time');
        child.kill('SIGKILL');
      }
    }, TIMEOUTS.start);
    readyTimer.unref();
    this.readyTimer = readyTimer;
    child.send({ t: 'init', plugin: { id: p.id, version: p.version, entry } });
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready':
        clearTimeout(this.readyTimer);
        this.state = 'running';
        this.lastError = null;
        this.startTimers();
        this.log('info', `started (v${this.plugin.version})`);
        events.emit('state', this.id, 'running');
        break;
      case 'fatal':
        this.lastError = String(m.error || 'start failed').split('\n')[0].slice(0, 300);
        this.log('error', 'start failed: ' + String(m.error || '').slice(0, 900));
        break;
      case 'log':
        this.log(['debug', 'info', 'warn', 'error'].includes(m.level) ? m.level : 'info', String(m.message || ''));
        break;
      case 'pong':
        this.lastPong = Date.now();
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value); else p.reject(Object.assign(new Error(String(m.error || 'plugin error').slice(0, 300)), { code: 'ERR_PLUGIN' }));
        break;
      }
      case 'host':
        this.onHostCall(m);
        break;
      default:
    }
  }

  onHostCall(m) {
    const reply = (msg) => { if (this.child && this.child.connected) { try { this.child.send(msg); } catch { /* gone */ } } };
    if (this.hostCalls >= MAX_HOST_CALLS) {
      reply({ t: 'hostResult', id: m.id, ok: false, error: 'too many concurrent host calls', code: 'ERR_BUSY' });
      return;
    }
    this.hostCalls++;
    const timeout = new Promise((_r, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('host call timed out'), { code: 'ERR_TIMEOUT' })), TIMEOUTS.hostCall); t.unref(); });
    const ctx = { emit: (msg) => reply(msg) };
    Promise.race([hostApi.handle(this.plugin, String(m.api || ''), m.args || {}, ctx), timeout])
      .then((value) => reply({ t: 'hostResult', id: m.id, ok: true, value: value === undefined ? null : value }),
        (e) => reply({ t: 'hostResult', id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 300), code: (e && e.code) || null }))
      .finally(() => { this.hostCalls--; });
  }

  startTimers() {
    const bg = this.plugin.manifest.permissions && this.plugin.manifest.permissions.background;
    if (bg && bg.intervalSeconds) {
      this.tickTimer = setInterval(() => this.runTick(), bg.intervalSeconds * 1000);
      this.tickTimer.unref();
    }
    this.pingTimer = setInterval(() => {
      if (!this.child || this.state !== 'running') return;
      if (Date.now() - this.lastPong > PING_DEAD_MS) {
        this.log('error', 'plugin stopped answering — restarting');
        this.child.kill('SIGKILL');
        return;
      }
      try { this.child.send({ t: 'ping', id: ++this.seq }); } catch { /* exit follows */ }
    }, PING_EVERY_MS);
    this.pingTimer.unref();
  }

  clearTimers() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.tickTimer = null;
    this.pingTimer = null;
  }

  async runTick() {
    if (this.tickBusy || this.state !== 'running') return;
    this.tickBusy = true;
    try { await this.call('tick', {}, TIMEOUTS.tick); } catch (e) { this.log('warn', 'background run failed: ' + e.message); } finally { this.tickBusy = false; }
  }

  onExit(code, sig, err, child) {
    if (child && this.child !== child) return;
    this.child = null;
    this.clearTimers();
    hostApi.closeSockets(this.id);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('plugin process ended'), { code: 'ERR_NOT_RUNNING' })); }
    this.pending.clear();
    if (this.stopResolve) { const r = this.stopResolve; this.stopResolve = null; r(); }
    if (!this.wanted) { this.state = 'stopped'; events.emit('state', this.id, 'stopped'); return; }
    // unexpected end → crash, restart with backoff
    this.crashes++;
    if (this.startedAt && Date.now() - this.startedAt > STABLE_AFTER_MS) this.backoffIdx = 0;
    const delay = backoff[Math.min(this.backoffIdx, backoff.length - 1)];
    this.backoffIdx++;
    this.state = 'crashed';
    this.lastError = this.lastError || (err ? err.message : `exited (${sig || code})`);
    this.log('error', `process ended (${sig || code}) — restart in ${Math.round(delay / 1000)} s`);
    logger.warn({ plugin: this.id, code, sig }, 'plugin process ended unexpectedly');
    events.emit('state', this.id, 'crashed');
    this.restartAt = Date.now() + delay;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartAt = null;
      if (this.wanted) { try { this.spawn(); } catch (e) { this.onExit(null, null, e); } }
    }, delay);
    this.restartTimer.unref();
  }

  start() {
    this.wanted = true;
    if (this.child || this.restartTimer) return;
    this.backoffIdx = 0;
    this.lastError = null;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; this.restartAt = null; }
    const child = this.child;
    if (!child) { this.state = 'stopped'; return Promise.resolve(); }
    this.state = 'stopping';
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      try { child.send({ t: 'stop' }); } catch { /* already gone */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUTS.stop);
      t.unref();
    });
  }

  call(method, payload, timeoutMs = TIMEOUTS.request) {
    if (this.state !== 'running' || !this.child) return Promise.reject(Object.assign(new Error('plugin is not running'), { code: 'ERR_NOT_RUNNING' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('plugin did not answer in time'), { code: 'ERR_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.send({ t: 'call', id, method, payload }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  info() {
    return { state: this.state, pid: this.child ? this.child.pid : null, crashes: this.crashes, lastError: this.lastError,
      restartAt: this.restartAt ? new Date(this.restartAt).toISOString() : null, startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null };
  }
}

/** Make sure `plugin` runs (same version); a running older version is replaced. */
async function ensureRunning(plugin) {
  let p = procs.get(plugin.id);
  if (p && p.plugin.version !== plugin.version) { await p.stop(); procs.delete(plugin.id); p = null; }
  if (!p) { p = new PluginProcess(plugin); procs.set(plugin.id, p); }
  p.plugin = plugin;
  p.start();
  return p;
}

async function ensureStopped(id) {
  const p = procs.get(id);
  if (!p) return;
  await p.stop();
  procs.delete(id);
}

async function stopAll() {
  await Promise.all([...procs.keys()].map(ensureStopped));
}

function get(id) { return procs.get(id) || null; }

function info(id) {
  const p = procs.get(id);
  return p ? p.info() : { state: 'stopped', pid: null, crashes: 0, lastError: null, restartAt: null, startedAt: null };
}

/** Wait until a plugin process is running (or failed). */
function waitRunning(id, timeoutMs = TIMEOUTS.start) {
  const p = procs.get(id);
  if (p && p.state === 'running') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); events.off('state', on); resolve(v); };
    const on = (pid, st) => { if (pid === id && (st === 'running' || st === 'crashed' || st === 'stopped')) done(st === 'running'); };
    const t = setTimeout(() => done(false), timeoutMs);
    events.on('state', on);
  });
}

function call(id, method, payload, timeoutMs) {
  const p = procs.get(id);
  if (!p) return Promise.reject(Object.assign(new Error('plugin is not running'), { code: 'ERR_NOT_RUNNING' }));
  return p.call(method, payload, timeoutMs);
}

function _setBackoffForTest(list) {
  if (process.env.NODE_ENV === 'test') backoff = Array.isArray(list) && list.length ? list : RESTART_BACKOFF_MS;
}

module.exports = { ensureRunning, ensureStopped, stopAll, get, info, call, waitRunning, execArgvFor, events, BOOTSTRAP, _setBackoffForTest };
