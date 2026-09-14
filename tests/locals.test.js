'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let injectLocals;

before(async () => {
  await setup();   // initializes the DB the badge-count queries read
  ({ injectLocals } = require('../src/middleware/locals'));
});
after(() => teardown());

function run(req, res) {
  return new Promise((resolve, reject) => {
    injectLocals(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

describe('injectLocals — flash handling does not pollute sessions', () => {
  test('anon visitor with no prior flash leaves session.flash unset', async () => {
    const session = {};
    const res = { locals: {} };
    await run({ session, path: '/' }, res);
    assert.equal(session.flash, undefined,
      'must not assign session.flash for first-time anon visitors — ' +
      'unconditional `req.session.flash = {}` was the second-source ' +
      'of bot-driven sessions-table pollution');
    assert.deepEqual(res.locals.flash, {},
      'locals.flash still surfaced as empty object for templates');
  });

  test('existing flash gets consumed (read into locals, cleared in session)', async () => {
    const session = { flash: { error: 'boom' } };
    const res = { locals: {} };
    await run({ session, path: '/' }, res);
    assert.deepEqual(res.locals.flash, { error: 'boom' });
    assert.deepEqual(session.flash, {}, 'consumed flash is cleared');
  });

  test('no session at all — middleware does not crash and skips flash', async () => {
    const res = { locals: {} };
    await run({ session: undefined, path: '/' }, res);
    assert.equal(res.locals.flash, undefined);
  });
});

describe('injectLocals — Aurora is the only theme', () => {
  test('theme is aurora for anon visitors, whatever default_theme says', async () => {
    const settings = require('../src/services/settings');
    for (const stored of ['default', 'pro', 'aurora', 'bogus']) {
      settings.set('default_theme', stored);
      const res = { locals: {} };
      await run({ session: {}, path: '/login' }, res);
      assert.equal(res.locals.theme, 'aurora', `default_theme=${stored}`);
    }
  });

  test('a stored personal users.theme does not change the theme', async () => {
    const { getDb } = require('../src/db/connection');
    const admin = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get();
    getDb().prepare("UPDATE users SET theme = 'pro' WHERE id = ?").run(admin.id);
    const res = { locals: {} };
    await run({ session: { userId: admin.id }, path: '/dashboard' }, res);
    assert.equal(res.locals.user.id, admin.id);
    assert.equal(res.locals.theme, 'aurora');
  });
});
