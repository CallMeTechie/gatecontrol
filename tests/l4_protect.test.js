'use strict';

// Protection for TCP/UDP entries — docs/feature-next-package.md §S1.
//   §S1.1  the ban list becomes the first route of every L4 listener
//   §S1.2  the per-entry IP filter becomes a `close` route in front of it
//   §S1.3  the connection rate (log → counter → ban) and its validation
// Pure unit level: no Caddy, no DB. The generated shapes are checked against
// a real Caddy in tests/l4_protect_caddy_validate.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_LOG_LEVEL = process.env.GC_LOG_LEVEL || 'silent';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-l4protect-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');

const l4 = require('../src/services/l4');
const guard = require('../src/services/l4ConnGuard');
const rv = require('../src/services/routesValidation');

const INTERNAL = ['10.10.0.0/24'];
const base = {
  id: 1, route_type: 'l4', enabled: 1, external_enabled: 1,
  l4_protocol: 'tcp', l4_listen_port: '2023', l4_tls_mode: 'none',
  target_ip: '10.10.0.5', target_port: 22, domain: null,
};

// ─── §S1.1 ban list ─────────────────────────────────────

test('without bans and without filters the L4 servers are unchanged', () => {
  const before = l4.buildL4Servers([{ ...base }], INTERNAL);
  const withEmpty = l4.buildL4Servers([{ ...base }], INTERNAL, { banRanges: [] });
  assert.deepEqual(withEmpty, before);
  assert.equal(JSON.stringify(withEmpty), JSON.stringify(before), 'byte-identical, key order included');
  assert.deepEqual(Object.keys(before), ['l4-tcp-2023']);
  assert.equal(before['l4-tcp-2023'].routes.length, 1);
  assert.equal(before['l4-tcp-2023'].routes[0].handle[0].handler, 'proxy');
});

test('banned addresses become the FIRST route of every L4 listener', () => {
  const ranges = ['45.33.32.156/32', '198.51.100.0/24', '2a01:4f8:1:2::3/128'];
  const servers = l4.buildL4Servers(
    [{ ...base }, { ...base, id: 2, l4_listen_port: '3389', l4_protocol: 'udp' }],
    INTERNAL, { banRanges: ranges },
  );
  for (const name of ['l4-tcp-2023', 'l4-udp-3389']) {
    const routes = servers[name].routes;
    assert.equal(routes.length, 2, name);
    assert.deepEqual(routes[0], { match: [{ remote_ip: { ranges } }], handle: [{ handler: 'close' }] });
    assert.equal(routes[1].handle[0].handler, 'proxy', 'the entry route keeps its place after the ban route');
  }
});

// ─── §S1.2 IP filter ────────────────────────────────────

test('allow filter: everything that is not on the list is closed', () => {
  const r = { ...base, ip_filter_enabled: 1, ip_filter_mode: 'whitelist', ip_filter_rules: JSON.stringify([{ type: 'ip', value: '203.0.113.7' }, { type: 'cidr', value: '198.51.100.0/24' }]) };
  const routes = l4.buildL4Servers([r], INTERNAL).routes || l4.buildL4Servers([r], INTERNAL)['l4-tcp-2023'].routes;
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0], {
    match: [{ not: [{ remote_ip: { ranges: ['203.0.113.7/32', '198.51.100.0/24'] } }] }],
    handle: [{ handler: 'close' }],
  });
  assert.equal(routes[1].handle[0].handler, 'proxy');
});

test("allow filter with no usable rule closes everything (fail closed)", () => {
  const r = { ...base, ip_filter_enabled: 1, ip_filter_mode: 'allow', ip_filter_rules: '[]' };
  const routes = l4.buildL4Servers([r], INTERNAL)['l4-tcp-2023'].routes;
  assert.deepEqual(routes[0], { handle: [{ handler: 'close' }] }, 'no match = every connection');
});

