'use strict';

// Retry plan of the licence checks (GateControl licence and third-party
// plugin licences). A check that failed because the server could not be
// reached — network error, timeout, 5xx, 429 — is repeated after 5 min,
// 15 min, 1 h and then hourly until it succeeds; afterwards the normal daily
// rhythm applies again. A 4xx answer is a decision of the server, never retried
// early. A 429 with Retry-After waits at least as long as the server asks.

const BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** Delay before retry number `attempt` (1 = first retry after the first failure). */
function backoffDelay(attempt, retryAfterMs = null) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1];
  const asked = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_WAIT_MS) : 0;
  return Math.max(base, asked);
}

/** Retry-After (seconds or HTTP date) → ms, null when missing or unreadable. */
function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(Array.isArray(value) ? value[0] : value).trim();
  if (!s) return null;
  if (/^\d{1,10}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** An HTTP status worth retrying soon: 5xx and 429. */
function retryableStatus(status) {
  return Number.isInteger(status) && (status >= 500 || status === 429);
}

/**
 * Short, harmless reason of a failed request: "timeout", "ENOTFOUND",
 * "ECONNREFUSED", … — never a URL, a key or response content.
 */
function networkReason(err) {
  if (!err) return 'network error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message === 'timeout') return 'timeout';
  const code = (err.cause && err.cause.code) || err.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
    return /TIMEOUT/.test(code) ? 'timeout' : code;
  }
  return 'network error';
}

module.exports = { BACKOFF_MS, backoffDelay, parseRetryAfter, retryableStatus, networkReason };
