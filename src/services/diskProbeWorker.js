'use strict';

// Worker thread of services/diskHealth.js: how long the data disk takes to
// put one small write on the disk — 4 KB into workerData.file, then
// fdatasync. That is what every write of a database pays at a sync (a commit
// in the rollback journal, a WAL checkpoint). Off the main thread: on a slow
// disk the sync takes seconds, and nothing waits for this one.

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { parentPort, workerData } = require('node:worker_threads');

const BYTES = 4096;
const buf = Buffer.alloc(BYTES, 0x2e);
let fd = null;
let stopped = false;

function probe() {
  if (stopped) return;
  try {
    if (fd === null) fd = fs.openSync(workerData.file, 'w', 0o600);
    buf.writeDoubleLE(Date.now(), 0); // a changed block each time: the disk really writes it
    const t0 = performance.now();
    fs.writeSync(fd, buf, 0, BYTES, 0);
    fs.fdatasyncSync(fd);
    parentPort.postMessage({ t: 'sample', ms: performance.now() - t0 });
  } catch (e) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* gone */ }
    fd = null;
    parentPort.postMessage({ t: 'error', error: String((e && e.message) || e).slice(0, 200) });
  }
}

setTimeout(() => {
  probe();
  setInterval(probe, workerData.everyMs);
}, workerData.firstMs);

parentPort.on('message', (m) => {
  if (m && m.t === 'stop') {
    stopped = true;
    try { if (fd !== null) fs.closeSync(fd); } catch { /* gone */ }
    try { fs.unlinkSync(workerData.file); } catch { /* gone */ }
    process.exit(0);
  }
});