test('deny filter: exactly the listed addresses are closed; an empty list is a no-op', () => {
  const deny = { ...base, ip_filter_enabled: 1, ip_filter_mode: 'blacklist', ip_filter_rules: JSON.stringify([{ type: 'cidr', value: '45.33.0.0/16' }]) };
  const routes = l4.buildL4Servers([deny], INTERNAL)['l4-tcp-2023'].routes;
  assert.deepEqual(routes[0], { match: [{ remote_ip: { ranges: ['45.33.0.0/16'] } }], handle: [{ handler: 'close' }] });

  const empty = { ...deny, ip_filter_rules: '[]' };
  assert.equal(l4.buildL4Servers([empty], INTERNAL)['l4-tcp-2023'].routes.length, 1, 'nothing to deny → no guard');
});

test('country rules have no layer-4 matcher and are ignored', () => {
  const r = { ...base, ip_filter_enabled: 1, ip_filter_mode: 'blacklist', ip_filter_rules: JSON.stringify([{ type: 'country', value: 'CN' }]) };
  assert.equal(l4.l4IpFilter(r), null);
  const allow = { ...r, ip_filter_mode: 'whitelist' };
  assert.deepEqual(l4.l4IpFilter(allow), { mode: 'allow', ranges: [] }, 'an allow list of country rules closes everything');
});

test('on a TLS listener the guard carries the entry SNI so it only closes its own entry', () => {
  const a = { ...base, id: 1, l4_tls_mode: 'passthrough', domain: 'a.example', ip_filter_enabled: 1, ip_filter_mode: 'whitelist', ip_filter_rules: JSON.stringify([{ type: 'ip', value: '203.0.113.7' }]) };
  const b = { ...base, id: 2, l4_tls_mode: 'passthrough', domain: 'b.example' };
  const routes = l4.buildL4Servers([a, b], INTERNAL, { banRanges: ['1.2.3.4/32'] })['l4-tls-2023'].routes;
  assert.equal(routes.length, 4);
  assert.deepEqual(routes[0].match, [{ remote_ip: { ranges: ['1.2.3.4/32'] } }]);
  assert.deepEqual(routes[1].match, [{ tls: { sni: ['a.example'] }, not: [{ remote_ip: { ranges: ['203.0.113.7/32'] } }] }]);
  assert.deepEqual(routes[2].match, [{ tls: { sni: ['a.example'] } }]);
  assert.deepEqual(routes[3].match, [{ tls: { sni: ['b.example'] } }], 'the unfiltered entry is untouched');
});

test('an internal-only entry keeps its VPN gate and gets the filter on top', () => {
  const r = { ...base, external_enabled: 0, ip_filter_enabled: 1, ip_filter_mode: 'whitelist', ip_filter_rules: JSON.stringify([{ type: 'ip', value: '10.10.0.9' }]) };
  const routes = l4.buildL4Servers([r], INTERNAL)['l4-tcp-2023'].routes;
  assert.deepEqual(routes[0].match, [{ not: [{ remote_ip: { ranges: ['10.10.0.9/32'] } }] }]);
  assert.deepEqual(routes[1].match, [{ remote_ip: { ranges: INTERNAL } }]);
});

test('toRange normalises single addresses and rejects nonsense', () => {
  assert.equal(l4.toRange('203.0.113.7'), '203.0.113.7/32');
  assert.equal(l4.toRange('2a01:4f8::1'), '2a01:4f8::1/128');
  assert.equal(l4.toRange(' 10.0.0.0/8 '), '10.0.0.0/8');
  for (const bad of ['', null, 'nope', '10.0.0.0/99', 'x'.repeat(70)]) assert.equal(l4.toRange(bad), null, String(bad));
});

// ─── §S1.3 connection rate ──────────────────────────────

test('isArmed needs both fields and an L4 entry', () => {
  assert.equal(guard.isArmed({ route_type: 'l4', l4_conn_limit: 10, l4_conn_window_s: 60 }), true);
  assert.equal(guard.isArmed({ route_type: 'l4', l4_conn_limit: 10, l4_conn_window_s: null }), false);
  assert.equal(guard.isArmed({ route_type: 'l4', l4_conn_limit: 0, l4_conn_window_s: 60 }), false);
  assert.equal(guard.isArmed({ route_type: 'http', l4_conn_limit: 10, l4_conn_window_s: 60 }), false);
});

