'use strict';

/**
 * Input-validation helpers for the routes service. Each helper THROWS on
 * a constraint violation so the caller — create() / update() — can let
 * the exception propagate to the API layer untouched.
 *
 * Some helpers also normalise nested JSON (currently bot_blocker_config)
 * by mutating the caller's `data` object. That mutation is intentional
 * and matches the pre-refactor behaviour: the subsequent INSERT/UPDATE
 * statement reads `data.bot_blocker_config` and expects a string. A
 * future PR can flip this to a return-value pattern; this PR keeps the
 * semantics byte-stable.
 */

const VALID_BOT_MODES = ['block', 'tarpit', 'drop', 'garbage', 'redirect', 'custom'];

const BRANDING_TITLE_MAX = 255;
const BRANDING_TEXT_MAX = 2000;
const BOT_CUSTOM_MESSAGE_MAX = 500;

/**
 * PATCH-semantics helper for the update() path: run `validatorFn(value)`
 * only when the field is actually present on the patch payload (i.e.
 * `data[field] !== undefined`). The validator is expected to return an
 * error STRING on failure, or any falsy value on success — that matches
 * the contract used throughout src/utils/validate.js.
 *
 * Throws an Error with the validator's message on failure, otherwise
 * returns silently.
 *
 * Empty strings and zero ARE considered "provided" (only `undefined`
 * skips). That matches the existing inline pattern in update() — an
 * admin sending `target_port: 0` should hit the validator and get a
 * "must be 1-65535" error rather than being silently allowed because
 * 0 is falsy.
 */
function validateIfProvided(data, field, validatorFn) {
  if (data[field] === undefined) return;
  const err = validatorFn(data[field]);
  if (err) throw new Error(err);
}

function validateBrandingFields(data) {
  if (data.branding_title && data.branding_title.length > BRANDING_TITLE_MAX) {
    throw new Error(`Branding title must be ${BRANDING_TITLE_MAX} characters or less`);
  }
  if (data.branding_text && data.branding_text.length > BRANDING_TEXT_MAX) {
    throw new Error(`Branding text must be ${BRANDING_TEXT_MAX} characters or less`);
  }
}

/**
 * Validate bot-blocker mode + nested JSON config. Mutates `data.bot_blocker_config`
 * to a normalised JSON string when the original value was an object — the SQL
 * write below expects a string and the pre-refactor inline code did the same.
 */
