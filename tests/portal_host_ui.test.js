'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const fs = require('node:fs'); const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('settings page renders the Portal address card, no raw i18n keys', async () => {
  const res = await getAgent().get('/settings').expect(200);
  assert.match(res.text, /id="st-po-domain"/);
  assert.match(res.text, /id="st-po-prefix"/);
  assert.match(res.text, /id="st-po-preview"/);
  // (the JSON string table in <script id="st-i18n"> carries the keys by design)
  const visible = res.text.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(visible, /settings\.portal\.(address|base_domain|prefix|host_note)\b/);
});

test('the portal address is part of the Portal section save (with a switch confirmation)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
  for (const id of ["selectRow('st-po-domain'", "textRow('st-po-prefix'", 'id="st-po-preview"', 'id="st-po-nodomains"']) assert.ok(html.includes(id), id);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  assert.match(js, /fields: \['po-domain', 'po-prefix'\], errorField: 'po-prefix',\s*confirm:/);
  assert.match(js, /api\.put\('\/api\/v1\/settings\/portal', \{ base_domain: v\['po-domain'\], prefix: v\['po-prefix'\]\.trim\(\) \}\)/);
});
