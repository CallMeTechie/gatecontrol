'use strict';

// Zonen-Seite (/routes, docs/feature-domain-zones.md): rendert sie die
// geseedete Zone, filtert die Suche, öffnen „Domain-Einstellungen“,
// „Host bearbeiten“ (mit Inline-Bearbeitung) und „Neuer Host“, und bleibt
// ein geänderter Ziel-Port nach dem Speichern erhalten — über beide Wege:
// Inline-Bearbeitung im Host-Dialog und Eintrags-Editor.
//
// Bewusst ohne Textvergleiche: Texte und Stylesheets ändern sich. Geprüft
// werden Auswahlpfade, data-Attribute und API-Daten.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, waitIdle, shot, api } = ctx;

  async function zoneData(page) {
    const res = await api(page, 'GET', '/api/v1/zones');
    return (res.body && res.body.zones || []).find((z) => z.domain === FIXTURES.zone.domain) || null;
  }
  async function entryOf(page, hostId, pred) {
    const z = await zoneData(page);
    const h = z && (z.hosts || []).find((x) => x.id === hostId);
    return h ? (h.entries || []).find(pred) || null : null;
  }
  const isHttp = (e) => e.route_type !== 'l4';
  const dialog = (page, kind) => page.locator(`[data-rt-dialog="${kind}"]`);
  async function closed(page, kind) {
    return page.waitForFunction((k) => !document.querySelector(`[data-rt-dialog="${k}"]`), kind, { timeout: 8000 })
      .then(() => true).catch(() => false);
  }

  return {
    async zones(page) {
      const zone = await zoneData(page);
      step('API: GET /zones answers with the seeded zone', !!zone);
      if (!zone) return;
      const apiHosts = (zone.hosts || []).length;
      step('API: the seeded zone carries its hosts', apiHosts === 3, `${apiHosts} hosts`);

      await page.goto(BASE + '/routes');
      const rendered = await visible(page, '#zn-zones .rt-zone', 10000);
      step('zones page renders the zone cards', rendered);
      await waitIdle(page);
      await shot(page, 'zones-page');

      const domains = await page.locator('#zn-zones .rt-zone .rt-zone-title').evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
      step('the seeded zone is listed', domains.some((d) => d.includes(FIXTURES.zone.domain)), domains.join(' '));
      const hostCount = await page.locator('#zn-zones .rt-host').count();
      step('every host of the zone is drawn', hostCount >= apiHosts, `${hostCount} host rows for ${apiHosts} API hosts`);
      const lines = await page.locator(`#zn-zones .rt-host[data-host-id="${FIXTURES.hosts.nas}"] .rt-line`).count();
      step('a host row shows one line per forwarding', lines === 2, `${lines} lines for nas`);

      // ── Suche + Typ-Filter (Zustand im URL-Hash) ─────────────────────────
      await page.fill('#zn-search', 'nas');
      await page.waitForTimeout(400);
      const hits = await page.locator('.rt-host').count();
      step('search narrows the host list', hits >= 1 && hits < hostCount, `${hits} of ${hostCount} hosts for "nas"`);
      await page.fill('#zn-search', '');
      await page.waitForTimeout(300);
      await page.click('#zn-type [data-type="l4"]');
      await page.waitForTimeout(300);
      const l4Hosts = await page.locator('.rt-host').count();
      const pressed = await page.getAttribute('#zn-type [data-type="l4"]', 'aria-pressed');
      step('type filter TCP/UDP keeps only hosts with such a forwarding', l4Hosts === 1 && pressed === 'true' && /type=l4/.test(page.url()),
        `${l4Hosts} hosts, hash ${page.url().split('#')[1] || ''}`);
      await page.click('#zn-type [data-type=""]');
      await page.waitForTimeout(300);

      // ── Domain-Einstellungen ─────────────────────────────────────────────
      const zoneCard = page.locator('.rt-zone').filter({ has: page.locator('.rt-zone-title', { hasText: FIXTURES.zone.domain }) }).first();
      await zoneCard.locator('.zn-edit-domain').click();
      const dsOpen = await visible(page, '[data-rt-dialog="domain-settings"] .rt-dlg', 6000);
      step('"Domain-Einstellungen" opens', dsOpen);
      if (dsOpen) {
        const rows = await dialog(page, 'domain-settings').locator('.rt-ds-row').count();
        step('the dialog shows the defaults (access, HSTS, WAF, TLS)', rows >= 4, `${rows} rows`);
        const saveDisabled = await dialog(page, 'domain-settings').locator('.rt-ds-save').isDisabled();
        step('nothing to save before a change', saveDisabled);
        await page.keyboard.press('Escape');
        step('Escape closes the dialog', await closed(page, 'domain-settings'));
      }

      // ── Host bearbeiten: Ziel-Port inline ändern ─────────────────────────
      const before = await entryOf(page, FIXTURES.hosts.nas, isHttp);
      step('API: the nas host has an HTTPS forwarding', !!before, before ? `target ${before.target_lan_port}` : '');
      if (before) {
        const oldPort = Number(before.target_lan_port || before.target_port);
        const newPort = oldPort + 1;
        await page.locator(`.rt-host[data-host-id="${FIXTURES.hosts.nas}"] .rt-edit-host`).click();
        const heOpen = await visible(page, '[data-rt-dialog="host-edit"] .rt-dlg', 6000);
        step('"Host bearbeiten" opens from the row', heOpen);
        if (heOpen) {
          const he = dialog(page, 'host-edit');
          const rows = await he.locator('.rt-erow[data-entry-id]').count();
          step('the dialog lists every forwarding of the host', rows === 2, `${rows} rows`);
          await he.locator(`.rt-erow[data-entry-id="${before.id}"] .rt-edit-toggle`).click();
          const port = he.locator(`[data-rt-key="e${before.id}-port"]`);
          await port.waitFor({ state: 'visible', timeout: 4000 });
          await port.fill(String(newPort));
          await page.waitForTimeout(150);
          const dirty = await he.locator('.rt-dlg-note.rt-dirty').count();
          step('the change counter shows the pending change', dirty === 1);
          await shot(page, 'zones-host-edit', false);
          await he.locator('.rt-he-save').click();
          step('saving closes the dialog', await closed(page, 'host-edit'));
          await waitIdle(page);
          const after = await entryOf(page, FIXTURES.hosts.nas, isHttp);
          step('the new target port is stored (both port fields of the gateway target)',
            !!after && Number(after.target_lan_port) === newPort && Number(after.target_port) === newPort,
            after ? `target_lan_port ${after.target_lan_port}, target_port ${after.target_port}` : 'entry gone');
          const lineText = await page.locator(`.rt-host[data-host-id="${FIXTURES.hosts.nas}"] .rt-line[data-entry-id="${before.id}"] .rt-to`)
            .textContent().catch(() => '');
          step('the host row shows the new port', String(lineText).includes(': ' + newPort), String(lineText).trim());

          // ── … und über den Eintrags-Editor zurück ────────────────────────
          await page.locator(`.rt-host[data-host-id="${FIXTURES.hosts.nas}"] .rt-edit-host`).click();
          await visible(page, '[data-rt-dialog="host-edit"] .rt-dlg', 6000);
          await dialog(page, 'host-edit').locator(`.rt-erow[data-entry-id="${before.id}"] .rt-options`).click();
          const edOpen = await page.waitForFunction(() => {
            const m = document.getElementById('modal-edit-route');
            return m && m.style.display === 'flex' && document.getElementById('edit-route-port').value !== '';
          }, null, { timeout: 8000 }).then(() => true).catch(() => false);
          const onTop = edOpen && await page.evaluate(() => {
            const r = document.querySelector('#modal-edit-route .rt-ee').getBoundingClientRect();
            const n = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
            return !!n && !!n.closest('#modal-edit-route');
          });
          step('the entry editor opens on top of "Host bearbeiten"', edOpen && onTop);
          if (edOpen) {
            const shown = await page.inputValue('#edit-route-port');
            step('the editor shows the LAN port of the gateway target', Number(shown) === newPort, `field ${shown}`);
            const navs = await page.locator('#ee-nav [data-ee-section]').count();
            step('the editor has the eight sections', navs === 8, `${navs}`);
            await page.fill('#edit-route-port', String(oldPort));
            await page.waitForTimeout(150);
            const changes = ((await page.textContent('#ee-changes').catch(() => '')) || '').trim();
            step('the footer summarises the change', changes.length > 0, changes);
            await page.click('#btn-edit-route-submit');
            const edClosed = await page.waitForFunction(() => document.getElementById('modal-edit-route').style.display !== 'flex', null, { timeout: 8000 })
              .then(() => true).catch(() => false);
            step('saving closes the editor', edClosed);
            await waitIdle(page);
            const restored = await entryOf(page, FIXTURES.hosts.nas, isHttp);
            step('the editor stores the target port (both port fields)',
              !!restored && Number(restored.target_lan_port) === oldPort && Number(restored.target_port) === oldPort,
              restored ? `target_lan_port ${restored.target_lan_port}, target_port ${restored.target_port}` : 'entry gone');
          }
          if (await dialog(page, 'host-edit').count()) {
            await page.keyboard.press('Escape');
            await closed(page, 'host-edit');
          }
        }
      }

      // ── Neuer Host: zwei Weiterleitungen, Vorschau und Prüfungen ─────────
      await page.click('#zn-new-host');
      const nhOpen = await visible(page, '[data-rt-dialog="new-host"] .rt-dlg', 6000);
      step('"Neuer Host" opens', nhOpen);
      if (nhOpen) {
        const nh = dialog(page, 'new-host');
        await nh.locator('[data-rt-key="nh-sub"]').fill('e2e-new');
        await nh.locator('[data-rt-key="nh-lan"]').fill('192.168.10.50');
        await nh.locator('[data-rt-key="nh-port-0"]').fill('8080');
        // A second (TCP) forwarding needs the L4 licence; the CI app runs
        // with the community licence, where the button is disabled.
        const canAdd = await nh.locator('.rt-add-row').isEnabled();
        if (canAdd) {
          await nh.locator('.rt-add-row').click();
          await nh.locator('[data-rt-key="nh-port-1"]').fill('22');
          await nh.locator('[data-rt-key="nh-out-1"]').fill('2023');
        }
        await page.waitForTimeout(200);
        const want = canAdd ? 2 : 1;
        const rows = await nh.locator('.rt-nh-entry').count();
        const preview = await nh.locator('.rt-preview-item').count();
        const checks = await nh.locator('.rt-checkline').count();
        step('one row and one preview per forwarding, plus the checks', rows === want && preview === want && checks >= 3,
          `${rows} rows, ${preview} preview, ${checks} checks${canAdd ? '' : ' (no L4 licence)'}`);
        await shot(page, 'zones-new-host', false);
        await page.keyboard.press('Escape');
        // Unsaved input: the dialog asks before discarding.
        const ask = await visible(page, '.zn-dialog .btn-danger', 4000);
        if (ask) await page.click('.zn-dialog .btn-danger');
        step('Escape asks before discarding and closes', ask && await closed(page, 'new-host'));
        const z2 = await zoneData(page);
        step('nothing was created', !!z2 && z2.hosts.length === apiHosts, `${z2 && z2.hosts.length} hosts`);
      }

      // ── Telefonbreite ────────────────────────────────────────────────────
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(BASE + '/routes');
      await waitIdle(page);
      await visible(page, '#zn-zones .rt-zone', 10000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 400px', overflow <= 1, `overflow ${overflow}px`);
      await shot(page, 'zones-phone', false);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};
