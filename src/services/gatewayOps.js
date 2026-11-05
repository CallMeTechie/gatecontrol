'use strict';

// Background jobs of phase 3a (network watch, internet quality):
//   every minute  notices about new devices that are still due (after a restart)
//   every hour    retention of the internet quality values (inetq.retention:
//                 compaction to hourly values after 30 days, deletion after a
//                 year — in steps, yielding to the event loop between them)
// phase 3b (DNS filter, home cache):
//   every minute  "DNS-Filter ausgefallen" (gateway offline > 5 min, port 53
//                 busy) and its end; ended pauses of "Internet zu Hause"
//   every hour    retention of the DNS and cache day values, offers of
//                 plugins whose file is gone, the app updates of the home
//                 caches (homeCache.refreshUpdates: downloads new installers)

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

async function homeHourly() {
  try {
    await withTask('home.retention', () => { require('./homeDns').retention(); require('./homeCache').retention(); require('./homeCache').dropStaleOffers(); });
  } catch (err) { logger.warn({ err: err.message }, 'DNS / cache retention failed'); }
  try { await require('./homeCache').refreshUpdates(); } catch (err) { logger.warn({ err: err.message }, 'home cache updates not refreshed'); }
}

function start() {
  stop();
  const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); if (t.unref) t.unref(); timers.push(t); };
  every(MINUTE, () => withTask('netwatch.notices', () => require('./netwatch').flushPending()));
  every(MINUTE, () => withTask('dns.down', () => { require('./homeDns').checkDown(); require('./homeInternet').cleanup(); }));
  every(HOUR, retentionOnce);
  every(HOUR, homeHourly);
  // first run a few minutes after the start (not in the busy start phase)
  const first = setTimeout(() => { retentionOnce(); homeHourly(); }, 5 * MINUTE);
  if (first.unref) first.unref();
  timers.push(first);
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
  try { require('./netwatch').stopTimers(); } catch { /* not loaded */ }
}

module.exports = { start, stop, retentionOnce, homeHourly };
