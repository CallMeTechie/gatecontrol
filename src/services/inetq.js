'use strict';

// Internet quality behind a home gateway (phase 3a, contract §4) and the
// UPS status (§5).
//
//   ingest(peerId, body)     POST /api/v1/gateway/inetq { samples, outages, speedtests }
//   view(peerId, range)      admin API, tab "Internet": now, speed, UPS, history, outages
//   speedtest(peerId)        "Jetzt messen" → gateway POST /api/inetq/speedtest
//   onHeartbeat(peerId, b)   UPS status from the heartbeat telemetry → notice on battery / back
//   retention()              5-minute values 30 days, then hourly up to 1 year;
//                            outages and speed tests 1 year — in small steps
//                            that give the event loop back in between
//   speedDown / speedUp      the server side of the speed test (streams, limits)
//
// Notices (topic "Netzwerk"): an outage longer than 5 minutes once it is over
// (duration and cause), the UPS on battery and back — each per gateway
// switchable (features.notify).

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const kit = require('../../public/js/gateway-net-kit');
const { normTime } = require('./homePresence');
const logger = require('../utils/logger');

const DAY = 24 * 3600 * 1000;
const RAW_KEEP_MS = 30 * DAY;
const LONG_KEEP_MS = 365 * DAY;
const OUTAGE_NOTICE_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 2000;
const MAX_OUTAGES = 200;
const MAX_SPEEDTESTS = 50;
const STEP_ROWS = 2000;

// speed test (contract §4 + server deviation 5)
const SPEED_MAX_BYTES = 100 * 1000 * 1000;
const SPEED_DEFAULT_BYTES = 25 * 1000 * 1000;
const SPEED_STREAMS_PER_GATEWAY = 8;
const SPEED_STREAMS_TOTAL = 16;
// a test at 300 Mbit/s moves about 750 MB (both directions); 4× a day on a fast line stays inside
const SPEED_BUDGET_BYTES = 12 * 1000 * 1000 * 1000;
const SPEED_STREAM_MAX_MS = 30 * 1000;
// plan 'hourly': each download stream gets at most this much (the gateway measures what arrived in
// its time) — 24 tests a day must not eat the daily budget on a fast line
const SPEED_HOURLY_MAX_BYTES = 25 * 1000 * 1000;
// plan 'hourly': the volume of one test per direction, all streams together (config pull
// `inetq.speedVolume`, gateways with the capability `speed-volume`). The server can cut a download by
// itself, but the upload is the gateway's to send — so the gateway caps both directions. 24 tests of
// 2 × 200 MB are 9.6 GB: inside the daily budget, with room for "Jetzt messen". A line up to about
// 160 Mbit/s is not cut at all (10 s per direction).
const SPEED_HOURLY_TEST_BYTES = 200 * 1000 * 1000;
const SPEED_CHUNK = 64 * 1024;

class InetqError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function num(v, max) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(n, max);
}
function ensureFeaturesRow(peerId) {
  db().prepare("INSERT OR IGNORE INTO gateway_features (peer_id, settings, updated_at) VALUES (?, '{}', ?)").run(peerId, Date.now());
}
function features(peerId) { return require('./gatewayFeatures').get(peerId); }
function peerName(peerId) { const r = db().prepare('SELECT name FROM peers WHERE id = ?').get(peerId); return r ? r.name : '#' + peerId; }

// ─── Reports of the gateway ────────────────────────────────────────────

function list(v, max, what) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new InetqError('invalid', `${what}: up to ${max} entries`);
  return v;
}

