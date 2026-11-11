'use strict';

// "Versionen" and "Handbuch" of a gateway (#gw/<id>/versions, #gw/<id>/handbook):
//   services/gatewayReleaseNotes.js — the release notes of the gateway repository
//     (GitHub releases, cached in memory and next to the database, offline-safe),
//     GET /api/v1/gateways/releases
//   services/gatewayHandbook.js — the gateway chapters (3–7) of docs/handbuch and
//     docs/guide as one document through the safe renderer of the plugin handbooks,
//     GET /api/v1/gateways/handbook
//   public/js/gateway-docs-kit.js — addresses, the installed version and the newer ones

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const notes = require('../src/services/gatewayReleaseNotes');
const hbook = require('../src/services/gatewayHandbook');
const md = require('../src/services/plugins/markdown');
const kit = require('../public/js/gateway-docs-kit');
const guide = require('../public/js/handbook');

const REL = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
function release(v, body, extra) {
  return { tag_name: 'v' + v, name: 'v' + v, draft: false, prerelease: false, published_at: '2026-11-07T17:13:47Z', html_url: `${REL}/tag/v${v}`, body, ...(extra || {}) };
}
const BODY = "## What's Changed\n* feat(radio): Funksticks von Hand zuordnen by @CallMeTechie in https://github.com/CallMeTechie/gatecontrol-gateway/pull/51\n"
  + '* fix(print): Office-Image im Release by @dependabot[bot] in https://github.com/CallMeTechie/gatecontrol-gateway/pull/52\n\n'
  + '## New Contributors\n* @someone made their first contribution in https://github.com/CallMeTechie/gatecontrol-gateway/pull/9\n\n'
  + '**Full Changelog**: https://github.com/CallMeTechie/gatecontrol-gateway/compare/v1.33.1...v1.34.0';

function answer(list, extra) {
  return () => Promise.resolve({ status: 200, headers: { etag: '"abc"', ...(extra || {}) }, body: JSON.stringify(list) });
}

