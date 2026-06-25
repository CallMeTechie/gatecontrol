'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('bulk owner control in batch bar (3 themes)', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'pages', 'peers.njk'), 'utf8');
    ['peer-bulk-owner', 'peer-bulk-owner-apply'].forEach(id => assert.ok(html.includes(id), `${theme}: ${id}`));
  }
});
test('peers.js wires bulk owner to batch-owner using batchSelected', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
  assert.ok(/peer-bulk-owner/.test(js));
  assert.ok(/batch-owner/.test(js));
  assert.ok(/batchSelected/.test(js));
});
