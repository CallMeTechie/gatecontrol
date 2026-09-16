'use strict';

// Dashboard problems (docs/feature-next-package.md S3 §1).
//
//   list()  → { generated_at, summary, problems: [...], on_demand: [...] }
//
// Nothing is measured here — every row is assembled from data GateControl
// already has, so the endpoint stays cheap enough for the dashboard's 15 s
// refresh and the SSE-driven reloads:
//
//   gateway_offline      gateway_meta.alive = 0
//   entry_down           uptime monitoring (routes.monitoring_status) and/or
//                        Caddy's access log, see below
//   tls_failed/paused    tls_status via tlsGuard.listStatus()
//   update_failed        .auto-update-state.json via autoUpdate.getStatus()
//   update_rolled_back   ditto
//   backup_failed        backup_targets.last_status
//   waf_engine_missing   waf.engineAvailable() while entries have the WAF on
//
// "Gateway erreichbar, Dienst im LAN antwortet nicht": the reason cannot be
// read literally — Caddy's access log carries no `error` field, only the
// status and the duration of the request (verified against the production
// log). The reverse proxy maps the dial result onto exactly that pair:
//
//   502 + duration < SLOW_MS   the dial was refused right away (ECONNREFUSED):
//                              the machine answers, the service does not
//   504, or 502 after the
//   proxy's dial timeout       nothing answered at all (EHOSTUNREACH /
//                              host off or asleep)
//
// L4 entries never appear in the HTTP access log; for them only the uptime
// monitoring can tell "down", and the reason stays null.
//
// Entries with routes.on_demand are never a problem — they are reported
// separately (`on_demand`) so the section can carry the note instead.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config/default');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

// Bounded tail of the access log, like the WAF assistant (wafAssistant.js).
const ACCESS_TAIL_BYTES = 2 * 1024 * 1024;
const ACCESS_CACHE_MS = 60 * 1000;
// Only failures from the last WINDOW_MS count — an outage from yesterday is
// not a problem of right now.
const ACCESS_WINDOW_MS = 30 * 60 * 1000;
// A dial that fails faster than this was refused; anything slower ran into a
// timeout. Caddy's default dial timeout is seconds, a refusal is ~20 ms.
const SLOW_MS = 1000;

const BACKUP_OK_STATUSES = ['ok', 'success', 'done', 'uploaded'];

function nowIso() { return new Date().toISOString(); }

function isoOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v).toISOString() : null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normHost(h) {
  return String(h || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
}

// ─── Access log ─────────────────────────────────────────

let _access = { at: 0, file: null, hosts: null, promise: null };

function accessLogPath() {
  return path.join(config.caddy.dataDir || '/data/caddy', 'access.log');
}

/**
 * Classify one access-log entry. Returns 'refused' | 'unreachable' | 'ok' |
 * null (the line says nothing about the upstream).
 */
function classifyLine(status, durationS) {
  const s = Number(status);
  if (!Number.isFinite(s)) return null;
  if (s < 500) return 'ok';
  const ms = Number(durationS) * 1000;
  if (s === 502) return Number.isFinite(ms) && ms < SLOW_MS ? 'refused' : 'unreachable';
  if (s === 504) return 'unreachable';
  // 500/503 and friends come from the app or from GateControl itself
  // (circuit breaker), they say nothing about reachability.
  return null;
}

/**
 * Tail of Caddy's access log → Map(host → { refused, unreachable, ok,
 * last_fail_at, last_ok_at }). Cached for ACCESS_CACHE_MS, never throws
 * (unreachable log → null, the problems then come from the monitoring only).
 */
async function scanAccessLog(now = Date.now()) {
  const file = accessLogPath();
  if (_access.promise) return _access.promise;
  if (_access.file === file && now - _access.at < ACCESS_CACHE_MS) return _access.hosts;
  _access.promise = (async () => {
    let fh;
    const hosts = new Map();
    let ok = true;
    try {
      fh = await fs.promises.open(file, 'r');
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - ACCESS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
      const from = (now - ACCESS_WINDOW_MS) / 1000;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const ts = Number(e && e.ts);
        if (!Number.isFinite(ts) || ts < from) continue;
        const host = e.request && e.request.host ? normHost(e.request.host) : null;
        if (!host) continue;
        const cls = classifyLine(e.status, e.duration);
        if (!cls) continue;
        const iso = new Date(ts * 1000).toISOString();
        const cur = hosts.get(host) || { refused: 0, unreachable: 0, ok: 0, last_fail_at: null, last_ok_at: null };
        if (cls === 'ok') {
          cur.ok += 1;
          if (!cur.last_ok_at || iso > cur.last_ok_at) cur.last_ok_at = iso;
        } else {
          cur[cls] += 1;
          if (!cur.last_fail_at || iso > cur.last_fail_at) cur.last_fail_at = iso;
        }
        hosts.set(host, cur);
      }
    } catch {
      ok = false;
    } finally {
      if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    }
    _access = { at: now, file, hosts: ok ? hosts : null, promise: null };
    return _access.hosts;
  })();
  return _access.promise;
}

