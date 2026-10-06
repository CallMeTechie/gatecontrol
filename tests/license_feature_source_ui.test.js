'use strict';

// Settings → Lizenz: features a paid plan only derives (the token does not
// name them) are marked "automatisch", with a count above the list — so an
// admin can tell them from features the licence actually grants.

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

function item(html, key) {
  const m = html.match(new RegExp('<li class="st-feature"[^>]*data-key="' + key + '"[^>]*>[\\s\\S]*?</li>'));
  return m ? m[0] : null;
}

test('a paid plan without machine_binding in the token shows it as automatic', async () => {
  license._applyLicenseForTest({ plan: 'pro', features: { webhooks: true, waf: false, vpn_peers: 10 } });
  const res = await agent.get('/settings').expect(200);
  const html = withoutScripts(res.text);

  const mb = item(html, 'machine_binding');
  assert.ok(mb, 'machine_binding listed');
  assert.match(mb, /data-src="plan_default"/);
  assert.match(mb, /data-on="1"/);
  assert.ok(mb.includes('enthalten (automatisch)') || mb.includes('included (automatic)'), mb);

  const wh = item(html, 'webhooks');
  assert.match(wh, /data-src="token"/);
  assert.ok(!wh.includes('automati'), 'token-granted feature is not marked automatic');

  const waf = item(html, 'waf');
  assert.match(waf, /data-on="0"/);
  assert.ok(!waf.includes('automati'));

  assert.match(html, /id="st-lic-derived-note"/);
  assert.doesNotMatch(html, /st\.lic\.[a-z_]+/, 'no raw i18n keys');
});

test('a token that names every boolean feature shows no automatic marker or note', async () => {
  const features = {};
  for (const [k, v] of Object.entries(license.COMMUNITY_FALLBACK)) features[k] = typeof v === 'boolean' ? true : v;
  license._applyLicenseForTest({ plan: 'pro', features });
  const html = withoutScripts((await agent.get('/settings').expect(200)).text);
  assert.doesNotMatch(html, /id="st-lic-derived-note"/);
  assert.doesNotMatch(html, /data-src="plan_default"/);
});

test('community mode shows no automatic marker', async () => {
  license._applyLicenseForTest(null);
  const html = withoutScripts((await agent.get('/settings').expect(200)).text);
  assert.doesNotMatch(html, /id="st-lic-derived-note"/);
  assert.doesNotMatch(html, /enthalten \(automatisch\)|included \(automatic\)/);
});

test('a paid plan does not claim community mode and shows the expiry date', async () => {
  license._applyLicenseForTest({ plan: 'pro', features: { webhooks: true }, expires_at: '2027-03-31T00:00:00.000Z' });
  const html = withoutScripts((await agent.get('/settings').expect(200)).text);
  const a = html.indexOf('class="st-plan-meta"');
  const meta = html.slice(a, html.indexOf('</div>', a));
  assert.doesNotMatch(meta, /Community/i);
  assert.ok(meta.includes('31.03.2027') || meta.includes('2027-03-31'), meta);
});
