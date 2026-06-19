'use strict';

// Regression guard for the scan/loading progress indicators.
//
// Root cause of the "indicator never visible" bug: the CSS was injected at
// runtime via document.createElement('style'). The app's CSP sets
// styleSrcElem with a nonce requirement and NO 'unsafe-inline', so a
// nonce-less injected <style> is blocked — the .gw-progress / gw-spin rules
// never applied. The fix moves the rules into the linked stylesheets
// (app.css + pro.css, served from 'self', CSP-allowed). These tests assert
// that arrangement so the regression cannot silently return.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

describe('gateways progress indicator CSS (CSP-safe)', () => {
  it('gateways.js must NOT inject a <style> element at runtime (CSP would block it)', () => {
    const js = read('js/gateways.js');
    assert.ok(
      !/createElement\(\s*['"]style['"]\s*\)/.test(js),
      'gateways.js injects a <style> element — CSP (styleSrcElem nonce, no unsafe-inline) blocks it'
    );
  });

  for (const css of ['css/app.css', 'css/pro.css']) {
    it(`${css} defines the spin + progress keyframes and .gw-progress`, () => {
      const c = read(css);
      assert.match(c, /@keyframes\s+gw-spin\b/, `${css} missing @keyframes gw-spin`);
      assert.match(c, /@keyframes\s+gw-progress-slide\b/, `${css} missing @keyframes gw-progress-slide`);
      assert.match(c, /\.gw-progress\b/, `${css} missing .gw-progress rule`);
      assert.match(c, /\.gw-progress::before\b/, `${css} missing .gw-progress::before rule`);
    });
  }
});