test('the Caddy log block is a dedicated DEBUG file for the layer4 logger', () => {
  const cfg = guard.logConfig();
  assert.equal(cfg.level, 'DEBUG');
  assert.deepEqual(cfg.include, ['layer4']);
  assert.equal(cfg.writer.output, 'file');
  assert.match(cfg.writer.filename, /l4conn\.log$/);
  assert.ok(cfg.writer.roll_size_mb > 0 && cfg.writer.roll_keep > 0, 'the file must stay bounded');
});

test('parseLine reads exactly the connection lines of caddy-l4', () => {
  const line = '{"level":"debug","ts":1789564839.6350486,"logger":"layer4","msg":"started handling connection","network":"tcp","local":"172.31.9.20:2023","remote":"203.0.113.7:42613"}';
  assert.deepEqual(guard.parseLine(line), { ts: 1789564839635, ip: '203.0.113.7', port: '2023' });

  const v6 = '{"level":"debug","ts":1,"logger":"layer4","msg":"started handling connection","local":"[2a01:4f8::2]:2023","remote":"[2a01:4f8::9]:5","network":"tcp"}';
  assert.deepEqual(guard.parseLine(v6), { ts: 1000, ip: '2a01:4f8::9', port: '2023' });

  for (const other of [
    '',
    'not json',
    '{"logger":"layer4","msg":"stopped handling connection; connection stats","local":"1.2.3.4:2023","remote":"5.6.7.8:9"}',
    '{"logger":"layer4","msg":"started handling listener socket","address":"[::]:2023"}',
    '{"logger":"http.log.access","msg":"started handling connection","local":"1.2.3.4:443","remote":"5.6.7.8:9"}',
  ]) assert.equal(guard.parseLine(other), null, JSON.stringify(other).slice(0, 60));
});

test('limitsByPort takes the strictest limit of the entries on a listener', () => {
  const m = guard.limitsByPort([
    { route_type: 'l4', enabled: 1, l4_listen_port: '2023', l4_conn_limit: 20, l4_conn_window_s: 60 },
    { route_type: 'l4', enabled: 1, l4_listen_port: '2023', l4_conn_limit: 5, l4_conn_window_s: 120 },
    { route_type: 'l4', enabled: 0, l4_listen_port: '3389', l4_conn_limit: 5, l4_conn_window_s: 60 },
    { route_type: 'l4', enabled: 1, l4_listen_port: '4000-4010', l4_conn_limit: 5, l4_conn_window_s: 60 },
    { route_type: 'l4', enabled: 1, l4_listen_port: '5000' },
  ]);
  assert.deepEqual([...m.keys()], ['2023']);
  assert.deepEqual(m.get('2023'), { limit: 5, windowS: 120 });
});

test('record bans above the limit, not at it, and only for listeners with one', () => {
  guard.resetCounters();
  const limits = new Map([['2023', { limit: 3, windowS: 60 }]]);
  const t0 = 1_700_000_000_000;
  const ev = (n, ip = '203.0.113.7', port = '2023') => ({ ts: t0 + n * 1000, ip, port });

  assert.deepEqual(guard.record([ev(0), ev(1), ev(2)], limits), [], '3 of 3 is still fine');
  const hit = guard.record([ev(3)], limits);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].ip, '203.0.113.7');
  assert.equal(hit[0].hits, 4);
  assert.equal(hit[0].window_s, 60);
  assert.equal(new Date(hit[0].first_seen).getTime(), t0);
  assert.deepEqual(guard.record([ev(4)], limits), [], 'the counter starts over after a hit');

  guard.resetCounters();
  assert.deepEqual(guard.record([ev(0, '1.2.3.4', '9999'), ev(1, '1.2.3.4', '9999')], limits), [], 'no limit on that port');

  guard.resetCounters();
  const old = [ev(0), ev(1), ev(2)];
  assert.deepEqual(guard.record([...old, { ts: t0 + 61_000, ip: '203.0.113.7', port: '2023' }], limits), [],
    'connections that fell out of the window do not count');
  guard.resetCounters();
});

