'use strict';

// The configuration of the bridge containers (docs/feature-messenger-bridges.md,
// "Configuration"), written by the server into /data/bridges before update.sh
// starts anything:
//
//   hs/config/tuwunel.toml         the internal homeserver (Tuwunel)
//   whatsapp/config/config.yaml    the WhatsApp bridge (mautrix-whatsapp)
//   hs/data, whatsapp/data         their databases
//   hs/run, run                    the Unix sockets: hs/run/hs.sock (the homeserver's; the bridge sees that
//                                  folder read-only) and run/<network>.sock (a bridge's; its relay sees it read-only)
//
// Every key written here exists in the example configuration of the pinned
// version (images.js) — tests/bridges_config.test.js checks each one against
// the key lists in tests/fixtures/bridges/. Nothing is guessed: a key that a
// version does not document is not written. The homeserver runs with
// error_on_unknown_config_opts, so a wrong key stops it at start instead of
// being ignored.
//
// Idempotent: the same master key gives the same files, and a file is only
// rewritten when its content changes (rev() tells update.sh when the
// containers must be recreated). The files hold the tokens derived from the
// master key and are 0600; nothing of them is returned by any API.
//
// Sparing with the disk (the server's is slow, ~38 ms per fdatasync):
//   homeserver   small caches (db_cache_capacity_mb, db_write_buffer_capacity_mb,
//                cache_capacity_modifier), no presence, no federation
//   bridge       SQLite in WAL mode with synchronous=NORMAL (what the driver
//                "sqlite3-fk-wal" sets), no history (backfill.enabled false,
//                no rooms for old conversations at login), no encryption
//                inside the internal server, no spaces, no status notices

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_NAME = 'gc.internal';
// inside the containers (docker-compose.yml)
const RUN_DIR = '/run/bruecken';
const HS_SOCKET = `${RUN_DIR}/hs.sock`;          // as the homeserver sees its own socket
const HS_SOCKET_BRIDGE = '/run/bruecken-hs/hs.sock'; // as a bridge sees it
const RELAY_PORT = { whatsapp: 29318 };
// the server's own application service on the internal homeserver: it owns the accounts of the GateControl people
const CORE_ID = 'gatecontrol';
const CORE_BOT = 'gcbot';

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userRegex = (prefix) => `@${reEsc(prefix)}.*:${reEsc(SERVER_NAME)}`;

/**
 * The homeserver's configuration as a model: { global: { key: value }, appservices: { id: { …, users: [ns] } } }.
 * @param {{asToken:string, hsToken:string, coreAsToken:string, coreHsToken:string}} secrets
 * @param {string[]} networks the bridges that are switched on
 */
function hsModel(secrets, networks) {
  const appservices = {
    // no url: the server asks the homeserver, the homeserver never calls the server
    [CORE_ID]: {
      as_token: secrets.coreAsToken,
      hs_token: secrets.coreHsToken,
      sender_localpart: CORE_BOT,
      rate_limited: false,
      users: [{ exclusive: true, regex: userRegex('gc_') }],
    },
  };
  for (const n of networks) {
    appservices[n] = {
      // the homeserver reaches a bridge by HTTP only; the relay next to it hands the call to the bridge's Unix socket
      url: `http://bruecken-${n}-relay:${RELAY_PORT[n]}`,
      as_token: secrets.asToken,
      hs_token: secrets.hsToken,
      sender_localpart: `${n}bot`,
      rate_limited: false,
      receive_ephemeral: true,
      users: [{ exclusive: true, regex: userRegex(`${n}_`) }],
    };
  }
  return {
    global: {
      server_name: SERVER_NAME,
      database_path: '/var/lib/tuwunel',
      unix_socket_path: HS_SOCKET,
      error_on_unknown_config_opts: true,
      // an island: nobody registers, nobody federates, no key servers
      allow_registration: false,
      allow_guest_registration: false,
      allow_federation: false,
      federate_created_rooms: false,
      federate_admin_room: false,
      grant_admin_to_first_user: false,
      trusted_servers: [],
      new_user_displayname_suffix: '',
      // small: a handful of people, no rooms of other servers
      db_cache_capacity_mb: 32,
      db_write_buffer_capacity_mb: 16,
      cache_capacity_modifier: 0.25,
      allow_local_presence: false,
      allow_incoming_presence: false,
      allow_outgoing_presence: false,
      log: 'info',
      log_colors: false,
    },
    appservices,
  };
}

const TOML_FLOAT = new Set(['db_cache_capacity_mb', 'db_write_buffer_capacity_mb', 'cache_capacity_modifier']);

