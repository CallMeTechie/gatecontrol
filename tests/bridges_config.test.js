'use strict';

// Messenger bridges, stage 2 (docs/feature-messenger-bridges.md): the pinned
// images, the release docker-compose.yml(s) with the profile "bruecken", the
// configuration the server writes for the containers — every key checked
// against the example configuration of the PINNED versions
// (tests/fixtures/bridges/, taken from the release tags) — the "outdated"
// state, what `update.sh bridges-probe` measured, the internal account, and
// ending somebody else's link (gc.bridges.unlinkFor).
//
// Nothing here starts a container: whether the programs accept the files is
// what the probe on a real Docker host shows.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { startFakeBridge } = require('./helpers/fake-bridge');

const ROOT = path.join(__dirname, '..');
const config = require('../src/services/bridges/config');
const images = require('../src/services/bridges/images');
const TUWUNEL = require('./fixtures/bridges/keys-tuwunel-1.9.4.json');
const MAUTRIX = require('./fixtures/bridges/keys-mautrix-whatsapp-0.2610.0.json');
const SECRETS = { asToken: 'a'.repeat(43), hsToken: 'b'.repeat(43), provisionSecret: 'c'.repeat(43), coreAsToken: 'd'.repeat(43), coreHsToken: 'e'.repeat(43) };

function keyPaths(o, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, p));
  }
  return out;
}

/** The block YAML config.js writes (maps, scalars, {} / [], lists of maps) → an object. */
function parseYaml(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  let i = 0;
  const scalar = (v) => (v === '{}' ? {} : v === '[]' ? [] : JSON.parse(v));
  function map(indent) {
    const o = {};
    while (i < lines.length) {
      const l = lines[i];
      const ind = l.length - l.trimStart().length;
      if (ind < indent || l.trimStart().startsWith('- ')) break;
      assert.equal(ind, indent, `indentation of: ${l}`);
      const m = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+):(?: (.*))?$/.exec(l.trim());
      assert.ok(m, `not a key line: ${l}`);
      const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
      i++;
      if (m[2] !== undefined) { o[key] = scalar(m[2]); continue; }
      const next = lines[i] || '';
      if (next.trimStart().startsWith('- ')) {
        const list = [];
        const li = next.length - next.trimStart().length;
        while (i < lines.length && lines[i].length - lines[i].trimStart().length === li && lines[i].trimStart().startsWith('- ')) {
          lines[i] = `${' '.repeat(li + 2)}${lines[i].trimStart().slice(2)}`;
          list.push(map(li + 2));
        }
        o[key] = list;
      } else o[key] = map(next.length - next.trimStart().length);
    }
    return o;
  }
  return map(0);
}

