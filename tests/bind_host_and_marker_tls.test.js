'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── Bind-Adresse ────────────────────────────────────────────────────────────
// Die ausgelieferte Compose-Datei nutzt `network_mode: host`. Es gibt also kein
// Port-Mapping, das die Bindung eingrenzen könnte: was der Prozess bindet, liegt
// direkt auf allen Interfaces des Hosts. Ein Default von 0.0.0.0 stellt damit das
// Admin-UI unverschlüsselt ins Netz — an Caddy, TLS und HSTS vorbei.

test('the shipped compose files still use host networking (premise of this guard)', () => {
  for (const f of ['docker-compose.yml', 'deploy/docker-compose.yml']) {
    assert.match(read(f), /network_mode:\s*host/, `${f} nutzt kein host networking mehr — Annahme dieses Tests prüfen`);
  }
});

test('the code default binds loopback, not every interface', () => {
  const src = read('config/default.js');
  const m = src.match(/host:\s*env\('GC_HOST',\s*'([^']+)'\)/);
  assert.ok(m, 'GC_HOST-Default nicht gefunden');
  assert.equal(m[1], '127.0.0.1');
});

test('both shipped .env examples default to loopback', () => {
  for (const f of ['.env.example', 'deploy/.env.example']) {
    const m = read(f).match(/^GC_HOST=(.*)$/m);
    assert.ok(m, `${f}: GC_HOST nicht gefunden`);
    assert.equal(m[1].trim(), '127.0.0.1', `${f} bindet auf ${m[1]}`);
  }
});

test('caddy reaches the app over loopback, so the loopback bind cannot break it', () => {
  const src = read('src/services/caddyConfig.js');
  assert.match(src, /dial:\s*`127\.0\.0\.1:\$\{config\.app\.port\}`/);
  assert.doesNotMatch(src, /dial:\s*`0\.0\.0\.0:/);
});

// ── Marker-Host ─────────────────────────────────────────────────────────────
// `gc-owner.invalid` wird als Ownership-Marker NACH buildTlsAutomation() an die
// Routen gehängt und erreicht dort die TLD-Klassifizierung nie. Ohne expliziten
// Ausschluss greift Caddys automatisches HTTPS und versucht dauerhaft, für einen
// RFC-6761-Namen ein öffentliches Zertifikat zu holen.

test('the marker host is excluded from automatic HTTPS', () => {
  const { MARKER_HOST } = require('../src/services/caddyOwner');
  assert.equal(MARKER_HOST, 'gc-owner.invalid');
  const src = read('src/services/caddyConfig.js');
  assert.match(src, /automatic_https:\s*\{\s*skip:\s*\[MARKER_HOST\]\s*\}/,
    'srv0 schließt den Marker-Host nicht von der automatischen Zertifikatsvergabe aus');
});

test('the marker host is still classified as non-public if it ever reaches the classifier', () => {
  const { NON_PUBLIC_TLDS } = require('../src/services/caddyTlsAutomation');
  assert.ok(NON_PUBLIC_TLDS.has('invalid'), 'invalid fehlt in NON_PUBLIC_TLDS');
});
