'use strict';

// Note: btn.innerHTML usage below is safe - only hardcoded SVG paths are inserted, no user input.

(function () {
  // ─── Clear logs ──────────────────────────────────────────
  document.getElementById('btn-clear-logs').addEventListener('click', async function() {
    if (!confirm('Clear all activity logs? This action cannot be undone.')) return;
    const btn = this;

    btnLoading(btn);
    try {
      const data = await api.post('/api/settings/clear-logs');
      if (data.ok) {
        alert('Logs cleared: ' + data.deleted + ' entries removed');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

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
    hooks.forEach(function(wh) {
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

      const svgPaths = {
        test: '<polygon points="5 3 19 12 5 21 5 3"/>',
        toggle: '<path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
        delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
      };
      ['test', 'toggle', 'delete'].forEach(function(action) {
        const btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.title = action.charAt(0).toUpperCase() + action.slice(1);
        btn.dataset.whAction = action;
        btn.dataset.whId = wh.id;
        btn.style.cssText = 'width:24px;height:24px';
        // Safe: only hardcoded SVG paths, no user input
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' + svgPaths[action] + '</svg>';
        row.appendChild(btn);
      });

      webhooksList.appendChild(row);
    });
  }

  if (webhooksList) {
    webhooksList.addEventListener('click', async function(e) {
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
    btnAddWebhook.addEventListener('click', async function() {
      const url = document.getElementById('webhook-url').value.trim();
      const description = document.getElementById('webhook-desc').value.trim();
      if (!url) return alert('Webhook URL is required');
      try {
        const data = await api.post('/api/webhooks', { url: url, description: description, events: '*' });
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

  // ─── Backup & Restore ───────────────────────────────────
  let pendingBackupFile = null;

  document.getElementById('btn-backup-download').addEventListener('click', async function() {
    try {
      const resp = await fetch('/api/settings/backup', { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const match = (resp.headers.get('Content-Disposition') || '').match(/filename="(.+)"/);
      a.download = match ? match[1] : 'gatecontrol-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Backup failed: ' + err.message);
    }
  });

  document.getElementById('btn-backup-select').addEventListener('click', function() {
    document.getElementById('backup-file-input').click();
  });

  document.getElementById('backup-file-input').addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const preview = document.getElementById('backup-preview');
    const restoreBtn = document.getElementById('btn-backup-restore');
    const msgEl = document.getElementById('restore-message');
    msgEl.style.display = 'none';

    const formData = new FormData();
    formData.append('backup', file);

    try {
      const resp = await fetch('/api/settings/restore/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': window.GC.csrfToken },
        body: formData,
      });
      const data = await resp.json();

      if (!data.ok) {
        preview.style.display = 'none';
        restoreBtn.style.display = 'none';
        pendingBackupFile = null;
        showMessage('restore-message', data.error + (data.errors ? ': ' + data.errors.join(', ') : ''), 'error');
        return;
      }

      const s = data.summary;
      preview.textContent = s.peers + ' Peers, ' + s.routes + ' Routes, ' + s.settings + ' Settings, ' + s.webhooks + ' Webhooks (' + s.created_at + ')';
      preview.style.display = 'block';
      restoreBtn.style.display = 'inline-flex';
      pendingBackupFile = file;
    } catch (err) {
      preview.style.display = 'none';
      restoreBtn.style.display = 'none';
      pendingBackupFile = null;
      showMessage('restore-message', err.message, 'error');
    }
  });

  document.getElementById('btn-backup-restore').addEventListener('click', async function() {
    if (!pendingBackupFile) return;
    if (!confirm('This will replace ALL existing peers, routes, settings and webhooks. Continue?')) return;

    const formData = new FormData();
    formData.append('backup', pendingBackupFile);

    try {
      const resp = await fetch('/api/settings/restore', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': window.GC.csrfToken },
        body: formData,
      });
      const data = await resp.json();

      if (data.ok) {
        const r = data.restored;
        alert('Restore complete: ' + r.peers + ' peers, ' + r.routes + ' routes, ' + r.settings + ' settings, ' + r.webhooks + ' webhooks');
        window.location.reload();
      } else {
        showMessage('restore-message', data.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showMessage('restore-message', err.message, 'error');
    }
  });

  // ─── SMTP ───────────────────────────────────────────────
  // Load SMTP settings
  api.get('/api/smtp/settings').then(function(data) {
    if (data.ok && data.data) {
      document.getElementById('smtp-host').value = data.data.host || '';
      document.getElementById('smtp-port').value = data.data.port || '';
      document.getElementById('smtp-user').value = data.data.user || '';
      document.getElementById('smtp-from').value = data.data.from || '';
      var tlsToggle = document.getElementById('smtp-tls');
      if (data.data.secure) tlsToggle.classList.add('on');
      else tlsToggle.classList.remove('on');
      if (data.data.hasPassword) {
        var hint = document.getElementById('smtp-password-hint');
        hint.textContent = 'Password is set';
        hint.style.display = '';
      }
    }
  }).catch(function(err) {
    console.error('Failed to load SMTP settings:', err);
  });

  // TLS toggle
  var smtpTlsToggle = document.getElementById('smtp-tls');
  if (smtpTlsToggle) {
    smtpTlsToggle.addEventListener('click', function() {
      smtpTlsToggle.classList.toggle('on');
    });
  }

  // Save SMTP settings
  var btnSmtpSave = document.getElementById('btn-smtp-save');
  if (btnSmtpSave) {
    btnSmtpSave.addEventListener('click', async function() {
      btnLoading(btnSmtpSave);
      try {
        var payload = {
          host: document.getElementById('smtp-host').value,
          port: document.getElementById('smtp-port').value,
          user: document.getElementById('smtp-user').value,
          from: document.getElementById('smtp-from').value,
          secure: document.getElementById('smtp-tls').classList.contains('on'),
        };
        var pw = document.getElementById('smtp-password').value;
        if (pw) payload.password = pw;
        var data = await api.put('/api/smtp/settings', payload);
        if (data.ok) {
          if (pw) {
            var hint = document.getElementById('smtp-password-hint');
            hint.textContent = 'Password is set';
            hint.style.display = '';
            document.getElementById('smtp-password').value = '';
          }
          showMessage('smtp-test-result', 'SMTP settings saved', 'success');
          document.getElementById('smtp-test-result').style.display = '';
        } else {
          showMessage('smtp-test-result', data.error || 'Failed to save SMTP settings', 'error');
          document.getElementById('smtp-test-result').style.display = '';
        }
      } catch (err) {
        showMessage('smtp-test-result', err.message, 'error');
        document.getElementById('smtp-test-result').style.display = '';
      } finally {
        btnReset(btnSmtpSave);
      }
    });
  }

  // Test SMTP
  var btnSmtpTest = document.getElementById('btn-smtp-test');
  if (btnSmtpTest) {
    btnSmtpTest.addEventListener('click', async function() {
      var email = document.getElementById('smtp-test-email').value.trim();
      var resultEl = document.getElementById('smtp-test-result');
      if (!email) {
        resultEl.textContent = 'Email address is required';
        resultEl.style.cssText = 'display:block;padding:8px 12px;border-radius:var(--radius-xs);font-size:12px;font-family:var(--font-mono);margin-top:10px;background:var(--red-bg);color:var(--red)';
        return;
      }
      btnLoading(btnSmtpTest);
      resultEl.style.display = 'none';
      try {
        var data = await api.post('/api/smtp/test', { to: email });
        if (data.ok) {
          resultEl.textContent = 'Test email sent to ' + email;
          resultEl.style.cssText = 'display:block;padding:8px 12px;border-radius:var(--radius-xs);font-size:12px;font-family:var(--font-mono);margin-top:10px;background:var(--green-bg);color:var(--green)';
        } else {
          resultEl.textContent = data.error || 'Test failed';
          resultEl.style.cssText = 'display:block;padding:8px 12px;border-radius:var(--radius-xs);font-size:12px;font-family:var(--font-mono);margin-top:10px;background:var(--red-bg);color:var(--red)';
        }
      } catch (err) {
        resultEl.textContent = err.message;
        resultEl.style.cssText = 'display:block;padding:8px 12px;border-radius:var(--radius-xs);font-size:12px;font-family:var(--font-mono);margin-top:10px;background:var(--red-bg);color:var(--red)';
      } finally {
        btnReset(btnSmtpTest);
      }
    });
  }

  // ─── Init ───────────────────────────────────────────────
  loadWebhooks();
})();
