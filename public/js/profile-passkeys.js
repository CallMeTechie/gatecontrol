'use strict';

// Profile page, "Passkeys" block (docs/feature-admin-passkeys.md). Talks to
// /api/v1/profile/passkeys/*; the WebAuthn calls go through /js/webauthn.js.
(function () {
  var card = document.getElementById('pk-card');
  if (!card) return;

  var byId = function (id) { return document.getElementById(id); };
  var T = {};
  try { T = JSON.parse(byId('pk-i18n').textContent); } catch (e) { T = {}; }
  var t = function (k, fb) { return T[k] || fb || k; };

  var state = { available: true, reauth: true, passkeys: [], origin: null, loaded: false };
  var deleteId = null;

  function show(id, on) { var el = byId(id); if (el) el.hidden = !on; }
  // While the add form is open it replaces the "Add passkey" button.
  function setAddForm(on) {
    show('pk-form-add', on);
    show('pk-btn-add', !on);
    byId('pk-btn-add').setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function msg(text, type) { window.showMessage('pk-message', text, type || 'error'); }
  function clearMsg() { var el = byId('pk-message'); if (el) el.style.display = 'none'; }
  function fmt(ts) { return ts ? String(ts).replace('T', ' ').slice(0, 16) : ''; }

  function blocker() {
    if (!window.GCWebAuthn || !window.GCWebAuthn.supported()) return t('unsupported');
    if (!state.available) return t('unavailable');
    if (state.origin && window.location.origin !== state.origin) return t('wrong_origin').replace('{{origin}}', state.origin);
    return '';
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Synced passkeys (iCloud Keychain, Google Password Manager …) get a device
  // icon, device-bound ones (security keys) a key.
  var ICON_DEVICE = 'M4 5h16v11H4zM2 20h20';
  var ICON_KEY = 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM12 10v11M12 14h3M12 18h2';
  var ICON_TRASH = 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3';
  function icon(d, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // The remove confirmation opens inside the list item; it lives below the
  // list whenever no item is asking.
  var delForm = byId('pk-form-delete');
  var delReturn = null;
  function parkDeleteForm() {
    var empty = byId('pk-empty');
    if (delForm && empty && delForm.previousElementSibling !== empty) empty.after(delForm);
  }

  function render() {
    var list = byId('pk-list');
    parkDeleteForm();
    list.textContent = '';
    state.passkeys.forEach(function (p) {
      var li = el('li', 'pk-item');
      li.setAttribute('data-passkey-id', String(p.id));
      var ic = el('span', 'pk-item-ic');
      ic.appendChild(icon(p.backed_up ? ICON_DEVICE : ICON_KEY));
      var main = el('div', 'pk-item-main');
      var head = el('div', 'pk-item-head');
      head.appendChild(el('span', 'pk-item-name', p.name));
      if (p.backed_up) head.appendChild(el('span', 'pk-chip-synced', t('synced', 'Synced')));
      var parts = [t('created', 'Added {{date}}').replace('{{date}}', fmt(p.created_at))];
      parts.push(p.last_used_at ? t('last_used', 'Last used {{date}}').replace('{{date}}', fmt(p.last_used_at)) : t('never_used', 'Never used'));
      main.appendChild(head);
      main.appendChild(el('div', 'pk-item-meta', parts.join(' · ')));
      var del = el('button', 'pk-item-remove');
      del.type = 'button';
      var label = t('remove_label', 'Remove passkey “{{name}}”').replace('{{name}}', p.name);
      del.setAttribute('aria-label', label);
      del.title = label;
      del.setAttribute('data-pk-remove', String(p.id));
      del.appendChild(icon(ICON_TRASH));
      del.addEventListener('click', function () { askDelete(p, li); });
      var row = el('div', 'pk-item-row');
      row.appendChild(ic); row.appendChild(main); row.appendChild(del);
      li.appendChild(row);
      list.appendChild(li);
    });
    show('pk-empty', state.loaded && state.passkeys.length === 0);
    if (state.loaded) {
      var st = byId('pk-status');
      if (st) {
        var n = state.passkeys.length;
        st.textContent = n ? t('count', '{{count}} registered').replace('{{count}}', n) : t('none', 'None');
        st.className = 'tf-status ' + (n ? 'tf-status-on pf-pill-teal' : 'tf-status-off');
      }
      // Identity header and security rail (profile.js) follow this state.
      document.dispatchEvent(new CustomEvent('gc:profile-passkeys', { detail: { count: state.passkeys.length } }));
    }
    var why = blocker();
    var un = byId('pk-unavailable');
    if (un) { un.textContent = why; un.hidden = !why; }
    byId('pk-btn-add').disabled = !!why;
  }

  async function refresh() {
    try {
      var data = await window.api.get('/api/v1/profile/passkeys');
      if (data.ok) {
        state.available = !!data.data.available;
        state.origin = data.data.origin || null;
        state.reauth = !!data.data.reauth_required;
        state.passkeys = data.data.passkeys || [];
        state.loaded = true;
      }
    } catch (err) { msg(err.message); }
    render();
  }

  // ─── add ────────────────────────────────────────────────────────────
  function openAdd() {
    clearMsg();
    show('pk-form-delete', false);
    byId('pk-name').value = '';
    byId('pk-add-password').value = '';
    show('pk-add-reauth', state.reauth);
    setAddForm(true);
    byId('pk-name').focus();
  }

  async function add() {
    var btn = byId('pk-btn-add-confirm');
    clearMsg();
    window.btnLoading(btn);
    try {
      var body = {};
      var pw = byId('pk-add-password').value;
      if (pw) body.password = pw;
      var opt = await window.api.post('/api/v1/profile/passkeys/register/options', body);
      if (!opt.ok) {
        if (opt.code === 'REAUTH_REQUIRED') { state.reauth = true; show('pk-add-reauth', true); byId('pk-add-password').focus(); }
        msg(opt.error || t('error'));
        return;
      }
      byId('pk-add-password').value = '';
      var credential;
      try {
        credential = await window.GCWebAuthn.register(opt.data);
      } catch (err) {
        msg(window.GCWebAuthn.isCancel(err) ? t('cancelled') : (err.message || t('error')));
        return;
      }
      var res = await window.api.post('/api/v1/profile/passkeys/register', { name: byId('pk-name').value, response: credential });
      if (!res.ok) { msg(res.error || t('error')); return; }
      setAddForm(false);
      msg(t('added'), 'success');
      await refresh();
    } catch (err) {
      msg(err.message || t('error'));
    } finally { window.btnReset(btn); }
  }

  // ─── remove ─────────────────────────────────────────────────────────
  function askDelete(p, li) {
    clearMsg();
    deleteId = p.id;
    setAddForm(false);
    if (li) { li.appendChild(delForm); delReturn = li.querySelector('[data-pk-remove]'); }
    byId('pk-delete-text').textContent = t('remove_confirm', 'Remove “{{name}}”?').replace('{{name}}', p.name);
    byId('pk-delete-password').value = '';
    show('pk-delete-reauth', state.reauth);
    show('pk-form-delete', true);
    (state.reauth ? byId('pk-delete-password') : byId('pk-btn-delete-confirm')).focus();
  }

  async function doDelete() {
    if (deleteId == null) return;
    var btn = byId('pk-btn-delete-confirm');
    clearMsg();
    window.btnLoading(btn);
    try {
      var body = {};
      var pw = byId('pk-delete-password').value;
      if (pw) body.password = pw;
      var res = await window.api.post('/api/v1/profile/passkeys/' + encodeURIComponent(deleteId) + '/delete', body);
      if (!res.ok) {
        if (res.code === 'REAUTH_REQUIRED') { state.reauth = true; show('pk-delete-reauth', true); byId('pk-delete-password').focus(); }
        msg(res.error || t('error'));
        return;
      }
      deleteId = null;
      show('pk-form-delete', false);
      msg(t('removed'), 'success');
      await refresh();
    } catch (err) {
      msg(err.message || t('error'));
    } finally { window.btnReset(btn); }
  }

  // ─── wiring ─────────────────────────────────────────────────────────
  byId('pk-btn-add').addEventListener('click', openAdd);
  byId('pk-btn-add-confirm').addEventListener('click', add);
  byId('pk-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  byId('pk-add-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  byId('pk-btn-delete-confirm').addEventListener('click', doDelete);
  byId('pk-delete-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doDelete(); } });
  card.querySelectorAll('[data-pk-cancel]').forEach(function (b) {
    b.addEventListener('click', function () {
      var form = b.getAttribute('data-pk-cancel');
      if (form === 'pk-form-add') setAddForm(false); else show(form, false);
      deleteId = null;
      if (form === 'pk-form-delete') { parkDeleteForm(); if (delReturn && delReturn.isConnected) delReturn.focus(); }
      else byId('pk-btn-add').focus();
    });
  });

  render();
  refresh();
})();
