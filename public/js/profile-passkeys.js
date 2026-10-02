'use strict';

// Profile card "Passkeys" (docs/feature-admin-passkeys.md). Talks to
// /api/v1/profile/passkeys/*; the WebAuthn calls go through /js/webauthn.js.
(function () {
  var card = document.getElementById('pk-card');
  if (!card) return;

  var byId = function (id) { return document.getElementById(id); };
  var T = {};
  try { T = JSON.parse(byId('pk-i18n').textContent); } catch (e) { T = {}; }
  var t = function (k, fb) { return T[k] || fb || k; };

  var state = { available: true, reauth: true, passkeys: [], origin: null };
  var deleteId = null;

  function show(id, on) { var el = byId(id); if (el) el.hidden = !on; }
  function msg(text, type) { window.showMessage('pk-message', text, type || 'error'); }
  function clearMsg() { var el = byId('pk-message'); if (el) el.style.display = 'none'; }
  function fmt(ts) { return ts ? String(ts).replace('T', ' ').slice(0, 16) : ''; }

  function blocker() {
    if (!window.GCWebAuthn || !window.GCWebAuthn.supported()) return t('unsupported');
    if (!state.available) return t('unavailable');
    if (state.origin && window.location.origin !== state.origin) return t('wrong_origin').replace('{{origin}}', state.origin);
    return '';
  }

  function render() {
    var list = byId('pk-list');
    list.textContent = '';
    state.passkeys.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'pk-item';
      li.setAttribute('data-passkey-id', String(p.id));
      var main = document.createElement('div');
      main.className = 'pk-item-main';
      var name = document.createElement('div');
      name.className = 'pk-item-name';
      name.textContent = p.name;
      var meta = document.createElement('div');
      meta.className = 'pk-item-meta';
      var parts = [t('created', 'Added {{date}}').replace('{{date}}', fmt(p.created_at))];
      parts.push(p.last_used_at ? t('last_used', 'Last used {{date}}').replace('{{date}}', fmt(p.last_used_at)) : t('never_used', 'Never used'));
      if (p.backed_up) parts.push(t('synced', 'Synced'));
      meta.textContent = parts.join(' · ');
      main.appendChild(name); main.appendChild(meta);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost tf-btn-sm';
      del.textContent = t('remove', 'Remove');
      del.setAttribute('data-pk-remove', String(p.id));
      del.addEventListener('click', function () { askDelete(p); });
      li.appendChild(main); li.appendChild(del);
      list.appendChild(li);
    });
    show('pk-empty', state.passkeys.length === 0);
    var st = byId('pk-status');
    if (st) {
      var n = state.passkeys.length;
      st.textContent = n ? t('count', '{{count}} registered').replace('{{count}}', n) : t('none', 'None');
      st.className = 'tf-status ' + (n ? 'tf-status-on' : 'tf-status-off');
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
    show('pk-form-add', true);
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
      show('pk-form-add', false);
      msg(t('added'), 'success');
      await refresh();
    } catch (err) {
      msg(err.message || t('error'));
    } finally { window.btnReset(btn); }
  }

  // ─── remove ─────────────────────────────────────────────────────────
  function askDelete(p) {
    clearMsg();
    deleteId = p.id;
    show('pk-form-add', false);
    byId('pk-delete-text').textContent = t('remove_confirm', 'Remove “{{name}}”?').replace('{{name}}', p.name);
    byId('pk-delete-password').value = '';
    show('pk-delete-reauth', state.reauth);
    show('pk-form-delete', true);
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
    b.addEventListener('click', function () { show(b.getAttribute('data-pk-cancel'), false); deleteId = null; });
  });

  render();
  refresh();
})();
