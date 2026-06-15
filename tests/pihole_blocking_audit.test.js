'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { blockingSource } = require('../src/routes/api/piholeAudit');

test('blocking audit source prefers session user', () => {
  assert.equal(blockingSource({ session: { userId: 7 } }), 7);
});
test('blocking audit source uses peer id for peer-scoped token', () => {
  assert.equal(blockingSource({ tokenPeerId: 74, tokenId: 68 }), 'peer:74');
});
test('blocking audit source falls back to token id then api', () => {
  assert.equal(blockingSource({ tokenId: 68 }), 'token:68');
  assert.equal(blockingSource({}), 'api');
});
