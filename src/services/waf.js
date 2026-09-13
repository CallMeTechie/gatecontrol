'use strict';

// Web Application Firewall (docs/feature-waf.md): Coraza + OWASP CRS as the
// Caddy module `http.handlers.waf`, switchable per HTTP route.
//
//   directivesFor(route)      pure: the SecLang directives of one route
//   buildWafHandler(route)    the Caddy handler object (null = no WAF)
//   blockErrorRoutes(hosts)   srv0 `errors` routes → own 403 page
//   engineAvailable()         does the running Caddy binary carry the module?
//   startWatcher/stopWatcher  audit log → waf_events (+ eventBus 'waf')
//   parseAuditLine            one Coraza JSON audit line → transaction or null
//   truncate after ingest     data minimisation; rotation (20 MB × 3) as fallback
//   stats / status / listEvents / addExclusion / removeExclusion / cleanup

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const logger = require('../utils/logger');
const settings = require('./settings');
const eventBus = require('./eventBus');
const { withCaddySync } = require('./routesSync');
const { restoreRouteRow } = require('./routesRollback');
const { WAF_MODES, WAF_PARANOIA_MIN, WAF_PARANOIA_MAX } = require('./routesValidation');

// ─── Constants ──────────────────────────────────────────

const AUDIT_LOG_NAME = 'waf-audit.log';
const WATCH_STATE_KEY = 'waf.watch_state';
const WATCH_INTERVAL_MS = 5000;
const ROTATE_BYTES = 20 * 1024 * 1024;   // 20 MB …
const ROTATE_KEEP = 3;                   // … rotated files .1 … .3
const MAX_READ_BYTES = 8 * 1024 * 1024;  // per poll tick; the rest follows next tick
const MAX_LINE_BYTES = 1024 * 1024;      // a longer line is skipped, not parsed
const HEAD_LEN = 64;

// Exclusions: rule IDs → SecRuleRemoveById; paths → ctl:ruleEngine=Off rule
// with id 10000 + route_id * 100 + index (contract), so at most 100 per route.
const PATH_RULE_BASE = 10000;
const PATH_RULE_SPAN = 100;
const MAX_PATH_EXCLUSIONS = 50;
const MAX_RULE_EXCLUSIONS = 200;
const RULE_ID_MAX = 9999999;
// Path exclusions go verbatim into a SecRule operator argument: no quotes,
// backslashes, whitespace or control characters — nothing that could end the
// quoted operator or the directive line.
const EXCLUSION_PATH_RE = /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]{0,255}$/;

// CRS scoring/evaluation/correlation rules: they summarise the detection
// rules of the transaction and are not what one excludes.
const SUMMARY_RULE_RE = /^9(49|59|80)\d{3}$/;

const SEVERITIES = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

const EVENTS_LIMIT_DEFAULT = 50;
const EVENTS_LIMIT_MAX = 500;
const MAX_EVENT_ROWS = 200000;           // hard cap on top of the retention days
const RETENTION_DEFAULT_DAYS = 14;

function wafError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function nowIso() { return new Date().toISOString(); }
function normHost(h) { return String(h || '').trim().toLowerCase().replace(/\.$/, ''); }

function auditLogPath() {
  return path.join(config.caddy.dataDir || '/data/caddy', AUDIT_LOG_NAME);
}

// ─── Exclusions ─────────────────────────────────────────

/** routes.waf_exclusions (JSON text or object) → { rule_ids:number[], paths:string[] }; never throws. */
function parseExclusions(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') obj = {};
  const ruleIds = Array.isArray(obj.rule_ids) ? obj.rule_ids : [];
  const paths = Array.isArray(obj.paths) ? obj.paths : [];
  return {
    rule_ids: [...new Set(ruleIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= RULE_ID_MAX))]
      .sort((a, b) => a - b)
      .slice(0, MAX_RULE_EXCLUSIONS),
    paths: [...new Set(paths.map((p) => String(p == null ? '' : p).trim()).filter((p) => EXCLUSION_PATH_RE.test(p)))]
      .slice(0, MAX_PATH_EXCLUSIONS),
  };
}

function validateRuleId(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 1 || n > RULE_ID_MAX) {
    throw wafError('WAF_RULE_ID_INVALID', `rule_id must be an integer between 1 and ${RULE_ID_MAX}`);
  }
  return n;
}

function validateExclusionPath(value) {
  const p = String(value == null ? '' : value).trim();
  if (!EXCLUSION_PATH_RE.test(p)) {
    throw wafError('WAF_PATH_INVALID', 'path must start with "/" and contain no spaces, quotes or backslashes (max. 256 characters)');
  }
  return p;
}

// ─── Directives (pure) ──────────────────────────────────

function modeOf(route) {
  return route && route.waf_mode === 'block' ? 'block' : 'detect';
}

function paranoiaOf(route) {
  const n = Number(route && route.waf_paranoia);
  if (!Number.isInteger(n)) return WAF_PARANOIA_MIN;
  return Math.min(WAF_PARANOIA_MAX, Math.max(WAF_PARANOIA_MIN, n));
}

