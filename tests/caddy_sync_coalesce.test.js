'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('requestCaddySync coalesces concurrent calls into one syncToCaddy', async () => {
  const routes = require('../src/services/routes');
  let calls = 0; const orig = routes.syncToCaddy;
  routes.syncToCaddy = async () => { calls++; };
  try {
    const { requestCaddySync } = require('../src/services/caddySync');
    await Promise.all([requestCaddySync(), requestCaddySync(), requestCaddySync()]);
    assert.equal(calls, 1);
  } finally { routes.syncToCaddy = orig; }
});
