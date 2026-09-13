'use strict';

// Pure helpers of the WAF UI kit (public/js/waf-ui.js) and the WAF chip note
// of zones-view.js (docs/feature-waf.md, "Oberfläche"): field normalisation,
// labels/keys, exclusion rules, event query + filter guard, status totals,
// deep links and error mapping.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../public/js/waf-ui.js');
const V = require('../public/js/zones-view.js');
const de = require('../src/i18n/de.json');

const NOW = Date.parse('2026-09-13T12:00:00Z');

describe('waf-ui: route/entry fields and labels', () => {
  it('normalises mode and paranoia with the contract defaults', () => {
    assert.equal(W.normMode('block'), 'block');
    assert.equal(W.normMode(' BLOCK '), 'block');
    for (const v of [undefined, null, '', 'detect', 'on', 1]) assert.equal(W.normMode(v), 'detect');
    assert.deepEqual([1, 2, 3, 4].map(W.normParanoia), [1, 2, 3, 4]);
    for (const v of [0, 5, '9', 'x', null, undefined, 2.5]) assert.equal(W.normParanoia(v), v === 2.5 ? 2 : 1);
  });

  it('wafOf reads routes rows, zones entries and entry.waf objects', () => {
    assert.deepEqual(W.wafOf(null), { enabled: false, mode: 'detect', paranoia: 1 });
    assert.deepEqual(W.wafOf({ waf_enabled: 1, waf_mode: 'block', waf_paranoia: 3 }), { enabled: true, mode: 'block', paranoia: 3 });
    assert.deepEqual(W.wafOf({ waf_enabled: '0', waf_mode: 'block' }), { enabled: false, mode: 'block', paranoia: 1 });
    assert.deepEqual(W.wafOf({ waf: { enabled: true, mode: 'detect', paranoia: '2' } }), { enabled: true, mode: 'detect', paranoia: 2 });
  });

  it('wafState: only enabled HTTP entries, never L4 / RDP', () => {
    assert.equal(W.wafState({ route_type: 'http', waf_enabled: true, waf_mode: 'block' }), 'block');
    assert.equal(W.wafState({ route_type: 'http', waf_enabled: 1 }), 'detect');
    assert.equal(W.wafState({ route_type: 'http', waf_enabled: 0, waf_mode: 'block' }), null);
    assert.equal(W.wafState({ route_type: 'l4', waf_enabled: 1 }), null);
    assert.equal(W.wafState({ route_type: 'http', rdp_owned: true, waf_enabled: 1 }), null);
    assert.equal(W.wafState(null), null);
  });

  it('keys for tags, chips, modes and paranoia exist in de.json', () => {
    assert.equal(W.tagKey('block'), 'waf.tag_block');
    assert.equal(W.tagKey('detect'), 'waf.tag_detect');
    assert.equal(de[W.tagKey('block')], 'WAF');
    assert.equal(de[W.tagKey('detect')], 'WAF · erkennt');
    assert.equal(de[W.chipKey('block')], 'WAF');
    assert.equal(de[W.chipKey('detect')], 'WAF (erkennt)');
    assert.equal(de[W.modeKey('detect')], 'Nur erkennen');
    assert.equal(de[W.modeKey('block')], 'Blockieren');
    for (const n of W.PARANOIA_LEVELS) {
      assert.match(de[W.paranoiaKey(n)], new RegExp('^' + n + ' – '));
      assert.ok(de[W.paranoiaHintKey(n)].length > 20, 'paranoia explanation ' + n);
    }
    assert.deepEqual(W.toRouteFields({ enabled: 1, mode: 'x', paranoia: '4' }), { waf_enabled: true, waf_mode: 'detect', waf_paranoia: 4 });
  });

  it('zones-view: chip note WAF / WAF (erkennt), translated, skipped with waf:false', () => {
    const e = { route_type: 'http', https_enabled: 1, target_port: 80, waf_enabled: 1, waf_mode: 'block' };
    assert.equal(V.wafState(e), 'block');
    assert.equal(V.entryChip(e).note, 'WAF');
    assert.equal(V.entryChip(Object.assign({}, e, { waf_mode: 'detect' })).note, 'WAF (erkennt)');
    assert.equal(V.entryChip(Object.assign({}, e, { hsts: { enabled: true } })).note, 'HSTS · WAF');
    assert.equal(V.entryChip(Object.assign({}, e, { backend_https: 1 }), { wafLabel: (s) => 'L:' + s }).note, 'Backend HTTPS · L:block');
    assert.equal(V.entryChip(e, { hsts: false, waf: false }).note, undefined);
    assert.equal(V.entryChip({ route_type: 'http', https_enabled: 1 }).note, undefined, 'no note without WAF');
    assert.equal(V.wafState({ route_type: 'l4', waf_enabled: 1 }), null);
    assert.equal(V.wafState({ route_type: 'http', waf: { enabled: true, mode: 'detect' } }), 'detect');
  });
});