/**
 * SecLang directives for one route. Order matters:
 *   - the paranoia SecAction (id 900000) and the path exclusions
 *     (ctl:ruleEngine=Off, runtime) must be defined BEFORE the CRS rules,
 *     otherwise REQUEST-901 has already fixed the paranoia level / the CRS
 *     phase-1 rules have already run;
 *   - SecRuleRemoveById (configure-time) must come AFTER the CRS rules.
 * Engine settings after the includes override coraza.conf-recommended.
 */
function directivesFor(route, { auditLog } = {}) {
  const mode = modeOf(route);
  const pl = paranoiaOf(route);
  const ex = parseExclusions(route && route.waf_exclusions);
  const routeId = Number(route && route.id) || 0;
  const lines = [
    'Include @coraza.conf-recommended',
    'Include @crs-setup.conf.example',
    `SecAction "id:900000,phase:1,pass,nolog,setvar:tx.blocking_paranoia_level=${pl}"`,
  ];
  ex.paths.slice(0, PATH_RULE_SPAN).forEach((p, i) => {
    lines.push(`SecRule REQUEST_URI "@beginsWith ${p}" "id:${PATH_RULE_BASE + routeId * PATH_RULE_SPAN + i},phase:1,pass,nolog,ctl:ruleEngine=Off"`);
  });
  lines.push(
    'Include @owasp_crs/*.conf',
    `SecRuleEngine ${mode === 'block' ? 'On' : 'DetectionOnly'}`,
    // Uploads above the inspection limit (12.5 MB) are inspected partially
    // instead of being answered with 413 — size limits are max_body_mb's job.
    'SecRequestBodyLimitAction ProcessPartial',
    // No response inspection: it buffers upstream bodies (latency, memory,
    // streaming) and cannot undo a request the backend already processed.
    'SecResponseBodyAccess Off',
    'SecAuditEngine RelevantOnly',
    // Only (would-be) interruptions are relevant — not every 404/5xx of the
    // backend. Coraza applies this filter to rule-triggered entries too, and
    // reports the interruption status (403, 400 for body parse errors) even in
    // DetectionOnly mode.
    'SecAuditLogRelevantStatus "^40[03]$"',
    'SecAuditLogFormat JSON',
    `SecAuditLog ${auditLog || auditLogPath()}`,
    // Data minimisation: A (always-on base: time, tx id, client ip, server
    // name, method, uri, protocol) + H (rule messages, engine) + Z. No B
    // (request headers: Cookie/Authorization), no C/F/E (bodies, response).
    'SecAuditLogParts AHZ',
    'SecAuditLogFileMode 0600',
  );
  for (const id of ex.rule_ids) lines.push(`SecRuleRemoveById ${id}`);
  return lines.join('\n');
}

/** Caddy handler for a route, or null when the WAF is off / not applicable. */
function buildWafHandler(route, { engine } = {}) {
  if (!route || !route.waf_enabled || route.route_type === 'l4') return null;
  const available = engine !== undefined ? !!engine : engineAvailable();
  if (!available) return null;
  return { handler: 'waf', load_owasp_crs: true, directives: directivesFor(route) };
}

// ─── Block page ─────────────────────────────────────────

