'use strict';

// services/releaseWatch.js — the newest release of GateControl and of the
// apps for the "Updates" card: answers from the cache only, refreshes in the
// background (an hour between checks, back-off after a failure), keeps the
// versions in a small file and writes it only when something changed.
// Plus utils/version.js compareSemver (pre-releases) and the result form of
// the shared fetch (routes/api/client/update.js fetchReleaseResult).

process.env.NODE_ENV = 'test';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const MODULE = '../src/services/releaseWatch';
function fresh() { delete require.cache[require.resolve(MODULE)]; return require(MODULE); }

const rel = (tag) => ({ tag_name: tag, html_url: `https://github.com/CallMeTechie/gatecontrol/releases/tag/${tag}` });

describe('compareSemver', () => {
  const { compareSemver } = require('../src/utils/version');
  it('orders plain versions numerically', () => {
    assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
    assert.equal(compareSemver('v2.0.0', '1.99.99'), 1);
    assert.equal(compareSemver('1.2.3', 'v1.2.3'), 0);
  });
  it('a pre-release is older than its release, and pre-releases order by their identifiers', () => {
    assert.equal(compareSemver('1.2.3-beta.1', '1.2.3'), -1);
    assert.equal(compareSemver('1.2.3', '1.2.3-rc.1'), 1);
    assert.equal(compareSemver('1.2.3-beta.2', '1.2.3-beta.10'), -1);
    assert.equal(compareSemver('1.2.3-alpha', '1.2.3-beta'), -1);
    assert.equal(compareSemver('1.2.3-beta', '1.2.3-beta.1'), -1);
    assert.equal(compareSemver('1.2.3-1', '1.2.3-beta'), -1);
    assert.equal(compareSemver('1.3.0-beta.1', '1.2.9'), 1);
  });
  it('ignores build metadata and answers null for anything that is not x.y.z', () => {
    assert.equal(compareSemver('1.2.3+45', '1.2.3'), 0);
    assert.equal(compareSemver('1.2', '1.2.3'), null);
    assert.equal(compareSemver('', '1.2.3'), null);
    assert.equal(compareSemver(null, '1.2.3'), null);
    assert.equal(compareSemver('1.2.3', 'latest'), null);
  });
});

