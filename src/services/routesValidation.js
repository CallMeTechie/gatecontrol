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

module.exports = {
  validateIfProvided,
  validateBrandingFields,
  validateBotBlockerConfig,
  VALID_BOT_MODES,
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
