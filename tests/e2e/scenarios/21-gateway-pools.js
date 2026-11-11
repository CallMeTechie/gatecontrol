'use strict';

// Gateways page with pools (public/js/gateways.js, gateway-pools-ui.js,
// gateway-pool-kit.js): the fleet with pools as groups and "Einzelne Gateways"
// with the hint card, the gateway detail (head with "Mehr" as a real menu,
// "Übersicht" in its new order — Zustand · Pool · Funktionen, then the
// gateway's info —, the tab "Funktionen", "Erkannte Geräte" in "Netzwerk"),
// the pool page #pool/<id> (order by buttons and keyboard, "In den Pool
// nehmen", failback time, history, "Pool auflösen"), the dialog "Pool anlegen"
// (same LAN suggestion, preset from the first gateway's device, its routes)
// and the old page /gateway-pools → /gateways.
//
// The app runs without a licence in the CI (community: no pools), so this
// scenario mocks: the page's licence flag (data-pools="on" in the HTML), the
// fleet (the two seeded gateways in one LAN plus two fake ones in another) and
// the whole pool API (a small in-memory model that answers like
// src/routes/api/gatewayPools.js). The seeded gateways' own tabs use the real
// API. German like the mockups (restored at the end), light/dark, 390 px.

const fs = require('node:fs');
const path = require('node:path');

