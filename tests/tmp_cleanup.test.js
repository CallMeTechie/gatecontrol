'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Importing the harness triggers its module-load side effects (creates this
// process's temp dir + registers the exit-cleanup handler). It also exports the
// stale-dir sweeper we exercise here against a throwaway root, so we never touch
// real /tmp/gc-test-* dirs belonging to concurrently-running test processes.
const { cleanupStaleTestDirs } = require('./helpers/setup');

test('cleanupStaleTestDirs removes stale dirs, keeps fresh / unrelated / excluded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cleanup-root-'));
  try {
    const stale = path.join(root, 'gc-test-STALE');
    const fresh = path.join(root, 'gc-test-FRESH');
    const other = path.join(root, 'unrelated-DIR');
    const self = path.join(root, 'gc-test-SELF');
    for (const d of [stale, fresh, other, self]) fs.mkdirSync(d);

    // Backdate two dirs to 3h ago. The excluded one is stale too, to prove the
    // exclude guard wins over staleness (a process never deletes its own dir).
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(self, old, old);

    cleanupStaleTestDirs(root, 'gc-test-', 2 * 60 * 60 * 1000, self);

    assert.equal(fs.existsSync(stale), false, 'stale gc-test dir should be removed');
    assert.equal(fs.existsSync(fresh), true, 'fresh gc-test dir should be kept');
    assert.equal(fs.existsSync(other), true, 'non-matching dir should be untouched');
    assert.equal(fs.existsSync(self), true, 'excluded (own) dir kept even if stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupStaleTestDirs never throws on a missing root', () => {
  assert.doesNotThrow(() => cleanupStaleTestDirs(path.join(os.tmpdir(), 'gc-does-not-exist-xyz'), 'gc-test-', 1000, null));
});