describe('releaseWatch', () => {
  let svc;
  let tmpDir;
  let file;
  let calls;
  let answer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-relwatch-'));
    file = path.join(tmpDir, 'latest-releases.json');
    process.env.GC_LATEST_RELEASES_CACHE = file;
    svc = fresh();
    calls = [];
    answer = () => ({ ok: true, data: rel('v1.270.0') });
    svc._setFetch(async (product, channel) => { calls.push(`${product}:${channel}`); return answer(product, channel); });
  });
  afterEach(() => {
    delete process.env.GC_LATEST_RELEASES_CACHE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a cold cache answers "nothing known" at once and never asks by reading', () => {
    const t0 = Date.now();
    assert.deepEqual(svc.get('server'), { version: null, url: null, checked_at: null, failed: false, failed_at: null, reason: null });
    assert.equal(svc.latestVersion('android', 'beta'), null);
    assert.equal(svc.isOutdated('android', 'stable', '1.0.0'), null);
    assert.ok(Date.now() - t0 < 100);
    assert.equal(calls.length, 0);
  });

  it('without a fetch function (tests, no override) refresh() does nothing', async () => {
    svc._setFetch(null);
    assert.equal(await svc.refresh(['server:stable']), false);
    assert.equal(svc.get('server').version, null);
  });

  it('refresh() fetches the wanted entries one after another and remembers version, link and time', async () => {
    let running = 0;
    let maxRunning = 0;
    svc._setFetch(async (product) => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      calls.push(product);
      return { ok: true, data: rel(product === 'server' ? 'v1.270.0' : 'v1.17.2') };
    });
    const before = Date.now();
    await svc.refresh(['server:stable', 'android:stable', 'pro:beta']);
    assert.deepEqual(calls, ['server', 'android', 'pro']);
    assert.equal(maxRunning, 1, 'never two requests at once');
    const s = svc.get('server');
    assert.equal(s.version, '1.270.0');
    assert.equal(s.url, 'https://github.com/CallMeTechie/gatecontrol/releases/tag/v1.270.0');
    assert.ok(s.checked_at >= before && s.failed === false);
    assert.equal(svc.latestVersion('android'), '1.17.2');
    assert.equal(svc.latestVersion('pro', 'beta'), '1.17.2');
  });

  it('an entry is asked at most once an hour', async () => {
    await svc.refresh(['server:stable']);
    await svc.refresh(['server:stable']);
    await svc.refresh(['server:stable']);
    assert.equal(calls.length, 1);
    svc._entry('server:stable').fetchedAt = Date.now() - svc.CACHE_TTL - 1000;
    await svc.refresh(['server:stable']);
    assert.equal(calls.length, 2);
  });

  it('unknown keys are ignored (no request for a made-up product or a server beta channel)', async () => {
    await svc.refresh(['ios:stable', 'server:beta', 'android:nightly', 'android', '__proto__:stable']);
    assert.equal(calls.length, 0);
  });

  it('a failure keeps the last version, says so, and backs off (30 s, doubling, at most 30 min)', async () => {
    await svc.refresh(['server:stable']);
    const e = svc._entry('server:stable');
    e.fetchedAt = 0;
    answer = () => ({ ok: false, data: null, reason: 'unreachable' });
    await svc.refresh(['server:stable']);
    let s = svc.get('server');
    assert.equal(s.version, '1.270.0', 'last known version stays');
    assert.equal(s.failed, true);
    assert.equal(s.reason, 'unreachable');
    assert.ok(s.failed_at > 0 && s.checked_at > 0);
    assert.equal(e.backoffMs, svc.BACKOFF_MIN_MS);
    // inside the back-off nothing is asked
    await svc.refresh(['server:stable']);
    assert.equal(calls.length, 2);
    for (let i = 0; i < 10; i++) { e.nextTryAt = 0; await svc.refresh(['server:stable']); }
    assert.equal(e.backoffMs, svc.BACKOFF_MAX_MS);
    // …and the next good answer clears it
    e.nextTryAt = 0;
    answer = () => ({ ok: true, data: rel('v1.271.0') });
    await svc.refresh(['server:stable']);
    s = svc.get('server');
    assert.deepEqual([s.version, s.failed, s.failed_at, s.reason], ['1.271.0', false, null, null]);
    assert.equal(e.backoffMs, 0);
  });

  it('a used-up rate limit (last known release handed back, ok: false) counts as a failed check', async () => {
    await svc.refresh(['android:stable']);
    svc._entry('android:stable').fetchedAt = 0;
    answer = () => ({ ok: false, data: rel('v9.9.9'), reason: 'rate_limited' });
    await svc.refresh(['android:stable']);
    const s = svc.get('android');
    assert.equal(s.version, '1.270.0');
    assert.deepEqual([s.failed, s.reason], [true, 'rate_limited']);
  });

  it('a fetch that throws is a failure, not a crash', async () => {
    svc._setFetch(async () => { throw new Error('boom'); });
    await svc.refresh(['server:stable']);
    assert.equal(svc.get('server').failed, true);
  });

  it('an answer without a readable tag keeps the version and counts as checked', async () => {
    await svc.refresh(['pro:beta']);
    svc._entry('pro:beta').fetchedAt = 0;
    answer = () => ({ ok: true, data: null }); // beta listing without a usable release
    await svc.refresh(['pro:beta']);
    assert.deepEqual([svc.get('pro', 'beta').version, svc.get('pro', 'beta').failed], ['1.270.0', false]);
    svc._entry('pro:beta').fetchedAt = 0;
    answer = () => ({ ok: true, data: { tag_name: 'nightly', html_url: 'javascript:alert(1)' } });
    await svc.refresh(['pro:beta']);
    assert.equal(svc.get('pro', 'beta').version, '1.270.0');
  });

  it('only a release page on github.com is kept as link', async () => {
    answer = () => ({ ok: true, data: { tag_name: 'v1.2.3', html_url: 'https://evil.example/releases/tag/v1.2.3' } });
    await svc.refresh(['server:stable']);
    assert.deepEqual([svc.get('server').version, svc.get('server').url], ['1.2.3', null]);
  });

  it('force asks again whatever the age — at most once a minute per entry, and through a back-off', async () => {
    await svc.refresh(['server:stable']);
    await svc.refresh(['server:stable'], { force: true });
    assert.equal(calls.length, 1, 'a minute has not passed');
    const e = svc._entry('server:stable');
    e.attemptAt = Date.now() - svc.FORCE_MIN_MS - 1000;
    e.nextTryAt = Date.now() + 60 * 60 * 1000;
    await svc.refresh(['server:stable'], { force: true });
    assert.equal(calls.length, 2);
  });

  it('the file is written when a version changed — not on every check — and read again after a restart', async () => {
    await svc.refresh(['server:stable', 'android:stable']);
    assert.equal(svc._writeCount(), 1, 'one write for the whole round');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc.releases).sort(), ['android:stable', 'server:stable']);
    assert.equal(doc.releases['server:stable'].version, '1.270.0');
    // the same answer an hour later: nothing to write
    for (const k of ['server:stable', 'android:stable']) svc._entry(k).fetchedAt = 0;
    await svc.refresh(['server:stable', 'android:stable']);
    assert.equal(calls.length, 4);
    assert.equal(svc._writeCount(), 1);
    // a failure writes nothing either
    svc._entry('server:stable').fetchedAt = 0;
    answer = () => ({ ok: false, data: null, reason: 'http_503' });
    await svc.refresh(['server:stable']);
    assert.equal(svc._writeCount(), 1);
    // a new version does
    svc._entry('server:stable').nextTryAt = 0;
    answer = () => ({ ok: true, data: rel('v1.271.0') });
    await svc.refresh(['server:stable']);
    assert.equal(svc._writeCount(), 2);
    assert.deepEqual(fs.readdirSync(tmpDir), ['latest-releases.json'], 'no temp file left');

    const again = fresh();
    const s = again.get('server');
    assert.equal(s.version, '1.271.0');
    assert.ok(s.checked_at > 0, 'the time of the last check survives');
    assert.equal(s.failed, false);
    assert.equal(again.latestVersion('android'), '1.270.0');
  });

  it('an unchanged version is written again once its stored check time is a day old', async () => {
    await svc.refresh(['server:stable']);
    assert.equal(svc._writeCount(), 1);
    assert.equal(await svc._persistIfChanged(Date.now() + 23 * 3600 * 1000), false);
    assert.equal(await svc._persistIfChanged(Date.now() + 25 * 3600 * 1000), true);
    assert.equal(svc._writeCount(), 2);
  });

  it('a broken or hostile cache file is ignored', () => {
    fs.writeFileSync(file, '{"releases":{"server:stable":{"version":"<script>","checkedAt":1},"ios:stable":{"version":"1.0.0"},"android:stable":{"version":"v1.2.3","url":"http://x","checkedAt":99999999999999}}}');
    const s = fresh();
    assert.equal(s.get('server').version, null);
    assert.equal(s.get('ios').version, null);
    assert.deepEqual([s.get('android').version, s.get('android').url, s.get('android').checked_at], ['1.2.3', null, null]);
    fs.writeFileSync(file, 'not json');
    assert.equal(fresh().get('server').version, null);
  });

  it('isOutdated: older, the same, newer, pre-releases, unreadable', async () => {
    svc._setFetch(async (product, channel) => ({ ok: true, data: rel(channel === 'beta' ? 'v1.18.0-beta.2' : 'v1.17.2') }));
    await svc.refresh(['android:stable', 'android:beta']);
    assert.equal(svc.isOutdated('android', 'stable', '1.16.0'), true);
    assert.equal(svc.isOutdated('android', 'stable', '1.17.2'), false);
    assert.equal(svc.isOutdated('android', 'stable', '1.17.2-rc.1'), true, 'a pre-release of the newest release is older');
    assert.equal(svc.isOutdated('android', 'stable', '1.18.0-beta.1'), false, 'a beta ahead of stable is not outdated');
    assert.equal(svc.isOutdated('android', 'beta', '1.18.0-beta.1'), true);
    assert.equal(svc.isOutdated('android', 'beta', '1.18.0-beta.2'), false);
    assert.equal(svc.isOutdated('android', 'beta', '1.18.0'), false);
    assert.equal(svc.isOutdated('android', 'stable', 'garbage'), null);
    assert.equal(svc.isOutdated('android', 'stable', ''), null);
    assert.equal(svc.isOutdated('pro', 'stable', '1.0.0'), null, 'nothing known about that app');
  });

  it('init() checks once after a delay and holds no timer open', async () => {
    process.env.GC_LATEST_RELEASES_INIT_MS = '20';
    const s = fresh();
    delete process.env.GC_LATEST_RELEASES_INIT_MS;
    const seen = [];
    s._setFetch(async (product) => { seen.push(product); return { ok: true, data: rel('v1.0.0') }; });
    const t = s.init(() => ['server:stable']);
    assert.equal(t.hasRef(), false);
    assert.equal(seen.length, 0, 'nothing at the call itself');
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(seen, ['server']);
  });
});

