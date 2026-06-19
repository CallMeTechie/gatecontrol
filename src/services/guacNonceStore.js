'use strict';

// In-memory, single-process only (see Phase 2a spec C7). Maps jti -> exp(ms).
// Consuming a jti deletes it (one-time). A periodic sweep drops expired entries.
const issued = new Map();

function register(jti, expEpochMs) {
  issued.set(jti, expEpochMs);
}

function consume(jti, nowMs = Date.now()) {
  const exp = issued.get(jti);
  if (exp === undefined) return false;     // unknown or already consumed
  issued.delete(jti);                       // one-time: remove regardless
  if (nowMs >= exp) return false;           // expired
  return true;
}

function _sweep(nowMs = Date.now()) {
  for (const [jti, exp] of issued) if (nowMs >= exp) issued.delete(jti);
}

function _clear() { issued.clear(); }

// Periodic cleanup; unref so it never holds the event loop open (tests).
const sweepTimer = setInterval(() => _sweep(), 60000);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = { register, consume, _sweep, _clear };
