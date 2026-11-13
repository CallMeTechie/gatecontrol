'use strict';

// One checkpoint at a time over all databases of GateControl (the host
// database: db/checkpointWorker.js; the plugin databases:
// services/plugins/checkpointWorker.js).
//
// A checkpoint ends with syncs of the disk. On a disk that confirms 26 small
// writes a second (a cloud volume, protocol of 13. 11.: 38 ms per sync, 266 ms
// at times) the syncs of 17 plugin databases and the host database queue up
// when they start in the same moment — and whoever syncs then (the host
// database's main thread writes the header of its log after a checkpoint, the
// write probe) waits behind all of them. With the gate one checkpoint runs,
// the next one follows.
//
// The gate is four bytes of shared memory: 0 free, else the holder's number.
// Nobody waits for it for ever: after `maxMs` a checkpoint runs without it
// (the data must reach the disk), and the main thread frees it when its
// holder ended (clear).

const HOST = 1;
const PLUGINS = 2;

let sab = null;

/** The gate of this process (main thread; handed to the workers as workerData). */
function shared() {
  if (!sab) sab = new SharedArrayBuffer(4);
  return sab;
}

/** In a worker thread: take the gate, waiting up to `maxMs`. → false: not taken (run without it, never release). */
function acquire(buf, owner, maxMs) {
  const a = new Int32Array(buf);
  const end = Date.now() + maxMs;
  while (Atomics.compareExchange(a, 0, 0, owner) !== 0) {
    const left = end - Date.now();
    if (left <= 0) return false;
    Atomics.wait(a, 0, Atomics.load(a, 0), Math.min(left, 250));
  }
  return true;
}

/** Take the gate if it is free, without waiting (a thread that must keep taking messages asks again later). */
function tryAcquire(buf, owner) {
  return Atomics.compareExchange(new Int32Array(buf), 0, 0, owner) === 0;
}

function release(buf, owner) {
  const a = new Int32Array(buf);
  if (Atomics.compareExchange(a, 0, owner, 0) === owner) Atomics.notify(a, 0);
}

/** Main thread: the worker `owner` ended — a gate it still held is free again. */
function clear(owner) {
  if (sab) release(sab, owner);
}

module.exports = { HOST, PLUGINS, shared, acquire, tryAcquire, release, clear };
