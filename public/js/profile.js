'use strict';

(function () {
  // Texts come from the whitelist in templates/aurora/layout.njk
  // (docs/feature-wave2.md §W1.1); the English string is only the fallback.
  function T(key, fallback) {
    return (window.GC && window.GC.t && window.GC.t[key]) || fallback;
  }
  function byId(id) { return document.getElementById(id); }
  function setText(id, text) { var el = byId(id); if (el) el.textContent = text; }

  // ─── Identity header ────────────────────────────────────
  // Same rule as profileInitials() in src/routes/index.js.
  function initials(name) {
    var words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return '?';
    var chars = words.length > 1
      ? [Array.from(words[0])[0], Array.from(words[1])[0]]
      : Array.from(words[0]).slice(0, 2);
    return chars.join('').toUpperCase();
  }

  function renderIdentity(profile) {
    var name = profile.display_name || profile.username || '';
    setText('pf-id-name', name);
    setText('pf-avatar', initials(name));
    setText('pf-id-email', profile.email || '');
    var wrap = byId('pf-id-email-wrap');
    if (wrap) wrap.hidden = !profile.email;
  }

  // "This session": when and how the current session was established.
  function renderSession() {
    var el = byId('pf-session-time');
    if (!el) return;
    var at = Number(el.getAttribute('data-at'));
    if (!at) { el.textContent = ''; return; }
    var d = new Date(at);
    var lang = document.documentElement.lang || undefined;
    var sameDay = d.toDateString() === new Date().toDateString();
    var when;
    try {
      when = sameDay
        ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString(lang, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { when = d.toISOString().replace('T', ' ').slice(0, 16); }
    el.textContent = T('profile.session_since', 'since {{time}}').replace('{{time}}', when) + ' ·';
    el.title = d.toLocaleString(lang);
  }

  // ─── Security status (header tiles + right rail) ────────
  // profile-2fa.js and profile-passkeys.js report their state as events.
  function isDone(id) { var el = byId(id); return !!el && el.getAttribute('data-done') === '1'; }
  // pk stays null until profile-passkeys.js has loaded the list; until then
  // the score shows "–" instead of a number that would jump.
  var secure = { tf: isDone('pf-check-2fa'), pk: null };

  function renderScore() {
    if (secure.pk === null) return;
    var score = 1 + (secure.tf ? 1 : 0) + (secure.pk ? 1 : 0);
    setText('pf-score', String(score));
    var box = byId('pf-status');
    if (box) box.setAttribute('data-score', String(score));
  }

  document.addEventListener('gc:profile-2fa', function (e) {
    var d = e.detail || {};
    secure.tf = !!d.enabled;
    var stat = byId('pf-stat-2fa');
    if (stat) stat.setAttribute('data-on', secure.tf ? '1' : '0');
    setText('pf-stat-2fa-text', secure.tf ? T('two_fa.status_on', 'Active') : T('two_fa.status_off', 'Not set up'));
    var check = byId('pf-check-2fa');
    if (check) check.setAttribute('data-done', secure.tf ? '1' : '0');
    if (secure.tf && typeof d.remaining === 'number') {
      setText('pf-check-2fa-hint', T('profile.check_2fa_codes', '{{count}} recovery codes left').replace('{{count}}', d.remaining));
    } else if (secure.tf && d.remaining === undefined) {
      setText('pf-check-2fa-hint', T('profile.check_2fa_on', 'One-time code at every sign-in'));
    }
    renderScore();
  });

  document.addEventListener('gc:profile-passkeys', function (e) {
    var n = (e.detail && e.detail.count) || 0;
    secure.pk = n > 0;
    setText('pf-stat-pk', n ? T('passkey.status_count', '{{count}} registered').replace('{{count}}', n) : T('passkey.status_none', 'None'));
    var check = byId('pf-check-pk');
    if (check) check.setAttribute('data-done', secure.pk ? '1' : '0');
    renderScore();
  });

  // ─── Load profile ────────────────────────────────────────
  async function loadProfile() {
    try {
      const data = await api.get('/api/settings/profile');
      if (data.ok) {
        document.getElementById('settings-username').value = data.profile.username || '';
        document.getElementById('settings-display-name').value = data.profile.display_name || '';
        document.getElementById('settings-email').value = data.profile.email || '';
        renderIdentity(data.profile);
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    }
  }

  // ─── Save profile ───────────────────────────────────────
  document.getElementById('btn-save-profile').addEventListener('click', async function() {
    const btn = this;
    const display_name = document.getElementById('settings-display-name').value.trim();
    const email = document.getElementById('settings-email').value.trim();

    btnLoading(btn);
    try {
      const data = await api.put('/api/settings/profile', { display_name: display_name, email: email });
      if (data.ok) {
        showMessage('profile-message', T('profile.saved', 'Profile saved'), 'success');
        renderIdentity({ display_name: display_name, email: email, username: document.getElementById('settings-username').value });
      } else {
        showMessage('profile-message', data.error || T('profile.save_failed', 'Failed to save'), 'error');
      }
    } catch (err) {
      showMessage('profile-message', err.message, 'error');
    } finally {
      btnReset(btn);
    }
  });

  // ─── Change password (form opens inline) ────────────────
  var pwOpen = byId('pf-pw-open');
  var pwForm = byId('pf-pw-form');
  function setPwForm(open) {
    if (!pwForm || !pwOpen) return;
    pwForm.hidden = !open;
    pwOpen.hidden = open;
    pwOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      byId('settings-current-pw').focus();
    } else {
      ['settings-current-pw', 'settings-new-pw', 'settings-confirm-pw'].forEach(function (id) { byId(id).value = ''; });
      pwOpen.focus();
    }
  }
  if (pwOpen) {
    pwOpen.addEventListener('click', function () {
      byId('password-message').style.display = 'none';
      setPwForm(true);
    });
  }
  if (byId('pf-pw-cancel')) byId('pf-pw-cancel').addEventListener('click', function () { setPwForm(false); });
  if (pwForm) {
    pwForm.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); setPwForm(false); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); byId('btn-change-password').click(); }
    });
  }

  document.getElementById('btn-change-password').addEventListener('click', async function() {
    const btn = this;
    const current_password = document.getElementById('settings-current-pw').value;
    const new_password = document.getElementById('settings-new-pw').value;
    const confirm_pw = document.getElementById('settings-confirm-pw').value;

    if (!current_password || !new_password) {
      showMessage('password-message', T('profile.pw_all_required', 'All fields are required'), 'error');
      return;
    }

    if (new_password !== confirm_pw) {
      showMessage('password-message', T('profile.pw_mismatch', 'Passwords do not match'), 'error');
      return;
    }

    if (new_password.length < 8) {
      showMessage('password-message', T('profile.pw_too_short', 'Password must be at least 8 characters'), 'error');
      return;
    }

    btnLoading(btn);
    try {
      const data = await api.put('/api/settings/password', { current_password: current_password, new_password: new_password });
      if (data.ok) {
        setPwForm(false);
        showMessage('password-message', T('profile.pw_changed', 'Password changed successfully'), 'success');
      } else {
        showMessage('password-message', data.error || T('profile.pw_change_failed', 'Failed to change password'), 'error');
      }
    } catch (err) {
      showMessage('password-message', err.message, 'error');
    } finally {
      btnReset(btn);
    }
  });

  // ─── Language switch ─────────────────────────────────────
  const langButtons = document.getElementById('language-buttons');
  if (langButtons) {
    langButtons.addEventListener('click', async function(e) {
      const btn = e.target.closest('[data-lang]');
      if (!btn || btn.getAttribute('aria-pressed') === 'true') return;
      const lang = btn.dataset.lang;
      try {
        const data = await api.post('/api/settings/language', { language: lang });
        if (data.ok) window.location.reload();
      } catch (err) {
        console.error('Language switch error:', err);
      }
    });
  }

  // ─── Colour scheme: the same switch as the topbar button ─
  // window.GCTheme (app.js) sets and stores the scheme; this control only
  // mirrors <html data-theme>, so it stays in sync with the topbar toggle.
  const schemeButtons = byId('pf-scheme-buttons');
  if (schemeButtons) {
    const current = function () { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; };
    const sync = function () {
      schemeButtons.querySelectorAll('[data-scheme]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-scheme') === current() ? 'true' : 'false');
      });
    };
    schemeButtons.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-scheme]');
      if (!btn || btn.getAttribute('data-scheme') === current()) return;
      if (window.GCTheme) window.GCTheme.set(btn.getAttribute('data-scheme'));
    });
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
  }

  // ─── Init ───────────────────────────────────────────────
  renderSession();
  loadProfile();
})();