/** POST /api/v1/gateway/inetq */
function ingest(peerId, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) throw new InetqError('invalid', 'invalid body');
  const now = Date.now();
  const samples = list(b.samples, MAX_SAMPLES, 'samples').map((s) => {
    const t = s && normTime(s.t, now);
    if (!t) throw new InetqError('invalid', 'samples[].t: time expected');
    return {
      t: t - (t % (5 * 60 * 1000)),
      router: num(s.rttRouterMs, 60000), inet: num(s.rttInetMs, 60000), loss: num(s.lossInetPct, 100), server: num(s.rttServerMs, 60000),
    };
  });
  const outages = list(b.outages, MAX_OUTAGES, 'outages').map((o) => {
    const start = o && normTime(o.start, now);
    if (!start) throw new InetqError('invalid', 'outages[].start: time expected');
    const end = o.end === null || o.end === undefined ? null : normTime(o.end, now);
    return { start, end: end && end >= start ? end : null, cause: kit.causeKey(o.cause) };
  });
  const speedtests = list(b.speedtests, MAX_SPEEDTESTS, 'speedtests').map((x) => {
    const at = x && normTime(x.at, now);
    if (!at) throw new InetqError('invalid', 'speedtests[].at: time expected');
    const bytes = Number.isSafeInteger(x.bytes) && x.bytes >= 0 ? x.bytes : null;
    // the gateway names a failed test (contract, gateway side 6): 'budget' = refused for the daily volume
    if (x.error === 'budget') budgetHit.set(peerId, now);
    return { at, down: num(x.downMbps, 100000), up: num(x.upMbps, 100000), bytes };
  });
  const minT = now - RAW_KEEP_MS;
  const insS = db().prepare(`INSERT INTO inetq_samples (peer_id, t, rtt_router_ms, rtt_inet_ms, loss_inet_pct, rtt_server_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_id, t) DO UPDATE SET rtt_router_ms = excluded.rtt_router_ms, rtt_inet_ms = excluded.rtt_inet_ms,
      loss_inet_pct = excluded.loss_inet_pct, rtt_server_ms = excluded.rtt_server_ms`);
  const insO = db().prepare(`INSERT INTO inetq_outages (peer_id, start_at, end_at, cause) VALUES (?, ?, ?, ?)
    ON CONFLICT(peer_id, start_at) DO UPDATE SET end_at = COALESCE(excluded.end_at, inetq_outages.end_at), cause = excluded.cause`);
  const insT = db().prepare(`INSERT INTO inetq_speedtests (peer_id, at, down_mbps, up_mbps, bytes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(peer_id, at) DO UPDATE SET down_mbps = excluded.down_mbps, up_mbps = excluded.up_mbps, bytes = excluded.bytes`);
  db().transaction(() => {
    for (const s of samples) if (s.t >= minT) insS.run(peerId, s.t, s.router, s.inet, s.loss, s.server);
    for (const o of outages) if (o.start >= now - LONG_KEEP_MS) insO.run(peerId, o.start, o.end, o.cause);
    for (const x of speedtests) if (x.at >= now - LONG_KEEP_MS) insT.run(peerId, x.at, x.down, x.up, x.bytes);
    ensureFeaturesRow(peerId);
    db().prepare('UPDATE gateway_features SET inetq_report_at = ? WHERE peer_id = ?').run(now, peerId);
  })();
  noticeOutages(peerId);
  if (speedtests.length) { speedRequested.delete(peerId); reported.delete(peerId); }
  return { samples: samples.length, outages: outages.length, speedtests: speedtests.length };
}

/** Ended outages longer than 5 minutes that were not notified yet → one notice each. */
function noticeOutages(peerId) {
  const rows = db().prepare('SELECT id, start_at, end_at, cause FROM inetq_outages WHERE peer_id = ? AND notified = 0 AND end_at IS NOT NULL ORDER BY start_at').all(peerId);
  if (!rows.length) return 0;
  const on = features(peerId).notify.outage;
  const mark = db().prepare('UPDATE inetq_outages SET notified = 1 WHERE id = ?');
  const text = require('./notify/text');
  const lang = text.serverLang();
  let n = 0;
  for (const o of rows) {
    mark.run(o.id);
    // old outages (a gateway sending its buffer after days) are not news any more
    if (!on || o.end_at - o.start_at <= OUTAGE_NOTICE_MS || Date.now() - o.end_at > DAY) continue;
    const mins = kit.minutes(o.start_at, o.end_at);
    const gw = peerName(peerId);
    const message = text.t(lang, 'push.inet.outage', { gateway: gw, minutes: mins, cause: text.t(lang, 'push.inet.cause_' + kit.causeKey(o.cause)) });
    try {
      require('./activity').log('inet_outage', message, {
        source: 'system', severity: 'warning',
        details: { peer_id: peerId, peer_name: gw, start: iso(o.start_at), end: iso(o.end_at), minutes: mins, cause: kit.causeKey(o.cause) },
      });
      n++;
    } catch (e) { logger.warn({ err: e.message }, 'outage notice not written'); }
  }
  return n;
}

