'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/js/settingsAutosaveCore');

test('classify returns config or independent default', () => {
  assert.equal(core.classify('pihole').klass, 'fullPayload');
  assert.equal(core.classify('smtp').klass, 'atomic');
  assert.equal(core.classify('unknown').klass, 'independent');
});

test('isDirty compares payload to snapshot', () => {
  assert.equal(core.isDirty({ a: 1 }, { a: 1 }), false);
  assert.equal(core.isDirty({ a: 1 }, { a: 2 }), true);
});

test('stripEmptySecrets removes only empty/null secret keys', () => {
  assert.deepEqual(core.stripEmptySecrets({ api_key: '', enabled: true }, ['api_key']), { enabled: true });
  assert.deepEqual(core.stripEmptySecrets({ api_key: 'k' }, ['api_key']), { api_key: 'k' });
  assert.deepEqual(core.stripEmptySecrets({ password: null }, ['password']), {});
});

test('needsConfirm: mb-mode always, lockout-attempts only when <=2', () => {
  assert.equal(core.needsConfirm(core.classify('machine-binding'), 'mb-mode', 'individual'), true);
  assert.equal(core.needsConfirm(core.classify('security'), 'security-lockout-attempts', '1'), true);
  assert.equal(core.needsConfirm(core.classify('security'), 'security-lockout-attempts', '5'), false);
  assert.equal(core.needsConfirm(core.classify('security'), 'security-lockout-enabled', 'on'), false);
});

test('isAtomicReady: independent always ready; atomic uses config or override', () => {
  assert.equal(core.isAtomicReady(core.classify('metrics'), {}), true);
  const smtp = core.classify('smtp');
  assert.equal(core.isAtomicReady(smtp, { 'smtp-host': '', 'smtp-from': '' }), false);
  assert.equal(core.isAtomicReady(smtp, { 'smtp-host': 'm', 'smtp-from': 'a@x' }), true);
  // Override: alerts with no active events -> email NOT required.
  assert.equal(core.isAtomicReady(core.classify('alerts'), { 'alerts-email': '' }, []), true);
  assert.equal(core.isAtomicReady(core.classify('alerts'), { 'alerts-email': '' }, ['alerts-email']), false);
});

test('createQueue serializes per key in call order', async () => {
  const enqueue = core.createQueue();
  const order = [];
  const p1 = enqueue('k', async () => { await Promise.resolve(); order.push('a'); });
  const p2 = enqueue('k', async () => { order.push('b'); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a', 'b']);
});

test('createQueue continues after a rejected task', async () => {
  const enqueue = core.createQueue();
  const order = [];
  await enqueue('k', async () => { throw new Error('boom'); }).catch(() => {});
  await enqueue('k', async () => { order.push('next'); });
  assert.deepEqual(order, ['next']);
});

test('missingValueKeys returns [] when all fields covered, missing ids when not', () => {
  assert.deepEqual(core.missingValueKeys(['a', 'b'], { a: 1, b: 2 }), []);
  assert.deepEqual(core.missingValueKeys(['a', 'b', 'c'], { a: 1, b: 2 }), ['c']);
  assert.deepEqual(core.missingValueKeys([], { a: 1 }), []);
  // Empty-string ids are ignored (elements without id attribute)
  assert.deepEqual(core.missingValueKeys(['', 'a'], { a: 1 }), []);
  // Null/undefined guards
  assert.deepEqual(core.missingValueKeys(null, { a: 1 }), []);
  assert.deepEqual(core.missingValueKeys(['a'], null), ['a']);
});
