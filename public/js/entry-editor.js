'use strict';

// ─── GateControl entry editor ("Weiterleitung bearbeiten") ─────────────────
// Standalone module behind the edit-route modal (partials/modals/route-edit.njk).
// Used by the domain-zones page (host-dialogs.js "Optionen", zones-page.js
// shield). Peers, users and domains are fetched here.
//
//   window.GCEntryEditor.open(routeOrId, { context: { host, zone }, onSaved,
//                                         onDeleted, onChanged, section, focus })
//   window.GCEntryEditor.close()
//
// Layout (docs/feature-domain-zones.md, "Eintrags-Editor"): header with type
// chip, "Weg der Verbindung", a section nav with one-line live summaries,
// sections Ziel & Ports / Zugriff / Anmeldung / Sicherheit / Zuverlässigkeit /
// Header / Branding / Diagnose and a footer with the change summary. Target,
// ports, protocol and type are editable for every entry (the former lockTarget
// mode is gone): inside a domain zone the gateway comes from the zone, the
// LAN address from the host (changed via PUT /hosts/:id), and the port is sent
// as target_port AND target_lan_port for gateway targets.
//
// Page requirements: app.js globals (api, openModal, closeModal, showError,
// hideError, showFieldErrors, clearFieldErrors, btnLoading, btnReset,
// showToast), window.GC (csrfToken, t), the route-edit.njk partial, and
// /js/vendor/qrcode.min.js + /js/routeDomain.js loaded before this file.
(function () {
  if (window.GCEntryEditor) return;

  var MODAL_ID = 'modal-edit-route';

  function T(key, fallback) {
    return (window.GC && window.GC.t && window.GC.t[key]) || fallback;
  }
  function byId(id) { return document.getElementById(id); }
  // In-app dialogs instead of confirm()/alert() (docs/feature-wave2.md §W1.2).
  var D = window.GCDialog;
  function dlgError(msg) { D.alert({ message: msg, danger: true }); }
  function warnColor() { return 'var(--amber)'; }

  // Tiny DOM builder so we never touch innerHTML (a hook blocks it).
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'dataset') Object.keys(props[k]).forEach(function (d) { node.dataset[d] = props[k][d]; });
        else if (k === 'style') node.setAttribute('style', props[k]);
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function shareFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    if (opts.method && opts.method !== 'GET') {
      opts.headers['X-CSRF-Token'] = window.GC.csrfToken;
    }
    return fetch(url, opts);
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
  }

  // Same TLD rule as the server's isPublicDomain (caddyTlsAutomation.js). Only
  // used when a route object comes without the list endpoint's domainIsPublic.
  var NON_PUBLIC_TLDS = ['test', 'local', 'invalid', 'internal', 'lan', 'home', 'localhost', 'corp'];
  function isPublicDomain(domain) {
    if (!domain) return false;
    var parts = String(domain).toLowerCase().split('.');
    return NON_PUBLIC_TLDS.indexOf(parts[parts.length - 1]) === -1;
  }

  function peerIp(p) {
    if (p.ip) return p.ip;
    return p.allowed_ips ? String(p.allowed_ips).split('/')[0] : '';
  }

  // ═══ Form helpers ═══════════════════════════════════════════════════════════

  function setToggleGroup(groupId, hiddenId, value) {
    var group = byId(groupId);
    var hidden = byId(hiddenId);
    if (!group || !hidden) return;
    hidden.value = value;
    group.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.classList.toggle('on', btn.dataset.value === value);
    });
  }

  function applyDomainContext(routeType, tlsMode, input, wrap, label, ctxHint) {
    if (!input) return;
    var isL4None = routeType === 'l4' && tlsMode === 'none';
    var row = wrap ? wrap.parentElement : null;
    if (isL4None) {
      if (wrap) wrap.style.display = 'none';
      if (row) row.classList.add('gc-row-collapsed');
      input.required = false;
      input.value = '';
      if (ctxHint) ctxHint.style.display = 'none';
    } else {
      if (wrap) wrap.style.display = '';
      if (row) row.classList.remove('gc-row-collapsed');
      input.required = true;
      var isSni = routeType === 'l4';
      var lt = label ? label.querySelector('.gc-label-text') : null;
      if (lt) lt.textContent = isSni ? T('routes.l4_sni_label', 'SNI hostname') : T('routes.domain', 'Domain');
      if (ctxHint) {
        if (isSni) { ctxHint.textContent = T('routes.l4_sni_required_hint', ''); ctxHint.style.display = ''; }
        else { ctxHint.style.display = 'none'; }
      }
    }
  }

  function updateTlsHint(selectId, hintId) {
    var select = byId(selectId);
    var hint = byId(hintId);
    if (!select || !hint) return;
    hint.textContent = hint.dataset['hint' + select.value.charAt(0).toUpperCase() + select.value.slice(1)] || '';
  }

  // ─── L4 blocked-port validation ──────────────────────────
  var PORT_SVC = { 22: 'SSH', 53: 'DNS', 80: 'Caddy HTTP', 443: 'Caddy HTTPS', 2019: 'Caddy Admin', 3000: 'GateControl', 51820: 'WireGuard' };
  function parsePortRangeClient(str) {
    if (!str || typeof str !== 'string') return null;
    var t = str.trim();
    var m = t.match(/^(\d+)-(\d+)$/);
    if (m) { var s = parseInt(m[1], 10), e = parseInt(m[2], 10); return (s >= 1 && e <= 65535 && s <= e) ? { start: s, end: e } : null; }
    if (/^\d+$/.test(t)) { var n = parseInt(t, 10); if (n >= 1 && n <= 65535) return { start: n, end: n }; }
    return null;
  }
  function firstBlockedPort(str, blocked) {
    var range = parsePortRangeClient(str);
    if (!range) return null;
    for (var p = range.start; p <= range.end; p++) { if (blocked.indexOf(p) !== -1) return p; }
    return null;
  }
  function checkListenPortBlocked(inputId, errId) {
    var input = byId(inputId);
    var errEl = byId(errId);
    if (!input) return true;
    var blocked = (input.dataset.blockedPorts || '').split(',').map(function (x) { return parseInt(x, 10); }).filter(function (n) { return !isNaN(n); });
    var hit = input.value ? firstBlockedPort(input.value, blocked) : null;
    if (hit != null) {
      input.classList.add('gc-port-error');
      if (errEl) {
        var svc = PORT_SVC[hit];
        var tpl = svc ? T('routes.l4_port_reserved', 'Port {port} is reserved ({service}).')
                      : T('routes.l4_port_reserved_generic', 'Port {port} is reserved by the system.');
        errEl.textContent = tpl.replace('{port}', hit).replace('{service}', svc || '');
        errEl.style.display = '';
      }
      return false;
    }
    input.classList.remove('gc-port-error');
    if (errEl) errEl.style.display = 'none';
    return true;
  }

  // ─── DNS check ──────────────────────────────────────────
  async function checkDns(domain, hintEl, inputEl) {
    if (!domain || !hintEl || !inputEl) return;
    var routeType = (byId('edit-route-type') || {}).value || 'http';
    if (routeType === 'l4') {
      hintEl.style.display = 'none';
      return;
    }
    var checking = inputEl.dataset.dnsChecking || 'Checking DNS...';
    var okMsg = inputEl.dataset.dnsOk || 'DNS OK';
    var warnTpl = inputEl.dataset.dnsWarning || 'Domain does not point to this server (expected: {{ip}})';
    hintEl.textContent = checking;
    hintEl.style.color = 'var(--text-3)';
    hintEl.style.display = '';
    try {
      var data = await window.api.post('/api/routes/check-dns', { domain: domain });
      if (!data || !data.ok) {
        hintEl.style.display = 'none';
        return;
      }
      if (data.resolves) {
        hintEl.textContent = okMsg;
        hintEl.style.color = 'var(--green, #4ade80)';
      } else if (data.expected) {
        hintEl.textContent = warnTpl.replace('{{ip}}', data.expected);
        hintEl.style.color = warnColor();
      } else {
        hintEl.style.display = 'none';
      }
    } catch (_) {
      hintEl.style.display = 'none';
    }
  }

  // ─── User visibility checkboxes ──────────────────────────
  function renderUserCheckboxes(containerId, selectedIds, cbClass, users) {
    var container = byId(containerId);
    if (!container) return;
    var list = users || [];
    container.textContent = '';
    list.forEach(function (u) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = u.id;
      cb.className = cbClass || 'route-user-cb';
      cb.checked = (selectedIds || []).includes(u.id);
      cb.style.cssText = 'accent-color:var(--accent)';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(u.display_name || u.username));
      container.appendChild(label);
    });
    if (!list.length) {
      container.textContent = T('users.no_users', 'No users available');
      container.style.cssText = 'font-size:12px;color:var(--text-3)';
    }
  }

  // ─── ACL helpers ─────────────────────────────────────────
  function renderAclPeerChecklist(prefix, selectedPeerIds, peers) {
    var list = byId(prefix + '-acl-peers-list');
    if (!list) return;
    list.textContent = '';
    var selected = new Set((selectedPeerIds || []).map(Number));
    (peers || []).forEach(function (p) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;font-size:12px;border-radius:var(--radius-xs)';
      label.onmouseenter = function () { this.style.background = 'var(--bg-panel)'; };
      label.onmouseleave = function () { this.style.background = ''; };
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.id;
      cb.checked = selected.has(p.id);
      cb.dataset.aclPeer = prefix;
      cb.addEventListener('change', function () { updateAclHint(prefix); });
      label.appendChild(cb);
      var text = document.createElement('span');
      var status = p.isOnline ? ' (online)' : p.enabled ? '' : ' (disabled)';
      text.textContent = p.name + ' — ' + (p.ip || '?') + status;
      text.style.cssText = 'font-family:var(--font-mono)';
      label.appendChild(text);
      list.appendChild(label);
    });
    updateAclHint(prefix);
  }

  function getSelectedAclPeers(prefix) {
    var list = byId(prefix + '-acl-peers-list');
    if (!list) return [];
    var cbs = list.querySelectorAll('input[type="checkbox"]:checked');
    var ids = [];
    for (var i = 0; i < cbs.length; i++) ids.push(Number(cbs[i].value));
    return ids;
  }

  function updateAclHint(prefix) {
    var hint = byId(prefix + '-acl-hint');
    if (!hint) return;
    var count = getSelectedAclPeers(prefix).length;
    if (count === 0) {
      hint.textContent = T('acl.no_peers_selected', 'No peers selected');
      hint.style.color = warnColor();
    } else {
      hint.textContent = T('acl.peers_selected', '{{count}} peer(s) allowed').replace('{{count}}', count);
      hint.style.color = 'var(--green, #4ade80)';
    }
  }

  // getPeers: () => peers[] — read at click time so late peer loads are seen.
  function setupAclToggle(prefix, getPeers) {
    var toggle = byId(prefix + '-route-acl');
    var fields = byId(prefix + '-acl-fields');
    if (!toggle) return;
    // Set up ARIA and visual toggle ourselves (app.js skips data-managed)
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-checked', toggle.classList.contains('on') ? 'true' : 'false');
    toggle.addEventListener('click', function () {
      toggle.classList.toggle('on');
      var isOn = toggle.classList.contains('on');
      toggle.setAttribute('aria-checked', isOn ? 'true' : 'false');
      if (fields) fields.style.display = isOn ? '' : 'none';
      if (isOn) renderAclPeerChecklist(prefix, [], getPeers ? getPeers() : []);
    });
    toggle.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle.click(); }
    });
  }

  // ─── IP filter helpers ───────────────────────────────────
  // rulesArr is mutated in place; the caller keeps the reference.
  function setupIpFilter(prefix, rulesArr) {
    var toggle = byId(prefix + '-route-ip-filter');
    var fields = byId(prefix + '-ip-filter-fields');
    var modeGroup = byId(prefix + '-ip-filter-mode-group');
    var addBtn = byId(prefix + '-ip-filter-add');

    if (toggle) toggle.addEventListener('click', function () {
      setTimeout(function () {
        if (fields) fields.style.display = toggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });

    if (modeGroup) modeGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        modeGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        byId(prefix + '-ip-filter-mode').value = btn.dataset.value;
      });
    });

    if (addBtn) addBtn.addEventListener('click', function () {
      var input = byId(prefix + '-ip-filter-input');
      var typeSelect = byId(prefix + '-ip-filter-type');
      var val = input.value.trim();
      if (!val) return;
      rulesArr.push({ type: typeSelect.value, value: val });
      input.value = '';
      renderIpFilterRules(prefix, rulesArr);
    });
  }

  function renderIpFilterRules(prefix, rulesArr) {
    var list = byId(prefix + '-ip-filter-rules-list');
    if (!list) return;
    list.textContent = '';
    rulesArr.forEach(function (rule, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:12px';
      var label = document.createElement('span');
      label.style.cssText = 'flex:1;font-family:var(--font-mono)';
      label.textContent = '[' + rule.type.toUpperCase() + '] ' + rule.value;
      row.appendChild(label);
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.style.cssText = 'background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px';
      del.addEventListener('click', function () { rulesArr.splice(idx, 1); renderIpFilterRules(prefix, rulesArr); });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  // ─── External-block visibility ───────────────────────────
  function syncBlockVisibility(prefix) {
    var ext = byId(prefix + '-route-external');
    var wrap = byId(prefix + '-route-block-wrap');
    var action = byId(prefix + '-route-block-action');
    var body = byId(prefix + '-route-block-body');
    var redir = byId(prefix + '-route-block-redirect');
    if (!wrap || !action) return;
    var internalOnly = !(ext && ext.classList.contains('on'));
    wrap.style.display = internalOnly ? '' : 'none';
    if (body) body.style.display = action.value === 'custom' ? '' : 'none';
    if (redir) redir.style.display = action.value === 'redirect' ? '' : 'none';
  }

  // L4 IP filter: which of the two mode hints is shown. `allow` only lets the
  // list through, `deny` closes exactly the list — the difference decides
  // whether a forgotten entry locks the admin out, so it is spelled out.
  function updateL4FilterModeHint() {
    var hint = byId('edit-l4-ip-filter-mode-hint');
    if (!hint) return;
    var mode = (byId('edit-l4-ip-filter-mode') || {}).value || 'whitelist';
    var key = (mode === 'blacklist' || mode === 'deny') ? 'deny' : 'allow';
    hint.textContent = hint.dataset['hint' + key.charAt(0).toUpperCase() + key.slice(1)] || '';
  }

  // Bot blocker: mode-switch field visibility
  function updateBotBlockerFields(prefix) {
    var mode = (byId(prefix + '-bot-blocker-mode') || {}).value || 'block';
    var redirectDiv = byId(prefix + '-bot-blocker-redirect');
    var customDiv = byId(prefix + '-bot-blocker-custom');
    if (redirectDiv) redirectDiv.style.display = mode === 'redirect' ? '' : 'none';
    if (customDiv) customDiv.style.display = mode === 'custom' ? '' : 'none';
  }

  // ─── Access-window rule builder ──────────────────────────
  function accessFmtBounds(rule) {
    var parts = [];
    if (rule.valid_from) parts.push(T('access.valid_from', 'Valid from') + ': ' + rule.valid_from);
    if (rule.valid_until) parts.push(T('access.valid_until', 'Valid until') + ': ' + rule.valid_until);
    return parts.join(' · ');
  }

  // Week order (Mo..So). Used to map day codes to indices for contiguity
  // detection when building the server-side schedule string.
  var ACCESS_DAY_CODES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Builds the legacy `Mo-Fr 09:00-17:00` schedule string the server parser
  // still expects. `dayCodes` is a subset of ACCESS_DAY_CODES in week order.
  // Contiguous (length > 1) → range; single → one day; non-contiguous → list.
  function buildScheduleString(dayCodes, from, to) {
    if (!dayCodes || !dayCodes.length) return '';
    var idx = dayCodes.map(function (d) { return ACCESS_DAY_CODES.indexOf(d); });
    var first = idx[0];
    var last = idx[idx.length - 1];
    var contiguous = (last - first) === (idx.length - 1);
    if (dayCodes.length > 1 && contiguous) {
      return ACCESS_DAY_CODES[first] + '-' + ACCESS_DAY_CODES[last] + ' ' + from + '-' + to;
    }
    if (dayCodes.length === 1) {
      return dayCodes[0] + ' ' + from + '-' + to;
    }
    return dayCodes.map(function (d) { return d + ' ' + from + '-' + to; }).join('; ');
  }

  // Access-rule builder of the edit modal's access-window section. Renders labelled controls (mode toggle, day multi-select, time +
  // date pickers, optional label), validates, builds the schedule string and
  // invokes onAdd({ mode, schedule, valid_from, valid_until, label }). On a
  // successful add (onAdd returns a non-false value) the day/time/date/label
  // controls reset. Safe-DOM only (el()/textContent — never innerHTML).
  function renderAccessRuleForm(container, onAdd) {
    if (!container) return;
    container.textContent = '';

    function lbl(key, fallback) {
      return el('label', { class: 'form-label' }, [T(key, fallback)]);
    }
    function lblOpt(key, fallback) {
      return el('label', { class: 'form-label' }, [
        T(key, fallback) + ' (' + T('access.optional', 'optional') + ')',
      ]);
    }

    // Mode toggle (single-select).
    var selectedMode = 'allow';
    var modeAllowBtn = el('button', { type: 'button', class: 'toggle-btn on', text: T('access.mode_allow', 'Allow') });
    var modeBlockBtn = el('button', { type: 'button', class: 'toggle-btn', text: T('access.mode_block', 'Block') });
    function selectMode(mode) {
      selectedMode = mode;
      modeAllowBtn.className = 'toggle-btn' + (mode === 'allow' ? ' on' : '');
      modeBlockBtn.className = 'toggle-btn' + (mode === 'block' ? ' on' : '');
    }
    modeAllowBtn.addEventListener('click', function () { selectMode('allow'); });
    modeBlockBtn.addEventListener('click', function () { selectMode('block'); });
    var modeGroup = el('div', { class: 'toggle-group' }, [modeAllowBtn, modeBlockBtn]);

    // Day multi-select toggles (Mo..So).
    var dayBtns = ACCESS_DAY_CODES.map(function (code) {
      var btn = el('button', { type: 'button', class: 'toggle-btn', text: code });
      btn.dataset.day = code;
      btn.addEventListener('click', function () {
        if (btn.className.indexOf('on') >= 0) btn.className = 'toggle-btn';
        else btn.className = 'toggle-btn on';
      });
      return btn;
    });
    var dayGroup = el('div', { class: 'toggle-group' }, dayBtns);
    function selectedDays() {
      return dayBtns.filter(function (b) { return b.className.indexOf('on') >= 0; })
        .map(function (b) { return b.dataset.day; });
    }

    var fromTime = el('input', { type: 'time', class: 'form-input' });
    var toTime = el('input', { type: 'time', class: 'form-input' });
    var fromDate = el('input', { type: 'date', class: 'form-input' });
    var untilDate = el('input', { type: 'date', class: 'form-input' });
    var labelInput = el('input', { type: 'text', class: 'form-input', maxlength: '120' });

    var errBox = el('small', { class: 'form-hint', style: 'display:none;color:var(--red,#e5484d)' });
    var addBtn = el('button', { type: 'button', class: 'btn btn-sm', text: T('access.add_rule', 'Add rule') });

    addBtn.addEventListener('click', function () {
      errBox.style.display = 'none';
      errBox.textContent = '';
      var days = selectedDays();
      if (!days.length) {
        errBox.textContent = T('access.err_days', 'Select at least one day');
        errBox.style.display = '';
        return;
      }
      var von = fromTime.value;
      var bis = toTime.value;
      if (!von || !bis) {
        errBox.textContent = T('access.err_time', 'Select a from and to time');
        errBox.style.display = '';
        return;
      }
      var ok = onAdd({
        mode: selectedMode,
        schedule: buildScheduleString(days, von, bis),
        valid_from: fromDate.value || null,
        valid_until: untilDate.value || null,
        label: labelInput.value.trim() || null,
      });
      // onAdd may be async/POST-based (returns undefined) or sync (returns
      // truthy). Only block reset on an explicit false.
      if (ok === false) return;
      dayBtns.forEach(function (b) { b.className = 'toggle-btn'; });
      fromTime.value = '';
      toTime.value = '';
      fromDate.value = '';
      untilDate.value = '';
      labelInput.value = '';
    });

    container.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:8px' }, [
      el('div', { class: 'form-group' }, [lbl('access.mode', 'Mode'), modeGroup]),
      el('div', { class: 'form-group' }, [lbl('access.days', 'Days'), dayGroup]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [lbl('access.time_from', 'From'), fromTime]),
        el('div', { class: 'form-group' }, [lbl('access.time_to', 'To'), toTime]),
      ]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [lblOpt('access.valid_from', 'Valid from'), fromDate]),
        el('div', { class: 'form-group' }, [lblOpt('access.valid_until', 'Valid until'), untilDate]),
      ]),
      el('div', { class: 'form-group' }, [lblOpt('access.label', 'Label'), labelInput]),
      el('div', {}, [addBtn]),
      errBox,
    ]));
  }

  // ─── Inline-Help Tooltips (gc-tip) ───────────────────────
  // Page-wide: serves the edit modal's tips. Bound once per page even if the
  // script is loaded twice.
  (function setupGcTips() {
    if (window.__gcTipsBound) return;
    window.__gcTipsBound = true;
    var bubble = byId('gc-tip-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'gc-tip-bubble';
      document.body.appendChild(bubble);
    }
    function show(tip) {
      var text = tip.getAttribute('data-tip');
      if (!text) return;
      bubble.textContent = text;
      bubble.style.display = 'block';
      var r = tip.getBoundingClientRect();
      var bb = bubble.getBoundingClientRect();
      var top = r.bottom + 6;
      if (top + bb.height > window.innerHeight - 8) top = r.top - bb.height - 6;
      var left = r.left + r.width / 2 - bb.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - bb.width - 8));
      bubble.style.top = top + 'px';
      bubble.style.left = left + 'px';
    }
    function hide() { bubble.style.display = 'none'; }
    function tipFrom(e) { return e.target && e.target.closest ? e.target.closest('.gc-tip') : null; }
    document.addEventListener('mouseover', function (e) { var t = tipFrom(e); if (t) show(t); });
    document.addEventListener('mouseout', function (e) { if (tipFrom(e)) hide(); });
    document.addEventListener('focusin', function (e) { var t = tipFrom(e); if (t) show(t); });
    document.addEventListener('focusout', function (e) { if (tipFrom(e)) hide(); });
    document.addEventListener('click', function (e) {
      var t = tipFrom(e);
      if (t) { e.preventDefault(); if (bubble.style.display === 'block') hide(); else show(t); }
      else if (e.target !== bubble) hide();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  })();

  // ═══ Editor state ══════════════════════════════════════════════════════════

  var state = {
    route: null,        // route object the modal was opened with
    opts: {},
    ctx: null,          // { host, zone } of the zones page (null outside a zone)
    zoneManaged: false, // target comes from the zone (gateway/pool/peer)
    section: 'target',
    snapshot: null,     // form values right after open (change summary)
    peers: [],          // GET /api/routes/peers
    users: null,        // GET /api/v1/users (cached per page)
    seq: 0,             // open() generation — stale async work checks it
  };
  var pendingTotpSecret = null;
  var editIpFilterRules = [];
  var editMirrorTargets = [];
  var editBackendsList = [];
  var editHeadersRequest = [];
  var editHeadersResponse = [];
  var currentEditRouteId = null;

  function isOpen() {
    var overlay = byId(MODAL_ID);
    return !!(overlay && overlay.style.display !== 'none');
  }

  function callOpt(name, arg) {
    var fn = state.opts && state.opts[name];
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (err) { console.error('GCEntryEditor ' + name + ' callback failed:', err); }
  }

  async function loadPeers() {
    try {
      var data = await window.api.get('/api/routes/peers');
      if (data && data.ok) state.peers = data.peers || [];
    } catch (err) {
      console.error('GCEntryEditor: failed to load peers:', err);
    }
    return state.peers;
  }

  async function loadUsers() {
    if (state.users) return state.users;
    try {
      var data = await window.api.get('/api/v1/users');
      state.users = data.users || [];
    } catch (_) { return []; }
    return state.users;
  }

  function renderEditPeerOptions(select, selectedId) {
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: '—' }));
    state.peers.forEach(function (p) {
      var status = p.isOnline ? ' (online)' : p.enabled ? '' : ' (disabled)';
      var opt = el('option', { value: String(p.id), text: p.name + ' — ' + (p.ip || '?') + status });
      if (String(selectedId) === String(p.id)) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function renderEditGatewayOptions(select, selectedId) {
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: '—' }));
    state.peers.filter(function (p) { return p.peer_type === 'gateway'; }).forEach(function (p) {
      var opt = el('option', { value: String(p.id), text: p.name });
      if (String(selectedId || '') === String(p.id)) opt.selected = true;
      select.appendChild(opt);
    });
  }

  // Peer <select> for backend / mirror rows: "name (ip)".
  function buildRowPeerSelect(selectedPeerId, cssText, onChange) {
    var sel = el('select', { style: cssText });
    sel.appendChild(el('option', { value: '', text: '—' }));
    state.peers.forEach(function (p) {
      var opt = el('option', { value: String(p.id), text: p.name + ' (' + peerIp(p) + ')' });
      if (p.id === selectedPeerId || String(p.id) === String(selectedPeerId)) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', onChange);
    return sel;
  }

  // ═══ Route auth UI ═════════════════════════════════════════════════════════

  function updateRouteAuthMethodUI() {
    var method = (byId('edit-ra-method') || {}).value || 'email_password';
    var ra2fa = byId('edit-ra-2fa');
    var is2fa = !!(ra2fa && ra2fa.classList.contains('on'));
    var singleView = byId('edit-ra-single-factor');
    var tfaView = byId('edit-ra-2fa-view');
    var sfEmail = byId('edit-ra-email');
    var tfaEmail = byId('edit-ra-2fa-email');
    var sfPass = byId('edit-ra-password');
    var tfaPass = byId('edit-ra-2fa-password');

    if (is2fa) {
      if (singleView) singleView.style.display = 'none';
      if (tfaView) tfaView.style.display = '';
      // Carry email/password over from the single-factor fields if empty
      if (sfEmail && tfaEmail && !tfaEmail.value && sfEmail.value) tfaEmail.value = sfEmail.value;
      if (sfPass && tfaPass && !tfaPass.value && sfPass.value) tfaPass.value = sfPass.value;
      update2faMethodUI();
    } else {
      if (singleView) singleView.style.display = '';
      if (tfaView) tfaView.style.display = 'none';
      if (tfaEmail && sfEmail && !sfEmail.value && tfaEmail.value) sfEmail.value = tfaEmail.value;
      if (tfaPass && sfPass && !sfPass.value && tfaPass.value) sfPass.value = tfaPass.value;
      updateSingleFactorUI(method);
    }
  }

  function updateSingleFactorUI(method) {
    var emailGroup = byId('edit-ra-sf-email-group');
    var passwordGroup = byId('edit-ra-sf-password-group');
    var totpGroup = byId('edit-ra-sf-totp-group');
    var showEmail = method !== 'totp';
    var showPassword = method !== 'totp' && method !== 'email_code';
    if (emailGroup) emailGroup.style.display = showEmail ? '' : 'none';
    if (passwordGroup) passwordGroup.style.display = showPassword ? '' : 'none';
    if (totpGroup) totpGroup.style.display = method === 'totp' ? '' : 'none';
  }

  function update2faMethodUI() {
    var method = (byId('edit-ra-method') || {}).value || 'email_code';
    var emailHint = byId('edit-ra-2fa-email-hint');
    var totpGroup = byId('edit-ra-2fa-totp-group');
    var label = byId('edit-ra-2fa-factor2-label');
    if (method === 'totp') {
      if (emailHint) emailHint.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
      if (label) label.textContent = label.dataset.totp || 'Factor 2 — TOTP (Authenticator)';
    } else {
      if (emailHint) emailHint.style.display = '';
      if (totpGroup) totpGroup.style.display = 'none';
      if (label) label.textContent = label.dataset.email || 'Factor 2 — Email Code';
    }
  }

  function updateEditAuthTypeUI() {
    var authType = (byId('edit-auth-type') || {}).value || 'none';
    var basicFields = byId('edit-basic-auth-fields');
    var routeAuthFields = byId('edit-route-auth-fields');
    if (basicFields) basicFields.style.display = authType === 'basic' ? 'block' : 'none';
    if (routeAuthFields) routeAuthFields.style.display = authType === 'route' ? 'block' : 'none';
    if (authType === 'route') updateRouteAuthMethodUI();
  }

  // Toggle the route-auth credential selector vs. a read-only "share managed"
  // note. The note element is created on demand (it is not in the template).
  function setRouteAuthShareManaged(managed) {
    var fields = byId('edit-route-auth-fields');
    if (!fields) return;
    var single = byId('edit-ra-single-factor');
    var twoFa = byId('edit-ra-2fa-view');
    var note = byId('edit-ra-share-managed-note');
    if (managed) {
      if (single) single.style.display = 'none';
      if (twoFa) twoFa.style.display = 'none';
      if (!note) {
        note = el('div', {
          id: 'edit-ra-share-managed-note',
          class: 'form-hint',
          style: 'margin:8px 0',
          text: T('route_auth.share_managed', 'Managed by share links'),
        });
        fields.appendChild(note);
      } else {
        note.textContent = T('route_auth.share_managed', 'Managed by share links');
        note.style.display = '';
      }
    } else {
      if (single) single.style.display = '';
      if (note) note.style.display = 'none';
    }
  }

  function bindToggleButtons(groupId, onPick) {
    var group = byId(groupId);
    if (!group) return;
    group.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        group.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        onPick(btn.dataset.value);
      });
    });
  }

  function setupAuthControls() {
    bindToggleButtons('edit-auth-type-group', function (v) {
      byId('edit-auth-type').value = v;
      updateEditAuthTypeUI();
    });
    bindToggleButtons('edit-ra-method-group', function (v) {
      byId('edit-ra-method').value = v;
      updateSingleFactorUI(v);
    });
    bindToggleButtons('edit-ra-2fa-method-group', function (v) {
      byId('edit-ra-method').value = v;
      update2faMethodUI();
    });
    var ra2faToggle = byId('edit-ra-2fa');
    if (ra2faToggle) {
      ra2faToggle.addEventListener('click', function () {
        ra2faToggle.classList.toggle('on');
        // When enabling 2FA, default Factor 2 to email_code
        if (ra2faToggle.classList.contains('on')) {
          var currentMethod = (byId('edit-ra-method') || {}).value || 'email_password';
          var f2 = currentMethod === 'email_password' ? 'email_code' : currentMethod;
          byId('edit-ra-method').value = f2;
          setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', f2);
        }
        updateRouteAuthMethodUI();
      });
    }
    // Single factor TOTP
    setupTotpGenerate('btn-ra-totp-generate', 'edit-ra-totp-secret', 'edit-ra-totp-qr', 'edit-ra-totp-verify');
    setupTotpConfirm('btn-ra-totp-confirm', 'edit-ra-totp-code', 'edit-ra-totp-status');
    // 2FA TOTP
    setupTotpGenerate('btn-ra-2fa-totp-generate', 'edit-ra-2fa-totp-secret', 'edit-ra-2fa-totp-qr', 'edit-ra-2fa-totp-verify');
    setupTotpConfirm('btn-ra-2fa-totp-confirm', 'edit-ra-2fa-totp-code', 'edit-ra-2fa-totp-status');
  }

  function setupTotpGenerate(btnId, secretElId, qrElId, verifyElId) {
    var btn = byId(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var routeId = (byId('edit-route-id') || {}).value;
      if (!routeId) return;
      window.btnLoading(btn);
      try {
        var data = await window.api.post('/api/routes/' + routeId + '/auth/totp-setup', {});
        if (data.ok && data.data) {
          pendingTotpSecret = data.data.secret;
          var secretEl = byId(secretElId);
          if (secretEl) { secretEl.textContent = data.data.secret; secretEl.style.display = ''; }
          var qrEl = byId(qrElId);
          if (qrEl && data.data.uri) {
            qrEl.textContent = '';
            try {
              var qr = window.qrcode(0, 'M'); qr.addData(data.data.uri); qr.make();
              var img = document.createElement('img');
              img.src = qr.createDataURL(4, 4); img.alt = 'TOTP QR Code';
              img.style.cssText = 'display:block;margin:0 auto;border-radius:var(--radius-sm);';
              qrEl.appendChild(img);
            } catch (e) {
              var d = document.createElement('div');
              d.style.cssText = 'font-size:11px;color:var(--text-3);word-break:break-all;padding:6px';
              d.textContent = data.data.uri; qrEl.appendChild(d);
            }
            qrEl.style.display = '';
          }
          var verifyEl = byId(verifyElId);
          if (verifyEl) verifyEl.style.display = '';
        } else { dlgError(data.error || T('route_auth.totp_setup_failed', 'Failed to generate TOTP setup')); }
      } catch (err) { dlgError(err.message); } finally { window.btnReset(btn); }
    });
  }

  function setupTotpConfirm(btnId, codeElId, statusElId) {
    var btn = byId(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var routeId = (byId('edit-route-id') || {}).value;
      var code = ((byId(codeElId) || {}).value || '').trim();
      var statusEl = byId(statusElId);
      if (!routeId || !pendingTotpSecret || !code) return;
      window.btnLoading(btn);
      try {
        var data = await window.api.post('/api/routes/' + routeId + '/auth/totp-verify', { secret: pendingTotpSecret, token: code });
        if (statusEl) {
          statusEl.style.display = '';
          statusEl.style.color = data.ok ? 'var(--green)' : 'var(--red)';
          statusEl.textContent = data.ok ? 'TOTP verified successfully' : 'Invalid code. Try again.';
        }
      } catch (err) { dlgError(err.message); } finally { window.btnReset(btn); }
    });
  }

  // Reset the auth tab and fill it from GET /api/routes/:id/auth. A route can
  // carry two auth truths at once (basic_auth_enabled AND a route_auth row);
  // Caddy resolves this with Basic Auth winning (caddyConfig.js). The
  // "effective active method" mirrors that precedence and drives both the
  // SELECTED tab and the green indicator:
  //   basic_auth_enabled        -> 'basic'
  //   else route_auth row exists -> 'route'
  //   else                       -> 'none'
  async function populateAuth(route, id, seq) {
    setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'none');

    var ra2fa = byId('edit-ra-2fa');
    if (ra2fa) ra2fa.classList.remove('on');
    setToggleGroup('edit-ra-method-group', 'edit-ra-method', 'email_password');
    // 2FA F2 group shares the same hidden #edit-ra-method as the SF group.
    // Reset only its visual state — do NOT write the hidden value, that
    // would clobber the SF default and hide the password field on first open.
    var ra2faGroupReset = byId('edit-ra-2fa-method-group');
    if (ra2faGroupReset) {
      ra2faGroupReset.querySelectorAll('.toggle-btn').forEach(function (b) {
        b.classList.toggle('on', b.dataset.value === 'email_code');
      });
    }
    ['edit-ra-email', 'edit-ra-password', 'edit-ra-2fa-email', 'edit-ra-2fa-password'].forEach(function (fid) {
      var n = byId(fid); if (n) n.value = '';
    });
    var raDuration = byId('edit-ra-session-duration');
    if (raDuration) raDuration.value = '86400000';
    pendingTotpSecret = null;
    ['edit-ra-totp-secret', 'edit-ra-2fa-totp-secret', 'edit-ra-totp-qr', 'edit-ra-2fa-totp-qr',
      'edit-ra-totp-status', 'edit-ra-2fa-totp-status'].forEach(function (fid) {
      var n = byId(fid); if (n) { n.textContent = ''; n.style.display = 'none'; }
    });
    ['edit-ra-totp-verify', 'edit-ra-2fa-totp-verify'].forEach(function (fid) {
      var n = byId(fid); if (n) n.style.display = 'none';
    });
    ['edit-ra-totp-code', 'edit-ra-2fa-totp-code'].forEach(function (fid) {
      var n = byId(fid); if (n) n.value = '';
    });

    var authUser = byId('edit-route-auth-user');
    if (authUser) authUser.value = route.basic_auth_user || '';
    var authPass = byId('edit-route-auth-pass');
    if (authPass) authPass.value = '';

    // Reset any share-managed read-only state from a previously edited route
    setRouteAuthShareManaged(false);

    var authIsShareManaged = false;
    var hasRouteAuth = false;
    try {
      var authData = await window.api.get('/api/routes/' + id + '/auth');
      if (seq !== state.seq) return;
      if (authData.ok && authData.data) {
        // Always populate the route-auth fields so that switching to the
        // Route-Auth tab shows the prior values, even when Basic Auth is the
        // effective-active method (dead route_auth row).
        hasRouteAuth = true;
        var auth = authData.data;
        var email = auth.email || '';
        if (auth.auth_type === 'share') {
          // Share-managed routes have no credential flow — read-only note.
          authIsShareManaged = true;
          setRouteAuthShareManaged(true);
        } else {
          setRouteAuthShareManaged(false);
          if (auth.two_factor_enabled) {
            if (ra2fa) ra2fa.classList.add('on');
            var tfaEmail = byId('edit-ra-2fa-email');
            if (tfaEmail) tfaEmail.value = email;
            var f2method = auth.two_factor_method || 'email_code';
            byId('edit-ra-method').value = f2method;
            setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', f2method);
          } else {
            setToggleGroup('edit-ra-method-group', 'edit-ra-method', auth.auth_type || 'email_password');
            var sfEmail = byId('edit-ra-email');
            if (sfEmail) sfEmail.value = email;
          }
          if (raDuration) raDuration.value = String(auth.session_max_age || 86400000);
        }
      }
    } catch (err) {
      // Auth fetch failed — fall back to whatever the route record tells us.
      if (seq !== state.seq) return;
    }

    var activeMethod = route.basic_auth_enabled ? 'basic' : (hasRouteAuth ? 'route' : 'none');
    setToggleGroup('edit-auth-type-group', 'edit-auth-type', activeMethod);
    // Green indicator: independent of ".on" (blue selected/visited) so green
    // stays put while the user clicks around between tabs.
    var authTypeGroupEl = byId('edit-auth-type-group');
    if (authTypeGroupEl) {
      authTypeGroupEl.querySelectorAll('.toggle-btn').forEach(function (b) {
        b.classList.toggle('method-active', b.dataset.value === activeMethod);
      });
    }
    updateEditAuthTypeUI();
    // updateEditAuthTypeUI() re-shows #edit-ra-single-factor for 'route' auth;
    // for share-managed routes the read-only note must win.
    if (authIsShareManaged) setRouteAuthShareManaged(true);
  }

  // ═══ Ziel & Ports: domain, target, type ════════════════════════════════════

  function setupDomainRegistry() {
    var sel = byId('edit-route-base-domain');
    var pfx = byId('edit-route-prefix');
    var ft = byId('edit-route-domain-freetext');
    var prev = byId('edit-route-domain-preview');
    var unvWarn = byId('edit-route-unverified-warning');
    function updateEditPreview() {
      if (!sel) return;
      var isFt = sel.value === '';
      if (ft) ft.style.display = isFt ? '' : 'none';
      if (prev) {
        if (isFt) { prev.style.display = 'none'; return; }
        var assembled = window.RouteDomain
          ? window.RouteDomain.assembleRouteDomain((pfx && pfx.value) || '', sel.value)
          : sel.value;
        if (assembled) { prev.textContent = assembled; prev.style.display = ''; }
        else prev.style.display = 'none';
      }
    }
    function updateEditUnverifiedWarning() {
      if (!sel || !unvWarn) return;
      var selectedOpt = sel.options[sel.selectedIndex];
      var isUnverified = selectedOpt && selectedOpt.dataset && selectedOpt.dataset.unverified === '1';
      if (isUnverified) {
        unvWarn.textContent = T('routes.unverified_base_prefix_warning', 'Changing the prefix requires a verified base — verify the domain first');
        unvWarn.style.display = '';
      } else {
        unvWarn.style.display = 'none';
      }
    }
    if (sel) sel.addEventListener('change', function () { updateEditPreview(); updateEditUnverifiedWarning(); });
    if (pfx) pfx.addEventListener('input', updateEditPreview);

    // DNS check on blur of the free-text domain
    var dnsHint = byId('edit-route-dns-hint');
    if (ft && dnsHint) {
      ft.addEventListener('blur', function () {
        var val = this.value.trim();
        if (val) checkDns(val, dnsHint, ft);
        else dnsHint.style.display = 'none';
      });
    }
  }

  // Path detection: public domain → base dropdown + prefix; otherwise free text.
  function populateDomain(route, seq) {
    var baseSel = byId('edit-route-base-domain');
    var pfxEl = byId('edit-route-prefix');
    var ftEl = byId('edit-route-domain-freetext');
    var prevEl = byId('edit-route-domain-preview');
    var unvWarn = byId('edit-route-unverified-warning');
    if (prevEl) prevEl.style.display = 'none';
    if (unvWarn) unvWarn.style.display = 'none';
    var isPub = typeof route.domainIsPublic === 'boolean' ? route.domainIsPublic : isPublicDomain(route.domain);
    if (!isPub) {
      // Freetext path: internal domain / no domain / stale cache — safe default
      if (ftEl) { ftEl.value = route.domain || ''; ftEl.style.display = ''; }
      if (baseSel) baseSel.value = '';
      return;
    }
    if (ftEl) ftEl.style.display = 'none';
    // Last-two-labels base and prefix
    var d = route.domain || '';
    var dParts = d ? d.split('.') : [];
    var base = dParts.length >= 2 ? dParts.slice(-2).join('.') : d;
    var prefix = (d && base && d.length > base.length + 1) ? d.slice(0, d.length - base.length - 1) : '';
    if (pfxEl) pfxEl.value = prefix;
    if (!baseSel) return;
    (async function loadDomains() {
      while (baseSel.firstChild) baseSel.removeChild(baseSel.firstChild);
      var ftOpt = el('option', { value: '', text: T('routes.other_domain', 'Other / internal domain (free text)') });
      baseSel.appendChild(ftOpt);
      var verifiedSet = [];
      try {
        var resp = await window.api.get('/api/v1/settings/domains');
        if (seq !== state.seq) return;
        var domList = (resp.data && resp.data.domains) || [];
        domList.filter(function (x) { return x.status === 'verified'; }).forEach(function (x) {
          baseSel.insertBefore(el('option', { value: x.domain, text: x.domain }), ftOpt);
          verifiedSet.push(x.domain);
        });
      } catch (_e) {
        // network error: proceed to inject unverified as fallback
        if (seq !== state.seq) return;
      }
      // Preselect base: inject as unverified legacy if not in verified list
      if (base) {
        if (verifiedSet.indexOf(base) === -1) {
          var unvOpt = el('option', { value: base, text: base + ' ' + T('routes.unverified_base_option', '(unverified · legacy)') });
          unvOpt.dataset.unverified = '1';
          baseSel.insertBefore(unvOpt, ftOpt);
          if (unvWarn) {
            unvWarn.textContent = T('routes.unverified_base_prefix_warning', 'Changing the prefix requires a verified base — verify the domain first');
            unvWarn.style.display = '';
          }
        }
        baseSel.value = base;
      }
      var assembled = (baseSel.value && window.RouteDomain)
        ? window.RouteDomain.assembleRouteDomain((pfxEl && pfxEl.value) || '', baseSel.value) : '';
      if (prevEl) {
        if (assembled) { prevEl.textContent = assembled; prevEl.style.display = ''; }
        else prevEl.style.display = 'none';
      }
      // The select was filled after open(): its value is the starting point.
      rebaseSnapshot(['edit-route-base-domain']);
    })();
  }

  // Domain as the form currently shows it: freetext if visible, else base+prefix.
  function readFormDomain() {
    var ft = byId('edit-route-domain-freetext');
    var base = byId('edit-route-base-domain');
    var pfx = byId('edit-route-prefix');
    if (ft && ft.style.display !== 'none') return ft.value.trim();
    if (window.RouteDomain && base && base.value) {
      return window.RouteDomain.assembleRouteDomain((pfx && pfx.value) || '', base.value);
    }
    return base ? base.value.trim() : '';
  }

  // ─── Context: host + zone of the entry (zones page) ─────
  // From opts.context, else looked up in the page data by bundle_id.
  function resolveContext(route, opts) {
    var c = opts && opts.context;
    if (c && c.host) return c;
    var V = window.GCZonesView;
    var data = window.GCZonesPage && window.GCZonesPage.getData && window.GCZonesPage.getData();
    if (!V || !data || route.bundle_id == null) return null;
    var zones = V.pageZones(data);
    for (var i = 0; i < zones.length; i++) {
      var h = (zones[i].hosts || []).find(function (x) { return x.id === route.bundle_id; });
      if (h) return { host: h, zone: zones[i] };
    }
    return null;
  }
  function ctxZone() { return state.ctx && state.ctx.zone && !state.ctx.zone.unassigned ? state.ctx.zone : null; }
  function ctxHost() { return state.ctx && state.ctx.host ? state.ctx.host : null; }
  // Target of a zone-managed entry: the zone's gateway / pool / peer.
  function zoneTargetOf() {
    var z = ctxZone();
    var h = ctxHost();
    if (!z || !h || h.gateway_override || !z.gateway || !z.gateway.kind) return null;
    return z.gateway;
  }
  function targetKindNow() {
    if (state.zoneManaged) {
      var g = zoneTargetOf();
      return g && g.kind === 'peer' ? 'peer' : 'gateway';
    }
    var tk = byId('edit-route-target-kind');
    return tk ? (tk.value || 'peer') : ((state.route && state.route.target_kind) || 'peer');
  }
  function hostFqdn() {
    var h = ctxHost();
    if (h && h.fqdn) return h.fqdn;
    return (state.route && state.route.domain) || '';
  }
  function l4Allowed() {
    var f = (window.GC && GC.features) || {};
    if (f.l4_routes === 0) return false;
    if (targetKindNow() === 'gateway' && f.gateway_tcp_routing === false) return false;
    return true;
  }
  // Another HTTP entry in the same host → no HTTPS for this one.
  function hostHasOtherHttp() {
    var h = ctxHost();
    if (!h || !state.route) return false;
    return (h.entries || []).some(function (e) { return e.id !== state.route.id && e.route_type !== 'l4' && !e.rdp_owned; });
  }

  // ─── Type (HTTPS / TCP / UDP) ─────────────────────────────
  function kindNow() {
    var type = (byId('edit-route-type') || {}).value || 'http';
    if (type !== 'l4') return 'http';
    return (byId('edit-l4-protocol') || {}).value === 'udp' ? 'udp' : 'tcp';
  }
  function setKind(kind) {
    var rt = byId('edit-route-type');
    var proto = byId('edit-l4-protocol');
    if (rt) rt.value = kind === 'http' ? 'http' : 'l4';
    if (proto && kind !== 'http') proto.value = kind;
    var group = byId('ee-kind-group');
    if (group) {
      group.querySelectorAll('[data-value]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.value === kind ? 'true' : 'false');
      });
    }
  }
  function syncKindButtons() {
    var group = byId('ee-kind-group');
    if (!group) return;
    var otherHttp = hostHasOtherHttp();
    var l4ok = l4Allowed();
    var cur = kindNow();
    var hint = byId('ee-kind-hint');
    group.querySelectorAll('[data-value]').forEach(function (b) {
      var v = b.dataset.value;
      b.disabled = v !== cur && (v === 'http' ? otherHttp : !l4ok);
      b.title = b.disabled ? (v === 'http' ? T('entry.err_http_taken', '') : T('entry.l4_locked', '')) : '';
    });
    if (hint) hint.textContent = otherHttp && cur !== 'http' ? T('entry.err_http_taken', '') : '';
  }

  // ─── Target block: zone-managed vs. own target ────────────
  function updateTargetKindVisibility() {
    var zoneTarget = state.zoneManaged ? zoneTargetOf() : null;
    var kind = targetKindNow();
    showIf('ee-row-kind', !state.zoneManaged);
    showIf('ee-zone-target', !!zoneTarget);
    showIf('edit-route-gateway-fields', !state.zoneManaged && kind === 'gateway');
    showIf('edit-route-peer-fields', !state.zoneManaged && kind === 'peer');
    var editPeerSelect = byId('edit-route-peer');
    showIf('edit-route-ip-group', !state.zoneManaged && kind === 'peer' && !(editPeerSelect && editPeerSelect.value));
    showIf('ee-row-lan', kind === 'gateway');
    showIf('ee-row-wol', kind === 'gateway');
    if (zoneTarget) {
      var lbl = byId('ee-zone-target-label');
      if (lbl) lbl.textContent = zoneTarget.kind === 'peer' ? T('entry_editor.peer', 'VPN peer') : zoneTarget.kind === 'pool' ? T('entry_editor.pool', 'Gateway pool') : T('entry_editor.gateway', 'Gateway');
      var name = byId('ee-zone-target-name');
      if (name) {
        name.textContent = '';
        name.appendChild(el('span', { class: 'rt-strong', text: zoneTarget.name || zoneTarget.ip || ('#' + (zoneTarget.peer_id || zoneTarget.pool_id)) }));
        name.appendChild(el('span', { class: 'rt-muted', text: ' · ' + T('entry_editor.from_domain', 'from the domain') }));
      }
    }
    var lanHint = byId('ee-lan-hint');
    if (lanHint) {
      var h = ctxHost();
      var n = h ? (h.entries || []).filter(function (e) { return !e.rdp_owned; }).length : 0;
      lanHint.textContent = state.zoneManaged && h ? T('entry_editor.lan_applies', 'Applies to all {{count}} entries of the host').replace('{{count}}', String(n)) : '';
    }
  }

  // Listen-port hint: free / taken / reserved, from the page data.
  function syncListenState() {
    var hint = byId('ee-listen-state');
    var lp = byId('edit-l4-listen-port');
    if (!hint || !lp) return;
    var V = window.GCZonesView;
    var data = window.GCZonesPage && window.GCZonesPage.getData && window.GCZonesPage.getData();
    var v = lp.value.trim();
    hint.classList.remove('rt-ok', 'rt-err');
    if (!v || !V || !data) { hint.textContent = T('entry_editor.listen_hint', ''); return; }
    var blocked = (lp.dataset.blockedPorts || '').split(',').map(function (x) { return parseInt(x, 10); }).filter(function (n) { return !isNaN(n); });
    var tls = (byId('edit-l4-tls-mode') || {}).value || 'none';
    var used = V.usedListenPorts(V.pageZones(data), state.route ? [state.route.id] : []);
    var st = tls !== 'none' ? (V.validPort(v, true) ? 'free' : 'invalid') : V.listenPortState(v, kindNow(), used, blocked);
    hint.textContent = T('entry_editor.listen_' + st, st);
    hint.classList.toggle('rt-ok', st === 'free');
    hint.classList.toggle('rt-err', st !== 'free');
  }

  function updateEditFieldVisibility() {
    var routeType = (byId('edit-route-type') || {}).value || 'http';
    var isL4 = routeType === 'l4';
    var modal = byId(MODAL_ID);
    showIf('edit-l4-fields', isL4);
    showIf('ee-outer-http', !isL4);
    showIf('edit-http-fields', !isL4);
    showIf('ee-sec-http', !isL4);
    showIf('edit-l4-protection', isL4);
    if (modal) modal.classList.toggle('rt-ee-is-l4', isL4);
    // HTTPS-only sections stay visible for TCP/UDP but greyed out and inert.
    if (modal) {
      modal.querySelectorAll('.rt-ee-http-only, .rt-ee-http-panel').forEach(function (n) {
        n.classList.toggle('rt-ee-disabled', isL4);
        try { n.inert = isL4; } catch (_) { /* old browser */ }
        if (n.classList.contains('rt-ee-http-panel')) {
          // The panel itself stays readable (title + note); only its content is inert.
          try { n.inert = false; } catch (_) { /* ignore */ }
          Array.prototype.forEach.call(n.children, function (c) {
            if (c.classList.contains('rt-ee-panel-title') || c.classList.contains('rt-ee-l4note')) return;
            c.classList.toggle('rt-ee-disabled', isL4);
            try { c.inert = isL4; } catch (_) { /* ignore */ }
          });
        }
      });
      modal.querySelectorAll('.rt-ee-l4note').forEach(function (n) { n.hidden = !isL4; });
      modal.querySelectorAll('.rt-ee-tab-http').forEach(function (b) { b.classList.toggle('rt-ee-tab-off', isL4); });
    }
    var chip = byId('ee-type-chip');
    if (chip) {
      var k = kindNow();
      var label = k === 'http' ? (isOn('edit-route-https') ? 'HTTPS' : 'HTTP') : k.toUpperCase();
      chip.textContent = label;
      chip.className = 'rt-chip rt-ee-chip rt-chip-' + label.toLowerCase();
    }
    var url = byId('ee-outer-url');
    if (url) url.textContent = (isOn('edit-route-https') ? 'https://' : 'http://') + (hostFqdn() || '…') + ' · :' + (isOn('edit-route-https') ? '443' : '80');

    var editTlsMode = (byId('edit-l4-tls-mode') || {}).value || 'none';
    // Domain picker only outside a zone (the host owns the name otherwise).
    showIf('ee-domain-legacy', !ctxZone());
    if (!ctxZone()) {
      var wrap = byId('edit-route-domain-wrap');
      applyDomainContext(
        routeType, editTlsMode,
        byId('edit-route-base-domain'),
        wrap,
        byId('edit-route-domain-label'),
        byId('edit-route-domain-ctx-hint')
      );
      if (isL4 && editTlsMode === 'none') {
        var eftClear = byId('edit-route-domain-freetext');
        if (eftClear) eftClear.value = '';
      }
    }
    updateTlsHint('edit-l4-tls-mode', 'edit-l4-tls-hint');
    syncKindButtons();
    syncListenState();
  }

  function populateTarget(route) {
    var gw = (route.target_kind || 'peer') === 'gateway';
    var portEl = byId('edit-route-port');
    if (portEl) portEl.value = (gw ? (route.target_lan_port || route.target_port) : route.target_port) || '';
    var ipInput = byId('edit-route-ip');
    if (ipInput) ipInput.value = route.target_ip || '';

    var editPeerSelect = byId('edit-route-peer');
    if (editPeerSelect) renderEditPeerOptions(editPeerSelect, route.peer_id);

    var gwPeerSelect = byId('edit-route-gateway-peer');
    if (gwPeerSelect) renderEditGatewayOptions(gwPeerSelect, route.target_peer_id);

    var tkSelect = byId('edit-route-target-kind');
    if (tkSelect) tkSelect.value = route.target_kind || 'peer';

    var lanHost = byId('edit-route-lan-host');
    if (lanHost) lanHost.value = route.target_lan_host || '';
    var wolCb = byId('edit-route-wol-enabled');
    if (wolCb) wolCb.checked = !!route.wol_enabled;
    var wolMac = byId('edit-route-wol-mac');
    if (wolMac) wolMac.value = route.wol_mac || '';
    syncWolMacVisibility();

    var kind = route.route_type === 'l4' ? (route.l4_protocol === 'udp' ? 'udp' : 'tcp') : 'http';
    setKind(kind);
    var lp = byId('edit-l4-listen-port');
    if (lp) { lp.value = route.route_type === 'l4' ? (route.l4_listen_port || '') : ''; delete lp.dataset.userModified; }
    var tls = byId('edit-l4-tls-mode');
    if (tls) tls.value = route.route_type === 'l4' ? (route.l4_tls_mode || 'none') : 'none';
    hideListenConflict();
  }

  function syncWolMacVisibility() {
    var wolCb = byId('edit-route-wol-enabled');
    var wolMacField = byId('edit-route-wol-mac-field');
    if (wolCb && wolMacField) wolMacField.style.display = wolCb.checked ? 'block' : 'none';
  }

  function hideListenConflict() {
    var box = byId('ee-listen-conflict');
    if (box) box.hidden = true;
  }
  // 409 BUNDLE_PORT_CONFLICT from the save: inline below the listen port,
  // with "Port n verwenden".
  function showListenConflict(conflict) {
    var box = byId('ee-listen-conflict');
    if (!box) return;
    var text = byId('ee-listen-conflict-text');
    var use = byId('ee-listen-use');
    if (text) text.textContent = T('entry.port_conflict', 'Port {{port}} is already in use').replace('{{port}}', String(conflict.port));
    if (use) {
      use.hidden = !conflict.suggestedPort;
      use.textContent = T('entry.use_port', 'Use port {{port}}').replace('{{port}}', String(conflict.suggestedPort || ''));
      use.onclick = function () {
        var lp = byId('edit-l4-listen-port');
        if (lp) { lp.value = String(conflict.suggestedPort); lp.dataset.userModified = 'true'; }
        box.hidden = true;
        onFormChange();
        if (lp) lp.focus();
      };
    }
    box.hidden = false;
    goSection('target');
  }

  function setupGeneralControls() {
    var editPeerSelect = byId('edit-route-peer');
    if (editPeerSelect) editPeerSelect.addEventListener('change', updateTargetKindVisibility);
    var tkSelect = byId('edit-route-target-kind');
    if (tkSelect) tkSelect.addEventListener('change', function () { updateTargetKindVisibility(); syncKindButtons(); });
    var wolCb = byId('edit-route-wol-enabled');
    if (wolCb) wolCb.addEventListener('change', syncWolMacVisibility);

    // Type: one segmented control for HTTPS / TCP / UDP.
    var kindGroup = byId('ee-kind-group');
    if (kindGroup) {
      kindGroup.addEventListener('click', function (e) {
        var b = e.target.closest('[data-value]');
        if (!b || b.disabled) return;
        var prev = kindNow();
        setKind(b.dataset.value);
        // Switching to TCP/UDP: suggest the target port as listen port.
        var lp = byId('edit-l4-listen-port');
        if (prev === 'http' && b.dataset.value !== 'http' && lp && !lp.value) lp.value = (byId('edit-route-port') || {}).value || '';
        if (b.dataset.value === 'udp') { var tls = byId('edit-l4-tls-mode'); if (tls) tls.value = 'none'; }
        hideListenConflict();
        updateEditFieldVisibility();
        syncWafBlock();
      });
    }
    var tlsSel = byId('edit-l4-tls-mode');
    if (tlsSel) tlsSel.addEventListener('change', function () { updateEditFieldVisibility(); });
    var lp = byId('edit-l4-listen-port');
    if (lp) {
      lp.addEventListener('input', function () { this.dataset.userModified = 'true'; hideListenConflict(); checkListenPortBlocked('edit-l4-listen-port', 'edit-l4-listen-port-error'); syncListenState(); });
      lp.addEventListener('change', function () { checkListenPortBlocked('edit-l4-listen-port', 'edit-l4-listen-port-error'); });
    }

    // External exposure + block action
    var extToggle = byId('edit-route-external');
    if (extToggle) {
      extToggle.addEventListener('click', function () {
        setTimeout(function () { syncBlockVisibility('edit'); }, 0);
      });
    }
    var blockActionSel = byId('edit-route-block-action');
    if (blockActionSel) blockActionSel.addEventListener('change', function () { syncBlockVisibility('edit'); });

    // "Nur bei Bedarf" (S3 §2): the Wake-on-LAN note only makes sense for a
    // gateway target with the licence.
    var odToggle = byId('edit-route-on-demand');
    if (odToggle) odToggle.addEventListener('click', function () { setTimeout(syncOnDemandHint, 0); });
    if (tkSelect) tkSelect.addEventListener('change', syncOnDemandHint);
    if (wolCb) wolCb.addEventListener('change', syncOnDemandHint);

    var https = byId('edit-route-https');
    if (https) https.addEventListener('click', function () { setTimeout(updateEditFieldVisibility, 0); });
    var settingsLink = byId('ee-zone-settings-link');
    if (settingsLink) {
      settingsLink.addEventListener('click', function () {
        var z = ctxZone();
        if (!z || !window.GCDomainModal) return;
        requestClose().then(function (closed) { if (closed) window.GCDomainModal.open(z.domain_id); });
      });
    }
  }

  // Wake-on-LAN note under the "nur bei Bedarf" switch: shown when the entry
  // targets a gateway, the licence has gateway_wol and WoL is still off.
  function syncOnDemandHint() {
    var hint = byId('edit-route-on-demand-wol');
    if (!hint) return;
    var on = isOn('edit-route-on-demand');
    var kind = targetKindNow();
    var wolCb = byId('edit-route-wol-enabled');
    var licensed = !!(window.GC && GC.features && GC.features.gateway_wol);
    hint.style.display = (on && kind === 'gateway' && licensed && !(wolCb && wolCb.checked)) ? '' : 'none';
  }

  // ═══ Security / feature toggles ════════════════════════════════════════════

  // app.js handles the visual toggle (classList, ARIA, keyboard); we react
  // AFTER app.js toggled the state.
  function setupSimpleToggle(toggleId, fieldsId) {
    var toggle = byId(toggleId);
    var fields = byId(fieldsId);
    if (toggle && fields) {
      toggle.addEventListener('click', function () {
        setTimeout(function () {
          fields.style.display = toggle.classList.contains('on') ? '' : 'none';
        }, 0);
      });
    }
  }

  function setupFeatureControls() {
    setupAclToggle('edit', function () { return state.peers; });
    setupIpFilter('edit', editIpFilterRules);
    // L4 protection block (docs/feature-next-package.md §S1.4). Same prefix
    // convention as the HTTP block, same rules array — only one of the two is
    // ever visible, the entry type decides which.
    setupIpFilter('edit-l4', editIpFilterRules);
    setupSimpleToggle('edit-l4-conn-rate', 'edit-l4-conn-rate-fields');
    var l4ModeGroup = byId('edit-l4-ip-filter-mode-group');
    if (l4ModeGroup) l4ModeGroup.addEventListener('click', function () { setTimeout(updateL4FilterModeHint, 0); });
    var l4Toggle = byId('edit-l4-route-ip-filter');
    if (l4Toggle) l4Toggle.addEventListener('click', function () { setTimeout(updateL4FilterModeHint, 0); });
    setupSimpleToggle('edit-route-rate-limit', 'edit-rate-limit-fields');
    setupSimpleToggle('edit-route-retry', 'edit-retry-fields');
    setupSimpleToggle('edit-route-backends', 'edit-backends-fields');
    setupSimpleToggle('edit-route-sticky', 'edit-sticky-fields');
    setupSimpleToggle('edit-route-circuit-breaker', 'edit-circuit-breaker-fields');
    setupSimpleToggle('edit-route-mirror', 'edit-mirror-fields');
    setupSimpleToggle('edit-route-debug', 'edit-debug-container');
    setupSimpleToggle('edit-route-bot-blocker', 'edit-bot-blocker-fields');
    var bbMode = byId('edit-bot-blocker-mode');
    if (bbMode) bbMode.addEventListener('change', function () { updateBotBlockerFields('edit'); });

    var backendsAddBtn = byId('edit-backends-add');
    if (backendsAddBtn) {
      backendsAddBtn.addEventListener('click', function () {
        editBackendsList.push({ peer_id: null, port: 8080, weight: 1 });
        renderBackendsList();
      });
    }
    var mirrorAddBtn = byId('edit-mirror-add-target');
    if (mirrorAddBtn) {
      mirrorAddBtn.addEventListener('click', function () {
        if (editMirrorTargets.length < 5) {
          editMirrorTargets.push({ peer_id: null, port: 8080 });
          renderEditMirrorTargets();
        }
      });
    }
  }

  function setToggle(id, on) {
    var t = byId(id);
    if (!t) return null;
    t.classList.toggle('on', !!on);
    t.setAttribute('aria-checked', on ? 'true' : 'false');
    return t;
  }
  function showIf(id, cond) {
    var n = byId(id);
    if (n) n.style.display = cond ? '' : 'none';
  }
  function setVal(id, v) {
    var n = byId(id);
    if (n) n.value = v;
  }

  function renderBackendsList() {
    var list = byId('edit-backends-list');
    if (!list) return;
    list.textContent = '';
    editBackendsList.forEach(function (b, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:12px';

      row.appendChild(buildRowPeerSelect(b.peer_id, 'flex:2;padding:4px 8px;font-size:12px', function () {
        editBackendsList[idx].peer_id = parseInt(this.value, 10) || null;
      }));

      var portInput = el('input', { type: 'number', min: '1', max: '65535', placeholder: T('routes.backends_port', 'Port'), style: 'flex:1;padding:4px 8px;font-size:12px' });
      portInput.value = b.port || 8080;
      portInput.addEventListener('change', function () { editBackendsList[idx].port = parseInt(this.value, 10); });
      row.appendChild(portInput);

      var weightInput = el('input', { type: 'number', min: '1', max: '100', placeholder: T('routes.backends_weight', 'Weight'), style: 'width:60px;padding:4px 8px;font-size:12px' });
      weightInput.value = b.weight || 1;
      weightInput.addEventListener('change', function () { editBackendsList[idx].weight = parseInt(this.value, 10); });
      row.appendChild(weightInput);

      var del = el('button', { type: 'button', text: '×', style: 'background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px' });
      del.addEventListener('click', function () { editBackendsList.splice(idx, 1); renderBackendsList(); });
      row.appendChild(del);

      list.appendChild(row);
    });
  }

  function renderEditMirrorTargets() {
    var list = byId('edit-mirror-targets-list');
    var hint = byId('edit-mirror-max-hint');
    var addBtn = byId('edit-mirror-add-target');
    if (!list) return;
    list.textContent = '';
    editMirrorTargets.forEach(function (t, i) {
      var sel = buildRowPeerSelect(t.peer_id, 'flex:2;padding:6px 10px;font-size:12px', function () {
        editMirrorTargets[i].peer_id = parseInt(this.value, 10) || null;
      });
      var portInput = el('input', { type: 'number', min: '1', max: '65535', placeholder: T('routes.mirror_target_port', 'Port'), style: 'flex:1;padding:6px 10px;font-size:12px' });
      portInput.value = String(parseInt(t.port, 10) || 8080);
      portInput.addEventListener('input', function () { editMirrorTargets[i].port = parseInt(this.value, 10) || 8080; });
      var del = el('button', { type: 'button', class: 'btn btn-ghost', text: '✕', style: 'padding:4px 8px;font-size:12px;color:var(--red)' });
      del.addEventListener('click', function () {
        editMirrorTargets.splice(i, 1);
        renderEditMirrorTargets();
      });
      list.appendChild(el('div', { style: 'display:flex;gap:6px;align-items:center' }, [sel, portInput, del]));
    });
    if (hint) hint.style.display = editMirrorTargets.length >= 5 ? '' : 'none';
    if (addBtn) addBtn.disabled = editMirrorTargets.length >= 5;
  }

  function parseJson(v, fallback) {
    if (v == null || v === '') return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return fallback; }
  }

  // Circuit breaker status indicator + manual reset button. The breaker state
  // is persisted in SQLite (cb_failure_count, cb_opened_at), so an open
  // breaker survives restarts and only clears via monitoring timeout or this
  // button.
  function paintCbStatus(indicator, status) {
    if (status === 'closed') {
      indicator.style.background = 'var(--green, #4ade80)';
      indicator.style.color = '#fff';
      indicator.textContent = T('circuit_breaker.status_closed', 'Closed');
    } else if (status === 'open') {
      indicator.style.background = 'var(--red, #f87171)';
      indicator.style.color = '#fff';
      indicator.textContent = T('circuit_breaker.status_open', 'Open');
    } else {
      indicator.style.background = warnColor();
      indicator.style.color = '#000';
      indicator.textContent = T('circuit_breaker.status_half_open', 'Half-Open');
    }
  }

  function populateCircuitBreaker(route) {
    var cbEnabled = !!route.circuit_breaker_enabled;
    setToggle('edit-route-circuit-breaker', cbEnabled);
    showIf('edit-circuit-breaker-fields', cbEnabled);
    setVal('edit-cb-threshold', route.circuit_breaker_threshold || 5);
    setVal('edit-cb-timeout', route.circuit_breaker_timeout || 30);
    var indicator = byId('edit-cb-status-indicator');
    var resetBtn = byId('edit-cb-reset');
    if (indicator && cbEnabled) {
      var status = route.circuit_breaker_status || 'closed';
      indicator.style.display = '';
      paintCbStatus(indicator, status);
      // Reset only makes sense when the breaker isn't closed.
      if (resetBtn) {
        resetBtn.style.display = status !== 'closed' ? '' : 'none';
        resetBtn.onclick = async function () {
          if (typeof window.btnLoading === 'function') window.btnLoading(resetBtn);
          try {
            var resp = await window.api.post('/api/routes/' + route.id + '/circuit-breaker/reset', {});
            if (resp && resp.ok) {
              toast(T('circuit_breaker.reset_ok', 'Circuit-Breaker zurückgesetzt'), 'success');
              paintCbStatus(indicator, 'closed');
              resetBtn.style.display = 'none';
              callOpt('onChanged', route.id);
            } else {
              toast((resp && resp.error) || 'Reset failed', 'error');
            }
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            if (typeof window.btnReset === 'function') window.btnReset(resetBtn);
          }
        };
      }
    } else if (indicator) {
      indicator.style.display = 'none';
      if (resetBtn) resetBtn.style.display = 'none';
    }
    // Monitoring requirement warning
    showIf('edit-cb-requires-monitoring', !route.monitoring_enabled);
  }

  async function populateFeatures(route, id, detail, seq) {
    var cls = function (id2, on) { var t = byId(id2); if (t) t.classList.toggle('on', !!on); };

    cls('edit-route-https', route.https_enabled);
    cls('edit-route-backend-https', route.backend_https);
    setToggle('edit-route-compress', route.compress_enabled);
    setToggle('edit-route-external', route.external_enabled);

    var blockAction = byId('edit-route-block-action');
    if (blockAction) {
      blockAction.value = route.external_block_action || 'inherit';
      setVal('edit-route-block-body', route.external_block_body || '');
      setVal('edit-route-block-redirect', route.external_block_redirect_url || '');
      syncBlockVisibility('edit');
    }

    // ACL (peer list comes from GET /api/routes/:id — list rows lack acl_peers)
    var aclToggle = byId('edit-route-acl');
    if (aclToggle) {
      aclToggle.classList.toggle('on', !!route.acl_enabled);
      showIf('edit-acl-fields', route.acl_enabled);
    }

    // Rate limit
    setToggle('edit-route-rate-limit', route.rate_limit_enabled);
    showIf('edit-rate-limit-fields', route.rate_limit_enabled);
    setVal('edit-rate-limit-requests', route.rate_limit_requests || 100);
    setVal('edit-rate-limit-window', route.rate_limit_window || '1m');

    // Retry
    setToggle('edit-route-retry', route.retry_enabled);
    showIf('edit-retry-fields', route.retry_enabled);
    setVal('edit-retry-count', route.retry_count || 3);
    setVal('edit-retry-status', route.retry_match_status || '502,503,504');

    // Backends
    editBackendsList.length = 0;
    var parsedBe = parseJson(route.backends, null);
    if (Array.isArray(parsedBe)) parsedBe.forEach(function (b) { editBackendsList.push(b); });
    var hasBackends = editBackendsList.length > 0;
    if (byId('edit-route-backends')) {
      setToggle('edit-route-backends', hasBackends);
      showIf('edit-backends-fields', hasBackends);
    }
    renderBackendsList();

    // Sticky sessions
    var stickyOn = !!(route.sticky_enabled && hasBackends);
    if (byId('edit-route-sticky')) {
      setToggle('edit-route-sticky', stickyOn);
      showIf('edit-sticky-fields', stickyOn);
    }
    setVal('edit-sticky-cookie-name', route.sticky_cookie_name || 'gc_sticky');
    setVal('edit-sticky-cookie-ttl', route.sticky_cookie_ttl || '3600');

    // Custom headers
    editHeadersRequest.length = 0;
    editHeadersResponse.length = 0;
    var ch = parseJson(route.custom_headers, null);
    if (ch && Array.isArray(ch.request)) ch.request.forEach(function (h) { editHeadersRequest.push(h); });
    if (ch && Array.isArray(ch.response)) ch.response.forEach(function (h) { editHeadersResponse.push(h); });
    renderHeadersList('edit', 'request', editHeadersRequest);
    renderHeadersList('edit', 'response', editHeadersResponse);

    setToggle('edit-route-monitoring', route.monitoring_enabled);
    populateHsts(route);
    populateSecOpts(route);
    populateWaf(route);

    // Debug
    if (byId('edit-route-debug')) {
      setToggle('edit-route-debug', route.debug_enabled);
      showIf('edit-debug-container', route.debug_enabled);
    }

    // Bot blocker
    if (byId('edit-route-bot-blocker')) {
      setToggle('edit-route-bot-blocker', route.bot_blocker_enabled);
      showIf('edit-bot-blocker-fields', route.bot_blocker_enabled);
    }
    setVal('edit-bot-blocker-mode', route.bot_blocker_mode || 'block');
    var bbCfg = parseJson(route.bot_blocker_config, {});
    if (!bbCfg || typeof bbCfg !== 'object') bbCfg = {};
    setVal('edit-bot-blocker-url', bbCfg.url || '');
    setVal('edit-bot-blocker-message', bbCfg.message || '');
    setVal('edit-bot-blocker-status', bbCfg.status_code || 403);
    updateBotBlockerFields('edit');

    populateCircuitBreaker(route);

    // Mirror
    setToggle('edit-route-mirror', route.mirror_enabled);
    showIf('edit-mirror-fields', route.mirror_enabled);
    editMirrorTargets.length = 0;
    var parsedMt = parseJson(route.mirror_targets, null);
    if (Array.isArray(parsedMt)) parsedMt.forEach(function (t) { editMirrorTargets.push(t); });
    renderEditMirrorTargets();

    // IP filter
    setToggle('edit-route-ip-filter', route.ip_filter_enabled);
    showIf('edit-ip-filter-fields', route.ip_filter_enabled);
    setToggleGroup('edit-ip-filter-mode-group', 'edit-ip-filter-mode', route.ip_filter_mode || 'whitelist');
    editIpFilterRules.length = 0;
    var rules = parseJson(route.ip_filter_rules || '[]', []);
    if (Array.isArray(rules)) rules.forEach(function (r) { editIpFilterRules.push(r); });
    renderIpFilterRules('edit', editIpFilterRules);

    // L4 protection: same values, own controls (the security tab is HTTP-only).
    setToggle('edit-l4-route-ip-filter', route.ip_filter_enabled);
    showIf('edit-l4-ip-filter-fields', route.ip_filter_enabled);
    setToggleGroup('edit-l4-ip-filter-mode-group', 'edit-l4-ip-filter-mode', route.ip_filter_mode || 'whitelist');
    renderIpFilterRules('edit-l4', editIpFilterRules);
    var connOn = !!(route.l4_conn_limit && route.l4_conn_window_s);
    setToggle('edit-l4-conn-rate', connOn);
    showIf('edit-l4-conn-rate-fields', connOn);
    setVal('edit-l4-conn-limit', connOn ? String(route.l4_conn_limit) : '20');
    setVal('edit-l4-conn-window', connOn ? String(route.l4_conn_window_s) : '60');
    updateL4FilterModeHint();

    // Branding
    setVal('edit-branding-title', route.branding_title || '');
    setVal('edit-branding-text', route.branding_text || '');
    setVal('edit-branding-color', route.branding_color || '#0a6e4f');
    setVal('edit-branding-bg', route.branding_bg || '#f2f0eb');
    setVal('edit-branding-logo-file', '');
    var logoCurrent = byId('edit-branding-logo-current');
    if (logoCurrent) logoCurrent.textContent = route.branding_logo || '';
    showIf('edit-branding-logo-remove', route.branding_logo);
    setVal('edit-branding-bg-file', '');
    var bgCurrent = byId('edit-branding-bg-current');
    if (bgCurrent) bgCurrent.textContent = route.branding_bg_image || '';
    showIf('edit-branding-bg-remove', route.branding_bg_image);

    // User visibility
    var userIds = parseJson(route.user_ids || '[]', []);
    var users = await loadUsers();
    if (seq !== state.seq) return;
    renderUserCheckboxes('route-user-ids', Array.isArray(userIds) ? userIds : [], 'route-user-cb', users);

    // ACL peer checklist
    renderAclPeerChecklist('edit', (detail && detail.acl_peers) || [], state.peers);
  }

  // ═══ HSTS (docs/feature-hsts.md, Tab Sicherheit) ═══════════════════════════
  // Fields: #edit-route-hsts (toggle), #edit-route-hsts-max-age,
  // #edit-route-hsts-subdomains, #edit-route-hsts-preload, #edit-hsts-hint.
  // Greyed out while #edit-route-https is off; preload only with
  // includeSubDomains and max-age ≥ 1 year, confirmed via GCHstsUI when present.

  var HSTS_PRELOAD_MIN_AGE = 31536000;
  var HSTS_ERROR_CODES = { HSTS_PRELOAD_REQUIREMENTS: 'preloadRequirements', HSTS_REQUIRES_HTTPS: 'requiresHttps', HSTS_MAX_AGE_INVALID: 'maxAgeInvalid' };

  function hstsText(name, key, fallback) {
    var block = byId('edit-hsts-block');
    return (block && block.dataset[name]) || T(key, fallback);
  }
  // German message for a contract error code, null for other codes.
  // IP_FILTER_* / L4_CONN_RATE_* from services/routesValidation — the API
  // passes the code through, the text comes from the translations.
  var L4_PROTECT_ERROR_KEYS = {
    IP_FILTER_MODE_INVALID: 'l4p.err.mode_invalid',
    IP_FILTER_RULE_INVALID: 'l4p.err.rule_invalid',
    IP_FILTER_COUNTRY_L4: 'l4p.err.country_l4',
    L4_CONN_RATE_INVALID: 'l4p.err.conn_rate_invalid',
  };
  function l4ProtectErrorText(code) {
    var key = code && L4_PROTECT_ERROR_KEYS[String(code).toUpperCase()];
    return key ? T(key, '') || null : null;
  }

  function hstsErrorText(code) {
    var k = code && HSTS_ERROR_CODES[String(code).toUpperCase()];
    if (!k) return null;
    return hstsText('err' + k.charAt(0).toUpperCase() + k.slice(1), 'hsts.err.' + String(code).toUpperCase().slice(5).toLowerCase(), String(code));
  }

  function populateHsts(route) {
    if (!byId('edit-hsts-block')) return;
    var on = !!(route.hsts_enabled === 1 || route.hsts_enabled === true || route.hsts_enabled === '1');
    setToggle('edit-route-hsts', on);
    var sel = byId('edit-route-hsts-max-age');
    if (sel) {
      var age = parseInt(route.hsts_max_age, 10);
      if (!isFinite(age) || age <= 0) age = HSTS_PRELOAD_MIN_AGE;
      var found = Array.prototype.some.call(sel.options, function (o) { return o.value === String(age); });
      if (!found) {
        var opt = document.createElement('option');
        opt.value = String(age);
        opt.textContent = age + ' s';
        sel.appendChild(opt);
      }
      sel.value = String(age);
    }
    var sub = byId('edit-route-hsts-subdomains');
    var pre = byId('edit-route-hsts-preload');
    if (sub) sub.checked = !!(route.hsts_subdomains === 1 || route.hsts_subdomains === true || route.hsts_subdomains === '1');
    if (pre) pre.checked = !!(route.hsts_preload === 1 || route.hsts_preload === true || route.hsts_preload === '1');
    syncHstsBlock();
  }

  function hstsPreloadAllowed() {
    var sel = byId('edit-route-hsts-max-age');
    var sub = byId('edit-route-hsts-subdomains');
    return !!(sub && sub.checked && sel && parseInt(sel.value, 10) >= HSTS_PRELOAD_MIN_AGE);
  }

  function syncHstsBlock() {
    var block = byId('edit-hsts-block');
    if (!block) return;
    var httpsOn = isOn('edit-route-https');
    var hstsOn = isOn('edit-route-hsts');
    block.classList.toggle('hs-locked', !httpsOn);
    var toggle = byId('edit-route-hsts');
    if (toggle) toggle.setAttribute('aria-disabled', httpsOn ? 'false' : 'true');
    var fields = byId('edit-hsts-fields');
    if (fields) fields.classList.toggle('hs-fields-off', !hstsOn);
    var sel = byId('edit-route-hsts-max-age');
    var sub = byId('edit-route-hsts-subdomains');
    var pre = byId('edit-route-hsts-preload');
    var active = httpsOn && hstsOn;
    if (sel) sel.disabled = !active;
    if (sub) sub.disabled = !active;
    var allowed = active && hstsPreloadAllowed();
    if (pre) {
      if (!allowed) pre.checked = false;
      pre.disabled = !allowed;
    }
    var hint = byId('edit-hsts-hint');
    if (hint) {
      if (!httpsOn) hint.textContent = hstsText('hintHttps', 'hsts.hint_https', 'HSTS requires "Force HTTPS".');
      else hint.textContent = hstsText('hintPreload', 'hsts.preload_hint', 'Preload requires includeSubDomains and max-age >= 1 year.');
    }
  }

  function readHstsFields() {
    var out = {};
    if (!byId('edit-hsts-block')) return out;
    var httpsOn = isOn('edit-route-https');
    out.hsts_enabled = httpsOn && isOn('edit-route-hsts');
    out.hsts_max_age = parseInt(val('edit-route-hsts-max-age', String(HSTS_PRELOAD_MIN_AGE)), 10) || HSTS_PRELOAD_MIN_AGE;
    var sub = byId('edit-route-hsts-subdomains');
    var pre = byId('edit-route-hsts-preload');
    out.hsts_subdomains = !!(sub && sub.checked);
    out.hsts_preload = !!(pre && pre.checked && out.hsts_subdomains && out.hsts_max_age >= HSTS_PRELOAD_MIN_AGE);
    return out;
  }

  function setupHstsControls() {
    if (!byId('edit-hsts-block')) return;
    var https = byId('edit-route-https');
    // app.js toggles the class on click before this listener runs.
    if (https) https.addEventListener('click', function () { syncHstsBlock(); });
    var toggle = byId('edit-route-hsts');
    if (toggle) toggle.addEventListener('click', function () { syncHstsBlock(); });
    var sel = byId('edit-route-hsts-max-age');
    var sub = byId('edit-route-hsts-subdomains');
    var pre = byId('edit-route-hsts-preload');
    if (sel) sel.addEventListener('change', syncHstsBlock);
    if (sub) sub.addEventListener('change', syncHstsBlock);
    if (pre) {
      pre.addEventListener('change', function () {
        if (!pre.checked) return;
        var ask = (window.GCHstsUI && typeof window.GCHstsUI.confirmPreload === 'function')
          ? window.GCHstsUI.confirmPreload()
          : D.confirm({ message: hstsText('preloadConfirm', 'hsts.preload_warning', 'Preload is practically irreversible. Enable it?'), danger: true });
        ask.then(function (ok) { if (!ok) { pre.checked = false; syncHstsBlock(); } });
      });
    }
  }

  // ═══ Security options (docs/feature-security-options.md) ═══════════════════
  // B  Backend TLS (tab Allgemein, under "Backend HTTPS"):
  //    #edit-route-backend-tls-verify / -server-name / -ca. Greyed out while
  //    Backend HTTPS is off and for gateway/pool targets (the gateway dials the
  //    target — the fields are stored but not applied, so they are not sent).
  // D  Body limit (tab Sicherheit): #edit-route-max-body-mb, 0 = unlimited.
  // F  mTLS (tab Auth): #edit-route-mtls + #edit-route-mtls-ca. Greyed out
  //    while "HTTPS erzwingen" is off; never sent without the route_auth
  //    license (#edit-mtls-block data-licensed="0").
  // Texts come from data attributes on the blocks (like the HSTS block).

  var BODY_MAX_MB = 4096;
  // Contract error code → [block id, data attribute, i18n key, tab]. The last
  // two codes are client-side (empty CA) and the 403 of the route_auth gate.
  var SECOPT_ERRORS = {
    BACKEND_CA_INVALID: ['edit-backend-tls-block', 'errBackendCaInvalid', 'backend_tls.err.ca_invalid', 'general'],
    BACKEND_SERVER_NAME_INVALID: ['edit-backend-tls-block', 'errBackendServerNameInvalid', 'backend_tls.err.server_name_invalid', 'general'],
    BACKEND_TLS_FINGERPRINT_INVALID: ['edit-backend-tls-block', 'errBackendTlsFingerprintInvalid', 'backend_tls.err.fingerprint_invalid', 'general'],
    MAX_BODY_INVALID: ['edit-body-limit-block', 'errMaxBodyInvalid', 'body_limit.err.invalid', 'security'],
    MTLS_CA_INVALID: ['edit-mtls-block', 'errMtlsCaInvalid', 'mtls.err.ca_invalid', 'auth'],
    MTLS_REQUIRES_HTTPS: ['edit-mtls-block', 'errMtlsRequiresHttps', 'mtls.err.requires_https', 'auth'],
    MTLS_MODE_INVALID: ['edit-mtls-block', 'errMtlsModeInvalid', 'mtls.err.mode_invalid', 'auth'],
    MTLS_CA_REQUIRED: ['edit-mtls-block', 'errCaRequired', 'mtls.err.ca_required', 'auth'],
    MTLS_LICENSE: ['edit-mtls-block', 'errLicense', 'mtls.err.license', 'auth'],
    // Web Application Firewall (docs/feature-waf.md, routesValidation) + 403 of the waf gate.
    WAF_MODE_INVALID: ['edit-waf-block', 'errWafModeInvalid', 'waf.err.mode_invalid', 'security'],
    WAF_PARANOIA_INVALID: ['edit-waf-block', 'errWafParanoiaInvalid', 'waf.err.paranoia_invalid', 'security'],
    WAF_REQUIRES_HTTP: ['edit-waf-block', 'errWafRequiresHttp', 'waf.err.requires_http', 'security'],
    WAF_LICENSE: ['edit-waf-block', 'errLicense', 'waf.err.license', 'security'],
  };
  // Tab names of the former editor → sections ('general' is "Ziel & Ports").
  var SECTION_OF_TAB = { general: 'target', debug: 'diagnose' };

  function flag(v) { return v === 1 || v === true || v === '1' || v === 'true'; }

  // German message for a code, null for anything else.
  function secoptErrorText(code) {
    var m = code && SECOPT_ERRORS[String(code).toUpperCase()];
    if (!m) return null;
    var block = byId(m[0]);
    return (block && block.dataset[m[1]]) || T(m[2], String(code));
  }
  // Shows the mapped error (form footer + inline in the block, e.g.
  // #edit-mtls-error), switches to the tab holding the field and scrolls the
  // block into view — the auth tab is long, the footer error sits below it.
  function showSecoptError(code) {
    var text = secoptErrorText(code);
    if (!text) return false;
    var m = SECOPT_ERRORS[String(code).toUpperCase()];
    goSection(SECTION_OF_TAB[m[3]] || m[3]);
    window.showError('edit-route-error', text);
    var inline = byId(m[0].replace(/-block$/, '-error'));
    if (inline) {
      inline.textContent = text;
      inline.hidden = false;
    }
    var block = byId(m[0]);
    if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'nearest' });
    return true;
  }
  function clearSecoptErrors() {
    ['edit-backend-tls-error', 'edit-body-limit-error', 'edit-mtls-error', 'edit-waf-error'].forEach(function (id) {
      var n = byId(id);
      if (n) { n.hidden = true; n.textContent = ''; }
    });
  }

  function secoptTargetKind() { return targetKindNow(); }
  function mtlsLicensed() {
    var block = byId('edit-mtls-block');
    return !!block && block.dataset.licensed !== '0';
  }

  function populateSecOpts(route) {
    var verify = byId('edit-route-backend-tls-verify');
    if (verify) verify.checked = flag(route.backend_tls_verify);
    setVal('edit-route-backend-tls-server-name', route.backend_tls_server_name || '');
    setVal('edit-route-backend-tls-ca', route.backend_tls_ca_pem || '');
    setVal('edit-route-backend-tls-fingerprint', formatFingerprint(route.backend_tls_fingerprint || ''));
    var mb = parseInt(route.max_body_mb, 10);
    setVal('edit-route-max-body-mb', String(isFinite(mb) && mb > 0 ? mb : 0));
    setToggle('edit-route-mtls', flag(route.mtls_enabled));
    setVal('edit-route-mtls-ca', route.mtls_ca_pem || '');
    clearSecoptErrors();
    // Preset hints belong to the last preset pick of this editor session.
    showIf('edit-headers-hsts-hint', false);
    var csp = byId('edit-headers-csp-warning');
    if (csp) csp.hidden = true;
    syncBackendTlsBlock();
    syncMtlsBlock();
  }

  function syncBackendTlsBlock() {
    var block = byId('edit-backend-tls-block');
    if (!block) return;
    var gateway = secoptTargetKind() === 'gateway';
    var bhttps = isOn('edit-route-backend-https');
    var active = !gateway && bhttps;
    var verify = byId('edit-route-backend-tls-verify');
    var checked = !!(verify && verify.checked);
    block.classList.toggle('so-locked', !active);
    block.classList.toggle('so-gateway', gateway);
    if (verify) verify.disabled = !active;
    ['edit-route-backend-tls-server-name', 'edit-route-backend-tls-ca'].forEach(function (id) {
      var n = byId(id);
      if (n) n.disabled = !(active && checked);
    });
    var fields = byId('edit-backend-tls-fields');
    if (fields) fields.classList.toggle('so-fields-off', !checked);
    var hint = byId('edit-backend-tls-hint');
    if (hint) {
      if (gateway) hint.textContent = block.dataset.hintGateway || T('backend_tls.hint_gateway', 'The gateway builds the connection to the target.');
      else if (!bhttps) hint.textContent = block.dataset.hintHttps || T('backend_tls.hint_https', 'Only with Backend HTTPS.');
      else hint.textContent = '';
    }
    // Gateway targets: the certificate is pinned by fingerprint instead (§13b);
    // stays usable inside the locked block, needs Backend HTTPS.
    var fp = byId('edit-backend-tls-fp');
    if (fp) {
      fp.hidden = !gateway;
      fp.classList.toggle('so-fields-off', gateway && !bhttps);
      var fpInput = byId('edit-route-backend-tls-fingerprint');
      if (fpInput) fpInput.disabled = !(gateway && bhttps);
    }
  }

  // ─── Gateway backend TLS fingerprint (release B §13b) ───
  // Same rule as routesValidation.normalizeBackendFingerprint: optional
  // "sha256:" prefix, colons/spaces/dashes ignored, 64 hex. '' clears it,
  // null = invalid. Shown with colons in upper case like browsers print it.
  function normalizeFingerprint(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^sha-?256\s*[:=]\s*/, '');
    var hex = s.replace(/[:\s-]/g, '');
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  }
  function formatFingerprint(hex) {
    var h = String(hex || '').toUpperCase();
    return /^[0-9A-F]{64}$/.test(h) ? h.match(/../g).join(':') : String(hex || '');
  }
  // Live check; the text goes to the block's error line (#edit-backend-tls-error),
  // the same place showSecoptError uses on save.
  function checkFingerprintField(strict) {
    var input = byId('edit-route-backend-tls-fingerprint');
    var err = byId('edit-backend-tls-error');
    if (!input || !err) return true;
    var raw = input.value.trim();
    var ok = input.disabled || normalizeFingerprint(raw) !== null;
    // While typing only complain once 64+ hex digits could be there.
    var show = !ok && (strict || raw.replace(/[^0-9a-fA-F]/g, '').length >= 64);
    var block = byId('edit-backend-tls-block');
    err.textContent = show ? ((block && block.dataset.errBackendTlsFingerprintInvalid) || T('backend_tls.err.fingerprint_invalid', 'Not a SHA-256 fingerprint.')) : '';
    err.hidden = !show;
    input.classList.toggle('field-invalid', show);
    if (show) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return ok;
  }

  function syncMtlsBlock() {
    var block = byId('edit-mtls-block');
    if (!block) return;
    var httpsOn = isOn('edit-route-https');
    var on = isOn('edit-route-mtls');
    block.classList.toggle('so-locked', !httpsOn && mtlsLicensed());
    var toggle = byId('edit-route-mtls');
    if (toggle && mtlsLicensed()) toggle.setAttribute('aria-disabled', httpsOn ? 'false' : 'true');
    var fields = byId('edit-mtls-fields');
    if (fields) fields.hidden = !on;
    var hint = byId('edit-mtls-hint');
    if (hint) hint.textContent = httpsOn ? '' : (block.dataset.hintHttps || T('mtls.hint_https', 'mTLS requires "Force HTTPS".'));
  }

  // Security-option fields for the PUT body: { fields } or { error: code }.
  function readSecOptFields(target, httpsOn) {
    var out = {};
    if (target.route_type === 'l4') return { fields: out };
    if (byId('edit-backend-tls-block') && (target.target_kind || 'peer') !== 'gateway') {
      var verify = byId('edit-route-backend-tls-verify');
      out.backend_tls_verify = !!(verify && verify.checked);
      out.backend_tls_server_name = (byId('edit-route-backend-tls-server-name').value || '').trim();
      out.backend_tls_ca_pem = (byId('edit-route-backend-tls-ca').value || '').trim();
    }
    // Gateway + Backend HTTPS: send the fingerprint ('' clears it). Without
    // Backend HTTPS it is not sent — the server drops a stored one then.
    var fpInput = byId('edit-route-backend-tls-fingerprint');
    if (fpInput && (target.target_kind || 'peer') === 'gateway' && isOn('edit-route-backend-https')) {
      var fpHex = normalizeFingerprint(fpInput.value);
      if (fpHex === null) { checkFingerprintField(true); return { error: 'BACKEND_TLS_FINGERPRINT_INVALID' }; }
      out.backend_tls_fingerprint = fpHex;
    }
    var mbInput = byId('edit-route-max-body-mb');
    if (mbInput) {
      var raw = String(mbInput.value || '').trim();
      if (raw === '') raw = '0';
      if (!/^\d+$/.test(raw) || parseInt(raw, 10) > BODY_MAX_MB) return { error: 'MAX_BODY_INVALID' };
      out.max_body_mb = parseInt(raw, 10);
    }
    if (byId('edit-mtls-block') && mtlsLicensed()) {
      var on = isOn('edit-route-mtls') && !!httpsOn;
      var pem = (byId('edit-route-mtls-ca').value || '').trim();
      if (on && !pem) return { error: 'MTLS_CA_REQUIRED' };
      out.mtls_enabled = on;
      out.mtls_ca_pem = pem;
    }
    return { fields: out };
  }

  function setupSecOptControls() {
    // app.js toggles the classes on click before these listeners run.
    var bhttps = byId('edit-route-backend-https');
    if (bhttps) bhttps.addEventListener('click', function () { syncBackendTlsBlock(); });
    var tk = byId('edit-route-target-kind');
    if (tk) tk.addEventListener('change', syncBackendTlsBlock);
    var verify = byId('edit-route-backend-tls-verify');
    if (verify) verify.addEventListener('change', syncBackendTlsBlock);
    var fpInput = byId('edit-route-backend-tls-fingerprint');
    if (fpInput) {
      fpInput.addEventListener('input', function () { checkFingerprintField(false); });
      fpInput.addEventListener('blur', function () {
        var hex = normalizeFingerprint(fpInput.value);
        if (hex) fpInput.value = formatFingerprint(hex);
        checkFingerprintField(true);
      });
    }
    var https = byId('edit-route-https');
    if (https) https.addEventListener('click', function () { syncMtlsBlock(); });
    var mtls = byId('edit-route-mtls');
    if (mtls && mtlsLicensed()) {
      mtls.addEventListener('click', function () {
        syncMtlsBlock();
        var ca = byId('edit-route-mtls-ca');
        if (isOn('edit-route-mtls') && ca && !ca.value.trim()) ca.focus();
      });
    }
  }

  // ═══ Web Application Firewall (docs/feature-waf.md, Tab Sicherheit) ═══════
  // #edit-route-waf (toggle, always managed here — never by app.js),
  // #edit-route-waf-mode (detect|block), #edit-route-waf-paranoia (1–4),
  // #edit-waf-exclusions (list built by GCWafUI.exclusionsEditor, saved per
  // item through the WAF API), #edit-waf-engine-hint (GET /waf/status). Locked
  // without the waf license (#edit-waf-block data-licensed="0" or
  // window.GC.features.waf === false): then the fields are never sent.

  var wafExclusions = null;   // GCWafUI.exclusionsEditor instance (built on first open)

  function wafLicensed() {
    var block = byId('edit-waf-block');
    if (!block || block.dataset.licensed === '0') return false;
    return !(window.GC && window.GC.features && window.GC.features.waf === false);
  }
  function wafText(name, key, fallback) {
    var block = byId('edit-waf-block');
    return (block && block.dataset[name]) || T(key, fallback);
  }
  function wafRouteType() {
    var rt = byId('edit-route-type');
    return rt ? (rt.value || 'http') : ((state.route && state.route.route_type) || 'http');
  }
  function wafMode(v) { return String(v || '').toLowerCase() === 'block' ? 'block' : 'detect'; }
  function wafParanoia(v) {
    var n = parseInt(v, 10);
    return n >= 1 && n <= 4 ? n : 1;
  }

  function populateWaf(route) {
    var block = byId('edit-waf-block');
    if (!block) return;
    setToggle('edit-route-waf', flag(route.waf_enabled));
    setVal('edit-route-waf-mode', wafMode(route.waf_mode));
    setVal('edit-route-waf-paranoia', String(wafParanoia(route.waf_paranoia)));
    var link = byId('edit-waf-events-link');
    if (link) link.setAttribute('href', '/waf' + (route.domain ? '?host=' + encodeURIComponent(String(route.domain).toLowerCase()) : ''));
    var W = window.GCWafUI;
    var box = byId('edit-waf-exclusions');
    if (box && W && typeof W.exclusionsEditor === 'function') {
      if (!wafExclusions) wafExclusions = W.exclusionsEditor(box, route);
      else wafExclusions.set(route);
    }
    var engine = byId('edit-waf-engine-hint');
    if (engine) {
      engine.textContent = '';
      if (W && typeof W.engineHint === 'function' && wafLicensed() && route.route_type !== 'l4') W.engineHint(engine);
    }
    syncWafBlock();
  }

  function syncWafBlock() {
    var block = byId('edit-waf-block');
    if (!block) return;
    var licensed = wafLicensed();
    var http = wafRouteType() !== 'l4';
    var active = licensed && http;
    var on = isOn('edit-route-waf');
    block.classList.toggle('feature-locked', !licensed);
    block.classList.toggle('wf-license-locked', !licensed);
    block.classList.toggle('wf-locked', licensed && !http);
    block.dataset.waf = on ? 'on' : 'off';
    var toggle = byId('edit-route-waf');
    if (toggle) {
      toggle.setAttribute('aria-disabled', active ? 'false' : 'true');
      toggle.setAttribute('tabindex', active ? '0' : '-1');
    }
    var fields = byId('edit-waf-fields');
    if (fields) fields.classList.toggle('wf-fields-off', !on);
    ['edit-route-waf-mode', 'edit-route-waf-paranoia'].forEach(function (id) {
      var n = byId(id);
      if (n) n.disabled = !(active && on);
    });
    var mode = wafMode(val('edit-route-waf-mode', 'detect'));
    block.dataset.wafMode = mode;
    var mh = byId('edit-waf-mode-hint');
    if (mh) mh.textContent = wafText(mode === 'block' ? 'modeHintBlock' : 'modeHintDetect', 'waf.mode_' + mode + '_hint', '');
    var p = wafParanoia(val('edit-route-waf-paranoia', '1'));
    var ph = byId('edit-waf-paranoia-hint');
    if (ph) ph.textContent = wafText('paranoiaHint' + p, 'waf.paranoia_' + p + '_hint', '');
    var hint = byId('edit-waf-hint');
    if (hint) hint.textContent = licensed && !http ? wafText('hintHttp', 'waf.hint_http', 'HTTP entries only.') : '';
    var locked = byId('edit-waf-locked-hint');
    if (locked) {
      locked.hidden = licensed;
      // Licence hint (docs/feature-release-b.md §11): why it is locked + "Lizenz aktualisieren".
      if (!licensed && window.GCLicenseHint) window.GCLicenseHint.mount(locked, 'waf');
    }
    var link = byId('edit-waf-events-link');
    if (link) link.hidden = !licensed;
    if (wafExclusions) wafExclusions.setDisabled(!active);
  }

  // waf_* fields for the PUT body; nothing without the license or for L4.
  function readWafFields(target) {
    if (!byId('edit-waf-block') || !wafLicensed() || target.route_type === 'l4') return {};
    return {
      waf_enabled: isOn('edit-route-waf'),
      waf_mode: wafMode(val('edit-route-waf-mode', 'detect')),
      waf_paranoia: wafParanoia(val('edit-route-waf-paranoia', '1')),
    };
  }

  function setupWafControls() {
    var toggle = byId('edit-route-waf');
    if (!toggle) return;
    function flip() {
      if (!wafLicensed() || wafRouteType() === 'l4') return;
      setToggle('edit-route-waf', !isOn('edit-route-waf'));
      syncWafBlock();
    }
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    });
    ['edit-route-waf-mode', 'edit-route-waf-paranoia'].forEach(function (id) {
      var n = byId(id);
      if (n) n.addEventListener('change', syncWafBlock);
    });
    var rt = byId('edit-route-type');
    if (rt) rt.addEventListener('change', syncWafBlock);
  }

  // ═══ Header (presets + editable lists) + branding ══════════════════════════
  // Request headers go to the device in the LAN, response headers to the
  // browser. A name '-Name' removes that header (no value). Presets come from
  // secopt-ui.js (HEADER_PRESETS / HEADER_PRESETS_REQUEST); a header of the
  // same name is replaced, not duplicated.

  function svgX() {
    var n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    [['viewBox', '0 0 24 24'], ['width', '15'], ['height', '15'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2.2'], ['stroke-linecap', 'round'], ['aria-hidden', 'true']]
      .forEach(function (a) { n.setAttribute(a[0], a[1]); });
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    n.appendChild(p);
    return n;
  }

  function renderHeadersList(prefix, type, arr) {
    var list = byId(prefix + '-headers-' + type + '-list');
    if (!list) return;
    list.textContent = '';
    if (!arr.length) list.appendChild(el('div', { class: 'rt-hint rt-ee-hempty', text: T('entry_editor.no_headers', 'No headers yet.') }));
    arr.forEach(function (h, idx) {
      var removal = String(h.name || '').trim().charAt(0) === '-';
      var name = el('input', { type: 'text', class: 'rt-input rt-mono', maxlength: '257', placeholder: T('headers.name', 'Header name'), 'aria-label': T('headers.name', 'Header name') });
      name.value = h.name || '';
      var value = el('input', { type: 'text', class: 'rt-input rt-mono', maxlength: '4096', 'aria-label': T('headers.value', 'Value') });
      value.value = removal ? '' : (h.value || '');
      function syncRemoval() {
        var rm = name.value.trim().charAt(0) === '-';
        value.disabled = rm;
        value.placeholder = rm ? T('entry_editor.header_removed', '(removed)') : T('headers.value', 'Value');
        if (rm) { value.value = ''; arr[idx].value = ''; }
      }
      syncRemoval();
      name.addEventListener('input', function () { arr[idx].name = name.value; syncRemoval(); onHeadersChanged(); });
      value.addEventListener('input', function () { arr[idx].value = value.value; onHeadersChanged(); });
      var del = el('button', { type: 'button', class: 'rt-ibtn zn-ibtn', 'aria-label': T('entry_editor.remove_header', 'Remove header {{name}}').replace('{{name}}', h.name || String(idx + 1)) }, [svgX()]);
      del.addEventListener('click', function () { arr.splice(idx, 1); renderHeadersList(prefix, type, arr); onHeadersChanged(); });
      list.appendChild(el('div', { class: 'rt-ee-hrow' }, [name, value, del]));
    });
  }

  function setupHeadersAdd(prefix, type, arr) {
    var short = type === 'request' ? 'req' : 'resp';
    var addBtn = byId(prefix + '-headers-' + short + '-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', function () {
      arr.push({ name: '', value: '' });
      renderHeadersList(prefix, type, arr);
      var list = byId(prefix + '-headers-' + type + '-list');
      var inputs = list ? list.querySelectorAll('.rt-ee-hrow input') : [];
      if (inputs.length > 1) inputs[inputs.length - 2].focus();
      onHeadersChanged();
    });
  }

  function syncPresetStates() {
    var SO = window.GCSecOptUI;
    var box = byId('edit-headers-presets');
    if (!box || !SO || typeof SO.presetApplied !== 'function') return;
    box.querySelectorAll('[data-preset]').forEach(function (b) {
      b.setAttribute('aria-pressed', SO.presetApplied(editHeadersRequest, editHeadersResponse, b.dataset.preset) ? 'true' : 'false');
    });
  }
  function onHeadersChanged() {
    syncPresetStates();
    onFormChange();
  }
  // Strict-Transport-Security in the response list while the HSTS switch is on.
  function syncHstsDup() {
    var dup = byId('ee-headers-hsts-dup');
    if (dup) {
      dup.hidden = !(isOn('edit-route-hsts') && editHeadersResponse.some(function (h) { return String(h.name || '').trim().toLowerCase() === 'strict-transport-security'; }));
    }
  }

  // Header lists for the PUT: empty rows dropped; { error } for a header
  // without a value (the server would refuse it).
  function readHeaders() {
    function clean(arr) {
      return arr.map(function (h) { return { name: String(h.name || '').trim(), value: String(h.value || '') }; })
        .filter(function (h) { return h.name || h.value.trim(); });
    }
    var req = clean(editHeadersRequest);
    var res = clean(editHeadersResponse);
    var bad = req.concat(res).find(function (h) { return !h.name || (h.name.charAt(0) !== '-' && !h.value.trim()); });
    if (bad) return { error: bad.name ? T('entry_editor.header_needs_value', 'Header {{name}} needs a value').replace('{{name}}', bad.name) : T('entry_editor.header_needs_name', 'A header needs a name') };
    return { request: req, response: res };
  }

  function setupHeaderControls() {
    setupHeadersAdd('edit', 'request', editHeadersRequest);
    setupHeadersAdd('edit', 'response', editHeadersResponse);
    var presets = byId('edit-headers-presets');
    if (presets) {
      presets.addEventListener('click', function (e) {
        var b = e.target.closest('[data-preset]');
        if (!b) return;
        var val = b.dataset.preset;
        // The security preset never adds Strict-Transport-Security — the HSTS
        // switch on the security section owns that header (docs/feature-hsts.md).
        showIf('edit-headers-hsts-hint', val === 'security');
        // The CSP preset breaks apps with external sources — say so.
        var cspWarn = byId('edit-headers-csp-warning');
        if (cspWarn) cspWarn.hidden = val !== 'csp';
        var SO = window.GCSecOptUI;
        if (SO && typeof SO.applyPresetSets === 'function') {
          var next = SO.applyPresetSets(editHeadersRequest, editHeadersResponse, val);
          editHeadersRequest.length = 0;
          next.request.forEach(function (h) { editHeadersRequest.push(h); });
          editHeadersResponse.length = 0;
          next.response.forEach(function (h) { editHeadersResponse.push(h); });
        } else {
          console.warn('GCEntryEditor: secopt-ui.js missing, header preset "' + val + '" not applied');
        }
        renderHeadersList('edit', 'request', editHeadersRequest);
        renderHeadersList('edit', 'response', editHeadersResponse);
        onHeadersChanged();
      });
    }
  }

  // Live login-page preview of the branding section.
  function renderBrandingPreview() {
    var title = val('edit-branding-title', '') || 'GateControl';
    var text = val('edit-branding-text', '') || T('branding.text_placeholder', 'Please sign in to continue');
    var accent = val('edit-branding-color', '#0a6e4f');
    var bg = val('edit-branding-bg', '#f2f0eb');
    var pv = byId('ee-brand-preview');
    if (pv) pv.style.background = /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : '#f2f0eb';
    var logo = byId('ee-bp-logo');
    if (logo) { logo.style.background = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#0a6e4f'; logo.textContent = title.slice(0, 2).toUpperCase(); }
    var btn = byId('ee-bp-btn');
    if (btn) btn.style.background = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#0a6e4f';
    var tt = byId('ee-bp-title');
    if (tt) tt.textContent = title;
    var tx = byId('ee-bp-text');
    if (tx) tx.textContent = text;
    var cv = byId('ee-color-val');
    if (cv) cv.textContent = accent;
    var bv = byId('ee-bg-val');
    if (bv) bv.textContent = bg;
    var inactive = byId('ee-branding-inactive');
    if (inactive) inactive.hidden = val('edit-auth-type', 'none') === 'route';
  }

  function setupBrandingUpload(fileInputId, field, urlPart, currentId, removeId) {
    var fileInput = byId(fileInputId);
    if (fileInput) {
      fileInput.addEventListener('change', async function () {
        var file = this.files[0];
        if (!file) return;
        var routeId = (byId('edit-route-id') || {}).value;
        if (!routeId) return;
        var formData = new FormData();
        formData.append(field, file);
        try {
          var resp = await fetch('/api/v1/routes/' + routeId + '/branding/' + urlPart, {
            method: 'POST',
            headers: { 'X-CSRF-Token': window.GC.csrfToken },
            body: formData,
          });
          var data = await resp.json();
          if (data.ok) {
            byId(currentId).textContent = data.filename;
            byId(removeId).style.display = '';
          } else {
            dlgError(data.error || T('branding.upload_failed', 'Upload failed'));
          }
        } catch (err) { dlgError(err.message); }
      });
    }
    var removeBtn = byId(removeId);
    if (removeBtn) {
      removeBtn.addEventListener('click', async function () {
        var routeId = (byId('edit-route-id') || {}).value;
        if (!routeId) return;
        try {
          await window.api.del('/api/v1/routes/' + routeId + '/branding/' + urlPart);
          byId(currentId).textContent = '';
          removeBtn.style.display = 'none';
        } catch (err) { dlgError(err.message); }
      });
    }
  }

  // ═══ Tabs + debug trace polling ════════════════════════════════════════════

  var traceInterval = null;
  var lastTraceSince = '';

  function startTracePolling(routeId) {
    stopTracePolling();
    lastTraceSince = '';
    var log = byId('edit-debug-log');
    if (log) log.querySelectorAll('.trace-entry').forEach(function (n) { n.remove(); });
    showIf('edit-debug-empty', true);
    fetchTraceEntries(routeId);
    traceInterval = setInterval(function () {
      // The modal can be closed via X / Escape (app.js) without telling us.
      if (!isOpen()) { stopTracePolling(); return; }
      fetchTraceEntries(routeId);
    }, 3000);
  }

  function stopTracePolling() {
    if (traceInterval) { clearInterval(traceInterval); traceInterval = null; }
  }

  function fetchTraceEntries(routeId) {
    var url = '/api/v1/routes/' + routeId + '/trace?limit=50';
    if (lastTraceSince) url += '&since=' + encodeURIComponent(lastTraceSince);
    window.api.get(url).then(function (res) {
      if (res.ok && res.data && res.data.entries) renderTraceEntries(res.data.entries);
    }).catch(function (err) { console.warn('[entry-editor] loading trace entries failed', err); });
  }

  function renderTraceEntries(entries) {
    var log = byId('edit-debug-log');
    var empty = byId('edit-debug-empty');
    if (!log) return;
    if (entries.length === 0 && !log.querySelector('.trace-entry')) return;
    if (empty) empty.style.display = entries.length > 0 || log.querySelector('.trace-entry') ? 'none' : '';

    entries.forEach(function (e) {
      if (e.timestamp && e.timestamp > lastTraceSince) lastTraceSince = e.timestamp;
      var statusColor = e.status >= 500 ? 'var(--red, #f87171)' : e.status >= 400 ? warnColor() : 'var(--green, #4ade80)';
      var ts = (String(e.timestamp || '').split('T')[1] || '').split('.')[0] || '';
      log.insertBefore(el('div', {
        class: 'trace-entry',
        style: 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);align-items:center;font-size:11px',
      }, [
        el('span', { style: 'color:var(--text-3);min-width:70px', text: ts }),
        el('span', { style: 'font-weight:600;min-width:40px', text: e.method || '' }),
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: e.uri || '' }),
        el('span', { style: 'color:' + statusColor + ';font-weight:600;min-width:30px', text: String(e.status || '-') }),
        el('span', { style: 'color:var(--text-3);min-width:80px', text: e.remote_ip || '' }),
      ]), log.firstChild);
    });
  }

  // ═══ Sections (left nav) ═══════════════════════════════════════════════════
  function goSection(id) {
    var modal = byId(MODAL_ID);
    if (!modal) return;
    var btn = modal.querySelector('.rt-ee-tab[data-ee-section="' + id + '"]');
    if (!btn) return;
    state.section = id;
    modal.querySelectorAll('.rt-ee-tab').forEach(function (t) { t.setAttribute('aria-current', t === btn ? 'page' : 'false'); });
    modal.querySelectorAll('.rt-ee-panel').forEach(function (p) { p.hidden = p.dataset.panel !== id; });
    var panels = byId('ee-panels');
    if (panels) panels.scrollTop = 0;
    // Request tracing polls only while the diagnose section is shown.
    if (id === 'diagnose' && currentEditRouteId && kindNow() === 'http') startTracePolling(currentEditRouteId);
    else stopTracePolling();
  }

  function setupTabsAndDebug() {
    var nav = byId('ee-nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        var b = e.target.closest('[data-ee-section]');
        if (b) goSection(b.dataset.eeSection);
      });
      // Arrow keys move between sections (a vertical tab list).
      nav.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        var list = Array.prototype.slice.call(nav.querySelectorAll('[data-ee-section]'));
        var i = list.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        var n = list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
        n.focus();
        goSection(n.dataset.eeSection);
      });
    }
    var modal = byId(MODAL_ID);
    if (modal) {
      modal.addEventListener('click', function (e) {
        var g = e.target.closest('[data-ee-goto]');
        if (g) goSection(g.dataset.eeGoto);
      });
    }

    var debugClear = byId('edit-debug-clear');
    if (debugClear) {
      debugClear.addEventListener('click', function () {
        var log = byId('edit-debug-log');
        if (log) {
          log.querySelectorAll('.trace-entry').forEach(function (n) { n.remove(); });
          showIf('edit-debug-empty', true);
        }
        lastTraceSince = '';
      });
    }
  }

  // ═══ Live summaries, connection path, change summary ═══════════════════════

  function summaryOf(id) {
    var isL4 = kindNow() !== 'http';
    var bits = [];
    if (id === 'target') {
      var port = val('edit-route-port', '?');
      var host = targetKindNow() === 'gateway' ? val('edit-route-lan-host', '?') : peerTargetText();
      if (isL4) return ':' + val('edit-l4-listen-port', '?') + ' → ' + host + ' : ' + port;
      return host + ' : ' + port + (isOn('edit-route-backend-https') ? ' · HTTPS' : '');
    }
    if (id === 'access') {
      bits.push(isOn('edit-route-external') ? T('entry_editor.sum_external', 'External') : T('entry_editor.sum_internal', 'Internal only'));
      if (isOn('edit-route-on-demand')) bits.push(T('entry.on_demand_tag', 'on demand'));
      if (!isL4 && isOn('edit-route-ip-filter')) bits.push(T('entry_editor.sum_ip_filter', 'IP filter'));
      if (!isL4 && isOn('edit-route-acl')) bits.push(T('entry_editor.sum_acl', 'Peer ACL'));
      var rules = byId('access-rules-list');
      if (!isL4 && rules && rules.querySelector('[data-rule]')) bits.push(T('entry_editor.sum_windows', 'Time windows'));
      return bits.join(' · ');
    }
    if (isL4 && (id === 'auth' || id === 'headers' || id === 'branding')) return T('entry_editor.https_only', 'HTTPS only');
    if (id === 'auth') {
      var a = val('edit-auth-type', 'none');
      if (a === 'basic') return T('route_auth.auth_basic', 'Basic Auth');
      if (a === 'route') {
        var two = isOn('edit-ra-2fa');
        var m = val('edit-ra-method', 'email_password');
        var label = two ? T('route_auth.method_email_password', 'E-mail & password') : T('route_auth.method_' + m, m);
        return T('route_auth.auth_route', 'Route Auth') + ' · ' + label + (two ? ' + 2FA' : '');
      }
      return T('route_auth.auth_none', 'None');
    }
    if (id === 'security') {
      if (isL4) {
        if (isOn('edit-l4-route-ip-filter')) bits.push(T('entry_editor.sum_ip_filter', 'IP filter'));
        if (isOn('edit-l4-conn-rate')) bits.push(T('entry_editor.sum_conn_rate', 'Connection rate'));
        return bits.join(' · ') || '–';
      }
      if (isOn('edit-route-hsts') && isOn('edit-route-https')) bits.push('HSTS');
      if (isOn('edit-route-waf')) bits.push(val('edit-route-waf-mode', 'detect') === 'block' ? T('waf.chip_block', 'WAF') : T('waf.chip_detect', 'WAF (detect)'));
      if (isOn('edit-route-rate-limit')) bits.push(T('entry_editor.sum_rate', 'Rate limit'));
      if (isOn('edit-route-bot-blocker')) bits.push(T('entry_editor.sum_bots', 'Bot blocker'));
      var mb = parseInt(val('edit-route-max-body-mb', '0'), 10);
      if (mb > 0) bits.push('≤ ' + mb + ' MB');
      return bits.join(' · ') || '–';
    }
    if (id === 'reliability') {
      if (isOn('edit-route-monitoring')) bits.push(T('entry_editor.sum_monitoring', 'Monitoring'));
      if (!isL4) {
        if (isOn('edit-route-backends')) bits.push(T('entry_editor.sum_backends', 'Backends'));
        if (isOn('edit-route-retry')) bits.push(T('entry_editor.sum_retry', 'Retry'));
        if (isOn('edit-route-circuit-breaker')) bits.push(T('entry_editor.sum_cb', 'Circuit breaker'));
        if (isOn('edit-route-compress')) bits.push(T('entry_editor.sum_compress', 'Compression'));
        if (isOn('edit-route-mirror')) bits.push(T('entry_editor.sum_mirror', 'Mirroring'));
      }
      return bits.join(' · ') || '–';
    }
    if (id === 'headers') {
      var n = editHeadersRequest.length + editHeadersResponse.length;
      return T(n === 1 ? 'entry_editor.sum_headers_one' : 'entry_editor.sum_headers', '{{count}} headers').replace('{{count}}', String(n));
    }
    if (id === 'branding') {
      if (val('edit-auth-type', 'none') !== 'route') return T('entry_editor.sum_branding_off', 'only with Route Auth');
      return val('edit-branding-title', '') || 'GateControl';
    }
    if (id === 'diagnose') {
      if (!isL4 && isOn('edit-route-debug')) return T('entry_editor.sum_trace_on', 'Tracing on');
      return diagStatusText();
    }
    return '';
  }

  function peerTargetText() {
    var z = state.zoneManaged ? zoneTargetOf() : null;
    if (z) return z.ip || z.name || '?';
    var sel = byId('edit-route-peer');
    if (sel && sel.value) {
      var p = state.peers.find(function (x) { return String(x.id) === String(sel.value); });
      if (p) return peerIp(p) || p.name;
    }
    return val('edit-route-ip', '?');
  }

  function diagStatusText() {
    var r = state.route || {};
    if (!r.enabled) return T('host.status_disabled', 'disabled');
    if (r.monitoring_enabled && r.monitoring_status === 'down') return T('entry_editor.diag_down', 'Not reachable');
    if (r.monitoring_enabled && r.monitoring_status === 'up') return T('entry_editor.diag_up', 'Reachable') + (r.monitoring_response_time != null ? ' · ' + r.monitoring_response_time + ' ms' : '');
    return T('entry_editor.diag_unknown', 'No check yet');
  }

  function renderDiagnose() {
    var r = state.route || {};
    var st = byId('ee-diag-status');
    if (st) {
      st.textContent = '';
      var cls = !r.enabled ? 'disabled' : (r.monitoring_enabled && r.monitoring_status === 'down') ? 'down' : (r.monitoring_enabled && r.monitoring_status === 'up') ? 'ok' : 'degraded';
      st.appendChild(el('span', { class: 'rt-dot zn-dot-' + cls, 'aria-hidden': 'true' }));
      st.appendChild(document.createTextNode(' ' + diagStatusText().split(' · ')[0]));
    }
    var tm = byId('ee-diag-time');
    if (tm) tm.textContent = r.monitoring_response_time != null && r.monitoring_enabled ? r.monitoring_response_time + ' ms' : '–';
    var cert = byId('ee-diag-cert');
    if (cert) {
      var h = ctxHost();
      var entry = h ? (h.entries || []).find(function (e) { return e.id === r.id; }) : null;
      var tls = entry && entry.tls;
      if (r.route_type === 'l4' && !(r.l4_tls_mode && r.l4_tls_mode !== 'none')) cert.textContent = T('entry_editor.cert_none', 'no certificate (TCP/UDP)');
      else if (tls && tls.state === 'issued' && tls.not_after) cert.textContent = T('entry_editor.cert_valid_until', 'valid until {{date}}').replace('{{date}}', new Date(tls.not_after).toLocaleDateString());
      else if (tls && (tls.state === 'failed' || tls.state === 'expiring')) cert.textContent = T('entry_editor.cert_problem', 'problem – see certificates');
      else if (tls && TLS_STATE_KEYS[tls.state]) cert.textContent = T(TLS_STATE_KEYS[tls.state], tls.state);
      else cert.textContent = T('entry_editor.cert_auto', 'issued automatically');
    }
    var md = byId('ee-monitor-desc');
    if (md && r.monitoring_enabled && r.monitoring_status) md.textContent = T('monitoring.toggle_desc', '') + ' · ' + diagStatusText();
  }

  // Static tls.state_* keys without {{placeholders}} (failed/expiring map to
  // entry_editor.cert_problem above).
  var TLS_STATE_KEYS = {
    pending: 'tls.state_pending', paused: 'tls.state_paused', internal: 'tls.state_internal',
    none: 'tls.state_none', unknown: 'tls.state_unknown',
  };

  // "Weg der Verbindung": Internet/VPN :port → GateControl [→ Anmeldung] → Gateway → LAN host:port
  function renderFlow() {
    var box = byId('ee-flow');
    var V = window.GCZonesView;
    if (!box || !V) return;
    var kind = kindNow();
    var tk = targetKindNow();
    var target;
    if (state.zoneManaged && zoneTargetOf()) target = zoneTargetOf();
    else if (tk === 'gateway') {
      var gsel = byId('edit-route-gateway-peer');
      var gp = gsel && state.peers.find(function (x) { return String(x.id) === String(gsel.value); });
      target = { kind: state.route && state.route.target_pool_id != null ? 'pool' : 'gateway', name: gp ? gp.name : (state.route && state.route.target_peer_name) || '?' };
    } else {
      target = { kind: 'peer', name: '' };
    }
    var steps = V.entryFlow({
      external: isOn('edit-route-external'), kind: kind, outer: kind === 'http' ? (isOn('edit-route-https') ? '443' : '80') : val('edit-l4-listen-port', ''),
      fqdn: hostFqdn(), auth: kind === 'http' ? val('edit-auth-type', 'none') : 'none',
      target: { kind: target.kind === 'peer' ? 'peer' : target.kind, name: target.name },
      lanHost: tk === 'gateway' ? val('edit-route-lan-host', '?') : peerTargetText(), port: val('edit-route-port', '?'),
    });
    var KICK = {
      internet: T('entry_editor.flow_internet', 'Internet'), vpn: T('entry_editor.flow_vpn', 'VPN'), lan: T('entry_editor.flow_lan', 'Device in the LAN'),
      peer: T('entry_editor.flow_peer', 'VPN peer'), gateway: T('entry_editor.gateway', 'Gateway'), pool: T('entry_editor.pool', 'Gateway pool'),
    };
    box.textContent = '';
    steps.forEach(function (st, i) {
      var kicker = st.id === 'gc' ? 'GateControl' : st.id === 'auth' ? T('entry_editor.flow_auth', 'Login') : (KICK[st.kicker] || st.kicker || '');
      var value = st.id === 'auth' ? (st.value === 'basic' ? T('route_auth.auth_basic', 'Basic Auth') : T('route_auth.auth_route', 'Route Auth')) : st.value;
      box.appendChild(el('div', { class: 'rt-ee-step rt-ee-step-' + st.id }, [
        el('div', { class: 'rt-ee-step-k', text: kicker }),
        el('div', { class: 'rt-ee-step-v rt-mono', text: value }),
      ]));
      if (i < steps.length - 1) box.appendChild(el('span', { class: 'rt-ee-step-arrow', 'aria-hidden': 'true', text: '→' }));
    });
  }

  // Form values for the change summary: every input/select/textarea and
  // toggle of the modal by id, plus the list-shaped state.
  // Share links and access windows save through their own API calls, so
  // their form fields are not part of "Speichern" (and they load later).
  var SNAPSHOT_SKIP = '#share-links-section, #access-windows-section';
  function formSnapshot() {
    var modal = byId(MODAL_ID);
    var out = {};
    if (!modal) return out;
    modal.querySelectorAll('input[id], select[id], textarea[id]').forEach(function (n) {
      if (n.type === 'file' || n.id === 'edit-route-id' || n.closest(SNAPSHOT_SKIP)) return;
      out[n.id] = n.type === 'checkbox' ? String(n.checked) : n.value;
    });
    modal.querySelectorAll('.toggle[id]').forEach(function (n) { out[n.id] = String(n.classList.contains('on')); });
    out['#headers'] = JSON.stringify([editHeadersRequest, editHeadersResponse]);
    out['#ipfilter'] = JSON.stringify(editIpFilterRules);
    out['#backends'] = JSON.stringify(editBackendsList);
    out['#mirror'] = JSON.stringify(editMirrorTargets);
    out['#acl'] = JSON.stringify(getSelectedAclPeers('edit'));
    var users = [];
    document.querySelectorAll('#route-user-ids .route-user-cb:checked').forEach(function (cb) { users.push(cb.value); });
    out['#users'] = users.join(',');
    return out;
  }
  // Fields filled asynchronously after open() take their loaded value as the
  // starting point (no false "1 more change").
  function rebaseSnapshot(ids) {
    if (!state.snapshot) return;
    var cur = formSnapshot();
    ids.forEach(function (k) { if (cur[k] !== undefined) state.snapshot[k] = cur[k]; });
    renderChanges();
  }
  // Readable changes for the footer ("Port am Ziel 3389 → 3390 · …").
  var CHANGE_LABELS = {
    'edit-route-port': 'entry.target_port', 'edit-l4-listen-port': 'entry.listen_port', 'edit-route-lan-host': 'route_lan_host',
    'edit-route-label': 'entry.label_field', 'edit-route-type': 'entry_editor.type', 'edit-l4-protocol': 'entry_editor.type',
  };
  function changeList() {
    var cur = formSnapshot();
    var base = state.snapshot || {};
    var keys = Object.keys(cur).filter(function (k) { return base[k] !== undefined && cur[k] !== base[k]; });
    var out = [];
    var other = 0;
    var typeDone = false;
    keys.forEach(function (k) {
      if (k === 'edit-route-type' || k === 'edit-l4-protocol') {
        if (typeDone) return;
        typeDone = true;
        var from = base['edit-route-type'] === 'l4' ? String(base['edit-l4-protocol'] || 'tcp').toUpperCase() : 'HTTPS';
        var to = kindNow() === 'http' ? 'HTTPS' : kindNow().toUpperCase();
        if (from !== to) out.push(T('entry_editor.type', 'Type') + ' ' + from + ' → ' + to);
        return;
      }
      if (k === 'edit-route-external') { out.push(cur[k] === 'true' ? T('entry_editor.chg_external_on', 'now reachable externally') : T('entry_editor.chg_external_off', 'now internal only')); return; }
      if (CHANGE_LABELS[k]) { out.push(T(CHANGE_LABELS[k], k) + ' ' + (base[k] || '—') + ' → ' + (cur[k] || '—')); return; }
      other++;
    });
    return { items: out, other: other, count: out.length + other };
  }
  function renderChanges() {
    var box = byId('ee-changes');
    if (!box) return;
    var c = changeList();
    if (!c.count) {
      box.textContent = T('zones.no_changes', 'No changes');
      box.classList.remove('rt-dirty');
      return;
    }
    if (!c.items.length) {
      box.textContent = T(c.other === 1 ? 'zones.dirty_one' : 'zones.dirty', '{{count}} unsaved changes').replace('{{count}}', String(c.other));
      box.classList.add('rt-dirty');
      return;
    }
    var parts = c.items.slice();
    if (c.other) parts.push(T(c.other === 1 ? 'entry_editor.chg_other_one' : 'entry_editor.chg_other', '{{count}} more').replace('{{count}}', String(c.other)));
    box.textContent = T('entry_editor.changes', 'Changes') + ': ' + parts.join(' · ');
    box.classList.add('rt-dirty');
  }

  function renderSummaries() {
    ['target', 'access', 'auth', 'security', 'reliability', 'headers', 'branding', 'diagnose'].forEach(function (id) {
      var n = byId('ee-sum-' + id);
      if (n) n.textContent = summaryOf(id);
    });
    var sub = byId('ee-name-sub');
    var label = val('edit-route-label', '') || val('edit-route-desc', '');
    if (sub) sub.textContent = label ? ' · ' + label : '';
  }

  var changeFrame = null;
  function onFormChange() {
    if (changeFrame) return;
    changeFrame = (window.requestAnimationFrame || setTimeout)(function () {
      changeFrame = null;
      if (!isOpen()) return;
      renderSummaries();
      renderFlow();
      renderChanges();
      renderBrandingPreview();
      syncHstsDup();
    });
  }

  // Escape (with the unsaved-changes question) and Tab stay inside the
  // editor while it is the topmost overlay; capture phase so app.js's global
  // Escape, which hides every overlay, never sees the key.
  function topOverlay() {
    var best = null;
    var bestZ = -Infinity;
    document.querySelectorAll('.modal-overlay').forEach(function (o) {
      if (o.style.display === 'none') return;
      var cs = window.getComputedStyle(o);
      if (cs.display === 'none') return;
      var z = parseInt(cs.zIndex, 10) || 0;
      if (z >= bestZ) { best = o; bestZ = z; }
    });
    return best;
  }
  function onEditorKey(e) {
    var overlay = byId(MODAL_ID);
    if (!overlay || !isOpen() || topOverlay() !== overlay) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    e.stopPropagation();
    var box = overlay.querySelector('.rt-ee');
    var list = Array.prototype.slice.call(box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(function (n) { return n.offsetParent !== null && !n.closest('[inert]'); });
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  // ═══ Share links (Pro: share_links) ════════════════════════════════════════

  function shareErrMsg(code) {
    var map = {
      disable_basic_auth: T('route_auth.share_err_basic_auth', 'This route uses HTTP Basic Auth. Disable Basic Auth before creating a share link.'),
      l4_not_supported: T('route_auth.share_err_l4', 'Share links are only available for HTTP routes.'),
      invalid_expiry: T('route_auth.share_err_expiry', 'Please choose a valid expiry time.'),
    };
    return map[code] || code;
  }

  function formatShareExpiry(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  async function loadShareLinks(routeId) {
    var list = byId('share-links-list');
    if (!list) return;
    // The secret URL box and create form are siblings of the list (not children),
    // so clearing the list alone would leak a previously shown one-time URL across
    // modal reopens — including for a different route. Remove them explicitly.
    var once = byId('share-link-url-once');
    if (once) once.remove();
    var form = byId('share-link-create-form');
    if (form) form.remove();
    list.textContent = '';
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var links = (data && data.links) || [];
      if (!links.length) {
        list.appendChild(el('div', { class: 'form-hint', text: T('route_auth.share_none', 'No share links yet.') }));
        return;
      }
      links.forEach(function (link) { list.appendChild(renderShareLinkRow(routeId, link)); });
    } catch (err) {
      list.appendChild(el('div', { class: 'form-hint', text: err.message }));
    }
  }

  function renderShareLinkRow(routeId, link) {
    var meta = [];
    if (link.label) meta.push(link.label);
    meta.push(formatShareExpiry(link.expires_at));
    meta.push(link.one_time ? T('route_auth.share_one_time', 'One-time') : T('route_auth.share_reusable', 'Reusable'));
    meta.push(T('route_auth.share_redeemed', 'Redeemed') + ': ' + (link.redeemed_count || 0));

    var info = el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-size:12px;color:var(--text-2)', text: meta.join(' · ') }),
    ]);
    var revokeBtn = el('button', { type: 'button', class: 'btn btn-sm', text: T('route_auth.share_revoke', 'Revoke') });
    revokeBtn.addEventListener('click', function () { revokeShareLink(routeId, link.id); });
    return el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
    }, [info, revokeBtn]);
  }

  async function revokeShareLink(routeId, linkId) {
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links/' + linkId, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      loadShareLinks(routeId);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showShareCreateForm(routeId) {
    var list = byId('share-links-list');
    if (!list) return;
    if (byId('share-link-create-form')) return;

    var expirySelect = el('select', { id: 'share-link-expiry', class: 'form-select', style: 'flex:1' }, [
      el('option', { value: '1', text: '1 h' }),
      el('option', { value: '24', text: '24 h' }),
      el('option', { value: '168', text: '168 h' }),
    ]);
    expirySelect.value = '24';

    var oneTime = el('input', { type: 'checkbox', id: 'share-link-one-time' });
    var oneTimeLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px' }, [
      oneTime,
      T('route_auth.share_one_time', 'One-time'),
    ]);

    var labelInput = el('input', {
      type: 'text',
      id: 'share-link-label',
      class: 'form-input',
      maxlength: '120',
      placeholder: T('route_auth.share_label', 'Label (optional)'),
      style: 'flex:1',
    });

    var form;
    var submitBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: T('route_auth.share_create', 'Create share link') });
    submitBtn.addEventListener('click', function () {
      createShareLink(routeId, {
        expiresInHours: Number(expirySelect.value),
        oneTime: oneTime.checked,
        label: labelInput.value.trim(),
      }, false, form);
    });

    form = el('div', {
      id: 'share-link-create-form',
      style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px',
    }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, [expirySelect, oneTimeLabel]),
      labelInput,
      submitBtn,
    ]);
    list.parentNode.insertBefore(form, list.nextSibling);
  }

  async function createShareLink(routeId, body, confirmGate, form) {
    var payload = { expiresInHours: body.expiresInHours, oneTime: body.oneTime };
    if (body.label) payload.label = body.label;
    if (confirmGate) payload.confirmGate = true;
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        var conflict = await res.json().catch(function () { return {}; });
        if (conflict && conflict.error === 'needs_gate_confirm') {
          if (await D.confirm({ message: T('route_auth.share_gate_warning', 'This route is currently public. A share link makes it reachable only via share links.'), danger: true })) {
            return createShareLink(routeId, body, true, form);
          }
          return;
        }
        throw new Error(shareErrMsg((conflict && conflict.error) || 'HTTP 409'));
      }
      if (res.status !== 201) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(shareErrMsg((errBody && errBody.error) || ('HTTP ' + res.status)));
      }
      var data = await res.json();
      if (form && form.parentNode) form.parentNode.removeChild(form);
      // Refresh the list FIRST — loadShareLinks() removes any #share-link-url-once
      // box at its start, so it must run before we show the new one.
      await loadShareLinks(routeId);
      showShareUrlOnce(data.url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function svgEl(name, attrs) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function copyIcon() {
    var s = svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    s.appendChild(svgEl('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }));
    s.appendChild(svgEl('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }));
    return s;
  }
  function checkIcon() {
    var s = svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--green)', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    s.appendChild(svgEl('path', { d: 'M20 6 9 17l-5-5' }));
    return s;
  }

  function showShareUrlOnce(url) {
    var list = byId('share-links-list');
    if (!list) return;
    var existing = byId('share-link-url-once');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var urlField = el('input', { type: 'text', class: 'form-input', readonly: 'readonly', style: 'flex:1;font-family:var(--font-mono)' });
    urlField.value = url || '';

    var copyLabel = T('common.copy', 'Copy');
    var copyBtn = el('button', { type: 'button', class: 'btn btn-sm', title: copyLabel, 'aria-label': copyLabel, style: 'display:flex;align-items:center;justify-content:center;padding:8px 10px' });
    copyBtn.appendChild(copyIcon());
    copyBtn.addEventListener('click', function () {
      urlField.focus();
      urlField.select();
      var showCopied = function () {
        copyBtn.textContent = '';
        copyBtn.appendChild(checkIcon());
        setTimeout(function () { copyBtn.textContent = ''; copyBtn.appendChild(copyIcon()); }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urlField.value).then(showCopied).catch(function () { /* clipboard write denied or unavailable — the URL stays selectable in the field */ });
      } else {
        try { document.execCommand('copy'); showCopied(); } catch (e) { /* clipboard unavailable */ }
      }
    });

    var box = el('div', {
      id: 'share-link-url-once',
      style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm)',
    }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, [urlField, copyBtn]),
      el('div', { class: 'form-hint', text: T('route_auth.share_copy_warning', "Anyone with this link gets in. Copy it now — it won't be shown again.") }),
    ]);
    list.parentNode.insertBefore(box, list.nextSibling);
  }

  function setupShareControls() {
    var shareCreateBtn = byId('share-link-create');
    if (shareCreateBtn) {
      shareCreateBtn.addEventListener('click', function () {
        var section = byId('share-links-section');
        var routeId = section && section.getAttribute('data-route-id');
        if (routeId) showShareCreateForm(Number(routeId));
      });
    }
  }

  // ═══ Access windows (Pro: access_windows) ══════════════════════════════════
  // A state badge, a rule list and an add-rule form, all driven by
  // /api/v1/routes/:id/access-rules. Safe-DOM only; CSRF via shareFetch().

  function renderAccessRuleRow(targetId, rule) {
    var isBlock = rule.mode === 'block';
    var chip = el('span', {
      style: 'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'
        + (isBlock
          ? 'background:rgba(229,72,77,0.15);color:var(--red,#e5484d)'
          : 'background:rgba(48,164,108,0.15);color:var(--green,#30a46c)'),
      text: isBlock ? T('access.mode_block', 'Block') : T('access.mode_allow', 'Allow'),
    });
    var lines = [el('div', { style: 'font-size:12px;font-family:var(--font-mono);color:var(--text-1)', text: rule.schedule || '' })];
    var bounds = accessFmtBounds(rule);
    if (bounds) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: bounds }));
    if (rule.label) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: rule.label }));
    var info = el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px' }, lines);
    var delBtn = el('button', { type: 'button', class: 'btn btn-sm', text: T('access.delete', 'Delete rule') });
    delBtn.addEventListener('click', function () { deleteAccessRule(targetId, rule.id); });
    return el('div', {
      class: 'rt-ee-rule', 'data-rule': String(rule.id),
      style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
    }, [chip, info, delBtn]);
  }

  function renderAccessStateBadge(accessState) {
    var badge = byId('access-state-badge');
    if (!badge) return;
    badge.textContent = '';
    if (accessState === 'denied') {
      badge.appendChild(document.createTextNode('🔴 ' + T('access.state_blocked', 'Blocked now')));
      badge.style.color = 'var(--red,#e5484d)';
    } else {
      badge.appendChild(document.createTextNode('🟢 ' + T('access.state_allowed', 'Allowed now')));
      badge.style.color = 'var(--green,#30a46c)';
    }
  }

  async function loadAccessRules(targetId) {
    var list = byId('access-rules-list');
    if (!list) return;
    list.textContent = '';
    var badge = byId('access-state-badge');
    if (badge) badge.textContent = '';
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      renderAccessStateBadge(data && data.state);
      var rules = (data && data.rules) || [];
      if (!rules.length) {
        list.appendChild(el('div', { class: 'form-hint', text: T('access.title', 'Access windows') + ' —' }));
      } else {
        rules.forEach(function (rule) { list.appendChild(renderAccessRuleRow(targetId, rule)); });
      }
      renderAccessAddForm(targetId);
    } catch (err) {
      list.appendChild(el('div', { class: 'form-hint', text: err.message }));
    }
  }

  function renderAccessAddForm(targetId) {
    var formWrap = byId('access-rules-form');
    if (!formWrap) return;
    var errBox = el('div', { class: 'form-error', style: 'display:none' });
    renderAccessRuleForm(formWrap, function (rule) {
      // addAccessRule POSTs then re-renders the whole form via loadAccessRules
      // on success (which resets it anyway), and keeps inputs on error. Return
      // false so the builder's own reset never fires for the edit modal.
      addAccessRule(targetId, rule, errBox);
      return false;
    });
    formWrap.appendChild(errBox);
  }

  async function addAccessRule(targetId, body, errBox) {
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    var payload = { mode: body.mode, schedule: body.schedule };
    if (body.valid_from) payload.valid_from = body.valid_from;
    if (body.valid_until) payload.valid_until = body.valid_until;
    if (body.label) payload.label = body.label;
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        await loadAccessRules(targetId);
        return;
      }
      var errData = await res.json().catch(function () { return {}; });
      var msg = (errData && errData.error) || ('HTTP ' + res.status);
      if (errBox) { errBox.textContent = msg; errBox.style.display = ''; }
      else toast(msg, 'error');
    } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.style.display = ''; }
      else toast(err.message, 'error');
    }
  }

  async function deleteAccessRule(targetId, ruleId) {
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules/' + ruleId, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadAccessRules(targetId);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ═══ open / save / close ═══════════════════════════════════════════════════

  async function fetchRoute(id) {
    try {
      var data = await window.api.get('/api/routes/' + id);
      return (data && data.ok && data.route) ? data.route : null;
    } catch (_) {
      return null;
    }
  }

  function loadFailedText() {
    var modal = byId(MODAL_ID);
    return (modal && modal.dataset.loadFailed) || T('common.error', 'Error');
  }

  async function open(routeOrId, opts) {
    var modal = byId(MODAL_ID);
    if (!modal) { console.error('GCEntryEditor: #' + MODAL_ID + ' is missing on this page'); return; }
    var seq = ++state.seq;
    opts = opts || {};

    var route = (routeOrId && typeof routeOrId === 'object') ? routeOrId : null;
    var id = route ? route.id : routeOrId;
    if (id == null || id === '') return;
    // The list row lacks acl_peers; GET /api/routes/:id has them.
    var detailPromise = fetchRoute(id);
    var peersPromise = loadPeers();
    var detail = await detailPromise;
    if (seq !== state.seq) return;
    if (!route) {
      route = detail;
      if (!route) { toast(loadFailedText(), 'error'); return; }
    }
    await peersPromise;
    if (seq !== state.seq) return;

    state.route = route;
    state.opts = opts;
    state.ctx = resolveContext(route, opts);
    // Inside a zone (no legacy override) the target comes from the zone.
    state.zoneManaged = !!zoneTargetOf();
    state.snapshot = null;
    id = route.id;

    byId('edit-route-id').value = id;
    var dnsHint = byId('edit-route-dns-hint');
    if (dnsHint) dnsHint.style.display = 'none';
    var hostEl = byId('ee-host');
    if (hostEl) hostEl.textContent = hostFqdn() || ('#' + id);
    populateDomain(route, seq);
    setVal('edit-route-desc', route.description || '');
    setVal('edit-route-label', route.label || '');
    setToggle('edit-route-on-demand', route.on_demand);
    populateTarget(route);
    syncOnDemandHint();
    updateTargetKindVisibility();
    updateEditFieldVisibility();

    // Start section: opts.section (shield popup, WAF tag) or the old tab name.
    var start = opts.section || SECTION_OF_TAB[opts.tab] || opts.tab || 'target';
    if (!modal.querySelector('.rt-ee-tab[data-ee-section="' + start + '"]')) start = 'target';
    goSection(start);

    await populateAuth(route, id, seq);
    if (seq !== state.seq) return;
    await populateFeatures(route, id, detail, seq);
    if (seq !== state.seq) return;

    window.hideError('edit-route-error');
    window.clearFieldErrors();
    clearSecoptErrors();

    var shareSection = byId('share-links-section');
    if (shareSection) {
      shareSection.setAttribute('data-route-id', String(id));
      loadShareLinks(id);
    }
    var accessSection = byId('access-windows-section');
    if (accessSection) {
      accessSection.setAttribute('data-target-id', String(id));
      loadAccessRules(id);
    }

    currentEditRouteId = id;
    updateEditFieldVisibility();
    syncWafBlock();
    renderDiagnose();
    renderBrandingPreview();
    syncPresetStates();
    syncHstsDup();
    renderSummaries();
    renderFlow();
    state.snapshot = formSnapshot();
    renderChanges();
    window.openModal(MODAL_ID);
    goSection(start);
    // opts.focus: id of a block to scroll into view on the start section (e.g. edit-waf-block).
    var focusEl = opts.focus ? byId(opts.focus) : null;
    if (focusEl && typeof focusEl.scrollIntoView === 'function') focusEl.scrollIntoView({ block: 'nearest' });
    var firstTab = modal.querySelector('.rt-ee-tab[aria-current="page"]');
    if (firstTab) firstTab.focus();
  }

  function close() {
    stopTracePolling();
    window.closeModal(MODAL_ID);
  }

  // Close unless there are unsaved changes the user wants to keep.
  // → Promise<boolean> (true = closed).
  function requestClose() {
    if (!isOpen()) return Promise.resolve(true);
    var n = changeList().count;
    if (!n) { close(); return Promise.resolve(true); }
    var ask = window.GCZonesUI && typeof window.GCZonesUI.confirmDiscard === 'function'
      ? window.GCZonesUI.confirmDiscard(n)
      : D.confirm({ message: T(n === 1 ? 'zones.discard_msg_one' : 'zones.discard_msg', 'Discard {{count}} unsaved changes?').replace('{{count}}', String(n)), danger: true });
    return ask.then(function (ok) { if (ok) close(); return !!ok; });
  }

  // Target/domain/type fields for the PUT, from the form. Inside a zone the
  // gateway/peer stay as they are (the zone owns them); the LAN address goes
  // through PUT /hosts/:id (lanHost), the port as target_port and — for
  // gateway targets — target_lan_port.
  function readTargetFields() {
    var out = {};
    var kind = kindNow();
    out.route_type = kind === 'http' ? 'http' : 'l4';
    if (out.route_type === 'l4') {
      out.l4_protocol = kind;
      out.l4_listen_port = (byId('edit-l4-listen-port') || {}).value ? byId('edit-l4-listen-port').value.trim() : '';
      out.l4_tls_mode = kind === 'udp' ? 'none' : ((byId('edit-l4-tls-mode') || {}).value || 'none');
    }
    out.target_port = (byId('edit-route-port') || {}).value ? byId('edit-route-port').value.trim() : '';
    out.target_kind = targetKindNow();
    if (state.zoneManaged) {
      // The name is the host's: HTTP and SNI entries carry the host fqdn.
      var fq = hostFqdn();
      if (out.route_type === 'http' || out.l4_tls_mode !== 'none') out.domain = fq;
      else out.domain = '';
      if (out.target_kind === 'gateway') {
        out.target_lan_port = out.target_port ? parseInt(out.target_port, 10) : null;
        var lan = (byId('edit-route-lan-host') || {}).value ? byId('edit-route-lan-host').value.trim() : '';
        var cur = (state.route && state.route.target_lan_host) || '';
        if (lan !== cur) out.lanHost = lan;
        var wolEnabledZ = byId('edit-route-wol-enabled');
        var wolMacZ = byId('edit-route-wol-mac');
        out.wol_enabled = !!(wolEnabledZ && wolEnabledZ.checked);
        out.wol_mac = wolMacZ && wolMacZ.value ? wolMacZ.value.trim() : null;
      }
      return out;
    }
    out.domain = readFormDomain();
    if (out.target_kind === 'gateway') {
      var gwPeerEl = byId('edit-route-gateway-peer');
      var lanHostEl = byId('edit-route-lan-host');
      var wolEnabledEl = byId('edit-route-wol-enabled');
      var wolMacEl = byId('edit-route-wol-mac');
      out.target_peer_id = gwPeerEl && gwPeerEl.value ? parseInt(gwPeerEl.value, 10) : null;
      out.target_lan_host = lanHostEl ? lanHostEl.value.trim() : null;
      out.target_lan_port = out.target_port ? parseInt(out.target_port, 10) : null;
      out.wol_enabled = !!(wolEnabledEl && wolEnabledEl.checked);
      out.wol_mac = wolMacEl && wolMacEl.value ? wolMacEl.value.trim() : null;
    } else {
      var editPeerSelect = byId('edit-route-peer');
      out.peer_id = editPeerSelect ? editPeerSelect.value || null : null;
      out.target_ip = byId('edit-route-ip').value.trim();
    }
    return out;
  }

  function isOn(id) {
    var n = byId(id);
    return !!(n && n.classList.contains('on'));
  }
  function val(id, fallback) {
    var n = byId(id);
    return (n && n.value) || fallback;
  }

  async function save(btn) {
    var id = byId('edit-route-id').value;
    var target = readTargetFields();
    var description = byId('edit-route-desc').value.trim();
    var labelEl = byId('edit-route-label');
    var label = labelEl ? labelEl.value.trim() : '';
    var httpsToggle = byId('edit-route-https');
    var https_enabled = httpsToggle ? httpsToggle.classList.contains('on') : true;
    var backend_https = isOn('edit-route-backend-https');
    var authType = val('edit-auth-type', 'none');
    var basic_auth_enabled = authType === 'basic';
    var basic_auth_user = val('edit-route-auth-user', '');
    var basic_auth_password = val('edit-route-auth-pass', '');

    var isL4 = target.route_type === 'l4';
    var isL4None = isL4 && (target.l4_tls_mode || 'none') === 'none';
    var fail = function (msg, section) { if (section) goSection(section); window.showError('edit-route-error', msg); };
    if (!target.domain && !isL4None) { fail(T('routes.domain_required', 'Domain is required'), 'target'); return; }
    if (!target.target_port || !/^\d{1,5}$/.test(target.target_port) || +target.target_port < 1 || +target.target_port > 65535) {
      fail(T('entry.err_target_port', 'Target port 1–65535'), 'target'); return;
    }
    if (isL4 && !target.l4_listen_port) { fail(T('entry.err_listen_port', 'Listen port required'), 'target'); return; }
    if (isL4 && !checkListenPortBlocked('edit-l4-listen-port', 'edit-l4-listen-port-error')) {
      fail((byId('edit-l4-listen-port-error') || {}).textContent || 'Port reserved', 'target');
      return;
    }
    if (target.lanHost !== undefined && !target.lanHost) { fail(T('host.err_lan_required', 'LAN address required'), 'target'); return; }
    if (basic_auth_enabled && !basic_auth_user) {
      fail(T('entry_editor.err_basic_user', 'Basic auth needs a user name'), 'auth');
      return;
    }
    var headers = isL4 ? { request: editHeadersRequest, response: editHeadersResponse } : readHeaders();
    if (headers.error) { fail(headers.error, 'headers'); return; }
    clearSecoptErrors();
    hideListenConflict();
    var secopt = readSecOptFields(target, https_enabled);
    if (secopt.error) { showSecoptError(secopt.error); return; }

    window.btnLoading(btn);
    try {
      var rateLimitEnabled = isOn('edit-route-rate-limit');
      var retryEnabled = isOn('edit-route-retry');
      var backendsEnabled = isOn('edit-route-backends');
      var stickyEnabled = isOn('edit-route-sticky');
      var cbEnabled = isOn('edit-route-circuit-breaker');
      // The L4 block carries its own controls — for a TCP/UDP entry they are
      // the ones the user actually saw (the security tab is hidden there).
      var ipFilterEnabled = isL4 ? isOn('edit-l4-route-ip-filter') : isOn('edit-route-ip-filter');
      var aclEnabled = isOn('edit-route-acl');
      var botBlockerEnabled = isOn('edit-route-bot-blocker');
      var botBlockerMode = val('edit-bot-blocker-mode', 'block');
      var botBlockerConfig = null;
      if (botBlockerMode === 'redirect') {
        botBlockerConfig = JSON.stringify({ url: val('edit-bot-blocker-url', '') });
      } else if (botBlockerMode === 'custom') {
        botBlockerConfig = JSON.stringify({
          message: val('edit-bot-blocker-message', ''),
          status_code: parseInt(val('edit-bot-blocker-status', ''), 10) || 403,
        });
      }
      var payload = {
        domain: target.domain,
        description: description,
        // Entry name + "nur bei Bedarf" (docs/feature-next-package.md S3 §2/§3).
        label: label,
        on_demand: isOn('edit-route-on-demand'),
        target_port: target.target_port,
        peer_id: target.peer_id,
        target_ip: target.target_ip,
        https_enabled: https_enabled,
        backend_https: backend_https,
        basic_auth_enabled: basic_auth_enabled,
        compress_enabled: isOn('edit-route-compress'),
        external_enabled: isOn('edit-route-external'),
        monitoring_enabled: isOn('edit-route-monitoring'),
        ip_filter_enabled: ipFilterEnabled,
        ip_filter_mode: isL4 ? val('edit-l4-ip-filter-mode', 'whitelist') : val('edit-ip-filter-mode', 'whitelist'),
        ip_filter_rules: ipFilterEnabled ? JSON.stringify(editIpFilterRules) : null,
        branding_title: val('edit-branding-title', ''),
        branding_text: val('edit-branding-text', ''),
        branding_color: val('edit-branding-color', ''),
        branding_bg: val('edit-branding-bg', ''),
        acl_enabled: aclEnabled,
        acl_peers: aclEnabled ? getSelectedAclPeers('edit') : [],
        rate_limit_enabled: rateLimitEnabled,
        rate_limit_requests: rateLimitEnabled ? parseInt(val('edit-rate-limit-requests', '100'), 10) : 100,
        rate_limit_window: rateLimitEnabled ? val('edit-rate-limit-window', '1m') : '1m',
        retry_enabled: retryEnabled,
        retry_count: retryEnabled ? parseInt(val('edit-retry-count', '3'), 10) : 3,
        retry_match_status: retryEnabled ? val('edit-retry-status', '502,503,504') : '502,503,504',
        backends: backendsEnabled ? editBackendsList : null,
        sticky_enabled: backendsEnabled && stickyEnabled,
        sticky_cookie_name: stickyEnabled ? val('edit-sticky-cookie-name', 'gc_sticky') : 'gc_sticky',
        sticky_cookie_ttl: stickyEnabled ? val('edit-sticky-cookie-ttl', '3600') : '3600',
        circuit_breaker_enabled: cbEnabled,
        circuit_breaker_threshold: cbEnabled ? parseInt(val('edit-cb-threshold', '5'), 10) : 5,
        circuit_breaker_timeout: cbEnabled ? parseInt(val('edit-cb-timeout', '30'), 10) : 30,
        debug_enabled: isOn('edit-route-debug'),
        bot_blocker_enabled: botBlockerEnabled,
        bot_blocker_mode: botBlockerEnabled ? botBlockerMode : undefined,
        bot_blocker_config: botBlockerEnabled ? botBlockerConfig : undefined,
        mirror_enabled: isOn('edit-route-mirror') ? 1 : 0,
        mirror_targets: editMirrorTargets.length > 0 ? editMirrorTargets : null,
      };
      Object.assign(payload, readHstsFields());
      Object.assign(payload, secopt.fields);
      // Web Application Firewall: waf_enabled, waf_mode, waf_paranoia (licensed HTTP routes only).
      Object.assign(payload, readWafFields(target));
      var blockAction = val('edit-route-block-action', 'inherit');
      payload.external_block_action = blockAction;
      if (blockAction === 'custom') payload.external_block_body = val('edit-route-block-body', '');
      if (blockAction === 'redirect') payload.external_block_redirect_url = val('edit-route-block-redirect', '');
      // User visibility
      var selectedUserIds = [];
      document.querySelectorAll('#route-user-ids .route-user-cb:checked').forEach(function (cb) {
        selectedUserIds.push(parseInt(cb.value, 10));
      });
      payload.user_ids = selectedUserIds.length > 0 ? selectedUserIds : null;
      // Custom headers (empty rows dropped; '-Name' removes a header)
      var hasCustomHeaders = headers.request.length > 0 || headers.response.length > 0;
      payload.custom_headers = hasCustomHeaders ? { request: headers.request, response: headers.response } : null;
      payload.route_type = target.route_type;
      if (isL4) {
        payload.l4_protocol = target.l4_protocol;
        payload.l4_listen_port = target.l4_listen_port;
        payload.l4_tls_mode = target.l4_tls_mode;
        var connRateOn = isOn('edit-l4-conn-rate');
        payload.l4_conn_limit = connRateOn ? parseInt(val('edit-l4-conn-limit', '20'), 10) : 0;
        payload.l4_conn_window_s = connRateOn ? parseInt(val('edit-l4-conn-window', '60'), 10) : 0;
      }
      if (isL4None) {
        // PUT /api/routes/:id validates any defined domain and rejects ''
        // ("Invalid domain format"). Send '' only when it clears a stored
        // domain (HTTP → TCP, SNI → none); otherwise leave the field out.
        if (!(state.route && state.route.domain)) delete payload.domain;
        else payload.domain = '';
      }
      // A switch to HTTP starts with HTTPS on (the type chip says HTTPS).
      if (!isL4 && state.route && state.route.route_type === 'l4') payload.https_enabled = true;

      payload.target_kind = target.target_kind;
      if (target.target_kind === 'gateway') {
        // Gateway/pool targets forward to target_lan_port; target_port mirrors it.
        payload.target_lan_port = target.target_lan_port;
        payload.wol_enabled = target.wol_enabled;
        payload.wol_mac = target.wol_mac;
        if (!state.zoneManaged) {
          payload.target_peer_id = target.target_peer_id;
          payload.target_lan_host = target.target_lan_host;
        }
        // Don't leak the peer-fields' target_ip/peer_id into a gateway route
        // payload: a legacy `target_ip='127.0.0.1'` placeholder would trip the
        // server's SSRF private-IP guard on every save. `delete` (not null) so
        // the PUT handler's validateIp() and SSRF checks skip the field.
        delete payload.target_ip;
        delete payload.peer_id;
      } else if (state.zoneManaged) {
        // Peer zone: the peer is the zone's — only the port changes here.
        delete payload.target_ip;
        delete payload.peer_id;
      }
      // LAN address of a zone host: one PUT /hosts/:id moves every entry.
      if (target.lanHost !== undefined && state.route && state.route.bundle_id != null) {
        var hostRes = await window.api.put('/api/v1/hosts/' + state.route.bundle_id, { lan_host: target.lanHost });
        if (hostRes && hostRes.ok === false) { fail(hostRes.error || T('zones.error_generic', 'Error'), 'target'); return; }
        state.route.target_lan_host = target.lanHost;
      }
      if (basic_auth_enabled) {
        payload.basic_auth_user = basic_auth_user.trim();
        if (basic_auth_password.trim()) payload.basic_auth_password = basic_auth_password.trim();
      }
      var data = await window.api.put('/api/routes/' + id, payload);
      if (!data.ok) {
        if (data.code === 'LABEL_INVALID') {
          window.showError('edit-route-error', T('entry.err_label', 'Name too long (max 64 characters)'));
          window.showFieldErrors({ label: data.error }, { label: 'edit-route-label' });
          return;
        }
        var hstsErr = hstsErrorText(data.code);
        if (hstsErr) {
          window.showError('edit-route-error', hstsErr);
          return;
        }
        if (showSecoptError(data.code)) return;
        // Coded L4-protection errors (docs/feature-next-package.md §S1.2/§S1.3).
        var l4Err = l4ProtectErrorText(data.code);
        if (l4Err) { window.showError('edit-route-error', l4Err); return; }
        // 403 of the route_auth gate (requireFeatureField('mtls_enabled', 'route_auth')).
        if (data.feature === 'route_auth' && payload.mtls_enabled) { showSecoptError('MTLS_LICENSE'); return; }
        // 403 of the waf gate (requireFeatureField('waf_enabled', 'waf')).
        if (data.feature === 'waf' && payload.waf_enabled) { showSecoptError('WAF_LICENSE'); return; }
        if (data.fields) {
          var ft = byId('edit-route-domain-freetext');
          window.showFieldErrors(data.fields, {
            // Point to the active domain element: freetext if visible, else base select
            domain: (ft && ft.style.display !== 'none') ? 'edit-route-domain-freetext' : 'edit-route-base-domain',
            target_port: 'edit-route-port',
            description: 'edit-route-desc',
            target_ip: 'edit-route-ip',
          });
          window.showError('edit-route-error', data.error);
        } else {
          var sec = /HOST_HAS_HTTP|TYPE_/.test(String(data.code || '')) ? 'target' : null;
          if (sec) goSection(sec);
          window.showError('edit-route-error', data.code === 'HOST_HAS_HTTP' ? T('entry.err_http_taken', data.error) : data.error);
        }
        return;
      }

      // Auth type side effects
      if (authType === 'none') {
        // Delete route auth if it existed (ignore errors)
        try { await window.api.del('/api/routes/' + id + '/auth'); } catch (e) { /* ignore */ }
      } else if (authType === 'route') {
        var raMethod = val('edit-ra-method', 'email_password');
        var ra2faActive = isOn('edit-ra-2fa');
        var raSessionDuration = val('edit-ra-session-duration', '86400000');
        var raEmailVal = val(ra2faActive ? 'edit-ra-2fa-email' : 'edit-ra-email', '');
        var raPasswordVal = val(ra2faActive ? 'edit-ra-2fa-password' : 'edit-ra-password', '');
        var raPayload = {
          auth_type: ra2faActive ? 'email_password' : raMethod,
          two_factor_enabled: ra2faActive,
          two_factor_method: ra2faActive ? raMethod : null,
          email: raEmailVal,
          session_max_age: parseInt(raSessionDuration, 10),
        };
        if (raPasswordVal) raPayload.password = raPasswordVal;
        if (pendingTotpSecret) raPayload.totp_secret = pendingTotpSecret;
        try {
          var raData = await window.api.post('/api/routes/' + id + '/auth', raPayload);
          if (!raData.ok) {
            window.showError('edit-route-error', raData.error || 'Failed to save route auth');
            return;
          }
        } catch (err) {
          window.showError('edit-route-error', err.message);
          return;
        }
      }

      close();
      if (typeof window.showToast === 'function') window.showToast(T('entry_editor.saved', 'Saved'), 'success');
      callOpt('onSaved', data.route || null);
    } catch (err) {
      var d = err && err.data;
      if (d && d.code === 'BUNDLE_PORT_CONFLICT' && d.conflict) showListenConflict(d.conflict);
      else if (d && d.code === 'HOST_HAS_HTTP') { goSection('target'); window.showError('edit-route-error', T('entry.err_http_taken', err.message)); return; }
      window.showError('edit-route-error', err.message);
    } finally {
      window.btnReset(btn);
    }
  }

  // ═══ Init (event wiring, once per page) ════════════════════════════════════

  function init() {
    if (!byId(MODAL_ID)) return;
    setupAuthControls();
    setupDomainRegistry();
    setupGeneralControls();
    setupFeatureControls();
    setupHeaderControls();
    setupHstsControls();
    setupSecOptControls();
    setupWafControls();
    setupBrandingUpload('edit-branding-logo-file', 'logo', 'logo', 'edit-branding-logo-current', 'edit-branding-logo-remove');
    setupBrandingUpload('edit-branding-bg-file', 'bg_image', 'bg-image', 'edit-branding-bg-current', 'edit-branding-bg-remove');
    setupTabsAndDebug();
    setupShareControls();
    var submit = byId('btn-edit-route-submit');
    if (submit) submit.addEventListener('click', function () { save(this); });
    var cancel = byId('ee-cancel');
    if (cancel) cancel.addEventListener('click', function () { requestClose(); });
    var x = byId('ee-close');
    if (x) x.addEventListener('click', function () { requestClose(); });
    // Every change refreshes the summaries, the path and the change line.
    var modal = byId(MODAL_ID);
    if (modal) {
      // The page content is its own stacking context; on <body> the editor
      // stacks above the "Host bearbeiten" dialog (z-index 1050 > 1000).
      if (modal.parentNode !== document.body) document.body.appendChild(modal);
      ['input', 'change'].forEach(function (ev) { modal.addEventListener(ev, onFormChange); });
      modal.addEventListener('click', function () { setTimeout(onFormChange, 0); });
    }
    window.addEventListener('keydown', onEditorKey, true);
  }
  init();

  window.GCEntryEditor = {
    open: open,
    close: close,
  };
})();
