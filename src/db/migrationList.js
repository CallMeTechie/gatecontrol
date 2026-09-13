'use strict';

const { hasColumn, tableExists } = require('./migrationHelpers');

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
  {
    version: 18,
    name: 'add_compress_enabled',
    sql: `ALTER TABLE routes ADD COLUMN compress_enabled INTEGER DEFAULT 0;`,
    detect: (db) => hasColumn(db, 'routes', 'compress_enabled'),
  },
  {
    version: 19,
    name: 'add_custom_headers',
    sql: `ALTER TABLE routes ADD COLUMN custom_headers TEXT;`,
    detect: (db) => hasColumn(db, 'routes', 'custom_headers'),
  },
  {
    version: 20,
    name: 'add_rate_limit_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN rate_limit_enabled INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN rate_limit_requests INTEGER DEFAULT 100;
      ALTER TABLE routes ADD COLUMN rate_limit_window TEXT DEFAULT '1m';
    `,
    detect: (db) => hasColumn(db, 'routes', 'rate_limit_enabled'),
  },
  {
    version: 21,
    name: 'add_retry_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN retry_enabled INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN retry_count INTEGER DEFAULT 3;
      ALTER TABLE routes ADD COLUMN retry_match_status TEXT DEFAULT '502,503,504';
    `,
    detect: (db) => hasColumn(db, 'routes', 'retry_enabled'),
  },
  {
    version: 22,
    name: 'add_backends_column',
    sql: `ALTER TABLE routes ADD COLUMN backends TEXT;`,
    detect: (db) => hasColumn(db, 'routes', 'backends'),
  },
  {
    version: 23,
    name: 'add_sticky_session_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN sticky_enabled INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN sticky_cookie_name TEXT DEFAULT 'gc_sticky';
      ALTER TABLE routes ADD COLUMN sticky_cookie_ttl TEXT DEFAULT '3600';
    `,
    detect: (db) => hasColumn(db, 'routes', 'sticky_enabled'),
  },
  {
    version: 24,
    name: 'add_circuit_breaker_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN circuit_breaker_enabled INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN circuit_breaker_threshold INTEGER DEFAULT 5;
      ALTER TABLE routes ADD COLUMN circuit_breaker_timeout INTEGER DEFAULT 30;
      ALTER TABLE routes ADD COLUMN circuit_breaker_status TEXT DEFAULT 'closed';
    `,
    detect: (db) => hasColumn(db, 'routes', 'circuit_breaker_enabled'),
  },
  {
    version: 25,
    name: 'create_peer_groups',
    sql: `
      CREATE TABLE IF NOT EXISTS peer_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#6b7280',
        description TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      ALTER TABLE peers ADD COLUMN group_id INTEGER REFERENCES peer_groups(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_peers_group_id ON peers(group_id);
    `,
    detect: (db) => hasColumn(db, 'peers', 'group_id'),
  },
  {
    version: 26,
    name: 'add_mirror_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN mirror_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN mirror_targets TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'mirror_enabled'),
  },
  {
    version: 27,
    name: 'add_debug_enabled',
    sql: 'ALTER TABLE routes ADD COLUMN debug_enabled INTEGER DEFAULT 0;',
    detect: (db) => hasColumn(db, 'routes', 'debug_enabled'),
  },
  {
    version: 28,
    name: 'add_bot_blocker',
    sql: `
      ALTER TABLE routes ADD COLUMN bot_blocker_enabled INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN bot_blocker_mode TEXT DEFAULT 'block';
      ALTER TABLE routes ADD COLUMN bot_blocker_count INTEGER DEFAULT 0;
      ALTER TABLE routes ADD COLUMN bot_blocker_config TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'bot_blocker_enabled'),
  },
  {
    version: 29,
    name: 'add_token_peer_binding',
    sql: 'ALTER TABLE api_tokens ADD COLUMN peer_id INTEGER REFERENCES peers(id) ON DELETE SET NULL;',
    detect: (db) => hasColumn(db, 'api_tokens', 'peer_id'),
  },
  {
    version: 30,
    name: 'add_machine_binding',
    sql: `
      ALTER TABLE api_tokens ADD COLUMN machine_fingerprint TEXT;
      ALTER TABLE api_tokens ADD COLUMN machine_binding_enabled INTEGER DEFAULT 0;
    `,
    detect: (db) => hasColumn(db, 'api_tokens', 'machine_fingerprint'),
  },
  {
    version: 31,
    name: 'create_rdp_routes',
    sql: `
      CREATE TABLE IF NOT EXISTS rdp_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Connection
        name TEXT NOT NULL,
        description TEXT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 3389,
        external_hostname TEXT,
        external_port INTEGER,
        access_mode TEXT NOT NULL DEFAULT 'internal',
        gateway_host TEXT,
        gateway_port INTEGER DEFAULT 443,
        enabled INTEGER NOT NULL DEFAULT 1,

        -- Authentication (encrypted via AES-256-GCM)
        credential_mode TEXT NOT NULL DEFAULT 'none',
        username_encrypted TEXT,
        password_encrypted TEXT,
        domain TEXT,

        -- Display
        resolution_mode TEXT DEFAULT 'fullscreen',
        resolution_width INTEGER,
        resolution_height INTEGER,
        multi_monitor INTEGER DEFAULT 0,
        color_depth INTEGER DEFAULT 32,

        -- Resource Redirect
        redirect_clipboard INTEGER DEFAULT 1,
        redirect_printers INTEGER DEFAULT 0,
        redirect_drives INTEGER DEFAULT 0,
        redirect_usb INTEGER DEFAULT 0,
        redirect_smartcard INTEGER DEFAULT 0,
        audio_mode TEXT DEFAULT 'local',

        -- Performance
        network_profile TEXT DEFAULT 'auto',
        nla_enabled INTEGER DEFAULT 1,
        disable_wallpaper INTEGER DEFAULT 0,
        disable_themes INTEGER DEFAULT 0,
        disable_animations INTEGER DEFAULT 0,
        bandwidth_limit INTEGER,

        -- Session
        session_timeout INTEGER,
        admin_session INTEGER DEFAULT 0,
        remote_app TEXT,
        start_program TEXT,

        -- Wake-on-LAN
        wol_enabled INTEGER DEFAULT 0,
        wol_mac_address TEXT,

        -- Maintenance Window
        maintenance_enabled INTEGER DEFAULT 0,
        maintenance_schedule TEXT,

        -- Session Sharing (Phase 2, prepared)
        sharing_enabled INTEGER DEFAULT 0,
        sharing_mode TEXT DEFAULT 'view',
        sharing_require_consent INTEGER DEFAULT 1,

        -- Screenshot Preview
        screenshot_enabled INTEGER DEFAULT 0,
        screenshot_data TEXT,

        -- Credential Rotation
        credential_rotation_enabled INTEGER DEFAULT 0,
        credential_rotation_days INTEGER DEFAULT 90,
        credential_rotation_last TEXT,

        -- Access Control
        token_ids TEXT,

        -- Notes & Tags
        notes TEXT,
        tags TEXT,

        -- Monitoring
        health_check_enabled INTEGER DEFAULT 1,

        -- Meta
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_rdp_routes_enabled ON rdp_routes(enabled);
      CREATE INDEX IF NOT EXISTS idx_rdp_routes_access_mode ON rdp_routes(access_mode);

      CREATE TABLE IF NOT EXISTS rdp_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rdp_route_id INTEGER NOT NULL,
        token_id INTEGER,
        token_name TEXT,
        peer_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat TEXT,
        ended_at TEXT,
        duration_seconds INTEGER,
        end_reason TEXT,
        client_ip TEXT,
        FOREIGN KEY (rdp_route_id) REFERENCES rdp_routes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rdp_sessions_route ON rdp_sessions(rdp_route_id);
      CREATE INDEX IF NOT EXISTS idx_rdp_sessions_status ON rdp_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_rdp_sessions_started ON rdp_sessions(started_at DESC);
    `,
  },
  {
    version: 32,
    name: 'unified_user_model',
    sql: `
      ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE api_tokens ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
    `,
    detect: (db) => hasColumn(db, 'api_tokens', 'user_id'),
  },
  {
    version: 33,
    name: 'user_visibility_on_routes',
    sql: `
      ALTER TABLE routes ADD COLUMN user_ids TEXT;
      ALTER TABLE rdp_routes ADD COLUMN user_ids TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'user_ids'),
  },
  {
    version: 34,
    name: 'add_split_tunnel_override',
    sql: `ALTER TABLE api_tokens ADD COLUMN split_tunnel_override TEXT DEFAULT NULL;`,
    detect: (db) => hasColumn(db, 'api_tokens', 'split_tunnel_override'),
  },
  {
    version: 35,
    name: 'peer_internal_hostname',
    // Per-peer DNS hostname for internal resolution (feature: internal_dns).
    // hostname is lowercase, DNS-label-clean, max 63 chars (RFC 1123).
    // hostname_source = 'admin' | 'agent' | 'stale' (post-restore marker).
    // UNIQUE via index with NOCASE collation so 'Foo' and 'foo' dedup.
    sql: `
      ALTER TABLE peers ADD COLUMN hostname TEXT;
      ALTER TABLE peers ADD COLUMN hostname_source TEXT;
      ALTER TABLE peers ADD COLUMN hostname_reported_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_peers_hostname_nocase
        ON peers(hostname COLLATE NOCASE)
        WHERE hostname IS NOT NULL;
    `,
    detect: (db) => hasColumn(db, 'peers', 'hostname'),
  },
  {
    version: 36,
    name: 'add_gateway_support',
    // SQLite ALTER TABLE ADD COLUMN silently ignores REFERENCES in some versions;
    // we add the column WITHOUT inline FK and rely on service-layer validation.
    // FK cascades for gateway_meta.peer_id work because gateway_meta is CREATE TABLE (not ALTER).
    detect: (db) => hasColumn(db, 'peers', 'peer_type'),
    sql: `
      ALTER TABLE peers ADD COLUMN peer_type TEXT NOT NULL DEFAULT 'regular';

      ALTER TABLE routes ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'peer';
      ALTER TABLE routes ADD COLUMN target_peer_id INTEGER;
      ALTER TABLE routes ADD COLUMN target_lan_host TEXT;
      ALTER TABLE routes ADD COLUMN target_lan_port INTEGER;
      ALTER TABLE routes ADD COLUMN wol_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN wol_mac TEXT;

      CREATE TABLE IF NOT EXISTS gateway_meta (
        peer_id INTEGER PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
        api_port INTEGER NOT NULL DEFAULT 9876,
        api_token_hash TEXT NOT NULL,
        push_token_encrypted TEXT NOT NULL,
        needs_repair INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER,
        last_config_hash TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_routes_target_peer_id ON routes(target_peer_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_meta_api_token_hash ON gateway_meta(api_token_hash);
    `,
  },
  {
    version: 37,
    name: 'gateway_meta_last_health',
    sql: `ALTER TABLE gateway_meta ADD COLUMN last_health TEXT;`,
    detect: (db) => hasColumn(db, 'gateway_meta', 'last_health'),
  },
  {
    // Option B: RDP routes can be fronted by a Home Gateway. When the
    // user picks access_mode='gateway', the service layer auto-creates
    // a linked L4 route (listen_port + target_lan_host + target_lan_port
    // mapped from the RDP config) and tracks its id here so delete/
    // update can keep both rows in lockstep.
    version: 38,
    name: 'rdp_routes_gateway_link',
    sql: `
      ALTER TABLE rdp_routes ADD COLUMN gateway_peer_id INTEGER
        REFERENCES peers(id) ON DELETE SET NULL;
      ALTER TABLE rdp_routes ADD COLUMN gateway_listen_port INTEGER;
      ALTER TABLE rdp_routes ADD COLUMN gateway_l4_route_id INTEGER
        REFERENCES routes(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_rdp_routes_gateway_peer ON rdp_routes(gateway_peer_id);
    `,
    detect: (db) => hasColumn(db, 'rdp_routes', 'gateway_peer_id'),
  },
  {
    // Tag registry — peer.tags remains a CSV on the peer row (unchanged),
    // this table is the canonical list for the Tags admin card. Entries
    // may exist without any peer having the tag yet (pre-registered).
    // Initially seeded from existing distinct values in peers.tags by the
    // tags service on first list() so migration stays schema-only.
    version: 39,
    name: 'create_tags_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    `,
    detect: (db) => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tags'").get();
      return !!row;
    },
  },
  {
    // Pairing-code mechanism for the install-pve.sh / one-shot bootstrap
    // flow: dashboard generates a short cleartext token (XXXX-XXXX-XXXX-
    // XXXX@host) shown once, installer POSTs it to /api/v1/gateway/pair
    // and gets the gateway.env content back. Codes are SHA-256 hashed
    // at rest, single-active per peer (regenerate invalidates prior),
    // 10-min TTL, one-shot (consumed_at set atomically on redeem).
    version: 40,
    name: 'create_gateway_pairing_codes',
    sql: `
      CREATE TABLE IF NOT EXISTS gateway_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        peer_id INTEGER NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_from_ip TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_pairing_codes_peer ON gateway_pairing_codes(peer_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_pairing_codes_expires ON gateway_pairing_codes(expires_at);
    `,
    detect: (db) => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_pairing_codes'").get();
      return !!row;
    },
  },
  {
    // Gateway-Pool: groups gateway-peers for failover or load-balancing.
    // Routes can target a single peer (target_peer_id, pin-mode,
    // unchanged) OR a pool (target_pool_id, dynamic resolution at render
    // time). Pool routes keep target_kind='gateway' so existing
    // companion-sync paths recognize them; target_pool_id is ADDITIVE.
    //
    // gateway_meta gets the alive-state + outage timestamps directly.
    // settings gets the gateway_down_threshold_s default (90 s).
    version: 41,
    name: 'create_gateway_pools',
    sql: `
      CREATE TABLE IF NOT EXISTS gateway_pools (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        name                  TEXT NOT NULL UNIQUE,
        mode                  TEXT NOT NULL DEFAULT 'failover',
        lb_policy             TEXT,
        failback_cooldown_s   INTEGER NOT NULL,
        outage_message        TEXT,
        enabled               INTEGER NOT NULL DEFAULT 1,
        created_at            DATETIME NOT NULL DEFAULT (datetime('now')),
        updated_at            DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_pools_enabled ON gateway_pools(enabled);

      CREATE TABLE IF NOT EXISTS gateway_pool_members (
        pool_id    INTEGER NOT NULL REFERENCES gateway_pools(id) ON DELETE CASCADE,
        peer_id    INTEGER NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
        priority   INTEGER NOT NULL DEFAULT 100,
        PRIMARY KEY (pool_id, peer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pool_members_peer ON gateway_pool_members(peer_id);

      ALTER TABLE routes      ADD COLUMN target_pool_id INTEGER REFERENCES gateway_pools(id);
      ALTER TABLE rdp_routes  ADD COLUMN gateway_pool_id INTEGER REFERENCES gateway_pools(id);

      ALTER TABLE gateway_meta ADD COLUMN alive INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE gateway_meta ADD COLUMN went_down_at INTEGER;
      ALTER TABLE gateway_meta ADD COLUMN recovered_first_hb_at INTEGER;

      INSERT OR IGNORE INTO settings (key, value)
        VALUES ('gateway_down_threshold_s', '90');
    `,
    detect: (db) => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_pools'").get();
      return !!row;
    },
  },
  {
    // Per-gateway proxy_port. Some hosts (e.g. Synology DSM) already bind
    // 8080 on 0.0.0.0, blocking the companion's tunnel-IP listen. Allow
    // each gateway to declare its own proxy port; server-side caddy renders
    // backend dial strings with the per-peer port instead of hardcoded 8080.
    version: 42,
    name: 'gateway_meta_proxy_port',
    sql: `
      ALTER TABLE gateway_meta ADD COLUMN proxy_port INTEGER NOT NULL DEFAULT 8080;
    `,
    detect: (db) => hasColumn(db, 'gateway_meta', 'proxy_port'),
  },
  {
    // Pool failover via DB pivot. When a pool member goes offline, the
    // routes pinned to it are reassigned to the next-priority alive
    // sibling; original_peer_id records where the route originally lived
    // so it can be moved back when the original peer recovers. NULL means
    // the route is in its normal state.
    version: 43,
    name: 'routes_original_peer_id',
    sql: `
      ALTER TABLE routes ADD COLUMN original_peer_id INTEGER REFERENCES peers(id) ON DELETE SET NULL;
    `,
    detect: (db) => hasColumn(db, 'routes', 'original_peer_id'),
  },
  {
    version: 44,
    name: 'gateway_meta_update_tracking',
    sql: `
      ALTER TABLE gateway_meta ADD COLUMN update_request_id TEXT;
      ALTER TABLE gateway_meta ADD COLUMN update_requested_at INTEGER;
      ALTER TABLE gateway_meta ADD COLUMN update_target_version TEXT;
    `,
    detect: (db) => hasColumn(db, 'gateway_meta', 'update_request_id'),
  },
  {
    version: 45,
    name: 'create_route_auth_share_links',
    sql: `
      CREATE TABLE IF NOT EXISTS route_auth_share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_by_user_id INTEGER,
        one_time INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        redeemed_count INTEGER NOT NULL DEFAULT 0,
        last_redeemed_at TEXT,
        last_redeemed_ip TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_share_links_token ON route_auth_share_links(token_hash);
      CREATE INDEX IF NOT EXISTS idx_share_links_route ON route_auth_share_links(route_id);
      ALTER TABLE route_auth_sessions ADD COLUMN share_link_id INTEGER REFERENCES route_auth_share_links(id) ON DELETE SET NULL;
    `,
    detect: (db) => hasColumn(db, 'route_auth_sessions', 'share_link_id'),
  },
  {
    version: 46,
    name: 'create_access_rules',
    sql: `
      CREATE TABLE IF NOT EXISTS access_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        mode TEXT NOT NULL,
        schedule TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_access_rules_target ON access_rules(target_type, target_id);
    `,
    detect: (db) => hasColumn(db, 'access_rules', 'mode'),
  },
  {
    version: 47,
    name: 'gateway_meta_discovery',
    sql: `
      ALTER TABLE gateway_meta ADD COLUMN discovery_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE gateway_meta ADD COLUMN discovery_active_scan INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE gateway_meta ADD COLUMN discovery_subnets TEXT;
      ALTER TABLE gateway_meta ADD COLUMN discovery_category_mode TEXT NOT NULL DEFAULT 'include';
      ALTER TABLE gateway_meta ADD COLUMN discovery_categories TEXT;
    `,
    detect: (db) => hasColumn(db, 'gateway_meta', 'discovery_enabled'),
  },
  {
    // Per-gateway LAN IP, self-reported via heartbeat. Used to rewrite a
    // loopback X-Gateway-Target (127.0.0.1, host-relative) to the home
    // gateway's real LAN address when a co-located service's route has
    // failed over to a sibling. NULL = not yet reported / old companion.
    version: 48,
    name: 'gateway_meta_lan_ip',
    sql: `
      ALTER TABLE gateway_meta ADD COLUMN lan_ip TEXT;
    `,
    detect: (db) => hasColumn(db, 'gateway_meta', 'lan_ip'),
  },
  {
    // Persist consumed TOTP codes so route-auth replay protection survives a
    // process restart. The previous in-memory map was wiped on restart,
    // leaving a <=90s window in which an intercepted code could be replayed.
    // Rows past the 90s validation window are pruned opportunistically on
    // each write; the UNIQUE constraint makes the "claim" race-safe.
    version: 49,
    name: 'route_auth_totp_used',
    sql: `
      CREATE TABLE IF NOT EXISTS route_auth_totp_used (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        UNIQUE(route_id, token_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_route_auth_totp_used_at ON route_auth_totp_used(used_at);
    `,
  },
  {
    // A service bundle groups routes that expose one host under one domain
    // (e.g. an HTTP route plus an SSH port-forward). The domain lives here
    // as a label for L4 members with tls_mode='none', which keep domain=NULL
    // in the routes table. The unique-domain index is narrowed to HTTP rows
    // so an HTTP route and L4 port-forwards may share one domain.
    version: 50,
    name: 'service_bundles',
    sql: `
      CREATE TABLE IF NOT EXISTS service_bundles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        domain TEXT,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE routes ADD COLUMN bundle_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_routes_bundle ON routes(bundle_id);
      DROP INDEX IF EXISTS idx_routes_domain_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_domain_unique
        ON routes(domain)
        WHERE domain IS NOT NULL AND domain != ''
          AND (route_type = 'http' OR route_type IS NULL);
    `,
    detect: (db) => hasColumn(db, 'routes', 'bundle_id'),
  },
  {
    // One-time full-table backfill: existing rows → external_enabled = 1 (preserve prior behaviour); new rows default to 0.
    version: 51,
    name: 'route_external_exposure',
    sql: `
      ALTER TABLE routes ADD COLUMN external_enabled INTEGER NOT NULL DEFAULT 0;
      UPDATE routes SET external_enabled = 1;
    `,
    detect: (db) => hasColumn(db, 'routes', 'external_enabled'),
  },
  {
    version: 52,
    name: 'route_external_block_response',
    sql: `
      ALTER TABLE routes ADD COLUMN external_block_action TEXT NOT NULL DEFAULT 'inherit';
      ALTER TABLE routes ADD COLUMN external_block_body TEXT;
      ALTER TABLE routes ADD COLUMN external_block_redirect_url TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'external_block_action'),
  },
  {
    version: 53,
    name: 'rdp_routes_protocol_generalization',
    sql: `
      ALTER TABLE rdp_routes ADD COLUMN protocol TEXT DEFAULT 'rdp';
      ALTER TABLE rdp_routes ADD COLUMN browser_enabled INTEGER DEFAULT 0;
      ALTER TABLE rdp_routes ADD COLUMN browser_enable_sftp INTEGER DEFAULT 0;
      ALTER TABLE rdp_routes ADD COLUMN sftp_host TEXT;
      ALTER TABLE rdp_routes ADD COLUMN sftp_port INTEGER;
      ALTER TABLE rdp_routes ADD COLUMN sftp_username TEXT;
      ALTER TABLE rdp_routes ADD COLUMN sftp_disable_download INTEGER DEFAULT 1;
      ALTER TABLE rdp_routes ADD COLUMN sftp_disable_upload INTEGER DEFAULT 1;
      ALTER TABLE rdp_routes ADD COLUMN browser_enable_audio INTEGER DEFAULT 0;
      ALTER TABLE rdp_routes ADD COLUMN audio_servername TEXT;
      ALTER TABLE rdp_routes ADD COLUMN browser_clipboard INTEGER DEFAULT 0;
    `,
    detect: (db) => hasColumn(db, 'rdp_routes', 'protocol'),
  },
  {
    version: 54,
    name: 'create_egress_routes',
    sql: `
      CREATE TABLE egress_routes (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        name               TEXT NOT NULL,
        device_id          INTEGER,
        near_peer_id       INTEGER,
        near_pool_id       INTEGER,
        vip_ip             TEXT NOT NULL,
        vip_prefix         INTEGER NOT NULL DEFAULT 24,
        lan_listen_port    INTEGER NOT NULL,
        target_route_id    INTEGER NOT NULL,
        allowed_source_ips TEXT NOT NULL DEFAULT '[]',
        enabled            INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_egress_near_peer ON egress_routes(near_peer_id);
      CREATE INDEX idx_egress_near_pool ON egress_routes(near_pool_id);
    `,
    detect: (db) => tableExists(db, 'egress_routes'),
  },
  {
    version: 55,
    name: 'rdp_sessions_browser_columns',
    sql: `
      ALTER TABLE rdp_sessions ADD COLUMN protocol TEXT DEFAULT 'rdp';
      ALTER TABLE rdp_sessions ADD COLUMN via TEXT DEFAULT 'native';
    `,
    detect: (db) => hasColumn(db, 'rdp_sessions', 'via'),
  },
  {
    version: 56,
    name: 'rdp_routes_phase2b_columns',
    sql: `
      ALTER TABLE rdp_routes ADD COLUMN ssh_private_key_encrypted TEXT;
      ALTER TABLE rdp_routes ADD COLUMN ssh_passphrase_encrypted TEXT;
      ALTER TABLE rdp_routes ADD COLUMN sftp_password_encrypted TEXT;
      ALTER TABLE rdp_routes ADD COLUMN sftp_private_key_encrypted TEXT;
      ALTER TABLE rdp_routes ADD COLUMN sftp_passphrase_encrypted TEXT;
      ALTER TABLE rdp_routes ADD COLUMN rdp_disable_audio INTEGER DEFAULT NULL;
    `,
    detect: (db) => hasColumn(db, 'rdp_routes', 'sftp_passphrase_encrypted'),
  },
  {
    version: 57,
    name: 'egress_lan_port_unique',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_egress_near_port_unique
    ON egress_routes(near_peer_id, lan_listen_port) WHERE enabled = 1 AND near_peer_id IS NOT NULL;`,
    detect: (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_egress_near_port_unique'").get(),
  },
  {
    version: 58,
    name: 'create_domains_registry',
    sql: `CREATE TABLE IF NOT EXISTS domains (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      domain          TEXT NOT NULL UNIQUE,
      status          TEXT NOT NULL DEFAULT 'pending',
      resolved_ip     TEXT,
      last_error      TEXT,
      verified_at     TEXT,
      last_checked_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );`,
    detect: (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='domains'").get(),
  },
  {
    version: 59,
    name: 'peer_owner_user_id',
    // Peer → owner (users.id). NO inline REFERENCES: ALTER TABLE ADD COLUMN
    // silently ignores REFERENCES in some SQLite versions (see 'add_gateway_support').
    // FK semantics live in the service layer (validation + null-on-user-delete).
    sql: `
      ALTER TABLE peers ADD COLUMN user_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_peers_user_id ON peers(user_id);
    `,
    detect: (db) => hasColumn(db, 'peers', 'user_id'),
  },
  {
    version: 60,
    name: 'create_midea_devices',
    sql: `CREATE TABLE IF NOT EXISTS midea_devices (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      device_sn        TEXT NOT NULL UNIQUE,
      device_id        TEXT,
      ip               TEXT,
      port             INTEGER NOT NULL DEFAULT 6444,
      protocol_version INTEGER NOT NULL DEFAULT 3,
      token_enc        TEXT,
      key_enc          TEXT,
      model            TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      last_seen_at     TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_midea_enabled ON midea_devices(enabled);`,
    detect: (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='midea_devices'").get(),
  },
  {
    version: 61,
    name: 'midea_devices_cloud_transport',
    sql: `ALTER TABLE midea_devices ADD COLUMN transport TEXT NOT NULL DEFAULT 'lan';
          ALTER TABLE midea_devices ADD COLUMN cloud_appliance_id TEXT;`,
    detect: (db) => hasColumn(db, 'midea_devices', 'transport'),
  },
  {
    version: 62,
    name: 'midea_device_owners',
    sql: `CREATE TABLE IF NOT EXISTS midea_device_owners (
      midea_device_id INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (midea_device_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_midea_owners_user ON midea_device_owners(user_id);`,
    detect: (db) => tableExists(db, 'midea_device_owners'),
  },
  {
    version: 64,
    name: 'create_smarthome',
    sql: `CREATE TABLE IF NOT EXISTS smarthome_gateways (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      route_id     INTEGER,
      api_key_enc  TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS smarthome_resources (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_id       INTEGER NOT NULL,
      deconz_id        TEXT NOT NULL,
      deconz_type      TEXT NOT NULL,
      uniqueid         TEXT,
      kind             TEXT NOT NULL,
      name             TEXT,
      capabilities_json TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_smarthome_resources_gw ON smarthome_resources(gateway_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smarthome_resources_uniq ON smarthome_resources(gateway_id, deconz_type, deconz_id);
    CREATE TABLE IF NOT EXISTS smarthome_resource_owners (
      resource_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (resource_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_smarthome_owners_user ON smarthome_resource_owners(user_id);
    CREATE TABLE IF NOT EXISTS smarthome_rules (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_id           INTEGER NOT NULL,
      name                 TEXT NOT NULL,
      enabled              INTEGER NOT NULL DEFAULT 1,
      definition_json      TEXT NOT NULL,
      deconz_rule_id       TEXT,
      deconz_schedule_id   TEXT,
      deconz_clip_sensor_id TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );`,
    detect: (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='smarthome_gateways'").get(),
  },
  {
    version: 63,
    name: 'backfill_domain_service_bundles',
    // One-time tidy: turn pre-existing loose domain groups (>=2 routes sharing a
    // domain, none yet bundled, RDP-linked L4s excluded) into service bundles so
    // they gain the same container behaviour as auto-promoted ones.
    sql: `
      INSERT INTO service_bundles (name, domain)
      SELECT domain, domain FROM routes
      WHERE domain IS NOT NULL AND domain != ''
        AND id NOT IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL)
      GROUP BY domain
      HAVING COUNT(*) >= 2 AND SUM(CASE WHEN bundle_id IS NOT NULL THEN 1 ELSE 0 END) = 0;

      UPDATE routes SET bundle_id = (
        SELECT sb.id FROM service_bundles sb WHERE sb.domain = routes.domain
      )
      WHERE bundle_id IS NULL
        AND domain IS NOT NULL AND domain != ''
        AND id NOT IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL)
        AND (SELECT COUNT(*) FROM service_bundles sb2 WHERE sb2.domain = routes.domain) = 1;`,
  },
  {
    version: 65,
    name: 'smarthome_resources_state',
    sql: `ALTER TABLE smarthome_resources ADD COLUMN state_json TEXT;`,
    detect: (db) => hasColumn(db, 'smarthome_resources', 'state_json'),
  },
  {
    version: 66,
    name: 'skoda_integration',
    sql: `CREATE TABLE IF NOT EXISTS skoda_accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_enc  TEXT NOT NULL,
      session_enc   TEXT,
      status        TEXT NOT NULL DEFAULT 'ok',
      status_detail TEXT,
      backoff_min   INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS skoda_vehicles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER NOT NULL,
      vin         TEXT NOT NULL UNIQUE,
      name        TEXT,
      model       TEXT,
      state_json  TEXT,
      image       BLOB,
      image_url   TEXT,
      fetched_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_skoda_vehicles_account ON skoda_vehicles(account_id);
    CREATE TABLE IF NOT EXISTS skoda_vehicle_owners (
      skoda_vehicle_id INTEGER NOT NULL,
      user_id          INTEGER NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (skoda_vehicle_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_skoda_owners_user ON skoda_vehicle_owners(user_id);`,
    detect: (db) => tableExists(db, 'skoda_accounts'),
  },
  {
    version: 67,
    name: 'skoda_account_spin',
    sql: `ALTER TABLE skoda_accounts ADD COLUMN spin_enc TEXT;`,
    detect: (db) => hasColumn(db, 'skoda_accounts', 'spin_enc'),
  },
  {
    version: 68,
    name: 'zones_hosts',
    // Domain zones, step 1: every route gets a host (service_bundles row) and
    // every host is linked to its zone (domains row) by LONGEST suffix match.
    // No inline REFERENCES (see 'peer_owner_user_id'); no unique index on
    // (domain_id, subdomain) either — a legacy duplicate would block the boot.
    // Uniqueness is enforced in services/hosts.js, the boot reconcile
    // (domainZones.reconcile) logs leftovers. Every statement is guarded so a
    // second run is a no-op.
    //
    // Step 1 (host per unbundled, non-RDP route) uses the same fqdn semantics
    // as the runtime (hosts.assignRoute), so no (zone, subdomain) duplicates
    // appear: a route whose domain equals an existing host's domain joins it
    // (L4 always; HTTP only if that host has no HTTP entry yet), remaining
    // routes sharing a domain get ONE new host, routes without domain one each.
    // New host ids are pre-computed in a temp table so the route → host link
    // needs no name matching. The base id respects sqlite_sequence:
    // service_bundles is AUTOINCREMENT, ids of deleted bundles are never reused.
    sql: `
      ALTER TABLE service_bundles ADD COLUMN domain_id INTEGER;
      ALTER TABLE service_bundles ADD COLUMN subdomain TEXT;
      ALTER TABLE service_bundles ADD COLUMN template TEXT;
      ALTER TABLE service_bundles ADD COLUMN gateway_override INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_bundles_domain ON service_bundles(domain_id, subdomain);

      UPDATE routes SET bundle_id = (
        SELECT MIN(sb.id) FROM service_bundles sb WHERE lower(sb.domain) = lower(routes.domain)
      )
      WHERE bundle_id IS NULL AND domain IS NOT NULL AND domain != ''
        AND id NOT IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM service_bundles sb WHERE lower(sb.domain) = lower(routes.domain))
        AND (route_type = 'l4' OR NOT EXISTS (
              SELECT 1 FROM routes h
              WHERE h.route_type != 'l4'
                AND h.bundle_id = (SELECT MIN(sb.id) FROM service_bundles sb WHERE lower(sb.domain) = lower(routes.domain))));

      DROP TABLE IF EXISTS temp._zones_groups;
      CREATE TEMP TABLE _zones_groups AS
      SELECT r.id AS route_id,
             CASE WHEN r.domain IS NOT NULL AND r.domain != '' THEN 'd:' || lower(r.domain)
                  ELSE 'r:' || r.id END AS gkey
      FROM routes r
      WHERE r.bundle_id IS NULL
        AND r.id NOT IN (SELECT gateway_l4_route_id FROM rdp_routes WHERE gateway_l4_route_id IS NOT NULL);

      DROP TABLE IF EXISTS temp._zones_new_hosts;
      CREATE TEMP TABLE _zones_new_hosts AS
      SELECT gkey, MIN(route_id) AS lead_id,
             max(COALESCE((SELECT MAX(id) FROM service_bundles), 0),
                 COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'service_bundles'), 0))
               + ROW_NUMBER() OVER (ORDER BY MIN(route_id)) AS host_id
      FROM _zones_groups
      GROUP BY gkey;

      INSERT INTO service_bundles (id, name, domain)
      SELECT n.host_id,
             substr(COALESCE(NULLIF(TRIM(r.description), ''), NULLIF(r.domain, ''),
                             'Port ' || r.l4_listen_port, 'Route ' || r.id), 1, 120),
             NULLIF(lower(r.domain), '')
      FROM _zones_new_hosts n JOIN routes r ON r.id = n.lead_id;

      UPDATE routes SET bundle_id = (
        SELECT n.host_id FROM _zones_groups g JOIN _zones_new_hosts n ON n.gkey = g.gkey
        WHERE g.route_id = routes.id
      )
      WHERE id IN (SELECT route_id FROM _zones_groups);

      DROP TABLE temp._zones_new_hosts;
      DROP TABLE temp._zones_groups;

      UPDATE service_bundles SET domain_id = (
        SELECT d.id FROM domains d
        WHERE lower(service_bundles.domain) = d.domain
           OR (length(service_bundles.domain) > length(d.domain)
               AND substr(lower(service_bundles.domain), -length(d.domain) - 1) = '.' || d.domain)
        ORDER BY length(d.domain) DESC LIMIT 1
      )
      WHERE domain_id IS NULL AND domain IS NOT NULL AND domain != '';

      UPDATE service_bundles SET subdomain = (
        SELECT CASE WHEN lower(service_bundles.domain) = d.domain THEN '@'
                    ELSE substr(lower(service_bundles.domain), 1,
                                length(service_bundles.domain) - length(d.domain) - 1)
               END
        FROM domains d WHERE d.id = service_bundles.domain_id
      )
      WHERE domain_id IS NOT NULL AND subdomain IS NULL;`,
    detect: (db) => hasColumn(db, 'service_bundles', 'domain_id'),
  },
  {
    version: 69,
    name: 'zones_gateway',
    // Domain zones, step 2: one gateway (target triple) and one default
    // access mode per zone, backfilled from the most common target of the
    // zone's entries. Mapping routes → zone target:
    //   target_kind='gateway' + target_pool_id  → ('pool', NULL, pool)
    //   target_kind='gateway'                   → ('gateway', home peer, NULL)
    //   target_kind='peer' / NULL               → ('peer', peer_id, NULL)
    // "home peer" = COALESCE(original_peer_id, target_peer_id): a route that
    // is mid-failover (gatewayHealth pivot) still belongs to its home gateway.
    // Hosts whose entries use another target than their zone are flagged
    // gateway_override = 1 (never silently re-targeted).
    sql: `
      ALTER TABLE domains ADD COLUMN gateway_kind TEXT;
      ALTER TABLE domains ADD COLUMN gateway_peer_id INTEGER;
      ALTER TABLE domains ADD COLUMN gateway_pool_id INTEGER;
      ALTER TABLE domains ADD COLUMN default_external_enabled INTEGER NOT NULL DEFAULT 0;

      DROP TABLE IF EXISTS temp._zones_targets;
      CREATE TEMP TABLE _zones_targets AS
      SELECT r.id AS route_id, sb.id AS host_id, sb.domain_id AS domain_id,
             CASE WHEN r.target_kind = 'gateway' AND r.target_pool_id IS NOT NULL THEN 'pool'
                  WHEN r.target_kind = 'gateway' THEN 'gateway'
                  ELSE 'peer' END AS kind,
             CASE WHEN r.target_kind = 'gateway' AND r.target_pool_id IS NOT NULL THEN NULL
                  WHEN r.target_kind = 'gateway' THEN COALESCE(r.original_peer_id, r.target_peer_id)
                  ELSE r.peer_id END AS peer_id,
             CASE WHEN r.target_kind = 'gateway' THEN r.target_pool_id END AS pool_id,
             r.external_enabled AS external_enabled
      FROM routes r JOIN service_bundles sb ON sb.id = r.bundle_id
      WHERE sb.domain_id IS NOT NULL;

      DROP TABLE IF EXISTS temp._zones_winner;
      CREATE TEMP TABLE _zones_winner AS
      SELECT domain_id, kind, peer_id, pool_id FROM (
        SELECT domain_id, kind, peer_id, pool_id,
               ROW_NUMBER() OVER (PARTITION BY domain_id ORDER BY COUNT(*) DESC, MIN(route_id)) AS rn
        FROM _zones_targets
        GROUP BY domain_id, kind, peer_id, pool_id
      ) WHERE rn = 1;

      UPDATE domains SET
        gateway_kind    = (SELECT w.kind    FROM _zones_winner w WHERE w.domain_id = domains.id),
        gateway_peer_id = (SELECT w.peer_id FROM _zones_winner w WHERE w.domain_id = domains.id),
        gateway_pool_id = (SELECT w.pool_id FROM _zones_winner w WHERE w.domain_id = domains.id),
        default_external_enabled = (
          SELECT CASE WHEN 2 * SUM(CASE WHEN t.external_enabled = 1 THEN 1 ELSE 0 END) > COUNT(*)
                      THEN 1 ELSE 0 END
          FROM _zones_targets t WHERE t.domain_id = domains.id)
      WHERE gateway_kind IS NULL AND id IN (SELECT domain_id FROM _zones_winner);

      UPDATE service_bundles SET gateway_override = 1
      WHERE domain_id IS NOT NULL AND gateway_override = 0 AND EXISTS (
        SELECT 1 FROM _zones_targets t JOIN domains d ON d.id = t.domain_id
        WHERE t.host_id = service_bundles.id
          AND d.gateway_kind IS NOT NULL
          AND NOT (t.kind = d.gateway_kind
                   AND t.peer_id IS d.gateway_peer_id
                   AND t.pool_id IS d.gateway_pool_id)
      );

      DROP TABLE temp._zones_winner;
      DROP TABLE temp._zones_targets;`,
    detect: (db) => hasColumn(db, 'domains', 'gateway_kind'),
  },
  {
    version: 70,
    name: 'tls_guard',
    // TLS guard (docs/feature-tls-guard.md): the strict DNS check stores its
    // full result per domain; tls_status carries the per-hostname certificate
    // state fed by the preflight, Caddy's tls.log and the storage inventory.
    // Rows appear on the first event — a missing row means 'pending'.
    sql: `
      ALTER TABLE domains ADD COLUMN check_json TEXT;
      CREATE TABLE IF NOT EXISTS tls_status (
        host             TEXT PRIMARY KEY,
        state            TEXT NOT NULL DEFAULT 'pending',
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        last_error_code  TEXT,
        last_attempt_at  TEXT,
        next_retry_at    TEXT,
        paused_at        TEXT,
        paused_reason    TEXT,
        preflight_json   TEXT,
        not_after        TEXT,
        issuer           TEXT,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
    detect: (db) => hasColumn(db, 'domains', 'check_json'),
  },
  {
    version: 71,
    name: 'hsts',
    // HSTS per host (docs/feature-hsts.md): the Strict-Transport-Security
    // header is a setting of the HTTP entry (routes); a zone carries a
    // default for new entries as JSON ({enabled, max_age, include_subdomains,
    // preload}) or NULL (= off).
    sql: `
      ALTER TABLE routes ADD COLUMN hsts_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN hsts_max_age INTEGER NOT NULL DEFAULT 31536000;
      ALTER TABLE routes ADD COLUMN hsts_subdomains INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN hsts_preload INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE domains ADD COLUMN hsts_default TEXT;`,
    detect: (db) => hasColumn(db, 'routes', 'hsts_enabled'),
  },
  {
    version: 72,
    name: 'security_options',
    // Security options (docs/feature-security-options.md):
    //   A  host aliases      service_bundles.aliases (JSON array of labels
    //                        relative to the host fqdn), alias_mode redirect|serve
    //   B  backend TLS       routes.backend_tls_verify / _server_name / _ca_pem
    //   D  body limit        routes.max_body_mb (0 = unlimited)
    //   E  TLS profile       domains.tls_min_version '1.2' | '1.3'
    //   F  mTLS per route    routes.mtls_enabled / mtls_ca_pem / mtls_mode
    // v73 is reserved for admin 2FA.
    sql: `
      ALTER TABLE service_bundles ADD COLUMN aliases TEXT;
      ALTER TABLE service_bundles ADD COLUMN alias_mode TEXT NOT NULL DEFAULT 'redirect';
      ALTER TABLE routes ADD COLUMN backend_tls_verify INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN backend_tls_server_name TEXT;
      ALTER TABLE routes ADD COLUMN backend_tls_ca_pem TEXT;
      ALTER TABLE routes ADD COLUMN max_body_mb INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE domains ADD COLUMN tls_min_version TEXT NOT NULL DEFAULT '1.2';
      ALTER TABLE routes ADD COLUMN mtls_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN mtls_ca_pem TEXT;
      ALTER TABLE routes ADD COLUMN mtls_mode TEXT NOT NULL DEFAULT 'require';`,
    detect: (db) => hasColumn(db, 'routes', 'mtls_enabled'),
  },
];

module.exports = { migrations };
