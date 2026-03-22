'use strict';

const crypto = require('node:crypto');
const { getDb } = require('./connection');
const logger = require('../utils/logger');

/**
 * Versioned migration definitions.
 * Each migration has a version, name, and sql string.
 * Migrations 1-14 represent the existing schema that was previously
 * applied via CREATE IF NOT EXISTS / ALTER TABLE try-catch blocks.
 *
 * Migrations with a `detect` function can be detected as already-applied
 * on legacy databases (pre-migration-history). Migrations using only
 * CREATE TABLE/INDEX IF NOT EXISTS are detected automatically.
 */
const migrations = [
  {
    version: 1,
    name: 'create_core_tables',
    sql: `
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
    `,
  },
  {
    version: 2,
    name: 'add_backend_https_column',
    sql: `ALTER TABLE routes ADD COLUMN backend_https INTEGER NOT NULL DEFAULT 0;`,
    detect: (db) => hasColumn(db, 'routes', 'backend_https'),
  },
  {
    version: 3,
    name: 'create_webhooks_table',
    sql: `
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '*',
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 4,
    name: 'add_peers_tags_column',
    sql: `ALTER TABLE peers ADD COLUMN tags TEXT DEFAULT '';`,
    detect: (db) => hasColumn(db, 'peers', 'tags'),
  },
  {
    version: 5,
    name: 'add_l4_routing_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN route_type TEXT NOT NULL DEFAULT 'http';
      ALTER TABLE routes ADD COLUMN l4_protocol TEXT;
      ALTER TABLE routes ADD COLUMN l4_listen_port TEXT;
      ALTER TABLE routes ADD COLUMN l4_tls_mode TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'route_type'),
  },
  {
    version: 6,
    name: 'relax_domain_constraint_for_l4',
    sql: `
      CREATE TABLE IF NOT EXISTS routes_new (
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
    `,
    detect: (db) => {
      const row = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='routes'`
      ).get();
      // Already applied if domain is NOT "NOT NULL UNIQUE"
      return row && !row.sql.includes('domain TEXT NOT NULL UNIQUE');
    },
  },
  {
    version: 7,
    name: 'add_performance_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);
      CREATE INDEX IF NOT EXISTS idx_routes_domain ON routes(domain);
      CREATE INDEX IF NOT EXISTS idx_routes_peer_id ON routes(peer_id);
      CREATE INDEX IF NOT EXISTS idx_peers_enabled ON peers(enabled);
      CREATE INDEX IF NOT EXISTS idx_routes_enabled ON routes(enabled);
      CREATE INDEX IF NOT EXISTS idx_routes_route_type ON routes(route_type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_domain_unique ON routes(domain) WHERE domain IS NOT NULL AND domain != '';
      CREATE INDEX IF NOT EXISTS idx_activity_created_desc ON activity_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_type_created ON activity_log(event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_peers_enabled_created ON peers(enabled, created_at);
      CREATE INDEX IF NOT EXISTS idx_routes_enabled_domain ON routes(enabled, domain);
    `,
  },
  {
    version: 8,
    name: 'create_route_auth_tables',
    sql: `
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
    `,
  },
  {
    version: 9,
    name: 'add_branding_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN branding_title TEXT;
      ALTER TABLE routes ADD COLUMN branding_text TEXT;
      ALTER TABLE routes ADD COLUMN branding_logo TEXT;
      ALTER TABLE routes ADD COLUMN branding_color TEXT;
      ALTER TABLE routes ADD COLUMN branding_bg TEXT;
      ALTER TABLE routes ADD COLUMN branding_bg_image TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'branding_title'),
  },
  {
    version: 10,
    name: 'add_ip_filter_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN ip_filter_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN ip_filter_mode TEXT;
      ALTER TABLE routes ADD COLUMN ip_filter_rules TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'ip_filter_enabled'),
  },
  {
    version: 11,
    name: 'add_monitoring_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN monitoring_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN monitoring_status TEXT;
      ALTER TABLE routes ADD COLUMN monitoring_last_check TEXT;
      ALTER TABLE routes ADD COLUMN monitoring_last_change TEXT;
      ALTER TABLE routes ADD COLUMN monitoring_response_time INTEGER;
    `,
    detect: (db) => hasColumn(db, 'routes', 'monitoring_enabled'),
  },
  {
    version: 12,
    name: 'create_peer_traffic_snapshots',
    sql: `
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
    `,
  },
  {
    version: 13,
    name: 'add_peers_total_rx_tx',
    sql: `
      ALTER TABLE peers ADD COLUMN total_rx INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE peers ADD COLUMN total_tx INTEGER NOT NULL DEFAULT 0;
    `,
    detect: (db) => hasColumn(db, 'peers', 'total_rx'),
  },
  {
    version: 14,
    name: 'create_login_attempts_table',
    sql: `
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT NOT NULL,
        type TEXT NOT NULL,
        ip_address TEXT,
        failed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, failed_at);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_failed_at ON login_attempts(failed_at);
    `,
  },
  {
    version: 15,
    name: 'create_api_tokens_table',
    sql: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
    `,
  },
  {
    version: 16,
    name: 'add_peers_expires_at',
    sql: `ALTER TABLE peers ADD COLUMN expires_at TEXT;`,
    detect: (db) => hasColumn(db, 'peers', 'expires_at'),
  },
  {
    version: 17,
    name: 'add_route_peer_acl',
    sql: `
      ALTER TABLE routes ADD COLUMN acl_enabled INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS route_peer_acl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        peer_id INTEGER NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        UNIQUE(route_id, peer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_route_peer_acl_route ON route_peer_acl(route_id);
    `,
    detect: (db) => hasColumn(db, 'routes', 'acl_enabled'),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a column exists in a table.
 */
function hasColumn(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}

/**
 * Check if a table exists in the database.
 */
function tableExists(db, table) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  return !!row;
}

/**
 * Compute a SHA-256 checksum for a migration's SQL.
 */
function computeChecksum(sql) {
  return crypto.createHash('sha256').update(sql.trim()).digest('hex');
}

// ---------------------------------------------------------------------------
// Bootstrap the migration_history table (must exist before we can query it)
// ---------------------------------------------------------------------------

function bootstrapMigrationHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// Detect which legacy migrations have already been applied
// ---------------------------------------------------------------------------

/**
 * For existing databases that were created before the migration_history system,
 * detect which migrations are already applied by inspecting the schema.
 * Returns a Set of version numbers that should be marked as already applied.
 */
function detectAppliedLegacyMigrations(db) {
  const applied = new Set();

  for (const migration of migrations) {
    if (migration.detect) {
      // Migration has a custom detection function
      if (migration.detect(db)) {
        applied.add(migration.version);
      }
    } else {
      // For CREATE TABLE / CREATE INDEX migrations, check if the artefacts exist
      const tableMatches = [
        ...migration.sql.matchAll(
          /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi
        ),
      ];
      const indexMatches = [
        ...migration.sql.matchAll(
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi
        ),
      ];

      let allExist = true;
      const foundAny = tableMatches.length > 0 || indexMatches.length > 0;

      for (const match of tableMatches) {
        if (!tableExists(db, match[1])) {
          allExist = false;
          break;
        }
      }

      if (allExist) {
        for (const match of indexMatches) {
          const idx = db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
            )
            .get(match[1]);
          if (!idx) {
            allExist = false;
            break;
          }
        }
      }

      if (foundAny && allExist) {
        applied.add(migration.version);
      }
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function runMigrations() {
  const db = getDb();

  // Ensure migration_history table exists
  bootstrapMigrationHistory(db);

  // Get already-recorded migrations
  const recorded = new Set(
    db
      .prepare('SELECT version FROM migration_history ORDER BY version')
      .all()
      .map((r) => r.version)
  );

  // If migration_history is empty but the database has existing tables,
  // this is a legacy database — detect and record what's already applied
  const isLegacyDb = recorded.size === 0 && tableExists(db, 'users');

  if (isLegacyDb) {
    logger.info(
      'Detected existing database without migration history, scanning schema...'
    );
    const legacyApplied = detectAppliedLegacyMigrations(db);

    // Record all detected legacy migrations
    if (legacyApplied.size > 0) {
      const insert = db.prepare(
        'INSERT INTO migration_history (version, name, checksum) VALUES (?, ?, ?)'
      );
      const recordLegacy = db.transaction(() => {
        for (const migration of migrations) {
          if (legacyApplied.has(migration.version)) {
            insert.run(
              migration.version,
              migration.name,
              computeChecksum(migration.sql)
            );
          }
        }
      });
      recordLegacy();
      logger.info(
        { count: legacyApplied.size },
        'Recorded pre-existing migrations in migration_history'
      );
      // Add to recorded set so they are skipped below
      for (const v of legacyApplied) {
        recorded.add(v);
      }
    }
  }

  // Determine which migrations need to run
  const pending = migrations
    .filter((m) => !recorded.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.info('All database migrations are up to date');
    return;
  }

  // Run pending migrations in a transaction
  logger.info({ count: pending.length }, 'Running pending database migrations');

  const insert = db.prepare(
    'INSERT INTO migration_history (version, name, checksum) VALUES (?, ?, ?)'
  );

  const applyMigrations = db.transaction(() => {
    for (const migration of pending) {
      logger.info(
        { version: migration.version, name: migration.name },
        'Applying migration'
      );
      db.exec(migration.sql);
      insert.run(
        migration.version,
        migration.name,
        computeChecksum(migration.sql)
      );
    }
  });

  applyMigrations();

  logger.info(
    { applied: pending.length },
    'Database migrations completed'
  );
}

module.exports = { runMigrations };
