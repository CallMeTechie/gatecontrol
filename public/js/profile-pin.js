'use strict';

// Konto & Sicherheit → Portal-PIN: the PIN that confirms the person on a
// shared device in the portal ("Wer bist du?"). 4–6 digits; setting and
// removing it needs the current password (/api/v1/profile/portal-pin).
// Strings: #pf-pin-i18n. Text only — no innerHTML.
(function () {
  var root = document.getElementById('pf-pin');
  if (!root) return;
  var I18N = {};
  try { I18N = JSON.parse(document.getElementById('pf-pin-i18n').textContent || '{}') || {}; } catch (e) { I18N = {}; }
  function T(key) { return I18N[key] || key; }
  function byId(id) { return document.getElementById(id); }
  function msg(text, type) { window.showMessage('pf-pin-message', text, type || 'error'); }

  var state = byId('pf-pin-state');
  var open = byId('pf-pin-open');
  var remove = byId('pf-pin-remove');
  var form = byId('pf-pin-form');
  var save = byId('pf-pin-save');
  var newPin = byId('pf-pin-new');
  var confirmPin = byId('pf-pin-confirm');
  var password = byId('pf-pin-password');
  var mode = 'set';
  var hasPin = false;

  function render() {
    state.textContent = hasPin ? T('profile.pin.state_on') : T('profile.pin.state_off');
    state.setAttribute('data-on', hasPin ? '1' : '0');
    open.textContent = hasPin ? T('profile.pin.change') : T('profile.pin.set');
    remove.hidden = !hasPin || !form.hidden;
  }
  function setForm(show, nextMode) {
    mode = nextMode || 'set';
    form.hidden = !show;
    open.hidden = show;
    open.setAttribute('aria-expanded', show ? 'true' : 'false');
    byId('pf-pin-new-wrap').hidden = mode === 'remove';
    byId('pf-pin-confirm-wrap').hidden = mode === 'remove';
    save.textContent = mode === 'remove' ? T('profile.pin.remove') : T('profile.pin.save');
    save.classList.toggle('btn-danger', mode === 'remove');
    save.classList.toggle('btn-primary', mode !== 'remove');
    newPin.value = '';
    confirmPin.value = '';
    password.value = '';
    render();
    if (show) (mode === 'remove' ? password : newPin).focus();
  }
  [newPin, confirmPin].forEach(function (input) {
    input.addEventListener('input', function () {
      var clean = input.value.replace(/\D+/g, '').slice(0, 6);
      if (clean !== input.value) input.value = clean;
    });
  });

  open.addEventListener('click', function () { setForm(true, 'set'); });
  remove.addEventListener('click', function () { setForm(true, 'remove'); msg(T('profile.pin.remove_confirm'), 'success'); });
  byId('pf-pin-cancel').addEventListener('click', function () { setForm(false); open.focus(); });

  save.addEventListener('click', async function () {
    if (mode === 'set') {
      if (!/^\d{4,6}$/.test(newPin.value)) { msg(T('profile.pin.err_format')); newPin.focus(); return; }
      if (newPin.value !== confirmPin.value) { msg(T('profile.pin.err_mismatch')); confirmPin.focus(); return; }
    }
    if (!password.value) { msg(T('profile.pin.err_password')); password.focus(); return; }
    window.btnLoading(save);
    try {
      var res = mode === 'remove'
        ? await window.api.post('/api/v1/profile/portal-pin/remove', { password: password.value })
        : await window.api.put('/api/v1/profile/portal-pin', { pin: newPin.value, password: password.value });
      window.btnReset(save);
      if (!res || res.ok === false) { msg((res && res.error) || T('common.error')); return; }
      hasPin = !!(res.data && res.data.has_pin);
      var done = mode === 'remove' ? T('profile.pin.removed') : T('profile.pin.saved');
      setForm(false);
      msg(done, 'success');
      open.focus();
    } catch (err) {
      window.btnReset(save);
      msg(T('common.error'));
    }
  });

  window.api.get('/api/v1/profile/portal-pin').then(function (res) {
    hasPin = !!(res && res.data && res.data.has_pin);
    render();
  }).catch(function () { render(); });
  render();
})();