describe('fetchReleaseResult (the fetch the update routes and the watch share)', () => {
  const update = require('../src/routes/api/client/update');
  const { fetchReleaseResult, fetchLatestRelease, RELEASE_REPOS } = update._internals;
  const realGet = https.get;
  let routes;
  let requests;

  function fakeGet(url, opts, cb) {
    const target = String(url);
    requests.push(target);
    const req = new EventEmitter();
    req.destroy = (err) => { if (err) req.emit('error', err); };
    setImmediate(() => {
      const route = routes[target];
      if (!route) return req.emit('error', new Error(`unexpected request ${target}`));
      const res = new PassThrough();
      res.statusCode = route.status || 200;
      res.headers = route.headers || {};
      cb(res);
      res.end(route.body === undefined ? '' : route.body);
    });
    return req;
  }
  const SERVER_URL = `https://api.github.com/repos/${RELEASE_REPOS.server}/releases/latest`;

  beforeEach(() => { update._resetCache(); routes = {}; requests = []; https.get = fakeGet; });
  afterEach(() => { https.get = realGet; update._resetCache(); });

  it('asks the server repository for "server" and answers { ok, data }', async () => {
    assert.equal(RELEASE_REPOS.server, 'CallMeTechie/gatecontrol');
    routes[SERVER_URL] = { body: JSON.stringify({ tag_name: 'v1.270.0' }) };
    const r = await fetchReleaseResult('server', 'stable');
    assert.equal(r.ok, true);
    assert.equal(r.data.tag_name, 'v1.270.0');
    assert.deepEqual(requests, [SERVER_URL]);
    // within the two minutes of the shared cache nothing is asked again
    assert.equal((await fetchReleaseResult('server', 'stable')).ok, true);
    assert.equal(requests.length, 1);
    assert.equal((await fetchLatestRelease('server', 'stable')).tag_name, 'v1.270.0');
  });

  it('names the failure: HTTP status, no connection, not JSON', async () => {
    routes[SERVER_URL] = { status: 503 };
    assert.deepEqual(await fetchReleaseResult('server', 'stable'), { ok: false, data: null, reason: 'http_503' });
    delete routes[SERVER_URL];
    assert.deepEqual(await fetchReleaseResult('server', 'stable'), { ok: false, data: null, reason: 'unreachable' });
    routes[SERVER_URL] = { body: '<html>' };
    assert.deepEqual(await fetchReleaseResult('server', 'stable'), { ok: false, data: null, reason: 'invalid' });
    assert.equal(await fetchLatestRelease('server', 'stable'), null, 'the old form still answers null');
  });

  it('a used-up rate limit hands back the last release with ok: false and asks nothing', async () => {
    routes[SERVER_URL] = { body: JSON.stringify({ tag_name: 'v1.270.0' }) };
    await fetchReleaseResult('server', 'stable');
    update._expireReleasesForTest();
    routes[SERVER_URL] = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } };
    const limited = await fetchReleaseResult('server', 'stable');
    assert.deepEqual([limited.ok, limited.reason, limited.data.tag_name], [false, 'rate_limited', 'v1.270.0']);
    const n = requests.length;
    const again = await fetchReleaseResult('server', 'stable');
    assert.deepEqual([again.ok, again.reason], [false, 'rate_limited']);
    assert.equal(requests.length, n, 'no request while the limit is used up');
  });
});

