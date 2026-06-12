'use strict';

const session = require('express-session');
const { getDb } = require('../db/connection');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    // Bulk cleanup every 5 minutes for stale sessions
    this._cleanupInterval = setInterval(() => this._cleanup(), 300000);
  }

  _expiresAt(sessionData) {
    const maxAge = sessionData.cookie && sessionData.cookie.maxAge
      ? sessionData.cookie.maxAge
      : 86400000;
    return Date.now() + maxAge;
  }

  get(sid, callback) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        // Immediately purge expired session on access
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const db = getDb();
      const expiresAt = this._expiresAt(sessionData);
      const data = JSON.stringify(sessionData);

      db.prepare(`
        INSERT INTO sessions (sid, data, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `).run(sid, data, expiresAt);

      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      const db = getDb();
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Delete every session belonging to a user, optionally keeping one sid
  // alive (the caller's current session). Used to force-logout other devices
  // after a password change or when an account is disabled. Returns the
  // number of sessions removed. The userId lives inside the JSON `data` blob
  // (there is no dedicated column), so we match it with json_extract.
  destroyByUserId(userId, exceptSid = null) {
    try {
      const db = getDb();
      if (exceptSid) {
        return db.prepare(
          "DELETE FROM sessions WHERE sid != ? AND json_extract(data, '$.userId') = ?"
        ).run(exceptSid, userId).changes;
      }
      return db.prepare(
        "DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?"
      ).run(userId).changes;
    } catch (err) {
      const logger = require('../utils/logger');
      logger.error({ err: err.message, userId }, 'Failed to destroy sessions by userId');
      return 0;
    }
  }

  touch(sid, sessionData, callback) {
    try {
      const db = getDb();
      const expiresAt = this._expiresAt(sessionData);

      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  _cleanup() {
    try {
      const db = getDb();
      const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      if (result.changes > 0) {
        const logger = require('../utils/logger');
        logger.debug({ count: result.changes }, 'Cleaned up expired sessions');
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  close() {
    clearInterval(this._cleanupInterval);
  }
}

module.exports = SQLiteStore;
