'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { withCaddySync } = require('../src/services/routesSync');

describe('routesSync: withCaddySync', () => {
  it('runs the sync once and never calls rollback on success', async () => {
    let syncCalls = 0;
    let rollbackCalls = 0;
    await withCaddySync(
      async () => { syncCalls++; },
      () => { rollbackCalls++; },
    );
    assert.equal(syncCalls, 1);
    assert.equal(rollbackCalls, 0);
  });

  it('returns undefined on success (callers shouldn\'t depend on a value)', async () => {
    const result = await withCaddySync(async () => 'ignored', () => {});
    assert.equal(result, undefined);
  });

  it('runs rollback exactly once when sync throws, then rethrows the SAME error', async () => {
    let rollbackCalls = 0;
    const syncErr = new Error('sync boom');
    await assert.rejects(
      () => withCaddySync(
        async () => { throw syncErr; },
        () => { rollbackCalls++; },
      ),
      (err) => err === syncErr,
    );
    assert.equal(rollbackCalls, 1);
  });

  it('passes the sync error to the rollback callback so it can branch on it', async () => {
    const syncErr = new Error('sync boom');
    let received;
    await assert.rejects(() => withCaddySync(
      async () => { throw syncErr; },
      (err) => { received = err; },
    ));
    assert.equal(received, syncErr);
  });

  it('a throwing rollback does NOT replace the original sync error in the rejection', async () => {
    const syncErr = new Error('sync boom');
    const rbErr = new Error('rollback also boom');
    await assert.rejects(
      () => withCaddySync(
        async () => { throw syncErr; },
        () => { throw rbErr; },
      ),
      (err) => err === syncErr, // syncErr propagates, NOT rbErr
    );
  });

  it('awaits an async rollback before propagating the sync error', async () => {
    const syncErr = new Error('sync boom');
    const events = [];
    await assert.rejects(() => withCaddySync(
      async () => { throw syncErr; },
      async () => {
        await new Promise(r => setImmediate(r));
        events.push('rollback-done');
      },
    ));
    events.push('caught');
    assert.deepEqual(events, ['rollback-done', 'caught']);
  });

  it('label is optional — defaults to "route mutation"', async () => {
    // Smoke: helper does not crash without an explicit label.
    await withCaddySync(async () => {}, () => {});
    await assert.rejects(() => withCaddySync(
      async () => { throw new Error('x'); },
      () => {},
    ));
  });
});
