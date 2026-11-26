'use strict';

// "Unhandled error: SyntaxError … JSON at position 30" (log of 07.11. and
// 08.11.): which paths let invalid JSON run into the error handler.
//   * a request body of two JSON objects back to back (or a doubled body):
//     body-parser's rejection — 400 invalid_json (middleware/bodyErrors.js,
//     #451), also on the gateway and client APIs with their own parsers;
//   * an unreadable session row: discarded with a warning (no sid, no data),
//     the request goes on without a session — no 500 for every request with
//     that cookie;
//   * JSON.parse on the server's side that throws past its caller: still a
//     500, logged with method, path and position — never the message, which
//     quotes the text (utils/jsonSyntaxError.js).

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

const logger = require('../src/utils/logger');
const warnOnce = require('../src/utils/warnOnce');
const jsonErr = require('../src/utils/jsonSyntaxError');

// 30 characters of JSON, then a second object: "… after JSON at position 30"
const DOUBLED = '{"token":"s3cr3t-value-12345"}{"token":"s3cr3t-value-12345"}';
const SECRET = 's3cr3t-value';

let app;
let db;
before(async () => {
  ({ app } = await setup());
  db = require('../src/db/connection').getDb();
});
after(() => teardown());
afterEach(() => { mock.restoreAll(); warnOnce._resetForTest(); });

function logged(spy) {
  return JSON.stringify(spy.mock.calls.map((c) => c.arguments), (k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
}

describe('invalid JSON', () => {
  it('the logged shape: a 30-character object followed by another one', () => {
    assert.equal(DOUBLED.indexOf('}{') + 1, 30);
    let e;
    try { JSON.parse(DOUBLED); } catch (x) { e = x; }
    assert.ok(e instanceof SyntaxError);
    assert.match(e.message, /position 30/);
    assert.equal(jsonErr.isJsonSyntaxError(e), true);
    assert.deepEqual(jsonErr.describe(e), { name: 'SyntaxError', position: 30 });
    // body-parser's rejection carries a status: not a server-side JSON error
    assert.equal(jsonErr.isJsonSyntaxError(Object.assign(new SyntaxError('Unexpected token in JSON at position 3'), { status: 400 })), false);
    assert.equal(jsonErr.isJsonSyntaxError(new Error('JSON at position 3')), false);
  });

  it('a doubled body is a 400 invalid_json everywhere, nothing at level error, never the body in the log', async () => {
    const error = mock.method(logger, 'error', () => {});
    const warn = mock.method(logger, 'warn', () => {});
    for (const path of ['/api/v1/gateway/heartbeat', '/api/v1/client/peers', '/api/v1/peers', '/login', '/run']) {
      const r = await supertest(app).post(path).set('Content-Type', 'application/json').set('Accept', 'application/json').send(DOUBLED);
      assert.equal(r.status, 400, path);
      assert.equal(r.body.code, 'invalid_json', path);
    }
    assert.equal(error.mock.callCount(), 0);
    assert.ok(warn.mock.calls.some((c) => c.arguments[1] === 'malformed request body'));
    assert.ok(!logged(warn).includes(SECRET));
  });

  it('an unreadable session row is discarded with a warning, not a 500', async () => {
    const SQLiteStore = require('../src/middleware/sessionStore');
    const store = new SQLiteStore();
    try {
      db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('broken-sid', DOUBLED, Date.now() + 60000);
      const warn = mock.method(logger, 'warn', () => {});
      const result = await new Promise((resolve, reject) => store.get('broken-sid', (err, s) => (err ? reject(err) : resolve(s))));
      assert.equal(result, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('broken-sid').n, 0, 'the row is gone');
      const line = warn.mock.calls.find((c) => c.arguments[1] === 'session data unreadable, session discarded');
      assert.ok(line);
      assert.deepEqual(line.arguments[0].err, { name: 'SyntaxError', position: 30 });
      const text = logged(warn);
      assert.ok(!text.includes(SECRET), 'never the data');
      assert.ok(!text.includes('broken-sid'), 'never the sid');
      // a readable row still works
      db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)').run('good-sid', '{"cookie":{},"userId":1}', Date.now() + 60000);
      const ok = await new Promise((resolve, reject) => store.get('good-sid', (err, s) => (err ? reject(err) : resolve(s))));
      assert.equal(ok.userId, 1);
    } finally {
      store.close();
      db.prepare("DELETE FROM sessions WHERE sid IN ('broken-sid', 'good-sid')").run();
    }
  });

  it('JSON.parse past its caller: a 500 with method, path and position — not the text', () => {
    const error = mock.method(logger, 'error', () => {});
    const handler = app.router.stack.at(-1).handle;
    assert.equal(handler.length, 4, 'the error handler is the last layer');
    let err;
    try { JSON.parse(DOUBLED); } catch (e) { err = e; }
    let status = null;
    let body = null;
    const req = { path: '/api/v1/example', method: 'POST', headers: {}, ip: '127.0.0.1' };
    const res = { headersSent: false, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    handler(err, req, res, () => {});
    assert.equal(status, 500);
    assert.deepEqual(body, { error: 'Internal server error' });
    const line = error.mock.calls.find((c) => c.arguments[1] === 'Unhandled error: invalid JSON on the server side');
    assert.ok(line, 'logged at error');
    assert.equal(line.arguments[0].path, '/api/v1/example');
    assert.equal(line.arguments[0].method, 'POST');
    assert.deepEqual(line.arguments[0].err, { name: 'SyntaxError', position: 30 });
    assert.match(String(line.arguments[0].at), /json_parse_errors\.test\.js/, 'where it was parsed');
    assert.ok(!logged(error).includes(SECRET), 'never the text');
  });
});
