'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare } = require('../scripts/changelog-release');

// Regression gegen den Fehler, der sich über 24 Releases angesammelt hat: der
// Release-Workflow schob seinen erzeugten Block blind hinter "# Changelog" und
// ließ einen handgepflegten [Unreleased]-Abschnitt darunter liegen. Dessen
// Beschreibungen erschienen dadurch in keinem Release, und die Datei sammelte
// [Unreleased]-Überschriften an, die längst ausgeliefert waren.

const WITH_UNRELEASED = `# Changelog

## [Unreleased]

### Security
- Etwas Wichtiges, von Hand beschrieben.

### Fixed
- Noch etwas.

---

## [1.0.0] — 2026-01-01

### Fixes
- alt

---
`;

const WITHOUT_UNRELEASED = `# Changelog

## [1.0.0] — 2026-01-01

### Fixes
- alt

---
`;

const EMPTY_UNRELEASED = `# Changelog

## [Unreleased]

---

## [1.0.0] — 2026-01-01

### Fixes
- alt

---
`;

function headings(text) {
  return text.split('\n').filter((l) => l.startsWith('## ['));
}

test('a hand-written Unreleased block becomes the release', () => {
  const { text, promoted } = prepare(WITH_UNRELEASED, '1.1.0', '2026-02-02', 'fix: irgendwas');
  assert.equal(promoted, true);
  assert.deepEqual(headings(text), ['## [1.1.0] — 2026-02-02', '## [1.0.0] — 2026-01-01']);
  // Der Inhalt reist mit — das ist der ganze Punkt.
  assert.match(text, /## \[1\.1\.0\] — 2026-02-02\n\n### Security\n- Etwas Wichtiges/);
  assert.match(text, /- Noch etwas\./);
  // Kein zurückgelassener Unreleased-Block mehr.
  assert.equal((text.match(/## \[Unreleased\]/g) || []).length, 0);
});

test('the commit-derived entry is dropped when a human already described the release', () => {
  const { text } = prepare(WITH_UNRELEASED, '1.1.0', '2026-02-02', 'fix: irgendwas');
  assert.ok(!text.includes('irgendwas'), 'die Commit-Zeile verdrängt die Beschreibung');
});

test('without an Unreleased block the generated entry is inserted as before', () => {
  const { text, promoted } = prepare(WITHOUT_UNRELEASED, '1.1.0', '2026-02-02', 'feat(scope): neue Sache');
  assert.equal(promoted, false);
  assert.deepEqual(headings(text), ['## [1.1.0] — 2026-02-02', '## [1.0.0] — 2026-01-01']);
  assert.match(text, /### Features\n- neue Sache/);
});

test('an empty Unreleased block falls back to the generated entry', () => {
  // Sonst entstünde ein Versionsblock ohne jeden Inhalt.
  const { text, promoted } = prepare(EMPTY_UNRELEASED, '1.1.0', '2026-02-02', 'fix: etwas');
  assert.equal(promoted, false);
  assert.match(text, /### Fixes\n- etwas/);
});

test('the commit type decides the section, and the prefix is stripped', () => {
  for (const [subject, section, entry] of [
    ['feat: a', 'Features', 'a'],
    ['feat(x): b', 'Features', 'b'],
    ['fix!: c', 'Fixes', 'c'],
    ['docs: d', 'Dokumentation', 'd'],
    ['chore: e', 'Änderungen', 'e'],
    ['ganz ohne Präfix', 'Änderungen', 'ganz ohne Präfix'],
  ]) {
    const { text } = prepare(WITHOUT_UNRELEASED, '1.1.0', '2026-02-02', subject);
    assert.match(text, new RegExp(`### ${section}\\n- ${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), subject);
  }
});

test('only the topmost block is promoted — stray Unreleased headings stay untouched', () => {
  // Die 24 Altlasten in der echten Datei dürfen nicht versehentlich zur Version werden.
  const stray = `# Changelog

## [1.0.0] — 2026-01-01

### Fixes
- alt

---

## [Unreleased]

### Fixed
- eine Altlast weiter unten

---
`;
  const { text, promoted } = prepare(stray, '1.1.0', '2026-02-02', 'fix: etwas');
  assert.equal(promoted, false);
  assert.equal((text.match(/## \[Unreleased\]/g) || []).length, 1, 'die Altlast wurde angefasst');
  assert.deepEqual(headings(text)[0], '## [1.1.0] — 2026-02-02');
});

// Beide Fälle werden aus der echten Datei ABGELEITET, statt ihren jeweiligen
// Zustand vorauszusetzen — sonst kippt der Test, sobald jemand einen
// Unreleased-Abschnitt anlegt oder ein Release ihn befördert.
function realChangelog() {
  const fs = require('node:fs');
  const path = require('node:path');
  return fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
}
function withoutTopUnreleased(text) {
  const lines = text.split('\n');
  const h = lines.findIndex((l) => /^## \[/.test(l));
  if (h === -1 || !/^## \[Unreleased\]/i.test(lines[h])) return text;
  const next = lines.findIndex((l, i) => i > h && /^## \[/.test(l));
  return lines.slice(0, h).concat(lines.slice(next === -1 ? lines.length : next)).join('\n');
}

test('the real CHANGELOG: without a top Unreleased block, exactly one heading is added', () => {
  const real = withoutTopUnreleased(realChangelog());
  const { text, promoted } = prepare(real, '9.9.9', '2026-12-31', 'fix: probe');
  assert.equal(promoted, false);
  assert.equal(headings(text).length, headings(real).length + 1);
  assert.equal(headings(text)[0], '## [9.9.9] — 2026-12-31');
  assert.ok(text.startsWith('# Changelog'));
  // Kein Bestandsinhalt verloren: die alte Datei steckt vollständig in der neuen.
  assert.ok(text.includes(real.slice(real.indexOf('## ['))));
});

test('the real CHANGELOG: with a hand-written block on top, it is promoted and nothing is added', () => {
  const base = withoutTopUnreleased(realChangelog());
  const withBlock = base.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n### Security\n- von Hand\n\n---\n');
  const { text, promoted } = prepare(withBlock, '9.9.9', '2026-12-31', 'fix: probe');
  assert.equal(promoted, true);
  assert.equal(headings(text).length, headings(withBlock).length, 'es kam eine Überschrift dazu');
  assert.equal(headings(text)[0], '## [9.9.9] — 2026-12-31');
  assert.match(text, /## \[9\.9\.9\] — 2026-12-31\n\n### Security\n- von Hand/);
  assert.ok(!text.includes('- probe'), 'die Commit-Zeile wurde zusätzlich eingefügt');
});
