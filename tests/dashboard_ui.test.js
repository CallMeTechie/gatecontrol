'use strict';

// Pure helpers of the dashboard (public/js/dashboard-ui.js): formatting,
// y-axis ticks, relative times, bucket labels, chart geometry, tile states,
// the headline — and the activity categories, which must match the server's
// allow-list (src/services/activityCategories.js) exactly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/js/dashboard-ui.js');
const server = require('../src/services/activityCategories');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const tDe = (k) => (de[k] != null ? de[k] : k);
const tEn = (k) => (en[k] != null ? en[k] : k);

describe('formatting', () => {
  it('bytes in binary units with German / English decimals', () => {
    assert.equal(UI.fmtBytes(0, 'de'), '0 B');
    assert.equal(UI.fmtBytes(512, 'de'), '512 B');
    assert.equal(UI.fmtBytes(4.2 * 1024 ** 3, 'de'), '4,2 GB');
    assert.equal(UI.fmtBytes(4.2 * 1024 ** 3, 'en'), '4.2 GB');
    assert.equal(UI.fmtBytes(123 * 1024 ** 2, 'de'), '123 MB');
    assert.equal(UI.fmtRate(1536, 'de'), '1,5 KB/s');
  });
  it('numbers and percent', () => {
    assert.equal(UI.fmtNumber(42310, 'de'), '42.310');
    assert.equal(UI.fmtNumber(42310, 'en'), '42,310');
    assert.equal(UI.fmtNumber(0.45, 'de', 1), '0,5');
    assert.equal(UI.fmtPercent(18, 'de'), '18 %');
    assert.equal(UI.fmtPercent(4.5, 'de'), '4,5 %');
    assert.equal(UI.fmtNumber(NaN, 'de'), '—');
  });
});

describe('y-axis ticks', () => {
  it('nice steps (1, 2, 2.5, 5 × 10^k) in one unit, 0 first, top ≥ max', () => {
    const a = UI.byteTicks(5.3 * 1024 ** 3, 'de', 4);
    assert.equal(a.unit, 'GB');
    assert.deepEqual(a.ticks.map((x) => x.label), ['0', '2 GB', '4 GB', '6 GB']);
    assert.ok(a.top >= 5.3 * 1024 ** 3);
    const b = UI.byteTicks(180 * 1024 ** 2, 'de', 4);
    assert.deepEqual(b.ticks.map((x) => x.label), ['0', '50 MB', '100 MB', '150 MB', '200 MB']);
    const c = UI.byteTicks(9 * 1024 ** 2, 'de', 4);
    assert.ok(c.ticks.every((x) => x.label === '0' || / MB$/.test(x.label)), c.ticks.map((x) => x.label).join());
    const d = UI.byteTicks(3.5 * 1024 ** 2, 'de', 4);
    assert.deepEqual(d.ticks.map((x) => x.label), ['0', '1 MB', '2 MB', '3 MB', '4 MB']);
    const e = UI.byteTicks(0.9 * 1024 ** 3, 'de', 4);
    assert.equal(e.unit, 'MB', '0.9 GB stays in MB');
    assert.equal(UI.byteTicks(0, 'de').ticks[0].label, '0');
  });
  it('decimal steps carry their decimals', () => {
    const t = UI.byteTicks(1.8 * 1024, 'de', 4);
    assert.deepEqual(t.ticks.map((x) => x.label), ['0', '0,5 KB', '1,0 KB', '1,5 KB', '2,0 KB']);
  });
  it('niceStep', () => {
    assert.equal(UI.niceStep(100, 4), 25);
    assert.equal(UI.niceStep(9, 4), 2.5);
    assert.equal(UI.niceStep(0, 4), 1);
  });
});

