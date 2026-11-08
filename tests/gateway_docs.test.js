'use strict';

// "Versionen" and "Handbuch" of the Gateways page (#versions, #handbook):
//   services/gatewayReleaseNotes.js — the release notes of the gateway repository
//     (GitHub releases, cached in memory and next to the database, offline-safe),
//     GET /api/v1/gateways/releases
//   services/gatewayHandbook.js — the gateway chapters (3–7) of docs/handbuch and
//     docs/guide as one document through the safe renderer of the plugin handbooks,
//     GET /api/v1/gateways/handbook
//   public/js/gateway-docs-kit.js — addresses, help topics → in-app anchors

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

  it('between(): the versions after the installed one up to the target', () => {
    const vs = notes.parse([release('1.34.1', 'a'), release('1.34.0', 'b'), release('1.33.1', 'c'), release('1.32.0', 'd')]);
    assert.deepEqual(notes.between(vs, '1.33.1', '1.34.1').map((v) => v.version), ['1.34.1', '1.34.0']);
    assert.deepEqual(notes.between(vs, '1.32.0', '1.34.0').map((v) => v.version), ['1.34.0', '1.33.1']);
    assert.deepEqual(notes.between(vs, '1.34.1', null), []);
    assert.deepEqual(notes.between(vs, 'garbage', '1.34.1'), []);
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

    it(`${lang}: every help topic of chapters 3–7 (public/js/handbook.js) opens its heading`, () => {
      const r = hbook.get(lang);
      const topics = Object.keys(guide.TOPICS).filter((k) => kit.isTopic(k));
      assert.ok(topics.length >= 30);
      for (const k of topics) {
        const a = kit.resolve(k, r.anchors, lang);
        assert.ok(a, 'no anchor for ' + k);
        assert.ok(r.html.includes(`id="hb-${a}"`), `${k} → ${a}`);
      }
      // the chapters themselves and their sections
      assert.equal(kit.resolve('edge', r.anchors, lang), r.chapters[1].anchor);
      assert.equal(kit.resolve('gw.rpi', r.anchors, lang), '3-3-raspberry-pi');
    });
  }

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
    assert.deepEqual(kit.parseHash('#versions'), { view: 'versions', from: null });
    assert.deepEqual(kit.parseHash('#versions/1.31.0'), { view: 'versions', from: '1.31.0' });
    assert.deepEqual(kit.parseHash('#versions/<x>'), { view: 'versions', from: null });
    assert.deepEqual(kit.parseHash('#handbook'), { view: 'handbook', target: null });
    assert.deepEqual(kit.parseHash('#handbook/3-3-raspberry-pi'), { view: 'handbook', target: '3-3-raspberry-pi' });
    assert.deepEqual(kit.parseHash('#handbook/gw.rpi'), { view: 'handbook', target: 'gw.rpi' });
    assert.deepEqual(kit.parseHash('#handbook/%3Cscript%3E'), { view: 'handbook', target: null });
    assert.deepEqual(kit.parseHash('#handbook/%E0%A4%A'), { view: 'handbook', target: null });
    assert.equal(kit.parseHash('#gw/3'), null);
    assert.equal(kit.parseHash('#versionsx'), null);
    assert.equal(kit.versionsHash('1.2.3'), '#versions/1.2.3');
    assert.equal(kit.versionsHash('x'), '#versions');
    assert.equal(kit.versionsHash(null), '#versions');
    assert.equal(kit.handbookHash('gw.rpi'), '#handbook/gw.rpi');
    assert.equal(kit.handbookHash(null), '#handbook');
  });

  it('topics: only those of chapters 3–7', () => {
    assert.equal(kit.isTopic('gw.rpi'), true);
    assert.equal(kit.isTopic('faq.utc'), true);
    assert.equal(kit.isTopic('index'), false);
    assert.equal(kit.isTopic('constructor'), false);
    assert.equal(kit.isTopic('__proto__'), false);
    assert.equal(kit.resolve('3-3-raspberry-pi', {}, 'de'), '3-3-raspberry-pi');
    assert.equal(kit.resolve('gw.rpi', { '03-gateway-einrichten.md#33-raspberry-pi': '3-3-raspberry-pi' }, 'de'), '3-3-raspberry-pi');
    assert.equal(kit.resolve('gw.rpi', { '03-gateway-einrichten.md': '3-gateway-einrichten' }, 'de'), '3-gateway-einrichten');
    assert.equal(kit.resolve('gw.rpi', { '03-gateway-einrichten.md#33-raspberry-pi': 'x y' }, 'de'), null);
    assert.equal(kit.resolve('gw.rpi', null, 'de'), null);
  });

  it('which gateway runs which version', () => {
    const run = kit.runningOn([{ name: 'b', health: { telemetry: { gateway_version: '1.34.0' } } }, { name: 'a', health: { telemetry: { gateway_version: 'v1.34.0' } } },
      { name: 'c', health: { telemetry: { gateway_version: '1.33.1' } } }, { name: 'd' }, { name: 'e', health: { telemetry: { gateway_version: 'dev' } } }]);
    assert.deepEqual(run, { '1.34.0': ['a', 'b'], '1.33.1': ['c'] });
    assert.equal(kit.namesText(['a', 'b'], 3), 'a, b');
    assert.equal(kit.namesText(['a', 'b', 'c', 'd', 'e'], 3, 'und {{n}} weiteren'), 'a, b, c und 2 weiteren');
  });
});