function validateBotBlockerConfig(data) {
  if (data.bot_blocker_mode && !VALID_BOT_MODES.includes(data.bot_blocker_mode)) {
    throw new Error('Invalid bot blocker mode');
  }
  if (!data.bot_blocker_config) return;

  const bbCfg = (typeof data.bot_blocker_config === 'string'
    ? JSON.parse(data.bot_blocker_config)
    : data.bot_blocker_config) || {};

  if (data.bot_blocker_mode === 'redirect' && (!bbCfg.url || !/^https?:\/\//.test(bbCfg.url))) {
    throw new Error('Redirect mode requires a valid URL');
  }
  if (data.bot_blocker_mode === 'custom') {
    if (bbCfg.status_code && (bbCfg.status_code < 100 || bbCfg.status_code > 599)) {
      throw new Error('Invalid status code');
    }
    if (bbCfg.message && bbCfg.message.length > BOT_CUSTOM_MESSAGE_MAX) {
      throw new Error('Message too long');
    }
  }

  data.bot_blocker_config = typeof data.bot_blocker_config === 'string'
    ? data.bot_blocker_config
    : JSON.stringify(data.bot_blocker_config);
}

// ─── L4 protection (docs/feature-next-package.md §S1) ────
//
// The IP filter columns (ip_filter_enabled / _mode / _rules) now apply to L4
// entries as well. What changes for them:
//   - the mode is validated (`whitelist`/`allow`, `blacklist`/`deny`; the
//     historical spellings stay the stored ones)          → IP_FILTER_MODE_INVALID
//   - every ip/cidr rule has to parse                     → IP_FILTER_RULE_INVALID
//   - `country` rules are refused for L4 entries: caddy-l4 has no geo matcher
//     and silently ignoring them would leave the entry open
//                                                         → IP_FILTER_COUNTRY_L4
//   - the connection rate needs both fields in range      → L4_CONN_RATE_INVALID
// Errors carry statusCode 400 + code, like the HSTS ones.

const ipaddrLib = require('ipaddr.js');

const IP_FILTER_MODES = ['whitelist', 'blacklist', 'allow', 'deny'];
const IP_FILTER_RULE_TYPES = ['ip', 'cidr', 'country'];
const IP_FILTER_RULES_MAX = 200;
const L4_CONN_LIMIT_RANGE = [1, 100000];
const L4_CONN_WINDOW_RANGE = [1, 3600];

function codedError(code, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

/** 'allow' → 'whitelist', 'deny' → 'blacklist'; everything else unchanged. */
function normalizeIpFilterMode(mode) {
  if (mode === 'allow') return 'whitelist';
  if (mode === 'deny') return 'blacklist';
  return mode;
}

function isAddressValue(type, value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > 64) return false;
  try {
    if (type === 'cidr') {
      if (!s.includes('/')) return false;
      ipaddrLib.parseCIDR(s);
      return true;
    }
    return !s.includes('/') && ipaddrLib.isValid(s);
  } catch {
    return false;
  }
}

/**
 * Validate `ip_filter_mode` / `ip_filter_rules` on a create or update payload
 * and normalise the mode in place. Only touches what the payload provides.
 * `routeType` is the EFFECTIVE type of the row after the write.
 */
function validateIpFilter(data, { routeType } = {}) {
  if (data.ip_filter_mode !== undefined && data.ip_filter_mode !== null && data.ip_filter_mode !== '') {
    if (!IP_FILTER_MODES.includes(data.ip_filter_mode)) {
      throw codedError('IP_FILTER_MODE_INVALID', `ip_filter_mode must be one of ${IP_FILTER_MODES.join(', ')}`);
    }
    data.ip_filter_mode = normalizeIpFilterMode(data.ip_filter_mode);
  }

  if (data.ip_filter_rules === undefined || data.ip_filter_rules === null || data.ip_filter_rules === '') return;
  let rules = data.ip_filter_rules;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules); }
    catch { throw codedError('IP_FILTER_RULE_INVALID', 'ip_filter_rules must be a JSON array of { type, value }'); }
  }
  if (!Array.isArray(rules)) throw codedError('IP_FILTER_RULE_INVALID', 'ip_filter_rules must be an array of { type, value }');
  if (rules.length > IP_FILTER_RULES_MAX) {
    throw codedError('IP_FILTER_RULE_INVALID', `at most ${IP_FILTER_RULES_MAX} IP filter rules`);
  }
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || !IP_FILTER_RULE_TYPES.includes(rule.type)) {
      throw codedError('IP_FILTER_RULE_INVALID', `every IP filter rule needs a type (${IP_FILTER_RULE_TYPES.join(', ')}) and a value`);
    }
    if (rule.type === 'country') {
      if (routeType === 'l4') {
        throw codedError('IP_FILTER_COUNTRY_L4', 'country rules are not available for TCP/UDP entries — use IP or CIDR rules');
      }
      if (!/^[A-Za-z]{2}$/.test(String(rule.value || '').trim())) {
        throw codedError('IP_FILTER_RULE_INVALID', `"${String(rule.value).slice(0, 32)}" is not a two-letter country code`);
      }
      continue;
    }
    if (!isAddressValue(rule.type, rule.value)) {
      throw codedError('IP_FILTER_RULE_INVALID', `"${String(rule.value).slice(0, 64)}" is not a valid ${rule.type === 'cidr' ? 'CIDR range' : 'IP address'}`);
    }
  }
}

/**
 * Validate the connection rate (`l4_conn_limit`, `l4_conn_window_s`).
 * Both off (0 / '' / null) is always fine; a limit needs a window and only
 * exists on L4 entries. `current` is the stored row on update (so a patch may
 * set just one of the two).
 */
