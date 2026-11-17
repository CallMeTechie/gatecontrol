'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../scripts/release-state');

// Regression für Lauf 44103244201: Bump-Commit und Tag v1.297.0 waren gepusht,
// dann scheiterte der Image-Build. Der Neustart übersprang alles, weil er den
// Bump-Commit sah — Tag ohne Image und ohne GitHub-Release.

const set = (...items) => (x) => items.includes(x);

test('normal run: no bump after the commit, tag free -> release', () => {
  const r = decide({
    subjectsAfter: [], computedTag: 'v1.297.1', headVersion: '1.297.0',
    tagExists: set(), releaseExists: set(),
  });
  assert.equal(r.mode, 'release');
  assert.equal(r.tag, 'v1.297.1');
  assert.equal(r.version, '1.297.1');
  assert.equal(r.latest, true);
});

test('re-run after failure behind the tag push -> resume the existing tag', () => {
  // HEAD is the bump commit; package.json there already says 1.297.0, so the
  // freshly computed tag would be v1.298.0 — must not be used.
  const r = decide({
    subjectsAfter: ['chore: bump version to 1.297.0'], computedTag: 'v1.298.0', headVersion: '1.297.0',
    tagExists: set('v1.297.0'), releaseExists: set(),
  });
  assert.equal(r.mode, 'resume');
  assert.equal(r.tag, 'v1.297.0');
  assert.equal(r.version, '1.297.0');
  assert.equal(r.latest, true);
});

test('re-run after a complete release -> skip', () => {
  const r = decide({
    subjectsAfter: ['chore: bump version to 1.297.0'], computedTag: 'v1.298.0', headVersion: '1.297.0',
    tagExists: set('v1.297.0'), releaseExists: set('v1.297.0'),
  });
  assert.equal(r.mode, 'skip');
});

test('resume of an older tag while a newer version exists keeps :latest', () => {
  const r = decide({
    subjectsAfter: ['chore: bump version to 1.297.0', 'fix: x (#1)', 'chore: bump version to 1.297.1'],
    computedTag: 'v1.297.2', headVersion: '1.297.1',
    tagExists: set('v1.297.0', 'v1.297.1'), releaseExists: set('v1.297.1'),
  });
  assert.equal(r.mode, 'resume');
  assert.equal(r.tag, 'v1.297.0');
  assert.equal(r.latest, false);
});

test('released together with a later merge -> skip', () => {
  const r = decide({
    subjectsAfter: ['feat: y (#2)', 'chore: bump version to 1.298.0'], computedTag: 'v1.299.0', headVersion: '1.298.0',
    tagExists: set('v1.298.0'), releaseExists: set('v1.298.0'),
  });
  assert.equal(r.mode, 'skip');
  assert.equal(r.tag, 'v1.298.0');
});

test('bump pushed but tag missing -> skip (nothing safe to resume)', () => {
  const r = decide({
    subjectsAfter: ['chore: bump version to 1.297.0'], computedTag: 'v1.298.0', headVersion: '1.297.0',
    tagExists: set(), releaseExists: set(),
  });
  assert.equal(r.mode, 'skip');
});

test('computed tag already exists without a bump after the commit -> skip', () => {
  const r = decide({
    subjectsAfter: [], computedTag: 'v1.297.0', headVersion: '1.296.0',
    tagExists: set('v1.297.0'), releaseExists: set(),
  });
  assert.equal(r.mode, 'skip');
});