describe('waf-ui: exclusions', () => {
  it('parses stored JSON text/objects, drops invalid items and duplicates', () => {
    assert.deepEqual(W.parseExclusions(null), { rule_ids: [], paths: [] });
    assert.deepEqual(W.parseExclusions('not json'), { rule_ids: [], paths: [] });
    assert.deepEqual(W.parseExclusions('{"rule_ids":[942100,"920350",942100,-1,"x"],"paths":["/api","api","/api"," /up "]}'),
      { rule_ids: [942100, 920350], paths: ['/api', '/up'] });
    assert.deepEqual(W.exclusionsOf({ waf_exclusions: { rule_ids: [1], paths: [] } }), { rule_ids: [1], paths: [] });
    assert.deepEqual(W.exclusionsOf({ waf: { exclusions: { paths: ['/x'] } } }), { rule_ids: [], paths: ['/x'] });
    assert.equal(W.exclusionCount('{"rule_ids":[1,2],"paths":["/a"]}'), 3);
  });

  it('validates rule ids and paths client-side', () => {
    assert.equal(W.parseRuleId('942100'), 942100);
    assert.equal(W.parseRuleId(' 7 '), 7);
    for (const v of ['0', '-1', '12a', '', '10000000', '1234567890', null]) assert.equal(W.parseRuleId(v), null, String(v));
    assert.equal(W.parseRuleId(String(W.RULE_ID_MAX)), 9999999);
    assert.ok(W.validPath('/api/upload'));
    assert.ok(W.validPath('/wp-admin/admin-ajax.php'));
    assert.ok(W.validPath('/' + 'x'.repeat(W.PATH_MAX - 1)), '256 characters');
    for (const v of ['api', '', '/a b', '/' + 'x'.repeat(W.PATH_MAX), '/a"b', "/a'b", '/a\\b', '/ä']) assert.ok(!W.validPath(v), v.slice(0, 20));
    const cur = { rule_ids: [942100], paths: ['/api'] };
    assert.equal(W.exclusionError('rule', '942100', cur), 'duplicate');
    assert.equal(W.exclusionError('rule', 'abc', cur), 'invalid_rule');
    assert.equal(W.exclusionError('rule', '920350', cur), null);
    assert.equal(W.exclusionError('path', '/api', cur), 'duplicate');
    assert.equal(W.exclusionError('path', 'upload', cur), 'invalid_path');
    assert.equal(W.exclusionError('path', '/upload', null), null);
    for (const k of ['invalid_rule', 'invalid_path', 'duplicate']) assert.ok(de[W.clientErrorKey(k)], k);
  });

  it('builds POST/DELETE bodies and applies changes without mutating', () => {
    assert.deepEqual(W.exclusionBody('rule', ' 942100 '), { rule_id: 942100 });
    assert.deepEqual(W.exclusionBody('path', ' /api '), { path: '/api' });
    const cur = { rule_ids: [1], paths: ['/a'] };
    const added = W.applyExclusion(cur, 'rule', '2');
    assert.deepEqual(added, { rule_ids: [1, 2], paths: ['/a'] });
    assert.deepEqual(cur, { rule_ids: [1], paths: ['/a'] }, 'input untouched');
    assert.deepEqual(W.applyExclusion(added, 'path', '/a', true), { rule_ids: [1, 2], paths: [] });
    assert.deepEqual(W.applyExclusion(cur, 'rule', '1'), cur, 'no duplicate');
    assert.deepEqual(W.exclusionsFromResponse({ ok: true, exclusions: { rule_ids: [5] } }), { rule_ids: [5], paths: [] });
    assert.deepEqual(W.exclusionsFromResponse({ ok: true, route: { waf_exclusions: '{"paths":["/p"]}' } }), { rule_ids: [], paths: ['/p'] });
    assert.equal(W.exclusionsFromResponse({ ok: true }), null);
  });
});

