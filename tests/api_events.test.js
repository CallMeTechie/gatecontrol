'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('SSE /api/v1/events', () => {
  let server, baseUrl;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sse-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  it('returns 401 without a session', async () => {
    const status = await new Promise((resolve) => {
      const req = http.get(`${baseUrl}/api/v1/events`, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', () => resolve(0));
    });
    assert.equal(status, 401);
  });

  it('streams a published event to a subscribed handler and unsubscribes on close', () => {
    delete require.cache[require.resolve('../src/services/eventBus')];
    const bus = require('../src/services/eventBus');
    delete require.cache[require.resolve('../src/routes/api/events')];
    const sseHandler = require('../src/routes/api/events');

    const writes = [];
    const handlers = {};
    const res = {
      writeHead() {}, flushHeaders() {},
      write(chunk) { writes.push(chunk); return true; },
      end() { this.ended = true; },
      once() {},
    };
    const req = { on(ev, fn) { handlers[ev] = fn; } };

    assert.equal(bus.subscriberCount(), 0);
    sseHandler(req, res);
    assert.equal(bus.subscriberCount(), 1);

    bus.publish('gateway', { peerId: 7, alive: false });
    const framed = writes.join('');
    assert.match(framed, /event: gateway/);
    assert.match(framed, /data: \{"peerId":7,"alive":false\}/);

    handlers.close();
    assert.equal(bus.subscriberCount(), 0);
  });

  it('pauses writing under backpressure (write returns false)', () => {
    delete require.cache[require.resolve('../src/services/eventBus')];
    const bus = require('../src/services/eventBus');
    delete require.cache[require.resolve('../src/routes/api/events')];
    const sseHandler = require('../src/routes/api/events');

    let writeCount = 0;
    const res = {
      writeHead() {}, flushHeaders() {}, end() {},
      write() { writeCount++; return false; },
      once() {},
    };
    const req = { on() {} };
    sseHandler(req, res);
    bus.publish('peer', { peerId: 1 });
    bus.publish('peer', { peerId: 2 });
    assert.equal(writeCount, 1);
  });
});
