'use strict';

// "Sign in with a passkey" on /login (docs/feature-admin-passkeys.md).
// Usernameless: the authenticator picks the account. The password form
// stays the fallback and is untouched by this script.
(function () {
  var box = document.getElementById('pk-login');
  var btn = document.getElementById('pk-login-btn');
  if (!box || !btn || !window.GCWebAuthn) return;

  var origin = box.getAttribute('data-origin') || '';
  var form = document.querySelector('form[action="/login"]');
  var csrfInput = form ? form.querySelector('input[name="_csrf"]') : null;
  var returnInput = form ? form.querySelector('input[name="returnTo"]') : null;
  var msgEl = document.getElementById('pk-login-msg');
  var T = {};
  try { T = JSON.parse(document.getElementById('pk-login-i18n').textContent); } catch (e) { T = {}; }

  function say(text) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
  }

  if (!window.GCWebAuthn.supported()) {
    say(T.unsupported || '');
    btn.disabled = true;
    box.hidden = false;
    return;
  }
  // The RP ID is pinned to GC_BASE_URL: on any other origin (IP address,
  // second host name) the browser would refuse, so say where it works.
  if (origin && window.location.origin !== origin) {
    say((T.wrong_origin || '').replace('{{origin}}', origin));
    btn.disabled = true;
    box.hidden = false;
    return;
  }
  box.hidden = false;

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': csrfInput ? csrfInput.value : '',
      },
      body: JSON.stringify(body || {}),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { status: res.status, data: data || { ok: false } };
  }

  btn.addEventListener('click', async function () {
    say('');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      var opt = await postJson('/login/passkey/options', {});
      if (!opt.data.ok) { say(opt.data.error || T.failed); return; }
      var assertion;
      try {
        assertion = await window.GCWebAuthn.authenticate(opt.data.data);
      } catch (err) {
        say(window.GCWebAuthn.isCancel(err) ? (T.cancelled || '') : (T.failed || err.message));
        return;
      }
      var res = await postJson('/login/passkey', { response: assertion, returnTo: returnInput ? returnInput.value : '' });
      if (res.data.ok) {
        window.location.assign(res.data.redirect || '/dashboard');
        return;
      }
      say(res.data.error || T.failed);
    } catch (err) {
      say(T.failed || String(err));
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  });
})();
