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
const SETTINGS_OPS = section(SETTINGS_JS, '// ─── Auto-Update: maintenance window', '// ── Machine Binding Settings');
const DASH_WN = section(DASH_JS, '// ─── "Was ist neu" card', '// ─── Refresh all');

describe('ops UI: stylesheet + scripts', () => {
  it('live backup refresh (gc:backup) only re-renders the target list when the data changed', () => {
    const js = read('public/js/settings.js');
    assert.match(js, /addEventListener\('gc:backup'[\s\S]{0,200}loadTargets\(\{ ifChanged: true \}\)/);
    assert.match(js, /if \(opts && opts\.ifChanged && JSON\.stringify\(\[state\.targets, state\.loadError\]\) === before\) return;/);
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
      const o = tpl.indexOf('/js/ops-ui.js');
      assert.ok(o > 0 && o < tpl.indexOf(main), main);
    }
  });
  it('no innerHTML in the new code', () => {
    for (const [name, src] of [['ops-ui.js', OPS_JS], ['settings.js (ops)', SETTINGS_OPS], ['dashboard.js (whats new)', DASH_WN]]) {
      assert.doesNotMatch(stripComments(src), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, name);
    }
  });
});

describe('ops UI: templates', () => {
  it('settings backup tab: off-site card, pre-migration card, target dialog, .gcbk restore', () => {
    for (const id of ['card-offsite', 'offsite-license', 'offsite-autobackup-off', 'offsite-passphrase', 'offsite-passphrase2', 'offsite-pass-strength',
      'offsite-pass-save', 'offsite-include-key', 'offsite-include-key-note', 'offsite-add', 'offsite-targets', 'card-premigration', 'premig-list',
      'offsite-target-modal', 'ot-type', 'ot-url', 'ot-host', 'ot-port', 'ot-l4', 'ot-pubkey', 'ot-key-copy', 'ot-key-rotate', 'ot-password',
      'ot-secret', 'ot-clear-password', 'ot-keep', 'ot-enabled', 'offsite-target-error', 'restore-passphrase-row', 'restore-passphrase']) {
      assert.ok(SETTINGS_TPL.includes('id="' + id + '"'), id);
    }
    assert.match(SETTINGS_TPL, /data-licensed="\{\{ '1' if license\.hasFeature\('scheduled_backups'\) else '0' \}\}"/);
    assert.match(SETTINGS_TPL, /id="backup-file-input" accept="\.json,\.gcbk"/);
    // the dialog sits outside the tab panels (fixed children of a hidden panel stay hidden)
    const modalAt = SETTINGS_TPL.indexOf('id="offsite-target-modal"');
    const backupPanel = SETTINGS_TPL.indexOf('data-settings-panel="backup"');
    const nextPanel = SETTINGS_TPL.indexOf('data-settings-panel="email"');
    assert.ok(modalAt > backupPanel && modalAt < nextPanel);
    const between = SETTINGS_TPL.slice(SETTINGS_TPL.indexOf('id="card-premigration"'), modalAt);
    assert.equal((between.match(/<div\b/g) || []).length, (between.match(/<\/div>/g) || []).length - 2, 'card + grid + panel closed before the dialog');
    for (const type of ['sftp', 'smb', 's3', 'webdav']) assert.ok(SETTINGS_TPL.includes('<option value="' + type + '">'), type);
  });
  it('secret inputs are never pre-filled by the template', () => {
    for (const id of ['offsite-passphrase', 'offsite-passphrase2', 'ot-password', 'ot-secret', 'restore-passphrase']) {
      const tag = new RegExp('<input[^>]*id="' + id + '"[^>]*>').exec(SETTINGS_TPL)[0];
      assert.match(tag, /type="password"/, id);
      assert.doesNotMatch(tag, /\svalue=/, id);
    }
  });
  it('advanced tab: maintenance window card after the mode card, reinstall command from INSTALL.md', () => {
    for (const id of ['card-au-window', 'au-window-enabled', 'au-window-start', 'au-window-end', 'au-window-tz', 'au-window-state', 'au-window-waiting',
      'au-window-trigger', 'au-reinstall', 'au-reinstall-cmd', 'au-notify-email', 'au-window-status', 'au-notify-status']) {
      assert.ok(SETTINGS_TPL.includes('id="' + id + '"'), id);
    }
    assert.ok(SETTINGS_TPL.indexOf('id="card-autoupdate"') < SETTINGS_TPL.indexOf('id="card-au-window"'));
    assert.match(SETTINGS_TPL, /curl -fsSLO https:\/\/raw\.githubusercontent\.com\/CallMeTechie\/gatecontrol\/master\/update\.sh/);
    assert.ok(read('INSTALL.md').includes('curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh'), 'same command as the install guide');
  });
  it('dashboard: hidden "Was ist neu" card before the KPI grid', () => {
    const card = DASH_TPL.indexOf('id="whats-new"');
    assert.ok(card > 0 && card < DASH_TPL.indexOf('aurora-kpi-grid'));
    assert.match(DASH_TPL, /<section class="card op-wn" id="whats-new" hidden/);
    for (const id of ['whats-new-title', 'whats-new-sub', 'whats-new-body', 'whats-new-all', 'whats-new-dismiss']) assert.ok(DASH_TPL.includes('id="' + id + '"'), id);
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
      assert.ok(html.includes('data-licensed="' + (licensed ? '1' : '0') + '"'));
      assert.ok(html.includes(de['offsite.title']) && html.includes(de['premig.title']) && html.includes(de['autoupdate.window_title']));
      assert.ok(html.includes("'offsite.err.transport_failed': \"Verbindung fehlgeschlagen.\""), 'client key rendered into GC.t');
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
    const scripts = OPS_JS + SETTINGS_OPS + DASH_WN + section(DASH_JS, 'function renderAutoUpdate', '// ─── "Was ist neu" card')
      + section(SETTINGS_JS, 'Encrypted off-site archives (.gcbk', "document.getElementById('btn-backup-restore')");
    const used = new Set(Array.from(scripts.matchAll(/['"]((?:offsite|premig|whatsnew|autoupdate)\.[a-z0-9_.]+)['"]/g)).map((m) => m[1]));
    assert.ok(used.size > 90, 'keys collected: ' + used.size);
    for (const k of used) {
      assert.ok(de[k] && en[k], 'i18n ' + k);
      assert.ok(LAYOUT.includes("'" + k + "': {{ t('" + k + "') | dump | safe }}"), 'GC.t whitelist ' + k);
    }
  });
});

describe('ops UI: behaviour wiring', () => {
  it('settings.js: the off-site API paths, passphrase write-only, include_key, licence hint with fallback', () => {
    const s = stripComments(SETTINGS_OPS);
    for (const p of ["BASE + '/offsite'", "BASE + '/targets'", "'/targets/' + t.id + '/test'", "'/targets/' + t.id + '/run'", "'/targets/' + t.id + '/files'",
      "BASE + '/targets/l4-candidates'", "BASE + '/ssh-key'", "BASE + '/ssh-key/rotate'", "BASE + '/pre-migration'"]) assert.ok(s.includes(p), p);
    assert.match(s, /var BASE = '\/api\/settings\/backup';/);
    assert.match(s, /window\.api\.put\(BASE \+ '\/offsite', \{ passphrase: pass1\.value \}\)/);
    assert.match(s, /window\.api\.put\(BASE \+ '\/offsite', \{ include_key: next \}\)/);
    assert.doesNotMatch(s, /pass1\.value = (?!'')/, 'the passphrase field is only ever cleared');
    assert.match(s, /window\.GCLicenseHint\.render\('scheduled_backups'\)/);
    assert.match(s, /typeof window\.GCLicenseHint\.render === 'function'/, 'degrades without the component');
    assert.match(s, /document\.addEventListener\('gc:backup'/);
    assert.match(s, /c\.connect_host/);
  });
  it('settings.js: maintenance window + update e-mail through SettingsAutosave', () => {
    const s = stripComments(SETTINGS_OPS);
    assert.match(s, /cluster: 'au-window'/);
    assert.match(s, /cluster: 'au-notify'/);
    assert.match(s, /window\.api\.put\('\/api\/system\/auto-update', \{ window: w \}\)/);
    assert.match(s, /window\.api\.put\('\/api\/system\/auto-update', \{ notify_email: /);
    assert.match(s, /saved\.last_action === 'waiting_window'/);
    assert.match(s, /SettingsAutosave\.resync\('au-window'\)/);
  });
  it('dashboard.js: waiting_window pill, trigger in auto mode with a window, what\'s new calls', () => {
    const d = stripComments(DASH_JS);
    assert.match(d, /d\.last_action === 'waiting_window'/);
    assert.match(d, /if \(d\.mode === 'manual' \|\| windowOn\)/);
    assert.match(d, /'\/api\/system\/whats-new' \+ \(all \? '\?all=1' : ''\)/);
    assert.match(d, /window\.api\.post\('\/api\/system\/whats-new\/seen', body\)/);
    assert.match(d, /if \(!all && !d\.unseen\) \{ card\.hidden = true; return; \}/);
  });
  it('settings.js: /settings#<tab> or #<element id> selects the tab, the hash follows tab switches', () => {
    const tabs = stripComments(section(SETTINGS_JS, '// ─── Settings Tab Switching', '// Mobile hamburger toggle'))
      + stripComments(section(SETTINGS_JS, '// Tab from the address first', '})();'));
    assert.match(tabs, /history\.replaceState\(null, '', location\.pathname \+ location\.search \+ '#' \+ tabName\)/);
    assert.match(tabs, /window\.addEventListener\('hashchange', fromHash\)/);
    assert.match(tabs, /target\.closest\('\.settings-panel'\)/);
    assert.match(tabs, /if \(!fromHash\(\)\) \{/, 'the hash wins over the remembered tab');
    assert.ok(SETTINGS_TPL.includes('data-settings-panel="backup"') && SETTINGS_TPL.includes('data-settings-tab="backup"'));
  });
  it('dashboard.js: #auto-update highlights the topbar status and opens the setup guide when not set up', () => {
    const d = stripComments(DASH_JS);
    assert.match(d, /location\.hash === '#auto-update'/);
    assert.match(d, /host\.classList\.add\('op-flash'\)/);
    assert.match(d, /if \(d && d\.status !== 'active'\) openAuSetup\(\);/);
    assert.match(OPS_CSS, /#au-status\.op-flash \{/);
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
