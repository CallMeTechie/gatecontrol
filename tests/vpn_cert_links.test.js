'use strict';

// "Zertifikat für die Namen": the switch "Links auf die neue Adresse" — off by
// default; while on and the wildcard is in use, invitation, kiosk and menu
// links and the way back of the cloud accounts point to home.<zone>; off, or
// the certificate stopped / expired: home.<legacy> as before. The OAuth
// callback registered at the providers never moves. Backup and restore keep
// the switch. The certificate is a throw-away self-signed one (openssl); all
// names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-links-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const TOKEN = 'fake-desec-token-0302';
const NEW = 'home.vpn.example.com';

describe('Zertifikat für die Namen: Links auf die neue Adresse', () => {
  let db; let vpnCert; let vpnNames; let tlsGuard; let license; let config; let portalConfig; let settings;
  let certDir;
  const legacy = () => `home.${config.dns.domain}`;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    tlsGuard = require('../src/services/tlsGuard');
    license = require('../src/services/license');
    portalConfig = require('../src/services/portalConfig');
    settings = require('../src/services/settings');
    config = require('../config/default');
    license._overrideForTest({ internal_dns: true, vpn_peers: -1 });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    require('../src/services/dns').restartDnsmasq = () => {};
  });

  after(() => teardown());

  beforeEach(async () => {
    vpnCert._resetForTest();
    for (const t of ['routes', 'domains', 'tls_status']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%' OR key LIKE 'portal.%'").run();
    db.prepare("DELETE FROM activity_log WHERE event_type LIKE 'tls_vpn_cert%'").run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true, vpn_peers: -1 });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    // the wildcard in Caddy's storage, the way Caddy keeps it
    certDir = path.join(config.caddy.dataDir, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', 'wildcard_.vpn.example.com');
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.mkdirSync(certDir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(certDir, 'wildcard_.vpn.example.com.key'), '-out', path.join(certDir, 'wildcard_.vpn.example.com.crt'),
      '-days', '60', '-subj', '/CN=*.vpn.example.com'], { stdio: 'ignore' });
    const res = await getAgent().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send({ provider: 'desec', credentials: { token: TOKEN } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 59 * 86400000).toISOString(), issuer: 'Test' });
    vpnCert.refreshServed('test');
  });

  const links = (body) => getAgent().put('/api/v1/settings/vpn-cert/links').set('X-CSRF-Token', getCsrf()).send(body);
  const inviteBase = () => require('../src/routes/api/groups').inviteBase();
  const cloudBack = () => require('../src/services/cloudAccounts').returnUrl({ kind: 'portal', path: '/portal/x' }, { ok: true });
  const menu = async () => (await getAgent().get('/me')).headers.location;

  it('off by default: every link keeps the name every device resolves', async () => {
    assert.equal(vpnCert.servedZone(), 'vpn.example.com');
    const v = vpnCert.view().links;
    assert.deepEqual(v, { enabled: false, new_host: NEW, old_host: legacy(), public_portal: false });
    assert.equal(portalConfig.effectivePortalHost().linkHost, legacy());
    assert.equal(inviteBase(), `https://${legacy()}`);
    assert.equal(cloudBack(), `https://${legacy()}/portal/x?cloud=connected`);
    assert.equal(await menu(), `https://${legacy()}`);
  });

  it('on and in use: invitations, kiosk, menu and the way back of the cloud accounts on home.<zone>', async () => {
    const res = await links({ enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.links.enabled, true);
    const p = portalConfig.effectivePortalHost();
    assert.equal(p.linkHost, NEW);
    assert.equal(p.compatHost, legacy(), 'apps that do not know the zone keep the old name');
    assert.equal(inviteBase(), `https://${NEW}`);
    assert.equal(cloudBack(), `https://${NEW}/portal/x?cloud=connected`);
    assert.equal(await menu(), `https://${NEW}`);
    const users = fs.readFileSync(path.join(__dirname, '..', 'src/routes/api/users.js'), 'utf8');
    assert.match(users, /effectivePortalHost\(\)\.linkHost\}\/portal\/kiosk/);
    // the callback registered at Google / Microsoft stays the main address
    const cloud = require('../src/services/cloudAccounts');
    assert.equal(cloud.redirectUri(), `${new URL(config.app.baseUrl).origin}/oauth/cloud/callback`);
    const log = db.prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'tls_vpn_cert_links%'").all().map((r) => r.event_type);
    assert.deepEqual(log, ['tls_vpn_cert_links_on']);
  });

  it('the certificate stopped or expired: the old links again, the switch stays', async () => {
    await links({ enabled: true });
    vpnCert.suspend('test');
    vpnCert.refreshServed('test');
    assert.equal(vpnCert.servedZone({ fresh: true }), null);
    assert.equal(portalConfig.effectivePortalHost().linkHost, legacy());
    assert.equal(inviteBase(), `https://${legacy()}`);
    assert.equal(vpnCert.linksNew(), true);
    vpnCert.unsuspend();
    assert.equal(portalConfig.effectivePortalHost().linkHost, NEW);
    tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() - 86400000).toISOString() });
    vpnCert.refreshServed('test');
    assert.equal(vpnCert.servedZone({ fresh: true }), null);
    assert.equal(portalConfig.effectivePortalHost().linkHost, legacy());
  });

  it('a public portal domain wins; bad input; locked without the feature; switching the certificate off resets it', async () => {
    let res = await links({ enabled: 'yes' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'links_invalid');
    await links({ enabled: true });
    settings.set('portal.base_domain', 'example.org');
    assert.equal(portalConfig.effectivePortalHost().linkHost, 'home.example.org');
    assert.equal(vpnCert.view().links.public_portal, true);
    settings.set('portal.base_domain', '');
    license._overrideForTest({ internal_dns: false, vpn_peers: -1 });
    res = await links({ enabled: false });
    assert.equal(res.status, 403);
    license._overrideForTest({ internal_dns: true, vpn_peers: -1 });
    await getAgent().delete('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).expect(200);
    assert.equal(vpnCert.linksNew(), false);
    res = await links({ enabled: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'not_configured');
  });

  it('backup and restore keep the switch', async () => {
    await links({ enabled: true });
    const backup = require('../src/services/backup');
    const b = JSON.parse(JSON.stringify(await backup.createBackup()));
    assert.ok(b.data.settings.some((s) => s.key === 'vpn_cert.links_new' && s.value === '1'));
    settings.set('vpn_cert.links_new', '');
    assert.equal(vpnCert.linksNew(), false);
    await backup.restoreBackup(b);
    assert.equal(vpnCert.linksNew(), true);
  });
});
