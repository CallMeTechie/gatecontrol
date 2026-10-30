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
