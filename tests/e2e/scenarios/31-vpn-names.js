'use strict';

// "Namen im VPN" (docs/feature-vpn-names.md): the former page "Interner DNS"
// is gone — the name stands with the device, the zone of the names and their
// state live in Einstellungen › VPN & Netzwerk.
//
// Part A, the app of the run (community licence): /dns leads to the settings,
// the menu item is gone, the card is visibly locked, the state card works.
//
// Part B needs the licence feature internal_dns, so the scenario starts a
// second app of its own (tests/e2e/app-licensed.js: own process, own empty
// data directory, own port, own dnsmasq.conf) and ends it again:
// the four states of the card (default, own domain, collision, domain
// removed), saving through the save bar, what lands in dnsmasq.conf and the
// hosts file, the state card, the name on the peer card / row with the copy
// button and its origin, "Namen vergeben", the dialog field with its live
// checks (invalid, reserved, taken — each with a suggestion) and a refusal of
// the server at the field, the stale filter, the gateway (card, head, "Mehr"),
// the hint in "Domain entfernen"; 390 px and dark.
//
// The texts are read from the page's own string islands, so the scenario runs
// in either language.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// what entrypoint.sh writes at a container start (the parts that matter here)
const BOOT_CONF = ['no-resolv', 'local=/gc.internal/', 'domain=gc.internal', 'host-record=gateway.gc.internal,10.8.0.1', 'server=1.1.1.1', 'server=8.8.8.8', ''].join('\n');

