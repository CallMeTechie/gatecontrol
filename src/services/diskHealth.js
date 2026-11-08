'use strict';

// How fast the data disk of GateControl writes (Logs & Monitoring, a hint —
// never a ban). Every write of a database ends with the disk confirming it
// (a sync); on an SSD that takes 1–5 ms, on a hard disk 10–30 ms. Seen on a
// NAS volume: 75 ms and more, seconds at times — every plugin write took
// 200–300 ms then (protocol of 8. 11., before plugin databases moved to WAL).
//
//   start({ dir, everyMs, firstMs })  probe in a worker thread (diskProbeWorker.js):
//                                     4 KB + fdatasync into <dir>/.disk-probe every PROBE_EVERY_MS
//   status()  → { ms, lastMs, samples, slow, since } | null (no sample yet)
//   hint()    → { ms } while the disk is slow, else null
//   lastMs()  → the latest probe (ms) or null — the slow-statement and the stall log lines carry it
//
// "Slow" is a persistent state, not one bad moment: the average of the last
// WINDOW probes without the highest and lowest fifth (trimmed mean) at
// SLOW_MS or more, with MIN_SAMPLES probes at least (16 minutes after a
// start). It ends below FAST_MS (no flapping around the line). The change
// is logged once each way.
//
// Off under NODE_ENV=test (tests call start() with a short interval) and with
// GC_DISK_PROBE=off.

const path = require('node:path');
const logger = require('../utils/logger');

const PROBE_EVERY_MS = 2 * 60 * 1000;
const FIRST_MS = 60 * 1000;
const WINDOW = 15;
const MIN_SAMPLES = 8;
const SLOW_MS = 50;
const FAST_MS = 30;
const PROBE_FILE = '.disk-probe';

let worker = null;
let samples = [];
let slow = false;
let since = null;
let last = null;

function trimmedMean(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.2);
  const kept = s.slice(cut, s.length - cut);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** One probe result (ms) — from the worker, or a test. */
function addSample(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms < 0) return;
  last = ms;
  samples.push(ms);
  if (samples.length > WINDOW) samples.splice(0, samples.length - WINDOW);
  if (samples.length < MIN_SAMPLES) return;
  const avg = trimmedMean(samples);
  if (!slow && avg >= SLOW_MS) {
    slow = true;
    since = now;
    logger.warn({ syncMs: Math.round(avg), samples: samples.length }, 'data disk is slow to write — see Logs & Monitoring');
  } else if (slow && avg < FAST_MS) {
    slow = false;
    since = null;
    logger.info({ syncMs: Math.round(avg), samples: samples.length }, 'data disk writes fast again');
  }
}

function status() {
  if (!samples.length) return null;
  return { ms: Math.round(trimmedMean(samples)), lastMs: Math.round(last), samples: samples.length, slow, since: since ? new Date(since).toISOString() : null };
}

function hint() {
  return slow ? { ms: Math.round(trimmedMean(samples)) } : null;
}

function lastMs() { return last == null ? null : Math.round(last); }

function enabled() {
  if (String(process.env.GC_DISK_PROBE || '').toLowerCase() === 'off') return false;
  return process.env.NODE_ENV !== 'test';
}

/** Start the probe (idempotent). `dir`: the folder of the host database (the data disk). */
function start({ dir, everyMs = PROBE_EVERY_MS, firstMs = FIRST_MS, force = false } = {}) {
  if (worker || !dir || dir === ':memory:') return false;
  if (!force && !enabled()) return false;
  let w;
  try {
    const { Worker } = require('node:worker_threads');
    w = new Worker(path.join(__dirname, 'diskProbeWorker.js'), {
      workerData: { file: path.join(dir, PROBE_FILE), everyMs, firstMs },
      resourceLimits: { maxOldGenerationSizeMb: 16 },
      env: {},
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'disk write probe not started');
    return false;
  }
  let errors = 0;
  w.on('message', (m) => {
    if (!m) return;
    if (m.t === 'sample') addSample(m.ms);
    else if (m.t === 'error' && errors++ === 0) logger.warn({ err: m.error }, 'disk write probe failed');
  });
  w.on('error', (err) => { if (worker === w) worker = null; logger.warn({ err: err && err.message }, 'disk write probe ended'); });
  w.on('exit', () => { if (worker === w) worker = null; });
  w.unref();
  worker = w;
  return true;
}

async function stop() {
  const w = worker;
  worker = null;
  if (!w) return;
  const exited = new Promise((resolve) => { w.once('exit', resolve); });
  try { w.postMessage({ t: 'stop' }); } catch { /* gone */ }
  let timer;
  await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
  clearTimeout(timer);
  await w.terminate().catch(() => {});
}

function _resetForTest() {
  samples = [];
  slow = false;
  since = null;
  last = null;
}

module.exports = {
  start, stop, status, hint, lastMs, addSample, trimmedMean, _resetForTest,
  PROBE_EVERY_MS, WINDOW, MIN_SAMPLES, SLOW_MS, FAST_MS, PROBE_FILE,
};
