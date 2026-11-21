'use strict';

// Wie lange hält eigener Code die Ereignisschleife an? — für die Tests
// „Ereignisschleife < 200 ms“ (event_loop_blocks, background_io_blocks,
// plugins_db_slow).
//
// Die Wanduhr allein taugt dafür nicht: ein ausgelasteter CI-Runner nimmt dem
// Prozess den Kern weg, und eine Lücke zwischen zwei Takten wird länger, ohne
// dass unser Code mehr gerechnet hätte (CI, 8. 11.: 219 ms im WAF-Test;
// 9. 11.: 245 ms im Kopier-Arbeiter, beide grün im zweiten Lauf). Gemessen
// wird deshalb wie seit #450 im WAF-Test die CPU-Zeit dieses Threads: je
// Lücke zwischen zwei 5-ms-Takten, was der Haupt-Thread in ihr gerechnet hat
// — ein synchrones Stück von 300 ms CPU bleibt 300 ms, wie voll der Runner
// auch ist. Die Wanduhr bleibt als grobe Wache (Pausen von Sekunden, auch
// ohne CPU – synchrones I/O), abzüglich dessen, was der Runner dem ganzen
// Prozess nahm: das misst ein Referenz-Thread (unten, startReference).
//
// Thread-CPU: process.threadCpuUsage (Node ≥ 23.9); davor unter Linux
// /proc/thread-self/stat (Ticks zu 10 ms — genau genug für Grenzen ab 50 ms),
// sonst die CPU-Zeit des ganzen Prozesses (zählt Worker-Threads mit).

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const USER_HZ = 100; // the unit of utime/stime in /proc (USER_HZ, 100 on Linux)
let procStat = process.platform === 'linux';

/** CPU time (ms) of the calling thread so far. */
function threadCpuMs() {
  if (typeof process.threadCpuUsage === 'function') {
    const u = process.threadCpuUsage();
    return (u.user + u.system) / 1000;
  }
  if (procStat) {
    try {
      const s = fs.readFileSync('/proc/thread-self/stat', 'utf8');
      // after "pid (comm) ": state is field 3, utime field 14, stime field 15
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]);
      if (Number.isFinite(ticks)) return ticks * 1000 / USER_HZ;
    } catch { /* no procfs here */ }
    procStat = false;
  }
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/**
 * The reference for the wall clock: a worker thread with its own 5-ms timer
 * notes every gap of its own (start/end, absolute ms) in shared memory. Our
 * main thread blocking — CPU or synchronous I/O — never stops it; a runner
 * that pauses the whole process (CI, 20. 11., Node 24: a pause of 1210 ms
 * with 43 ms of CPU in it) stops it just as long. What of a main-thread gap
 * the reference also saw, or (Linux, /proc/thread-self/schedstat) the main
 * thread spent waiting for a core, is the runner's, not ours.
 */
const REF_SLOTS = 512;
const REF_GAP_MS = 15;
const REF_CODE = `
const { workerData, parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const f = new Float64Array(workerData.sab);
const now = () => performance.timeOrigin + performance.now();
let last = now();
f[0] = last;
const tick = () => {
  const t = now();
  if (t - last > ${REF_GAP_MS}) {
    const i = f[1] % ${REF_SLOTS};
    f[2 + 2 * i] = last;
    f[3 + 2 * i] = t;
    f[1] += 1;
  }
  last = t;
  f[0] = t;
};
setInterval(tick, 5);
setTimeout(() => { tick(); parentPort.postMessage('ready'); }, 10);
`;

async function startReference() {
  const sab = new SharedArrayBuffer(8 * (2 + 2 * REF_SLOTS));
  const f = new Float64Array(sab);
  let worker;
  try {
    worker = new Worker(REF_CODE, { eval: true, workerData: { sab } });
    await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  } catch {
    if (worker) worker.terminate();
    return null;
  }
  /** ms of [a, b] (absolute) in which the reference did not run either */
  const stalled = (a, b) => {
    let ms = 0;
    const n = Math.min(f[1], REF_SLOTS);
    for (let i = 0; i < n; i++) ms += Math.max(0, Math.min(b, f[3 + 2 * i]) - Math.max(a, f[2 + 2 * i]));
    // a gap the reference has not closed yet (the process just woke up; its timer comes after ours)
    if (b - f[0] > REF_GAP_MS) ms += Math.max(0, b - Math.max(a, f[0]));
    return Math.min(ms, b - a);
  };
  return { stalled, stop: () => worker.terminate() };
}

let schedstat = process.platform === 'linux';
/** ns this thread has waited for a core so far (Linux schedstat), or null */
function runQueueWaitMs() {
  if (!schedstat) return null;
  try {
    const v = Number(fs.readFileSync('/proc/thread-self/schedstat', 'utf8').split(' ')[1]);
    if (Number.isFinite(v)) return v / 1e6;
  } catch { /* no schedstat */ }
  schedstat = false;
  return null;
}

/**
 * While `fn` runs, a timer every `everyMs` looks at the gap since its last run:
 * → { worst: longest pause (wall clock, ms), own: longest pause less what the
 *     runner took from the whole process or kept this thread waiting for a
 *     core (ms), cpu: most CPU time this thread spent in one gap (ms) — what
 *     our code held the loop for —, result }.
 */
async function maxLag(fn, { everyMs = 5 } = {}) {
  const ref = await startReference();
  let worst = 0;
  let own = 0;
  let cpu = 0;
  let last = performance.now();
  let lastCpu = threadCpuMs();
  let lastWait = runQueueWaitMs();
  const look = () => {
    const t = performance.now();
    const c = threadCpuMs();
    const w = runQueueWaitMs();
    const gap = t - last - everyMs;
    if (gap > 0) {
      const runner = Math.max(
        ref ? ref.stalled(performance.timeOrigin + last, performance.timeOrigin + t) : 0,
        w !== null && lastWait !== null ? w - lastWait : 0,
      );
      worst = Math.max(worst, gap);
      own = Math.max(own, gap - runner);
    }
    cpu = Math.max(cpu, c - lastCpu);
    last = t;
    lastCpu = c;
    lastWait = w;
  };
  const iv = setInterval(look, everyMs);
  let result;
  try { result = await fn(); } finally {
    look();
    clearInterval(iv);
    if (ref) await ref.stop();
  }
  return { worst: Math.round(Math.max(0, worst)), own: Math.round(Math.max(0, own)), cpu: Math.round(cpu), result };
}

/**
 * No gap with `limitMs` or more of our own CPU time; no pause of our own (wall clock less what the runner took)
 * of a second or more (or 5 × limitMs) at all — synchronous I/O holds the loop without CPU.
 * `t` (the test context): the numbers as a diagnostic line.
 */
function assertLoopFree(r, what, limitMs, t = null) {
  if (t) t.diagnostic(`${what}: most CPU without a break ${r.cpu} ms, longest pause ${r.worst} ms (${r.own} ms of it ours)`);
  assert.ok(r.cpu < limitMs, `${what}: ${r.cpu} ms of CPU without a break (longest pause ${r.worst} ms)`);
  const wall = Math.max(1000, 5 * limitMs);
  assert.ok(r.own < wall, `${what}: a pause of ${r.own} ms of our own (${r.worst} ms on the wall clock, ${r.cpu} ms of CPU)`);
}

module.exports = { threadCpuMs, maxLag, assertLoopFree };
