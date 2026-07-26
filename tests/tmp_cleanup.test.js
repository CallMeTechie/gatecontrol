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

// ── Generische Bereinigung für ALLE Testdateien ────────────────────────────
// Der Sweeper oben deckt nur das Präfix `gc-test-` dieses Harness ab. 59 von 70
// Testdateien legen jedoch mit eigenem Präfix an (`gc-caddy-retry-`, `gc-env-`,
// `gc-cc-*` …) und entfernen nie. Jeder Suite-Lauf hinterließ dadurch hunderte
// Verzeichnisse, bis /tmp volllief — mit Symptomen, die nichts mit Tests zu tun
// hatten (ENOSPC in beliebigen anderen Kommandos).
//
// Geprüft wird die EIGENSCHAFT, nicht die Aufrufliste: ein Prozess, der ein
// temp-Verzeichnis anlegt, hinterlässt keines. Damit ist auch jede künftige
// Testdatei abgedeckt, ohne dass jemand daran denken muss.

const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'tests', 'helpers', 'tmp-cleanup.js');
const CHILD = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cleanup-probe-'));
fs.writeFileSync(path.join(d, 'inhalt.txt'), 'x');
fs.mkdirSync(path.join(d, 'unterordner'));
process.stdout.write(d);
`;

function runChild(preload) {
  const args = preload ? ['--require', PRELOAD, '-e', CHILD] : ['-e', CHILD];
  return execFileSync(process.execPath, args, { encoding: 'utf8' }).trim();
}

test('without the preload a temp dir survives the process — the bug this guards', () => {
  const dir = runChild(false);
  try {
    assert.equal(fs.existsSync(dir), true, 'Voraussetzung dieses Tests stimmt nicht mehr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with the preload the temp dir — including its contents — is gone on exit', () => {
  // Der Kindprozess legt Datei und Unterordner an: ein rmSync ohne `recursive`
  // würde hier scheitern.
  const dir = runChild(true);
  assert.equal(fs.existsSync(dir), false, `Verzeichnis blieb liegen: ${dir}`);
});

test('the preload leaves directories outside the temp root alone', () => {
  const outside = fs.mkdtempSync(path.join(ROOT, 'nicht-temp-'));
  try {
    const child = `const fs = require('node:fs');
      process.stdout.write(fs.mkdtempSync(${JSON.stringify(path.join(outside, 'x-'))}));`;
    const dir = execFileSync(process.execPath, ['--require', PRELOAD, '-e', child], { encoding: 'utf8' }).trim();
    assert.equal(fs.existsSync(dir), true, 'ein Verzeichnis außerhalb von os.tmpdir() wurde entfernt');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('mkdtempSync still behaves normally while the process runs', () => {
  const out = execFileSync(process.execPath, ['--require', PRELOAD, '-e',
    `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');
     const d=fs.mkdtempSync(p.join(os.tmpdir(),'gc-probe-rc-'));
     process.stdout.write(String(fs.existsSync(d)) + '|' + d);`], { encoding: 'utf8' }).trim();
  const [existedDuringRun, dir] = out.split('|');
  assert.equal(existedDuringRun, 'true', 'das Verzeichnis existierte während des Laufs nicht');
  assert.match(dir, /gc-probe-rc-/);
});

test('the npm test script preloads the cleanup', () => {
  // Ohne diesen Eintrag greift die Bereinigung im Suite-Lauf nicht — und genau
  // der Suite-Lauf hat /tmp gefüllt.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--require \.\/tests\/helpers\/tmp-cleanup\.js/);
});
