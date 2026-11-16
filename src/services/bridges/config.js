'use strict';

// The configuration of the bridge containers (docs/feature-messenger-bridges.md,
// "Configuration"), written by the server into /data/bridges before update.sh
// starts anything:
//
//   hs/config/tuwunel.toml         the internal homeserver (Tuwunel)
//   whatsapp/config/config.yaml    the WhatsApp bridge (mautrix-whatsapp)
//   signal/config/config.yaml      stage 7a: the Signal bridge (mautrix-signal) — NETWORK_MODELS says what differs
//   telegram/config/config.yaml    stage 7b: the Telegram bridge (mautrix-telegram, the Go version) — it holds the
//                                  administrator's Telegram application id (api_id / api_hash) in clear, the one place
//                                  outside secrets.json; written only while that id is set (index.js wanted())
//   hs/data, <network>/data        their databases
//   hs/run, run                    the Unix sockets: hs/run/hs.sock (the homeserver's; the bridge sees that
//                                  folder read-only), run/<network>.sock (a bridge's; its relay sees it read-only)
//                                  and run/core.sock (this server's, appservice.js; its relay sees it read-only)
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
//
// Stage 3 (messages):
//   homeserver   the server's own application service gets an address (the relay bruecken-core-relay) and the
//                ephemeral events (typing, read receipts); a third registration without address ("gcpuppet")
//                whose token the bridge uses to act for the people's internal accounts
//   bridge       double puppeting with that token (the bridge joins a person's account to new rooms itself, and
//                what the person writes in the messenger's own app arrives as theirs); one room per person even
//                for shared groups (split_portals); the bridge's word on every sent message as an event
//                (message_status_events) instead of an error text in the chat; no bot picture from another
//                server; a log that names no chats (min_level warn)
//
// Stage 5 (history, clean-up):
//   homeserver   the server's own bot account (gcbot) is made a server administrator at every start
//                (admin_execute "users make-user-admin") — only so that the server can delete a file of a room from
//                the homeserver once a plugin took it over (Synapse admin API, hs.js deleteMedia). The account has no
//                password and no device; its token never leaves this server.
//   bridge       history only while an administrator allows it (opts.history): the phone's history sync at a new
//                link is kept by the bridge (backfill.enabled — without it the bridge drops the notification), rooms
//                are made at the link for at most HISTORY.conversations chats, each with at most HISTORY.messages
//                messages; the other chats get theirs when their next message arrives. No backfill queue (it needs a
//                Beeper homeserver). Which history a PERSON wants (off, 30 days, everything) is decided by the server
//                when it arrives (events.js), not here.
//
// gc.bridges version 13 (old media from the phone, WhatsApp only): a picture, video, voice message or file of the history
// whose copy at WhatsApp ran out arrives as the bridge's notice "Old <kind>. …" (fi.mau.whatsapp.failed_media); the
// bridge keeps a request for it in its database either way (pkg/connector/backfill.go, mediarequest.go). Whether it
// asks the phone for it is the administrator's choice (opts.mediaRequests, MEDIA_REQUESTS):
//   'off'    auto_request_media false — as before (the files stay on the phone, the notice says "open it in WhatsApp")
//   'now'    request_method immediate — asked for the moment the message is backfilled (at the link, or a live message
//            with a file that ran out); what was already waiting from before is not asked for
//   'daily'  request_method local_time — the bridge's loop (mediarequest.go mediaRequestLoop) asks for everything still
//            waiting, then every 24 hours. Its time of day (request_local_time) counts in the time zone of the person's
//            login, and v0.2610.0 never sets one (pkg/connector/login.go: WALogin.Timezone is never written, so
//            UserLoginMetadata.LoadTimezone is nil): the loop then starts 8 hours after the bridge connected. The bridge
//            restarts every night for its snapshot (backup.js, BACKUP_TIME) — so the requests go out about 8 hours after
//            that time, once a day. request_local_time is not written: it would change nothing.
// When the phone answers, the bridge edits the notice into the file (m.replace with the media — events.js passes it on);
// when it cannot, into the notice "Failed to bridge media after re-requesting it …" (events.js: request 'failed').
// Signal and Telegram have no such switch: neither bridge asks a phone for a file (Telegram fetches every file from its
// servers, Signal's bridge has no media request — their key lists hold none).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_NAME = 'gc.internal';
// inside the containers (docker-compose.yml)
const RUN_DIR = '/run/bruecken';
const HS_SOCKET = `${RUN_DIR}/hs.sock`;          // as the homeserver sees its own socket
const HS_SOCKET_BRIDGE = '/run/bruecken-hs/hs.sock'; // as a bridge sees it
// stage 7: Signal (7a) and Telegram (7b) get relays of their own next to WhatsApp's
const RELAY_PORT = { whatsapp: 29318, core: 29319, signal: 29320, telegram: 29321 };
// the server's own application service on the internal homeserver: it owns the accounts of the GateControl people
const CORE_ID = 'gatecontrol';
const CORE_BOT = 'gcbot';
// a registration without address: its token lets a bridge act for those accounts ("double puppeting")
const PUPPET_ID = 'gcpuppet';
const PUPPET_BOT = 'gcpuppetbot';

