'use strict';

// Einstellungen › Plugins › Speicher (docs/storage-targets.md): ein
// Speicherziel „Ordner auf dem Server“ anlegen, vor dem Speichern prüfen,
// speichern (die Liste zeigt „Erreichbar“), eine falsche Eingabe markiert
// ihr Feld, umbenennen, löschen; Google Drive / OneDrive verweisen ohne
// OAuth-App auf die Seite Cloud-Konten, die die Weiterleitungs-URI zeigt. Der
// Ordner liegt unter <data>/storage — die einzige Stelle im Datenordner, die
// ein Speicherziel sein darf.

const fs = require('fs');
const path = require('path');

module.exports = (ctx) => {
  const { BASE, step, visible, waitIdle, shot, allow } = ctx;

  return {
    async storage(page) {
      const dir = path.join(process.env.GC_DATA_DIR || '/data', 'storage', 'e2e-disk');
      fs.mkdirSync(dir, { recursive: true });
      // an earlier scenario may leave a session (another account, too): sign in as the admin
      await page.context().clearCookies();
      await ctx.login(page);
      await page.goto(BASE + '/settings/plugins/storage');
      await waitIdle(page);
      step('storage: the page renders with "add"', await visible(page, '#pgx-stg-add'));
      step('storage: empty list says so', await visible(page, '#pgx-stg-empty'));
      step('storage: the cache card shows the size of the media cache', await visible(page, '#pgx-stg-cache'));
      step('storage: the side navigation marks "Speicher"', (await page.$('a.pgx-sl[data-tab="storage"][aria-current="page"]')) !== null);
      await shot(page, 'storage-empty');

      // ── anlegen: prüfen ohne speichern, dann speichern ──
      await page.click('#pgx-stg-add');
      await page.waitForSelector('.pgx-stg-kind', { timeout: 6000 }).catch(() => {});
      const kinds = await page.$$eval('.pgx-stg-kind', (l) => l.map((b) => b.getAttribute('data-kind')));
      step('storage: the dialog offers six kinds (folder, SMB, WebDAV, S3, Google Drive, OneDrive)', kinds.join(',') === 'local,smb,webdav,s3,gdrive,onedrive', kinds.join(','));
      // Google Drive / OneDrive need an OAuth app first (docs/cloud-accounts.md): the dialog says where
      await page.click('.pgx-stg-kind[data-kind="gdrive"]');
      step('storage: Google Drive without an OAuth app points to Cloud-Konten', await visible(page, '#pgx-stg-cloud-missing a[href="/settings/plugins/cloud"]'));
      await page.click('.pgx-stg-kind[data-kind="onedrive"]');
      step('storage: OneDrive without an OAuth app points to Cloud-Konten', await visible(page, '#pgx-stg-cloud-missing a[href="/settings/plugins/cloud"]'));
      await shot(page, 'storage-dialog-cloud', false);
      await page.click('.pgx-stg-kind[data-kind="local"]');
      await page.fill('#pgx-stg-label', 'E2E-Platte');
      await page.fill('#pgx-stg-path', dir);
      await page.click('#pgx-stg-check');
      await page.waitForSelector('#pgx-stg-checks', { timeout: 10000 }).catch(() => {});
      const okSteps = await page.$$eval('#pgx-stg-checks li[data-state="ok"]', (l) => l.length).catch(() => 0);
      step('storage: "Prüfen" passes all five steps before saving', okSteps === 5, `${okSteps}/5`);
      step('storage: the check did not store anything', (await ctx.api(page, 'GET', '/api/v1/storage-targets')).body.targets.length === 0);
      await shot(page, 'storage-dialog-check', false);
      await page.click('#pgx-stg-save');
      await page.waitForSelector('.pgx-stg-row', { timeout: 10000 }).catch(() => {});
      step('storage: saved → one row, reachable', await page.$eval('.pgx-stg-row .pgx-pill[data-tone="good"]', () => true).catch(() => false));
      step('storage: the row shows the folder', (await ctx.text(page, '.pgx-stg-row')).includes(dir));
      await shot(page, 'storage-list');

      // ── eine falsche Eingabe markiert ihr Feld ──
      await page.click('#pgx-stg-add');
      await page.waitForSelector('.pgx-stg-kind[data-kind="local"]');
      await page.click('.pgx-stg-kind[data-kind="local"]');
      await page.fill('#pgx-stg-label', 'System');
      await page.fill('#pgx-stg-path', '/etc/gatecontrol');
      await page.click('#pgx-stg-save');
      step('storage: a system folder is refused at its field', await visible(page, '.pgx-stg-f[data-field="path"][data-invalid]'));
      allow((p) => p.kind === 'http' && p.status === 400 && p.url === '/api/v1/storage-targets', (p) => p.kind === 'console' && /status of 400/.test(p.text));
      await page.keyboard.press('Escape');

      // ── SMB-Felder: Adresse oder VPN-Gerät ──
      await page.click('#pgx-stg-add');
      await page.waitForSelector('.pgx-stg-kind[data-kind="smb"]');
      await page.click('.pgx-stg-kind[data-kind="smb"]');
      const hostShown = await page.isVisible('.pgx-stg-f[data-field="host"]');
      await page.selectOption('#pgx-stg-via', 'peer');
      step('storage: SMB switches between address and VPN device', hostShown && !(await page.isVisible('.pgx-stg-f[data-field="host"]')) && await page.isVisible('.pgx-stg-f[data-field="peerId"]'));
      // "Verbindung verschlüsseln (SMB3)": on for a new target; switched off it says what that means
      const encOn = await page.isChecked('#pgx-stg-encrypt');
      const hintOn = await ctx.text(page, '#pgx-stg-encrypt-h');
      await page.uncheck('#pgx-stg-encrypt');
      const hintOff = await ctx.text(page, '#pgx-stg-encrypt-h');
      step('storage: SMB encrypts by default; switching it off explains the risk', encOn && hintOn !== hintOff && hintOff.length > 20, `${encOn} / ${hintOff}`);
      await shot(page, 'storage-dialog-smb', false);
      // WebDAV (since 1.218.0): directly, through a route or a VPN device — the URL stays
      await page.click('.pgx-stg-kind[data-kind="webdav"]');
      const directOnly = !(await page.isVisible('.pgx-stg-f[data-field="routeId"]')) && !(await page.isVisible('#pgx-stg-url-via'));
      await page.selectOption('#pgx-stg-via', 'route');
      const routeShown = await page.isVisible('.pgx-stg-f[data-field="routeId"]') && await page.isVisible('.pgx-stg-f[data-field="url"]')
        && await page.isVisible('#pgx-stg-url-via') && !(await page.isVisible('.pgx-stg-f[data-field="peerId"]'));
      await page.selectOption('#pgx-stg-via', 'peer');
      const peerShown = await page.isVisible('.pgx-stg-f[data-field="peerId"]') && await page.isVisible('.pgx-stg-f[data-field="port"]');
      step('storage: WebDAV switches between address, route and VPN device', directOnly && routeShown && peerShown, `${directOnly}/${routeShown}/${peerShown}`);
      await page.keyboard.press('Escape');

      // ── TLS (docs/storage-targets.md "Trusting a NAS"): the answers of
      // "Prüfen" are fixtures here — the real handshakes are covered by
      // tests/storage_targets_trust.test.js, _tls and _via
      const leaf = { subject: 'CN=synology', issuer: 'CN=Synology Inc. CA', names: ['synology'], validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z',
        fingerprint: 'ab'.repeat(32), ca: false, selfSigned: false, pem: '-----BEGIN CERTIFICATE-----\nTEFBRg==\n-----END CERTIFICATE-----' };
      const caCert = { subject: 'CN=Synology Inc. CA', issuer: 'CN=Synology Inc. CA', names: [], validFrom: leaf.validFrom, validTo: leaf.validTo,
        fingerprint: 'cd'.repeat(32), ca: true, selfSigned: true, pem: '-----BEGIN CERTIFICATE-----\nQ0FDQQ==\n-----END CERTIFICATE-----' };
      const steps = (n) => ['connect', 'folder', 'write', 'read', 'delete'].slice(0, n).map((x, i) => ({ step: x, ok: i < n - 1 || n === 5 }));
      const sent = [];
      let auto = false;
      await page.route('**/api/v1/storage-targets/check', async (r) => {
        const b = JSON.parse(r.request().postData() || '{}');
        sent.push(b);
        let check;
        if (auto) check = { ok: true, error: null, message: null, free: null, total: null, steps: steps(5), trusted: { auto: true, cert: Object.assign({ device: 'synology' }, leaf) } };
        else if (b.tlsCa) check = { ok: true, error: null, message: null, free: null, total: null, steps: steps(5) };
        else {
          check = { ok: false, error: 'tls', message: 'x', free: null, total: null, steps: steps(2),
            tls: { reason: 'untrusted_ca', code: 'SELF_SIGNED_CERT_IN_CHAIN', host: 'nas.example.com', cert: leaf, chain: [leaf, caCert], hints: [], state: 'untrusted', device: 'synology', trust: { leaf: true, chain: true } } };
        }
        await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, check }) });
      });
      await page.click('#pgx-stg-add');
      await page.waitForSelector('.pgx-stg-kind[data-kind="webdav"]');
      await page.click('.pgx-stg-kind[data-kind="webdav"]');
      step('storage: the PEM field is folded away under "Erweitert"', !(await page.isVisible('#pgx-stg-tlsCa')) && await visible(page, '#pgx-stg-adv > summary'));
      await page.fill('#pgx-stg-label', 'NAS');
      await page.fill('#pgx-stg-url', 'https://nas.example.com:5006/GateControl');
      await page.click('#pgx-stg-check');
      await page.waitForSelector('#pgx-stg-tls', { timeout: 10000 }).catch(() => {});
      const box = await ctx.text(page, '#pgx-stg-tls').catch(() => '');
      step('storage: an own certificate gets a plain card with the device and its validity',
        await visible(page, '#pgx-stg-tls-why[data-state="untrusted"]') && box.includes('synology') && /eigenen Zertifikat|own certificate/.test(box), box.slice(0, 200));
      step('storage: the fingerprint and the chain option wait under "Details"',
        box.includes('AB:AB:AB') && !(await page.isVisible('#pgx-stg-trust-chain')) && await visible(page, '#pgx-stg-details > summary'));
      step('storage: one button "Diesem Gerät vertrauen"', await visible(page, '#pgx-stg-trust'));
      await shot(page, 'storage-dialog-tls', false);
      await page.click('#pgx-stg-trust');
      await page.waitForSelector('#pgx-stg-ok', { timeout: 10000 }).catch(() => {});
      const last = sent[sent.length - 1] || {};
      step('storage: one click → the leaf goes into the field and the check runs again with it',
        (await page.inputValue('#pgx-stg-tlsCa')).includes('TEFBRg==') && String(last.tlsCa || '').includes('TEFBRg==') && !String(last.tlsCa).includes('Q0FDQQ==') && await visible(page, '#pgx-stg-ok'));
      // through the VPN: remembered on the first contact, shown as such
      await page.$eval('#pgx-stg-tlsCa', (n) => { n.value = ''; });
      auto = true;
      await page.click('#pgx-stg-check');
      await page.waitForSelector('#pgx-stg-remembered', { timeout: 10000 }).catch(() => {});
      step('storage: remembered on first contact → "Zertifikat der NAS gemerkt", kept in the field',
        await visible(page, '#pgx-stg-remembered') && (await page.inputValue('#pgx-stg-tlsCa')).includes('TEFBRg=='));
      await page.unroute('**/api/v1/storage-targets/check');
      await page.keyboard.press('Escape');

      // ── umbenennen ──
      await page.click('.pgx-stg-row [data-action="edit"]');
      await page.waitForSelector('#pgx-stg-label');
      await page.fill('#pgx-stg-label', 'Zweite Platte');
      await page.click('#pgx-stg-save');
      await page.waitForFunction(() => /Zweite Platte/.test((document.querySelector('.pgx-stg-row') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
      step('storage: renamed', (await ctx.text(page, '.pgx-stg-row')).includes('Zweite Platte'));

      // ── löschen ──
      await page.click('.pgx-stg-row [data-action="delete"]');
      await page.click('.gcd-ok');
      step('storage: deleted → the list is empty again', await visible(page, '#pgx-stg-empty'));

      // ── Cloud-Konten: Weiterleitungs-URI und je Anbieter eine OAuth-App ──
      await page.goto(BASE + '/settings/plugins/cloud');
      await waitIdle(page);
      step('cloud accounts: the side navigation marks "Cloud-Konten"', (await page.$('a.pgx-sl[data-tab="cloud"][aria-current="page"]')) !== null);
      step('cloud accounts: the page shows the redirect URI', /\/oauth\/cloud\/callback$/.test((await ctx.text(page, '#pgx-cl-uri')).trim()));
      step('cloud accounts: one card per provider', (await page.$$('section[data-provider]')).length === 2);
      step('cloud accounts: nobody connected yet', await visible(page, '#pgx-cl-empty'));
      await shot(page, 'cloud-accounts');
    },
  };
};