function validateL4ConnRate(data, { routeType, current = null } = {}) {
  const has = (f) => data[f] !== undefined;
  if (!has('l4_conn_limit') && !has('l4_conn_window_s')) return;

  const pick = (f) => {
    if (has(f)) {
      const raw = data[f];
      if (raw === null || raw === '' || raw === false) return 0;
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (!Number.isInteger(n) || n < 0) throw codedError('L4_CONN_RATE_INVALID', `${f} must be a non-negative integer`);
      return n;
    }
    return current && current[f] ? Number(current[f]) : 0;
  };
  const limit = pick('l4_conn_limit');
  const windowS = pick('l4_conn_window_s');

  if (limit === 0 && windowS === 0) return;
  if (routeType !== 'l4') {
    throw codedError('L4_CONN_RATE_INVALID', 'a connection rate is only available for TCP/UDP entries');
  }
  if (limit === 0 || windowS === 0) {
    throw codedError('L4_CONN_RATE_INVALID', 'l4_conn_limit and l4_conn_window_s belong together — set both or neither');
  }
  if (limit < L4_CONN_LIMIT_RANGE[0] || limit > L4_CONN_LIMIT_RANGE[1]) {
    throw codedError('L4_CONN_RATE_INVALID', `l4_conn_limit must be an integer between ${L4_CONN_LIMIT_RANGE[0]} and ${L4_CONN_LIMIT_RANGE[1]}`);
  }
  if (windowS < L4_CONN_WINDOW_RANGE[0] || windowS > L4_CONN_WINDOW_RANGE[1]) {
    throw codedError('L4_CONN_RATE_INVALID', `l4_conn_window_s must be an integer between ${L4_CONN_WINDOW_RANGE[0]} and ${L4_CONN_WINDOW_RANGE[1]}`);
  }
}

// ─── HSTS (docs/feature-hsts.md) ─────────────────────────
//
// Rules shared by routes.create/update and domainZones.updateDefaults:
//   - max_age is an integer 300 … 63072000            → HSTS_MAX_AGE_INVALID
//   - preload needs includeSubDomains and ≥ 1 year     → HSTS_PRELOAD_REQUIREMENTS
//   - enabled needs an HTTP route with https_enabled   → HSTS_REQUIRES_HTTPS
// Errors carry statusCode 400 + code so both API layers answer with the code.

const HSTS_MAX_AGE_MIN = 300;
const HSTS_MAX_AGE_MAX = 63072000;
const HSTS_MAX_AGE_DEFAULT = 31536000;
const HSTS_PRELOAD_MIN_MAX_AGE = 31536000;

function hstsError(code, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

function hstsFlag(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string') return (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'on') ? 1 : 0;
  return v ? 1 : 0;
}

/** Parse a max-age input; throws HSTS_MAX_AGE_INVALID when out of range. */
function validateHstsMaxAge(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < HSTS_MAX_AGE_MIN || n > HSTS_MAX_AGE_MAX) {
    throw hstsError('HSTS_MAX_AGE_INVALID', `hsts_max_age must be an integer between ${HSTS_MAX_AGE_MIN} and ${HSTS_MAX_AGE_MAX}`);
  }
  return n;
}

/**
 * Validate the EFFECTIVE HSTS state of a route row. `fields` uses the
 * routes column names (integers 0/1); `route_type` and `https_enabled`
 * decide whether HSTS may be on at all.
 */
function validateHstsRules({ hsts_enabled, hsts_max_age, hsts_subdomains, hsts_preload, route_type, https_enabled }) {
  const maxAge = validateHstsMaxAge(hsts_max_age);
  if (hsts_preload && (!hsts_subdomains || maxAge < HSTS_PRELOAD_MIN_MAX_AGE)) {
    throw hstsError('HSTS_PRELOAD_REQUIREMENTS', `hsts_preload requires hsts_subdomains and hsts_max_age >= ${HSTS_PRELOAD_MIN_MAX_AGE}`);
  }
  if (hsts_enabled && ((route_type || 'http') !== 'http' || !https_enabled)) {
    throw hstsError('HSTS_REQUIRES_HTTPS', 'hsts_enabled requires an HTTP route with https_enabled');
  }
  return maxAge;
}

/**
 * Resolve the hsts_* columns for a write. `data` is the incoming payload
 * (fields may be absent), `current` the stored row (create: defaults).
 * Turning HTTPS off (or leaving it off) silently clears an INHERITED
 * hsts_enabled; an EXPLICIT hsts_enabled=1 without HTTPS is rejected.
 * Returns { hsts_enabled, hsts_max_age, hsts_subdomains, hsts_preload }.
 */
