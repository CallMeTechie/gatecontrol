'use strict';

// Static wiring of the release B operations UI (strand B5, docs/feature-
// release-b.md §4, §6, §7, §13b): ops.css link position, template hooks
// (settings backup + advanced tab, dashboard card, entry-editor fingerprint),
// script order, i18n placement (three contiguous blocks, none at the file
// end), the GC.t whitelist for client-side keys, no innerHTML in the new code
// and the entry-editor save wiring of backend_tls_fingerprint.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LAYOUT = read('templates/aurora/layout.njk');
const SETTINGS_TPL = read('templates/aurora/pages/settings.njk');
const DASH_TPL = read('templates/aurora/pages/dashboard.njk');
const EDITOR_TPL = read('templates/aurora/partials/modals/route-edit.njk');
const SETTINGS_JS = read('public/js/settings.js');
const DASH_JS = read('public/js/dashboard.js');
const OPS_JS = read('public/js/ops-ui.js');
const EDITOR_JS = read('public/js/entry-editor.js');
const APP_CSS = read('public/css/app.css');
// Wave 2 §W2: ops.css is now section §5 of the single stylesheet app.css.
const OPS_CSS = (() => {
  const a = APP_CSS.indexOf('\n * \u00a75 ');
  const b = APP_CSS.indexOf('\n * \u00a76 ');
  return APP_CSS.slice(a, b < 0 ? APP_CSS.length : b);
})();

// The strand's own code sections in the shared scripts.
function section(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, 'section start ' + from);
  const b = to ? src.indexOf(to, a + from.length) : src.length;
  assert.ok(b > a, 'section end ' + to);
  return src.slice(a, b);
}
const SETTINGS_OPS = section(SETTINGS_JS, '// ── Backups ──', '// ── Lizenz ──');
const DASH_WN = section(DASH_JS, '// ─── "Was ist neu" strip', '// ─── Activity');

