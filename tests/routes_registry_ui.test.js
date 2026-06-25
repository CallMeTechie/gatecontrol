'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

let app;
beforeEach(async () => { await setup(); app = require('../src/app').createApp(); });
afterEach(teardown);

test('create wizard has prefix + base-domain dropdown + free-text carve-out (served, no raw keys)', async () => {
  const res = await getAgent().get('/routes').expect(200);
  assert.match(res.text, /create-route-prefix/);
  assert.match(res.text, /create-route-base-domain/);
  assert.match(res.text, /create-route-domain-freetext/);
  assert.doesNotMatch(res.text, /routes\.(prefix|base_domain|other_domain)\b/);
});

test('all three themes carry the create-route registry ids', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'pages', 'routes.njk'), 'utf8');
    ['create-route-prefix', 'create-route-base-domain', 'create-route-domain-freetext']
      .forEach(id => assert.ok(html.includes(id), `${theme}: ${id}`));
  }
});
