'use strict';

// Clean-up of the notification center — hourly from server.js, plus a short
// ticker for held messages (delay_s) and due fallback mails:
//   * undelivered copies (queued/sent) expire after retention_h (72 h) — the
//     notification's own expires_at, which never exceeds retention_h;
//   * the history (notifications + deliveries) is purged after history_days;
//   * each device keeps at most max_queue queued copies; the oldest `info`
//     messages go first, then the oldest of the rest;
//   * queues of deleted tokens expire, their device rows are removed;
//   * fallback mails that are due are sent (hub.sweepEmail).

const { getDb } = require('../../db/connection');
const store = require('./store');
const config = require('./config');
const logger = require('../../utils/logger');

const HOUR_MS = 60 * 60 * 1000;
const TICK_MS = 15 * 1000;
let timers = [];

/** → { expired, purged, capped, orphans } */
function run() {
  const db = getDb();
  const cfg = config.get();
  const nowIso = store.iso();
  const out = { expired: 0, purged: 0, capped: 0, orphans: 0 };

  out.expired = db.prepare(`UPDATE notification_deliveries SET state = 'expired'
     WHERE state IN ('queued', 'sent') AND notification_id IN (
       SELECT id FROM notifications WHERE expires_at IS NOT NULL AND expires_at <= ?)`).run(nowIso).changes;
  // a queued copy older than retention_h expires even if its notification lives longer (resend)
  out.expired += db.prepare(`UPDATE notification_deliveries SET state = 'expired'
     WHERE state IN ('queued', 'sent') AND queued_at <= ?`).run(store.iso(store.now() - cfg.retention_h * HOUR_MS)).changes;

  out.purged = db.prepare('DELETE FROM notifications WHERE created_at <= ? AND release_at IS NULL')
    .run(store.iso(store.now() - cfg.history_days * 24 * HOUR_MS)).changes;

  const over = db.prepare(`SELECT token_id, COUNT(*) AS n FROM notification_deliveries WHERE state = 'queued'
     GROUP BY token_id HAVING n > ?`).all(cfg.max_queue);
  for (const o of over) {
    const victims = db.prepare(`SELECT d.seq FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.token_id = ? AND d.state = 'queued'
       ORDER BY CASE n.priority WHEN 'info' THEN 0 ELSE 1 END, d.seq LIMIT ?`).all(o.token_id, o.n - cfg.max_queue);
    const upd = db.prepare("UPDATE notification_deliveries SET state = 'expired' WHERE seq = ?");
    db.transaction(() => { for (const v of victims) upd.run(v.seq); })();
    out.capped += victims.length;
  }

  out.orphans = db.prepare(`UPDATE notification_deliveries SET state = 'expired'
     WHERE state IN ('queued', 'sent') AND token_id NOT IN (SELECT id FROM api_tokens)`).run().changes;
  db.prepare('DELETE FROM notify_device_prefs WHERE token_id NOT IN (SELECT id FROM api_tokens)').run();
  return out;
}

function hourly() {
  try {
    const r = run();
    if (r.expired || r.purged || r.capped || r.orphans) logger.info(r, 'notification center clean-up');
  } catch (err) {
    logger.warn({ err: err.message }, 'notification center clean-up failed');
  }
}

function start() {
  stop();
  const hub = require('./hub');
  const t1 = setInterval(hourly, HOUR_MS);
  const t2 = setInterval(() => { hub.tick(); }, TICK_MS);
  const t3 = setTimeout(() => { hourly(); hub.tick(); }, 30 * 1000);
  for (const t of [t1, t2, t3]) if (t.unref) t.unref();
  timers = [t1, t2, t3];
}

function stop() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers = [];
  try { require('./stream').closeAll(() => true, 'shutdown'); } catch { /* ignore */ }
}

module.exports = { run, start, stop, TICK_MS };