describe('gateway release notes (services/gatewayReleaseNotes.js)', () => {
  beforeEach(() => { notes._reset(); notes._setTransport(null); try { fs.unlinkSync(notes.PERSIST_FILE); } catch (_) { /* none */ } });
  after(() => { notes._setTransport(null); notes._reset(); });

  it('cleans a GitHub release body to the list of changes', () => {
    assert.equal(notes.cleanNotes(BODY), '- Funksticks von Hand zuordnen (#51)\n- Office-Image im Release (#52)');
    assert.equal(notes.cleanNotes(''), '');
    // anything else stays as written (it is rendered as text on the page)
    assert.equal(notes.cleanNotes('### Fixed\n- <img src=x onerror=alert(1)> `x`'), '### Fixed\n- <img src=x onerror=alert(1)> `x`');
    assert.ok(notes.cleanNotes('- x\n'.repeat(5000)).length <= 8000);
  });

  it('parses the releases: no drafts, pre-releases or odd tags; newest first; only addresses of the releases page', () => {
    const list = notes.parse([
      release('1.33.1', BODY), release('1.34.0', BODY), release('1.34.1', null),
      release('1.35.0', 'x', { draft: true }), release('1.36.0-rc.1', 'x'), release('1.37.0', 'x', { prerelease: true }),
      { tag_name: 'nightly' }, null, 'x',
      release('1.30.0', 'x', { html_url: 'javascript:alert(1)' }),
      release('1.34.0', 'duplicate'),
    ]);
    assert.deepEqual(list.map((v) => v.version), ['1.34.1', '1.34.0', '1.33.1', '1.30.0']);
    assert.equal(list[0].notes, null);
    assert.equal(list[1].notes, '- Funksticks von Hand zuordnen (#51)\n- Office-Image im Release (#52)');
    assert.equal(list[1].published_at, '2026-11-07T17:13:47.000Z');
    assert.equal(list[3].url, `${REL}/tag/v1.30.0`);
    assert.throws(() => notes.parse({}), /not a list/);
  });

  it('without GitHub (tests never reach it): not available, no error thrown', async () => {
    const r = await notes.list();
    assert.equal(r.available, false);
    assert.equal(r.stale, true);
    assert.deepEqual(r.versions, []);
  });

  it('loads once, keeps the list (file next to the database), checks again only when old; offline → the last list, stale', async () => {
    let calls = 0;
    let headers = null;
    notes._setTransport((url, h) => { calls++; headers = h; assert.match(url, /^https:\/\/api\.github\.com\/repos\/CallMeTechie\/gatecontrol-gateway\/releases\?per_page=60$/); return answer([release('1.34.0', BODY), release('1.33.1', 'x')])(); });
    const a = await notes.list();
    assert.equal(calls, 1);
    assert.equal(a.available, true);
    assert.equal(a.stale, false);
    assert.deepEqual(a.versions.map((v) => v.version), ['1.34.0', '1.33.1']);
    assert.equal(headers['User-Agent'], 'GateControl');
    assert.equal(headers['If-None-Match'], undefined);
    // persisted, read back as written
    const stored = notes._load();
    assert.deepEqual(stored.versions, a.versions);
    assert.equal(stored.etag, '"abc"');
    // fresh: no second request, also "Neu laden" within a minute is not a request
    await notes.list();
    await notes.list({ refresh: true });
    assert.equal(calls, 1);
    // old (and the minute is over): asks again with the ETag; a 304 keeps the list
    notes._reset({ versions: a.versions, fetchedAt: Date.now() - 7 * 3600 * 1000, etag: '"abc"', attemptAt: Date.now() - 2 * 3600 * 1000 });
    notes._setTransport((url, h) => { calls++; headers = h; return Promise.resolve({ status: 304, headers: {}, body: null }); });
    const b = await notes.list({ refresh: true });
    assert.equal(calls, 2);
    assert.equal(headers['If-None-Match'], '"abc"');
    assert.equal(b.stale, false);
    assert.equal(b.versions.length, 2);
    // GitHub gone: the last list, marked stale
    notes._reset({ versions: a.versions, fetchedAt: Date.now() - 7 * 3600 * 1000, attemptAt: 0 });
    notes._setTransport(() => { calls++; return Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'releases_unreachable' })); });
    const c = await notes.list({ refresh: true });
    assert.equal(calls, 3);
    assert.equal(c.available, true);
    assert.equal(c.stale, true);
    assert.equal(c.versions.length, 2);
    // a rate limit (403) or a broken answer is the same
    notes._reset({ versions: a.versions, fetchedAt: 1, attemptAt: 0 });
    notes._setTransport(() => Promise.resolve({ status: 403, headers: {}, body: null }));
    assert.equal((await notes.list({ refresh: true })).stale, true);
    notes._reset({ versions: a.versions, fetchedAt: 1, attemptAt: 0 });
    notes._setTransport(() => Promise.resolve({ status: 200, headers: {}, body: '<html>' }));
    const d = await notes.list({ refresh: true });
    assert.equal(d.stale, true);
    assert.equal(d.versions.length, 2);
  });

  it('with a list in hand an old cache answers at once and checks in the background', async () => {
    let release0;
    notes._reset({ versions: notes.parse([release('1.33.1', 'x')]), fetchedAt: Date.now() - 7 * 3600 * 1000 });
    notes._setTransport(() => new Promise((res) => { release0 = res; }));
    const r = await notes.list();
    assert.deepEqual(r.versions.map((v) => v.version), ['1.33.1']);
    release0({ status: 200, headers: {}, body: JSON.stringify([release('1.34.0', 'y'), release('1.33.1', 'x')]) });
    await new Promise((res) => setImmediate(res));
    assert.deepEqual((await notes.list()).versions.map((v) => v.version), ['1.34.0', '1.33.1']);
  });

  it('a stored file with foreign addresses or bad entries is filtered', () => {
    fs.writeFileSync(notes.PERSIST_FILE, JSON.stringify({ versions: [{ version: '1.2.3', notes: 'a', url: 'https://evil.example/x' }, { version: '1.2.4', notes: 'b', url: `${REL}/tag/v1.2.4` }, { version: '<x>', notes: null, url: REL }], fetchedAt: 5 }));
    assert.deepEqual(notes._load().versions.map((v) => v.version), ['1.2.4']);
  });
});

