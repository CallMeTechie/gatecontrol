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
        hint.textContent = (window.GC.t || {})['settings.smtp.password_set'] || 'Password is set';
        hint.style.display = '';
      }
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('smtp');
    }
  }).catch(function(err) {
    console.error('Failed to load SMTP settings:', err);
  });

  // TLS toggle
  var smtpTlsToggle = document.getElementById('smtp-tls');
  if (smtpTlsToggle) {
    smtpTlsToggle.addEventListener('click', function() {
      smtpTlsToggle.classList.toggle('on');
      smtpTlsToggle.dispatchEvent(new Event('change'));
    });
  }

  // SMTP autosave
  var Core = window.SettingsAutosaveCore;
  function smtpValues() {
    var hostEl = document.getElementById('smtp-host');
    var portEl = document.getElementById('smtp-port');
    var userEl = document.getElementById('smtp-user');
    var fromEl = document.getElementById('smtp-from');
    var tlsEl = document.getElementById('smtp-tls');
    var pwEl = document.getElementById('smtp-password');
    return {
      'smtp-host': hostEl ? hostEl.value : '',
      'smtp-port': portEl ? portEl.value : '',
      'smtp-user': userEl ? userEl.value : '',
      'smtp-from': fromEl ? fromEl.value : '',
      'smtp-tls': tlsEl ? tlsEl.classList.contains('on') : false,
      'smtp-password': pwEl ? pwEl.value : '',
    };
  }
  function smtpSave() {
    var payload = {
      host: document.getElementById('smtp-host').value,
      port: document.getElementById('smtp-port').value,
      user: document.getElementById('smtp-user').value,
      from: document.getElementById('smtp-from').value,
      secure: document.getElementById('smtp-tls').classList.contains('on'),
    };
    var pw = document.getElementById('smtp-password').value;
    if (pw) payload.password = pw;
    payload = Core.stripEmptySecrets(payload, ['password']);
    return api.put('/api/smtp/settings', payload).then(function (res) {
      if (res && res.ok && pw) {
        var hint = document.getElementById('smtp-password-hint');
        if (hint) { hint.textContent = (window.GC.t || {})['settings.smtp.password_set'] || 'Password is set'; hint.style.display = ''; }
      }
      return res;
    });
  }
  (function () {
    var smtpFields = ['smtp-host', 'smtp-port', 'smtp-user', 'smtp-from', 'smtp-tls', 'smtp-password']
      .map(function (i) { return document.getElementById(i); }).filter(Boolean);
    if (smtpFields.length) {
      SettingsAutosave.bind({
        cluster: 'smtp',
        fields: smtpFields,
        statusEl: document.getElementById('smtp-status'),
        valuesById: smtpValues,
        save: smtpSave,
      });
    }
  })();
  // SMTP password clear
  var smtpClear = document.getElementById('smtp-password-clear');
  if (smtpClear) {
    smtpClear.addEventListener('click', function () {
      if (!window.confirm((window.GC.t || {})['settings.autosave.clear_secret_confirm'] || 'Remove the stored value?')) return;
      SettingsAutosave.enqueue('smtp', function () {
        return api.put('/api/smtp/settings', {
          host: document.getElementById('smtp-host').value,
          port: document.getElementById('smtp-port').value,
          from: document.getElementById('smtp-from').value,
          clear_password: true,
        });
      });
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
    if (!el) return;
    el.addEventListener('click', function () {
      el.classList.toggle('on');
      el.dispatchEvent(new Event('change'));    // <-- enables autosave on toggles
    });
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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('security');
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

  // ─── Security Autosave (single bind over all 8 fields) ───
  (function () {
    var g = function (id) { return document.getElementById(id); };
    function securityValues() {
      return {
        'security-lockout-enabled': g('security-lockout-enabled') ? g('security-lockout-enabled').classList.contains('on') : false,
        'security-lockout-attempts': g('security-lockout-attempts') ? g('security-lockout-attempts').value : '',
        'security-lockout-duration': g('security-lockout-duration') ? g('security-lockout-duration').value : '',
        'security-password-enabled': g('security-password-enabled') ? g('security-password-enabled').classList.contains('on') : false,
        'security-password-min-length': g('security-password-min-length') ? g('security-password-min-length').value : '',
        'security-password-uppercase': g('security-password-uppercase') ? g('security-password-uppercase').classList.contains('on') : false,
        'security-password-number': g('security-password-number') ? g('security-password-number').classList.contains('on') : false,
        'security-password-special': g('security-password-special') ? g('security-password-special').classList.contains('on') : false,
      };
    }
    function securitySave() {
      var v = securityValues();
      return api.put('/api/settings/security', {
        lockout: {
          enabled: v['security-lockout-enabled'],
          max_attempts: v['security-lockout-attempts'],
          duration: v['security-lockout-duration'],
        },
        password: {
          complexity_enabled: v['security-password-enabled'],
          min_length: v['security-password-min-length'],
          require_uppercase: v['security-password-uppercase'],
          require_number: v['security-password-number'],
          require_special: v['security-password-special'],
        },
      });
    }
    var securityFieldIds = [
      'security-lockout-enabled', 'security-lockout-attempts', 'security-lockout-duration',
      'security-password-enabled', 'security-password-min-length', 'security-password-uppercase',
      'security-password-number', 'security-password-special',
    ];
    var securityFields = securityFieldIds.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    if (securityFields.length) {
      SettingsAutosave.bind({
        cluster: 'security',
        fields: securityFields,
        statusEl: document.getElementById('security-status'),
        valuesById: securityValues,
        save: securitySave,
      });
    }
  })();

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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('data');
    } catch (err) {
      console.error('Failed to load data settings:', err);
    }
  }

  (function () {
    var trafficDays = document.getElementById('data-traffic-days');
    var activityDays = document.getElementById('data-activity-days');
    var peerTimeout = document.getElementById('data-peer-timeout');
    var dataStatus = document.getElementById('data-status');
    var dataFields = [trafficDays, activityDays, peerTimeout].filter(Boolean);
    if (dataFields.length) {
      SettingsAutosave.bind({
        cluster: 'data',
        fields: dataFields,
        statusEl: dataStatus,
        valuesById: function () {
          return {
            'data-traffic-days': trafficDays ? trafficDays.value : '',
            'data-activity-days': activityDays ? activityDays.value : '',
            'data-peer-timeout': peerTimeout ? peerTimeout.value : '',
          };
        },
        save: function () {
          return api.put('/api/settings/data', {
            retention_traffic_days: trafficDays ? trafficDays.value : '',
            retention_activity_days: activityDays ? activityDays.value : '',
            peer_online_timeout: peerTimeout ? peerTimeout.value : '',
          });
        },
      });
    }
  })();

  // ─── Monitoring Settings ───────────────────────────────

  var monEmailToggle = document.getElementById('monitoring-email-alerts');
  if (monEmailToggle) monEmailToggle.addEventListener('click', function() {
    monEmailToggle.classList.toggle('on');
    monEmailToggle.dispatchEvent(new Event('change'));
  });

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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('monitoring');
    } catch (err) {
      console.error('Failed to load monitoring settings:', err);
    }
  }

  (function () {
    var intervalEl = document.getElementById('monitoring-interval');
    var alertEmailEl = document.getElementById('monitoring-alert-email');
    var monFields = [intervalEl, monEmailToggle, alertEmailEl].filter(Boolean);
    if (monFields.length) {
      SettingsAutosave.bind({
        cluster: 'monitoring',
        fields: monFields,
        statusEl: document.getElementById('monitoring-status'),
        valuesById: function () {
          return {
            'monitoring-interval': intervalEl ? intervalEl.value : '',
            'monitoring-email-alerts': monEmailToggle ? monEmailToggle.classList.contains('on') : false,
            'monitoring-alert-email': alertEmailEl ? alertEmailEl.value : '',
          };
        },
        save: function () {
          return api.put('/api/settings/monitoring', {
            interval: intervalEl ? intervalEl.value : '',
            email_alerts: monEmailToggle ? monEmailToggle.classList.contains('on') : false,
            alert_email: alertEmailEl ? alertEmailEl.value : '',
          });
        },
      });
    }
  })();

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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('alerts');
    } catch (err) {
      console.error('Failed to load alert settings:', err);
    }
  }

  // Alerts autosave
  function alertsEventsActive() { return !!document.querySelector('.alert-event-group:checked'); }
  (function () {
    var alertsEmail = document.getElementById('alerts-email');
    var alertsBackupDays = document.getElementById('alerts-backup-days');
    var alertsCpu = document.getElementById('alerts-cpu');
    var alertsRam = document.getElementById('alerts-ram');
    var alertsEventGroups = Array.from(document.querySelectorAll('.alert-event-group'));
    var alertsFields = [alertsEmail].concat(alertsEventGroups).concat([alertsBackupDays, alertsCpu, alertsRam]).filter(Boolean);
    if (alertsFields.length) {
      SettingsAutosave.bind({
        cluster: 'alerts',
        fields: alertsFields,
        statusEl: document.getElementById('alerts-status'),
        valuesById: function () {
          var vals = {
            'alerts-email': alertsEmail ? alertsEmail.value : '',
            'alerts-backup-days': alertsBackupDays ? alertsBackupDays.value : '',
            'alerts-cpu': alertsCpu ? alertsCpu.value : '',
            'alerts-ram': alertsRam ? alertsRam.value : '',
          };
          alertsEventGroups.forEach(function(cb) { if (cb.id) vals[cb.id] = cb.checked; });
          return vals;
        },
        requiredForCommit: function () { return alertsEventsActive() ? ['alerts-email'] : []; },
        save: function () {
          var events = [];
          document.querySelectorAll('.alert-event-group:checked').forEach(function (cb) {
            cb.dataset.events.split(',').forEach(function (e) { if (events.indexOf(e) === -1) events.push(e); });
          });
          return api.put('/api/settings/alerts', {
            email: alertsEmail ? alertsEmail.value : '',
            email_events: events.join(','),
            backup_reminder_days: alertsBackupDays ? alertsBackupDays.value : '',
            resource_cpu_threshold: alertsCpu ? alertsCpu.value : '',
            resource_ram_threshold: alertsRam ? alertsRam.value : '',
          });
        },
      });
    }
  })();

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

  // ip2location clear
  var ip2lClear = document.getElementById('ip2location-clear');
  if (ip2lClear) {
    ip2lClear.addEventListener('click', function () {
      if (!window.confirm((window.GC.t || {})['settings.autosave.clear_secret_confirm'] || 'Remove the stored value?')) return;
      SettingsAutosave.enqueue('ip2location', function () {
        return api.put('/api/v1/settings/ip2location', { api_key: '', clear: true });
      });
      var keyEl = document.getElementById('ip2location-key');
      if (keyEl) keyEl.value = '';
    });
  }

  // ─── Auto-Backup Settings ──────────────────────────────

  var autobackupEnabledToggle = document.getElementById('autobackup-enabled');
  if (autobackupEnabledToggle) {
    autobackupEnabledToggle.addEventListener('click', function() {
      autobackupEnabledToggle.classList.toggle('on');
      autobackupEnabledToggle.dispatchEvent(new Event('change'));
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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('autobackup');
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

  // ─── Autobackup Autosave ───────────────────────────────
  (function () {
    var scheduleEl = document.getElementById('autobackup-schedule');
    var retentionEl = document.getElementById('autobackup-retention');
    var abFields = [autobackupEnabledToggle, scheduleEl, retentionEl].filter(Boolean);
    if (abFields.length) {
      SettingsAutosave.bind({
        cluster: 'autobackup',
        fields: abFields,
        statusEl: document.getElementById('autobackup-status'),
        valuesById: function () {
          return {
            'autobackup-enabled': autobackupEnabledToggle ? autobackupEnabledToggle.classList.contains('on') : false,
            'autobackup-schedule': scheduleEl ? scheduleEl.value : '',
            'autobackup-retention': retentionEl ? retentionEl.value : '',
          };
        },
        save: function () {
          return api.put('/api/settings/autobackup', {
            enabled: autobackupEnabledToggle ? autobackupEnabledToggle.classList.contains('on') : false,
            schedule: scheduleEl ? scheduleEl.value : '',
            retention: retentionEl ? retentionEl.value : '',
          });
        },
      });
    }
  })();

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
      metricsEnabledToggle.dispatchEvent(new Event('change'));
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
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('metrics');
    } catch (err) {
      console.error('Failed to load metrics settings:', err);
    }
  }

  var metricsStatus = document.getElementById('metrics-status');
  if (metricsEnabledToggle) {
    SettingsAutosave.bind({
      cluster: 'metrics',
      fields: [metricsEnabledToggle],
      statusEl: metricsStatus,
      valuesById: function () { return { 'metrics-enabled': metricsEnabledToggle.classList.contains('on') }; },
      save: function () { return api.put('/api/settings/metrics', { enabled: metricsEnabledToggle.classList.contains('on') }); },
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

  if (dnsInput) {
    api.get('/api/v1/settings/dns').then(function(data) {
      if (data.ok) {
        dnsInput.value = data.data.dns || '';
        if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('dns');
      }
    }).catch(function() {});

    SettingsAutosave.bind({
      cluster: 'dns',
      fields: [dnsInput],
      statusEl: document.getElementById('dns-status'),
      valuesById: function () { return { 'settings-dns-input': dnsInput.value.trim() }; },
      save: function () { return api.put('/api/v1/settings/dns', { dns: dnsInput.value.trim() }); },
    });
  }
})();

// ─── Auto-Update Mode ─────────────────────────────────
(function initAutoUpdateMode() {
  var card = document.getElementById('card-autoupdate');
  if (!card) return;
  window.api.get('/api/system/auto-update').then(function (d) {
    var el = card.querySelector('input[name="au-mode"][value="' + ((d && d.mode) || 'auto') + '"]');
    if (el) el.checked = true;
    if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('auto-update');
  }).catch(function () {});
  var auRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="au-mode"]'));
  if (auRadios.length) {
    function auVal() { var c = document.querySelector('input[name="au-mode"]:checked'); return c ? c.value : ''; }
    SettingsAutosave.bind({
      cluster: 'auto-update',
      fields: auRadios,
      statusEl: document.getElementById('au-mode-status'),
      valuesById: function () { return { 'au-mode': auVal() }; },
      save: function () { return api.put('/api/system/auto-update', { mode: auVal() }); },
    });
  }
})();


// ── Machine Binding Settings ──────────────────────────
(async function () {
  var modeSelect = document.getElementById('mb-mode');
  var statusEl = document.getElementById('machine-binding-status');
  if (!modeSelect) return;

  try {
    var res = await api.get('/api/v1/settings/machine-binding');
    if (res.ok) modeSelect.value = res.data.mode;
  } catch {}

  SettingsAutosave.bind({
    cluster: 'machine-binding',
    fields: [modeSelect],
    statusEl: statusEl,
    valuesById: function () { return { 'mb-mode': modeSelect.value }; },
    save: function () { return api.put('/api/v1/settings/machine-binding', { mode: modeSelect.value }); },
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

// Split-Tunnel Preset
(function () {
  var modeSelect = document.getElementById('st-mode');
  var networksSection = document.getElementById('st-networks-section');
  var privateNets = document.getElementById('st-private-nets');
  var linkLocal = document.getElementById('st-link-local');
  var lockedCb = document.getElementById('st-locked');
  var customList = document.getElementById('st-custom-list');
  if (!modeSelect) return;

  // 10.0.0.0/8 intentionally excluded — the WireGuard VPN subnet (10.8.0.0/24)
  // lives there. Users who need it can add it as a custom network.
  var PRIVATE_CIDRS = [
    { cidr: '172.16.0.0/12', label: 'Private 172.x' },
    { cidr: '192.168.0.0/16', label: 'Private 192.x' },
  ];
  var LINK_LOCAL = { cidr: '169.254.0.0/16', label: 'Link-Local' };
  var customNets = [];

  modeSelect.addEventListener('change', function () {
    networksSection.style.display = modeSelect.value === 'off' ? 'none' : '';
  });

  function renderCustom() {
    customList.textContent = '';
    customNets.forEach(function (n, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
      var lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:12px;min-width:100px';
      lbl.textContent = n.label || '';
      row.appendChild(lbl);
      var cidr = document.createElement('code');
      cidr.style.cssText = 'font-size:12px;color:var(--text-2)';
      cidr.textContent = n.cidr;
      row.appendChild(cidr);
      var del = document.createElement('button');
      del.className = 'icon-btn';
      del.style.cssText = 'color:var(--red);margin-left:auto';
      del.textContent = '\u2715';
      del.addEventListener('click', function () { customNets.splice(i, 1); renderCustom(); SettingsAutosave.enqueue('split-tunnel', stSave); });
      row.appendChild(del);
      customList.appendChild(row);
    });
  }

  document.getElementById('st-add-network').addEventListener('click', function () {
    var label = prompt(GC.t['settings.split_tunnel_label_prompt'] || 'Label:');
    if (!label) return;
    var cidr = prompt(GC.t['settings.split_tunnel_cidr_prompt'] || 'CIDR (e.g. 172.20.0.0/16):');
    if (!cidr) return;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr)) {
      alert('Invalid CIDR format');
      return;
    }
    customNets.push({ label: label, cidr: cidr });
    renderCustom();
    SettingsAutosave.enqueue('split-tunnel', stSave);
  });

  async function loadST() {
    try {
      var data = await api.get('/api/v1/settings/split-tunnel');
      if (!data.ok) return;
      modeSelect.value = data.mode || 'off';
      networksSection.style.display = modeSelect.value === 'off' ? 'none' : '';
      lockedCb.checked = !!data.locked;
      var nets = data.networks || [];
      var pCidrs = PRIVATE_CIDRS.map(function (p) { return p.cidr; });
      privateNets.checked = nets.some(function (n) { return pCidrs.indexOf(n.cidr) >= 0; });
      linkLocal.checked = nets.some(function (n) { return n.cidr === LINK_LOCAL.cidr; });
      customNets = nets.filter(function (n) { return pCidrs.indexOf(n.cidr) < 0 && n.cidr !== LINK_LOCAL.cidr; });
      renderCustom();
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('split-tunnel');
    } catch {}
  }

  function stSave() {
    var networks = customNets.slice();
    if (privateNets && privateNets.checked) networks = PRIVATE_CIDRS.concat(networks);
    if (linkLocal && linkLocal.checked) networks.push(LINK_LOCAL);
    return api.put('/api/v1/settings/split-tunnel', { mode: modeSelect.value, networks: networks, locked: lockedCb ? lockedCb.checked : false });
  }

  SettingsAutosave.bind({
    cluster: 'split-tunnel',
    fields: [modeSelect, privateNets, linkLocal, lockedCb].filter(Boolean),
    statusEl: document.getElementById('st-status'),
    valuesById: function () {
      return {
        'st-mode': modeSelect ? modeSelect.value : 'off',
        'st-private-nets': privateNets ? privateNets.checked : false,
        'st-link-local': linkLocal ? linkLocal.checked : false,
        'st-locked': lockedCb ? lockedCb.checked : false,
      };
    },
    save: stSave,
  });

  loadST();
})();

// ─── Default Theme Switcher ─────────────────────────────
(function () {
  var container = document.getElementById('default-theme-buttons');
  if (!container) return;
  var statusEl = document.getElementById('default-theme-status');
  function flash() {
    if (!statusEl) return;
    statusEl.classList.remove('autosave-error');
    statusEl.classList.add('field-saving');
    statusEl.textContent = (window.GC && GC.t && GC.t['settings.autosave.saved']) || 'Saved';
    setTimeout(function () { statusEl.classList.remove('field-saving'); }, 500);
  }
  container.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-default-theme]');
    if (!btn) return;
    var selected = btn.dataset.defaultTheme;
    try {
      var data = await api.put('/api/v1/settings/default-theme', { theme: selected });
      if (data.ok) {
        container.querySelectorAll('[data-default-theme]').forEach(function (b) {
          b.className = b.dataset.defaultTheme === selected ? 'btn btn-primary' : 'btn btn-ghost';
        });
        flash();
        // Reload page to apply the new theme (templates are server-rendered)
        setTimeout(function () { window.location.reload(); }, 300);
      }
    } catch (err) {
      alert(err.message || 'Failed to save');
    }
  });
})();

