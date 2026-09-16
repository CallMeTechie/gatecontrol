'use strict';

// WAF page, release B §3 (docs/feature-release-b.md, UI strand B3): tabs
// Ereignisse / Assistent / Eigene IPs & Sperren on waf.njk, public/js/
// waf-assistant.js (assistant, own IPs, scanner ban, bans), the trusted
// marks in waf.js, the island keys and the pure helpers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const A = require('../public/js/waf-assistant.js');
const W = require('../public/js/waf-ui.js');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
env.addFilter('bytes', (v) => String(v || 0) + ' B');
env.addFilter('reltime', () => '—');
env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
function render(lang = 'de', waf = true) {
  const loc = lang === 'en' ? en : de;
  const t = (key, params) => {
    let s = loc[key] !== undefined ? loc[key] : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    return s;
  };
  return env.render('aurora/pages/waf.njk', {
    theme: 'aurora', language: lang, t, availableLanguages: ['de', 'en'],
    license: { features: { http_routes: -1, l4_routes: -1, waf }, hasFeature: () => false, tier: 'pro' },
    cspNonce: 'NONCE123', csrfToken: 'c', appVersion: '9.9.9', appName: 'GateControl', baseUrl: 'https://gc.example.com',
    user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin', theme: 'aurora' },
    title: 'WAF', activeNav: 'waf', currentPath: '/waf', flash: {}, httpRouteCount: 3, l4RouteCount: 2, peerCount: 1, routeCount: 5, rdpRouteCount: 0,
  });
}
const island = (html) => JSON.parse(/<script type="application\/json" id="waf-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);

describe('waf.njk: tabs and panels', () => {
  it('three tabs; the events panel keeps the original page, assistant + protect start hidden', () => {
    const html = render();
    const tabs = Array.from(html.matchAll(/data-wf-tab="([a-z]+)"/g)).map((m) => m[1]);
    assert.deepEqual(tabs, ['events', 'assistant', 'protect']);
    assert.match(html, /class="tab active" id="wf-tab-events" role="tab" aria-selected="true"/);
    const ev = html.indexOf('id="wf-panel-events"');
    for (const id of ['wf-tiles', 'wf-events-card', 'wf-routes-card']) {
      const at = html.indexOf(`id="${id}"`);
      assert.ok(at > ev && at < html.indexOf('id="wf-panel-assistant"'), `#${id} inside the events panel`);
    }
    assert.match(html, /id="wf-panel-assistant"[^>]*data-wf-panel="assistant" hidden/);
    assert.match(html, /id="wf-panel-protect"[^>]*data-wf-panel="protect" hidden/);
    const js = stripComments(read('public/js/waf-assistant.js'));
    for (const m of js.matchAll(/\$\('([a-z0-9-]+)'\)/g)) assert.ok(html.includes(`id="${m[1]}"`), `waf-assistant.js queries #${m[1]}`);
    assert.match(html, /id="wfa-bypass" data-managed="true" role="switch"/, 'switches are managed (app.js never wires them)');
    assert.match(html, /id="wfa-autoban" data-managed="true" role="switch"/);
    assert.match(html, /id="wf-hide-trusted" aria-pressed="false"/);
    assert.match(html, /<input type="number" class="form-input" id="wfa-ab-threshold" min="1" max="1000"/);
    assert.match(html, /id="wfa-ab-window" min="1" max="1440"/);
    assert.match(html, /id="wfa-ab-duration" min="1" max="8760"/);
    assert.ok(html.includes(de['waf.bypass_warn']), 'bypass warning rendered');
  });

  it('script order: waf-ui.js → waf-assistant.js → waf.js; not loaded without the licence', () => {
    const html = render();
    const srcs = Array.from(html.matchAll(/<script src="([^"?]+)\?v=9\.9\.9"/g)).map((m) => m[1]);
    const ui = srcs.indexOf('/js/waf-ui.js');
    const asst = srcs.indexOf('/js/waf-assistant.js');
    const page = srcs.indexOf('/js/waf.js');
    assert.ok(ui >= 0 && asst > ui && page > asst, srcs.join(','));
    assert.ok(!render('de', false).includes('/js/waf-assistant.js'));
  });

  it('the island carries every waf.*/common.* key waf-assistant.js and waf.js use, translated', () => {
    const listed = Array.from(/set wafI18nKeys = \[([\s\S]*?)\]/.exec(read('templates/partials/waf-i18n.njk'))[1].matchAll(/'([a-z0-9_.]+)'/g)).map((x) => x[1]);
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    const used = new Set();
    for (const f of ['public/js/waf-assistant.js', 'public/js/waf.js']) {
      for (const m of read(f).matchAll(/'((?:waf|common)\.[a-z0-9_.]+)'/g)) if (!/[._]$/.test(m[1])) used.add(m[1]);
    }
    A.READINESS.forEach((r) => { used.add('waf.asst_' + r); used.add('waf.asst_' + r + '_hint'); });
    A.VERDICTS.forEach((v) => used.add('waf.asst_verdict_' + v));
    Object.values(A.ERROR_KEYS).forEach((k) => used.add(k));
    for (const k of used) {
      assert.ok(listed.includes(k), `island lists ${k}`);
      assert.ok(de[k] && en[k], `${k} in de/en`);
    }
    for (const lang of ['de', 'en']) {
      const isl = island(render(lang));
      const loc = lang === 'en' ? en : de;
      for (const k of used) assert.equal(isl[k], loc[k], `${lang}: ${k}`);
    }
  });
});

describe('waf-assistant.js pure helpers', () => {
  it('tabs from the hash (deep link /waf#assistant)', () => {
    assert.equal(A.parseTab('#assistant'), 'assistant');
    assert.equal(A.parseTab('#protect'), 'protect');
    assert.equal(A.parseTab(''), 'events');
    assert.equal(A.parseTab('#x'), 'events');
  });

  // docs/feature-wave2.md §W1.3: the server sends `reason_code` + `reason_params`,
  // the browser translates the code. The English `reason` is never parsed.
  it('reason_code → text key with the server parameters, unknown code falls back', () => {
    assert.deepEqual(A.reasonText({ reason_code: 'secret_path', reason_params: { path: '/.env' } }), { key: 'waf.asst_reason_secret', params: { path: '/.env' } });
    assert.deepEqual(A.reasonText({ reason_code: 'scanner_rule', reason_params: {} }), { key: 'waf.asst_reason_scanner', params: {} });
    assert.deepEqual(A.reasonText({ reason_code: 'series', reason_params: { hits: 7 } }), { key: 'waf.asst_reason_series', params: { hits: 7, n: 7 } });
    assert.deepEqual(A.reasonText({ reason_code: 'all_banned', reason_params: {} }), { key: 'waf.asst_reason_banned', params: {} });
    assert.deepEqual(A.reasonText({ reason_code: 'shared_path', reason_params: { path: '/api/x', ips: 4, days: 3 } }), { key: 'waf.asst_reason_fp', params: { path: '/api/x', ips: 4, days: 3 } });
    assert.deepEqual(A.reasonText({ reason_code: 'inconclusive', reason_params: { hits: 2, ips: 2 } }), { key: 'waf.asst_reason_unclear', params: { hits: 2, ips: 2 } });
    assert.deepEqual(A.reasonText({ reason_code: 'scanner', reason_params: { hits: 6, window: 10, rules: '913100, 930120' } }), { key: 'waf.bans_reason_scanner', params: { hits: 6, window: 10, rules: '913100, 930120' } });
    assert.deepEqual(A.reasonText({ reason_code: 'manual', reason_params: {} }), { key: 'waf.bans_reason_manual', params: {} });
    assert.equal(A.reasonText({ reason_code: null, reason: 'Login-Scanner' }), null, 'own ban reason stays verbatim');
    assert.equal(A.reasonText({ reason: 'hits a typical secret path (/.env)' }), null, 'the English text is not parsed');
    assert.equal(A.reasonText(null), null);
    for (const k of ['waf.asst_reason_secret', 'waf.asst_reason_fp', 'waf.bans_reason_scanner']) assert.ok(de[k] && en[k], k);
  });

  it('every reason_code of the services has a text key, and the plain text stays', () => {
    // Read the list out of the source; requiring the service would open the DB.
    const codes = /const REASON_CODES = \[([^\]]+)\]/.exec(read('src/services/wafAssistant.js'))[1]
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.ok(codes.length >= 6, 'REASON_CODES found');
    for (const c of codes) {
      const r = A.reasonText({ reason_code: c, reason_params: {} });
      assert.ok(r, `code ${c} known to the UI`);
      assert.ok(de[r.key] && en[r.key], `${c} → ${r.key} in both languages`);
    }
    // `reason` keeps its English wording for API users.
    const svc = read('src/services/wafAssistant.js') + read('src/services/wafBans.js');
    for (const s of ['hits a typical secret path (', "'scanner / file-inclusion rule'", 'series of ${hits} requests from a single address', "'every source address is banned'",
      'same path ${fpPaths[0]} from ${pe.cleanIps.size} different addresses on ${pe.days.size} days', '${hits} request(s) from ${ips.length} address(es) — not conclusive',
      'scanner: ${c.hits} requests in ${s.autoban.window_min} min (rules ${rules})', "reason || 'manual'"]) {
      assert.ok(svc.includes(s), `server text: ${s}`);
    }
    // No regex on server prose left in the assistant script.
    assert.ok(!read('public/js/waf-assistant.js').includes('not conclusive'), 'no English reason regex in the browser');
  });

  it('routes sorted ready → review → too_early → no_traffic, block last; counts', () => {
    const rs = [
      { route_id: 1, host: 'z.de', mode: 'detect', readiness: 'no_traffic' },
      { route_id: 2, host: 'a.de', mode: 'block', readiness: 'ready' },
      { route_id: 3, host: 'b.de', mode: 'detect', readiness: 'review' },
      { route_id: 4, host: 'c.de', mode: 'detect', readiness: 'ready' },
      { route_id: 5, host: 'd.de', mode: 'detect', readiness: 'too_early' },
    ];
    assert.deepEqual(A.sortRoutes(rs).map((r) => r.route_id), [4, 3, 5, 1, 2]);
    assert.deepEqual(A.readinessCounts(rs), { ready: 1, review: 1, too_early: 1, no_traffic: 1, block: 1 });
    assert.equal(A.readinessOf({ readiness: 'bogus' }), 'too_early');
    assert.equal(A.verdictOf({ verdict: 'x' }), 'unclear');
  });

  it('suggestions: numbers and valid exclusion paths only; observed time', () => {
    assert.deepEqual(A.suggestionOf({ suggestion: { exclude_rules: [942100, 'x', -1], exclude_paths: ['/api', 'bad path', '/a"b'] } }), { rules: [942100], paths: ['/api'] });
    assert.deepEqual(A.suggestionOf({}), { rules: [], paths: [] });
    assert.deepEqual(A.hoursText(36), { key: 'waf.asst_hours', params: { n: 36 } });
    assert.deepEqual(A.hoursText(80), { key: 'waf.asst_days', params: { n: 3 } });
  });

  it('address check for own IPs and bans (IPv4, IPv6, CIDR)', () => {
    for (const ok of ['93.215.209.180', '10.0.0.0/8', '2001:db8::1', '2001:db8::/32', '::1', '::ffff:10.0.0.1', 'fe80::1%'.slice(0, -1), '1:2:3:4:5:6:7:8']) assert.ok(A.parseAddr(ok), ok);
    for (const bad of ['', '300.1.1.1', '1.2.3', '10.0.0.0/33', '2001:db8::/129', 'abc', '1::2::3', '1:2:3:4:5:6:7:8:9', '010.1.1.1', '1.2.3.4/x', 'example.com']) assert.equal(A.parseAddr(bad), null, bad);
    assert.equal(A.parseAddr('2001:DB8::1').text, '2001:db8::1');
    const r = A.addTrusted(['10.0.0.0/8'], '1.2.3.4, 10.0.0.0/8 nope\n2001:db8::1');
    assert.deepEqual(r.list, ['10.0.0.0/8', '1.2.3.4', '2001:db8::1']);
    assert.deepEqual(r.invalid, ['nope']);
    assert.deepEqual(r.duplicate, ['10.0.0.0/8']);
    const full = Array.from({ length: A.TRUSTED_MAX }, (_, i) => '10.0.' + Math.floor(i / 250) + '.' + (i % 250));
    assert.equal(A.addTrusted(full, '1.1.1.1').overflow, true);
  });

  it('autoban limits like services/wafBans.js, ban URL encodes CIDR slashes', () => {
    const svc = read('src/services/wafBans.js');
    assert.ok(svc.includes('const LIMITS = { threshold: [1, 1000], window_min: [1, 1440], duration_h: [1, 8760] };'));
    assert.deepEqual(A.LIMITS, { threshold: [1, 1000], window_min: [1, 1440], duration_h: [1, 8760] });
    assert.ok(svc.includes('const TRUSTED_MAX = 50;') && A.TRUSTED_MAX === 50);
    assert.equal(A.intIn('5', 'threshold'), 5);
    assert.equal(A.intIn('0', 'threshold'), null);
    assert.equal(A.intIn('1441', 'window_min'), null);
    assert.equal(A.intIn('2.5', 'duration_h'), null);
    assert.equal(A.banUrl('203.0.113.0/24'), '/api/v1/waf/bans/203.0.113.0%2F24');
    assert.equal(A.banUrl('2001:db8::1'), '/api/v1/waf/bans/2001%3Adb8%3A%3A1');
    assert.equal(A.errorKey('waf_ban_trusted'), 'waf.err.ban_trusted');
    assert.equal(A.errorKey('NOPE'), null);
  });
});