function tomlValue(key, v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return TOML_FLOAT.has(key) && Number.isInteger(v) ? v.toFixed(1) : String(v);
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(key, x)).join(', ')}]`;
  throw new Error(`bridges config: no TOML form for ${key}`);
}

function hsToml(model) {
  const out = ['# Written by GateControl (src/services/bridges/config.js) — changes are overwritten.', '', '[global]'];
  for (const [k, v] of Object.entries(model.global)) out.push(`${k} = ${tomlValue(k, v)}`);
  for (const [id, as] of Object.entries(model.appservices)) {
    out.push('', `[global.appservice.${id}]`);
    for (const [k, v] of Object.entries(as)) if (k !== 'users') out.push(`${k} = ${tomlValue(k, v)}`);
    for (const ns of as.users) {
      out.push('', `[[global.appservice.${id}.users]]`);
      for (const [k, v] of Object.entries(ns)) out.push(`${k} = ${tomlValue(k, v)}`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * The configuration of a mautrix bridge as a model (only what differs from the bridge's own defaults; the bridge
 * fills in the rest from its built-in example and, started with --no-update, never writes the file).
 */
function bridgeModel(network, secrets) {
  if (network !== 'whatsapp') throw new Error(`bridges config: unknown network ${network}`);
  return {
    homeserver: {
      address: `unix://${HS_SOCKET_BRIDGE}`,
      domain: SERVER_NAME,
      software: 'standard',
    },
    appservice: {
      address: `http://bruecken-${network}-relay:${RELAY_PORT[network]}`,
      // an absolute path = listen on a Unix socket (appservice and provisioning API)
      hostname: `${RUN_DIR}/${network}.sock`,
      port: 0,
      id: network,
      bot: { username: `${network}bot` },
      ephemeral_events: true,
      as_token: secrets.asToken,
      hs_token: secrets.hsToken,
      username_template: `${network}_{{.}}`,
    },
    database: {
      type: 'sqlite3-fk-wal',
      uri: `file:/data/${network}.db?_txlock=immediate`,
      max_open_conns: 5,
      max_idle_conns: 1,
    },
    bridge: {
      personal_filtering_spaces: false,
      bridge_status_notices: 'none',
      // only accounts of the internal server, and only as users — no relay, no administrator
      permissions: { [SERVER_NAME]: 'user' },
    },
    matrix: {
      federate_rooms: false,
      delivery_receipts: false,
      message_status_events: false,
    },
    provisioning: {
      shared_secret: secrets.provisionSecret,
      allow_matrix_auth: false,
      debug_endpoints: false,
      enable_session_transfers: false,
    },
    backfill: { enabled: false },
    double_puppet: { servers: {}, allow_discovery: false, secrets: {} },
    encryption: { allow: false, default: false, require: false },
    logging: { min_level: 'info', writers: [{ type: 'stdout', format: 'pretty' }] },
    network: {
      // no rooms for old conversations at login: a room appears with its first new message
      history_sync: { max_initial_conversations: 0, request_full_sync: false, media_requests: { auto_request_media: false } },
    },
  };
}

function yamlScalar(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  throw new Error('bridges config: no YAML form');
}

const YAML_KEY = /^[A-Za-z0-9_.-]+$/;

function yamlLines(v, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [k, x] of Object.entries(v)) {
    const key = YAML_KEY.test(k) ? k : JSON.stringify(k);
    if (Array.isArray(x)) {
      if (!x.length) { out.push(`${pad}${key}: []`); continue; }
      out.push(`${pad}${key}:`);
      for (const item of x) {
        const lines = yamlLines(item, indent + 6);
        out.push(`${pad}    - ${lines[0].trimStart()}`, ...lines.slice(1));
      }
    } else if (x && typeof x === 'object') {
      if (!Object.keys(x).length) out.push(`${pad}${key}: {}`);
      else out.push(`${pad}${key}:`, ...yamlLines(x, indent + 4));
    } else {
      out.push(`${pad}${key}: ${yamlScalar(x)}`);
    }
  }
  return out;
}

function bridgeYaml(model) {
  return ['# Written by GateControl (src/services/bridges/config.js) — changes are overwritten.', ...yamlLines(model, 0)].join('\n') + '\n';
}

// ─── Files ─────────────────────────────────────────────

/** The files of the containers: relative path → content. */
function files(secrets, networks) {
  const out = { 'hs/config/tuwunel.toml': hsToml(hsModel(secrets, networks)) };
  for (const n of networks) out[`${n}/config/config.yaml`] = bridgeYaml(bridgeModel(n, secrets));
  return out;
}

function dirsOf(networks) {
  return ['run', 'hs/run', 'hs/config', 'hs/data', ...networks.flatMap((n) => [`${n}/config`, `${n}/data`])];
}

/** What the containers were configured with — update.sh recreates them when it changes (12 hex digits). */
function rev(secrets, networks) {
  const h = crypto.createHash('sha256');
  for (const [name, content] of Object.entries(files(secrets, networks)).sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${name}\0${content}\0`);
  return h.digest('hex').slice(0, 12);
}

/**
 * Make the folders and write the files that differ. → { changed: [relative paths], rev }
 * The folders are 0700: the containers reach them as root with DAC_OVERRIDE (see docker-compose.yml), nobody else does.
 */
function write(dir, secrets, networks) {
  for (const d of dirsOf(networks)) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  const changed = [];
  for (const [name, content] of Object.entries(files(secrets, networks))) {
    const file = path.join(dir, name);
    let have = null;
    try { have = fs.readFileSync(file, 'utf8'); } catch { have = null; }
    if (have === content) continue;
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
    changed.push(name);
  }
  return { changed, rev: rev(secrets, networks) };
}

module.exports = {
  SERVER_NAME, RUN_DIR, HS_SOCKET, HS_SOCKET_BRIDGE, RELAY_PORT, CORE_ID, CORE_BOT,
  hsModel, hsToml, bridgeModel, bridgeYaml, files, rev, write,
};
