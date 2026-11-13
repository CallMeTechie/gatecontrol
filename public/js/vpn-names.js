'use strict';

// "Name im VPN" with the device (Peers, Gateways).
//
// Every VPN device can have a name: <name>.<zone>. The zone is chosen in
// Einstellungen › VPN & Netzwerk ("Namen im VPN", services/vpnNames.js) — a
// subdomain of an own domain, with the legacy zone (gc.internal) staying as
// the second spelling. The page hands zones and reserved names over in a JSON
// island (#vpn-names-data, partials/vpn-names-data.njk); the strings (vn.*)
// are in the string island of the page (#pl-i18n on Peers, #gwiz-i18n on
// Gateways).
//
//   GCVpnNames.cfg                       { primary, legacy, custom, licensed }
//   GCVpnNames.line(device, opts)        → [nodes] name + copy button, origin
//                                          line; without a name the offer to
//                                          give one (opts.onAssign)
//   GCVpnNames.chip(hostname)            → node: name + copy button only
//   GCVpnNames.gatewayNote()             → node: "only the server reaches this
//                                          name" + link to Domains / Routen
//   GCVpnNames.field(opts)               → the dialog field (label, input with
//                                          the fixed ending, hint that says
//                                          what is wrong and suggests a name)
//   GCVpnNames.suggest(text), .check(…)  the rules, as the server has them
//
// DOM is built with textContent only — never from HTML strings.
(function () {
  var data = {};
  try { data = JSON.parse((document.getElementById('vpn-names-data') || {}).textContent || '{}') || {}; } catch (e) { data = {}; }
  var STR = {};
  ['pl-i18n', 'gwiz-i18n'].forEach(function (id) {
    var node = document.getElementById(id);
    if (!node) return;
    try { Object.assign(STR, JSON.parse(node.textContent || '{}')); } catch (e) { /* keys stay visible */ }
  });
  var cfg = {
    primary: data.primary || 'gc.internal',
    legacy: data.legacy || 'gc.internal',
    custom: !!data.custom,
    licensed: !!data.licensed,
  };
  var RESERVED = {};
  (data.reserved || []).forEach(function (n) { RESERVED[n] = true; });
  var LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  function t(key, params) {
    var s = STR[key] != null ? STR[key] : key;
    Object.keys(params || {}).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // "… {{a}} … {{b}} …" → text nodes; names to type or copy stand out as <code>
  var CODE = { suggestion: true, fqdn: true, legacy: true };
  function rich(node, key, params) {
    var s = STR[key] != null ? STR[key] : key;
    s.split(/(\{\{\w+\}\})/).forEach(function (part) {
      var m = /^\{\{(\w+)\}\}$/.exec(part);
      if (m && params && params[m[1]] != null) node.appendChild(CODE[m[1]] ? h('code', null, String(params[m[1]])) : document.createTextNode(String(params[m[1]])));
      else if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }
  function copyIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '14'], ['height', '14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach(function (a) { svg.setAttribute(a[0], a[1]); });
    var r = document.createElementNS(NS, 'rect');
    [['x', '9'], ['y', '9'], ['width', '11'], ['height', '11'], ['rx', '2']].forEach(function (a) { r.setAttribute(a[0], a[1]); });
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M5 15V6a2 2 0 0 1 2-2h9');
    svg.appendChild(r); svg.appendChild(p);
    return svg;
  }
  function copy(text) {
    function done() { if (window.showToast) window.showToast(t('vn.copied', { name: text })); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.readOnly = true; ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function fqdn(hostname, zone) { return String(hostname).toLowerCase() + '.' + (zone || cfg.primary); }

  /** name + ending (muted) + copy button */
  function chip(hostname, extraClass) {
    var full = fqdn(hostname);
    var box = h('div', 'vn-name' + (extraClass ? ' ' + extraClass : ''));
    box.dataset.vnName = full;
    var code = h('code', null, String(hostname).toLowerCase());
    code.appendChild(h('i', null, '.' + cfg.primary));
    var b = h('button', 'vn-copy');
    b.type = 'button';
    b.title = t('vn.copy');
    b.setAttribute('aria-label', t('vn.copy_name', { name: full }));
    b.appendChild(copyIcon());
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); copy(full); });
    box.appendChild(code);
    box.appendChild(b);
    return box;
  }
  /**
   * The note at the name of a gateway. The name resolves for every device, but
   * the tunnel of a gateway only lets the server in (services/gateways.js,
   * buildEnvContent: WG_ALLOWED_IPS is the server alone), so no other VPN
   * device gets an answer. What is behind the gateway is reached with a route.
   */
  function gatewayNote(extraClass) {
    var n = h('div', 'vn-src vn-gw-note' + (extraClass ? ' ' + extraClass : ''));
    n.appendChild(h('span', null, t('vn.gw_note')));
    var a = h('a', 'vn-link', t('vn.gw_note_link'));
    a.href = '/routes';
    n.appendChild(a);
    return n;
  }
  function sourceText(source) {
    return source === 'admin' ? t('vn.src_admin') : (source === 'agent' || source === 'stale') ? t('vn.src_agent') : '';
  }
  /**
   * The lines of a device card: with a name the chip and where the name comes
   * from ("veraltet" = from a restored backup, not confirmed since); without
   * one the offer to give one. Without the licence a missing name shows nothing.
   */
  function line(device, opts) {
    opts = opts || {};
    var name = device && device.hostname;
    if (!name) {
      if (!cfg.licensed || !opts.onAssign) return [];
      var none = h('div', 'vn-name vn-none');
      none.appendChild(h('span', null, t('vn.none')));
      var a = h('button', 'vn-link', t('vn.assign'));
      a.type = 'button';
      a.addEventListener('click', function (e) { e.preventDefault(); opts.onAssign(device); });
      none.appendChild(a);
      return [none];
    }
    var out = [chip(name)];
    var src = sourceText(device.hostname_source);
    if (src && !opts.noSource) {
      var s = h('div', 'vn-src', src);
      s.dataset.source = device.hostname_source;
      if (device.hostname_source === 'stale') {
        var tag = h('span', 'tag tag-amber vn-stale', t('vn.stale'));
        tag.title = t('vn.stale_hint');
        s.appendChild(tag);
      }
      out.push(s);
    }
    return out;
  }

  // ── The rules (services/dns.js: HOSTNAME_RE, RESERVED_HOSTNAMES, suggestHostname) ──
  // one pass over a bounded input, no regular expression (as on the server)
  function trimHyphens(s) {
    var a = 0; var b = s.length;
    while (a < b && s.charAt(a) === '-') a++;
    while (b > a && s.charAt(b - 1) === '-') b--;
    return s.slice(a, b);
  }
  function suggest(input) {
    var raw = String(input == null ? '' : input).slice(0, 255);
    try { raw = raw.normalize('NFKD'); } catch (e) { /* old browser */ }
    raw = raw.toLowerCase();
    var out = '';
    var gap = false;
    for (var i = 0; i < raw.length && out.length < 63; i++) {
      var c = raw.charCodeAt(i);
      if (c >= 0x0300 && c <= 0x036f) continue;
      var keep = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
      if (!keep) { gap = true; continue; }
      if (gap && out) out += '-';
      gap = false;
      out += raw.charAt(i);
    }
    var s = trimHyphens(out.slice(0, 63));
    if (!s || !LABEL_RE.test(s)) return null;
    if (RESERVED[s]) return trimHyphens(s.slice(0, 61)) + '-2';
    return s;
  }
  function freeSuffix(name, taken) {
    for (var n = 2; n < 100; n++) {
      var c = trimHyphens(name.slice(0, 63 - String(n).length - 1)) + '-' + n;
      if (!taken[c] && !RESERVED[c]) return c;
    }
    return null;
  }
  /**
   * → { state: 'empty' | 'ok' | 'invalid' | 'reserved' | 'taken', name, suggestion?, owner? }
   * others: [{ hostname, name }] — the other devices the page knows.
   */
  function check(value, others) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return { state: 'empty', name: '' };
    var name = raw.toLowerCase();
    if (!LABEL_RE.test(name)) return { state: 'invalid', name: name, suggestion: suggest(raw) };
    if (RESERVED[name]) return { state: 'reserved', name: name, suggestion: suggest(name) };
    var taken = {};
    var owner = null;
    (others || []).forEach(function (o) {
      if (!o.hostname) return;
      var hn = String(o.hostname).toLowerCase();
      taken[hn] = true;
      if (hn === name) owner = o.name;
    });
    if (owner != null) return { state: 'taken', name: name, owner: owner, suggestion: freeSuffix(name, taken) };
    return { state: 'ok', name: name };
  }

  /**
   * The dialog field "Name im VPN".
   *   opts.id            id of the input
   *   opts.input         an existing input to use (the peer dialogs render it)
   *   opts.suffix/.hint/.badge  existing nodes next to it (else created)
   *   opts.saveBtn       disabled while the name cannot be saved
   *   opts.others()      → [{ hostname, name }] the other devices
   *   opts.gateway       the device is a gateway: the note that only the
   *                      server reaches the name stands below the hint
   * → { root, input, set(device), value(), valid(), serverError(res) }
   */
  function field(opts) {
    opts = opts || {};
    var input = opts.input;
    var root = null;
    var suffix = opts.suffix;
    var hint = opts.hint;
    var badge = opts.badge;
    if (!input) {
      root = h('div', 'form-group vn-field');
      var label = h('label', 'form-label', t('vn.label') + ' ');
      label.htmlFor = opts.id;
      badge = h('span', 'tag tag-grey vn-badge');
      badge.hidden = true;
      label.appendChild(badge);
      input = h('input', 'form-input');
      input.type = 'text'; input.id = opts.id; input.maxLength = 63;
      input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'none');
      suffix = h('span', 'vn-suf');
      var grp = h('div', 'vn-grp');
      grp.appendChild(input); grp.appendChild(suffix);
      hint = h('small', 'form-hint vn-hint');
      hint.id = opts.id + '-hint';
      input.setAttribute('aria-describedby', hint.id);
      root.appendChild(label); root.appendChild(grp); root.appendChild(hint);
      if (opts.gateway) root.appendChild(gatewayNote());
    }
    var device = null;
    var server = null; // the server's refusal for exactly this value
    if (suffix) suffix.textContent = '.' + cfg.primary;
    input.placeholder = t('vn.placeholder');

    function others() { return typeof opts.others === 'function' ? (opts.others() || []) : []; }
    function state() {
      if (server && server.value === input.value.trim().toLowerCase()) return { state: 'server', name: server.value, error: server.error, suggestion: server.suggestion };
      return check(input.value, others().filter(function (o) { return !device || String(o.id) !== String(device.id); }));
    }
    function render() {
      var st = state();
      var bad = st.state !== 'ok' && st.state !== 'empty';
      var grpEl = input.closest('.vn-grp');
      if (grpEl) grpEl.classList.toggle('vn-err', bad);
      if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      if (opts.saveBtn) opts.saveBtn.disabled = bad;
      if (!hint) return st;
      hint.textContent = '';
      hint.classList.toggle('vn-hint-err', bad);
      hint.dataset.state = st.state;
      if (st.state === 'server') hint.textContent = st.error;
      else if (st.state === 'invalid') rich(hint, st.suggestion ? 'vn.err_invalid_suggest' : 'vn.err_invalid', { suggestion: st.suggestion });
      else if (st.state === 'reserved') rich(hint, st.suggestion ? 'vn.err_reserved_suggest' : 'vn.err_reserved', { name: st.name, suggestion: st.suggestion });
      else if (st.state === 'taken') rich(hint, st.suggestion ? 'vn.err_taken_suggest' : 'vn.err_taken', { name: st.name, owner: st.owner, suggestion: st.suggestion });
      else if (st.state === 'empty') hint.textContent = t('vn.hint_empty');
      else {
        rich(hint, cfg.custom ? 'vn.hint_ok_both' : 'vn.hint_ok', { fqdn: fqdn(st.name), legacy: fqdn(st.name, cfg.legacy) });
        var saved = device && device.hostname && String(device.hostname).toLowerCase() === st.name;
        if (saved && (device.hostname_source === 'agent' || device.hostname_source === 'stale')) {
          hint.appendChild(document.createElement('br'));
          hint.appendChild(document.createTextNode(t(device.hostname_source === 'stale' ? 'vn.hint_stale' : 'vn.hint_agent')));
        }
      }
      // a suggestion is taken over with a click
      if (bad && st.suggestion) {
        var use = h('button', 'vn-link vn-use', t('vn.use_suggestion'));
        use.type = 'button';
        use.addEventListener('click', function () { input.value = st.suggestion; server = null; render(); input.focus(); });
        hint.appendChild(document.createTextNode(' '));
        hint.appendChild(use);
      }
      return st;
    }
    input.addEventListener('input', function () { server = null; render(); });

    return {
      root: root,
      input: input,
      /** fill for a device ({ id, hostname, hostname_source }) or empty for a new one */
      set: function (d) {
        device = d || null;
        server = null;
        input.value = (d && d.hostname) || '';
        if (badge) {
          var src = d && d.hostname ? sourceText(d.hostname_source) : '';
          badge.textContent = d && d.hostname_source === 'stale' ? t('vn.stale') : src;
          badge.className = 'tag vn-badge ' + (d && d.hostname_source === 'stale' ? 'tag-amber' : 'tag-grey');
          badge.hidden = !src;
        }
        render();
      },
      value: function () { return input.value.trim().toLowerCase(); },
      changed: function () { return this.value() !== String((device && device.hostname) || '').toLowerCase(); },
      valid: function () { var s = state().state; return s === 'ok' || s === 'empty'; },
      /** show the server's answer to PATCH …/hostname ({ ok:false, error, suggestion }) at the field */
      serverError: function (res) {
        server = { value: input.value.trim().toLowerCase(), error: (res && res.error) || t('vn.err_generic'), suggestion: (res && res.suggestion) || null };
        render();
        input.focus();
      },
      render: render,
    };
  }

  window.GCVpnNames = { cfg: cfg, t: t, line: line, chip: chip, gatewayNote: gatewayNote, field: field, check: check, suggest: suggest, fqdn: fqdn, copy: copy };
})();
