'use strict';

// Security options UI kit (docs/feature-security-options.md): host aliases
// (A), header presets (C), body limit (D), TLS profile (E) and the mTLS entry
// tag (F). Used by the domain dialog (domain-modal.js: alias tags, "Alias-
// Namen…" dialog, www checkbox of a new "@" host, TLS profile select, entry
// tags), the zones page (zones-page.js: "+ www" in the host row) and the
// entry editor (entry-editor.js: header presets). Loaded on zones.njk after
// hsts-ui.js and before domain-modal.js. UMD like hsts-ui.js: the pure
// helpers (alias label rules, preset contents, body-limit formatting, error
// mapping) are testable in node:test; the DOM part only exists in the
// browser. DOM is built with el() — no innerHTML. Strings come from the
// zones i18n island (#zones-i18n, keys alias.* / tls_profile.* / …).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCSecOptUI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const ALIAS_MAX = 10;
  const ALIAS_MODES = ['redirect', 'serve'];
  const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const BODY_MAX_MB = 4096;
  const TLS_VERSIONS = ['1.2', '1.3'];
  const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

  function str(v) { return v == null ? '' : String(v); }
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

  // ── Aliases (§A) ──
  // Labels are relative to the host FQDN ('www' on 'app.example.com' →
  // 'www.app.example.com'); same label rules as a subdomain, never '@'.
  function normalizeAlias(s) { return str(s).trim().toLowerCase().replace(/\.+$/, ''); }
  function validAliasLabel(s) {
    const v = normalizeAlias(s);
    if (!v || v === '@' || v.length > 190) return false;
    return v.split('.').every((l) => LABEL_RE.test(l));
  }
  // Client-side check before adding a label to the list:
  // null | 'invalid' | 'duplicate' | 'limit'.
  function aliasLabelError(label, existing) {
    const v = normalizeAlias(label);
    if (!validAliasLabel(v)) return 'invalid';
    const list = (existing || []).map(normalizeAlias);
    if (list.indexOf(v) >= 0) return 'duplicate';
    if (list.length >= ALIAS_MAX) return 'limit';
    return null;
  }
  function aliasFqdn(label, hostFqdn) {
    const l = normalizeAlias(label);
    const f = normalizeAlias(hostFqdn);
    return f ? l + '.' + f : l;
  }
  function aliasModeOf(host) { return host && host.alias_mode === 'serve' ? 'serve' : 'redirect'; }
  // { labels, mode, fqdns } of a zones Host (aliases may arrive as an array or JSON text).
  function hostAliases(host) {
    let raw = host && host.aliases;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = []; } }
    const labels = [];
    (Array.isArray(raw) ? raw : []).forEach((l) => { const v = normalizeAlias(l); if (v && labels.indexOf(v) < 0) labels.push(v); });
    const given = host && Array.isArray(host.alias_fqdns) ? host.alias_fqdns : null;
    const fqdns = given && given.length === labels.length ? given.map(normalizeAlias) : labels.map((l) => aliasFqdn(l, host && host.fqdn));
    return { labels, mode: aliasModeOf(host), fqdns };
  }
  // Host card tag text: 'www ↗' (redirect) or 'www' (serve).
  function aliasTagText(label, mode) { return mode === 'serve' ? normalizeAlias(label) : normalizeAlias(label) + ' ↗'; }
  // Zones page host row: '+ www' / '+ www, shop' ('' without aliases).
  function aliasSummary(host) {
    const a = hostAliases(host);
    return a.labels.length ? '+ ' + a.labels.join(', ') : '';
  }
  // Zone already has 'www' as a host or as an alias of another host → the
  // "www-Alias anlegen" checkbox of a new '@' host would only answer 409.
  function wwwTaken(zone) {
    const domain = normalizeAlias(zone && zone.domain);
    const www = 'www' + (domain ? '.' + domain : '');
    return ((zone && zone.hosts) || []).some((h) => normalizeAlias(h.subdomain) === 'www'
      || normalizeAlias(h.fqdn) === www || hostAliases(h).fqdns.indexOf(www) >= 0);
  }
  // Only hosts with an HTTP entry can carry aliases (ALIAS_REQUIRES_HTTP).
  function hostHasHttp(host) { return ((host && host.entries) || []).some((e) => e && e.route_type !== 'l4'); }
  // New-host draft ({ type, template }) creates an HTTP entry.
  function draftHasHttp(draft) {
    if (!draft) return false;
    if (draft.template) return Array.isArray(draft.template.entries) && draft.template.entries.some((e) => e && e.type === 'http');
    return draft.type === 'http';
  }
  function isApexSub(sub) { const v = normalizeAlias(sub); return v === '' || v === '@'; }
  // POST /domains/:id/hosts fields for the "www-Alias anlegen" checkbox of a
  // new-host draft ({ sub, type, template, www }), or null.
  function wwwAliasFields(draft, zone) {
    if (!draft || !isApexSub(draft.sub) || draft.www === false || wwwTaken(zone) || !draftHasHttp(draft)) return null;
    return { aliases: ['www'], alias_mode: 'redirect' };
  }

  // ── Header presets (§C) ──
  // Response headers the editor's preset select adds. "Sicherheits-Header
  // (modern)" without X-XSS-Protection; HSTS stays with the HSTS switch.
  const HEADER_PRESETS = {
    cors: [
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
    ],
    security: [
      { name: 'X-Content-Type-Options', value: 'nosniff' },
      { name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { name: 'X-Frame-Options', value: 'DENY' },
      { name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { name: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ],
    csp: [
      { name: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'" },
    ],
  };
  // Presets that need a visible warning in the editor.
  const PRESET_WARNINGS = { csp: 'headers.preset_csp_warning' };
  function presetHeaders(name) {
    const list = HEADER_PRESETS[str(name)];
    return list ? list.map((h) => ({ name: h.name, value: h.value })) : [];
  }
  // New header list with the preset applied: a header of the same name
  // (case-insensitive) is replaced instead of duplicated. Never mutates.
  function applyPreset(list, name) {
    const add = presetHeaders(name);
    const names = add.map((h) => h.name.toLowerCase());
    return (list || []).filter((h) => h && names.indexOf(str(h.name).trim().toLowerCase()) < 0).concat(add);
  }

  // ── Body limit (§D) ──
  // '' / null → 0 (unlimited); integer 0…4096 → the number; anything else → null.
  function parseBodyLimit(v) {
    if (v === undefined || v === null) return 0;
    const s = str(v).trim();
    if (s === '') return 0;
    if (!/^\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n <= BODY_MAX_MB ? n : null;
  }
  function bodyLimitOf(entry) {
    const n = parseInt(entry && entry.max_body_mb, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  // Entry tag text '≤ 50 MB'; null for 0 (unlimited). tr(key, params) optional.
  function bodyLimitLabel(mb, tr) {
    const n = parseInt(mb, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return tr ? tr('body_limit.tag', { mb: n }) : '≤ ' + n + ' MB';
  }

  // ── Backend TLS (§B) / mTLS (§F) ──
  // Caddy only dials peer targets itself; gateway and pool routes are dialled
  // by the gateway companion, where the backend TLS fields are not applied.
  function backendTlsApplies(route) { return !!route && (route.target_kind || 'peer') !== 'gateway'; }
  function mtlsActive(entry) { return !!entry && entry.route_type !== 'l4' && truthy(entry.mtls_enabled); }
  function pemCertCount(text) { return (str(text).match(PEM_CERT_RE) || []).length; }

  // ── TLS profile (§E) ──
  function zoneTlsMin(zone) { return zone && String(zone.tls_min_version) === '1.3' ? '1.3' : '1.2'; }

  // ── Error mapping (all contract codes of the feature) ──
  const ERROR_KEYS = {
    ALIAS_CONFLICT: 'alias.err.conflict',
    HOST_EXISTS: 'alias.err.host_exists',
    ALIAS_REQUIRES_HTTP: 'alias.err.requires_http',
    ALIAS_INVALID: 'alias.err.invalid',
    ALIAS_LIMIT: 'alias.err.limit',
    BACKEND_CA_INVALID: 'backend_tls.err.ca_invalid',
    BACKEND_SERVER_NAME_INVALID: 'backend_tls.err.server_name_invalid',
    MAX_BODY_INVALID: 'body_limit.err.invalid',
    MTLS_CA_INVALID: 'mtls.err.ca_invalid',
    MTLS_REQUIRES_HTTPS: 'mtls.err.requires_https',
    MTLS_MODE_INVALID: 'mtls.err.mode_invalid',
    TLS_MIN_VERSION_INVALID: 'tls_profile.err.invalid',
  };
  const ERROR_CODES = Object.keys(ERROR_KEYS);
  function errorKey(code) { return ERROR_KEYS[str(code).toUpperCase()] || null; }
  // Client-side alias check result → i18n key.
  function aliasCheckKey(err) { return err ? 'alias.err.' + err : null; }

  const pure = {
    ALIAS_MAX, ALIAS_MODES, BODY_MAX_MB, TLS_VERSIONS, HEADER_PRESETS, PRESET_WARNINGS, ERROR_CODES, ERROR_KEYS,
    normalizeAlias, validAliasLabel, aliasLabelError, aliasFqdn, aliasModeOf, hostAliases, aliasTagText, aliasSummary,
    wwwTaken, hostHasHttp, draftHasHttp, isApexSub, wwwAliasFields, presetHeaders, applyPreset, parseBodyLimit, bodyLimitOf, bodyLimitLabel,
    backendTlsApplies, mtlsActive, pemCertCount, zoneTlsMin, errorKey, aliasCheckKey,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const GC = win.GC = win.GC || {};
  GC.t = GC.t || {};
  try {
    const island = doc.getElementById('zones-i18n');
    if (island) {
      const strings = JSON.parse(island.textContent || '{}');
      Object.keys(strings).forEach((k) => { if (GC.t[k] === undefined) GC.t[k] = strings[k]; });
    }
  } catch (_) { /* keep whatever GC.t has */ }

  function t(key, params) {
    let s = GC.t[key] != null ? GC.t[key] : key;
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function errorText(code, params) { const k = errorKey(code); return k ? t(k, params) : null; }

  const PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, placeholder: 1, maxLength: 1, htmlFor: 1, tabIndex: 1, href: 1, target: 1, rel: 1, name: 1 };
  function el(tag, props, children) {
    const node = doc.createElement(tag);
    const p = props || {};
    if (p.type != null) node.type = p.type;
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (k === 'type' || v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
      else if (k === 'style') node.setAttribute('style', v);
      else if (k === 'on') Object.keys(v).forEach((ev) => node.addEventListener(ev, v[ev]));
      else if (PROPS[k]) node[k] = v;
      else if (v === false) return;
      else node.setAttribute(k, v === true ? '' : v);
    });
    append(node, children);
    return node;
  }
  function append(node, children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(node, c);
      else node.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return node;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    info: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 16, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 8, x2: 12.01, y2: 8 }]],
    plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    lock: [['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }], ['path', { d: 'M7 11V7a5 5 0 0110 0v4' }]],
  };
  function icon(name, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'],
      ['class', 'so-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((spec) => {
      const n = doc.createElementNS(SVGNS, spec[0]);
      Object.keys(spec[1]).forEach((k) => n.setAttribute(k, String(spec[1][k])));
      svg.appendChild(n);
    });
    return svg;
  }

  function busy(btn, on) {
    if (!btn) return;
    if (on) { if (win.btnLoading) win.btnLoading(btn); else btn.disabled = true; }
    else if (win.btnReset) win.btnReset(btn); else btn.disabled = false;
  }
  function toast(msg, type) {
    if (win.showToast) win.showToast(msg, type || 'success');
    else if (type === 'error') console.error(msg);
  }
  // api.put resolves {ok:false, code?} for 400/403/429 and throws otherwise
  // (409 carries the body in err.data) — both become a thrown Error.
  async function call(promise) {
    const res = await promise;
    if (res && res.ok === false) {
      const e = new Error(res.error || t('zones.error_generic'));
      e.data = res;
      throw e;
    }
    return res || {};
  }
  function errCode(err) { return err && err.data && err.data.code ? String(err.data.code) : ''; }
  // Mapped German text for a contract code, else the server/API message.
  function errMsg(err) {
    return errorText(errCode(err), { max: ALIAS_MAX }) || (err && err.message) || t('zones.error_generic');
  }

  // ── Dialog (own overlay above the domain modal, like GCHstsUI.dialog) ──
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body so-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot so-dialog-foot' });
    const titleId = 'so-dlg-' + Math.random().toString(36).slice(2, 8);
    const box = el('div', { class: 'modal zn-dialog-box so-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), closeBtn]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog so-dialog', style: 'display:flex', dataset: { soDialog: opts.kind || 'dialog' } }, [box]);
    const prevFocus = doc.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus && doc.contains(prevFocus)) prevFocus.focus();
      resolveFn(result);
    }
    // Capture phase so app.js's global Escape never closes the domain modal underneath.
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
    }
    closeBtn.addEventListener('click', () => close(null));
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(overlay);
    return { overlay, box, body, foot, close, promise };
  }
  function hintEl(text, warn) {
    return el('div', { class: 'so-hint' + (warn ? ' so-hint-warn' : '') }, [icon(warn ? 'alert' : 'info', 12), el('span', { text })]);
  }
  function errorBox() {
    const box = el('div', { class: 'zn-field-error so-field-error', role: 'alert' }, [el('span', { class: 'so-err-text' }), el('span', { class: 'so-err-detail' })]);
    box.hidden = true;
    return {
      node: box,
      show(text, detail) {
        box.querySelector('.so-err-text').textContent = text || '';
        const d = box.querySelector('.so-err-detail');
        d.textContent = detail && detail !== text ? detail : '';
        d.hidden = !d.textContent;
        box.hidden = false;
      },
      hide() { box.hidden = true; },
    };
  }

  // ── Aliases: host card tags ──
  function aliasTags(host) {
    const a = hostAliases(host);
    if (!a.labels.length) return null;
    return a.labels.map((label, i) => el('span', {
      class: 'tag tag-grey so-alias-tag' + (a.mode === 'serve' ? ' so-alias-serve' : ''),
      title: t(a.mode === 'serve' ? 'alias.tag_serve_hint' : 'alias.tag_redirect_hint', { fqdn: a.fqdns[i] || label, host: str(host.fqdn) }),
      dataset: { alias: label, aliasMode: a.mode },
    }, [aliasTagText(label, a.mode)]));
  }

  // ── Aliases: host menu item ("Alias-Namen…") ──
  // opts.onChanged(res) after a successful save. null for hosts without a zone.
  function aliasMenuItem(host, zone, opts) {
    if (!host || !zone || zone.unassigned || !host.fqdn) return null;
    const http = hostHasHttp(host);
    return {
      icon: 'link', label: t('alias.menu'), disabled: !http, hint: http ? null : t('alias.needs_http'),
      onClick: () => openAliasDialog(host, zone, opts),
    };
  }

  // ── Aliases: dialog (list, add/remove, mode, save → PUT /hosts/:id) ──
  function openAliasDialog(host, zone, opts) {
    const o = opts || {};
    const cur = hostAliases(host);
    const st = { labels: cur.labels.slice(), mode: cur.mode };
    const fqdn = str(host.fqdn);
    const d = dialog({ title: t('alias.dialog_title', { host: fqdn }), kind: 'alias' });
    d.overlay.classList.add('so-alias-dialog');
    const err = errorBox();
    const addErr = el('div', { class: 'zn-field-error so-alias-add-error', role: 'alert' });
    addErr.hidden = true;
    const list = el('div', { class: 'so-alias-list', role: 'list' });
    const input = el('input', { type: 'text', class: 'form-input zn-input zn-mono so-alias-input', placeholder: t('alias.add_ph'), 'aria-label': t('alias.add_label'), maxLength: 190, autocomplete: 'off', spellcheck: 'false' });
    const addBtn = el('button', { type: 'button', class: 'btn btn-secondary zn-btn-sm so-alias-add-btn' }, [icon('plus', 12), t('alias.add')]);
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary so-btn-save', text: t('common.save') });
    const count = el('span', { class: 'so-alias-count' });

    function renderList() {
      list.replaceChildren();
      if (!st.labels.length) list.appendChild(el('div', { class: 'so-alias-empty', text: t('alias.list_empty') }));
      st.labels.forEach((label, i) => {
        list.appendChild(el('div', { class: 'so-alias-row', role: 'listitem', dataset: { alias: label } }, [
          el('span', { class: 'tag tag-grey so-alias-tag' + (st.mode === 'serve' ? ' so-alias-serve' : '') }, [aliasTagText(label, st.mode)]),
          el('code', { class: 'so-alias-fqdn', text: aliasFqdn(label, fqdn) }),
          el('span', { class: 'zn-spacer' }),
          el('button', {
            type: 'button', class: 'zn-ibtn zn-ibtn-danger so-alias-remove', title: t('alias.remove', { alias: label }), 'aria-label': t('alias.remove', { alias: label }),
            on: { click: () => { st.labels.splice(i, 1); addErr.hidden = true; renderList(); input.focus(); } },
          }, [icon('x', 12)]),
        ]));
      });
      count.textContent = st.labels.length + ' / ' + ALIAS_MAX;
      const full = st.labels.length >= ALIAS_MAX;
      input.disabled = full;
      addBtn.disabled = full;
    }
    function add() {
      const v = normalizeAlias(input.value);
      if (!v) { input.focus(); return; }
      const bad = aliasLabelError(v, st.labels);
      if (bad) {
        addErr.textContent = t(aliasCheckKey(bad), { alias: v, max: ALIAS_MAX });
        addErr.hidden = false;
        input.focus();
        return;
      }
      addErr.hidden = true;
      st.labels.push(v);
      input.value = '';
      renderList();
      input.focus();
    }
    addBtn.addEventListener('click', add);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    input.addEventListener('input', () => { addErr.hidden = true; });

    const radio = (value) => {
      const r = el('input', { type: 'radio', name: 'so-alias-mode', value, checked: st.mode === value, class: 'so-alias-mode-' + value });
      r.addEventListener('change', () => { if (r.checked) { st.mode = value; renderList(); } });
      return el('label', { class: 'zn-radio so-radio' }, [r, el('span', { class: 'so-radio-text' }, [
        el('span', { class: 'so-radio-title', text: t('alias.mode_' + value) }),
        el('span', { class: 'so-radio-desc', text: t('alias.mode_' + value + '_hint', { host: fqdn }) }),
      ])]);
    };

    d.body.appendChild(el('p', { class: 'zn-dialog-detail so-alias-intro', text: t('alias.intro', { host: fqdn, example: aliasFqdn('www', fqdn) }) }));
    d.body.appendChild(el('div', { class: 'so-alias-head' }, [el('span', { class: 'form-label', text: t('alias.list_label') }), count]));
    d.body.appendChild(list);
    d.body.appendChild(el('div', { class: 'so-alias-add' }, [
      el('div', { class: 'zn-affix so-alias-affix' }, [input, el('span', { class: 'zn-affix-sfx', text: '.' + fqdn })]),
      addBtn,
    ]));
    d.body.appendChild(addErr);
    d.body.appendChild(el('div', { class: 'form-group zn-radios so-radios', role: 'radiogroup', 'aria-label': t('alias.mode_label') }, [
      el('span', { class: 'form-label', text: t('alias.mode_label') }),
      radio('redirect'), radio('serve'),
    ]));
    d.body.appendChild(el('div', { class: 'so-hints' }, [hintEl(t('alias.cert_hint'), false)]));
    d.body.appendChild(err.node);

    saveBtn.addEventListener('click', async () => {
      err.hide();
      // A label still in the input counts as "add, then save".
      if (normalizeAlias(input.value)) { add(); if (!addErr.hidden) return; }
      busy(saveBtn, true);
      try {
        const res = await call(win.api.put('/api/v1/hosts/' + host.id, { aliases: st.labels.slice(), alias_mode: st.mode }));
        const tls = res.tls && res.tls.state ? res.tls : null;
        if (tls && tls.state === 'paused') {
          toast(t('alias.paused', { alias: str(tls.host || aliasFqdn(st.labels[0] || '', fqdn)), reason: pausedReason(tls) }), 'warning');
        } else {
          toast(t('alias.saved', { host: fqdn }), 'success');
        }
        d.close(res);
        if (o.onChanged) o.onChanged(res);
      } catch (e) {
        err.show(errMsg(e), errorKey(errCode(e)) ? (e && e.message) : '');
        busy(saveBtn, false);
      }
    });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(saveBtn);
    renderList();
    input.focus();
    return d;
  }
  // Reason text of a paused TLS result (tls-ui.js when present).
  function pausedReason(tls) {
    const TG = win.GCTlsUI;
    if (TG && typeof TG.pausedReason === 'function') return TG.pausedReason(tls);
    return str(tls && (tls.code || tls.detail));
  }
  // Inline notice text for the domain dialog after a paused alias.
  function pausedNotice(res) {
    const tls = res && res.tls;
    if (!tls || tls.state !== 'paused') return null;
    const reason = pausedReason(tls);
    return { host: str(tls.host), tls, reason, text: t('alias.paused', { alias: str(tls.host), reason }) };
  }

  // ── Aliases: "www-Alias anlegen" checkbox of a new "@" host ──
  // draft: the new-host draft (draft.www: bool). Returns the label node;
  // the caller hides it while the subdomain is not '@'.
  function wwwCheckbox(draft, zone, keyPrefix) {
    const taken = wwwTaken(zone);
    const cb = el('input', { type: 'checkbox', class: 'so-www-cb', checked: !taken && draft.www !== false, disabled: taken, 'data-zn-key': (keyPrefix || 'nh') + 'www' });
    cb.addEventListener('change', () => { draft.www = cb.checked; });
    return el('label', { class: 'zn-check so-www-check' + (taken ? ' so-www-taken' : ''), title: taken ? t('alias.www_taken', { host: 'www.' + str(zone && zone.domain) }) : t('alias.www_hint') }, [cb, t('alias.www_checkbox')]);
  }

  // ── Entry line tags: body limit + mTLS ──
  function entryTags(entry) {
    if (!entry || entry.route_type === 'l4') return [];
    const out = [];
    const mb = bodyLimitOf(entry);
    if (mb > 0) {
      out.push(el('span', { class: 'tag tag-grey zn-opt-tag so-body-tag', title: t('body_limit.tag_hint', { mb }), dataset: { maxBody: String(mb) } }, [bodyLimitLabel(mb, t)]));
    }
    if (mtlsActive(entry)) {
      out.push(el('span', { class: 'tag tag-blue zn-opt-tag so-mtls-tag', title: t('mtls.tag_hint'), dataset: { mtls: 'on' } }, [icon('lock', 10), t('mtls.tag')]));
    }
    return out;
  }

  // ── TLS profile: select in the domain dialog head (PUT defaults) ──
  function tlsProfileControl(zone, opts) {
    const o = opts || {};
    const current = zoneTlsMin(zone);
    const sel = el('select', { class: 'form-select zn-select so-tls-min', 'aria-label': t('tls_profile.label'), 'data-zn-key': 'tlsmin' },
      TLS_VERSIONS.map((v) => el('option', { value: v, text: t(v === '1.3' ? 'tls_profile.v13' : 'tls_profile.v12') })));
    sel.value = current;
    sel.addEventListener('change', async () => {
      const next = sel.value;
      if (next === current) return;
      const ok = await confirmTlsProfile(zone, next);
      if (!ok) { sel.value = current; return; }
      sel.disabled = true;
      try {
        await call(win.api.put('/api/v1/domains/' + zone.domain_id + '/defaults', { tls_min_version: next }));
        toast(t('tls_profile.saved', { domain: str(zone.domain), version: next }), 'success');
        if (o.onChanged) o.onChanged(next);
      } catch (e) {
        sel.value = current;
        toast(errMsg(e), 'error');
      } finally { sel.disabled = false; }
    });
    return el('div', { class: 'zn-field so-tls-profile', dataset: { tlsMin: current } }, [
      el('span', { class: 'form-label', text: t('tls_profile.label') }),
      sel,
      el('span', { class: 'form-hint so-tls-hint', text: t('tls_profile.hint') }),
    ]);
  }
  function confirmTlsProfile(zone, next) {
    const d = dialog({ title: t('tls_profile.confirm_title'), kind: 'tls-profile' });
    const up = next === '1.3';
    d.body.appendChild(el('p', { class: 'zn-dialog-msg', text: t(up ? 'tls_profile.confirm_13' : 'tls_profile.confirm_12', { domain: str(zone.domain) }) }));
    if (up) d.body.appendChild(el('div', { class: 'so-warn', role: 'alert' }, [icon('alert', 14), el('span', { text: t('tls_profile.confirm_13_detail') })]));
    const ok = el('button', { type: 'button', class: 'btn btn-primary so-btn-ok', text: t('tls_profile.confirm_ok'), on: { click: () => d.close(true) } });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(false) } }));
    d.foot.appendChild(ok);
    ok.focus();
    return d.promise.then((r) => r === true);
  }

  return Object.assign(pure, {
    t, el, icon, dialog, errMsg, errorText, aliasTags, aliasMenuItem, openAliasDialog, pausedNotice,
    wwwCheckbox, entryTags, tlsProfileControl, confirmTlsProfile,
  });
});
