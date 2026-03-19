'use strict';

const { getDb } = require('./connection');
const logger = require('../utils/logger');

function runMigrations() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      language TEXT DEFAULT 'en',
      theme TEXT DEFAULT 'default',
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      public_key TEXT NOT NULL UNIQUE,
      private_key_encrypted TEXT,
      preshared_key_encrypted TEXT,
      allowed_ips TEXT NOT NULL,
      endpoint TEXT,
      dns TEXT,
      persistent_keepalive INTEGER DEFAULT 25,
      enabled INTEGER NOT NULL DEFAULT 1,
      transfer_rx INTEGER DEFAULT 0,
      transfer_tx INTEGER DEFAULT 0,
      latest_handshake INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      target_ip TEXT NOT NULL,
      target_port INTEGER NOT NULL,
      description TEXT,
      peer_id INTEGER,
      https_enabled INTEGER NOT NULL DEFAULT 1,
      basic_auth_enabled INTEGER NOT NULL DEFAULT 0,
      basic_auth_user TEXT,
      basic_auth_password_hash TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      source TEXT,
      ip_address TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS traffic_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_bytes INTEGER NOT NULL,
      download_bytes INTEGER NOT NULL,
      peer_count INTEGER NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_recorded ON traffic_snapshots(recorded_at);
  `);

  // Add backend_https column if missing
  try {
    db.exec(`ALTER TABLE routes ADD COLUMN backend_https INTEGER NOT NULL DEFAULT 0`);
    logger.info('Added backend_https column to routes');
  } catch (e) {
    // Column already exists
  }

  // Add webhooks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '*',
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add tags column to peers if missing
  try {
    db.exec(`ALTER TABLE peers ADD COLUMN tags TEXT DEFAULT ''`);
    logger.info('Added tags column to peers');
  } catch (e) {
    // Column already exists
  }

  // Migration: Add Layer 4 routing support
  try {
    db.exec(`ALTER TABLE routes ADD COLUMN route_type TEXT NOT NULL DEFAULT 'http'`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_protocol TEXT`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_listen_port TEXT`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_tls_mode TEXT`);
    logger.info('Migration: Added L4 routing columns');
  } catch (e) {
    // Columns already exist
  }

  // Migration: Relax domain UNIQUE NOT NULL constraint for L4 routes without domain
  try {
    const hasNullableDomain = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='routes'`
    ).get();
    if (hasNullableDomain.sql.includes('domain TEXT NOT NULL UNIQUE')) {
      db.exec(`
        CREATE TABLE routes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT,
          target_ip TEXT NOT NULL,
          target_port INTEGER NOT NULL,
          description TEXT,
          peer_id INTEGER,
          https_enabled INTEGER NOT NULL DEFAULT 1,
          basic_auth_enabled INTEGER NOT NULL DEFAULT 0,
          basic_auth_user TEXT,
          basic_auth_password_hash TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          backend_https INTEGER NOT NULL DEFAULT 0,
          route_type TEXT NOT NULL DEFAULT 'http',
          l4_protocol TEXT,
          l4_listen_port TEXT,
          l4_tls_mode TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE SET NULL
        );
        INSERT INTO routes_new (
          id, domain, target_ip, target_port, description, peer_id,
          https_enabled, basic_auth_enabled, basic_auth_user, basic_auth_password_hash,
          enabled, backend_https, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
          created_at, updated_at
        ) SELECT
          id, domain, target_ip, target_port, description, peer_id,
          https_enabled, basic_auth_enabled, basic_auth_user, basic_auth_password_hash,
          enabled, backend_https, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
          created_at, updated_at
        FROM routes;
        DROP TABLE routes;
        ALTER TABLE routes_new RENAME TO routes;
      `);
      logger.info('Migration: Relaxed domain constraint for L4 routes');
    }
  } catch (e) {
    logger.warn('Migration: Domain constraint change skipped', e.message);
  }

  // Add performance indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);
    CREATE INDEX IF NOT EXISTS idx_routes_domain ON routes(domain);
    CREATE INDEX IF NOT EXISTS idx_routes_peer_id ON routes(peer_id);
    CREATE INDEX IF NOT EXISTS idx_peers_enabled ON peers(enabled);
    CREATE INDEX IF NOT EXISTS idx_routes_enabled ON routes(enabled);
    CREATE INDEX IF NOT EXISTS idx_routes_route_type ON routes(route_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_domain_unique ON routes(domain) WHERE domain IS NOT NULL AND domain != '';
  `);

  // Composite indexes for common query patterns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activity_created_desc ON activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_type_created ON activity_log(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_peers_enabled_created ON peers(enabled, created_at);
    CREATE INDEX IF NOT EXISTS idx_routes_enabled_domain ON routes(enabled, domain);
  `);

  // Migration: Route Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_auth (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL UNIQUE,
      auth_type TEXT NOT NULL,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      two_factor_method TEXT,
      email TEXT,
      password_hash TEXT,
      totp_secret_encrypted TEXT,
      session_max_age INTEGER NOT NULL DEFAULT 86400000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_route_id ON route_auth(route_id);

    CREATE TABLE IF NOT EXISTS route_auth_sessions (
      id TEXT PRIMARY KEY,
      route_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      ip_address TEXT,
      two_factor_pending INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_sessions_expires ON route_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_route_auth_sessions_route_pending ON route_auth_sessions(route_id, two_factor_pending);

    CREATE TABLE IF NOT EXISTS route_auth_otp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_auth_otp_route_email ON route_auth_otp(route_id, email);
  `);

  // Migration: Per-peer traffic snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_traffic_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peer_id INTEGER NOT NULL,
      upload_bytes INTEGER NOT NULL DEFAULT 0,
      download_bytes INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_peer_traffic_peer_recorded ON peer_traffic_snapshots(peer_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_peer_traffic_recorded ON peer_traffic_snapshots(recorded_at);
  `);

  // Add total_rx/total_tx columns to peers for persistent totals
  try {
    db.exec(`ALTER TABLE peers ADD COLUMN total_rx INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE peers ADD COLUMN total_tx INTEGER NOT NULL DEFAULT 0`);
    logger.info('Added total_rx/total_tx columns to peers');
  } catch (e) {
    // Columns already exist
  }

  // Migration: Login attempts table for account lockout
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL,
      type TEXT NOT NULL,
      ip_address TEXT,
      failed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, failed_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_failed_at ON login_attempts(failed_at);
  `);

  logger.info('Database migrations completed');
}

module.exports = { runMigrations };
