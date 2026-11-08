'use strict';

// Gateways › Standorte (docs/feature-gateway-locations.md): without a
// location the fleet looks as before (no switch); the dialog "Standorte"
// (empty, create with address, the form's own check, a taken name from the
// real API, edit), the location of a gateway from its detail view ("Mehr" ›
// "Standort ändern …", the chip of the head, the row in "Gerät & Software"),
// the fleet by location with "Ohne Standort" last and the switch to the pools
// (kept after a reload), the assistant's step 1 (the list, "Neuer Standort …"
// inline — no peer group any more), deleting a used location (the question,
// the gateway goes to "Ohne Standort"), light/dark and 390 px. Everything
// against the real API; at the end the locations are gone again and the
// switch is reset, so later scenarios see the fleet as before.

const fs = require('node:fs');
const path = require('node:path');

function enableSeededGateways(ids) {
  const file = process.env.GC_DB_PATH || path.join(process.env.GC_DATA_DIR || '.', 'gatecontrol.db');
  if (!fs.existsSync(file)) return 0;
  const Database = require('better-sqlite3');
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const st = db.prepare("UPDATE peers SET enabled = 1 WHERE id = ? AND peer_type = 'gateway'");
    return ids.reduce((n, id) => n + st.run(id).changes, 0);
  } finally { db.close(); }
}

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, shot, api, allow } = ctx;
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
  const fill = async (page, form, values) => {
    const ins = await page.$$(form + ' input');
    for (let i = 0; i < values.length && i < ins.length; i++) await ins[i].fill(values[i]);
  };

  return {
    async gatewaylocations(page) {
      const GW = FIXTURES.gateways;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      enableSeededGateways([GW.home, GW.nas]);
      // a clean start: no locations, the switch not chosen yet
      const pre = await api(page, 'GET', '/api/v1/gateway-locations');
      for (const l of (pre.body && pre.body.locations) || []) await api(page, 'DELETE', '/api/v1/gateway-locations/' + l.id);
      await page.goto(BASE + '/gateways');
      await page.evaluate(() => { try { localStorage.removeItem('gc.gw.fleetGroup'); } catch (_) { /* ignore */ } });
      await page.reload();

      // ── without a location: as before ──
      step('gateway page: button "Standorte" in the head', await visible(page, '#btn-locations'));
      step('no location yet → no switch, no location sections (the fleet as before)',
        await until(page, () => document.querySelector('#fleet-grid .gw') && !document.querySelector('.gwl-bar') && !document.querySelector('.gwl-section')));

      // ── dialog "Standorte" ──
      await page.click('#btn-locations');
      step('the dialog opens with the empty state', await visible(page, '[data-gwl="manage"] .gwl-empty'));
      await page.click('[data-gwl-new]');
      step('"Neuer Standort" opens the form (name focused)', await visible(page, '[data-gwl-form="new"]')
        && await until(page, () => document.activeElement && document.activeElement.closest('[data-gwl-form="new"]')));
      await page.click('[data-gwl-form="new"] [data-gwl-save]');
      step('without a name → field error in the browser, no request', await visible(page, '[data-gwl-form="new"] .gwz-ferr:not([hidden])')
        && await page.$eval('[data-gwl-form="new"] input', (n) => n.getAttribute('aria-invalid') === 'true'));
      await fill(page, '[data-gwl-form="new"]', ['Zuhause E2E', 'Musterweg 12', '10115', 'Berlin']);
      await page.selectOption('[data-gwl-form="new"] select', 'DE');
      await page.click('[data-gwl-form="new"] [data-gwl-save]');
      step('created: a row with name, address and "kein Gateway"', await until(page, () => {
        const r = [...document.querySelectorAll('[data-gwl-row]')].find((x) => /Zuhause E2E/.test(x.textContent));
        return r && /Musterweg 12, 10115 Berlin/.test(r.textContent) && !document.querySelector('[data-gwl-form]');
      }));
      await page.click('[data-gwl-new]');
      await fill(page, '[data-gwl-form="new"]', ['zuhause e2e']);
      await page.click('[data-gwl-form="new"] [data-gwl-save]');
      step('a taken name (other case) → the real API answers 409, shown at the field',
        await visible(page, '[data-gwl-form="new"] .gwz-ferr:not([hidden])'));
      allow((p) => p.kind === 'http' && p.status === 409 && p.url === '/api/v1/gateway-locations');
      allow((p) => p.kind === 'console' && /409/.test(p.text));
      await fill(page, '[data-gwl-form="new"]', ['Büro E2E', '', '', 'Hamburg']);
      await page.click('[data-gwl-form="new"] [data-gwl-save]');
      await until(page, () => document.querySelectorAll('[data-gwl-row]').length === 2);
      const list = await api(page, 'GET', '/api/v1/gateway-locations');
      const home = list.body.locations.find((l) => l.name === 'Zuhause E2E');
      const office = list.body.locations.find((l) => l.name === 'Büro E2E');
      step('API: both stored, country DE, sorted by name', home && office && home.country === 'DE' && list.body.locations[0].name === 'Büro E2E');
      // edit
      await page.click(`[data-gwl-edit="${office.id}"]`);
      step('edit: the form in place of the row, filled', await until(page, (id) => {
        const f = document.querySelector(`[data-gwl-form="${id}"]`);
        return f && f.querySelectorAll('input')[0].value === 'Büro E2E' && f.querySelectorAll('input')[3].value === 'Hamburg';
      }, office.id));
      await fill(page, `[data-gwl-form="${office.id}"]`, ['Büro E2E', 'Hafenstraße 8', '20457']);
      await page.click(`[data-gwl-form="${office.id}"] [data-gwl-save]`);
      step('saved: the row shows the new address', await until(page, (id) => /Hafenstraße 8, 20457 Hamburg/.test((document.querySelector(`[data-gwl-row="${id}"]`) || {}).textContent || ''), office.id));
      await theme(page, 'dark');
      await shot(page, 'gwl-dialog-dark', false);
      await page.keyboard.press('Escape');
      step('Escape closes the dialog', await until(page, () => !document.querySelector('[data-gwl="manage"]')));

      // ── with locations, still no gateway in one: everything under "Ohne Standort" ──
      step('locations exist → switch "Standorte | Pools", fleet by location, all gateways under "Ohne Standort"',
        await until(page, () => document.querySelector('.gwl-bar [data-gwl-mode="locations"][aria-pressed="true"]')
          && document.querySelectorAll('.gwl-section').length === 1 && document.querySelector('.gwl-section[data-location="none"]')));

      // ── a gateway's location from its detail view ──
      await page.goto(BASE + '/gateways#gw/' + GW.home);
      step('detail: row "Standort" with "Festlegen" in "Gerät & Software"', await visible(page, '#gw-detail-view .gwl-dev [data-act="location"]'));
      await page.click('#gw-more-btn');
      await page.click('#gw-more-menu [data-act="location"]');
      step('"Mehr" › "Standort ändern …" opens the choice (radio list + "Ohne Standort" checked)',
        await visible(page, '[data-gwl="change"]') && await until(page, () => {
          const r = [...document.querySelectorAll('[data-gwl="change"] input[type="radio"]')];
          return r.length === 3 && r[r.length - 1].checked;
        }));
      await page.click(`[data-gwl="change"] label[for$="-${home.id}"]`);
      await shot(page, 'gwl-change-dark', false);
      await page.click('[data-gwl="change"] [data-gwl-save]');
      step('saved: chip in the head, the row names the location',
        await until(page, () => /Zuhause E2E/.test((document.querySelector('#gw-detail-view .gwl-chip') || {}).textContent || '')
          && /Zuhause E2E · Musterweg 12, 10115 Berlin/.test((document.querySelector('#gw-detail-view .gwl-dev') || {}).textContent || '')));
      const gws = await api(page, 'GET', '/api/v1/gateways');
      const g1 = gws.body.gateways.find((g) => g.peer_id === GW.home);
      step('API: GET /api/v1/gateways carries the location', g1 && g1.location && g1.location.id === home.id && g1.location.city === 'Berlin');
      // the chip opens the same dialog
      await page.click('#gw-detail-view .gwl-chip');
      step('the chip opens "Standort von …" with the location checked', await until(page, (id) => {
        const r = document.querySelector(`[data-gwl="change"] input[value="${id}"]`);
        return r && r.checked;
      }, String(home.id)));
      // "Neuer Standort …" inside the dialog
      await page.click('[data-gwl="change"] [data-gwl-newpick]');
      step('"Neuer Standort …" in the dialog: the address form, no radio checked',
        await visible(page, '[data-gwl="change"] [data-gwl-form="new"]')
        && await page.$$eval('[data-gwl="change"] input[type="radio"]', (r) => r.every((x) => !x.checked)));
      await page.keyboard.press('Escape');

      // ── fleet by location ──
      await page.goto(BASE + '/gateways');
      step('fleet: section "Zuhause E2E" with the gateway, "Ohne Standort" last, no empty section for "Büro E2E"',
        await until(page, ([h, id]) => {
          const s = [...document.querySelectorAll('.gwl-section')];
          return s.length === 2 && s[0].dataset.location === String(h) && s[0].querySelector(`.gw[data-id="${id}"]`)
            && s[1].dataset.location === 'none' && /Musterweg 12, 10115 Berlin/.test(s[0].querySelector('.gwl-addr').textContent);
        }, [home.id, GW.home]));
      await theme(page, 'light');
      await view(page, 'gwl-fleet-locations-light', 1300);
      await page.click('[data-gwl-mode="pools"]');
      step('switch → pools: the fleet as before, location tags on the cards',
        await until(page, () => !document.querySelector('.gwl-section') && document.querySelector('[data-gwl-mode="pools"][aria-pressed="true"]')
          && document.querySelectorAll('.gwl-tag').length >= 2));
      await page.reload();
      step('the choice is kept per browser (after a reload still "Pools")',
        await until(page, () => document.querySelector('[data-gwl-mode="pools"][aria-pressed="true"]') && !document.querySelector('.gwl-section')));
      await page.click('[data-gwl-mode="locations"]');

      // ── assistant, step 1 ──
      await page.click('#btn-add-gateway');
      step('assistant: "Standort" lists the locations and "Neuer Standort …" (no peer group)',
        await until(page, ([a, b]) => {
          const o = [...document.querySelectorAll('#gwz-location option')].map((x) => x.value);
          return o[0] === '' && o.includes(String(a)) && o.includes(String(b)) && o[o.length - 1] === 'new' && !document.getElementById('gwz-group');
        }, [home.id, office.id]));
      await page.fill('#gwz-name', 'Pi Standort E2E');
      await page.click('#gwz-overlay label.gwz-plat:has(input[value="linux"])');
      await page.selectOption('#gwz-location', 'new');
      step('"Neuer Standort …" shows the inline form', await visible(page, '#gwz-loc-new'));
      await page.click('#gwz-next');
      step('without a location name → field error, still step 1', await visible(page, '#gwz-loc-name-err'));
      await page.selectOption('#gwz-location', String(home.id));
      step('choosing a location hides the form again', await until(page, () => document.getElementById('gwz-loc-new').hidden));
      await shot(page, 'gwl-wizard-light', false);
      await page.click('[data-gwz-close]');

      // ── delete a used location ──
      await page.click('#btn-locations');
      await page.click(`[data-gwl-del="${home.id}"]`);
      step('delete: the question names the gateway', await until(page, () => {
        const d = [...document.querySelectorAll('.gcd-dialog')].pop();
        return d && /e2e-gw-home/.test(d.textContent);
      }));
      await shot(page, 'gwl-delete-light', false);
      await page.click('.gcd-dialog .gcd-ok');
      step('deleted: the row is gone', await until(page, (id) => !document.querySelector(`[data-gwl-row="${id}"]`), home.id));
      await page.keyboard.press('Escape');
      const after = await api(page, 'GET', '/api/v1/gateways');
      step('the gateway stays, without a location', (after.body.gateways.find((g) => g.peer_id === GW.home) || {}).location === null);

      // ── 390 px ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await until(page, () => document.querySelector('.gwl-bar'));
      step('390 px: no horizontal scrolling on the fleet', (await overflow(page)) <= 0);
      await page.click('#btn-locations');
      await visible(page, '[data-gwl-row]');
      step('390 px: no horizontal scrolling in the dialog', (await overflow(page)) <= 0);
      await shot(page, 'gwl-390-light', false);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ── clean up: later scenarios see the fleet as before ──
      const rest = await api(page, 'GET', '/api/v1/gateway-locations');
      for (const l of (rest.body && rest.body.locations) || []) await api(page, 'DELETE', '/api/v1/gateway-locations/' + l.id);
      await page.evaluate(() => { try { localStorage.removeItem('gc.gw.fleetGroup'); } catch (_) { /* ignore */ } });
      const end = await api(page, 'GET', '/api/v1/gateway-locations');
      step('clean-up: no locations left', end.body && end.body.locations.length === 0);
    },
  };
};
