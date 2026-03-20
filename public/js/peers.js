'use strict';

(function () {
  const tbody = document.getElementById('peers-tbody');
  const searchInput = document.getElementById('peer-search');
  const statusTags = document.getElementById('peer-status-tags');
  const tagFilters = document.getElementById('peer-tag-filters');
  let allPeers = [];
  let activeTagFilter = null;

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
  function renderPeers(peers) {
    if (!peers.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:40px">No peers configured</td></tr>';
      return;
    }

    // All user-controlled values passed through escapeHtml() for XSS safety
    tbody.innerHTML = peers.map(p => {
      const ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '—';
      const pubKey = p.public_key ? p.public_key.substring(0, 12) + '…' : '—';
      const lastContact = formatLastContact(p.latestHandshake || p.latest_handshake);
      const rx = formatBytes(p.transferRx || p.transfer_rx || 0);
      const tx = formatBytes(p.transferTx || p.transfer_tx || 0);
      const statusTag = getStatusTag(p);
      const peerTags = parseTags(p.tags);
      const tagsHtml = peerTags.map(t => `<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">${escapeHtml(t)}</span>`).join('');

      return `<tr data-peer-id="${p.id}">
        <td>
          <div class="peer-name">${escapeHtml(p.name)}</div>
          <div class="peer-meta">${escapeHtml(p.description || '')}</div>
          ${tagsHtml ? `<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">${tagsHtml}</div>` : ''}
        </td>
        <td><span style="font-family:var(--font-mono);font-size:12px">${escapeHtml(ip)}</span></td>
        <td><span style="font-family:var(--font-mono);font-size:11px;color:var(--text-2)">${escapeHtml(pubKey)}</span></td>
        <td><span style="font-size:12px;color:var(--text-2)">${lastContact}</span></td>
        <td>
          <span style="font-family:var(--font-mono);font-size:11px">↓${rx} ↑${tx}</span>
          ${(p.total_rx || p.total_tx) ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:2px">Σ ${formatBytes((p.total_rx || 0) + (p.total_tx || 0))}</div>` : ''}
        </td>
        <td>${statusTag}</td>
        <td>
          <div class="peer-actions">
            <button class="icon-btn" title="Traffic" data-action="traffic" data-id="${p.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </button>
            <button class="icon-btn" title="QR Code" data-action="qr" data-id="${p.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button class="icon-btn" title="Edit" data-action="edit" data-id="${p.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" title="Toggle" data-action="toggle" data-id="${p.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
            </button>
            <button class="icon-btn" title="Delete" data-action="delete" data-id="${p.id}" data-name="${escapeHtml(p.name)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── Status tags summary ─────────────────────────────────
  function renderStatusTags(peers) {
    const online = peers.filter(p => p.isOnline).length;
    const offline = peers.filter(p => !p.isOnline && p.enabled).length;
    const disabled = peers.filter(p => !p.enabled).length;

    let html = '';
    if (online > 0) html += `<span class="tag tag-green"><span class="tag-dot"></span>${online} ${escapeHtml(GC.t['peers.online'] || 'Online')}</span>`;
    if (offline > 0) html += `<span class="tag tag-grey"><span class="tag-dot"></span>${offline} ${escapeHtml(GC.t['peers.offline'] || 'Offline')}</span>`;
    if (disabled > 0) html += `<span class="tag tag-amber"><span class="tag-dot"></span>${disabled} ${escapeHtml(GC.t['peers.disabled'] || 'Disabled')}</span>`;
    statusTags.innerHTML = html;
  }

  function getStatusTag(peer) {
    if (!peer.enabled) return '<span class="tag tag-amber"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.disabled'] || 'Disabled') + '</span>';
    if (peer.isOnline) return '<span class="tag tag-green"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.online'] || 'Online') + '</span>';
    return '<span class="tag tag-grey"><span class="tag-dot"></span>' + escapeHtml(GC.t['peers.offline'] || 'Offline') + '</span>';
  }

  function formatLastContact(timestamp) {
    if (!timestamp) return '—';
    const ts = typeof timestamp === 'number' ? timestamp * 1000 : new Date(timestamp).getTime();
    if (isNaN(ts) || ts === 0) return '—';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ─── Tag helpers ────────────────────────────────────────
  function parseTags(tags) {
    if (!tags) return [];
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }

  function renderTagFilters(peers) {
    if (!tagFilters) return;
    const tagSet = new Set();
    peers.forEach(p => parseTags(p.tags).forEach(t => tagSet.add(t)));
    const tags = Array.from(tagSet).sort();

    tagFilters.textContent = '';
    if (tags.length === 0) return;

    const allBtn = document.createElement('button');
    allBtn.className = 'tag ' + (!activeTagFilter ? 'tag-blue' : 'tag-grey');
    allBtn.style.cssText = 'cursor:pointer;font-size:11px';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { activeTagFilter = null; applyFilters(); renderTagFilters(allPeers); });
    tagFilters.appendChild(allBtn);

    tags.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'tag ' + (activeTagFilter === tag ? 'tag-blue' : 'tag-grey');
      btn.style.cssText = 'cursor:pointer;font-size:11px';
      btn.textContent = tag;
      btn.addEventListener('click', () => { activeTagFilter = tag; applyFilters(); renderTagFilters(allPeers); });
      tagFilters.appendChild(btn);
    });
  }

  function applyFilters() {
    let filtered = allPeers;
    if (activeTagFilter) {
      filtered = filtered.filter(p => parseTags(p.tags).includes(activeTagFilter));
    }
    const q = searchInput.value.toLowerCase().trim();
    if (q) {
      filtered = filtered.filter(p =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.allowed_ips && p.allowed_ips.includes(q)) ||
        (p.public_key && p.public_key.toLowerCase().includes(q)) ||
        (p.tags && p.tags.toLowerCase().includes(q))
      );
    }
    renderPeers(filtered);
  }

  // ─── Search ──────────────────────────────────────────────
  searchInput.addEventListener('input', () => applyFilters());

  // ─── Table action delegation ─────────────────────────────
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;

    switch (action) {
      case 'traffic': showTrafficModal(id); break;
      case 'qr': showQrModal(id); break;
      case 'edit': showEditModal(id); break;
      case 'toggle': togglePeer(id); break;
      case 'delete': showConfirmDelete(id, btn.dataset.name); break;
    }
  });

  // ─── Add peer ────────────────────────────────────────────
  document.getElementById('btn-add-peer').addEventListener('click', () => {
    document.getElementById('add-peer-name').value = '';
    document.getElementById('add-peer-desc').value = '';
    document.getElementById('add-peer-tags').value = '';
    hideError('add-peer-error');
    clearFieldErrors();
    openModal('modal-add-peer');
    document.getElementById('add-peer-name').focus();
  });

  document.getElementById('btn-add-peer-submit').addEventListener('click', async function() {
    const btn = this;
    const name = document.getElementById('add-peer-name').value.trim();
    const description = document.getElementById('add-peer-desc').value.trim();
    const tags = document.getElementById('add-peer-tags').value.trim();

    if (!name) {
      showError('add-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      const data = await api.post('/api/peers', { name, description, tags });
      if (data.ok) {
        clearFieldErrors();
        closeModal('modal-add-peer');
        showQrModal(data.peer.id);
        loadPeers();
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
    const peer = allPeers.find(p => String(p.id) === String(id));
    if (!peer) return;

    document.getElementById('edit-peer-id').value = id;
    document.getElementById('edit-peer-name').value = peer.name || '';
    document.getElementById('edit-peer-desc').value = peer.description || '';
    document.getElementById('edit-peer-tags').value = peer.tags || '';
    hideError('edit-peer-error');
    clearFieldErrors();
    openModal('modal-edit-peer');
    document.getElementById('edit-peer-name').focus();
  }

  document.getElementById('btn-edit-peer-submit').addEventListener('click', async function() {
    const btn = this;
    const id = document.getElementById('edit-peer-id').value;
    const name = document.getElementById('edit-peer-name').value.trim();
    const description = document.getElementById('edit-peer-desc').value.trim();
    const tags = document.getElementById('edit-peer-tags').value.trim();

    if (!name) {
      showError('edit-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      const data = await api.put('/api/peers/' + id, { name, description, tags });
      if (data.ok) {
        clearFieldErrors();
        closeModal('modal-edit-peer');
        loadPeers();
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
      const data = await api.get('/api/peers/' + id + '/qr');
      if (data.ok) {
        document.getElementById('qr-peer-title').textContent = data.name + ' — QR Code';
        document.getElementById('qr-peer-img').src = data.qr;
        document.getElementById('qr-peer-config').textContent = data.config;
        document.getElementById('qr-peer-download').href = '/api/peers/' + id + '/config?download=1';
        document.getElementById('qr-peer-download').download = data.name + '.conf';
        openModal('modal-qr-peer');
      }
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  // ─── Copy config to clipboard ───────────────────────────
  document.getElementById('qr-peer-copy').addEventListener('click', async function() {
    const config = document.getElementById('qr-peer-config').textContent;
    const btn = document.getElementById('qr-peer-copy');
    const label = document.getElementById('qr-peer-copy-label');
    try {
      await navigator.clipboard.writeText(config);
      const original = label.textContent;
      label.textContent = btn.dataset.copiedText || 'Copied!';
      setTimeout(() => { label.textContent = original; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  // ─── Toggle ──────────────────────────────────────────────
  async function togglePeer(id) {
    try {
      await api.post('/api/peers/' + id + '/toggle');
      loadPeers();
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  // ─── Delete ──────────────────────────────────────────────
  let pendingDeleteId = null;

  function showConfirmDelete(id, name) {
    pendingDeleteId = id;
    document.getElementById('confirm-message').textContent =
      (GC.t['peers.confirm_delete'] || 'Are you sure you want to delete this peer?').replace('?', ' "' + (name || id) + '"?');
    openModal('modal-confirm');
  }

  document.getElementById('btn-confirm-yes').addEventListener('click', async function() {
    if (!pendingDeleteId) return;
    const btn = this;
    btnLoading(btn);
    try {
      await api.del('/api/peers/' + pendingDeleteId);
      closeModal('modal-confirm');
      pendingDeleteId = null;
      loadPeers();
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Traffic modal ─────────────────────────────────────
  let trafficPeerId = null;
  let trafficPeriod = '24h';

  async function showTrafficModal(id) {
    trafficPeerId = id;
    trafficPeriod = '24h';
    const modal = document.getElementById('modal-peer-traffic');
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
        'Σ ' + formatBytes((data.peer.total_rx || 0) + (data.peer.total_tx || 0)) +
        '  ↓' + formatBytes(data.peer.total_rx || 0) +
        '  ↑' + formatBytes(data.peer.total_tx || 0);
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

  // Modal helpers use global openModal/closeModal from app.js

  // ─── Auto-refresh ────────────────────────────────────────
  loadPeers();
  setInterval(loadPeers, 15000);
})();
