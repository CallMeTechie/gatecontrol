'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { canAccessRoute } = require('../src/services/rdpAcl');

describe('rdpAcl: canAccessRoute', () => {
  it('returns false when route is null/undefined', () => {
    assert.equal(canAccessRoute(null, 1, 1), false);
    assert.equal(canAccessRoute(undefined, 1, 1), false);
  });

  it('grants access when no restrictions are configured', () => {
    assert.equal(canAccessRoute({}, 1, 1), true);
    assert.equal(canAccessRoute({ user_ids: null, token_ids: null }, 1, 1), true);
  });

  it('user_ids takes priority over token_ids', () => {
    const route = {
      user_ids: JSON.stringify([42]),
      token_ids: JSON.stringify([1, 2, 3]), // generous token list
    };
    // user 42 listed → allowed
    assert.equal(canAccessRoute(route, 1, 42), true);
    // user 99 not listed → denied even though token 1 IS listed
    assert.equal(canAccessRoute(route, 1, 99), false);
  });

  it('user_ids: missing userId means denied', () => {
    const route = { user_ids: JSON.stringify([42]) };
    assert.equal(canAccessRoute(route, 1, null), false);
    assert.equal(canAccessRoute(route, 1, undefined), false);
  });

  it('falls through to token_ids when user_ids is empty array (no users restricted)', () => {
    // [] means "no user restriction in effect" — fall through to token check.
    const route = {
      user_ids: JSON.stringify([]),
      token_ids: JSON.stringify([5]),
    };
    assert.equal(canAccessRoute(route, 5, 99), true);
    assert.equal(canAccessRoute(route, 6, 99), false);
  });

  it('token_ids: matching token grants access', () => {
    const route = { token_ids: JSON.stringify([5, 7]) };
    assert.equal(canAccessRoute(route, 5, null), true);
    assert.equal(canAccessRoute(route, 7, null), true);
    assert.equal(canAccessRoute(route, 6, null), false);
  });

  it('token_ids: missing tokenId means denied', () => {
    const route = { token_ids: JSON.stringify([5]) };
    assert.equal(canAccessRoute(route, null, null), false);
  });

  it('malformed JSON in user_ids/token_ids falls through to "no restriction"', () => {
    // Defensive: a corrupted column should not lock everyone out — same
    // contract as the pre-refactor inline code.
    assert.equal(canAccessRoute({ user_ids: 'not-json' }, 1, 1), true);
    assert.equal(canAccessRoute({ token_ids: 'not-json' }, 1, 1), true);
  });

  it('non-array JSON in user_ids/token_ids falls through to "no restriction"', () => {
    assert.equal(canAccessRoute({ user_ids: '"a string"' }, 1, 1), true);
    assert.equal(canAccessRoute({ token_ids: '{}' }, 1, 1), true);
  });
});