function resolveHstsFields(data, current, { route_type, https_enabled }) {
  const cur = current || {};
  const pick = (field, fallback) => (data[field] !== undefined ? data[field] : (cur[field] !== undefined && cur[field] !== null ? cur[field] : fallback));
  const explicitEnabled = data.hsts_enabled !== undefined;
  let enabled = hstsFlag(pick('hsts_enabled', 0));
  const httpsOn = (route_type || 'http') === 'http' && !!https_enabled;
  if (!explicitEnabled && !httpsOn) enabled = 0;
  const fields = {
    hsts_enabled: enabled,
    hsts_max_age: pick('hsts_max_age', HSTS_MAX_AGE_DEFAULT),
    hsts_subdomains: hstsFlag(pick('hsts_subdomains', 0)),
    hsts_preload: hstsFlag(pick('hsts_preload', 0)),
  };
  fields.hsts_max_age = validateHstsRules({ ...fields, route_type, https_enabled });
  return fields;
}

/** True when the payload carries any hsts_* field (explicit choice). */
function hasHstsInput(data) {
  return ['hsts_enabled', 'hsts_max_age', 'hsts_subdomains', 'hsts_preload'].some((k) => data[k] !== undefined);
}

/** Header value: max-age=<n>[; includeSubDomains][; preload]. */
function hstsHeaderValue({ max_age, include_subdomains, preload }) {
  let v = 'max-age=' + Number(max_age);
  if (include_subdomains) v += '; includeSubDomains';
  if (preload) v += '; preload';
  return v;
}

/**
 * Validate and normalise a zone default ({ enabled, max_age,
 * include_subdomains, preload } or null = off). Returns the normalised
 * object or null. Throws the HSTS_* errors above.
 */
function normalizeHstsDefault(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw hstsError('HSTS_MAX_AGE_INVALID', 'hsts_default must be an object or null');
  }
  const out = {
    enabled: !!hstsFlag(input.enabled),
    max_age: input.max_age === undefined ? HSTS_MAX_AGE_DEFAULT : input.max_age,
    include_subdomains: !!hstsFlag(input.include_subdomains),
    preload: !!hstsFlag(input.preload),
  };
  out.max_age = validateHstsRules({
    hsts_enabled: 0, hsts_max_age: out.max_age, hsts_subdomains: out.include_subdomains ? 1 : 0,
    hsts_preload: out.preload ? 1 : 0, route_type: 'http', https_enabled: 1,
  });
  return out;
}

/** domains.hsts_default (JSON text) → object | null; never throws. */
function parseHstsDefault(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    return {
      enabled: !!obj.enabled,
      max_age: Number.isInteger(obj.max_age) ? obj.max_age : HSTS_MAX_AGE_DEFAULT,
      include_subdomains: !!obj.include_subdomains,
      preload: !!obj.preload,
    };
  } catch {
    return null;
  }
}

/** routes row → API object { enabled, max_age, include_subdomains, preload }. */
function hstsOfRoute(row) {
  return {
    enabled: !!row.hsts_enabled,
    max_age: Number.isInteger(row.hsts_max_age) ? row.hsts_max_age : HSTS_MAX_AGE_DEFAULT,
    include_subdomains: !!row.hsts_subdomains,
    preload: !!row.hsts_preload,
  };
}

/** Zone default object → routes column values. */
function hstsDefaultToFields(def) {
  if (!def) return { hsts_enabled: 0, hsts_max_age: HSTS_MAX_AGE_DEFAULT, hsts_subdomains: 0, hsts_preload: 0 };
  return {
    hsts_enabled: def.enabled ? 1 : 0,
    hsts_max_age: def.max_age,
    hsts_subdomains: def.include_subdomains ? 1 : 0,
    hsts_preload: def.preload ? 1 : 0,
  };
}

// ─── Security options (docs/feature-security-options.md) ─
//
// Rules shared by routes.create/update and the API:
//   B  backend_tls_verify / backend_tls_server_name / backend_tls_ca_pem
//        CA must parse as one or more PEM certificates → BACKEND_CA_INVALID
//        server name must be a hostname              → BACKEND_SERVER_NAME_INVALID
//   D  max_body_mb: integer 0 … 4096 (0 = unlimited) → MAX_BODY_INVALID
//   E  domains.tls_min_version: '1.2' | '1.3'        → TLS_MIN_VERSION_INVALID
//   F  mtls_enabled needs an HTTP route with HTTPS   → MTLS_REQUIRES_HTTPS
//        and a parsable CA PEM                       → MTLS_CA_INVALID
//        mtls_mode: 'require' only                   → MTLS_MODE_INVALID
// Errors carry statusCode 400 + code like the HSTS ones.