// ─── UPS (heartbeat telemetry) ─────────────────────────────────────────

function upsOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const u = (b.telemetry && typeof b.telemetry === 'object' && b.telemetry.ups) || b.ups;
  return u && typeof u === 'object' && !Array.isArray(u) ? u : null;
}

/** Heartbeat: a change between mains and battery is a notice (when switched on). */
function onHeartbeat(peerId, body) {
  const u = upsOf(body);
  if (!u || typeof u.status !== 'string') return null;
  const s = features(peerId);
  if (!s.ups.enabled) return null;
  const status = u.status.slice(0, 40);
  ensureFeaturesRow(peerId);
  const prev = db().prepare('SELECT ups_status FROM gateway_features WHERE peer_id = ?').get(peerId);
  const was = prev && prev.ups_status ? kit.onBattery(prev.ups_status) : false;
  const is = kit.onBattery(status);
  if (!prev || prev.ups_status !== status) db().prepare('UPDATE gateway_features SET ups_status = ?, ups_status_at = ? WHERE peer_id = ?').run(status, Date.now(), peerId);
  if (was === is || !prev || (prev.ups_status == null && !is)) return null;
  if (!s.notify.ups) return { changed: true, notified: false };
  const text = require('./notify/text');
  const lang = text.serverLang();
  const gw = peerName(peerId);
  const charge = Number.isFinite(Number(u.charge)) ? Math.round(Number(u.charge)) : null;
  const runtimeMin = Number.isFinite(Number(u.runtimeSec)) ? Math.round(Number(u.runtimeSec) / 60) : null;
  const type = is ? 'ups_on_battery' : 'ups_on_line';
  const message = is
    ? text.t(lang, 'push.ups.on_battery', { gateway: gw }) + (charge != null ? ' ' + text.t(lang, 'push.ups.charge', { charge, minutes: runtimeMin == null ? '?' : runtimeMin }) : '')
    : text.t(lang, 'push.ups.on_line', { gateway: gw });
  try {
    require('./activity').log(type, message, { source: 'system', severity: is ? 'warning' : 'info', details: { peer_id: peerId, peer_name: gw, status, charge, runtime_min: runtimeMin } });
  } catch (e) { logger.warn({ err: e.message }, 'UPS notice not written'); }
  return { changed: true, notified: true };
}

// ─── Admin view ────────────────────────────────────────────────────────

const speedRequested = new Map(); // peerId → epoch ms of "Jetzt messen"

function series(peerId, range, now) {
  const from = now - kit.RANGE_MS[range];
  const bucket = kit.BUCKET_MS[range];
  if (range === '24h') {
    return db().prepare('SELECT t, rtt_inet_ms, loss_inet_pct, rtt_router_ms, rtt_server_ms FROM inetq_samples WHERE peer_id = ? AND t >= ? ORDER BY t')
      .all(peerId, from).map((r) => ({ t: r.t, rtt: r.rtt_inet_ms, loss: r.loss_inet_pct, router: r.rtt_router_ms, server: r.rtt_server_ms }));
  }
  return db().prepare(`SELECT (t / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS b, AVG(rtt_inet_ms) AS rtt, AVG(loss_inet_pct) AS loss, AVG(rtt_router_ms) AS router, AVG(rtt_server_ms) AS server
      FROM inetq_samples WHERE peer_id = ? AND t >= ? GROUP BY b ORDER BY b`).all(bucket, bucket, peerId, from)
    .map((r) => ({ t: r.b, rtt: r.rtt == null ? null : Math.round(r.rtt * 10) / 10, loss: r.loss == null ? null : Math.round(r.loss * 10) / 10,
      router: r.router == null ? null : Math.round(r.router * 10) / 10, server: r.server == null ? null : Math.round(r.server * 10) / 10 }));
}

