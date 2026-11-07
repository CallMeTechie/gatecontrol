'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
// Bulk owner on the Peers page (docs/feature-peers-page.md): a button in the
// bulk bar opens a choice of owners and posts the selection to batch-owner.
test('bulk owner control in the bulk bar', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'peers.njk'), 'utf8');
  assert.match(html, /id="pl-bulkbar"[\s\S]*data-bulk="owner"/);
});
test('peers.js wires bulk owner to batch-owner using the selection', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
  assert.match(js, /act === 'owner'/);
  assert.match(js, /\/api\/v1\/peers\/batch-owner', \{ peer_ids: ids\(\)/);
  assert.match(js, /var selected = new Set\(\);/);
});
