'use strict';

// "What's new" (docs/feature-release-b.md §6): structured CHANGELOG parser
// (tokens, never HTML), sections newer than users.last_seen_version (≤ 5),
// POST …/seen, and the CHANGELOG shipped in the image (.dockerignore).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const changelog = require('../src/services/changelog');

const SAMPLE = `# Changelog

## [Unreleased]

- not released yet

## [1.3.0] — 2026-09-15

### Features
- Neues **Wartungsfenster** für \`update.sh\`: Updates nur zwischen 03:00 und 05:00.
  Fortsetzung der Zeile mit [Link](https://example.com).
- Zweiter Punkt mit \`a\` und \`b\`.

  **Hinweis:** eingerückter Absatz gehört zum Punkt.

### Fixes
- <script>alert(1)</script> bleibt Text

---

## [1.2.0] — 2026-09-10

### Fixes
- Fix A

---

## [1.1.0] — 2026-09-01

### Features
- Feature B

## [Unreleased]

- orphaned block

## [1.0.0] — 2026-08-01

Initial text without a group.
`;

describe('parser', () => {
  const sections = changelog.parseChangelog(SAMPLE);

  test('version sections only (Unreleased blocks skipped), dates parsed', () => {
    assert.deepEqual(sections.map((s) => [s.version, s.date]), [
      ['1.3.0', '2026-09-15'], ['1.2.0', '2026-09-10'], ['1.1.0', '2026-09-01'], ['1.0.0', '2026-08-01'],
    ]);
    assert.ok(!JSON.stringify(sections).includes('orphaned'));
    assert.ok(!JSON.stringify(sections).includes('not released'));
  });

  test('groups and inline tokens (text/code/strong), continuation lines joined', () => {
    const s = sections[0];
    assert.deepEqual(s.groups.map((g) => g.title), ['Features', 'Fixes']);
    assert.deepEqual(s.groups[0].items[0], [
      { t: 'text', v: 'Neues ' },
      { t: 'strong', v: 'Wartungsfenster' },
      { t: 'text', v: ' für ' },
      { t: 'code', v: 'update.sh' },
      { t: 'text', v: ': Updates nur zwischen 03:00 und 05:00. Fortsetzung der Zeile mit Link.' },
    ]);
    const second = s.groups[0].items[1];
    assert.deepEqual(second.filter((x) => x.t === 'code').map((x) => x.v), ['a', 'b']);
    assert.ok(second.some((x) => x.t === 'strong' && x.v === 'Hinweis:'), 'indented paragraph belongs to the item');
  });

  test('no HTML: markup stays literal text', () => {
    const item = sections[0].groups[1].items[0];
    assert.deepEqual(item, [{ t: 'text', v: '<script>alert(1)</script> bleibt Text' }]);
  });

  test('loose paragraph → own item in an untitled group', () => {
    assert.deepEqual(sections[3].groups, [{ title: '', items: [[{ t: 'text', v: 'Initial text without a group.' }]] }]);
  });

  test('the real CHANGELOG.md parses and has no markup left in text tokens', () => {
    const real = changelog.getSections(path.join(__dirname, '..', 'CHANGELOG.md'));
    assert.ok(real.length > 100);
    const pkg = require('../package.json');
    assert.equal(real[0].version, pkg.version, 'newest section = package version');
    for (const s of real) {
      for (const g of s.groups) {
        for (const it of g.items) {
          for (const tok of it) {
            assert.ok(['text', 'code', 'strong'].includes(tok.t));
            if (tok.t === 'text') assert.ok(!/\*\*|`/.test(tok.v), `markup left in ${s.version}: ${tok.v.slice(0, 80)}`);
          }
        }
      }
    }
  });

  test('CHANGELOG.md is not excluded from the Docker build context', () => {
    const di = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
    const star = di.indexOf('*.md');
    const keep = di.indexOf('!CHANGELOG.md');
    assert.ok(keep > star && star !== -1, '!CHANGELOG.md must come after *.md');
  });
});

describe('whatsNew()', () => {
  const sections = changelog.parseChangelog(SAMPLE);
  test('sections newer than last seen, up to current, newest first', () => {
    const r = changelog.whatsNew({ current: '1.3.0', lastSeen: '1.1.0', sections });
    assert.equal(r.unseen, true);
    assert.deepEqual(r.sections.map((s) => s.version), ['1.3.0', '1.2.0']);
  });
  test('nothing newer → unseen false, empty; all=true → latest ≤ current', () => {
    const r = changelog.whatsNew({ current: '1.2.0', lastSeen: '1.2.0', sections });
    assert.equal(r.unseen, false);
    assert.deepEqual(r.sections, []);
    const a = changelog.whatsNew({ current: '1.2.0', lastSeen: '1.2.0', all: true, sections });
    assert.deepEqual(a.sections.map((s) => s.version), ['1.2.0', '1.1.0', '1.0.0']);
  });
  test('never dismissed → only the current release', () => {
    const r = changelog.whatsNew({ current: '1.3.0', lastSeen: null, sections });
    assert.equal(r.unseen, true);
    assert.deepEqual(r.sections.map((s) => s.version), ['1.3.0']);
  });
  test('at most 5 sections', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ version: `2.0.${i}`, date: null, groups: [] }));
    const r = changelog.whatsNew({ current: '2.0.8', lastSeen: '1.0.0', sections: many });
    assert.equal(r.sections.length, 5);
    assert.equal(r.sections[0].version, '2.0.8');
  });
  test('compareVersions is numeric', () => {
    assert.equal(changelog.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(changelog.compareVersions('1.2.0', '1.2.0'), 0);
    assert.equal(changelog.compareVersions('1.2.0', '1.12.0'), -1);
  });
});

describe('API', () => {
  before(async () => { await setup(); });
  after(() => teardown());
  const pkg = require('../package.json');

  test('GET /api/v1/system/whats-new for a user who never dismissed it', async () => {
    const res = await getAgent().get('/api/v1/system/whats-new');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.current, pkg.version);
    assert.equal(res.body.unseen, true);
    assert.equal(res.body.sections.length, 1);
    assert.equal(res.body.sections[0].version, pkg.version);
    assert.ok(Array.isArray(res.body.sections[0].groups));
    assert.ok(!/<[a-z]/i.test(JSON.stringify(res.body).replace(/"v":"[^"]*"/g, '')), 'no HTML structure from the server');
  });

  test('POST …/seen stores users.last_seen_version → unseen false', async () => {
    const r = await getAgent().post('/api/v1/system/whats-new/seen').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(r.status, 200);
    assert.equal(r.body.last_seen_version, pkg.version);
    const row = require('../src/db/connection').getDb().prepare("SELECT last_seen_version FROM users WHERE username = 'admin'").get();
    assert.equal(row.last_seen_version, pkg.version);
    const res = await getAgent().get('/api/v1/system/whats-new');
    assert.equal(res.body.unseen, false);
    assert.deepEqual(res.body.sections, []);
    const all = await getAgent().get('/api/v1/system/whats-new?all=1');
    assert.ok(all.body.sections.length >= 1 && all.body.sections.length <= 5);
  });

  test('an older last_seen_version shows the releases in between', async () => {
    const real = changelog.getSections();
    const older = real[3].version;
    await getAgent().post('/api/v1/system/whats-new/seen').set('X-CSRF-Token', getCsrf()).send({ version: older });
    const res = await getAgent().get('/api/v1/system/whats-new');
    assert.equal(res.body.unseen, true);
    assert.deepEqual(res.body.sections.map((s) => s.version), real.slice(0, 3).map((s) => s.version));
  });

  test('POST …/seen rejects a version newer than the running one or garbage', async () => {
    for (const version of ['99.0.0', 'abc', '1.2']) {
      const r = await getAgent().post('/api/v1/system/whats-new/seen').set('X-CSRF-Token', getCsrf()).send({ version });
      assert.equal(r.status, 400, version);
      assert.equal(r.body.code, 'INVALID_VERSION');
    }
  });
});
