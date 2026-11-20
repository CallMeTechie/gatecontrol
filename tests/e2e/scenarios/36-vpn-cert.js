'use strict';

// "Zertifikat für die Namen" (docs/feature-vpn-names.md, services/vpnCert.js):
// the card in Einstellungen › VPN & Netzwerk for the wildcard certificate of
// the VPN zone via ACME DNS-01.
//
// Part A, the app of the run (community licence): the card is visibly locked.
//
// Part B starts an app of its own with the licence feature internal_dns
// (tests/e2e/app-licensed.js) and a stub of `caddy gc-dnstest`
// (GC_CADDY_BIN): every view of the card — without an own domain, off,
// set up and test, being fetched, valid, renewal stopped — the save bar, the
// test steps with the suggested waiting time, no credential value in the page
// or the answers, "Ändern", switching off; 390 px and dark.
// Caddy is not running there (NODE_ENV=test): the certificate states are
// written into tls_status the way the TLS guard writes them.
//
// All names and values are made up. The texts are read from the page's own
// string island, so the scenario runs in either language.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

const NETCUP = { customer_number: '12345', api_key: 'fake-netcup-key-e2e-0001', api_password: 'fake-netcup-pass-e2e-0001' };

// `caddy gc-dnstest`: the five steps, a propagation of 42 s
const STUB = `#!/usr/bin/env node
'use strict';
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  require('node:fs').writeFileSync(process.argv[1] + '.request.json', raw);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  setTimeout(() => {
    out({ step: 'login', status: 'ok', ms: 120 });
    out({ step: 'zone', status: 'ok', ms: 30, detail: 'example.com' });
    out({ step: 'write', status: 'ok', ms: 200 });
    out({ step: 'visible', status: 'ok', ms: 42000, detail: 'ns1.example.com' });
    out({ step: 'delete', status: 'ok', ms: 90 });
    out({ done: true, ok: true, zone: 'example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], propagation_ms: 42000 });
  }, 600);
  if (!req.record) process.exit(2);
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

module.exports = (ctx) => {
  const { BASE, step, visible, problems } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  // the card alone (the page around it is the one of "Namen im VPN")
  const cardShot = (page, name) => page.locator('#card-vpn-cert').screenshot({ path: path.join(ctx.OUT, name + '.png') }).catch(() => {});
  const stText = (page, key, params) => page.evaluate(([k, ps]) => {
    let str = JSON.parse(document.getElementById('st-i18n').textContent)[k];
    for (const [name, value] of Object.entries(ps || {})) str = str.split('{{' + name + '}}').join(value);
    return str;
  }, [key, params]);

  async function startLicensed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-vpn-cert-'));
    const port = await freePort();
    const conf = path.join(dir, 'dnsmasq.conf');
    fs.writeFileSync(conf, 'local=/gc.internal/\n');
    const stub = path.join(dir, 'caddy-stub');
    fs.writeFileSync(stub, STUB, { mode: 0o755 });
    const env = Object.assign({}, process.env, {
      NODE_ENV: 'test',
      GC_DATA_DIR: dir,
      GC_DB_PATH: path.join(dir, 'gatecontrol.db'),
      GC_CADDY_DATA_DIR: path.join(dir, 'caddy'),
      GC_BACKUP_DIR: path.join(dir, 'backups'),
      GC_DNS_HOSTS_FILE: path.join(dir, 'dns', 'peers.hosts'),
      GC_WG_CONFIG_PATH: path.join(dir, 'wireguard', 'wg0.conf'),
      GC_SUPPORT_BUNDLE_DIR: path.join(dir, 'support'),
      GC_DNSMASQ_CONF: conf,
      GC_DNS_PROBE: '127.0.0.1#1',
      GC_DNS_DOMAIN: 'gc.internal',
      GC_CADDY_BIN: stub,
      GC_HOST: '127.0.0.1',
      GC_PORT: String(port),
      GC_BASE_URL: `http://localhost:${port}`,
      GC_SERVER_LOG: 'off',
      E2E_FEATURES: 'internal_dns,vpn_peers=-1,http_routes=-1',
    });
    fs.mkdirSync(path.join(dir, 'dns'), { recursive: true });
    const logFile = path.join(dir, 'app.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'app-licensed.js')], { cwd: ROOT, env, stdio: ['ignore', out, out] });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up && child.exitCode === null; i++) {
      up = await fetch(base + '/login').then((r) => r.status === 200, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    return {
      up, base, dir, stub, dbFile: env.GC_DB_PATH, caddyDir: env.GC_CADDY_DATA_DIR,
      log: () => { try { return fs.readFileSync(logFile, 'utf8').slice(-1500); } catch (_) { return ''; } },
      async stop() {
        if (child.exitCode === null) { await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 4000).unref(); }); }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      },
    };
  }
  function db(app, fn) {
    const Database = require('better-sqlite3');
    const d = new Database(app.dbFile);
    d.pragma('busy_timeout = 5000');
    try { return fn(d); } finally { d.close(); }
  }
  // the certificate row the way the TLS guard writes it
  function certRow(app, patch) {
    db(app, (d) => {
      d.prepare("INSERT OR IGNORE INTO tls_status (host, state) VALUES ('*.vpn.example.com', 'pending')").run();
      const keys = Object.keys(patch);
      d.prepare(`UPDATE tls_status SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE host = '*.vpn.example.com'`).run(patch);
    });
  }

  return {
    async vpncert(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ══ Part A: community licence ══
      await page.goto(BASE + '/settings/netzwerk');
      step('the card "Zertifikat für die Namen" sits between "Namen im VPN" and "Zustand der Namen"',
        await visible(page, '#card-vpn-cert')
        && await page.evaluate(() => {
          const a = document.getElementById('card-vpn-names'); const b = document.getElementById('card-vpn-cert'); const c = document.getElementById('card-vpn-names-state');
          return a.nextElementSibling === b && b.nextElementSibling === c;
        }));
      step('without the licence the card is visibly locked',
        await until(page, () => {
          const card = document.getElementById('card-vpn-cert');
          const hint = card.querySelector('[data-license-hint="internal_dns"]');
          return card.dataset.view === 'locked' && !!card.querySelector('.st-pro') && hint && hint.textContent.trim().length > 0
            && document.getElementById('st-vc-setup').disabled && !document.getElementById('st-vc-setup').hidden;
        }));
      await cardShot(page, 'vpncert-locked');

      // ══ Part B: an app of its own with the licence feature ══
      const app = await startLicensed();
      step('licensed app of the scenario is up', app.up, app.up ? '' : app.log());
      if (!app.up) { await app.stop(); return; }
      const B = app.base;
      const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
      const p = await context.newPage();
      p.on('console', (m) => { if (m.type() === 'error') problems.push({ kind: 'console', text: 'vpncert: ' + m.text().slice(0, 300) }); });
      p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: 'vpncert: ' + String(e).slice(0, 300) }));
      const bodies = [];
      p.on('response', async (r) => {
        const u = r.url();
        if (u.startsWith(B) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', status: r.status(), url: 'vpncert:' + u.replace(B, '') });
        if (u.startsWith(B + '/api/v1/settings/vpn-cert')) bodies.push(await r.text().catch(() => ''));
      });
      const api = async (method, url, body) => {
        const headers = method === 'GET' ? {} : { 'X-CSRF-Token': await p.evaluate(() => window.GC && window.GC.csrfToken) };
        const r = await p.request.fetch(B + url, { method, data: body, headers });
        return { status: r.status(), body: await r.json().catch(() => null) };
      };
      const leaked = async () => {
        const html = await p.content();
        return Object.values(NETCUP).filter((v) => v.length > 8).some((v) => html.includes(v) || bodies.some((b) => b.includes(v)));
      };

      try {
        await p.goto(B + '/login');
        await p.fill('input[name="username"]', ctx.FIXTURES.admin.username);
        await p.fill('input[name="password"]', ctx.FIXTURES.admin.password);
        await Promise.all([p.waitForNavigation(), p.click('button[type="submit"]')]);
        db(app, (d) => d.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run());

        // ── ohne eigene Domain ──
        await p.goto(B + '/settings/netzwerk');
        const nozoneText = await stText(p, 'st.vc.nozone_b') + ' ' + await stText(p, 'st.vc.nozone', { legacy: 'gc.internal' });
        step('without an own domain: the card asks for one first',
          await until(p, (want) => document.getElementById('card-vpn-cert').dataset.view === 'nozone'
            && document.querySelector('#card-vpn-cert [data-vc-show~="nozone"] .stx-box').textContent === want, nozoneText), nozoneText);

        // ── aus ──
        const r = await api('PUT', '/api/v1/settings/vpn-names', { base_domain: 'example.com', sub: 'vpn' });
        step('own domain for the names saved', r.status === 200, JSON.stringify(r.body));
        await p.reload();
        step('off: no provider, today\'s state, "Einrichten"',
          await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'off'
            // the names stand in their own monospace parts: compared exactly
            && [...document.querySelectorAll('#st-vc-desc .st-mono')].map((n) => n.textContent).join() === 'vpn.example.com'
            && [...document.querySelectorAll('#st-vc-today .st-mono')].map((n) => n.textContent).join() === 'home.gc.internal,vpn.example.com'
            && !document.getElementById('st-vc-pill').hidden && !document.getElementById('st-vc-setup').disabled
            && document.getElementById('st-savebar').hidden));
        await cardShot(p, 'vpncert-off');

        // ── einrichten ──
        await p.click('#st-vc-setup');
        step('"Einrichten": the forwarding via deSEC is offered first, the save bar shows the change',
          await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'setup'
            && document.getElementById('st-vc-provider').value === 'desec_delegated'
            && !document.getElementById('st-vc-delegate-row').hidden
            && document.getElementById('st-vc-rights').dataset.tone === 'good'
            && document.getElementById('st-vc-wildcard').textContent === '*.vpn.example.com'
            && !document.getElementById('st-savebar').hidden && document.getElementById('st-vc-pill').dataset.state === 'info'));
        await p.selectOption('#st-vc-provider', 'netcup');
        step('netcup: its three fields, the hint "besser Weiterleitung", its waiting time',
          await until(p, () => document.querySelectorAll('#st-vc-fields .st-row').length === 3
            && document.getElementById('st-vc-rights').dataset.tone === 'warn'
            && document.getElementById('st-vc-delegate-row').hidden && !document.getElementById('st-vc-cname-wrap').hidden
            && document.getElementById('st-vc-delay').value === '300'
            && document.getElementById('st-vc-f-api_key').type === 'password'));
        step('the test names the real challenge record',
          await p.evaluate(() => [...document.querySelectorAll('#st-vc-test-hint .st-mono')].map((n) => n.textContent).join()) === '_acme-challenge.vpn.example.com');
        await p.fill('#st-vc-f-customer_number', NETCUP.customer_number);
        await p.fill('#st-vc-f-api_key', NETCUP.api_key);
        await p.fill('#st-vc-f-api_password', NETCUP.api_password);
        await cardShot(p, 'vpncert-setup');

        // ── Testen ──
        const zoneStep = await stText(p, 'st.vc.step.zone_named', { zone: 'example.com' });
        await p.click('#st-vc-test');
        step('"Testen": five steps, all ticked, with the measured time and a suggested waiting time',
          await until(p, (zoneLabel) => {
            const li = [...document.querySelectorAll('#st-vc-checks li')];
            return li.length === 5 && li.every((x) => x.dataset.s === 'ok') && /\b42 s\b/.test(li[3].textContent) && /\b80 s\b/.test(li[3].textContent)
              && li[1].lastElementChild.textContent === zoneLabel;
          }, zoneStep, 15000));
        const req = JSON.parse(fs.readFileSync(app.stub + '.request.json', 'utf8'));
        step('the test request: _acme-challenge.<zone>, a unique test value, values only as file placeholders',
          req.record === '_acme-challenge.vpn.example.com' && /^gc-test-[0-9a-f]{24}$/.test(req.value)
          && /^\{file\./.test(req.provider.api_key) && !JSON.stringify(req).includes(NETCUP.api_key), JSON.stringify({ record: req.record }));
        await p.click('#st-vc-checks li:nth-child(4) .vn-link');
        step('"Übernehmen" puts the suggested waiting time into the field', await until(p, () => document.getElementById('st-vc-delay').value === '80'));
        await cardShot(p, 'vpncert-tested');

        // ── Speichern ──
        await p.click('#st-save');
        step('saved through the save bar: being fetched',
          await until(p, () => document.getElementById('st-savebar').hidden && document.getElementById('card-vpn-cert').dataset.view === 'pending'));
        const saved = (await api('GET', '/api/v1/settings/vpn-cert')).body.data;
        step('the server keeps the provider, the fields set and the waiting time — never a value',
          saved.provider === 'netcup' && saved.fields_set.length === 3 && saved.propagation_delay === 80 && !await leaked(), JSON.stringify({ provider: saved.provider, fields: saved.fields_set }));
        step('one file per credential for Caddy',
          ['customer_number', 'api_key', 'api_password'].every((f) => fs.existsSync(path.join(app.caddyDir, 'secrets', 'dns', f))));
        await cardShot(p, 'vpncert-pending');

        // ── gültig ──
        certRow(app, { state: 'issued', not_after: new Date(Date.now() + 89 * 86400000).toISOString(), issuer: "Let's Encrypt" });
        await p.reload();
        const until90 = await stText(p, 'st.vc.days_left_other', { n: '89' });
        step('valid: date and days left, the provider with "Ändern", "Ausschalten"; no renewal needed yet',
          await until(p, (want) => document.getElementById('card-vpn-cert').dataset.view === 'active'
            && document.getElementById('st-vc-valid').textContent.includes(want)
            && document.getElementById('st-vc-provider-name').textContent === 'netcup'
            && !document.getElementById('st-vc-off').hidden && document.getElementById('st-vc-renew').hidden
            && !!document.getElementById('st-vc-off').closest('.stx-cha')
            && document.getElementById('st-vc-pill').dataset.state === 'good', until90), until90);
        step('valid: "Genutzt von" lists the portal and the management under the zone',
          await until(p, () => {
            const items = [...document.querySelectorAll('#st-vc-used .vn-name')].map((n) => n.querySelector('code').textContent);
            return !document.getElementById('st-vc-used-row').hidden
              && items.join() === 'home.vpn.example.com,gc-server.vpn.example.com,server.vpn.example.com';
          }));
        const perm = await p.request.fetch(B + '/api/v1/settings/portal');
        step('the portal settings name home.<zone> next to the internal name',
          (await perm.json()).data.vpnHost === 'home.vpn.example.com');
        await cardShot(p, 'vpncert-active');

        // ── Ändern ──
        await p.click('#st-vc-change');
        step('"Ändern": the stored secrets show as saved, nothing is changed yet',
          await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'setup'
            && document.getElementById('st-vc-f-api_key').value === '' && document.getElementById('st-vc-f-api_key').placeholder.length > 5
            && document.getElementById('st-vc-f-customer_number').value === '12345'
            && document.getElementById('st-savebar').hidden && !document.getElementById('st-vc-cancel').hidden));
        await p.click('#st-vc-cancel');
        step('"Abbrechen" goes back to the valid certificate', await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'active'));

        // ── Erneuern angehalten ──
        certRow(app, { state: 'paused', paused_reason: 'attempts', attempts: 3, last_error: 'netcup: API key invalid for ' + NETCUP.api_key, not_after: new Date(Date.now() + 14 * 86400000).toISOString() });
        await p.reload();
        step('renewal stopped: what happened, that it stopped, until when the old one holds — without the key',
          await until(p, () => {
            const box = document.getElementById('st-vc-error');
            return document.getElementById('card-vpn-cert').dataset.view === 'error' && !box.hidden && box.dataset.tone === 'crit'
              && /3/.test(box.querySelector('b').textContent) && /\*\*\*/.test(box.textContent)
              && !document.getElementById('st-vc-retry').hidden && !document.getElementById('st-vc-fix').hidden
              && document.getElementById('st-vc-pill').dataset.state === 'crit';
          }) && !await leaked());
        await cardShot(p, 'vpncert-error');
        await p.click('#st-vc-retry');
        step('"Erneut versuchen": counters reset, being fetched again',
          await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'active' || document.getElementById('card-vpn-cert').dataset.view === 'pending')
          && db(app, (d) => d.prepare("SELECT attempts FROM tls_status WHERE host = '*.vpn.example.com'").get().attempts) === 0);

        // ── 390 px, dunkel ──
        certRow(app, { state: 'issued', paused_reason: null, paused_at: null, not_after: new Date(Date.now() + 60 * 86400000).toISOString() });
        await p.setViewportSize({ width: 390, height: 900 });
        await p.reload();
        await theme(p, 'dark');
        await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'active');
        await p.click('#st-vc-change');
        await p.selectOption('#st-vc-provider', 'desec_delegated');
        await until(p, () => !document.getElementById('st-vc-delegate-row').hidden);
        const fit = await p.evaluate(() => {
          const card = document.getElementById('card-vpn-cert').getBoundingClientRect();
          const outside = [...document.querySelectorAll('#card-vpn-cert .st-input, #card-vpn-cert .st-select, #card-vpn-cert .pgx-btn')]
            .filter((n) => n.offsetParent).filter((n) => { const b = n.getBoundingClientRect(); return b.left < card.left - 0.5 || b.right > card.right + 0.5; }).length;
          return { overflow: document.documentElement.scrollWidth - window.innerWidth, outside };
        });
        step('390 px: no horizontal scroll, every control inside the card', fit.overflow <= 0 && fit.outside === 0, JSON.stringify(fit));
        await cardShot(p, 'vpncert-390-dark');
        await p.click('#st-discard');
        await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'active');
        await p.setViewportSize({ width: 1440, height: 1000 });
        await theme(p, 'light');

        // ── Ausschalten ──
        await p.click('#st-vc-off');
        await visible(p, '.gcd-dialog .gcd-ok');
        await p.click('.gcd-dialog .gcd-ok');
        step('"Ausschalten": back to off, credentials and files gone',
          await until(p, () => document.getElementById('card-vpn-cert').dataset.view === 'off')
          && (await api('GET', '/api/v1/settings/vpn-cert')).body.data.provider === null
          && (fs.existsSync(path.join(app.caddyDir, 'secrets', 'dns')) ? fs.readdirSync(path.join(app.caddyDir, 'secrets', 'dns')).length : 0) === 0);
        step('no credential value ever reached the page', !await leaked());
      } finally {
        await context.close().catch(() => {});
        await app.stop();
      }
    },
  };
};