(function () {
  var sliderEl = document.getElementById('gw-down-threshold');
  var sliderOut = document.getElementById('gw-down-threshold-value');
  if (sliderEl && sliderOut) {
    sliderEl.addEventListener('input', function () { sliderOut.textContent = sliderEl.value + ' s'; });
    SettingsAutosave.bind({
      cluster: 'gateway-failover',
      fields: [sliderEl],
      statusEl: document.getElementById('gw-failover-status'),
      valuesById: function () { return { 'gw-down-threshold': sliderEl.value }; },
      save: function () { return api.put('/api/v1/settings/gateway-failover', { gateway_down_threshold_s: parseInt(sliderEl.value, 10) }); },
    });
  }
})();

// ─── Pi-hole Settings ─────────────────────────────────
(function () {
  var phInstances = [];
  var editingIndex = -1;
  var t = window.GC && window.GC.t || {};

  var addBtn = document.getElementById('btn-pihole-add-instance');
  var instancesList = document.getElementById('pihole-instances-list');
  var instanceForm = document.getElementById('pihole-instance-form');
  if (!addBtn && !instancesList) return;

  async function loadPihole() {
    try {
      var data = await api.get('/api/v1/settings/pihole');
      if (!data.ok) return;
      var cfg = data.data;
      var enabledEl = document.getElementById('pihole-enabled');
      var chainEl = document.getElementById('pihole-manage-chain');
      var intervalEl = document.getElementById('pihole-sync-interval');
      if (enabledEl) enabledEl.classList.toggle('on', !!cfg.enabled);
      if (chainEl) chainEl.classList.toggle('on', !!cfg.manage_dns_chain);
      if (intervalEl) intervalEl.value = cfg.sync_interval_sec || 30;
      var countEl = document.getElementById('pihole-top-clients-count'); if (countEl) countEl.value = cfg.top_clients_count || 1000;
      phInstances = (cfg.instances || []).slice();
      renderInstances();
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('pihole');
    } catch (err) {
      console.error('Failed to load Pi-hole settings:', err);
    }
  }

  function renderInstances() {
    if (!instancesList) return;
    instancesList.textContent = '';
    if (phInstances.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);padding:8px 0';
      empty.textContent = t['pihole.cfg.no_instances'] || 'No instances configured';
      instancesList.appendChild(empty);
      return;
    }
    phInstances.forEach(function (inst, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      var labelEl = document.createElement('div');
      labelEl.style.cssText = 'font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      labelEl.textContent = inst.label || inst.url;
      info.appendChild(labelEl);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:2px';
      var parts = [inst.url];
      if (inst.dns_ip) parts.push('DNS: ' + inst.dns_ip);
      parts.push(inst.password_set ? (t['pihole.cfg.password_set'] || 'set') : (t['pihole.cfg.no_password'] || '—'));
      parts.push(inst.verify_tls !== false ? 'TLS ✓' : 'TLS ✗');
      meta.textContent = parts.join(' · ');
      info.appendChild(meta);
      row.appendChild(info);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0';
      var svgPaths = {
        edit: '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        test: '<polygon points="5 3 19 12 5 21 5 3"/>',
        delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
      };
      ['edit', 'test', 'delete'].forEach(function (action) {
        var btn = document.createElement('button');
        btn.className = 'icon-btn';
        btn.title = action.charAt(0).toUpperCase() + action.slice(1);
        btn.dataset.phAction = action;
        btn.dataset.phIdx = idx;
        btn.style.cssText = 'width:24px;height:24px';
        // Safe: only hardcoded SVG paths, no user input
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' + svgPaths[action] + '</svg>';
        actions.appendChild(btn);
      });
      row.appendChild(actions);
      instancesList.appendChild(row);
    });
  }

  function showInstanceForm(inst) {
    if (!instanceForm) return;
    document.getElementById('ph-inst-label').value = inst ? (inst.label || '') : '';
    document.getElementById('ph-inst-url').value = inst ? (inst.url || '') : '';
    document.getElementById('ph-inst-dns').value = inst ? (inst.dns_ip || '') : '';
    var dnsPortEl = document.getElementById('ph-inst-dns-port');
    if (dnsPortEl) dnsPortEl.value = inst ? (inst.dns_port || 53) : 53;
    document.getElementById('ph-inst-password').value = '';
    var tlsEl = document.getElementById('ph-inst-tls');
    if (tlsEl) tlsEl.classList.toggle('on', inst ? inst.verify_tls !== false : true);
    var hint = document.getElementById('ph-inst-password-hint');
    if (hint) hint.style.display = (inst && inst.password_set) ? '' : 'none';
    instanceForm.style.display = 'flex';
  }

  // Prefill dns_ip from the url host when dns_ip is empty
  var urlInput = document.getElementById('ph-inst-url');
  if (urlInput) {
    urlInput.addEventListener('blur', function () {
      var dnsEl = document.getElementById('ph-inst-dns');
      if (dnsEl && !dnsEl.value.trim() && this.value.trim()) {
        try {
          var hostname = new URL(this.value.trim()).hostname;
          if (hostname) dnsEl.value = hostname;
        } catch (e) {}
      }
    });
  }

  function hideInstanceForm() {
    if (instanceForm) instanceForm.style.display = 'none';
    editingIndex = -1;
  }

  if (instancesList) {
    instancesList.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-ph-action]');
      if (!btn) return;
      var action = btn.dataset.phAction;
      var idx = parseInt(btn.dataset.phIdx, 10);
      var inst = phInstances[idx];
      if (!inst) return;

      if (action === 'delete') {
        if (!confirm(t['pihole.cfg.confirm_delete'] || 'Delete this instance?')) return;
        phInstances.splice(idx, 1);
        renderInstances();
        await SettingsAutosave.enqueue('pihole', function () { return savePihole(false); });
      } else if (action === 'edit') {
        editingIndex = idx;
        showInstanceForm(inst);
      } else if (action === 'test') {
        btnLoading(btn);
        try {
          var res = await api.post('/api/v1/settings/pihole/test/' + encodeURIComponent(inst.id));
          if (res.ok && res.data && res.data.connected) {
            showToast(buildPiholeTestToast(res.data, inst.dns_port || 53));
          } else {
            showToast(res.error || (t['pihole.cfg.test_failed'] || 'Connection failed'), 'error');
          }
        } catch (err) {
          showToast(err.message || 'Error', 'error');
        } finally {
          btnReset(btn);
        }
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      editingIndex = -1;
      showInstanceForm(null);
    });
  }

  var cancelBtn = document.getElementById('btn-pihole-cancel-instance');
  if (cancelBtn) cancelBtn.addEventListener('click', hideInstanceForm);

  var applyBtn = document.getElementById('btn-pihole-apply-instance');
  if (applyBtn) {
    applyBtn.addEventListener('click', async function () {
      var label = document.getElementById('ph-inst-label').value.trim();
      var url = document.getElementById('ph-inst-url').value.trim();
      var dns_ip = document.getElementById('ph-inst-dns').value.trim();
      var dnsPortEl = document.getElementById('ph-inst-dns-port');
      var dns_port = dnsPortEl ? (parseInt(dnsPortEl.value, 10) || 53) : 53;
      var app_password = document.getElementById('ph-inst-password').value;
      var tlsEl = document.getElementById('ph-inst-tls');
      var verify_tls = tlsEl ? tlsEl.classList.contains('on') : true;

      if (!url) { showToast(t['pihole.cfg.url_required'] || 'URL required', 'error'); return; }

      if (editingIndex >= 0) {
        var existing = phInstances[editingIndex];
        existing.label = label;
        existing.url = url;
        existing.dns_ip = dns_ip;
        existing.dns_port = dns_port;
        existing.verify_tls = verify_tls;
        if (app_password) {
          existing.app_password = app_password;
          existing.password_set = true;
        }
      } else {
        var newInst = {
          id: Date.now().toString(),
          label: label,
          url: url,
          dns_ip: dns_ip,
          dns_port: dns_port,
          verify_tls: verify_tls,
          password_set: !!app_password,
        };
        if (app_password) newInst.app_password = app_password;
        phInstances.push(newInst);
      }
      renderInstances();
      hideInstanceForm();
      try {
        await SettingsAutosave.enqueue('pihole', function () { return savePihole(false); });
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      }
    });
  }

  var testFormBtn = document.getElementById('btn-pihole-test-instance');
  if (testFormBtn) {
    testFormBtn.addEventListener('click', async function () {
      var url = document.getElementById('ph-inst-url').value.trim();
      var dns_ip_test = document.getElementById('ph-inst-dns').value.trim();
      var dnsPortTestEl = document.getElementById('ph-inst-dns-port');
      var dns_port_test = dnsPortTestEl ? (parseInt(dnsPortTestEl.value, 10) || 53) : 53;
      var app_password = document.getElementById('ph-inst-password').value || null;
      var tlsEl = document.getElementById('ph-inst-tls');
      var verify_tls = tlsEl ? tlsEl.classList.contains('on') : true;
      if (!url) { showToast(t['pihole.cfg.url_required'] || 'URL required', 'error'); return; }
      btnLoading(testFormBtn);
      try {
        var res = await api.post('/api/v1/settings/pihole/test', { url: url, app_password: app_password, verify_tls: verify_tls, dns_ip: dns_ip_test, dns_port: dns_port_test });
        if (res.ok && res.data && res.data.connected) {
          showToast(buildPiholeTestToast(res.data, dns_port_test));
        } else {
          showToast(res.error || (t['pihole.cfg.test_failed'] || 'Connection failed'), 'error');
        }
      } catch (err) {
        showToast(err.message || 'Error', 'error');
      } finally {
        btnReset(testFormBtn);
      }
    });
  }

  function buildPiholeTestToast(data, dns_port) {
    var msg = (t['pihole.cfg.test_ok'] || 'Connected') + ' (v' + (data.version || '?') + ')';
    if (data.dns) {
      if (!data.dns.reachable) {
        msg += ' · DNS ' + (t['pihole.cfg.dns_not_reachable'] || 'not reachable on port') + ' ' + (dns_port || 53);
      } else {
        msg += ' · DNS ✓';
        if (data.dns.blocking === true) msg += ' · Blocking ✓';
        else if (data.dns.blocking === false) msg += ' · Blocking ✗';
      }
    }
    return msg;
  }

  var tlsFormToggle = document.getElementById('ph-inst-tls');
  if (tlsFormToggle) {
    tlsFormToggle.addEventListener('click', function () {
      tlsFormToggle.classList.toggle('on');
    });
  }

  var enabledToggle = document.getElementById('pihole-enabled');
  if (enabledToggle) {
    enabledToggle.addEventListener('click', function () {
      enabledToggle.classList.toggle('on');
      enabledToggle.dispatchEvent(new Event('change'));
    });
  }

  var chainToggle = document.getElementById('pihole-manage-chain');
  if (chainToggle) {
    chainToggle.addEventListener('click', function () {
      chainToggle.classList.toggle('on');
      chainToggle.dispatchEvent(new Event('change'));
    });
  }

  async function savePihole(showSavedToast) {
    var enabledEl = document.getElementById('pihole-enabled');
    var chainEl = document.getElementById('pihole-manage-chain');
    var intervalEl = document.getElementById('pihole-sync-interval');
    var countEl = document.getElementById('pihole-top-clients-count');
    var payload = {
      enabled: enabledEl ? enabledEl.classList.contains('on') : false,
      manage_dns_chain: chainEl ? chainEl.classList.contains('on') : false,
      sync_interval_sec: intervalEl ? (parseInt(intervalEl.value, 10) || 30) : 30,
      top_clients_count: countEl ? (parseInt(countEl.value, 10) || 1000) : 1000,
      instances: phInstances.map(function (inst) {
        var out = {
          id: inst.id,
          label: inst.label || '',
          url: inst.url,
          dns_ip: inst.dns_ip || '',
          dns_port: parseInt(inst.dns_port, 10) || 53,
          verify_tls: inst.verify_tls !== false,
          password_set: !!inst.password_set,
        };
        if (inst.app_password) out.app_password = inst.app_password;
        return out;
      }),
    };
    var res = await api.put('/api/v1/settings/pihole', payload);
    if (res.ok) {
      if (showSavedToast) showToast(t['pihole.cfg.saved'] || 'Pi-hole settings saved');
    } else {
      showToast(res.error || 'Error', 'error');
    }
  }

  var phIntervalEl = document.getElementById('pihole-sync-interval');
  var phCountEl = document.getElementById('pihole-top-clients-count');
  SettingsAutosave.bind({
    cluster: 'pihole',
    fields: [enabledToggle, chainToggle, phIntervalEl, phCountEl].filter(Boolean),
    statusEl: document.getElementById('pihole-status'),
    valuesById: function () {
      return {
        'pihole-enabled': enabledToggle ? enabledToggle.classList.contains('on') : false,
        'pihole-manage-chain': chainToggle ? chainToggle.classList.contains('on') : false,
        'pihole-sync-interval': phIntervalEl ? phIntervalEl.value : '30',
        'pihole-top-clients-count': phCountEl ? phCountEl.value : '1000',
      };
    },
    save: function () { return savePihole(false); },
  });

  loadPihole();
})();