describe('times', () => {
  const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
  it('relative time, localised', () => {
    assert.equal(UI.relTime(NOW - 4000, NOW, tDe), 'gerade eben');
    assert.equal(UI.relTime(NOW - 42000, NOW, tDe), 'vor 42 s');
    assert.equal(UI.relTime(NOW - 14 * 60000, NOW, tDe), 'vor 14 Min.');
    assert.equal(UI.relTime(NOW - 2 * 3600000, NOW, tDe), 'vor 2 Std.');
    assert.equal(UI.relTime(NOW - 3 * 86400000, NOW, tDe), 'vor 3 Tagen');
    assert.equal(UI.relTime(NOW - 14 * 60000, NOW, tEn), '14 min ago');
    assert.equal(UI.relTime('', NOW, tDe), '');
  });
  it('SQLite timestamps are UTC, epoch seconds are accepted', () => {
    assert.equal(UI.parseTime('2026-10-04 11:00:00'), Date.UTC(2026, 9, 4, 11));
    assert.equal(UI.parseTime(1_791_000_000), 1_791_000_000_000);
    assert.equal(UI.relTime('2026-10-04 11:58:00', NOW, tEn), '2 min ago');
  });
  it('duration (for "seit …") and uptime', () => {
    assert.equal(UI.duration(NOW - 2 * 3600000, NOW, tDe), '2 Std.');
    assert.equal(UI.duration(NOW - 5 * 86400000, NOW, tEn), '5 days');
    assert.equal(UI.uptimeText(12 * 86400 + 5, tDe), '12 Tagen');
    assert.equal(UI.uptimeText(86400, tDe), '1 Tag');
    assert.equal(UI.uptimeText(3 * 3600, tEn), '3 hours');
    assert.equal(UI.uptimeText(30, tEn), '1 minute');
  });
  it('bucket labels: day buckets are calendar dates, minute/hour are local clock times', () => {
    assert.equal(UI.bucketLabel('2026-10-04', 'day', 'de', false), '4.10.');
    assert.match(UI.bucketLabel('2026-10-04', 'day', 'de', true), /4\. Okt/);
    assert.match(UI.bucketLabel('2026-10-04T13:00:00Z', 'hour', 'de', false), /^\d{2}:\d{2}$/);
    assert.match(UI.bucketLabel('2026-10-04T13:00:00Z', 'hour', 'de', true), /–/);
    assert.equal(UI.bucketLabel('garbage', 'hour', 'de'), '');
  });
  it('x tick indices: anchored on the newest bucket, at most ~7', () => {
    assert.deepEqual(UI.xTickIndices(24, 'hour'), [3, 7, 11, 15, 19, 23]);
    assert.deepEqual(UI.xTickIndices(60, 'minute'), [9, 19, 29, 39, 49, 59]);
    assert.deepEqual(UI.xTickIndices(7, 'day'), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(UI.xTickIndices(30, 'day').length <= 7);
    assert.equal(UI.xTickIndices(30, 'day').slice(-1)[0], 29);
    assert.ok(UI.xTickIndices(24, 'hour', 4).length <= 4);
    assert.deepEqual(UI.xTickIndices(0, 'hour'), []);
  });
});

describe('chart geometry', () => {
  it('points at bucket centres, y scaled to top, area closed at the baseline', () => {
    const pts = [{ download: 0, upload: 0 }, { download: 50, upload: 10 }, { download: 100, upload: 20 }];
    const g = UI.chartGeometry(pts, 100, 300, 100);
    assert.equal(g.xAt(0), 50);
    assert.equal(g.xAt(2), 250);
    assert.equal(g.yAt(100), 0);
    assert.equal(g.yAt(0), 100);
    assert.equal(g.down, 'M50.0 100.0 L150.0 50.0 L250.0 0.0');
    assert.match(g.area, /L250\.0 100 L50\.0 100 Z$/);
    assert.equal(UI.sparkPath([1], 100, 28), '');
    assert.match(UI.sparkLast([0, 2, 4], 100, 28), /^M50\.0 .* L100\.0 1\.0$/);
  });
  it('meter levels: > 70 % warn, > 90 % crit', () => {
    assert.equal(UI.meterLevel(70), 'ok');
    assert.equal(UI.meterLevel(71), 'warn');
    assert.equal(UI.meterLevel(90), 'warn');
    assert.equal(UI.meterLevel(91), 'crit');
  });
});

describe('activity categories', () => {
  it('the browser table equals the server allow-list', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(UI.ACTIVITY_CATEGORIES)), JSON.parse(JSON.stringify(server.CATEGORIES)));
    for (const ev of ['login_failed', 'login_2fa_failed', 'passkey_login_failed', 'peer_connected', 'gateway_down', 'route_down',
      'waf_ip_banned', 'tls_paused', 'backup_created', 'system_start', 'passkey_added', 'peerXconnected']) {
      assert.equal(UI.categoryOf(ev), server.categoryOf(ev), ev);
    }
    assert.equal(UI.categoryOf('login_failed'), 'login');
    assert.equal(UI.categoryOf('waf_ip_banned'), 'security');
    assert.equal(UI.categoryOf('backup_created'), 'system');
  });
  it('server: LIKE patterns escape _ and %', () => {
    assert.equal(server.likePrefix('peer_'), 'peer\\_%');
    const f = server.sqlFilter('peer');
    assert.equal(f.args.length, server.CATEGORIES.peer.length);
    assert.throws(() => server.sqlFilter('nope'));
  });
  it('severity → state', () => {
    assert.equal(UI.severityState('error'), 'crit');
    assert.equal(UI.severityState('warning'), 'warn');
    assert.equal(UI.severityState('success'), 'good');
    assert.equal(UI.severityState('info'), 'info');
  });
});