const MAX_BODY_MB_MAX = 4096;
const TLS_MIN_VERSIONS = ['1.2', '1.3'];
const MTLS_MODES = ['require'];
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function secError(code, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

/**
 * Parse a PEM text with one or more certificates (crypto.X509Certificate).
 * Returns { pem, count } with the certificates re-joined one per block and
 * a trailing newline; throws a plain Error when nothing parses.
 */
function parsePemCertificates(pem) {
  const crypto = require('node:crypto');
  const text = String(pem == null ? '' : pem).replace(/\r\n?/g, '\n').trim();
  const blocks = text.match(PEM_CERT_RE);
  if (!blocks || blocks.length === 0) throw new Error('no PEM certificate block found');
  for (const block of blocks) {
    // Throws on a malformed block ("error:0480006C:PEM routines::no start line" etc.).
    new crypto.X509Certificate(block); // eslint-disable-line no-new
  }
  return { pem: blocks.join('\n') + '\n', count: blocks.length };
}

/** Empty → null; otherwise the normalised PEM or a coded 400. */
function normalizeCaPem(value, code) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return parsePemCertificates(text).pem;
  } catch (err) {
    throw secError(code, 'CA must be one or more PEM certificates (' + err.message + ')');
  }
}

/** Parse max_body_mb; '' / null / undefined mean 0 (unlimited). */
function validateMaxBodyMb(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < 0 || n > MAX_BODY_MB_MAX) {
    throw secError('MAX_BODY_INVALID', `max_body_mb must be an integer between 0 and ${MAX_BODY_MB_MAX} (0 = unlimited)`);
  }
  return n;
}

/** Optional hostname for backend certificate verification / SNI. */
function validateBackendServerName(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (!HOSTNAME_RE.test(s)) throw secError('BACKEND_SERVER_NAME_INVALID', 'backend_tls_server_name must be a hostname');
  return s;
}

function validateTlsMinVersion(value) {
  const v = value === undefined || value === null ? '1.2' : String(value).trim();
  if (!TLS_MIN_VERSIONS.includes(v)) throw secError('TLS_MIN_VERSION_INVALID', "tls_min_version must be '1.2' or '1.3'");
  return v;
}

function validateMtlsMode(value) {
  const v = value === undefined || value === null || value === '' ? 'require' : String(value).trim();
  if (!MTLS_MODES.includes(v)) throw secError('MTLS_MODE_INVALID', "mtls_mode must be 'require'");
  return v;
}

/**
 * Resolve the security-option columns for a write. `data` is the incoming
 * payload (fields may be absent), `current` the stored row (create: null).
 * Like HSTS: turning HTTPS off clears an INHERITED mtls_enabled, an EXPLICIT
 * mtls_enabled=1 without HTTPS is rejected. Returns the seven columns.
 */
function resolveSecurityFields(data, current, { route_type, https_enabled }) {
  const cur = current || {};
  const given = (field) => data[field] !== undefined;
  const pick = (field, fallback) => (given(field) ? data[field] : (cur[field] !== undefined && cur[field] !== null ? cur[field] : fallback));
  const httpsOn = (route_type || 'http') === 'http' && !!https_enabled;

  const fields = {
    backend_tls_verify: hstsFlag(pick('backend_tls_verify', 0)),
    backend_tls_server_name: given('backend_tls_server_name') ? validateBackendServerName(data.backend_tls_server_name) : (cur.backend_tls_server_name || null),
    backend_tls_ca_pem: given('backend_tls_ca_pem') ? normalizeCaPem(data.backend_tls_ca_pem, 'BACKEND_CA_INVALID') : (cur.backend_tls_ca_pem || null),
    max_body_mb: given('max_body_mb') ? validateMaxBodyMb(data.max_body_mb) : validateMaxBodyMb(cur.max_body_mb),
    mtls_enabled: hstsFlag(pick('mtls_enabled', 0)),
    mtls_ca_pem: given('mtls_ca_pem') ? normalizeCaPem(data.mtls_ca_pem, 'MTLS_CA_INVALID') : (cur.mtls_ca_pem || null),
    mtls_mode: validateMtlsMode(pick('mtls_mode', 'require')),
  };
  if (fields.mtls_enabled && !httpsOn) {
    if (given('mtls_enabled')) throw secError('MTLS_REQUIRES_HTTPS', 'mtls_enabled requires an HTTP route with https_enabled');
    fields.mtls_enabled = 0;
  }
  if (fields.mtls_enabled && !fields.mtls_ca_pem) {
    throw secError('MTLS_CA_INVALID', 'mtls_ca_pem (PEM, one or more certificates) is required when mtls_enabled is set');
  }
  return fields;
}

