'use strict';

// Since 1.241.0 (docs/plugins.md "Handbook", "Setup notices"):
//   plugin.json `handbook` { de, en } — Markdown files of the package, rendered
//   safely on the server (services/plugins/markdown.js) for the tab "Handbuch"
//   and GET /api/v1/plugins/:id/handbook?lang=
//   plugin.json `setupNotices` — steps outside GateControl after an install or
//   update (manual | gatewayService | gatewayVersion | hostVersion), banner,
//   list badge, dashboard notice, "Erledigt" stored (migration 137) + activity log.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handbookPackage, helloPackage, HANDBOOK_DEMO, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const md = require('../src/services/plugins/markdown');
const manifest = require('../src/services/plugins/manifest');

let agent, csrf, db, plugins, notices, gateways, gf;
const API = '/api/v1/plugins';
const demo = JSON.parse(fs.readFileSync(path.join(HANDBOOK_DEMO, 'plugin.json'), 'utf8'));
const hello = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const FILES = new Set(['server/index.js', 'HANDBUCH.md', 'HANDBOOK.md']);

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

function setTel(g, { version = '1.28.0', cams = null } = {}) {
  const t = { gateway_version: version, capabilities: ['cameras'], hardware: { model: 'DS918+' }, features: cams ? { cameras: cams } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ?, platform = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), 'synology', g.peer.id);
  notices.resetCache();
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  plugins = require('../src/services/plugins');
  notices = require('../src/services/plugins/setupNotices');
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gf = require('../src/services/gatewayFeatures');
  db = require('../src/db/connection').getDb();
  await install(handbookPackage());
  await install(helloPackage());
});
after(async () => { await plugins.stop(); teardown(); });

describe('plugin.json handbook', () => {
  const check = (mut, files = FILES, sizes) => { const m = clone(demo); mut(m); return manifest.validate(m, { files, sizes }); };

  it('{ de, en } of .md files in the package, at most 256 KB each', () => {
    const ok = check(() => {});
    assert.equal(ok.ok, true, ok.errors.join(', '));
    assert.deepEqual(ok.manifest.handbook, { de: 'HANDBUCH.md', en: 'HANDBOOK.md' });
    assert.deepEqual(check((m) => { m.handbook = { en: 'HANDBOOK.md' }; }).manifest.handbook, { en: 'HANDBOOK.md' }, 'one language is enough');
    assert.deepEqual(check((m) => { m.handbook = { de: 'HANDBUCH.md', fr: 'MANUEL.md' }; }).manifest.handbook, { de: 'HANDBUCH.md' }, 'a later language is ignored');
    assert.deepEqual(check(() => {}, new Set(['server/index.js', 'HANDBOOK.md'])).errors, ['handbook.de: missing']);
    assert.deepEqual(check(() => {}, FILES, new Map([['HANDBUCH.md', manifest.HANDBOOK_MAX_BYTES + 1]])).errors, ['handbook.de: too large']);
    assert.equal(manifest.HANDBOOK_MAX_BYTES, 256 * 1024);
    for (const v of ['HANDBUCH.md', [], {}, { de: '../x.md' }, { de: '/etc/passwd' }, { de: 'HANDBUCH.txt' }, { de: 3 }]) {
      assert.equal(check((m) => { m.handbook = v; }).ok, false, JSON.stringify(v));
    }
    const plain = manifest.validate(clone(hello));
    assert.equal(plain.manifest.handbook, null);
    assert.deepEqual(plain.manifest.setupNotices, []);
  });
});