/** Tab "Internet": now, speed, UPS, history of `range`, outages, settings. */
function view(peerId, range, tel) {
  const r = kit.RANGES.includes(range) ? range : '24h';
  const now = Date.now();
  const last = db().prepare('SELECT t, rtt_inet_ms, loss_inet_pct, rtt_router_ms, rtt_server_ms FROM inetq_samples WHERE peer_id = ? ORDER BY t DESC LIMIT 1').get(peerId);
  const open = db().prepare('SELECT start_at, cause FROM inetq_outages WHERE peer_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1').get(peerId);
  const fresh = last && now - last.t < 20 * 60 * 1000;
  const st = db().prepare('SELECT inetq_report_at, ups_status, ups_status_at FROM gateway_features WHERE peer_id = ?').get(peerId) || {};
  const tests = db().prepare('SELECT at, down_mbps, up_mbps, bytes FROM inetq_speedtests WHERE peer_id = ? ORDER BY at DESC LIMIT 1').get(peerId);
  const u = tel && typeof tel === 'object' && tel.ups && typeof tel.ups === 'object' ? tel.ups : null;
  const outages = db().prepare('SELECT start_at, end_at, cause FROM inetq_outages WHERE peer_id = ? AND (end_at IS NULL OR end_at >= ?) ORDER BY start_at DESC LIMIT 50')
    .all(peerId, now - kit.RANGE_MS['30d']);
  const req = speedRequested.get(peerId);
  return {
    range: r,
    from: iso(now - kit.RANGE_MS[r]),
    to: iso(now),
    now: {
      state: open ? 'outage' : (fresh ? 'ok' : (last ? 'stale' : 'none')),
      at: last ? iso(last.t) : null,
      rttInetMs: fresh ? last.rtt_inet_ms : null,
      lossInetPct: fresh ? last.loss_inet_pct : null,
      rttRouterMs: fresh ? last.rtt_router_ms : null,
      rttServerMs: fresh ? last.rtt_server_ms : null,
      outageSince: open ? iso(open.start_at) : null,
      outageCause: open ? kit.causeKey(open.cause) : null,
    },
    speed: tests ? { at: iso(tests.at), downMbps: tests.down_mbps, upMbps: tests.up_mbps, bytes: tests.bytes } : null,
    speedPending: req && now - req < 5 * 60 * 1000 ? iso(req) : null,
    speedBudget: budgetInfo(peerId, now),
    ups: u ? (u.error ? { error: String(u.error).slice(0, 120) }
      : { status: typeof u.status === 'string' ? u.status.slice(0, 40) : null, state: kit.upsState(u.status), charge: Number.isFinite(Number(u.charge)) ? Number(u.charge) : null,
        runtimeSec: Number.isFinite(Number(u.runtimeSec)) ? Number(u.runtimeSec) : null, model: typeof u.model === 'string' ? u.model.slice(0, 80) : null, at: u.at ? iso(normTime(u.at)) : null })
      : null,
    upsStatusAt: iso(st.ups_status_at),
    lastReportAt: iso(st.inetq_report_at),
    points: series(peerId, r, now),
    outages: outages.map((o) => ({ start: iso(o.start_at), end: iso(o.end_at), cause: kit.causeKey(o.cause), minutes: o.end_at ? kit.minutes(o.start_at, o.end_at) : null })),
  };
}

/** "Jetzt messen": ask the gateway (management API). */
async function speedtest(peerId) {
  const r = await require('./gateways').mgmtCall(peerId, '/api/inetq/speedtest', {});
  if (!r) throw new InetqError('gateway_unreachable', 'gateway not reachable');
  if (r.status === 404) throw new InetqError('gateway_unsupported', 'the gateway does not know this command yet');
  if (r.status === 503) throw new InetqError('unavailable', 'the internet quality is not running on the gateway yet');
  if (r.status === 409) { speedRequested.set(peerId, Date.now()); return { ok: true, busy: true }; }
  if (r.status < 200 || r.status >= 300) throw new InetqError('gateway_error', 'gateway answered ' + r.status);
  speedRequested.set(peerId, Date.now());
  return { ok: true, busy: false };
}

// ─── Retention (in steps, the event loop gets air in between) ──────────

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Run `stmt` (deleting/moving at most STEP_ROWS rows) until it changes nothing. */
async function inSteps(fn) {
  let total = 0;
  for (let i = 0; i < 100000; i++) {
    const n = fn();
    total += n;
    if (n < (module.exports._stepRows || STEP_ROWS)) break;
    await yieldLoop();
  }
  return total;
}

