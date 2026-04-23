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

function isValidHeaderValue(value) {
  return typeof value === 'string' && value.length <= 4096 && !CADDY_PLACEHOLDER_RE.test(value);
}

function sanitizeRateWindow(window) {
  return VALID_RATE_WINDOWS.includes(window) ? window : '1m';
}

function sanitizeStickyCookieName(name) {
  return (typeof name === 'string' && STICKY_COOKIE_NAME_RE.test(name)) ? name : 'gc_sticky';
}

module.exports = {
  BOT_BLOCKER_RANGES,
  escapeHtmlForDefender,
  buildDefenderConfig,
  parseStatusCodes,
  isValidHeaderName,
  isValidHeaderValue,
  sanitizeRateWindow,
  sanitizeStickyCookieName,
};
