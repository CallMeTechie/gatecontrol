'use strict';

// Template rendering of the 2FA surfaces (Aurora, the only theme) + i18n
// parity of the two_fa.* block.

const cryptoEnv = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || cryptoEnv.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)
let app, agent, csrf;
beforeEach(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
afterEach(teardown);

test('two_fa.* keys exist in de and en with identical key sets, inserted as one block', () => {
  const de = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/i18n/de.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/i18n/en.json'), 'utf8'));
  const deKeys = Object.keys(de).filter((k) => k.startsWith('two_fa.'));
  const enKeys = Object.keys(en).filter((k) => k.startsWith('two_fa.'));
  assert.ok(deKeys.length >= 40);
  assert.deepEqual(deKeys, enKeys);
  for (const k of ['two_fa.login_title', 'two_fa.use_recovery', 'two_fa.error_expired', 'two_fa.settings_require', 'two_fa.users_reset']) {
    assert.ok(de[k] && en[k], k);
  }
  // contiguous block
  const all = Object.keys(de);
  const first = all.indexOf(deKeys[0]);
  assert.deepEqual(all.slice(first, first + deKeys.length), deKeys);
});

test('/login/2fa renders (code and recovery variants)', async () => {
  const adminTwoFactor = require('../src/services/adminTwoFactor');
  const { getDb } = require('../src/db/connection');
  // enable 2FA on admin directly so the password step leaves a pending marker
  const admin = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get();
  adminTwoFactor.beginSetup(admin.id);
  getDb().prepare("UPDATE users SET totp_enabled = 1, totp_confirmed_at = datetime('now') WHERE id = ?").run(admin.id);

  for (const theme of THEMES) {
    const a = supertest.agent(app);
    const page = await a.get('/login').expect(200);
    const loginCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const res = await a.post('/login').type('form').send({ username: 'admin', password: 'TestPass123!', _csrf: loginCsrf }).expect(302);
    assert.equal(res.headers.location, '/login/2fa');

    const code = await a.get('/login/2fa').expect(200);
    assert.match(code.text, /action="\/login\/2fa"/, theme);
    assert.match(code.text, /name="code"[^>]*inputmode="numeric"/, theme);
    assert.match(code.text, /autofocus/, theme);
    assert.match(code.text, /href="\/login\/2fa\?recovery=1"/, theme);
    assert.match(code.text, /id="tf-remaining"[^>]*>[^<{]*\d[^<{]*</, theme);
    assert.doesNotMatch(code.text, /replace\('',/, `${theme}: countdown placeholder must survive templating`);
    // One stylesheet since wave 2 (docs/feature-wave2.md): app.css, nothing else.
    assert.match(code.text, /\/css\/app\.css/, theme);
    for (const gone of ['pro.css', 'aurora.css', 'two-factor.css']) {
      assert.doesNotMatch(code.text, new RegExp(gone.replace('.', '\\.')), `${theme}: ${gone}`);
    }

    const rec = await a.get('/login/2fa?recovery=1').expect(200);
    assert.match(rec.text, /name="recovery_code"/, theme);
    assert.doesNotMatch(rec.text, /name="code"/, theme);
    assert.match(rec.text, /href="\/login\/2fa"/, theme);
  }
});

test('profile card, users modal row and settings toggle render', async () => {
  for (const theme of THEMES) {
    const profile = await agent.get('/profile').expect(200);
    assert.match(profile.text, /id="tf-card"[^>]*data-enabled="0"/, theme);
    for (const id of ['tf-btn-setup', 'tf-qr', 'tf-secret', 'tf-confirm-code', 'tf-btn-confirm', 'tf-codes', 'tf-btn-download-codes', 'tf-btn-regenerate', 'tf-btn-disable', 'tf-i18n']) {
      assert.match(profile.text, new RegExp(`id="${id}"`), `${theme}: ${id}`);
    }
    assert.match(profile.text, /\/js\/vendor\/qrcode\.min\.js/, theme);
    assert.match(profile.text, /\/js\/profile-2fa\.js/, theme);
    const setup = await agent.get('/profile?setup2fa=1').expect(200);
    assert.match(setup.text, /id="tf-card"[^>]*data-setup="1"/, theme);

    const users = await agent.get('/users').expect(200);
    assert.match(users.text, /id="user-2fa-section"/, theme);
    assert.match(users.text, /id="btn-user-2fa-reset"/, theme);
    assert.match(users.text, /id="tf-users-i18n"/, theme);

    const settingsPage = await agent.get('/settings').expect(200);
    assert.match(settingsPage.text, /id="security-require-2fa"[^>]*data-self-2fa="0"/, theme);
    assert.match(settingsPage.text, /id="security-require-2fa-warning"/, theme);
  }
});

test('profile card reflects an enabled 2FA server-side', async () => {
  const { getDb } = require('../src/db/connection');
  getDb().prepare("UPDATE users SET totp_enabled = 1 WHERE username = 'admin'").run();
  const profile = await agent.get('/profile').expect(200);
  assert.match(profile.text, /id="tf-card"[^>]*data-enabled="1"/);
  const settingsPage = await agent.get('/settings').expect(200);
  assert.match(settingsPage.text, /data-self-2fa="1"/);
});
