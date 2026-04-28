'use strict';

(function () {
  // ─── Gateway-Tokens Modal (shared helper for create + rotate flows) ──────
  // Source URL of the install-pve.sh script used in the LXC tab. Hardcoded
  // — the gateway repo is the canonical home; if it ever moves, both this
  // and the script's own self-reference need updating in lockstep.
  var INSTALL_SCRIPT_URL =
    'https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/scripts/install-pve.sh';

  // Track the active pairing-code countdown so we can cancel it on
  // modal-close / regenerate without leaving timers running.
  var _pairingCountdownTimer = null;
  function _stopPairingCountdown() {
    if (_pairingCountdownTimer) { clearInterval(_pairingCountdownTimer); _pairingCountdownTimer = null; }
  }

  function openGatewayTokensModal(peer, tokens) {
    var apiEl = document.getElementById('gateway-tokens-api-token');
    var pushEl = document.getElementById('gateway-tokens-push-token');
    var envEl = document.getElementById('gateway-tokens-env');
    var feedback = document.getElementById('gateway-tokens-copy-feedback');
    if (!apiEl) return; // modal template not loaded — shouldn't happen

    apiEl.value = tokens.apiToken || '';
    pushEl.value = tokens.pushToken || '';
    envEl.value = tokens.envContent || '';
    if (feedback) feedback.style.display = 'none';

    function showFeedback() {
      if (!feedback) return;
      feedback.style.display = '';
      setTimeout(function() { feedback.style.display = 'none'; }, 2000);
    }

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(showFeedback);
      }
      // Fallback for older browsers or non-HTTPS contexts
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showFeedback(); } catch (e) { /* noop */ }
      document.body.removeChild(ta);
    }

    document.getElementById('gateway-tokens-copy-api').onclick = function() {
      copyToClipboard(apiEl.value);
    };
    document.getElementById('gateway-tokens-copy-push').onclick = function() {
      copyToClipboard(pushEl.value);
    };
    document.getElementById('gateway-tokens-copy-all').onclick = function() {
      copyToClipboard(envEl.value);
    };
    document.getElementById('gateway-tokens-download').onclick = function() {
      var blob = new Blob([envEl.value], { type: 'text/plain' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'gateway-' + peer.id + '.env';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    };

    // ── Tabs ──────────────────────────────────────────────
    var tabs = document.querySelectorAll('.gw-tab');
    var panes = document.querySelectorAll('.gw-tab-pane');
    function activateTab(name) {
      tabs.forEach(function(b) {
        var on = b.getAttribute('data-gw-tab') === name;
        b.style.borderBottomColor = on ? '#2563eb' : 'transparent';
        b.style.color = on ? '#2563eb' : '#6b7280';
        b.style.fontWeight = on ? '600' : 'normal';
      });
      panes.forEach(function(p) {
        p.style.display = (p.getAttribute('data-gw-pane') === name) ? '' : 'none';
      });
    }
    tabs.forEach(function(b) {
      b.onclick = function() { activateTab(b.getAttribute('data-gw-tab')); };
    });
    activateTab('lxc');

    // ── LXC pairing-code wiring ───────────────────────────
    var tokenEl = document.getElementById('gateway-pairing-token');
    var commandEl = document.getElementById('gateway-pairing-command');
    var countdownEl = document.getElementById('gateway-pairing-countdown');
    var statusEl = document.getElementById('gateway-pairing-status');
    var copyTokenBtn = document.getElementById('gateway-pairing-copy-token');
    var copyCmdBtn = document.getElementById('gateway-pairing-copy-command');
    var regenBtn = document.getElementById('gateway-pairing-regenerate');

    function buildCommand(token) {
      // Inline -- separator splits the curl-fetched script's positional
      // args from bash's own args. The installer uses --token and --yes.
      return 'bash -c "$(curl -fsSL ' + INSTALL_SCRIPT_URL + ')" -- \\\n' +
             '  --token "' + token + '" --yes';
    }

    function startCountdown(expiresAt) {
      _stopPairingCountdown();
      function tick() {
        var ms = expiresAt - Date.now();
        if (ms <= 0) {
          countdownEl.textContent = (GC.t['gateway_deploy_lxc_expired'] || 'Expired — click ↻ to regenerate');
          countdownEl.style.color = '#dc2626';
          _stopPairingCountdown();
          return;
        }
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        var ss = String(s % 60).padStart(2, '0');
        countdownEl.textContent = (GC.t['gateway_deploy_lxc_valid_for'] || 'Valid for') + ' ' + m + ':' + ss;
        countdownEl.style.color = ms < 2 * 60 * 1000 ? '#dc2626' : '#6b7280';
      }
      tick();
      _pairingCountdownTimer = setInterval(tick, 1000);
    }

    async function loadPairingCode() {
      tokenEl.value = '';
      commandEl.value = '';
      statusEl.textContent = (GC.t['gateway_deploy_lxc_generating'] || 'Generating…');
      countdownEl.textContent = '';
      try {
        // Same CSRF + credentials shape as the existing /gateway-env/rotate
        // call below — the admin POST endpoints all require both.
        const resp = await fetch('/api/v1/peers/' + encodeURIComponent(peer.id) + '/gateway-pairing-code', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'X-CSRF-Token': (typeof GC !== 'undefined' && GC.csrfToken) ? GC.csrfToken : '',
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        tokenEl.value = data.token;
        commandEl.value = buildCommand(data.token);
        statusEl.textContent = '';
        startCountdown(data.expiresAt);
      } catch (err) {
        statusEl.textContent = (GC.t['gateway_deploy_lxc_failed'] || 'Failed') + ': ' + err.message;
        statusEl.style.color = '#dc2626';
      }
    }

    if (copyTokenBtn) copyTokenBtn.onclick = function() { copyToClipboard(tokenEl.value); };
    if (copyCmdBtn)   copyCmdBtn.onclick   = function() { copyToClipboard(commandEl.value); };
    if (regenBtn)     regenBtn.onclick     = function() { loadPairingCode(); };

    // Auto-fetch on open. If the user closes the modal without copying,
    // the code expires harmlessly within 10 minutes — server-side janitor
    // sweeps eventually.
    loadPairingCode();

    // Stop the countdown when the modal closes (any [data-close-modal] click).
    var modal = document.getElementById('modal-gateway-tokens');
    if (modal) {
      modal.addEventListener('click', function onClose(e) {
        if (e.target.closest && e.target.closest('[data-close-modal]')) {
          _stopPairingCountdown();
        }
      });
    }

    openModal('modal-gateway-tokens');
  }

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
  // Note: All innerHTML assignments below use only escapeHtml()-sanitized user values
  // and static SVG/HTML strings. This follows the existing pattern throughout the codebase.
  var peersMobile = document.getElementById('peers-mobile');

  function actionBtns(p) {
    var gatewayBtn = p.peer_type === 'gateway'
      ? '<button class="icon-btn" title="' + escapeHtml(GC.t['gateway_download_env'] || 'Download gateway config') + '" data-action="gateway-env" data-id="' + p.id + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        '</button>'
      : '';
    return gatewayBtn +
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
    '</button>';
  }

  function renderPeers(peers) {
    var colSpan = batchMode ? 7 : 6;
    if (!peers.length) {
      tbody.innerHTML = '<tr><td colspan="' + colSpan + '" style="text-align:center;color:var(--text-3);padding:40px">' + escapeHtml(GC.t['peers.no_peers'] || 'No peers configured') + '</td></tr>';
      if (peersMobile) peersMobile.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:40px">' + escapeHtml(GC.t['peers.no_peers'] || 'No peers configured') + '</div>';
      return;
    }

    // Desktop table
    tbody.innerHTML = peers.map(function(p) {
      var ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '\u2014';
      var lastContact = formatLastContact(p.latestHandshake || p.latest_handshake);
      var rx = formatBytes(p.transferRx || p.transfer_rx || 0);
      var tx = formatBytes(p.transferTx || p.transfer_tx || 0);
      var statusTag = getStatusTag(p);
      var expiryTag = getExpiryTag(p);
      var groupBadge = getGroupBadge(p);
      var peerTags = parseTags(p.tags);
      var tagsHtml = peerTags.map(function(t) { return '<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">' + escapeHtml(t) + '</span>'; }).join('');
      var totalTraffic = (p.total_rx || p.total_tx) ? '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:2px">\u03A3 ' + formatBytes((p.total_rx || 0) + (p.total_tx || 0)) + '</div>' : '';
      var checked = batchSelected.has(String(p.id)) ? ' checked' : '';
      var batchTd = batchMode ? '<td class="batch-col"><input type="checkbox" class="batch-checkbox" data-batch-id="' + p.id + '"' + checked + '></td>' : '';

      var hostnameHtml = '';
      if (p.hostname) {
        var srcLabel = '';
        if (p.hostname_source === 'admin') srcLabel = (GC.t['peers.hostname_source_admin'] || 'manuell');
        else if (p.hostname_source === 'agent') srcLabel = (GC.t['peers.hostname_source_agent'] || 'auto');
        else if (p.hostname_source === 'stale') srcLabel = (GC.t['peers.hostname_source_stale'] || 'stale');
        hostnameHtml = '<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);margin-top:2px">'
          + '\u29C9 ' + escapeHtml(p.hostname)
          + (srcLabel ? ' <span style="opacity:0.6">(' + escapeHtml(srcLabel) + ')</span>' : '')
          + '</div>';
      }
      return '<tr data-peer-id="' + p.id + '">' +
        batchTd +
        '<td>' +
          '<div class="peer-name">' + escapeHtml(p.name) + expiryTag + groupBadge + getGatewayBadge(p) + '</div>' +
          '<div class="peer-meta">' + escapeHtml(p.description || '') + '</div>' +
          hostnameHtml +
          (tagsHtml ? '<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">' + tagsHtml + '</div>' : '') +
        '</td>' +
        '<td><span style="font-family:var(--font-mono);font-size:12px">' + escapeHtml(ip) + '</span></td>' +
        '<td><span style="font-size:12px;color:var(--text-2)">' + lastContact + '</span></td>' +
        '<td>' +
          '<span style="font-family:var(--font-mono);font-size:11px">\u2193' + rx + ' \u2191' + tx + '</span>' +
          totalTraffic +
        '</td>' +
        '<td>' + statusTag + '</td>' +
        '<td><div class="peer-actions">' + actionBtns(p) + '</div></td>' +
      '</tr>';
    }).join('');

    // Mobile cards
    if (peersMobile) {
      peersMobile.innerHTML = peers.map(function(p) {
        var ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '\u2014';
        var lastContact = formatLastContact(p.latestHandshake || p.latest_handshake);
        var rx = formatBytes(p.transferRx || p.transfer_rx || 0);
        var tx = formatBytes(p.transferTx || p.transfer_tx || 0);
        var statusTag = getStatusTag(p);
        var expiryTag = getExpiryTag(p);
        var groupBadge = getGroupBadge(p);
        var peerTags = parseTags(p.tags);
        var tagsHtml = peerTags.map(function(t) { return '<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">' + escapeHtml(t) + '</span>'; }).join('');

        var mobileChecked = batchSelected.has(String(p.id)) ? ' checked' : '';
        var mobileBatchCb = batchMode ? '<input type="checkbox" class="batch-checkbox" data-batch-id="' + p.id + '"' + mobileChecked + ' style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)">' : '';

        return '<div class="peer-card" data-peer-id="' + p.id + '">' +
          '<div class="peer-card-top">' +
            mobileBatchCb +
            '<div class="peer-card-info">' +
              '<div class="peer-name">' + escapeHtml(p.name) + expiryTag + groupBadge + getGatewayBadge(p) + '</div>' +
              (p.description ? '<div class="peer-meta">' + escapeHtml(p.description) + '</div>' : '') +
              (tagsHtml ? '<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">' + tagsHtml + '</div>' : '') +
            '</div>' +
            statusTag +
          '</div>' +
          '<div class="peer-card-meta">' +
            '<span>' + escapeHtml(ip) + '</span>' +
            '<span>\u2193' + rx + ' \u2191' + tx + '</span>' +
            '<span>' + lastContact + '</span>' +
          '</div>' +
          '<div class="peer-card-actions">' + actionBtns(p) + '</div>' +
        '</div>';
      }).join('');
    }
  }

  // ─── Gateway badge ───────────────────────────────────────
  function getGatewayBadge(peer) {
    if (peer.peer_type !== 'gateway') return '';
    return ' <span style="display:inline-flex;align-items:center;font-size:10px;padding:1px 6px;border-radius:9999px;background:#0ea5e91a;color:#0ea5e9;border:1px solid #0ea5e940;margin-left:4px;font-weight:600;letter-spacing:0.5px">GATEWAY</span>';
  }

  // ─── Group badge ─────────────────────────────────────────
  function getGroupBadge(peer) {
    if (!peer.group_id) return '';
    var group = getGroupById(peer.group_id);
    if (!group) return '';
    var color = /^#[0-9a-fA-F]{3,8}$/.test(group.color) ? group.color : '#6b7280';
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
    // Gateway peers live in their own section above the table — exclude
    // them from the client list so they don't appear twice.
    var filtered = allPeers.filter(function(p) { return p.peer_type !== 'gateway'; });

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

  // ─── Action delegation (desktop table + mobile cards) ────
  function handlePeerAction(e) {
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
      case 'gateway-env': downloadGatewayEnv(id); break;
    }
  }

  // ─── Gateway env download (rotates tokens on server) ─────
  async function downloadGatewayEnv(peerId) {
    var confirmMsg = GC.t['gateway_download_confirm']
      || 'Downloading regenerates the gateway tokens. The currently running gateway will lose its connection. Continue?';
    if (!window.confirm(confirmMsg)) return;
    try {
      var resp = await fetch('/api/v1/peers/' + encodeURIComponent(peerId) + '/gateway-env/rotate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'X-CSRF-Token': (typeof GC !== 'undefined' && GC.csrfToken) ? GC.csrfToken : '',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        alert('Download failed (' + resp.status + ')');
        return;
      }
      var text = await resp.text();
      var blob = new Blob([text], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'gateway-' + peerId + '.env';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Download error: ' + err.message);
    }
  }
  tbody.addEventListener('click', handlePeerAction);
  if (peersMobile) peersMobile.addEventListener('click', handlePeerAction);

  // ─── Add peer ────────────────────────────────────────────
  // Toggle gateway-fields visibility on checkbox change
  var isGatewayCb = document.getElementById('add-peer-is-gateway');
  if (isGatewayCb) {
    isGatewayCb.addEventListener('change', function() {
      var fields = document.getElementById('add-peer-gateway-fields');
      if (fields) fields.style.display = this.checked ? 'block' : 'none';
    });
  }

  document.getElementById('btn-add-peer').addEventListener('click', function() {
    document.getElementById('add-peer-name').value = '';
    document.getElementById('add-peer-desc').value = '';
    document.getElementById('add-peer-tags').value = '';
    document.getElementById('add-peer-group').value = '';
    document.getElementById('add-peer-expires').value = '';
    document.getElementById('add-peer-expires-date').value = '';
    document.getElementById('add-peer-expires-date').style.display = 'none';
    var addHostnameEl = document.getElementById('add-peer-hostname');
    if (addHostnameEl) addHostnameEl.value = '';
    if (isGatewayCb) {
      isGatewayCb.checked = false;
      var gwFields = document.getElementById('add-peer-gateway-fields');
      if (gwFields) gwFields.style.display = 'none';
    }
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
      var dns = document.getElementById('add-peer-dns') ? document.getElementById('add-peer-dns').value.trim() : undefined;
      var expires_at = computeExpiresAt('add-peer-expires', 'add-peer-expires-date');
      var isGatewayEl = document.getElementById('add-peer-is-gateway');
      var apiPortEl = document.getElementById('add-peer-api-port');
      var isGateway = !!(isGatewayEl && isGatewayEl.checked);
      var apiPort = apiPortEl ? parseInt(apiPortEl.value, 10) || 9876 : 9876;
      var payload = { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns || undefined };
      if (isGateway) {
        payload.is_gateway = true;
        payload.api_port = apiPort;
      }
      var data = await api.post('/api/peers', payload);
      if (data.ok) {
        clearFieldErrors();

        // Hostname is a separate, license-gated endpoint. Only call when the
        // field is visible AND the admin entered a value.
        var addHostnameInput = document.getElementById('add-peer-hostname');
        var addHostnameVal = addHostnameInput ? addHostnameInput.value.trim() : '';
        if (addHostnameInput && addHostnameVal && data.peer && data.peer.id) {
          try {
            var hnRes = await api.patch('/api/peers/' + data.peer.id + '/hostname', { hostname: addHostnameVal });
            if (!hnRes.ok) {
              showError('add-peer-error', hnRes.error || 'Hostname update failed');
              // Peer is created — don't roll back, just surface the hostname error.
              loadPeers();
              loadGroups();
              return;
            }
          } catch (hnErr) {
            showError('add-peer-error', hnErr.message);
            loadPeers();
            loadGroups();
            return;
          }
        }

        closeModal('modal-add-peer');
        if (data.gateway && data.gateway.apiToken && data.gateway.pushToken) {
          // Gateway peer created — show tokens + env-file in dedicated modal
          openGatewayTokensModal(data.peer, data.gateway);
        } else {
          showQrModal(data.peer.id);
        }
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
  // ─── Gateway telemetry panel (in edit-peer modal) ──────────────────
  // Fetches the parsed last_health snapshot from the server and renders a
  // compact two-column table (key / value). Safe-by-construction: every
  // value is inserted via textContent; style strings are static literals.
  function renderRow(parent, key, value, opts) {
    if (value === undefined || value === null || value === '') return;
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;padding:2px 0;align-items:baseline';
    var k = document.createElement('span');
    k.style.cssText = 'color:var(--text-3);width:110px;flex-shrink:0;text-transform:uppercase;font-size:10px;letter-spacing:0.05em';
    k.textContent = key;
    var v = document.createElement('span');
    v.style.cssText = 'color:var(--text-1);flex:1;word-break:break-all';
    if (opts && opts.mute) v.style.color = 'var(--text-2)';
    v.textContent = value;
    row.appendChild(k); row.appendChild(v);
    parent.appendChild(row);
  }

  function renderSectionHeader(parent, title) {
    var h = document.createElement('div');
    h.style.cssText = 'margin-top:8px;margin-bottom:4px;color:var(--accent);font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase';
    h.textContent = title;
    parent.appendChild(h);
  }

  function formatRelTime(ms) {
    if (!ms) return null;
    var diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return diffSec + 's';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm';
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h';
    return Math.floor(diffSec / 86400) + 'd';
  }

  function formatUptimeSec(s) {
    if (!s && s !== 0) return null;
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function formatPercent(used, total) {
    if (!total) return null;
    return Math.round((used / total) * 100) + '%';
  }

  function paintStatusBadge(el, status) {
    if (!el) return;
    if (!status) { el.style.display = 'none'; return; }
    el.textContent = status.toUpperCase();
    el.style.display = '';
    if (status === 'online') {
      el.style.background = 'var(--green-lt)';
      el.style.color = 'var(--green)';
      el.style.border = '1px solid var(--green-bd)';
    } else if (status === 'offline') {
      el.style.background = 'var(--red-lt)';
      el.style.color = 'var(--red)';
      el.style.border = '1px solid var(--red-bd)';
    } else {
      el.style.background = 'var(--amber-lt)';
      el.style.color = 'var(--amber)';
      el.style.border = '1px solid var(--amber-bd)';
    }
  }

  async function loadGatewayTelemetry(peerId) {
    var wrap = document.getElementById('edit-gw-telemetry');
    var empty = document.getElementById('edit-gw-telemetry-empty');
    var statusBadge = document.getElementById('edit-gw-status-badge');
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.style.display = 'none';
    if (empty) empty.style.display = 'none';
    paintStatusBadge(statusBadge, null);

    try {
      var data = await api.get('/api/peers/' + peerId + '/gateway-info');
      if (!data || !data.ok || !data.gateway) return;
      var gw = data.gateway;
      paintStatusBadge(statusBadge, gw.status);

      var health = gw.health || {};
      var tel = health.telemetry || null;

      // No heartbeat received yet — nothing to render.
      if (!gw.last_seen_at && !tel) {
        if (empty) empty.style.display = '';
        return;
      }

      renderSectionHeader(wrap, (GC.t && GC.t['gateway_info.section_status']) || 'Status');
      renderRow(wrap, (GC.t && GC.t['gateway_info.last_seen']) || 'Last seen',
        gw.last_seen_at ? (formatRelTime(gw.last_seen_at) + ' ago') : '—');
      if (typeof health.uptime_s === 'number') {
        renderRow(wrap, (GC.t && GC.t['gateway_info.uptime']) || 'Uptime', formatUptimeSec(health.uptime_s));
      }
      if (typeof health.wg_handshake_age_s === 'number') {
        renderRow(wrap, (GC.t && GC.t['gateway_info.wg_handshake']) || 'WG handshake',
          health.wg_handshake_age_s + 's ago');
      }
      if (health.hostname) {
        renderRow(wrap, (GC.t && GC.t['gateway_info.hostname']) || 'Hostname', health.hostname);
      }

      if (tel) {
        renderSectionHeader(wrap, (GC.t && GC.t['gateway_info.section_version']) || 'Versionen');
        renderRow(wrap, 'Gateway', tel.gateway_version);
        renderRow(wrap, 'Node', tel.node_version);
        renderRow(wrap, 'WG-Tools', tel.wg_tools_version);
        if (tel.os_platform) {
          renderRow(wrap, 'OS', tel.os_platform + (tel.os_release ? ' ' + tel.os_release : '') +
            (tel.arch ? ' · ' + tel.arch : ''));
        }

        renderSectionHeader(wrap, (GC.t && GC.t['gateway_info.section_resources']) || 'Ressourcen');
        if (tel.cpu_cores) {
          var load = Array.isArray(tel.cpu_load_avg) ? tel.cpu_load_avg.map(function(n) { return n.toFixed(2); }).join(' · ') : '';
          renderRow(wrap, 'CPU', tel.cpu_cores + ' cores' + (load ? ' · load ' + load : ''));
        }
        if (tel.mem_total) {
          var pct = formatPercent(tel.mem_used, tel.mem_total);
          renderRow(wrap, 'Memory',
            window.formatBytes(tel.mem_used) + ' / ' + window.formatBytes(tel.mem_total) +
            (pct ? ' (' + pct + ')' : ''));
        }
        if (tel.disk && tel.disk.total) {
          var diskPct = formatPercent(tel.disk.used, tel.disk.total);
          renderRow(wrap, 'Disk',
            window.formatBytes(tel.disk.free) + ' free / ' + window.formatBytes(tel.disk.total) +
            (diskPct ? ' (' + diskPct + ' used)' : ''));
        }

        if (tel.default_gateway_ip || (tel.dns_resolvers && tel.dns_resolvers.length)) {
          renderSectionHeader(wrap, (GC.t && GC.t['gateway_info.section_lan']) || 'LAN');
          renderRow(wrap, 'Default GW', tel.default_gateway_ip);
          if (Array.isArray(tel.dns_resolvers) && tel.dns_resolvers.length) {
            renderRow(wrap, 'DNS', tel.dns_resolvers.join(', '));
          }
        }
      }

      wrap.style.display = '';
    } catch (err) {
      console.error('gateway telemetry load failed', err);
      if (empty) {
        empty.textContent = err.message || ((GC.t && GC.t['gateway_info.no_data']) || 'Keine Daten');
        empty.style.display = '';
      }
    }
  }

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

    var editDns = document.getElementById('edit-peer-dns');
    if (editDns) editDns.value = peer.dns || '';

    var editHostname = document.getElementById('edit-peer-hostname');
    if (editHostname) {
      editHostname.value = peer.hostname || '';
      var badge = document.getElementById('edit-peer-hostname-badge');
      if (badge) {
        if (peer.hostname_source === 'admin') {
          badge.textContent = GC.t['peers.hostname_source_admin'] || 'manuell';
          badge.className = 'badge badge-sm badge-info';
          badge.style.display = '';
        } else if (peer.hostname_source === 'agent') {
          badge.textContent = GC.t['peers.hostname_source_agent'] || 'auto';
          badge.className = 'badge badge-sm badge-success';
          badge.style.display = '';
        } else if (peer.hostname_source === 'stale') {
          badge.textContent = GC.t['peers.hostname_source_stale'] || 'stale';
          badge.className = 'badge badge-sm badge-warning';
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      }
    }

    // Gateway-Info-Block — nur sichtbar wenn peer_type === 'gateway'
    var gwInfo = document.getElementById('edit-peer-gateway-info');
    var gwBtn = document.getElementById('btn-edit-peer-download-env');
    if (gwInfo) {
      if (peer.peer_type === 'gateway') {
        gwInfo.style.display = '';
        var portDisplay = document.getElementById('edit-peer-api-port-display');
        if (portDisplay) portDisplay.textContent = peer.api_port || '9876';
        if (gwBtn) {
          gwBtn.onclick = async function() {
            if (!confirm((GC.t && GC.t['gateway_download_confirm']) || 'Gateway-Tokens werden regeneriert. Laufender Gateway wird ungültig. Fortfahren?')) return;
            try {
              // POST /rotate returns JSON { apiToken, pushToken, envContent }
              var data = await api.post('/api/peers/' + peer.id + '/gateway-env/rotate', {});
              if (!data.ok) {
                showError('edit-peer-error', data.error || 'Rotate failed');
                return;
              }
              closeModal('modal-edit-peer');
              openGatewayTokensModal(peer, data);
            } catch (err) {
              showError('edit-peer-error', err.message);
            }
          };
        }
        // Fetch + render telemetry snapshot (versions, resources, LAN).
        loadGatewayTelemetry(peer.id);
      } else {
        gwInfo.style.display = 'none';
      }
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
      var dns = document.getElementById('edit-peer-dns') ? document.getElementById('edit-peer-dns').value.trim() : undefined;
      var expires_at = computeExpiresAt('edit-peer-expires', 'edit-peer-expires-date');
      var data = await api.put('/api/peers/' + id, { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns || undefined });
      if (!data.ok) {
        if (data.fields) {
          showFieldErrors(data.fields, { name: 'edit-peer-name', description: 'edit-peer-desc' });
        } else {
          showError('edit-peer-error', data.error);
        }
        return;
      }

      // Hostname is a separate endpoint (license-gated). Only call when the
      // field is visible AND the value actually changed.
      var hostnameInput = document.getElementById('edit-peer-hostname');
      if (hostnameInput) {
        var currentPeer = allPeers.find(function(p) { return String(p.id) === String(id); }) || {};
        var newHostname = hostnameInput.value.trim();
        var prevHostname = currentPeer.hostname || '';
        if (newHostname !== prevHostname) {
          var hnRes = await api.patch('/api/peers/' + id + '/hostname', { hostname: newHostname });
          if (!hnRes.ok) {
            showError('edit-peer-error', hnRes.error || 'Hostname update failed');
            return;
          }
        }
      }

      clearFieldErrors();
      closeModal('modal-edit-peer');
      loadPeers();
      loadGroups();
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
      var data = await api.put('/api/peers/' + id + '/toggle');
      if (data && !data.ok) {
        showToast(data.error || 'Error', 'error');
        return;
      }
      loadPeers();
    } catch (err) {
      showToast(err.message, 'error');
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
        '<span style="width:10px;height:10px;border-radius:50%;background:' + (/^#[0-9a-fA-F]{3,8}$/.test(g.color) ? g.color : '#6b7280') + ';flex-shrink:0"></span>' +
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
    if (batchMode) {
      batchBar.style.display = '';
      if (count > 0) {
        batchCountEl.textContent = count + ' ' + (GC.t['batch.selected'] || 'selected');
        document.getElementById('batch-enable-peers').textContent = (GC.t['batch.enable'] || 'Enable ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-disable-peers').textContent = (GC.t['batch.disable'] || 'Disable ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-delete-peers').textContent = (GC.t['batch.delete'] || 'Delete ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-enable-peers').disabled = false;
        document.getElementById('batch-disable-peers').disabled = false;
        document.getElementById('batch-delete-peers').disabled = false;
      } else {
        batchCountEl.textContent = GC.t['batch.none_selected'] || 'Select items...';
        document.getElementById('batch-enable-peers').textContent = (GC.t['batch.enable'] || 'Enable').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-disable-peers').textContent = (GC.t['batch.disable'] || 'Disable').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-delete-peers').textContent = (GC.t['batch.delete'] || 'Delete').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-enable-peers').disabled = true;
        document.getElementById('batch-disable-peers').disabled = true;
        document.getElementById('batch-delete-peers').disabled = true;
      }
    } else {
      batchBar.style.display = 'none';
    }
  }

  if (batchBtn) batchBtn.addEventListener('click', enterBatchMode);
  document.getElementById('batch-cancel-peers').addEventListener('click', exitBatchMode);

  // Checkbox delegation (desktop table + mobile cards)
  function handleBatchCheckbox(e) {
    var cb = e.target.closest('.batch-checkbox');
    if (!cb) return;
    var id = String(cb.dataset.batchId);
    if (cb.checked) batchSelected.add(id);
    else batchSelected.delete(id);
    updateBatchBar();
  }
  tbody.addEventListener('change', handleBatchCheckbox);
  if (peersMobile) peersMobile.addEventListener('change', handleBatchCheckbox);

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

  // ─── Home-Gateway cards (above the peer table) ──────────
  // One /api/gateways call returns each gateway's state, telemetry and
  // the routes it serves. Cards default to collapsed; the expanded set
  // is persisted per-gateway in localStorage so the UI remembers which
  // ones the admin had open.
  var gwContainer = document.getElementById('gateways-container');
  var gwCountEl = document.getElementById('gw-section-count');
  var peersCountEl = document.getElementById('peers-section-count');
  var statGwOnline = document.getElementById('stat-gw-online');
  var statGwTotal  = document.getElementById('stat-gw-total');
  var statClOnline = document.getElementById('stat-cl-online');
  var statClTotal  = document.getElementById('stat-cl-total');

  var allGateways = [];
  var GW_EXPANDED_KEY = 'gc_gw_expanded_v1';
  var gwExpanded = (function() {
    try { return new Set((JSON.parse(localStorage.getItem(GW_EXPANDED_KEY) || '[]') || []).map(String)); }
    catch (_) { return new Set(); }
  })();
  function saveGwExpanded() {
    try { localStorage.setItem(GW_EXPANDED_KEY, JSON.stringify(Array.from(gwExpanded))); } catch (_) { /* ignore */ }
  }

  function clearEl(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  function gwT(key, fallback) {
    return (window.GC && GC.t && GC.t[key]) || fallback;
  }

  function formatRelTime(ms) {
    if (!ms) return null;
    var sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    return Math.floor(sec / 86400) + 'd';
  }
  function formatUptimeSec(s) {
    if (s == null) return null;
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  function formatPct(used, total) {
    if (!total) return null;
    return Math.round((used / total) * 100) + '%';
  }

  // ─── SVG helpers (pure DOM, no innerHTML) ───────────────
  function svgEl(attrs, children) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    Object.keys(attrs).forEach(function(k) { svg.setAttribute(k, attrs[k]); });
    (children || []).forEach(function(c) { svg.appendChild(c); });
    return svg;
  }
  function svgShape(tag, attrs) {
    var ns = 'http://www.w3.org/2000/svg';
    var el = document.createElementNS(ns, tag);
    Object.keys(attrs).forEach(function(k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function shieldSvg() {
    return svgEl(
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      [svgShape('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
       svgShape('polyline', { points: '9 12 11 14 15 10' })]
    );
  }
  function chevronSvg() {
    return svgEl(
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      [svgShape('polyline', { points: '6 9 12 15 18 9' })]
    );
  }
  function plainSvg(path) {
    return svgEl(
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', width: '14', height: '14' },
      [svgShape('path', { d: path })]
    );
  }

  function addMeta(row, text) {
    var el = document.createElement('span');
    el.textContent = text;
    row.appendChild(el);
  }
  function addSep(row) {
    var s = document.createElement('span');
    s.className = 'sep';
    s.textContent = '·';
    row.appendChild(s);
  }

  function renderGatewayHeader(gw, isExpanded) {
    var head = document.createElement('header');
    head.className = 'gw-card-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', String(isExpanded));

    var avatar = document.createElement('div');
    avatar.className = 'gw-avatar';
    avatar.appendChild(shieldSvg());

    var identity = document.createElement('div');
    identity.className = 'gw-identity';
    var h3 = document.createElement('h3');
    h3.textContent = gw.name;
    identity.appendChild(h3);

    var meta = document.createElement('div');
    meta.className = 'gw-identity-meta';
    var metaParts = [];
    if (gw.hostname) metaParts.push(gw.hostname);
    if (gw.ip) metaParts.push(gw.ip);
    if (gw.api_port) metaParts.push('API :' + gw.api_port);
    metaParts.forEach(function(p, i) {
      addMeta(meta, p);
      if (i < metaParts.length - 1) addSep(meta);
    });
    identity.appendChild(meta);

    var statusWrap = document.createElement('div');
    statusWrap.className = 'gw-status';
    var telemetry = (gw.health && gw.health.telemetry) || null;
    if (telemetry && telemetry.gateway_version) {
      var vchip = document.createElement('span');
      vchip.className = 'version-chip';
      vchip.title = gwT('peers.gateway.version_chip', 'Gateway-Container-Version');
      vchip.textContent = 'v' + telemetry.gateway_version;
      statusWrap.appendChild(vchip);
    }

    var status = gw.status || 'degraded';
    var pill = document.createElement('span');
    pill.className = 'status-pill ' + status;
    var dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);
    var labelKey = 'peers.gateway.status_' + status;
    var fallback = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Degraded';
    pill.appendChild(document.createTextNode(gwT(labelKey, fallback)));
    statusWrap.appendChild(pill);

    var chev = document.createElement('span');
    chev.className = 'gw-chev';
    chev.appendChild(chevronSvg());
    statusWrap.appendChild(chev);

    head.appendChild(avatar);
    head.appendChild(identity);
    head.appendChild(statusWrap);
    return head;
  }

  function teleRow(grid, key, value, barPercent, barClass) {
    if (value === undefined || value === null || value === '') return;
    var k = document.createElement('div');
    k.className = 'tele-k';
    k.textContent = key;
    var v = document.createElement('div');
    v.className = 'tele-v';
    v.textContent = value;
    if (typeof barPercent === 'number' && barPercent >= 0) {
      var bar = document.createElement('span');
      bar.className = 'tele-bar';
      var fill = document.createElement('span');
      fill.className = 'tele-bar-fill' + (barClass ? ' ' + barClass : '');
      fill.style.width = Math.min(100, Math.max(0, barPercent)) + '%';
      bar.appendChild(fill);
      v.appendChild(bar);
    }
    grid.appendChild(k);
    grid.appendChild(v);
  }

  function renderTelemetrySection(gw) {
    var sec = document.createElement('div');
    sec.className = 'gw-section';
    var title = document.createElement('div');
    title.className = 'gw-section-title';
    title.textContent = gwT('peers.gateway.section_telemetry', 'Telemetrie');
    sec.appendChild(title);

    var grid = document.createElement('div');
    grid.className = 'tele-rows';
    var h = gw.health || {};
    var t = h.telemetry || {};

    // Status-y fields
    teleRow(grid, gwT('peers.gateway.last_seen', 'Zuletzt gesehen'),
      gw.last_seen_at ? (formatRelTime(gw.last_seen_at) + ' ago') : '—');
    teleRow(grid, gwT('peers.gateway.uptime', 'Laufzeit'), formatUptimeSec(h.uptime_s));
    if (typeof h.wg_handshake_age_s === 'number') {
      teleRow(grid, gwT('peers.gateway.wg_handshake', 'Handshake'), h.wg_handshake_age_s + 's ago');
    }
    if (h.hostname) teleRow(grid, gwT('peers.gateway.hostname', 'Hostname'), h.hostname);

    // Versions
    if (t.gateway_version) teleRow(grid, 'Gateway', 'v' + t.gateway_version);
    if (t.node_version)    teleRow(grid, 'Node', t.node_version);
    if (t.wg_tools_version) teleRow(grid, 'WG-Tools', t.wg_tools_version);
    if (t.os_platform) {
      teleRow(grid, 'OS', t.os_platform + (t.os_release ? ' ' + t.os_release : '') + (t.arch ? ' · ' + t.arch : ''));
    }

    // Resources
    if (t.cpu_cores) {
      var loadStr = Array.isArray(t.cpu_load_avg)
        ? t.cpu_load_avg.map(function(n) { return (+n).toFixed(2); }).join(' · ')
        : '';
      teleRow(grid, 'CPU', t.cpu_cores + ' cores' + (loadStr ? ' · load ' + loadStr : ''));
    }
    if (t.mem_total) {
      var pct = Math.round((t.mem_used / t.mem_total) * 100);
      var memCls = pct > 90 ? 'bad' : pct > 70 ? 'warn' : '';
      teleRow(grid, 'Memory',
        window.formatBytes(t.mem_used) + ' / ' + window.formatBytes(t.mem_total) + ' (' + pct + '%)',
        pct, memCls);
    }
    if (t.disk && t.disk.total) {
      var dPct = Math.round((t.disk.used / t.disk.total) * 100);
      var dCls = dPct > 90 ? 'bad' : dPct > 70 ? 'warn' : '';
      teleRow(grid, 'Disk',
        window.formatBytes(t.disk.free) + ' frei / ' + window.formatBytes(t.disk.total) + ' (' + dPct + '%)',
        dPct, dCls);
    }

    // LAN
    if (t.default_gateway_ip) teleRow(grid, 'LAN-GW', t.default_gateway_ip);
    if (Array.isArray(t.dns_resolvers) && t.dns_resolvers.length) {
      teleRow(grid, 'DNS', t.dns_resolvers.join(', '));
    }

    sec.appendChild(grid);
    return sec;
  }

  function renderRoutesSection(gw) {
    var sec = document.createElement('div');
    sec.className = 'gw-section';
    var title = document.createElement('div');
    title.className = 'gw-section-title';
    var routes = Array.isArray(gw.routes) ? gw.routes : [];
    title.textContent = gwT('peers.gateway.section_routes', 'Geroutete Ziele') + ' (' + routes.length + ')';
    sec.appendChild(title);

    if (!routes.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text-3);font-family:var(--font-mono)';
      empty.textContent = gwT('peers.gateway.no_routes', 'Keine Routen über diesen Gateway');
      sec.appendChild(empty);
      return sec;
    }

    // Build a lookup from route_reachability if present
    var reach = {};
    var arr = (gw.health && Array.isArray(gw.health.route_reachability)) ? gw.health.route_reachability : [];
    arr.forEach(function(r) { reach[r.route_id] = r; });

    var list = document.createElement('div');
    list.className = 'gw-routes-list';
    routes.forEach(function(r) {
      var row = document.createElement('div');
      row.className = 'gw-route-row';

      var dot = document.createElement('span');
      dot.className = 'gw-route-dot';
      var rr = reach[r.id];
      if (rr) {
        if (rr.reachable) dot.classList.add(); // green default
        else dot.classList.add('down');
      } else {
        dot.classList.add('check');
      }
      row.appendChild(dot);

      var domain = document.createElement('span');
      domain.className = 'gw-route-domain';
      domain.textContent = r.domain || '—';
      row.appendChild(domain);

      var target = document.createElement('span');
      target.className = 'gw-route-target';
      if (r.route_type === 'l4') {
        target.textContent = '→ ' + (r.target_lan_host || '?') + ':' + (r.target_lan_port || r.l4_listen_port || '?');
      } else {
        target.textContent = '→ ' + (r.target_lan_host || '?') + ':' + (r.target_lan_port || '?');
      }
      row.appendChild(target);

      var kind = document.createElement('span');
      kind.className = 'gw-route-kind ' + (r.route_type || 'http');
      kind.textContent = (r.route_type || 'http').toUpperCase();
      row.appendChild(kind);

      list.appendChild(row);
    });
    sec.appendChild(list);

    // Reachability summary
    if (arr.length) {
      var reachCount = arr.filter(function(x) { return x.reachable; }).length;
      var latencies = arr.filter(function(x) { return typeof x.latency_ms === 'number'; }).map(function(x) { return x.latency_ms; });
      var avg = latencies.length ? (latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length).toFixed(1) : null;
      var summary = document.createElement('div');
      summary.style.cssText = 'margin-top:10px;font-size:11px;color:var(--text-3);font-family:var(--font-mono)';
      summary.textContent = 'Reachability: ' + reachCount + '/' + arr.length + ' erreichbar' + (avg ? ' · Ø ' + avg + ' ms' : '');
      sec.appendChild(summary);
    }
    return sec;
  }

  function renderActionsSection(gw) {
    var footer = document.createElement('footer');
    footer.className = 'gw-actions';

    var left = document.createElement('div');
    left.className = 'gw-actions-left';
    if (gw.health && gw.health.config_hash) {
      left.textContent = 'Config-Hash: ' + gw.health.config_hash.slice(0, 24);
    } else {
      left.textContent = '';
    }
    footer.appendChild(left);

    function mkBtn(labelKey, labelFallback, onClick, danger) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm' + (danger ? ' btn-danger' : '');
      b.textContent = gwT(labelKey, labelFallback);
      b.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
      return b;
    }

    footer.appendChild(mkBtn('peers.gateway.action_edit', 'Bearbeiten', function() {
      showEditModal(gw.peer_id);
    }));
    footer.appendChild(mkBtn('peers.gateway.action_env', 'ENV herunterladen', function() {
      // Open edit modal which carries the download/rotate UI — same flow
      showEditModal(gw.peer_id);
    }));
    return footer;
  }

  function toggleGwExpanded(peerId, card) {
    var id = String(peerId);
    if (gwExpanded.has(id)) { gwExpanded.delete(id); card.classList.remove('expanded'); }
    else { gwExpanded.add(id); card.classList.add('expanded'); }
    var head = card.querySelector('.gw-card-head');
    if (head) head.setAttribute('aria-expanded', String(gwExpanded.has(id)));
    saveGwExpanded();
  }

  function renderGatewayCard(gw) {
    var card = document.createElement('article');
    card.className = 'gw-card';
    var isOpen = gwExpanded.has(String(gw.peer_id));
    if (isOpen) card.classList.add('expanded');
    if (gw.status === 'offline') card.classList.add('offline');

    var head = renderGatewayHeader(gw, isOpen);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'gw-card-body';
    body.appendChild(renderTelemetrySection(gw));
    body.appendChild(renderRoutesSection(gw));
    card.appendChild(body);

    card.appendChild(renderActionsSection(gw));

    head.addEventListener('click', function(e) {
      if (e.target.closest('button, a')) return;
      toggleGwExpanded(gw.peer_id, card);
    });
    head.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleGwExpanded(gw.peer_id, card);
      }
    });
    return card;
  }

  function renderGateways() {
    if (!gwContainer) return;
    clearEl(gwContainer);
    if (gwCountEl) {
      var online = allGateways.filter(function(g) { return g.status === 'online'; }).length;
      gwCountEl.textContent = online + ' / ' + allGateways.length + ' online';
    }
    gwContainer.classList.toggle('multi', allGateways.length > 1);
    if (!allGateways.length) {
      var empty = document.createElement('div');
      empty.className = 'gw-empty';
      empty.textContent = gwT('peers.gateway.none', 'Kein Gateway konfiguriert. Neuen Gateway-Peer über „Hinzufügen" anlegen.');
      gwContainer.appendChild(empty);
      return;
    }
    allGateways.forEach(function(gw) { gwContainer.appendChild(renderGatewayCard(gw)); });
  }

  function updateStats() {
    var gwOnline = allGateways.filter(function(g) { return g.status === 'online'; }).length;
    var gwTotal = allGateways.length;
    var clients = allPeers.filter(function(p) { return p.peer_type !== 'gateway'; });
    var clientsOnline = clients.filter(function(p) { return p.isOnline; }).length;
    if (statGwOnline) statGwOnline.textContent = gwOnline;
    if (statGwTotal)  statGwTotal.textContent = '/ ' + gwTotal;
    if (statClOnline) statClOnline.textContent = clientsOnline;
    if (statClTotal)  statClTotal.textContent  = '/ ' + clients.length;
    if (peersCountEl) peersCountEl.textContent = clients.length + ' total · ' + clientsOnline + ' online';
  }

  async function loadGateways() {
    try {
      var data = await api.get('/api/gateways');
      if (data && data.ok) {
        allGateways = Array.isArray(data.gateways) ? data.gateways : [];
        renderGateways();
        updateStats();
      }
    } catch (err) {
      console.error('gateways load failed', err);
    }
  }

  // Re-run stats when peers finish loading — wraps loadPeers to refresh stats.
  var _origLoadPeers = loadPeers;
  loadPeers = async function() {
    await _origLoadPeers.apply(this, arguments);
    updateStats();
  };

  // ─── Auto-refresh ────────────────────────────────────────
  loadGroups();
  loadPeers();
  loadGateways();
  setInterval(loadPeers, 15000);
  setInterval(loadGroups, 30000);
  setInterval(loadGateways, 20000);
})();
