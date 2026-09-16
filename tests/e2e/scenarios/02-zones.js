'use strict';

// Zonen-Seite (/routes): rendert sie die geseedete Zone, filtert die Suche,
// öffnet der Domain-Dialog, und stimmt das Bild mit dem überein, was
// GET /api/v1/zones liefert?
//
// Bewusst ohne Textvergleiche: Strang W1 ändert Texte, Strang W2 die
// Stylesheets. Geprüft werden Auswahlpfade und API-Daten, nicht Beschriftungen
// und nicht der Name einer CSS-Datei.

module.exports = (ctx) => {
  const { BASE, FIXTURES, step, visible, waitIdle, shot, api } = ctx;

  return {
    async zones(page) {
      const zonesApi = await api(page, 'GET', '/api/v1/zones');
      const zone = (zonesApi.body && zonesApi.body.zones || []).find((z) => z.domain === FIXTURES.zone.domain);
      step('API: GET /zones answers', zonesApi.status === 200 && !!zone,
        `${(zonesApi.body && zonesApi.body.zones || []).length} zones`);
      if (!zone) return;
      const apiHosts = (zone.hosts || []).length;
      step('API: the seeded zone carries its hosts', apiHosts === 3, `${apiHosts} hosts`);

      await page.goto(BASE + '/routes');
      const rendered = await visible(page, '#zn-zones .zn-zone', 10000);
      step('zones page renders the zone list', rendered);
      await waitIdle(page);
      await shot(page, 'zones-page');

      const domains = await page.locator('#zn-zones .zn-zone .zn-domain').evaluateAll((ns) => ns.map((n) => n.textContent.trim()));
      step('the seeded zone is listed', domains.some((d) => d.includes(FIXTURES.zone.domain)), domains.join(' '));

      const hostCount = await page.locator('#zn-zones .zn-host').count();
      step('every host of the zone is drawn', hostCount >= apiHosts, `${hostCount} host rows for ${apiHosts} API hosts`);

      // ── Suche ────────────────────────────────────────────────────────────
      await page.fill('#zn-search', 'nas');
      await page.waitForTimeout(400);
      const hits = await page.locator('.zn-host').count();
      step('search narrows the host list', hits >= 1 && hits < hostCount, `${hits} of ${hostCount} hosts for "nas"`);
      await page.fill('#zn-search', '');
      await page.waitForTimeout(300);

      // ── Domain-Dialog ────────────────────────────────────────────────────
      const zoneRow = page.locator('.zn-zone').filter({ has: page.locator('.zn-domain', { hasText: FIXTURES.zone.domain }) }).first();
      await zoneRow.locator('.zn-edit-domain').click();
      const modalOpen = await page.waitForFunction(
        () => document.getElementById('zn-domain-modal') && document.getElementById('zn-domain-modal').style.display === 'flex',
        null, { timeout: 6000 }).then(() => true).catch(() => false);
      step('the domain dialog opens', modalOpen);
      if (modalOpen) {
        // .zn-newcard (das Formular „neuer Host“) trägt dieselbe Klasse — nur Karten
        // mit data-host-id sind echte Hosts.
        const cards = await page.locator('#zn-domain-modal .zn-hcard[data-host-id]').count();
        step('the dialog shows one card per host', cards === apiHosts, `${cards} cards`);
        const apexFirst = (await page.locator('#zn-domain-modal .zn-hcard[data-host-id]').first().textContent()).trim();
        step('the base domain host is shown as "@"', apexFirst.startsWith('@'), apexFirst.slice(0, 40));
        const entries = await page.locator('#zn-domain-modal .zn-pline[data-entry-id]').count();
        step('the entries of the hosts are drawn', entries >= 4, `${entries} entries`);
        await shot(page, 'zones-modal', false);
        await page.locator('#zn-domain-modal .zn-dm-close').click().catch(() => {});
        await page.waitForTimeout(250);
      }

      // ── Telefonbreite ────────────────────────────────────────────────────
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(BASE + '/routes');
      await waitIdle(page);
      await visible(page, '#zn-zones .zn-zone', 10000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      step('no horizontal overflow at 400px', overflow <= 1, `overflow ${overflow}px`);
      await shot(page, 'zones-phone', false);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  };
};