// ─── Portal Settings ─────────────────────────────────
(function () {
  var enabledToggle = document.getElementById('portal-enabled');
  var widgetDevice = document.getElementById('portal-widget-device');
  var widgetTraffic = document.getElementById('portal-widget-traffic');
  var widgetServices = document.getElementById('portal-widget-services');
  var widgetPihole = document.getElementById('portal-widget-pihole');
  var trustToggle = document.getElementById('portal-trust-owner-mapping');
  if (!enabledToggle) return;

  [enabledToggle, widgetDevice, widgetTraffic, widgetServices, widgetPihole, trustToggle].forEach(function (el) {
    if (el) el.addEventListener('click', function () {
      el.classList.toggle('on');
      el.dispatchEvent(new Event('change'));
    });
  });

  function setToggle(el, val) {
    if (!el) return;
    if (val) el.classList.add('on'); else el.classList.remove('on');
  }

  api.get('/api/v1/settings/portal').then(function (data) {
    if (!data.ok) return;
    var d = data.data;
    setToggle(enabledToggle, d.enabled);
    setToggle(widgetDevice, d.widgets && d.widgets.device);
    setToggle(widgetTraffic, d.widgets && d.widgets.traffic);
    setToggle(widgetServices, d.widgets && d.widgets.services);
    setToggle(widgetPihole, d.widgets && d.widgets.pihole);
    setToggle(trustToggle, d.trustOwnerMapping);
    if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('portal');
  }).catch(function (err) {
    console.error('Failed to load portal settings:', err);
  });

  var portalFields = [enabledToggle, widgetDevice, widgetTraffic, widgetServices, widgetPihole, trustToggle].filter(Boolean);
  SettingsAutosave.bind({
    cluster: 'portal',
    fields: portalFields,
    statusEl: document.getElementById('portal-status'),
    valuesById: function () {
      return {
        'portal-enabled': enabledToggle.classList.contains('on'),
        'portal-widget-device': widgetDevice ? widgetDevice.classList.contains('on') : true,
        'portal-widget-traffic': widgetTraffic ? widgetTraffic.classList.contains('on') : true,
        'portal-widget-services': widgetServices ? widgetServices.classList.contains('on') : true,
        'portal-widget-pihole': widgetPihole ? widgetPihole.classList.contains('on') : true,
        'portal-trust-owner-mapping': trustToggle ? trustToggle.classList.contains('on') : false,
      };
    },
    save: function () {
      return api.put('/api/v1/settings/portal', {
        enabled: enabledToggle.classList.contains('on'),
        widgets: {
          device:   widgetDevice   ? widgetDevice.classList.contains('on')   : true,
          traffic:  widgetTraffic  ? widgetTraffic.classList.contains('on')  : true,
          services: widgetServices ? widgetServices.classList.contains('on') : true,
          pihole: widgetPihole ? widgetPihole.classList.contains('on') : true,
        },
        trust_owner_mapping: trustToggle ? trustToggle.classList.contains('on') : false,
      });
    },
  });
})();