// ─── Web Application Firewall (docs/feature-waf.md) ─────
//
//   waf_enabled   HTTP routes only                    → WAF_REQUIRES_HTTP
//   waf_mode      'detect' | 'block'                  → WAF_MODE_INVALID
//   waf_paranoia  integer 1 … 4                       → WAF_PARANOIA_INVALID
// waf_exclusions is not a route write field — it is managed by
// POST/DELETE /api/v1/waf/routes/:id/exclusions (services/waf.js).

const WAF_MODES = ['detect', 'block'];
const WAF_PARANOIA_MIN = 1;
const WAF_PARANOIA_MAX = 4;

function wafError(code, message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

function validateWafMode(value) {
  const v = value === undefined || value === null || value === '' ? 'detect' : String(value).trim();
  if (!WAF_MODES.includes(v)) throw wafError('WAF_MODE_INVALID', "waf_mode must be 'detect' or 'block'");
  return v;
}

function validateWafParanoia(value) {
  if (value === undefined || value === null || value === '') return WAF_PARANOIA_MIN;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < WAF_PARANOIA_MIN || n > WAF_PARANOIA_MAX) {
    throw wafError('WAF_PARANOIA_INVALID', `waf_paranoia must be an integer between ${WAF_PARANOIA_MIN} and ${WAF_PARANOIA_MAX}`);
  }
  return n;
}

/**
 * Resolve the WAF columns for a write (same PATCH semantics as the security
 * options: absent field = keep the stored value). An EXPLICIT waf_enabled on
 * an L4 route is rejected; an inherited one is cleared when the route turns
 * into L4. Returns { waf_enabled, waf_mode, waf_paranoia }.
 */
function resolveWafFields(data, current, { route_type }) {
  const cur = current || {};
  const given = (field) => data[field] !== undefined;
  const pick = (field, fallback) => (given(field) ? data[field] : (cur[field] !== undefined && cur[field] !== null ? cur[field] : fallback));
  const fields = {
    waf_enabled: hstsFlag(pick('waf_enabled', 0)),
    waf_mode: validateWafMode(pick('waf_mode', 'detect')),
    waf_paranoia: validateWafParanoia(pick('waf_paranoia', WAF_PARANOIA_MIN)),
  };
  if (fields.waf_enabled && (route_type || 'http') !== 'http') {
    if (given('waf_enabled')) throw wafError('WAF_REQUIRES_HTTP', 'waf_enabled requires an HTTP route');
    fields.waf_enabled = 0;
  }
  return fields;
}

/** True when the payload carries any waf_* write field (explicit choice). */
function hasWafInput(data) {
  return ['waf_enabled', 'waf_mode', 'waf_paranoia'].some((k) => data[k] !== undefined);
}

/**
 * WAF switch/mode changed between two column sets? (routes.waf_mode_changed_at
 * is stamped on every change of waf_enabled or waf_mode — release B §3.)
 */
function wafModeChanged(before, after) {
  const b = before || {};
  return (b.waf_enabled ? 1 : 0) !== (after.waf_enabled ? 1 : 0)
    || String(b.waf_mode || 'detect') !== String(after.waf_mode || 'detect');
}

/**
 * Zone WAF default (release B §2): { enabled, mode, paranoia } or null (= no
 * default). Throws the WAF_* codes above.
 */
function normalizeWafDefault(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw wafError('WAF_DEFAULT_INVALID', 'waf_default must be an object or null');
  }
  return {
    enabled: !!hstsFlag(input.enabled),
    mode: validateWafMode(input.mode),
    paranoia: validateWafParanoia(input.paranoia),
  };
}

