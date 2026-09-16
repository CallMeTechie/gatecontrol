'use strict';

// Die Testumgebung darf nirgendwo nach /data zeigen.
//
// Zwei Releases sind daran gescheitert: lokal lief der Test-Container als root
// mit beschreibbarem /data, die CI läuft unprivilegiert. Ein Test, der die
// Caddy-Logdatei schreibt, war lokal grün und in der CI rot — weil
// helpers/setup.js nur GC_DATA_DIR umgelenkt hat, nicht GC_CADDY_DATA_DIR.
//
// Geprüft wird die EIGENSCHAFT (jeder aufgelöste Datenpfad liegt unterhalb von
// os.tmpdir()), nicht die Liste der Variablen — ein neuer Pfad in
// config/default.js fällt damit auf, ohne dass jemand diesen Test pflegt.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('./helpers/test-env');

const TMP_ROOT = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
const underTmp = (p) => {
  const abs = path.resolve(p);
  return abs === TMP_ROOT || abs.startsWith(TMP_ROOT + path.sep);
};

test('the preload sets NODE_ENV=test', () => {
  // Ohne das wirft config/default.js „GC_SECRET is not set“, und
  // caddyAdminClient/caddyConfig lassen ihre Netzaufrufe zu.
  assert.equal(process.env.NODE_ENV, 'test');
});

test('every GC_* path variable points into the temp dir', () => {
  const pathVars = Object.keys(process.env).filter((k) => /^GC_.*(DIR|PATH|FILE)$/.test(k));
  assert.ok(pathVars.length >= 8, `only ${pathVars.length} path variables set: ${pathVars.join(', ')}`);
  for (const k of pathVars) {
    if (k === 'GC_CHANGELOG_PATH') continue; // liest CHANGELOG.md aus dem Repo, schreibt nichts
    assert.ok(underTmp(process.env[k]), `${k}=${process.env[k]} is outside ${TMP_ROOT}`);
  }
});

test('config/default.js resolves every data path into the temp dir', () => {
  const config = require('../config/default');
  const resolved = {
    'app.dbPath': config.app.dbPath,
    'caddy.dataDir': config.caddy.dataDir,
    'dns.hostsFile': config.dns.hostsFile,
    'license.tokenPath': config.license.tokenPath,
    'wireguard.configPath': config.wireguard.configPath,
  };
  for (const [name, p] of Object.entries(resolved)) {
    assert.ok(underTmp(p), `${name}=${p} is outside ${TMP_ROOT}`);
  }
});

test('the services that default to /data follow the environment', () => {
  assert.ok(underTmp(require('../src/services/autobackup').BACKUP_DIR), 'autobackup.BACKUP_DIR');
  assert.ok(underTmp(require('../src/services/offsite/proc').dataDir()), 'offsite.dataDir()');
  assert.ok(underTmp(require('../src/utils/crypto').KEYPAIR_DIR || process.env.GC_DATA_DIR), 'crypto keypair dir');
});

test('no test file puts a database or a written file into the repo tree', () => {
  // Der unprivilegierte Lauf mountet /app read-only; eine Test-DB neben den
  // Testdateien schlägt dort fehl (und in der CI, dort schreibbar, nicht) —
  // sechs Dateien haben das getan. Statisch geprüft, damit die siebte auffällt.
  const dir = path.join(__dirname);
  const offenders = [];
  const bad = [
    /mkdtempSync\(\s*path\.join\(\s*__dirname\s*,\s*['"`][^.]/,              // mkdtemp direkt in tests/
    /(writeFileSync|mkdirSync|appendFileSync|createWriteStream)\(\s*path\.join\(\s*__dirname\s*,\s*['"`][^.]/,
    /path\.join\(\s*__dirname\s*,\s*[`'"][^`'"\n]*\.(db|sqlite|log|conf|hosts)[`'"]\s*\)/, // test-x.db neben der Testdatei
  ];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (bad.some((re) => re.test(src))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `write into the repo tree — use os.tmpdir(): ${offenders.join(', ')}`);
});
