'use strict';
// access.log wird inkrementell und asynchron gelesen (utils/logTail) —
// der Bot-Blocker-Zähler zählt dabei dasselbe wie das frühere Voll-Lesen.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogTail } = require('../src/utils/logTail');
const { createCounter, countBlocked } = require('../src/services/botBlockerCounter');

let dir, file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-logtail-')); file = path.join(dir, 'access.log'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('missing file yields no lines', async () => {
  const t = createLogTail(file);
  assert.deepEqual(await t.readNewLines(), []);
});

test('reads only appended bytes on each call', async () => {
  fs.writeFileSync(file, 'a\nb\n');
  const t = createLogTail(file);
  assert.deepEqual(await t.readNewLines(), ['a', 'b']);
  assert.equal(t.state.offset, 4);
  assert.deepEqual(await t.readNewLines(), []);
  fs.appendFileSync(file, 'c\n\nd\n');
  assert.deepEqual(await t.readNewLines(), ['c', 'd']);
});

test('partial last line is carried over until completed', async () => {
  fs.writeFileSync(file, 'one\ntw');
  const t = createLogTail(file);
  assert.deepEqual(await t.readNewLines(), ['one']);
  fs.appendFileSync(file, 'o');
  assert.deepEqual(await t.readNewLines(), []);
  fs.appendFileSync(file, '\nthree\n');
  assert.deepEqual(await t.readNewLines(), ['two', 'three']);
});

test('multi-byte UTF-8 split across reads and chunks stays intact', async () => {
  const line = 'häßlich-€-𝄞';
  const bytes = Buffer.from(line + '\n');
  fs.writeFileSync(file, bytes.subarray(0, 3)); // mitten im "ä"
  const t = createLogTail(file, { chunkBytes: 2 });
  assert.deepEqual(await t.readNewLines(), []);
  fs.appendFileSync(file, bytes.subarray(3));
  assert.deepEqual(await t.readNewLines(), [line]);
});

test('truncation resets the offset', async () => {
  fs.writeFileSync(file, 'old-1\nold-2\nold-3\n');
  const t = createLogTail(file);
  await t.readNewLines();
  fs.writeFileSync(file, 'new\n'); // gleiche Inode, kleiner als Offset
  assert.deepEqual(await t.readNewLines(), ['new']);
});

test('rotation (new inode) resets the offset', async () => {
  fs.writeFileSync(file, 'x'.repeat(10) + '\n');
  const t = createLogTail(file);
  await t.readNewLines();
  fs.renameSync(file, path.join(dir, 'access-1.log'));
  // neue Datei, größer als der alte Offset — nur die Inode verrät die Rotation
  fs.writeFileSync(file, 'rotated-line-1\nrotated-line-2\n');
  assert.deepEqual(await t.readNewLines(), ['rotated-line-1', 'rotated-line-2']);
});

test('file disappearing resets state', async () => {
  fs.writeFileSync(file, 'a\n');
  const t = createLogTail(file);
  await t.readNewLines();
  fs.unlinkSync(file);
  assert.deepEqual(await t.readNewLines(), []);
  assert.equal(t.state.offset, 0);
  fs.writeFileSync(file, 'b\n');
  assert.deepEqual(await t.readNewLines(), ['b']);
});

// ─── Bot-Blocker-Zähler ────────────────────────────────

function entry(ts, host, status = 403) { return JSON.stringify({ ts, status, request: { host } }) + '\n'; }

function fakeDb(routes) {
  const counts = new Map();
  return {
    counts,
    prepare(sql) {
      if (/^SELECT/.test(sql)) return { all: () => routes };
      return { run: (n, id) => counts.set(id, (counts.get(id) || 0) + n) };
    },
  };
}

test('countBlocked keeps the old semantics (403 only, ts monotonic, host without port)', () => {
  const state = { lastTs: 0 };
  const map = new Map([['a.example', 1], ['b.example', 2]]);
  const lines = [
    entry(1, 'a.example'), entry(2, 'A.example:443'), entry(3, 'a.example', 200),
    entry(4, 'unknown.example'), entry(2.5, 'b.example'), 'not json', entry(5, 'b.example'),
  ].map((l) => l.trim());
  const counts = countBlocked(lines, map, state);
  assert.deepEqual([...counts], [[1, 2], [2, 1]]);
  assert.equal(state.lastTs, 5);
});

test('counter counts incrementally without double counting', async () => {
  const db = fakeDb([{ id: 7, domain: 'Bot.Example' }]);
  const c = createCounter({ file, getDb: () => db });
  await c.tick(); // noch keine Datei
  fs.writeFileSync(file, entry(1, 'bot.example') + entry(2, 'bot.example') + entry(3, 'other'));
  await c.tick();
  assert.equal(db.counts.get(7), 2);
  await c.tick();
  assert.equal(db.counts.get(7), 2, 'no re-count of already read lines');
  fs.appendFileSync(file, entry(4, 'bot.example') + entry(5, 'bot.example').slice(0, 10));
  await c.tick();
  assert.equal(db.counts.get(7), 3, 'partial line not counted yet');
  fs.appendFileSync(file, entry(5, 'bot.example').slice(10));
  await c.tick();
  assert.equal(db.counts.get(7), 4);
  // Rotation: neue Datei mit neueren Einträgen
  fs.renameSync(file, path.join(dir, 'access-old.log'));
  fs.writeFileSync(file, entry(6, 'bot.example'));
  await c.tick();
  assert.equal(db.counts.get(7), 5);
});

test('counter does not read while no route has the bot blocker enabled', async () => {
  const routes = [];
  const db = fakeDb(routes);
  const c = createCounter({ file, getDb: () => db });
  fs.writeFileSync(file, entry(1, 'bot.example'));
  await c.tick();
  assert.equal(c.tail.state.offset, 0);
  routes.push({ id: 1, domain: 'bot.example' });
  await c.tick();
  assert.equal(db.counts.get(1), 1, 'backlog counted after enabling, as before');
});