function withDb(fn) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, shot, api, allow } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => { try { localStorage.setItem('gc-theme-mode', m); } catch (_) { /* ignore */ } document.documentElement.setAttribute('data-theme', m); }, mode);
    await page.waitForTimeout(150);
  };
  const view = async (page, name, height) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: height || 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await shot(page, name, false);
    await page.setViewportSize(vp);
  };

  return {
    async gatewaypools(page) {
      const HOME = FIXTURES.gateways.home;
      const NAS = FIXTURES.gateways.nas;
      const FH = 9301; // "Ferienhaus" (fake, never opened)
      const PIFH = 9302; // "Pi Ferienhaus" (fake, same LAN as Ferienhaus)
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      const now = Date.now();
      const MIN = 60000;
      // without a licence only the newest peers stay enabled: both seeded gateways on for the run (restored at the end)
      const enabled0 = withDb((db) => {
        const r = db.prepare("SELECT id, enabled FROM peers WHERE id IN (?, ?) AND peer_type = 'gateway'").all(HOME, NAS);
        db.prepare("UPDATE peers SET enabled = 1 WHERE id IN (?, ?) AND peer_type = 'gateway'").run(HOME, NAS);
        return r;
      }) || [];

      // ── the old page ──
      await page.goto(BASE + '/gateway-pools');
      step('pools: /gateway-pools lands on /gateways', new URL(page.url()).pathname === '/gateways');
      step('pools: no menu entry "Gateway-Pools" any more', await page.evaluate(() => !document.querySelector('.sidebar a[href="/gateway-pools"]')));
      const lang0 = await page.evaluate(() => document.documentElement.lang || 'en');
      const langSet = await api(page, 'POST', '/api/v1/settings/language', { language: 'de' });
      step('pools: page in German for the run', langSet.status === 200);

      // ── mocks ──
      const tel = (lan, router, model, extra) => ({ lan_subnets: [{ cidr: lan, primary: true }], default_gateway_ip: router, lan_ip: lan.replace(/0\/24$/, '23'),
        hardware: { model }, gateway_version: '1.23.0', cpu_cores: 4, cpu_load_avg: [0.3, 0.2, 0.2], mem_total: 16e9, mem_used: 5e9, disk: { total: 2e12, used: 1e12 },
        state_dir_writable: true, lan_discovery: false, ...extra });
      // live state of the server (gatewayLiveState): online unless the section "live state" below switches it
      const live = { on: false, failbackAt: 0, expectedBy: 0 };
      const liveOf = (id) => {
        if (!live.on) return {};
        if (id === FH) return { state: 'updating', status: 'offline', reachable: false, offline_since: Date.now() - 40000, expected_back_by: live.expectedBy, update_state: 'updating' };
        if (id === PIFH) return { state: 'offline', status: 'offline', reachable: false, offline_since: now - 20 * MIN, last_seen_at: now - 20 * MIN };
        if (id === NAS) return { state: 'online', reachable: true, alive: false, failback_at: live.failbackAt, failback_takes_routes: false };
        return {};
      };
      const fake = (id, name, platform, t, routes) => ({ peer_id: id, name, hostname: null, ip: '10.8.0.' + (id - 9200), status: 'online', state: 'online', reachable: true, alive: true, last_seen_at: now - 12000,
        health: { telemetry: t, overall_healthy: true, http_proxy_healthy: true, api_healthy: true, dns_resolve_ok: true, config_hash: 'a91f3c00' }, routes,
        platform, never_connected: false, update_available: false, discovery: { enabled: 0 } });
      await page.route(/\/api\/v1\/gateways(\?.*)?$/, async (r) => {
        const res = await r.fetch();
        const j = await res.json();
        const seeded = (j.gateways || []).filter((g) => g.peer_id === HOME || g.peer_id === NAS).map((g) => ({
          ...g, status: 'online', state: 'online', reachable: true, alive: true, failback_at: null, expected_back_by: null, offline_since: null,
          never_connected: false, last_seen_at: now - 12000, platform: g.peer_id === HOME ? 'synology' : 'rpi',
          health: { ...(g.health || {}), overall_healthy: true, http_proxy_healthy: true, api_healthy: true, dns_resolve_ok: true, config_hash: 'a91f3c00',
            route_reachability: [{ route_id: 9501, reachable: true, latency_ms: 3 }],
            telemetry: { ...((g.health && g.health.telemetry) || {}), ...tel('192.168.1.0/24', '192.168.1.1', g.peer_id === HOME ? 'Synology DS918+' : 'Raspberry Pi 4 Model B') } },
        }));
        const fleet = seeded.concat([
          fake(FH, 'Ferienhaus', 'linux', tel('192.168.178.0/24', '192.168.178.1', 'Linux · Docker'), [{ id: 9401, domain: 'cloud.ferien.example' }, { id: 9402, domain: 'kamera.ferien.example' }]),
          fake(PIFH, 'Pi Ferienhaus', 'rpi', tel('192.168.178.0/24', '192.168.178.1', 'Raspberry Pi 4 Model B'), []),
        ]);
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...j, gateways: fleet.map((g) => ({ ...g, ...liveOf(g.peer_id) })) }) });
      });
      // the licence flag of the page (community in the CI)
      await page.route((u) => u.pathname === '/gateways', async (r) => {
        const res = await r.fetch();
        const html = (await res.text()).replace('data-pools="off"', 'data-pools="on"');
        r.fulfill({ response: res, body: html });
      });
      // the pool API: a small model
      const route = (id, domain, host, port) => ({ id, domain, route_type: 'http', target_lan_host: host, target_lan_port: port, l4_listen_port: null, enabled: 1 });
      let nextId = 2;
      const calls = [];
      const pools = [{
        id: 1, name: 'Heimnetz', mode: 'failover', lb_policy: null, failback_cooldown_s: 900, outage_message: null, enabled: true,
        members: [{ peer_id: HOME, priority: 1 }, { peer_id: NAS, priority: 2 }],
        routes: [route(9501, 'nas.example.com', '192.168.1.23', 5001), route(9502, 'phoscon.example.com', '192.168.1.40', 80)],
        rdp_routes: 0,
        pinned: [{ id: 9503, domain: 'drucker.example.com', peer_id: HOME, target_lan_host: '192.168.1.60', target_lan_port: 631, failed_over: false, enabled: 1, route_type: 'http' }],
        history: [
          { at: now - 6 * 24 * 60 * MIN + 22 * MIN, kind: 'failback', from_peer_id: NAS, to_peer_id: HOME, duration_ms: null },
          { at: now - 6 * 24 * 60 * MIN, kind: 'failover', from_peer_id: HOME, to_peer_id: NAS, duration_ms: 22 * MIN },
        ],
      }];
      // the reserve check of e2e-gw-nas: one target of the pool's routes not reachable (false: no data)
      let reserveData = true;
      let pinnedReach = true; // … and of the route pinned to e2e-gw-home: does the reserve reach its target
      const alive = { [HOME]: true, [NAS]: true, [FH]: true, [PIFH]: true };
      const names = { [HOME]: 'e2e-gw-home', [NAS]: 'e2e-gw-nas', [FH]: 'Ferienhaus', [PIFH]: 'Pi Ferienhaus' };
      const stateOf = (p) => {
        const ms = p.members.slice().sort((a, b) => a.priority - b.priority);
        const serving = ms.filter((m) => alive[m.peer_id]).slice(0, 1).map((m) => m.peer_id);
        // live state: NAS back online, its routing still in the failback wait (gatewayPoolState 'recovering')
        const back = (id) => live.on && id === NAS;
        const members = ms.map((m) => ({ peer_id: m.peer_id, priority: m.priority, name: names[m.peer_id], platform: null, last_seen_at: now - 12000, went_down_at: null,
          failback_at: back(m.peer_id) ? live.failbackAt : null, live_state: 'online', reachable: true, failback_takes_routes: back(m.peer_id) ? false : null,
          state: back(m.peer_id) ? 'recovering' : serving.includes(m.peer_id) ? 'active' : (alive[m.peer_id] ? 'standby' : 'offline'),
          reserve: reserveData && !serving.includes(m.peer_id) && m.peer_id === NAS ? { total: p.routes.length, checked: p.routes.length, reachable: p.routes.length - 1, missing: [{ id: p.routes[p.routes.length - 1].id, domain: p.routes[p.routes.length - 1].domain }] } : null }));
        // like an older server: "protected" even when the reserve misses a target — the page
        // must still show "teilweise geschützt" (gateway-pool-kit.js effectiveStatus)
        const up = members.filter((m) => m.state === 'active' || m.state === 'standby').length;
        const status = members.length < 2 ? 'single' : (members[0].state === 'active' ? (up > 1 ? 'protected' : 'no_reserve') : 'on_reserve');
        return { id: p.id, name: p.name, mode: p.mode, lb_policy: p.lb_policy, failback_cooldown_s: p.failback_cooldown_s, outage_message: p.outage_message, enabled: true,
          status, active_peer_ids: serving, members, routes: p.routes, rdp_routes: p.rdp_routes,
          // the reserve check of a pinned route (gatewayPoolState): the member that would take it over reaches its target
          pinned_routes: p.pinned.map((x) => ({ ...x, peer_name: names[x.peer_id], reserve: reserveData && x.peer_id === HOME && alive[NAS] && !back(NAS) ? { peer_id: NAS, name: names[NAS], reachable: pinnedReach } : null })),
          history: p.history.map((e) => ({ ...e, from_name: names[e.from_peer_id], to_name: names[e.to_peer_id] })), last_switch_at: p.history.length ? p.history[0].at : null,
          since: { at: now - 30 * 24 * 60 * MIN, peer_id: serving[0] || null, name: names[serving[0]] } };
      };
      await page.route(/\/api\/v1\/gateway-pools(\/.*)?(\?.*)?$/, async (r) => {
        const u = new URL(r.request().url());
        const m = r.request().method();
        const body = r.request().postData() ? JSON.parse(r.request().postData()) : null;
        const json = (status, b) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
        const rest = u.pathname.replace('/api/v1/gateway-pools', '');
        calls.push({ m, rest, body });
        if (rest === '/state' && m === 'GET') {
          const total = 3 + pools.reduce((a, p) => a + p.routes.length, 0);
          return json(200, { ok: true, threshold_s: 90, routes_total: total, routes_pooled: pools.reduce((a, p) => a + (p.members.length > 1 ? p.routes.length : 0), 0),
            licensed: { failover: true, load_balancing: false }, pools: pools.map(stateOf) });
        }
        if (rest === '/migration-candidates' && m === 'GET') {
          return json(200, { pools: pools.map((p) => ({ id: p.id, name: p.name, mode: p.mode })), routes: [
            { id: 9401, domain: 'cloud.ferien.example', target_peer_id: FH, peer_name: 'Ferienhaus', target_lan_host: '192.168.178.20', target_lan_port: 443, target_ip: '10.8.0.101', target_port: 443 },
            { id: 9402, domain: 'kamera.ferien.example', target_peer_id: FH, peer_name: 'Ferienhaus', target_lan_host: '192.168.178.30', target_lan_port: 80, target_ip: '10.8.0.101', target_port: 80 },
          ] });
        }
        if (rest === '' && m === 'POST') {
          const p = { id: nextId++, name: body.name, mode: body.mode, lb_policy: null, failback_cooldown_s: body.failback_cooldown_s, outage_message: null, members: [], routes: [], rdp_routes: 0, pinned: [], history: [] };
          pools.push(p);
          return json(201, { ...p, members: [] });
        }
        let mm = /^\/(\d+)(\/.*)?$/.exec(rest);
        const p = mm && pools.find((x) => String(x.id) === mm[1]);
        if (!p) return json(404, { ok: false, error: 'pool_not_found' });
        const sub = mm[2] || '';
        if (sub === '/members' && m === 'PUT') { p.members = (body.members || body).map((x) => ({ peer_id: x.peer_id, priority: x.priority })); return json(200, p.members); }
        if (sub === '' && m === 'PUT') { Object.assign(p, body); return json(200, { ok: true }); }
        if (sub === '/migrate-routes' && m === 'POST') {
          for (const id of body.route_ids) {
            const pin = p.pinned.find((x) => x.id === id);
            if (pin) { p.pinned = p.pinned.filter((x) => x.id !== id); p.routes.push(route(pin.id, pin.domain, pin.target_lan_host, pin.target_lan_port)); } else p.routes.push(route(id, id === 9401 ? 'cloud.ferien.example' : 'kamera.ferien.example', '192.168.178.20', 443));
          }
          return json(200, { ok: true, migrated: body.route_ids.length });
        }
        if (sub === '/dissolve' && m === 'POST') { pools.splice(pools.indexOf(p), 1); return json(200, { ok: true, pinned: p.routes.length, rdp: 0, zones: 0 }); }
        return json(404, { ok: false, error: 'not mocked: ' + m + ' ' + rest });
      });
      const last = (m, rest) => calls.filter((c) => c.m === m && c.rest === rest).pop();

      try {
        // ── fleet: the pool as a group, the single gateways with the hint ──
        await page.evaluate(() => { try { localStorage.removeItem('gc.gw.poolHintHidden'); } catch (_) { /* ignore */ } });
        await page.goto(BASE + '/gateways');
        await theme(page, 'light');
        step('fleet: the pool "Heimnetz" is a group with its two gateways in priority order', await until(page, ([h, n]) => {
          const g = document.querySelector('.gwp-group[data-pool="1"]');
          const ids = g ? [...g.querySelectorAll('.gw[data-id]')].map((x) => Number(x.dataset.id)) : [];
          return ids.join() === [h, n].join();
        }, [HOME, NAS]));
        step('fleet: role tags "arbeitet gerade" / reserve missing a target (amber), status "teilweise geschützt" — not "geschützt"', await page.evaluate(([h, n]) => {
          const g = document.querySelector('.gwp-group[data-pool="1"]');
          return g.querySelector(`.gw[data-id="${h}"] [data-role="active"]`) && g.querySelector(`.gw[data-id="${n}"] .tag-amber[data-role="standby"]`)
            && g.querySelector('.tag-amber[data-status="partial"]') && !g.querySelector('[data-status="protected"]') && g.querySelector('a[href="#pool/1"]');
        }, [HOME, NAS]));
        step('fleet: "Einzelne Gateways" with Ferienhaus and the hint for a pool with Pi Ferienhaus (same LAN)', await page.evaluate(([f, p]) => {
          const s = document.querySelector('.gwp-singles');
          const hint = s && s.querySelector(`.gwp-hint[data-hint="${f}"] [data-act="pool-create"]`);
          return s && s.querySelector(`.gw[data-id="${f}"]`) && s.querySelector(`.gw[data-id="${p}"]`) && hint && hint.dataset.ids === f + ',' + p;
        }, [FH, PIFH]));
        step('fleet: KPIs "Pools" and "Ausfallsicher"', await page.evaluate(() => {
          const k = [...document.querySelectorAll('#fleet-kpis .kpi')].map((x) => x.textContent);
          return k.length === 5 && k.some((t) => /^1Pools/.test(t)) && k.some((t) => /2 von 5Ausfallsicher/.test(t));
        }));
        step('fleet: header has "Pool anlegen" and "Gateway hinzufügen"', await page.evaluate(() => !!document.getElementById('btn-add-pool') && !!document.getElementById('btn-add-gateway')));
        await view(page, 'gwpool-fleet-light');
        await theme(page, 'dark');
        await view(page, 'gwpool-fleet-dark');
        await page.click('.gwp-hint [data-act="hint-hide"]');
        step('fleet: the hint can be hidden (per viewer)', await until(page, () => !document.querySelector('.gwp-hint')));
        await page.evaluate(() => { try { localStorage.removeItem('gc.gw.poolHintHidden'); } catch (_) { /* ignore */ } });

        // ── gateway detail: head, "Mehr", the overview's order ──
        await page.click(`.gwp-group[data-pool="1"] .gw[data-id="${HOME}"] .gw-card-link`);
        step('detail: the card opens the gateway', await until(page, (h) => location.hash === '#gw/' + h && document.querySelector('#gw-detail-view .gw-detail'), HOME));
        step('detail: head with pool chip (→ #pool/1), auto-update, "Neu prüfen" and "Mehr"', await until(page, () => {
          const head = document.querySelector('.gw-head');
          return head && head.querySelector('a.gw-pool-chip[href="#pool/1"]') && head.querySelector('[data-act="recheck"]')
            && head.querySelector('#gw-more-btn[aria-haspopup="menu"][aria-expanded="false"]') && document.getElementById('gw-more-menu').hidden;
        }));
        step('detail: Übersicht starts with Zustand · Pool · Funktionen, then Gerät & Software · Auslastung, then the routes', await until(page, () => {
          const p = document.getElementById('gwe-tabpanel');
          const top = [...p.querySelectorAll('.gwo-top > section')].map((s) => s.classList.contains('gwo-state') ? 'state' : s.classList.contains('gwp-ovcard') ? 'pool' : s.classList.contains('gwn-fsum') ? 'feat' : '?');
          const two = [...p.querySelectorAll('.gwo-two > section')].map((s) => s.classList.contains('gwo-dev') ? 'dev' : 'load');
          const order = [...p.children].map((c) => c.className);
          return top.join() === 'state,pool,feat' && two.join() === 'dev,load' && /gwo-top/.test(order[0]) && /gwo-two/.test(order[1]) && /gwo-routes/.test(order[2])
            && !p.querySelector('.gwn-features [role="switch"]') && !p.querySelector('.gw-net-extras');
        }));
        step('detail: Zustand shows checks; Pool lists both members and the outage sentence', await page.evaluate((n) => {
          const st = document.querySelector('.gwo-state');
          const pc = document.querySelector('.gwp-ovcard');
          return st.querySelector('.gwo-banner') && st.querySelectorAll('.gwo-checks li').length >= 2 && pc.querySelectorAll('.gwp-mrow').length === 2
            && pc.querySelector('.gwp-mrow-self') && /90 Sekunden/.test(pc.querySelector('[data-outage]').textContent) && /15 Minuten/.test(pc.querySelector('[data-outage]').textContent)
            && /1 von 2 Routen/.test(pc.querySelector('[data-outage]').textContent) && pc.querySelector('[data-state="standby_partial"]')
            && pc.querySelector(`a[href="#gw/${n}"]`);
        }, NAS));
        step('detail: technical rows in "Technische Details" (closed), route table with reachability', await page.evaluate(() => {
          const d = document.querySelector('.gwo-dev details.gwo-tech');
          return d && !d.open && /Node/.test(d.textContent) && document.querySelector('.gwo-routes table.gw-routes');
        }));
        await page.click('.gwo-dev details.gwo-tech summary');
        // "Mehr": keyboard and mouse
        await page.focus('#gw-more-btn');
        await page.keyboard.press('ArrowDown');
        step('menu: ArrowDown opens it and focuses the first item', await until(page, () => !document.getElementById('gw-more-menu').hidden
          && document.getElementById('gw-more-btn').getAttribute('aria-expanded') === 'true' && document.activeElement === document.querySelector('#gw-more-menu [role="menuitem"]')));
        // "Verwalten" (gateway-manage.js, docs/feature-peers-page.md): moved here from the Peers page, "Gateway entfernen" last
        // "Versionen" and "Handbuch" open in the page (#gw/<id>/versions, …/handbook — gateway-docs.js)
        step('menu: compose, auto-update, location, pool, versions, manual, then "Verwalten" with "Gateway entfernen" last', await page.evaluate(() => {
          const acts = [...document.querySelectorAll('#gw-more-menu [role="menuitem"]')].map((x) => x.dataset.act);
          const v = document.querySelector('#gw-more-menu a[data-act="versions"]');
          const h = document.querySelector('#gw-more-menu a[data-act="handbook"]');
          return acts.join() === 'compose,setup,location,pool-add,versions,handbook,gm-rename,gm-renew,gm-proxy,gm-disable,gm-delete'
            && !!v && /^#gw\/[^/]+\/versions$/.test(v.getAttribute('href')) && !v.target && !!h && /^#gw\/[^/]+\/handbook$/.test(h.getAttribute('href')) && !h.target;
        }));
        await page.keyboard.press('ArrowDown');
        step('menu: ArrowDown moves on', await page.evaluate(() => document.activeElement && document.activeElement.dataset.act === 'setup'));
        // a poll redraws the view: the menu stays open, the focus stays on the item
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway')));
        await page.waitForTimeout(1700);
        step('menu: survives the redraw of a poll (still open, same item focused); "Technische Details" stays open', await page.evaluate(() => !document.getElementById('gw-more-menu').hidden
          && document.activeElement && document.activeElement.dataset.act === 'setup' && document.querySelector('.gwo-dev details.gwo-tech').open));
        await page.keyboard.press('End');
        step('menu: End → last item', await page.evaluate(() => document.activeElement && document.activeElement.dataset.act === 'gm-delete'));
        await page.keyboard.press('Escape');
        step('menu: Escape closes it and gives the focus back to "Mehr"', await until(page, () => document.getElementById('gw-more-menu').hidden && document.activeElement && document.activeElement.id === 'gw-more-btn'));
        await page.click('#gw-more-btn');
        step('menu: a click opens it', await until(page, () => !document.getElementById('gw-more-menu').hidden));
        await page.mouse.click(10, 990);
        step('menu: a click outside closes it', await until(page, () => document.getElementById('gw-more-menu').hidden));
        await page.click('#gw-more-btn');
        await page.click('#gw-more-menu [data-act="pool-add"]');
        step('menu: "Zu einem Pool hinzufügen …" → pool "Heimnetz" (already in it) or a new one', await until(page, () => {
          const d = document.querySelector('.gwp-dlg');
          return d && d.querySelector('#gwp-addto-1').disabled && d.querySelector('#gwp-addto-new').checked;
        }));
        await page.click('.gwp-dlg .gcd-foot .btn-primary');
        step('menu: "Neuen Pool …" opens "Pool anlegen" with this gateway first', await until(page, (h) => {
          const d = document.querySelector('.gwp-pooldlg');
          return d && d.querySelector('#gwp-dlg-gw-' + h).checked && document.getElementById('gwp-dlg-cool').value === '900';
        }, HOME));
        await page.keyboard.press('Escape');
        await until(page, () => !document.querySelector('.gwp-pooldlg'));
        // tab "Netzwerk": discovered devices + scan targets below
        await page.evaluate((h) => { location.hash = '#gw/' + h + '/net'; }, HOME);
        step('detail: "Erkannte Geräte" moved to the tab Netzwerk', await until(page, () => !!document.querySelector('#gwe-tabpanel .gw-net-extras .gw')));
        await page.evaluate((h) => { location.hash = '#gw/' + h + '/features'; }, HOME);
        step('detail: tab "Funktionen" (#gw/<id>/features) with the switches in groups', await until(page, () => document.getElementById('gwe-tab-features').getAttribute('aria-selected') === 'true'
          && document.querySelector('#gwe-tabpanel [data-fgroup="home"] [data-feature="netwatch"] [role="switch"]')));
        // tabs reach every function: the address keeps the tab on a reload
        await page.reload();
        step('detail: the tab survives a reload', await until(page, () => (document.getElementById('gwe-tab-features') || {}).getAttribute && document.getElementById('gwe-tab-features').getAttribute('aria-selected') === 'true'));

        // ── pool page ──
        await page.evaluate(() => { location.hash = '#pool/1'; });
        step('pool: page with name, status, banner and the sentence of what happens', await until(page, () => {
          const v = document.getElementById('gw-pool-view');
          return !v.hidden && v.querySelector('.gwp-head h2 [data-status="partial"]') && v.querySelector('.gwp-banner-warn[data-status="partial"]')
            && /1 von 2 Routen/.test(v.querySelector('.gwp-banner').textContent) && !/alle 2 Routen/.test(v.querySelector('.gwp-banner').textContent)
            && v.querySelector('.gwp-mlist [data-state="standby_partial"]') && document.getElementById('fleet-view').hidden;
        }));
        step('pool: members in order with up/down buttons (first "up" disabled), reserve check names the missing target', await page.evaluate(([h, n]) => {
          const li = [...document.querySelectorAll('.gwp-mlist > li')];
          return li.map((x) => Number(x.dataset.peer)).join() === [h, n].join() && li[0].querySelector(`[data-fk="gwp-up:${h}"]`).disabled
            && !li[0].querySelector(`[data-fk="gwp-down:${h}"]`).disabled && li[0].getAttribute('draggable') === 'true'
            && document.querySelector('.gwp-reserve[data-reserve="missing"]') && /phoscon/.test(document.querySelector('.gwp-reserve').textContent);
        }, [HOME, NAS]));
        step('pool: behaviour — Ausfallsicherheit pressed, "Last verteilen" locked, failback 15 min selected', await page.evaluate(() => {
          const fo = document.querySelector('.gwp-beh [data-mode="failover"]');
          const lb = document.querySelector('.gwp-beh [data-mode="load_balancing"]');
          return fo.getAttribute('aria-pressed') === 'true' && lb.disabled && document.getElementById('gwp-cool').value === '900' && !document.getElementById('gwp-lb');
        }));
        step('pool: routes of the pool and the pinned one with "In den Pool nehmen"; history with durations', await page.evaluate(() => {
          const rt = document.querySelector('.gwp-routes');
          return rt.querySelectorAll('.gwp-li[data-route]').length === 3 && rt.querySelector('.gwp-li-pinned [data-fk="gwp-take:9503"]')
            && document.querySelectorAll('.gwp-hist .gwp-li[data-kind]').length === 2 && document.querySelector('.gwp-hist [data-kind="failover"] .gwe-d');
        }));
        step('pool: the pinned route says that its reserve reaches the target (reserve check for pinned routes)', await page.evaluate(() => {
          const tag = document.querySelector('.gwp-routes .gwp-li-pinned[data-route="9503"] .tag[data-reserve="ok"]');
          return !!tag && tag.classList.contains('tag-green') && /e2e-gw-nas (erreicht das Ziel|reaches the target)$/.test(tag.textContent);
        }));
        await view(page, 'gwpool-page-dark');
        await theme(page, 'light');
        await view(page, 'gwpool-page-light');
        pinnedReach = false;
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway')));
        step('pool: … and warns when it does not', await until(page, () => {
          const tag = document.querySelector('.gwp-routes .gwp-li-pinned[data-route="9503"] .tag[data-reserve="missing"]');
          return !!tag && tag.classList.contains('tag-amber') && /e2e-gw-nas (erreicht das Ziel nicht|does not reach the target)$/.test(tag.textContent);
        }));
        pinnedReach = true;
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway')));
        await until(page, () => !!document.querySelector('.gwp-routes .gwp-li-pinned .tag[data-reserve="ok"]'));
        // without reserve-check data the wording stays as before: "geschützt", "alle n Routen"
        reserveData = false;
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway')));
        step('pool: without reserve-check data → "geschützt" and "bleiben alle 3 Routen erreichbar (2 im Pool + 1 fest an einem Mitglied)"', await until(page, () => {
          const v = document.getElementById('gw-pool-view');
          return v.querySelector('.gwp-head h2 [data-status="protected"]') && v.querySelector('.gwp-banner[data-status="protected"]')
            && /alle 3 Routen/.test(v.querySelector('.gwp-banner').textContent) && !v.querySelector('.gwp-reserve') && v.querySelector('.gwp-mlist [data-state="standby"]');
        }));
        reserveData = true;
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('gc:gateway')));
        await until(page, () => !!document.querySelector('.gwp-banner[data-status="partial"]'));
        // "In den Pool nehmen"
        await page.click('[data-fk="gwp-take:9503"]');
        step('pool: "In den Pool nehmen" uses migrate-routes; the route is in the pool afterwards', await until(page, () => !document.querySelector('.gwp-li-pinned')
          && document.querySelectorAll('.gwp-routes .gwp-li[data-route]').length === 3) && JSON.stringify((last('POST', '/1/migrate-routes') || {}).body) === '{"route_ids":[9503]}');
        // order by button and by keyboard
        await page.click(`[data-fk="gwp-down:${HOME}"]`);
        step('pool: "nach unten" saves the new order (PUT members)', await until(page, ([h, n]) => [...document.querySelectorAll('.gwp-mlist > li')].map((x) => Number(x.dataset.peer)).join() === [n, h].join(), [HOME, NAS])
          && JSON.stringify(last('PUT', '/1/members').body.members) === JSON.stringify([{ peer_id: NAS, priority: 1 }, { peer_id: HOME, priority: 2 }]));
        await page.focus(`[data-fk="gwp-down:${NAS}"]`);
        await page.keyboard.press('Enter');
        step('pool: keyboard (Enter on "nach unten") moves it back', await until(page, ([h, n]) => [...document.querySelectorAll('.gwp-mlist > li')].map((x) => Number(x.dataset.peer)).join() === [h, n].join(), [HOME, NAS]));
        // failback time
        await page.selectOption('#gwp-cool', '180');
        step('pool: failback time saved (PUT pool)', await until(page, () => document.getElementById('gwp-cool') && document.getElementById('gwp-cool').value === '180') && (last('PUT', '/1') || {}).body.failback_cooldown_s === 180);
        await page.selectOption('#gwp-cool', 'custom');
        step('pool: "eigene Zeit …" shows the seconds field', await until(page, () => !document.querySelector('.gwp-beh .gwp-cool-custom').hidden && document.activeElement && document.activeElement.id === 'gwp-cool-s'));
        await page.fill('#gwp-cool-s', '240');
        await page.click('[data-fk="gwp-cool-apply"]');
        step('pool: custom failback time saved', await until(page, () => true) && await (async () => { for (let i = 0; i < 20; i++) { const c = last('PUT', '/1'); if (c && c.body.failback_cooldown_s === 240) return true; await page.waitForTimeout(100); } return false; })());
        // "Routen hierher umziehen": the migration dialog of the former page, with "relocate"
        await page.click('[data-fk="gwp-migrate"]');
        step('pool: "Routen hierher umziehen" opens the migration dialog (pool preselected, relocate mode)', await until(page, () => {
          const d = document.querySelector('.gwp-migdlg');
          return d && document.getElementById('gwp-mig-pool') && document.getElementById('gwp-mig-pool').value === '1' && document.getElementById('gwp-mig-mode-relocate')
            && d.querySelectorAll('input[name="gwp-mig-route"]').length === 2;
        }));
        await page.keyboard.press('Escape');
        await until(page, () => !document.querySelector('.gwp-migdlg'));

        // ── phone ──
        await page.setViewportSize({ width: 390, height: 900 });
        await page.waitForTimeout(300);
        step('phone: pool page without sideways scroll', (await overflow(page)) <= 0, 'overflow ' + await overflow(page));
        await view(page, 'gwpool-page-390-light', 2600);
        await page.evaluate((h) => { location.hash = '#gw/' + h; }, HOME);
        await until(page, () => document.querySelector('.gwo-top'));
        await page.waitForTimeout(300);
        step('phone: detail without sideways scroll; tabs scroll inside their bar; "Neu prüfen" and "Mehr" side by side', await page.evaluate(() => {
          const tabs = document.querySelector('.gwe-tabs');
          const a = document.querySelector('[data-act="recheck"]').getBoundingClientRect();
          const b = document.getElementById('gw-more-btn').getBoundingClientRect();
          return document.documentElement.scrollWidth <= window.innerWidth && tabs.scrollWidth > tabs.clientWidth
            && Math.abs(a.top - b.top) < 2 && Math.abs(a.width - b.width) < 2 && a.height >= 44;
        }));
        await page.click('#gw-more-btn');
        step('phone: menu items are at least 44 px high and inside the screen', await until(page, () => {
          const items = [...document.querySelectorAll('#gw-more-menu [role="menuitem"]')];
          const m = document.getElementById('gw-more-menu').getBoundingClientRect();
          return items.length && items.every((i) => i.getBoundingClientRect().height >= 44) && m.left >= 0 && m.right <= window.innerWidth;
        }));
        await view(page, 'gwpool-detail-390-light', 2600);
        await page.keyboard.press('Escape');
        await page.evaluate(() => { history.replaceState(null, '', location.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); });
        await until(page, () => !document.getElementById('fleet-view').hidden);
        step('phone: fleet without sideways scroll', (await overflow(page)) <= 0);
        await view(page, 'gwpool-fleet-390-light', 2600);
        await page.setViewportSize({ width: 1440, height: 1000 });

        // ── "Pool anlegen" from the hint: same LAN, preset of the first device, its routes ──
        await page.click('.gwp-hint [data-act="pool-create"]');
        step('create: dialog with name, both Ferienhaus gateways checked in order, "gleiches Netz"', await until(page, ([f, p]) => {
          const d = document.querySelector('.gwp-pooldlg');
          if (!d) return false;
          const a = d.querySelector('#gwp-dlg-gw-' + f);
          const b = d.querySelector('#gwp-dlg-gw-' + p);
          return document.getElementById('gwp-dlg-name').value === 'Ferienhaus' && a.checked && b.checked
            && a.closest('label').querySelector('.tag-blue').textContent === '1' && /192\.168\.178\.0\/24/.test(b.closest('label').textContent)
            && document.activeElement && document.activeElement.id === 'gwp-dlg-name';
        }, [FH, PIFH]));
        step('create: failback proposed from Ferienhaus (Linux → 3 min); its 2 routes offered', await until(page, () => document.getElementById('gwp-dlg-cool').value === '180'
          && document.getElementById('gwp-dlg-take') && document.getElementById('gwp-dlg-take').checked && /cloud\.ferien\.example/.test(document.querySelector('.gwp-pooldlg').textContent)));
        step('create: the home pool\'s gateways are shown with "schon im Pool"', await page.evaluate((h) => /Heimnetz/.test(document.querySelector('#gwp-dlg-gw-' + h).closest('label').textContent), HOME));
        await view(page, 'gwpool-create-light');
        await page.fill('#gwp-dlg-name', '');
        await page.click('[data-fk="gwp-dlg-ok"]');
        step('create: an empty name is refused in the dialog', await until(page, () => { const e = document.querySelector('.gwp-pooldlg .gwe-err'); return e && !e.hidden; }));
        await page.fill('#gwp-dlg-name', 'Ferienhaus');
        await page.click('[data-fk="gwp-dlg-ok"]');
        step('create: POST pool (failover) → PUT members in order → migrate the 2 routes → pool page', await until(page, () => location.hash === '#pool/2' && !!document.querySelector('[data-pool-page="2"] .gwp-head'))
          && last('POST', '').body.mode === 'failover' && last('POST', '').body.failback_cooldown_s === 180
          && JSON.stringify(last('PUT', '/2/members').body.members) === JSON.stringify([{ peer_id: FH, priority: 1 }, { peer_id: PIFH, priority: 2 }])
          && JSON.stringify(last('POST', '/2/migrate-routes').body) === '{"route_ids":[9401,9402]}');
        await page.click('[data-pool-page="2"] [data-act="back"]');
        step('create: the fleet shows the new pool as a group, no single gateways left', await until(page, () => !!document.querySelector('.gwp-group[data-pool="2"]') && !document.querySelector('.gwp-singles')));

        // ── "Pool auflösen …" ──
        await page.evaluate(() => { location.hash = '#pool/2'; });
        await until(page, () => document.querySelector('[data-pool-page="2"] [data-fk="gwp-dissolve"]'));
        await page.click('[data-fk="gwp-dissolve"]');
        step('dissolve: asks, says the routes stay and run pinned to a gateway (choice)', await until(page, (f) => {
          const s = document.getElementById('gwp-dis-pin');
          return s && s.value === String(f) && document.querySelector('.gwp-dlg .btn-danger');
        }, FH));
        await page.click('.gwp-dlg .btn-danger');
        step('dissolve: POST dissolve with pin_to → back to the fleet, the group is gone', await until(page, () => location.hash === '' && !document.getElementById('fleet-view').hidden && !document.querySelector('.gwp-group[data-pool="2"]'))
          && last('POST', '/2/dissolve').body.pin_to === FH);
        // ── live state (gatewayLiveState): an update under way, offline since, back online in the failback wait ──
        live.on = true;
        live.failbackAt = Date.now() + 4 * MIN + 30000;
        live.expectedBy = Date.now() + 8 * MIN;
        await page.goto(BASE + '/gateways');
        await theme(page, 'light');
        step('live: an update under way is "Update läuft" (blue) with the expected time — not offline', await until(page, (f) => {
          const c = document.querySelector(`.gw[data-id="${f}"]`);
          const tag = c && c.querySelector('.tag-blue[data-live="updating"]');
          return tag && /Update läuft/.test(tag.textContent) && /zurück erwartet bis \d\d:\d\d/.test(c.textContent) && c.dataset.live === 'updating';
        }, FH));
        step('live: an offline gateway stays offline (grey)', await page.evaluate((p) => {
          const c = document.querySelector(`.gw[data-id="${p}"]`);
          return !!(c && c.querySelector('.tag-grey[data-live="offline"]'));
        }, PIFH));
        step('live: KPI "Online" says "1 offline · 1 startet neu"', await page.evaluate(() => [...document.querySelectorAll('#fleet-kpis .kpi')].some((k) => /1 offline · 1 startet neu/.test(k.textContent))));
        const roleText = () => page.evaluate((n) => { const r = document.querySelector(`.gwp-group[data-pool="1"] .gw[data-id="${n}"] [data-role="recovering"]`); return r ? r.textContent : ''; }, NAS);
        const r0 = await roleText();
        step('live: back online in the failback wait — the role tag counts down m:ss', /Reserve in [34]:\d\d/.test(r0), r0);
        await page.waitForTimeout(2100);
        const r1 = await roleText();
        step('live: … and the countdown runs without a reload', r1 !== r0 && /Reserve in [34]:\d\d/.test(r1), r0 + ' → ' + r1);
        step('live: the card of a gateway in the failback wait is online (green), not offline', await page.evaluate((n) => !!document.querySelector(`.gw[data-id="${n}"] .tag-green[data-live="online"]`), NAS));
        await view(page, 'gwpool-live-light');
        await page.evaluate((n) => { location.hash = '#gw/' + n; }, NAS);
        step('live: detail head — pill "Online" and the line "steht in m:ss wieder als Reserve bereit"', await until(page, () => {
          const head = document.querySelector('.gw-head');
          const hint = head && head.querySelector('.gw-live-hint[data-gw-until]');
          return head && head.querySelector('.pill.online') && hint && /steht in \d+:\d\d wieder als Reserve bereit/.test(hint.textContent);
        }));
        step('live: Zustand names the failback wait', await until(page, () => /wieder als Reserve bereit/.test((document.querySelector('.gwo-state') || {}).textContent || '')));
        await page.evaluate(() => { location.hash = '#pool/1'; });
        step('live: pool page — the member is "wieder online" and the routes wait', await until(page, (n) => {
          const li = document.querySelector(`.gwp-mlist > li[data-peer="${n}"]`);
          return li && /wieder online/.test(li.textContent);
        }, NAS));
        await theme(page, 'dark');
        await view(page, 'gwpool-live-dark');
        live.on = false;
        await page.evaluate(() => { location.hash = ''; });
        step('pools: no raw i18n keys on the page', await page.evaluate(() => !/\bgwp\.[a-z_]+\.[a-z_.]+/.test(['fleet-view', 'gw-detail-view', 'gw-pool-view'].map((i) => document.getElementById(i).innerText).join(' '))));
        allow((p) => p.kind === 'http' && p.status === 403 && /\/discovered$/.test(p.url));
        allow((p) => p.kind === 'console' && /403/.test(p.text));
      } finally {
        await page.unroute(/\/api\/v1\/gateway-pools(\/.*)?(\?.*)?$/).catch(() => {});
        await page.unroute(/\/api\/v1\/gateways(\?.*)?$/).catch(() => {});
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await api(page, 'POST', '/api/v1/settings/language', { language: lang0 }).catch(() => {});
        await page.evaluate(() => { try { localStorage.removeItem('gc.gw.poolHintHidden'); } catch (_) { /* ignore */ } }).catch(() => {});
        withDb((db) => { for (const r of enabled0) db.prepare('UPDATE peers SET enabled = ? WHERE id = ?').run(r.enabled, r.id); });
      }
    },
  };
};
