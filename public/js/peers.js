'use strict';

(function () {
  const tbody = document.getElementById('peers-tbody');
  const searchInput = document.getElementById('peer-search');
  const statusTags = document.getElementById('peer-status-tags');
  const tagFilters = document.getElementById('peer-tag-filters');
  const groupFilter = document.getElementById('peer-group-filter');
  let allPeers = [];
  let allGroups = [];
  let activeTagFilter = null;
  let activeGroupFilter = ''; // '' = all, 'ungrouped' = no group, number = group id
  let batchMode = false;
  let batchSelected = new Set();

  // ─── Load peer groups ──────────────────────────────────
  async function loadGroups() {
    try {
      const data = await api.get('/api/peer-groups');
      if (data.ok) {
        allGroups = data.groups;
        renderGroupFilter();
        renderGroupDropdowns();
        renderGroupsList();
      }
    } catch (err) {
      console.error('Failed to load peer groups:', err);
    }
  }

  function getGroupById(id) {
    return allGroups.find(function(g) { return g.id === id; });
  }

  function renderGroupFilter() {
    if (!groupFilter) return;
    var val = groupFilter.value;
    groupFilter.innerHTML = '';

    var optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = GC.t['peer_groups.all'] || 'All';
    groupFilter.appendChild(optAll);

    allGroups.forEach(function(g) {
      var opt = document.createElement('option');
      opt.value = String(g.id);
      opt.textContent = g.name + ' (' + g.peer_count + ')';
      groupFilter.appendChild(opt);
    });

    var ungOpt = document.createElement('option');
    ungOpt.value = 'ungrouped';
    ungOpt.textContent = GC.t['peer_groups.ungrouped'] || 'Ungrouped';
    groupFilter.appendChild(ungOpt);

    groupFilter.value = val;
  }

  function renderGroupDropdowns() {
    ['add-peer-group', 'edit-peer-group'].forEach(function(selectId) {
      var sel = document.getElementById(selectId);
      if (!sel) return;
      var val = sel.value;
      sel.innerHTML = '';

      var optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = GC.t['peer_groups.none'] || 'No group';
      sel.appendChild(optNone);

      allGroups.forEach(function(g) {
        var opt = document.createElement('option');
        opt.value = String(g.id);
        opt.textContent = g.name;
        sel.appendChild(opt);
      });
      sel.value = val;
    });
  }

  // ─── Load peers ──────────────────────────────────────────
  async function loadPeers() {
    try {
      const data = await api.get('/api/peers');
      if (data.ok) {
        allPeers = data.peers;
        applyFilters();
        renderStatusTags(allPeers);
        renderTagFilters(allPeers);
      }
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--red);padding:40px">' +
        escapeHtml(err.message) + '</td></tr>';
    }
  }

  // ─── Render peers table ──────────────────────────────────
  // Note: All user-controlled values are passed through escapeHtml() for XSS safety,
  // following the same pattern used throughout the existing codebase.
  function renderPeers(peers) {
    // Safe: colSpan is a number derived from boolean, no user input
    var colSpan = batchMode ? 8 : 7;
    if (!peers.length) {
      tbody.innerHTML = '<tr><td colspan="' + colSpan + '" style="text-align:center;color:var(--text-3);padding:40px">' + escapeHtml(GC.t['peers.no_peers'] || 'No peers configured') + '</td></tr>';
      return;
    }

    tbody.innerHTML = peers.map(function(p) {
      var ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '\u2014';
      var pubKey = p.public_key ? p.public_key.substring(0, 12) + '\u2026' : '\u2014';
      var lastContact = formatLastContact(p.latestHandshake || p.latest_handshake);
      var rx = formatBytes(p.transferRx || p.transfer_rx || 0);
      var tx = formatBytes(p.transferTx || p.transfer_tx || 0);
      var statusTag = getStatusTag(p);
      var expiryTag = getExpiryTag(p);
      var groupBadge = getGroupBadge(p);
      var peerTags = parseTags(p.tags);
      var tagsHtml = peerTags.map(function(t) { return '<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">' + escapeHtml(t) + '</span>'; }).join('');
      var totalTraffic = (p.total_rx || p.total_tx) ? '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:2px">\u03A3 ' + formatBytes((p.total_rx || 0) + (p.total_tx || 0)) + '</div>' : '';
      // p.id is a numeric DB id, safe for attribute use; checked is a static string
      var checked = batchSelected.has(String(p.id)) ? ' checked' : '';
      var batchTd = batchMode ? '<td class="batch-col"><input type="checkbox" class="batch-checkbox" data-batch-id="' + p.id + '"' + checked + '></td>' : '';

      return '<tr data-peer-id="' + p.id + '">' +
        batchTd +
        '<td>' +
          '<div class="peer-name">' + escapeHtml(p.name) + expiryTag + groupBadge + '</div>' +
          '<div class="peer-meta">' + escapeHtml(p.description || '') + '</div>' +
          (tagsHtml ? '<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">' + tagsHtml + '</div>' : '') +
        '</td>' +
        '<td><span style="font-family:var(--font-mono);font-size:12px">' + escapeHtml(ip) + '</span></td>' +
        '<td><span style="font-family:var(--font-mono);font-size:11px;color:var(--text-2)">' + escapeHtml(pubKey) + '</span></td>' +
        '<td><span style="font-size:12px;color:var(--text-2)">' + lastContact + '</span></td>' +
        '<td>' +
          '<span style="font-family:var(--font-mono);font-size:11px">\u2193' + rx + ' \u2191' + tx + '</span>' +
          totalTraffic +
        '</td>' +
        '<td>' + statusTag + '</td>' +
        '<td>' +
          '<div class="peer-actions">' +
            '<button class="icon-btn" title="Traffic" data-action="traffic" data-id="' + p.id + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' +
            '</button>' +
            '<button class="icon-btn" title="QR Code" data-action="qr" data-id="' + p.id + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>' +
            '</button>' +
            '<button class="icon-btn" title="Edit" data-action="edit" data-id="' + p.id + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            '</button>' +
            '<button class="icon-btn" title="Toggle" data-action="toggle" data-id="' + p.id + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>' +
            '</button>' +
            '<button class="icon-btn" title="Delete" data-action="delete" data-id="' + p.id + '" data-name="' + escapeHtml(p.name) + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
            '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  // ─── Group badge ─────────────────────────────────────────
  function getGroupBadge(peer) {
    if (!peer.group_id) return '';
    var group = getGroupById(peer.group_id);
    if (!group) return '';
    var color = escapeHtml(group.color || '#6b7280');
    return ' <span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 6px;border-radius:9999px;background:' + color + '1a;color:' + color + ';border:1px solid ' + color + '40;margin-left:4px">' +
      '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block"></span>' +
      escapeHtml(group.name) + '</span>';
  }

  // ─── Status tags summary ─────────────────────────────────
  function renderStatusTags(peers) {
    var online = peers.filter(function(p) { return p.isOnline; }).length;
    var offline = peers.filter(function(p) { return !p.isOnline && p.enabled; }).length;
    var disabled = peers.filter(function(p) { return !p.enabled; }).length;

    var html = '';
    if (online > 0) html += '<span class="tag tag-green"><span class="tag-dot"></span>' + online + ' ' + escapeHtml(GC.t['peers.online'] || 'Online') + '</span>';
    if (offline > 0) html += '<span class="tag tag-grey"><span class="tag-dot"></span>' + offline + ' ' + escapeHtml(GC.t['peers.offline'] || 'Offline') + '</span>';
    if (disabled > 0) html += '<span class="tag tag-amber"><span class="tag-dot"></span>' + disabled + ' ' + escapeHtml(GC.t['peers.disabled'] || 'Disabled') + '</span>';
    statusTags.innerHTML = html;
  }

  function getExpiryTag(peer) {
    if (!peer.expires_at) return '';
    var expiresAt = new Date(peer.expires_at);
    var now = new Date();
    var daysLeft = Math.ceil((expiresAt - now) / 86400000);
    var dateStr = expiresAt.toLocaleDateString();

    if (daysLeft < 0) {
      return '<span class="tag tag-red" style="font-size:10px;margin-left:4px">' + escapeHtml(GC.t['peers.expired'] || 'Expired') + '</span>';
    }
    if (daysLeft <= 7) {
      return '<span class="tag tag-amber" style="font-size:10px;margin-left:4px" title="' + escapeHtml(dateStr) + '">' + escapeHtml(GC.t['peers.expires_soon'] || 'Expires soon') + '</span>';
    }
    return '<span class="tag tag-grey" style="font-size:10px;margin-left:4px" title="' + escapeHtml(dateStr) + '">' + escapeHtml(dateStr) + '</span>';
  }

  function getStatusTag(peer) {
    if (!peer.enabled) return '<span class="tag tag-amber"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.disabled'] || 'Disabled') + '</span>';
    if (peer.isOnline) return '<span class="tag tag-green"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.online'] || 'Online') + '</span>';
    return '<span class="tag tag-grey"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.offline'] || 'Offline') + '</span>';
  }

  function formatLastContact(timestamp) {
    if (!timestamp) return '\u2014';
    var ts = typeof timestamp === 'number' ? timestamp * 1000 : new Date(timestamp).getTime();
    if (isNaN(ts) || ts === 0) return '\u2014';
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ─── Tag helpers ────────────────────────────────────────
  function parseTags(tags) {
    if (!tags) return [];
    return tags.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  }

  function renderTagFilters(peers) {
    if (!tagFilters) return;
    var tagSet = new Set();
    peers.forEach(function(p) { parseTags(p.tags).forEach(function(t) { tagSet.add(t); }); });
    var tags = Array.from(tagSet).sort();

    tagFilters.textContent = '';
    if (tags.length === 0) return;

    var allBtn = document.createElement('button');
    allBtn.className = 'tag ' + (!activeTagFilter ? 'tag-blue' : 'tag-grey');
    allBtn.style.cssText = 'cursor:pointer;font-size:11px';
    allBtn.textContent = GC.t['peer_groups.all'] || 'All';
    allBtn.addEventListener('click', function() { activeTagFilter = null; applyFilters(); renderTagFilters(allPeers); });
    tagFilters.appendChild(allBtn);

    tags.forEach(function(tag) {
      var btn = document.createElement('button');
      btn.className = 'tag ' + (activeTagFilter === tag ? 'tag-blue' : 'tag-grey');
      btn.style.cssText = 'cursor:pointer;font-size:11px';
      btn.textContent = tag;
      btn.addEventListener('click', function() { activeTagFilter = tag; applyFilters(); renderTagFilters(allPeers); });
      tagFilters.appendChild(btn);
    });
  }

  function applyFilters() {
    var filtered = allPeers;

    // Group filter
    if (activeGroupFilter === 'ungrouped') {
      filtered = filtered.filter(function(p) { return !p.group_id; });
    } else if (activeGroupFilter) {
      var gid = parseInt(activeGroupFilter, 10);
      filtered = filtered.filter(function(p) { return p.group_id === gid; });
    }

    if (activeTagFilter) {
      filtered = filtered.filter(function(p) { return parseTags(p.tags).includes(activeTagFilter); });
    }
    var q = searchInput.value.toLowerCase().trim();
    if (q) {
      filtered = filtered.filter(function(p) {
        return (p.name && p.name.toLowerCase().includes(q)) ||
          (p.description && p.description.toLowerCase().includes(q)) ||
          (p.allowed_ips && p.allowed_ips.includes(q)) ||
          (p.public_key && p.public_key.toLowerCase().includes(q)) ||
          (p.tags && p.tags.toLowerCase().includes(q));
      });
    }
    renderPeers(filtered);
  }

  // ─── Expiry helpers ──────────────────────────────────────
  function computeExpiresAt(selectId, dateInputId) {
    var sel = document.getElementById(selectId);
    var dateInput = document.getElementById(dateInputId);
    var val = sel.value;
    if (!val) return null;
    if (val === 'custom') {
      if (!dateInput.value) return null;
      return dateInput.value + 'T23:59:59.000Z';
    }
    var days = parseInt(val, 10);
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  function setupExpiryToggle(selectId, dateInputId) {
    var sel = document.getElementById(selectId);
    var dateInput = document.getElementById(dateInputId);
    sel.addEventListener('change', function() {
      dateInput.style.display = sel.value === 'custom' ? '' : 'none';
    });
  }

  setupExpiryToggle('add-peer-expires', 'add-peer-expires-date');
  setupExpiryToggle('edit-peer-expires', 'edit-peer-expires-date');

  // ─── Group filter change ───────────────────────────────
  if (groupFilter) {
    groupFilter.addEventListener('change', function() {
      activeGroupFilter = groupFilter.value;
      applyFilters();
    });
  }

  // ─── Search ──────────────────────────────────────────────
  searchInput.addEventListener('input', function() { applyFilters(); });

  // ─── Table action delegation ─────────────────────────────
  tbody.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;

    var action = btn.dataset.action;
    var id = btn.dataset.id;

    switch (action) {
      case 'traffic': showTrafficModal(id); break;
      case 'qr': showQrModal(id); break;
      case 'edit': showEditModal(id); break;
      case 'toggle': togglePeer(id); break;
      case 'delete': showConfirmDelete(id, btn.dataset.name); break;
    }
  });

  // ─── Add peer ────────────────────────────────────────────
  document.getElementById('btn-add-peer').addEventListener('click', function() {
    document.getElementById('add-peer-name').value = '';
    document.getElementById('add-peer-desc').value = '';
    document.getElementById('add-peer-tags').value = '';
    document.getElementById('add-peer-group').value = '';
    document.getElementById('add-peer-expires').value = '';
    document.getElementById('add-peer-expires-date').value = '';
    document.getElementById('add-peer-expires-date').style.display = 'none';
    hideError('add-peer-error');
    clearFieldErrors();
    renderGroupDropdowns();
    openModal('modal-add-peer');
    document.getElementById('add-peer-name').focus();
  });

  document.getElementById('btn-add-peer-submit').addEventListener('click', async function() {
    var btn = this;
    var name = document.getElementById('add-peer-name').value.trim();
    var description = document.getElementById('add-peer-desc').value.trim();
    var tags = document.getElementById('add-peer-tags').value.trim();
    var group_id = document.getElementById('add-peer-group').value ? parseInt(document.getElementById('add-peer-group').value, 10) : null;

    if (!name) {
      showError('add-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      var expires_at = computeExpiresAt('add-peer-expires', 'add-peer-expires-date');
      var data = await api.post('/api/peers', { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id });
      if (data.ok) {
        clearFieldErrors();
        closeModal('modal-add-peer');
        showQrModal(data.peer.id);
        loadPeers();
        loadGroups();
      } else if (data.fields) {
        showFieldErrors(data.fields, { name: 'add-peer-name', description: 'add-peer-desc' });
      } else {
        showError('add-peer-error', data.error);
      }
    } catch (err) {
      showError('add-peer-error', err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Edit peer ───────────────────────────────────────────
  async function showEditModal(id) {
    var peer = allPeers.find(function(p) { return String(p.id) === String(id); });
    if (!peer) return;

    document.getElementById('edit-peer-id').value = id;
    document.getElementById('edit-peer-name').value = peer.name || '';
    document.getElementById('edit-peer-desc').value = peer.description || '';
    document.getElementById('edit-peer-tags').value = peer.tags || '';

    renderGroupDropdowns();
    document.getElementById('edit-peer-group').value = peer.group_id ? String(peer.group_id) : '';

    var editExpiresSel = document.getElementById('edit-peer-expires');
    var editExpiresDate = document.getElementById('edit-peer-expires-date');
    if (peer.expires_at) {
      editExpiresSel.value = 'custom';
      editExpiresDate.style.display = '';
      editExpiresDate.value = peer.expires_at.substring(0, 10);
    } else {
      editExpiresSel.value = '';
      editExpiresDate.style.display = 'none';
      editExpiresDate.value = '';
    }

    hideError('edit-peer-error');
    clearFieldErrors();
    openModal('modal-edit-peer');
    document.getElementById('edit-peer-name').focus();
  }

  document.getElementById('btn-edit-peer-submit').addEventListener('click', async function() {
    var btn = this;
    var id = document.getElementById('edit-peer-id').value;
    var name = document.getElementById('edit-peer-name').value.trim();
    var description = document.getElementById('edit-peer-desc').value.trim();
    var tags = document.getElementById('edit-peer-tags').value.trim();
    var group_id = document.getElementById('edit-peer-group').value ? parseInt(document.getElementById('edit-peer-group').value, 10) : null;

    if (!name) {
      showError('edit-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      var expires_at = computeExpiresAt('edit-peer-expires', 'edit-peer-expires-date');
      var data = await api.put('/api/peers/' + id, { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id });
      if (data.ok) {
        clearFieldErrors();
        closeModal('modal-edit-peer');
        loadPeers();
        loadGroups();
      } else if (data.fields) {
        showFieldErrors(data.fields, { name: 'edit-peer-name', description: 'edit-peer-desc' });
      } else {
        showError('edit-peer-error', data.error);
      }
    } catch (err) {
      showError('edit-peer-error', err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── QR modal ────────────────────────────────────────────
  async function showQrModal(id) {
    try {
      var data = await api.get('/api/peers/' + id + '/qr');
      if (data.ok) {
        document.getElementById('qr-peer-title').textContent = data.name + ' \u2014 QR Code';
        document.getElementById('qr-peer-img').src = data.qr;
        document.getElementById('qr-peer-config').textContent = data.config;
        document.getElementById('qr-peer-download').href = '/api/v1/peers/' + id + '/config?download=1';
        document.getElementById('qr-peer-download').download = data.name + '.conf';
        openModal('modal-qr-peer');
      }
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  // ─── Copy config to clipboard ───────────────────────────
  document.getElementById('qr-peer-copy').addEventListener('click', async function() {
    var config = document.getElementById('qr-peer-config').textContent;
    var btn = document.getElementById('qr-peer-copy');
    var label = document.getElementById('qr-peer-copy-label');
    try {
      await navigator.clipboard.writeText(config);
      var original = label.textContent;
      label.textContent = btn.dataset.copiedText || 'Copied!';
      setTimeout(function() { label.textContent = original; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  // ─── Toggle ──────────────────────────────────────────────
  async function togglePeer(id) {
    try {
      await api.put('/api/peers/' + id + '/toggle');
      loadPeers();
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  // ─── Delete ──────────────────────────────────────────────
  var pendingDeleteId = null;

  function showConfirmDelete(id, name) {
    pendingDeleteId = id;
    document.getElementById('confirm-message').textContent =
      (GC.t['peers.confirm_delete'] || 'Are you sure you want to delete this peer?').replace('?', ' "' + (name || id) + '"?');
    openModal('modal-confirm');
  }

  document.getElementById('btn-confirm-yes').addEventListener('click', async function() {
    if (!pendingDeleteId) return;
    var btn = this;
    btnLoading(btn);
    try {
      await api.del('/api/peers/' + pendingDeleteId);
      closeModal('modal-confirm');
      pendingDeleteId = null;
      loadPeers();
      loadGroups();
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Traffic modal ─────────────────────────────────────
  var trafficPeerId = null;
  var trafficPeriod = '24h';

  async function showTrafficModal(id) {
    trafficPeerId = id;
    trafficPeriod = '24h';
    var modal = document.getElementById('modal-peer-traffic');
    if (!modal) return;
    modal.querySelectorAll('.tab[data-period]').forEach(function(t) {
      t.classList.toggle('active', t.dataset.period === '24h');
    });
    openModal('modal-peer-traffic');
    await loadTrafficChart();
  }

  async function loadTrafficChart() {
    if (!trafficPeerId) return;
    try {
      var data = await api.get('/api/peers/' + trafficPeerId + '/traffic?period=' + trafficPeriod);
      if (!data.ok) return;
      document.getElementById('traffic-peer-title').textContent = data.peer.name;
      document.getElementById('traffic-peer-total').textContent =
        '\u03A3 ' + formatBytes((data.peer.total_rx || 0) + (data.peer.total_tx || 0)) +
        '  \u2193' + formatBytes(data.peer.total_rx || 0) +
        '  \u2191' + formatBytes(data.peer.total_tx || 0);
      renderTrafficChart(data.data);
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  function renderTrafficChart(dataPoints) {
    var svg = document.getElementById('traffic-peer-chart');
    if (!svg) return;
    if (!dataPoints || dataPoints.length === 0) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--text-3)" font-size="13">No data</text>';
      return;
    }
    var w = 520, h = 120;
    var maxVal = Math.max(1, Math.max.apply(null, dataPoints.map(function(d) { return Math.max(d.upload, d.download); })));
    function toPath(points, key) {
      var step = w / Math.max(1, points.length - 1);
      return points.map(function(p, i) {
        var x = i * step;
        var y = h - 10 - ((p[key] / maxVal) * (h - 20));
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }
    var upPath = toPath(dataPoints, 'upload');
    var dnPath = toPath(dataPoints, 'download');
    svg.innerHTML =
      '<defs><linearGradient id="gPUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0a6e4f" stop-opacity="0.18"/><stop offset="100%" stop-color="#0a6e4f" stop-opacity="0"/></linearGradient>' +
      '<linearGradient id="gPDn" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.14"/><stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/></linearGradient></defs>' +
      '<line x1="0" y1="30" x2="' + w + '" y2="30" stroke="var(--border)" stroke-width="1"/>' +
      '<line x1="0" y1="60" x2="' + w + '" y2="60" stroke="var(--border)" stroke-width="1"/>' +
      '<line x1="0" y1="90" x2="' + w + '" y2="90" stroke="var(--border)" stroke-width="1"/>' +
      '<path d="' + upPath + ' L' + w + ',' + h + ' L0,' + h + ' Z" fill="url(#gPUp)"/>' +
      '<path d="' + upPath + '" fill="none" stroke="#0a6e4f" stroke-width="2"/>' +
      '<path d="' + dnPath + ' L' + w + ',' + h + ' L0,' + h + ' Z" fill="url(#gPDn)"/>' +
      '<path d="' + dnPath + '" fill="none" stroke="#1d4ed8" stroke-width="2"/>';
  }

  document.addEventListener('click', function(e) {
    var tab = e.target.closest('#modal-peer-traffic .tab[data-period]');
    if (!tab) return;
    document.getElementById('modal-peer-traffic').querySelectorAll('.tab[data-period]').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    trafficPeriod = tab.dataset.period;
    loadTrafficChart();
  });

  // ─── Peer Groups Management ─────────────────────────────
  var pgList = document.getElementById('peer-groups-list');
  var editingGroupId = null;

  // Note: Group management uses innerHTML with all user values passed through escapeHtml()
  // for XSS safety, consistent with the rest of the codebase.
  function renderGroupsList() {
    if (!pgList) return;
    if (!allGroups.length) {
      pgList.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:8px 0">' + escapeHtml(GC.t['peer_groups.no_groups'] || 'No peer groups configured') + '</div>';
      return;
    }
    pgList.innerHTML = allGroups.map(function(g) {
      if (editingGroupId === g.id) {
        return '<div style="display:flex;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)" data-group-id="' + g.id + '">' +
          '<input type="color" class="pg-edit-color" value="' + escapeHtml(g.color || '#6b7280') + '" style="width:28px;height:28px;padding:1px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer">' +
          '<input type="text" class="pg-edit-name" value="' + escapeHtml(g.name) + '" style="flex:1;padding:4px 8px;font-size:12px" maxlength="100">' +
          '<input type="text" class="pg-edit-desc" value="' + escapeHtml(g.description || '') + '" placeholder="' + escapeHtml(GC.t['peer_groups.description_placeholder'] || 'Description') + '" style="flex:1;padding:4px 8px;font-size:12px" maxlength="255">' +
          '<button class="icon-btn" title="' + escapeHtml(GC.t['common.save'] || 'Save') + '" data-pg-action="save" data-pg-id="' + g.id + '" style="color:var(--green)">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</button>' +
          '<button class="icon-btn" title="' + escapeHtml(GC.t['common.cancel'] || 'Cancel') + '" data-pg-action="cancel" style="color:var(--text-3)">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>';
      }
      return '<div style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)" data-group-id="' + g.id + '">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + escapeHtml(g.color || '#6b7280') + ';flex-shrink:0"></span>' +
        '<span style="font-size:13px;font-weight:500;flex:1">' + escapeHtml(g.name) + '</span>' +
        (g.description ? '<span style="font-size:11px;color:var(--text-3);flex:1">' + escapeHtml(g.description) + '</span>' : '') +
        '<span class="tag tag-grey" style="font-size:10px">' + g.peer_count + ' peer(s)</span>' +
        '<button class="icon-btn" title="' + escapeHtml(GC.t['common.edit'] || 'Edit') + '" data-pg-action="edit" data-pg-id="' + g.id + '">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        '</button>' +
        '<button class="icon-btn" title="' + escapeHtml(GC.t['common.delete'] || 'Delete') + '" data-pg-action="delete" data-pg-id="' + g.id + '">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>' +
        '</button>' +
      '</div>';
    }).join('');
  }

  // Event delegation for peer groups management
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-pg-action]');
    if (!btn) return;
    var action = btn.dataset.pgAction;
    var id = btn.dataset.pgId ? parseInt(btn.dataset.pgId, 10) : null;

    if (action === 'edit') {
      editingGroupId = id;
      renderGroupsList();
    } else if (action === 'cancel') {
      editingGroupId = null;
      renderGroupsList();
    } else if (action === 'save' && id) {
      var row = btn.closest('[data-group-id]');
      var nameInput = row.querySelector('.pg-edit-name');
      var colorInput = row.querySelector('.pg-edit-color');
      var descInput = row.querySelector('.pg-edit-desc');
      api.put('/api/peer-groups/' + id, {
        name: nameInput.value.trim(),
        color: colorInput.value,
        description: descInput.value.trim()
      }).then(function(data) {
        if (data.ok) {
          editingGroupId = null;
          loadGroups();
        } else {
          alert(data.error);
        }
      }).catch(function(err) { alert(err.message); });
    } else if (action === 'delete' && id) {
      if (!confirm(GC.t['peer_groups.confirm_delete'] || 'Delete this peer group?')) return;
      api.del('/api/peer-groups/' + id).then(function(data) {
        if (data.ok) {
          loadGroups();
          loadPeers();
        } else {
          alert(data.error);
        }
      }).catch(function(err) { alert(err.message); });
    }
  });

  // Add peer group button
  var btnAddGroup = document.getElementById('btn-add-peer-group');
  if (btnAddGroup) {
    btnAddGroup.addEventListener('click', async function() {
      var nameEl = document.getElementById('pg-name');
      var colorEl = document.getElementById('pg-color');
      var descEl = document.getElementById('pg-desc');
      var errorEl = document.getElementById('pg-error');
      var name = nameEl.value.trim();
      if (!name) {
        errorEl.textContent = GC.t['error.peer_groups.name_required'] || 'Group name is required';
        errorEl.style.display = '';
        return;
      }
      errorEl.style.display = 'none';
      btnLoading(btnAddGroup);
      try {
        var data = await api.post('/api/peer-groups', { name: name, color: colorEl.value, description: descEl.value.trim() });
        if (data.ok) {
          nameEl.value = '';
          colorEl.value = '#6b7280';
          descEl.value = '';
          loadGroups();
        } else {
          errorEl.textContent = data.error;
          errorEl.style.display = '';
        }
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = '';
      } finally {
        btnReset(btnAddGroup);
      }
    });
  }

  // ─── Batch mode ──────────────────────────────────────────
  var batchBtn = document.getElementById('btn-batch-peers');
  var batchBar = document.getElementById('batch-bar-peers');
  var batchCountEl = document.getElementById('batch-bar-peers-count');
  var batchSelectAll = document.getElementById('batch-select-all-peers');
  var batchCols = document.querySelectorAll('.batch-col');

  function enterBatchMode() {
    batchMode = true;
    batchSelected.clear();
    batchBtn.style.display = 'none';
    batchCols.forEach(function(c) { c.style.display = ''; });
    applyFilters();
    updateBatchBar();
  }

  function exitBatchMode() {
    batchMode = false;
    batchSelected.clear();
    batchBtn.style.display = '';
    batchBar.style.display = 'none';
    batchCols.forEach(function(c) { c.style.display = 'none'; });
    if (batchSelectAll) batchSelectAll.checked = false;
    applyFilters();
  }

  function updateBatchBar() {
    var count = batchSelected.size;
    if (count > 0) {
      batchBar.style.display = '';
      batchCountEl.textContent = count + ' selected';
      document.getElementById('batch-enable-peers').textContent = (GC.t['batch.enable'] || 'Enable ({{count}})').replace('{{count}}', count);
      document.getElementById('batch-disable-peers').textContent = (GC.t['batch.disable'] || 'Disable ({{count}})').replace('{{count}}', count);
      document.getElementById('batch-delete-peers').textContent = (GC.t['batch.delete'] || 'Delete ({{count}})').replace('{{count}}', count);
    } else {
      batchBar.style.display = 'none';
    }
  }

  if (batchBtn) batchBtn.addEventListener('click', enterBatchMode);
  document.getElementById('batch-cancel-peers').addEventListener('click', exitBatchMode);

  // Checkbox delegation
  tbody.addEventListener('change', function(e) {
    var cb = e.target.closest('.batch-checkbox');
    if (!cb) return;
    var id = String(cb.dataset.batchId);
    if (cb.checked) batchSelected.add(id);
    else batchSelected.delete(id);
    updateBatchBar();
  });

  if (batchSelectAll) {
    batchSelectAll.addEventListener('change', function() {
      var checked = batchSelectAll.checked;
      var checkboxes = tbody.querySelectorAll('.batch-checkbox');
      checkboxes.forEach(function(cb) {
        cb.checked = checked;
        var id = String(cb.dataset.batchId);
        if (checked) batchSelected.add(id);
        else batchSelected.delete(id);
      });
      updateBatchBar();
    });
  }

  async function executeBatchAction(action) {
    var ids = Array.from(batchSelected).map(Number);
    if (ids.length === 0) return;
    try {
      var data = await api.post('/api/peers/batch', { action: action, ids: ids });
      if (data.ok) {
        exitBatchMode();
        loadPeers();
      } else {
        alert(data.error || (GC.t['common.error'] || 'Error'));
      }
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  document.getElementById('batch-enable-peers').addEventListener('click', function() {
    executeBatchAction('enable');
  });
  document.getElementById('batch-disable-peers').addEventListener('click', function() {
    executeBatchAction('disable');
  });
  document.getElementById('batch-delete-peers').addEventListener('click', function() {
    var count = batchSelected.size;
    var msg = (GC.t['batch.confirm_delete_peers'] || 'Are you sure you want to delete {{count}} peer(s)?').replace('{{count}}', count);
    if (confirm(msg)) {
      executeBatchAction('delete');
    }
  });

  // ─── Auto-refresh ────────────────────────────────────────
  loadGroups();
  loadPeers();
  setInterval(loadPeers, 15000);
  setInterval(loadGroups, 30000);
})();
