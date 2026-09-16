'use strict';

// Static wiring of strand S2 (docs/feature-next-package.md §S2): the restore
// test in the backup card, the update.sh version hint in the advanced tab and
// the "derived from your plan" note of the licence hint. Templates, script
// wiring, i18n placement + GC.t whitelist, no innerHTML.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const LAYOUT = read('templates/aurora/layout.njk');
const SETTINGS_TPL = read('templates/aurora/pages/settings.njk');
const SETTINGS_JS = read('public/js/settings.js');
const OPS_JS = read('public/js/ops-ui.js');
const HINT_JS = read('public/js/license-hint.js');
const O = require('../public/js/ops-ui.js');

describe('restore test: UI wiring', () => {
  it('settings.js has a verify action per target that calls the contract endpoint', () => {
    assert.match(SETTINGS_JS, /actionButton\(t, 'verify', T\('offsite\.act_verify'/);
    assert.match(SETTINGS_JS, /window\.api\.post\(BASE \+ '\/targets\/' \+ t\.id \+ '\/verify'/);
    assert.match(SETTINGS_JS, /state\.busy\[t\.id\] = 'verify'/);
    // Licence gate like the other target actions (actionButton disables without it).
    assert.match(SETTINGS_JS, /disabled: !licensed \|\| !!busy,/);
  });

  it('the result shows date, size, counts and warnings and says nothing was changed', () => {
    assert.match(SETTINGS_JS, /lines: O\.verifyLines\(r, lang\)/);
    assert.match(SETTINGS_JS, /warnings: \(r\.warnings \|\| \[\]\)\.map\(O\.verifyWarningText\)\.filter\(Boolean\)/);
    assert.match(SETTINGS_JS, /note: T\('offsite\.verify_note'/);
    assert.match(SETTINGS_JS, /op-t-verify-facts/);
    assert.match(SETTINGS_JS, /op-t-verify-warn/);
    assert.match(SETTINGS_JS, /T\('offsite\.verify_last'|T\('offsite\.verify_never'/);
  });

  it('ops-ui: verifyLines and the warning codes', () => {
    const r = { size: 2048, created_at: '2026-09-01T10:00:00.000Z', gc_version: '1.2.3', counts: { routes: 7, peers: 3, users: 2, settings: 41 } };
    const lines = O.verifyLines(r, 'en');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /2\.0 KB/);
    assert.match(lines[2], /1\.2\.3/);
    assert.match(lines[3], /7/);
    assert.match(lines[3], /41/);
    // Missing fields simply drop out; counts are always there.
    assert.equal(O.verifyLines({ size: 10, counts: {} }, 'en').length, 2);
    assert.deepEqual(O.verifyLines(null), []);
    assert.deepEqual(O.VERIFY_WARNINGS, ['archive_old', 'no_encryption_key', 'version_differs', 'no_routes', 'no_users']);
    for (const c of O.VERIFY_WARNINGS) assert.ok(O.verifyWarningText(c), c);
    assert.equal(O.verifyWarningText('something_else'), null);
    assert.equal(O.verifyWarningText(undefined), null);
    assert.equal(O.ERROR_KEYS.NO_REMOTE_BACKUP[0], 'offsite.err.no_remote_backup');
  });
});

describe('update.sh version hint (advanced tab)', () => {
  it('the hint lives in the maintenance-window card, next to the reinstall commands', () => {
    for (const id of ['au-updatesh', 'au-updatesh-text', 'au-updatesh-show']) {
      assert.ok(SETTINGS_TPL.includes('id="' + id + '"'), id);
    }
    assert.ok(SETTINGS_TPL.indexOf('id="au-updatesh"') < SETTINGS_TPL.indexOf('id="au-reinstall"'));
    assert.match(SETTINGS_TPL, /<div id="au-updatesh" class="op-note op-note-warn op-updatesh" hidden>/);
    // Strand S3 owns the dashboard — the hint must not be put there.
    assert.doesNotMatch(read('templates/aurora/pages/dashboard.njk'), /au-updatesh/);
  });

  it('settings.js fills it from GET /system/auto-update update_sh', () => {
    assert.match(SETTINGS_JS, /var u = saved && saved\.update_sh;/);
    assert.match(SETTINGS_JS, /T\('updatesh\.mismatch'/);
    assert.match(SETTINGS_JS, /T\('updatesh\.unknown'/);
    assert.match(SETTINGS_JS, /renderUpdateSh\(\);/);
    // "Befehle zeigen" opens the reinstall block on demand — the block's own
    // visibility rule (maintenance window) stays exactly as it was.
    assert.match(SETTINGS_JS, /byId\('au-reinstall'\)\.hidden = !w\.enabled;/);
    assert.match(SETTINGS_JS, /au-updatesh-show[\s\S]{0,300}det\.hidden = false;[\s\S]{0,60}det\.open = true;/);
  });
});

describe('licence source note', () => {
  it('license-hint.js exposes sourceOf and auto-mounts data-license-source', () => {
    const src = stripComments(HINT_JS);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /querySelectorAll\('\[data-license-source\]'\)/);
    assert.match(src, /function sourceNote\(featureKey\)/);
    assert.match(src, /'license_hint\.plan_default'/);
    // The release B API stays exactly as it was.
    assert.match(src, /return Object\.assign\(pure, \{ render, mount, mountAll, load, refresh \}\)/);
  });

  it('the off-site card carries the slot for scheduled_backups', () => {
    assert.match(SETTINGS_TPL, /<div id="offsite-plan-default" data-license-source="scheduled_backups"><\/div>/);
  });

  it('security.css styles the note and stays balanced', () => {
    const css = read('public/css/security.css');
    assert.match(css, /\.lh-src \{/);
    assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
    const ops = read('public/css/ops.css');
    assert.match(ops, /\.op-updatesh \{/);
    assert.match(ops, /\.op-t-verify-facts \{/);
    assert.equal((ops.match(/\{/g) || []).length, (ops.match(/\}/g) || []).length);
    assert.doesNotMatch(read('public/css/aurora.css'), /\.op-t-verify|\.op-updatesh|\.lh-src/);
  });
});

describe('i18n', () => {
  const OWN = /^(offsite\.(verify_|act_verify|err\.no_remote_backup)|updatesh\.|license_hint\.plan_default|security\.check\.backup_offsite\.fail_verify)/;
  const pick = (o) => Object.keys(o).filter((k) => OWN.test(k));

  it('de and en carry the same new keys with the same {placeholders}', () => {
    assert.deepEqual(pick(de).sort(), pick(en).sort());
    assert.ok(pick(de).length >= 22, 'keys: ' + pick(de).length);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.ok(de[k] && en[k], k);
      assert.equal(ph(de[k]), ph(en[k]), k);
    }
  });

  it('every new key is whitelisted in the layout GC.t block and none sits at the file end', () => {
    for (const k of pick(de)) assert.ok(LAYOUT.includes("'" + k + "'"), 'GC.t whitelist ' + k);
    for (const [n, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      assert.match(keys[keys.length - 1], /^waf\./, n + ': the waf.* block stays the tail');
      // offsite.verify_* inside the offsite.* block, updatesh.* after whatsnew.*
      const firstVerify = keys.findIndex((k) => k === 'offsite.act_verify');
      assert.ok(keys[firstVerify - 1].startsWith('offsite.'), n + ': verify keys inside the offsite block');
      const firstUpdatesh = keys.findIndex((k) => k.startsWith('updatesh.'));
      assert.ok(keys[firstUpdatesh - 1].startsWith('whatsnew.'), n + ': updatesh.* after the whats-new block');
      const idx = keys.map((k, i) => (k.startsWith('updatesh.') ? i : -1)).filter((i) => i >= 0);
      assert.equal(idx[idx.length - 1] - idx[0] + 1, idx.length, n + ': updatesh.* is one contiguous block');
    }
  });

  it('settings.njk renders with the new hooks', () => {
    const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
    env.addFilter('bytes', (v) => String(v || 0) + ' B');
    env.addFilter('reltime', () => '—');
    env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
    const t = (key) => (de[key] !== undefined ? de[key] : key);
    const license = { plan: 'pro', features: { scheduled_backups: true, http_routes: -1, l4_routes: -1, pihole: { available: true } }, hasFeature: () => true, isWithinLimit: () => true };
    const html = env.render('aurora/pages/settings.njk', {
      theme: 'aurora', language: 'de', t, availableLanguages: ['de', 'en'], cspNonce: 'N', csrfToken: 'c',
      appVersion: '9.9.9', appName: 'GateControl', baseUrl: 'https://gc.example.com',
      user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin' }, flash: {}, title: 'x',
      license, activeNav: 'settings', currentPath: '/settings',
    });
    assert.ok(html.includes('data-license-source="scheduled_backups"'));
    assert.ok(html.includes('id="au-updatesh"'));
    assert.ok(html.includes(de['updatesh.show']));
    assert.doesNotMatch(html, /\{\{\s*t\(|\{%/, 'no unrendered tags');
  });
});
