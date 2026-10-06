'use strict';

/**
 * Login sessions of an account, read from the session store table
 * (middleware/sessionStore.js keeps the session JSON in sessions.data).
 *
 * The session id is the bearer secret of the cookie, so it never leaves the
 * server: every session is addressed by a short SHA-256 digest of it
 * (`ref`). Listing and signing out always filter by the account as well, so
 * a ref of another user's session never matches.
 */

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');

const REF_LEN = 24;

function refOf(sid) {
  return crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, REF_LEN);
}

function parse(data) {
  try { return JSON.parse(data) || {}; } catch { return {}; }
}

/** Browser + OS from a user agent, coarse ("Firefox", "Windows"). */
function describeAgent(ua) {
  const s = String(ua || '');
  if (!s) return { browser: null, os: null };
  let browser = null;
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let os = null;
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(s)) os = /iPad/.test(s) ? 'iPad' : 'iPhone';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser, os };
}

/**
 * Active sessions of `userId`, newest first. `currentSid` marks the
 * caller's own session.
 */
function list(userId, currentSid = null) {
  const db = getDb();
  const rows = db.prepare(`SELECT sid, data, expires_at, created_at FROM sessions
    WHERE expires_at > ? AND json_valid(data) AND json_extract(data, '$.userId') = ?`).all(Date.now(), userId);
  return rows.map((r) => {
    const d = parse(r.data);
    const agent = describeAgent(d.ua);
    return {
      ref: refOf(r.sid),
      current: currentSid != null && r.sid === currentSid,
      method: ['password', 'totp', 'passkey'].includes(d.authMethod) ? d.authMethod : null,
      since: Number(d.authAt) || null,
      browser: agent.browser,
      os: agent.os,
      ip: typeof d.ip === 'string' ? d.ip.slice(0, 64) : null,
      expires_at: r.expires_at,
    };
  }).sort((a, b) => (b.since || 0) - (a.since || 0));
}

/** Sign out one session of `userId` by its ref. Returns true when one was removed. */
function destroyByRef(userId, ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{8,64}$/.test(ref)) return false;
  const db = getDb();
  const rows = db.prepare(`SELECT sid FROM sessions WHERE json_valid(data) AND json_extract(data, '$.userId') = ?`).all(userId);
  const hit = rows.find((r) => refOf(r.sid) === ref);
  if (!hit) return false;
  return db.prepare('DELETE FROM sessions WHERE sid = ?').run(hit.sid).changes > 0;
}

module.exports = { list, destroyByRef, refOf, describeAgent };