/** domains.waf_default (JSON text) → object | null; never throws. */
function parseWafDefault(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return {
      enabled: !!obj.enabled,
      mode: WAF_MODES.includes(obj.mode) ? obj.mode : 'detect',
      paranoia: Number.isInteger(obj.paranoia) && obj.paranoia >= WAF_PARANOIA_MIN && obj.paranoia <= WAF_PARANOIA_MAX ? obj.paranoia : WAF_PARANOIA_MIN,
    };
  } catch {
    return null;
  }
}

/** Zone default object → routes column values (null / disabled → WAF off). */
function wafDefaultToFields(def) {
  if (!def || !def.enabled) return { waf_enabled: 0, waf_mode: def ? def.mode : 'detect', waf_paranoia: def ? def.paranoia : WAF_PARANOIA_MIN };
  return { waf_enabled: 1, waf_mode: def.mode, waf_paranoia: def.paranoia };
}

// ─── Gateway backend TLS fingerprint (release B §13b) ───
//
// routes.backend_tls_fingerprint: SHA-256 of the LAN certificate the gateway
// should pin, stored as 64 lower-case hex characters. Input with or without
// colons (AA:BB:… as browsers/openssl print it), case-insensitive, optional
// "sha256:" / "SHA256=" prefix. Only for gateway HTTP routes with
// backend_https — an explicit value elsewhere → 400, an inherited one is
// cleared when the route stops qualifying (HSTS-style PATCH semantics).

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Parse a fingerprint input; '' / null → null; throws BACKEND_TLS_FINGERPRINT_INVALID. */
function normalizeBackendFingerprint(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^sha-?256\s*[:=]\s*/, '');
  const hex = s.replace(/[:\s-]/g, '');
  if (!FINGERPRINT_RE.test(hex)) {
    throw secError('BACKEND_TLS_FINGERPRINT_INVALID', 'backend_tls_fingerprint must be a SHA-256 fingerprint (64 hex characters, colons allowed)');
  }
  return hex;
}

/**
 * Resolve routes.backend_tls_fingerprint for a write. `data` is the payload,
 * `current` the stored row (create: null), `effective` the route's state
 * after the write ({ route_type, target_kind, backend_https }).
 */
function resolveBackendFingerprint(data, current, { route_type, target_kind, backend_https }) {
  const given = data.backend_tls_fingerprint !== undefined;
  const value = given ? normalizeBackendFingerprint(data.backend_tls_fingerprint) : ((current && current.backend_tls_fingerprint) || null);
  if (!value) return null;
  const qualifies = (route_type || 'http') === 'http' && target_kind === 'gateway' && !!backend_https;
  if (!qualifies) {
    if (given) throw secError('BACKEND_TLS_FINGERPRINT_INVALID', 'backend_tls_fingerprint requires a gateway HTTP route with backend_https');
    return null;
  }
  return value;
}

module.exports = {
  hasWafInput,
  wafModeChanged,
  normalizeWafDefault,
  parseWafDefault,
  wafDefaultToFields,
  normalizeBackendFingerprint,
  resolveBackendFingerprint,
  validateIfProvided,
  validateIpFilter,
  validateL4ConnRate,
  normalizeIpFilterMode,
  IP_FILTER_MODES,
  IP_FILTER_RULE_TYPES,
  L4_CONN_LIMIT_RANGE,
  L4_CONN_WINDOW_RANGE,
  WAF_MODES,
  WAF_PARANOIA_MIN,
  WAF_PARANOIA_MAX,
  validateWafMode,
  validateWafParanoia,
  resolveWafFields,
  validateBrandingFields,
  validateBotBlockerConfig,
  VALID_BOT_MODES,
  MAX_BODY_MB_MAX,
  TLS_MIN_VERSIONS,
  parsePemCertificates,
  normalizeCaPem,
  validateMaxBodyMb,
  validateBackendServerName,
  validateTlsMinVersion,
  validateMtlsMode,
  resolveSecurityFields,
  HSTS_MAX_AGE_MIN,
  HSTS_MAX_AGE_MAX,
  HSTS_MAX_AGE_DEFAULT,
  HSTS_PRELOAD_MIN_MAX_AGE,
  validateHstsMaxAge,
  validateHstsRules,
  resolveHstsFields,
  hasHstsInput,
  hstsHeaderValue,
  normalizeHstsDefault,
  parseHstsDefault,
  hstsOfRoute,
  hstsDefaultToFields,
};
