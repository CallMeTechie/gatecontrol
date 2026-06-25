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
  assert.match(res.text, /portal-base-domain/);
  assert.match(res.text, /portal-prefix/);
  assert.match(res.text, /portal-effective-host/);
  assert.doesNotMatch(res.text, /settings\.portal\.(address|base_domain|prefix|host_note)\b/);
});

test('all three themes contain the portal-address ids incl. the Apply button', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'pages', 'settings.njk'), 'utf8');
    ['portal-base-domain', 'portal-prefix', 'portal-effective-host', 'portal-host-error', 'portal-switch-warning', 'portal-host-apply', 'portal-no-domains-hint']
      .forEach(id => assert.ok(html.includes(id), `${theme}: ${id}`));
  }
});
