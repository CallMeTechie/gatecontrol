#!/usr/bin/env node
'use strict';
// Legt den Test-Stub für @callmetechie/gatecontrol-config-hash in node_modules ab.
//
// Warum: das echte Paket liegt in der privaten GitHub-Registry. Ohne Token
// bricht `npm ci` mit E401 ab — und zwar für ALLE Abhängigkeiten, nicht nur
// für dieses eine Paket. Wer ohne Zugriff an GateControl arbeitet, macht
// deshalb:
//
//   npm install --ignore-scripts --no-package-lock --omit=optional \
//     $(node -e "…")           # oder: node_modules aus dem Image kopieren
//   npm run test:config-hash-stub
//   npm test
//
// Siehe docs/testing-local.md.
//
// Sicherungen:
//   * NODE_ENV=production → Abbruch.
//   * Ein bereits installiertes ECHTES Paket wird nicht überschrieben
//     (--force erzwingt es, etwa zum Nachstellen eines Stub-Laufs).
//   * Der Stub selbst wirft beim require ausserhalb von NODE_ENV=test.
//   * tests/config_hash_stub_guard.test.js schlägt fehl, wenn in der CI
//     (CI=true) der Stub geladen ist.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'tests', 'stubs', 'config-hash');
const DEST = path.join(ROOT, 'node_modules', '@callmetechie', 'gatecontrol-config-hash');
const FILES = ['package.json', 'index.cjs'];

function isStub(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).gatecontrolTestStub === true;
  } catch {
    return false;
  }
}

function main(argv) {
  const force = argv.includes('--force');

  if (process.env.NODE_ENV === 'production') {
    console.error('install-config-hash-stub: refusing to run with NODE_ENV=production.');
    console.error('The stub is for running the test suite without registry access — never for a deployment.');
    return 1;
  }

  if (fs.existsSync(DEST) && !isStub(DEST) && !force) {
    console.error(`install-config-hash-stub: ${path.relative(ROOT, DEST)} already holds the REAL package — leaving it alone.`);
    console.error('Nothing to do (that is the good case). Use --force only to reproduce a stub run on purpose.');
    return 1;
  }

  fs.mkdirSync(DEST, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));

  console.log(`install-config-hash-stub: wrote the TEST STUB to ${path.relative(ROOT, DEST)}`);
  console.log('It is NOT the real config-hash implementation: hashes are self-consistent inside this repo,');
  console.log('but must not be compared against a real gateway. CI always installs the real package.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, isStub, SRC, DEST, FILES };
