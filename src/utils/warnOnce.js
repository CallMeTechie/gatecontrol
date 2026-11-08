'use strict';

// The same warning again and again (GitHub down for an hour: one line per
// request, seven a minute) says nothing new. throttled() writes a key's line
// once per window; the repeats are counted and the next line says how many
// there were (`repeated`). recovered() ends an outage: the next failure is
// written at once, and the caller may log one line that it works again.

const logger = require('./logger');

const WINDOW_MS = 5 * 60 * 1000;
const KEYS_MAX = 500;
const seen = new Map(); // key → { at, repeated, first }

/**
 * logger[level](fields, msg) — unless the same `key` was written less than
 * `everyMs` ago (then only counted). → true when the line was written.
 */
function throttled(key, fields, msg, { everyMs = WINDOW_MS, level = 'warn', now = Date.now() } = {}) {
  const e = seen.get(key);
  if (e && now - e.at < everyMs) { e.repeated++; return false; }
  const extra = e && e.repeated ? { repeated: e.repeated, sinceMs: now - e.first } : {};
  seen.set(key, { at: now, repeated: 0, first: e ? e.first : now });
  if (seen.size > KEYS_MAX) seen.delete(seen.keys().next().value);
  logger[level]({ ...(fields || {}), ...extra }, msg);
  return true;
}

/** The trouble of `key` is over. → { since, repeated } when it was failing (to log one "works again"), else null. */
function recovered(key, now = Date.now()) {
  const e = seen.get(key);
  if (!e) return null;
  seen.delete(key);
  return { sinceMs: now - e.first, repeated: e.repeated };
}

function _resetForTest() { seen.clear(); }

module.exports = { throttled, recovered, WINDOW_MS, _resetForTest };
