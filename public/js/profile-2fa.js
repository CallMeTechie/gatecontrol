'use strict';

// Profile card "Two-factor login" (docs/feature-admin-2fa.md).
// Talks to /api/v1/profile/2fa/*; the QR code is drawn client-side with
// /js/vendor/qrcode.min.js (same helper route-auth uses).
(function () {
  var card = document.getElementById('tf-card');
  if (!card) return;

  var byId = function (id) { return document.getElementById(id); };
  var T = {};
  try { T = JSON.parse(byId('tf-i18n').textContent); } catch (e) { T = {}; }
  var t = function (k, fb) { return T[k] || fb || k; };

  var enabled = card.getAttribute('data-enabled') === '1';
  var username = card.getAttribute('data-username') || '';
  var required = false;
  var pendingSecret = null;
  var lastCodes = [];

  function show(id, on) { var el = byId(id); if (el) el.hidden = !on; }
  function msg(text, type) { window.showMessage('tf-message', text, type || 'error'); }
  function clearMsg() { var el = byId('tf-message'); if (el) el.style.display = 'none'; }
  function panel(name) {
    ['tf-panel-off', 'tf-panel-setup', 'tf-panel-codes', 'tf-panel-on'].forEach(function (id) { show(id, id === 'tf-panel-' + name); });
  }

  function renderStatus(status) {
    var st = byId('tf-status');
    if (st) {
      st.textContent = enabled ? t('status_on', 'Active') : t('status_off', 'Not set up');
      st.className = 'tf-status ' + (enabled ? 'tf-status-on' : 'tf-status-off');
    }
    var rem = byId('tf-remaining');
    if (rem) {
      var parts = [];
      if (status && status.confirmed_at) parts.push(t('status_since', 'Active since {{date}}').replace('{{date}}', String(status.confirmed_at).replace('T', ' ').slice(0, 16)));
      if (status && typeof status.recovery_codes_remaining === 'number') parts.push(t('recovery_remaining', '{{count}} of 10 codes left').replace('{{count}}', status.recovery_codes_remaining));
      rem.textContent = parts.join(' · ');
    }
    show('tf-required-banner', required && !enabled);
    show('tf-required-locked', required && enabled);
    var dis = byId('tf-btn-disable');
    if (dis) dis.disabled = required && enabled;
  }

  async function refresh() {
    try {
      var data = await window.api.get('/api/v1/profile/2fa');
      if (data.ok) {
        enabled = !!data.data.enabled;
        required = !!data.data.required;
        renderStatus(data.data);
        if (!byId('tf-panel-setup').hidden || !byId('tf-panel-codes').hidden) return;
        panel(enabled ? 'on' : 'off');
      }
    } catch (err) {
      renderStatus(null);
      panel(enabled ? 'on' : 'off');
    }
  }

  // ─── setup ─────────────────────────────────────────────────────────
  async function startSetup() {
    var btn = byId('tf-btn-setup');
    clearMsg();
    window.btnLoading(btn);
    try {
      var data = await window.api.post('/api/v1/profile/2fa/setup', {});
      if (!data.ok || !data.data) { msg(data.error || t('error')); return; }
      pendingSecret = data.data.secret;
      byId('tf-secret').textContent = pendingSecret;
      var qrEl = byId('tf-qr');
      qrEl.textContent = '';
      try {
        var qr = window.qrcode(0, 'M'); qr.addData(data.data.otpauth_url); qr.make();
        var img = document.createElement('img');
        img.src = qr.createDataURL(4, 4); img.alt = 'TOTP QR Code'; img.className = 'tf-qr-img';
        qrEl.appendChild(img);
      } catch (e) {
        var d = document.createElement('div'); d.className = 'tf-hint tf-mono'; d.textContent = data.data.otpauth_url; qrEl.appendChild(d);
      }
      byId('tf-confirm-code').value = '';
      panel('setup');
      byId('tf-confirm-code').focus();
    } catch (err) { msg(err.message); } finally { window.btnReset(btn); }
  }

  async function confirmSetup() {
    var btn = byId('tf-btn-confirm');
    var code = (byId('tf-confirm-code').value || '').replace(/\s+/g, '');
    clearMsg();
    if (!code) { msg(t('error_code_required')); return; }
    window.btnLoading(btn);
    try {
      var data = await window.api.post('/api/v1/profile/2fa/confirm', { code: code });
      if (!data.ok) { msg(data.error || t('error')); return; }
      pendingSecret = null;
      enabled = true;
      showCodes(data.data.recovery_codes || []);
      msg(t('enabled_success'), 'success');
      renderStatus(null);
    } catch (err) { msg(err.message); } finally { window.btnReset(btn); }
  }

  function cancelSetup() { pendingSecret = null; clearMsg(); panel(enabled ? 'on' : 'off'); }

  // ─── recovery codes (shown once) ───────────────────────────────────
  function showCodes(codes) {
    lastCodes = codes.slice();
    var ol = byId('tf-codes');
    ol.textContent = '';
    codes.forEach(function (c) { var li = document.createElement('li'); li.textContent = c; ol.appendChild(li); });
    panel('codes');
  }

  function codesText() {
    return t('download_header', 'GateControl recovery codes for {{user}}').replace('{{user}}', username) + '\n' +
      new Date().toISOString().slice(0, 10) + '\n\n' + lastCodes.join('\n') + '\n';
  }

  async function copyText(text, btn) {
    var label = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = t('copied', 'Copied');
      setTimeout(function () { btn.textContent = label; }, 1500);
    } catch (e) {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = t('copied', 'Copied'); setTimeout(function () { btn.textContent = label; }, 1500); } catch (e2) { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  function downloadCodes() {
    var blob = new Blob([codesText()], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = t('download_filename', 'gatecontrol-recovery-codes.txt');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function codesDone() { lastCodes = []; byId('tf-codes').textContent = ''; panel('on'); refresh(); }

  // ─── regenerate / disable ──────────────────────────────────────────
  async function regenerate() {
    var btn = byId('tf-btn-regenerate-confirm');
    var password = byId('tf-regen-password').value;
    clearMsg();
    window.btnLoading(btn);
    try {
      var data = await window.api.post('/api/v1/profile/2fa/recovery-codes', { password: password });
      if (!data.ok) { msg(data.error || t('error')); return; }
      byId('tf-regen-password').value = '';
      show('tf-form-regenerate', false);
      showCodes(data.data.recovery_codes || []);
    } catch (err) { msg(err.message); } finally { window.btnReset(btn); }
  }

  async function disable() {
    var btn = byId('tf-btn-disable-confirm');
    var password = byId('tf-disable-password').value;
    var code = (byId('tf-disable-code').value || '').replace(/\s+/g, '');
    clearMsg();
    if (!code) { msg(t('error_code_required')); return; }
    window.btnLoading(btn);
    try {
      var data = await window.api.post('/api/v1/profile/2fa/disable', { password: password, code: code });
      if (!data.ok) { msg(data.error || t('error')); return; }
      byId('tf-disable-password').value = ''; byId('tf-disable-code').value = '';
      show('tf-form-disable', false);
      enabled = false;
      msg(t('disabled_success'), 'success');
      panel('off');
      refresh();
    } catch (err) { msg(err.message); } finally { window.btnReset(btn); }
  }

  // ─── wiring ────────────────────────────────────────────────────────
  byId('tf-btn-setup').addEventListener('click', startSetup);
  byId('tf-btn-confirm').addEventListener('click', confirmSetup);
  byId('tf-confirm-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); confirmSetup(); } });
  byId('tf-btn-cancel-setup').addEventListener('click', cancelSetup);
  byId('tf-btn-copy-secret').addEventListener('click', function () { if (pendingSecret) copyText(pendingSecret, this); });
  byId('tf-btn-copy-codes').addEventListener('click', function () { copyText(lastCodes.join('\n'), this); });
  byId('tf-btn-download-codes').addEventListener('click', downloadCodes);
  byId('tf-btn-codes-done').addEventListener('click', codesDone);
  byId('tf-btn-regenerate').addEventListener('click', function () { clearMsg(); show('tf-form-disable', false); show('tf-form-regenerate', true); byId('tf-regen-password').focus(); });
  byId('tf-btn-disable').addEventListener('click', function () { clearMsg(); show('tf-form-regenerate', false); show('tf-form-disable', true); byId('tf-disable-password').focus(); });
  byId('tf-btn-regenerate-confirm').addEventListener('click', regenerate);
  byId('tf-btn-disable-confirm').addEventListener('click', disable);
  byId('tf-disable-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); disable(); } });
  byId('tf-regen-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); regenerate(); } });
  card.querySelectorAll('[data-tf-cancel]').forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-tf-cancel'), false); });
  });

  renderStatus(null);
  panel(enabled ? 'on' : 'off');
  refresh().then(function () {
    if (card.getAttribute('data-setup') === '1' && !enabled) startSetup();
  });
})();
