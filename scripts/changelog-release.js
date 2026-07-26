#!/usr/bin/env node
'use strict';

/**
 * Prepare CHANGELOG.md for a release.
 *
 * Wird vom Release-Workflow aufgerufen. Die Logik lag früher als awk-Einzeiler
 * im YAML und war damit nicht testbar — sie hatte einen Fehler, der sich über
 * 24 Releases angesammelt hat:
 *
 *   awk '/^# Changelog/ { print; print ""; print block; … }'
 *
 * Der erzeugte Versionsblock wurde blind hinter die Überschrift geschoben. Ein
 * von Hand gepflegter `## [Unreleased]`-Abschnitt blieb dabei liegen, wo er
 * war — also unterhalb der neuen Version. Folge: die ausführlichen
 * Beschreibungen erschienen in keinem Release, und die Datei sammelte
 * `[Unreleased]`-Überschriften an, die längst ausgeliefert waren.
 *
 * Neues Verhalten:
 *   - Steht direkt unter `# Changelog` ein `## [Unreleased]` MIT Inhalt, wird
 *     dessen Überschrift zur Version. Der aus der Commit-Message erzeugte
 *     Eintrag entfällt dann: hat jemand die Änderung beschrieben, ist die
 *     erste Zeile des letzten Commits die schlechtere Zusammenfassung.
 *   - Sonst wird wie bisher ein Block aus der Commit-Message erzeugt.
 *
 * Aufruf: node scripts/changelog-release.js <version> <date> <commit-subject> [datei]
 */

const fs = require('node:fs');

function sectionFor(subject) {
  if (/^feat/.test(subject)) return 'Features';
  if (/^fix/.test(subject)) return 'Fixes';
  if (/^docs/.test(subject)) return 'Dokumentation';
  return 'Änderungen';
}

function entryFor(subject) {
  // "feat(scope): text" → "text"; ohne Präfix bleibt die Zeile, wie sie ist.
  const m = subject.match(/^[a-z]+(\([^)]*\))?!?:\s*(.*)$/);
  return m ? m[2] : subject;
}

/**
 * @returns {{ text: string, promoted: boolean }} promoted=true, wenn ein
 * handgepflegter Unreleased-Block zur Version wurde.
 */
function prepare(content, version, date, subject) {
  const lines = content.split('\n');
  const headingAt = lines.findIndex((l) => /^## \[/.test(l));
  const headerEnd = headingAt === -1 ? lines.length : headingAt;

  const isUnreleased = headingAt !== -1 && /^## \[Unreleased\]/i.test(lines[headingAt]);
  if (isUnreleased) {
    // Inhalt bis zur nächsten Überschrift — Trennstriche und Leerzeilen zählen nicht.
    const next = lines.findIndex((l, i) => i > headingAt && /^## \[/.test(l));
    const end = next === -1 ? lines.length : next;
    const hasContent = lines.slice(headingAt + 1, end)
      .some((l) => l.trim() && l.trim() !== '---');
    if (hasContent) {
      const out = lines.slice();
      out[headingAt] = `## [${version}] — ${date}`;
      return { text: out.join('\n'), promoted: true };
    }
  }

  const block = [
    `## [${version}] — ${date}`,
    '',
    `### ${sectionFor(subject)}`,
    `- ${entryFor(subject)}`,
    '',
    '---',
    '',
  ];
  const out = lines.slice(0, headerEnd).concat(block, lines.slice(headerEnd));
  return { text: out.join('\n'), promoted: false };
}

module.exports = { prepare, sectionFor, entryFor };

if (require.main === module) {
  const [version, date, subject, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version || !date || subject === undefined) {
    console.error('usage: changelog-release.js <version> <date> <commit-subject> [file]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`${file} not found — nothing to do`);
    process.exit(0);
  }
  const { text, promoted } = prepare(fs.readFileSync(file, 'utf8'), version, date, subject.split('\n')[0]);
  fs.writeFileSync(file, text);
  console.log(promoted
    ? `promoted the hand-written [Unreleased] block to [${version}]`
    : `inserted a generated block for [${version}]`);
}
