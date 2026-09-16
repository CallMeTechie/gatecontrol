'use strict';

// Wave 2, W1 (docs/feature-wave2.md §W1.1, §W1.2, §W1.4): the user interface
// speaks the user's language and uses its own dialogs.
//
//   1. No browser dialog left in public/js/**. confirm()/alert()/prompt()
//      cannot be translated or styled and block the page — the replacement is
//      public/js/gc-dialog.js (window.GCDialog) resp. the portal's own
//      portalConfirm().
//   2. Every translation key a page script asks for exists in de.json AND
//      en.json, and is actually delivered to the browser: either through the
//      window.GC.t whitelist in templates/aurora/layout.njk or through the JSON
//      i18n island of the page that loads the script. A key that reaches
//      neither renders in English (the autobackup.* case of §W1.1).
//
// The delivery sets are derived from the templates, not hard-coded, so a new
// page or a new island is covered without touching this test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public/js');
const PAGES_DIR = path.join(ROOT, 'templates/aurora/pages');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readAbs = (p) => fs.readFileSync(p, 'utf8');

// Comments and line comments out; string contents kept (keys live in strings).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();

// ─── 1. no browser dialogs ──────────────────────────────────────────────────

describe('W1: no browser dialogs in public/js/**', () => {
  // A bare call (`confirm(`) or an explicit `window.confirm(`. A call on any
  // other object (GCDialog.confirm(), D.alert(), confirmDialog()) is fine.
  const BARE = /(?<![.\w$])(confirm|alert|prompt)\s*\(/g;
  const VIA_WINDOW = /\bwindow\s*\.\s*(confirm|alert|prompt)\s*\(/g;

  it('no confirm(), alert() or prompt() is called anywhere', () => {
    const hits = [];
    for (const f of jsFiles) {
      const src = stripComments(readAbs(path.join(JS_DIR, f)));
      src.split('\n').forEach((line, i) => {
        BARE.lastIndex = 0;
        VIA_WINDOW.lastIndex = 0;
        if (BARE.test(line) || VIA_WINDOW.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(hits, [], 'use window.GCDialog (public/js/gc-dialog.js) instead');
  });

  it('the replacement is loaded on every admin page and offers the three dialogs', () => {
    const layout = read('templates/aurora/layout.njk');
    assert.match(layout, /<script src="\/js\/gc-dialog\.js/, 'layout.njk loads gc-dialog.js');
    assert.ok(layout.indexOf('/js/gc-dialog.js') < layout.indexOf('/js/app.js'), 'before the page scripts');
    const src = read('public/js/gc-dialog.js');
    assert.match(src, /root\.GCDialog = \{/);
    for (const fn of ['confirm: confirmDialog', 'alert: alertDialog', 'prompt: promptDialog']) {
      assert.ok(src.includes(fn), fn);
    }
    // Reuses the zones dialog markup, so W2's stylesheet work stays untouched.
    assert.match(src, /modal-overlay zn-dialog/);
    assert.ok(!/innerHTML/.test(stripComments(src)), 'no innerHTML');
    // Destructive actions get the red button.
    assert.match(src, /o\.danger \? 'btn-danger' : 'btn-primary'/);
  });

  it('every destructive confirmation asks with the danger button', () => {
    // Deleting, revoking, restoring, resetting: danger: true on the dialog.
    const DESTRUCTIVE = [
      ['public/js/settings.js', ['settings.confirm_clear_logs', 'settings.confirm_delete_webhook',
        'settings.restore_warning', 'autobackup.confirm_delete', 'license.remove_confirm', 'pihole.cfg.confirm_delete']],
      ['public/js/users.js', ['users.confirm_delete', 'users.confirm_disable', 'users.token_revoke_confirm']],
      ['public/js/rdp.js', ['rdp.confirm_delete', 'rdp.confirm_disconnect_all']],
      ['public/js/peers.js', ['peer_groups.confirm_delete', 'gateway_download_confirm']],
      ['public/js/smarthome-rules.js', ['smarthome.rules.confirm_delete']],
      ['public/js/tags-admin.js', ['tags.confirm_delete']],
      ['public/js/peer-groups-admin.js', ['peer_groups.confirm_delete']],
      ['public/js/gatewayPools.js', ['gateway_pools.confirm_delete']],
      ['public/js/gateways.js', ['egress.delete_confirm']],
    ];
    for (const [file, keys] of DESTRUCTIVE) {
      const src = read(file);
      for (const key of keys) {
        const i = src.indexOf(key);
        assert.ok(i > 0, `${file}: ${key} used`);
        const call = src.slice(Math.max(0, i - 200), i + 300);
        assert.match(call, /danger: true/, `${file}: ${key} confirms with the danger button`);
      }
    }
  });
});

// ─── 2. every key reaches the browser ───────────────────────────────────────

// Keys from `'some.key': {{ t('some.key') | dump }}` and from
// `{%- for k in [ 'a', 'b' ] %}` lists.
function njkKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/'([^']+)':\s*\{\{\s*t\(/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\[[^[\]]*\]/g)) {
    // only lists that feed t() — every list of quoted dotted keys qualifies
    for (const k of m[0].matchAll(/'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g)) keys.add(k[1]);
  }
  return keys;
}

const whitelist = njkKeys(read('templates/aurora/layout.njk'));

// page file → { scripts, islandKeys }
function pageInfo(file) {
  let src = readAbs(path.join(PAGES_DIR, file));
  for (const m of src.matchAll(/\{%\s*include\s+"([^"]+)"\s*%\}/g)) {
    const inc = path.join(ROOT, 'templates', m[1]);
    if (fs.existsSync(inc)) src += '\n' + readAbs(inc);
  }
  const scripts = new Set();
  for (const m of src.matchAll(/\/js\/([A-Za-z0-9_.-]+\.js)/g)) scripts.add(m[1]);
  // An i18n island only counts when the page really renders one.
  const islandKeys = /type="application\/json" id="[a-z-]*i18n"/.test(src) ? njkKeys(src) : new Set();
  return { scripts, islandKeys };
}

const pages = fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.njk')).map(pageInfo);
const globalScripts = new Set();
for (const m of read('templates/aurora/layout.njk').matchAll(/\/js\/([A-Za-z0-9_.-]+\.js)/g)) globalScripts.add(m[1]);

// script file → the keys the browser has where that script runs (whitelist plus
// the islands of every page that loads it; a script on two pages must work on
// both, so the intersection of the pages' island sets is what it may rely on).
function deliveredTo(file) {
  if (globalScripts.has(file)) return whitelist;
  const loading = pages.filter((p) => p.scripts.has(file));
  if (!loading.length) return null; // not loaded by an Aurora page (portal, route-auth …)
  let islands = null;
  for (const p of loading) {
    if (islands === null) islands = new Set(p.islandKeys);
    else islands = new Set([...islands].filter((k) => p.islandKeys.has(k)));
  }
  return new Set([...whitelist, ...islands]);
}

// Keys a script asks for. `t('foo.' + x)` is a dynamic prefix, not a key.
function usedKeys(src) {
  const keys = new Set();
  const prefixes = new Set();
  // t('k'), obj.t('k') (GCDialog, the page kits), T('k'), tr('k'), DT('k').
  const KEY_RE = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
  for (const re of [/GC\.t\[\s*['"]([^'"]+)['"]\s*\]/g, /(?<![\w$])t\(\s*['"]([^'"]+)['"]/g,
    /(?<![\w$])[A-Za-z_$][\w$]*\.t\(\s*['"]([^'"]+)['"]/g,
    /(?<![\w$])T\(\s*['"]([^'"]+)['"]/g, /(?<![\w$])tr\(\s*['"]([^'"]+)['"]/g, /(?<![\w$])DT\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) if (KEY_RE.test(m[1])) keys.add(m[1]);
  }
  for (const re of [/\bt\(\s*['"]([^'"]+)['"]\s*\+/g, /\bT\(\s*['"]([^'"]+)['"]\s*\+/g]) {
    for (const m of src.matchAll(re)) prefixes.add(m[1]);
  }
  for (const p of prefixes) keys.delete(p);
  return keys;
}

describe('W1: every key the page scripts ask for reaches the user', () => {
  const used = new Map();
  for (const f of jsFiles) used.set(f, usedKeys(readAbs(path.join(JS_DIR, f))));

  it('exists in de.json and en.json', () => {
    const missing = [];
    for (const [f, keys] of used) {
      for (const k of keys) {
        if (!(k in de)) missing.push(`${f}: de.json is missing ${k}`);
        if (!(k in en)) missing.push(`${f}: en.json is missing ${k}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('is delivered to the browser (layout whitelist or the page island)', () => {
    const missing = [];
    for (const [f, keys] of used) {
      const delivered = deliveredTo(f);
      if (!delivered) continue; // not an Aurora page script
      for (const k of keys) if (!delivered.has(k)) missing.push(`${f}: ${k}`);
    }
    assert.deepEqual(missing, [], 'add the key to the whitelist in layout.njk or to the page island');
  });

  it('German and English use the same placeholders', () => {
    const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join();
    for (const [, keys] of used) {
      for (const k of keys) {
        if (!(k in de) || !(k in en)) continue;
        assert.equal(ph(de[k]), ph(en[k]), `${k}: same {{placeholders}}`);
      }
    }
  });

  it('the wave 2 block is contiguous and identical in both files', () => {
    const BLOCK = ['common.ok', 'common.done', 'common.next', 'profile.saved', 'profile.save_failed',
      'profile.pw_all_required', 'profile.pw_mismatch', 'profile.pw_too_short', 'profile.pw_changed',
      'profile.pw_change_failed'];
    for (const [nm, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.indexOf(BLOCK[0]);
      assert.ok(first > 0, `${nm}: block present`);
      assert.deepEqual(keys.slice(first, first + BLOCK.length), BLOCK, `${nm}: contiguous`);
    }
    // Both files carry exactly the same keys in the same order for the block.
    const pick = (loc) => Object.keys(loc).slice(Object.keys(loc).indexOf(BLOCK[0]));
    assert.deepEqual(pick(de).slice(0, 57), pick(en).slice(0, 57));
  });

  it('profile.js — the page that had no translation at all — uses keys everywhere', () => {
    const src = stripComments(read('public/js/profile.js'));
    for (const m of src.matchAll(/showMessage\([^,]+,\s*([^,]+),/g)) {
      assert.match(m[1].trim(), /^(T\(|data\.error|err\.message)/, `untranslated text: ${m[1].trim()}`);
    }
  });
});