describe('health tiles and headline', () => {
  const stats = { peers: { clients: { online: 12, total: 18 } }, wireguard: { running: true }, routes: { active: 24 }, monitoring: { total: 0 } };
  it('tunnel', () => {
    assert.deepEqual(UI.tunnelTile(stats), { state: 'good', value: '12 / 18', sub: ['dashboard.tile_tunnel_ok', {}] });
    assert.equal(UI.tunnelTile({ ...stats, wireguard: { running: false } }).state, 'crit');
    assert.equal(UI.tunnelTile(null), null);
  });
  it('gateways', () => {
    const t = (k) => tDe(k);
    assert.equal(UI.gatewaysTile({ gateways: [] }, 0, t).state, 'none');
    const one = UI.gatewaysTile({ gateways: [{ status: 'online' }, { status: 'offline', name: 'garage', last_seen_at: 0 }] }, 7200000, t);
    assert.equal(one.state, 'crit');
    assert.equal(one.value, '1 / 2');
    assert.equal(one.sub[1].name, 'garage');
    assert.equal(one.sub[1].dur, '2 Std.');
    assert.equal(UI.gatewaysTile({ gateways: [{ status: 'degraded' }] }, 0, t).state, 'warn');
    assert.equal(UI.gatewaysTile({ gateways: [{ status: 'online' }] }, 0, t).state, 'good');
  });
  it('routes count entries behind offline gateways as unreachable', () => {
    const problems = { problems: [{ kind: 'entry_down' }, { kind: 'gateway_offline', gateway: { entries: 2 } }] };
    const r = UI.routesTile(stats, problems);
    assert.equal(r.state, 'warn');
    assert.deepEqual(r.sub[1], { n: 3, ok: 21 });
    assert.equal(UI.routesTile(stats, { problems: [] }).state, 'good');
    assert.equal(UI.routesTile({ ...stats, routes: { active: 0 } }, { problems: [] }).state, 'none');
  });
  it('certificates and security check', () => {
    assert.equal(UI.certsTile({ summary: { total: 14, failed: 1, expiring: 0 } }).state, 'crit');
    const exp = UI.certsTile({ summary: { total: 14, failed: 0, expiring: 1 }, hosts: [{ state: 'issued', days_left: 9 }, { state: 'issued', days_left: 50 }] });
    assert.equal(exp.state, 'warn');
    assert.deepEqual(exp.sub, ['dashboard.tile_certs_expiring_one', { n: 1, days: 9 }]);
    assert.equal(UI.certsTile({ summary: { total: 0 } }).state, 'none');
    assert.equal(UI.checkTile({ check: { pass: 8, total: 10, fail: 2, info: 0, critical: 0 } }).state, 'warn');
    assert.equal(UI.checkTile({ check: { pass: 9, total: 10, fail: 0, info: 1, critical: 0 } }).state, 'good');
    assert.equal(UI.checkTile({ check: { pass: 7, total: 10, fail: 3, info: 0, critical: 1 } }).state, 'crit');
    assert.equal(UI.checkTile({ check: null }), null);
  });
  it('headline: "Alles läuft" or N things, one phrase per kind', () => {
    const ok = UI.headline({ problems: [] }, stats, { gateways: [{}] });
    assert.deepEqual(ok.title, ['dashboard.headline_ok', {}]);
    assert.deepEqual(ok.sub.map((s) => s[0]), ['dashboard.sum_ok_peers_other', 'dashboard.sum_ok_gateways', 'dashboard.sum_ok_routes']);
    const bad = UI.headline({ problems: [{ kind: 'gateway_offline' }, { kind: 'entry_down' }, { kind: 'tls_expiring' }, { kind: 'tls_failed' }, { kind: 'tls_paused' }] }, stats, null);
    assert.deepEqual(bad.title, ['dashboard.headline_problems_other', { n: 5 }]);
    assert.deepEqual(bad.sub, [
      ['dashboard.sum_gateway_offline_one', { n: 1 }],
      ['dashboard.sum_entry_down_one', { n: 1 }],
      ['dashboard.sum_tls_broken_other', { n: 2 }],
      ['dashboard.sum_tls_expiring_one', { n: 1 }],
    ]);
  });
});

