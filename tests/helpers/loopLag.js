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
// auch ist. Die Wanduhr bleibt als grobe Wache (Pausen von Sekunden).
//
// Thread-CPU: process.threadCpuUsage (Node ≥ 23.9); davor unter Linux
// /proc/thread-self/stat (Ticks zu 10 ms — genau genug für Grenzen ab 50 ms),
// sonst die CPU-Zeit des ganzen Prozesses (zählt Worker-Threads mit).

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

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
 * While `fn` runs, a timer every `everyMs` looks at the gap since its last run:
 * → { worst: longest pause (wall clock, ms), cpu: most CPU time this thread
 *     spent in one gap (ms) — what our code held the loop for —, result }.
 */
async function maxLag(fn, { everyMs = 5 } = {}) {
  let worst = 0;
  let cpu = 0;
  let last = performance.now();
  let lastCpu = threadCpuMs();
  const look = () => {
    const t = performance.now();
    const c = threadCpuMs();
    worst = Math.max(worst, t - last - everyMs);
    cpu = Math.max(cpu, c - lastCpu);
    last = t;
    lastCpu = c;
  };
  const iv = setInterval(look, everyMs);
  let result;
  try { result = await fn(); } finally {
    look();
    clearInterval(iv);
  }
  return { worst: Math.round(Math.max(0, worst)), cpu: Math.round(cpu), result };
}

/**
 * No gap with `limitMs` or more of our own CPU time; no pause of a second or more (or 5 × limitMs) at all.
 * `t` (the test context): the numbers as a diagnostic line.
 */
function assertLoopFree(r, what, limitMs, t = null) {
  if (t) t.diagnostic(`${what}: most CPU without a break ${r.cpu} ms, longest pause ${r.worst} ms`);
  assert.ok(r.cpu < limitMs, `${what}: ${r.cpu} ms of CPU without a break (longest pause ${r.worst} ms)`);
  const wall = Math.max(1000, 5 * limitMs);
  assert.ok(r.worst < wall, `${what}: a pause of ${r.worst} ms (${r.cpu} ms of CPU)`);
}

module.exports = { threadCpuMs, maxLag, assertLoopFree };
