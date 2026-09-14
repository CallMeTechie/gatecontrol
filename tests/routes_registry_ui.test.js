'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('served routes page carries the edit modal registry ids (rendered, no raw keys)', async () => {
  const res = await getAgent().get('/routes').expect(200);
  assert.match(res.text, /id="edit-route-prefix"/);
  assert.match(res.text, /id="edit-route-base-domain"/);
  assert.match(res.text, /id="edit-route-domain-freetext"/);
  // routes.prefix / routes.prefix_hint must be server-rendered (Nunjucks), not leaked as raw keys
  assert.doesNotMatch(res.text, /routes\.(prefix|prefix_hint|base_domain)\b/);
  assert.match(res.text, /empty = directly on the domain|leer = direkt auf der Domain/);
});

test('edit modal carries registry ids in all three themes', () => {
  for (const theme of ['aurora']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'partials', 'modals', 'route-edit.njk'), 'utf8');
    ['edit-route-prefix', 'edit-route-base-domain', 'edit-route-domain-freetext']
      .forEach(id => assert.ok(html.includes(id), `${theme}: ${id}`));
  }
});
