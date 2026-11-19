'use strict';

// The browser scenarios open an address with ctx.loadFresh (tests/e2e/run.js),
// never with page.goto(<the open page>#hash) followed by page.reload().
//
// Why: when the page changes its own address right then (history.replaceState —
// e.g. the gateway assistant clears #setup/<id> just after Escape), Chromium can
// apply that change after the hash navigation of the test. The browser then
// keeps the address without the hash while the page shows the hash, and the
// reload loads the address without it: the overview instead of #gw/<id>
// (gatewaywizard, CI runs 43863311002 and 44508800779; reproduced locally in
// 2 of 80 tries with the real app and in 19 of 400 with a bare page, 0 of 400
// with about:blank + a full load).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'e2e', 'scenarios');
// goto(… # …) — then, with only comments in between, page.reload()
const HASH_THEN_RELOAD = /\.goto\(([^;\n]*#[^;\n]*)\);\s*(?:\/\/[^\n]*\n\s*)*await\s+page\.reload\(\)/g;

test('no scenario goes to a hash and reloads — it uses loadFresh', () => {
  const found = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of src.matchAll(HASH_THEN_RELOAD)) {
      found.push(`${f}:${src.slice(0, m.index).split('\n').length} goto(${m[1]}) + reload()`);
    }
  }
  assert.deepEqual(found, []);
});

test('the pattern is recognised (the check itself)', () => {
  const src = "await page.goto(`${BASE}/gateways#gw/${GW}/features`);\n        // a comment\n        await page.reload();";
  assert.equal([...src.matchAll(HASH_THEN_RELOAD)].length, 1);
  assert.equal([..."await page.goto(BASE + '/dashboard');\n await page.reload();".matchAll(HASH_THEN_RELOAD)].length, 0);
});

test('loadFresh is a full load: about:blank, then the address', () => {
  const src = fs.readFileSync(path.join(__dirname, 'e2e', 'run.js'), 'utf8');
  assert.match(src, /async loadFresh\(page, url\) \{\s*await page\.goto\('about:blank'\);\s*return page\.goto\(url\);\s*\}/);
});
