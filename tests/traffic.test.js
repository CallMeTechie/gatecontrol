'use strict';

/**
 * Coverage for src/services/traffic.js — snapshot deltas (aggregate +
 * per-peer), chart aggregation periods, today totals, cleanup horizon,
 * and collector lifecycle. wireguard.getStatus / getTransferTotals are
 * stubbed so the test never shells out to `wg`.
 */

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-traffic-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let getDb;
let wireguard;

function loadFreshTraffic() {
  // Reload traffic.js so its module-level previousTotals / previousPeerTransfers
  // start clean — the deltas-from-prev tests need a known starting state.
  delete require.cache[require.resolve('../src/services/traffic')];
  return require('../src/services/traffic');
}

function insertPeer({ id, name, publicKey, allowedIps = '10.8.0.10/32' }) {
  getDb().prepare(`
    INSERT INTO peers (id, name, public_key, allowed_ips, enabled)
    VALUES (?, ?, ?, ?, 1)
  `).run(id, name, publicKey, allowedIps);
}

before(() => {
  require('../src/db/migrations').runMigrations();
  getDb = require('../src/db/connection').getDb;
  wireguard = require('../src/services/wireguard');
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM peer_traffic_snapshots').run();
  db.prepare('DELETE FROM traffic_snapshots').run();
  db.prepare('DELETE FROM peers').run();
});

