'use strict';

// RDP route through a gateway POOL (services/rdp.js, access_mode=gateway):
// the "Home-Gateway" select of the RDP wizard offers the gateways and — as a
// group of its own, like the target select of the domain settings — the
// gateway pools. A route is created on a pool straight away, opens again with
// the pool selected, and moves to a single gateway and back; the server keeps
// exactly one of the two (RDP row and linked TCP route).
//
// Needs the licence features remote_desktop, rdp_via_gateway and
// gateway_pools, so the scenario starts an app of its own
// (tests/e2e/app-licensed.js: own process, data directory and port) and ends
// it again — like scenarios/31-vpn-names.js.

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-rdp-pool-'));
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
      E2E_FEATURES: 'remote_desktop,rdp_via_gateway,gateway_pools,gateway_pool_failover,gateway_tcp_routing,gateway_peers=-1,l4_routes=-1,http_routes=-1',
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

  // two gateways, a failover pool with the second one
  function seed(app) {
    const Database = require('better-sqlite3');
    const db = new Database(app.dbFile);
    db.pragma('busy_timeout = 5000');
    try {
      const gw = (name, ip) => {
        const id = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
          .run(name, crypto.randomBytes(32).toString('base64'), ip + '/32').lastInsertRowid);
        db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive, last_seen_at)
          VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, 1, strftime('%s','now')*1000)`).run(id, crypto.randomBytes(16).toString('hex'));
        return id;
      };
      const a = gw('e2e-rdp-gw-a', '10.8.0.40');
      const b = gw('e2e-rdp-gw-b', '10.8.0.41');
      const pool = Number(db.prepare("INSERT INTO gateway_pools (name, mode, failback_cooldown_s) VALUES ('e2e-rdp-pool', 'failover', 60)").run().lastInsertRowid);
      db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, ?, 10)').run(pool, b);
      return { a, b, pool };
    } finally { db.close(); }
  }

  function readRows(app, rdpId) {
    const Database = require('better-sqlite3');
    const db = new Database(app.dbFile, { readonly: true });
    try {
      const rdp = db.prepare('SELECT gateway_peer_id, gateway_pool_id, gateway_l4_route_id FROM rdp_routes WHERE id = ?').get(rdpId) || {};
      const l4 = rdp.gateway_l4_route_id
        ? db.prepare('SELECT target_peer_id, target_pool_id FROM routes WHERE id = ?').get(rdp.gateway_l4_route_id) || {}
        : {};
      return { rdp, l4 };
    } finally { db.close(); }
  }

  // Next until the save button shows, then save; resolves with the response of the save.
  async function saveWizard(p) {
    for (let i = 0; i < 10 && !(await p.locator('#rdp-modal-save').isVisible()); i++) {
      await p.click('#rdp-wizard-next');
      await p.waitForTimeout(100);
    }
    const [res] = await Promise.all([
      p.waitForResponse((r) => /\/api\/v1\/rdp(\/\d+)?$/.test(new URL(r.url()).pathname) && ['POST', 'PATCH'].includes(r.request().method())),
      p.click('#rdp-modal-save'),
    ]);
    return res;
  }

  return {
    async rdppool(page) {
      const app = await startLicensed();
      step('rdppool: licensed app of the scenario is up', app.up, app.up ? '' : app.log());
      if (!app.up) { await app.stop(); return; }
      const B = app.base;
      const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
      const p = await context.newPage();
      p.on('console', (m) => { if (m.type() === 'error') problems.push({ kind: 'console', text: 'rdppool: ' + m.text().slice(0, 300) }); });
      p.on('pageerror', (e) => problems.push({ kind: 'pageerror', text: 'rdppool: ' + String(e).slice(0, 300) }));
      p.on('response', (r) => {
        const u = r.url();
        if (u.startsWith(B) && r.status() >= 400 && !u.includes('/favicon')) problems.push({ kind: 'http', status: r.status(), url: 'rdppool:' + u.replace(B, '') });
      });
      try {
        await p.goto(B + '/login');
        await p.fill('input[name="username"]', ctx.FIXTURES.admin.username);
        await p.fill('input[name="password"]', ctx.FIXTURES.admin.password);
        await Promise.all([p.waitForNavigation(), p.click('button[type="submit"]')]);
        const S = seed(app);

        // ── New route: the select offers gateways and pools, as two groups ──
        await p.goto(B + '/rdp');
        await p.click('#btn-add-rdp');
        await p.fill('#rdp-name', 'e2e-rdp-pool');
        await p.fill('#rdp-host', '192.168.40.10');
        await p.selectOption('#rdp-access-mode', 'gateway');
        step('rdppool: the gateway select has a group "Gateways" and a group "Gateway pools"',
          await until(p, ([a, pool]) => {
            const sel = document.getElementById('rdp-homegw-peer');
            const groups = sel.querySelectorAll('optgroup');
            return sel.offsetParent !== null && groups.length === 2
              && !!groups[0].querySelector('option[value="' + a + '"]')
              && !!groups[1].querySelector('option[value="pool:' + pool + '"]')
              && groups[1].querySelector('option[value="pool:' + pool + '"]').textContent === 'e2e-rdp-pool'
              && groups[0].label !== '' && groups[1].label !== '';
          }, [S.a, S.pool]));
        await p.selectOption('#rdp-homegw-peer', 'pool:' + S.pool);
        await p.fill('#rdp-homegw-listen-port', '4810');
        await shot(p, 'rdppool-create');
        const created = await saveWizard(p);
        const body = await created.json().catch(() => ({}));
        step('rdppool: a route on a pool is created (201)', created.status() === 201, created.status() + ' ' + JSON.stringify(body).slice(0, 200));
        const id = body && body.route && body.route.id;
        let rows = id ? readRows(app, id) : { rdp: {}, l4: {} };
        step('rdppool: RDP row and linked TCP route are on the pool only',
          rows.rdp.gateway_pool_id === S.pool && rows.rdp.gateway_peer_id === null
          && rows.l4.target_pool_id === S.pool && rows.l4.target_peer_id === null, JSON.stringify(rows));
        if (!id) return;

        // ── Edit: opens with the pool selected; switch to a single gateway ──
        await until(p, (rid) => !!document.querySelector('[data-edit="' + rid + '"]'), id);
        await p.click('[data-edit="' + id + '"]');
        step('rdppool: the route opens again with the pool selected',
          await until(p, (v) => document.getElementById('rdp-homegw-peer').value === v, 'pool:' + S.pool));
        await p.selectOption('#rdp-homegw-peer', String(S.a));
        let res = await saveWizard(p);
        rows = readRows(app, id);
        step('rdppool: pool → gateway: only the gateway is left (RDP row and TCP route)',
          res.status() === 200 && rows.rdp.gateway_peer_id === S.a && rows.rdp.gateway_pool_id === null
          && rows.l4.target_peer_id === S.a && rows.l4.target_pool_id === null, res.status() + ' ' + JSON.stringify(rows));

        // ── and back to the pool ──
        await until(p, () => !document.querySelector('#rdp-modal-overlay.active, #rdp-modal-overlay.open'), null, 3000);
        await p.click('[data-edit="' + id + '"]');
        await until(p, (v) => document.getElementById('rdp-homegw-peer').value === v, String(S.a));
        await p.selectOption('#rdp-homegw-peer', 'pool:' + S.pool);
        res = await saveWizard(p);
        rows = readRows(app, id);
        step('rdppool: gateway → pool: only the pool is left (RDP row and TCP route)',
          res.status() === 200 && rows.rdp.gateway_pool_id === S.pool && rows.rdp.gateway_peer_id === null
          && rows.l4.target_pool_id === S.pool && rows.l4.target_peer_id === null, res.status() + ' ' + JSON.stringify(rows));
      } finally {
        await context.close().catch(() => {});
        await app.stop();
      }
    },
  };
};
