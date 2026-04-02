/* global GC, api */
'use strict';

(function () {
  var currentView = 'grid';
  var currentFilter = 'all';
  var searchQuery = '';
  var allRoutes = [];
  var editingId = null;

  // -- DOM References -------------------------------------------
  var grid = document.getElementById('rdp-grid');
  var searchInput = document.getElementById('rdp-search');
  var subtitle = document.getElementById('rdp-subtitle');
  var historyList = document.getElementById('rdp-history-list');
  var modalOverlay = document.getElementById('rdp-modal-overlay');
  var modal = document.getElementById('rdp-modal');
  var modalTitle = document.getElementById('rdp-modal-title');

  // -- Load Routes ----------------------------------------------
  async function loadRoutes() {
    try {
      var res = await api.get('/api/v1/rdp');
      if (!res.ok) return;
      allRoutes = res.routes || [];
      updateStats();
      renderRoutes();
      updateSubtitle();
    } catch (err) {
      grid.textContent = err.message || 'Error';
    }
  }

  function updateSubtitle() {
    if (subtitle) {
      subtitle.textContent = (GC.t['rdp.subtitle'] || '{{count}} RDP route(s) configured').replace('{{count}}', allRoutes.length);
    }
  }

  function updateStats() {
    var total = allRoutes.length;
    var online = allRoutes.filter(function (r) { return r.status && r.status.online; }).length;
    var offline = total - online;
    var sessions = allRoutes.reduce(function (sum, r) { return sum + (r.active_sessions || 0); }, 0);
    var maintenance = allRoutes.filter(function (r) { return r.maintenance_enabled; }).length;

    document.getElementById('rdp-stat-total').textContent = total;
    document.getElementById('rdp-stat-online').textContent = online;
    document.getElementById('rdp-stat-offline').textContent = offline;
    document.getElementById('rdp-stat-sessions').textContent = sessions;
    document.getElementById('rdp-stat-maintenance').textContent = maintenance;
  }

  function filterRoutes() {
    return allRoutes.filter(function (r) {
      if (currentFilter === 'online' && (!r.status || !r.status.online)) return false;
      if (currentFilter === 'offline' && r.status && r.status.online) return false;
      if (searchQuery) {
        var q = searchQuery.toLowerCase();
        var match = (r.name || '').toLowerCase().includes(q) ||
          (r.host || '').toLowerCase().includes(q) ||
          (r.description || '').toLowerCase().includes(q) ||
          (r.tags || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }

  function renderRoutes() {
    var filtered = filterRoutes();
    if (filtered.length === 0) {
      grid.textContent = GC.t['rdp.no_routes'] || 'No RDP routes configured';
      grid.style.cssText = 'font-size:13px;color:var(--text-3);padding:20px 0;text-align:center';
      return;
    }
    grid.style.cssText = '';

    if (currentView === 'grid') {
      renderGrid(filtered);
    } else {
      renderList(filtered);
    }
  }

  function renderGrid(routes) {
    // Clear and build via DOM
    grid.textContent = '';
    var container = document.createElement('div');
    container.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px';

    routes.forEach(function (r) {
      var isOnline = r.status && r.status.online;
      var statusColor = isOnline ? 'var(--success)' : 'var(--danger)';
      var statusText = isOnline ? (GC.t['rdp.online'] || 'Online') : (GC.t['rdp.offline'] || 'Offline');
      var tags = '';
      try { var parsed = JSON.parse(r.tags || '[]'); if (Array.isArray(parsed)) tags = parsed.join(', '); } catch {}

      var card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'padding:14px;cursor:pointer';
      card.dataset.rdpId = r.id;

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
      var nameEl = document.createElement('strong');
      nameEl.style.fontSize = '14px';
      nameEl.textContent = r.name;
      var statusEl = document.createElement('span');
      statusEl.style.cssText = 'font-size:11px;color:' + statusColor;
      statusEl.textContent = statusText;
      header.appendChild(nameEl);
      header.appendChild(statusEl);
      card.appendChild(header);

      var hostEl = document.createElement('div');
      hostEl.style.cssText = 'font-size:12px;color:var(--text-3)';
      hostEl.textContent = r.host + ':' + r.port;
      card.appendChild(hostEl);

      if (r.description) {
        var descEl = document.createElement('div');
        descEl.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:4px';
        descEl.textContent = r.description;
        card.appendChild(descEl);
      }

      if (tags) {
        var tagsEl = document.createElement('div');
        tagsEl.style.cssText = 'margin-top:6px;font-size:10px;color:var(--text-3)';
        tagsEl.textContent = tags;
        card.appendChild(tagsEl);
      }

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:10px';

      if (r.wol_enabled && r.wol_mac_address && !isOnline) {
        var wolBtn = document.createElement('button');
        wolBtn.className = 'btn btn-ghost btn-sm';
        wolBtn.dataset.wol = r.id;
        wolBtn.textContent = GC.t['rdp.wol_send'] || 'WoL';
        actions.appendChild(wolBtn);
      }

      var checkBtn = document.createElement('button');
      checkBtn.className = 'btn btn-ghost btn-sm';
      checkBtn.dataset.check = r.id;
      checkBtn.textContent = GC.t['rdp.connect_test'] || 'Test';
      actions.appendChild(checkBtn);

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost btn-sm';
      editBtn.dataset.edit = r.id;
      editBtn.style.marginLeft = 'auto';
      editBtn.textContent = 'Edit';
      actions.appendChild(editBtn);

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-ghost btn-sm';
      toggleBtn.dataset.toggle = r.id;
      toggleBtn.textContent = r.enabled ? (GC.t['rdp.enabled'] || 'On') : (GC.t['rdp.disabled'] || 'Off');
      actions.appendChild(toggleBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-ghost btn-sm';
      deleteBtn.style.color = 'var(--danger)';
      deleteBtn.dataset.delete = r.id;
      deleteBtn.textContent = '\u00d7';
      actions.appendChild(deleteBtn);

      card.appendChild(actions);
      container.appendChild(card);
    });
    grid.appendChild(container);
  }

  function renderList(routes) {
    grid.textContent = '';
    var table = document.createElement('table');
    table.className = 'table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = [
      GC.t['rdp.name'] || 'Name',
      GC.t['rdp.host'] || 'Host',
      GC.t['rdp.access_mode'] || 'Access',
      GC.t['rdp.credentials'] || 'Creds',
      GC.t['rdp.status'] || 'Status',
      GC.t['rdp.sessions'] || 'Sessions',
      ''
    ];
    headers.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    routes.forEach(function (r) {
      var isOnline = r.status && r.status.online;
      var tr = document.createElement('tr');

      var cells = [
        r.name,
        r.host + ':' + r.port,
        r.access_mode,
        r.has_credentials ? 'Yes' : 'No',
        isOnline ? 'Online' : 'Offline',
        String(r.active_sessions || 0)
      ];
      cells.forEach(function (text, i) {
        var td = document.createElement('td');
        if (i === 0) { var strong = document.createElement('strong'); strong.textContent = text; td.appendChild(strong); }
        else { td.textContent = text; }
        if (i === 4) td.style.color = isOnline ? 'var(--success)' : 'var(--danger)';
        tr.appendChild(td);
      });

      var actionTd = document.createElement('td');
      actionTd.style.cssText = 'display:flex;gap:4px';

      var editBtn = document.createElement('button');
      editBtn.className = 'icon-btn';
      editBtn.dataset.edit = r.id;
      editBtn.title = 'Edit';
      editBtn.textContent = '\u270e';
      actionTd.appendChild(editBtn);

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'icon-btn';
      toggleBtn.dataset.toggle = r.id;
      toggleBtn.title = 'Toggle';
      toggleBtn.textContent = r.enabled ? '\u2714' : '\u2716';
      actionTd.appendChild(toggleBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn';
      deleteBtn.dataset.delete = r.id;
      deleteBtn.title = 'Delete';
      deleteBtn.style.color = 'var(--danger)';
      deleteBtn.textContent = '\u00d7';
      actionTd.appendChild(deleteBtn);

      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    grid.appendChild(table);
  }

  // -- Event Handlers -------------------------------------------
  grid.addEventListener('click', async function (e) {
    var editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openEditModal(parseInt(editBtn.dataset.edit, 10)); return; }

    var deleteBtn = e.target.closest('[data-delete]');
    if (deleteBtn) {
      if (!confirm(GC.t['rdp.confirm_delete'] || 'Delete this RDP route?')) return;
      try { await api.del('/api/v1/rdp/' + deleteBtn.dataset.delete); loadRoutes(); } catch {}
      return;
    }

    var toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      try { await api.put('/api/v1/rdp/' + toggleBtn.dataset.toggle + '/toggle'); loadRoutes(); } catch {}
      return;
    }

    var wolBtn = e.target.closest('[data-wol]');
    if (wolBtn) {
      try { await api.post('/api/v1/rdp/' + wolBtn.dataset.wol + '/wol'); wolBtn.textContent = GC.t['rdp.wol_sent'] || 'Sent'; } catch {}
      return;
    }

    var checkBtn = e.target.closest('[data-check]');
    if (checkBtn) {
      try {
        var result = await api.get('/api/v1/rdp/' + checkBtn.dataset.check + '/status');
        checkBtn.textContent = result.online ? 'Online' : 'Offline';
        checkBtn.style.color = result.online ? 'var(--success)' : 'var(--danger)';
      } catch {}
      return;
    }
  });

  // View toggle
  var viewToggle = document.getElementById('rdp-view-toggle');
  if (viewToggle) {
    viewToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-view]');
      if (!btn) return;
      currentView = btn.dataset.view;
      viewToggle.querySelectorAll('.btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderRoutes();
    });
  }

  // Status filter
  var statusFilter = document.getElementById('rdp-status-filter');
  if (statusFilter) {
    statusFilter.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) return;
      currentFilter = btn.dataset.filter;
      statusFilter.querySelectorAll('.btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderRoutes();
    });
  }

  // Search
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      searchQuery = this.value;
      renderRoutes();
    });
  }

  // -- Modal ----------------------------------------------------
  var addBtn = document.getElementById('btn-add-rdp');
  if (addBtn) addBtn.addEventListener('click', function () { openCreateModal(); });

  document.getElementById('rdp-modal-close').addEventListener('click', closeRdpModal);
  document.getElementById('rdp-modal-cancel').addEventListener('click', closeRdpModal);
  modalOverlay.addEventListener('click', function (e) { if (e.target === modalOverlay) closeRdpModal(); });

  // Credential mode toggle
  var credMode = document.getElementById('rdp-credential-mode');
  if (credMode) {
    credMode.addEventListener('change', function () {
      var fields = document.getElementById('rdp-cred-fields');
      var pwGroup = document.getElementById('rdp-password-group');
      fields.style.display = this.value === 'none' ? 'none' : '';
      pwGroup.style.display = this.value === 'full' ? '' : 'none';
    });
  }

  // Resolution mode toggle
  var resMode = document.getElementById('rdp-resolution-mode');
  if (resMode) {
    resMode.addEventListener('change', function () {
      document.getElementById('rdp-resolution-fields').style.display = this.value === 'fixed' ? '' : 'none';
    });
  }

  // -- Access mode field dependencies -----------------------------
  var accessMode = document.getElementById('rdp-access-mode');
  var externalFields = document.getElementById('rdp-external-fields');
  var externalHostInput = document.getElementById('rdp-external-hostname');
  var externalHostLabel = document.getElementById('rdp-external-hostname-label');

  function updateAccessModeFields() {
    if (!accessMode || !externalFields) return;
    var labelBase = GC.t['rdp.external_hostname'] || 'External Hostname';
    if (accessMode.value === 'internal') {
      externalFields.style.display = 'none';
      externalHostInput.removeAttribute('required');
      if (externalHostLabel) externalHostLabel.textContent = labelBase;
    } else {
      externalFields.style.display = '';
      externalHostInput.setAttribute('required', '');
      if (externalHostLabel) externalHostLabel.textContent = labelBase + ' *';
    }
  }

  if (accessMode) {
    accessMode.addEventListener('change', updateAccessModeFields);
    updateAccessModeFields();
  }

  // -- Peer autocomplete for Host field ---------------------------
  var cachedPeers = null;
  var hostInput = document.getElementById('rdp-host');
  var suggestions = document.getElementById('rdp-host-suggestions');

  async function fetchPeers() {
    if (cachedPeers) return cachedPeers;
    try {
      var res = await api.get('/api/v1/peers');
      if (res.ok && res.peers) {
        cachedPeers = res.peers;
        return cachedPeers;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function extractIp(allowedIps) {
    if (!allowedIps) return '';
    return allowedIps.replace(/\/\d+$/, '');
  }

  function showSuggestions(peers) {
    suggestions.textContent = '';
    if (peers.length === 0) {
      suggestions.style.display = 'none';
      return;
    }
    peers.forEach(function (p) {
      var ip = extractIp(p.allowed_ips);
      var item = document.createElement('div');
      item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between';
      item.addEventListener('mouseenter', function () { item.style.background = 'var(--bg-hover)'; });
      item.addEventListener('mouseleave', function () { item.style.background = ''; });

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-weight:600;color:var(--text-1)';
      nameSpan.textContent = p.name;

      var ipSpan = document.createElement('span');
      ipSpan.style.cssText = 'font-family:var(--font-mono);color:var(--text-3);font-size:11px';
      ipSpan.textContent = ip;

      item.appendChild(nameSpan);
      item.appendChild(ipSpan);

      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        hostInput.value = ip;
        suggestions.style.display = 'none';
      });

      suggestions.appendChild(item);
    });
    suggestions.style.display = '';
  }

  function filterPeers(peers, query) {
    if (!query) return peers.slice(0, 10);
    var q = query.toLowerCase();
    return peers.filter(function (p) {
      var ip = extractIp(p.allowed_ips);
      return (p.name || '').toLowerCase().indexOf(q) === 0 ||
        ip.toLowerCase().indexOf(q) === 0;
    }).slice(0, 10);
  }

  if (hostInput && suggestions) {
    hostInput.addEventListener('input', async function () {
      var peers = await fetchPeers();
      var filtered = filterPeers(peers, this.value);
      showSuggestions(filtered);
    });

    hostInput.addEventListener('focus', async function () {
      if (this.value) {
        var peers = await fetchPeers();
        var filtered = filterPeers(peers, this.value);
        showSuggestions(filtered);
      }
    });

    hostInput.addEventListener('blur', function () {
      setTimeout(function () { suggestions.style.display = 'none'; }, 150);
    });

    hostInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        suggestions.style.display = 'none';
      }
    });
  }

  // Pre-fetch peers on page load
  fetchPeers();

  function openCreateModal() {
    editingId = null;
    modalTitle.textContent = GC.t['rdp.add'] || 'Add RDP Route';
    document.getElementById('rdp-form').reset();
    document.getElementById('rdp-edit-id').value = '';
    openModal('rdp-modal-overlay');
  }

  async function openEditModal(id) {
    editingId = id;
    modalTitle.textContent = 'Edit RDP Route';
    try {
      var res = await api.get('/api/v1/rdp/' + id);
      if (!res.ok) return;
      var r = res.route;
      document.getElementById('rdp-edit-id').value = r.id;
      document.getElementById('rdp-name').value = r.name || '';
      document.getElementById('rdp-description').value = r.description || '';
      document.getElementById('rdp-host').value = r.host || '';
      document.getElementById('rdp-port').value = r.port || 3389;
      document.getElementById('rdp-access-mode').value = r.access_mode || 'internal';
      document.getElementById('rdp-external-hostname').value = r.external_hostname || '';
      document.getElementById('rdp-external-port').value = r.external_port || '';
      document.getElementById('rdp-gateway-host').value = r.gateway_host || '';
      document.getElementById('rdp-gateway-port').value = r.gateway_port || 443;
      document.getElementById('rdp-credential-mode').value = r.credential_mode || 'none';
      document.getElementById('rdp-domain').value = r.domain || '';
      document.getElementById('rdp-resolution-mode').value = r.resolution_mode || 'fullscreen';
      document.getElementById('rdp-resolution-width').value = r.resolution_width || '';
      document.getElementById('rdp-resolution-height').value = r.resolution_height || '';
      document.getElementById('rdp-multi-monitor').checked = !!r.multi_monitor;
      document.getElementById('rdp-color-depth').value = r.color_depth || 32;
      document.getElementById('rdp-redirect-clipboard').checked = !!r.redirect_clipboard;
      document.getElementById('rdp-redirect-printers').checked = !!r.redirect_printers;
      document.getElementById('rdp-redirect-drives').checked = !!r.redirect_drives;
      document.getElementById('rdp-redirect-usb').checked = !!r.redirect_usb;
      document.getElementById('rdp-redirect-smartcard').checked = !!r.redirect_smartcard;
      document.getElementById('rdp-audio-mode').value = r.audio_mode || 'local';
      document.getElementById('rdp-network-profile').value = r.network_profile || 'auto';
      document.getElementById('rdp-nla').checked = !!r.nla_enabled;
      document.getElementById('rdp-disable-wallpaper').checked = !!r.disable_wallpaper;
      document.getElementById('rdp-disable-themes').checked = !!r.disable_themes;
      document.getElementById('rdp-disable-animations').checked = !!r.disable_animations;
      document.getElementById('rdp-bandwidth-limit').value = r.bandwidth_limit || '';
      document.getElementById('rdp-session-timeout').value = r.session_timeout || '';
      document.getElementById('rdp-admin-session').checked = !!r.admin_session;
      document.getElementById('rdp-remote-app').value = r.remote_app || '';
      document.getElementById('rdp-start-program').value = r.start_program || '';
      document.getElementById('rdp-wol-enabled').checked = !!r.wol_enabled;
      document.getElementById('rdp-wol-mac').value = r.wol_mac_address || '';
      document.getElementById('rdp-maintenance-enabled').checked = !!r.maintenance_enabled;
      document.getElementById('rdp-health-check').checked = r.health_check_enabled !== 0;
      document.getElementById('rdp-credential-rotation-enabled').checked = !!r.credential_rotation_enabled;
      document.getElementById('rdp-rotation-days').value = r.credential_rotation_days || 90;
      document.getElementById('rdp-notes').value = r.notes || '';
      try { var t = JSON.parse(r.tags || '[]'); document.getElementById('rdp-tags').value = Array.isArray(t) ? t.join(', ') : ''; } catch { document.getElementById('rdp-tags').value = ''; }

      // Trigger change events
      credMode.dispatchEvent(new Event('change'));
      resMode.dispatchEvent(new Event('change'));
      accessMode.dispatchEvent(new Event('change'));

      openModal('rdp-modal-overlay');
    } catch (err) {
      alert(err.message || 'Failed to load route');
    }
  }

  function closeRdpModal() {
    closeModal('rdp-modal-overlay');
    editingId = null;
  }

  // Save handler
  document.getElementById('rdp-modal-save').addEventListener('click', async function () {
    var data = {
      name: document.getElementById('rdp-name').value,
      description: document.getElementById('rdp-description').value,
      host: document.getElementById('rdp-host').value,
      port: parseInt(document.getElementById('rdp-port').value, 10) || 3389,
      access_mode: document.getElementById('rdp-access-mode').value,
      external_hostname: document.getElementById('rdp-external-hostname').value || null,
      external_port: document.getElementById('rdp-external-port').value ? parseInt(document.getElementById('rdp-external-port').value, 10) : null,
      gateway_host: document.getElementById('rdp-gateway-host').value || null,
      gateway_port: document.getElementById('rdp-gateway-port').value ? parseInt(document.getElementById('rdp-gateway-port').value, 10) : null,
      credential_mode: document.getElementById('rdp-credential-mode').value,
      domain: document.getElementById('rdp-domain').value || null,
      username: document.getElementById('rdp-username').value || null,
      password: document.getElementById('rdp-password').value || null,
      resolution_mode: document.getElementById('rdp-resolution-mode').value,
      resolution_width: document.getElementById('rdp-resolution-width').value ? parseInt(document.getElementById('rdp-resolution-width').value, 10) : null,
      resolution_height: document.getElementById('rdp-resolution-height').value ? parseInt(document.getElementById('rdp-resolution-height').value, 10) : null,
      multi_monitor: document.getElementById('rdp-multi-monitor').checked,
      color_depth: parseInt(document.getElementById('rdp-color-depth').value, 10) || 32,
      redirect_clipboard: document.getElementById('rdp-redirect-clipboard').checked,
      redirect_printers: document.getElementById('rdp-redirect-printers').checked,
      redirect_drives: document.getElementById('rdp-redirect-drives').checked,
      redirect_usb: document.getElementById('rdp-redirect-usb').checked,
      redirect_smartcard: document.getElementById('rdp-redirect-smartcard').checked,
      audio_mode: document.getElementById('rdp-audio-mode').value,
      network_profile: document.getElementById('rdp-network-profile').value,
      nla_enabled: document.getElementById('rdp-nla').checked,
      disable_wallpaper: document.getElementById('rdp-disable-wallpaper').checked,
      disable_themes: document.getElementById('rdp-disable-themes').checked,
      disable_animations: document.getElementById('rdp-disable-animations').checked,
      bandwidth_limit: document.getElementById('rdp-bandwidth-limit').value ? parseInt(document.getElementById('rdp-bandwidth-limit').value, 10) : null,
      session_timeout: document.getElementById('rdp-session-timeout').value ? parseInt(document.getElementById('rdp-session-timeout').value, 10) : null,
      admin_session: document.getElementById('rdp-admin-session').checked,
      remote_app: document.getElementById('rdp-remote-app').value || null,
      start_program: document.getElementById('rdp-start-program').value || null,
      wol_enabled: document.getElementById('rdp-wol-enabled').checked,
      wol_mac_address: document.getElementById('rdp-wol-mac').value || null,
      maintenance_enabled: document.getElementById('rdp-maintenance-enabled').checked,
      health_check_enabled: document.getElementById('rdp-health-check').checked,
      credential_rotation_enabled: document.getElementById('rdp-credential-rotation-enabled').checked,
      credential_rotation_days: parseInt(document.getElementById('rdp-rotation-days').value, 10) || 90,
      notes: document.getElementById('rdp-notes').value || null,
      tags: document.getElementById('rdp-tags').value ? document.getElementById('rdp-tags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : null,
    };

    try {
      if (editingId) {
        await api.patch('/api/v1/rdp/' + editingId, data);
      } else {
        await api.post('/api/v1/rdp', data);
      }
      closeRdpModal();
      loadRoutes();
    } catch (err) {
      alert(err.message || 'Failed to save RDP route');
    }
  });

  // -- History --------------------------------------------------
  async function loadHistory() {
    try {
      var res = await api.get('/api/v1/rdp/history?limit=20');
      if (!res.ok) return;
      var history = res.history || [];

      if (history.length === 0) {
        historyList.textContent = 'No session history';
        historyList.style.cssText = 'font-size:13px;color:var(--text-3);padding:12px;text-align:center';
        return;
      }
      historyList.style.cssText = '';
      historyList.textContent = '';

      var table = document.createElement('table');
      table.className = 'table';

      var thead = document.createElement('thead');
      var headerRow = document.createElement('tr');
      var headers = [
        GC.t['rdp.name'] || 'Route',
        GC.t['rdp.history_token'] || 'Token',
        GC.t['rdp.history_started'] || 'Started',
        GC.t['rdp.history_duration'] || 'Duration',
        GC.t['rdp.status'] || 'Status',
        GC.t['rdp.history_reason'] || 'Reason'
      ];
      headers.forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      history.forEach(function (s) {
        var tr = document.createElement('tr');
        var cells = [
          s.route_name || '',
          s.token_name || '-',
          s.started_at || '-',
          s.duration_seconds ? formatDuration(s.duration_seconds) : '-',
          s.status,
          s.end_reason || '-'
        ];
        cells.forEach(function (text) {
          var td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      historyList.appendChild(table);
    } catch {
      historyList.textContent = 'Error loading history';
      historyList.style.cssText = 'color:var(--danger);padding:12px;text-align:center';
    }
  }

  function formatDuration(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
  }

  // History export
  var csvBtn = document.getElementById('rdp-history-export-csv');
  var jsonBtn = document.getElementById('rdp-history-export-json');
  if (csvBtn) csvBtn.addEventListener('click', function () { window.open('/api/v1/rdp/history/export?format=csv', '_blank'); });
  if (jsonBtn) jsonBtn.addEventListener('click', function () { window.open('/api/v1/rdp/history/export?format=json', '_blank'); });

  // -- Rotation stats -------------------------------------------
  async function loadRotationCount() {
    try {
      var res = await api.get('/api/v1/rdp/rotation/pending');
      if (res.ok && res.pending) {
        document.getElementById('rdp-stat-rotation').textContent = res.pending.length;
      }
    } catch {}
  }

  // -- Init -----------------------------------------------------
  loadRoutes();
  loadHistory();
  loadRotationCount();

  // Auto-refresh every 60s
  setInterval(function () {
    loadRoutes();
    loadHistory();
  }, 60000);
})();
