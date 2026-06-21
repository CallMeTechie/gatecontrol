'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'routes.js'), 'utf8');
describe('printer-preset wizard UI', () => {
  it('posts to the printer-presets endpoint', () => {
    assert.match(js, /\/api\/v1\/printer-presets/);
  });
  it('does not inject a <style> element (CSP)', () => {
    assert.ok(!/createElement\(\s*['"]style['"]\s*\)/.test(js), 'no runtime <style> injection');
  });
  it('never uses a _hint as an insertBefore reference (sharp guard, R3-M4)', () => {
    // Convention: hints are appended, never used as insertBefore refs (that was the egress bug).
    assert.ok(!/insertBefore\([^,]+,\s*\w+\._hint\b/.test(js), 'use appendChild for hints, not insertBefore(_hint)');
  });
  it('references the license-lock hint keys (gating, R1-G2)', () => {
    assert.match(js, /printer_preset\.scan_locked/);
    assert.match(js, /printer_preset\.ews_locked/);
  });
});

// Behaviour test for the extracted, importable body-assembler (R3-M4). Put
// buildPresetBody in public/js/printerPresetForm.js with a `if (typeof module
// !== 'undefined') module.exports = { buildPresetBody }` footer so both the
// browser and node can load it.
const { buildPresetBody } = require('../public/js/printerPresetForm');
describe('buildPresetBody', () => {
  it('omits ews/scan when their checkboxes are off', () => {
    const body = buildPresetBody({ near_peer_id: 5, printer_ip: '192.168.2.45', name: 'X', ports: { 9100: true, 631: false }, ewsOn: false, scanOn: false });
    assert.deepEqual(body.print_ports, [9100]); assert.equal(body.ews, null); assert.equal(body.scan, null);
  });
  it('includes scan with mode new and a /32 is added server-side', () => {
    const body = buildPresetBody({ near_peer_id: 5, printer_ip: '192.168.2.45', name: 'X', ports: { 9100: true, 631: true }, ewsOn: true, ewsDomain: 'p.example.com', scanOn: true, vip: '192.168.2.250', scanTargetMode: 'new', nasIp: '192.168.2.10', nasPeerId: 5 });
    assert.deepEqual(body.print_ports, [9100, 631]);
    assert.equal(body.ews.domain, 'p.example.com');
    assert.equal(body.scan.target.mode, 'new'); assert.equal(body.scan.vip_ip, '192.168.2.250');
  });
});

// Discovery-adopt fix: the wizard must be capability/enabled-aware and actively
// trigger a scan (not just read the in-memory cache and mislabel an empty result
// as "gateway does not support discovery").
const en = require('../src/i18n/en.json');
const de = require('../src/i18n/de.json');
const ADOPT_KEYS = ['printer_preset.adopt_unsupported', 'printer_preset.adopt_not_enabled', 'printer_preset.adopt_scanning', 'printer_preset.adopt_none', 'printer_preset.adopt_failed', 'printer_preset.adopt_active_hint', 'printer_preset.adopt_enable', 'printer_preset.adopt_enable_failed'];
describe('printer-preset discovery adopt (capability-aware)', () => {
  it('wizard references the capability-aware adopt message keys', () => {
    for (const k of ADOPT_KEYS) assert.ok(js.includes(k), 'routes.js missing ' + k);
  });
  it('wizard no longer mislabels an empty result with routes.suggested.unavailable in the adopt handler', () => {
    // The misleading reuse of routes.suggested.unavailable for the adopt empty-state is gone.
    // (The route-create discovery flow legitimately uses gateways.discovery.* keys instead.)
    assert.ok(!/printer_preset\.adopt'[\s\S]{0,1200}routes\.suggested\.unavailable/.test(js),
      'adopt handler must not fall back to routes.suggested.unavailable');
  });
  it('new adopt keys exist in both locales (en + de parity)', () => {
    for (const k of ADOPT_KEYS) { assert.ok(k in en, 'en missing ' + k); assert.ok(k in de, 'de missing ' + k); }
  });
});

describe('printer-preset discovery adopt — phase A (active scan + SSE + enable)', () => {
  it('adopt triggers an active scan', () => {
    assert.ok(js.includes('active_scan: true') || js.includes("active_scan:true"), 'adopt must request an active scan');
  });
  it('adopt wires a dedicated SSE listener (_discListener), not the route-create one', () => {
    assert.ok(js.includes('_discListener'), 'adopt must use _discListener');
    assert.ok(js.includes("document.addEventListener('gc:gateway_discovery', _discListener"), 'must register _discListener for gc:gateway_discovery');
  });
  it('adopt removes the SSE listener (leak-safe)', () => {
    assert.ok(js.includes("removeEventListener('gc:gateway_discovery', _discListener"), 'must remove _discListener');
  });
  it('adopt cancels its timeout timer on cleanup (no cross-scan race)', () => {
    assert.ok(js.includes('_discTimer'), 'must use a module-level _discTimer cleared in _clearDisc');
  });
  it('adopt renders the active-scan IDS hint', () => {
    assert.ok(js.includes('printer_preset.adopt_active_hint'), 'must render adopt_active_hint');
  });
  it('adopt offers inline enable + references its i18n keys', () => {
    assert.ok(js.includes('/discovery-settings'), 'must call discovery-settings to enable');
    assert.ok(js.includes('printer_preset.adopt_enable'), 'must reference adopt_enable');
  });
});
