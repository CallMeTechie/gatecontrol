'use strict';

// Background jobs of phase 3a (network watch, internet quality):
//   every minute  notices about new devices that are still due (after a restart)
//   at the start and every 5 minutes
//                 gateways of one home network (failover pool, same LAN and
//                 router — homeNetwork.gatewayHomes()): rows of one MAC get the
//                 same decisions (netwatch.reconcileHomes), the DNS filter the
//                 same settings (homeDns.reconcileHomes) — e.g. after a pool
//                 was created or a gateway reported its LAN for the first time
//   every hour    retention of the internet quality values (inetq.retention:
//                 compaction to hourly values after 30 days, deletion after a
//                 year — in steps, yielding to the event loop between them)
// phase 3b (DNS filter, home cache):
//   every minute  "DNS-Filter ausgefallen" (gateway offline > 5 min, port 53
//                 busy) and its end; ended pauses of "Internet zu Hause"
//   every hour    retention of the DNS and cache day values, offers of
//                 plugins whose file is gone, the app updates of the home
//                 caches (homeCache.refreshUpdates: downloads new installers)
// phase 3c (Drucken & Scannen):
//   every minute  print jobs past 24 h expire, stale scans fail (homePrint.housekeeping)
//   every hour    job files without an open job go (homePrint.sweepFiles)
// phase 3c, step 2 (Funk):
//   every hour    Bluetooth sensors nobody took over and nobody heard for a day go (homeRadio.housekeeping)

const logger = require('../utils/logger');
const { withTask } = require('../utils/loopStall');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// first runs of the hourly jobs: after the busy start phase, not at the same moment
const START_DELAY_MS = 5 * MINUTE;
const HOME_OFFSET_MS = 7 * MINUTE;

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

let homeRunning = false;

async function homeHourly() {
  if (homeRunning) return;
  homeRunning = true;
  try {
    try {
      await withTask('home.retention', async () => { await require('./homeDns').retention(); require('./homeCache').retention(); });
    } catch (err) { logger.warn({ err: err.message }, 'DNS / cache retention failed'); }
    // offers whose file is gone (in slices — a Drive offers tens of thousands)
    try { await withTask('home.staleOffers', () => require('./homeCache').dropStaleOffers()); } catch (err) { logger.warn({ err: err.message }, 'home cache offers not cleaned up'); }
    // previews in the stock as they are now (a device sent another one)
    try { await withTask('home.previews', () => require('./homeCache').refreshPreviewOffers()); } catch (err) { logger.warn({ err: err.message }, 'home cache previews not refreshed'); }
    try { await withTask('home.updates', () => require('./homeCache').refreshUpdates()); } catch (err) { logger.warn({ err: err.message }, 'home cache updates not refreshed'); }
  } finally { homeRunning = false; }
}

/** Gateways of one home network: the same device decisions and DNS settings everywhere. */
function reconcileHomes() {
  try { require('./netwatch').reconcileHomes(); } catch (err) { logger.warn({ err: err.message }, 'network devices of the home networks not merged'); }
  try { require('./homeDns').reconcileHomes(); } catch (err) { logger.warn({ err: err.message }, 'DNS settings of the home networks not compared'); }
}

function start() {
  stop();
  const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); if (t.unref) t.unref(); timers.push(t); };
  // before the first notice run: a MAC already known on the other gateway of the home network is no "new device"
  reconcileHomes();
  every(5 * MINUTE, () => withTask('home.reconcile', reconcileHomes));
  every(MINUTE, () => withTask('netwatch.notices', () => require('./netwatch').flushPending()));
  every(MINUTE, () => withTask('dns.down', () => { require('./homeDns').checkDown(); require('./homeInternet').cleanup(); }));
  every(MINUTE, () => withTask('print.housekeeping', () => require('./homePrint').housekeeping()));
  every(HOUR, () => withTask('print.files', () => require('./homePrint').sweepFiles()));
  every(HOUR, () => withTask('radio.sensors', () => require('./homeRadio').housekeeping()));
  every(HOUR, () => withTask('cameras.events', () => require('./homeCameras').housekeeping()));
  // the hourly jobs apart from each other (one hour, shifted): a stall names one of them, not both
  const later = (ms, fn) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); timers.push(t); };
  later(START_DELAY_MS, () => { retentionOnce(); every(HOUR, retentionOnce); });
  later(START_DELAY_MS + HOME_OFFSET_MS, () => { homeHourly(); every(HOUR, homeHourly); });
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
  try { require('./netwatch').stopTimers(); } catch { /* not loaded */ }
}

module.exports = { start, stop, retentionOnce, homeHourly, reconcileHomes };
