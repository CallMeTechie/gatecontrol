'use strict';

// Die alte Gateway-Verwaltung auf „Peers“ (Token-Dialog, Deploy-Tabs LXC /
// Docker / Raspberry Pi, Gateway-Karten) ist mit #441 entfallen; die heutige
// Verwaltung liegt unter „Gateways“ (gwiz.*, gwm.*, gateway_delete_*). Ihre
// Übersetzungen waren danach verwaist und sind entfernt. Dieser Test hält
// beides fest: die Schlüssel kommen nicht unbemerkt zurück, und niemand
// verweist mehr auf sie (auch nicht über einen zusammengesetzten Präfix).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'src', 'i18n');

const REMOVED_PREFIXES = ['peers.gateway.', 'gateway_deploy_', 'gateway_tokens_', 'gateway_download_'];
const REMOVED_KEYS = ['peer_is_gateway', 'peer_gateway_hint', 'peer_gateway_api_port', 'peers.gateways_section', 'gateway_setup_again'];

// Gleich anfangende Namen, die keine Übersetzungsschlüssel der alten Seite
// sind: das Aktivitätsereignis beim Erneuern der Gateway-Tokens.
const NOT_I18N = ['gateway_tokens_rotated'];

function isRemoved(key) {
  return REMOVED_KEYS.includes(key) || REMOVED_PREFIXES.some((p) => key.startsWith(p));
}

test('language files no longer contain the old gateway page keys', () => {
  for (const file of fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.json'))) {
    const dict = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
    const left = Object.keys(dict).filter(isRemoved);
    assert.deepEqual(left, [], `${file}: ${left.join(', ')}`);
  }
});

test('the keys still in use next to them are kept', () => {
  for (const file of ['de.json', 'en.json']) {
    const dict = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
    for (const key of ['peer_gateway_proxy_port_hint', 'gateway_delete_title', 'peers.stats.gateways']) {
      assert.ok(Object.prototype.hasOwnProperty.call(dict, key), `${file}: ${key}`);
    }
  }
});

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || full === I18N_DIR) continue;
      yield* sourceFiles(full);
    } else if (/\.(js|mjs|cjs|njk|html)$/.test(entry.name)) {
      yield full;
    }
  }
}

test('no source, template or page script refers to the removed keys or prefixes', () => {
  const self = path.resolve(__filename);
  const needles = [...REMOVED_PREFIXES, ...REMOVED_KEYS];
  const hits = [];
  for (const dir of ['src', 'public', 'templates', 'tests']) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      if (path.resolve(file) === self) continue;
      let text = fs.readFileSync(file, 'utf8');
      for (const name of NOT_I18N) text = text.split(name).join('');
      for (const n of needles) if (text.includes(n)) hits.push(`${path.relative(ROOT, file)}: ${n}`);
    }
  }
  assert.deepEqual(hits, []);
});