describe('GET /api/v1/gateways/releases, /handbook and the page', () => {
  let agent;
  before(async () => {
    const { setup } = require('./helpers/setup');
    ({ agent } = await setup());
  });
  after(() => { notes._setTransport(null); notes._reset(); require('./helpers/setup').teardown(); });

  it('releases: the list, the versions since the installed one, the source', async () => {
    notes._reset();
    notes._setTransport(answer([release('1.34.1', 'a'), release('1.34.0', BODY), release('1.33.1', 'c')]));
    require('../src/services/gatewayRelease')._setCache('1.34.1');
    const r = await agent.get('/api/v1/gateways/releases?from=1.33.1').expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.available, true);
    assert.equal(r.body.latest_version, '1.34.1');
    assert.equal(r.body.releases_url, REL);
    assert.deepEqual(r.body.versions.map((v) => v.version), ['1.34.1', '1.34.0', '1.33.1']);
    assert.deepEqual(r.body.since.map((v) => v.version), ['1.34.1', '1.34.0']);
    assert.equal(r.body.since[1].notes, '- Funksticks von Hand zuordnen (#51)\n- Office-Image im Release (#52)');
    const bad = await agent.get('/api/v1/gateways/releases?from=<script>').expect(200);
    assert.equal(bad.body.from, null);
    assert.deepEqual(bad.body.since, []);
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

  it('the page: buttons, the view, the scripts in order, the strings in the island', async () => {
    const html = (await agent.get('/gateways').expect(200)).text;
    assert.match(html, /id="btn-gw-versions" href="#versions"/);
    assert.match(html, /id="btn-gw-handbook" href="#handbook"/);
    assert.match(html, /<div id="gw-docs-view" class="pgx gw-docs" hidden><\/div>/);
    const at = (s) => html.indexOf(s);
    assert.ok(at('/js/handbook.js') > 0 && at('/js/handbook.js') < at('/js/gateway-docs-kit.js'));
    assert.ok(at('/js/plugins-ui.js') > 0 && at('/js/plugins-ui.js') < at('/js/gateway-docs.js?'));
    assert.ok(at('/js/gateway-docs-kit.js') < at('/js/gateway-docs.js?') && at('/js/gateway-docs.js?') < at('/js/gateways.js?'));
    const m = /<script type="application\/json" id="gwiz-i18n" data-prefixes="([^"]+)"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m[1].split(' ').includes('gwd.'));
    const island = JSON.parse(m[2]);
    assert.ok(island['gwd.ver.since'] && island['gwd.hb.toc'] && island['gwd.whats_new']);
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