function renderBlockPage() {
  // Hardcoded bilingual like caddyAccessWindow (rendered at config-build time).
  // {http.error.id} is the Coraza transaction id, expanded by Caddy.
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Anfrage blockiert · Request blocked</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f8f9fa; color: #212529; margin: 0; padding: 2rem; }
    .container { max-width: 520px; margin: 10vh auto; text-align: center; }
    h1 { color: #dc3545; font-size: 1.75rem; }
    p { line-height: 1.6; color: #6c757d; }
    .detail { background: #fff; border-radius: 8px; padding: 1rem; margin-top: 1.5rem; font-size: 0.875rem; }
    code { background: #e9ecef; padding: 0.125rem 0.375rem; border-radius: 3px; }
    .lang-sep { margin-top: 1.25rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Anfrage blockiert</h1>
    <p>Die Web Application Firewall hat diese Anfrage als möglichen Angriff eingestuft und nicht weitergeleitet. Wenn Sie glauben, dass dies ein Fehler ist, wenden Sie sich an den Betreiber und nennen Sie die Referenz.</p>
    <p class="lang-sep"><strong>Request blocked</strong></p>
    <p>The web application firewall classified this request as a possible attack and did not forward it. If you believe this is a mistake, contact the operator and quote the reference.</p>
    <div class="detail">Referenz / Reference: <code>{http.error.id}</code></div>
  </div>
</body>
</html>`;
}

/**
 * srv0 `errors` routes for the hosts with a blocking WAF: coraza-caddy ends an
 * interrupted request with HandlerError{StatusCode: 403|400, Err: "interruption
 * triggered", ID: tx id}. Other errors fall through to Caddy's default.
 */
function blockErrorRoutes(hosts) {
  const list = [...new Set((hosts || []).map(normHost).filter(Boolean))];
  if (list.length === 0) return null;
  return [{
    '@id': 'gc_waf_block_page',
    match: [{ host: list, expression: "{http.error.message} == 'interruption triggered'" }],
    handle: [{
      handler: 'static_response',
      status_code: '{http.error.status_code}',
      headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'] },
      body: renderBlockPage(),
    }],
    terminal: true,
  }];
}

// ─── Engine availability ────────────────────────────────

const ENGINE_NEGATIVE_TTL_MS = 10 * 60 * 1000;
let _engine = { value: null, checkedAt: 0 };
let _engineOverride = null;

function caddyBinaries() {
  const list = [process.env.GC_CADDY_BIN, '/usr/local/bin/caddy', '/usr/bin/caddy'].filter(Boolean);
  return [...new Set(list)];
}

function modulesHaveWaf(out) {
  return /^\s*http\.handlers\.waf\s*$/m.test(String(out || ''));
}

function probeEngineSync() {
  for (const bin of caddyBinaries()) {
    try {
      if (!fs.existsSync(bin)) continue;
      const out = childProcess.execFileSync(bin, ['list-modules'], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return modulesHaveWaf(out);
    } catch (err) {
      logger.warn({ err: err.message, bin }, 'waf: caddy list-modules failed');
    }
  }
  return false;
}

/**
 * true when the Caddy binary provides http.handlers.waf. Checked once via
 * `caddy list-modules` (a positive result is cached for the process lifetime,
 * a negative one for 10 min). GC_WAF_ENGINE=1|0 forces it; in the test
 * environment the binary is never executed (tests inject _setEngineForTest).
 */
function engineAvailable() {
  if (_engineOverride !== null) return _engineOverride;
  const env = process.env.GC_WAF_ENGINE;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (_engine.value === true) return true;
  if (_engine.value === false && Date.now() - _engine.checkedAt < ENGINE_NEGATIVE_TTL_MS) return false;
  _engine = { value: probeEngineSync(), checkedAt: Date.now() };
  if (!_engine.value) logger.warn('waf: the Caddy binary has no http.handlers.waf module — WAF handlers are omitted');
  return _engine.value;
}

function _setEngineForTest(v) { _engineOverride = v === null || v === undefined ? null : !!v; }

// ─── Audit log parser ───────────────────────────────────

function severityName(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isInteger(v)) return SEVERITIES[v] || String(v);
  const s = String(v).trim().toLowerCase();
  if (/^\d+$/.test(s)) return SEVERITIES[Number(s)] || s;
  return s || null;
}

function tsOf(t) {
  const u = Number(t.unix_timestamp);
  if (Number.isFinite(u) && u > 0) {
    // Coraza: nanoseconds. Tolerate ms / s as well.
    const ms = u > 1e17 ? u / 1e6 : (u > 1e14 ? u / 1e3 : (u > 1e11 ? u : u * 1000));
    const d = new Date(Math.floor(ms));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof t.timestamp === 'string' && t.timestamp) {
    // "2026/09/13 18:30:00" (Coraza, UTC) or ISO.
    const m = t.timestamp.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(t.timestamp);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return nowIso();
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== want) continue;
    const val = Array.isArray(v) ? v[0] : v;
    return val == null ? null : String(val);
  }
  return null;
}

function hostOf(t) {
  const req = t.request || {};
  const h = t.server_id || headerValue(req.headers, 'host') || '';
  // strip a port (not for bracketed IPv6)
  const s = String(h).trim();
  const host = s.startsWith('[') ? s.replace(/\]:\d+$/, ']') : s.replace(/:\d+$/, '');
  return normHost(host) || null;
}

// Go %q unquoting for the values in Coraza's ModSecurity-style error log
// strings ([id "941100"] [msg "…"] …). Unknown escapes are kept literally.
function goUnquote(v) {
  return String(v).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|.)/g, (m, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '\\': return '\\';
      case '"': return '"';
      case "'": return "'";
      case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
      case 'u':
      case 'U': { const cp = parseInt(e.slice(1), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
      default: return /^[0-7]{3}$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : m;
    }
  });
}

const ERRLOG_FIELD_RE = /\[([a-z][a-z0-9_]*) "((?:[^"\\]|\\.)*)"\]/g;

/**
 * Coraza error-log string (audit part H without part K) → { id, msg, data,
 * severity, tags }. Only the first occurrence of a field counts (later
 * msg_match_N/data_match_N belong to chained matches).
 */
function parseErrorLog(text) {
  const out = { tags: [] };
  if (!text) return out;
  ERRLOG_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = ERRLOG_FIELD_RE.exec(String(text)))) {
    const key = m[1];
    const val = goUnquote(m[2]);
    if (key === 'tag') { if (out.tags.length < 20) out.tags.push(val); continue; }
    if (!(key in out)) out[key] = val;
  }
  return out;
}

function clip(s, n) {
  if (s === undefined || s === null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

/**
 * One line of the Coraza JSON audit log → { tx_id, ts, host, client_ip,
 * method, uri, status, interrupted, rule_engine, messages:[{rule_id,
 * severity, message, data, tags}] } or null (not JSON / not an audit entry).
 */
function parseAuditLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !obj.transaction || typeof obj.transaction !== 'object') return null;
  const t = obj.transaction;
  const req = t.request && typeof t.request === 'object' ? t.request : {};
  const res = t.response && typeof t.response === 'object' ? t.response : {};
  const messages = [];
  for (const m of Array.isArray(obj.messages) ? obj.messages : []) {
    if (!m || typeof m !== 'object') continue;
    // Structured details exist with audit part K; with the parts used here
    // (AHZ) Coraza only writes the error-log string (part H).
    const d = m.data && typeof m.data === 'object' ? m.data : parseErrorLog(m.error_message || m.message || '');
    const id = Number(d.id);
    messages.push({
      rule_id: Number.isInteger(id) && id > 0 ? id : null,
      severity: severityName(d.severity),
      message: clip(d.msg || '', 1000),
      data: clip(d.data || '', 2000),
      tags: Array.isArray(d.tags) ? d.tags.slice(0, 20).map(String) : [],
    });
  }
  return {
    tx_id: t.id ? String(t.id) : null,
    ts: tsOf(t),
    host: hostOf(t),
    client_ip: t.client_ip ? String(t.client_ip) : null,
    method: req.method ? clip(req.method, 16) : null,
    uri: req.uri != null ? clip(req.uri, 2048) : null,
    protocol: req.protocol ? clip(req.protocol, 16) : null,
    status: Number.isInteger(res.status) ? res.status : null,
    interrupted: t.is_interrupted === true,
    rule_engine: t.producer && t.producer.rule_engine ? String(t.producer.rule_engine) : null,
    messages,
  };
}

// Matched data of a rule that fired on a cookie, a credential header or a
// credential-like form/JSON field (password, token, OTP, API key …) holds that
// value ("Matched Data: … found within REQUEST_COOKIES:sid: <value>") — never
// stored; only the variable name survives.
const SENSITIVE_TARGET_RE = /(REQUEST_COOKIES(?:_NAMES)?(?::[^:\s]*)?|REQUEST_HEADERS(?:_NAMES)?:(?:cookie|authorization|proxy-authorization)\b|ARGS(?:_POST|_GET)?:[^:\s]*(?:pass|pwd|secret|token|otp|api[_-]?key|auth|recovery)[^:\s]*)/i;

function redactMatchedData(data) {
  if (!data) return data || null;
  const m = String(data).match(SENSITIVE_TARGET_RE);
  return m ? `[redacted: matched in ${m[1]}]` : String(data);
}

const RAW_MAX_BYTES = 8192;

/**
 * Redacted raw record of one row (the UI shows it collapsible): request line,
 * engine/interruption, the row's rule with its (redacted) matched data, and
 * the other rule messages of the same request (id/msg/severity only — the
 * anomaly-score summary 949110 included). No request headers, no bodies.
 */
function rawFor(tx, m) {
  const raw = {
    request: [tx.method, tx.uri, tx.protocol].filter(Boolean).join(' ') || null,
    rule_engine: tx.rule_engine,
    interrupted: tx.interrupted,
    rule: { id: m.rule_id, msg: m.message || null, severity: m.severity, data: redactMatchedData(m.data), tags: m.tags },
    messages: tx.messages.filter((x) => x.rule_id).slice(0, 30).map((x) => ({ id: x.rule_id, msg: x.message || null, severity: x.severity })),
  };
  let json = JSON.stringify(raw);
  if (json.length > RAW_MAX_BYTES) { raw.messages = raw.messages.slice(0, 5); raw.request = clip(raw.request, 1024); json = JSON.stringify(raw); }
  return json.length > RAW_MAX_BYTES ? JSON.stringify({ request: clip(raw.request, 512), rule: { id: m.rule_id } }) : json;
}

/**
 * Transaction → waf_events rows: one row per detection rule (the CRS
 * scoring/evaluation rules 949/959/980xxx are dropped — unless nothing else
 * matched, then the first message is kept so a blocked request never
 * vanishes). Transactions without any rule message produce no row.
 */
function eventsFromTransaction(tx, routeLookup) {
  if (!tx) return [];
  const withId = tx.messages.filter((m) => m.rule_id);
  if (withId.length === 0) return [];
  let picked = withId.filter((m) => !SUMMARY_RULE_RE.test(String(m.rule_id)));
  if (picked.length === 0) picked = [withId[0]];
  const seen = new Set();
  picked = picked.filter((m) => (seen.has(m.rule_id) ? false : (seen.add(m.rule_id), true)));
  const action = tx.interrupted ? 'blocked' : 'detected';
  const host = tx.host || 'unknown';
  const routeId = routeLookup ? routeLookup(host) : null;
  return picked.map((m) => ({
    ts: tx.ts,
    host,
    route_id: routeId,
    client_ip: tx.client_ip,
    method: tx.method,
    uri: tx.uri,
    rule_id: m.rule_id,
    severity: m.severity,
    message: m.message,
    action,
    tx_id: tx.tx_id,
    raw: rawFor(tx, m),
  }));
}

// host → route id (HTTP routes incl. alias FQDNs); rebuilt per poll batch.
function buildRouteLookup() {
  const map = new Map();
  try {
    const db = getDb();
    for (const r of db.prepare("SELECT id, domain FROM routes WHERE route_type != 'l4' AND domain IS NOT NULL AND domain != '' ORDER BY id").all()) {
      const h = normHost(r.domain);
      if (!map.has(h)) map.set(h, r.id);
    }
    const { parseAliases, aliasFqdns } = require('./domainZones');
    const rows = db.prepare(`
      SELECT r.id, r.domain, sb.aliases FROM routes r
      JOIN service_bundles sb ON sb.id = r.bundle_id
      WHERE r.route_type != 'l4' AND sb.aliases IS NOT NULL AND sb.aliases != '' AND sb.aliases != '[]'`).all();
    for (const r of rows) {
      for (const f of aliasFqdns(r.domain, parseAliases(r.aliases))) if (!map.has(f)) map.set(f, r.id);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'waf: route lookup unavailable');
  }
  return (host) => (map.has(normHost(host)) ? map.get(normHost(host)) : null);
}

function insertEvents(rows) {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO waf_events (ts, host, route_id, client_ip, method, uri, rule_id, severity, message, action, tx_id, raw)
    VALUES (@ts, @host, @route_id, @client_ip, @method, @uri, @rule_id, @severity, @message, @action, @tx_id, @raw)`);
  db.transaction((list) => { for (const r of list) stmt.run(r); })(rows);
  return rows.length;
}

const MAX_PUBLISH_PER_BATCH = 20;

/** Parse + store a batch of lines. Returns the number of stored rows. */
function ingestLines(lines) {
  const lookup = buildRouteLookup();
  const rows = [];
  const firsts = [];
  for (const line of lines) {
    const t = String(line || '').trim();
    if (!t || t.length > MAX_LINE_BYTES) continue;
    try {
      const evts = eventsFromTransaction(parseAuditLine(t), lookup);
      if (evts.length > 0) { rows.push(...evts); firsts.push(evts[0]); }
    } catch (err) {
      logger.warn({ err: err.message }, 'waf: audit line failed');
    }
  }
  const n = insertEvents(rows);
  for (const e of firsts.slice(0, MAX_PUBLISH_PER_BATCH)) {
    try { eventBus.publish('waf', { host: e.host, action: e.action, rule_id: e.rule_id }); } catch { /* best-effort */ }
  }
  return n;
}

// ─── Watcher (modeled on tlsGuard: offset + inode + head fingerprint) ──

// `partial` holds the bytes of an unterminated last line (a Buffer, so a
// multi-byte character split across two reads is decoded correctly).
const EMPTY = Buffer.alloc(0);
const _watch = { timer: null, file: null, ino: null, offset: 0, head: '', partial: EMPTY, busy: false, rotateBytes: ROTATE_BYTES, truncate: true };

function loadWatchState() {
  try {
    const raw = settings.get(WATCH_STATE_KEY, '');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.file === _watch.file) { _watch.ino = s.ino ?? null; _watch.offset = Number(s.offset) || 0; _watch.head = s.head || ''; }
  } catch { /* fresh start */ }
}
function saveWatchState() {
  try { settings.set(WATCH_STATE_KEY, JSON.stringify({ file: _watch.file, ino: _watch.ino, offset: _watch.offset, head: _watch.head })); }
  catch { /* best-effort */ }
}
function readHead(fd, size) {
  const len = Math.min(HEAD_LEN, size);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return buf.subarray(0, n).toString('latin1');
}

// Read [from, to) of an open file.
function readRange(fd, from, to) {
  const len = Math.max(0, to - from);
  if (len === 0) return EMPTY;
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, from);
  return buf.subarray(0, n);
}

// Complete lines of partial + chunk; the unterminated rest stays in partial.
function splitLines(chunk) {
  const all = _watch.partial.length ? Buffer.concat([_watch.partial, chunk]) : chunk;
  const lines = [];
  let start = 0;
  let nl;
  while ((nl = all.indexOf(0x0a, start)) !== -1) {
    lines.push(all.subarray(start, nl).toString('utf8'));
    start = nl + 1;
  }
  _watch.partial = Buffer.from(all.subarray(start));
  if (_watch.partial.length > MAX_LINE_BYTES) _watch.partial = EMPTY; // runaway line → drop
  return lines;
}

/**
 * Rotation: Coraza keeps the audit log open (O_APPEND) until the next config
 * load, so a rename would keep it writing into the renamed file. Instead:
 * copy the file to <name>.1 (older ones shift to .2/.3, the oldest drops) and
 * truncate the original in place — O_APPEND writers continue at offset 0.
 * The unread tail is ingested from the copy, so only lines written in the
 * microseconds between copy and truncate can be lost. Returns the lines read
 * from the copy (not yet ingested).
 */
function rotate(file, fromOffset) {
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const src = i === 1 ? null : `${file}.${i - 1}`;
    const dst = `${file}.${i}`;
    if (i === ROTATE_KEEP) { try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ } }
    if (src) { try { fs.renameSync(src, dst); } catch { /* missing → skip */ } }
  }
  const tmp = `${file}.1.tmp`;
  fs.copyFileSync(file, tmp);
  try { fs.chmodSync(tmp, FILE_MODE); } catch { /* best-effort */ }
  fs.truncateSync(file, 0);
  fs.renameSync(tmp, `${file}.1`);
  const fd = fs.openSync(`${file}.1`, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    return readRange(fd, Math.min(fromOffset, size), size);
  } finally { fs.closeSync(fd); }
}

