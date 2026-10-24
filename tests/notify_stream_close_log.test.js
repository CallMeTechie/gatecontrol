'use strict';

// Push streams (services/notify/stream.js): why a stream ended is logged at
// info when the server ends it or the client drops it within 30 s — a
// flapping stream shows its cause without debug logging.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/utils/logger');
const stream = require('../src/services/notify/stream');

function fakeRes() {
  return { ended: false, end() { this.ended = true; }, write() { return true; }, once() {} };
}

describe('push stream close log', () => {
  let lines;
  let orig;
  beforeEach(() => {
    stream._resetForTest();
    lines = [];
    orig = { info: logger.info, debug: logger.debug };
    logger.info = (fields, msg) => { if (msg === 'push stream closed') lines.push({ level: 'info', ...fields }); };
    logger.debug = (fields, msg) => { if (msg === 'push stream closed') lines.push({ level: 'debug', ...fields }); };
  });
  afterEach(() => {
    logger.info = orig.info;
    logger.debug = orig.debug;
    stream._resetForTest();
  });

  it('a stream replaced by a new one of the same token: info, with both paths', () => {
    const a = stream.add({ tokenId: 7, via: 'direct', res: fakeRes() });
    const b = stream.add({ tokenId: 7, via: 'tunnel', res: fakeRes() });
    assert.equal(stream.get(7), b);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].reason, 'replaced');
    assert.equal(lines[0].via, 'direct');
    assert.equal(lines[0].replaced_by_via, 'tunnel');
    assert.equal(typeof lines[0].lived_s, 'number');
    assert.ok(a.closed);
  });

  it('the client closing a short-lived stream: info; a long-lived one: debug', () => {
    const c = stream.add({ tokenId: 8, via: 'tunnel', res: fakeRes() });
    stream.close(c, 'client_closed');
    const d = stream.add({ tokenId: 9, via: 'tunnel', res: fakeRes() });
    d.openedMs = Date.now() - 120000;
    stream.close(d, 'client_closed');
    assert.deepEqual(lines.map((l) => [l.tokenId, l.level]), [[8, 'info'], [9, 'debug']]);
    assert.ok(lines[1].lived_s >= 119);
  });

  it('server-side reasons are always info', () => {
    const e = stream.add({ tokenId: 10, via: 'tunnel', res: fakeRes() });
    e.openedMs = Date.now() - 600000;
    stream.close(e, 'revoked');
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].reason, 'revoked');
  });
});
