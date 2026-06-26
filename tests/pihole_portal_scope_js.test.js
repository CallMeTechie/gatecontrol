'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('portal.js wires scope switching to the 3 endpoints + login affordance, DOM-safe, PT, no raw fields', () => {
  const js = fs.readFileSync(path.join(__dirname,'..','public','js','portal.js'),'utf8');
  assert.ok(/hydratePiholeScope/.test(js), 'no hydratePiholeScope');
  assert.ok(/data-scope|dataset\.scope/.test(js), 'no scope wiring');
  assert.ok(/\/api\/v1\/portal\/pihole\/owner/.test(js) && /\/api\/v1\/portal\/pihole\/household/.test(js), 'missing endpoints');
  assert.ok(/no_owner|login_required/.test(js) && /\/login/.test(js), 'no login affordance');
  assert.ok(/\bPT\[/.test(js) && !/\bI18N\b/.test(js), 'must use PT i18n object');
  // client-side leak guard (spec §7): scope render must not touch raw cache fields
  assert.ok(!/\.topClients\b|\.clients\b|data\.ip\b/.test(js), 'raw field referenced');
  // DOM-safety: the login affordance must NOT be built by concatenating i18n text into innerHTML
  assert.ok(!/innerHTML\s*[+=][^;]*PT\.pihole(NoOwner|LoginRequired)/.test(js), 'innerHTML + PT i18n (XSS risk)');
  assert.ok(!/innerHTML\s*[+=][^;]*['"]\/login['"]/.test(js), 'login href via innerHTML');
});
