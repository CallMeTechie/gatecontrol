'use strict';

// Background jobs of phase 3a (network watch, internet quality):
//   every minute  notices about new devices that are still due (after a restart)
//   every hour    retention of the internet quality values (inetq.retention:
//                 compaction to hourly values after 30 days, deletion after a
//                 year — in steps, yielding to the event loop between them)

const logger = require('../utils/logger');
const { withTask } = require('../utils/loopStall');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let timers = [];
let running = false;

async function retentionOnce() {
  if (running) return null;
  running = true;
  try {
    return await withTask('inetq.retention', () => require('./inetq').retention());
  } catch (err) {
    logger.warn({ err: err.message }, 'internet quality retention failed');
    return null;
  } finally { running = false; }
}

function start() {
  stop();
  const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); if (t.unref) t.unref(); timers.push(t); };
  every(MINUTE, () => withTask('netwatch.notices', () => require('./netwatch').flushPending()));
  every(HOUR, retentionOnce);
  // first run a few minutes after the start (not in the busy start phase)
  const first = setTimeout(() => { retentionOnce(); }, 5 * MINUTE);
  if (first.unref) first.unref();
  timers.push(first);
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
  try { require('./netwatch').stopTimers(); } catch { /* not loaded */ }
}

module.exports = { start, stop, retentionOnce };
