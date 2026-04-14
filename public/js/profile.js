'use strict';

(function () {
  // ─── Load profile ────────────────────────────────────────
  async function loadProfile() {
    try {
      const data = await api.get('/api/settings/profile');
      if (data.ok) {
        document.getElementById('settings-username').value = data.profile.username || '';
        document.getElementById('settings-display-name').value = data.profile.display_name || '';
        document.getElementById('settings-email').value = data.profile.email || '';
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
        showMessage('profile-message', 'Profile saved', 'success');
      } else {
        showMessage('profile-message', data.error || 'Failed to save', 'error');
      }
    } catch (err) {
      showMessage('profile-message', err.message, 'error');
    } finally {
      btnReset(btn);
    }
  });

  // ─── Change password ────────────────────────────────────
  document.getElementById('btn-change-password').addEventListener('click', async function() {
    const btn = this;
    const current_password = document.getElementById('settings-current-pw').value;
    const new_password = document.getElementById('settings-new-pw').value;
    const confirm_pw = document.getElementById('settings-confirm-pw').value;

    if (!current_password || !new_password) {
      showMessage('password-message', 'All fields are required', 'error');
      return;
    }

    if (new_password !== confirm_pw) {
      showMessage('password-message', 'Passwords do not match', 'error');
      return;
    }

    if (new_password.length < 8) {
      showMessage('password-message', 'Password must be at least 8 characters', 'error');
      return;
    }

    btnLoading(btn);
    try {
      const data = await api.put('/api/settings/password', { current_password: current_password, new_password: new_password });
      if (data.ok) {
        showMessage('password-message', 'Password changed successfully', 'success');
        document.getElementById('settings-current-pw').value = '';
        document.getElementById('settings-new-pw').value = '';
        document.getElementById('settings-confirm-pw').value = '';
      } else {
        showMessage('password-message', data.error || 'Failed to change password', 'error');
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
      if (!btn) return;
      const lang = btn.dataset.lang;
      try {
        const data = await api.post('/api/settings/language', { language: lang });
        if (data.ok) window.location.reload();
      } catch (err) {
        console.error('Language switch error:', err);
      }
    });
  }

  // ─── Theme switch ────────────────────────────────────────
  var themeButtons = document.getElementById('theme-buttons');
  if (themeButtons) {
    themeButtons.addEventListener('click', async function(e) {
      var btn = e.target.closest('[data-theme]');
      if (!btn) return;
      var selectedTheme = btn.dataset.theme;
      try {
        var data = await api.put('/api/settings/profile', { theme: selectedTheme });
        if (data.ok) window.location.reload();
      } catch (err) {
        console.error('Theme switch error:', err);
      }
    });
  }

  // ─── Init ───────────────────────────────────────────────
  loadProfile();
})();
