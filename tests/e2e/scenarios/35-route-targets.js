'use strict';

// Domains / Routen — targets and the row actions (docs/feature-domain-zones.md):
//
//   * entry editor of a TCP entry with its own gateway target: the select
//     "Gateway" has the groups Gateways / Gateway pools (like the RDP route),
//     gateway → pool → gateway stores exactly one of the two;
//   * an entry whose gateway was deleted: hint at the select, the 400
//     TARGET_REQUIRED of a save lands as a field error there, a new gateway saves;
//   * UDP behind a gateway: UDP button locked in the editor, UDP locked in
//     "Weiterleitung hinzufügen" and "Neuer Host", the API answers 400
//     UDP_VIA_GATEWAY; an older UDP entry behind a gateway carries "wirkt nicht"
//     (row note) and the editor says so;
//   * "Weiterleitung hinzufügen" / "Neuer Host" whose answer is lost after the
//     server created the entry/host (page.route): the page reloads, the form
//     closes, a note instead of an error, nothing twice;
//   * row menu (.rt-more): a small scroll moves it along, scrolling the button
//     out of sight closes it;
//   * delete answered 202 { pending } (page.route): "still being applied",
//     the routes event with sync 'failed' brings the error message.
//
// Needs the L4 and pool licence features, so the scenario starts an app of its
// own (tests/e2e/app-licensed.js) like scenarios/33-rdp-pool.js.

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