/**
 * The verdict of the access log for one host:
 * { reason: 'refused' | 'unreachable', since } or null (fine / no evidence).
 */
function accessVerdict(hosts, host) {
  if (!hosts) return null;
  const h = hosts.get(normHost(host));
  if (!h || !h.last_fail_at) return null;
  // A later success ends the outage.
  if (h.last_ok_at && h.last_ok_at > h.last_fail_at) return null;
  return {
    reason: h.unreachable > h.refused ? 'unreachable' : 'refused',
    since: h.last_fail_at,
    fails: h.refused + h.unreachable,
  };
}

function _resetAccessCacheForTest() { _access = { at: 0, file: null, hosts: null, promise: null }; }

// ─── Entries ────────────────────────────────────────────

function fqdnOf(row) {
  if (row.subdomain != null && row.subdomain !== '' && row.zone_domain) {
    return row.subdomain === '@' ? row.zone_domain : row.subdomain + '.' + row.zone_domain;
  }
  return row.bundle_domain || row.domain || null;
}

function entryView(row, rdpIds) {
  const isL4 = row.route_type === 'l4';
  const gw = row.target_kind === 'gateway';
  return {
    id: row.id,
    label: row.label || null,
    fqdn: fqdnOf(row),
    proto: isL4 ? (row.l4_protocol === 'udp' ? 'UDP' : 'TCP') : (row.https_enabled ? 'HTTPS' : 'HTTP'),
    listen: isL4 ? (row.l4_listen_port != null ? String(row.l4_listen_port) : null) : (row.https_enabled ? '443' : '80'),
    target: String((gw ? (row.target_lan_port || row.target_port) : row.target_port) || ''),
    lan_host: gw ? row.target_lan_host || null : null,
    external: !!row.external_enabled,
    on_demand: !!row.on_demand,
    rdp_owned: rdpIds.has(row.id),
  };
}

function entryHref(row, rdpIds) {
  if (rdpIds.has(row.id)) return '/rdp';
  if (row.zone_id != null && row.bundle_id != null) return '/routes?domain=' + row.zone_id + '&host=' + row.bundle_id;
  return '/routes';
}

// ─── Assembly ───────────────────────────────────────────

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const KIND_RANK = [
  'gateway_offline', 'entry_down', 'tls_failed', 'tls_paused',
  'update_failed', 'update_rolled_back', 'backup_failed', 'waf_engine_missing',
];

function offlineGateways(db) {
  try {
    return db.prepare(`
      SELECT gm.peer_id, gm.went_down_at, gm.last_seen_at, p.name
      FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
      WHERE gm.alive = 0 AND p.enabled = 1
      ORDER BY p.name COLLATE NOCASE`).all();
  } catch (err) {
    logger.warn({ err: err.message }, 'problems: gateway state unavailable');
    return [];
  }
}

function activeRoutes(db) {
  return db.prepare(`
    SELECT r.id, r.domain, r.label, r.on_demand, r.enabled, r.external_enabled, r.route_type,
           r.https_enabled, r.l4_protocol, r.l4_listen_port,
           r.target_kind, r.target_peer_id, r.target_pool_id,
           r.target_lan_host, r.target_lan_port, r.target_port,
           r.wol_enabled, r.wol_mac,
           r.monitoring_enabled, r.monitoring_status, r.monitoring_last_change,
           r.bundle_id, sb.subdomain, sb.domain AS bundle_domain,
           sb.domain_id AS zone_id, d.domain AS zone_domain
    FROM routes r
    LEFT JOIN service_bundles sb ON sb.id = r.bundle_id
    LEFT JOIN domains d ON d.id = sb.domain_id
    WHERE r.enabled = 1
    ORDER BY r.id`).all();
}

function rdpOwnedIds(db) {
  try {
    return new Set(db.prepare('SELECT gateway_l4_route_id AS id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL')
      .all().map((r) => r.id));
  } catch { return new Set(); }
}

function wolInfo(row, licensed) {
  if (row.target_kind !== 'gateway') return null;
  return { licensed: !!licensed, enabled: !!row.wol_enabled, mac: row.wol_mac || null };
}

function tlsProblems() {
  let st;
  try { st = require('./tlsGuard').listStatus(); }
  catch (err) { logger.warn({ err: err.message }, 'problems: tls status unavailable'); return []; }
  return (st.hosts || [])
    .filter((h) => h.state === 'failed' || h.state === 'paused')
    .map((h) => ({
      id: 'tls:' + h.host,
      kind: h.state === 'failed' ? 'tls_failed' : 'tls_paused',
      severity: h.state === 'failed' ? 'error' : 'warning',
      href: '/certificates',
      since: isoOf(h.paused_at || h.last_attempt_at),
      tls: {
        host: h.host,
        code: h.last_error_code || null,
        paused_reason: h.paused_reason || null,
        attempts: h.attempts,
        max_attempts: h.max_attempts,
      },
    }));
}