describe('gatewayRelease.getStatus', () => {
  let tmpDir;
  const GW = '../src/services/gatewayRelease';
  const freshGw = () => { delete require.cache[require.resolve(GW)]; return require(GW); };
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwrel-'));
    process.env.GC_GATEWAY_LATEST_CACHE = path.join(tmpDir, 'gateway-latest-version.json');
  });
  afterEach(() => { delete process.env.GC_GATEWAY_LATEST_CACHE; fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('nothing known: no version, no time, not failed', () => {
    assert.deepEqual(freshGw().getStatus(), { version: null, checked_at: null, failed: false, failed_at: null });
  });

  it('a persisted version carries the time it was stored', () => {
    fs.writeFileSync(process.env.GC_GATEWAY_LATEST_CACHE, JSON.stringify({ version: '1.31.0', savedAt: 1700000000000 }));
    assert.deepEqual(freshGw().getStatus(), { version: '1.31.0', checked_at: 1700000000000, failed: false, failed_at: null });
  });

  it('a successful check sets the time, a failed one says so and keeps the version', async () => {
    const svc = freshGw();
    svc._setTransport(async () => ({ status: 200, body: JSON.stringify({ tag_name: 'v1.31.0' }) }));
    const before = Date.now();
    svc._fetchLatest();
    await new Promise((r) => setImmediate(r));
    let s = svc.getStatus();
    assert.equal(s.version, '1.31.0');
    assert.ok(s.checked_at >= before && !s.failed);
    svc._setTransport(async () => ({ status: 503, body: '' }));
    svc._fetchLatest();
    await new Promise((r) => setImmediate(r));
    s = svc.getStatus();
    assert.deepEqual([s.version, s.failed], ['1.31.0', true]);
    assert.ok(s.failed_at >= before);
    svc._setTransport(async () => ({ status: 200, body: JSON.stringify({ tag_name: 'v1.31.1' }) }));
    svc._resetBackoff();
    svc._fetchLatest();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([svc.getStatus().version, svc.getStatus().failed, svc.getStatus().failed_at], ['1.31.1', false, null]);
    svc._setTransport(null);
  });
});