module.exports = (ctx) => {
  const { step, problems, shot } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

  async function startLicensed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-route-targets-'));
    const port = await freePort();
    const env = Object.assign({}, process.env, {
      NODE_ENV: 'test',
      GC_DATA_DIR: dir,
      GC_DB_PATH: path.join(dir, 'gatecontrol.db'),
      GC_CADDY_DATA_DIR: path.join(dir, 'caddy'),
      GC_BACKUP_DIR: path.join(dir, 'backups'),
      GC_DNS_HOSTS_FILE: path.join(dir, 'dns', 'peers.hosts'),
      GC_WG_CONFIG_PATH: path.join(dir, 'wireguard', 'wg0.conf'),
      GC_SUPPORT_BUNDLE_DIR: path.join(dir, 'support'),
      GC_HOST: '127.0.0.1',
      GC_PORT: String(port),
      GC_BASE_URL: `http://localhost:${port}`,
      GC_SERVER_LOG: 'off',
      E2E_FEATURES: 'gateway_pools,gateway_pool_failover,gateway_tcp_routing,gateway_peers=-1,l4_routes=-1,http_routes=-1,vpn_peers=-1',
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
      up, base, dbFile: env.GC_DB_PATH,
      log: () => { try { return fs.readFileSync(logFile, 'utf8').slice(-1500); } catch (_) { return ''; } },
      async stop() {
        if (child.exitCode === null) { await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 4000).unref(); }); }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      },
    };
  }

  function withDb(app, fn) {
    const Database = require('better-sqlite3');
    const db = new Database(app.dbFile);
    db.pragma('busy_timeout = 5000');
    try { return fn(db); } finally { db.close(); }
  }

  // two gateways, a failover pool with the second one, a domain zone on the first
  function seed(app) {
    return withDb(app, (db) => {
      const gw = (name, ip) => {
        const id = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
          .run(name, crypto.randomBytes(32).toString('base64'), ip + '/32').lastInsertRowid);
        db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive, last_seen_at)
          VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, 1, strftime('%s','now')*1000)`).run(id, crypto.randomBytes(16).toString('hex'));
        return id;
      };
      const a = gw('e2e-target-gw-a', '10.8.0.50');
      const b = gw('e2e-target-gw-b', '10.8.0.51');
      const pool = Number(db.prepare("INSERT INTO gateway_pools (name, mode, failback_cooldown_s) VALUES ('e2e-target-pool', 'failover', 60)").run().lastInsertRowid);
      db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, ?, 10)').run(pool, b);
      const zone = Number(db.prepare("INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled) VALUES ('e2e-targets.example.com', 'verified', 'gateway', ?, 0)")
        .run(a).lastInsertRowid);
      return { a, b, pool, zone };
    });
  }
  const routeRow = (app, id) => withDb(app, (db) => db.prepare('SELECT target_kind, target_peer_id, target_pool_id, l4_protocol, enabled FROM routes WHERE id = ?').get(id) || {});

  return {
    async routetargets(page) {
      const app = await startLicensed();
      step('routetargets: licensed app of the scenario is up', app.up, app.up ? '' : app.log());
      if (!app.up) { await app.stop(); return; }
      const B = app.base;
      const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
      const p = await context.newPage();
      // 4xx/5xx the scenario provokes on purpose are listed here and not counted.
      const expected = [];
      p.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/Failed to load resource/.test(m.text()) && expected.length) return;
        problems.push({ kind: 'console', text: 'routetargets: ' + m.text().slice(0, 300) });
      });
      p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: 'routetargets: ' + String(e).slice(0, 300) }));
      p.on('response', (r) => {
        const u = r.url();
        if (!u.startsWith(B) || r.status() < 400 || u.includes('/favicon')) return;
        if (expected.some((f) => f(r))) return;
        problems.push({ kind: 'http', status: r.status(), url: 'routetargets:' + u.replace(B, '') });
      });
      const api = async (method, url, body) => {
        const headers = method === 'GET' ? {} : { 'X-CSRF-Token': await p.evaluate(() => window.GC && window.GC.csrfToken) };
        const r = await p.request.fetch(B + url, { method, data: body, headers });
        return { status: r.status(), body: await r.json().catch(() => null) };
      };
      try {
        await p.goto(B + '/login');
        await p.fill('input[name="username"]', ctx.FIXTURES.admin.username);
        await p.fill('input[name="password"]', ctx.FIXTURES.admin.password);
        await Promise.all([p.waitForNavigation(), p.click('button[type="submit"]')]);
        const S = seed(app);

        // Entries: R1 TCP on gateway a (own target), R2 an older UDP entry on
        // gateway a (the API refuses that now → stored as TCP, then switched in
        // the database), R3 TCP whose gateway gets deleted.
        const mk = async (lp) => api('POST', '/api/v1/routes', {
          route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: String(lp), l4_tls_mode: 'none',
          target_kind: 'gateway', target_peer_id: S.a, target_lan_host: '192.168.60.10', target_lan_port: 22, target_port: 22,
        });
        const r1 = await mk(4901);
        const r2 = await mk(4902);
        const r3 = await mk(4903);
        step('routetargets: three TCP entries on a gateway are created', [r1, r2, r3].every((r) => r.status === 201),
          [r1, r2, r3].map((r) => r.status + ' ' + JSON.stringify(r.body).slice(0, 120)).join(' | '));
        const id1 = r1.body.route.id;
        const id2 = r2.body.route.id;
        const id3 = r3.body.route.id;
        withDb(app, (db) => {
          db.prepare("UPDATE routes SET l4_protocol = 'udp' WHERE id = ?").run(id2);
          // what deleting the gateway does (services/peers.js)
          db.prepare('UPDATE routes SET target_peer_id = NULL, enabled = 0 WHERE id = ?').run(id3);
        });

        // ── API: UDP behind a gateway → 400 UDP_VIA_GATEWAY, translated ──
        const udp = await api('POST', '/api/v1/routes', {
          route_type: 'l4', l4_protocol: 'udp', l4_listen_port: '4904', l4_tls_mode: 'none',
          target_kind: 'gateway', target_peer_id: S.a, target_lan_host: '192.168.60.10', target_lan_port: 53, target_port: 53,
        });
        step('routetargets: API refuses a new UDP entry on a gateway (400 UDP_VIA_GATEWAY, field l4_protocol, text without the code)',
          udp.status === 400 && udp.body && udp.body.code === 'UDP_VIA_GATEWAY' && !!(udp.body.fields || {}).l4_protocol
          && !/^udp_via_gateway/.test(udp.body.error || ''), udp.status + ' ' + JSON.stringify(udp.body).slice(0, 200));
        const toUdp = await api('PUT', '/api/v1/routes/' + id1, { l4_protocol: 'udp' });
        step('routetargets: API refuses switching a gateway TCP entry to UDP', toUdp.status === 400 && toUdp.body.code === 'UDP_VIA_GATEWAY',
          toUdp.status + ' ' + JSON.stringify(toUdp.body).slice(0, 160));

        // ── the page: older UDP entry marked "has no effect" ──
        await p.goto(B + '/routes');
        await until(p, () => !!document.querySelector('#zn-zones .rt-zone'), null, 10000);
        step('routetargets: the older UDP entry behind a gateway carries the note "has no effect"',
          await until(p, (id) => !!document.querySelector('.rt-line[data-entry-id="' + id + '"] .rt-note-amber'), id2));
        const noteOnTcp = await p.locator(`.rt-line[data-entry-id="${id1}"] .rt-note-amber`).count();
        step('routetargets: a TCP entry has no such note', noteOnTcp === 0);

        // ── editor: gateway / pool select ──
        const openEditor = async (id) => {
          await p.evaluate((rid) => window.GCEntryEditor.open(rid), id);
          return until(p, () => { const m = document.getElementById('modal-edit-route'); return m && m.style.display === 'flex'; });
        };
        const saveEditor = async () => {
          const [res] = await Promise.all([
            p.waitForResponse((r) => /\/api\/v1\/routes\/\d+$/.test(new URL(r.url()).pathname) && r.request().method() === 'PUT'),
            p.click('#btn-edit-route-submit'),
          ]);
          return res;
        };
        const edClosed = () => until(p, () => document.getElementById('modal-edit-route').style.display !== 'flex');
        step('routetargets: the editor opens', await openEditor(id1));
        step('routetargets: the select "Gateway" has a group "Gateways" and a group "Gateway pools"',
          await until(p, ([a, pool]) => {
            const sel = document.getElementById('edit-route-gateway-peer');
            const groups = sel.querySelectorAll('optgroup');
            return sel.offsetParent !== null && groups.length === 2
              && !!groups[0].querySelector('option[value="' + a + '"]')
              && !!groups[1].querySelector('option[value="pool:' + pool + '"]')
              && groups[0].label !== '' && groups[1].label !== '' && sel.value === String(a);
          }, [S.a, S.pool]));
        step('routetargets: UDP cannot be chosen for a gateway target',
          await p.locator('#ee-kind-group [data-value="udp"]').isDisabled());
        await p.selectOption('#edit-route-gateway-peer', 'pool:' + S.pool);
        await shot(p, 'routetargets-pool');
        let res = await saveEditor();
        let row = routeRow(app, id1);
        step('routetargets: gateway → pool: only the pool is stored', res.status() === 200 && row.target_pool_id === S.pool && row.target_peer_id === null,
          res.status() + ' ' + JSON.stringify(row));
        await edClosed();
        await openEditor(id1);
        step('routetargets: the entry opens again with the pool selected',
          await until(p, (v) => document.getElementById('edit-route-gateway-peer').value === v, 'pool:' + S.pool));
        await p.selectOption('#edit-route-gateway-peer', String(S.a));
        res = await saveEditor();
        row = routeRow(app, id1);
        step('routetargets: pool → gateway: only the gateway is stored', res.status() === 200 && row.target_peer_id === S.a && row.target_pool_id === null,
          res.status() + ' ' + JSON.stringify(row));
        await edClosed();

        // ── editor: older UDP entry → the hint says it has no effect ──
        await openEditor(id2);
        step('routetargets: the editor of the older UDP entry says it has no effect',
          await until(p, () => { const h = document.getElementById('ee-kind-hint'); return !!h && h.textContent.trim() !== '' && h.classList.contains('rt-hint-warn'); }));
        await p.keyboard.press('Escape');
        await edClosed();

        // ── editor: deleted gateway → hint, 400 at the select, new gateway saves ──
        await openEditor(id3);
        step('routetargets: an entry without gateway shows the hint at the empty select',
          await until(p, () => document.getElementById('ee-gateway-missing').style.display !== 'none'
            && document.getElementById('edit-route-gateway-peer').value === ''));
        expected.push((r) => r.status() === 400 && r.request().method() === 'PUT' && r.url().endsWith('/api/v1/routes/' + id3));
        res = await saveEditor();
        const body = await res.json().catch(() => ({}));
        step('routetargets: saving without a target → 400 TARGET_REQUIRED, shown at the select',
          res.status() === 400 && body.code === 'TARGET_REQUIRED'
          && await until(p, () => {
            const sel = document.getElementById('edit-route-gateway-peer');
            const err = document.getElementById('edit-route-error');
            return sel.classList.contains('field-invalid') && !!sel.parentNode.querySelector('.field-error') && err.style.display !== 'none';
          }), res.status() + ' ' + JSON.stringify(body).slice(0, 160));
        await shot(p, 'routetargets-gateway-missing');
        await p.selectOption('#edit-route-gateway-peer', String(S.b));
        step('routetargets: choosing a gateway hides the hint', await until(p, () => document.getElementById('ee-gateway-missing').style.display === 'none'));
        res = await saveEditor();
        row = routeRow(app, id3);
        step('routetargets: with a new gateway the entry saves', res.status() === 200 && row.target_peer_id === S.b, res.status() + ' ' + JSON.stringify(row));
        await edClosed();

        // ── a host in the gateway zone: "Weiterleitung hinzufügen" ──
        const host = await api('POST', '/api/v1/domains/' + S.zone + '/hosts', { subdomain: 'svc', lan_host: '192.168.60.20', entries: [{ type: 'tcp', target_port: 22, listen_port: 4910 }] });
        step('routetargets: a host in the gateway zone is created', host.status === 201, host.status + ' ' + JSON.stringify(host.body).slice(0, 200));
        const hostId = host.body && host.body.host && host.body.host.id;
        const udpEntry = await api('POST', '/api/v1/hosts/' + hostId + '/entries', { type: 'udp', target_port: 53, listen_port: 4911 });
        step('routetargets: API refuses a UDP entry for a host behind a gateway (400 UDP_VIA_GATEWAY)',
          udpEntry.status === 400 && udpEntry.body.code === 'UDP_VIA_GATEWAY' && !/^udp_via_gateway/.test(udpEntry.body.error || ''),
          udpEntry.status + ' ' + JSON.stringify(udpEntry.body).slice(0, 160));
        await p.evaluate(() => window.GCZonesPage.reload());
        const hostRow = `.rt-host[data-host-id="${hostId}"]`;
        await until(p, (sel) => !!document.querySelector(sel), hostRow);
        await p.locator(`${hostRow} .rt-edit-host`).click();
        await until(p, () => !!document.querySelector('[data-rt-dialog="host-edit"] .rt-dlg'));
        const he = p.locator('[data-rt-dialog="host-edit"]');
        await he.locator('.rt-add-entry').click();
        step('routetargets: "Weiterleitung hinzufügen": UDP is locked behind a gateway',
          await until(p, () => { const o = document.querySelector('[data-rt-key="add-type"] option[value="udp"]'); return !!o && o.disabled; }));
        // the answer gets lost after the server created the entry
        const entriesUrl = new RegExp('/api/v1/hosts/' + hostId + '/entries$');
        await p.route(entriesUrl, async (r) => {
          if (r.request().method() !== 'POST') return r.continue();
          await r.fetch();
          return r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'e2e: answer lost' }) });
        });
        expected.push((r) => r.status() === 502 && entriesUrl.test(new URL(r.url()).pathname));
        await p.selectOption('[data-rt-key="add-type"]', 'tcp');
        await p.fill('[data-rt-key="add-outer"]', '4912');
        await p.fill('[data-rt-key="add-port"]', '2222');
        await he.locator('.rt-addform .btn-primary').click();
        const added = await until(p, (sel) => !document.querySelector('[data-rt-dialog="host-edit"] .rt-addform')
          && document.querySelectorAll(sel + ' .rt-line').length === 2 && !!document.querySelector('.toast-warning'), hostRow);
        const entriesNow = withDb(app, (db) => db.prepare("SELECT COUNT(*) AS n FROM routes WHERE bundle_id = ? AND l4_listen_port = '4912'").get(hostId).n);
        step('routetargets: lost answer after the entry was created: the list is reloaded, the form closes, a note instead of an error',
          added && entriesNow === 1, `form closed + 2 lines + note ${added}, rows on 4912: ${entriesNow}`);
        await p.unroute(entriesUrl);
        await p.keyboard.press('Escape');
        await until(p, () => !document.querySelector('[data-rt-dialog="host-edit"]'));

        // ── "Neuer Host": UDP locked; a lost answer after the host was created ──
        await p.evaluate((z) => window.GCZonesPage.openNewHost(z), S.zone);
        await until(p, () => !!document.querySelector('[data-rt-dialog="new-host"] .rt-dlg'));
        const nh = p.locator('[data-rt-dialog="new-host"]');
        step('routetargets: "Neuer Host": UDP is locked behind a gateway',
          await until(p, () => { const b = document.querySelector('[data-rt-dialog="new-host"] .rt-nh-entry .rt-seg-btn[data-value="udp"]'); return !!b && b.disabled; }));
        const hostsUrl = new RegExp('/api/v1/domains/' + S.zone + '/hosts$');
        await p.route(hostsUrl, async (r) => {
          if (r.request().method() !== 'POST') return r.continue();
          await r.fetch();
          return r.abort('connectionreset');
        });
        await nh.locator('[data-rt-key="nh-sub"]').fill('lost');
        await nh.locator('[data-rt-key="nh-lan"]').fill('192.168.60.30');
        await nh.locator('[data-rt-key="nh-port-0"]').fill('8080');
        await nh.locator('.rt-nh-create').click();
        const created = await until(p, () => !document.querySelector('[data-rt-dialog="new-host"]') && !!document.querySelector('.toast-warning'), null, 10000);
        const lostHosts = withDb(app, (db) => db.prepare("SELECT COUNT(*) AS n FROM service_bundles WHERE domain_id = ? AND subdomain = 'lost'").get(S.zone).n);
        const lostRow = await until(p, () => [...document.querySelectorAll('.rt-host .rt-host-label')].some((n) => n.textContent.trim() === 'lost'));
        step('routetargets: lost answer after the host was created: dialog closes, the host is listed once, a note instead of an error',
          created && lostRow && lostHosts === 1, `closed + note ${created}, row ${lostRow}, hosts ${lostHosts}`);
        await p.unroute(hostsUrl);

        // ── row menu: a small scroll moves it along, out of sight it closes ──
        await p.setViewportSize({ width: 1440, height: 520 });
        await p.evaluate((sel) => { const n = document.querySelector(sel); n.scrollIntoView({ block: 'center' }); }, hostRow);
        await p.locator(`${hostRow} .rt-more`).click();
        const menuOpen = await until(p, () => !!document.querySelector('.zn-menu'));
        const top0 = await p.evaluate(() => document.querySelector('.zn-menu').getBoundingClientRect().top);
        await p.evaluate(() => {
          let n = document.querySelector('.rt-host');
          for (; n; n = n.parentElement) {
            const oy = getComputedStyle(n).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) break;
          }
          window.__gcScroller = n || document.scrollingElement;
          window.__gcScroller.scrollBy(0, 24);
        });
        await p.waitForTimeout(200);
        const after = await p.evaluate(() => { const m = document.querySelector('.zn-menu'); return m ? m.getBoundingClientRect().top : null; });
        step('routetargets: row menu stays open on a small scroll and moves along with its button',
          menuOpen && after !== null && Math.abs((top0 - after) - 24) <= 3, `open ${menuOpen}, top ${top0} → ${after}`);
        // Out of sight: down past the button when the page is long enough
        // there, else up to the top (the button is further down then).
        const outInfo = await p.evaluate((sel) => {
          const sc = window.__gcScroller;
          const btn = document.querySelector(sel + ' .rt-more').getBoundingClientRect();
          const room = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
          if (room > btn.bottom + 20) sc.scrollBy(0, btn.bottom + 20);
          else sc.scrollTo(0, 0);
          return { room, bottom: btn.bottom, top: sc.scrollTop };
        }, hostRow);
        step('routetargets: row menu closes once its button is scrolled out of sight',
          await until(p, () => !document.querySelector('.zn-menu'), null, 3000), JSON.stringify(outInfo));
        await p.setViewportSize({ width: 1440, height: 1000 });

        // ── delete answered 202 { pending }; then the routes event "failed" ──
        await p.evaluate(() => window.__gcScroller.scrollTo(0, 0));
        const delUrl = new RegExp('/api/v1/routes/' + id1 + '$');
        await p.route(delUrl, (r) => {
          if (r.request().method() !== 'DELETE') return r.continue();
          return r.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, pending: true }) });
        });
        const legacyHost = await p.evaluate((rid) => {
          const line = document.querySelector('.rt-line[data-entry-id="' + rid + '"]');
          const h = line && line.closest('.rt-host');
          return h ? h.dataset.hostId : null;
        }, id1);
        let pendingToast = false;
        let failToast = false;
        if (legacyHost && legacyHost !== 'null') {
          await p.locator(`.rt-host[data-host-id="${legacyHost}"] .rt-edit-host`).click();
          await until(p, () => !!document.querySelector('[data-rt-dialog="host-edit"] .rt-dlg'));
          await p.locator(`[data-rt-dialog="host-edit"] .rt-erow[data-entry-id="${id1}"] .rt-ibtn-danger`).click();
          await until(p, () => !!document.querySelector('.zn-dialog .btn-danger'));
          await p.click('.zn-dialog .btn-danger');
          pendingToast = await until(p, () => [...document.querySelectorAll('.toast-success')].some((n) => n.textContent === (window.GC.t['entry.delete_pending'] || '?')));
          await p.evaluate((rid) => document.dispatchEvent(new CustomEvent('gc:routes', { detail: { route_id: rid, sync: 'failed' } })), id1);
          failToast = await until(p, () => !!document.querySelector('.toast-error'));
        }
        step('routetargets: delete answered 202: "still being applied"; a failed sync on the routes event says the entry is back',
          pendingToast && failToast, `host ${legacyHost}, pending note ${pendingToast}, error ${failToast}`);
        await p.unroute(delUrl);
        await shot(p, 'routetargets-end');
      } finally {
        await context.close().catch(() => {});
        await app.stop();
      }
    },
  };
};