describe('pinned images and the release docker-compose.yml', () => {
  it('every image is pinned by version and digest', () => {
    assert.deepEqual(Object.keys(images.IMAGES), ['hs', 'whatsapp', 'whatsapp-relay']);
    for (const [name, i] of Object.entries(images.IMAGES)) {
      assert.match(i.digest, /^sha256:[0-9a-f]{64}$/, name);
      assert.match(i.tag, /^v?\d+(\.\d+)+$/, `${name}: a version, never latest`);
      assert.equal(i.tag.replace(/^v/, ''), i.version);
      assert.equal(images.ref(name), `${i.repo}:${i.tag}@${i.digest}`);
    }
    assert.equal(images.IMAGES.hs.version, TUWUNEL.version, 'the homeserver keys were taken from the pinned version');
    assert.equal(images.IMAGES.whatsapp.version, MAUTRIX.versions['mautrix-whatsapp'], 'the bridge keys were taken from the pinned version');
  });

  for (const f of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // one service block: from "  <name>:" to the next line with two spaces of indentation or less
    const block = (name) => {
      const m = new RegExp(`^  ${name}:\\n((?:(?:    .*|\\s*)\\n)+)`, 'm').exec(src);
      assert.ok(m, `${f}: service ${name}`);
      return m[1];
    };

    it(`${f}: the profile "bruecken" names exactly the pinned images`, () => {
      for (const [name, i] of Object.entries(images.IMAGES)) {
        const b = block(i.service);
        assert.ok(b.includes(`    image: ${images.ref(name)}\n`), `${f}: ${i.service} must run ${images.ref(name)}`);
        assert.match(b, /^ {4}profiles: \["bruecken"\]$/m, `${i.service}: only with the profile`);
        assert.match(b, new RegExp(`^ {4}container_name: ${i.service}$`, 'm'));
      }
    });

    it(`${f}: no port, no host network, hardened, limited`, () => {
      for (const i of Object.values(images.IMAGES)) {
        const b = block(i.service);
        assert.doesNotMatch(b, /^\s+ports:/m, `${i.service}: publishes nothing`);
        assert.doesNotMatch(b, /network_mode/, `${i.service}: not on the host network`);
        assert.doesNotMatch(b, /privileged|docker\.sock/, i.service);
        assert.match(b, /^ {4}read_only: true$/m, i.service);
        assert.match(b, /^ {4}cap_drop:\n {6}- ALL$/m, i.service);
        assert.match(b, /^ {4}cap_add:\n {6}- DAC_OVERRIDE\n {4}\S/m, `${i.service}: one capability, no more`);
        assert.match(b, /^ {4}security_opt:\n {6}- no-new-privileges:true$/m, i.service);
        assert.match(b, /^ {4}mem_limit: \d+m$/m, i.service);
        assert.match(b, /^ {4}cpus: "[0-9.]+"$/m, i.service);
        assert.match(b, /^ {4}pids_limit: \d+$/m, i.service);
        assert.match(b, /^ {4}healthcheck:$/m, i.service);
        // only folders below the bridges' own data folder
        for (const v of b.match(/^ {6}- \S+:\S+$/gm).filter((l) => l.includes('/'))) {
          if (/^ {6}- \/tmp:/.test(v)) continue;
          assert.match(v, /^ {6}- \$\{GC_BRIDGES_DIR:-\.\/data\/bridges\}\/[a-z/]+:\/[a-z/-]+(:ro)?$/, `${i.service}: ${v.trim()}`);
        }
      }
      // the homeserver and the relay have no way out; only a bridge has, and it shares no network with them
      assert.match(block('bruecken-hs'), /^ {4}networks:\n {6}- bruecken-intern\n {4}\S/m);
      assert.match(block('bruecken-whatsapp-relay'), /^ {4}networks:\n {6}- bruecken-intern\n {4}\S/m);
      assert.match(block('bruecken-whatsapp'), /^ {4}networks:\n {6}- bruecken-aussen\n {4}\S/m);
      assert.match(src, /^ {2}bruecken-intern:\n {4}internal: true$/m);
      // configuration read-only, sockets of the other side read-only
      assert.match(block('bruecken-hs'), /\/hs\/config:\/etc\/bruecken:ro$/m);
      assert.match(block('bruecken-whatsapp'), /\/whatsapp\/config:\/etc\/bruecken:ro$/m);
      assert.match(block('bruecken-whatsapp'), /\/hs\/run:\/run\/bruecken-hs:ro$/m);
      assert.match(block('bruecken-whatsapp-relay'), /\/run:\/run\/bruecken:ro$/m);
      // the bridge never rewrites the configuration and is not started through the image's script
      assert.match(block('bruecken-whatsapp'), /command: \["\/usr\/bin\/mautrix-whatsapp", "--config", "\/etc\/bruecken\/config\.yaml", "--no-update"\]/);
      assert.match(block('bruecken-hs'), /command: \["--config", "\/etc\/bruecken\/tuwunel\.toml"\]/);
    });

    it(`${f}: paths, sockets and the relay port are the ones the configuration uses`, () => {
      const port = config.RELAY_PORT.whatsapp;
      assert.ok(block('bruecken-whatsapp-relay').includes(`command: ["TCP-LISTEN:${port},fork,reuseaddr", "UNIX-CONNECT:${config.RUN_DIR}/whatsapp.sock"]`));
      const hs = config.hsModel(SECRETS, ['whatsapp']);
      assert.equal(hs.appservices.whatsapp.url, `http://bruecken-whatsapp-relay:${port}`);
      assert.equal(hs.global.unix_socket_path, '/run/bruecken/hs.sock');
      assert.match(block('bruecken-hs'), /\/hs\/run:\/run\/bruecken$/m);
      assert.match(block('bruecken-hs'), /\/hs\/data:\/var\/lib\/tuwunel$/m);
      assert.equal(hs.global.database_path, '/var/lib/tuwunel');
      const br = config.bridgeModel('whatsapp', SECRETS);
      assert.equal(br.homeserver.address, 'unix:///run/bruecken-hs/hs.sock');
      assert.equal(br.appservice.hostname, '/run/bruecken/whatsapp.sock');
      assert.match(block('bruecken-whatsapp'), /\/whatsapp\/data:\/data$/m);
      assert.match(br.database.uri, /^file:\/data\/whatsapp\.db\?/);
    });
  }

  it('both compose files carry the same bridge services', () => {
    const cut = (f) => { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); return s.slice(s.indexOf('  # Messenger bridges')); };
    assert.equal(cut('docker-compose.yml'), cut('deploy/docker-compose.yml'));
  });
});

