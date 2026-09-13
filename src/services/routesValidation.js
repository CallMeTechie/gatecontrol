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

module.exports = {
  validateIfProvided,
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
