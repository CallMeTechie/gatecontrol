'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.js wires the Pi-hole scope switch to the 3 endpoints + login affordance, DOM-safe, no raw fields', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
  assert.ok(/function loadPihole\(/.test(js), 'no loadPihole');
  assert.ok(/getAttribute\('data-scope'\)/.test(js), 'no scope wiring');
  for (const u of ['/api/v1/portal/pihole', '/api/v1/portal/pihole/owner', '/api/v1/portal/pihole/household']) assert.ok(js.includes(`'${u}'`), u);
  assert.ok(/no_owner/.test(js) && /login_required/.test(js) && js.includes("'/login?returnTo=/portal'"), 'no login affordance');
  // Strings only from the island (T()), never concatenated into markup.
  assert.ok(!/\.innerHTML|outerHTML|insertAdjacentHTML/.test(js), 'no HTML injection APIs');
  // client-side leak guard (spec §7): never touches raw cache fields
  assert.ok(!/\.topClients\b|\.clients\b|data\.ip\b/.test(js), 'raw field referenced');
  // hiding on "unavailable" only for the first (device) load — owner/household keep the card
  assert.ok(/first && scope === 'device' && body\.reason === 'unavailable'/.test(js), 'unavailable hide must be gated to the device scope');
});
