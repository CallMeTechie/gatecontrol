'use strict';

// Home cache, a withdrawal: the gateways that hold a withdrawn blob (home_cache_have) and name the
// capability `cache-withdraw` are asked to match their stock now (POST /api/cache/sync over the
// management API) — gathered, at most once per gateway in a gap, never per blob; an older gateway is
// left to its interval, a failed call is only logged.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, teardown } = require('./helpers/setup');

let db, hc, gateways, gwNew, gwOld, gwOff, origMgmt;
const calls = [];
let answer = async () => ({ status: 202, body: { accepted: true } });
const P = 'drive-demo';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function health(peerId, capabilities) {
  db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({
    telemetry: { gateway_version: '1.60.0', ...(capabilities ? { capabilities } : {}) },
  }), Date.now(), peerId);
}

function offerRow(mediaId, { preview = null } = {}) {
  const s = sha(mediaId + (preview || ''));
  const now = Date.now();
  db.prepare(`INSERT INTO home_cache_blobs (sha256, size, kind, source, plugin_id, media_id, user_ids, priority, label, created_at, updated_at)
    VALUES (?, 100, 'vault', ?, ?, ?, NULL, 50, ?, ?, ?)`).run(s, preview ? 'preview' : 'plugin', P, mediaId, preview, now, now);
  return s;
}

function holds(peerId, s) {
  db.prepare('INSERT OR REPLACE INTO home_cache_have (peer_id, sha256, at) VALUES (?, ?, ?)').run(peerId, s, Date.now());
}

before(async () => {
  await setup();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  db = require('../src/db/connection').getDb();
  hc = require('../src/services/homeCache');
  gwNew = (await gateways.createGateway({ name: 'NAS neu' })).peer.id;
  gwOld = (await gateways.createGateway({ name: 'Pi alt' })).peer.id;
  gwOff = (await gateways.createGateway({ name: 'Pi aus' })).peer.id;
  health(gwNew, ['cache', 'cache-withdraw']);
  health(gwOld, ['cache']);
  health(gwOff, ['cache', 'cache-withdraw']);
  hc.set(gwNew, { enabled: true });
  hc.set(gwOld, { enabled: true });
  origMgmt = gateways.mgmtCall;
  gateways.mgmtCall = async (peerId, p, payload) => { calls.push([peerId, p, payload]); return answer(peerId); };
});

after(() => { gateways.mgmtCall = origMgmt; hc._resetForTest(); teardown(); });

beforeEach(() => {
  hc._resetForTest();
  calls.length = 0;
  answer = async () => ({ status: 202, body: { accepted: true } });
  db.prepare('DELETE FROM home_cache_blobs').run();
  db.prepare('DELETE FROM home_cache_have').run();
  hc._setNudgeTimingForTest({ delayMs: 60 * 60 * 1000 }); // the timer stays out of the way unless a test wants it
});

describe('home cache: sync after a withdrawal', () => {
  it('asks only the gateways that hold the blob and name cache-withdraw (cache on)', async () => {
    const a = offerRow('m-a');
    for (const id of [gwNew, gwOld, gwOff]) holds(id, a);
    assert.deepEqual(hc.withdraw(P, 'm-a'), { removed: true });
    assert.equal(calls.length, 0, 'nothing right away — gathered first');
    assert.deepEqual(await hc._flushNudges(), [gwNew]);
    assert.deepEqual(calls, [[gwNew, '/api/cache/sync', {}]]);
  });

  it('many withdrawals: one call per gateway, none for blobs nobody holds', async () => {
    const shas = [];
    for (let i = 0; i < 50; i++) shas.push(offerRow('m-' + i));
    for (const s of shas.slice(0, 10)) holds(gwNew, s);
    for (let i = 0; i < 50; i++) hc.withdraw(P, 'm-' + i);
    await hc._flushNudges();
    assert.deepEqual(calls.map((c) => c[0]), [gwNew]);

    calls.length = 0;
    offerRow('m-x');
    hc.withdraw(P, 'm-x');
    assert.deepEqual(await hc._flushNudges(), []);
    assert.equal(calls.length, 0);
  });

  it('a preview withdrawn and a withdrawal that removes nothing', async () => {
    const pv = offerRow('m-p', { preview: 'small' });
    holds(gwNew, pv);
    assert.deepEqual(hc.withdraw(P, 'm-p'), { removed: false }, 'the file itself was not offered');
    assert.deepEqual(await hc._flushNudges(), []);
    hc.withdraw(P, 'm-p', { preview: 'small' });
    assert.deepEqual(await hc._flushNudges(), [gwNew]);
  });

  it('at most once per gap: asked again within it, the gateway waits for its turn', async () => {
    hc._setNudgeTimingForTest({ delayMs: 60 * 60 * 1000, gapMs: 60 * 1000 });
    const a = offerRow('m-a'); const b = offerRow('m-b');
    holds(gwNew, a); holds(gwNew, b);
    const t0 = Date.now();
    hc.withdraw(P, 'm-a');
    assert.deepEqual(await hc._flushNudges(t0), [gwNew]);
    hc.withdraw(P, 'm-b');
    assert.deepEqual(await hc._flushNudges(t0 + 5000), [], 'within the gap');
    assert.deepEqual(await hc._flushNudges(t0 + 30 * 1000), [], 'still within the gap');
    assert.deepEqual(await hc._flushNudges(t0 + 61 * 1000), [gwNew], 'its turn after the gap (kept from before)');
    assert.equal(calls.length, 2);
    assert.deepEqual(await hc._flushNudges(t0 + 200 * 1000), [], 'nothing left to ask');
  });

  it('the timer: gathered for the delay, then one call', async () => {
    hc._setNudgeTimingForTest({ delayMs: 40, gapMs: 60 * 1000 });
    const a = offerRow('m-a'); const b = offerRow('m-b');
    holds(gwNew, a); holds(gwNew, b);
    hc.withdraw(P, 'm-a');
    hc.withdraw(P, 'm-b');
    for (let i = 0; i < 50 && !calls.length; i++) await sleep(20);
    await sleep(60);
    assert.deepEqual(calls.map((c) => c[0]), [gwNew]);
  });

  it('a failed call (unreachable, 404, throws) is only logged', async () => {
    const a = offerRow('m-a');
    holds(gwNew, a);
    for (const fail of [async () => null, async () => ({ status: 404, body: null }), async () => { throw new Error('boom'); }]) {
      hc._resetForTest();
      hc._setNudgeTimingForTest({ delayMs: 60 * 60 * 1000 });
      answer = fail;
      db.prepare('DELETE FROM home_cache_blobs').run();
      offerRow('m-a');
      hc.withdraw(P, 'm-a');
      assert.deepEqual(await hc._flushNudges(), [gwNew]);
    }
    assert.equal(calls.length, 3);
  });

  it('the hourly clean-up (media gone) asks the holders as well', async () => {
    const a = offerRow('m-gone');
    holds(gwNew, a);
    assert.equal(await hc.dropStaleOffers(), 1);
    assert.deepEqual(await hc._flushNudges(), [gwNew]);
  });
});
