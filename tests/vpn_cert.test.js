'use strict';

// "Zertifikat für die Namen" (services/vpnCert.js): wildcard certificate of the
// VPN zone via ACME DNS-01 — catalog, encrypted credentials, the files Caddy
// reads, the Caddy policy, the states, the connection test (caddy gc-dnstest,
// here a stub), switch off, backup restore. All names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const NETCUP = { customer_number: '12345', api_key: 'fake-netcup-key-0001', api_password: 'fake-netcup-pass-0001' };
const DESEC_TOKEN = 'fake-desec-token-0002';

// Stub of `caddy gc-dnstest`: reads the request, checks that every credential
// arrives as {file.*} placeholder of a readable file, writes the steps — the
// login step echoes the file content in its error text (providers do that).
const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  fs.writeFileSync(process.argv[1] + '.request.json', raw); // the server passes no environment but PATH/HOME
  const vals = [];
  for (const [k, v] of Object.entries(req.provider)) {
    if (k === 'name') continue;
    const m = /^\\{file\\.(.+)\\}$/.exec(v);
    if (m) vals.push(fs.readFileSync(m[1], 'utf8'));
  }
  const fail = req.record.includes('fail');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ step: 'login', status: fail ? 'fail' : 'ok', ms: 5, code: fail ? 'credentials' : undefined, error: fail ? 'denied for ' + vals.join(',') : undefined });
  if (fail) { out({ done: true, ok: false, code: 'credentials', error: 'denied for ' + vals.join(',') }); process.exit(3); }
  out({ step: 'zone', status: 'ok', ms: 3, detail: 'example.com' });
  out({ step: 'write', status: 'ok', ms: 4 });
  out({ step: 'visible', status: 'ok', ms: 42000 });
  out({ step: 'delete', status: 'ok', ms: 2 });
  out({ done: true, ok: true, zone: 'example.com', nameservers: ['ns1.example.com'], propagation_ms: 42000 });
});
`;

describe('Zertifikat für die Namen', () => {
  let db; let vpnCert; let vpnNames; let settings; let config; let license; let tlsGuard; let caddyConfig;
  let stubPath; let stubOut; let realBin;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    settings = require('../src/services/settings');
    config = require('../config/default');
    license = require('../src/services/license');
    tlsGuard = require('../src/services/tlsGuard');
    caddyConfig = require('../src/services/caddyConfig');
    license._overrideForTest({ internal_dns: true });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    require('../src/services/dns').restartDnsmasq = () => {};
    stubPath = path.join(confDir, 'caddy-stub');
    stubOut = stubPath + '.request.json';
    fs.writeFileSync(stubPath, STUB, { mode: 0o755 });
    realBin = config.caddy.bin;
    config.caddy.bin = stubPath;
  });

  after(() => {
    config.caddy.bin = realBin;
    license._overrideForTest({ internal_dns: true });
    teardown();
  });

  beforeEach(() => {
    vpnCert._resetForTest();
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM domains').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%'").run();
    db.prepare('DELETE FROM tls_status').run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
  });

  function zone() {
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
  }
  const api = () => getAgent();
  const put = (body) => api().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send(body);
  const secretFile = (k) => path.join(vpnCert.secretsDir(), k);
  async function waitTest() {
    for (let i = 0; i < 200; i++) {
      const t = vpnCert.testView();
      if (t && !t.running) return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('test did not finish');
  }

  describe('catalog', () => {
    it('the ten providers of the first version, the forwarding via deSEC first; no Route 53, no DigitalOcean', () => {
      const ids = vpnCert.catalog().map((p) => p.id);
      assert.deepEqual(ids, ['desec_delegated', 'hetzner', 'ionos', 'netcup', 'inwx', 'allinkl', 'ovh', 'desec', 'cloudflare', 'rfc2136', 'acmedns']);
      const mods = new Set(vpnCert.catalog().map((p) => p.module));
      assert.equal(mods.size, 10);
      assert.ok(!mods.has('route53') && !mods.has('digitalocean'));
      const hint = vpnCert.catalog().filter((p) => p.prefer_delegation).map((p) => p.id).sort();
      assert.deepEqual(hint, ['allinkl', 'inwx', 'ionos', 'netcup']);
      assert.equal(vpnCert.catalog()[0].recommended, true);
    });
  });

  describe('states', () => {
    it('without an own domain: no_zone; with one: off; without the licence feature: locked', async () => {
      assert.equal(vpnCert.state().state, 'no_zone');
      zone();
      assert.equal(vpnCert.state().state, 'off');
      assert.equal(vpnCert.state().wildcard, '*.vpn.example.com');
      license._overrideForTest({ internal_dns: false });
      assert.equal(vpnCert.state().state, 'locked');
      const res = await put({ provider: 'netcup', credentials: NETCUP });
      assert.equal(res.status, 403);
      assert.equal(res.body.feature, 'internal_dns');
    });

    it('saving without an own domain is refused', async () => {
      const res = await put({ provider: 'netcup', credentials: NETCUP });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'no_zone');
    });
  });

  describe('saving', () => {
    it('checks the fields of the provider', async () => {
      zone();
      let res = await put({ provider: 'netcup', credentials: { customer_number: '12345', api_key: 'fake-netcup-key-0001' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'field_required');
      assert.ok(res.body.fields.api_password);
      res = await put({ provider: 'cloudflare', credentials: { api_token: 'too-short' } });
      assert.equal(res.body.code, 'field_invalid');
      res = await put({ provider: 'desec_delegated', credentials: { token: DESEC_TOKEN } });
      assert.equal(res.body.code, 'delegate_required');
      res = await put({ provider: 'desec_delegated', credentials: { token: DESEC_TOKEN }, delegate: 'x.vpn.example.com' });
      assert.equal(res.body.code, 'delegate_invalid', 'the target must not lie inside the zone');
      const rfc = (server) => put({ provider: 'rfc2136', credentials: { server, key_name: 'gc-acme', key_alg: 'hmac-sha256', key: 'ZmFrZS10c2lnLWtleQ==' } });
      res = await rfc('ns1 example.com');
      assert.equal(res.body.code, 'field_invalid');
      res = await rfc('[2001:db8::53]:70000');
      assert.equal(res.body.code, 'field_invalid');
      res = await put({ provider: 'acmedns', credentials: { server_url: 'http://acme-dns.example.net', username: 'u', password: 'fake-pass-0005', subdomain: 's', fulldomain: 's.acme-dns.example.net' } });
      assert.equal(res.body.code, 'field_invalid', 'acme-dns only over https');
      res = await put({ provider: 'route53', credentials: {} });
      assert.equal(res.body.code, 'provider_unknown');
      res = await put({ provider: 'netcup', credentials: NETCUP, propagation_delay: 5000 });
      assert.equal(res.body.code, 'delay_invalid');
      assert.equal(settings.get(vpnCert.KEY.provider, ''), '', 'nothing stored after a refusal');
    });

    it('stores the credentials encrypted, writes one 0600 file per field, never answers with a value', async () => {
      zone();
      const res = await put({ provider: 'netcup', credentials: NETCUP, propagation_delay: 120 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const raw = settings.get(vpnCert.KEY.credentials, '');
      for (const v of Object.values(NETCUP)) {
        if (v.length >= 6) assert.ok(!raw.includes(v), 'stored in clear');
        assert.ok(!JSON.stringify(res.body).includes(v) || v === NETCUP.customer_number, 'value in the answer');
      }
      assert.deepEqual(res.body.data.fields_set.sort(), ['api_key', 'api_password', 'customer_number']);
      assert.equal(res.body.data.state, 'pending');
      assert.equal(res.body.data.propagation_delay, 120);
      assert.equal(settings.get(vpnCert.KEY.zone, ''), 'vpn.example.com');
      assert.equal(fs.readFileSync(secretFile('api_key'), 'utf8'), NETCUP.api_key);
      assert.equal(fs.statSync(secretFile('api_key')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(vpnCert.secretsDir()).mode & 0o777, 0o700);
      const act = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'tls_vpn_cert_saved'").all();
      assert.equal(act.length, 1);
      assert.ok(!JSON.stringify(act).includes(NETCUP.api_key));

      const get = await api().get('/api/v1/settings/vpn-cert');
      assert.equal(get.status, 200);
      assert.ok(!JSON.stringify(get.body).includes(NETCUP.api_key));
      assert.ok(!JSON.stringify(get.body).includes(NETCUP.api_password));
    });

    it('accepts the address forms of a DNS server (RFC 2136)', async () => {
      zone();
      for (const server of ['ns1.example.com', 'ns1.example.com:5353', '192.0.2.53', '[2001:db8::53]:53']) {
        const res = await put({ provider: 'rfc2136', credentials: { server, key_name: 'gc-acme', key_alg: 'hmac-sha256', key: 'ZmFrZS10c2lnLWtleQ==' } });
        assert.equal(res.status, 200, server + ' ' + JSON.stringify(res.body));
        assert.equal(res.body.data.fields_plain.server, server);
      }
    });

    it('"Ändern": empty fields keep the stored value of the same provider; a provider change removes old files', async () => {
      zone();
      await put({ provider: 'netcup', credentials: NETCUP });
      const res = await put({ provider: 'netcup', credentials: { api_password: 'fake-netcup-pass-0003' } });
      assert.equal(res.status, 200);
      assert.equal(fs.readFileSync(secretFile('api_key'), 'utf8'), NETCUP.api_key);
      assert.equal(fs.readFileSync(secretFile('api_password'), 'utf8'), 'fake-netcup-pass-0003');
      const res2 = await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      assert.equal(res2.status, 200);
      assert.deepEqual(fs.readdirSync(vpnCert.secretsDir()).sort(), ['token']);
    });

    it('token auth may not touch it', async () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'src/routes/api/settings/index.js'), 'utf8');
      assert.match(idx, /\/\^\\\/vpn-cert\(\\\/\|\$\)\//);
    });
  });

  describe('Caddy policy', () => {
    function build() { return caddyConfig.buildCaddyConfig([]); }

    it('without a provider: no policy, no automate, no files', () => {
      zone();
      const cfg = build();
      assert.equal(vpnCert.inConfig(cfg), false);
      assert.ok(!JSON.stringify(cfg).includes('dns'), 'no DNS challenge');
    });

    it('with a provider: own policy first, DNS challenge with placeholders and public resolvers, no secret in the config', async () => {
      zone();
      await put({ provider: 'netcup', credentials: NETCUP, propagation_delay: 90 });
      const cfg = build();
      const tls = cfg.apps.tls;
      assert.deepEqual(tls.certificates.automate, ['*.vpn.example.com']);
      const pol = tls.automation.policies[0];
      assert.deepEqual(pol.subjects, ['*.vpn.example.com']);
      const iss = pol.issuers[0];
      assert.equal(iss.module, 'acme');
      assert.deepEqual(iss.challenges.http, { disabled: true });
      assert.deepEqual(iss.challenges['tls-alpn'], { disabled: true });
      const d = iss.challenges.dns;
      assert.equal(d.provider.name, 'netcup');
      assert.equal(d.provider.api_key, `{file.${secretFile('api_key')}}`);
      assert.equal(d.propagation_delay, '90s');
      assert.deepEqual(d.resolvers, config.caddy.dnsResolvers);
      assert.equal(d.override_domain, undefined);
      const text = JSON.stringify(cfg);
      assert.ok(!text.includes(NETCUP.api_key) && !text.includes(NETCUP.api_password));
    });

    it('forwarding: override_domain is the CNAME target', async () => {
      zone();
      const res = await put({ provider: 'desec_delegated', credentials: { token: DESEC_TOKEN }, delegate: 'vpn-example.dedyn.example.net' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.delegate, '_acme-challenge.vpn-example.dedyn.example.net');
      const d = build().apps.tls.automation.policies[0].issuers[0].challenges.dns;
      assert.equal(d.provider.name, 'desec');
      assert.equal(d.override_domain, '_acme-challenge.vpn-example.dedyn.example.net');
    });

    it('names of the zone served by Caddy leave the other policies and get skip_certificates', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      const cfg = { apps: { tls: { automation: { policies: [
        { subjects: ['nas-web.vpn.example.com'], issuers: [{ module: 'internal' }] },
        { subjects: ['app.example.org', 'a.b.vpn.example.com'], issuers: [{ module: 'acme' }] },
      ] } } } };
      const covered = caddyConfig.__test.applyVpnCertTls(cfg, ['nas-web.vpn.example.com', 'app.example.org', 'a.b.vpn.example.com']);
      assert.deepEqual(covered, ['nas-web.vpn.example.com']);
      const pols = cfg.apps.tls.automation.policies;
      assert.equal(pols.length, 2, 'the emptied policy is dropped, never a catch-all');
      assert.deepEqual(pols[0].subjects, ['*.vpn.example.com']);
      assert.deepEqual(pols[1].subjects, ['app.example.org', 'a.b.vpn.example.com'], 'one level only');
    });

    it('a changed zone drops the policy and asks for a new setup', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      assert.equal(vpnCert.inConfig(build()), true);
      assert.equal(vpnNames.save('example.com', 'gc').ok, true);
      assert.equal(vpnCert.state().state, 'zone_changed');
      assert.equal(vpnCert.inConfig(build()), false);
      assert.equal(vpnNames.save('', '').ok, true);
      assert.equal(vpnCert.state().state, 'no_zone');
      assert.equal(vpnCert.inConfig(build()), false);
    });

    it('paused by the TLS guard or suspended after a refused load: no policy until renew', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      tlsGuard.writeRow('*.vpn.example.com', { state: 'paused', paused_reason: 'attempts', attempts: 3, last_error: 'provider said: bad token ' + DESEC_TOKEN });
      assert.equal(vpnCert.state().state, 'paused');
      assert.equal(vpnCert.inConfig(build()), false);
      const view = vpnCert.view();
      assert.ok(!view.certificate.last_error.includes(DESEC_TOKEN), 'error text redacted');
      assert.equal(view.renew_possible, true);
      const res = await api().post('/api/v1/settings/vpn-cert/renew').set('X-CSRF-Token', getCsrf());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.state, 'pending');
      assert.equal(tlsGuard.getRow('*.vpn.example.com').attempts, 0);
      assert.equal(vpnCert.inConfig(build()), true);

      vpnCert.suspend('Caddy API 400: loading dns.providers.desec: token ' + DESEC_TOKEN + ' invalid');
      assert.equal(vpnCert.state().state, 'suspended');
      assert.equal(vpnCert.inConfig(build()), false);
      assert.ok(!JSON.stringify(vpnCert.view()).includes(DESEC_TOKEN));
    });

    it('a valid certificate needs no renewal; the wildcard is listed under the certificates', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 80 * 86400000).toISOString(), issuer: "Let's Encrypt" });
      assert.equal(vpnCert.state().state, 'active');
      const res = await api().post('/api/v1/settings/vpn-cert/renew').set('X-CSRF-Token', getCsrf());
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'renew_not_needed');
      const listed = tlsGuard.listStatus().hosts.find((h) => h.host === '*.vpn.example.com');
      assert.ok(listed);
      assert.equal(listed.state, 'issued');
    });

    it('a provider error in the tls.log is stored without the credential', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      await tlsGuard.applyLogEvent({ kind: 'error', host: '*.vpn.example.com', at: new Date().toISOString(), error: `presenting token ${DESEC_TOKEN}: 401`, attempt: 1 });
      const row = tlsGuard.getRow('*.vpn.example.com');
      assert.equal(row.state, 'failed');
      assert.ok(!row.last_error.includes(DESEC_TOKEN));
      assert.match(row.last_error, /\*\*\*/);
    });
  });

  describe('certificate list (TLS API)', () => {
    it('the wildcard can be retried from the certificate list: renew instead of an A-record check', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      tlsGuard.writeRow('*.vpn.example.com', { state: 'paused', paused_reason: 'attempts', attempts: 3 });
      const res = await api().post('/api/v1/tls/*.vpn.example.com/retry').set('X-CSRF-Token', getCsrf());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(tlsGuard.getRow('*.vpn.example.com').attempts, 0);
      assert.notEqual(tlsGuard.getRow('*.vpn.example.com').state, 'paused');
      const again = await api().post('/api/v1/tls/*.vpn.example.com/retry').set('X-CSRF-Token', getCsrf());
      assert.equal(again.status, 409, 'nothing to renew yet');
      assert.equal(again.body.code, 'renew_not_needed');
      const pf = await tlsGuard.preflight('*.vpn.example.com');
      assert.equal(pf.ok, true);
    });

    it('"Genutzt von" lists the names under the zone the server answers', async () => {
      zone();
      db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, route_type, https_enabled) VALUES ('nas-web.vpn.example.com', '10.0.0.5', 5000, 1, 'http', 1)").run();
      db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, route_type, https_enabled) VALUES ('app.example.com', '10.0.0.6', 80, 1, 'http', 1)").run();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      assert.deepEqual(vpnCert.view().used_by, [{ host: 'nas-web.vpn.example.com', kind: 'route' }]);
    });
  });

  describe('CAA pre-check', () => {
    it('issuewild without Let\'s Encrypt pauses the wildcard; renew is refused while it stays', async () => {
      const domains = require('../src/services/domains');
      domains._setResolverForTest(async () => ({ v4: [], v6: [] }));
      domains._setCaaResolverForTest(async (name) => (name === 'example.com'
        ? [{ critical: 0, issue: 'letsencrypt.org' }, { critical: 0, issuewild: 'ca.example.net' }]
        : []));
      try {
        zone();
        const res = await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.state, 'paused');
        assert.equal(tlsGuard.getRow('*.vpn.example.com').paused_reason, 'preflight');
        const r = await api().post('/api/v1/settings/vpn-cert/renew').set('X-CSRF-Token', getCsrf());
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'preflight_failed');
      } finally {
        domains._setCaaResolverForTest(null);
        domains._setResolverForTest(null);
      }
    });
  });

  describe('connection test', () => {
    it('writes at _acme-challenge.<zone>, values only in temporary files, result without values', async () => {
      zone();
      const res = await api().post('/api/v1/settings/vpn-cert/test').set('X-CSRF-Token', getCsrf()).send({ provider: 'netcup', credentials: NETCUP });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      const t = await waitTest();
      assert.equal(t.result.ok, true, JSON.stringify(t));
      assert.deepEqual(t.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
      assert.equal(t.result.propagation_ms, 42000);
      assert.equal(t.result.suggested_delay, 80);
      const req = JSON.parse(fs.readFileSync(stubOut, 'utf8'));
      assert.equal(req.record, '_acme-challenge.vpn.example.com');
      assert.equal(req.lookup, undefined);
      assert.match(req.value, /^gc-test-[0-9a-f]{24}$/);
      assert.deepEqual(req.resolvers, config.caddy.dnsResolvers);
      const m = /^\{file\.(.+)\/api_key\}$/.exec(req.provider.api_key);
      assert.ok(m, 'placeholder');
      assert.ok(!fs.existsSync(m[1]), 'temporary files removed');
      assert.equal(settings.get(vpnCert.KEY.provider, ''), '', 'a test saves nothing');
      const last = settings.get(vpnCert.KEY.lastTest, '');
      assert.ok(last.includes('"ok":true'));
      assert.ok(!last.includes(NETCUP.api_key));
    });

    it('forwarding and acme-dns: the record lands at the CNAME target, the challenge name is the lookup', async () => {
      zone();
      await api().post('/api/v1/settings/vpn-cert/test').set('X-CSRF-Token', getCsrf())
        .send({ provider: 'desec_delegated', credentials: { token: DESEC_TOKEN }, delegate: 'vpn-example.dedyn.example.net' });
      await waitTest();
      let req = JSON.parse(fs.readFileSync(stubOut, 'utf8'));
      assert.equal(req.record, '_acme-challenge.vpn-example.dedyn.example.net');
      assert.equal(req.lookup, '_acme-challenge.vpn.example.com');
      vpnCert._resetForTest();
      await api().post('/api/v1/settings/vpn-cert/test').set('X-CSRF-Token', getCsrf()).send({ provider: 'acmedns', credentials: {
        server_url: 'https://acme-dns.example.net', username: 'fake-user', password: 'fake-acmedns-pass-0004', subdomain: 'fake-sub', fulldomain: 'fake-sub.acme-dns.example.net',
      } });
      await waitTest();
      req = JSON.parse(fs.readFileSync(stubOut, 'utf8'));
      assert.equal(req.record, 'fake-sub.acme-dns.example.net');
      assert.equal(req.lookup, '_acme-challenge.vpn.example.com');
      assert.equal(req.provider.server_url, 'https://acme-dns.example.net', 'plain field inline (the module reads no placeholder there)');
      assert.match(req.provider.password, /^\{file\./);
    });

    it('a failing provider: error text redacted, only one test at a time', async () => {
      zone();
      const first = await api().post('/api/v1/settings/vpn-cert/test').set('X-CSRF-Token', getCsrf())
        .send({ provider: 'desec_delegated', credentials: { token: DESEC_TOKEN }, delegate: 'fail.example.net' });
      assert.equal(first.status, 202);
      const second = await api().post('/api/v1/settings/vpn-cert/test').set('X-CSRF-Token', getCsrf())
        .send({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'test_running');
      const t = await waitTest();
      assert.equal(t.result.ok, false);
      assert.equal(t.result.code, 'credentials');
      assert.equal(t.steps[0].status, 'fail');
      assert.ok(!JSON.stringify(t).includes(DESEC_TOKEN));
      assert.match(t.steps[0].error, /\*\*\*/);
    });

    it('no Caddy binary: a clear code, no hang', async () => {
      zone();
      config.caddy.bin = path.join(confDir, 'no-such-caddy');
      try {
        vpnCert.startTest({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
        const t = await waitTest();
        assert.equal(t.result.code, 'caddy_unavailable');
      } finally { config.caddy.bin = stubPath; }
    });
  });

  describe('switch off and restore', () => {
    it('switch off removes settings, files and the status row', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      tlsGuard.writeRow('*.vpn.example.com', { state: 'failed' });
      const res = await api().delete('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf());
      assert.equal(res.status, 200);
      assert.equal(res.body.data.state, 'off');
      assert.equal(settings.get(vpnCert.KEY.credentials, ''), '');
      assert.deepEqual(fs.existsSync(vpnCert.secretsDir()) ? fs.readdirSync(vpnCert.secretsDir()) : [], []);
      assert.equal(tlsGuard.getRow('*.vpn.example.com'), null);
    });

    it('backup: the credentials count as encrypted field; after a restore the files come back', async () => {
      const backup = fs.readFileSync(path.join(__dirname, '..', 'src/services/backup.js'), 'utf8');
      assert.match(backup, /'vpn_cert\.credentials_encrypted'/);
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      vpnCert.removeSecretFiles();
      vpnCert.suspend('x');
      vpnCert.applyAfterRestore();
      assert.equal(fs.readFileSync(secretFile('token'), 'utf8'), DESEC_TOKEN);
      assert.equal(vpnCert.state().state, 'pending');
    });

    it('credentials from another key: unreadable, no policy', async () => {
      zone();
      await put({ provider: 'desec', credentials: { token: DESEC_TOKEN } });
      settings.set(vpnCert.KEY.credentials, 'aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cc');
      assert.equal(vpnCert.state().state, 'unreadable');
      assert.equal(vpnCert.inConfig(caddyConfig.buildCaddyConfig([])), false);
    });
  });

  describe('provider suggestion', () => {
    it('from the nameservers of the base domain', async () => {
      zone();
      vpnCert._setNsResolverForTest(async () => ['root-dns1.netcup.net', 'second-dns.netcup.net']);
      try {
        const d = await vpnCert.detect();
        assert.equal(d.provider, 'netcup');
        assert.equal(d.base, 'example.com');
      } finally { vpnCert._setNsResolverForTest(null); }
    });
  });
});