describe('ops UI: stylesheet + scripts', () => {
  it('live backup refresh (gc:backup) reloads the targets of the open Backups section', () => {
    const js = read('public/js/settings.js');
    // Only while the Backups section is open, debounced.
    assert.match(js, /addEventListener\('gc:backup', \(\) => \{ if \(current === 'backup'\) \{ clearTimeout\(bk\.sse\); bk\.sse = setTimeout\(loadTargets, 400\); \} \}\)/);
  });
  it('the layout links app.css exactly once and nothing else', () => {
    const links = Array.from(LAYOUT.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)).map((m) => m[1]);
    assert.deepEqual(links, ['/css/app.css']);
  });
  it('the op- rules live in the ops section, not in the base or Aurora sections; app.css braces balance', () => {
    const base = APP_CSS.slice(APP_CSS.indexOf('\n * \u00a71 '), APP_CSS.indexOf('\n * \u00a73 '));
    assert.doesNotMatch(base.replace(/\/\*[\s\S]*?\*\//g, ''), /\.op-/);
    assert.match(OPS_CSS, /\.op-/);
    const whole = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((whole.match(/\{/g) || []).length, (whole.match(/\}/g) || []).length);
    assert.match(OPS_CSS, /\.so-editor-block\.so-locked > \.so-fp \{ opacity: 1; pointer-events: auto; \}/);
  });
  it('ops-ui.js loads before settings.js and dashboard.js', () => {
    for (const [tpl, main] of [[SETTINGS_TPL, '/js/settings.js'], [DASH_TPL, '/js/dashboard.js']]) {
      const o = tpl.indexOf('src="/js/ops-ui.js');
      assert.ok(o > 0 && o < tpl.indexOf('src="' + main), main);
    }
  });
  it('no innerHTML in the new code', () => {
    for (const [name, src] of [['ops-ui.js', OPS_JS], ['settings.js (ops)', SETTINGS_OPS], ['dashboard.js (whats new)', DASH_WN]]) {
      assert.doesNotMatch(stripComments(src), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, name);
    }
  });
});

// An element id written out in the template or passed to a row macro
// (switchRow('st-off-key', …) renders id="st-off-key").
const hasId = (id) => SETTINGS_TPL.includes('id="' + id + '"') || SETTINGS_TPL.includes("Row('" + id + "'");

describe('ops UI: templates', () => {
  it('Backups section: off-site card, pre-migration card, target dialog (type cards first), .gcbk restore', () => {
    for (const id of ['card-offsite', 'st-off-abhint', 'st-off-pass', 'st-off-pass2', 'st-off-strength', 'st-off-key', 'st-off-add', 'st-off-targets',
      'card-premigration', 'st-premig', 'st-ot-modal', 'st-ot-url', 'st-ot-host', 'st-ot-port', 'st-ot-l4', 'st-ot-pubkey', 'st-ot-keycopy',
      'st-ot-keyrotate', 'st-ot-pw', 'st-ot-secret', 'st-ot-clearpw', 'st-ot-keep', 'st-ot-enabled', 'st-ot-err', 'st-rs-passrow', 'st-rs-pass']) {
      assert.ok(hasId(id), id);
    }
    assert.match(SETTINGS_TPL, /id="st-rs-file" accept="\.json,\.gcbk"/);
    // the dialog sits outside the sections (fixed children of a hidden section stay hidden)
    assert.ok(SETTINGS_TPL.indexOf('id="st-ot-modal"') > SETTINGS_TPL.indexOf('data-section="gefahr"'));
    // type cards come before the fields
    const dlg = SETTINGS_TPL.slice(SETTINGS_TPL.indexOf('id="st-ot-modal"'));
    for (const type of ['sftp', 'smb', 's3', 'webdav']) assert.ok(dlg.includes(type), type);
    assert.ok(dlg.indexOf('class="st-typecards"') < dlg.indexOf('id="st-ot-name"'));
    assert.ok(dlg.indexOf('id="st-ot-l4"') > 0 && /data-for="sftp smb">\s*<label class="st-label" for="st-ot-l4"/.test(dlg), 'gateway L4 picker for SFTP/SMB');
    assert.match(dlg, /<div class="st-panel" data-for="sftp">/, 'SSH key only for SFTP');
  });
  it('secret inputs are never pre-filled by the template', () => {
    for (const id of ['st-off-pass', 'st-off-pass2', 'st-ot-pw', 'st-ot-secret', 'st-rs-pass', 'st-smtp-pw']) {
      const tag = new RegExp('<input[^>]*id="' + id + '"[^>]*>').exec(SETTINGS_TPL)[0];
      assert.match(tag, /type="password"/, id);
      assert.doesNotMatch(tag, /\svalue=/, id);
    }
  });
  it('Updates section: mode, maintenance window with timeline, update e-mail; reinstall command from INSTALL.md', () => {
    for (const id of ['card-au-window', 'st-au-mode', 'st-au-win', 'st-au-from', 'st-au-to', 'st-au-tz', 'st-au-timeline', 'st-au-waiting',
      'st-au-trigger', 'st-ush-cmds', 'st-ush-cmd', 'st-au-mail']) {
      assert.ok(hasId(id), id);
    }
    assert.match(SETTINGS_TPL, /curl -fsSLO https:\/\/raw\.githubusercontent\.com\/CallMeTechie\/gatecontrol\/master\/update\.sh/);
    assert.ok(read('INSTALL.md').includes('curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh'), 'same command as the install guide');
  });
  it('dashboard: hidden "Was ist neu" strip before the health tiles', () => {
    const strip = DASH_TPL.indexOf('id="whats-new"');
    assert.ok(strip > 0 && strip < DASH_TPL.indexOf('id="db-tiles"'));
    assert.match(DASH_TPL, /<section class="db-news" id="whats-new" hidden/);
    for (const id of ['whats-new-badge', 'whats-new-text', 'whats-new-body', 'whats-new-all', 'whats-new-dismiss']) assert.ok(DASH_TPL.includes('id="' + id + '"'), id);
  });
  it('entry editor: fingerprint field inside the backend TLS block, error text as data attribute', () => {
    const block = section(EDITOR_TPL, 'id="edit-backend-tls-block"', 'id="edit-backend-tls-error"');
    assert.match(block, /id="edit-backend-tls-fp" class="so-editor-fields so-fp" hidden/);
    assert.match(block, /<input type="text" class="form-input so-mono" id="edit-route-backend-tls-fingerprint"/);
    assert.ok(block.includes("t('backend_tls.fp_gateway_note')"));
    assert.match(EDITOR_TPL, /data-err-backend-tls-fingerprint-invalid="\{\{ t\('backend_tls\.err\.fingerprint_invalid'\) \}\}"/);
    // The note must name the gateway version that starts verifying (the pin
    // shipped with gateway 1.16.10) — pinning the exact sentence only breaks
    // on wording changes.
    assert.match(de['backend_tls.fp_gateway_note'], /Gateway-Version \d+\.\d+\.\d+/);
    assert.match(en['backend_tls.fp_gateway_note'], /gateway version \d+\.\d+\.\d+/i);
  });
  it('settings.njk and dashboard.njk render (German) with the new hooks', () => {
    const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(ROOT, 'templates')), { autoescape: true });
    env.addFilter('bytes', (v) => String(v || 0) + ' B');
    env.addFilter('reltime', () => '—');
    env.addFilter('truncate', (s, n) => (!s || s.length <= n ? (s || '') : s.substring(0, n) + '...'));
    const t = (key) => (de[key] !== undefined ? de[key] : key);
    const base = {
      theme: 'aurora', language: 'de', t, availableLanguages: ['de', 'en'], cspNonce: 'N', csrfToken: 'c', appVersion: '9.9.9', appName: 'GateControl',
      baseUrl: 'https://gc.example.com', user: { id: 1, username: 'admin', display_name: 'Admin', role: 'admin' }, flash: {}, title: 'x',
    };
    for (const licensed of [true, false]) {
      const license = { plan: 'pro', features: { scheduled_backups: licensed, http_routes: -1, l4_routes: -1, pihole: { available: true } }, hasFeature: (k) => (k === 'scheduled_backups' ? licensed : true), isWithinLimit: () => true };
      const html = env.render('aurora/pages/settings.njk', Object.assign({}, base, { license, activeNav: 'settings', currentPath: '/settings' }));
      assert.equal(/id="st-off-add"[^>]* disabled/.test(html), !licensed, 'add target only with the licence');
      assert.equal(html.includes('data-license-hint="scheduled_backups"'), !licensed, 'licence hint without it');
      assert.ok(html.includes(de['st.bk.offsite_title']) && html.includes(de['premig.title']) && html.includes(de['autoupdate.window_help']));
      assert.doesNotMatch(html, /\{\{\s*t\(|\{%/, 'no unrendered tags');
    }
    const license = { plan: 'pro', features: {}, hasFeature: () => true, isWithinLimit: () => true, unlicensed: false };
    const dash = env.render('aurora/pages/dashboard.njk', Object.assign({}, base, { license, activeNav: 'dashboard', currentPath: '/dashboard' }));
    assert.ok(dash.includes('data-title="Neu in GateControl {v}"'));
  });
});

describe('ops UI: i18n', () => {
  const OWN = /^(offsite\.|premig\.|whatsnew\.|autoupdate\.(window_|waiting_window|trigger_now_window|trigger_cooldown|trigger_not_manual|reinstall_|notify_email|version_whats_new|err\.)|backend_tls\.(fp_|err\.fingerprint_invalid))/;
  const pick = (o) => Object.keys(o).filter((k) => OWN.test(k));

  it('de and en carry identical key sets with the same {placeholders}', () => {
    assert.deepEqual(pick(de).sort(), pick(en).sort());
    assert.ok(pick(de).length > 150);
    for (const k of pick(de)) {
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.ok(de[k] && en[k], k);
      assert.equal(ph(de[k]), ph(en[k]), k);
    }
  });
  function contiguous(loc, name, re, anchorRe) {
    const keys = Object.keys(loc);
    const idx = keys.map((k, i) => (re.test(k) ? i : -1)).filter((i) => i >= 0);
    assert.ok(idx.length > 0, name);
    assert.equal(idx[idx.length - 1] - idx[0] + 1, idx.length, `${name}: one contiguous block`);
    assert.match(keys[idx[0] - 1], anchorRe, `${name}: follows ${keys[idx[0] - 1]}`);
    assert.ok(idx[idx.length - 1] < keys.length - 1, `${name}: not at the file end`);
  }
  it('update/what\'s-new block directly after the old autoupdate.* keys', () => {
    const re = /^(whatsnew\.|autoupdate\.(window_|waiting_window|trigger_now_window|trigger_cooldown|trigger_not_manual|reinstall_|notify_email|version_whats_new|err\.))/;
    for (const [n, loc] of [['de', de], ['en', en]]) {
      contiguous(loc, n + ' update', re, /^autoupdate\.rollback_failed$/);
      const keys = Object.keys(loc);
      const au = keys.map((k, i) => (k.startsWith('autoupdate.') ? i : -1)).filter((i) => i >= 0);
      assert.ok(au[au.length - 1] < keys.findIndex((k) => k.startsWith('whatsnew.')), n + ': whatsnew.* after the last autoupdate.* key');
    }
  });
  it('backup block (offsite.*, premig.*) directly after the last autobackup.* key', () => {
    for (const [n, loc] of [['de', de], ['en', en]]) contiguous(loc, n + ' backup', /^(offsite\.|premig\.)/, /^autobackup\.confirm_delete$/);
  });
  it('fingerprint keys inside the backend_tls.* group of the security options block', () => {
    for (const [n, loc] of [['de', de], ['en', en]]) {
      contiguous(loc, n + ' fingerprint', /^backend_tls\.(fp_|err\.fingerprint_invalid)/, /^backend_tls\.err\.server_name_invalid$/);
      const keys = Object.keys(loc);
      assert.match(keys[keys.length - 1], /^waf\./, n + ': the waf.* block stays the tail');
    }
  });
  it('every key the templates use exists; every key the scripts use is whitelisted in GC.t', () => {
    for (const src of [SETTINGS_TPL, DASH_TPL, EDITOR_TPL]) {
      for (const m of src.matchAll(/t\('((?:offsite|premig|whatsnew|autoupdate|backend_tls)\.[a-z0-9_.]+)'\)/g)) {
        assert.ok(de[m[1]] && en[m[1]], m[1]);
      }
    }
    // Dashboard + ops-ui: the GC.t whitelist; settings.js: the page island
    // (offsite., premig., autoupdate. are island prefixes of settings.njk).
    const global = OPS_JS + DASH_WN + section(DASH_JS, 'function renderAutoUpdate', '// ─── "Was ist neu" strip');
    const used = new Set(Array.from(global.matchAll(/['"]((?:offsite|premig|whatsnew|autoupdate)\.[a-z0-9_.]+)['"]/g)).map((m) => m[1]));
    assert.ok(used.size > 40, 'keys collected: ' + used.size);
    for (const k of used) {
      assert.ok(de[k] && en[k], 'i18n ' + k);
      if (!/^(offsite|premig)\./.test(k) || DASH_WN.includes(k)) assert.ok(LAYOUT.includes("'" + k + "': {{ t('" + k + "') | dump | safe }}"), 'GC.t whitelist ' + k);
    }
    const island = /id="st-i18n" data-prefixes="([^"]+)"/.exec(SETTINGS_TPL)[1].split(' ');
    for (const p of ['offsite.', 'premig.', 'autoupdate.', 'updatesh.']) assert.ok(island.includes(p), 'island ' + p);
    for (const m of SETTINGS_OPS.matchAll(/t\('((?:offsite|premig|autoupdate|updatesh)\.[a-z0-9_.]+)'/g)) assert.ok(de[m[1]] && en[m[1]], 'i18n ' + m[1]);
  });
});

describe('ops UI: behaviour wiring', () => {
  it('settings.js: the off-site API paths, passphrase write-only through the save bar, include_key', () => {
    const s = stripComments(SETTINGS_OPS);
    for (const p of ["BK + '/offsite'", "BK + '/targets'", "'/targets/' + tg.id + '/test'", "'/targets/' + tg.id + '/run'", "'/targets/' + tg.id + '/verify'",
      "'/targets/' + tg.id + '/files'", "BK + '/targets/l4-candidates'", "BK + '/ssh-key'", "BK + '/ssh-key/rotate'", "BK + '/pre-migration'"]) assert.ok(s.includes(p), p);
    assert.match(s, /const BK = '\/api\/v1\/settings\/backup';/);
    assert.match(s, /fields: \['off-pass'\], errorField: 'off-pass', save: \(\) => api\.put\(BK \+ '\/offsite', \{ passphrase: passEl\.value \}\)/);
    assert.match(s, /fields: \['off-key'\], errorField: 'off-key', save: \(v\) => api\.put\(BK \+ '\/offsite', \{ include_key: v\['off-key'\] \}\)/);
    assert.doesNotMatch(s, /passEl\.value = (?!''|s\[0\] \|\| '')/, 'the passphrase field is only ever cleared (or reset to its empty baseline)');
    assert.match(s, /c\.connect_host/);
  });
  it('settings.js: maintenance window + update e-mail as save groups', () => {
    const s = stripComments(SETTINGS_OPS);
    assert.match(s, /api\.put\('\/api\/v1\/system\/auto-update', \{ window: \{ enabled: v\['au-win'\], start: v\['au-from'\], end: v\['au-to'\], tz: v\['au-tz'\] \} \}\)/);
    assert.match(s, /api\.put\('\/api\/v1\/system\/auto-update', \{ notify_email: v\['au-mail'\] \}\)/);
    assert.match(s, /auSaved\.last_action === 'waiting_window'/);
    assert.match(s, /O\.windowProblem\(/);
  });
  it('dashboard.js: waiting_window pill, trigger in auto mode with a window, what\'s new calls', () => {
    const d = stripComments(DASH_JS);
    assert.match(d, /d\.last_action === 'waiting_window'/);
    assert.match(d, /if \(d\.mode === 'manual' \|\| windowOn\)/);
    assert.match(d, /'\/api\/system\/whats-new' \+ \(all \? '\?all=1' : ''\)/);
    assert.match(d, /window\.api\.post\('\/api\/system\/whats-new\/seen', body\)/);
    assert.match(d, /if \(!all && !d\.unseen\) \{ strip\.hidden = true; return; \}/);
  });
  it('settings.js: /settings#<section>, old tabs and element ids select the section; the hash follows', () => {
    const js = stripComments(SETTINGS_JS);
    assert.match(js, /history\.replaceState\(null, '', location\.pathname \+ hash\)/);
    assert.match(js, /window\.addEventListener\('hashchange', \(\) => \{/);
    assert.match(js, /U\.resolveLocation\(\{ hash: location\.hash, search: location\.search \}, \{ known, sectionOfElement \}\)/);
    assert.ok(SETTINGS_TPL.includes('<section class="st-section" data-section="backup"'));
  });
  it('dashboard.js: #auto-update highlights the Server card\'s update block and opens the setup guide when not set up', () => {
    const d = stripComments(DASH_JS);
    assert.match(d, /location\.hash === '#auto-update'/);
    assert.match(d, /box\.classList\.add\('db-flash'\)/);
    assert.match(d, /if \(d && d\.status !== 'active'\) openAuSetup\(\);/);
    assert.match(DASH_TPL, /<div class="db-au" id="auto-update"/);
    assert.match(APP_CSS, /\.db-flash\{/);
  });
  it('events.js subscribes the backup SSE type (gc:backup refreshes the targets)', () => {
    assert.match(read('public/js/events.js'), /'tls', 'backup'\]/);
  });
  it('entry-editor.js: fingerprint only for gateway + Backend HTTPS, code mapped, client check', () => {
    const e = stripComments(EDITOR_JS);
    assert.match(e, /BACKEND_TLS_FINGERPRINT_INVALID: \['edit-backend-tls-block', 'errBackendTlsFingerprintInvalid', 'backend_tls\.err\.fingerprint_invalid', 'general'\]/);
    assert.match(e, /\(target\.target_kind \|\| 'peer'\) === 'gateway' && isOn\('edit-route-backend-https'\)/);
    assert.match(e, /out\.backend_tls_fingerprint = fpHex;/);
    assert.match(e, /return \{ error: 'BACKEND_TLS_FINGERPRINT_INVALID' \}/);
    assert.match(e, /setVal\('edit-route-backend-tls-fingerprint', formatFingerprint\(route\.backend_tls_fingerprint \|\| ''\)\)/);
    // same rule as the server and as ops-ui.js
    const O = require('../public/js/ops-ui.js');
    const fn = /function normalizeFingerprint\(value\) \{[\s\S]*?\n  \}/.exec(EDITOR_JS)[0];
    const editorNormalize = new Function(fn + '; return normalizeFingerprint;')();
    for (const v of ['', 'AB:CD', 'ab'.repeat(32), 'SHA256=' + 'AB:'.repeat(31) + 'AB', 'zz'.repeat(32)]) assert.equal(editorNormalize(v), O.normalizeFingerprint(v), v);
  });
});
