'use strict';

// Peers / Clients (docs/feature-peers-page.md) and the regrouped navigation:
// no gateways on the page (API ?type=client, deep link to a gateway goes to
// /gateways), the licence line, cards ↔ list (kept after a reload), search
// with the empty state, status/device filters in the address, "Weitere
// Filter", the bulk bar (tag, group, disable, enable, delete), the active
// switch of a card, the add dialog without the old gateway hint; the moved
// gateway functions in the detail "Mehr" menu (rename, proxy port, new
// connection data → assistant, disable → "Deaktivierte Gateways" → enable,
// remove with the IP check); sidebar groups incl. "Wartung", the bottom
// navigation; 390 px with the filter sheet; light/dark.
//
// The app runs with the community licence (3 VPN peers): the scenario puts
// its own two devices and one gateway into the database, switches every
// other peer off for its run (enabling stays within the licence) and puts
// the previous state back at the end, like the gateway scenarios do.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function openDb() {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.pragma('busy_timeout = 5000');
  return db;
}
function setup() {
  const db = openDb();
  if (!db) return null;
  try {
    const before = db.prepare('SELECT id, enabled FROM peers').all();
    db.prepare('UPDATE peers SET enabled = 0').run();
    const key = () => crypto.randomBytes(32).toString('base64');
    const client = (name, ip, platform) => db.prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, client_platform, client_version, client_product, tags)
      VALUES (?, ?, ?, 1, 'regular', ?, ?, ?, '')`).run(name, key(), ip + '/32', platform, platform ? '1.16.0' : null, platform === 'android' ? 'android' : null).lastInsertRowid;
    const a = client('E2E-Bulk-1', '10.8.0.201', 'android');
    const b = client('E2E-Bulk-2', '10.8.0.202', null);
    const gw = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('E2E-GW-Verwalten', ?, '10.8.0.203/32', 1, 'gateway')").run(key()).lastInsertRowid;
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive)
      VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, 1)`).run(gw, crypto.randomBytes(16).toString('hex'));
    return { before, a, b, gw };
  } finally { db.close(); }
}
function restore(s) {
  const db = openDb();
  if (!db || !s) return;
  try {
    for (const id of [s.a, s.b, s.gw]) {
      db.prepare('DELETE FROM gateway_meta WHERE peer_id = ?').run(id);
      db.prepare('DELETE FROM peers WHERE id = ?').run(id);
    }
    db.prepare("DELETE FROM peer_groups WHERE name = 'E2E-Gruppe'").run();
    const st = db.prepare('UPDATE peers SET enabled = ? WHERE id = ?');
    for (const r of s.before) st.run(r.enabled, r.id);
  } finally { db.close(); }
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const peer = async (page, id) => { const r = await api(page, 'GET', '/api/v1/peers/' + id); return r.body && r.body.peer; };
  const gcdOk = (page) => page.click('.gcd-dialog .gcd-ok');
  const openMore = async (page) => {
    await page.click('#gw-more-btn');
    return visible(page, '#gw-more-menu [data-act="gm-rename"]');
  };

  return {
    async peers(page) {
      const GW = FIXTURES.gateways;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => { try { localStorage.removeItem('gc-peers-view'); } catch (_) { /* ignore */ } });
      const S = setup();
      step('scenario data: two devices and a gateway in the database', !!S);
      if (!S) return;
      try {
        // ── API ──
        const cl = await api(page, 'GET', '/api/v1/peers?type=client');
        const ids = ((cl.body && cl.body.peers) || []).map((p) => p.id);
        step('API ?type=client: devices only, the counts name the gateways',
          cl.status === 200 && ids.includes(S.a) && !ids.includes(GW.home) && !ids.includes(S.gw)
          && cl.body.counts && cl.body.counts.gateways >= 3 && cl.body.counts.total === cl.body.counts.clients + cl.body.counts.gateways,
          JSON.stringify(cl.body && cl.body.counts));
        const all = await api(page, 'GET', '/api/v1/peers');
        step('API without type: every peer, as before', ((all.body && all.body.peers) || []).some((p) => p.id === GW.home));

        // ── Page: cards by default, no gateways ──
        await page.goto(BASE + '/peers');
        step('cards by default', await visible(page, `#pl-grid .pl-card[data-peer-id="${S.a}"]`)
          && await page.getAttribute('#pl-view [data-view="cards"]', 'aria-pressed') === 'true');
        step('no gateway on the page', await page.locator(`[data-peer-id="${GW.home}"], [data-peer-id="${S.gw}"], #gateways-container`).count() === 0);
        step('licence line names the gateways and links to them',
          await until(page, () => { const l = document.getElementById('pl-licence'); return l && !l.hidden && !!l.querySelector('a[href="/gateways"]'); }));
        step('sidebar badge counts active devices only',
          (await page.locator('#peer-count-badge').textContent()).trim() === String(cl.body.peers.filter((p) => p.enabled).length));
        await shot(page, 'peers-cards-light');

        // ── List view, kept after a reload ──
        await page.click('#pl-view [data-view="list"]');
        step('list view: one row per device', await visible(page, `#pl-table tr[data-peer-id="${S.a}"]`));
        await page.reload();
        step('the view is remembered per browser', await visible(page, `#pl-table tr[data-peer-id="${S.b}"]`));

        // ── Search + empty state ──
        await page.fill('#peer-search', 'E2E-Bulk');
        step('search finds the two devices', await until(page, () => document.querySelectorAll('#pl-results [data-peer-id]').length === 2));
        step('the search is in the address', await until(page, () => /q=E2E-Bulk/.test(location.hash)));
        await page.fill('#peer-search', 'zzz-kein-geraet');
        step('no match → empty state with "Suche leeren"', await visible(page, '#pl-noresult #pl-clear-search'));
        await page.click('#pl-clear-search');
        step('"Suche leeren" brings the list back', await until(page, () => !document.getElementById('pl-noresult') && document.querySelectorAll('#pl-results [data-peer-id]').length >= 2));

        // ── Filters ──
        await page.click('#pl-status [data-status="disabled"]');
        step('status "Deaktiviert": only disabled devices, chip + address',
          await until(page, () => [...document.querySelectorAll('#pl-results [data-state]')].every((n) => n.dataset.state === 'disabled')
            && /status=disabled/.test(location.hash) && !document.getElementById('pl-active').hidden));
        await page.click('#pl-reset');
        await page.selectOption('#pl-device', 'android');
        step('device "Android": only Android devices',
          await until(page, () => { const r = [...document.querySelectorAll('#pl-results tr[data-peer-id]')]; return r.length > 0 && r.every((x) => x.querySelector('.pl-av-android')); }));
        await page.goto(BASE + '/peers#device=none');
        step('a filter in the address is applied on load', await until(page, (b) => {
          const r = [...document.querySelectorAll('#pl-results [data-peer-id]')].map((x) => Number(x.dataset.peerId));
          return r.includes(b) && document.getElementById('pl-device').value === 'none';
        }, S.b));
        await page.click('#pl-reset');
        await page.click('#pl-more-btn');
        step('"Weitere Filter": owner, tags and "needs attention"', await visible(page, '#pl-more .pl-fsec:not(.pl-narrow) .pl-fbtn') && await page.locator('#pl-more .pl-fsec:not(.pl-narrow)').count() === 3);
        await page.keyboard.press('Escape');
        step('Escape closes it', await until(page, () => document.getElementById('pl-more').hidden));

        // ── Bulk bar ──
        const grp = await api(page, 'POST', '/api/v1/peer-groups', { name: 'E2E-Gruppe', color: '#22c55e' });
        const groupId = grp.body && grp.body.group && grp.body.group.id;
        await page.reload();
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.a}"]`);
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.b}"]`);
        step('selection shows the bulk bar with the count', await visible(page, '#pl-bulkbar') && /2/.test(await page.textContent('#pl-bulk-count')));
        await shot(page, 'peers-bulk-light', false);
        await page.click('#pl-bulkbar [data-bulk="tag"]');
        await page.fill('.gcd-dialog .gcd-input', 'e2e-tag');
        await gcdOk(page);
        step('bulk "Tag": both devices get the tag', await until(page, () => !document.querySelector('#pl-bulkbar:not([hidden])'))
          && /e2e-tag/.test((await peer(page, S.a)).tags) && /e2e-tag/.test((await peer(page, S.b)).tags));
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.a}"]`);
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.b}"]`);
        await page.click('#pl-bulkbar [data-bulk="group"]');
        await page.selectOption('#pl-bulk-select', String(groupId));
        await page.click('#pl-bulk-apply');
        step('bulk "Gruppe": both devices in the group', !!groupId && await until(page, () => !document.querySelector('#pl-bulkbar:not([hidden])'))
          && (await peer(page, S.a)).group_id === groupId && (await peer(page, S.b)).group_id === groupId);
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.a}"]`);
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.b}"]`);
        await page.click('#pl-bulkbar [data-bulk="disable"]');
        step('bulk "Deaktivieren"', await until(page, () => !document.querySelector('#pl-bulkbar:not([hidden])'))
          && !(await peer(page, S.a)).enabled && !(await peer(page, S.b)).enabled);

        // ── Active switch on the card ──
        await page.click('#pl-view [data-view="cards"]');
        await page.click(`.pl-card[data-peer-id="${S.a}"] [data-action="toggle"]`);
        step('the card switch enables the device', await until(page, (id) => {
          const s = document.querySelector(`.pl-card[data-peer-id="${id}"] [data-action="toggle"]`); return s && s.getAttribute('aria-checked') === 'true';
        }, S.a) && !!(await peer(page, S.a)).enabled);

        // ── Add dialog: no gateway hint ──
        await page.click('#btn-add-peer');
        step('"Peer hinzufügen" without the old gateway hint', await visible(page, '#modal-add-peer #add-peer-name') && await page.locator('#add-peer-gateway-moved, #add-peer-is-gateway').count() === 0);
        await page.keyboard.press('Escape');

        // ── Deep link to a gateway goes to its page ──
        await page.goto(BASE + '/peers#edit/' + GW.home);
        step('/peers#edit/<gateway> opens the gateway page', await until(page, (id) => location.pathname === '/gateways' && location.hash === '#gw/' + id, GW.home));

        // ── Gateway detail: the moved functions ──
        await page.goto(BASE + '/gateways#gw/' + S.gw);
        step('gateway detail "Mehr": rename, renew access, proxy port, disable, remove',
          await visible(page, '#gw-more-btn') && await openMore(page)
          && await page.locator('#gw-more-menu [data-act="gm-renew"], #gw-more-menu [data-act="gm-proxy"], #gw-more-menu [data-act="gm-disable"], #gw-more-menu [data-act="gm-delete"]').count() === 4);
        await shot(page, 'peers-gw-menu-light', false);
        await page.click('#gw-more-menu [data-act="gm-rename"]');
        await page.fill('#gwm-name', 'E2E-GW-Neu');
        await page.click('#gwm-save');
        step('rename → saved in the API', await until(page, () => !document.getElementById('gwm-name')) && (await peer(page, S.gw)).name === 'E2E-GW-Neu');
        await openMore(page);
        await page.click('#gw-more-menu [data-act="gm-proxy"]');
        await page.fill('.gcd-dialog .gcd-input', '70000');
        await gcdOk(page);
        step('proxy port: an invalid port is refused in the dialog', await visible(page, '.gcd-dialog .gcd-error'));
        await page.fill('.gcd-dialog .gcd-input', '18080');
        await gcdOk(page);
        const info = async () => { const r = await api(page, 'GET', '/api/v1/peers/' + S.gw + '/gateway-info'); return r.body && r.body.gateway && r.body.gateway.proxy_port; };
        step('proxy port → saved', await until(page, () => !document.querySelector('.gcd-dialog')) && await info() === 18080);
        await openMore(page);
        // this gateway never reported the capability setup-page: "Zugang erneuern" says so and goes the file way
        // (the assistant at step 3 with gateway.env) — the code way is in the scenario gatewaywizard
        await page.click('#gw-more-menu [data-act="gm-renew"]');
        await gcdOk(page);
        step('"Zugang erneuern" of an older gateway opens the assistant for this gateway (file way)', await until(page, (id) => location.hash === '#setup/' + id, S.gw) && await visible(page, '#gwz-overlay'));
        await page.keyboard.press('Escape');
        await page.goto(BASE + '/gateways#gw/' + S.gw);
        await openMore(page);
        await page.click('#gw-more-menu [data-act="gm-disable"]');
        await gcdOk(page);
        step('disable → listed under "Deaktivierte Gateways"', await visible(page, `#gw-disabled .gwm-off[data-id="${S.gw}"]`, 8000) && !(await peer(page, S.gw)).enabled);
        await shot(page, 'peers-gw-disabled-light');
        await page.click(`#gw-disabled [data-gm="gm-enable"][data-id="${S.gw}"]`);
        step('"Aktivieren" switches it on again', await until(page, (id) => !document.querySelector(`#gw-disabled .gwm-off[data-id="${id}"]`), S.gw) && !!(await peer(page, S.gw)).enabled);
        await page.goto(BASE + '/gateways#gw/' + S.gw);
        await openMore(page);
        await page.click('#gw-more-menu [data-act="gm-delete"]');
        await page.fill('#gwm-delete-ip', '10.8.0.9');
        step('remove: the button waits for the right IP', await page.isDisabled('#gwm-delete-ok'));
        await page.fill('#gwm-delete-ip', '10.8.0.203');
        await page.click('#gwm-delete-ok');
        const gone = await until(page, () => !document.getElementById('gwm-delete-ok'));
        const after = await api(page, 'GET', '/api/v1/peers/' + S.gw);
        step('remove → the gateway is gone', gone && after.status === 404);
        ctx.allow((p) => p.kind === 'http' && p.status === 404 && p.url === '/api/v1/peers/' + S.gw);

        // ── Bulk delete ──
        await page.goto(BASE + '/peers');
        await page.click('#pl-view [data-view="list"]');
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.a}"]`);
        await page.check(`#pl-table .pl-cb[data-batch-id="${S.b}"]`);
        await page.click('#pl-bulkbar [data-bulk="delete"]');
        await gcdOk(page);
        step('bulk "Löschen" asks, then removes both', await until(page, (ids) => ids.every((id) => !document.querySelector(`[data-peer-id="${id}"]`)), [S.a, S.b])
          && (await api(page, 'GET', '/api/v1/peers/' + S.a)).status === 404);
        ctx.allow((p) => p.kind === 'http' && p.status === 404 && p.url === '/api/v1/peers/' + S.a);

        // ── Navigation ──
        const groups = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('#sidebar > .nav-section-label, #sidebar > a.nav-item').forEach((n) => {
            if (n.classList.contains('nav-section-label')) out.push({ hrefs: [] });
            else if (out.length) out[out.length - 1].hrefs.push(n.getAttribute('href'));
          });
          return out.map((g) => g.hrefs.join(' '));
        });
        step('sidebar: Geräte (Peers, Gateways) · Dienste · … · Wartung (Logs, Support-Pakete) · System',
          groups.some((g) => /^\/peers \/gateways/.test(g)) && groups.some((g) => /^\/routes \/rdp/.test(g))
          && groups.some((g) => g === '/logs /support-bundles') && groups.some((g) => g === '/notifications /settings'), groups.join(' | '));
        await theme(page, 'dark');
        await page.click('#pl-view [data-view="cards"]');
        await shot(page, 'peers-cards-dark');
        await theme(page, 'light');

        // ── 390 px ──
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(BASE + '/peers');
        await visible(page, '#pl-results [data-peer-id]');
        const ov = await overflow(page);
        step('390 px: no horizontal scrolling', ov <= 0, `overflow ${ov}px`);
        const bn = await page.evaluate(() => [...document.querySelectorAll('.bottom-nav a.bn-item')].map((a) => a.getAttribute('href')).join(' '));
        step('bottom navigation: Dashboard · Geräte · Dienste · Sicherheit', bn === '/dashboard /peers /routes /security', bn);
        await page.click('#pl-more-btn');
        step('390 px: "Filter" opens the sheet with status, group, device and sort',
          await until(page, () => { const m = document.getElementById('pl-more'); return m.parentNode === document.body && !m.hidden && m.querySelectorAll('.pl-narrow').length === 4; }));
        await shot(page, 'peers-390-sheet-light', false);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1440, height: 1000 });
      } finally {
        restore(S);
        await page.evaluate(() => { try { localStorage.removeItem('gc-peers-view'); } catch (_) { /* ignore */ } }).catch(() => {});
      }
    },
  };
};
