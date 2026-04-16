'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../src/utils/fs');

describe('atomicWrite', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fs-test-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes content to the target path', () => {
    const target = path.join(dir, 'a.txt');
    atomicWrite(target, 'hello');
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  });

  it('accepts Buffer content', () => {
    const target = path.join(dir, 'b.bin');
    const buf = Buffer.from([0x00, 0xff, 0x42]);
    atomicWrite(target, buf);
    assert.deepEqual(fs.readFileSync(target), buf);
  });

  it('overwrites existing file atomically', () => {
    const target = path.join(dir, 'c.txt');
    atomicWrite(target, 'first');
    atomicWrite(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  });

  it('sets the requested file mode', () => {
    const target = path.join(dir, 'd.txt');
    atomicWrite(target, 'x', { mode: 0o600 });
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('leaves no tmp file behind after success', () => {
    const target = path.join(dir, 'e.txt');
    atomicWrite(target, 'x');
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.e.txt.') && f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0);
  });

  it('cleans up tmp file when rename fails', () => {
    // Target is a directory — rename of a file over an existing non-empty
    // directory fails with EISDIR/ENOTEMPTY. The tmp file must still be
    // unlinked afterwards.
    const target = path.join(dir, 'f-dir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'k');

    assert.throws(() => atomicWrite(target, 'x'));

    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.f-dir.') && f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, `tmp file leaked: ${leftovers.join(', ')}`);
  });

  it('last concurrent writer wins, no partial content visible', async () => {
    const target = path.join(dir, 'g.txt');
    const writes = Array.from({ length: 20 }, (_, i) => `payload-${i}-${'x'.repeat(1024)}`);

    await Promise.all(writes.map((content) => new Promise((resolve) => {
      setImmediate(() => {
        atomicWrite(target, content);
        resolve();
      });
    })));

    const final = fs.readFileSync(target, 'utf8');
    // Must be exactly one of the writes (no mix, no truncation)
    assert.ok(writes.includes(final), `final content is not one of the writes: ${final.slice(0, 40)}…`);
  });
});