// ───────────────────────────────────────────────────────────────────────
// takeSnapshot — aggregate deltas
// ───────────────────────────────────────────────────────────────────────
describe('traffic: takeSnapshot aggregate deltas', () => {
  it('first snapshot writes a zero-delta row (no previous state)', async () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const traffic = loadFreshTraffic();

    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'pkA', transferTx: 1000, transferRx: 2000 }],
    }));

    try {
      await traffic.takeSnapshot();
      const row = getDb().prepare('SELECT upload_bytes, download_bytes, peer_count FROM traffic_snapshots').get();
      assert.equal(row.upload_bytes, 0, 'first snapshot has no previous → zero delta');
      assert.equal(row.download_bytes, 0);
      assert.equal(row.peer_count, 1);
    } finally {
      stub.mock.restore();
    }
  });

  it('second snapshot stores positive delta against the first', async () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const traffic = loadFreshTraffic();

    let totals = { tx: 1000, rx: 2000 };
    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'pkA', transferTx: totals.tx, transferRx: totals.rx }],
    }));

    try {
      await traffic.takeSnapshot();
      totals = { tx: 1500, rx: 2750 };
      await traffic.takeSnapshot();

      const rows = getDb().prepare('SELECT upload_bytes, download_bytes FROM traffic_snapshots ORDER BY id').all();
      assert.equal(rows.length, 2);
      assert.equal(rows[1].upload_bytes, 500, 'second-snapshot upload delta = 1500 − 1000');
      assert.equal(rows[1].download_bytes, 750, 'second-snapshot download delta = 2750 − 2000');
    } finally {
      stub.mock.restore();
    }
  });

  it('counter reset (current < previous) coerces deltas to 0 instead of negatives', async () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const traffic = loadFreshTraffic();

    let totals = { tx: 5000, rx: 8000 };
    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'pkA', transferTx: totals.tx, transferRx: totals.rx }],
    }));

    try {
      await traffic.takeSnapshot();
      // Simulate WireGuard interface restart — counters reset to 0.
      totals = { tx: 200, rx: 100 };
      await traffic.takeSnapshot();

      const second = getDb().prepare('SELECT upload_bytes, download_bytes FROM traffic_snapshots ORDER BY id LIMIT 1 OFFSET 1').get();
      assert.equal(second.upload_bytes, 0, 'negative delta after reset must be coerced to 0');
      assert.equal(second.download_bytes, 0);
    } finally {
      stub.mock.restore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// takeSnapshot — per-peer deltas
// ───────────────────────────────────────────────────────────────────────
describe('traffic: takeSnapshot per-peer deltas', () => {
  it('per-peer deltas accumulate into peers.total_tx / total_rx', async () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const traffic = loadFreshTraffic();

    let totals = { tx: 1000, rx: 2000 };
    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'pkA', transferTx: totals.tx, transferRx: totals.rx }],
    }));

    try {
      await traffic.takeSnapshot();        // baseline
      totals = { tx: 1300, rx: 2500 };
      await traffic.takeSnapshot();         // delta 300/500

      const peer = getDb().prepare('SELECT total_tx, total_rx FROM peers WHERE id=1').get();
      assert.equal(peer.total_tx, 300);
      assert.equal(peer.total_rx, 500);

      const peerRow = getDb().prepare('SELECT upload_bytes, download_bytes FROM peer_traffic_snapshots').get();
      assert.equal(peerRow.upload_bytes, 300);
      assert.equal(peerRow.download_bytes, 500);
    } finally {
      stub.mock.restore();
    }
  });

  it('zero-delta peers do NOT produce a peer_traffic_snapshot row', async () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const traffic = loadFreshTraffic();

    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'pkA', transferTx: 1000, transferRx: 2000 }],
    }));

    try {
      await traffic.takeSnapshot();        // baseline
      await traffic.takeSnapshot();         // identical totals → 0 delta

      const count = getDb().prepare('SELECT COUNT(*) AS n FROM peer_traffic_snapshots').get().n;
      assert.equal(count, 0, 'no per-peer row for zero delta — keeps the table sparse');
    } finally {
      stub.mock.restore();
    }
  });

  it('peers absent from the DB are silently skipped', async () => {
    // No peer inserted, but wireguard reports one. takeSnapshot must
    // not throw and must not insert into peer_traffic_snapshots.
    const traffic = loadFreshTraffic();

    const stub = mock.method(wireguard, 'getStatus', async () => ({
      peers: [{ publicKey: 'unknown-pk', transferTx: 100, transferRx: 200 }],
    }));

    try {
      await traffic.takeSnapshot();
      await traffic.takeSnapshot();
      const count = getDb().prepare('SELECT COUNT(*) AS n FROM peer_traffic_snapshots').get().n;
      assert.equal(count, 0);
    } finally {
      stub.mock.restore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// getCurrentRates
// ───────────────────────────────────────────────────────────────────────
describe('traffic: getCurrentRates', () => {
  it('returns 0/0 on first call (no previous state)', async () => {
    const traffic = loadFreshTraffic();
    const stub = mock.method(wireguard, 'getTransferTotals', async () => ({ totalTx: 0, totalRx: 0 }));
    try {
      const rates = await traffic.getCurrentRates();
      assert.equal(rates.uploadRate, 0);
      assert.equal(rates.downloadRate, 0);
    } finally {
      stub.mock.restore();
    }
  });

  it('returns non-negative integer rates after a baseline call', async () => {
    const traffic = loadFreshTraffic();
    let totals = { totalTx: 0, totalRx: 0 };
    const stub = mock.method(wireguard, 'getTransferTotals', async () => totals);
    try {
      await traffic.getCurrentRates();        // sets baseline
      totals = { totalTx: 10000, totalRx: 20000 };
      const rates = await traffic.getCurrentRates();
      assert.ok(Number.isInteger(rates.uploadRate));
      assert.ok(Number.isInteger(rates.downloadRate));
      assert.ok(rates.uploadRate >= 0);
      assert.ok(rates.downloadRate >= 0);
    } finally {
      stub.mock.restore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// getChartData / getTodayTotals — pure DB readers
// ───────────────────────────────────────────────────────────────────────
describe('traffic: getChartData', () => {
  const traffic = require('../src/services/traffic');

  it('returns an empty array when no snapshots exist', () => {
    assert.deepEqual(traffic.getChartData('1h'), []);
  });

  it('aggregates snapshot rows into time buckets — 1h period', () => {
    const db = getDb();
    db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count) VALUES (10, 20, 1)').run();
    db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count) VALUES (30, 40, 2)').run();

    const data = traffic.getChartData('1h');
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 1, 'recent rows must show up in the 1h chart');
    const total = data.reduce((acc, p) => ({ upload: acc.upload + p.upload, download: acc.download + p.download }), { upload: 0, download: 0 });
    assert.equal(total.upload, 40);
    assert.equal(total.download, 60);
  });

  it('default period is 1h', () => {
    const db = getDb();
    db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count) VALUES (5, 5, 1)').run();
    const a = traffic.getChartData();
    const b = traffic.getChartData('1h');
    assert.deepEqual(a, b);
  });
});

describe('traffic: getTodayTotals', () => {
  const traffic = require('../src/services/traffic');

  it('returns zeros when no snapshots exist', () => {
    const t = traffic.getTodayTotals();
    assert.equal(t.upload, 0);
    assert.equal(t.download, 0);
    assert.equal(t.total, 0);
  });

  it('sums today rows; total = upload + download', () => {
    const db = getDb();
    db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count) VALUES (100, 200, 1)').run();
    db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count) VALUES (50, 25, 1)').run();
    const t = traffic.getTodayTotals();
    assert.equal(t.upload, 150);
    assert.equal(t.download, 225);
    assert.equal(t.total, 375);
  });

  it('rows older than start of day are excluded', () => {
    const db = getDb();
    db.prepare(`INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count, recorded_at)
                VALUES (999, 999, 1, datetime('now', '-2 days'))`).run();
    db.prepare(`INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count)
                VALUES (10, 20, 1)`).run();
    const t = traffic.getTodayTotals();
    assert.equal(t.upload, 10);
    assert.equal(t.download, 20);
  });
});

// ───────────────────────────────────────────────────────────────────────
// getPeerChartData
// ───────────────────────────────────────────────────────────────────────
describe('traffic: getPeerChartData', () => {
  const traffic = require('../src/services/traffic');

  it('filters by peer_id and returns the configured periods', () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    insertPeer({ id: 2, name: 'p2', publicKey: 'pkB' });
    const db = getDb();
    db.prepare('INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes) VALUES (1, 100, 200)').run();
    db.prepare('INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes) VALUES (2, 999, 999)').run();

    const peer1 = traffic.getPeerChartData(1, '24h');
    const sum1 = peer1.reduce((acc, p) => ({ u: acc.u + p.upload, d: acc.d + p.download }), { u: 0, d: 0 });
    assert.equal(sum1.u, 100);
    assert.equal(sum1.d, 200);
  });

  it('defaults to 24h when no period is given', () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    getDb().prepare('INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes) VALUES (1, 50, 60)').run();
    const a = traffic.getPeerChartData(1);
    const b = traffic.getPeerChartData(1, '24h');
    assert.deepEqual(a, b);
  });
});