describe('gateway handbook (services/gatewayHandbook.js)', () => {
  for (const lang of ['de', 'en']) {
    it(`${lang}: chapters 3–7 as one document with a table of contents`, () => {
      hbook._clear();
      const r = hbook.get(lang);
      assert.equal(r.lang, lang);
      assert.deepEqual(r.chapters.map((c) => c.file.slice(0, 3)), ['03-', '04-', '05-', '06-', '07-']);
      assert.deepEqual(r.toc.filter((x) => x.level === 1).map((x) => x.text.slice(0, 2)), ['3.', '4.', '5.', '6.', '7.']);
      assert.ok(r.toc.every((x) => x.level <= 2));
      assert.ok(r.chapters.every((c) => c.url.startsWith(guide.BASE + guide.DIRS[lang])));
      // nothing but the renderer's own elements; no relative link, no nav line under the chapter titles
      assert.doesNotMatch(r.html, /<script|<iframe|<img|\son\w+=|javascript:/i);
      const hrefs = [...r.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      assert.ok(hrefs.length > 20);
      assert.ok(hrefs.every((h) => h.startsWith('#') || h.startsWith('https://')), hrefs.filter((h) => !h.startsWith('#') && !h.startsWith('https://')).join(' '));
      assert.ok(!hrefs.some((h) => /README\.md$/.test(h)), 'the nav lines are dropped');
      // every in-app link has its heading
      for (const h of hrefs.filter((x) => x.startsWith('#'))) assert.ok(r.html.includes(`id="hb-${h.slice(1)}"`), 'missing heading for ' + h);
      // links to chapters outside the gateway part → the guide on GitHub
      assert.ok(hrefs.some((h) => h.startsWith(guide.BASE + guide.DIRS[lang] + '02-')));
    });

    it(`${lang}: every chapter file maps to its heading`, () => {
      const r = hbook.get(lang);
      for (const c of r.chapters) assert.ok(c.anchor && r.html.includes(`id="hb-${c.anchor}"`), c.file);
    });
  }

  it('every help topic of the page (public/js/handbook.js) has its heading in the in-app handbook, in both languages', () => {
    for (const lang of ['de', 'en']) {
      const map = hbook.topicAnchors(lang);
      const html = hbook.get(lang).html;
      for (const topic of Object.keys(guide.TOPICS)) {
        if (topic === 'index') { assert.equal(map.index, undefined, 'the overview is not part of the gateway chapters'); continue; }
        assert.match(String(map[topic]), kit.SLUG_RE, `${lang} ${topic}`);
        assert.ok(html.includes(`id="hb-${map[topic]}"`), `${lang} ${topic} → #${map[topic]} is a heading of the handbook`);
      }
    }
    assert.equal(hbook.topicAnchors('de')['gw.rpi'], '3-3-raspberry-pi');
    assert.equal(hbook.topicAnchors('en')['feat.print'], hbook.get('en').anchors['05-features.md#print--scan']);
  });

  it('a link between the chapters becomes the in-app anchor', () => {
    const r = hbook.get('de');
    // 03 → "05-funktionen.md#zwischenspeicher"
    assert.match(r.html, /href="#zwischenspeicher" data-hb-anchor="zwischenspeicher"/);
    // 07-faq.md#der-server-läuft-in-utc (GitHub keeps the umlaut, the renderer transliterates)
    assert.equal(r.anchors['07-faq.md#der-server-läuft-in-utc'], 'der-server-laeuft-in-utc');
    assert.equal(hbook.get('xx').lang, 'de');
  });

  it('GitHub anchors as tests/handbook_docs.test.js derives them; code is left alone', () => {
    const gh = hbook._githubSlugger();
    assert.equal(gh('3.3 Raspberry Pi'), '33-raspberry-pi');
    assert.equal(gh('Drucken & Scannen'), 'drucken--scannen');
    assert.equal(gh('Warum die Zeitzone in die `.env`?'), 'warum-die-zeitzone-in-die-env');
    assert.equal(gh('Gateway offline'), 'gateway-offline');
    assert.equal(gh('Gateway offline'), 'gateway-offline-1');
    const out = hbook._rewriteLinks('[a](x.md) `[b](x.md)`\n```\n[c](x.md)\n```\n[d](#y)', () => '#z');
    assert.equal(out, '[a](#z) `[b](x.md)`\n```\n[c](x.md)\n```\n[d](#z)');
    assert.equal(hbook._dropNav('# T\n\n[← A](02-a.md) · [Inhalt](README.md) · [Weiter →](04-b.md)\n\nText'), '# T\n\n\nText');
  });

  it('markdown.render lists the headings only when asked (the plugin handbooks stay as they were)', () => {
    assert.equal(md.render('# A\n## B').heads, undefined);
    assert.deepEqual(md.render('# A\n#### B', { heads: true }).heads, [{ level: 1, source: 'A', anchor: 'a' }, { level: 4, source: 'B', anchor: 'b' }]);
  });

  it('the image keeps the user guide (.dockerignore)', () => {
    const di = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
    assert.ok(di.includes('!docs/handbuch/*.md') && di.includes('!docs/guide/*.md'));
    assert.ok(!di.includes('docs') && !di.includes('docs/') && !di.includes('**/*.md'));
  });
});

describe('gateway docs kit (public/js/gateway-docs-kit.js)', () => {
  it('addresses', () => {
    assert.deepEqual(kit.parseHash('#gw/7/versions'), { id: '7', view: 'versions', target: null });
    assert.deepEqual(kit.parseHash('#gw/7/handbook'), { id: '7', view: 'handbook', target: null });
    assert.deepEqual(kit.parseHash('#gw/7/handbook/3-3-raspberry-pi'), { id: '7', view: 'handbook', target: '3-3-raspberry-pi' });
    assert.deepEqual(kit.parseHash('#gw/7/handbook/%3Cscript%3E'), { id: '7', view: 'handbook', target: null });
    assert.deepEqual(kit.parseHash('#gw/a%20b/versions'), { id: 'a b', view: 'versions', target: null });
    assert.equal(kit.parseHash('#gw/%E0%A4%A/versions'), null);
    assert.equal(kit.parseHash('#gw/7/versions/1.2.3'), null);
    assert.equal(kit.parseHash('#gw/7'), null);
    assert.equal(kit.parseHash('#gw/7/net'), null);
    assert.equal(kit.parseHash('#versions'), null);
    assert.equal(kit.versionsHash(7), '#gw/7/versions');
    assert.equal(kit.versionsHash('a b'), '#gw/a%20b/versions');
    assert.equal(kit.handbookHash(7), '#gw/7/handbook');
    assert.equal(kit.handbookHash(7, '3-3-raspberry-pi'), '#gw/7/handbook/3-3-raspberry-pi');
    assert.equal(kit.handbookHash(7, '<x>'), '#gw/7/handbook');
  });

  it('versions: clean, compare, installed / newer / older', () => {
    assert.equal(kit.cleanVersion('v1.34.0'), '1.34.0');
    assert.equal(kit.cleanVersion(' 1.34.0 '), '1.34.0');
    assert.equal(kit.cleanVersion('dev'), null);
    assert.equal(kit.cleanVersion(null), null);
    assert.equal(kit.compare('1.10.0', '1.9.9'), 1);
    assert.equal(kit.compare('1.9.9', '1.10.0'), -1);
    assert.equal(kit.compare('2.0.0', '2.0.0'), 0);
    assert.equal(kit.stateOf('1.34.0', 'v1.34.0'), 'installed');
    assert.equal(kit.stateOf('1.34.1', '1.34.0'), 'newer');
    assert.equal(kit.stateOf('1.33.1', '1.34.0'), 'older');
    assert.equal(kit.stateOf('1.33.1', null), 'unknown');
    assert.equal(kit.stateOf('x', '1.34.0'), 'unknown');
  });

  it('"Alle Versionen" opens with the newest five; down to the installed one when that is older; the rest folds', () => {
    const list = (n) => Array.from({ length: n }, (_, i) => ({ version: `1.${40 - i}.0` })); // 1.40.0, 1.39.0, …
    assert.equal(kit.VERSIONS_FIRST, 5);
    assert.equal(kit.visibleCount(list(20), '1.40.0'), 5, 'the gateway is up to date: the newest five');
    assert.equal(kit.visibleCount(list(20), null), 5, 'no version reported');
    assert.equal(kit.visibleCount(list(20), '1.2.0'), 5, 'older than the whole list');
    assert.equal(kit.visibleCount(list(20), 'v1.38.0'), 5, 'within the first five');
    assert.equal(kit.visibleCount(list(20), '1.31.0'), 10, 'nine versions behind: every newer one and the installed one stay in sight');
    assert.equal(kit.visibleCount(list(5), '1.40.0'), 5);
    assert.equal(kit.visibleCount(list(3), '1.40.0'), 3);
    assert.equal(kit.visibleCount(list(6), '1.40.0'), 6, 'no fold for a single row');
    assert.equal(kit.visibleCount(list(7), '1.40.0'), 5);
    assert.equal(kit.visibleCount(list(20), '1.40.0', 3), 3);
    assert.equal(kit.visibleCount([], '1.40.0'), 0);
    assert.equal(kit.visibleCount(null, null), 0);
  });

  it('"Anleitung": a help topic → its heading in the handbook of the gateway; nothing for a topic outside it', () => {
    const anchors = { 'gw.rpi': '3-3-raspberry-pi', 'feat.dns': 'dns-filter', top: '', bad: '../x', obj: {} };
    assert.equal(kit.topicHash(7, 'gw.rpi', anchors), '#gw/7/handbook/3-3-raspberry-pi');
    assert.equal(kit.topicHash('7', 'feat.dns', anchors), '#gw/7/handbook/dns-filter');
    assert.equal(kit.topicHash(7, 'top', anchors), '#gw/7/handbook');
    assert.equal(kit.topicHash(7, 'index', anchors), null);
    assert.equal(kit.topicHash(7, 'bad', anchors), null);
    assert.equal(kit.topicHash(7, 'obj', anchors), null);
    assert.equal(kit.topicHash(7, 'toString', anchors), null);
    assert.equal(kit.topicHash(null, 'gw.rpi', anchors), null);
    assert.equal(kit.topicHash(7, 'gw.rpi', null), null);
    // and back: the address parses to the same heading
    assert.deepEqual(kit.parseHash(kit.topicHash(7, 'gw.rpi', anchors)), { id: '7', view: 'handbook', target: '3-3-raspberry-pi' });
  });

  it('summary: how many versions are newer, whether the installed one is listed', () => {
    const vs = [{ version: '1.34.2' }, { version: '1.34.1' }, { version: '1.34.0' }, { version: '1.33.1' }];
    assert.deepEqual(kit.summary(vs, '1.34.0'), { installed: '1.34.0', newer: 2, listed: true });
    assert.deepEqual(kit.summary(vs, '1.34.2'), { installed: '1.34.2', newer: 0, listed: true });
    assert.deepEqual(kit.summary(vs, '1.20.0'), { installed: '1.20.0', newer: 4, listed: false });
    assert.deepEqual(kit.summary(vs, null), { installed: null, newer: 0, listed: false });
    assert.deepEqual(kit.summary(null, '1.0.0'), { installed: '1.0.0', newer: 0, listed: false });
  });
});

describe('GET /api/v1/gateways/releases, /handbook and the page', () => {
  let agent;
  let app;
  before(async () => {
    const { setup } = require('./helpers/setup');
    ({ agent, app } = await setup());
  });
  after(() => { notes._setTransport(null); notes._reset(); require('./helpers/setup').teardown(); });

  it('releases: the list, the latest version, the source', async () => {
    notes._reset();
    notes._setTransport(answer([release('1.34.1', 'a'), release('1.34.0', BODY), release('1.33.1', 'c')]));
    require('../src/services/gatewayRelease')._setCache('1.34.1');
    const r = await agent.get('/api/v1/gateways/releases').expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.available, true);
    assert.equal(r.body.stale, false);
    assert.equal(r.body.latest_version, '1.34.1');
    assert.equal(r.body.releases_url, REL);
    assert.deepEqual(r.body.versions.map((v) => v.version), ['1.34.1', '1.34.0', '1.33.1']);
    assert.equal(r.body.versions[1].notes, '- Funksticks von Hand zuordnen (#51)\n- Office-Image im Release (#52)');
    assert.equal(r.body.versions[1].url, `${REL}/tag/v1.34.0`);
    // the lines the page renders as text (the plugin area's noteLines, made on the server)
    assert.deepEqual(r.body.versions[1].lines, [{ kind: 'li', level: 0, text: 'Funksticks von Hand zuordnen (#51)' }, { kind: 'li', level: 0, text: 'Office-Image im Release (#52)' }]);
  });

  it('releases and handbook need a signed-in admin', async () => {
    const request = require('supertest');
    await request(app).get('/api/v1/gateways/releases').expect((res) => assert.ok([401, 403, 302].includes(res.status), String(res.status)));
    await request(app).get('/api/v1/gateways/handbook').expect((res) => assert.ok([401, 403, 302].includes(res.status), String(res.status)));
  });

  it('releases: offline and never loaded → available false', async () => {
    notes._reset();
    notes._setTransport(null);
    const r = await agent.get('/api/v1/gateways/releases').expect(200);
    assert.equal(r.body.available, false);
    assert.deepEqual(r.body.versions, []);
  });

  it('handbook: in the language asked for, else the interface language', async () => {
    const en = await agent.get('/api/v1/gateways/handbook?lang=en').expect(200);
    assert.equal(en.body.ok, true);
    assert.equal(en.body.lang, 'en');
    assert.equal(en.body.version, require('../package.json').version);
    assert.match(en.body.html, /id="hb-3-setting-up-a-gateway"/);
    assert.ok(Array.isArray(en.body.toc) && en.body.toc.length > 10);
    const de = await agent.get('/api/v1/gateways/handbook?lang=de').expect(200);
    assert.equal(de.body.lang, 'de');
    assert.match(de.body.html, /id="hb-3-gateway-einrichten"/);
  });

  it('the page: the view, the scripts in order, the strings in the island', async () => {
    const html = (await agent.get('/gateways').expect(200)).text;
    assert.match(html, /<div id="gw-docs-view" class="pgx gw-docs" hidden><\/div>/);
    const at = (s) => html.indexOf(s);
    assert.equal(at('/js/plugins-ui.js'), -1, 'the notes come as lines, the plugin helpers stay on the plugin page');
    assert.ok(at('/js/gateway-docs-kit.js') > 0 && at('/js/gateway-docs-kit.js') < at('/js/gateway-docs.js?') && at('/js/gateway-docs.js?') < at('/js/gateways.js?'));
    assert.ok(at('/js/gateway-edge.js?') < at('/js/gateway-docs.js?'));
    const m = /<script type="application\/json" id="gwiz-i18n" data-prefixes="([^"]+)"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m[1].split(' ').includes('gwd.'));
    const island = JSON.parse(m[2]);
    assert.ok(island['gwd.ver.installed'] && island['gwd.ver.newer'] && island['gwd.hb.toc'] && island['gwd.whats_new'] && island['gwp.menu.versions'] && island['gwp.menu.handbook']);
    assert.ok(island['gwd.ver.older_show'] && island['gwd.ver.older_hide']);
  });

  it('the page: "Anleitung" leads into the handbook of the app — the topics come as an island, in the language of the page', async () => {
    const html = (await agent.get('/gateways').expect(200)).text;
    const m = /<script type="application\/json" id="gw-handbook-topics"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'the island is there');
    const topics = JSON.parse(m[1]);
    const lang = /<html[^>]* lang="en"/.test(html) ? 'en' : 'de';
    assert.deepEqual(topics, hbook.topicAnchors(lang));
    // the links of the assistant name their topic; gateway-wizard.js gives them the address of the gateway's handbook
    for (const topic of ['gw.rpi', 'gw.synology', 'gw.proxmox', 'gw.linux']) {
      assert.match(html, new RegExp(`<a href="[^"]+" target="_blank" rel="noopener noreferrer" data-guide="${topic.replace('.', '\\.')}">`), topic);
      assert.ok(topics[topic], topic);
    }
    const wiz = fs.readFileSync(path.join(ROOT, 'public/js/gateway-wizard.js'), 'utf8');
    const edge = fs.readFileSync(path.join(ROOT, 'public/js/gateway-edge.js'), 'utf8');
    assert.match(wiz, /DK\.topicHash\(state\.peerId, a\.dataset\.guide, HB_TOPICS\)/);
    assert.match(edge, /DK\.topicHash\(guideGw, topic, HB_TOPICS\)/);
    // every "Anleitung" of the tabs goes through guide() / guideUrl(): no address of the guide outside built by hand
    for (const f of ['gateway-edge.js', 'gateway-net.js', 'gateway-home.js', 'gateway-radio.js', 'gateway-wizard.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
      assert.doesNotMatch(src, /docs\/(handbuch|guide)\//, f);
      assert.equal((src.match(/GCHandbook\.url\(/g) || []).length, f === 'gateway-edge.js' ? 1 : 0, f + ': only the fallback of guideUrl()');
    }
  });

  it('every gwd.* string in German and English', () => {
    const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/de.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8'));
    const kd = Object.keys(de).filter((k) => k.startsWith('gwd.')).sort();
    assert.deepEqual(kd, Object.keys(en).filter((k) => k.startsWith('gwd.')).sort());
    // every key the page uses exists
    const src = fs.readFileSync(path.join(ROOT, 'public/js/gateway-docs.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public/js/gateways.js'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'templates/aurora/pages/gateways.njk'), 'utf8');
    for (const k of new Set([...src.matchAll(/'(gwd\.[a-z_.]+)'/g)].map((x) => x[1]))) assert.ok(de[k] && en[k], k);
  });
});