describe('the homeserver configuration (Tuwunel)', () => {
  const model = config.hsModel(SECRETS, ['whatsapp']);

  it('writes only keys the pinned version documents', () => {
    const known = new Set(TUWUNEL.sections.global);
    for (const k of Object.keys(model.global)) assert.ok(known.has(k), `[global] ${k} is not in tuwunel-example.toml of ${TUWUNEL.version}`);
    const as = new Set(TUWUNEL.sections['global.appservice.<ID>']);
    const ns = new Set(TUWUNEL.sections['global.appservice.<ID>.<users|rooms|aliases>']);
    for (const [id, a] of Object.entries(model.appservices)) {
      for (const k of Object.keys(a)) if (k !== 'users') assert.ok(as.has(k), `[global.appservice.${id}] ${k}`);
      for (const n of a.users) for (const k of Object.keys(n)) assert.ok(ns.has(k), `[[global.appservice.${id}.users]] ${k}`);
    }
  });

  it('is an island: no federation, no registration, no guests, no key servers — and strict about unknown keys', () => {
    const g = model.global;
    assert.equal(g.server_name, 'gc.internal');
    assert.equal(g.allow_federation, false);
    assert.equal(g.federate_created_rooms, false);
    assert.equal(g.federate_admin_room, false);
    assert.equal(g.allow_registration, false);
    assert.equal(g.allow_guest_registration, false);
    assert.equal(g.grant_admin_to_first_user, false);
    assert.deepEqual(g.trusted_servers, []);
    assert.equal(g.error_on_unknown_config_opts, true);
    assert.ok(!('address' in g) && !('port' in g), 'the TCP listener stays on its default: loopback inside the container');
  });

  it('is small: caches far below the defaults (128 + 64 × cores MB)', () => {
    assert.ok(model.global.db_cache_capacity_mb <= 64);
    assert.ok(model.global.db_write_buffer_capacity_mb <= 32);
    assert.ok(model.global.cache_capacity_modifier < 1);
    assert.equal(model.global.allow_local_presence, false);
  });

  it('registers the bridge and the server itself, each with its own tokens and namespace', () => {
    const { whatsapp, gatecontrol } = model.appservices;
    assert.equal(whatsapp.as_token, SECRETS.asToken);
    assert.equal(whatsapp.hs_token, SECRETS.hsToken);
    assert.equal(whatsapp.sender_localpart, 'whatsappbot');
    assert.deepEqual(whatsapp.users, [{ exclusive: true, regex: '@whatsapp_.*:gc\\.internal' }]);
    assert.equal(gatecontrol.as_token, SECRETS.coreAsToken);
    assert.ok(!('url' in gatecontrol), 'the homeserver never calls the server');
    assert.deepEqual(gatecontrol.users, [{ exclusive: true, regex: '@gc_.*:gc\\.internal' }]);
    assert.equal(new Set([whatsapp.as_token, whatsapp.hs_token, gatecontrol.as_token, gatecontrol.hs_token]).size, 4);
    // a bridge that is switched off is not registered
    assert.deepEqual(Object.keys(config.hsModel(SECRETS, []).appservices), ['gatecontrol']);
  });

  it('serialises to TOML: one [global] table, appservice tables, floats as floats, strings escaped', () => {
    const toml = config.hsToml(model);
    assert.match(toml, /^\[global\]$/m);
    assert.match(toml, /^server_name = "gc\.internal"$/m);
    assert.match(toml, /^db_cache_capacity_mb = 32\.0$/m);
    assert.match(toml, /^cache_capacity_modifier = 0\.25$/m);
    assert.match(toml, /^trusted_servers = \[\]$/m);
    assert.match(toml, /^\[global\.appservice\.whatsapp\]\nurl = "http:\/\/bruecken-whatsapp-relay:29318"$/m);
    assert.match(toml, /^\[\[global\.appservice\.whatsapp\.users\]\]\nexclusive = true\nregex = "@whatsapp_\.\*:gc\\\\\.internal"$/m);
    // every line is a comment, a table header or key = value
    for (const l of toml.split('\n')) assert.match(l, /^(#.*|\[\[?[a-z._]+\]\]?|[a-z_]+ = (".*"|true|false|\d+(\.\d+)?|\[\])|)$/, l);
    // every table once
    const heads = toml.split('\n').filter((l) => /^\[[a-z]/.test(l));
    assert.equal(new Set(heads).size, heads.length);
  });
});

describe('the bridge configuration (mautrix-whatsapp)', () => {
  const model = config.bridgeModel('whatsapp', SECRETS);

  it('writes only keys the pinned version documents', () => {
    const known = new Set(MAUTRIX.keys);
    // user-chosen map keys below these (a server name, a Matrix id)
    const free = ['bridge.permissions.', 'double_puppet.servers.', 'double_puppet.secrets.'];
    for (const p of keyPaths(model)) {
      if (free.some((f) => p.startsWith(f))) continue;
      assert.ok(known.has(p), `${p} is not in the example configuration of mautrix-whatsapp ${MAUTRIX.versions['mautrix-whatsapp']}`);
    }
    for (const w of model.logging.writers) assert.deepEqual(Object.keys(w), ['type', 'format']);
  });

  it('talks over Unix sockets only and takes its tokens from the server', () => {
    assert.match(model.homeserver.address, /^unix:\/\/\//);
    assert.match(model.appservice.hostname, /^\//, 'an absolute path = a Unix socket listener');
    assert.equal(model.appservice.port, 0);
    assert.equal(model.appservice.as_token, SECRETS.asToken);
    assert.equal(model.appservice.hs_token, SECRETS.hsToken);
    assert.equal(model.provisioning.shared_secret, SECRETS.provisionSecret);
    assert.ok(model.provisioning.shared_secret.length >= 16);
    assert.equal(model.provisioning.allow_matrix_auth, false);
    assert.equal(model.provisioning.debug_endpoints, false);
    assert.equal(model.provisioning.enable_session_transfers, false, 'session credentials never leave through the API');
    assert.equal(model.appservice.username_template, 'whatsapp_{{.}}');
    assert.equal(model.homeserver.domain, 'gc.internal');
  });

  it('passes the bridge’s own start checks (mxmain validateConfig)', () => {
    assert.notEqual(model.homeserver.address, 'http://example.localhost:8008');
    assert.notEqual(model.homeserver.domain, 'example.com');
    assert.equal(model.homeserver.software, 'standard');
    assert.doesNotMatch(model.appservice.as_token, /generated/);
    assert.doesNotMatch(model.database.uri, /user:password/);
    assert.deepEqual(model.bridge.permissions, { 'gc.internal': 'user' }, 'only accounts of the internal server, never "*", no administrator');
    assert.ok(model.appservice.username_template.includes('{{.}}'));
  });

  it('spares the disk: SQLite in WAL mode, no history, no rooms for old chats, no encryption, no spaces', () => {
    assert.equal(model.database.type, 'sqlite3-fk-wal');
    assert.match(model.database.uri, /_txlock=immediate$/);
    assert.equal(model.backfill.enabled, false);
    assert.equal(model.network.history_sync.max_initial_conversations, 0);
    assert.equal(model.network.history_sync.request_full_sync, false);
    assert.equal(model.network.history_sync.media_requests.auto_request_media, false);
    assert.equal(model.encryption.allow, false);
    assert.equal(model.bridge.personal_filtering_spaces, false);
    assert.equal(model.matrix.federate_rooms, false);
    assert.deepEqual(model.double_puppet, { servers: {}, allow_discovery: false, secrets: {} }, 'none of the example servers of the built-in defaults');
    assert.deepEqual(model.logging.writers, [{ type: 'stdout', format: 'pretty' }], 'no log file');
  });

  it('serialises to YAML that reads back as the same object', () => {
    const yaml = config.bridgeYaml(model);
    assert.deepEqual(parseYaml(yaml), model);
    assert.match(yaml, /^ {4}username_template: "whatsapp_\{\{\.\}\}"$/m);
    assert.doesNotMatch(yaml, /\t/);
  });

  it('knows no other network', () => {
    assert.throws(() => config.bridgeModel('telegram', SECRETS), /unknown network/);
  });
});

describe('writing the files', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bridges-cfg-')); });

  it('makes folders (0700) and files (0600), is idempotent, and the revision follows the content', () => {
    const a = config.write(dir, SECRETS, ['whatsapp']);
    assert.deepEqual(a.changed.sort(), ['hs/config/tuwunel.toml', 'whatsapp/config/config.yaml']);
    assert.match(a.rev, /^[0-9a-f]{12}$/);
    for (const d of ['run', 'hs/run', 'hs/config', 'hs/data', 'whatsapp/config', 'whatsapp/data']) {
      assert.equal(fs.statSync(path.join(dir, d)).mode & 0o777, 0o700, d);
    }
    for (const f of a.changed) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    const mtime = fs.statSync(path.join(dir, 'hs/config/tuwunel.toml')).mtimeMs;

    const b = config.write(dir, SECRETS, ['whatsapp']);
    assert.deepEqual(b.changed, [], 'nothing is rewritten');
    assert.equal(b.rev, a.rev);
    assert.equal(fs.statSync(path.join(dir, 'hs/config/tuwunel.toml')).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'hs/config')), ['tuwunel.toml'], 'no temporary file left');

    const c = config.write(dir, { ...SECRETS, asToken: 'z'.repeat(43) }, ['whatsapp']);
    assert.deepEqual(c.changed.sort(), ['hs/config/tuwunel.toml', 'whatsapp/config/config.yaml']);
    assert.notEqual(c.rev, a.rev);
    // a file changed by hand is put back
    fs.appendFileSync(path.join(dir, 'whatsapp/config/config.yaml'), 'backfill: { enabled: true }\n');
    assert.deepEqual(config.write(dir, { ...SECRETS, asToken: 'z'.repeat(43) }, ['whatsapp']).changed, ['whatsapp/config/config.yaml']);
  });
});

describe('the service with stage 2', () => {
  let bridges, au, hostApi, ctx, db, adminId, parentId, childId;
  const PLUGIN = { id: 'bridge-demo', manifest: { permissions: { bridges: true } } };
  const call = (api, args) => hostApi.handle(PLUGIN, api, args);
  const stateFile = () => path.join(au.DATA_DIR, '.bridges-state.json');
  const probeFile = () => path.join(au.DATA_DIR, '.bridges-probe.json');

  before(async () => {
    await setup();
    bridges = require('../src/services/bridges');
    au = require('../src/services/autoUpdate');
    hostApi = require('../src/services/plugins/hostApi');
    ctx = require('../src/services/plugins/personContext');
    db = require('../src/db/connection').getDb();
    adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    const add = db.prepare('INSERT INTO users (username, password_hash, role, enabled, language, display_name) VALUES (?, ?, ?, 1, ?, ?)');
    parentId = Number(add.run('parent-bridges2', 'x', 'user', 'de', 'Elternteil').lastInsertRowid);
    childId = Number(add.run('child-bridges2', 'x', 'user', 'de', 'Kind').lastInsertRowid);
    process.env.GC_BRIDGES_PREVIEW = '1';
  });
  after(() => { delete process.env.GC_BRIDGES_PREVIEW; teardown(); });

  it('writes the configuration when switched on, and tells update.sh its revision', () => {
    bridges.configure({ enabled: true, networks: { whatsapp: true } }, { actor: { id: adminId, name: 'admin' }, pluginId: PLUGIN.id });
    const toml = fs.readFileSync(path.join(bridges.dir(), 'hs/config/tuwunel.toml'), 'utf8');
    const yaml = parseYaml(fs.readFileSync(path.join(bridges.dir(), 'whatsapp/config/config.yaml'), 'utf8'));
    const secrets = bridges.readSecrets();
    assert.equal(yaml.provisioning.shared_secret, secrets.provisionSecret);
    assert.ok(toml.includes(`as_token = "${secrets.asToken}"`));
    assert.ok(toml.includes(`as_token = "${secrets.coreAsToken}"`));
    assert.ok(!toml.includes(JSON.parse(fs.readFileSync(path.join(bridges.dir(), 'secrets.json'), 'utf8')).key), 'the master key itself is in no configuration');
    const cfg = JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8'));
    assert.equal(cfg.bridges, 'whatsapp');
    assert.match(cfg.bridges_rev, /^[0-9a-f]{12}$/);
    assert.equal(cfg.bridges_rev, config.rev(secrets, ['whatsapp']));
    // the same after a restart: nothing changes
    au.syncConfigFile();
    assert.equal(JSON.parse(fs.readFileSync(au.CONFIG_FILE, 'utf8')).bridges_rev, cfg.bridges_rev);
    // no status call and no host API gives a token away
    const all = JSON.stringify(bridges.status());
    for (const t of Object.values(secrets)) assert.ok(!all.includes(t));
  });

  it('shows "outdated" when a container runs another image than the pinned one', () => {
    const svc = (image) => ({ running: true, mem_mb: 50, limit_mb: 384, version: '', image });
    const write = (hsImg, waImg) => fs.writeFileSync(stateFile(), JSON.stringify({ checked_at: new Date().toISOString(), state: 'running', error: '', services: { hs: svc(hsImg), whatsapp: svc(waImg) } }));
    write(images.ref('hs'), images.ref('whatsapp'));
    let st = bridges.status();
    assert.equal(st.networks[0].outdated, false);
    assert.equal(st.networks[0].version, '0.2610.0', 'the version from the image reference when the image carries no label');
    assert.equal(st.host.homeserver.outdated, false);

    write(images.ref('hs'), `dock.mau.dev/mautrix/whatsapp:v0.2609.0@sha256:${'1'.repeat(64)}`);
    st = bridges.status();
    assert.equal(st.networks[0].outdated, true);
    assert.equal(st.networks[0].version, '0.2609.0');
    assert.equal(st.networks[0].wantVersion, '0.2610.0');
    assert.equal(st.host.homeserver.outdated, false);

    // an older update.sh (no image) or nonsense: unknown, not "outdated"
    write(undefined, '<script>');
    st = bridges.status();
    assert.equal(st.networks[0].outdated, false);
    assert.equal(st.host.homeserver.outdated, false);
    assert.deepEqual(images.compare('whatsapp', 'x'), { version: null, outdated: null });
  });

  it('shows what the probe measured — numbers only, never its log lines', () => {
    assert.equal(bridges.status().host.probe, null);
    fs.writeFileSync(probeFile(), JSON.stringify({
      probed_at: '2026-11-14T12:00:00+01:00', update_sh: 6, result: 'ok', window_s: 60, disk_mb: 12,
      services: {
        hs: { running: true, restarts: 0, oom: false, exit: 0, health: 'healthy', mem_mb: 71, mem_peak_mb: 80, limit_mb: 384, write_kb: 512, blkio_write_kb: 600, image: 'x' },
        whatsapp: { running: true, restarts: 2, oom: true, mem_mb: 'many', mem_peak_mb: -1, limit_mb: 512, write_kb: 9 },
        other: { running: true },
      },
      sockets: { hs: true, whatsapp: 'yes' },
      logs: { hs: 'SECRET LINES' },
    }));
    const p = bridges.status().host.probe;
    assert.equal(p.at, '2026-11-14T11:00:00.000Z');
    assert.equal(p.result, 'ok');
    assert.equal(p.windowSeconds, 60);
    assert.equal(p.diskMb, 12);
    assert.deepEqual(p.services.hs, { running: true, restarts: 0, oomKilled: false, memMb: 71, memPeakMb: 80, limitMb: 384, writtenKb: 512 });
    assert.deepEqual(p.services.whatsapp, { running: true, restarts: 2, oomKilled: true, memMb: null, memPeakMb: null, limitMb: 512, writtenKb: 9 });
    assert.ok(!('other' in p.services));
    assert.deepEqual(p.sockets, { hs: true, whatsapp: false });
    assert.ok(!JSON.stringify(bridges.status()).includes('SECRET'));
    fs.writeFileSync(probeFile(), '{"probed_at":"x"}');
    assert.equal(bridges.status().host.probe, null);
    fs.unlinkSync(probeFile());
  });

  describe('with a bridge and a homeserver', () => {
    let bridge, hsServer, hsRequests;
    before(async () => {
      const secrets = bridges.ensureSecrets();
      bridge = await startFakeBridge({ socket: path.join(bridges.dir(), 'run', 'whatsapp.sock'), secret: secrets.provisionSecret });
      fs.writeFileSync(stateFile(), JSON.stringify({ checked_at: new Date().toISOString(), state: 'running', error: '', services: { hs: { running: true }, whatsapp: { running: true } } }));
      hsRequests = [];
      const known = new Set();
      hsServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const j = JSON.parse(body || '{}');
          hsRequests.push({ url: req.url, auth: req.headers.authorization, body: j });
          const send = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
          if (req.headers.authorization !== `Bearer ${secrets.coreAsToken}`) return send(401, { errcode: 'M_UNKNOWN_TOKEN' });
          if (known.has(j.username)) return send(400, { errcode: 'M_USER_IN_USE', error: 'taken' });
          known.add(j.username);
          return send(200, { user_id: `@${j.username}:gc.internal` });
        });
      });
      const sock = path.join(bridges.dir(), 'hs', 'run', 'hs.sock');
      try { fs.unlinkSync(sock); } catch { /* none */ }
      await new Promise((r) => hsServer.listen(sock, r));
    });
    after(async () => { await bridge.close(); await new Promise((r) => hsServer.close(r)); });

    it('makes the internal account once before the first link — as the server’s own application service', async () => {
      bridges._reset();
      const start = () => ctx.run(PLUGIN.id, childId, true, () => call('bridges.login.start', { userId: childId, network: 'whatsapp', flowId: 'qr' }));
      const a = await start();
      assert.equal(a.step.display.type, 'qr');
      assert.equal(hsRequests.length, 1);
      assert.equal(hsRequests[0].url, '/_matrix/client/v3/register');
      assert.deepEqual(hsRequests[0].body, { type: 'm.login.application_service', username: `gc_${childId}`, inhibit_login: true });
      await ctx.run(PLUGIN.id, childId, true, () => call('bridges.login.cancel', { userId: childId, network: 'whatsapp', processId: a.processId }));
      await start();
      assert.equal(hsRequests.length, 1, 'not asked again');
      // after a restart of the server the account is already there
      bridges._reset();
      await start();
      assert.equal(hsRequests.length, 2);
      // a homeserver that does not answer does not stop the link
      bridges._reset();
      await new Promise((r) => hsServer.close(r));
      const b = await start();
      assert.equal(b.step.display.type, 'qr');
      await new Promise((r) => hsServer.listen(path.join(bridges.dir(), 'hs', 'run', 'hs.sock'), r));
    });

    it('unlinkFor: an acting person ends somebody else’s link — never an administrator’s, never without acting, and it is logged', async () => {
      const link = async (uid) => {
        const s = await ctx.run(PLUGIN.id, uid, true, () => call('bridges.login.start', { userId: uid, network: 'whatsapp', flowId: 'qr' }));
        bridge.confirm(s.processId);
        return ctx.run(PLUGIN.id, uid, true, () => call('bridges.login.step', { userId: uid, network: 'whatsapp', processId: s.processId, stepId: s.step.id, kind: 'display_and_wait' }));
      };
      await link(childId);
      await link(childId);
      const logins = () => ctx.run(PLUGIN.id, childId, false, () => call('bridges.logins', { userId: childId, network: 'whatsapp' }));
      assert.equal((await logins()).length, 2);

      // nobody is acting
      await assert.rejects(call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: parentId }), (e) => e.code === 'ERR_NOT_PERSON');
      // only reading does not count
      await assert.rejects(ctx.run('other-plugin', parentId, false, () => call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: parentId })), (e) => e.code === 'ERR_NOT_PERSON');
      // not for oneself (that is logout), not with a made-up actor
      await assert.rejects(ctx.run(PLUGIN.id, childId, true, () => call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: childId })), (e) => e.code === 'ERR_INVALID');
      await assert.rejects(ctx.run(PLUGIN.id, parentId, true, () => call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: 999999 })), (e) => e.code === 'ERR_NOT_PERSON');
      // never an administrator's link
      await assert.rejects(ctx.run(PLUGIN.id, parentId, true, () => call('bridges.unlinkFor', { userId: adminId, network: 'whatsapp', actor: parentId })), (e) => e.code === 'ERR_BRIDGES_DENIED');
      await assert.rejects(ctx.run(PLUGIN.id, parentId, true, () => call('bridges.unlinkFor', { userId: childId, network: 'telegram', actor: parentId })), (e) => e.code === 'ERR_INVALID');
      assert.equal((await logins()).length, 2);
      // a plugin without the permission
      await assert.rejects(ctx.run('other-demo', parentId, true, () => hostApi.handle({ id: 'other-demo', manifest: { permissions: {} } }, 'bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: parentId })), (e) => e.code === 'ERR_BRIDGES_DENIED');

      // the parent's request goes to ANOTHER plugin (the family plugin), which calls this plugin's service
      const r = await ctx.run('family-plugin', parentId, true, () => call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: parentId }));
      assert.deepEqual(r, { unlinked: 2 });
      assert.deepEqual(await logins(), []);
      const row = db.prepare("SELECT * FROM activity_log WHERE event_type = 'bridges_unlinked_for' ORDER BY id DESC LIMIT 1").get();
      assert.ok(row, 'written to the activity log');
      const d = JSON.parse(row.details);
      assert.equal(d.userId, childId);
      assert.equal(d.by, parentId);
      assert.equal(d.byName, 'Elternteil');
      assert.equal(d.plugin, PLUGIN.id);
      assert.equal(d.logins, 2);
      // nothing linked: nothing to do, still fine
      assert.deepEqual(await ctx.run(PLUGIN.id, parentId, true, () => call('bridges.unlinkFor', { userId: childId, network: 'whatsapp', actor: parentId })), { unlinked: 0 });
    });
  });
});
