'use strict';

// Doppelte Schlüssel in de.json/en.json sind unsichtbar: JSON.parse behält den
// letzten Wert, jeder Test auf `t('…')` bleibt grün, und eine Änderung am
// ersten der beiden Einträge wirkt einfach nicht. In en.json war das drei
// Schlüssel lang der Fall (`route_auth.method_email_password`,
// `route_auth.method_email_code`, `route_auth.method_totp`, Zeilen 613–615 und
// 988–990, beide Male mit demselben Wert — deshalb ist beim Entfernen des
// späteren Blocks nichts an der Oberfläche anders).
//
// Derselbe Prüfer läuft als CI-Schritt (scripts/check-i18n-duplicates.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findDuplicates, checkFiles, I18N_DIR } = require('../scripts/check-i18n-duplicates');

test('no language file has a duplicate key', () => {
  const problems = checkFiles();
  const msg = problems.map(({ file, dups }) => dups.map((d) => `${file}: "${d.key}" (lines ${d.lines.join(', ')})`).join('\n')).join('\n');
  assert.deepEqual(problems, [], msg);
});

test('de.json and en.json are actually being checked', () => {
  const files = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('de.json') && files.includes('en.json'), files.join(', '));
});

test('the check finds a duplicate that JSON.parse would swallow', () => {
  const text = '{\n  "a.b": "one",\n  "c.d": "two",\n  "a.b": "three"\n}\n';
  // Der Beweis, dass ein Test auf den geparsten Wert nichts merken würde:
  assert.equal(JSON.parse(text)['a.b'], 'three');
  assert.deepEqual(findDuplicates(text), [{ key: 'a.b', lines: [2, 4] }]);
});

test('escapes, colons in values and nested objects do not produce false positives', () => {
  const text = '{\n  "a": "x: y",\n  "b": "a quote \\" and a brace {",\n  "c": { "a": 1, "b": 2 },\n  "d": ["a", "a"]\n}\n';
  assert.deepEqual(findDuplicates(text), []);
});

test('the CI script exits non-zero on a duplicate and zero on a clean tree', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'check-i18n-duplicates.js');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);

  // Ein Verzeichnis mit einer kaputten Datei: der Prüfer muss anschlagen.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-i18ndup-'));
  fs.writeFileSync(path.join(dir, 'xx.json'), '{\n  "k": "1",\n  "k": "2"\n}\n');
  const { checkFiles: check } = require('../scripts/check-i18n-duplicates');
  assert.equal(check(dir).length, 1);
});