// ─── Portal Address ───────────────────────────────────
(function () {
  var sel = document.getElementById('portal-base-domain');
  if (!sel) return;
  var prefix = document.getElementById('portal-prefix');
  var preview = document.getElementById('portal-effective-host');
  var errEl = document.getElementById('portal-host-error');
  var applyBtn = document.getElementById('portal-host-apply');
  var switchWarn = document.getElementById('portal-switch-warning');
  var noDomainsHint = document.getElementById('portal-no-domains-hint');
  var t = (window.GC && window.GC.t) || {};
  var currentHost = '';     // the live, persisted effective host (from initial GET)
  var internalHost = '';    // home.<gc.internal> for the "Internal (default)" preview
  var curBase = '';         // persisted base_domain (for confirm-cancel restore)
  var curPrefix = 'home';   // persisted prefix

  function effective() {
    var base = sel.value; var p = (prefix.value || '').trim();
    return base ? (p ? p + '.' + base : base) : internalHost;
  }
  function renderPreview() {
    preview.textContent = effective();
    prefix.disabled = !sel.value;
    // Show the switch warning ONLY when the selection differs from the live host
    // (no false alarm for an already-configured, stable host on page load).
    if (switchWarn) switchWarn.style.display = (effective() !== currentHost) ? '' : 'none';
  }

  // Populate verified domains + current selection.
  Promise.all([api.get('/api/v1/settings/domains'), api.get('/api/v1/settings/portal')]).then(function (r) {
    var verified = (r[0].data.domains || []).filter(function (d) { return d.status === 'verified'; });
    var cur = r[1].data;
    currentHost = cur.effectiveHost || '';
    internalHost = cur.internalHost || '';
    curBase = cur.base_domain || '';
    curPrefix = cur.prefix || 'home';
    sel.appendChild(new Option(t['settings.portal.internal_default'] || 'Internal (default)', ''));
    verified.forEach(function (d) { sel.appendChild(new Option(d.domain, d.domain)); });
    sel.value = curBase;
    prefix.value = curPrefix;
    // Empty state: no verified domains → only "Internal (default)" + a hint pointing to the registry.
    if (noDomainsHint) noDomainsHint.style.display = verified.length ? 'none' : '';
    renderPreview();
  }).catch(function () {});

  // Preview only — selecting/typing does NOT switch the live host.
  sel.addEventListener('change', renderPreview);
  prefix.addEventListener('input', renderPreview);

  // Deliberate, confirmed commit (NOT autosave): a host change causes a brief
  // portal outage (single-host switch window), so it stays an explicit action.
  if (applyBtn) applyBtn.addEventListener('click', async function () {
    if (errEl) { errEl.classList.remove('autosave-error'); errEl.textContent = ''; errEl.style.display = 'none'; }
    if (effective() === currentHost) return;     // no-op: nothing changed
    if (!window.confirm(t['settings.portal.switch_warning'] || 'The portal will be briefly unreachable while switching, and the previous name stops working. Continue?')) {
      // Cancel: restore the persisted selection so the warning clears and a stray re-Apply is avoided.
      sel.value = curBase; prefix.value = curPrefix; renderPreview();
      return;
    }
    btnLoading(applyBtn);
    try {
      var res = await api.put('/api/v1/settings/portal', { base_domain: sel.value, prefix: prefix.value });
      if (res && res.ok) { curBase = sel.value; curPrefix = prefix.value; currentHost = effective(); renderPreview(); showToast(t['settings.portal.saved'] || 'Saved'); }
      else if (errEl) { errEl.classList.add('autosave-error'); errEl.textContent = (res && res.error) || ''; errEl.style.display = ''; }
    } catch (err) {
      if (errEl) { errEl.classList.add('autosave-error'); errEl.textContent = err.message; errEl.style.display = ''; }
    } finally { btnReset(applyBtn); }
  });
})();

