'use strict';

// Note: btn.innerHTML usage below is safe - only hardcoded SVG paths are inserted, no user input.

// ─── Settings Tab Switching ──────────────────────────────
(function () {
  var tabs = document.querySelectorAll('.settings-tabs .tab');
  var panels = document.querySelectorAll('.settings-panel');
  var toggle = document.querySelector('.settings-tab-toggle');
  var dropdown = document.querySelector('.settings-tab-dropdown');
  var label = document.querySelector('.settings-tab-label');
  if (!tabs.length) return;

  function switchTab(tabName) {
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.dataset.settingsTab === tabName);
    });
    panels.forEach(function (p) {
      p.style.display = p.dataset.settingsPanel === tabName ? '' : 'none';
    });
    // Update mobile hamburger label
    if (label) {
      var activeTab = document.querySelector('.settings-tabs > .tab.active');
      if (activeTab) label.textContent = activeTab.textContent;
    }
    try { localStorage.setItem('settings-active-tab', tabName); } catch (e) {}
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      switchTab(t.dataset.settingsTab);
      // Close dropdown on mobile after selection
      if (dropdown && dropdown.classList.contains('open')) {
        dropdown.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  });

  // Mobile hamburger toggle
  if (toggle && dropdown) {
    toggle.addEventListener('click', function () {
      var isOpen = dropdown.classList.toggle('open');
      toggle.classList.toggle('open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!toggle.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Restore last active tab
  var saved = null;
  try { saved = localStorage.getItem('settings-active-tab'); } catch (e) {}
  if (saved && document.querySelector('[data-settings-panel="' + saved + '"]')) {
    switchTab(saved);
  }
})();

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
      const resp = await fetch('/api/v1/settings/backup', { credentials: 'same-origin' });
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
      const resp = await fetch('/api/v1/settings/restore/preview', {
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
      const resp = await fetch('/api/v1/settings/restore', {
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

  async function saveSecuritySettings(triggerBtn, messageId) {
    btnLoading(triggerBtn);
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
        showMessage(messageId, GC.t['security.saved'] || 'Security settings saved', 'success');
      } else {
        showMessage(messageId, data.error || 'Failed to save', 'error');
      }
    } catch (err) {
      showMessage(messageId, err.message, 'error');
    } finally {
      btnReset(triggerBtn);
    }
  }

  var btnSecuritySave = document.getElementById('btn-security-save');
  if (btnSecuritySave) {
    btnSecuritySave.addEventListener('click', function() {
      saveSecuritySettings(btnSecuritySave, 'security-message');
    });
  }

  var btnPasswordSave = document.getElementById('btn-password-save');
  if (btnPasswordSave) {
    btnPasswordSave.addEventListener('click', function() {
      saveSecuritySettings(btnPasswordSave, 'security-message-2');
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

  // ─── ip2location Settings ──────────────────────────────

  async function loadIp2locationSettings() {
    try {
      var data = await api.get('/api/v1/settings/ip2location');
      if (data.ok && data.data.has_api_key) {
        var el = document.getElementById('ip2location-key');
        if (el) el.placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + ' (' + (GC.t['settings.key_is_set'] || 'Key is set') + ')';
      }
    } catch (err) { console.error('Failed to load ip2location settings:', err); }
  }

  var btnIp2Save = document.getElementById('btn-ip2location-save');
  if (btnIp2Save) {
    btnIp2Save.addEventListener('click', async function() {
      btnLoading(btnIp2Save);
      try {
        var key = document.getElementById('ip2location-key').value;
        var data = await api.put('/api/v1/settings/ip2location', { api_key: key });
        if (data.ok) {
          showMessage('ip2location-result', GC.t['security.saved'] || 'Saved', 'success');
          document.getElementById('ip2location-key').value = '';
          loadIp2locationSettings();
        } else {
          showMessage('ip2location-result', data.error || 'Failed', 'error');
        }
      } catch (err) { showMessage('ip2location-result', err.message, 'error'); }
      finally { btnReset(btnIp2Save); }
    });
  }

  var btnIp2Test = document.getElementById('btn-ip2location-test');
  if (btnIp2Test) {
    btnIp2Test.addEventListener('click', async function() {
      btnLoading(btnIp2Test);
      try {
        var data = await api.post('/api/v1/settings/ip2location/test', {});
        if (data.ok && data.data) {
          showMessage('ip2location-result', data.data.country_name + ' (' + data.data.country_code + ') — ' + data.data.ip, 'success');
        } else {
          showMessage('ip2location-result', data.error || 'Test failed', 'error');
        }
      } catch (err) { showMessage('ip2location-result', err.message, 'error'); }
      finally { btnReset(btnIp2Test); }
    });
  }

  // ─── Auto-Backup Settings ──────────────────────────────

  var autobackupEnabledToggle = document.getElementById('autobackup-enabled');
  if (autobackupEnabledToggle) {
    autobackupEnabledToggle.addEventListener('click', function() {
      autobackupEnabledToggle.classList.toggle('on');
    });
  }

  function createSvgIcon(paths) {
    // Safe: creates SVG elements via DOM API, no innerHTML used
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    paths.forEach(function(p) {
      var el;
      if (p.type === 'path') {
        el = document.createElementNS(ns, 'path');
        el.setAttribute('d', p.d);
      } else if (p.type === 'polyline') {
        el = document.createElementNS(ns, 'polyline');
        el.setAttribute('points', p.points);
      } else if (p.type === 'line') {
        el = document.createElementNS(ns, 'line');
        el.setAttribute('x1', p.x1); el.setAttribute('y1', p.y1);
        el.setAttribute('x2', p.x2); el.setAttribute('y2', p.y2);
      }
      if (el) svg.appendChild(el);
    });
    return svg;
  }

  async function loadAutobackupSettings() {
    try {
      var data = await api.get('/api/settings/autobackup');
      if (!data.ok) return;
      var d = data.data;
      if (autobackupEnabledToggle) {
        if (d.enabled) autobackupEnabledToggle.classList.add('on');
        else autobackupEnabledToggle.classList.remove('on');
      }
      var scheduleEl = document.getElementById('autobackup-schedule');
      if (scheduleEl) scheduleEl.value = d.schedule || 'daily';
      var retentionEl = document.getElementById('autobackup-retention');
      if (retentionEl) retentionEl.value = d.retention || 5;
      var lastRunEl = document.getElementById('autobackup-last-run');
      if (lastRunEl) {
        lastRunEl.textContent = d.lastRun
          ? new Date(d.lastRun).toLocaleString()
          : (GC.t['autobackup.last_run_never'] || 'Never');
      }
    } catch (err) {
      console.error('Failed to load auto-backup settings:', err);
    }
  }

  async function loadAutobackupFiles() {
    var container = document.getElementById('autobackup-files');
    if (!container) return;
    try {
      var data = await api.get('/api/settings/autobackup/list');
      if (!data.ok || !data.files || data.files.length === 0) {
        container.textContent = GC.t['autobackup.no_files'] || 'No backup files yet';
        return;
      }
      container.textContent = '';
      data.files.forEach(function(f) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)';

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0';
        var nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:12px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        nameEl.textContent = f.filename;
        info.appendChild(nameEl);
        var metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size:10px;color:var(--text-3);margin-top:2px';
        var sizeKb = (f.size / 1024).toFixed(1);
        metaEl.textContent = sizeKb + ' KB — ' + new Date(f.created).toLocaleString();
        info.appendChild(metaEl);
        row.appendChild(info);

        var downloadBtn = document.createElement('button');
        downloadBtn.className = 'icon-btn';
        downloadBtn.title = GC.t['peers.download'] || 'Download';
        downloadBtn.style.cssText = 'width:24px;height:24px';
        downloadBtn.appendChild(createSvgIcon([
          { type: 'path', d: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4' },
          { type: 'polyline', points: '7 10 12 15 17 10' },
          { type: 'line', x1: '12', y1: '15', x2: '12', y2: '3' },
        ]));
        downloadBtn.addEventListener('click', function() {
          var a = document.createElement('a');
          a.href = '/api/v1/settings/autobackup/download/' + encodeURIComponent(f.filename);
          a.download = f.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
        row.appendChild(downloadBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'icon-btn';
        deleteBtn.title = GC.t['common.delete'] || 'Delete';
        deleteBtn.style.cssText = 'width:24px;height:24px;color:var(--red)';
        deleteBtn.appendChild(createSvgIcon([
          { type: 'polyline', points: '3 6 5 6 21 6' },
          { type: 'path', d: 'M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2' },
        ]));
        deleteBtn.addEventListener('click', async function() {
          if (!confirm(GC.t['autobackup.confirm_delete'] || 'Delete this backup file?')) return;
          try {
            var res = await api.del('/api/settings/autobackup/' + encodeURIComponent(f.filename));
            if (res.ok) loadAutobackupFiles();
            else alert(res.error || 'Failed');
          } catch (err) { alert(err.message); }
        });
        row.appendChild(deleteBtn);

        container.appendChild(row);
      });
    } catch (err) {
      container.textContent = GC.t['autobackup.no_files'] || 'No backup files yet';
      console.error('Failed to load backup files:', err);
    }
  }

  var btnAutobackupSave = document.getElementById('btn-autobackup-save');
  if (btnAutobackupSave) {
    btnAutobackupSave.addEventListener('click', async function() {
      btnLoading(btnAutobackupSave);
      try {
        var data = await api.put('/api/settings/autobackup', {
          enabled: autobackupEnabledToggle.classList.contains('on'),
          schedule: document.getElementById('autobackup-schedule').value,
          retention: document.getElementById('autobackup-retention').value,
        });
        if (data.ok) {
          showMessage('autobackup-message', GC.t['autobackup.saved'] || 'Auto-backup settings saved', 'success');
        } else {
          showMessage('autobackup-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('autobackup-message', err.message, 'error');
      } finally {
        btnReset(btnAutobackupSave);
      }
    });
  }

  var btnAutobackupRun = document.getElementById('btn-autobackup-run');
  if (btnAutobackupRun) {
    btnAutobackupRun.addEventListener('click', async function() {
      btnLoading(btnAutobackupRun);
      try {
        var data = await api.post('/api/settings/autobackup/run');
        if (data.ok) {
          showMessage('autobackup-message', (GC.t['autobackup.run_success'] || 'Backup created successfully') + ': ' + data.filename, 'success');
          loadAutobackupFiles();
          loadAutobackupSettings();
        } else {
          showMessage('autobackup-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('autobackup-message', err.message, 'error');
      } finally {
        btnReset(btnAutobackupRun);
      }
    });
  }

  // ─── Metrics Settings ──────────────────────────────────

  var metricsEnabledToggle = document.getElementById('metrics-enabled');
  if (metricsEnabledToggle) {
    metricsEnabledToggle.addEventListener('click', function() {
      metricsEnabledToggle.classList.toggle('on');
    });
  }

  async function loadMetricsSettings() {
    try {
      var data = await api.get('/api/settings/metrics');
      if (!data.ok) return;
      if (metricsEnabledToggle) {
        if (data.data.enabled) metricsEnabledToggle.classList.add('on');
        else metricsEnabledToggle.classList.remove('on');
      }
    } catch (err) {
      console.error('Failed to load metrics settings:', err);
    }
  }

  var btnMetricsSave = document.getElementById('btn-metrics-save');
  if (btnMetricsSave) {
    btnMetricsSave.addEventListener('click', async function() {
      btnLoading(btnMetricsSave);
      try {
        var data = await api.put('/api/settings/metrics', {
          enabled: metricsEnabledToggle.classList.contains('on'),
        });
        if (data.ok) {
          showMessage('metrics-message', GC.t['security.saved'] || 'Settings saved', 'success');
        } else {
          showMessage('metrics-message', data.error || 'Failed', 'error');
        }
      } catch (err) {
        showMessage('metrics-message', err.message, 'error');
      } finally {
        btnReset(btnMetricsSave);
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
  loadIp2locationSettings();
  loadAutobackupSettings();
  loadAutobackupFiles();
  loadMetricsSettings();
  setInterval(loadLockedAccounts, 30000);
})();

// ─── License Tab ─────────────────────────────────
(function () {
  var licenseForm = document.getElementById('license-form');
  var refreshBtn = document.getElementById('license-refresh-btn');
  var removeBtn = document.getElementById('license-remove-btn');
  var t = window.GC && window.GC.t || {};

  if (licenseForm) {
    licenseForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        var data = await api.post('/api/v1/license/activate', {
          license_key: licenseForm.querySelector('[name="license_key"]').value,
          signing_key: licenseForm.querySelector('[name="signing_key"]').value,
        });
        if (data.ok) {
          showToast(t['license.activated'] || 'License activated');
          setTimeout(function () { location.reload(); }, 1000);
        } else {
          showToast(data.error || 'Activation failed', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      try {
        var data = await api.post('/api/v1/license/refresh', {});
        if (data.ok) {
          showToast(t['license.refresh_success'] || 'License refreshed');
          setTimeout(function () { location.reload(); }, 1000);
        } else {
          showToast(data.error || 'Refresh failed', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', async function () {
      if (!confirm(t['license.remove_confirm'] || 'Remove license?')) return;
      try {
        var data = await api.del('/api/v1/license');
        if (data.ok) {
          showToast(t['license.removed'] || 'License removed');
          setTimeout(function () { location.reload(); }, 1000);
        } else {
          showToast(data.error || 'Remove failed', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      }
    });
  }
})();

// ─── DNS Settings ─────────────────────────────
(function () {
  var dnsInput = document.getElementById('settings-dns-input');
  var dnsSaveBtn = document.getElementById('btn-dns-save');

  if (dnsInput) {
    api.get('/api/v1/settings/dns').then(function(data) {
      if (data.ok) dnsInput.value = data.data.dns || '';
    }).catch(function() {});
  }

  if (dnsSaveBtn) {
    dnsSaveBtn.addEventListener('click', async function() {
      var btn = this;
      btnLoading(btn);
      try {
        var data = await api.put('/api/v1/settings/dns', { dns: dnsInput.value.trim() });
        if (data.ok) {
          showToast(GC.t['settings.dns_saved'] || 'DNS settings saved');
        } else {
          showToast(data.error || 'Error', 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      } finally {
        btnReset(btn);
      }
    });
  }
})();


// ── Machine Binding Settings ──────────────────────────
(async function () {
  var modeSelect = document.getElementById('mb-mode');
  var saveBtn = document.getElementById('mb-save');
  var msg = document.getElementById('mb-msg');
  if (!modeSelect) return;

  try {
    var res = await api.get('/api/v1/settings/machine-binding');
    if (res.ok) modeSelect.value = res.data.mode;
  } catch {}

  saveBtn.addEventListener('click', async function () {
    try {
      await api.put('/api/v1/settings/machine-binding', { mode: modeSelect.value });
      msg.textContent = GC.t['security.machine_binding.saved'] || 'Saved';
      msg.style.color = 'var(--success)';
      setTimeout(function () { msg.textContent = ''; }, 3000);
    } catch (err) {
      msg.style.color = 'var(--danger)';
      msg.textContent = err.message || 'Error';
    }
  });
})();

// ─── Service Management (WireGuard + Caddy) ────────────
(function () {
  // ── WG Restart ──
  var btnRestart = document.getElementById('btn-svc-wg-restart');
  if (btnRestart) {
    btnRestart.addEventListener('click', async function () {
      if (!confirm(GC.t['config.restart'] + ' WireGuard?')) return;
      btnLoading(btnRestart);
      try {
        var data = await api.post('/api/wg/restart');
        if (!data.success) alert('Failed to restart WireGuard');
      } catch (err) {
        alert(err.message || 'Error');
      } finally {
        btnReset(btnRestart);
      }
    });
  }

  // ── WG Stop (with password modal) ──
  var btnStop = document.getElementById('btn-svc-wg-stop');
  var modal = document.getElementById('wg-stop-modal');
  var pwdInput = document.getElementById('wg-stop-password');
  var errDiv = document.getElementById('wg-stop-error');
  var btnCancel = document.getElementById('wg-stop-cancel');
  var btnConfirm = document.getElementById('wg-stop-confirm');

  function openModal() {
    if (!modal) return;
    modal.style.display = 'flex';
    pwdInput.value = '';
    errDiv.style.display = 'none';
    setTimeout(function () { pwdInput.focus(); }, 100);
  }

  function closeModal() {
    if (!modal) return;
    modal.style.display = 'none';
    pwdInput.value = '';
    errDiv.style.display = 'none';
  }

  if (btnStop) btnStop.addEventListener('click', openModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
  }

  if (pwdInput) {
    pwdInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') btnConfirm.click();
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async function () {
      var password = pwdInput.value.trim();
      if (!password) {
        errDiv.textContent = GC.t['error.wireguard.password_required'] || 'Password required';
        errDiv.style.display = 'block';
        return;
      }
      btnLoading(btnConfirm);
      try {
        await api.post('/api/wg/stop', { password: password });
        closeModal();
      } catch (err) {
        errDiv.textContent = err.message || 'Error';
        errDiv.style.display = 'block';
      } finally {
        btnReset(btnConfirm);
      }
    });
  }

  // ── Caddy Status ──
  var caddyStatus = document.getElementById('svc-caddy-status');
  var caddyInfo = document.getElementById('svc-caddy-info');

  function setCaddyState(color, text) {
    if (!caddyStatus) return;
    caddyStatus.textContent = '';
    var dot = document.createElement('div');
    if (color === 'green') {
      dot.className = 'pulse-dot';
    } else {
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--' + color + ')';
    }
    var label = document.createElement('span');
    label.style.cssText = 'font-size:13px;color:var(--' + color + ');font-weight:600';
    label.textContent = text;
    caddyStatus.appendChild(dot);
    caddyStatus.appendChild(label);
  }

  async function loadCaddyStatus() {
    if (!caddyStatus) return;
    try {
      var data = await api.get('/api/caddy/status');
      if (data.running) {
        setCaddyState('green', GC.t['config.caddy_running'] || 'Caddy running');
        var parts = [];
        if (data.httpRoutes) parts.push(data.httpRoutes + ' HTTP');
        if (data.l4Routes) parts.push(data.l4Routes + ' L4');
        caddyInfo.textContent = (parts.length ? parts.join(' \u00b7 ') + ' routes \u00b7 ' : '') + 'HTTPS \u00b7 Let\'s Encrypt';
      } else {
        setCaddyState('red', GC.t['config.caddy_stopped'] || 'Caddy stopped');
        caddyInfo.textContent = '';
      }
    } catch {
      setCaddyState('amber', 'Unknown');
      caddyInfo.textContent = '';
    }
  }

  // ── Caddy Reload ──
  var btnReload = document.getElementById('btn-svc-caddy-reload');
  if (btnReload) {
    btnReload.addEventListener('click', async function () {
      btnLoading(btnReload);
      try {
        var data = await api.post('/api/caddy/reload');
        if (data.success) loadCaddyStatus();
        else alert('Failed to reload Caddy');
      } catch (err) {
        alert(err.message || 'Error');
      } finally {
        btnReset(btnReload);
      }
    });
  }

  loadCaddyStatus();
})();
