'use strict';
// config/default generates a session secret only in test mode; set it before
// any require so transitively-loaded config (via the logger) doesn't throw.
process.env.NODE_ENV = 'test';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshBus() {
  delete require.cache[require.resolve('../src/services/eventBus')];
  return require('../src/services/eventBus');
}

describe('eventBus', () => {
  let bus;
  beforeEach(() => { bus = freshBus(); });

  it('delivers published events to subscribers', () => {
    const got = [];
    bus.subscribe((evt) => got.push(evt));
    bus.publish('peer', { peerId: 1 });
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'peer');
    assert.deepEqual(got[0].payload, { peerId: 1 });
    assert.equal(typeof got[0].ts, 'number');
  });

  it('applies a per-subscriber filter predicate', () => {
    const got = [];
    bus.subscribe((evt) => got.push(evt.type), (type) => type === 'gateway');
    bus.publish('peer', {});
    bus.publish('gateway', {});
    assert.deepEqual(got, ['gateway']);
  });

  it('isolates a throwing subscriber from the others', () => {
    const got = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((evt) => got.push(evt.type));
    bus.publish('activity', {});
    assert.deepEqual(got, ['activity']);
  });

  it('is a no-op with zero subscribers and supports unsubscribe', () => {
    assert.equal(bus.subscriberCount(), 0);
    const fn = () => {};
    bus.subscribe(fn);
    assert.equal(bus.subscriberCount(), 1);
    bus.unsubscribe(fn);
    assert.equal(bus.subscriberCount(), 0);
    assert.doesNotThrow(() => bus.publish('peer', {}));
  });

  it('ignores a duplicate subscribe of the same listener (no wrapper leak)', () => {
    let count = 0;
    const fn = () => { count++; };
    bus.subscribe(fn);
    bus.subscribe(fn); // duplicate — must be ignored
    assert.equal(bus.subscriberCount(), 1);
    bus.publish('peer', {});
    assert.equal(count, 1);
    bus.unsubscribe(fn);
    assert.equal(bus.subscriberCount(), 0); // fully removed, no orphan
  });
});

describe('activity.log → eventBus', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');

  it('publishes an activity event when a log row is written', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-act-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/eventBus', '../src/services/activity']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const bus = require('../src/services/eventBus');
    const activity = require('../src/services/activity');

    const got = [];
    bus.subscribe((evt) => { if (evt.type === 'activity') got.push(evt); });
    activity.log('test_event', 'hello', { severity: 'info' });

    assert.equal(got.length, 1);
    assert.equal(got[0].payload.eventType, 'test_event');
    assert.equal(typeof got[0].payload.id, 'number');
  });
});
