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
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const display_name = document.getElementById('settings-display-name').value.trim();
    const email = document.getElementById('settings-email').value.trim();

    try {
      const data = await api.put('/api/settings/profile', { display_name, email });
      if (data.ok) {
        showMessage('profile-message', 'Profile saved', 'success');
      } else {
        showMessage('profile-message', data.error || 'Failed to save', 'error');
      }
    } catch (err) {
      showMessage('profile-message', err.message, 'error');
    }
  });

  // ─── Change password ────────────────────────────────────
  document.getElementById('btn-change-password').addEventListener('click', async () => {
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

    try {
      const data = await api.put('/api/settings/password', { current_password, new_password });
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
    }
  });

  // ─── Language switch ─────────────────────────────────────
  const langButtons = document.getElementById('language-buttons');
  if (langButtons) {
    langButtons.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-lang]');
      if (!btn) return;

      const lang = btn.dataset.lang;
      try {
        const data = await api.post('/api/settings/language', { language: lang });
        if (data.ok) {
          // Reload page to apply new language
          window.location.reload();
        }
      } catch (err) {
        console.error('Language switch error:', err);
      }
    });
  }

  // ─── Clear logs ──────────────────────────────────────────
  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    if (!confirm('Clear all activity logs? This action cannot be undone.')) return;

    try {
      const data = await api.post('/api/settings/clear-logs');
      if (data.ok) {
        alert('Logs cleared: ' + data.deleted + ' entries removed');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  // ─── Message helper ─────────────────────────────────────
  function showMessage(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = type === 'success' ? 'flash flash-success' : 'form-error';
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ─── Webhooks ──────────────────────────────────────────
  const webhooksList = document.getElementById('webhooks-list');

  async function loadWebhooks() {
    try {
      const data = await api.get('/api/webhooks');
      if (data.ok) renderWebhooks(data.webhooks);
    } catch (err) {
      console.error('Failed to load webhooks:', err);
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderWebhooks(hooks) {
    if (!hooks || hooks.length === 0) {
      webhooksList.textContent = '';
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);text-align:center;padding:8px 0';
      empty.textContent = 'No webhooks configured';
      webhooksList.appendChild(empty);
      return;
    }
    webhooksList.textContent = '';
    hooks.forEach(wh => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';
      row.dataset.whId = wh.id;

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const urlEl = document.createElement('div');
      urlEl.style.cssText = 'font-size:12px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      urlEl.title = wh.url;
      urlEl.textContent = wh.url.length > 45 ? wh.url.substring(0, 45) + '...' : wh.url;
      info.appendChild(urlEl);

      if (wh.description) {
        const descEl = document.createElement('div');
        descEl.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:2px';
        descEl.textContent = wh.description;
        info.appendChild(descEl);
      }
      row.appendChild(info);

      const tag = document.createElement('span');
      tag.className = wh.enabled ? 'tag tag-green' : 'tag tag-amber';
      tag.style.fontSize = '10px';
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(wh.enabled ? 'Active' : 'Off'));
      row.appendChild(tag);

      ['test', 'toggle', 'delete'].forEach(action => {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.title = action.charAt(0).toUpperCase() + action.slice(1);
        btn.dataset.whAction = action;
        btn.dataset.whId = wh.id;
        btn.style.cssText = 'width:24px;height:24px';
        const svgPaths = {
          test: '<polygon points="5 3 19 12 5 21 5 3"/>',
          toggle: '<path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
          delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
        };
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' + svgPaths[action] + '</svg>';
        row.appendChild(btn);
      });

      webhooksList.appendChild(row);
    });
  }

  if (webhooksList) {
    webhooksList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-wh-action]');
      if (!btn) return;
      const action = btn.dataset.whAction;
      const id = btn.dataset.whId;

      if (action === 'test') {
        try {
          const data = await api.post('/api/webhooks/' + id + '/test');
          alert(data.ok ? 'Test sent (HTTP ' + data.status + ')' : 'Test failed: ' + data.error);
        } catch (err) { alert('Test failed: ' + err.message); }
      } else if (action === 'toggle') {
        try { await api.post('/api/webhooks/' + id + '/toggle'); loadWebhooks(); } catch (err) { console.error(err); }
      } else if (action === 'delete') {
        if (!confirm('Delete this webhook?')) return;
        try { await api.del('/api/webhooks/' + id); loadWebhooks(); } catch (err) { console.error(err); }
      }
    });
  }

  const btnAddWebhook = document.getElementById('btn-add-webhook');
  if (btnAddWebhook) {
    btnAddWebhook.addEventListener('click', async () => {
      const url = document.getElementById('webhook-url').value.trim();
      const description = document.getElementById('webhook-desc').value.trim();
      if (!url) return alert('Webhook URL is required');
      try {
        const data = await api.post('/api/webhooks', { url, description, events: '*' });
        if (data.ok) {
          document.getElementById('webhook-url').value = '';
          document.getElementById('webhook-desc').value = '';
          loadWebhooks();
        } else {
          alert(data.error || 'Failed to create webhook');
        }
      } catch (err) { alert(err.message); }
    });
  }

  // ─── Init ───────────────────────────────────────────────
  loadProfile();
  loadWebhooks();
})();