function updateProblem() {
  let st;
  try { st = require('./autoUpdate').getStatus(); }
  catch (err) { logger.warn({ err: err.message }, 'problems: auto-update state unavailable'); return []; }
  if (st.last_action !== 'failed' && st.last_action !== 'rolled_back') return [];
  const failed = st.last_action === 'failed';
  return [{
    id: 'update',
    kind: failed ? 'update_failed' : 'update_rolled_back',
    severity: failed ? 'error' : 'warning',
    href: '/dashboard#auto-update',
    since: isoOf(st.checked_at),
    update: {
      bad_version: st.bad_version || null,
      running_version: st.running_version || null,
      rollback_failed: failed && !!st.bad_image,
    },
  }];
}

function backupProblems(db) {
  let rows;
  try {
    rows = db.prepare('SELECT id, name, last_run_at, last_status FROM backup_targets WHERE enabled = 1 ORDER BY id').all();
  } catch { return []; }
  return rows
    .filter((t) => t.last_status && !BACKUP_OK_STATUSES.includes(String(t.last_status).toLowerCase()))
    .map((t) => ({
      id: 'backup:' + t.id,
      kind: 'backup_failed',
      severity: 'warning',
      href: '/settings#backup',
      since: isoOf(t.last_run_at),
      backup: { target_id: t.id, name: t.name, status: String(t.last_status) },
    }));
}

function wafEngineProblem(db) {
  let waf;
  try { waf = require('./waf'); } catch { return []; }
  let count = 0;
  try { count = db.prepare('SELECT COUNT(*) AS c FROM routes WHERE waf_enabled = 1 AND enabled = 1').get().c; }
  catch { return []; }
  if (count === 0) return [];
  let available = true;
  try { available = waf.engineAvailable(); } catch { return []; }
  if (available) return [];
  return [{
    id: 'waf_engine',
    kind: 'waf_engine_missing',
    severity: 'warning',
    href: '/waf',
    since: null,
    waf: { routes: count },
  }];
}

/**
 * All current problems. `now` and `access` are injectable for tests.
 */
async function list({ now = Date.now(), access } = {}) {
  const db = getDb();
  const hosts = access !== undefined ? access : await scanAccessLog(now);
  const rdpIds = rdpOwnedIds(db);
  let wolLicensed = false;
  try { wolLicensed = require('./license').hasFeature('gateway_wol'); } catch { /* unlicensed */ }

  const problems = [];
  const onDemand = [];

  // 1. Gateways that stopped answering.
  const offline = offlineGateways(db);
  const offlineIds = new Set(offline.map((g) => g.peer_id));
  const gatewayRows = new Map();
  for (const g of offline) {
    const row = {
      id: 'gateway:' + g.peer_id,
      kind: 'gateway_offline',
      severity: 'error',
      href: '/gateways',
      since: isoOf(g.went_down_at || g.last_seen_at),
      gateway: { peer_id: g.peer_id, name: g.name, entries: 0 },
    };
    gatewayRows.set(g.peer_id, row);
    problems.push(row);
  }

  // 2. Entries whose target does not answer.
  for (const row of activeRoutes(db)) {
    const offlineGw = row.target_kind === 'gateway' && row.target_peer_id != null && offlineIds.has(row.target_peer_id);
    if (offlineGw) {
      // The gateway row already says it — count the entry there instead of
      // repeating the same outage per entry.
      const gwRow = gatewayRows.get(row.target_peer_id);
      if (gwRow) gwRow.gateway.entries += 1;
      continue;
    }
    const verdict = row.domain ? accessVerdict(hosts, row.domain) : null;
    const monitorDown = !!row.monitoring_enabled && row.monitoring_status === 'down';
    if (!verdict && !monitorDown) continue;

    const entry = entryView(row, rdpIds);
    const base = {
      id: 'entry:' + row.id,
      kind: 'entry_down',
      href: entryHref(row, rdpIds),
      reason: verdict ? verdict.reason : null,
      evidence: verdict ? 'access_log' : 'monitor',
      since: (verdict && verdict.since) || isoOf(row.monitoring_last_change),
      entry,
      wol: wolInfo(row, wolLicensed),
    };
    if (row.on_demand) {
      // "Nur bei Bedarf": never a problem, only the note.
      onDemand.push({ ...base, kind: 'on_demand', severity: 'info' });
      continue;
    }
    problems.push({ ...base, severity: row.external_enabled ? 'error' : 'warning' });
  }

  // 3–6. Certificates, update, off-site backups, WAF module.
  problems.push(...tlsProblems(), ...updateProblem(), ...backupProblems(db), ...wafEngineProblem(db));

  problems.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const k = KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind);
    if (k !== 0) return k;
    return String(a.id).localeCompare(String(b.id));
  });

  const summary = {
    total: problems.length,
    error: problems.filter((p) => p.severity === 'error').length,
    warning: problems.filter((p) => p.severity === 'warning').length,
    on_demand: onDemand.length,
    // The access log is optional input — the UI says so when it is missing.
    access_log: hosts ? 'ok' : 'unavailable',
  };

  return { generated_at: nowIso(), summary, problems, on_demand: onDemand };
}

module.exports = {
  list,
  scanAccessLog, accessVerdict, classifyLine,
  ACCESS_TAIL_BYTES, ACCESS_WINDOW_MS, SLOW_MS,
  _resetAccessCacheForTest,
};