module.exports = (ctx) => {
  const { BASE, step, visible, shot, problems } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const cardState = (page) => page.evaluate(() => document.getElementById('card-vpn-names').dataset.state);
  // A text of the settings page with its values filled in, read from the page's
  // own string island — the scenario compares whole sentences, in either language.
  const stText = (page, key, params) => page.evaluate(([k, ps]) => {
    let str = JSON.parse(document.getElementById('st-i18n').textContent)[k];
    for (const [name, value] of Object.entries(ps || {})) str = str.split('{{' + name + '}}').join(value);
    return str;
  }, [key, params]);
  const fill = (str, params) => Object.entries(params).reduce((acc, [name, value]) => acc.split('{{' + name + '}}').join(value), str);
  // the lines of a dnsmasq.conf with one option
  const confLines = (file, option) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith(option + '='));

  // ── The licensed app of part B ──
  async function startLicensed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-vpn-names-'));
    const port = await freePort();
    const conf = path.join(dir, 'dnsmasq.conf');
    fs.writeFileSync(conf, BOOT_CONF);
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
      GC_DNS_PROBE: '127.0.0.1#1', // nothing answers there: the state card says so at once
      GC_DNS_DOMAIN: 'gc.internal',
      GC_HOST: '127.0.0.1',
      GC_PORT: String(port),
      GC_BASE_URL: `http://localhost:${port}`,
      GC_SERVER_LOG: 'off',
      E2E_FEATURES: 'internal_dns,vpn_peers=-1,gateway_peers=-1,http_routes=-1',
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
      up, base, dir, conf, hosts: env.GC_DNS_HOSTS_FILE, dbFile: env.GC_DB_PATH,
      log: () => { try { return fs.readFileSync(logFile, 'utf8').slice(-1500); } catch (_) { return ''; } },
      async stop() {
        if (child.exitCode === null) { await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 4000).unref(); }); }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      },
    };
  }
  function seedLicensed(app) {
    const Database = require('better-sqlite3');
    const db = new Database(app.dbFile);
    db.pragma('busy_timeout = 5000');
    try {
      const key = () => crypto.randomBytes(32).toString('base64');
      const peer = (name, ip, hostname, source, type = 'regular') => Number(db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, hostname, hostname_source, tags)
        VALUES (?, ?, ?, 1, ?, ?, ?, '')`).run(name, key(), ip + '/32', type, hostname, source).lastInsertRowid);
      const ids = {
        buero: peer('e2e-buero', '10.8.0.10', 'laptop-buero', 'admin'),
        pixel: peer('e2e-pixel', '10.8.0.14', 'pixel-8', 'agent'),
        ipad: peer('e2e-ipad', '10.8.0.21', 'ipad-tom', 'stale'),
        tablet: peer('e2e-tablet', '10.8.0.30', null, null),
        gw: peer('e2e-gw-buero', '10.8.0.2', 'gw-buero', 'agent', 'gateway'),
      };
      db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive, last_seen_at, last_health)
        VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, 1, strftime('%s','now')*1000, ?)`).run(ids.gw, crypto.randomBytes(16).toString('hex'),
        JSON.stringify({ telemetry: { gateway_version: '1.33.0' } }));
      const dom = (d) => Number(db.prepare("INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id) VALUES (?, 'verified', 'peer', ?)").run(d, ids.buero).lastInsertRowid);
      ids.com = dom('example.com');
      ids.org = dom('example.org');
      db.prepare("INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES ('NAS', 'nas.example.com', ?, 'nas')").run(ids.com);
      // an internal route of the legacy zone: a device cannot take its name
      db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled, route_type) VALUES ('kamera.gc.internal', '10.8.0.10', 8080, 1, 'http')").run();
      return ids;
    } finally { db.close(); }
  }

  return {
    async vpnnames(page) {
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ══ Part A: the app of the run, community licence ══
      await page.goto(BASE + '/dns');
      step('/dns leads to Einstellungen › VPN & Netzwerk', /\/settings\/netzwerk#card-vpn-names$/.test(page.url()) && await visible(page, '#card-vpn-names'));
      step('the menu item "Interner DNS" is gone', await page.locator('.sidebar a[href="/dns"], a.nav-item[href="/dns"]').count() === 0);
      step('without the licence the card is visibly locked',
        await until(page, () => {
          const card = document.getElementById('card-vpn-names');
          const hint = card.querySelector('[data-license-hint="internal_dns"]');
          return document.getElementById('st-vn-domain').disabled && !!card.querySelector('.st-pro') && hint && hint.textContent.trim().length > 0
            && card.dataset.state === 'std' && !document.getElementById('st-vn-sub-off').hidden;
        }));
      step('"Zustand der Namen": service, last rewrite, entries, the three fixed names',
        await until(page, () => {
          const svc = document.getElementById('st-vn-service');
          return ['running', 'stale', 'down', 'off'].includes(svc.dataset.service) && svc.textContent.trim().length > 1
            && /\d/.test(document.getElementById('st-vn-entries').textContent)
            && document.querySelectorAll('#st-vn-fixed-list li').length === 3
            && /gateway\./.test(document.querySelector('#st-vn-fixed-list li').textContent);
        }));
      await shot(page, 'vpnnames-locked');
      await page.goto(BASE + '/peers');
      step('without the licence a device without a name offers nothing, the dialogs have no name field',
        await until(page, () => !!document.querySelector('#pl-results [data-peer-id]'))
        && await page.locator('.vn-none').count() === 0 && await page.locator('#edit-peer-hostname, #add-peer-hostname').count() === 0);

      // ══ Part B: an app of its own with the licence feature ══
      const app = await startLicensed();
      step('licensed app of the scenario is up', app.up, app.up ? '' : app.log());
      if (!app.up) { await app.stop(); return; }
      const B = app.base;
      const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B }).catch(() => {});
      const p = await context.newPage();
      p.on('console', (m) => { if (m.type() === 'error') problems.push({ kind: 'console', text: 'vpnnames: ' + m.text().slice(0, 300) }); });
      p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: 'vpnnames: ' + String(e).slice(0, 300) }));
      p.on('response', (r) => {
        const u = r.url();
        if (u.startsWith(B) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', status: r.status(), url: 'vpnnames:' + u.replace(B, '') });
      });
      const api = async (method, url, body) => {
        const headers = method === 'GET' ? {} : { 'X-CSRF-Token': await p.evaluate(() => window.GC && window.GC.csrfToken) };
        const r = await p.request.fetch(B + url, { method, data: body, headers });
        return { status: r.status(), body: await r.json().catch(() => null) };
      };
      const names = async () => (await api('GET', '/api/v1/settings/vpn-names')).body.data;
      const VN = () => p.evaluate(() => JSON.parse(document.getElementById('pl-i18n').textContent));

      try {
        await p.goto(B + '/login');
        await p.fill('input[name="username"]', ctx.FIXTURES.admin.username);
        await p.fill('input[name="password"]', ctx.FIXTURES.admin.password);
        await Promise.all([p.waitForNavigation(), p.click('button[type="submit"]')]);
        const S = seedLicensed(app);

        // ── Einstellung: Standard ──
        await p.goto(B + '/settings/netzwerk');
        step('default: "<legacy zone> (Standard)", no subdomain needed, the preview shows the legacy name',
          await until(p, () => {
            const sel = document.getElementById('st-vn-domain');
            return !sel.disabled && sel.value === '' && /gc\.internal/.test(sel.options[0].textContent)
              && document.getElementById('card-vpn-names').dataset.state === 'std'
              && document.getElementById('st-vn-sub').hidden && !document.getElementById('st-vn-sub-off').hidden
              && document.getElementById('st-vn-preview-name').textContent === 'laptop-buero.gc.internal'
              && document.getElementById('st-vn-active').hidden;
          }));
        step('the domains of "Domains / Routen" can be chosen', await p.evaluate(() => [...document.getElementById('st-vn-domain').options].map((o) => o.value).join()) === ',example.com,example.org');
        await shot(p, 'vpnnames-default');

        // ── Eigene Domain: live preview ──
        await p.selectOption('#st-vn-domain', 'example.com');
        step('own domain: suggested subdomain "vpn", fixed ending, live preview, the legacy name stays',
          await until(p, () => document.getElementById('card-vpn-names').dataset.state === 'own'
            && document.getElementById('st-vn-sub').value === 'vpn' && !document.getElementById('st-vn-sub').hidden
            && document.getElementById('st-vn-suffix').textContent === '.example.com'
            && document.getElementById('st-vn-preview-name').textContent === 'laptop-buero.vpn.example.com'
            && /laptop-buero\.gc\.internal/.test(document.getElementById('st-vn-preview-note').textContent)
            && !document.getElementById('st-savebar').hidden));
        await p.fill('#st-vn-sub', 'geraete');
        step('the preview follows the subdomain while typing', await until(p, () => document.getElementById('st-vn-preview-name').textContent === 'laptop-buero.geraete.example.com'));

        // ── Kollision ──
        await p.fill('#st-vn-sub', 'nas');
        const clashText = await stText(p, 'st.names.err.collision_host', { fqdn: 'nas.example.com' }) + ' ' + await stText(p, 'st.names.err.suggest', { sub: 'vpn' });
        step('collision: the message names the host and a free subdomain, the preview waits',
          await until(p, (want) => {
            const err = document.getElementById('st-vn-sub-err');
            return document.getElementById('card-vpn-names').dataset.state === 'clash' && !err.hidden
              && err.textContent === want
              && document.getElementById('st-vn-preview').hidden && document.getElementById('st-vn-preview-note').textContent.trim().length > 10
              && document.getElementById('st-vn-sub').getAttribute('aria-invalid') === 'true';
          }, clashText), clashText);
        await shot(p, 'vpnnames-collision');
        await p.click('#st-save');
        await p.waitForTimeout(300);
        step('a taken subdomain is not saved', (await names()).custom === false && await p.evaluate(() => !document.getElementById('st-savebar').hidden));

        // ── Speichern ──
        await p.fill('#st-vn-sub', 'vpn');
        step('a free subdomain: the message goes, the preview is back',
          await until(p, () => document.getElementById('card-vpn-names').dataset.state === 'own' && document.getElementById('st-vn-sub-err').hidden && !document.getElementById('st-vn-preview').hidden));
        await p.click('#st-save');
        step('saved through the save bar: marked "aktiv"',
          await until(p, () => document.getElementById('st-savebar').hidden && !document.getElementById('st-vn-active').hidden));
        const saved = await names();
        step('the server names both zones, the own one first', saved.primary === 'vpn.example.com' && saved.zones.join() === 'vpn.example.com,gc.internal', JSON.stringify(saved.zones));
        const conf = fs.readFileSync(app.conf, 'utf8');
        step('dnsmasq.conf: local= and the fixed names of the new zone next to what the container start wrote',
          confLines(app.conf, 'local').join() === 'local=/gc.internal/,local=/vpn.example.com/'
          && confLines(app.conf, 'host-record').slice(1).join() === ['gateway', 'server', 'gc-server'].map((n) => `host-record=${n}.vpn.example.com,10.8.0.1`).join()
          && confLines(app.conf, 'server').join() === 'server=1.1.1.1,server=8.8.8.8', conf.length + ' bytes');
        step('hosts file: the device under both spellings', fs.readFileSync(app.hosts, 'utf8').split('\n').filter((l) => l.startsWith('10.8.0.10\t')).join() === '10.8.0.10\tlaptop-buero.vpn.example.com\tlaptop-buero.gc.internal\tlaptop-buero');
        await p.reload();
        step('after a reload the choice is still there',
          await until(p, () => document.getElementById('st-vn-domain').value === 'example.com' && document.getElementById('st-vn-sub').value === 'vpn'
            && !document.getElementById('st-vn-active').hidden && document.getElementById('st-savebar').hidden));
        await shot(p, 'vpnnames-own-domain');
        await p.click('#st-vn-preview-copy');
        step('the copy button copies the full name', await until(p, async () => (await navigator.clipboard.readText().catch(() => '')) === 'laptop-buero.vpn.example.com'));

        // ── Routen und Hosts bleiben draußen ──
        const host = await api('POST', `/api/v1/domains/${S.com}/hosts`, { subdomain: 'cam.vpn', entries: [{ type: 'http', target_port: 3000 }] });
        step('no host below the zone of the devices', host.status === 400 && host.body.code === 'DEVICE_ZONE', JSON.stringify(host.body));
        ctx.allow((x) => x.kind === 'http' && x.status === 400 && /vpnnames:\/api\/v1\/domains\/\d+\/hosts/.test(x.url));

        // ── Zustand der Namen ──
        step('state card: entries, one stale name with a link, the fixed names with both endings',
          await until(p, () => {
            // each row: the name in the new zone, in the legacy zone, the address
            const li = [...document.querySelectorAll('#st-vn-fixed-list li')].map((n) => [...n.childNodes].map((c) => c.textContent).join(' | '));
            // four devices with a name (the gateway is one), one route, the portal
            return /^6\s/.test(document.getElementById('st-vn-entries').textContent)
              && document.getElementById('st-vn-stale').textContent === '1' && !document.getElementById('st-vn-stale-link').hidden
              && li.join('\n') === ['gateway', 'server', 'gc-server'].map((n) => `${n}.vpn.example.com | ${n}.gc.internal | 10.8.0.1`).join('\n')
              && document.getElementById('st-vn-service').dataset.service === 'down';
          }));
        await p.locator('#st-vn-fixed summary').click();
        await shot(p, 'vpnnames-state');
        await p.click('#st-vn-stale-link');
        step('"Ansehen" opens the peers page with exactly the stale name',
          await until(p, (id) => {
            const cards = [...document.querySelectorAll('#pl-results [data-peer-id]')];
            return /hints=oldname/.test(location.hash) && cards.length === 1 && Number(cards[0].dataset.peerId) === id && !!cards[0].querySelector('.vn-stale');
          }, S.ipad));

        // ── Peers: der Name steht beim Gerät ──
        const T = await VN();
        await p.goto(B + '/peers');
        await p.evaluate(() => { try { localStorage.removeItem('gc-peers-view'); } catch (_) { /* ignore */ } });
        step('card: the full name with a copy button and its origin',
          await until(p, ([a, b, t]) => {
            const card = (id) => document.querySelector(`#pl-grid .pl-card[data-peer-id="${id}"]`);
            const ca = card(a); const cb = card(b);
            if (!ca || !cb) return false;
            return ca.querySelector('.vn-name code').textContent === 'laptop-buero.vpn.example.com' && !!ca.querySelector('.vn-copy')
              && ca.querySelector('.vn-src').textContent.trim() === t['vn.src_admin']
              && cb.querySelector('.vn-name code').textContent === 'pixel-8.vpn.example.com'
              && cb.querySelector('.vn-src').textContent.trim() === t['vn.src_agent'];
          }, [S.buero, S.pixel, T]));
        await p.click(`.pl-card[data-peer-id="${S.pixel}"] .vn-copy`);
        step('the copy button on the card copies the full name', await until(p, async () => (await navigator.clipboard.readText().catch(() => '')) === 'pixel-8.vpn.example.com'));
        step('the search finds a device by its name in the VPN',
          await p.fill('#peer-search', 'pixel-8').then(() => until(p, (id) => {
            const c = [...document.querySelectorAll('#pl-results [data-peer-id]')];
            return c.length === 1 && Number(c[0].dataset.peerId) === id;
          }, S.pixel)));
        await p.fill('#peer-search', '');
        await shot(p, 'vpnnames-peers');

        // ── "Namen vergeben" → Dialog ──
        await p.click(`.pl-card[data-peer-id="${S.tablet}"] .vn-none .vn-link`);
        step('a device without a name: "Namen vergeben" opens the dialog at the field',
          await visible(p, '#modal-edit-peer #edit-peer-hostname') && await until(p, () => document.activeElement && document.activeElement.id === 'edit-peer-hostname')
          && await p.textContent('#edit-peer-hostname-suffix') === '.vpn.example.com');
        const hintState = (want) => until(p, (w) => document.getElementById('edit-peer-hostname-hint').dataset.state === w, want);
        const saveOff = () => p.evaluate(() => document.getElementById('btn-edit-peer-submit').disabled);
        await p.fill('#edit-peer-hostname', 'Annas Pixel!');
        step('invalid: the rule in plain words, a suggestion, saving is off',
          await hintState('invalid') && await saveOff() && /annas-pixel/.test(await p.textContent('#edit-peer-hostname-hint'))
          && await p.getAttribute('#edit-peer-hostname', 'aria-invalid') === 'true');
        await shot(p, 'vpnnames-dialog-invalid', false);
        await p.click('#edit-peer-hostname-hint .vn-use');
        step('the suggestion is taken over with one click', await hintState('ok') && await p.inputValue('#edit-peer-hostname') === 'annas-pixel' && !(await saveOff()));
        await p.fill('#edit-peer-hostname', 'server');
        step('reserved: says so and suggests a name', await hintState('reserved') && await saveOff() && /server-2/.test(await p.textContent('#edit-peer-hostname-hint')));
        await p.fill('#edit-peer-hostname', 'Laptop-Buero');
        step('taken: names the device that has it and a free name',
          await hintState('taken') && await saveOff()
          && await p.evaluate(() => { const x = document.getElementById('edit-peer-hostname-hint').textContent; return /e2e-buero/.test(x) && /laptop-buero-2/.test(x); }));
        await shot(p, 'vpnnames-dialog-taken', false);
        await p.fill('#edit-peer-hostname', 'tablet-kinder');
        step('in order: the hint names both spellings',
          await hintState('ok') && await p.textContent('#edit-peer-hostname-hint') === fill(T['vn.hint_ok_both'], { fqdn: 'tablet-kinder.vpn.example.com', legacy: 'tablet-kinder.gc.internal' }));
        await p.click('#btn-edit-peer-submit');
        step('saved: the card shows the name as set by the admin',
          await until(p, ([id, t]) => {
            const c = document.querySelector(`#pl-grid .pl-card[data-peer-id="${id}"]`);
            const m = document.getElementById('modal-edit-peer');
            return m && getComputedStyle(m).display === 'none' && c && c.querySelector('.vn-name code') && c.querySelector('.vn-name code').textContent === 'tablet-kinder.vpn.example.com'
              && c.querySelector('.vn-src').textContent.trim() === t['vn.src_admin'];
          }, [S.tablet, T]));

        // ── A refusal only the server knows (a route has the name) is shown at the field ──
        await p.click(`.pl-card[data-peer-id="${S.pixel}"] [data-action="edit"]`);
        await visible(p, '#modal-edit-peer #edit-peer-hostname');
        step('a reported name: the dialog says where it comes from',
          await until(p, (t) => { const b = document.getElementById('edit-peer-hostname-badge'); return !b.hidden && b.textContent === t['vn.src_agent']; }, T)
          && (await p.textContent('#edit-peer-hostname-hint')).includes(T['vn.hint_agent']));
        await shot(p, 'vpnnames-dialog-ok', false);
        await p.fill('#edit-peer-hostname', 'kamera');
        await p.click('#btn-edit-peer-submit');
        step('a name a route already answers under: refused at the field, with the address and a free name',
          await hintState('server') && await p.evaluate(() => {
            const x = document.getElementById('edit-peer-hostname-hint').textContent;
            const m = document.getElementById('modal-edit-peer');
            return /kamera\.gc\.internal/.test(x) && /kamera-2/.test(x) && getComputedStyle(m).display !== 'none';
          }));
        ctx.allow((x) => x.kind === 'http' && x.status === 409 && /vpnnames:\/api\/(v1\/)?peers\/\d+\/hostname/.test(x.url),
          (x) => x.kind === 'console' && /vpnnames:.*409/.test(x.text));
        const pixel = (await api('GET', '/api/v1/peers/' + S.pixel)).body.peer;
        step('the name of the device is unchanged', pixel.hostname === 'pixel-8' && pixel.hostname_source === 'agent');
        await p.click('#modal-edit-peer [data-close-modal]');

        // ── Liste ──
        await p.click('#pl-view [data-view="list"]');
        step('list: the name with the copy button in the row of the device',
          await until(p, (id) => { const r = document.querySelector(`#pl-table tr[data-peer-id="${id}"] .pl-vn-row .vn-name code`); return r && r.textContent === 'laptop-buero.vpn.example.com'; }, S.buero)
          && await p.locator(`#pl-table tr[data-peer-id="${S.buero}"] .vn-copy`).count() === 1);
        await shot(p, 'vpnnames-peers-list');
        await p.click('#pl-view [data-view="cards"]');

        // ── 390 px, dunkel: one measurement in the page (it may redraw between two) ──
        await p.setViewportSize({ width: 390, height: 844 });
        await theme(p, 'dark');
        await until(p, () => !!document.querySelector('#pl-grid .pl-card .vn-name'));
        const narrow = await p.evaluate(() => {
          const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, cards: 0, outside: 0 };
          for (const card of document.querySelectorAll('#pl-grid .pl-card')) {
            const c = card.getBoundingClientRect();
            for (const n of card.querySelectorAll('.vn-name, .vn-src')) {
              out.cards++;
              const r = n.getBoundingClientRect();
              if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.width < 1) out.outside++;
            }
          }
          return out;
        });
        step('390 px: the name has its own line inside the card, the page does not scroll sideways', narrow.overflow <= 0 && narrow.cards >= 6 && narrow.outside === 0, JSON.stringify(narrow));
        await shot(p, 'vpnnames-peers-390-dark');
        await p.click(`.pl-card[data-peer-id="${S.buero}"] [data-action="edit"]`);
        await visible(p, '#modal-edit-peer #edit-peer-hostname');
        const field = await p.evaluate(() => {
          const g = document.querySelector('#modal-edit-peer .vn-grp').getBoundingClientRect();
          const m = document.querySelector('#modal-edit-peer .modal').getBoundingClientRect();
          const i = document.getElementById('edit-peer-hostname').getBoundingClientRect();
          return { inside: g.left >= m.left && g.right <= m.right + 0.5, input: Math.round(i.width), overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        step('390 px: the field with its ending fits the dialog', field.inside && field.input >= 100 && field.overflow <= 0, JSON.stringify(field));
        await shot(p, 'vpnnames-dialog-390-dark', false);
        await p.click('#modal-edit-peer [data-close-modal]');
        await p.goto(B + '/settings/netzwerk');
        await until(p, () => !document.getElementById('st-vn-active').hidden);
        const st390 = await p.evaluate(() => {
          const card = document.getElementById('card-vpn-names').getBoundingClientRect();
          const prev = document.getElementById('st-vn-preview').getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth - window.innerWidth, inside: prev.left >= card.left && prev.right <= card.right + 0.5 };
        });
        step('390 px: the settings card fits', st390.overflow <= 0 && st390.inside, JSON.stringify(st390));
        await shot(p, 'vpnnames-settings-390-dark');
        await theme(p, 'light');
        await p.setViewportSize({ width: 1440, height: 1000 });

        // ── Gateway ──
        await p.goto(B + '/gateways');
        step('gateway card: the name with the copy button',
          await until(p, (id) => { const c = document.querySelector(`.gw.unit[data-id="${id}"] .gw-vn code`); return c && c.textContent === 'gw-buero.vpn.example.com'; }, S.gw));
        await p.click(`.gw.unit[data-id="${S.gw}"] a.gw-card-link`);
        step('gateway head: the name next to the VPN address',
          await until(p, () => { const c = document.querySelector('.gw-head .gw-vn code'); return c && c.textContent === 'gw-buero.vpn.example.com' && !!document.querySelector('.gw-head .gw-vn .vn-copy'); }));
        await shot(p, 'vpnnames-gateway');
        await p.click('#gw-more-btn');
        await p.click('#gw-more-menu [data-act="gm-rename"]');
        step('"Mehr": the name in the VPN can be changed where the display name is',
          await visible(p, '#gwm-hostname') && await p.inputValue('#gwm-hostname') === 'gw-buero'
          && await p.evaluate(() => document.querySelector('.vn-field .vn-suf').textContent === '.vpn.example.com'));
        await p.fill('#gwm-hostname', 'gw-keller');
        await p.click('#gwm-save');
        step('saved: the head shows the new name',
          await until(p, () => { const c = document.querySelector('.gw-head .gw-vn code'); return c && c.textContent === 'gw-keller.vpn.example.com'; }));

        // ── Domain entfernen ──
        await p.goto(B + '/settings/netzwerk');
        await until(p, () => document.getElementById('st-vn-domain').value === 'example.com');
        await p.selectOption('#st-vn-domain', 'example.org');
        await until(p, () => document.getElementById('st-vn-preview-name').textContent === 'laptop-buero.vpn.example.org');
        await p.click('#st-save');
        step('another domain: saved, the block in dnsmasq.conf follows',
          await until(p, () => document.getElementById('st-savebar').hidden && !document.getElementById('st-vn-active').hidden)
          && confLines(app.conf, 'local').join() === 'local=/gc.internal/,local=/vpn.example.org/'
          && confLines(app.conf, 'host-record').join() === ['host-record=gateway.gc.internal,10.8.0.1'].concat(['gateway', 'server', 'gc-server'].map((n) => `host-record=${n}.vpn.example.org,10.8.0.1`)).join(),
          confLines(app.conf, 'local').join());
        await p.goto(B + '/settings/domains');
        await visible(p, '#st-dom-list li[data-domain="example.org"]');
        await p.click('#st-dom-list li[data-domain="example.org"] .st-li-actions .st-icon-btn');
        step('"Domain entfernen" says that the names hang on it and go on working',
          await visible(p, '.gcd-dialog .gcd-detail')
          && await p.textContent('.gcd-dialog .gcd-detail') === await stText(p, 'st.names.remove_detail', { zone: 'vpn.example.org' }));
        await shot(p, 'vpnnames-domain-remove', false);
        await p.click('.gcd-dialog .gcd-ok');
        await until(p, () => !document.querySelector('#st-dom-list li[data-domain="example.org"]'));
        await p.goto(B + '/settings/netzwerk');
        const goneText = await stText(p, 'st.names.removed_b', { domain: 'example.org' }) + ' ' + await stText(p, 'st.names.removed', { zone: 'vpn.example.org', legacy: 'gc.internal' });
        const goneOption = await stText(p, 'st.names.removed_option', { domain: 'example.org' });
        step('domain removed: the card says so, the names go on, the way back is offered',
          await until(p, ([text, option]) => {
            const box = document.getElementById('st-vn-removed');
            const sel = document.getElementById('st-vn-domain');
            return document.getElementById('card-vpn-names').dataset.state === 'gone' && !box.hidden
              && box.textContent === text
              && sel.value === 'example.org' && sel.getAttribute('aria-invalid') === 'true' && sel.selectedOptions[0].textContent === option
              && !document.getElementById('st-vn-back-row').hidden && document.getElementById('st-vn-active').hidden;
          }, [goneText, goneOption]), goneText);
        step('… and the names still resolve as before', (await names()).zones.join() === 'vpn.example.org,gc.internal' && confLines(app.conf, 'local').join() === 'local=/gc.internal/,local=/vpn.example.org/');
        await shot(p, 'vpnnames-domain-removed');
        await p.click('#st-vn-back');
        step('"Zurück zu gc.internal": default again, the block is gone from dnsmasq.conf',
          await until(p, () => document.getElementById('card-vpn-names').dataset.state === 'std' && document.getElementById('st-vn-domain').value === ''
            && document.getElementById('st-vn-back-row').hidden && document.getElementById('st-savebar').hidden)
          && (await names()).custom === false && fs.readFileSync(app.conf, 'utf8') === BOOT_CONF,
          JSON.stringify({ state: await cardState(p), custom: (await names()).custom, conf: fs.readFileSync(app.conf, 'utf8') === BOOT_CONF }));
        step('hosts file: one spelling again', /^10\.8\.0\.10\tlaptop-buero\.gc\.internal\tlaptop-buero$/m.test(fs.readFileSync(app.hosts, 'utf8')));
      } finally {
        await context.close().catch(() => {});
        await app.stop();
      }
    },
  };
};