// stage 5: what the bridge loads at a new link when history is allowed (estimates for a handful of people — not measured)
const HISTORY = Object.freeze({ conversations: 30, messages: 200, catchup: 100 });
// version 13: old media from the phone (see above) — the administrator's choice, 'off' unless set
const MEDIA_REQUESTS = Object.freeze(['off', 'daily', 'now']);
// 'daily': the bridge's loop starts this long after it connected (mautrix-whatsapp pkg/connector/mediarequest.go)
const MEDIA_REQUEST_DELAY_MIN = 8 * 60;

/** The media_requests section of WhatsApp's history_sync: 'off' writes exactly what was written before version 13. */
function mediaRequestsOf(mode) {
  if (mode === 'now') return { auto_request_media: true, request_method: 'immediate' };
  if (mode === 'daily') return { auto_request_media: true, request_method: 'local_time' };
  return { auto_request_media: false };
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userRegex = (prefix) => `@${reEsc(prefix)}.*:${reEsc(SERVER_NAME)}`;

// The tokens of each bridge's own registration (index.js tokens() derives them): never shared between bridges — the
// homeserver finds a registration by its as_token, so with a shared one a bridge lands in another one's namespace
const BRIDGE_TOKEN_KEYS = Object.freeze({
  whatsapp: ['asToken', 'hsToken'],
  signal: ['signalAsToken', 'signalHsToken'],
  telegram: ['telegramAsToken', 'telegramHsToken'],
});

/** → { asToken, hsToken } of the bridge `network`; throws when the secrets have none for it. */
function bridgeTokens(secrets, network) {
  const keys = BRIDGE_TOKEN_KEYS[network];
  if (!keys) throw new Error(`bridges config: unknown network ${network}`);
  const [asToken, hsToken] = keys.map((k) => secrets[k]);
  if (typeof asToken !== 'string' || !asToken || typeof hsToken !== 'string' || !hsToken) throw new Error(`bridges config: no tokens for ${network}`);
  return { asToken, hsToken };
}

/**
 * The homeserver's configuration as a model: { global: { key: value }, appservices: { id: { …, users: [ns] } } }.
 * @param {{asToken:string, hsToken:string, signalAsToken:string, signalHsToken:string, coreAsToken:string, coreHsToken:string, puppetAsToken:string, puppetHsToken:string}} secrets
 * @param {string[]} networks the bridges that are switched on
 */
function hsModel(secrets, networks) {
  const appservices = {
    // the homeserver pushes the events of the people's rooms to the server — by HTTP only, so through a relay that
    // hands the call to the server's Unix socket (run/core.sock)
    [CORE_ID]: {
      url: `http://bruecken-core-relay:${RELAY_PORT.core}`,
      as_token: secrets.coreAsToken,
      hs_token: secrets.coreHsToken,
      sender_localpart: CORE_BOT,
      rate_limited: false,
      receive_ephemeral: true,
      users: [{ exclusive: true, regex: userRegex('gc_') }],
    },
    // no url: nothing is pushed for this one, a bridge only acts with its token
    [PUPPET_ID]: {
      as_token: secrets.puppetAsToken,
      hs_token: secrets.puppetHsToken,
      sender_localpart: PUPPET_BOT,
      rate_limited: false,
      users: [{ exclusive: false, regex: userRegex('gc_') }],
    },
  };
  for (const n of networks) {
    const own = bridgeTokens(secrets, n);
    appservices[n] = {
      // the homeserver reaches a bridge by HTTP only; the relay next to it hands the call to the bridge's Unix socket
      url: `http://bruecken-${n}-relay:${RELAY_PORT[n]}`,
      as_token: own.asToken,
      hs_token: own.hsToken,
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
      // stage 4: files cross in both directions — a little more than the messenger's 25 MB (default 24 MiB);
      // the homeserver holds one upload in memory at a time per request
      max_request_size: 32 * 1024 * 1024,
      log: 'info',
      log_colors: false,
      // stage 5: the server's bot may delete a file a plugin took over (hs.js deleteMedia). Run at every start; an
      // error (the account not there yet at the very first start) does not stop the homeserver
      admin_execute: [`users make-user-admin @${CORE_BOT}:${SERVER_NAME}`],
      admin_execute_errors_ignore: true,
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
function bridgeModel(network, secrets, opts = {}) {
  const history = opts.history === true;
  if (!NETWORK_MODELS[network]) throw new Error(`bridges config: unknown network ${network}`);
  const own = NETWORK_MODELS[network]({ history, animatedStickers: opts.animatedStickers === true, telegramApp: opts.telegramApp || null,
    mediaRequests: MEDIA_REQUESTS.includes(opts.mediaRequests) ? opts.mediaRequests : 'off' });
  const tokens = bridgeTokens(secrets, network);
  const model = {
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
      // no picture: the default one lies on another server, which this island never reaches
      bot: { username: `${network}bot`, avatar: 'remove' },
      ephemeral_events: true,
      as_token: tokens.asToken,
      hs_token: tokens.hsToken,
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
      // one room per person, also for a group two people are in: nobody shares a room with another account
      split_portals: true,
      // only accounts of the internal server, and only as users — no relay, no administrator
      permissions: { [SERVER_NAME]: 'user' },
      ...(own.bridge || {}),
    },
    matrix: {
      federate_rooms: false,
      delivery_receipts: false,
      // what became of a sent message arrives as an event (the server turns it into "sent / delivered / failed"),
      // not as an error text written into the chat
      message_status_events: true,
      message_error_notices: false,
    },
    provisioning: {
      shared_secret: secrets.provisionSecret,
      allow_matrix_auth: false,
      debug_endpoints: false,
      enable_session_transfers: false,
    },
    // stage 5: history at a new link, only while an administrator allows it (see HISTORY)
    backfill: history
      ? { enabled: true, max_initial_messages: HISTORY.messages, max_catchup_messages: HISTORY.catchup, queue: { enabled: false } }
      : { enabled: false },
    double_puppet: { servers: {}, allow_discovery: false, secrets: { [SERVER_NAME]: `as_token:${secrets.puppetAsToken}` } },
    encryption: { allow: false, default: false, require: false },
    // warn: the info and debug lines name chats and accounts (ids with phone numbers) — they are not written at all
    logging: { min_level: 'warn', writers: [{ type: 'stdout', format: 'pretty' }] },
    network: own.network,
  };
  return model;
}

/**
 * What differs per bridge: its own `network` section (the connector's example-config.yaml of the pinned version) and
 * the few `bridge` keys only that bridge needs.
 */
const NETWORK_MODELS = {
  whatsapp: ({ history, mediaRequests }) => ({
    network: {
      // a contact's name: only what the contact (or the business) shows publicly — never the phone number (the
      // default falls back to it, and to its redacted form) and no " (WA)" (the apps mark the network themselves).
      // Not .FullName either: that is the name in the linking person's own address book, and a contact's account
      // ("ghost") is shared by everybody who has that contact. No name → empty; services/bridges/names.js drops what a
      // bridge still names by number, the plugin shows the person's own address book name or a neutral label
      displayname_template: '{{or .BusinessName .PushName}}',
      // without history: no rooms for old conversations at login — a room appears with its first new message.
      // With history (stage 5): rooms for the most recent chats at once; never a full sync. Files that ran out are asked
      // from the phone only with the administrator's switch (version 13, mediaRequestsOf)
      history_sync: { max_initial_conversations: history ? HISTORY.conversations : 0, request_full_sync: false, media_requests: mediaRequestsOf(mediaRequests) },
      // gc.bridges version 12 (WhatsApp status): the contacts' status updates arrive in their own room (status@broadcast),
      // which events.js marks as chat.status — the messenger shows them in its status row, not as a chat. Written down
      // so a change of the bridge's defaults moves nothing: without the room the status updates would be lost, and
      // sending into it would post a status of the person to all their contacts (never — the plugin answers a status
      // in the direct chat). The bridge's mute_status_broadcast / status_broadcast_tag are account data of the person's
      // account and have no effect here, so they keep their defaults.
      enable_status_broadcast: true,
      disable_status_broadcast_send: true,
    },
  }),
  // stage 7a: mautrix-signal v0.2610.0 (pkg/connector/example-config.yaml, config.go). It logs in as a linked device by
  // QR code only (login.go: the one flow "qr"). History: with backfill.enabled the bridge asks the phone for the
  // transfer archive at the link (login.go PerformProvisioning(…, Backfill.Enabled)) and makes a room for every chat
  // of it (chatsync.go) — once; without it no archive is asked for and a room appears with its first message. Which
  // days of it a person gets is decided by the server (index.js historyOf: at most 30 days for Signal).
  signal: () => ({
    bridge: {
      // a view-once picture arrives marked (com.beeper.view_limited) instead of with an English line written into
      // the chat (pkg/msgconv/from-signal.go) — the server turns it into a hint, the picture is not passed on
      view_limited_media: true,
    },
    network: {
      // only the name the contact shows in their Signal profile: never the number (the default falls back to it),
      // never the name of the linking person's address book or nickname ("not safe on multi-user instances")
      displayname_template: '{{or .ProfileName ""}}',
      use_contact_avatars: false,
      // no number in the topic of a direct chat's room: no number lies in the homeserver
      number_in_topic: false,
      // as the device shows in Signal › Linked devices
      device_name: 'GateControl',
      // the default picture of "Note to Self" lies on another server, which this island never reaches
      note_to_self_avatar: '',
    },
  }),
  // stage 7b: mautrix-telegram v0.2610.0 (the Go version; pkg/connector/example-config.yaml, config.go). Logins by QR
  // code or by number, code and password (login.go: the flows "phone" and "qr" — never "bot" or "manual", index.js NET).
  // It needs the administrator's own application id (ValidateConfig: without api_id / api_hash, or with the example
  // hash, it does not start) — the server writes this file only while that id is set.
  telegram: ({ animatedStickers, telegramApp }) => {
    if (!telegramApp || !Number.isSafeInteger(telegramApp.apiId) || typeof telegramApp.apiHash !== 'string') throw new Error('bridges config: telegram needs the application id');
    return {
      bridge: {
        // a view-once picture arrives marked (com.beeper.view_limited), like Signal's — a hint, the picture not passed on
        view_limited_media: true,
      },
      network: {
        api_id: telegramApp.apiId,
        api_hash: telegramApp.apiHash,
        // as the session shows in Telegram › Settings › Devices
        device_info: { device_model: 'GateControl' },
        // off (the default): a still picture (PNG, hardly any CPU); on (the administrator's switch): an animated GIF —
        // lottieconverter and ffmpeg are in the image. Video stickers (WebM) stay as they are.
        animated_sticker: { target: animatedStickers ? 'gif' : 'png', convert_from_webm: false },
        // sparing with the disk: at most 100 members of a group at the start (the others with their first message),
        // none of a channel; rooms for the 15 most recently active chats at a new link, the others with their first
        // message; no data export of the whole chat list
        member_list: { max_initial_sync: 100, sync_broadcast_channels: false },
        sync: { create_limit: 15, login_sync_limit: 15 },
        takeout: { dialog_sync: false, forward_backfill: false, backward_backfill: false },
        // a contact's name: what the contact shows (first and last name) — never the name of the linking person's
        // address book, never a picture only that person sees ("not safe on multi-user instances")
        displayname_template: '{{.FullName}}',
        contact_names: false,
        contact_avatars: false,
        // the default picture of "Saved Messages" lies on another server (the chat itself is not shown — events.js)
        saved_message_avatar: '',
        // GateControl knows no spaces: the groups of a community one by one
        bridge_communities: false,
      },
    };
  },
};

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
function files(secrets, networks, opts = {}) {
  const out = { 'hs/config/tuwunel.toml': hsToml(hsModel(secrets, networks)) };
  for (const n of networks) out[`${n}/config/config.yaml`] = bridgeYaml(bridgeModel(n, secrets, opts));
  return out;
}

function dirsOf(networks) {
  // backup (stage 5): where update.sh leaves a snapshot of the stopped containers' data for the server, and where the
  // server leaves one to be restored (services/bridges/backup.js)
  return ['run', 'backup', 'hs/run', 'hs/config', 'hs/data', ...networks.flatMap((n) => [`${n}/config`, `${n}/data`])];
}

/** What the containers were configured with — update.sh recreates them when it changes (12 hex digits). */
function rev(secrets, networks, opts = {}) {
  const h = crypto.createHash('sha256');
  for (const [name, content] of Object.entries(files(secrets, networks, opts)).sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${name}\0${content}\0`);
  return h.digest('hex').slice(0, 12);
}

/**
 * Make the folders and write the files that differ. → { changed: [relative paths], rev }
 * The folders are 0700: the containers reach them as root with DAC_OVERRIDE (see docker-compose.yml), nobody else does.
 */
function write(dir, secrets, networks, opts = {}) {
  for (const d of dirsOf(networks)) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  const changed = [];
  for (const [name, content] of Object.entries(files(secrets, networks, opts))) {
    const file = path.join(dir, name);
    let have = null;
    try { have = fs.readFileSync(file, 'utf8'); } catch { have = null; }
    if (have === content) continue;
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
    changed.push(name);
  }
  return { changed, rev: rev(secrets, networks, opts) };
}

module.exports = {
  SERVER_NAME, RUN_DIR, HS_SOCKET, HS_SOCKET_BRIDGE, RELAY_PORT, CORE_ID, CORE_BOT, PUPPET_ID, PUPPET_BOT, HISTORY,
  MEDIA_REQUESTS, MEDIA_REQUEST_DELAY_MIN, mediaRequestsOf,
  hsModel, hsToml, bridgeModel, bridgeYaml, files, rev, write, bridgeTokens, BRIDGE_TOKEN_KEYS,
};
