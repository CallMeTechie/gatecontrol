/* global GC, api */
'use strict';

(function () {
  var currentView = 'grid';
  var currentFilter = 'all';
  var searchQuery = '';
  var allRoutes = [];
  var editingId = null;

  function formatRelativeTime(isoDate) {
    if (!isoDate) return '-';
    var diff = (Date.now() - new Date(isoDate + 'Z').getTime()) / 1000;
    if (diff < 0) return '-';
    if (diff < 60) return GC.t['rdp.just_now'] || 'gerade eben';
    if (diff < 3600) return Math.floor(diff / 60) + ' Min';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
  }

  // -- DOM References -------------------------------------------
  var grid = document.getElementById('rdp-grid');
  var searchInput = document.getElementById('rdp-search');
  var subtitle = document.getElementById('rdp-subtitle');
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

  function setStatValue(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    var dot = el.querySelector('.stat-dot');
    el.textContent = value;
    if (dot) el.prepend(dot);
  }

  function updateStats() {
    var total = allRoutes.length;
    var online = allRoutes.filter(function (r) { return r.status && r.status.online; }).length;
    var offline = total - online;
    var sessions = allRoutes.reduce(function (sum, r) { return sum + (r.active_sessions || 0); }, 0);
    var maintenance = allRoutes.filter(function (r) { return r.maintenance_enabled; }).length;

    setStatValue('rdp-stat-total', total);
    setStatValue('rdp-stat-online', online);
    setStatValue('rdp-stat-offline', offline);
    setStatValue('rdp-stat-sessions', sessions);
    setStatValue('rdp-stat-maintenance', maintenance);
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
    grid.textContent = '';
    var container = document.createElement('div');
    container.className = 'vm-grid';

    routes.forEach(function (r) {
      var isOnline = r.status && r.status.online;
      var isMaintenance = r.maintenance_enabled;
      var tags = [];
      try { tags = JSON.parse(r.tags || '[]'); } catch {}
      if (!Array.isArray(tags)) tags = [];

      var card = document.createElement('div');
      card.className = 'vm-card';
      if (isMaintenance) card.style.borderLeft = '3px solid var(--amber)';

      // Header: name + host + status tag
      var header = document.createElement('div');
      header.className = 'vm-card-header';

      var nameBlock = document.createElement('div');
      var nameEl = document.createElement('div');
      nameEl.className = 'vm-name';
      nameEl.textContent = r.name;
      nameBlock.appendChild(nameEl);

      var hostEl = document.createElement('div');
      hostEl.className = 'vm-host';
      hostEl.textContent = r.host + ':' + (r.port || 3389);
      nameBlock.appendChild(hostEl);
      header.appendChild(nameBlock);

      var statusTag = document.createElement('span');
      statusTag.className = 'tag';
      if (isOnline) {
        statusTag.classList.add('tag-green');
        statusTag.textContent = GC.t['rdp.online'] || 'Online';
      } else if (isMaintenance) {
        statusTag.classList.add('tag-amber');
        statusTag.textContent = GC.t['rdp.maintenance'] || 'Wartung';
      } else {
        statusTag.classList.add('tag-red');
        statusTag.textContent = GC.t['rdp.offline'] || 'Offline';
      }
      header.appendChild(statusTag);
      card.appendChild(header);

      // Tags
      if (tags.length > 0) {
        var tagsRow = document.createElement('div');
        tagsRow.className = 'vm-tags';
        tags.forEach(function (tg) {
          var tagEl = document.createElement('span');
          tagEl.className = 'tag tag-neutral';
          tagEl.textContent = tg;
          tagsRow.appendChild(tagEl);
        });
        card.appendChild(tagsRow);
      }

      // Meta rows
      var meta = document.createElement('div');
      meta.className = 'vm-meta';

      // Access mode row
      var accessRow = document.createElement('div');
      accessRow.className = 'vm-meta-row';
      var accessLabel = document.createElement('span');
      accessLabel.textContent = GC.t['rdp.access_mode'] || 'Zugriff';
      accessRow.appendChild(accessLabel);
      var accessTag = document.createElement('span');
      accessTag.className = 'tag';
      accessTag.style.fontSize = '10px';
      if (r.access_mode === 'external' || r.access_mode === 'both') {
        accessTag.classList.add('tag-purple');
        accessTag.textContent = r.access_mode === 'both' ? (GC.t['rdp.access_both'] || 'Extern + Intern') : (GC.t['rdp.access_external'] || 'Extern');
      } else {
        accessTag.classList.add('tag-blue');
        accessTag.textContent = GC.t['rdp.access_internal'] || 'Intern';
      }
      accessRow.appendChild(accessTag);
      meta.appendChild(accessRow);

      // External hostname (if applicable)
      if (r.external_hostname && (r.access_mode === 'external' || r.access_mode === 'both')) {
        var extHostRow = document.createElement('div');
        extHostRow.className = 'vm-meta-row';
        var extHostLabel = document.createElement('span');
        extHostLabel.textContent = 'Hostname';
        extHostRow.appendChild(extHostLabel);
        var extHostVal = document.createElement('span');
        extHostVal.style.cssText = 'font-family:var(--font-mono);font-size:11px';
        extHostVal.textContent = r.external_hostname;
        extHostRow.appendChild(extHostVal);
        meta.appendChild(extHostRow);
      }

      // Credentials row
      var credRow = document.createElement('div');
      credRow.className = 'vm-meta-row';
      var credLabel = document.createElement('span');
      credLabel.textContent = GC.t['rdp.credentials'] || 'Credentials';
      credRow.appendChild(credLabel);
      var credVal = document.createElement('span');
      if (r.credential_mode === 'full') credVal.textContent = GC.t['rdp.credential_full'] || 'Vollständig';
      else if (r.credential_mode === 'user_only') credVal.textContent = GC.t['rdp.credential_user'] || 'Nur Username';
      else credVal.textContent = GC.t['rdp.credential_none'] || 'Keine';
      credRow.appendChild(credVal);
      meta.appendChild(credRow);

      // Active sessions row
      var sessRow = document.createElement('div');
      sessRow.className = 'vm-meta-row';
      var sessLabel = document.createElement('span');
      sessLabel.textContent = GC.t['rdp.stat_active_sessions'] || 'Aktive Sessions';
      sessRow.appendChild(sessLabel);
      var sessVal = document.createElement('span');
      if (r.active_sessions > 0) {
        sessVal.style.cssText = 'font-weight:600;color:var(--blue)';
        sessVal.textContent = r.active_session_users
          ? r.active_sessions + ' (' + r.active_session_users + ')'
          : String(r.active_sessions);
      } else {
        sessVal.textContent = '-';
      }
      sessRow.appendChild(sessVal);
      meta.appendChild(sessRow);

      // Last access row
      if (r.last_access) {
        var lastAccessRow = document.createElement('div');
        lastAccessRow.className = 'vm-meta-row';
        var lastAccessLabel = document.createElement('span');
        lastAccessLabel.textContent = GC.t['rdp.last_access'] || 'Letzter Zugriff';
        lastAccessRow.appendChild(lastAccessLabel);
        var lastAccessVal = document.createElement('span');
        lastAccessVal.textContent = formatRelativeTime(r.last_access);
        lastAccessRow.appendChild(lastAccessVal);
        meta.appendChild(lastAccessRow);
      }

      // WoL row (if enabled)
      if (r.wol_enabled && r.wol_mac_address) {
        var wolRow = document.createElement('div');
        wolRow.className = 'vm-meta-row';
        var wolLabel = document.createElement('span');
        wolLabel.textContent = 'WoL';
        wolRow.appendChild(wolLabel);
        var wolVal = document.createElement('span');
        wolVal.style.cssText = 'font-family:var(--font-mono);font-size:11px';
        wolVal.textContent = r.wol_mac_address;
        wolRow.appendChild(wolVal);
        meta.appendChild(wolRow);
      }

      // Maintenance row
      if (r.maintenance_enabled) {
        var maintRow = document.createElement('div');
        maintRow.className = 'vm-meta-row';
        var maintLabel = document.createElement('span');
        maintLabel.textContent = GC.t['rdp.maintenance'] || 'Wartung';
        maintRow.appendChild(maintLabel);
        var maintVal = document.createElement('span');
        if (r.maintenance_schedule) {
          maintVal.style.cssText = 'font-family:var(--font-mono);font-size:10px';
          maintVal.textContent = r.maintenance_schedule;
        } else {
          maintVal.style.cssText = 'color:var(--amber);font-weight:600';
          maintVal.textContent = GC.t['rdp.maintenance_active'] || 'Aktiv';
        }
        maintRow.appendChild(maintVal);
        meta.appendChild(maintRow);
      }

      card.appendChild(meta);

      // Actions
      var actions = document.createElement('div');
      actions.className = 'vm-actions';

      if (!isOnline && r.wol_enabled && r.wol_mac_address) {
        var wolBtn = document.createElement('button');
        wolBtn.className = 'btn btn-sm btn-green';
        wolBtn.dataset.wol = r.id;
        wolBtn.textContent = GC.t['rdp.wol_send'] || 'WoL senden';
        actions.appendChild(wolBtn);
      }

      if (r.active_sessions > 0) {
        var disconnBtn = document.createElement('button');
        disconnBtn.className = 'btn btn-sm btn-amber';
        disconnBtn.dataset.disconnectAll = r.id;
        disconnBtn.textContent = GC.t['rdp.disconnect_all'] || 'Alle trennen';
        actions.appendChild(disconnBtn);
      }

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-ghost';
      editBtn.dataset.edit = r.id;
      editBtn.textContent = GC.t['rdp.edit'] || 'Bearbeiten';
      actions.appendChild(editBtn);

      var checkBtn = document.createElement('button');
      checkBtn.className = 'btn btn-sm btn-ghost';
      checkBtn.dataset.check = r.id;
      checkBtn.textContent = GC.t['rdp.connect_test'] || 'Verbindungstest';
      actions.appendChild(checkBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.dataset.delete = r.id;
      delBtn.textContent = GC.t['rdp.delete'] || 'Löschen';
      actions.appendChild(delBtn);

      card.appendChild(actions);
      container.appendChild(card);
    });

    grid.appendChild(container);
  }

  function renderList(routes) {
    grid.textContent = '';
    var table = document.createElement('table');
    table.className = 'history-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = [
      GC.t['rdp.name'] || 'Name',
      GC.t['rdp.host'] || 'Host',
      GC.t['rdp.access_mode'] || 'Zugriff',
      GC.t['rdp.credentials'] || 'Credentials',
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
      var isMaintenance = r.maintenance_enabled;
      var tr = document.createElement('tr');

      // Name
      var tdName = document.createElement('td');
      tdName.style.cssText = 'font-weight:600;color:var(--text-1)';
      tdName.textContent = r.name;
      tr.appendChild(tdName);

      // Host
      var tdHost = document.createElement('td');
      tdHost.style.cssText = 'font-family:var(--font-mono);font-size:11px';
      tdHost.textContent = r.host + ':' + (r.port || 3389);
      tr.appendChild(tdHost);

      // Access mode
      var tdAccess = document.createElement('td');
      var accessTag = document.createElement('span');
      accessTag.className = 'tag';
      accessTag.style.fontSize = '10px';
      if (r.access_mode === 'external' || r.access_mode === 'both') {
        accessTag.classList.add('tag-purple');
        accessTag.textContent = r.access_mode === 'both' ? (GC.t['rdp.access_both'] || 'Extern + Intern') : (GC.t['rdp.access_external'] || 'Extern');
      } else {
        accessTag.classList.add('tag-blue');
        accessTag.textContent = GC.t['rdp.access_internal'] || 'Intern';
      }
      tdAccess.appendChild(accessTag);
      tr.appendChild(tdAccess);

      // Credentials
      var tdCred = document.createElement('td');
      if (r.credential_mode === 'full') tdCred.textContent = GC.t['rdp.credential_full'] || 'Vollständig';
      else if (r.credential_mode === 'user_only') tdCred.textContent = GC.t['rdp.credential_user'] || 'Nur Username';
      else tdCred.textContent = GC.t['rdp.credential_none'] || 'Keine';
      tr.appendChild(tdCred);

      // Status
      var tdStatus = document.createElement('td');
      var statusTag = document.createElement('span');
      statusTag.className = 'tag';
      if (isOnline) {
        statusTag.classList.add('tag-green');
        statusTag.textContent = GC.t['rdp.online'] || 'Online';
      } else if (isMaintenance) {
        statusTag.classList.add('tag-amber');
        statusTag.textContent = GC.t['rdp.maintenance'] || 'Wartung';
      } else {
        statusTag.classList.add('tag-red');
        statusTag.textContent = GC.t['rdp.offline'] || 'Offline';
      }
      tdStatus.appendChild(statusTag);
      tr.appendChild(tdStatus);

      // Sessions
      var tdSess = document.createElement('td');
      if (r.active_sessions > 0) {
        tdSess.style.cssText = 'font-weight:600;color:var(--blue)';
        tdSess.textContent = r.active_sessions;
      } else {
        tdSess.textContent = '-';
      }
      tr.appendChild(tdSess);

      // Actions
      var tdActions = document.createElement('td');
      tdActions.style.cssText = 'display:flex;gap:4px';

      if (!isOnline && r.wol_enabled && r.wol_mac_address) {
        var wolBtn = document.createElement('button');
        wolBtn.className = 'btn btn-sm btn-green';
        wolBtn.dataset.wol = r.id;
        wolBtn.textContent = GC.t['rdp.wol_send'] || 'WoL senden';
        tdActions.appendChild(wolBtn);
      }

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-ghost';
      editBtn.dataset.edit = r.id;
      editBtn.textContent = GC.t['rdp.edit'] || 'Bearbeiten';
      tdActions.appendChild(editBtn);

      var checkBtn = document.createElement('button');
      checkBtn.className = 'btn btn-sm btn-ghost';
      checkBtn.dataset.check = r.id;
      checkBtn.textContent = GC.t['rdp.connect_test'] || 'Verbindungstest';
      tdActions.appendChild(checkBtn);

      tr.appendChild(tdActions);
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

    var disconnAllBtn = e.target.closest('[data-disconnect-all]');
    if (disconnAllBtn) {
      if (!confirm(GC.t['rdp.confirm_disconnect_all'] || 'Alle aktiven Sessions trennen?')) return;
      try { await api.post('/api/v1/rdp/' + disconnAllBtn.dataset.disconnectAll + '/sessions/disconnect-all'); loadRoutes(); } catch {}
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
    var mode = accessMode.value;
    var homegwFields = document.getElementById('rdp-homegw-fields');

    // External hostname fields: visible for external / both
    if (mode === 'external' || mode === 'both') {
      externalFields.style.display = '';
      externalHostInput.setAttribute('required', '');
      if (externalHostLabel) externalHostLabel.textContent = labelBase + ' *';
    } else {
      externalFields.style.display = 'none';
      externalHostInput.removeAttribute('required');
      if (externalHostLabel) externalHostLabel.textContent = labelBase;
    }

    // Home-Gateway fields: visible only for access_mode='gateway'
    if (homegwFields) {
      homegwFields.style.display = mode === 'gateway' ? '' : 'none';
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

  // -- Fetch users for visibility control ---------------------------
  var allUsers = [];
  async function fetchUsers() {
    try {
      var data = await api.get('/api/v1/users');
      allUsers = data.users || [];
    } catch (e) { /* ignore */ }
  }
  fetchUsers();

  function renderUserCheckboxes(containerId, selectedIds) {
    var container = document.getElementById(containerId);
    container.textContent = '';
    allUsers.forEach(function (u) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = u.id;
      cb.className = 'rdp-user-cb';
      cb.checked = selectedIds.includes(u.id);
      cb.style.cssText = 'accent-color:var(--accent)';
      label.appendChild(cb);
      var txt = document.createTextNode(u.display_name || u.username);
      label.appendChild(txt);
      container.appendChild(label);
    });
    if (!allUsers.length) {
      container.textContent = 'No users available';
      container.style.cssText = 'font-size:12px;color:var(--text-3)';
    }
  }

  function openCreateModal() {
    editingId = null;
    modalTitle.textContent = GC.t['rdp.add'] || 'Add RDP Route';
    document.getElementById('rdp-form').reset();
    document.getElementById('rdp-edit-id').value = '';
    renderUserCheckboxes('rdp-user-ids', []);
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
      // Home-Gateway fields
      var homegwPeerSel = document.getElementById('rdp-homegw-peer');
      if (homegwPeerSel) homegwPeerSel.value = r.gateway_peer_id != null ? String(r.gateway_peer_id) : '';
      var homegwListenInput = document.getElementById('rdp-homegw-listen-port');
      if (homegwListenInput) homegwListenInput.value = r.gateway_listen_port != null ? String(r.gateway_listen_port) : '';
      document.getElementById('rdp-credential-mode').value = r.credential_mode || 'none';
      // Load decrypted credentials from server (separate endpoint for security)
      document.getElementById('rdp-username').value = '';
      document.getElementById('rdp-password').value = '';
      if (r.credential_mode && r.credential_mode !== 'none') {
        try {
          var credRes = await api.get('/api/v1/rdp/' + id + '/credentials');
          if (credRes.ok && credRes.credentials) {
            document.getElementById('rdp-username').value = credRes.credentials.username || '';
            document.getElementById('rdp-password').value = credRes.credentials.password || '';
          }
        } catch (e) { /* credentials may not be accessible */ }
      }
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

      // User visibility
      var userIds = [];
      try { userIds = JSON.parse(r.user_ids || '[]'); } catch (e) { /* ignore */ }
      renderUserCheckboxes('rdp-user-ids', Array.isArray(userIds) ? userIds : []);

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
      // Microsoft RD-Gateway (TSGateway) — NOT the Home Gateway
      gateway_host: document.getElementById('rdp-gateway-host').value || null,
      gateway_port: document.getElementById('rdp-gateway-port').value ? parseInt(document.getElementById('rdp-gateway-port').value, 10) : null,
      // Home-Gateway routing (Option B)
      gateway_peer_id: (document.getElementById('rdp-access-mode').value === 'gateway'
        && document.getElementById('rdp-homegw-peer') && document.getElementById('rdp-homegw-peer').value)
        ? parseInt(document.getElementById('rdp-homegw-peer').value, 10) : null,
      gateway_listen_port: (document.getElementById('rdp-access-mode').value === 'gateway'
        && document.getElementById('rdp-homegw-listen-port') && document.getElementById('rdp-homegw-listen-port').value)
        ? parseInt(document.getElementById('rdp-homegw-listen-port').value, 10) : null,
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

    // User visibility
    var selectedUserIds = [];
    document.querySelectorAll('.rdp-user-cb:checked').forEach(function (cb) {
      selectedUserIds.push(parseInt(cb.value, 10));
    });
    data.user_ids = selectedUserIds.length > 0 ? selectedUserIds : null;

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
  loadRotationCount();

  // ─── Wizard navigation ─────────────────────────────────
  // The create/edit modal is laid out as a 6-step wizard. Each section
  // carries data-wizard-step="N". All steps > currentStep are hidden.
  // This reuses the existing form state + save handler 1:1 — the
  // wizard is purely a presentation layer on top of the same <form>.
  var WIZARD_TOTAL_STEPS = 6;
  var currentWizardStep = 1;

  function showWizardStep(n) {
    currentWizardStep = Math.max(1, Math.min(WIZARD_TOTAL_STEPS, n));
    var modal = document.getElementById('rdp-modal');
    if (!modal) return;

    // Show matching step content, hide everything else
    modal.querySelectorAll('[data-wizard-step]').forEach(function (el) {
      var s = parseInt(el.getAttribute('data-wizard-step'), 10);
      el.style.display = (s === currentWizardStep) ? '' : 'none';
    });

    // Mark dots + connecting lines as active / done
    var dots = modal.querySelectorAll('.rdp-step-dot');
    var lines = modal.querySelectorAll('.rdp-step-line');
    dots.forEach(function (d) {
      var s = parseInt(d.getAttribute('data-pill'), 10);
      d.classList.remove('active', 'done');
      if (s === currentWizardStep) d.classList.add('active');
      else if (s < currentWizardStep) d.classList.add('done');
    });
    lines.forEach(function (line, idx) {
      // Line between dot idx+1 and dot idx+2; done if currentStep > idx+1
      line.classList.toggle('done', currentWizardStep > idx + 1);
    });

    // Sub-title: "Schritt X von 6"
    var sub = document.getElementById('rdp-modal-subtitle');
    if (sub) {
      var tpl = GC.t['rdp.wizard.step_of'] || 'Step {{current}} of {{total}}';
      sub.textContent = tpl
        .replace('{{current}}', String(currentWizardStep))
        .replace('{{total}}', String(WIZARD_TOTAL_STEPS));
    }

    // Step title next to the counter — pulled from the active dot's data-label
    var stepTitle = document.getElementById('rdp-modal-steptitle');
    if (stepTitle) {
      var activeDot = modal.querySelector('.rdp-step-dot[data-pill="' + currentWizardStep + '"]');
      stepTitle.textContent = activeDot ? (activeDot.getAttribute('data-label') || '') : '';
    }

    // Nav-button visibility
    var prev = document.getElementById('rdp-wizard-prev');
    var next = document.getElementById('rdp-wizard-next');
    var save = document.getElementById('rdp-modal-save');
    if (prev) prev.style.display = currentWizardStep > 1 ? '' : 'none';
    if (next) next.style.display = currentWizardStep < WIZARD_TOTAL_STEPS ? '' : 'none';
    if (save) save.style.display = currentWizardStep === WIZARD_TOTAL_STEPS ? '' : 'none';

    if (currentWizardStep === WIZARD_TOTAL_STEPS) renderWizardReview();
  }

  function validateWizardStep(n) {
    if (n === 1) {
      var name = (document.getElementById('rdp-name') || {}).value || '';
      var host = (document.getElementById('rdp-host') || {}).value || '';
      if (!name.trim()) { alert(GC.t['rdp.name_required'] || 'Name is required'); return false; }
      if (!host.trim()) { alert(GC.t['rdp.host_required'] || 'Host is required'); return false; }
      var accessModeEl = document.getElementById('rdp-access-mode');
      if (accessModeEl && accessModeEl.value === 'gateway') {
        var peer = (document.getElementById('rdp-homegw-peer') || {}).value || '';
        if (!peer) { alert(GC.t['rdp.gateway_peer_required'] || 'Please pick a Home Gateway peer'); return false; }
      }
    }
    return true;
  }

  function _valOf(id) {
    var el = document.getElementById(id);
    if (!el) return '';
    return el.type === 'checkbox' ? (el.checked ? '✓' : '✗') : (el.value || '');
  }

  function renderWizardReview() {
    var target = document.getElementById('rdp-wizard-review');
    if (!target) return;
    while (target.firstChild) target.removeChild(target.firstChild);
    var accessModeVal = _valOf('rdp-access-mode');
    var credModeVal = _valOf('rdp-credential-mode');
    var rows = [];
    rows.push(['Name', _valOf('rdp-name')]);
    if (_valOf('rdp-description')) rows.push(['Description', _valOf('rdp-description')]);
    rows.push(['Host', _valOf('rdp-host') + ':' + (_valOf('rdp-port') || '3389')]);
    rows.push(['Access mode', accessModeVal]);
    if (accessModeVal === 'gateway') {
      var gwSel = document.getElementById('rdp-homegw-peer');
      var gwPeerLabel = (gwSel && gwSel.selectedOptions && gwSel.selectedOptions[0])
        ? gwSel.selectedOptions[0].textContent : _valOf('rdp-homegw-peer');
      rows.push(['Home Gateway', gwPeerLabel]);
      rows.push(['Public listen port', _valOf('rdp-homegw-listen-port') || _valOf('rdp-port') || '3389']);
    } else if (accessModeVal === 'external' || accessModeVal === 'both') {
      rows.push(['External', _valOf('rdp-external-hostname') + ':' + (_valOf('rdp-external-port') || '?')]);
    }
    if (_valOf('rdp-gateway-host')) {
      rows.push(['MS RD-Gateway', _valOf('rdp-gateway-host') + ':' + (_valOf('rdp-gateway-port') || '443')]);
    }
    rows.push(['Credentials', credModeVal]);
    if (credModeVal !== 'none' && _valOf('rdp-username')) rows.push(['Username', _valOf('rdp-username')]);
    if (_valOf('rdp-domain')) rows.push(['Domain', _valOf('rdp-domain')]);
    var resStr = _valOf('rdp-resolution-mode');
    if (resStr === 'fixed') resStr += ' (' + _valOf('rdp-resolution-width') + '×' + _valOf('rdp-resolution-height') + ')';
    rows.push(['Resolution', resStr]);
    rows.push(['Multi-monitor', _valOf('rdp-multi-monitor')]);
    rows.push(['Color depth', _valOf('rdp-color-depth') + ' bit']);
    rows.push(['Audio', _valOf('rdp-audio-mode')]);
    var redir = [];
    ['clipboard','printers','drives','usb','smartcard'].forEach(function (k) {
      var el = document.getElementById('rdp-redirect-' + k);
      if (el && el.checked) redir.push(k);
    });
    if (redir.length) rows.push(['Redirects', redir.join(', ')]);
    rows.push(['Network', _valOf('rdp-network-profile')]);
    if (_valOf('rdp-bandwidth-limit')) rows.push(['Bandwidth limit', _valOf('rdp-bandwidth-limit') + ' kbps']);
    rows.push(['NLA', _valOf('rdp-nla')]);
    if (_valOf('rdp-session-timeout')) rows.push(['Session timeout', _valOf('rdp-session-timeout') + ' s']);
    if (_valOf('rdp-remote-app')) rows.push(['Remote app', _valOf('rdp-remote-app')]);
    rows.push(['Admin session', _valOf('rdp-admin-session')]);
    var wolStr = _valOf('rdp-wol-enabled');
    if (wolStr === '✓' && _valOf('rdp-wol-mac')) wolStr += ' → ' + _valOf('rdp-wol-mac');
    rows.push(['Wake-on-LAN', wolStr]);
    rows.push(['Health check', _valOf('rdp-health-check')]);
    if (_valOf('rdp-tags')) rows.push(['Tags', _valOf('rdp-tags')]);
    // Safe DOM construction — no innerHTML
    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:8px;padding:3px 0;border-bottom:1px dashed var(--border)';
      var k = document.createElement('div');
      k.style.color = 'var(--text-3)';
      k.textContent = row[0];
      var v = document.createElement('div');
      v.textContent = String(row[1]);
      line.appendChild(k); line.appendChild(v);
      target.appendChild(line);
    });
  }

  async function populateHomeGatewayPeers() {
    var sel = document.getElementById('rdp-homegw-peer');
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    var placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = '—';
    sel.appendChild(placeholder);
    try {
      // Reuse the simplified peer endpoint that already exposes
      // peer_type so we don't need a server-side filter change.
      var data = await api.get('/api/v1/routes/peers');
      var peers = ((data && data.peers) || []).filter(function (p) { return p.peer_type === 'gateway' && p.enabled; });
      peers.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = p.name + ' (' + (p.ip || '?') + ')';
        sel.appendChild(opt);
      });
    } catch (err) { /* non-fatal */ }
  }

  (function initWizardNav() {
    var next = document.getElementById('rdp-wizard-next');
    var prev = document.getElementById('rdp-wizard-prev');
    if (next) next.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (!validateWizardStep(currentWizardStep)) return;
      showWizardStep(currentWizardStep + 1);
    });
    if (prev) prev.addEventListener('click', function (ev) {
      ev.preventDefault();
      showWizardStep(currentWizardStep - 1);
    });
    // Clicking a done-dot jumps back to that step — quick edits without
    // clicking Prev six times. Active + not-yet-reached dots ignore clicks.
    var stepsBar = document.getElementById('rdp-wizard-steps');
    if (stepsBar) {
      stepsBar.addEventListener('click', function (ev) {
        var dot = ev.target.closest('.rdp-step-dot.done');
        if (!dot) return;
        var target = parseInt(dot.getAttribute('data-pill'), 10);
        if (!isNaN(target)) showWizardStep(target);
      });
    }
  })();

  // Hook the wizard into openCreateModal / openEditModal so each open
  // starts at step 1 with a fresh peer dropdown.
  var originalOpenCreateModal = openCreateModal;
  openCreateModal = function () {
    originalOpenCreateModal();
    populateHomeGatewayPeers();
    showWizardStep(1);
  };
  var originalOpenEditModal = openEditModal;
  openEditModal = async function (id) {
    await originalOpenEditModal(id);
    await populateHomeGatewayPeers();
    var sel = document.getElementById('rdp-homegw-peer');
    if (sel && editingId) {
      try {
        var res = await api.get('/api/v1/rdp/' + id);
        if (res && res.ok && res.route && res.route.gateway_peer_id != null) {
          sel.value = String(res.route.gateway_peer_id);
        }
      } catch (e) { /* non-fatal */ }
    }
    var am = document.getElementById('rdp-access-mode');
    if (am) am.dispatchEvent(new Event('change'));
    showWizardStep(1);
  };
  var btnAdd = document.getElementById('btn-add-rdp');
  if (btnAdd) {
    var freshBtn = btnAdd.cloneNode(true);
    btnAdd.parentNode.replaceChild(freshBtn, btnAdd);
    freshBtn.addEventListener('click', function () { openCreateModal(); });
  }

  // Auto-refresh every 60s
  setInterval(function () {
    loadRoutes();
  }, 60000);
})();
