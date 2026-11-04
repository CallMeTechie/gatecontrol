'use strict';
// Gateway-Einrichtungsdialog: Tab „Raspberry Pi“ (fertiges SD-Karten-Image).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');

const ROOT = path.join(__dirname, '..');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/aurora/partials/modals/peer-gateway-tokens.njk'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'public/js/peers.js'), 'utf8');

const KEYS = [
  'gateway_deploy_tab_rpi', 'gateway_deploy_rpi_intro', 'gateway_deploy_rpi_download_image',
  'gateway_deploy_rpi_download_env', 'gateway_deploy_rpi_imager_label', 'gateway_deploy_rpi_imager_hint',
  'gateway_deploy_rpi_steps_title', 'gateway_deploy_rpi_step1', 'gateway_deploy_rpi_step2',
  'gateway_deploy_rpi_step3', 'gateway_deploy_rpi_step4', 'gateway_deploy_rpi_step5', 'gateway_deploy_rpi_docs',
];

test('rpi tab i18n keys present and non-empty in en + de', () => {
  for (const k of KEYS) {
    assert.equal(typeof en[k], 'string', 'en missing ' + k); assert.ok(en[k].length, 'en empty ' + k);
    assert.equal(typeof de[k], 'string', 'de missing ' + k); assert.ok(de[k].length, 'de empty ' + k);
  }
});

test('every rpi key used by the template exists, and the template uses all of them', () => {
  const used = [...TPL.matchAll(/t\('(gateway_deploy_rpi_[a-z0-9_]+|gateway_deploy_tab_rpi)'\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].sort(), [...KEYS].sort());
});

test('rpi tab button + pane are wired like the other tabs', () => {
  assert.match(TPL, /class="gw-tab" data-gw-tab="rpi"/);
  assert.match(TPL, /class="gw-tab-pane" data-gw-pane="rpi" style="display:none"/);
});

test('image + Imager links point at releases/latest (no hard-coded version)', () => {
  assert.match(TPL, /href="https:\/\/github\.com\/CallMeTechie\/gatecontrol-gateway\/releases\/latest"/);
  assert.match(TPL, /value="https:\/\/github\.com\/CallMeTechie\/gatecontrol-gateway\/releases\/latest\/download\/gatecontrol-rpi-imager\.json"/);
  const pane = TPL.slice(TPL.indexOf('data-gw-pane="rpi"'), TPL.indexOf('data-gw-pane="manual"'));
  assert.doesNotMatch(pane, /releases\/download\/v\d|\/v\d+\.\d+\.\d+\//, 'no pinned release version');
  assert.match(pane, /rel="noopener noreferrer"/);
});

test('peers.js wires the rpi buttons (env download as gateway.env, copy Imager URL)', () => {
  assert.match(JS, /getElementById\('gateway-rpi-download-env'\)/);
  assert.match(JS, /rpiEnvBtn\.onclick\s*=\s*function\(\) \{ downloadAsFile\(envEl\.value, 'gateway\.env'\); \}/);
  assert.match(JS, /getElementById\('gateway-rpi-copy-imager-url'\)/);
  assert.match(JS, /copyToClipboard\(rpiUrlEl\.value\)/);
  for (const id of ['gateway-rpi-download-env', 'gateway-rpi-copy-imager-url', 'gateway-rpi-imager-url']) {
    assert.ok(TPL.includes('id="' + id + '"'), 'template missing #' + id);
  }
});
