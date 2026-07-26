'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let ctx, settings;

// GET /api/v1/settings/app gab settings.getAll() ungefiltert aus — inklusive
// ip2location.api_key im Klartext, obwohl die dafür zuständige Route
// GET /settings/ip2location bewusst nur has_api_key liefert. Ein Token mit
// settings-Scope las damit Secrets, Sicherheitsrichtlinie und Betreiberadressen.

// Schlüssel, die die Route unter keinen Umständen ausliefern darf.
// Werte bewusst unterscheidbar (Marker statt '1' oder '900'): die Prüfung sucht
// sie als Teilstring in der GESAMTEN Antwort — mit kurzen, häufigen Werten wäre
// sie ein Zufallstreffer statt eines Belegs.
const MUST_NOT_LEAK = {
  'ip2location.api_key': 'LEAKMARK-ip2location-key',
  license_key: 'LEAKMARK-license-key',
  license_signing_key_encrypted: 'LEAKMARK-signing-key',
  'alerts.email': 'LEAKMARK-alerts@example.com',
  alert_email: 'LEAKMARK-alert@example.com',
  'monitoring.alert_email': 'LEAKMARK-monitoring@example.com',
  custom_dns: 'LEAKMARK-10.9.8.7',
  'server.public_ip': 'LEAKMARK-203.0.113.9',
  'server.verify_resolver': 'LEAKMARK-10.0.0.53',
  'portal.base_domain': 'LEAKMARK-geheim.example.com',
  'portal.prefix': 'LEAKMARK-intern',
  'security.lockout.enabled': 'LEAKMARK-lockout-on',
  'security.lockout.duration': 'LEAKMARK-lockout-duration',
  'security.lockout.max_attempts': 'LEAKMARK-lockout-attempts',
  'security.password.min_length': 'LEAKMARK-pw-minlen',
  'security.password.require_special': 'LEAKMARK-pw-special',
  route_external_block_body: 'LEAKMARK-<p>interne Notiz</p>',
};

before(async () => {
  ctx = await setup();
  settings = require('../src/services/settings');
});
after(async () => { await teardown(); });
beforeEach(() => {
  for (const [k, v] of Object.entries(MUST_NOT_LEAK)) settings.set(k, v);
  settings.set('default_theme', 'aurora');
});

test('GET /settings/app leaks none of the sensitive keys', async () => {
  const res = await ctx.agent.get('/api/v1/settings/app');
  assert.equal(res.status, 200);
  const body = JSON.stringify(res.body);
  for (const [key, value] of Object.entries(MUST_NOT_LEAK)) {
    assert.equal(res.body.settings[key], undefined, `Schlüssel ${key} wird ausgeliefert`);
    assert.ok(!body.includes(value), `Wert von ${key} taucht irgendwo in der Antwort auf`);
  }
});

test('GET /settings/app still returns the harmless settings and the config block', async () => {
  const res = await ctx.agent.get('/api/v1/settings/app');
  assert.equal(res.body.settings.default_theme, 'aurora');
  assert.equal(typeof res.body.config.appName, 'string');
  assert.ok(Array.isArray(res.body.config.availableLanguages));
});

test('a key nobody classified stays private — the allowlist decides, not the caller', async () => {
  // Das ist die eigentliche Zusicherung: eine künftig ergänzte Einstellung ist
  // unsichtbar, bis jemand sie bewusst in PUBLIC_KEYS aufnimmt. Eine Sperrliste
  // verhielte sich umgekehrt und hätte genau dieses Leck erneut erzeugt.
  settings.set('some.future.setting', 'noch-nicht-eingeordnet');
  const res = await ctx.agent.get('/api/v1/settings/app');
  assert.equal(res.body.settings['some.future.setting'], undefined);
});

test('getPublic is a strict subset of getAll and never invents keys', () => {
  const all = settings.getAll();
  const pub = settings.getPublic();
  for (const [k, v] of Object.entries(pub)) {
    assert.ok(k in all, `getPublic erfand den Schlüssel ${k}`);
    assert.equal(v, all[k], `Wert von ${k} weicht ab`);
  }
  assert.ok(Object.keys(pub).length < Object.keys(all).length, 'nichts wurde gefiltert');
});

test('the allowlist itself contains no sensitive key', () => {
  for (const key of Object.keys(MUST_NOT_LEAK)) {
    assert.ok(!settings.PUBLIC_KEYS.has(key), `PUBLIC_KEYS enthält ${key}`);
  }
  // Grobfilter gegen künftige Ergänzungen mit verräterischem Namen.
  for (const key of settings.PUBLIC_KEYS) {
    assert.doesNotMatch(key, /key|secret|token|password|credential/i, `verdächtiger Eintrag: ${key}`);
  }
});