describe('waf-assistant.js / waf.js integration', () => {
  it('waf-assistant.js: no innerHTML, contract endpoints and bodies, confirmations, live updates', () => {
    const src = stripComments(read('public/js/waf-assistant.js'));
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /'\/api\/v1\/waf\/assistant' \+ \(routeId \? '\?route_id=' \+ encodeURIComponent\(routeId\) : ''\)/);
    assert.match(src, /W\.addExclusion\(r\.route_id, W\.exclusionBody\(it\.kind, it\.value\)\)/);
    assert.match(src, /W\.request\('PUT', '\/api\/v1\/routes\/' \+ encodeURIComponent\(r\.route_id\), \{ waf_mode: 'block' \}\)/);
    assert.match(src, /W\.request\('GET', '\/api\/v1\/settings\/waf'\)/);
    assert.match(src, /W\.request\('PUT', '\/api\/v1\/settings\/waf', body\)/);
    assert.match(src, /W\.request\('GET', '\/api\/v1\/waf\/bans'\)/);
    assert.match(src, /W\.request\('POST', '\/api\/v1\/waf\/bans', body\)/);
    assert.match(src, /W\.request\('DELETE', banUrl\(b\.ip\)\)/);
    assert.match(src, /const ok = await confirmDialog\(\{\s*kind: 'to-block'[\s\S]*?if \(!ok\) return;/, 'block switch confirmed');
    assert.match(src, /kind: 'bypass'[\s\S]*?warn: t\('waf\.bypass_warn'\)/, 'bypass switch confirmed with the warning');
    assert.match(src, /kind: 'unban'/);
    assert.match(src, /d\.kind === 'ban' \|\| d\.kind === 'unban'/);
    assert.match(src, /win\.GCLicenseHint \? win\.GCLicenseHint\.render\('waf'\)/);
  });

  it('waf.js: ban events do not reload the list; trusted events marked and hideable; summary names own IPs', () => {
    const src = stripComments(read('public/js/waf.js'));
    assert.match(src, /if \(d && \(d\.kind === 'ban' \|\| d\.kind === 'unban'\)\) return;/);
    assert.match(src, /ev\.trusted \? el\('span', \{ class: 'tag tag-blue wfa-trusted-tag'/);
    assert.match(src, /state\.hideTrusted \? state\.events\.filter\(\(e\) => !e\.trusted\) : state\.events/);
    assert.match(src, /t\('waf\.summary_trusted', \{ n: s\.trusted_24h \}\)/);
    assert.match(src, /\$\('wf-hide-trusted'\)/);
  });

  it('statusFrom carries trusted_24h only when the server sends it', () => {
    assert.equal(W.statusFrom({ routes: [], events_24h: 3, blocked_24h: 1, trusted_24h: 4 }).totals.trusted_24h, 4);
    assert.ok(!('trusted_24h' in W.statusFrom({ routes: [] }).totals));
  });

  it('styles: one wfa- section at the end of security.css (not in pro.css / aurora.css)', () => {
    const css = read('public/css/security.css');
    const marker = '/* ─── WAF: tabs, assistant, own IPs, scanner ban, bans (wfa-) ─── */';
    const at = css.indexOf(marker);
    assert.ok(at > css.indexOf('/* ─── Sicherheits-Check (sc-) ─── */') && css.indexOf('/* ─── ', at + 1) === -1, 'last section');
    assert.doesNotMatch(css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, ''), /\.wfa-[a-z]/, 'no wfa- rules before the section');
    for (const cls of ['.wfa-route', '.wfa-ip-chip', '.wfa-bans-table', '.wfa-warn.wfa-warn-on', '.wfa-row-trusted']) assert.ok(css.includes(cls), cls);
    for (const f of ['pro.css', 'aurora.css']) assert.ok(!read('public/css/' + f).includes('.wfa-'), f);
  });

  it('German texts', () => {
    assert.equal(de['waf.tab_assistant'], 'Assistent');
    assert.equal(de['waf.asst_to_block'], 'Auf Blockieren stellen');
    assert.equal(de['waf.trusted_title'], 'Eigene IPs');
    assert.equal(de['waf.autoban_title'], 'Scanner-Sperre');
    assert.equal(de['waf.bans_title'], 'Gesperrte IPs');
  });
});
