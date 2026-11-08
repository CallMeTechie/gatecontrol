'use strict';

// Long work in slices: a job that walks thousands of rows or files gives the
// event loop back every SLICE_MS (setImmediate — timers, I/O and requests run
// in between), so the heartbeats of the gateways and the web UI never wait
// longer than one slice for it (like the gateway's cache eviction, GW #55).
//
//   const s = slicer();
//   for (const x of list) { work(x); await s.pause(); }
//
// pause() costs one clock read while the slice has time left.

const { performance } = require('node:perf_hooks');

const SLICE_MS = 10;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

/** → { pause(): Promise<boolean> (true when it yielded), due(): boolean, yields: number } */
function slicer(budgetMs = SLICE_MS) {
  let start = performance.now();
  const s = {
    yields: 0,
    due() { return performance.now() - start >= budgetMs; },
    async pause() {
      if (performance.now() - start < budgetMs) return false;
      await yieldLoop();
      s.yields++;
      start = performance.now();
      return true;
    },
    /** Yield now, whatever the slice has left. */
    async yieldNow() {
      await yieldLoop();
      s.yields++;
      start = performance.now();
    },
  };
  return s;
}

/** fn(item, index) for every item of `list` (awaited), yielding every `budgetMs`. */
async function forEachSliced(list, fn, { budgetMs = SLICE_MS } = {}) {
  const s = slicer(budgetMs);
  for (let i = 0; i < list.length; i++) {
    await fn(list[i], i);
    await s.pause();
  }
  return s.yields;
}

/**
 * The rows of a table in rowid ranges of `step` (sync `fetch(lo, hi)` → rows
 * with rowid in (lo, hi]), yielding between the ranges. `maxRowid` bounds the
 * walk (rows added meanwhile come the next run). onRows(rows) may return true
 * to stop early.
 */
async function walkRowids(maxRowid, step, fetch, onRows, { budgetMs = SLICE_MS } = {}) {
  const s = slicer(budgetMs);
  for (let lo = 0; lo < maxRowid; lo += step) {
    const rows = fetch(lo, Math.min(lo + step, maxRowid));
    if (rows.length && (await onRows(rows)) === true) return;
    await s.pause();
  }
}

module.exports = { SLICE_MS, slicer, forEachSliced, walkRowids, yieldLoop };