describe('plugin.json setupNotices', () => {
  const check = (mut) => { const m = clone(demo); mut(m.setupNotices, m); return manifest.validate(m, { files: FILES }); };

  it('ids, since, texts and checks are checked; an unknown check type is a manual one', () => {
    const ok = check(() => {});
    assert.equal(ok.ok, true, ok.errors.join(', '));
    assert.deepEqual(ok.manifest.setupNotices.map((n) => [n.id, n.check.type]),
      [['cameras-compose', 'gatewayService'], ['camera-settings', 'manual'], ['later-step', 'manual'], ['host-new', 'hostVersion']]);
    assert.deepEqual(ok.manifest.setupNotices[0].check, { type: 'gatewayService', feature: 'cameras', service: 'kameras' });
    assert.deepEqual(ok.manifest.setupNotices[0].handbook, { de: 'kameras-einrichten', en: 'setting-up-cameras' });
    assert.deepEqual(ok.manifest.setupNotices[1].handbook, { de: 'kamera-einstellungen', en: 'kamera-einstellungen' }, 'a string: both languages');
    assert.deepEqual(check((l) => { l[0].handbook = { de: 'nur-de' }; }).manifest.setupNotices[0].handbook, { de: 'nur-de', en: 'nur-de' });
    assert.deepEqual(ok.manifest.setupNotices[2].title, { de: 'Erst ab 2.0.0', en: 'Erst ab 2.0.0' }, 'a plain string for both languages');
    const future = check((l) => { l[1].check = { type: 'cloudThing', x: 1 }; });
    assert.equal(future.ok, true);
    assert.deepEqual(future.manifest.setupNotices[1].check, { type: 'manual', declared: 'cloudThing' });
    assert.deepEqual(check((l) => { l[0].check = { type: 'gatewayVersion', min: '1.28.0', feature: 'cameras' }; }).manifest.setupNotices[0].check,
      { type: 'gatewayVersion', min: '1.28.0', feature: 'cameras' });
    assert.deepEqual(check((l, m) => { delete m.handbook; }).ok, true);
    assert.equal(check((l, m) => { delete m.handbook; }).manifest.setupNotices[0].handbook, null, 'no handbook: nothing to open');
  });

  it('refuses what is broken', () => {
    const bad = [
      (l) => { l[1].id = l[0].id; },
      (l) => { l[0].id = 'Kameras Compose'; },
      (l) => { l[0].since = '1.6'; },
      (l) => { l[0].title = ''; },
      (l) => { l[0].text = { de: 'x'.repeat(manifest.NOTICE_TEXT_MAX + 1) }; },
      (l) => { l[0].title = 'x'.repeat(manifest.NOTICE_TITLE_MAX + 1); },
      (l) => { l[0].handbook = '#kameras'; },
      (l) => { l[0].handbook = { de: 'Bad Anchor' }; },
      (l) => { l[0].handbook = {}; },
      (l) => { l[0].check = { type: 'gatewayService', feature: 'cameras' }; },
      (l) => { l[0].check = { type: 'hostVersion' }; },
      (l) => { l[0].check = { type: 'gatewayVersion', min: 'neu' }; },
      (l) => { l[0].check = 'manual'; },
      (l) => { l.push(...Array.from({ length: manifest.NOTICES_MAX }, (_, i) => ({ ...l[1], id: 'n' + i }))); },
      (l, m) => { m.setupNotices = {}; },
    ];
    bad.forEach((mut, i) => assert.equal(check(mut).ok, false, 'case ' + i));
  });
});