// ─── Route Block Default ──────────────────────────────
(function () {
  var actionSel = document.getElementById('settings-route-block-action');
  var bodyEl = document.getElementById('settings-route-block-body');
  var redirectEl = document.getElementById('settings-route-block-redirect');
  if (!actionSel) return;

  function syncSettingsBlockVisibility() {
    if (bodyEl) bodyEl.style.display = actionSel.value === 'custom' ? '' : 'none';
    if (redirectEl) redirectEl.style.display = actionSel.value === 'redirect' ? '' : 'none';
  }

  actionSel.addEventListener('change', syncSettingsBlockVisibility);

  api.get('/api/v1/settings/route-block-default').then(function (r) {
    if (r.ok && r.data) {
      actionSel.value = r.data.action || 'not_found';
      if (bodyEl) bodyEl.value = r.data.body || '';
      if (redirectEl) redirectEl.value = r.data.redirect_url || '';
      syncSettingsBlockVisibility();
      if (window.SettingsAutosave && SettingsAutosave.resync) SettingsAutosave.resync('route-block');
    }
  }).catch(function (err) {
    console.error('Failed to load route block default:', err);
  });

  function rbValues() {
    return {
      'settings-route-block-action': actionSel.value,
      'settings-route-block-body': bodyEl ? bodyEl.value || '' : '',
      'settings-route-block-redirect': redirectEl ? redirectEl.value || '' : '',
    };
  }
  var rbFields = ['settings-route-block-action', 'settings-route-block-body', 'settings-route-block-redirect']
    .map(function (i) { return document.getElementById(i); }).filter(Boolean);
  SettingsAutosave.bind({
    cluster: 'route-block',
    fields: rbFields,
    statusEl: document.getElementById('route-block-status'),
    valuesById: rbValues,
    requiredForCommit: function () { return actionSel.value === 'redirect' ? ['settings-route-block-redirect'] : []; },
    save: function () {
      return api.put('/api/v1/settings/route-block-default', {
        action: actionSel.value,
        body: bodyEl ? bodyEl.value : '',
        redirect_url: redirectEl ? redirectEl.value : '',
      });
    },
  });
})();

