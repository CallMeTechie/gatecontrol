'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { injectLocals } = require('../src/middleware/locals');

function run(req, res) {
  return new Promise((resolve, reject) => {
    injectLocals(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

describe('injectLocals — flash handling does not pollute sessions', () => {
  test('anon visitor with no prior flash leaves session.flash unset', async () => {
    // Anon path: no userId → DB queries are skipped, only the static
    // template locals + flash branch run. This is the bug surface.
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