describe('markdown renderer', () => {
  const html = (s) => md.render(s).html;

  it('escapes every bit of HTML of the source', () => {
    const attacks = [
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://evil.example"></iframe>',
      '<svg onload=alert(1)>', '"><script>x</script>', '<style>body{}</style>', '<div onclick="x">', '&lt;script&gt;',
    ];
    for (const a of attacks) {
      for (const s of [a, '# ' + a, '- ' + a, '> ' + a, '| a |\n|---|\n| ' + a + ' |', '**' + a + '**', '`' + a + '`', '```\n' + a + '\n```', '[' + a + '](https://x.example)']) {
        const out = html(s);
        assert.doesNotMatch(out, /<(script|img|iframe|svg|style|div onclick)/i, s);
        assert.doesNotMatch(out, /<[a-z][^>]*\son\w+=/i, s);
      }
    }
    assert.match(html('<b>fett</b>'), /&lt;b&gt;fett&lt;\/b&gt;/);
    assert.equal(html('a & b'), '<p>a &amp; b</p>');
  });

  it('links: only https:// (new tab, rel noopener) and anchors; everything else stays text', () => {
    assert.equal(html('[GateControl](https://callmetechie.de/docs?a=1&b=2)'),
      '<p><a href="https://callmetechie.de/docs?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">GateControl</a></p>');
    assert.equal(html('[oben](#was-das-plugin-kann)'), '<p><a href="#was-das-plugin-kann" data-hb-anchor="was-das-plugin-kann">oben</a></p>');
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'http://x.example', '//evil.example', 'data:text/html,x', 'vbscript:x', 'https://user:pw@x.example', '#Bad Anchor', 'mailto:a@b.c', 'ftp://x', '/relative']) {
      const out = html(`[klick](${u})`);
      assert.doesNotMatch(out, /<a /, u);
      assert.match(out, /klick/, u);
    }
    assert.match(html('<https://x.example/a>'), /<a href="https:\/\/x.example\/a" target="_blank" rel="noopener noreferrer">/);
    assert.match(html('[Wiki](https://de.wikipedia.org/wiki/A_(B))'), /href="https:\/\/de.wikipedia.org\/wiki\/A_\(B\)"/);
    assert.equal(html('![Bild](https://x.example/a.png)'), '<p>Bild</p>', 'no images (yet): the alt text');
    assert.match(html('[x](https://a.example/"onmouseover=y)'), /href="https:\/\/a.example\/%22onmouseover=y"/);
  });

  it('headings get anchors (German transliteration, unique) and form the TOC', () => {
    const r = md.render('<!-- version: 1.6.0 -->\n# Größe & Übung\n## Häufige Fragen / Fehlersuche\n## Häufige Fragen / Fehlersuche\n### Neu in 1.6.0\n#### Tief\n## `code` und **fett**');
    assert.equal(r.version, '1.6.0');
    assert.deepEqual(r.toc, [
      { level: 1, text: 'Größe & Übung', anchor: 'groesse-uebung' },
      { level: 2, text: 'Häufige Fragen / Fehlersuche', anchor: 'haeufige-fragen-fehlersuche' },
      { level: 2, text: 'Häufige Fragen / Fehlersuche', anchor: 'haeufige-fragen-fehlersuche-2' },
      { level: 3, text: 'Neu in 1.6.0', anchor: 'neu-in-1-6-0' },
      { level: 2, text: 'code und fett', anchor: 'code-und-fett' },
    ]);
    assert.match(r.html, /<h2 id="hb-groesse-uebung" class="hb-h">Größe &amp; Übung<\/h2>/);
    assert.match(r.html, /<h5 id="hb-tief" class="hb-h">Tief<\/h5>/);
    assert.doesNotMatch(r.html, /version/, 'the version comment is dropped');
    assert.equal(md.slugify('Straße — Zürich, Ça va?'), 'strasse-zuerich-ca-va');
    assert.equal(md.slugify('Kameras einrichten'), 'kameras-einrichten');
    assert.deepEqual(md.render('## Camera settings {#kamera-einstellungen}\n## Kaputt {#Nicht Gut}').toc.map((x) => [x.text, x.anchor]),
      [['Camera settings', 'kamera-einstellungen'], ['Kaputt {#Nicht Gut}', 'kaputt-nicht-gut']]);
  });

  it('lists, notes, code, tables, emphasis', () => {
    assert.equal(html('- eins\n- zwei\n  - drei\n- vier\n  weiter'), '<ul><li>eins</li><li>zwei<ul><li>drei</li></ul></li><li>vier weiter</li></ul>');
    assert.equal(html('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
    assert.equal(html('> **Hinweis:** Text'), '<blockquote class="hb-note" data-tone="info"><p><strong>Hinweis:</strong> Text</p></blockquote>');
    assert.match(html('> **Achtung:** heiß'), /data-tone="warn"/);
    assert.equal(html('```bash\necho "<b>" && ls\n```'), '<pre class="hb-code"><code>echo &quot;&lt;b&gt;&quot; &amp;&amp; ls</code></pre>');
    assert.equal(html('| A | B | C |\n|:--|:-:|--:|\n| 1 | `x\\|y` | 3 |'),
      '<div class="hb-table"><table><thead><tr><th>A</th><th class="hb-al-c">B</th><th class="hb-al-r">C</th></tr></thead>'
      + '<tbody><tr><td>1</td><td class="hb-al-c"><code>x|y</code></td><td class="hb-al-r">3</td></tr></tbody></table></div>');
    assert.equal(html('**fett** *kursiv* _auch_ snake_case `a*b*c`'), '<p><strong>fett</strong> <em>kursiv</em> <em>auch</em> snake_case <code>a*b*c</code></p>');
    assert.equal(html('Zeile  \nzwei'), '<p>Zeile<br>zwei</p>');
    assert.equal(html('---'), '<hr>');
    assert.equal(html('<!--\nmehrere\nZeilen\n-->\nText'), '<p>Text</p>');
  });

  it('stays fast on hostile input', () => {
    const t = Date.now();
    for (const s of ['['.repeat(100000), '*a'.repeat(50000), '`'.repeat(60000) + 'x', '> '.repeat(30000) + 'x', '_a '.repeat(50000), ('- x\n  ').repeat(20000), '|'.repeat(50000) + '\n' + '-|'.repeat(25000)]) md.render(s);
    assert.ok(Date.now() - t < 5000, 'took ' + (Date.now() - t) + ' ms');
  });
});

