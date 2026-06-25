'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
test('owner selects exist in add+edit peer partials (3 themes)', () => {
  for (const theme of ['aurora', 'default', 'pro']) {
    const add = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'partials', 'modals', 'peer-add.njk'), 'utf8');
    const edit = fs.readFileSync(path.join(__dirname, '..', 'templates', theme, 'partials', 'modals', 'peer-edit.njk'), 'utf8');
    assert.ok(add.includes('add-peer-owner'), `${theme} add`);
    assert.ok(edit.includes('edit-peer-owner'), `${theme} edit`);
  }
});
test('peers.js loads users and sends user_id', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
  assert.ok(/add-peer-owner|edit-peer-owner/.test(js));
  assert.ok(/\/api\/v1\/users/.test(js));
  assert.ok(/user_id/.test(js));
});
