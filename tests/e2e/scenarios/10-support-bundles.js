'use strict';

// Support-Pakete (/support-bundles, docs/feature-support-bundle.md): the
// inbox lists the seeded bundles (a new one from anna-pixel, a viewed one
// from wohnzimmer-pc), filters by status and device, the peer list marks
// the device, the peer dialog links to the viewer, the viewer renders every
// section (redacted) incl. problem description and diagnosis of the apps'
// diagnosis assistant, filters the logs, marks the bundle viewed (sidebar
// badge) and deletes; light/dark screenshots, no overflow at 400 px.
//
// Against the real API with the bundles from seed.js — no text comparisons,
// only data attributes, classes and API answers.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, waitIdle, shot, api } = ctx;
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const count = (page, sel) => page.locator(sel).count();
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const theme = async (page, mode) => {
    await page.evaluate((m) => {
      try { localStorage.setItem('gc-theme-mode', m); } catch { /* ignore */ }
      document.documentElement.setAttribute('data-theme', m);
    }, mode);
    await page.waitForTimeout(200);
  };

  return {
    async support(page) {
      const S = FIXTURES.support;
      const ping = await page.request.fetch(BASE + '/api/v1/ping');
      if (ping.status() !== 200) await ctx.login(page);
      await page.setViewportSize({ width: 1440, height: 1000 });

      const list = await api(page, 'GET', '/api/v1/support-bundles');
      const ids = ((list.body && list.body.bundles) || []).map((b) => b.id);
      step('API: inbox lists both seeded bundles, one unviewed',
        list.status === 200 && ids.includes(S.pixelBundle) && ids.includes(S.pcBundle) && list.body.unviewed === 1,
        `${ids.join(',')} unviewed ${list.body && list.body.unviewed}`);

      // ── List ──
      await page.goto(BASE + '/support-bundles');
      await waitIdle(page);
      step('list renders the bundles', await until(page, (n) => document.querySelectorAll('#sb-tbody tr[data-bundle-id]').length >= n, 2));
      step('the new bundle is marked new', await count(page, `#sb-tbody tr.sb-row-new[data-bundle-id="${S.pixelBundle}"]`) === 1);
      step('its row shows the diagnosis chip and the start of the problem description',
        await count(page, `#sb-tbody tr[data-bundle-id="${S.pixelBundle}"] .sb-row-extra [data-diag="fail"]`) === 1
        && await count(page, `#sb-tbody tr.sb-desc-row[data-desc-for="${S.pixelBundle}"] .sb-row-desc`) === 1
        && await count(page, `#sb-tbody tr[data-bundle-id="${S.pcBundle}"] .sb-row-extra`) === 0
        && await count(page, `#sb-tbody tr[data-desc-for="${S.pcBundle}"]`) === 0);
      step('sidebar badge shows 1 unviewed', (await page.locator('#sb-nav-badge').textContent()).trim() === '1');
      await theme(page, 'dark');
      await shot(page, 'support-list-dark');

      await page.click('#sb-chips [data-status="new"]');
      step('status filter "new" keeps only the new one',
        await until(page, (id) => { const r = document.querySelectorAll('#sb-tbody tr[data-bundle-id]'); return r.length === 1 && r[0].dataset.bundleId === String(id); }, S.pixelBundle),
        page.url());
      step('the filter is in the address', /status=new/.test(page.url()));
      await page.click('#sb-chips [data-status=""]');
      await page.selectOption('#sb-filter-peer', String(S.pc));
      step('device filter keeps only that device',
        await until(page, (id) => { const r = document.querySelectorAll('#sb-tbody tr[data-bundle-id]'); return r.length === 1 && r[0].dataset.peerId === String(id); }, S.pc));
      await page.selectOption('#sb-filter-peer', '');

      // ── Peer list + edit dialog ──
      await page.goto(BASE + '/peers');
      await waitIdle(page);
      step('peer list marks the device with an unviewed bundle',
        await visible(page, `tr[data-peer-id="${S.pixel}"] .sb-peer-badge`, 8000));
      await page.click(`tr[data-peer-id="${S.laptop}"] [data-action="edit"]`);
      step('edit dialog of a device with an open request shows the support section',
        await visible(page, '#edit-peer-support-group') && await until(page, () => {
          const b = document.getElementById('btn-edit-peer-support-request');
          return b && b.dataset.requested === '1';
        }));
      await page.click('#modal-edit-peer [data-close-modal]');
      await page.click(`tr[data-peer-id="${S.pixel}"] [data-action="edit"]`);
      step('edit dialog of the Android device lists its bundle with a view link',
        await visible(page, '#edit-peer-support-list [data-action="support-view"]'));
      await page.click('#edit-peer-support-list [data-action="support-view"]');

      // ── Viewer ──
      step('the view link opens the viewer', await visible(page, '#sb-viewer .sb-view-title', 10000), page.url());
      const secs = await page.locator('#sb-viewer [data-sec]').evaluateAll((ns) => ns.map((n) => n.dataset.sec));
      step('viewer renders every section', ['description', 'diagnosis', 'tunnel', 'settings', 'network', 'wireguard', 'errors', 'logs', 'other', 'raw'].every((s) => secs.includes(s)), secs.join(' '));
      const desc = await page.evaluate(() => {
        const p = document.querySelector('#sb-viewer [data-sec="description"] .sb-desc');
        return p ? { text: p.textContent, html: p.children.length, ws: getComputedStyle(p).whiteSpace } : null;
      });
      step('problem description: plain text with its line breaks, no markup',
        !!desc && desc.text.includes('\n') && desc.text.includes('<b>kein HTML</b>') && desc.html === 0 && desc.ws === 'pre-wrap', JSON.stringify(desc));
      const diag = await page.locator('#sb-viewer [data-sec="diagnosis"] .sb-diag-row').evaluateAll((ns) => ns.map((n) => n.dataset.check + ':' + n.dataset.status));
      step('diagnosis: one row per check with its status, summary chip "fail"',
        diag.join(' ') === 'internet:ok server:ok tunnel:ok handshake:warn dns:fail mtu:skipped speed:ok'
        && await count(page, '#sb-viewer [data-sec="diagnosis"] .sb-sec-head [data-diag="fail"]') === 1, diag.join(' '));
      step('diagnosis: hints and details render, colours differ per status', await page.evaluate(() => {
        const row = (id) => document.querySelector(`#sb-viewer .sb-diag-row[data-check="${id}"]`);
        const color = (id) => getComputedStyle(row(id).querySelector('.sb-diag-icon')).color;
        return !!row('dns').querySelector('.sb-diag-hint') && !!row('handshake').querySelector('.sb-diag-detail')
          && new Set([color('internet'), color('handshake'), color('dns'), color('mtu')]).size === 4;
      }));
      step('description and diagnosis are not repeated under "other data"',
        !(await page.locator('#sb-viewer [data-sec="other"] .sb-sub-title').allTextContents()).some((t) => t === 'diagnosis' || t === 'description'));
      const viewerText = await page.locator('#sb-viewer').textContent();
      step('no secret reaches the page (WireGuard key, API token)',
        !viewerText.includes('yAnz5TF+lXXJte14tji3zlMNq') && !viewerText.includes('e2eSecretToken') && viewerText.includes('[REDACTED]'));
      const lines = await count(page, '#sb-viewer [data-sec="logs"] .sb-line');
      step('logs render all lines', lines >= 150, `${lines} lines`);
      await page.selectOption('#sb-viewer .sb-log-level', 'error');
      step('level filter shows only error lines', await until(page, () => {
        const r = document.querySelectorAll('#sb-viewer [data-sec="logs"] .sb-line');
        return r.length > 0 && Array.prototype.every.call(r, (n) => n.classList.contains('sb-lv-error'));
      }));
      await page.selectOption('#sb-viewer .sb-log-level', '');
      await page.fill('#sb-viewer .sb-log-search', 'DNS resolver');
      step('search highlights matches', await until(page, () => {
        const r = document.querySelectorAll('#sb-viewer [data-sec="logs"] .sb-line');
        return r.length > 0 && Array.prototype.every.call(r, (n) => n.querySelector('mark'));
      }));
      step('opening it marks it viewed (sidebar badge gone)', await until(page, () => document.getElementById('sb-nav-badge').hidden));
      const after = await api(page, 'GET', '/api/v1/support-bundles');
      step('API: no unviewed bundle left', after.body && after.body.unviewed === 0);
      await theme(page, 'dark');
      await shot(page, 'support-viewer-dark');
      await theme(page, 'light');
      await shot(page, 'support-viewer-light');

      await page.setViewportSize({ width: 400, height: 860 });
      await page.waitForTimeout(200);
      step('viewer: no horizontal overflow at 400px', await overflow(page) <= 1);
      await page.click('#sb-viewer [data-action="back"]');
      step('back to the list', await visible(page, '#sb-list-view'));
      step('list: no horizontal overflow at 400px', await overflow(page) <= 1);
      await page.setViewportSize({ width: 1440, height: 1000 });

      // ── Delete from the viewer ──
      await page.goto(BASE + `/support-bundles#view/${S.pc}/${S.pcBundle}`);
      await visible(page, '#sb-viewer [data-action="delete"]', 10000);
      await page.click('#sb-viewer [data-action="delete"]');
      await page.click('.gcd-ok');
      step('delete returns to the list without the bundle', await until(page, (id) => !document.getElementById('sb-list-view').hidden
        && !document.querySelector(`#sb-tbody tr[data-bundle-id="${id}"]`) && document.querySelectorAll('#sb-tbody tr[data-bundle-id]').length === 1, S.pcBundle));
      await theme(page, 'dark');
    },
  };
};
