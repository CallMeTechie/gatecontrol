'use strict';

// Einstellungen › Plugins › <plugin> › Einstellungen: the card "Zugriffsziele" (since 1.325.0,
// docs/plugins.md "Network"). A plugin with permissions.network.assignTargets assigns its targets
// on its own pages (window.GC.targets) — one place for them: the card leaves them out completely
// (no form, no list). Without the permission the card stays as before. A declared localDiscovery
// keeps its switch (the plugin cannot grant that itself).
//
// No mocks: the fixture plugin tests/fixtures/plugins/hello is packed three times under its own ids
// (unsigned — "Unsignierte Plugins erlauben" while the scenario runs, switched off again at its end)
// and installed through the real API:
//   tg-plain  homeTargets + localDiscovery, without assignTargets — the form as before
//   tg-own    the same with assignTargets — only the discovery switch is left on the card
//   tg-only   assignTargets without localDiscovery — no card at all
// Desktop and 390 px. The plugins are removed at the end.

const path = require('node:path');
const fs = require('node:fs');

module.exports = (ctx) => {
  const { BASE, step, shot, api } = ctx;
  const HELLO = path.join(__dirname, '..', '..', 'fixtures', 'plugins', 'hello');
  const base = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
  const until = (page, fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const net = base.permissions.network;
  const PLUGINS = [
    { id: 'tg-plain', name: 'Targets plain', network: net },
    { id: 'tg-own', name: 'Targets own', network: { ...net, assignTargets: true } },
    { id: 'tg-only', name: 'Targets only', network: { internet: net.internet, homeTargets: net.homeTargets, assignTargets: true } },
  ];

  async function install(page, x) {
    const { packDir } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'plugin-pack'));
    const buf = packDir(HELLO, { signingKey: '', overrides: {
      id: x.id, name: { de: x.name, en: x.name }, gatecontrol: '>=1.324.0',
      permissions: { ...base.permissions, network: x.network },
    } }).buffer;
    const csrf = await page.evaluate(() => window.GC && window.GC.csrfToken);
    const r = await page.request.fetch(BASE + '/api/v1/plugins/inspect', { method: 'POST', data: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf } });
    const ins = await r.json().catch(() => null);
    const done = ins && ins.token ? await api(page, 'POST', '/api/v1/plugins/install', { token: ins.token, accept: true }) : null;
    return !!done && done.status === 200;
  }

  // the settings tab of one plugin, once its settings form (below the card) is there
  async function settingsTab(page, id) {
    await page.goto(BASE + '/settings/plugins/manage/' + id + '?tab=settings');
    return until(page, () => !!document.getElementById('pg-settings-form'), null, 10000);
  }
  const card = (page) => page.evaluate(() => {
    const c = document.getElementById('pg-targets');
    if (!c) return null;
    return {
      rows: [...c.querySelectorAll('.pg-target[data-target]')].map((r) => r.getAttribute('data-target')),
      selects: c.querySelectorAll('select').length,
      intro: [...c.querySelectorAll('p.pgx-muted')].some((p) => /reaches only what you assign/.test(p.textContent)),
      discovery: !!c.querySelector('#pg-discovery'),
    };
  });

  return {
    async plugintargets(page) {
      await page.goto(BASE + '/dashboard');
      const pol = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: true, confirm: 'ALLOW' });
      try {
        let all = pol.status === 200;
        for (const x of PLUGINS) all = (await install(page, x)) && all;
        step('plugintargets: the three fixture plugins install (unsigned, allowed for the run)', all);

        // without the permission: as before — the form with every declared target
        step('plugintargets: without assignTargets the settings tab opens', await settingsTab(page, 'tg-plain'));
        let c = await card(page);
        step('plugintargets: without assignTargets the card shows the form of every target, as before',
          !!c && c.rows.join(',') === 'gateway,device' && c.selects > 0 && c.intro && c.discovery, JSON.stringify(c));

        // granted: the targets are managed on the plugin's own page only
        step('plugintargets: with assignTargets the settings tab opens', await settingsTab(page, 'tg-own'));
        c = await card(page);
        step('plugintargets: with assignTargets no target on the card — no form, no list, no intro',
          !!c && c.rows.length === 0 && c.selects === 0 && !c.intro, JSON.stringify(c));
        step('plugintargets: … the switch for local discovery stays (the plugin cannot grant it)', !!c && c.discovery, JSON.stringify(c));
        await shot(page, 'plugintargets-own');

        step('plugintargets: assignTargets without discovery: the settings tab opens', await settingsTab(page, 'tg-only'));
        step('plugintargets: … no card "Access targets" at all', (await card(page)) === null
          && await page.evaluate(() => !/Access targets/.test(document.getElementById('pg-panel').textContent)));
        const api1 = await api(page, 'GET', '/api/v1/plugins/tg-only/page-targets');
        step('plugintargets: … the plugin\'s page assigns them (GC.targets: page-targets answers)', api1.status === 200 && !!api1.body
          && api1.body.targets.map((x) => x.id).join(',') === 'gateway,device', String(api1.status));

        // 390 px: the same, nothing sideways
        await page.setViewportSize({ width: 390, height: 844 });
        await settingsTab(page, 'tg-own');
        c = await card(page);
        step('plugintargets: 390 px: only the discovery switch, no sideways scroll', !!c && c.rows.length === 0 && c.discovery && (await overflow(page)) <= 1, JSON.stringify(c));
        await shot(page, 'plugintargets-own-390');
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        let ok = true;
        for (const x of PLUGINS) {
          const rm = await api(page, 'POST', '/api/v1/plugins/' + x.id + '/uninstall', { mode: 'wipe', confirm: x.name });
          ok = ok && rm.status === 200;
        }
        const off = await api(page, 'PUT', '/api/v1/plugins/policy', { allowUnsigned: false });
        step('plugintargets: plugins removed, unsigned off again', ok && off.status === 200, String(off.status));
      }
    },
  };
};
