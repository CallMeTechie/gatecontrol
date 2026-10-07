'use strict';

// Plugin platform constants (docs/plugins.md): limits, file layout, trusted keys.

const path = require('node:path');

// ─── Trusted publisher keys ─────────────────────────────────────────────────
// Ed25519 public keys (base64 of the raw 32 bytes) whose signature makes a
// plugin "Verifiziert" and first-party (licensed through the GateControl
// licence server's plugin entitlements).
//
// >>> EMPTY ON PURPOSE. The CallMeTechie key is added here in Stage 2, once
// >>> the gatecontrol-plugins repository's CI signing key exists. Until then
// >>> trusted keys come only from the environment (GC_PLUGIN_PUBKEYS, a JSON
// >>> array of base64 raw keys) — that is also how the tests sign.
const BUILTIN_PUBLIC_KEYS = Object.freeze([]);

const LIMITS = Object.freeze({
  packageBytes: 20 * 1024 * 1024,      // uploaded .gcplugin (compressed)
  unpackedBytes: 50 * 1024 * 1024,     // all files together after gunzip
  fileCount: 1000,
  pathLength: 200,
  pathDepth: 12,
  manifestBytes: 256 * 1024,           // plugin.json
  migrationBytes: 512 * 1024,          // one migration file
  responseBytes: 1024 * 1024,          // a plugin's JSON/HTML answer
  fetchResponseBytes: 5 * 1024 * 1024, // http.fetch body handed to a plugin
  fetchRequestBytes: 1024 * 1024,
  memoryMb: 128,                       // --max-old-space-size of a plugin process
  stagingTtlMs: 30 * 60 * 1000,        // inspected upload waiting for "Installieren"
  stagingMax: 4,
  logEntriesPerPlugin: 500,
  dbMaxBytes: 256 * 1024 * 1024,       // per-plugin SQLite file
});

// Server-side timeouts (ms).
const TIMEOUTS = Object.freeze({
  start: 15000,     // child loaded its entry and answered "ready"
  request: 30000,   // one forwarded HTTP request / render
  tick: 120000,     // one background tick
  stop: 3000,       // grace before SIGKILL
  hostCall: 30000,  // http.fetch etc. performed for a plugin
  db: 5000,         // one storage statement (worker is terminated after this)
});

// Restart delays after a crash; the last one repeats.
const RESTART_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 15000, 30000, 60000, 300000]);
// A process that ran this long without crashing resets the backoff.
const STABLE_AFTER_MS = 10 * 60 * 1000;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dataRoot() {
  return process.env.GC_DATA_DIR || process.env.GC_DATA_PATH || '/data';
}

/** <data>/plugins — installed code, one folder per plugin and version. */
function pluginsRoot() { return path.join(dataRoot(), 'plugins'); }
/** <data>/plugin-data — a plugin's data, kept when it is uninstalled with "Daten behalten". */
function pluginDataRoot() { return path.join(dataRoot(), 'plugin-data'); }

function assertId(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64 || !ID_RE.test(id)) throw new Error('invalid plugin id');
  return id;
}

/** Code of one version: <data>/plugins/<id>/<version>/ */
function codeDir(id, version) { return path.join(pluginsRoot(), assertId(id), version); }
/** Everything of one plugin's data: <data>/plugin-data/<id>/ */
function dataDir(id) { return path.join(pluginDataRoot(), assertId(id)); }
/** The host-owned storage (SQLite) — never writable by the plugin process. */
function dbDir(id) { return path.join(dataDir(id), 'db'); }
/** Files the plugin process may write itself (--allow-fs-write). */
function filesDir(id) { return path.join(dataDir(id), 'files'); }

module.exports = {
  BUILTIN_PUBLIC_KEYS, LIMITS, TIMEOUTS, RESTART_BACKOFF_MS, STABLE_AFTER_MS, ID_RE,
  dataRoot, pluginsRoot, pluginDataRoot, codeDir, dataDir, dbDir, filesDir, assertId,
};
