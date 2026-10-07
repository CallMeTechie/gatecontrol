'use strict';

// Settings → Lizenz card: plan expiry, "updates until" and whether the
// licence was verified via the signed v2 path or the legacy v1 path.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

let agent, license;

before(async () => {
  await setup();
  agent = getAgent();
  license = require('../src/services/license');
});
after(() => { license._applyLicenseForTest(null); teardown(); });

function card(html) {
  const a = html.indexOf('class="st-plan-text"');
  return html.slice(a, html.indexOf('</section>', a));
}

test('a signed v2 licence shows expiry, updates-until and the signed line', async () => {
  license._applyLicenseForTest({
    plan: 'pro-monthly', features: { webhooks: true },
    expires_at: '2027-03-31T00:00:00.000Z', updates_until: '2028-01-15T00:00:00.000Z', verification: 'signed',
  });
  const c = card(withoutScripts((await agent.get('/settings').expect(200)).text));
  assert.ok(c.includes('31.03.2027') || c.includes('2027-03-31'), c);
  assert.ok(c.includes('Updates bis 15.01.2028') || c.includes('updates until 2028-01-15'), c);
  assert.match(c, /data-verification="signed"/);
  assert.ok(c.includes('Lizenzserver v2') || c.includes('license server v2'), c);
  assert.ok(c.includes('Pro Monthly'), 'unknown plan slug gets a readable label');
  assert.doesNotMatch(c, /st\.lic\.[a-z_]+|license\.plan_/, 'no raw i18n keys');
});

test('a legacy licence says so and shows no updates line', async () => {
  license._applyLicenseForTest({ plan: 'pro', features: { webhooks: true } });
  const c = card(withoutScripts((await agent.get('/settings').expect(200)).text));
  assert.match(c, /data-verification="legacy"/);
  assert.ok(!c.includes('Updates bis') && !c.includes('updates until'));
  assert.doesNotMatch(c, /st\.lic\.[a-z_]+/);
});

test('community mode shows no verification line', async () => {
  license._applyLicenseForTest(null);
  const html = withoutScripts((await agent.get('/settings').expect(200)).text);
  assert.doesNotMatch(html, /id="st-lic-verify"/);
});