describe('GET /api/v1/plugins/:id/handbook', () => {
  it('the handbook of the installed package in the language asked for', async () => {
    const r = (await agent.get(API + '/handbook-demo/handbook?lang=de').expect(200)).body;
    assert.equal(r.version, '1.6.0');
    assert.equal(r.handbookVersion, '1.6.0');
    assert.equal(r.lang, 'de');
    assert.deepEqual(r.toc.map((x) => x.anchor), ['handbuch-demo', 'was-das-plugin-kann', 'voraussetzungen', 'kameras-einrichten', 'kamera-einstellungen', 'haeufige-fragen', 'neu-in-1-6-0']);
    assert.match(r.html, /<h3 id="hb-kameras-einrichten" class="hb-h">Kameras einrichten<\/h3>/);
    assert.match(r.html, /<a href="#kameras-einrichten" data-hb-anchor="kameras-einrichten">/);
    assert.match(r.html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
    assert.doesNotMatch(r.html, /javascript:/);
    const en = (await agent.get(API + '/handbook-demo/handbook?lang=en').expect(200)).body;
    assert.equal(en.lang, 'en');
    assert.match(en.html, /id="hb-setting-up-cameras"/);
    assert.match(en.html, /<h4 id="hb-kamera-einstellungen" class="hb-h">Camera settings<\/h4>/, 'an explicit {#anchor}');
    assert.equal((await agent.get(API + '/handbook-demo/handbook?lang=fr').expect(200)).body.lang, 'en', 'an unknown language: the page language (English here)');
  });

  it('only German in the package: German for an English page too', async () => {
    await install(handbookPackage({ overrides: { id: 'handbook-de', handbook: { de: 'HANDBUCH.md' }, setupNotices: [] } }));
    const r = (await agent.get(API + '/handbook-de/handbook?lang=en').expect(200)).body;
    assert.equal(r.lang, 'de');
  });

  it('a plugin without a handbook: 404 and no tab', async () => {
    const r = await agent.get(API + '/hello/handbook').expect(404);
    assert.equal(r.body.code, 'no_handbook');
    await agent.get(API + '/nope/handbook').expect(404);
    const list = (await agent.get(API).expect(200)).body.plugins;
    assert.equal(list.find((p) => p.id === 'hello').handbook, false);
    assert.equal(list.find((p) => p.id === 'handbook-demo').handbook, true);
  });
});

describe('setup notices', () => {
  let gw, gw2;
  const openIds = () => notices.open(plugins.get('handbook-demo'), 'de').map((n) => n.id);

  it('only those of the installed version (since); a met check hides the notice', async () => {
    const all = (await agent.get(API + '/handbook-demo/notices').expect(200)).body.notices;
    assert.deepEqual(all.map((n) => [n.id, n.state]), [['cameras-compose', 'open'], ['camera-settings', 'open'], ['host-new', 'done']], 'later-step (since 2.0.0) is not there yet');
    assert.equal(all[0].title, 'Cameras: renew the compose file', 'in the language of the page');
    assert.equal(all[0].handbook, 'setting-up-cameras', 'the anchor of the English handbook');
    assert.equal(all[1].handbook, 'kamera-einstellungen', 'one anchor for both languages');
    assert.equal(notices.all(plugins.get('handbook-demo'), 'de')[0].handbook, 'kameras-einrichten');
    const v = (await agent.get(API).expect(200)).body.plugins.find((p) => p.id === 'handbook-demo');
    assert.deepEqual(v.notices.map((n) => n.id), ['cameras-compose', 'camera-settings']);
    assert.deepEqual((await agent.get(API).expect(200)).body.plugins.find((p) => p.id === 'hello').notices, []);
  });

  it('gatewayService: open while a gateway has the feature on without the service, done once it runs', async () => {
    gw = await gateways.createGateway({ name: 'DS918 Keller' });
    gw2 = await gateways.createGateway({ name: 'Pi Garten' });
    setTel(gw, { cams: { enabled: false, service: 'missing', state: 'off' } });
    setTel(gw2, { version: '1.26.0' });
    assert.deepEqual(openIds(), ['cameras-compose', 'camera-settings'], 'no gateway with cameras: still to do');
    gf.set(gw.peer.id, { cameras: { enabled: true } });
    setTel(gw, { cams: { enabled: true, service: 'missing', state: 'service_missing' } });
    const n = notices.open(plugins.get('handbook-demo'), 'en').find((x) => x.id === 'cameras-compose');
    assert.equal(n.title, 'Cameras: renew the compose file');
    assert.deepEqual(n.gateways.map((g) => [g.name, g.compose, g.platform]), [['DS918 Keller', true, 'synology']]);
    setTel(gw, { cams: { enabled: true, service: 'managed', state: 'running' } });
    assert.deepEqual(openIds(), ['camera-settings'], 'the service runs: done by itself');
    db.prepare("UPDATE gateway_meta SET platform = 'rpi' WHERE peer_id = ?").run(gw.peer.id);
    setTel(gw, { cams: { enabled: true, service: 'absent', state: 'service_missing' } });
    db.prepare("UPDATE gateway_meta SET platform = 'rpi' WHERE peer_id = ?").run(gw.peer.id);
    notices.resetCache();
    assert.equal(notices.open(plugins.get('handbook-demo'), 'de').find((x) => x.id === 'cameras-compose').gateways[0].compose, false, 'a Pi image: no compose file');
    setTel(gw, { cams: { enabled: true, service: 'managed', state: 'running' } });
  });

  it('gatewayVersion and hostVersion', () => {
    const gws = notices.gateways();
    assert.deepEqual(notices.evaluateCheck({ type: 'gatewayVersion', min: '1.28.0' }, gws).gateways.map((g) => g.name), ['Pi Garten']);
    assert.equal(notices.evaluateCheck({ type: 'gatewayVersion', min: '1.28.0', feature: 'cameras' }, gws).met, true, 'only gateways with the feature');
    assert.equal(notices.evaluateCheck({ type: 'gatewayVersion', min: '1.29.0', feature: 'cameras' }, gws).met, false);
    assert.equal(notices.evaluateCheck({ type: 'hostVersion', min: '1.0.0' }, gws).met, true);
    assert.equal(notices.evaluateCheck({ type: 'hostVersion', min: '99.0.0' }, gws).met, false);
    assert.equal(notices.evaluateCheck({ type: 'manual' }, gws).met, false);
  });

  it('the dashboard says "Plugins brauchen deine Hilfe"', async () => {
    const html = (await agent.get('/dashboard').expect(200)).text;
    assert.match(html, /id="db-plugin-setup"/);
    assert.match(html, /Plugins need your help/);
    assert.match(html, /href="\/settings\/plugins\/manage\/handbook-demo">Manual demo<\/a> — Check the camera settings/);
    assert.equal(notices.summary('de')[0].name, 'Handbuch-Demo');
  });

  it('"Erledigt": stored with person and time, in the activity log; the notice is gone', async () => {
    const r = (await agent.post(API + '/handbook-demo/notices/camera-settings/ack').set('X-CSRF-Token', csrf).send({}).expect(200)).body;
    assert.equal(r.notices.find((n) => n.id === 'camera-settings').state, 'acked');
    assert.ok(r.notices.find((n) => n.id === 'camera-settings').ack.by);
    assert.deepEqual(r.plugin.notices, []);
    const row = db.prepare("SELECT * FROM plugin_notice_acks WHERE plugin_id = 'handbook-demo' AND notice_id = 'camera-settings'").get();
    assert.equal(row.plugin_version, '1.6.0');
    assert.ok(row.acked_at > 0 && row.acked_by);
    const log = db.prepare("SELECT * FROM activity_log WHERE event_type = 'plugin_notice_done' ORDER BY id DESC LIMIT 1").get();
    assert.match(log.message, /Kamera-Einstellungen prüfen/);
    assert.equal(JSON.parse(log.details).notice, 'camera-settings');
    await agent.post(API + '/handbook-demo/notices/later-step/ack').set('X-CSRF-Token', csrf).send({}).expect(404);
    await agent.post(API + '/handbook-demo/notices/Nope!/ack').set('X-CSRF-Token', csrf).send({}).expect(404);
    assert.doesNotMatch((await agent.get('/dashboard').expect(200)).text, /id="db-plugin-setup"/);
  });

  it('an acked notice stays done although its check fails again; "Alles löschen" forgets the acks', async () => {
    await agent.post(API + '/handbook-demo/notices/cameras-compose/ack').set('X-CSRF-Token', csrf).send({}).expect(200);
    setTel(gw, { cams: { enabled: true, service: 'missing', state: 'service_missing' } });
    assert.deepEqual(openIds(), []);
    notices.forget('handbook-demo');
    assert.deepEqual(openIds(), ['cameras-compose', 'camera-settings']);
  });

  it('an update to a version ≥ since brings the later notice', async () => {
    await install(handbookPackage({ overrides: { version: '2.0.0' } }));
    assert.deepEqual(openIds(), ['cameras-compose', 'camera-settings', 'later-step']);
  });
});
