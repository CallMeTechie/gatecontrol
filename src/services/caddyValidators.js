'use strict';

// Caddy-Defender bot-blocker provider ranges. Override via
// GC_BOT_BLOCKER_RANGES (comma list).
const DEFAULT_BOT_BLOCKER_RANGES = Object.freeze([
  'openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud',
]);
const BOT_BLOCKER_RANGES = Object.freeze(
  (process.env.GC_BOT_BLOCKER_RANGES || '').split(',').map(s => s.trim()).filter(Boolean).length > 0
    ? process.env.GC_BOT_BLOCKER_RANGES.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_BOT_BLOCKER_RANGES
);

// Escape user-supplied strings that land in Caddy response bodies so they
// cannot inject HTML into the error page served to blocked bots/humans.
function escapeHtmlForDefender(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDefenderConfig(route) {
  const defenderConfig = {
    handler: 'defender',
    raw_responder: route.bot_blocker_mode || 'block',
    ranges: [...BOT_BLOCKER_RANGES],
  };
  const bbConfig = (route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : null) || {};
  if (bbConfig.message) defenderConfig.message = escapeHtmlForDefender(String(bbConfig.message));
  if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
  if (bbConfig.url) defenderConfig.url = bbConfig.url;
  return defenderConfig;
}

// Parse comma-separated HTTP status codes (e.g. "502,503,504") from
// route.retry_match_status. Drops non-numeric tokens and out-of-range
// codes silently. Returns a de-duplicated number array.
function parseStatusCodes(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const token of csv.split(',')) {
    const n = parseInt(token.trim(), 10);
    if (!Number.isInteger(n) || n < 100 || n > 599) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

const HEADER_NAME_RE = /^[a-zA-Z0-9\-]+$/;
const CADDY_PLACEHOLDER_RE = /\{[^}]+\}/;
const VALID_RATE_WINDOWS = ['1s', '1m', '5m', '1h'];
const STICKY_COOKIE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;

function isValidHeaderName(name) {
  return typeof name === 'string' && name.length <= 256 && HEADER_NAME_RE.test(name);
}

// Custom headers (docs/feature-domain-zones.md, "Header-Vorlagen"): a name
// with a leading '-' removes that header instead of setting it (Caddyfile
// `header -Server`). The rest must be a plain token that starts with a letter
// or digit, so '--x' or a bare '-' never reach the config.
const HEADER_DELETE_RE = /^-[a-zA-Z0-9][a-zA-Z0-9-]*$/;
function isHeaderDeletion(name) {
  return typeof name === 'string' && name.length <= 257 && HEADER_DELETE_RE.test(name);
}

// Request-derived placeholders a header value may carry (the "Reverse-Proxy-
// Infos" preset). Caddy's JSON config only knows the long forms, so the short
// Caddyfile spellings are written into the config expanded. Every other
// {...} stays rejected: {env.*}, {file.*}, {http.request.header.*} and friends
// would let a value read server state or secrets.
const HEADER_PLACEHOLDERS = Object.freeze({
  '{host}': '{http.request.host}',
  '{remote_host}': '{http.request.remote.host}',
  '{scheme}': '{http.request.scheme}',
});
const HEADER_PLACEHOLDER_TOKEN_RE = /\{(?:host|remote_host|scheme)\}/g;

function isValidHeaderValue(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  // CR/LF/NUL would split the header (Caddy refuses them too).
  if (/[\r\n\0]/.test(value)) return false;
  return !CADDY_PLACEHOLDER_RE.test(value.replace(HEADER_PLACEHOLDER_TOKEN_RE, ''));
}

// Value as written into the Caddy config: allowed short placeholders expanded.
function expandHeaderValue(value) {
  return String(value).replace(HEADER_PLACEHOLDER_TOKEN_RE, (tok) => HEADER_PLACEHOLDERS[tok]);
}

function sanitizeRateWindow(window) {
  return VALID_RATE_WINDOWS.includes(window) ? window : '1m';
}

function sanitizeStickyCookieName(name) {
  return (typeof name === 'string' && STICKY_COOKIE_NAME_RE.test(name)) ? name : 'gc_sticky';
}

module.exports = {
  CADDY_PLACEHOLDER_RE,
  BOT_BLOCKER_RANGES,
  escapeHtmlForDefender,
  buildDefenderConfig,
  parseStatusCodes,
  isValidHeaderName,
  isValidHeaderValue,
  isHeaderDeletion,
  expandHeaderValue,
  HEADER_PLACEHOLDERS,
  sanitizeRateWindow,
  sanitizeStickyCookieName,
};