// ─── §S1.2/§S1.3 API validation ─────────────────────────

function codeOf(fn) {
  try { fn(); return null; } catch (err) { return err.code + '/' + err.statusCode; }
}

test('validateIpFilter: modes, aliases and rule shapes', () => {
  const d = { ip_filter_mode: 'allow' };
  rv.validateIpFilter(d, { routeType: 'l4' });
  assert.equal(d.ip_filter_mode, 'whitelist', 'the contract spelling maps onto the stored one');
  const d2 = { ip_filter_mode: 'deny' };
  rv.validateIpFilter(d2, { routeType: 'l4' });
  assert.equal(d2.ip_filter_mode, 'blacklist');

  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_mode: 'maybe' }, {})), 'IP_FILTER_MODE_INVALID/400');
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: '{' }, {})), 'IP_FILTER_RULE_INVALID/400');
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: [{ type: 'ip', value: 'nope' }] }, {})), 'IP_FILTER_RULE_INVALID/400');
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: [{ type: 'cidr', value: '10.0.0.1' }] }, {})), 'IP_FILTER_RULE_INVALID/400');
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: [{ type: 'nope', value: 'x' }] }, {})), 'IP_FILTER_RULE_INVALID/400');

  // country: fine for HTTP, refused for L4 (caddy-l4 has no geo matcher).
  rv.validateIpFilter({ ip_filter_rules: [{ type: 'country', value: 'DE' }] }, { routeType: 'http' });
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: [{ type: 'country', value: 'DE' }] }, { routeType: 'l4' })), 'IP_FILTER_COUNTRY_L4/400');
  assert.equal(codeOf(() => rv.validateIpFilter({ ip_filter_rules: [{ type: 'country', value: 'Germany' }] }, { routeType: 'http' })), 'IP_FILTER_RULE_INVALID/400');

  // Untouched payloads stay untouched.
  const untouched = {};
  rv.validateIpFilter(untouched, { routeType: 'l4' });
  assert.deepEqual(untouched, {});
});

test('validateL4ConnRate: both or neither, in range, L4 only', () => {
  rv.validateL4ConnRate({}, { routeType: 'l4' });
  rv.validateL4ConnRate({ l4_conn_limit: 0, l4_conn_window_s: 0 }, { routeType: 'http' });
  rv.validateL4ConnRate({ l4_conn_limit: 20, l4_conn_window_s: 60 }, { routeType: 'l4' });
  rv.validateL4ConnRate({ l4_conn_limit: '20', l4_conn_window_s: '60' }, { routeType: 'l4' });
  // A patch may send one half when the other is already stored.
  rv.validateL4ConnRate({ l4_conn_limit: 5 }, { routeType: 'l4', current: { l4_conn_window_s: 60 } });

  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 20 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 20, l4_conn_window_s: 60 }, { routeType: 'http' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 0, l4_conn_window_s: 60 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 999999, l4_conn_window_s: 60 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 20, l4_conn_window_s: 99999 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: -1, l4_conn_window_s: 60 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');
  assert.equal(codeOf(() => rv.validateL4ConnRate({ l4_conn_limit: 1.5, l4_conn_window_s: 60 }, { routeType: 'l4' })), 'L4_CONN_RATE_INVALID/400');

  // Clearing: an explicit 0 / null / '' switches it off without an error.
  rv.validateL4ConnRate({ l4_conn_limit: 0, l4_conn_window_s: 0 }, { routeType: 'l4', current: { l4_conn_limit: 20, l4_conn_window_s: 60 } });
  rv.validateL4ConnRate({ l4_conn_limit: null, l4_conn_window_s: null }, { routeType: 'l4', current: { l4_conn_limit: 20, l4_conn_window_s: 60 } });
});

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