describe('i18n', () => {
  it('every dashboard.* key exists in de and en with the same placeholders', () => {
    const pick = (o) => Object.keys(o).filter((k) => k.startsWith('dashboard.')).sort();
    assert.deepEqual(pick(de), pick(en));
    const ph = (s) => (String(s).match(/\{\{?\w+\}?\}/g) || []).sort().join();
    for (const k of pick(de)) assert.equal(ph(de[k]), ph(en[k]), k);
  });
  it('every key the dashboard scripts and template use exists (plurals: _one and _other)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = ['public/js/dashboard.js', 'public/js/dashboard-ui.js', 'templates/aurora/pages/dashboard.njk']
      .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    const plurals = new Set(Array.from(src.matchAll(/plural\('(dashboard\.[a-z0-9_]+)'/g)).map((m) => m[1]));
    // headline() builds the sum_* keys through plural(key, n) with a variable key.
    for (const m of src.matchAll(/'(dashboard\.sum_[a-z_]+)'\]/g)) plurals.add(m[1]);
    const keys = new Set(Array.from(src.matchAll(/'((?:dashboard|problems)\.[a-z0-9_]+)'/g)).map((m) => m[1]).filter((k) => !k.endsWith('_')));
    for (const k of keys) {
      if (plurals.has(k)) {
        for (const f of ['_one', '_other']) for (const [n, loc] of [['de', de], ['en', en]]) assert.ok(loc[k + f], `${n}: ${k + f}`);
      } else if (!/^dashboard\.(sum_ok_peers|headline_problems|in_days|tile_check_open|tile_check_hints|tile_certs_expiring)$/.test(k)) {
        for (const [n, loc] of [['de', de], ['en', en]]) assert.ok(loc[k], `${n}: ${k}`);
      }
    }
    for (const s of ['good', 'warn', 'crit', 'none', 'unknown']) assert.ok(de['dashboard.state_' + s] && en['dashboard.state_' + s]);
  });
});
