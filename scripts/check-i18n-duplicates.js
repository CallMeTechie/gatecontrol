#!/usr/bin/env node
'use strict';
// Doppelte Schlüssel in den Sprachdateien finden.
//
// JSON.parse nimmt bei einem doppelten Schlüssel stillschweigend den LETZTEN
// Wert. In en.json standen `route_auth.method_email_password`,
// `route_auth.method_email_code` und `route_auth.method_totp` deshalb lange
// zweimal, ohne dass irgendetwas rot wurde — bis jemand den ersten der beiden
// Einträge ändert und sich wundert, warum die Oberfläche den alten Text zeigt.
//
// Der Parser hier liest die Datei als Zeichenstrom und zählt jeden Schlüssel
// mit seiner Zeilennummer, statt sich auf JSON.parse zu verlassen.
// Exit 1 bei Fund (mit beiden Zeilennummern), sonst 0.

const fs = require('node:fs');
const path = require('node:path');

const I18N_DIR = path.join(__dirname, '..', 'src', 'i18n');

/**
 * Alle Schlüssel der obersten Ebene mit ihren Zeilennummern.
 * Die Sprachdateien sind flach ("a.b.c": "text"), aber verschachtelte Objekte
 * würden hier ebenfalls sauber übersprungen: gezählt wird nur Tiefe 1.
 */
function topLevelKeys(text) {
  const found = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '"') {
      // Zeichenkette lesen (mit Escapes), Startzeile merken.
      const startLine = line;
      let j = i + 1;
      let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { raw += text[j] + text[j + 1]; j += 2; continue; }
        if (text[j] === '\n') line++;
        raw += text[j];
        j++;
      }
      // Ist es ein Schlüssel? Dann folgt (nach Zwischenraum) ein ':'.
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (depth === 1 && text[k] === ':') found.push({ key: JSON.parse(`"${raw}"`), line: startLine });
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return found;
}

/** @returns {{key: string, lines: number[]}[]} */
function findDuplicates(text) {
  const byKey = new Map();
  for (const { key, line } of topLevelKeys(text)) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(line);
  }
  return [...byKey.entries()].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
}

function checkFiles(dir = I18N_DIR) {
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const dups = findDuplicates(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (dups.length) out.push({ file, dups });
  }
  return out;
}

if (require.main === module) {
  const problems = checkFiles();
  if (problems.length) {
    for (const { file, dups } of problems) {
      for (const { key, lines } of dups) {
        console.error(`${file}: duplicate key "${key}" on lines ${lines.join(', ')}`);
      }
    }
    console.error('\nJSON.parse silently keeps the last value — remove the superfluous entries.');
    process.exit(1);
  }
  console.log('i18n: no duplicate keys');
}

module.exports = { topLevelKeys, findDuplicates, checkFiles, I18N_DIR };