// ─── Domains Registry ─────────────────────────────
(function () {
  var tbl = document.getElementById('domains-table');
  if (!tbl) return;

  var tbody = document.getElementById('domains-tbody');
  var serverIpEl = document.getElementById('domains-server-ip');
  var warningEl = document.getElementById('domains-server-ip-warning');
  var ipInput = document.getElementById('domains-server-ip-input');
  var ipSaveBtn = document.getElementById('domains-server-ip-save');
  var addInput = document.getElementById('domains-add-input');
  var addBtn = document.getElementById('domains-add-btn');
  var addError = document.getElementById('domains-add-error');

  var labelVerified = tbl.dataset.labelVerified || '';
  var labelFailed = tbl.dataset.labelFailed || '';
  var labelPending = tbl.dataset.labelPending || '';
  var labelVerify = tbl.dataset.labelVerify || '';
  var labelRemove = tbl.dataset.labelRemove || '';

  function statusBadge(status) {
    var span = document.createElement('span');
    span.className = 'tag ' + (status === 'verified' ? 'tag-green' : status === 'failed' ? 'tag-amber' : 'tag-grey');
    span.style.fontSize = '11px';
    var dot = document.createElement('span');
    dot.className = 'tag-dot';
    span.appendChild(dot);
    span.appendChild(document.createTextNode(
      status === 'verified' ? labelVerified : status === 'failed' ? labelFailed : labelPending
    ));
    return span;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString(); } catch (e) { return iso; }
  }

  function renderRows(domains) {
    tbody.textContent = '';
    if (!domains || domains.length === 0) return;
    domains.forEach(function (d) {
      var tr = document.createElement('tr');
      tr.dataset.domainId = d.id;
      tr.style.borderBottom = '1px solid var(--border)';

      var tdDomain = document.createElement('td');
      tdDomain.style.cssText = 'padding:8px;font-family:var(--font-mono);font-size:12px';
      tdDomain.textContent = d.domain;
      if (d.last_error && d.status === 'failed') {
        var errEl = document.createElement('div');
        errEl.style.cssText = 'font-size:11px;color:var(--red);margin-top:2px;font-family:inherit';
        errEl.textContent = d.last_error;
        tdDomain.appendChild(errEl);
      }
      tr.appendChild(tdDomain);

      var tdStatus = document.createElement('td');
      tdStatus.style.padding = '8px';
      tdStatus.appendChild(statusBadge(d.status));
      tr.appendChild(tdStatus);

      var tdDate = document.createElement('td');
      tdDate.style.cssText = 'padding:8px;font-size:11px;color:var(--text-3)';
      tdDate.textContent = formatDate(d.verified_at);
      tr.appendChild(tdDate);

      var tdAct = document.createElement('td');
      tdAct.style.cssText = 'padding:8px;white-space:nowrap';

      var verifyBtn = document.createElement('button');
      verifyBtn.className = 'btn btn-ghost';
      verifyBtn.style.cssText = 'font-size:11px;padding:3px 8px;margin-right:4px';
      verifyBtn.textContent = labelVerify;
      verifyBtn.addEventListener('click', (function (domainId, row) {
        return function () { recheckDomain(domainId, row); };
      })(d.id, tr));
      tdAct.appendChild(verifyBtn);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-ghost';
      removeBtn.style.cssText = 'font-size:11px;padding:3px 8px;color:var(--red)';
      removeBtn.textContent = labelRemove;
      removeBtn.addEventListener('click', (function (domainId, row) {
        return function () { removeDomain(domainId, row); };
      })(d.id, tr));
      tdAct.appendChild(removeBtn);

      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
  }

  async function loadDomains() {
    try {
      var r = await api.get('/api/v1/settings/domains');
      if (!r.ok) return;
      renderRows(r.data.domains);
      if (serverIpEl) serverIpEl.textContent = r.data.serverIp || '—';
      if (warningEl) warningEl.style.display = r.data.serverIpWarning ? '' : 'none';
    } catch (err) {
      console.error('Failed to load domains:', err);
    }
  }

  async function recheckDomain(id, tr) {
    try {
      var r = await api.post('/api/v1/settings/domains/' + id + '/verify', {});
      if (r.ok && r.data) {
        var d = r.data;
        var domainCell = tr.cells[0];
        domainCell.textContent = d.domain;
        if (d.last_error && d.status === 'failed') {
          var errEl = document.createElement('div');
          errEl.style.cssText = 'font-size:11px;color:var(--red);margin-top:2px';
          errEl.textContent = d.last_error;
          domainCell.appendChild(errEl);
        }
        var statusCell = tr.cells[1];
        statusCell.textContent = '';
        statusCell.appendChild(statusBadge(d.status));
        tr.cells[2].textContent = formatDate(d.verified_at);
      }
    } catch (err) {
      console.error('Recheck failed:', err);
    }
  }

  async function removeDomain(id, tr) {
    try {
      var r = await api.del('/api/v1/settings/domains/' + id);
      if (r.ok) tr.remove();
    } catch (err) {
      console.error('Remove domain failed:', err);
    }
  }

  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var domain = addInput ? addInput.value.trim() : '';
      if (!domain) return;
      if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
      btnLoading(addBtn);
      try {
        var r = await api.post('/api/v1/settings/domains', { domain: domain });
        if (!r.ok) {
          if (addError) { addError.textContent = r.error || ''; addError.style.display = ''; }
        } else {
          if (addInput) addInput.value = '';
          await loadDomains();
        }
      } catch (err) {
        if (addError) { addError.textContent = err.message; addError.style.display = ''; }
      } finally {
        btnReset(addBtn);
      }
    });
  }

  if (ipSaveBtn) {
    ipSaveBtn.addEventListener('click', async function () {
      var ip = ipInput ? ipInput.value.trim() : '';
      if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
      btnLoading(ipSaveBtn);
      try {
        var r = await api.put('/api/v1/settings/domains/server-ip', { ip: ip });
        if (r.ok) {
          if (ipInput) ipInput.value = '';
          await loadDomains();
        } else {
          if (addError) { addError.textContent = r.error || ''; addError.style.display = ''; }
        }
      } catch (err) {
        if (addError) { addError.textContent = err.message; addError.style.display = ''; }
      } finally {
        btnReset(ipSaveBtn);
      }
    });
  }

  loadDomains();
})();
