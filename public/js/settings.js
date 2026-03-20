'use strict';

// Note: btn.innerHTML usage below is safe - only hardcoded SVG paths are inserted, no user input.

(function () {
  // ─── Clear logs ──────────────────────────────────────────
  document.getElementById('btn-clear-logs').addEventListener('click', async function() {
    if (!confirm(GC.t['settings.confirm_clear_logs'] || 'Clear all activity logs? This action cannot be undone.')) return;
    const btn = this;

    btnLoading(btn);
    try {
      const data = await api.post('/api/settings/clear-logs');
      if (data.ok) {
        alert((GC.t['settings.logs_cleared'] || 'Logs cleared') + ': ' + data.deleted);
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
        try { await api.put('/api/webhooks/' + id + '/toggle'); loadWebhooks(); } catch (err) { console.error(err); }
      } else if (action === 'delete') {
        if (!confirm(GC.t['settings.confirm_delete_webhook'] || 'Delete this webhook?')) return;
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
        var data = await api.post('/api/smtp/test', { email: email });
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

  // ─── Security Settings ────────────────────────────────

  // Toggle helpers for managed toggles
  function setupManagedToggle(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', function() { el.classList.toggle('on'); });
  }
  ['security-lockout-enabled', 'security-password-enabled', 'security-password-uppercase',
   'security-password-number', 'security-password-special'].forEach(setupManagedToggle);

  async function loadSecuritySettings() {
    try {
      var data = await api.get('/api/settings/security');
      if (!data.ok) return;
      var lo = data.data.lockout;
      var pw = data.data.password;

      var loEnabled = document.getElementById('security-lockout-enabled');
      if (loEnabled) { if (lo.enabled) loEnabled.classList.add('on'); else loEnabled.classList.remove('on'); }
      var loAttempts = document.getElementById('security-lockout-attempts');
      if (loAttempts) loAttempts.value = lo.max_attempts;
      var loDuration = document.getElementById('security-lockout-duration');
      if (loDuration) loDuration.value = lo.duration;

      var pwEnabled = document.getElementById('security-password-enabled');
      if (pwEnabled) { if (pw.complexity_enabled) pwEnabled.classList.add('on'); else pwEnabled.classList.remove('on'); }
      var pwMin = document.getElementById('security-password-min-length');
      if (pwMin) pwMin.value = pw.min_length;
      var pwUpper = document.getElementById('security-password-uppercase');
      if (pwUpper) { if (pw.require_uppercase) pwUpper.classList.add('on'); else pwUpper.classList.remove('on'); }
      var pwNum = document.getElementById('security-password-number');
      if (pwNum) { if (pw.require_number) pwNum.classList.add('on'); else pwNum.classList.remove('on'); }
      var pwSpecial = document.getElementById('security-password-special');
      if (pwSpecial) { if (pw.require_special) pwSpecial.classList.add('on'); else pwSpecial.classList.remove('on'); }
    } catch (err) {
      console.error('Failed to load security settings:', err);
    }
  }

  async function loadLockedAccounts() {
    var listEl = document.getElementById('security-locked-list');
    if (!listEl) return;
    try {
      var data = await api.get('/api/settings/lockout');
      if (!data.ok || !data.locked || data.locked.length === 0) {
        listEl.textContent = GC.t['security.lockout.no_locked'] || 'No locked accounts';
        return;
      }
      listEl.textContent = '';
      data.locked.forEach(function(acc) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)';
        var info = document.createElement('div');
        info.style.cssText = 'font-size:12px';
        var id = document.createElement('span');
        id.style.fontWeight = '600';
        id.textContent = acc.identifier;
        info.appendChild(id);
        var remaining = document.createElement('span');
        remaining.style.cssText = 'color:var(--text-3);margin-left:8px';
        var mins = Math.ceil(acc.remainingSeconds / 60);
        remaining.textContent = (GC.t['security.lockout.remaining'] || '{{minutes}} min remaining').replace('{{minutes}}', mins);
        info.appendChild(remaining);
        row.appendChild(info);
        var btn = document.createElement('button');
        btn.className = 'btn btn-ghost';
        btn.style.cssText = 'font-size:11px;padding:3px 8px;color:var(--red)';
        btn.textContent = GC.t['security.lockout.unlock'] || 'Unlock';
        btn.addEventListener('click', async function() {
          try {
            await api.del('/api/settings/lockout/' + encodeURIComponent(acc.identifier));
            loadLockedAccounts();
          } catch (err) { alert(err.message); }
        });
        row.appendChild(btn);
        listEl.appendChild(row);
      });
    } catch (err) {
      listEl.textContent = GC.t['security.lockout.no_locked'] || 'No locked accounts';
    }
  }

  var btnSecuritySave = document.getElementById('btn-security-save');
  if (btnSecuritySave) {
    btnSecuritySave.addEventListener('click', async function() {
      btnLoading(btnSecuritySave);
      try {
        var payload = {
          lockout: {
            enabled: document.getElementById('security-lockout-enabled').classList.contains('on'),
            max_attempts: document.getElementById('security-lockout-attempts').value,
            duration: document.getElementById('security-lockout-duration').value,
          },
          password: {
            complexity_enabled: document.getElementById('security-password-enabled').classList.contains('on'),
            min_length: document.getElementById('security-password-min-length').value,
            require_uppercase: document.getElementById('security-password-uppercase').classList.contains('on'),
            require_number: document.getElementById('security-password-number').classList.contains('on'),
            require_special: document.getElementById('security-password-special').classList.contains('on'),
          },
        };
        var data = await api.put('/api/settings/security', payload);
        if (data.ok) {
          showMessage('security-message', GC.t['security.saved'] || 'Security settings saved', 'success');
        } else {
          showMessage('security-message', data.error || 'Failed to save', 'error');
        }
      } catch (err) {
        showMessage('security-message', err.message, 'error');
      } finally {
        btnReset(btnSecuritySave);
      }
    });
  }

  // ─── Monitoring Settings ───────────────────────────────

  // ─── Data & Retention Settings ─────────────────────────

  async function loadDataSettings() {
    try {
      var data = await api.get('/api/settings/data');
      if (!data.ok) return;
      var d = data.data;
      var el1 = document.getElementById('data-traffic-days');
      if (el1) el1.value = d.retention_traffic_days;
      var el2 = document.getElementById('data-activity-days');
      if (el2) el2.value = d.retention_activity_days;
      var el3 = document.getElementById('data-peer-timeout');
      if (el3) el3.value = d.peer_online_timeout;
    } catch (err) {
      console.error('Failed to load data settings:', err);
    }
  }

  var btnDataSave = document.getElementById('btn-data-save');
  if (btnDataSave) {
    btnDataSave.addEventListener('click', async function() {
      btnLoading(btnDataSave);
      try {
        var data = await api.put('/api/settings/data', {
          retention_traffic_days: document.getElementById('data-traffic-days').value,
          retention_activity_days: document.getElementById('data-activity-days').value,
          peer_online_timeout: document.getElementById('data-peer-timeout').value,
        });
        if (data.ok) {
          showMessage('data-message', GC.t['security.saved'] || 'Settings saved', 'success');
        } else {
          showMessage('data-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('data-message', err.message, 'error');
      } finally {
        btnReset(btnDataSave);
      }
    });
  }

  // ─── Monitoring Settings ───────────────────────────────

  var monEmailToggle = document.getElementById('monitoring-email-alerts');
  if (monEmailToggle) monEmailToggle.addEventListener('click', function() { monEmailToggle.classList.toggle('on'); });

  async function loadMonitoringSettings() {
    try {
      var data = await api.get('/api/settings/monitoring');
      if (!data.ok) return;
      var d = data.data;
      var intervalEl = document.getElementById('monitoring-interval');
      if (intervalEl) intervalEl.value = d.interval;
      if (monEmailToggle) { if (d.emailAlerts) monEmailToggle.classList.add('on'); else monEmailToggle.classList.remove('on'); }
      var emailEl = document.getElementById('monitoring-alert-email');
      if (emailEl) emailEl.value = d.alertEmail || '';
    } catch (err) {
      console.error('Failed to load monitoring settings:', err);
    }
  }

  var btnMonSave = document.getElementById('btn-monitoring-save');
  if (btnMonSave) {
    btnMonSave.addEventListener('click', async function() {
      btnLoading(btnMonSave);
      try {
        var data = await api.put('/api/settings/monitoring', {
          interval: document.getElementById('monitoring-interval').value,
          email_alerts: monEmailToggle.classList.contains('on'),
          alert_email: document.getElementById('monitoring-alert-email').value,
        });
        if (data.ok) {
          showMessage('monitoring-message', GC.t['security.saved'] || 'Settings saved', 'success');
        } else {
          showMessage('monitoring-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('monitoring-message', err.message, 'error');
      } finally {
        btnReset(btnMonSave);
      }
    });
  }

  // ─── Email Alert Settings ──────────────────────────────

  async function loadAlertSettings() {
    try {
      var data = await api.get('/api/settings/alerts');
      if (!data.ok) return;
      var d = data.data;
      var emailEl = document.getElementById('alerts-email');
      if (emailEl) emailEl.value = d.email || '';
      var backupEl = document.getElementById('alerts-backup-days');
      if (backupEl) backupEl.value = d.backup_reminder_days || 0;
      var cpuEl = document.getElementById('alerts-cpu');
      if (cpuEl) cpuEl.value = d.resource_cpu_threshold || 0;
      var ramEl = document.getElementById('alerts-ram');
      if (ramEl) ramEl.value = d.resource_ram_threshold || 0;

      // Set checkboxes based on configured events
      var configuredEvents = (d.email_events || '').split(',').map(function(e) { return e.trim(); }).filter(Boolean);
      document.querySelectorAll('.alert-event-group').forEach(function(cb) {
        var groupEvents = cb.dataset.events.split(',');
        cb.checked = groupEvents.some(function(e) { return configuredEvents.includes(e); });
      });
    } catch (err) {
      console.error('Failed to load alert settings:', err);
    }
  }

  var btnAlertsSave = document.getElementById('btn-alerts-save');
  if (btnAlertsSave) {
    btnAlertsSave.addEventListener('click', async function() {
      btnLoading(btnAlertsSave);
      try {
        // Collect selected events from checkboxes
        var events = [];
        document.querySelectorAll('.alert-event-group:checked').forEach(function(cb) {
          cb.dataset.events.split(',').forEach(function(e) { if (events.indexOf(e) === -1) events.push(e); });
        });
        var data = await api.put('/api/settings/alerts', {
          email: document.getElementById('alerts-email').value,
          email_events: events.join(','),
          backup_reminder_days: document.getElementById('alerts-backup-days').value,
          resource_cpu_threshold: document.getElementById('alerts-cpu').value,
          resource_ram_threshold: document.getElementById('alerts-ram').value,
        });
        if (data.ok) {
          showMessage('alerts-message', GC.t['security.saved'] || 'Settings saved', 'success');
        } else {
          showMessage('alerts-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('alerts-message', err.message, 'error');
      } finally {
        btnReset(btnAlertsSave);
      }
    });
  }

  // ─── Init ───────────────────────────────────────────────
  loadWebhooks();
  loadSecuritySettings();
  loadLockedAccounts();
  loadDataSettings();
  loadMonitoringSettings();
  loadAlertSettings();
  setInterval(loadLockedAccounts, 30000);
})();
