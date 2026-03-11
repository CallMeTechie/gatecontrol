'use strict';

const session = require('express-session');
const { getDb } = require('../db/connection');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    // Bulk cleanup every 5 minutes for stale sessions
    this._cleanupInterval = setInterval(() => this._cleanup(), 300000);
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
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : 86400000;
      const expiresAt = Date.now() + maxAge;
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

  touch(sid, sessionData, callback) {
    try {
      const db = getDb();
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : 86400000;
      const expiresAt = Date.now() + maxAge;

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