// Data minimisation: the audit log is readable by root only and holds a
// request (request line + rule messages) just until the watcher ingested it.
const FILE_MODE = 0o600;

function restrictMode(file, st) {
  try { if (st && (st.mode & 0o077) !== 0) fs.chmodSync(file, FILE_MODE); } catch { /* best-effort */ }
}

/**
 * Empty the audit log in place once everything in it was ingested
 * (copytruncate semantics: Coraza keeps writing through its O_APPEND fd at
 * offset 0). Returns 'truncated', 'grown' (new bytes arrived since the read —
 * read them first) or 'failed'. Only the microseconds between fstat and
 * ftruncate can lose a line.
 */
function truncateIfCaughtUp(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    const size = fs.fstatSync(fd).size;
    if (size !== _watch.offset) return 'grown';
    fs.ftruncateSync(fd, 0);
    return 'truncated';
  } catch (err) {
    logger.warn({ err: err.message, file }, 'waf: truncating the audit log failed');
    return 'failed';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Read new lines since the last offset and ingest them. When the file is
 * fully read (no backlog, no half-written line) it is truncated right away;
 * rotation (20 MB, 3 files) remains as the fallback when truncation is off or
 * fails.
 */
async function pollOnce() {
  if (_watch.busy) return 0;
  _watch.busy = true;
  try {
    const file = _watch.file;
    let stored = 0;
    let st = null;
    for (let round = 0; round < 3; round++) {
      try { st = fs.statSync(file); }
      catch { _watch.ino = null; _watch.offset = 0; _watch.head = ''; _watch.partial = EMPTY; return stored; }
      restrictMode(file, st);
      let fd;
      try { fd = fs.openSync(file, 'r'); }
      catch { return stored; }
      let chunk = EMPTY;
      try {
        const head = readHead(fd, st.size);
        const known = _watch.head.length > 0 ? head.slice(0, _watch.head.length) : '';
        const rotated = _watch.ino !== null && (st.ino !== _watch.ino || st.size < _watch.offset || (known && known !== _watch.head));
        if (rotated) { _watch.offset = 0; _watch.partial = EMPTY; }  // rotated/truncated elsewhere → from the top
        _watch.ino = st.ino;
        if (_watch.offset === 0) _watch.head = head;
        const to = Math.min(st.size, _watch.offset + MAX_READ_BYTES);
        chunk = readRange(fd, _watch.offset, to);
        _watch.offset += chunk.length;
        if (_watch.head.length < HEAD_LEN) _watch.head = readHead(fd, st.size);
      } finally { fs.closeSync(fd); }

      stored += ingestLines(splitLines(chunk));

      if (_watch.offset < st.size) break;                 // backlog → next tick
      if (!_watch.truncate || _watch.partial.length) break; // off, or a line is still being written
      const res = truncateIfCaughtUp(file);
      if (res === 'truncated') { _watch.offset = 0; _watch.head = ''; break; }
      if (res === 'failed') break;
      // 'grown' → another round reads the new lines, then tries again
    }

    // Fallback: rotate once the file is big AND fully read.
    let cur;
    try { cur = fs.statSync(file); } catch { cur = null; }
    if (cur && cur.size >= _watch.rotateBytes && _watch.offset >= cur.size) {
      try {
        const rest = rotate(file, _watch.offset);
        const lines = splitLines(rest);
        if (_watch.partial.length) { lines.push(_watch.partial.toString('utf8')); _watch.partial = EMPTY; } // the copy is complete
        stored += ingestLines(lines);
        _watch.offset = 0; _watch.head = '';
        try { _watch.ino = fs.statSync(file).ino; } catch { _watch.ino = null; }
        logger.info({ file }, 'WAF audit log rotated');
      } catch (err) {
        logger.warn({ err: err.message, file }, 'waf: audit log rotation failed');
      }
    }
    saveWatchState();
    return stored;
  } finally {
    _watch.busy = false;
  }
}

function startWatcher({ file, intervalMs = WATCH_INTERVAL_MS, immediate = true, rotateBytes = ROTATE_BYTES, truncateAfterIngest = true } = {}) {
  if (_watch.timer) return;
  _watch.file = file || auditLogPath();
  _watch.rotateBytes = rotateBytes;
  _watch.truncate = !!truncateAfterIngest;
  _watch.ino = null; _watch.offset = 0; _watch.partial = EMPTY; _watch.head = '';
  loadWatchState();
  const tick = () => pollOnce().catch((err) => logger.warn({ err: err.message }, 'waf: watcher tick failed'));
  _watch.timer = setInterval(tick, intervalMs);
  if (_watch.timer.unref) _watch.timer.unref();
  if (immediate) tick();
  logger.info({ file: _watch.file }, 'WAF audit log watcher started');
}

function stopWatcher() {
  if (_watch.timer) { clearInterval(_watch.timer); _watch.timer = null; }
}

// ─── Queries ────────────────────────────────────────────

const SINCE_24H = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();
// A request (transaction) with several rule hits is one event in the counters.
const TX_KEY = "COALESCE(tx_id, 'row:' || id)";

/** { events, blocked, by_route: { [route_id]: { events, blocked } } } since `since` (ISO; default 24 h). */
function stats({ since } = {}) {
  const from = since || SINCE_24H();
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(DISTINCT ${TX_KEY}) AS events,
      COUNT(DISTINCT CASE WHEN action = 'blocked' THEN ${TX_KEY} END) AS blocked
    FROM waf_events WHERE ts >= ?`).get(from);
  const byRoute = {};
  for (const r of db.prepare(`SELECT route_id, COUNT(DISTINCT ${TX_KEY}) AS events,
      COUNT(DISTINCT CASE WHEN action = 'blocked' THEN ${TX_KEY} END) AS blocked
    FROM waf_events WHERE ts >= ? AND route_id IS NOT NULL GROUP BY route_id`).all(from)) {
    byRoute[r.route_id] = { events: r.events, blocked: r.blocked };
  }
  return { since: from, events: total.events || 0, blocked: total.blocked || 0, by_route: byRoute };
}

/** GET /waf/status payload. */
function status() {
  const db = getDb();
  const s = stats();
  const rows = db.prepare(`SELECT id, domain, enabled, waf_mode, waf_paranoia, waf_exclusions
    FROM routes WHERE waf_enabled = 1 AND route_type != 'l4' ORDER BY domain, id`).all();
  return {
    engine_available: engineAvailable(),
    events_24h: s.events,
    blocked_24h: s.blocked,
    routes: rows.map((r) => ({
      route_id: r.id,
      host: r.domain,
      enabled: !!r.enabled,
      mode: modeOf(r),
      paranoia: paranoiaOf(r),
      exclusions: parseExclusions(r.waf_exclusions),
      events_24h: (s.by_route[r.id] || {}).events || 0,
      blocked_24h: (s.by_route[r.id] || {}).blocked || 0,
    })),
  };
}

function parseRaw(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function parseLimit(v) {
  if (v === undefined || v === null || v === '') return EVENTS_LIMIT_DEFAULT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw wafError('WAF_LIMIT_INVALID', `limit must be an integer between 1 and ${EVENTS_LIMIT_MAX}`);
  return Math.min(n, EVENTS_LIMIT_MAX);
}

function parseTime(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw wafError('WAF_TIME_INVALID', `${field} must be an ISO 8601 timestamp`);
  return d.toISOString();
}

/**
 * Newest first, keyset pagination on id: { events, next_cursor }.
 * Filters: host (exact, case-insensitive), route_id, action ('blocked'|
 * 'detected'), from/to (ISO, inclusive/exclusive), rule_id.
 */
function listEvents({ host, route_id, action, from, to, rule_id, limit, cursor } = {}) {
  const lim = parseLimit(limit);
  const where = [];
  const args = [];
  if (host !== undefined && host !== null && String(host).trim() !== '') { where.push('host = ?'); args.push(normHost(host)); }
  if (route_id !== undefined && route_id !== null && route_id !== '') {
    const n = Number(route_id);
    if (!Number.isInteger(n) || n < 1) throw wafError('WAF_ROUTE_ID_INVALID', 'route_id must be a positive integer');
    where.push('route_id = ?'); args.push(n);
  }
  if (action !== undefined && action !== null && action !== '') {
    if (action !== 'blocked' && action !== 'detected') throw wafError('WAF_ACTION_INVALID', "action must be 'blocked' or 'detected'");
    where.push('action = ?'); args.push(action);
  }
  if (rule_id !== undefined && rule_id !== null && rule_id !== '') { where.push('rule_id = ?'); args.push(validateRuleId(rule_id)); }
  const f = parseTime(from, 'from');
  const t = parseTime(to, 'to');
  if (f) { where.push('ts >= ?'); args.push(f); }
  if (t) { where.push('ts < ?'); args.push(t); }
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    const c = Number(cursor);
    if (!Number.isInteger(c) || c < 1) throw wafError('WAF_CURSOR_INVALID', 'cursor must be a positive integer');
    where.push('id < ?'); args.push(c);
  }
  const db = getDb();
  const rows = db.prepare(`SELECT id, ts, host, route_id, client_ip, method, uri, rule_id, severity, message, action, tx_id, raw
    FROM waf_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, lim + 1);
  const more = rows.length > lim;
  const page = more ? rows.slice(0, lim) : rows;
  // Mark rows whose rule is already excluded on their route (UI hides the action).
  const exByRoute = new Map();
  const ids = [...new Set(page.map((r) => r.route_id).filter((id) => id != null))];
  if (ids.length > 0) {
    for (const r of db.prepare(`SELECT id, waf_exclusions FROM routes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      exByRoute.set(r.id, parseExclusions(r.waf_exclusions));
    }
  }
  return {
    events: page.map((r) => ({
      ...r,
      raw: parseRaw(r.raw),
      rule_excluded: !!(r.route_id != null && r.rule_id != null && exByRoute.has(r.route_id) && exByRoute.get(r.route_id).rule_ids.includes(r.rule_id)),
    })),
    next_cursor: more ? page[page.length - 1].id : null,
  };
}

// ─── Exclusions (write) ─────────────────────────────────

function syncToCaddy() { return require('./caddyConfig').syncToCaddy(); }

function loadHttpRoute(routeId) {
  const id = Number(routeId);
  if (!Number.isInteger(id) || id < 1) throw wafError('WAF_ROUTE_NOT_FOUND', 'route not found', 404);
  const row = getDb().prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!row) throw wafError('WAF_ROUTE_NOT_FOUND', 'route not found', 404);
  if (row.route_type === 'l4') throw wafError('WAF_REQUIRES_HTTP', 'the WAF is only available for HTTP routes');
  return row;
}

function exclusionInput(input) {
  const body = input || {};
  const hasRule = body.rule_id !== undefined && body.rule_id !== null && body.rule_id !== '';
  const hasPath = body.path !== undefined && body.path !== null && body.path !== '';
  if (!hasRule && !hasPath) throw wafError('WAF_EXCLUSION_REQUIRED', 'rule_id or path is required');
  return {
    rule_id: hasRule ? validateRuleId(body.rule_id) : null,
    path: hasPath ? validateExclusionPath(body.path) : null,
  };
}

async function writeExclusions(route, next, label) {
  const db = getDb();
  const snapshot = { ...route };
  const json = (next.rule_ids.length === 0 && next.paths.length === 0) ? null : JSON.stringify(next);
  db.prepare("UPDATE routes SET waf_exclusions = ?, updated_at = datetime('now') WHERE id = ?").run(json, route.id);
  await withCaddySync(syncToCaddy, () => restoreRouteRow(db, route.id, snapshot), label);
  try {
    require('./activity').log('waf_exclusions_changed', `WAF exclusions of "${route.domain}" changed`, {
      source: 'admin', severity: 'info', details: { routeId: route.id, rule_ids: next.rule_ids, paths: next.paths },
    });
  } catch { /* best-effort */ }
}

/** Add a rule-ID and/or path exclusion; idempotent. Returns { exclusions, changed }. */
async function addExclusion(routeId, input) {
  const route = loadHttpRoute(routeId);
  const add = exclusionInput(input);
  const cur = parseExclusions(route.waf_exclusions);
  const next = { rule_ids: [...cur.rule_ids], paths: [...cur.paths] };
  if (add.rule_id !== null && !next.rule_ids.includes(add.rule_id)) {
    if (next.rule_ids.length >= MAX_RULE_EXCLUSIONS) throw wafError('WAF_EXCLUSION_LIMIT', `at most ${MAX_RULE_EXCLUSIONS} rule exclusions per route`);
    next.rule_ids.push(add.rule_id);
    next.rule_ids.sort((a, b) => a - b);
  }
  if (add.path !== null && !next.paths.includes(add.path)) {
    if (next.paths.length >= MAX_PATH_EXCLUSIONS) throw wafError('WAF_EXCLUSION_LIMIT', `at most ${MAX_PATH_EXCLUSIONS} path exclusions per route`);
    next.paths.push(add.path);
  }
  const changed = next.rule_ids.length !== cur.rule_ids.length || next.paths.length !== cur.paths.length;
  if (changed) await writeExclusions(route, next, 'waf exclusion add');
  return { exclusions: next, changed };
}

/** Remove a rule-ID and/or path exclusion. 404 WAF_EXCLUSION_NOT_FOUND when none of them exists. */
async function removeExclusion(routeId, input) {
  const route = loadHttpRoute(routeId);
  const del = exclusionInput(input);
  const cur = parseExclusions(route.waf_exclusions);
  const next = {
    rule_ids: del.rule_id !== null ? cur.rule_ids.filter((id) => id !== del.rule_id) : [...cur.rule_ids],
    paths: del.path !== null ? cur.paths.filter((p) => p !== del.path) : [...cur.paths],
  };
  const changed = next.rule_ids.length !== cur.rule_ids.length || next.paths.length !== cur.paths.length;
  if (!changed) throw wafError('WAF_EXCLUSION_NOT_FOUND', 'exclusion not found', 404);
  await writeExclusions(route, next, 'waf exclusion remove');
  return { exclusions: next, changed };
}

// ─── Retention ──────────────────────────────────────────

function retentionDays() {
  const n = parseInt(settings.get('data.retention_waf_days', String(RETENTION_DEFAULT_DAYS)), 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 365) : RETENTION_DEFAULT_DAYS;
}

/** Delete events older than `days` (default: data.retention_waf_days) and above the row cap. */
function cleanup(days) {
  const d = Number.isInteger(days) && days >= 1 ? days : retentionDays();
  const db = getDb();
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  let removed = db.prepare('DELETE FROM waf_events WHERE ts < ?').run(cutoff).changes;
  const maxId = db.prepare('SELECT id FROM waf_events ORDER BY id DESC LIMIT 1 OFFSET ?').get(MAX_EVENT_ROWS);
  if (maxId) removed += db.prepare('DELETE FROM waf_events WHERE id <= ?').run(maxId.id).changes;
  return removed;
}

// ─── Lifecycle ──────────────────────────────────────────

function start({ watcher = true } = {}) {
  // Warm the engine cache off the request path (list-modules takes a moment).
  setImmediate(() => { try { engineAvailable(); } catch { /* logged */ } });
  if (watcher) {
    try { startWatcher(); } catch (err) { logger.warn({ err: err.message }, 'WAF audit log watcher not started'); }
  }
}

function stop() { stopWatcher(); }

module.exports = {
  WAF_MODES,
  PATH_RULE_BASE,
  PATH_RULE_SPAN,
  MAX_PATH_EXCLUSIONS,
  MAX_RULE_EXCLUSIONS,
  ROTATE_BYTES,
  ROTATE_KEEP,
  auditLogPath,
  parseExclusions,
  validateRuleId,
  validateExclusionPath,
  directivesFor,
  buildWafHandler,
  blockErrorRoutes,
  renderBlockPage,
  engineAvailable,
  modulesHaveWaf,
  parseAuditLine,
  parseErrorLog,
  redactMatchedData,
  eventsFromTransaction,
  ingestLines,
  pollOnce,
  startWatcher,
  stopWatcher,
  stats,
  status,
  listEvents,
  addExclusion,
  removeExclusion,
  retentionDays,
  cleanup,
  start,
  stop,
  _setEngineForTest,
};
