'use strict';

// Static guarantees for the entry editor
// (public/js/entry-editor.js, window.GCEntryEditor). No DOM library is
// available in the test environment, so the checks read the sources and
// templates; one test loads the module in a vm with a stub document.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const THEMES = ['aurora']; // Aurora is the only theme (docs/feature-aurora-only.md)

const editorJs = read('public', 'js', 'entry-editor.js');
const de = JSON.parse(read('src', 'i18n', 'de.json'));
const en = JSON.parse(read('src', 'i18n', 'en.json'));

function modalTpl(theme) {
  return read('templates', theme, 'partials', 'modals', 'route-edit.njk')
    + read('templates', theme, 'partials', 'modals', 'confirm.njk');
}
function pageTpl(theme) {
  return read('templates', theme, 'pages', 'zones.njk') + modalTpl(theme);
}
function hasId(html, id) {
  return html.includes('id="' + id + '"');
}
// Literal ids passed to getElementById / byId / querySelector('#…').
function literalIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/(?:getElementById|byId)\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z0-9_-]+)/g)) ids.add(m[1]);
  return ids;
}

test('entry-editor.js exposes window.GCEntryEditor with open/close', () => {
  assert.match(editorJs, /window\.GCEntryEditor\s*=\s*\{/);
  assert.match(editorJs, /\bopen:\s*open\b/);
  assert.match(editorJs, /\bclose:\s*close\b/);
  assert.match(editorJs, /async function open\(routeOrId, opts\)/);
});

test('entry-editor.js loads without a modal and exports the API (vm, stub DOM)', () => {
  const noop = () => {};
  const stubEl = () => ({ id: '', style: {}, appendChild: noop, addEventListener: noop });
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: stubEl,
    addEventListener: noop,
    body: { appendChild: noop },
  };
  const window = { GC: { t: {}, csrfToken: 'x' } };
  const ctx = vm.createContext({ window, document, console, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(editorJs, ctx, { filename: 'entry-editor.js' });
  const ed = window.GCEntryEditor;
  assert.equal(typeof ed.open, 'function');
  assert.equal(typeof ed.close, 'function');
  assert.deepEqual(Object.keys(ed), ['open', 'close'], 'no internal helpers exported');
  // A second load must not replace the first instance.
  vm.runInContext(editorJs, ctx);
  assert.equal(window.GCEntryEditor, ed);
});

test('entry-editor.js does not depend on the removed routes.js closure state', () => {
  for (const name of ['allRoutes', 'allPeers', 'allUsers', 'loadRoutes', 'batchMode', 'renderPeerOptions']) {
    assert.doesNotMatch(editorJs, new RegExp('\\b' + name + '\\b'), 'entry-editor.js references ' + name);
  }
  assert.match(editorJs, /\/api\/routes\/peers/, 'fetches peers itself');
  assert.match(editorJs, /\/api\/v1\/users/, 'fetches users itself');
  assert.match(editorJs, /\/api\/v1\/settings\/domains/, 'fetches domains itself');
  assert.match(editorJs, /'\/api\/routes\/' \+ id\)/, 'fetches GET /api/routes/:id');
});

test('entry-editor.js builds DOM without innerHTML', () => {
  assert.doesNotMatch(editorJs, /\.innerHTML\b/);
});

// Ids that entry-editor.js creates itself.
const EDITOR_DYNAMIC_IDS = new Set([
  'gc-tip-bubble', 'edit-ra-share-managed-note', 'share-link-create-form', 'share-link-url-once',
]);
// Ids built as prefix + suffix with prefix 'edit' (setupAclToggle, setupIpFilter, …).
const EDITOR_PREFIXED_IDS = [
  'edit-route-acl', 'edit-acl-fields', 'edit-acl-peers-list', 'edit-acl-hint',
  'edit-route-ip-filter', 'edit-ip-filter-fields', 'edit-ip-filter-mode-group', 'edit-ip-filter-mode',
  'edit-ip-filter-add', 'edit-ip-filter-input', 'edit-ip-filter-type', 'edit-ip-filter-rules-list',
  'edit-route-external', 'edit-route-block-wrap', 'edit-route-block-action', 'edit-route-block-body',
  'edit-route-block-redirect', 'edit-bot-blocker-mode', 'edit-bot-blocker-redirect', 'edit-bot-blocker-custom',
  'edit-headers-request-list', 'edit-headers-response-list', 'edit-headers-req-add', 'edit-headers-resp-add',
  'edit-route-type', 'edit-l4-protocol',
];

for (const theme of THEMES) {
  test(`[${theme}] every id entry-editor.js uses exists in route-edit.njk / confirm.njk`, () => {
    const html = modalTpl(theme);
    const missing = [...literalIds(editorJs)].filter((id) => !EDITOR_DYNAMIC_IDS.has(id) && !hasId(html, id));
    assert.deepEqual(missing, [], 'ids missing from ' + theme + ' modal partials');
    const missingPrefixed = EDITOR_PREFIXED_IDS.filter((id) => !hasId(html, id));
    // edit-route-acl etc. exist in both the licensed and the locked branch.
    assert.deepEqual(missingPrefixed, [], 'prefixed ids missing from ' + theme);
  });

  test(`[${theme}] route-edit.njk: type chip, flow strip, section nav with summaries, sticky footer`, () => {
    const html = modalTpl(theme);
    for (const id of ['ee-type-chip', 'ee-flow', 'ee-nav', 'ee-panels', 'ee-changes', 'ee-cancel', 'ee-close', 'ee-kind-group',
      'ee-zone-target', 'ee-listen-conflict']) assert.ok(hasId(html, id), id);
    for (const sec of ['target', 'access', 'auth', 'security', 'reliability', 'headers', 'branding', 'diagnose']) {
      assert.ok(hasId(html, 'ee-panel-' + sec), 'panel ' + sec);
      assert.ok(html.includes("['" + sec + "', t('entry_editor.sec_" + sec + "')"), 'nav entry ' + sec);
    }
    assert.ok(html.includes('id="ee-sum-{{ s[0] }}"'), 'one live summary per nav entry');
    // HTTPS-only sections carry the "nur HTTPS" note and the greying hook.
    assert.match(html, /rt-ee-tab-http/);
    assert.match(html, /t\('entry_editor\.https_only'\)/);
    assert.ok((html.match(/rt-ee-http-panel/g) || []).length >= 3, 'auth / headers / branding panels');
    assert.doesNotMatch(html, /edit-route-locked-summary|edit-route-locked-target|entry_editor\.locked_hint/, 'lockTarget summary removed');
    assert.match(html, /id="modal-edit-route"[^>]*data-load-failed="\{\{ t\('entry_editor\.load_failed'\) \}\}"/);
  });

  test(`[${theme}] zones.njk includes the editor partials and loads entry-editor.js after its prerequisites`, () => {
    const tpl = read('templates', theme, 'pages', 'zones.njk');
    for (const partial of ['route-edit.njk', 'confirm.njk']) {
      assert.ok(tpl.includes('{% include theme + "/partials/modals/' + partial + '" %}'), partial + ' included');
    }
    const at = (file) => tpl.indexOf('<script src="/js/' + file + '?v={{ appVersion }}"></script>');
    const order = ['vendor/qrcode.min.js', 'routes-view.js', 'routeDomain.js', 'entry-editor.js', 'domain-modal.js'].map(at);
    order.forEach((i, n) => assert.ok(i > -1, 'script ' + n + ' present'));
    for (let n = 1; n < order.length; n++) assert.ok(order[n] > order[n - 1], 'script order ' + n);
    assert.ok(!tpl.includes('/js/routes.js'), 'legacy routes.js not loaded');
  });
}

test('entry_editor.* i18n keys exist in de and en with identical key sets', () => {
  const deKeys = Object.keys(de).filter((k) => k.startsWith('entry_editor.')).sort();
  const enKeys = Object.keys(en).filter((k) => k.startsWith('entry_editor.')).sort();
  assert.ok(deKeys.length > 0);
  assert.deepEqual(deKeys, enKeys);
  const used = new Set();
  for (const theme of THEMES) {
    for (const m of pageTpl(theme).matchAll(/t\('(entry_editor\.[a-z_]+)'\)/g)) used.add(m[1]);
  }
  for (const k of used) {
    assert.ok(typeof de[k] === 'string' && de[k].length, 'de missing ' + k);
    assert.ok(typeof en[k] === 'string' && en[k].length, 'en missing ' + k);
  }
});

test('lockTarget is gone: ports, protocol and type are editable; zone targets stay with the zone', () => {
  const code = editorJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /lockTarget/, 'no lockTarget option any more');
  // Gateway targets: the editor shows target_lan_port and sends both port fields.
  assert.match(editorJs, /target_lan_port/);
  // Zone-managed entries never send peer/gateway ids (the zone owns the target).
  assert.match(editorJs, /state\.zoneManaged/);
  // Type changes go to the server, which validates them (HOST_HAS_HTTP etc.).
  assert.match(editorJs, /HOST_HAS_HTTP/);
  // A taken listen port shows the server's suggestion inline.
  assert.match(editorJs, /suggestedPort/);
});