describe('waf-ui: events', () => {
  it('eventsQuery: limit, from of the period, host, action, cursor', () => {
    const q = W.eventsQuery({ host: 'App.Example.com', action: 'blocked', range: '7d' }, { now: NOW, cursor: 'abc 1' });
    assert.equal(q, '?limit=50&from=' + encodeURIComponent('2026-09-06T12:00:00.000Z') + '&host=app.example.com&action=blocked&cursor=abc%201');
    assert.equal(W.eventsQuery({}, { now: NOW }), '?limit=50&from=' + encodeURIComponent('2026-09-12T12:00:00.000Z'));
    assert.equal(W.eventsQuery({ action: 'nope', range: '1y' }, { now: NOW, limit: 10 }), '?limit=10&from=' + encodeURIComponent('2026-09-12T12:00:00.000Z'));
    assert.equal(W.rangeFrom('30d', NOW), '2026-08-14T12:00:00.000Z');
  });

  it('eventsFrom tolerates the answer shapes and normalises events', () => {
    const r = W.eventsFrom({ ok: true, events: [{ id: 1, host: 'A.de', action: 'BLOCKED', rule_id: 942100 }, null, { id: 2, action: 'detected', rule_id: '' }], next_cursor: 17 });
    assert.equal(r.next_cursor, '17');
    assert.deepEqual(r.events.map((e) => [e.id, e.host, e.action, e.rule_id]), [[1, 'a.de', 'blocked', 942100], [2, '', 'detected', null]]);
    assert.equal(W.eventsFrom({ items: [{ id: 3 }], cursor: '' }).next_cursor, null);
    assert.equal(W.eventsFrom({ data: [{ id: 3, action: 'x' }], next: 'n' }).events[0].action, 'unknown');
    assert.deepEqual(W.eventsFrom([{ id: 4 }]).events.length, 1);
    assert.deepEqual(W.eventsFrom(null), { events: [], next_cursor: null });
  });

  it('matchesFilter guards host, action and period', () => {
    const ev = { host: 'a.de', action: 'blocked', ts: '2026-09-13T08:00:00Z' };
    assert.ok(W.matchesFilter(ev, {}, NOW));
    assert.ok(W.matchesFilter(ev, { host: 'A.DE', action: 'blocked' }, NOW));
    assert.ok(!W.matchesFilter(ev, { host: 'b.de' }, NOW));
    assert.ok(!W.matchesFilter(ev, { action: 'detected' }, NOW));
    assert.ok(!W.matchesFilter(Object.assign({}, ev, { ts: '2026-09-10T08:00:00Z' }), { range: '24h' }, NOW));
    assert.ok(W.matchesFilter(Object.assign({}, ev, { ts: '2026-09-10T08:00:00Z' }), { range: '7d' }, NOW));
    assert.ok(W.matchesFilter(Object.assign({}, ev, { ts: 'garbage' }), {}, NOW), 'unparsable ts is kept');
  });

  it('merges pages without duplicates, formats raw records and request lines', () => {
    const a = [{ id: 1 }, { id: 2 }];
    assert.deepEqual(W.mergeEvents(a, [{ id: 2 }, { id: 3 }]).map((e) => e.id), [1, 2, 3]);
    assert.equal(W.eventKey({ tx_id: 't', ts: 'x', rule_id: 5, host: 'h' }), 't|x|5|h');
    assert.equal(W.rawText('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(W.rawText({ b: 2 }), '{\n  "b": 2\n}');
    assert.equal(W.rawText('plain'), 'plain');
    assert.equal(W.rawText(null), '');
    assert.equal(W.requestLine({ method: 'post', uri: '/login?x=1' }), 'POST /login?x=1');
    assert.equal(W.requestLine({}), '/');
  });

  it('pathOfUri strips scheme, host, query and fragment', () => {
    assert.equal(W.pathOfUri('/wp-login.php?redirect=1'), '/wp-login.php');
    assert.equal(W.pathOfUri('https://a.de/api/v1/x?y#z'), '/api/v1/x');
    assert.equal(W.pathOfUri('https://a.de'), '/');
    assert.equal(W.pathOfUri('api/x'), '/api/x');
    assert.equal(W.pathOfUri(''), '/');
  });
});

describe('waf-ui: status, routes, deep links, errors', () => {
  const res = {
    ok: true, engine_available: false,
    routes: [
      { route_id: 7, host: 'Shop.example.com', mode: 'block', paranoia: 2, events_24h: 12, blocked_24h: 5 },
      { route_id: 3, host: 'app.example.com', mode: 'detect', paranoia: 1, events_24h: 4, blocked_24h: 0 },
    ],
  };

  it('statusFrom sorts routes and sums the tiles (or takes the answer totals)', () => {
    const s = W.statusFrom(res);
    assert.equal(s.engine_available, false);
    assert.deepEqual(s.routes.map((r) => r.host), ['app.example.com', 'shop.example.com']);
    assert.deepEqual(s.totals, { events_24h: 16, blocked_24h: 5, routes: 2 });
    assert.equal(W.statusFrom({ routes: [] }).engine_available, true, 'missing flag counts as available');
    assert.deepEqual(W.statusFrom({ routes: res.routes, totals: { events_24h: 99, blocked_24h: 9 } }).totals, { events_24h: 99, blocked_24h: 9, routes: 2 });
    assert.deepEqual(W.statusFrom(null), { engine_available: true, routes: [], totals: { events_24h: 0, blocked_24h: 0, routes: 0 } });
    // services/waf.js status(): top-level counters (distinct requests) win over the route sum.
    const real = W.statusFrom({ ok: true, licensed: true, engine_available: true, events_24h: 20, blocked_24h: 4, routes: [
      { route_id: 3, host: 'a.de', enabled: true, mode: 'block', paranoia: 2, exclusions: { rule_ids: [942100], paths: ['/api'] }, events_24h: 12, blocked_24h: 4 }] });
    assert.deepEqual(real.totals, { events_24h: 20, blocked_24h: 4, routes: 1 });
    assert.deepEqual(real.routes[0].exclusions, { rule_ids: [942100], paths: ['/api'] });
    assert.equal(real.routes[0].enabled, true);
  });

  it('known exclusions: API flag rule_excluded, route exclusions, path prefixes', () => {
    const routes = W.statusFrom({ routes: [{ route_id: 3, host: 'a.de', exclusions: { rule_ids: [942100], paths: ['/api'] } }] }).routes;
    const excl = W.routeExclusions(3, routes);
    assert.deepEqual(excl, { rule_ids: [942100], paths: ['/api'] });
    assert.equal(W.routeExclusions(9, routes), null);
    assert.ok(W.ruleExcluded({ rule_id: 1, rule_excluded: true }, null));
    assert.ok(W.ruleExcluded({ rule_id: 942100 }, excl));
    assert.ok(!W.ruleExcluded({ rule_id: 941100 }, excl));
    assert.ok(W.pathExcluded({ uri: '/api/v1/x?y=1' }, excl));
    assert.ok(!W.pathExcluded({ uri: '/login' }, excl));
    assert.ok(!W.pathExcluded({ uri: '/api' }, null));
  });

  it('detailOf reads the redacted raw record (object or JSON) without the own rule', () => {
    const raw = { request: 'GET /?q=1 HTTP/1.1', rule_engine: 'On', interrupted: true,
      rule: { id: 942100, msg: 'SQL Injection', severity: 'critical', data: 'Matched Data: 1 UNION', tags: ['attack-sqli', 'OWASP_CRS'] },
      messages: [{ id: 942100, msg: 'SQL Injection', severity: 'critical' }, { id: 949110, msg: 'Inbound Anomaly Score Exceeded', severity: 'emergency' }] };
    const d = W.detailOf({ rule_id: 942100, raw });
    assert.deepEqual(d, { request: 'GET /?q=1 HTTP/1.1', rule_engine: 'On', interrupted: true, data: 'Matched Data: 1 UNION',
      tags: ['attack-sqli', 'OWASP_CRS'], others: [{ id: 949110, msg: 'Inbound Anomaly Score Exceeded', severity: 'emergency' }] });
    assert.deepEqual(W.detailOf({ rule_id: 942100, raw: JSON.stringify(raw) }), d);
    assert.equal(W.detailOf({ raw: null }), null);
    assert.equal(W.detailOf({ raw: 'not json' }), null);
    const small = W.detailOf({ rule_id: 5, raw: { request: 'GET /', rule: { id: 5 } } });
    assert.deepEqual([small.tags, small.others, small.interrupted, small.data], [[], [], null, '']);
  });

  it('routeIdFor prefers the event route, else the WAF route of the host', () => {
    const routes = W.statusFrom(res).routes;
    assert.equal(W.routeIdFor({ route_id: '9', host: 'x' }, routes), 9);
    assert.equal(W.routeIdFor({ host: 'shop.example.com' }, routes), 7);
    assert.equal(W.routeIdFor({ host: 'unknown.example.com' }, routes), null);
  });

  it('hostOptions merges status, events and the current filter', () => {
    const routes = W.statusFrom(res).routes;
    assert.deepEqual(W.hostOptions(routes, [{ host: 'b.de' }, { host: 'APP.example.com' }], 'deep.link.de'),
      ['app.example.com', 'b.de', 'deep.link.de', 'shop.example.com']);
  });

  it('deep links /waf?host=&action=&range= round-trip, defaults omitted', () => {
    assert.deepEqual(W.parseDeepLink('?host=Shop.Example.com&action=blocked&range=7d'), { host: 'shop.example.com', action: 'blocked', range: '7d' });
    assert.deepEqual(W.parseDeepLink('?action=evil&range=1y&x=1'), { host: '', action: 'all', range: '24h' });
    assert.deepEqual(W.parseDeepLink(''), { host: '', action: 'all', range: '24h' });
    assert.equal(W.deepLinkQuery({ host: 'a.de', action: 'all', range: '24h' }), '?host=a.de');
    assert.equal(W.deepLinkQuery({}), '');
    assert.equal(W.deepLinkQuery({ action: 'detected', range: '30d' }), '?action=detected&range=30d');
    assert.equal(W.pageHref('App.de'), '/waf?host=app.de');
  });

  it('maps contract and API error codes to existing texts', () => {
    for (const code of ['WAF_MODE_INVALID', 'WAF_PARANOIA_INVALID', 'WAF_REQUIRES_HTTP', 'WAF_RULE_ID_INVALID', 'WAF_PATH_INVALID', 'WAF_EXCLUSION_REQUIRED',
      'WAF_EXCLUSION_LIMIT', 'WAF_EXCLUSION_NOT_FOUND', 'WAF_ROUTE_NOT_FOUND', 'WAF_CURSOR_INVALID', 'CADDY_SYNC_FAILED']) assert.ok(W.errorKey(code), code);
    for (const k of Object.values(W.ERROR_KEYS)) assert.ok(typeof de[k] === 'string' && de[k].length, k);
    assert.equal(W.errorKey('waf_mode_invalid'), 'waf.err.mode_invalid');
    assert.equal(W.errorKey('OTHER'), null);
  });
});
