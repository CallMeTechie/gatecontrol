'use strict';

// Logs when the main thread did not get to its timers for a while: every
// timer of the host — plugin storage, plugin calls, polls — fires late then,
// and a log line with the time says which errors of that moment came from a
// blocked host rather than from what they name (synchronous file I/O under
// heavy load, a large backup, …). Costs one timer per second.

const { performance } = require('node:perf_hooks');
const logger = require('./logger');

const EVERY_MS = 1000;
const WARN_MS = 2000;

let timer = null;

/** Start watching (idempotent). `onStall(ms)` for tests. */
function start({ everyMs = EVERY_MS, warnMs = WARN_MS, onStall = null } = {}) {
  if (timer) return;
  let last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const late = Math.round(now - last - everyMs);
    last = now;
    if (late < warnMs) return;
    logger.warn({ blockedMs: late }, 'event loop was blocked');
    if (onStall) onStall(late);
  }, everyMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, EVERY_MS, WARN_MS };
