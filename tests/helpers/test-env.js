'use strict';

// Ein Ort für die Testumgebung — damit ein lokaler Lauf nicht anders aussieht
// als die CI.
//
// Hintergrund: die CI ruft `npm test` mit NODE_ENV=test und einem beschreib-
// baren Arbeitsverzeichnis auf, lokal lief der Container bisher als root ohne
// NODE_ENV. Beides zusammen hat zwei Releases gekostet:
//   * ohne NODE_ENV=test wirft config/default.js „GC_SECRET is not set“ —
//     jede Testdatei, die nicht über helpers/setup.js läuft, scheitert lokal
//     (und nur lokal);
//   * als root schreibt ein Test nach /data, ohne dass es auffällt — die CI
//     läuft unprivilegiert und bricht ab.
//
// Dieses Modul setzt deshalb NODE_ENV=test und lenkt JEDEN Datenpfad, den
// config/default.js bzw. src/ kennt, in ein Temp-Verzeichnis. Es wird an drei
// Stellen benutzt:
//   1. als `--require`-Vorlader des test-Skripts (package.json) und von
//      nt.sh — greift damit für JEDE Testdatei, auch für die, die
//      helpers/setup.js nicht benutzen;
//   2. aus helpers/setup.js heraus (applyDataDirEnv), damit die 200+ Dateien
//      mit setup() ihre Pfade auch im Einzellauf ohne Vorlader umgelenkt
//      bekommen;
//   3. aus einzelnen Testdateien, die ohne setup() auskommen und sonst nur
//      im Suite-Lauf grün sind (`require('./helpers/test-env')`).
//
// Alles ist „nur setzen, wenn nicht gesetzt“: eine Testdatei, die vor dem
// require ihr eigenes GC_CADDY_DATA_DIR wählt, behält es.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// mkdtempSync-Wrapper + Aufräumen am Prozessende.
require('./tmp-cleanup');

function setIfUnset(key, value) {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

/**
 * Lenkt alle Datenpfade nach `dir`. Nur Variablen, die noch nicht gesetzt
 * sind — der Aufrufer (Testdatei) hat immer Vorrang.
 *
 * Die Liste ist bewusst vollständig gegenüber config/default.js und den
 * `/data`-Vorgabewerten in src/: jeder Pfad, den ein Test anfassen könnte,
 * muss im Temp-Verzeichnis landen, sonst schreibt der Test als root nach
 * /data und fällt erst in der CI auf.
 */
function applyDataDirEnv(dir) {
  setIfUnset('GC_DATA_DIR', dir);                                        // utils/crypto (Keypair), Branding, allgemein
  setIfUnset('GC_DATA_PATH', dir);                                       // license token, autoUpdate, offsite
  setIfUnset('GC_CADDY_DATA_DIR', path.join(dir, 'caddy'));              // access.log, tls.log, runtime.json, Zertifikate
  setIfUnset('GC_BACKUP_DIR', path.join(dir, 'backups'));                // autobackup
  setIfUnset('GC_DNS_HOSTS_FILE', path.join(dir, 'dns', 'peers.hosts')); // services/dns
  setIfUnset('GC_WG_ENDPOINTS_FILE', path.join(dir, 'wireguard', 'last-endpoints'));
  setIfUnset('GC_WG_CONFIG_PATH', path.join(dir, 'wireguard', 'wg0.conf'));
  setIfUnset('GC_DNSMASQ_CONF', path.join(dir, 'dnsmasq.conf'));
  setIfUnset('GC_GATEWAY_LATEST_CACHE', path.join(dir, 'gateway-latest.json'));
  return dir;
}

/**
 * Die Grundeinstellungen, ohne die eine Testdatei im Einzellauf gar nicht
 * erst lädt. NODE_ENV=test ist der wichtigste Eintrag: config/default.js
 * erzeugt nur dann ein Sitzungsgeheimnis selbst, und caddyAdminClient /
 * caddyConfig schalten nur dann ihre Netzaufrufe ab.
 */
function applyBaseEnv() {
  setIfUnset('NODE_ENV', 'test');
  setIfUnset('GC_LOG_LEVEL', 'silent');
  setIfUnset('GC_BASE_URL', 'http://localhost:3000');
  setIfUnset('GC_WG_HOST', 'test.example.com');
  setIfUnset('GC_ADMIN_USER', 'admin');
  setIfUnset('GC_ADMIN_PASSWORD', 'TestPass123!');
  // Hohe Obergrenzen: viele Dateien melden sich pro Test neu an.
  setIfUnset('GC_RATE_LIMIT_LOGIN', '100000');
  setIfUnset('GC_RATE_LIMIT_API', '100000');
  setIfUnset('GC_RATE_LIMIT_GATEWAY', '100000');
  // Feste, offensichtlich wertlose Testschlüssel statt Zufall: zwei Läufe
  // derselben Datei sind damit vergleichbar, und ein Geheimnis steht nirgends
  // in einer Ausgabe. Für Produktion wirft config/default.js ohnehin.
  setIfUnset('GC_SECRET', 'gc-test-secret-'.padEnd(64, '0'));
  setIfUnset('GC_ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
}

// Beim ersten require: Umgebung setzen und ein eigenes Temp-Verzeichnis
// anlegen. Weitere requires bekommen dasselbe Verzeichnis (require-Cache).
applyBaseEnv();
// Präfix bewusst `gc-test-`: der Nachzügler-Sweeper in helpers/setup.js
// (cleanupStaleTestDirs) räumt damit auch dieses Verzeichnis, wenn ein Lauf
// hart abgeschossen wurde.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-env-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });
applyDataDirEnv(tmpDir);
// Ohne setup() gibt es keine eigene DB — eine im Temp-Verzeichnis ist immer
// noch besser als die Vorgabe <repo>/data/gatecontrol.db (Arbeitskopie in der
// CI schreibbar, im unprivilegierten Lauf nicht).
setIfUnset('GC_DB_PATH', path.join(tmpDir, 'gatecontrol.db'));

module.exports = { applyBaseEnv, applyDataDirEnv, setIfUnset, tmpDir };