/**
 * 5-minute values older than 30 days → hourly averages (one gateway-hour at a
 * time), then deleted; hourly values, outages and speed tests older than a
 * year deleted. Returns the counts.
 */
async function retention(now = Date.now()) {
  const step = module.exports._stepRows || STEP_ROWS;
  const cutRaw = now - RAW_KEEP_MS;
  const cutLong = now - LONG_KEEP_MS;
  const H = 3600 * 1000;
  let hours = 0;
  // the hours to compact, per gateway (only full hours before the cut)
  const pending = db().prepare('SELECT DISTINCT peer_id, (t / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS h FROM inetq_samples WHERE t < ? ORDER BY peer_id, h LIMIT 100000').all(H, H, cutRaw - (cutRaw % H));
  const agg = db().prepare(`SELECT AVG(rtt_router_ms) AS router, AVG(rtt_inet_ms) AS inet, MAX(rtt_inet_ms) AS inet_max, AVG(loss_inet_pct) AS loss,
      AVG(rtt_server_ms) AS server, COUNT(*) AS n FROM inetq_samples WHERE peer_id = ? AND t >= ? AND t < ?`);
  const put = db().prepare(`INSERT INTO inetq_hourly (peer_id, t, rtt_router_ms, rtt_inet_ms, rtt_inet_max, loss_inet_pct, rtt_server_ms, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_id, t) DO UPDATE SET rtt_router_ms = excluded.rtt_router_ms, rtt_inet_ms = excluded.rtt_inet_ms, rtt_inet_max = excluded.rtt_inet_max,
      loss_inet_pct = excluded.loss_inet_pct, rtt_server_ms = excluded.rtt_server_ms, n = excluded.n`);
  const drop = db().prepare('DELETE FROM inetq_samples WHERE peer_id = ? AND t >= ? AND t < ?');
  const BATCH = 50; // gateway-hours per transaction
  for (let i = 0; i < pending.length; i += BATCH) {
    db().transaction(() => {
      for (const p of pending.slice(i, i + BATCH)) {
        const a = agg.get(p.peer_id, p.h, p.h + H);
        if (a && a.n) put.run(p.peer_id, p.h, a.router, a.inet, a.inet_max, a.loss, a.server, a.n);
        drop.run(p.peer_id, p.h, p.h + H);
        hours++;
      }
    })();
    await yieldLoop();
  }
  // samples before the cut that are not a full hour yet stay until the next run
  const del = (table, col) => inSteps(() => db().prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`).run(cutLong, step).changes);
  const hourly = await del('inetq_hourly', 't');
  const outages = await del('inetq_outages', 'COALESCE(end_at, start_at)');
  const tests = await del('inetq_speedtests', 'at');
  return { compactedHours: hours, hourlyDeleted: hourly, outagesDeleted: outages, speedtestsDeleted: tests };
}

// ─── Speed test endpoints (gateway token) ──────────────────────────────

const streams = { total: 0, byPeer: new Map() };
const budget = new Map(); // peerId → [{ at, bytes }] — what this process streamed (gone with a restart)
const budgetHit = new Map(); // peerId → epoch ms when a stream was refused for the budget
// peerId → { readAt, bytes, oldest }: the volume of the tests the gateway reported in the last 24 h
// (inetq_speedtests.bytes). It survives a restart of the server — without it every restart (every
// update) started a new day. Read at most every few seconds: a test asks once per stream request.
const reported = new Map();
const REPORTED_CACHE_MS = 5000;

function reportedTests(peerId, now) {
  const c = reported.get(peerId);
  if (c && now >= c.readAt && now - c.readAt < REPORTED_CACHE_MS) return c;
  let rows = [];
  try {
    // tests dated into the future (a gateway clock ahead) do not count: they would block for more than a day
    rows = db().prepare('SELECT at, bytes FROM inetq_speedtests WHERE peer_id = ? AND at > ? AND at <= ? AND bytes > 0 ORDER BY at')
      .all(peerId, now - DAY, now + 5 * 60 * 1000);
  } catch (err) {
    logger.debug({ err: err.message, peerId }, 'speed test budget: reported tests unreadable');
  }
  const v = { readAt: now, bytes: rows.reduce((a, r) => a + r.bytes, 0), oldest: rows.length ? rows[0].at : null };
  reported.set(peerId, v);
  return v;
}

/** The volume of the last 24 h: what this process streamed, or — after a restart — what the gateway reported. */
function budgetUsed(peerId, now) {
  const list = (budget.get(peerId) || []).filter((x) => now - x.at < DAY);
  budget.set(peerId, list);
  return Math.max(list.reduce((a, x) => a + x.bytes, 0), reportedTests(peerId, now).bytes);
}

function account(peerId, bytes) {
  if (!bytes) return;
  const list = budget.get(peerId) || [];
  list.push({ at: Date.now(), bytes });
  budget.set(peerId, list);
}

/** The daily volume of the speed test: { usedBytes, limitBytes, exhausted, resetAt } (resetAt: when room frees up). */
function budgetInfo(peerId, now = Date.now()) {
  const used = budgetUsed(peerId, now);
  const list = budget.get(peerId) || [];
  const hit = budgetHit.get(peerId);
  const exhausted = used >= SPEED_BUDGET_BYTES * 0.95 || (hit != null && now - hit < DAY && used > SPEED_BUDGET_BYTES / 2);
  const olds = list.map((x) => x.at);
  const rep = reportedTests(peerId, now);
  if (rep.oldest != null) olds.push(rep.oldest);
  const oldest = olds.length ? Math.min(...olds) : null;
  return { usedBytes: used, limitBytes: SPEED_BUDGET_BYTES, exhausted, resetAt: exhausted && oldest ? iso(oldest + DAY) : null };
}

/** `Retry-After` (seconds) of a stream refused for the budget: until the oldest volume leaves the 24 hours. */
function budgetRetryAfter(peerId, now = Date.now()) {
  const list = (budget.get(peerId) || []).map((x) => x.at);
  const rep = reportedTests(peerId, now);
  if (rep.oldest != null) list.push(rep.oldest);
  const until = list.length ? Math.min(...list) + DAY : now + 3600 * 1000;
  return Math.min(24 * 3600, Math.max(60, Math.ceil((until - now) / 1000)));
}

/**
 * The volume of the speed tests for the config pull (`features.inetq.speedVolume`, an older gateway
 * ignores it): dayBytes — the daily budget, which the gateway keeps in its state directory as well;
 * downBytes / upBytes — plan 'hourly' only: the cap of one test per direction.
 */
function speedVolume(plan) {
  return { dayBytes: SPEED_BUDGET_BYTES, ...(plan === 'hourly' ? { downBytes: SPEED_HOURLY_TEST_BYTES, upBytes: SPEED_HOURLY_TEST_BYTES } : {}) };
}

/** Take a stream slot → release() or an error code ('busy' | 'budget'). */
function acquire(peerId, wantBytes) {
  const mine = streams.byPeer.get(peerId) || 0;
  if (mine >= SPEED_STREAMS_PER_GATEWAY || streams.total >= SPEED_STREAMS_TOTAL) return { error: 'busy' };
  if (budgetUsed(peerId, Date.now()) + (wantBytes || 0) > SPEED_BUDGET_BYTES) { budgetHit.set(peerId, Date.now()); return { error: 'budget' }; }
  streams.total++;
  streams.byPeer.set(peerId, mine + 1);
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      streams.total = Math.max(0, streams.total - 1);
      const n = (streams.byPeer.get(peerId) || 1) - 1;
      if (n > 0) streams.byPeer.set(peerId, n); else streams.byPeer.delete(peerId);
    },
  };
}

/** GET /api/v1/gateway/speedtest/down?bytes=N — N random bytes, streamed with backpressure. */
function speedDown(req, res) {
  const peerId = req.gateway.peer_id;
  const raw = req.query.bytes;
  let n = SPEED_DEFAULT_BYTES;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return res.status(400).json({ ok: false, error: 'invalid_bytes' });
    n = Number(raw);
    if (n < 1 || n > SPEED_MAX_BYTES) return res.status(400).json({ ok: false, error: 'invalid_bytes', max: SPEED_MAX_BYTES });
  }
  let hourly = false;
  try { hourly = features(peerId).inetq.speedtest === 'hourly'; } catch { hourly = false; }
  if (hourly) n = Math.min(n, SPEED_HOURLY_MAX_BYTES);
  const slot = acquire(peerId, n);
  if (slot.error) {
    if (slot.error === 'budget') res.set('Retry-After', String(budgetRetryAfter(peerId)));
    return res.status(429).json({ ok: false, error: slot.error });
  }
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(n), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  // one random block, sent again and again with a fresh random prefix — not compressible, no big buffers
  const block = crypto.randomBytes(SPEED_CHUNK);
  let left = n;
  let sent = 0;
  let finished = false;
  const end = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    account(peerId, sent);
    slot.release();
  };
  const timer = setTimeout(() => { res.destroy(); end(); }, module.exports._streamMaxMs || SPEED_STREAM_MAX_MS);
  if (timer.unref) timer.unref();
  const pump = () => {
    while (left > 0 && !finished) {
      const len = Math.min(SPEED_CHUNK, left);
      const chunk = Buffer.allocUnsafe(len);
      block.copy(chunk, 0, 0, len);
      crypto.randomFillSync(chunk, 0, Math.min(len, 64));
      left -= len;
      sent += len;
      if (!res.write(chunk)) { res.once('drain', pump); return; }
    }
    if (left <= 0 && !finished) res.end();
  };
  res.on('close', end);
  res.on('finish', end);
  res.on('error', end);
  pump();
  return undefined;
}

/** POST /api/v1/gateway/speedtest/up — the body is counted and thrown away. */
function speedUp(req, res) {
  const peerId = req.gateway.peer_id;
  const len = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
  if (len !== null && (!Number.isSafeInteger(len) || len < 0 || len > SPEED_MAX_BYTES)) {
    res.set('Connection', 'close');
    req.resume();
    return res.status(413).json({ ok: false, error: 'too_large', max: SPEED_MAX_BYTES });
  }
  const slot = acquire(peerId, len || 0);
  if (slot.error) {
    res.set('Connection', 'close');
    if (slot.error === 'budget') res.set('Retry-After', String(budgetRetryAfter(peerId)));
    req.resume();
    return res.status(429).json({ ok: false, error: slot.error });
  }
  const started = Date.now();
  let bytes = 0;
  let over = false;
  let finished = false;
  const end = () => { if (finished) return; finished = true; clearTimeout(timer); account(peerId, bytes); slot.release(); };
  const timer = setTimeout(() => {
    if (finished) return;
    // the time is up: answer with what came so far and stop reading
    req.pause();
    res.set('Connection', 'close');
    if (!res.headersSent) res.json({ ok: true, bytes, ms: Date.now() - started, cut: true });
    end();
    setImmediate(() => req.destroy());
  }, module.exports._streamMaxMs || SPEED_STREAM_MAX_MS);
  if (timer.unref) timer.unref();
  req.on('data', (c) => {
    if (over || finished) return;
    bytes += c.length;
    if (bytes > SPEED_MAX_BYTES) {
      over = true;
      req.pause();
      res.set('Connection', 'close');
      if (!res.headersSent) res.status(413).json({ ok: false, error: 'too_large', max: SPEED_MAX_BYTES });
      end();
      setImmediate(() => req.destroy());
    }
  });
  req.on('end', () => {
    if (over || finished) return;
    res.json({ ok: true, bytes, ms: Date.now() - started });
    end();
  });
  req.on('error', end);
  req.on('close', end);
  return undefined;
}

function _resetForTest() { streams.total = 0; streams.byPeer.clear(); budget.clear(); budgetHit.clear(); reported.clear(); speedRequested.clear(); }

module.exports = {
  InetqError, RAW_KEEP_MS, LONG_KEEP_MS, SPEED_MAX_BYTES, SPEED_HOURLY_MAX_BYTES, SPEED_HOURLY_TEST_BYTES, budgetInfo, budgetRetryAfter, speedVolume,
  SPEED_STREAMS_PER_GATEWAY, SPEED_STREAMS_TOTAL, SPEED_BUDGET_BYTES,
  ingest, view, speedtest, onHeartbeat, retention, noticeOutages, speedDown, speedUp, acquire, account, _resetForTest,
  _stepRows: null, _streamMaxMs: null,
};
