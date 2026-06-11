'use strict';

// extractRedirect recovers the full original URI from the raw request URL.
// Caddy appends it verbatim as the last query param, so Express' parsed
// req.query.redirect truncates multi-parameter URLs at the first '&'. These
// tests lock in the recovery plus safeRedirect's open-redirect guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractRedirect, safeRedirect } = require('../src/routes/routeAuth');

function req(originalUrl, query = {}) {
  return { originalUrl, query };
}

test('recovers a multi-parameter URI that Express would truncate', () => {
  const r = req('/route-auth/login?route=app.example.com&redirect=/page?a=1&b=2',
    { route: 'app.example.com', redirect: '/page?a=1' });
  assert.equal(extractRedirect(r), '/page?a=1&b=2');
});

test('single-parameter URI is preserved', () => {
  const r = req('/route-auth/login?route=app.example.com&redirect=/page?tab=x',
    { route: 'app.example.com', redirect: '/page?tab=x' });
  assert.equal(extractRedirect(r), '/page?tab=x');
});

test('no redirect marker falls back to parsed query value', () => {
  const r = req('/route-auth/login?route=app.example.com', { route: 'app.example.com' });
  assert.equal(extractRedirect(r), undefined);
});

test('safeRedirect still blocks open redirects from the recovered value', () => {
  const r = req('/route-auth/login?redirect=//evil.example.com/x', { redirect: '//evil.example.com/x' });
  assert.equal(safeRedirect(extractRedirect(r)), '/');
});

test('safeRedirect blocks scheme-prefixed targets', () => {
  const r = req('/route-auth/login?redirect=https://evil.example.com', { redirect: 'https://evil.example.com' });
  assert.equal(safeRedirect(extractRedirect(r)), '/');
});

test('recovered relative multi-param path passes safeRedirect intact', () => {
  const r = req('/route-auth/login?route=x&redirect=/dash?a=1&b=2&c=3', {});
  assert.equal(safeRedirect(extractRedirect(r)), '/dash?a=1&b=2&c=3');
});
