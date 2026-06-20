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
