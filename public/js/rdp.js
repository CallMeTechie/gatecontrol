/* global GC, api, GCRdpForm, GCRdpCred */
'use strict';

(function () {
  // ── Aurora theme detector (identical pattern to peers.js / gateways.js) ──────
  function isAurora() { return !!document.querySelector('.app'); }

  var currentView = 'grid';
  var currentFilter = 'all';
  var currentProtoFilter = 'all';
  var searchQuery = '';
  var allRoutes = [];
  var editingId = null;

  // ── Task 6 — adaptive auth step + credential tri-state ──────────────
  // editCredFlags holds the has_* flags returned by the admin detail endpoint
  // (GET /api/v1/rdp/:id with credFlags:true). They are ONLY populated in edit
  // mode and drive (a) the "gesetzt"/"set" hints and (b) THE OMISSION RULE.
  var editCredFlags = {};
  var editBrowserEnabled = false;   // loaded route.browser_enabled → ASCII pre-warning
  var sshAuthMode = 'password';     // ssh auth-mode segment: 'password' | 'key'
  // Fields the admin explicitly asked to wipe via the "remove credential" action.
  // Membership here means we send '' (deliberate clear) instead of omitting.
  var credsToClear = {};
  // Logic field-name → DOM id suffix → has_* flag. Single source of truth for the
  // credential tri-state across hints, the omission rule and the clear action.
  var CRED_FIELDS = {
    username:        { dom: 'rdp-username',        hint: 'rdp-cred-set-username',        flag: 'has_username' },
    password:        { dom: 'rdp-password',        hint: 'rdp-cred-set-password',        flag: 'has_password' },
    ssh_private_key: { dom: 'rdp-ssh-private-key', hint: 'rdp-cred-set-ssh-private-key', flag: 'has_ssh_private_key' },
    ssh_passphrase:  { dom: 'rdp-ssh-passphrase',  hint: 'rdp-cred-set-ssh-passphrase',  flag: 'has_ssh_passphrase' },
  };

  // Protocol → display label / badge class (badge text is protocol-name, same in EN/DE)
  var PROTO_LABELS = { rdp: 'RDP', vnc: 'VNC', ssh: 'SSH', telnet: 'Telnet' };
  var PROTO_BADGE_CLASS = { rdp: 'b-rdp', vnc: 'b-vnc', ssh: 'b-ssh', telnet: 'b-telnet' };

  // DA-2 / CARRY-FORWARD: when access_mode is gateway/external, SFTP and Audio
  // must be blocked COMPLETELY. Hoisted here so applyBrowserFields() can use them
  // at init time (updateAccessModeFields() is called before these would otherwise
  // be reached at their original location ~line 1335).
  var SFTP_BLOCK_IDS  = ['rdp-browser-sftp-row', 'rdp-sftp-locks', 'rdp-sftp-secondary'];
  var AUDIO_BLOCK_IDS = ['rdp-browser-audio-rdp-row', 'rdp-browser-audio-vnc-row', 'rdp-audio-servername-row'];

  function protoOf(r) {
    var p = (r && r.protocol) || 'rdp';
    return PROTO_LABELS[p] ? p : 'rdp';
  }

  // Builds a protocol badge (+ optional "◉ Browser" indicator) for a route.
  function buildProtoBadge(r) {
    var p = protoOf(r);
    var frag = document.createDocumentFragment();
    var badge = document.createElement('span');
    badge.className = 'proto-chip ' + PROTO_BADGE_CLASS[p];
    badge.textContent = PROTO_LABELS[p];
    frag.appendChild(badge);
    if (r && r.browser_enabled) {
      var ind = document.createElement('span');
      ind.className = 'browser-ind';
      ind.textContent = '◉ ' + (GC.t['rdp.badge.browser'] || 'Browser');
      frag.appendChild(ind);
    }
    return frag;
  }

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
      if (currentProtoFilter !== 'all' && protoOf(r) !== currentProtoFilter) return false;
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
    if (isAurora()) return auroraRenderGrid(routes);
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
      nameEl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
      var nameText = document.createElement('span');
      nameText.textContent = r.name;
      nameEl.appendChild(nameText);
      nameEl.appendChild(buildProtoBadge(r));
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

      if (r.browser_enabled && GC.features && GC.features.browser_sessions) {
        var browserBtn = document.createElement('button');
        browserBtn.className = 'btn btn-sm btn-primary';
        browserBtn.textContent = GC.t['rdp.browser.open'] || 'Im Browser öffnen';
        (function (id) {
          browserBtn.addEventListener('click', function () {
            window.open('/rdp/' + id + '/session', '_blank', 'noopener');
          });
        }(r.id));
        actions.appendChild(browserBtn);
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

      // Name + protocol badge / browser indicator
      var tdName = document.createElement('td');
      tdName.style.cssText = 'font-weight:600;color:var(--text-1)';
      var nameWrap = document.createElement('div');
      nameWrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
      var nameSpan = document.createElement('span');
      nameSpan.textContent = r.name;
      nameWrap.appendChild(nameSpan);
      nameWrap.appendChild(buildProtoBadge(r));
      tdName.appendChild(nameWrap);
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
        if (isAurora()) {
          // Issue 16: Aurora — color + distinct icon, no big text in button
          checkBtn.style.color = result.online ? 'var(--green)' : 'var(--red)';
          checkBtn.title = result.online ? (GC.t['rdp.online'] || 'Online') : (GC.t['rdp.offline'] || 'Offline');
          checkBtn.innerHTML = result.online
            ? '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><circle cx="12" cy="12" r="10"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          checkBtn.textContent = result.online ? 'Online' : 'Offline';
          checkBtn.style.color = result.online ? 'var(--success)' : 'var(--danger)';
        }
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

  // Protocol filter (All / RDP / VNC / SSH / Telnet)
  var protocolFilter = document.getElementById('rdp-protocol-filter');
  if (protocolFilter) {
    protocolFilter.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-protocol-filter]');
      if (!btn) return;
      currentProtoFilter = btn.dataset.protocolFilter;
      protocolFilter.querySelectorAll('.btn').forEach(function (b) { b.classList.remove('active'); });
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

  // Credential mode toggle + adaptive auth-step visibility (Task 6).
  var credMode = document.getElementById('rdp-credential-mode');
  if (credMode) {
    credMode.addEventListener('change', updateAuthFields);
  }

  // Adaptive auth step: decides which credential controls are visible for the
  // current protocol + credential_mode + ssh auth-mode, and refreshes the
  // "set"/"gesetzt" hints and the ASCII pre-warning.
  function updateAuthFields() {
    var mode = credMode ? credMode.value : 'none';
    var isSsh = currentProtocol === 'ssh';
    var credsOn = mode !== 'none';

    var fields = document.getElementById('rdp-cred-fields');
    if (fields) fields.style.display = credsOn ? '' : 'none';

    var seg = document.getElementById('rdp-ssh-auth-mode');
    if (seg) seg.style.display = (isSsh && credsOn) ? '' : 'none';

    // Password visible: rdp/vnc → only 'full'; ssh → only in password auth-mode;
    // telnet → whenever creds are on (optional user/pass).
    var pwGroup = document.getElementById('rdp-password-group');
    if (pwGroup) {
      var showPw = credsOn && (isSsh ? (sshAuthMode === 'password')
        : (currentProtocol === 'telnet' ? true : mode === 'full'));
      pwGroup.style.display = showPw ? '' : 'none';
    }

    var keyGroup = document.getElementById('rdp-ssh-key-group');
    if (keyGroup) keyGroup.style.display = (isSsh && credsOn && sshAuthMode === 'key') ? '' : 'none';

    updateCredSetHints();
    updateAsciiHint();
  }

  // Render the protocol-scoped "set"/"gesetzt" hint on each credential field.
  // A hint shows only in edit mode, only when the stored value exists (has_*),
  // and only while its field is actually visible (so ssh hints never leak onto
  // rdp). When the admin has armed "remove credential" the hint flips to the
  // will-be-removed state with an undo ("keep") action.
  // Logical (DOM-independent) visibility of a credential field for the current
  // protocol / credential_mode / ssh auth-mode — mirrors updateAuthFields so it
  // works even before the modal is shown (offsetParent would be null then).
  function credFieldVisible(field) {
    var mode = credMode ? credMode.value : 'none';
    if (mode === 'none') return false;
    var isSsh = currentProtocol === 'ssh';
    if (field === 'username') return true;
    if (field === 'password') {
      return isSsh ? (sshAuthMode === 'password')
        : (currentProtocol === 'telnet' ? true : mode === 'full');
    }
    if (field === 'ssh_private_key' || field === 'ssh_passphrase') {
      return isSsh && sshAuthMode === 'key';
    }
    return false;
  }

  function updateCredSetHints() {
    Object.keys(CRED_FIELDS).forEach(function (field) {
      var cfg = CRED_FIELDS[field];
      var hint = document.getElementById(cfg.hint);
      if (!hint) return;
      var stored = !!(editingId && editCredFlags[cfg.flag]);
      if (!stored || !credFieldVisible(field)) { hint.style.display = 'none'; return; }
      hint.style.display = '';
      var label = hint.querySelector('.rdp-cred-set-label');
      var btn = hint.querySelector('.rdp-cred-remove');
      if (credsToClear[field]) {
        hint.classList.add('is-clearing');
        if (label) label.textContent = (GC.t && GC.t['rdp.cred.will_remove']) || 'will be removed on save';
        if (btn) btn.textContent = (GC.t && GC.t['rdp.cred.keep']) || 'Keep';
      } else {
        hint.classList.remove('is-clearing');
        if (label) label.textContent = (GC.t && GC.t['rdp.cred.set']) || 'set';
        if (btn) btn.textContent = (GC.t && GC.t['rdp.cred.remove']) || 'Remove';
      }
    });
  }

  // ASCII pre-warning: shown when the loaded route is browser-enabled (the
  // authoritative ASCII check stays server-side in validatePhase2bRoute).
  function updateAsciiHint() {
    var el = document.getElementById('rdp-ascii-hint');
    if (!el) return;
    var credsOn = credMode && credMode.value !== 'none';
    el.style.display = (editBrowserEnabled && credsOn) ? '' : 'none';
  }

  // SSH auth-mode segment (Password | Private key)
  var sshAuthSeg = document.getElementById('rdp-ssh-auth-seg');
  if (sshAuthSeg) {
    sshAuthSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-auth-mode]');
      if (!btn) return;
      e.preventDefault();
      sshAuthMode = btn.dataset.authMode === 'key' ? 'key' : 'password';
      sshAuthSeg.querySelectorAll('[data-auth-mode]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.authMode === sshAuthMode);
      });
      updateAuthFields();
    });
  }

  // "Remove credential" / "Keep" toggle — the ONLY way to send '' (deliberate
  // clear). Without it an empty+has_* field is omitted (kept), never wiped.
  var credFieldsContainer = document.getElementById('rdp-cred-fields');
  if (credFieldsContainer) {
    credFieldsContainer.addEventListener('click', function (e) {
      var btn = e.target.closest('.rdp-cred-remove');
      if (!btn) return;
      e.preventDefault();
      var field = btn.dataset.cred;
      if (!field) return;
      if (credsToClear[field]) delete credsToClear[field];
      else credsToClear[field] = true;
      updateCredSetHints();
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

    var hostHint = document.getElementById('rdp-host-hint');
    if (hostHint && window.GC && GC.t) {
      hostHint.textContent = (mode === 'gateway')
        ? (GC.t['rdp.host_hint.gateway'] || hostHint.textContent)
        : (GC.t['rdp.host_hint.default'] || hostHint.textContent);
    }

    // DA-2: access-mode changes re-evaluate the browser-step SFTP/Audio lock.
    applyBrowserFields();
  }

  if (accessMode) {
    accessMode.addEventListener('change', updateAccessModeFields);
    updateAccessModeFields();
  }

  // Browser-access entry toggle: recompute the step model so the dedicated
  // "Browser access" step appears/disappears, then re-render the wizard.
  var browserEnabledEl = document.getElementById('rdp-browser-enabled');
  if (browserEnabledEl) {
    browserEnabledEl.addEventListener('change', function () {
      currentSteps = GCRdpForm.stepsForProtocol(currentProtocol, { browserEnabled: browserEnabledEl.checked });
      applyBrowserFields();
      showWizardStep(Math.min(currentWizardStep, currentSteps.length));
    });
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
      var am = document.getElementById('rdp-access-mode');
      if (am && am.value === 'gateway') { suggestions.style.display = 'none'; return; }
      var peers = await fetchPeers();
      if (am && am.value === 'gateway') { suggestions.style.display = 'none'; return; }
      var filtered = filterPeers(peers, this.value);
      showSuggestions(filtered);
    });

    hostInput.addEventListener('focus', async function () {
      var am = document.getElementById('rdp-access-mode');
      if (am && am.value === 'gateway') { suggestions.style.display = 'none'; return; }
      if (this.value) {
        var peers = await fetchPeers();
        if (am && am.value === 'gateway') { suggestions.style.display = 'none'; return; }
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
    // Fresh form → no stored credentials, no pending clears, password auth-mode.
    editCredFlags = {};
    editBrowserEnabled = false;
    credsToClear = {};
    sshAuthMode = 'password';
    var sshSeg = document.getElementById('rdp-ssh-auth-seg');
    if (sshSeg) sshSeg.querySelectorAll('[data-auth-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.authMode === 'password');
    });
    var storedBanner = document.getElementById('rdp-cred-stored-banner');
    if (storedBanner) storedBanner.style.display = 'none';
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
      // Task 6 tri-state: stored secrets are NEVER returned to the client.
      // Credential fields render EMPTY; the has_* flags from the admin detail
      // endpoint drive the "gesetzt"/"set" hints AND the omission rule on save.
      // Leaving a field empty keeps the stored value; only typing replaces it.
      editCredFlags = {
        has_username: !!r.has_username,
        has_password: !!r.has_password,
        has_ssh_private_key: !!r.has_ssh_private_key,
        has_ssh_passphrase: !!r.has_ssh_passphrase,
        has_sftp_password: !!r.has_sftp_password,
        has_sftp_private_key: !!r.has_sftp_private_key,
        has_sftp_passphrase: !!r.has_sftp_passphrase,
      };
      editBrowserEnabled = !!r.browser_enabled;
      credsToClear = {};
      // ssh auth-mode: default to key when a key is stored but no password.
      sshAuthMode = (r.protocol === 'ssh' && r.has_ssh_private_key && !r.has_password) ? 'key' : 'password';
      var sshSeg = document.getElementById('rdp-ssh-auth-seg');
      if (sshSeg) sshSeg.querySelectorAll('[data-auth-mode]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.authMode === sshAuthMode);
      });
      var storedBanner = document.getElementById('rdp-cred-stored-banner');
      if (storedBanner) storedBanner.style.display = 'none';
      document.getElementById('rdp-username').value = '';
      document.getElementById('rdp-password').value = '';
      var sshKeyEl = document.getElementById('rdp-ssh-private-key');
      if (sshKeyEl) sshKeyEl.value = '';
      var sshPassEl = document.getElementById('rdp-ssh-passphrase');
      if (sshPassEl) sshPassEl.value = '';
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

      // Browser-access fields (Task 7). Secrets are never returned — sftp secret
      // inputs render empty; has_sftp_* flags drive the "set" hints + omission.
      document.getElementById('rdp-browser-enabled').checked = !!r.browser_enabled;
      document.getElementById('rdp-browser-clipboard').checked = !!r.browser_clipboard;
      document.getElementById('rdp-browser-sftp').checked = !!r.browser_enable_sftp;
      // Secure default: locks default ON (1); only an explicit 0 unlocks transfer.
      document.getElementById('rdp-sftp-disable-download').checked = r.sftp_disable_download !== 0;
      document.getElementById('rdp-sftp-disable-upload').checked = r.sftp_disable_upload !== 0;
      document.getElementById('rdp-sftp-host').value = r.sftp_host || '';
      document.getElementById('rdp-sftp-port').value = r.sftp_port != null ? r.sftp_port : '';
      document.getElementById('rdp-sftp-username').value = r.sftp_username || '';
      document.getElementById('rdp-sftp-password').value = '';
      document.getElementById('rdp-sftp-private-key').value = '';
      document.getElementById('rdp-sftp-passphrase').value = '';
      // rdp audio shown INVERTED: "Audio active" = NOT rdp_disable_audio.
      document.getElementById('rdp-browser-audio-rdp').checked = !r.rdp_disable_audio;
      document.getElementById('rdp-browser-audio-vnc').checked = !!r.browser_enable_audio;
      document.getElementById('rdp-audio-servername').value = r.audio_servername || '';

      // User visibility
      var userIds = [];
      try { userIds = JSON.parse(r.user_ids || '[]'); } catch (e) { /* ignore */ }
      renderUserCheckboxes('rdp-user-ids', Array.isArray(userIds) ? userIds : []);

      // Trigger change events
      credMode.dispatchEvent(new Event('change'));
      resMode.dispatchEvent(new Event('change'));
      accessMode.dispatchEvent(new Event('change'));

      // Hydrate protocol (segment + adaptive steps/fields) WITHOUT clobbering the
      // loaded port — fromUser:false skips the default-port logic.
      selectProtocol(r.protocol || 'rdp', false);

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
      protocol: currentProtocol,
      name: document.getElementById('rdp-name').value,
      description: document.getElementById('rdp-description').value,
      host: document.getElementById('rdp-host').value,
      port: parseInt(document.getElementById('rdp-port').value, 10) || GCRdpForm.defaultPortFor(currentProtocol),
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
      // Credential fields carry their RAW value (empty string when blank) so the
      // omission rule below can tell "left empty" from "typed". Do NOT coerce to
      // null here — that would lose the distinction the omission rule depends on.
      username: document.getElementById('rdp-username').value,
      password: document.getElementById('rdp-password').value,
      ssh_private_key: (document.getElementById('rdp-ssh-private-key') || {}).value || '',
      ssh_passphrase: (document.getElementById('rdp-ssh-passphrase') || {}).value || '',
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
      // WoL is not supported for ssh/telnet (server rejects it) — force off.
      wol_enabled: (currentProtocol === 'ssh' || currentProtocol === 'telnet')
        ? false : document.getElementById('rdp-wol-enabled').checked,
      wol_mac_address: (document.getElementById('rdp-wol-mac').value || '').trim() || null,
      maintenance_enabled: document.getElementById('rdp-maintenance-enabled').checked,
      health_check_enabled: document.getElementById('rdp-health-check').checked,
      credential_rotation_enabled: document.getElementById('rdp-credential-rotation-enabled').checked,
      credential_rotation_days: parseInt(document.getElementById('rdp-rotation-days').value, 10) || 90,
      notes: document.getElementById('rdp-notes').value || null,
      tags: document.getElementById('rdp-tags').value ? document.getElementById('rdp-tags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : null,
    };

    // ── Browser-access fields (Task 7) ─────────────────────────────────
    // Curated + advanced. DA-2: when access_mode is gateway/external, SFTP and
    // Audio are forced OFF/null here too (defence-in-depth beyond the UI lock),
    // so a gateway route can never persist SFTP or audio even if the DOM lock
    // were bypassed.
    (function applyBrowserPayload() {
      var browserOn = (document.getElementById('rdp-browser-enabled') || {}).checked || false;
      var am = data.access_mode;
      var internal = !(am === 'gateway' || am === 'external');
      var isRdp = currentProtocol === 'rdp', isVnc = currentProtocol === 'vnc';
      var rdpvnc = isRdp || isVnc;
      var sftpProto = rdpvnc || currentProtocol === 'ssh';      // telnet → no SFTP
      var secondaryOn = browserOn && internal && rdpvnc;        // secondary host/creds

      data.browser_enabled = browserOn;
      data.browser_clipboard = browserOn ? document.getElementById('rdp-browser-clipboard').checked : false;
      // SFTP only when browser on, protocol supports it, AND internal (DA-2).
      data.browser_enable_sftp = (browserOn && internal && sftpProto)
        ? document.getElementById('rdp-browser-sftp').checked : false;
      // Transfer locks — secure default ON; persisted as 0/1.
      data.sftp_disable_download = document.getElementById('rdp-sftp-disable-download').checked ? 1 : 0;
      data.sftp_disable_upload = document.getElementById('rdp-sftp-disable-upload').checked ? 1 : 0;
      // Secondary SFTP target/creds — rdp/vnc + internal only; else null.
      // (serializeForm additionally nulls all sftp_* when switching to ssh/telnet.)
      data.sftp_host = secondaryOn ? (document.getElementById('rdp-sftp-host').value || null) : null;
      data.sftp_port = (secondaryOn && document.getElementById('rdp-sftp-port').value)
        ? parseInt(document.getElementById('rdp-sftp-port').value, 10) : null;
      data.sftp_username = secondaryOn ? (document.getElementById('rdp-sftp-username').value || null) : null;
      // Secret fields carry their RAW value; the omission rule below decides keep/clear.
      data.sftp_password = secondaryOn ? document.getElementById('rdp-sftp-password').value : '';
      data.sftp_private_key = secondaryOn ? document.getElementById('rdp-sftp-private-key').value : '';
      data.sftp_passphrase = secondaryOn ? document.getElementById('rdp-sftp-passphrase').value : '';
      // Audio. rdp: "Audio active" checkbox → rdp_disable_audio is its INVERSE.
      data.rdp_disable_audio = (isRdp && browserOn && internal)
        ? (document.getElementById('rdp-browser-audio-rdp').checked ? 0 : 1) : null;
      data.browser_enable_audio = (isVnc && browserOn && internal)
        ? document.getElementById('rdp-browser-audio-vnc').checked : false;
      data.audio_servername = (isVnc && browserOn && internal
        && document.getElementById('rdp-browser-audio-vnc').checked)
        ? (document.getElementById('rdp-audio-servername').value || null) : null;
    })();

    // User visibility
    var selectedUserIds = [];
    document.querySelectorAll('.rdp-user-cb:checked').forEach(function (cb) {
      selectedUserIds.push(parseInt(cb.value, 10));
    });
    data.user_ids = selectedUserIds.length > 0 ? selectedUserIds : null;

    // ── THE UNMODIFIED-CREDENTIAL OMISSION RULE (Chain H4 — CRITICAL) ──────
    // Must run BEFORE serializeForm. See applyUnmodifiedCredentialOmission.
    applyUnmodifiedCredentialOmission(data);

    // Same omission rule for the secondary SFTP secrets (Task 7). The shared
    // GCRdpCred module intentionally only covers the four ssh/login secrets, so
    // the three sftp secrets are handled here: an empty field whose stored value
    // exists (has_sftp_* true) is OMITTED so update() keeps the encrypted column;
    // a present-but-empty value would WIPE it. serializeForm still nulls them on
    // a switch to ssh/telnet (DA-8). Create mode (no editingId) never omits.
    [['sftp_password', 'has_sftp_password'],
     ['sftp_private_key', 'has_sftp_private_key'],
     ['sftp_passphrase', 'has_sftp_passphrase']].forEach(function (pair) {
      var v = data[pair[0]];
      if ((v === '' || v === null || v === undefined) && editingId && editCredFlags[pair[1]]) {
        delete data[pair[0]];
      }
    });

    // Null out fields meaningless in the chosen protocol (domain for non-rdp,
    // ssh-key for non-ssh, etc.). Shared username/password are never touched.
    data = GCRdpForm.serializeForm(data);

    try {
      var result = editingId
        ? await api.patch('/api/v1/rdp/' + editingId, data)
        : await api.post('/api/v1/rdp', data);
      // Validation/conflict errors (400/403/409/429) come back as data with
      // ok:false instead of throwing — surface them instead of silently
      // closing the modal as if the save had succeeded.
      if (result && result.ok === false) {
        var fields = result.fields || {};
        // DA-6 Stored-Secret banner: a server error on a credential the admin
        // left EMPTY (so it was omitted and kept) is otherwise an unresolvable
        // field message — surface a route-level banner telling them to re-enter.
        var storedInvalid = Object.keys(fields).some(function (f) {
          var cfg = CRED_FIELDS[f];
          if (!cfg) return false;
          return editingId && editCredFlags[cfg.flag] && !(f in data) && !credsToClear[f];
        });
        var banner = document.getElementById('rdp-cred-stored-banner');
        if (banner) banner.style.display = storedInvalid ? '' : 'none';
        if (storedInvalid) {
          var authPos = currentSteps.indexOf('auth');
          if (authPos !== -1) showWizardStep(authPos + 1);
          return;
        }
        var msg = result.error || 'Failed to save RDP route';
        var firstField = Object.keys(fields)[0];
        if (firstField) msg = fields[firstField];
        alert(msg);
        return;
      }
      closeRdpModal();
      loadRoutes();
    } catch (err) {
      alert(err.message || 'Failed to save RDP route');
    }
  });

  // THE UNMODIFIED-CREDENTIAL OMISSION RULE (Chain H4 — CRITICAL, named invariant).
  // Delegates to the standalone, unit-tested GCRdpCred module (loaded before this
  // script) so the production code path and tests/rdp_cred_omission.test.js drive
  // the EXACT same logic. A credential field shown EMPTY whose stored value exists
  // (has_* true) is OMITTED entirely from the patch so update() keeps the column;
  // a present-but-empty value would WIPE the stored secret via encryptCredentials.
  // Foreign-to-protocol cred fields are intentionally NOT protected here; the
  // subsequent serializeForm nulls them (DA-8 switch-clear). Create mode is exempt.
  function applyUnmodifiedCredentialOmission(data) {
    GCRdpCred.applyUnmodifiedCredentialOmission(data, {
      editingId: editingId,
      editCredFlags: editCredFlags,
      credsToClear: credsToClear,
    });
  }

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

  // ─── Wizard navigation (protocol-adaptive, KEY-DRIVEN) ──────────────
  // The create/edit modal is laid out as a wizard. Each panel carries a
  // data-step-key (connection/auth/experience/security/wol/access) AND the
  // legacy data-wizard-step number (kept for CSS only). Navigation is driven
  // by currentSteps = GCRdpForm.stepsForProtocol(p): an array of the keys
  // that apply to the chosen protocol, IN ORDER. ssh/telnet omit 'experience',
  // so the wizard compacts (display position 3 becomes 'security').
  var currentProtocol = 'rdp';
  var currentSteps = GCRdpForm.stepsForProtocol('rdp');
  var currentWizardStep = 1;

  // Logic-field name → DOM container id (only fields that exist in this phase;
  // ssh-key/audio/sftp fields arrive in later tasks and are skipped gracefully).
  var FIELD_DOM = { domain: 'rdp-domain-field', wol: 'rdp-wol-section' };

  // Apply protocol-specific field visibility via GCRdpForm.visibleFieldsFor.
  // Panels (elements with data-wizard-step) are only TAGGED via data-proto-hidden
  // so showWizardStep stays the single authority over panel display; non-panel
  // containers are toggled directly.
  function applyProtocolFields() {
    var state = {
      accessMode: (document.getElementById('rdp-access-mode') || {}).value,
      credentialMode: (document.getElementById('rdp-credential-mode') || {}).value,
    };
    var vis = GCRdpForm.visibleFieldsFor(currentProtocol, state);
    Object.keys(FIELD_DOM).forEach(function (field) {
      var el = document.getElementById(FIELD_DOM[field]);
      if (!el) return;
      var show = !!vis[field];
      var isPanel = el.hasAttribute('data-wizard-step');
      if (show) {
        el.removeAttribute('data-proto-hidden');
        if (!isPanel) el.style.display = '';
      } else {
        el.setAttribute('data-proto-hidden', '1');
        el.style.display = 'none';
      }
    });
  }

  // ── Browser-access step (Task 7) ───────────────────────────────────
  // True when the browser-access entry toggle is on. Drives whether the
  // 'browser' step is part of currentSteps (stepsForProtocol inserts it).
  function browserEnabled() {
    var el = document.getElementById('rdp-browser-enabled');
    return !!(el && el.checked);
  }
  function _isGatewayish(m) { return m === 'gateway' || m === 'external'; }
  function _setDisplay(id, show) {
    var el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }
  // Lock a control group: dim it AND disable every contained input (so the
  // value can't be edited and won't be picked up by tab/keyboard either).
  function _setGroupLocked(id, locked) {
    var c = document.getElementById(id);
    if (!c) return;
    c.classList.toggle('rdp-browser-blocked', locked);
    c.querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = locked; });
  }

  // Adapt the browser step to protocol + access_mode + toggle state.
  function applyBrowserFields() {
    var on = browserEnabled();
    var amEl = document.getElementById('rdp-access-mode');
    var internal = !_isGatewayish(amEl && amEl.value);
    var p = currentProtocol;
    var isRdp = p === 'rdp', isVnc = p === 'vnc', rdpvnc = isRdp || isVnc;

    var reveal = document.getElementById('rdp-browser-reveal');
    if (reveal) reveal.style.display = on ? '' : 'none';

    // Per-protocol presence (independent of the gateway lock)
    _setDisplay('rdp-browser-sftp-row', on && p !== 'telnet');     // ssh native / rdp-vnc secondary
    _setDisplay('rdp-sftp-secondary', on && rdpvnc);               // secondary host/port/creds: rdp/vnc only
    _setDisplay('rdp-sftp-locks', on && p !== 'telnet');
    _setDisplay('rdp-browser-audio-rdp-row', on && isRdp);         // rdp_disable_audio (inverted)
    _setDisplay('rdp-browser-audio-vnc-row', on && isVnc);         // browser_enable_audio
    _setDisplay('rdp-audio-servername-row', on && isVnc);

    // SFTP mode hint text (native over SSH vs secondary connection)
    var modeHint = document.getElementById('rdp-browser-sftp-mode-hint');
    if (modeHint) {
      modeHint.textContent = p === 'ssh'
        ? '— ' + (GC.t['rdp.browser.sftp_native'] || 'native over SSH')
        : '— ' + (GC.t['rdp.browser.sftp_secondary'] || 'secondary connection');
    }

    // DA-2 gateway/external lock — block ALL sftp + audio controls.
    var blocked = on && !internal;
    SFTP_BLOCK_IDS.forEach(function (id) { _setGroupLocked(id, blocked); });
    AUDIO_BLOCK_IDS.forEach(function (id) { _setGroupLocked(id, blocked); });
    _setDisplay('rdp-browser-gateway-hint', blocked && p !== 'telnet');

    // Stored-secret hints for the secondary SFTP credentials (edit mode only).
    var secondaryOn = on && rdpvnc && internal;
    [['rdp-cred-set-sftp-password', 'has_sftp_password'],
     ['rdp-cred-set-sftp-private-key', 'has_sftp_private_key'],
     ['rdp-cred-set-sftp-passphrase', 'has_sftp_passphrase']].forEach(function (pair) {
      var h = document.getElementById(pair[0]);
      if (h) h.style.display = (secondaryOn && editingId && editCredFlags[pair[1]]) ? '' : 'none';
    });
  }

  // Switch protocol: recompute steps, sync segment UI, adapt fields, set the
  // default port (only if the field still holds the previous default), clamp
  // the current step to the new length and re-render.
  function selectProtocol(p, fromUser) {
    if (!PROTO_LABELS[p]) p = 'rdp';
    var prevDefault = GCRdpForm.defaultPortFor(currentProtocol);
    currentProtocol = p;
    var seg = document.getElementById('rdp-protocol-seg');
    if (seg) seg.querySelectorAll('[data-protocol]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.protocol === p);
    });
    if (fromUser) {
      var portEl = document.getElementById('rdp-port');
      if (portEl) {
        var cur = (portEl.value || '').trim();
        if (cur === '' || parseInt(cur, 10) === prevDefault) {
          portEl.value = GCRdpForm.defaultPortFor(p);
        }
      }
    }
    currentSteps = GCRdpForm.stepsForProtocol(p, { browserEnabled: browserEnabled() });
    applyProtocolFields();
    applyBrowserFields();
    updateAuthFields();
    showWizardStep(Math.min(currentWizardStep, currentSteps.length));
  }

  function showWizardStep(n) {
    currentWizardStep = Math.max(1, Math.min(currentSteps.length, n));
    var modal = document.getElementById('rdp-modal');
    if (!modal) return;
    var activeKey = currentSteps[currentWizardStep - 1];

    // Show panel(s) whose key === activeKey (unless protocol-hidden), hide rest.
    modal.querySelectorAll('[data-wizard-step]').forEach(function (el) {
      var key = el.getAttribute('data-step-key');
      var protoHidden = el.getAttribute('data-proto-hidden') === '1';
      el.style.display = (key === activeKey && !protoHidden) ? '' : 'none';
    });

    // Dots: only those whose key is in currentSteps are shown; active/done by
    // position within currentSteps (NOT by the static pill number).
    modal.querySelectorAll('.rdp-step-dot').forEach(function (d) {
      var pos = currentSteps.indexOf(d.getAttribute('data-step-key')); // -1 = omitted
      d.classList.remove('active', 'done');
      if (pos === -1) { d.style.display = 'none'; return; }
      d.style.display = '';
      // Number the dot by its compacted position (mockup behaviour) so an
      // inserted/omitted step never leaves a gap or duplicate in the bar.
      d.textContent = String(pos + 1);
      // Keep the hover tooltip in sync with the compacted position (the static
      // template title can't be right for both browser-on and browser-off).
      d.title = (pos + 1) + ' · ' + (d.getAttribute('data-label') || '');
      if (pos + 1 === currentWizardStep) d.classList.add('active');
      else if (pos + 1 < currentWizardStep) d.classList.add('done');
    });

    // Lines: each carries the key of the dot it precedes. Hide the line of an
    // omitted step so the bar compacts; mark done once we're at/past that dot.
    modal.querySelectorAll('.rdp-step-line').forEach(function (line) {
      var pos = currentSteps.indexOf(line.getAttribute('data-step-key'));
      line.classList.remove('done');
      if (pos === -1) { line.style.display = 'none'; return; }
      line.style.display = '';
      if (currentWizardStep >= pos + 1) line.classList.add('done');
    });

    // Sub-title: "Step X of N" — N = currentSteps.length (compacted total).
    var sub = document.getElementById('rdp-modal-subtitle');
    if (sub) {
      var tpl = GC.t['rdp.wizard.step_of'] || 'Step {{current}} of {{total}}';
      sub.textContent = tpl
        .replace('{{current}}', String(currentWizardStep))
        .replace('{{total}}', String(currentSteps.length));
    }

    // Step title next to the counter — pulled from the active dot's data-label
    var stepTitle = document.getElementById('rdp-modal-steptitle');
    if (stepTitle) {
      var activeDot = modal.querySelector('.rdp-step-dot[data-step-key="' + activeKey + '"]');
      stepTitle.textContent = activeDot ? (activeDot.getAttribute('data-label') || '') : '';
    }

    // Nav-button visibility
    var prev = document.getElementById('rdp-wizard-prev');
    var next = document.getElementById('rdp-wizard-next');
    var save = document.getElementById('rdp-modal-save');
    if (prev) prev.style.display = currentWizardStep > 1 ? '' : 'none';
    if (next) next.style.display = currentWizardStep < currentSteps.length ? '' : 'none';
    if (save) save.style.display = currentWizardStep === currentSteps.length ? '' : 'none';

    // Refresh the credential hints once the auth panel is actually visible
    // (they can't be computed reliably while the modal is still hidden).
    if (activeKey === 'auth') updateCredSetHints();

    if (currentWizardStep === currentSteps.length) renderWizardReview();
  }

  // Protocol segment-control click
  var protoSeg = document.getElementById('rdp-protocol-seg');
  if (protoSeg) {
    protoSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-protocol]');
      if (!btn) return;
      e.preventDefault();
      var target = btn.dataset.protocol;
      // Step 6: warn before a switch that would clear a field with content
      // (typed or stored). username/password are protocol-shared → never cleared.
      if (target !== currentProtocol && wouldClearSetFieldsOnSwitch(target)) {
        if (!window.confirm(GC.t['rdp.proto_switch_confirm']
          || 'Switching protocol clears settings that do not apply to the new protocol. Continue?')) return;
      }
      selectProtocol(target, true);
    });
  }

  // A credential is "satisfied" if the admin typed a value OR a value is already
  // stored (has_*) and not armed for removal — mirrors the omission rule so the
  // inline pre-validation never blocks an unchanged-but-set credential.
  function credSatisfied(field) {
    var cfg = CRED_FIELDS[field];
    var el = cfg && document.getElementById(cfg.dom);
    if (el && (el.value || '').trim()) return true;
    return !!(editingId && cfg && editCredFlags[cfg.flag] && !credsToClear[field]);
  }

  // Foreign-field → DOM id / has_* flag (only fields that exist this phase).
  // sftp_* arrive in Task 7 and are skipped gracefully.
  var SWITCH_DOM = { domain: 'rdp-domain', ssh_private_key: 'rdp-ssh-private-key', ssh_passphrase: 'rdp-ssh-passphrase' };
  var SWITCH_FLAG = { ssh_private_key: 'has_ssh_private_key', ssh_passphrase: 'has_ssh_passphrase' };

  // True if switching to `target` would clear a field that currently holds
  // content — either a typed DOM value or a stored secret (edit + has_*).
  function wouldClearSetFieldsOnSwitch(target) {
    return GCRdpForm.foreignFieldsOnSwitch(target).some(function (f) {
      var domId = SWITCH_DOM[f];
      var el = domId ? document.getElementById(domId) : null;
      if (el && (el.value || '').trim()) return true;
      var flag = SWITCH_FLAG[f];
      return !!(flag && editingId && editCredFlags[flag]);
    });
  }

  function validateWizardStep(n) {
    var key = currentSteps[n - 1];
    if (key === 'connection') {
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
    // Auth step — inline pre-validation (UX only; backend stays authoritative).
    // credential_mode 'none' suppresses all required-field UX (Chain M3).
    if (key === 'auth' && currentProtocol === 'ssh') {
      var mode = (document.getElementById('rdp-credential-mode') || {}).value;
      if (mode !== 'none') {
        if (!credSatisfied('username')) {
          alert(GC.t['rdp.auth.username_required'] || 'Username is required'); return false;
        }
        if (!credSatisfied('password') && !credSatisfied('ssh_private_key')) {
          alert(GC.t['rdp.auth.password_or_key'] || 'Enter a password or a private key'); return false;
        }
        var passVal = (document.getElementById('rdp-ssh-passphrase') || {}).value || '';
        if (passVal.trim() && !credSatisfied('ssh_private_key')) {
          alert(GC.t['rdp.auth.passphrase_needs_key'] || 'A passphrase requires a private key'); return false;
        }
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
        // Jump by position within currentSteps, not the static pill number.
        var pos = currentSteps.indexOf(dot.getAttribute('data-step-key'));
        if (pos !== -1) showWizardStep(pos + 1);
      });
    }
  })();

  // Hook the wizard into openCreateModal / openEditModal so each open
  // starts at step 1 with a fresh peer dropdown.
  var originalOpenCreateModal = openCreateModal;
  openCreateModal = function () {
    originalOpenCreateModal();
    var amEl = document.getElementById('rdp-access-mode');
    if (amEl) amEl.dispatchEvent(new Event('change'));
    // Fresh route → reset to RDP defaults (segment + steps + fields + port 3389).
    selectProtocol('rdp', false);
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

  // ── Aurora theme — card grid (theme-branched sibling of renderGrid()) ─────────
  // Emits .grid > .card.span6 structure per mockup (2026-06-21).
  // All action data-* attributes from the default renderGrid() are preserved.
  // Added: Session-Verlauf (.btn-block) targeting #modal-peer-traffic.
  function auroraRenderGrid(routes) {
    grid.textContent = '';
    if (routes.length === 0) {
      grid.style.cssText = 'font-size:13px;color:var(--muted);padding:20px 0;text-align:center';
      grid.textContent = GC.t['rdp.no_routes'] || 'No RDP routes configured';
      return;
    }
    grid.style.cssText = '';
    // Issue 12: use unit-grid-style auto-fill grid so cards are consistently sized
    // (not stretched span6 in 12-col grid like other Aurora pages)
    var container = document.createElement('div');
    container.className = 'rdp-card-grid';

    // Monitor SVG (matches mockup card-title icon)
    var MONITOR_SVG = '<svg viewBox="0 0 24 24" fill="none" width="15" height="15"><rect x="2" y="4" width="20" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    routes.forEach(function (r) {
      var isOnline = r.status && r.status.online;
      var isMaintenance = r.maintenance_enabled;

      // Issue 12: plain .card (no span6), sized by the .rdp-card-grid container
      var card = document.createElement('div');
      card.className = 'card';

      // Card title: monitor icon + [name+proto group] + status badge (Issue 13: badge inside header)
      var cardTitle = document.createElement('div');
      cardTitle.className = 'card-title';
      var ic = document.createElement('span');
      ic.className = 'ic';
      ic.innerHTML = MONITOR_SVG;
      cardTitle.appendChild(ic);
      // nameGroup wraps name + proto so they shrink together, leaving room for statusTag
      var nameGroup = document.createElement('span');
      nameGroup.style.cssText = 'flex:1;min-width:0;display:inline-flex;align-items:center;gap:6px;overflow:hidden';
      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nameSpan.textContent = r.name;
      nameGroup.appendChild(nameSpan);
      // Proto badge alongside name (flex-shrink:0 keeps it fully visible)
      var protoBadgeWrap = document.createElement('span');
      protoBadgeWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;font-family:var(--font-body);color:var(--faint);flex-shrink:0';
      protoBadgeWrap.appendChild(buildProtoBadge(r));
      nameGroup.appendChild(protoBadgeWrap);
      cardTitle.appendChild(nameGroup);
      // Issue 13: status badge inside card header, text LEFT of dot (uses .tag.tag-dot::after)
      // margin-left:auto pushes badge to the right within the card title flex row
      var statusTag = document.createElement('span');
      if (isOnline) {
        statusTag.className = 'tag tag-green tag-dot';
        statusTag.textContent = GC.t['rdp.health_reachable'] || 'Reachable';
      } else if (isMaintenance) {
        statusTag.className = 'tag tag-amber tag-dot';
        statusTag.textContent = GC.t['rdp.health_checking'] || 'Checking…';
      } else {
        statusTag.className = 'tag tag-red tag-dot';
        statusTag.textContent = GC.t['rdp.offline'] || 'Offline';
      }
      statusTag.style.marginLeft = 'auto';
      cardTitle.appendChild(statusTag);
      card.appendChild(cardTitle);

      // KV rows: Mode / Target (Health removed from kv — now in header as Issue 13)
      var kv = document.createElement('div');
      kv.className = 'kv';

      // Mode row
      var modeRow = document.createElement('div');
      modeRow.className = 'row';
      var modeK = document.createElement('span');
      modeK.className = 'k';
      modeK.textContent = GC.t['rdp.kv.mode'] || 'Mode';
      var modeV = document.createElement('span');
      modeV.className = 'v';
      var accessMode = r.access_mode || 'internal';
      modeV.textContent = GC.t['rdp.access_mode.' + accessMode] || accessMode;
      modeRow.appendChild(modeK);
      modeRow.appendChild(modeV);
      kv.appendChild(modeRow);

      // Target row (host:port)
      var targetRow = document.createElement('div');
      targetRow.className = 'row';
      var targetK = document.createElement('span');
      targetK.className = 'k';
      targetK.textContent = GC.t['rdp.kv.target'] || 'Target';
      var targetV = document.createElement('span');
      targetV.className = 'v';
      targetV.textContent = (r.host || '') + ':' + (r.port || 3389);
      targetRow.appendChild(targetK);
      targetRow.appendChild(targetV);
      kv.appendChild(targetRow);

      card.appendChild(kv);

      // Action buttons — ALL actions from default card preserved, as .icon-action set
      var rowActions = document.createElement('div');
      rowActions.className = 'row-actions';
      rowActions.style.marginTop = '12px';

      // WoL (conditional: offline + wol enabled)
      if (!isOnline && r.wol_enabled && r.wol_mac_address) {
        var wolBtn = document.createElement('button');
        wolBtn.className = 'icon-action';
        wolBtn.title = GC.t['rdp.wol_send'] || 'WoL senden';
        wolBtn.dataset.wol = r.id;
        wolBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
        rowActions.appendChild(wolBtn);
      }

      // Disconnect all (conditional: active sessions > 0)
      if (r.active_sessions > 0) {
        var disconnBtn = document.createElement('button');
        disconnBtn.className = 'icon-action';
        disconnBtn.title = GC.t['rdp.disconnect_all'] || 'Alle trennen';
        disconnBtn.dataset.disconnectAll = r.id;
        disconnBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';
        rowActions.appendChild(disconnBtn);
      }

      // Issue 14: browser session button — only when browser access is enabled and licensed.
      // Real mechanism: GET /rdp/:id/session (confirmed in src/routes/index.js line 254).
      if (r.browser_enabled && GC.features && GC.features.browser_sessions) {
        var browserBtn = document.createElement('button');
        browserBtn.className = 'icon-action';
        browserBtn.title = GC.t['rdp.browser.open'] || 'Im Browser öffnen';
        (function (id) {
          browserBtn.addEventListener('click', function () {
            window.open('/rdp/' + id + '/session', '_blank', 'noopener');
          });
        }(r.id));
        browserBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M2 9h20M9 21h6"/></svg>';
        rowActions.appendChild(browserBtn);
      }

      // Edit (always)
      var editBtn = document.createElement('button');
      editBtn.className = 'icon-action';
      editBtn.title = GC.t['rdp.edit'] || 'Bearbeiten';
      editBtn.dataset.edit = r.id;
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6 4 4M4 20l1-4L16 5l3 3L8 19l-4 1Z" stroke-linejoin="round"/></svg>';
      rowActions.appendChild(editBtn);

      // Connection test (always)
      var checkBtn = document.createElement('button');
      checkBtn.className = 'icon-action';
      checkBtn.title = GC.t['rdp.connect_test'] || 'Verbindungstest';
      checkBtn.dataset.check = r.id;
      checkBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>';
      rowActions.appendChild(checkBtn);

      // Delete (always)
      var delBtn = document.createElement('button');
      delBtn.className = 'icon-action danger';
      delBtn.title = GC.t['rdp.delete'] || 'Löschen';
      delBtn.dataset.delete = r.id;
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
      rowActions.appendChild(delBtn);

      card.appendChild(rowActions);


      container.appendChild(card);
    });

    grid.appendChild(container);
  }

})();