// ───────────────────────────────────────────────────────────────────────
// cleanup
// ───────────────────────────────────────────────────────────────────────
describe('traffic: cleanup', () => {
  const traffic = require('../src/services/traffic');

  it('deletes snapshots older than N days, leaves recent rows alone, returns total changes', () => {
    insertPeer({ id: 1, name: 'p1', publicKey: 'pkA' });
    const db = getDb();
    db.prepare(`INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count, recorded_at)
                VALUES (1, 2, 1, datetime('now', '-40 days'))`).run();
    db.prepare(`INSERT INTO traffic_snapshots (upload_bytes, download_bytes, peer_count, recorded_at)
                VALUES (3, 4, 1, datetime('now', '-2 days'))`).run();
    db.prepare(`INSERT INTO peer_traffic_snapshots (peer_id, upload_bytes, download_bytes, recorded_at)
                VALUES (1, 5, 6, datetime('now', '-40 days'))`).run();

    const removed = traffic.cleanup(30);
    assert.equal(removed, 2, 'one aggregate + one per-peer row removed = 2');

    const aggKept = db.prepare('SELECT COUNT(*) AS n FROM traffic_snapshots').get().n;
    const peerKept = db.prepare('SELECT COUNT(*) AS n FROM peer_traffic_snapshots').get().n;
    assert.equal(aggKept, 1, 'recent aggregate row must still be there');
    assert.equal(peerKept, 0, 'old per-peer row must be gone');
  });

  it('cleanup is idempotent on an empty table', () => {
    assert.equal(traffic.cleanup(30), 0);
    assert.equal(traffic.cleanup(30), 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// startCollector / stopCollector
// ───────────────────────────────────────────────────────────────────────
describe('traffic: collector lifecycle', () => {
  it('startCollector is idempotent — second call is a no-op', () => {
    const traffic = loadFreshTraffic();
    const stub = mock.method(wireguard, 'getStatus', async () => ({ peers: [] }));
    try {
      traffic.startCollector(60_000);
      traffic.startCollector(60_000); // should be ignored
      // We can't directly observe the interval, but stopCollector must
      // succeed in clearing exactly one pending interval.
      traffic.stopCollector();
      // Calling stop again must not throw.
      traffic.stopCollector();
    } finally {
      stub.mock.restore();
    }
  });
});

after(() => {
  // Make sure no interval keeps the test process alive.
  try {
    require('../src/services/traffic').stopCollector();
  } catch {}
});
