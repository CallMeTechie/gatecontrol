'use strict';

(function () {
  const routesList = document.getElementById('routes-list');
  const routesCount = document.getElementById('routes-count');
  const routesSubtitle = document.getElementById('routes-subtitle');
  const peerSelect = document.getElementById('route-peer-select');
  const routeForm = document.getElementById('route-form');
  const routeSearch = document.getElementById('route-search');
  let allRoutes = [];
  let allPeers = [];
  let batchMode = false;
  let batchSelected = new Set();

  function isAurora() { return !!document.querySelector('.app'); }

  // ─── View state ──────────────────────────────────────────
  // Lives outside the DOM (plus localStorage) because SSE events
  // (gc:monitor / gc:reconnected) trigger full re-renders — any state kept
  // only in the DOM would reset on every monitor tick.
  const view = window.GCRoutesView;
  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsGetSet(k) { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch (_) { return new Set(); } }
  function lsSetSet(k, s) { try { localStorage.setItem(k, JSON.stringify(Array.from(s))); } catch (_) {} }
  const viewState = {
    view: lsGet('gc_routes_view_v1', 'cards') === 'table' ? 'table' : 'cards',
    sort: lsGet('gc_routes_sort_v1', 'domain'),
    typeFilter: null,
    statusFilter: null,
    targetFilter: null,
  };
  // Aurora always uses the table view (no view-toggle in Aurora toolbar).
  if (isAurora()) viewState.view = 'table';
  const collapsedGroups = lsGetSet('gc_routes_groups_collapsed_v1');
  const expandedBadges = new Set();

  // ─── Load routes ─────────────────────────────────────────
  async function loadRoutes() {
    try {
      const data = await api.get('/api/routes');
      if (data.ok) {
        allRoutes = data.routes;
        applyRouteFilter();
        const enabledCount = allRoutes.filter(r => r.enabled).length;
        routesCount.textContent = enabledCount + ' entries';
        routesSubtitle.textContent = enabledCount + ' active entries';
      }
    } catch (err) {
      routesList.innerHTML = '<div style="color:var(--red);padding:20px;text-align:center">' +
        escapeHtml(err.message) + '</div>';
    }
  }

  // ─── Load peers for dropdown ─────────────────────────────
  async function loadPeers() {
    try {
      const data = await api.get('/api/routes/peers');
      if (data.ok) {
        allPeers = data.peers;
        window.allPeers = allPeers;
        renderPeerOptions(peerSelect);
        renderGatewayPeerOptions(document.getElementById('create-route-gateway-peer'));
      }
    } catch (err) {
      console.error('Failed to load peers:', err);
    }
  }

  function renderGatewayPeerOptions(select, selectedId) {
    if (!select) return;
    select.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '\u2014';
    select.appendChild(emptyOpt);
    for (const p of allPeers.filter(x => x.peer_type === 'gateway')) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const ip = p.ip || '?';
      const status = p.isOnline ? ' (online)' : p.enabled ? '' : ' (disabled)';
      opt.textContent = `${p.name} — ${ip}${status}`;
      if (String(selectedId) === String(p.id)) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function renderPeerOptions(select, selectedId) {
    const current = select.querySelector('option[value=""]');
    select.innerHTML = '';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '—';
    select.appendChild(emptyOpt);

    for (const p of allPeers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const ip = p.ip || '?';
      const status = p.isOnline ? ' (online)' : p.enabled ? '' : ' (disabled)';
      opt.textContent = `${p.name} — ${ip}${status}`;
      if (String(selectedId) === String(p.id)) opt.selected = true;
      select.appendChild(opt);
    }
  }

  // ─── Load users for visibility control ───────────────────
  var allUsers = [];
  async function fetchUsers() {
    try {
      var data = await api.get('/api/v1/users');
      allUsers = data.users || [];
    } catch (e) { /* ignore */ }
  }
  fetchUsers().then(function () {
    renderUserCheckboxes('create-route-user-ids', [], 'create-route-user-cb');
  });

  function renderUserCheckboxes(containerId, selectedIds, cbClass) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.textContent = '';
    allUsers.forEach(function (u) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = u.id;
      cb.className = cbClass || 'route-user-cb';
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

  // ─── Render a single route (card or group sub-item) ──────
  function renderRouteEntry(r, opts) {
    opts = opts || {};
    {
      // Gateway-routed routes show the LAN target behind the home gateway.
      // Peer-routed routes show the direct WG peer IP.
      const isGatewayRoute = r.target_kind === 'gateway';
      let peerIp, peerLabel, target;
      if (isGatewayRoute) {
        const gwIp = r.target_peer_ip ? r.target_peer_ip.split('/')[0] : '';
        const gwLabel = r.target_peer_name || gwIp || 'Gateway';
        peerIp = gwIp;
        peerLabel = 'Gateway: ' + gwLabel;
        target = (r.target_lan_host || '?') + ':' + (r.target_lan_port || r.target_port || '?');
      } else {
        peerIp = r.peer_ip ? r.peer_ip.split('/')[0] : r.target_ip;
        peerLabel = r.peer_name || peerIp;
        target = peerIp + ':' + r.target_port;
      }
      const peerOnline = isGatewayRoute ? (r.target_peer_enabled !== 0) : (r.peer_enabled !== 0);
      const statusTag = !r.enabled
        ? '<span class="tag tag-amber"><span class="tag-dot"></span>' + escapeHtml(GC.t['routes.disabled'] || 'Disabled') + '</span>'
        : peerOnline
          ? '<span class="tag tag-green"><span class="tag-dot"></span>' + escapeHtml(GC.t['routes.active'] || 'Active') + '</span>'
          : '<span class="tag tag-red"><span class="tag-dot"></span>' + escapeHtml(GC.t['routes.peer_offline'] || 'Peer offline') + '</span>';
      let monitorTag = '';
      if (r.monitoring_enabled) {
        const mStatus = r.monitoring_status || 'unknown';
        const mColor = mStatus === 'up' ? 'tag-green' : mStatus === 'down' ? 'tag-red' : 'tag-grey';
        const mLabel = mStatus === 'up' ? 'UP' : mStatus === 'down' ? 'DOWN' : '?';
        const mTime = r.monitoring_response_time != null ? ' ' + (parseInt(r.monitoring_response_time, 10) || 0) + 'ms' : '';
        monitorTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Monitoring</span>';
        monitorTag += '<span class="tag ' + mColor + '" style="margin-left:4px"><span class="tag-dot"></span>' + mLabel + mTime + '</span>';
      }
      let aclTag = '';
      if (r.acl_enabled) {
        aclTag = '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> ACL</span>';
      }
      let ipFilterTag = '';
      if (r.ip_filter_enabled) {
        const mode = r.ip_filter_mode === 'blacklist' ? 'Blacklist' : 'Whitelist';
        ipFilterTag = '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> ' + mode + '</span>';
      }
      let rateLimitTag = '';
      if (r.rate_limit_enabled && r.route_type !== 'l4') {
        var rlWindows = { '1s': 's', '1m': 'min', '5m': '5min', '1h': 'h' };
        var rlW = rlWindows[r.rate_limit_window] || r.rate_limit_window;
        rateLimitTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> ' + (GC.t['routes.rate_limit_badge'] || 'Rate Limit: {{requests}}/{{window}}').replace('{{requests}}', r.rate_limit_requests || 100).replace('{{window}}', rlW) + '</span>';
      }
      let retryTag = '';
      if (r.retry_enabled && r.route_type !== 'l4') {
        retryTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg> ' + (GC.t['routes.retry_badge'] || 'Retry: {{count}}x').replace('{{count}}', r.retry_count || 3) + '</span>';
      }
      let backendsTag = '';
      if (r.backends && r.route_type !== 'l4') {
        try {
          var be = typeof r.backends === 'string' ? JSON.parse(r.backends) : r.backends;
          if (Array.isArray(be) && be.length > 0) {
            backendsTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg> ' + (GC.t['routes.backends_badge'] || 'LB: {{count}} backends').replace('{{count}}', be.length) + '</span>';
          }
        } catch (_) {}
      }
      let stickyTag = '';
      if (r.sticky_enabled && r.backends && r.route_type !== 'l4') {
        try {
          var beSt = typeof r.backends === 'string' ? JSON.parse(r.backends) : r.backends;
          if (Array.isArray(beSt) && beSt.length > 0) {
            stickyTag = '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 014 4c0 2-2 3-2 5h-4c0-2-2-3-2-5a4 4 0 014-4z"/><rect x="9" y="17" width="6" height="3" rx="1"/></svg> ' + escapeHtml(GC.t['routes.sticky_badge'] || 'Sticky') + '</span>';
          }
        } catch (_) {}
      }
      let cbTag = '';
      if (r.circuit_breaker_enabled && r.route_type !== 'l4') {
        var cbStatus = r.circuit_breaker_status || 'closed';
        var cbColor = cbStatus === 'closed' ? 'tag-green' : cbStatus === 'open' ? 'tag-red' : 'tag-amber';
        var cbLabel = cbStatus === 'closed' ? (GC.t['circuit_breaker.badge_closed'] || 'CB: Closed')
          : cbStatus === 'open' ? (GC.t['circuit_breaker.badge_open'] || 'CB: Open')
          : (GC.t['circuit_breaker.badge_half_open'] || 'CB: Half-Open');
        cbTag = '<span class="tag ' + cbColor + '" style="margin-left:4px"><span class="tag-dot"></span>' + escapeHtml(cbLabel) + '</span>';
      }
      let debugTag = '';
      if (r.debug_enabled && r.route_type !== 'l4') {
        debugTag = '<span class="tag tag-amber" style="margin-left:4px">' + escapeHtml(GC.t['debug.badge'] || 'Debug') + '</span>';
      }
      let botTag = '';
      if (r.bot_blocker_enabled && r.route_type !== 'l4') {
        var botCount = r.bot_blocker_count || 0;
        var botSvg = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="11"/><line x1="8" y1="16" x2="8" y2="16.01"/><line x1="16" y1="16" x2="16" y2="16.01"/></svg>';
        var botLabel = escapeHtml(GC.t['bot_blocker.badge'] || 'bots blocked');
        botTag = '<span class="tag tag-amber" style="margin-left:4px">' + botSvg + ' ' + botCount + ' ' + botLabel + '</span>';
      }
      let mirrorTag = '';
      if (r.mirror_enabled && r.route_type !== 'l4') {
        try {
          var mt = typeof r.mirror_targets === 'string' ? JSON.parse(r.mirror_targets) : r.mirror_targets;
          if (Array.isArray(mt) && mt.length > 0) {
            mirrorTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg> ' + (GC.t['routes.mirror_badge'] || 'Mirror: {{count}} targets').replace('{{count}}', mt.length) + '</span>';
          }
        } catch (_) {}
      }
      let headersTag = '';
      if (r.custom_headers && r.route_type !== 'l4') {
        try {
          var ch = typeof r.custom_headers === 'string' ? JSON.parse(r.custom_headers) : r.custom_headers;
          var reqCount = (ch.request || []).length;
          var respCount = (ch.response || []).length;
          if (reqCount + respCount > 0) {
            headersTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 6h16M4 12h16M4 18h16"/></svg> ' + escapeHtml(GC.t['headers.badge'] || 'Headers') + '</span>';
          }
        } catch (_) {}
      }
      const httpsTag = r.https_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> HTTPS</span>'
        : '';
      const backendHttpsTag = r.backend_https && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Backend HTTPS</span>'
        : '';
      const compressTag = r.compress_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 14l8-8 8 8"/><path d="M4 20l8-8 8 8"/></svg> ' + escapeHtml(GC.t['routes.compress_badge'] || 'Compress') + '</span>'
        : '';
      const internalTag = !r.external_enabled
        ? '<span class="tag tag-amber" style="margin-left:4px">' + escapeHtml(GC.t['routes.internal_badge'] || 'Internal only') + '</span>'
        : '';
      const blockActionTag = !r.external_enabled && r.external_block_action && r.external_block_action !== 'inherit'
        ? '<span class="tag tag-amber" style="margin-left:4px">' + escapeHtml(GC.t['routes.block_' + r.external_block_action] || r.external_block_action) + '</span>'
        : '';
      const authTag = r.basic_auth_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Basic Auth</span>'
        : '';
      let routeAuthTags = '';
      if (r.route_auth_enabled && !r.basic_auth_enabled && r.route_type !== 'l4') {
        // Auth method badge
        const methodLabels = { email_password: GC.t['route_auth.method_email_password'] || 'Email & Password', email_code: GC.t['route_auth.method_email_code'] || 'Email & Code', totp: GC.t['route_auth.method_totp'] || 'TOTP', share: (GC.t && GC.t['route_auth.method_share']) || 'Share link' };
        const methodLabel = methodLabels[r.route_auth_type] || r.route_auth_type;
        routeAuthTags += '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> ' + escapeHtml(methodLabel) + '</span>';
        // 2FA badge
        if (r.route_auth_2fa) {
          const tfaMethodLabels = { email_code: 'Email Code', totp: 'TOTP' };
          const tfaLabel = tfaMethodLabels[r.route_auth_2fa_method] || '';
          routeAuthTags += '<span class="tag tag-amber" style="margin-left:4px">2FA' + (tfaLabel ? ': ' + escapeHtml(tfaLabel) : '') + '</span>';
        }
        // Session duration badge
        if (r.route_auth_session_max_age) {
          const ms = r.route_auth_session_max_age;
          let durLabel;
          if (ms <= 3600000) durLabel = '1h';
          else if (ms <= 43200000) durLabel = '12h';
          else if (ms <= 86400000) durLabel = '24h';
          else if (ms <= 604800000) durLabel = '7d';
          else durLabel = '30d';
          routeAuthTags += '<span class="tag tag-grey" style="margin-left:4px">Session: ' + durLabel + '</span>';
        }
      }
      let l4Tags = '';
      if (r.route_type === 'l4') {
        const protoTag = r.l4_protocol === 'udp' ? 'UDP' : 'TCP';
        l4Tags += '<span class="tag tag-info">' + protoTag + '</span>';
        if (r.l4_tls_mode && r.l4_tls_mode !== 'none') {
          l4Tags += '<span class="tag tag-info">TLS-SNI</span>';
        } else {
          l4Tags += '<span class="tag tag-info">L4</span>';
        }
      }
      const targetDisplay = r.route_type === 'l4'
        ? ':' + (r.l4_listen_port || '') + ' → ' + escapeHtml(peerLabel) + ' (' + escapeHtml(target) + ')'
        : '→ ' + escapeHtml(peerLabel) + ' (' + escapeHtml(target) + ')';

      const l4ShortTitle = (r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + (r.l4_listen_port || '');
      let titleText;
      let showDescLine = !!r.description;
      if (r.domain) {
        titleText = escapeHtml(r.domain);
      } else if (r.route_type === 'l4') {
        if (r.description) { titleText = escapeHtml(r.description); showDescLine = false; }
        else { titleText = l4ShortTitle; }
      } else {
        titleText = '';
      }
      if (opts.subItem) {
        // The domain lives on the group header — sub-items show the
        // protocol role instead, mirroring the approved mockup.
        titleText = r.route_type === 'l4' ? l4ShortTitle : 'HTTP';
        showDescLine = false;
      }

      // Badge budget: status/monitoring/circuit-breaker/L4 type are always
      // visible; the first two feature badges follow, the rest collapse
      // behind a "+N" toggle (expandedBadges survives SSE re-renders).
      const primaryTags = statusTag + monitorTag + cbTag + l4Tags;
      const extraTags = [internalTag, blockActionTag, debugTag, botTag, aclTag, ipFilterTag, rateLimitTag, retryTag,
        backendsTag, stickyTag, httpsTag, backendHttpsTag, compressTag, authTag,
        routeAuthTags, headersTag, mirrorTag].filter(function (tag) { return !!tag; });
      let visibleExtras, moreBtn = '';
      if (expandedBadges.has(String(r.id)) || extraTags.length <= 3) {
        visibleExtras = extraTags.join('');
      } else {
        visibleExtras = extraTags.slice(0, 2).join('');
        moreBtn = '<button type="button" class="tag tag-more" style="margin-left:4px" data-more-id="' + r.id + '">+' + (extraTags.length - 2) + '</button>';
      }

      // r.id is a numeric DB id, safe for attribute use; checked is a static string
      var batchChecked = batchSelected.has(String(r.id)) ? ' checked' : '';
      var batchCbHtml = batchMode ? '<div class="batch-checkbox-wrap" style="display:flex;align-items:center;padding-right:10px"><input type="checkbox" class="batch-checkbox" data-batch-id="' + r.id + '"' + batchChecked + '></div>' : '';

      const typeIcon = r.route_type === 'l4'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>';

      return `<div class="route-item${opts.subItem ? ' route-sub-item' : ''}${batchMode ? ' batch-mode' : ''}" data-route-id="${r.id}">
        ${batchCbHtml}
        <div class="route-icon${r.route_type === 'l4' ? ' route-icon-l4' : ''}">
          ${typeIcon}
        </div>
        <div style="flex:1;min-width:0">
          <div class="route-domain">${titleText}</div>
          <div class="route-target">${targetDisplay}</div>
          ${showDescLine ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(r.description)}</div>` : ''}
        </div>
        <div class="route-tags">
          ${primaryTags}${visibleExtras}${moreBtn}
        </div>
        <div class="route-actions">
          <button class="icon-btn" title="Edit" data-action="edit" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn" title="Toggle" data-action="toggle" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>
          <button class="icon-btn" title="Delete" data-action="delete" data-id="${r.id}" data-domain="${titleText}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }
  }

  // ─── Group + table rendering ─────────────────────────────

  function groupTargetLabel(g) {
    const r = g.routes[0];
    if (r.target_kind === 'gateway') {
      if (r.target_pool_id != null) return 'Pool';
      return 'Gateway · ' + (r.target_peer_name || '');
    }
    return r.peer_name ? ('Peer · ' + r.peer_name) : (r.target_ip || '');
  }

  function statusDotClass(status) {
    return status === 'down' ? 'red' : status === 'active' ? 'green' : 'amber';
  }

  function renderGroupCard(g) {
    const collapsed = collapsedGroups.has(g.key);
    const label = g.label != null
      ? escapeHtml(g.label)
      : escapeHtml(GC.t['routes.group_no_domain'] || 'Without domain');
    const countTxt = (GC.t['routes.group_count'] || '{{count}} routes').replace('{{count}}', g.routes.length);
    const bundleTag = g.isBundle
      ? '<span class="group-bundle-tag">' + escapeHtml(GC.t['service_bundle.badge'] || 'SERVICE') + '</span>'
      : '';
    const targetTag = g.key !== view.NO_DOMAIN_KEY
      ? '<span class="group-target-tag">' + escapeHtml(groupTargetLabel(g)) + '</span>'
      : '';
    const routeIds = g.routes.map(function (r) { return r.id; }).join(',');

    let actions = '';
    if (g.isBundle) {
      actions =
        '<button type="button" class="icon-btn" data-gaction="bundle-add-route" data-bundle-id="' + g.bundleId + '" data-name="' + label + '" title="' + escapeHtml(GC.t['service_bundle.add_route'] || 'Add route') + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>'
        + '<button type="button" class="icon-btn" data-gaction="bundle-toggle" data-bundle-id="' + g.bundleId + '" title="' + escapeHtml(GC.t['service_bundle.toggle_all'] || 'Enable/disable all routes') + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>'
        + '<button type="button" class="icon-btn" data-gaction="bundle-ungroup" data-bundle-id="' + g.bundleId + '" title="' + escapeHtml(GC.t['service_bundle.ungroup'] || 'Ungroup') + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 12h8"/><circle cx="12" cy="12" r="10"/></svg></button>'
        + '<button type="button" class="icon-btn icon-btn-danger" data-gaction="bundle-delete" data-bundle-id="' + g.bundleId + '" data-name="' + label + '" title="' + escapeHtml(GC.t['service_bundle.delete'] || 'Delete service') + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
    } else if (g.key !== view.NO_DOMAIN_KEY) {
      actions =
        '<button type="button" class="icon-btn" data-gaction="group-domain" data-route-ids="' + routeIds + '" data-name="' + label + '" title="' + escapeHtml(GC.t['service_bundle.group_selected'] || 'Group as service') + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v8M8 12h8"/><circle cx="12" cy="12" r="10"/></svg></button>';
    }

    return '<div class="route-group' + (collapsed ? ' collapsed' : '') + '" data-gkey="' + escapeHtml(g.key) + '">'
      + '<div class="route-group-head" data-gtoggle="' + escapeHtml(g.key) + '">'
      + '<svg class="group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'
      + '<span class="group-status-dot ' + statusDotClass(g.status) + '"></span>'
      + '<span class="group-label">' + label + '</span>'
      + bundleTag + targetTag
      + '<span class="group-meta">' + escapeHtml(countTxt) + '</span>'
      + '<span class="group-spacer"></span>'
      + '<div class="group-actions">' + actions + '</div>'
      + '</div>'
      + '<div class="route-group-body">'
      + g.routes.map(function (r) { return renderRouteEntry(r, { subItem: true }); }).join('')
      + '</div></div>';
  }

  // ─── Aurora table rendering ──────────────────────────────
  // These functions are ADDITIVE: renderTableRow/renderTable guard into them
  // when isAurora() is true. Default/pro paths are never modified.

  function auroraRenderTableRow(r, opts) {
    opts = opts || {};
    const isGw = r.target_kind === 'gateway';
    const targetTxt = isGw
      ? ((r.target_lan_host || '?') + ':' + (r.target_lan_port || r.target_port || '?') + (r.target_peer_name ? ' · ' + r.target_peer_name : ''))
      : (((r.peer_ip ? r.peer_ip.split('/')[0] : r.target_ip) || '') + ':' + r.target_port + (r.peer_name ? ' · ' + r.peer_name : ''));

    // Type tag: HTTP → tag-blue, L4 → tag-amber
    var typeTag;
    if (r.route_type === 'l4') {
      typeTag = '<span class="tag tag-amber">' + escapeHtml(r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + escapeHtml(String(r.l4_listen_port || '')) + '</span>';
    } else {
      typeTag = '<span class="tag tag-blue">' + escapeHtml(GC.t['routes.type_http'] || 'HTTP') + '</span>';
    }

    // Auth tag: route-auth → tag-green, basic → tag-green, none / L4 → tag-grey
    var authTag;
    if (r.route_type === 'l4') {
      authTag = '<span class="tag tag-grey">—</span>';
    } else if (r.route_auth_enabled && !r.basic_auth_enabled) {
      authTag = '<span class="tag tag-green">' + escapeHtml(GC.t['route_auth.auth_route'] || 'Route Auth') + '</span>';
    } else if (r.basic_auth_enabled) {
      authTag = '<span class="tag tag-green">' + escapeHtml(GC.t['route_auth.auth_basic'] || 'Basic Auth') + '</span>';
    } else {
      authTag = '<span class="tag tag-grey">' + escapeHtml(GC.t['route_auth.auth_none'] || 'None') + '</span>';
    }

    // Status: CSS toggle widget (clickable via data-action delegation)
    var status = view.routeStatus(r);
    var toggleEl = '<div class="toggle' + (status !== 'disabled' ? ' on' : '') + '" data-action="toggle" data-id="' + r.id + '" style="cursor:pointer" title="Toggle"></div>';

    // Domain display. Grouped members are visually nested via the
    // .aurora-route-sub class (indent + left rail in aurora.css) so they read
    // as belonging to the group header above, distinct from standalone routes.
    var domainTxt = (r.domain ? escapeHtml(r.domain) : '—');

    var delDomain = r.domain ? escapeHtml(r.domain) : ((r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + (r.l4_listen_port || ''));

    // Batch-select checkbox (first column) — only while batch mode is active.
    var batchCell = batchMode
      ? '<td class="td-batch"><input type="checkbox" class="batch-checkbox" data-batch-id="' + r.id + '"' + (batchSelected.has(String(r.id)) ? ' checked' : '') + '></td>'
      : '';
    var rowCls = opts.grouped ? ' class="aurora-route-sub"' : '';
    return '<tr data-route-id="' + r.id + '"' + rowCls + '>'
      + batchCell
      + '<td class="cell-name">' + domainTxt + '</td>'
      + '<td>' + typeTag + '</td>'
      + '<td class="mono">' + escapeHtml(targetTxt) + '</td>'
      + '<td>' + authTag + '</td>'
      + '<td>' + toggleEl + '</td>'
      + '<td><div class="row-actions">'
      + '<button class="icon-action" title="Edit" data-action="edit" data-id="' + r.id + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6 4 4M4 20l1-4L16 5l3 3L8 19l-4 1Z"/></svg>'
      + '</button>'
      + '<button class="icon-action danger" title="Delete" data-action="delete" data-id="' + r.id + '" data-domain="' + delDomain + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>'
      + '</button>'
      + '</div></td></tr>';
  }

  // Chevron for collapsible Aurora group headers (rotates via CSS .collapsed).
  var AURORA_GROUP_CHEVRON = '<svg class="aurora-group-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  // Aurora group-header row: shown for every multi-route group (service
  // bundle or shared domain) so related routes read as a unit, not just a
  // hinted-at indent. Collapsible — clicking the row toggles its members via
  // the shared [data-gtoggle] handler + collapsedGroups set (same persisted
  // localStorage state the default/pro card view uses). Mirrors the default
  // theme's .routes-table-group row.
  function auroraRenderGroupHead(g) {
    var t = GC.t;
    var collapsed = collapsedGroups.has(g.key);
    var label = g.label != null
      ? escapeHtml(g.label)
      : escapeHtml(t['routes.group_no_domain'] || 'Without domain');
    var bundleTag = g.isBundle
      ? '<span class="tag tag-blue aurora-group-badge">' + escapeHtml(t['service_bundle.badge'] || 'SERVICE') + '</span>'
      : '';
    var countTxt = (t['routes.group_count'] || '{{count}} routes').replace('{{count}}', g.routes.length);
    return '<tr class="aurora-group-row' + (collapsed ? ' collapsed' : '') + '" data-gtoggle="' + escapeHtml(g.key) + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '"><td colspan="' + (batchMode ? 7 : 6) + '">'
      + AURORA_GROUP_CHEVRON
      + '<span class="group-status-dot ' + statusDotClass(g.status) + '"></span>'
      + '<span class="aurora-group-label">' + label + '</span>'
      + bundleTag
      + '<span class="aurora-group-count">' + escapeHtml(countTxt) + '</span>'
      + '</td></tr>';
  }

  // Keys of the multi-route groups in the last Aurora render — drives the
  // toolbar "collapse/expand all" toggle. Updated by auroraRenderTable().
  var auroraGroupKeys = [];

  function auroraRenderTable(groups) {
    var t = GC.t;
    var rows = '';
    auroraGroupKeys = [];
    // Aurora: group-headed table. Multi-route groups get a collapsible header
    // row + indented sub-rows; collapsed groups hide their members. Standalone
    // routes render bare. A batch-select checkbox column is prepended in batch mode.
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var grouped = !g.single && g.routes.length > 1;
      if (grouped) {
        auroraGroupKeys.push(g.key);
        rows += auroraRenderGroupHead(g);
        if (collapsedGroups.has(g.key)) continue; // collapsed → members hidden
      }
      for (var ri = 0; ri < g.routes.length; ri++) {
        rows += auroraRenderTableRow(g.routes[ri], { grouped: grouped });
      }
    }
    auroraUpdateCollapseAll();
    if (!rows) {
      return '<div style="font-size:13px;color:var(--faint);padding:20px 0;text-align:center">'
        + escapeHtml(t['routes.no_routes'] || 'No routes configured') + '</div>';
    }
    return '<table class="data-table' + (batchMode ? ' batch-mode' : '') + '"><thead><tr>'
      + (batchMode ? '<th class="td-batch"></th>' : '')
      + '<th>' + escapeHtml(t['routes.table_domain'] || 'Domain') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_type'] || 'Type') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_target'] || 'Target') + '</th>'
      + '<th>' + escapeHtml(t['route_auth.auth_type'] || 'Auth') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_status'] || 'Status') + '</th>'
      + '<th></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function auroraInitTypeToggle() {
    var typeToggle = document.getElementById('aurora-type-toggle');
    if (!typeToggle) return;
    typeToggle.addEventListener('click', function (e) {
      var btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      if (btn.dataset.nav) { window.location.href = btn.dataset.nav; return; }
      typeToggle.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      viewState.typeFilter = btn.dataset.value || null;
      render();
    });
  }

  // Reflects the "collapse all / expand all" toolbar button: hidden when no
  // multi-route groups exist, otherwise labelled by what the click will do.
  function auroraUpdateCollapseAll() {
    var btn = document.getElementById('aurora-collapse-all');
    if (!btn) return;
    if (!auroraGroupKeys.length) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    var allCollapsed = auroraGroupKeys.every(function (k) { return collapsedGroups.has(k); });
    var lbl = btn.querySelector('.aurora-collapse-all-lbl');
    if (lbl) {
      lbl.textContent = allCollapsed
        ? (GC.t['routes.expand_all'] || 'Expand all')
        : (GC.t['routes.collapse_all'] || 'Collapse all');
    }
    btn.classList.toggle('all-collapsed', allCollapsed);
  }

  function auroraInitCollapseAll() {
    var btn = document.getElementById('aurora-collapse-all');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var allCollapsed = auroraGroupKeys.length > 0
        && auroraGroupKeys.every(function (k) { return collapsedGroups.has(k); });
      // All collapsed → expand all; otherwise collapse all.
      auroraGroupKeys.forEach(function (k) {
        if (allCollapsed) collapsedGroups.delete(k);
        else collapsedGroups.add(k);
      });
      lsSetSet('gc_routes_groups_collapsed_v1', collapsedGroups);
      render();
    });
  }

  function renderTableRow(r, opts) {
    if (isAurora()) return auroraRenderTableRow(r, opts);
    opts = opts || {};
    const isGw = r.target_kind === 'gateway';
    const targetTxt = isGw
      ? ((r.target_lan_host || '?') + ':' + (r.target_lan_port || r.target_port || '?') + (r.target_peer_name ? ' · ' + r.target_peer_name : ''))
      : (((r.peer_ip ? r.peer_ip.split('/')[0] : r.target_ip) || '') + ':' + r.target_port + (r.peer_name ? ' · ' + r.peer_name : ''));
    const typeTag = r.route_type === 'l4'
      ? '<span class="tag tag-info">' + (r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + escapeHtml(String(r.l4_listen_port || '')) + '</span>'
      : '<span class="tag">HTTP</span>';
    const status = view.routeStatus(r);
    const statusTag = status === 'disabled'
      ? '<span class="tag tag-amber"><span class="tag-dot"></span>' + escapeHtml(GC.t['routes.disabled'] || 'Disabled') + '</span>'
      : status === 'down'
        ? '<span class="tag tag-red"><span class="tag-dot"></span>DOWN</span>'
        : '<span class="tag tag-green"><span class="tag-dot"></span>' + escapeHtml(GC.t['routes.active'] || 'Active') + '</span>';
    const monitorTxt = (r.monitoring_enabled && r.monitoring_status === 'up' && r.monitoring_response_time != null)
      ? ' <span class="tag tag-green">UP ' + (parseInt(r.monitoring_response_time, 10) || 0) + 'ms</span>'
      : '';
    const domainTxt = opts.subRow
      ? '<span style="color:var(--text-3)">└ ' + (r.domain ? escapeHtml(r.domain) : '—') + '</span>'
      : (r.domain ? escapeHtml(r.domain) : '—');
    const batchChecked = batchSelected.has(String(r.id)) ? ' checked' : '';
    const batchCell = batchMode
      ? '<td class="td-batch"><input type="checkbox" class="batch-checkbox" data-batch-id="' + r.id + '"' + batchChecked + '></td>'
      : '';
    const delDomain = r.domain ? escapeHtml(r.domain) : ((r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + (r.l4_listen_port || ''));
    return '<tr data-route-id="' + r.id + '"' + (status === 'disabled' ? ' style="opacity:.6"' : '') + '>'
      + batchCell
      + '<td class="mono">' + domainTxt + '</td>'
      + '<td>' + typeTag + '</td>'
      + '<td class="mono">' + escapeHtml(targetTxt) + '</td>'
      + '<td>' + statusTag + monitorTxt + '</td>'
      + '<td class="td-actions">'
      + '<button class="icon-btn" title="Edit" data-action="edit" data-id="' + r.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
      + '<button class="icon-btn" title="Toggle" data-action="toggle" data-id="' + r.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg></button>'
      + '<button class="icon-btn" title="Delete" data-action="delete" data-id="' + r.id + '" data-domain="' + delDomain + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>'
      + '</td></tr>';
  }

  function renderTable(groups) {
    if (isAurora()) return auroraRenderTable(groups);
    const t = GC.t;
    const batchHead = batchMode ? '<th class="td-batch"></th>' : '';
    let rows = '';
    for (const g of groups) {
      if (!g.single && g.routes.length > 1) {
        const label = g.label != null
          ? escapeHtml(g.label)
          : escapeHtml(t['routes.group_no_domain'] || 'Without domain');
        const bundleTag = g.isBundle ? ' <span class="group-bundle-tag">' + escapeHtml(t['service_bundle.badge'] || 'SERVICE') + '</span>' : '';
        const countTxt = (t['routes.group_count'] || '{{count}} routes').replace('{{count}}', g.routes.length);
        rows += '<tr class="routes-table-group"><td colspan="' + (batchMode ? 6 : 5) + '">'
          + '<span class="group-status-dot ' + statusDotClass(g.status) + '"></span>'
          + label + bundleTag + ' · ' + escapeHtml(countTxt)
          + '</td></tr>';
        rows += g.routes.map(function (r, i) { return renderTableRow(r, { subRow: i > 0 }); }).join('');
      } else {
        rows += g.routes.map(function (r) { return renderTableRow(r, {}); }).join('');
      }
    }
    return '<div class="routes-table-wrap"><table class="routes-table"><thead><tr>'
      + batchHead
      + '<th>' + escapeHtml(t['routes.table_domain'] || 'Domain') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_type'] || 'Type') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_target'] || 'Target') + '</th>'
      + '<th>' + escapeHtml(t['routes.table_status'] || 'Status') + '</th>'
      + '<th class="td-actions">' + escapeHtml(t['routes.table_actions'] || 'Actions') + '</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  const GROUP_STATUS_ORDER = { down: 0, mixed: 1, disabled: 2, active: 3 };
  function sortGroups(groups, key) {
    // The no-domain bucket stays last in every ordering.
    groups.sort(function (a, b) {
      if (a.key === view.NO_DOMAIN_KEY) return 1;
      if (b.key === view.NO_DOMAIN_KEY) return -1;
      if (key === 'status') {
        const d = GROUP_STATUS_ORDER[a.status] - GROUP_STATUS_ORDER[b.status];
        if (d !== 0) return d;
      } else if (key === 'type') {
        const d = (a.routes[0].route_type === 'l4' ? 1 : 0) - (b.routes[0].route_type === 'l4' ? 1 : 0);
        if (d !== 0) return d;
      }
      return String(a.label || '').localeCompare(String(b.label || ''));
    });
    return groups;
  }

  function render() {
    const q = routeSearch ? routeSearch.value : '';
    const hasFilter = !!(q.trim() || viewState.typeFilter || viewState.statusFilter || viewState.targetFilter);
    const filtered = view.filterRoutes(allRoutes, {
      q,
      type: viewState.typeFilter,
      status: viewState.statusFilter,
      target: viewState.targetFilter,
    });
    if (!filtered.length) {
      const msg = hasFilter
        ? (GC.t['routes.no_match'] || 'No routes match the filter')
        : (GC.t['routes.no_routes'] || 'No routes configured');
      routesList.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">' + escapeHtml(msg) + '</div>';
      return;
    }
    const groups = sortGroups(view.buildGroups(filtered), viewState.sort);
    if (viewState.view === 'table') {
      routesList.innerHTML = renderTable(groups);
    } else {
      routesList.innerHTML = groups.map(function (g) {
        return g.single ? renderRouteEntry(g.routes[0], {}) : renderGroupCard(g);
      }).join('');
    }
  }

  // Kept as the historical entry point — every caller funnels into render().
  function applyRouteFilter() { render(); }

  if (routeSearch) {
    routeSearch.addEventListener('input', () => applyRouteFilter());
  }

  // ─── Route list action delegation ────────────────────────
  routesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      switch (action) {
        case 'edit': showEditModal(id); break;
        case 'toggle': toggleRoute(id); break;
        case 'delete': showConfirmDelete(id, btn.dataset.domain); break;
      }
      return;
    }

    // "+N" badge expander — state survives SSE re-renders
    const more = e.target.closest('[data-more-id]');
    if (more) {
      const rid = String(more.dataset.moreId);
      if (expandedBadges.has(rid)) expandedBadges.delete(rid);
      else expandedBadges.add(rid);
      render();
      return;
    }

    // Group lockstep actions (service bundles / group-as-service)
    const gbtn = e.target.closest('[data-gaction]');
    if (gbtn) {
      handleGroupAction(gbtn);
      return;
    }

    // Header click toggles collapse (ignored while selecting in batch mode)
    const head = e.target.closest('[data-gtoggle]');
    if (head && !batchMode) {
      const key = head.dataset.gtoggle;
      if (collapsedGroups.has(key)) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
      lsSetSet('gc_routes_groups_collapsed_v1', collapsedGroups);
      render();
    }
  });

  async function handleGroupAction(btn) {
    const gaction = btn.dataset.gaction;
    try {
      if (gaction === 'bundle-toggle') {
        const bundleId = parseInt(btn.dataset.bundleId, 10);
        const members = allRoutes.filter(function (r) { return r.bundle_id === bundleId; });
        const allEnabled = members.length > 0 && members.every(function (r) { return r.enabled; });
        await api.put('/api/v1/service-bundles/' + bundleId + '/toggle', { enabled: !allEnabled });
        loadRoutes();
      } else if (gaction === 'bundle-ungroup') {
        const bundleId = parseInt(btn.dataset.bundleId, 10);
        if (!confirm(GC.t['service_bundle.confirm_ungroup'] || 'Ungroup this service? The routes are kept.')) return;
        await api.del('/api/v1/service-bundles/' + bundleId + '?delete_routes=false');
        loadRoutes();
      } else if (gaction === 'bundle-delete') {
        const bundleId = parseInt(btn.dataset.bundleId, 10);
        const msg = (GC.t['service_bundle.confirm_delete'] || 'Delete service "{{name}}" and all its routes?')
          .replace('{{name}}', btn.dataset.name || '');
        if (!confirm(msg)) return;
        await api.del('/api/v1/service-bundles/' + bundleId);
        loadRoutes();
      } else if (gaction === 'bundle-add-route') {
        const bundleId = parseInt(btn.dataset.bundleId, 10);
        openAddRouteToBundlePicker(bundleId, btn.dataset.name || '');
      } else if (gaction === 'group-domain') {
        const ids = (btn.dataset.routeIds || '').split(',').map(Number).filter(Boolean);
        if (!ids.length) return;
        const data = await api.post('/api/v1/service-bundles/group', {
          name: btn.dataset.name || '',
          route_ids: ids,
        });
        if (!data.ok) { alert(data.error || (GC.t['common.error'] || 'Error')); return; }
        loadRoutes();
      }
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  // Friendly one-line descriptor for a route in the add-to-bundle picker.
  function routePickLabel(r) {
    const typ = (r.route_type === 'l4') ? 'L4' : 'HTTP';
    const name = r.domain || (r.l4_listen_port ? (':' + r.l4_listen_port) : ('#' + r.id));
    const tgt = (r.target_ip || r.target_host || '') + (r.target_port ? (':' + r.target_port) : '');
    return { typ, name, tgt };
  }

  // Lightweight dynamic picker overlay — lists currently-unbundled routes and
  // POSTs the selected ones to /service-bundles/:id/routes. Reuses the global
  // .modal-overlay class; no template markup needed. Server validates the
  // membership rules (one HTTP max, no RDP-linked L4) and the error surfaces
  // inline.
  function openAddRouteToBundlePicker(bundleId, bundleName) {
    const T = (k, fb) => (GC.t[k] || fb);
    const candidates = (allRoutes || []).filter((r) => r.bundle_id == null);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-panel);border-radius:var(--radius);width:560px;max-width:94vw;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2);padding:22px 24px';
    overlay.appendChild(card);

    const h = document.createElement('div');
    h.style.cssText = 'font-family:var(--font-display);font-size:18px;margin-bottom:4px';
    h.textContent = T('service_bundle.add_route_title', 'Add route to “{{name}}”').replace('{{name}}', bundleName);
    card.appendChild(h);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-2);margin-bottom:14px';
    hint.textContent = T('service_bundle.add_route_hint', 'Pick one or more ungrouped routes to add to this service.');
    card.appendChild(hint);

    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:8px';
    card.appendChild(listWrap);

    const checks = [];
    if (!candidates.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px 0;text-align:center;color:var(--text-3);font-size:13px';
      empty.textContent = T('service_bundle.add_route_empty', 'No ungrouped routes available to add.');
      listWrap.appendChild(empty);
    } else {
      candidates.forEach((r) => {
        const lab = routePickLabel(r);
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = String(r.id);
        checks.push(cb);
        const txt = document.createElement('div');
        txt.style.cssText = 'display:flex;flex-direction:column;min-width:0';
        const t1 = document.createElement('span');
        t1.style.cssText = 'font-weight:600;font-size:13px;color:var(--text-primary)';
        t1.textContent = lab.typ + ' · ' + lab.name;
        const t2 = document.createElement('span');
        t2.style.cssText = 'font-size:11px;color:var(--text-3);font-family:var(--font-mono)';
        t2.textContent = lab.tgt;
        txt.appendChild(t1); if (lab.tgt) txt.appendChild(t2);
        row.appendChild(cb); row.appendChild(txt);
        listWrap.appendChild(row);
      });
    }

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:var(--red,#dc2626);min-height:16px;margin:6px 0';
    card.appendChild(msg);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:10px';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn';
    cancel.textContent = T('service_bundle.add_route_cancel', 'Cancel');
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn-primary';
    add.textContent = T('service_bundle.add_route_confirm', 'Add');
    add.disabled = !candidates.length;
    footer.appendChild(cancel); footer.appendChild(add);
    card.appendChild(footer);

    function close() { overlay.remove(); }
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    add.addEventListener('click', async () => {
      const ids = checks.filter((c) => c.checked).map((c) => parseInt(c.value, 10));
      if (!ids.length) { msg.textContent = T('service_bundle.add_route_hint', 'Pick one or more ungrouped routes to add to this service.'); return; }
      add.disabled = true;
      try {
        const data = await api.post('/api/v1/service-bundles/' + bundleId + '/routes', { route_ids: ids });
        if (!data.ok) { msg.textContent = data.error || T('common.error', 'Error'); add.disabled = false; return; }
        close();
        loadRoutes();
      } catch (err) {
        msg.textContent = err.message || T('common.error', 'Error');
        add.disabled = false;
      }
    });

    document.body.appendChild(overlay);
  }

  // ─── Create form: target-kind (peer vs gateway vs pool) toggle ───
  (function initCreateTargetKindToggle() {
    const tkSel = document.getElementById('create-route-target-kind');
    const peerFields = document.getElementById('create-route-peer-fields');
    const gwFields = document.getElementById('create-route-gateway-fields');
    const poolFields = document.getElementById('create-route-pool-fields');
    const wolCb = document.getElementById('create-route-wol-enabled');
    const wolMacField = document.getElementById('create-route-wol-mac-field');
    if (tkSel && peerFields && gwFields) {
      const sync = () => {
        const kind = tkSel.value;
        peerFields.style.display = kind === 'peer' ? '' : 'none';
        gwFields.style.display = kind === 'gateway' ? '' : 'none';
        if (poolFields) poolFields.style.display = kind === 'pool' ? '' : 'none';
      };
      tkSel.addEventListener('change', sync);
      sync();
    }
    if (wolCb && wolMacField) {
      const syncWol = () => { wolMacField.style.display = wolCb.checked ? '' : 'none'; };
      wolCb.addEventListener('change', syncWol);
      syncWol();
    }
  })();

  // ─── Create route via inline form ────────────────────────
  routeForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fd = new FormData(routeForm);
    const _cBaseSel = document.getElementById('create-route-base-domain');
    const _cPfxEl = document.getElementById('create-route-prefix');
    const _cFtEl = document.getElementById('create-route-domain-freetext');
    const _cFtMode = _cBaseSel && _cBaseSel.value === '';
    const domain = _cFtMode
      ? ((_cFtEl && _cFtEl.value) || '').trim()
      : (window.RouteDomain && _cBaseSel
          ? window.RouteDomain.assembleRouteDomain((_cPfxEl && _cPfxEl.value) || '', _cBaseSel.value || '')
          : '');
    const description = fd.get('description') ? fd.get('description').trim() : '';
    const targetKind = (document.getElementById('create-route-target-kind')?.value) || 'peer';
    const isGateway = targetKind === 'gateway';
    const peer_id = isGateway ? null : (fd.get('peer_id') || null);
    const lanPortVal = document.getElementById('create-route-lan-port')?.value || '';
    const target_port = isGateway ? lanPortVal.trim() : fd.get('target_port').trim();

    const httpsToggle = routeForm.querySelector('[data-field="https_enabled"]');
    const backendHttpsToggle = routeForm.querySelector('[data-field="backend_https"]');

    const https_enabled = httpsToggle ? httpsToggle.classList.contains('on') : true;
    const backend_https = backendHttpsToggle ? backendHttpsToggle.classList.contains('on') : false;

    const authType = document.getElementById('create-auth-type')?.value || 'none';
    const basic_auth_enabled = authType === 'basic';
    const basic_auth_user = fd.get('basic_auth_user') ? fd.get('basic_auth_user').trim() : '';
    const basic_auth_password = fd.get('basic_auth_password') ? fd.get('basic_auth_password').trim() : '';

    const submitRouteType = document.getElementById('route-type')?.value || 'http';
    const submitTlsMode = document.getElementById('l4-tls-mode')?.value || 'none';
    const submitIsL4None = submitRouteType === 'l4' && submitTlsMode === 'none';
    if (!domain && !submitIsL4None) {
      alert(GC.t['routes.domain_required'] || 'Domain is required');
      return;
    }
    if (!target_port) {
      alert(isGateway
        ? (GC.t['route_lan_port_required'] || 'LAN port is required')
        : (GC.t['routes.target_port_required'] || 'Target port is required'));
      return;
    }

    if (isGateway) {
      const gwPeer = document.getElementById('create-route-gateway-peer')?.value || '';
      const lanHost = document.getElementById('create-route-lan-host')?.value.trim() || '';
      if (!gwPeer || !lanHost) {
        alert(GC.t['route_gateway_required'] || 'Gateway, LAN host and LAN port are required');
        return;
      }
    } else {
      // Peer mode requires a selected peer (otherwise route target defaults to 127.0.0.1 silently)
      if (!peer_id) {
        alert(GC.t['routes.peer_required'] || 'Please select a target peer');
        return;
      }
    }

    if (basic_auth_enabled && (!basic_auth_user || !basic_auth_password)) {
      alert(GC.t['routes.auth_basic_required'] || 'Basic auth username and password are required when auth is enabled');
      return;
    }

    const submitBtn = document.getElementById('route-wizard-save') || routeForm.querySelector('button[type="submit"]');
    btnLoading(submitBtn);
    try {
      const createMonitoring = document.getElementById('create-route-monitoring')?.classList.contains('on') || false;
      const createIpFilter = document.getElementById('create-route-ip-filter')?.classList.contains('on') || false;
      const createAcl = document.getElementById('create-route-acl')?.classList.contains('on') || false;
      const createCompress = document.getElementById('create-route-compress')?.classList.contains('on') || false;
      const createExternal = document.getElementById('create-route-external')?.classList.contains('on') || false;
      const createRateLimit = document.getElementById('create-route-rate-limit')?.classList.contains('on') || false;
      const createRetry = document.getElementById('create-route-retry')?.classList.contains('on') || false;
      const createCb = document.getElementById('create-route-circuit-breaker')?.classList.contains('on') || false;
      const createDebug = document.getElementById('create-route-debug')?.classList.contains('on') || false;
      const createBotBlocker = document.getElementById('create-route-bot-blocker')?.classList.contains('on') || false;
      const createBotMode = document.getElementById('create-bot-blocker-mode')?.value || 'block';
      let createBotConfig = null;
      if (createBotMode === 'redirect') {
        createBotConfig = JSON.stringify({ url: document.getElementById('create-bot-blocker-url')?.value || '' });
      } else if (createBotMode === 'custom') {
        createBotConfig = JSON.stringify({
          message: document.getElementById('create-bot-blocker-message')?.value || '',
          status_code: parseInt(document.getElementById('create-bot-blocker-status')?.value) || 403,
        });
      }
      const payload = {
        domain, description, peer_id, target_port, https_enabled, backend_https, basic_auth_enabled,
        compress_enabled: createCompress,
        external_enabled: createExternal,
        monitoring_enabled: createMonitoring,
        ip_filter_enabled: createIpFilter,
        ip_filter_mode: document.getElementById('create-ip-filter-mode')?.value || 'whitelist',
        ip_filter_rules: createIpFilter ? JSON.stringify(createIpFilterRules) : null,
        acl_enabled: createAcl,
        acl_peers: createAcl ? getSelectedAclPeers('create') : [],
        rate_limit_enabled: createRateLimit,
        rate_limit_requests: createRateLimit ? parseInt(document.getElementById('create-rate-limit-requests')?.value || '100', 10) : 100,
        rate_limit_window: createRateLimit ? (document.getElementById('create-rate-limit-window')?.value || '1m') : '1m',
        retry_enabled: createRetry,
        retry_count: createRetry ? parseInt(document.getElementById('create-retry-count')?.value || '3', 10) : 3,
        retry_match_status: createRetry ? (document.getElementById('create-retry-status')?.value || '502,503,504') : '502,503,504',
        circuit_breaker_enabled: createCb,
        circuit_breaker_threshold: createCb ? parseInt(document.getElementById('create-cb-threshold')?.value || '5', 10) : 5,
        circuit_breaker_timeout: createCb ? parseInt(document.getElementById('create-cb-timeout')?.value || '30', 10) : 30,
        debug_enabled: createDebug,
        bot_blocker_enabled: createBotBlocker,
        bot_blocker_mode: createBotBlocker ? createBotMode : 'block',
        bot_blocker_config: createBotBlocker ? createBotConfig : null,
        mirror_enabled: document.getElementById('create-route-mirror')?.classList.contains('on') ? 1 : 0,
        mirror_targets: createMirrorTargets.length > 0 ? createMirrorTargets : null,
        target_kind: targetKind,
      };
      const createBlockAction = document.getElementById('create-route-block-action')?.value || 'inherit';
      payload.external_block_action = createBlockAction;
      if (createBlockAction === 'custom') payload.external_block_body = document.getElementById('create-route-block-body')?.value || '';
      if (createBlockAction === 'redirect') payload.external_block_redirect_url = document.getElementById('create-route-block-redirect')?.value || '';
      if (isGateway) {
        const gwPeerVal = document.getElementById('create-route-gateway-peer')?.value || '';
        const lanHostVal = document.getElementById('create-route-lan-host')?.value || '';
        const lanPortNum = parseInt(document.getElementById('create-route-lan-port')?.value || '', 10);
        const wolEnabled = !!document.getElementById('create-route-wol-enabled')?.checked;
        const wolMacVal = document.getElementById('create-route-wol-mac')?.value || '';
        payload.target_peer_id = gwPeerVal ? parseInt(gwPeerVal, 10) : null;
        payload.target_lan_host = lanHostVal.trim() || null;
        payload.target_lan_port = Number.isInteger(lanPortNum) ? lanPortNum : null;
        payload.wol_enabled = wolEnabled;
        payload.wol_mac = wolEnabled ? (wolMacVal.trim() || null) : null;
      }
      // User visibility
      var createUserIds = [];
      document.querySelectorAll('.create-route-user-cb:checked').forEach(function (cb) {
        createUserIds.push(parseInt(cb.value, 10));
      });
      if (createUserIds.length > 0) payload.user_ids = createUserIds;
      const routeType = document.getElementById('route-type').value;
      payload.route_type = routeType;
      if (routeType === 'l4') {
        payload.l4_protocol = document.getElementById('l4-protocol').value;
        payload.l4_listen_port = document.getElementById('l4-listen-port').value;
        payload.l4_tls_mode = document.getElementById('l4-tls-mode').value;
      }
      if (routeType === 'l4' && payload.l4_tls_mode === 'none') {
        payload.domain = '';
      }
      if (basic_auth_enabled) {
        payload.basic_auth_user = basic_auth_user;
        payload.basic_auth_password = basic_auth_password;
      }
      const data = await api.post('/api/routes', payload);
      if (data.ok) {
        // If Route Auth selected, configure it on the new route
        if (authType === 'route' && data.route && data.route.id) {
          var raMethod = document.getElementById('create-ra-method')?.value || 'email_password';
          var is2fa = document.getElementById('create-ra-2fa')?.classList.contains('on') || false;
          var raEmailVal, raPasswordVal;
          if (is2fa) {
            raEmailVal = document.getElementById('create-ra-2fa-email')?.value || null;
            raPasswordVal = document.getElementById('create-ra-2fa-password')?.value || null;
          } else {
            raEmailVal = document.getElementById('create-ra-email')?.value || null;
            raPasswordVal = document.getElementById('create-ra-password')?.value || null;
          }
          var raPayload = {
            auth_type: is2fa ? 'email_password' : raMethod,
            two_factor_enabled: is2fa,
            two_factor_method: is2fa ? raMethod : null,
            email: raEmailVal,
            password: raPasswordVal,
            session_max_age: parseInt(document.getElementById('create-ra-session-duration')?.value || '86400000', 10),
          };
          try {
            await api.post('/api/routes/' + data.route.id + '/auth', raPayload);
          } catch (raErr) {
            console.error('Route auth config failed:', raErr);
          }
        }
        // Flush buffered access-window rules to the freshly created route.
        if (data.route && data.route.id && createAccessRules.length) {
          for (const ar of createAccessRules) {
            const arPayload = { mode: ar.mode, schedule: ar.schedule };
            if (ar.valid_from) arPayload.valid_from = ar.valid_from;
            if (ar.valid_until) arPayload.valid_until = ar.valid_until;
            if (ar.label) arPayload.label = ar.label;
            try {
              await shareFetch('/api/v1/routes/' + data.route.id + '/access-rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(arPayload),
              });
            } catch (arErr) {
              console.error('Access rule create failed:', arErr);
            }
          }
        }
        routeForm.reset();
        // Reset toggles
        if (httpsToggle) httpsToggle.classList.add('on');
        if (backendHttpsToggle) backendHttpsToggle.classList.remove('on');
        var ccmp = document.getElementById('create-route-compress');
        if (ccmp) ccmp.classList.remove('on');
        var cext = document.getElementById('create-route-external');
        if (cext) cext.classList.remove('on');
        var cmt = document.getElementById('create-route-monitoring');
        if (cmt) cmt.classList.remove('on');
        var cipf = document.getElementById('create-route-ip-filter');
        if (cipf) cipf.classList.remove('on');
        var cipfFields = document.getElementById('create-ip-filter-fields');
        if (cipfFields) cipfFields.style.display = 'none';
        var cacl = document.getElementById('create-route-acl');
        if (cacl) cacl.classList.remove('on');
        var caclFields = document.getElementById('create-acl-fields');
        if (caclFields) caclFields.style.display = 'none';
        var crl = document.getElementById('create-route-rate-limit');
        if (crl) crl.classList.remove('on');
        var crlFields = document.getElementById('create-rate-limit-fields');
        if (crlFields) crlFields.style.display = 'none';
        var crt = document.getElementById('create-route-retry');
        if (crt) crt.classList.remove('on');
        var crtFields = document.getElementById('create-retry-fields');
        if (crtFields) crtFields.style.display = 'none';
        var ccb = document.getElementById('create-route-circuit-breaker');
        if (ccb) ccb.classList.remove('on');
        var ccbFields = document.getElementById('create-circuit-breaker-fields');
        if (ccbFields) ccbFields.style.display = 'none';
        var createDebugToggle = document.getElementById('create-route-debug');
        if (createDebugToggle) createDebugToggle.classList.remove('on');
        var cmr = document.getElementById('create-route-mirror');
        if (cmr) cmr.classList.remove('on');
        var cmrFields = document.getElementById('create-mirror-fields');
        if (cmrFields) cmrFields.style.display = 'none';
        createMirrorTargets.length = 0;
        renderCreateMirrorTargets();
        createAccessRules.length = 0;
        renderCreateAccessRules();
        renderUserCheckboxes('create-route-user-ids', [], 'create-route-user-cb');
        createIpFilterRules.length = 0;
        renderIpFilterRules('create', createIpFilterRules);
        setToggleGroup('create-auth-type-group', 'create-auth-type', 'none');
        updateCreateAuthTypeUI();
        // Close wizard modal on success
        if (typeof window.closeRouteWizard === 'function') window.closeRouteWizard();
        loadRoutes();
      } else if (data.fields) {
        // Map target_port error to the visible input for the active target_kind.
        // In gateway mode #route-port is inside a display:none div, so the error
        // would be attached to an invisible element.
        showFieldErrors(data.fields, {
          domain: (document.getElementById('create-route-base-domain')?.value === '' ? 'create-route-domain-freetext' : 'create-route-base-domain'),
          target_port: isGateway ? 'create-route-lan-port' : 'route-port',
          description: 'route-description', target_ip: 'route-ip',
        });
        if (data.error) alert(data.error);
      } else {
        alert(data.error || 'Failed to create route');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      btnReset(submitBtn);
    }
  });

  // ─── Create-Route Wizard ──────────────────────────────────
  const btnAdd = document.getElementById('btn-add-route');
  const routeModalOverlay = document.getElementById('route-modal-overlay');
  const routeModalClose = document.getElementById('route-modal-close');
  const wizardPrev = document.getElementById('route-wizard-prev');
  const wizardNext = document.getElementById('route-wizard-next');
  const wizardSave = document.getElementById('route-wizard-save');
  const wizardStepIndicator = document.getElementById('route-wizard-step-indicator');
  const wizardSubtitle = document.getElementById('route-modal-subtitle');
  const wizardStepTitle = document.getElementById('route-modal-steptitle');
  const wizardReviewEl = document.getElementById('route-wizard-review');
  const routeTypeInput = document.getElementById('route-type');

  const WIZARD_STEP_LABELS = {
    1: (GC.t && GC.t['routes.wizard.step_target']) || 'Ziel',
    2: (GC.t && GC.t['routes.wizard.step_transport']) || 'Transport',
    3: (GC.t && GC.t['routes.wizard.step_auth']) || 'Authentifizierung',
    4: (GC.t && GC.t['routes.wizard.step_access']) || 'Zugriff',
    5: (GC.t && GC.t['routes.wizard.step_reliability']) || 'Zuverlässigkeit',
    6: (GC.t && GC.t['routes.wizard.step_review']) || 'Übersicht',
  };

  let currentWizardStep = 1;

  function isL4Route() {
    return (routeTypeInput && routeTypeInput.value === 'l4');
  }

  function visibleWizardSteps() {
    // L4 routes skip transport/auth/access/reliability (all inside #http-fields)
    return isL4Route() ? [1, 6] : [1, 2, 3, 4, 5, 6];
  }

  function showWizardStep(n) {
    if (!routeModalOverlay) return;
    const steps = visibleWizardSteps();
    if (!steps.includes(n)) n = steps[0];
    currentWizardStep = n;

    routeModalOverlay.querySelectorAll('[data-wizard-step]').forEach(el => {
      el.style.display = (Number(el.dataset.wizardStep) === n) ? '' : 'none';
    });

    const dots = Array.from(routeModalOverlay.querySelectorAll('.route-step-dot'));
    const lines = Array.from(routeModalOverlay.querySelectorAll('.route-step-line'));
    dots.forEach(dot => dot.classList.remove('active', 'done'));
    lines.forEach(line => line.classList.remove('done'));
    const idx = steps.indexOf(n);
    dots.forEach(dot => {
      const stepN = Number(dot.dataset.pill);
      if (!steps.includes(stepN)) {
        dot.style.opacity = '0.35';
        dot.style.cursor = 'default';
        return;
      }
      dot.style.opacity = '';
      const dotIdx = steps.indexOf(stepN);
      if (stepN === n) dot.classList.add('active');
      else if (dotIdx < idx) dot.classList.add('done');
    });
    // Mark lines done based on visible dot order in DOM
    let completedCount = 0;
    dots.forEach((dot, i) => {
      const stepN = Number(dot.dataset.pill);
      if (steps.includes(stepN) && steps.indexOf(stepN) < idx) {
        if (lines[i]) lines[i].classList.add('done');
        completedCount++;
      }
    });

    if (wizardStepIndicator) wizardStepIndicator.textContent = (idx + 1) + ' / ' + steps.length;
    if (wizardSubtitle) wizardSubtitle.textContent = ((GC.t && GC.t['routes.wizard.step']) || 'Schritt') + ' ' + (idx + 1) + '/' + steps.length;
    if (wizardStepTitle) wizardStepTitle.textContent = WIZARD_STEP_LABELS[n] || '';

    if (wizardPrev) wizardPrev.style.visibility = (idx === 0) ? 'hidden' : '';
    const isLast = (idx === steps.length - 1);
    if (wizardNext) wizardNext.style.display = isLast ? 'none' : '';
    if (wizardSave) wizardSave.style.display = isLast ? '' : 'none';

    if (isLast) renderWizardReview();
  }

  function wizardError(msgKey, fallback, focusEl) {
    const msg = (GC.t && GC.t[msgKey]) || fallback;
    if (typeof window.showToast === 'function') window.showToast(msg, 'error');
    else alert(msg);
    if (focusEl) { try { focusEl.focus(); } catch (_) {} }
    return false;
  }

  function validateWizardStep(n) {
    if (n !== 1) return true;
    const _vBaseSel = document.getElementById('create-route-base-domain');
    const _vPfxEl = document.getElementById('create-route-prefix');
    const _vFtEl = document.getElementById('create-route-domain-freetext');
    const _vFtMode = _vBaseSel && _vBaseSel.value === '';
    const domain = _vFtMode
      ? ((_vFtEl && _vFtEl.value) || '').trim()
      : (window.RouteDomain && _vBaseSel
          ? window.RouteDomain.assembleRouteDomain((_vPfxEl && _vPfxEl.value) || '', _vBaseSel.value || '')
          : (_vBaseSel && _vBaseSel.value || ''));
    const domainErrEl = _vFtMode ? _vFtEl : _vBaseSel;
    const tlsModeC = (document.getElementById('l4-tls-mode') || {}).value || 'none';
    const isL4None = isL4Route() && tlsModeC === 'none';
    if (!domain && !isL4None) return wizardError('routes.domain_required', 'Domain is required', domainErrEl);
    if (isL4Route()) {
      const lpEl = document.getElementById('l4-listen-port');
      if (!lpEl || !lpEl.value.trim()) return wizardError('routes.l4_listen_port_required', 'Listen-Port erforderlich', lpEl);
      if (!checkListenPortBlocked('l4-listen-port', 'l4-listen-port-error')) { try { lpEl.focus(); } catch (_) {} return false; }
      return true;
    }
    const tk = (document.getElementById('create-route-target-kind') || {}).value || 'peer';
    if (tk === 'gateway') {
      const gwEl = document.getElementById('create-route-gateway-peer');
      const hostEl = document.getElementById('create-route-lan-host');
      const portEl = document.getElementById('create-route-lan-port');
      if (!((gwEl || {}).value)) return wizardError('route_gateway_peer_required', 'Gateway erforderlich', gwEl);
      if (!(((hostEl || {}).value) || '').trim()) return wizardError('route_lan_host_required', 'LAN-Host erforderlich', hostEl);
      if (!((portEl || {}).value)) return wizardError('route_lan_port_required', 'LAN-Port erforderlich', portEl);
    } else {
      const peerEl = document.getElementById('route-peer-select');
      const portEl = document.getElementById('route-port');
      if (!((peerEl || {}).value)) return wizardError('routes.peer_required', 'Peer erforderlich', peerEl);
      if (!(((portEl || {}).value) || '').trim()) return wizardError('routes.target_port_required', 'Target-Port erforderlich', portEl);
    }
    return true;
  }

  function goWizardNext() {
    if (!validateWizardStep(currentWizardStep)) return;
    const steps = visibleWizardSteps();
    const idx = steps.indexOf(currentWizardStep);
    if (idx < steps.length - 1) showWizardStep(steps[idx + 1]);
  }

  function goWizardPrev() {
    const steps = visibleWizardSteps();
    const idx = steps.indexOf(currentWizardStep);
    if (idx > 0) showWizardStep(steps[idx - 1]);
  }

  function renderWizardReview() {
    if (!wizardReviewEl) return;
    while (wizardReviewEl.firstChild) wizardReviewEl.removeChild(wizardReviewEl.firstChild);

    const _rBaseSel = document.getElementById('create-route-base-domain');
    const _rPfxEl = document.getElementById('create-route-prefix');
    const _rFtEl = document.getElementById('create-route-domain-freetext');
    const _rFtMode = _rBaseSel && _rBaseSel.value === '';
    const domain = _rFtMode
      ? ((_rFtEl && _rFtEl.value) || '').trim() || '—'
      : (window.RouteDomain && _rBaseSel
          ? (window.RouteDomain.assembleRouteDomain((_rPfxEl && _rPfxEl.value) || '', _rBaseSel.value || '') || '—')
          : ((_rBaseSel && _rBaseSel.value) || '—'));
    const type = (routeTypeInput && routeTypeInput.value) || 'http';
    let target = '—';
    if (isL4Route()) {
      const proto = ((document.getElementById('l4-protocol') || {}).value || 'tcp').toUpperCase();
      const port = (document.getElementById('l4-listen-port') || {}).value || '';
      const tls = (document.getElementById('l4-tls-mode') || {}).value || 'none';
      target = proto + ' :' + port + (tls !== 'none' ? (' (' + tls + ')') : '');
    } else {
      const tk = (document.getElementById('create-route-target-kind') || {}).value || 'peer';
      if (tk === 'gateway') {
        const gw = document.getElementById('create-route-gateway-peer');
        const gwLabel = (gw && gw.options && gw.options[gw.selectedIndex] && gw.options[gw.selectedIndex].text) || '';
        const host = (document.getElementById('create-route-lan-host') || {}).value || '';
        const port = (document.getElementById('create-route-lan-port') || {}).value || '';
        target = gwLabel + ' → ' + host + ':' + port;
      } else {
        const peer = document.getElementById('route-peer-select');
        const peerLabel = (peer && peer.options && peer.options[peer.selectedIndex] && peer.options[peer.selectedIndex].text) || '';
        const port = (document.getElementById('route-port') || {}).value || '';
        target = peerLabel + ':' + port;
      }
    }

    const auth = (document.getElementById('create-auth-type') || {}).value || 'none';
    const authLabel = auth === 'none' ? ((GC.t && GC.t['route_auth.auth_none']) || 'None')
      : auth === 'basic' ? ((GC.t && GC.t['route_auth.auth_basic']) || 'Basic Auth')
      : ((GC.t && GC.t['route_auth.auth_route']) || 'Route Auth');

    const httpsToggleEl = document.querySelector('#route-form [data-field="https_enabled"]');
    const httpsOn = httpsToggleEl && httpsToggleEl.classList.contains('on');
    const backendHttpsEl = document.querySelector('#route-form [data-field="backend_https"]');
    const backendHttpsOn = backendHttpsEl && backendHttpsEl.classList.contains('on');

    const reviewIsL4None = isL4Route() && ((document.getElementById('l4-tls-mode') || {}).value || 'none') === 'none';
    const rows = [];
    if (!reviewIsL4None) rows.push([(GC.t && GC.t['routes.domain']) || 'Domain', domain]);
    rows.push([(GC.t && GC.t['routes.type']) || 'Typ', type.toUpperCase()]);
    rows.push([(GC.t && GC.t['routes.target_peer']) || 'Ziel', target]);
    if (!isL4Route()) {
      rows.push([(GC.t && GC.t['routes.force_https']) || 'HTTPS', httpsOn ? '✓' : '—']);
      rows.push([(GC.t && GC.t['routes.backend_https']) || 'Backend HTTPS', backendHttpsOn ? '✓' : '—']);
      rows.push([(GC.t && GC.t['route_auth.auth_type']) || 'Auth', authLabel]);
    }

    rows.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border)';
      const kEl = document.createElement('span');
      kEl.style.cssText = 'color:var(--text-3);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;flex-shrink:0';
      kEl.textContent = k;
      const vEl = document.createElement('span');
      vEl.style.cssText = 'color:var(--text-1);font-weight:600;text-align:right;word-break:break-all';
      vEl.textContent = v;
      row.appendChild(kEl);
      row.appendChild(vEl);
      wizardReviewEl.appendChild(row);
    });
  }

  function openRouteWizard() {
    if (!routeModalOverlay) return;
    currentWizardStep = 1;
    createAccessRules.length = 0;
    renderCreateAccessRules();
    var createForm = document.getElementById('create-access-rules-form');
    if (createForm) {
      renderAccessRuleForm(createForm, function (rule) {
        createAccessRules.push(rule);
        renderCreateAccessRules();
      });
    }
    routeModalOverlay.style.display = 'flex';
    showWizardStep(1);
    syncBlockVisibility('create');
    setTimeout(() => {
      const f = document.getElementById('create-route-base-domain');
      if (f) f.focus();
    }, 50);
    (async function _loadDomains() {
      const sel = document.getElementById('create-route-base-domain');
      if (!sel) return;
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      const ftOpt = document.createElement('option');
      ftOpt.value = '';
      ftOpt.textContent = GC.t['routes.other_domain'] || 'Other / internal domain (free text)';
      sel.appendChild(ftOpt);
      try {
        const resp = await api.get('/api/v1/settings/domains');
        const domainsList = (resp.data && resp.data.domains) || [];
        const verified = domainsList.filter(function(d) { return d.status === 'verified'; });
        for (var _i = 0; _i < verified.length; _i++) {
          const opt = document.createElement('option');
          opt.value = verified[_i].domain;
          opt.textContent = verified[_i].domain;
          sel.insertBefore(opt, ftOpt);
        }
        if (verified.length > 0) {
          sel.value = verified[0].domain;
        } else {
          const noHint = document.getElementById('create-route-domain-ctx-hint');
          if (noHint) { noHint.textContent = GC.t['routes.no_verified_domains_hint'] || 'No verified domains'; noHint.style.display = ''; }
        }
      } catch (_e) {}
      sel.dispatchEvent(new Event('change'));
    })();
  }

  function closeRouteWizard() {
    if (!routeModalOverlay) return;
    routeModalOverlay.style.display = 'none';
  }

  window.openRouteWizard = openRouteWizard;
  window.closeRouteWizard = closeRouteWizard;

  if (btnAdd) btnAdd.addEventListener('click', openRouteWizard);
  if (routeModalClose) routeModalClose.addEventListener('click', closeRouteWizard);
  // Intentionally NO overlay-click-to-close: a click outside the modal must not
  // discard an in-progress route. Close only via the X button or Escape.
  if (wizardNext) wizardNext.addEventListener('click', goWizardNext);
  if (wizardPrev) wizardPrev.addEventListener('click', goWizardPrev);
  if (wizardSave) wizardSave.addEventListener('click', () => {
    routeForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

  // Dots: click to jump back to completed steps
  if (routeModalOverlay) {
    routeModalOverlay.querySelectorAll('.route-step-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        const step = Number(dot.dataset.pill);
        const steps = visibleWizardSteps();
        if (steps.includes(step) && steps.indexOf(step) < steps.indexOf(currentWizardStep)) {
          showWizardStep(step);
        }
      });
    });
  }

  // Domain-registry fields: freetext toggle + preview
  (function setupCreateDomainRegistry() {
    const sel = document.getElementById('create-route-base-domain');
    const pfx = document.getElementById('create-route-prefix');
    const ft = document.getElementById('create-route-domain-freetext');
    const prev = document.getElementById('create-route-domain-preview');
    function updatePreview() {
      if (!sel) return;
      const isFt = sel.value === '';
      if (ft) ft.style.display = isFt ? '' : 'none';
      if (prev) {
        if (isFt) { prev.style.display = 'none'; return; }
        const assembled = window.RouteDomain
          ? window.RouteDomain.assembleRouteDomain((pfx && pfx.value) || '', sel.value)
          : sel.value;
        if (assembled) { prev.textContent = assembled; prev.style.display = ''; }
        else prev.style.display = 'none';
      }
    }
    if (sel) sel.addEventListener('change', updatePreview);
    if (pfx) pfx.addEventListener('input', updatePreview);
  })();

  // Refresh visible steps if route-type changes mid-wizard
  if (routeTypeInput) {
    const routeTypeGroup = document.getElementById('route-type-group');
    if (routeTypeGroup) {
      routeTypeGroup.addEventListener('click', () => {
        // Defer to after setupToggleGroup handler updates hidden value
        setTimeout(() => {
          if (routeModalOverlay && routeModalOverlay.style.display !== 'none') {
            const steps = visibleWizardSteps();
            if (!steps.includes(currentWizardStep)) showWizardStep(steps[0]);
            else showWizardStep(currentWizardStep);
          }
        }, 10);
      });
    }
  }

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && routeModalOverlay && routeModalOverlay.style.display !== 'none') {
      closeRouteWizard();
    }
  });

  // ─── Route Auth UI helpers ────────────────────────────────

  // Stored TOTP secret for confirm flow
  let pendingTotpSecret = null;

  function updateRouteAuthMethodUI() {
    var method = document.getElementById('edit-ra-method')?.value || 'email_password';
    var is2fa = document.getElementById('edit-ra-2fa')?.classList.contains('on') || false;
    var singleView = document.getElementById('edit-ra-single-factor');
    var tfaView = document.getElementById('edit-ra-2fa-view');

    if (is2fa) {
      // Show 2FA view, hide single factor view
      if (singleView) singleView.style.display = 'none';
      if (tfaView) tfaView.style.display = '';
      // Sync email/password from single-factor fields to 2FA fields if empty
      var sfEmail = document.getElementById('edit-ra-email');
      var tfaEmail = document.getElementById('edit-ra-2fa-email');
      if (sfEmail && tfaEmail && !tfaEmail.value && sfEmail.value) tfaEmail.value = sfEmail.value;
      var sfPass = document.getElementById('edit-ra-password');
      var tfaPass = document.getElementById('edit-ra-2fa-password');
      if (sfPass && tfaPass && !tfaPass.value && sfPass.value) tfaPass.value = sfPass.value;
      // Update Factor 2 method UI
      update2faMethodUI();
    } else {
      // Show single factor view, hide 2FA view
      if (singleView) singleView.style.display = '';
      if (tfaView) tfaView.style.display = 'none';
      // Sync back from 2FA fields
      var tfaEmail2 = document.getElementById('edit-ra-2fa-email');
      var sfEmail2 = document.getElementById('edit-ra-email');
      if (tfaEmail2 && sfEmail2 && !sfEmail2.value && tfaEmail2.value) sfEmail2.value = tfaEmail2.value;
      var tfaPass2 = document.getElementById('edit-ra-2fa-password');
      var sfPass2 = document.getElementById('edit-ra-password');
      if (tfaPass2 && sfPass2 && !sfPass2.value && tfaPass2.value) sfPass2.value = tfaPass2.value;
      // Update single factor field visibility
      updateSingleFactorUI(method);
    }
  }

  function updateSingleFactorUI(method) {
    var emailGroup = document.getElementById('edit-ra-sf-email-group');
    var passwordGroup = document.getElementById('edit-ra-sf-password-group');
    var totpGroup = document.getElementById('edit-ra-sf-totp-group');
    if (method === 'totp') {
      if (emailGroup) emailGroup.style.display = 'none';
      if (passwordGroup) passwordGroup.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
    } else if (method === 'email_code') {
      if (emailGroup) emailGroup.style.display = '';
      if (passwordGroup) passwordGroup.style.display = 'none';
      if (totpGroup) totpGroup.style.display = 'none';
    } else {
      // email_password
      if (emailGroup) emailGroup.style.display = '';
      if (passwordGroup) passwordGroup.style.display = '';
      if (totpGroup) totpGroup.style.display = 'none';
    }
  }

  function update2faMethodUI() {
    var method = document.getElementById('edit-ra-method')?.value || 'email_code';
    var emailHint = document.getElementById('edit-ra-2fa-email-hint');
    var totpGroup = document.getElementById('edit-ra-2fa-totp-group');
    var label = document.getElementById('edit-ra-2fa-factor2-label');
    if (method === 'totp') {
      if (emailHint) emailHint.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
      if (label) label.textContent = label.dataset.totp || 'Factor 2 — TOTP (Authenticator)';
    } else {
      if (emailHint) emailHint.style.display = '';
      if (totpGroup) totpGroup.style.display = 'none';
      if (label) label.textContent = label.dataset.email || 'Factor 2 — Email Code';
    }
  }

  function updateEditAuthTypeUI() {
    var authType = document.getElementById('edit-auth-type')?.value || 'none';
    var basicFields = document.getElementById('edit-basic-auth-fields');
    var routeAuthFields = document.getElementById('edit-route-auth-fields');

    if (basicFields) basicFields.style.display = authType === 'basic' ? 'block' : 'none';
    if (routeAuthFields) routeAuthFields.style.display = authType === 'route' ? 'block' : 'none';

    if (authType === 'route') {
      updateRouteAuthMethodUI();
    }
  }

  // Setup auth type toggle group
  var authTypeGroup = document.getElementById('edit-auth-type-group');
  if (authTypeGroup) {
    authTypeGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        authTypeGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('edit-auth-type').value = btn.dataset.value;
        updateEditAuthTypeUI();
      });
    });
  }

  // Setup single-factor method toggle group
  var raMethodGroup = document.getElementById('edit-ra-method-group');
  if (raMethodGroup) {
    raMethodGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        raMethodGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('edit-ra-method').value = btn.dataset.value;
        updateSingleFactorUI(btn.dataset.value);
      });
    });
  }

  // Setup 2FA Factor 2 method toggle group
  var ra2faMethodGroup = document.getElementById('edit-ra-2fa-method-group');
  if (ra2faMethodGroup) {
    ra2faMethodGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ra2faMethodGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('edit-ra-method').value = btn.dataset.value;
        update2faMethodUI();
      });
    });
  }

  // Setup 2FA toggle
  var ra2faToggle = document.getElementById('edit-ra-2fa');
  if (ra2faToggle) {
    ra2faToggle.addEventListener('click', function () {
      ra2faToggle.classList.toggle('on');
      var is2fa = ra2faToggle.classList.contains('on');
      // When enabling 2FA, default Factor 2 to email_code
      if (is2fa) {
        var currentMethod = document.getElementById('edit-ra-method')?.value || 'email_password';
        if (currentMethod === 'email_password') {
          document.getElementById('edit-ra-method').value = 'email_code';
          setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', 'email_code');
        } else {
          setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', currentMethod);
        }
      }
      updateRouteAuthMethodUI();
    });
  }

  // ─── Reusable TOTP setup handler ──────────────────────
  function setupTotpGenerate(btnId, secretElId, qrElId, verifyElId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;
      btnLoading(btn);
      try {
        var data = await api.post('/api/routes/' + routeId + '/auth/totp-setup', {});
        if (data.ok && data.data) {
          pendingTotpSecret = data.data.secret;
          var secretEl = document.getElementById(secretElId);
          if (secretEl) { secretEl.textContent = data.data.secret; secretEl.style.display = ''; }
          var qrEl = document.getElementById(qrElId);
          if (qrEl && data.data.uri) {
            qrEl.textContent = '';
            try {
              var qr = qrcode(0, 'M'); qr.addData(data.data.uri); qr.make();
              var img = document.createElement('img');
              img.src = qr.createDataURL(4, 4); img.alt = 'TOTP QR Code';
              img.style.cssText = 'display:block;margin:0 auto;border-radius:var(--radius-sm);';
              qrEl.appendChild(img);
            } catch (e) {
              var d = document.createElement('div');
              d.style.cssText = 'font-size:11px;color:var(--text-3);word-break:break-all;padding:6px';
              d.textContent = data.data.uri; qrEl.appendChild(d);
            }
            qrEl.style.display = '';
          }
          var verifyEl = document.getElementById(verifyElId);
          if (verifyEl) verifyEl.style.display = '';
        } else { alert(data.error || 'Failed to generate TOTP setup'); }
      } catch (err) { alert(err.message); } finally { btnReset(btn); }
    });
  }

  function setupTotpConfirm(btnId, codeElId, statusElId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var routeId = document.getElementById('edit-route-id')?.value;
      var code = document.getElementById(codeElId)?.value?.trim();
      var statusEl = document.getElementById(statusElId);
      if (!routeId || !pendingTotpSecret || !code) return;
      btnLoading(btn);
      try {
        var data = await api.post('/api/routes/' + routeId + '/auth/totp-verify', { secret: pendingTotpSecret, token: code });
        if (statusEl) {
          statusEl.style.display = '';
          statusEl.style.color = data.ok ? 'var(--green)' : 'var(--red)';
          statusEl.textContent = data.ok ? 'TOTP verified successfully' : 'Invalid code. Try again.';
        }
      } catch (err) { alert(err.message); } finally { btnReset(btn); }
    });
  }

  // Single factor TOTP
  setupTotpGenerate('btn-ra-totp-generate', 'edit-ra-totp-secret', 'edit-ra-totp-qr', 'edit-ra-totp-verify');
  setupTotpConfirm('btn-ra-totp-confirm', 'edit-ra-totp-code', 'edit-ra-totp-status');
  // 2FA TOTP
  setupTotpGenerate('btn-ra-2fa-totp-generate', 'edit-ra-2fa-totp-secret', 'edit-ra-2fa-totp-qr', 'edit-ra-2fa-totp-verify');
  setupTotpConfirm('btn-ra-2fa-totp-confirm', 'edit-ra-2fa-totp-code', 'edit-ra-2fa-totp-status');

  // ─── Edit route modal ───────────────────────────────────
  async function showEditModal(id) {
    const route = allRoutes.find(r => String(r.id) === String(id));
    if (!route) return;

    document.getElementById('edit-route-id').value = id;
    document.getElementById('edit-route-domain').value = route.domain || '';
    // Reset DNS hint on modal open
    const editDnsHintEl = document.getElementById('edit-route-dns-hint');
    if (editDnsHintEl) editDnsHintEl.style.display = 'none';
    document.getElementById('edit-route-desc').value = route.description || '';
    document.getElementById('edit-route-port').value = route.target_port || '';

    const ipInput = document.getElementById('edit-route-ip');
    if (ipInput) ipInput.value = route.target_ip || '';

    // Populate peer select in edit modal
    const editPeerSelect = document.getElementById('edit-route-peer');
    if (editPeerSelect) renderPeerOptions(editPeerSelect, route.peer_id);

    // Toggle peer vs direct IP
    const ipGroup = document.getElementById('edit-route-ip-group');
    if (editPeerSelect) {
      editPeerSelect.addEventListener('change', () => {
        ipGroup.style.display = editPeerSelect.value ? 'none' : 'block';
      });
      ipGroup.style.display = route.peer_id ? 'none' : 'block';
    }

    // Target-kind: peer (direct) vs gateway (home-gateway LAN)
    const tkSelect = document.getElementById('edit-route-target-kind');
    const peerFields = document.getElementById('edit-route-peer-fields');
    const gwFields = document.getElementById('edit-route-gateway-fields');
    const gwPeerSelect = document.getElementById('edit-route-gateway-peer');
    const lanHost = document.getElementById('edit-route-lan-host');
    const lanPort = document.getElementById('edit-route-lan-port');
    const wolCb = document.getElementById('edit-route-wol-enabled');
    const wolMacField = document.getElementById('edit-route-wol-mac-field');
    const wolMac = document.getElementById('edit-route-wol-mac');

    // Populate gateway-peer select with gateway-type peers
    if (gwPeerSelect && window.allPeers) {
      while (gwPeerSelect.firstChild) gwPeerSelect.removeChild(gwPeerSelect.firstChild);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '\u2014';
      gwPeerSelect.appendChild(placeholder);
      window.allPeers
        .filter(p => p.peer_type === 'gateway')
        .forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          if (String(route.target_peer_id || '') === String(p.id)) opt.selected = true;
          gwPeerSelect.appendChild(opt);
        });
    }

    function updateTargetKindVisibility() {
      const kind = tkSelect ? tkSelect.value : 'peer';
      if (peerFields) peerFields.style.display = kind === 'peer' ? 'block' : 'none';
      if (gwFields) gwFields.style.display = kind === 'gateway' ? 'block' : 'none';
    }

    if (tkSelect) {
      tkSelect.value = route.target_kind || 'peer';
      tkSelect.addEventListener('change', updateTargetKindVisibility);
      updateTargetKindVisibility();
    }

    if (lanHost) lanHost.value = route.target_lan_host || '';
    if (lanPort) lanPort.value = route.target_lan_port || '';
    if (wolCb) wolCb.checked = !!route.wol_enabled;
    if (wolMac) wolMac.value = route.wol_mac || '';
    if (wolCb && wolMacField) {
      const syncWolMacVisibility = () => {
        wolMacField.style.display = wolCb.checked ? 'block' : 'none';
      };
      wolCb.addEventListener('change', syncWolMacVisibility);
      syncWolMacVisibility();
    }

    const httpsToggle = document.getElementById('edit-route-https');
    if (httpsToggle) {
      if (route.https_enabled) httpsToggle.classList.add('on');
      else httpsToggle.classList.remove('on');
    }

    const backendHttpsToggle = document.getElementById('edit-route-backend-https');
    if (backendHttpsToggle) {
      if (route.backend_https) backendHttpsToggle.classList.add('on');
      else backendHttpsToggle.classList.remove('on');
    }

    const compressToggle = document.getElementById('edit-route-compress');
    if (compressToggle) {
      if (route.compress_enabled) compressToggle.classList.add('on');
      else compressToggle.classList.remove('on');
      compressToggle.setAttribute('aria-checked', route.compress_enabled ? 'true' : 'false');
    }

    const externalToggle = document.getElementById('edit-route-external');
    if (externalToggle) {
      if (route.external_enabled) externalToggle.classList.add('on');
      else externalToggle.classList.remove('on');
      externalToggle.setAttribute('aria-checked', route.external_enabled ? 'true' : 'false');
    }

    const editBlockAction = document.getElementById('edit-route-block-action');
    if (editBlockAction) {
      editBlockAction.value = route.external_block_action || 'inherit';
      const editBlockBody = document.getElementById('edit-route-block-body');
      if (editBlockBody) editBlockBody.value = route.external_block_body || '';
      const editBlockRedirect = document.getElementById('edit-route-block-redirect');
      if (editBlockRedirect) editBlockRedirect.value = route.external_block_redirect_url || '';
      syncBlockVisibility('edit');
    }

    // Reset auth type to none first
    setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'none');

    // Reset route auth fields
    var ra2fa = document.getElementById('edit-ra-2fa');
    if (ra2fa) ra2fa.classList.remove('on');
    setToggleGroup('edit-ra-method-group', 'edit-ra-method', 'email_password');
    // 2FA F2 group shares the same hidden #edit-ra-method as the SF group.
    // Reset only its visual state — do NOT write the hidden value, that
    // would clobber the SF default and hide the password field on first open.
    var ra2faGroupReset = document.getElementById('edit-ra-2fa-method-group');
    if (ra2faGroupReset) {
      ra2faGroupReset.querySelectorAll('.toggle-btn').forEach(function (b) {
        b.classList.toggle('on', b.dataset.value === 'email_code');
      });
    }
    // Reset all text fields
    ['edit-ra-email', 'edit-ra-password', 'edit-ra-2fa-email', 'edit-ra-2fa-password'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) el.value = '';
    });
    var raDuration = document.getElementById('edit-ra-session-duration');
    if (raDuration) raDuration.value = '86400000';
    // Reset TOTP state
    pendingTotpSecret = null;
    ['edit-ra-totp-secret', 'edit-ra-2fa-totp-secret'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) { el.textContent = ''; el.style.display = 'none'; }
    });
    ['edit-ra-totp-qr', 'edit-ra-2fa-totp-qr'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) { el.textContent = ''; el.style.display = 'none'; }
    });
    ['edit-ra-totp-verify', 'edit-ra-2fa-totp-verify'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) el.style.display = 'none';
    });
    ['edit-ra-totp-code', 'edit-ra-2fa-totp-code'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) el.value = '';
    });
    ['edit-ra-totp-status', 'edit-ra-2fa-totp-status'].forEach(function (fid) {
      var el = document.getElementById(fid); if (el) { el.textContent = ''; el.style.display = 'none'; }
    });

    // Reset basic auth fields
    var authUser = document.getElementById('edit-route-auth-user');
    if (authUser) authUser.value = route.basic_auth_user || '';
    var authPass = document.getElementById('edit-route-auth-pass');
    if (authPass) authPass.value = '';

    // Reset any share-managed read-only state from a previously edited route
    setRouteAuthShareManaged(false);

    // Load route auth config from API. A route can carry two auth truths at
    // once (basic_auth_enabled AND a route_auth row); Caddy resolves this with
    // Basic Auth winning (caddyConfig.js). The "effective active method" mirrors
    // that precedence and drives both the SELECTED tab and the green indicator:
    //   basic_auth_enabled        -> 'basic'
    //   else route_auth row exists -> 'route'
    //   else                       -> 'none'
    var authIsShareManaged = false;
    var hasRouteAuth = false;
    try {
      var authData = await api.get('/api/routes/' + id + '/auth');
      if (authData.ok && authData.data) {
        // Always populate the route-auth fields from the API data so that
        // switching to the Route-Auth tab shows the prior values, even when
        // Basic Auth is the effective-active method (dead route_auth row).
        hasRouteAuth = true;
        var auth = authData.data;
        var email = auth.email || '';
        var sessionAge = String(auth.session_max_age || 86400000);

        if (auth.auth_type === 'share') {
          // Share-managed routes have no credential flow — show a read-only
          // note and skip building the email/OTP/TOTP selector.
          authIsShareManaged = true;
          setRouteAuthShareManaged(true);
        } else {
          setRouteAuthShareManaged(false);
          if (auth.two_factor_enabled) {
            if (ra2fa) ra2fa.classList.add('on');
            // Populate 2FA fields
            var tfaEmail = document.getElementById('edit-ra-2fa-email');
            if (tfaEmail) tfaEmail.value = email;
            // Set Factor 2 method
            var f2method = auth.two_factor_method || 'email_code';
            document.getElementById('edit-ra-method').value = f2method;
            setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', f2method);
          } else {
            // Single factor — populate single factor fields
            var method = auth.auth_type || 'email_password';
            setToggleGroup('edit-ra-method-group', 'edit-ra-method', method);
            var sfEmail = document.getElementById('edit-ra-email');
            if (sfEmail) sfEmail.value = email;
          }
          if (raDuration) raDuration.value = sessionAge;
        }
      }
    } catch (err) {
      // Auth fetch failed — fall back to whatever the route record tells us.
    }

    // Effective-active method: Basic wins over a (possibly dead) route_auth row.
    var activeMethod = route.basic_auth_enabled ? 'basic' : (hasRouteAuth ? 'route' : 'none');
    // Select the tab matching the effective-active method (blue ".on").
    setToggleGroup('edit-auth-type-group', 'edit-auth-type', activeMethod);
    // Green indicator: mark the active method's tab. Reset on every open, then
    // set once. This is independent of ".on" (blue selected/visited) so green
    // stays put while the user clicks around between tabs.
    var authTypeGroupEl = document.getElementById('edit-auth-type-group');
    if (authTypeGroupEl) {
      authTypeGroupEl.querySelectorAll('.toggle-btn').forEach(function (b) {
        b.classList.toggle('method-active', b.dataset.value === activeMethod);
      });
    }

    updateEditAuthTypeUI();
    // updateEditAuthTypeUI() unconditionally re-shows #edit-ra-single-factor for
    // 'route' auth. For share-managed routes the read-only note must win, so
    // re-apply the hide after the generic selector pass.
    if (authIsShareManaged) setRouteAuthShareManaged(true);

    setToggleGroup('edit-route-type-group', 'edit-route-type', route.route_type || 'http');
    if (route.route_type === 'l4') {
      setToggleGroup('edit-l4-protocol-group', 'edit-l4-protocol', route.l4_protocol || 'tcp');
      document.getElementById('edit-l4-listen-port').value = route.l4_listen_port || '';
      document.getElementById('edit-l4-tls-mode').value = route.l4_tls_mode || 'none';
    }
    updateEditFieldVisibility();

    // ACL toggle
    var aclToggle = document.getElementById('edit-route-acl');
    var aclFields = document.getElementById('edit-acl-fields');
    if (aclToggle) {
      if (route.acl_enabled) aclToggle.classList.add('on'); else aclToggle.classList.remove('on');
      if (aclFields) aclFields.style.display = route.acl_enabled ? '' : 'none';
    }
    // Load ACL peers for this route
    try {
      var routeDetail = await api.get('/api/routes/' + id);
      if (routeDetail.ok && routeDetail.route) {
        renderAclPeerChecklist('edit', routeDetail.route.acl_peers || []);
      } else {
        renderAclPeerChecklist('edit', []);
      }
    } catch (_) {
      renderAclPeerChecklist('edit', []);
    }

    // Rate limit toggle
    var rateLimitToggle = document.getElementById('edit-route-rate-limit');
    var rateLimitFields = document.getElementById('edit-rate-limit-fields');
    if (rateLimitToggle) {
      if (route.rate_limit_enabled) rateLimitToggle.classList.add('on'); else rateLimitToggle.classList.remove('on');
      rateLimitToggle.setAttribute('aria-checked', route.rate_limit_enabled ? 'true' : 'false');
      if (rateLimitFields) rateLimitFields.style.display = route.rate_limit_enabled ? '' : 'none';
    }
    var rlRequests = document.getElementById('edit-rate-limit-requests');
    if (rlRequests) rlRequests.value = route.rate_limit_requests || 100;
    var rlWindow = document.getElementById('edit-rate-limit-window');
    if (rlWindow) rlWindow.value = route.rate_limit_window || '1m';

    // Retry toggle
    var retryToggle = document.getElementById('edit-route-retry');
    var retryFields = document.getElementById('edit-retry-fields');
    if (retryToggle) {
      if (route.retry_enabled) retryToggle.classList.add('on'); else retryToggle.classList.remove('on');
      retryToggle.setAttribute('aria-checked', route.retry_enabled ? 'true' : 'false');
      if (retryFields) retryFields.style.display = route.retry_enabled ? '' : 'none';
    }
    var retryCount = document.getElementById('edit-retry-count');
    if (retryCount) retryCount.value = route.retry_count || 3;
    var retryStatus = document.getElementById('edit-retry-status');
    if (retryStatus) retryStatus.value = route.retry_match_status || '502,503,504';

    // Backends toggle
    editBackendsList.length = 0;
    var backendsToggle = document.getElementById('edit-route-backends');
    var backendsFields = document.getElementById('edit-backends-fields');
    var hasBackends = false;
    if (route.backends) {
      try {
        var parsedBe = typeof route.backends === 'string' ? JSON.parse(route.backends) : route.backends;
        if (Array.isArray(parsedBe) && parsedBe.length > 0) {
          parsedBe.forEach(function(b) { editBackendsList.push(b); });
          hasBackends = true;
        }
      } catch (_) {}
    }
    if (backendsToggle) {
      if (hasBackends) backendsToggle.classList.add('on'); else backendsToggle.classList.remove('on');
      backendsToggle.setAttribute('aria-checked', hasBackends ? 'true' : 'false');
      if (backendsFields) backendsFields.style.display = hasBackends ? '' : 'none';
    }
    renderBackendsList();

    // Sticky toggle
    var stickyToggle = document.getElementById('edit-route-sticky');
    var stickyFields = document.getElementById('edit-sticky-fields');
    if (stickyToggle) {
      if (route.sticky_enabled && hasBackends) stickyToggle.classList.add('on'); else stickyToggle.classList.remove('on');
      stickyToggle.setAttribute('aria-checked', (route.sticky_enabled && hasBackends) ? 'true' : 'false');
      if (stickyFields) stickyFields.style.display = (route.sticky_enabled && hasBackends) ? '' : 'none';
    }
    var stickyCookieName = document.getElementById('edit-sticky-cookie-name');
    if (stickyCookieName) stickyCookieName.value = route.sticky_cookie_name || 'gc_sticky';
    var stickyCookieTtl = document.getElementById('edit-sticky-cookie-ttl');
    if (stickyCookieTtl) stickyCookieTtl.value = route.sticky_cookie_ttl || '3600';

    // Custom headers
    editHeadersRequest.length = 0;
    editHeadersResponse.length = 0;
    if (route.custom_headers) {
      try {
        var ch = typeof route.custom_headers === 'string' ? JSON.parse(route.custom_headers) : route.custom_headers;
        if (Array.isArray(ch.request)) ch.request.forEach(function(h) { editHeadersRequest.push(h); });
        if (Array.isArray(ch.response)) ch.response.forEach(function(h) { editHeadersResponse.push(h); });
      } catch (_) {}
    }
    renderHeadersList('edit', 'request', editHeadersRequest);
    renderHeadersList('edit', 'response', editHeadersResponse);

    // Tab/feature visibility for L4 is handled by updateEditFieldVisibility()

    // Monitoring toggle
    const monitorToggle = document.getElementById('edit-route-monitoring');
    if (monitorToggle) {
      if (route.monitoring_enabled) monitorToggle.classList.add('on');
      else monitorToggle.classList.remove('on');
      monitorToggle.setAttribute('aria-checked', route.monitoring_enabled ? 'true' : 'false');
    }

    // Circuit breaker toggle
    var cbToggle = document.getElementById('edit-route-circuit-breaker');
    var cbFields = document.getElementById('edit-circuit-breaker-fields');
    if (cbToggle) {
      if (route.circuit_breaker_enabled) cbToggle.classList.add('on'); else cbToggle.classList.remove('on');
      cbToggle.setAttribute('aria-checked', route.circuit_breaker_enabled ? 'true' : 'false');
      if (cbFields) cbFields.style.display = route.circuit_breaker_enabled ? '' : 'none';
    }
    // Debug toggle
    var debugToggle = document.getElementById('edit-route-debug');
    var debugContainer = document.getElementById('edit-debug-container');
    if (debugToggle) {
      if (route.debug_enabled) debugToggle.classList.add('on'); else debugToggle.classList.remove('on');
      debugToggle.setAttribute('aria-checked', route.debug_enabled ? 'true' : 'false');
      if (debugContainer) debugContainer.style.display = route.debug_enabled ? '' : 'none';
    }
    // Bot blocker toggle + mode
    var bbToggle = document.getElementById('edit-route-bot-blocker');
    var bbFields = document.getElementById('edit-bot-blocker-fields');
    if (bbToggle) {
      if (route.bot_blocker_enabled) bbToggle.classList.add('on'); else bbToggle.classList.remove('on');
      bbToggle.setAttribute('aria-checked', route.bot_blocker_enabled ? 'true' : 'false');
      if (bbFields) bbFields.style.display = route.bot_blocker_enabled ? '' : 'none';
    }
    var bbModeSelect = document.getElementById('edit-bot-blocker-mode');
    if (bbModeSelect) bbModeSelect.value = route.bot_blocker_mode || 'block';
    var bbCfg = {};
    try { var _parsed = route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : null; if (_parsed && typeof _parsed === 'object') bbCfg = _parsed; } catch {}
    var bbUrl = document.getElementById('edit-bot-blocker-url');
    if (bbUrl) bbUrl.value = bbCfg.url || '';
    var bbMsg = document.getElementById('edit-bot-blocker-message');
    if (bbMsg) bbMsg.value = bbCfg.message || '';
    var bbStatus = document.getElementById('edit-bot-blocker-status');
    if (bbStatus) bbStatus.value = bbCfg.status_code || 403;
    updateBotBlockerFields('edit');
    var cbThreshold = document.getElementById('edit-cb-threshold');
    if (cbThreshold) cbThreshold.value = route.circuit_breaker_threshold || 5;
    var cbTimeout = document.getElementById('edit-cb-timeout');
    if (cbTimeout) cbTimeout.value = route.circuit_breaker_timeout || 30;
    // Circuit breaker status indicator + manual reset button.
    // The breaker state is persisted in SQLite (cb_failure_count, cb_opened_at),
    // so an open breaker survives restarts and only clears via monitoring
    // timeout or this button.
    var cbStatusIndicator = document.getElementById('edit-cb-status-indicator');
    var cbResetBtn = document.getElementById('edit-cb-reset');
    if (cbStatusIndicator && route.circuit_breaker_enabled) {
      var cbStatus = route.circuit_breaker_status || 'closed';
      cbStatusIndicator.style.display = '';
      if (cbStatus === 'closed') {
        cbStatusIndicator.style.background = 'var(--green, #4ade80)';
        cbStatusIndicator.style.color = '#fff';
        cbStatusIndicator.textContent = GC.t['circuit_breaker.status_closed'] || 'Closed';
      } else if (cbStatus === 'open') {
        cbStatusIndicator.style.background = 'var(--red, #f87171)';
        cbStatusIndicator.style.color = '#fff';
        cbStatusIndicator.textContent = GC.t['circuit_breaker.status_open'] || 'Open';
      } else {
        cbStatusIndicator.style.background = (isAurora() ? 'var(--amber)' : 'var(--yellow, #facc15)');
        cbStatusIndicator.style.color = '#000';
        cbStatusIndicator.textContent = GC.t['circuit_breaker.status_half_open'] || 'Half-Open';
      }
      // Reset only makes sense when the breaker isn't closed.
      if (cbResetBtn) {
        cbResetBtn.style.display = cbStatus !== 'closed' ? '' : 'none';
        cbResetBtn.onclick = async function() {
          if (typeof window.btnLoading === 'function') window.btnLoading(cbResetBtn);
          try {
            var resp = await api.post('/api/routes/' + route.id + '/circuit-breaker/reset', {});
            if (resp && resp.ok) {
              if (typeof window.showToast === 'function') {
                window.showToast(GC.t['circuit_breaker.reset_ok'] || 'Circuit-Breaker zurückgesetzt', 'success');
              }
              cbStatusIndicator.style.background = 'var(--green, #4ade80)';
              cbStatusIndicator.style.color = '#fff';
              cbStatusIndicator.textContent = GC.t['circuit_breaker.status_closed'] || 'Closed';
              cbResetBtn.style.display = 'none';
              loadRoutes();
            } else if (typeof window.showToast === 'function') {
              window.showToast((resp && resp.error) || 'Reset failed', 'error');
            }
          } catch (err) {
            if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
          } finally {
            if (typeof window.btnReset === 'function') window.btnReset(cbResetBtn);
          }
        };
      }
    } else if (cbStatusIndicator) {
      cbStatusIndicator.style.display = 'none';
      if (cbResetBtn) cbResetBtn.style.display = 'none';
    }
    // Show monitoring requirement warning if monitoring not enabled
    var cbRequiresMonitoring = document.getElementById('edit-cb-requires-monitoring');
    if (cbRequiresMonitoring) {
      cbRequiresMonitoring.style.display = !route.monitoring_enabled ? '' : 'none';
    }

    // Mirror
    var mirrorToggle = document.getElementById('edit-route-mirror');
    if (mirrorToggle) {
      mirrorToggle.classList.toggle('on', !!route.mirror_enabled);
      mirrorToggle.setAttribute('aria-checked', route.mirror_enabled ? 'true' : 'false');
    }
    var mirrorFields = document.getElementById('edit-mirror-fields');
    if (mirrorFields) mirrorFields.style.display = route.mirror_enabled ? '' : 'none';
    editMirrorTargets.length = 0;
    if (route.mirror_targets) {
      var parsedMt = typeof route.mirror_targets === 'string' ? JSON.parse(route.mirror_targets) : route.mirror_targets;
      if (Array.isArray(parsedMt)) parsedMt.forEach(function (t) { editMirrorTargets.push(t); });
    }
    renderEditMirrorTargets();

    // IP filter
    var ipFilterToggle = document.getElementById('edit-route-ip-filter');
    var ipFilterFields = document.getElementById('edit-ip-filter-fields');
    if (ipFilterToggle) {
      if (route.ip_filter_enabled) ipFilterToggle.classList.add('on'); else ipFilterToggle.classList.remove('on');
      ipFilterToggle.setAttribute('aria-checked', route.ip_filter_enabled ? 'true' : 'false');
      if (ipFilterFields) ipFilterFields.style.display = route.ip_filter_enabled ? '' : 'none';
    }
    setToggleGroup('edit-ip-filter-mode-group', 'edit-ip-filter-mode', route.ip_filter_mode || 'whitelist');
    editIpFilterRules.length = 0;
    try {
      var parsed = JSON.parse(route.ip_filter_rules || '[]');
      if (Array.isArray(parsed)) parsed.forEach(function(r) { editIpFilterRules.push(r); });
    } catch {}
    renderIpFilterRules('edit', editIpFilterRules);

    // Branding
    var btEl = document.getElementById('edit-branding-title');
    if (btEl) btEl.value = route.branding_title || '';
    var bxEl = document.getElementById('edit-branding-text');
    if (bxEl) bxEl.value = route.branding_text || '';
    var bcEl = document.getElementById('edit-branding-color');
    if (bcEl) bcEl.value = route.branding_color || '#0a6e4f';
    var bbEl = document.getElementById('edit-branding-bg');
    if (bbEl) bbEl.value = route.branding_bg || '#f2f0eb';
    var logoFileEl = document.getElementById('edit-branding-logo-file');
    if (logoFileEl) logoFileEl.value = '';
    var logoCurrent = document.getElementById('edit-branding-logo-current');
    var logoRemove = document.getElementById('edit-branding-logo-remove');
    if (logoCurrent) logoCurrent.textContent = route.branding_logo || '';
    if (logoRemove) logoRemove.style.display = route.branding_logo ? '' : 'none';
    var bgFileEl = document.getElementById('edit-branding-bg-file');
    if (bgFileEl) bgFileEl.value = '';
    var bgCurrent = document.getElementById('edit-branding-bg-current');
    var bgRemove = document.getElementById('edit-branding-bg-remove');
    if (bgCurrent) bgCurrent.textContent = route.branding_bg_image || '';
    if (bgRemove) bgRemove.style.display = route.branding_bg_image ? '' : 'none';

    // User visibility
    var userIds = [];
    try { userIds = JSON.parse(route.user_ids || '[]'); } catch (e) { /* ignore */ }
    renderUserCheckboxes('route-user-ids', Array.isArray(userIds) ? userIds : []);

    hideError('edit-route-error');
    clearFieldErrors();
    // Reset to first tab
    var editModal = document.getElementById('modal-edit-route');
    editModal.querySelectorAll('.edit-route-tabs .tab').forEach(function(t) { t.classList.toggle('active', t.dataset.editTab === 'general'); });
    editModal.querySelectorAll('.edit-route-panel').forEach(function(p) { p.style.display = p.dataset.panel === 'general' ? '' : 'none'; });
    var debugTab = document.querySelector('[data-edit-tab="debug"]');
    if (debugTab) debugTab.style.display = (route.route_type === 'l4') ? 'none' : '';

    // Share links (Pro: share_links — section only present when the flag is on)
    var shareSection = document.getElementById('share-links-section');
    if (shareSection) {
      shareSection.setAttribute('data-route-id', String(id));
      loadShareLinks(id);
    }

    // Access windows (Pro: access_windows — section only present when the flag is on)
    var accessSection = document.getElementById('access-windows-section');
    if (accessSection) {
      accessSection.setAttribute('data-target-id', String(id));
      loadAccessRules(id);
    }

    currentEditRouteId = id;
    stopTracePolling();
    openModal('modal-edit-route');
    document.getElementById('edit-route-domain').focus();
  }

  const btnEditSubmit = document.getElementById('btn-edit-route-submit');
  if (btnEditSubmit) {
    btnEditSubmit.addEventListener('click', async function() {
      const btn = this;
      const id = document.getElementById('edit-route-id').value;
      const domain = document.getElementById('edit-route-domain').value.trim();
      const description = document.getElementById('edit-route-desc').value.trim();
      const target_port = document.getElementById('edit-route-port').value.trim();
      const editPeerSelect = document.getElementById('edit-route-peer');
      const peer_id = editPeerSelect ? editPeerSelect.value || null : null;
      const target_ip = document.getElementById('edit-route-ip').value.trim();
      const httpsToggle = document.getElementById('edit-route-https');
      const https_enabled = httpsToggle ? httpsToggle.classList.contains('on') : true;
      const backendHttpsToggle = document.getElementById('edit-route-backend-https');
      const backend_https = backendHttpsToggle ? backendHttpsToggle.classList.contains('on') : false;
      const authType = document.getElementById('edit-auth-type')?.value || 'none';
      const basic_auth_enabled = authType === 'basic';
      const basic_auth_user = (document.getElementById('edit-route-auth-user') || {}).value || '';
      const basic_auth_password = (document.getElementById('edit-route-auth-pass') || {}).value || '';

      const editTlsMode = document.getElementById('edit-l4-tls-mode')?.value || 'none';
      const editIsL4 = document.getElementById('edit-route-type')?.value === 'l4';
      const editIsL4None = editIsL4 && editTlsMode === 'none';
      if (!domain && !editIsL4None) { showError('edit-route-error', GC.t['routes.domain_required'] || 'Domain is required'); return; }
      if (!target_port) { showError('edit-route-error', GC.t['routes.target_port_required'] || 'Target port is required'); return; }
      if (editIsL4 && !checkListenPortBlocked('edit-l4-listen-port', 'edit-l4-listen-port-error')) {
        showError('edit-route-error', (document.getElementById('edit-l4-listen-port-error') || {}).textContent || 'Port reserved');
        return;
      }

      if (basic_auth_enabled && !basic_auth_user) {
        showError('edit-route-error', 'Basic auth username is required when auth is enabled');
        return;
      }

      btnLoading(btn);
      try {
        const monitoringEnabled = document.getElementById('edit-route-monitoring')?.classList.contains('on') || false;
        const ipFilterEnabled = document.getElementById('edit-route-ip-filter')?.classList.contains('on') || false;
        const aclEnabled = document.getElementById('edit-route-acl')?.classList.contains('on') || false;
        const compressEnabled = document.getElementById('edit-route-compress')?.classList.contains('on') || false;
        const externalEnabled = document.getElementById('edit-route-external')?.classList.contains('on') || false;
        const rateLimitEnabled = document.getElementById('edit-route-rate-limit')?.classList.contains('on') || false;
        const retryEnabled = document.getElementById('edit-route-retry')?.classList.contains('on') || false;
        const backendsEnabled = document.getElementById('edit-route-backends')?.classList.contains('on') || false;
        const stickyEnabled = document.getElementById('edit-route-sticky')?.classList.contains('on') || false;
        const cbEnabled = document.getElementById('edit-route-circuit-breaker')?.classList.contains('on') || false;
        const debugEnabled = document.getElementById('edit-route-debug')?.classList.contains('on') || false;
        const botBlockerEnabled = document.getElementById('edit-route-bot-blocker')?.classList.contains('on') || false;
        const botBlockerMode = document.getElementById('edit-bot-blocker-mode')?.value || 'block';
        let botBlockerConfig = null;
        if (botBlockerMode === 'redirect') {
          botBlockerConfig = JSON.stringify({ url: document.getElementById('edit-bot-blocker-url')?.value || '' });
        } else if (botBlockerMode === 'custom') {
          botBlockerConfig = JSON.stringify({
            message: document.getElementById('edit-bot-blocker-message')?.value || '',
            status_code: parseInt(document.getElementById('edit-bot-blocker-status')?.value) || 403,
          });
        }
        const payload = {
          domain, description, target_port, peer_id, target_ip, https_enabled, backend_https, basic_auth_enabled,
          compress_enabled: compressEnabled,
          external_enabled: externalEnabled,
          monitoring_enabled: monitoringEnabled,
          ip_filter_enabled: ipFilterEnabled,
          ip_filter_mode: document.getElementById('edit-ip-filter-mode')?.value || 'whitelist',
          ip_filter_rules: ipFilterEnabled ? JSON.stringify(editIpFilterRules) : null,
          branding_title: document.getElementById('edit-branding-title')?.value || '',
          branding_text: document.getElementById('edit-branding-text')?.value || '',
          branding_color: document.getElementById('edit-branding-color')?.value || '',
          branding_bg: document.getElementById('edit-branding-bg')?.value || '',
          acl_enabled: aclEnabled,
          acl_peers: aclEnabled ? getSelectedAclPeers('edit') : [],
          rate_limit_enabled: rateLimitEnabled,
          rate_limit_requests: rateLimitEnabled ? parseInt(document.getElementById('edit-rate-limit-requests')?.value || '100', 10) : 100,
          rate_limit_window: rateLimitEnabled ? (document.getElementById('edit-rate-limit-window')?.value || '1m') : '1m',
          retry_enabled: retryEnabled,
          retry_count: retryEnabled ? parseInt(document.getElementById('edit-retry-count')?.value || '3', 10) : 3,
          retry_match_status: retryEnabled ? (document.getElementById('edit-retry-status')?.value || '502,503,504') : '502,503,504',
          backends: backendsEnabled ? editBackendsList : null,
          sticky_enabled: backendsEnabled && stickyEnabled,
          sticky_cookie_name: stickyEnabled ? (document.getElementById('edit-sticky-cookie-name')?.value || 'gc_sticky') : 'gc_sticky',
          sticky_cookie_ttl: stickyEnabled ? (document.getElementById('edit-sticky-cookie-ttl')?.value || '3600') : '3600',
          circuit_breaker_enabled: cbEnabled,
          circuit_breaker_threshold: cbEnabled ? parseInt(document.getElementById('edit-cb-threshold')?.value || '5', 10) : 5,
          circuit_breaker_timeout: cbEnabled ? parseInt(document.getElementById('edit-cb-timeout')?.value || '30', 10) : 30,
          debug_enabled: debugEnabled,
          bot_blocker_enabled: botBlockerEnabled,
          bot_blocker_mode: botBlockerEnabled ? botBlockerMode : undefined,
          bot_blocker_config: botBlockerEnabled ? botBlockerConfig : undefined,
          mirror_enabled: document.getElementById('edit-route-mirror')?.classList.contains('on') ? 1 : 0,
          mirror_targets: editMirrorTargets.length > 0 ? editMirrorTargets : null,
        };
        const editBlockAction = document.getElementById('edit-route-block-action')?.value || 'inherit';
        payload.external_block_action = editBlockAction;
        if (editBlockAction === 'custom') payload.external_block_body = document.getElementById('edit-route-block-body')?.value || '';
        if (editBlockAction === 'redirect') payload.external_block_redirect_url = document.getElementById('edit-route-block-redirect')?.value || '';
        // User visibility
        var selectedUserIds = [];
        document.querySelectorAll('.route-user-cb:checked').forEach(function (cb) {
          selectedUserIds.push(parseInt(cb.value, 10));
        });
        payload.user_ids = selectedUserIds.length > 0 ? selectedUserIds : null;
        // Custom headers
        var hasCustomHeaders = editHeadersRequest.length > 0 || editHeadersResponse.length > 0;
        payload.custom_headers = hasCustomHeaders ? { request: editHeadersRequest, response: editHeadersResponse } : null;
        const editRouteType = document.getElementById('edit-route-type').value;
        payload.route_type = editRouteType;
        if (editRouteType === 'l4') {
          payload.l4_protocol = document.getElementById('edit-l4-protocol').value;
          payload.l4_listen_port = document.getElementById('edit-l4-listen-port').value;
          payload.l4_tls_mode = document.getElementById('edit-l4-tls-mode').value;
        }
        if (editRouteType === 'l4' && payload.l4_tls_mode === 'none') {
          payload.domain = '';
        }

        // Target-kind (peer vs gateway)
        const tkEl = document.getElementById('edit-route-target-kind');
        const tkVal = tkEl ? tkEl.value : 'peer';
        payload.target_kind = tkVal;
        if (tkVal === 'gateway') {
          const gwPeerEl = document.getElementById('edit-route-gateway-peer');
          const lanHostEl = document.getElementById('edit-route-lan-host');
          const lanPortEl = document.getElementById('edit-route-lan-port');
          const wolEnabledEl = document.getElementById('edit-route-wol-enabled');
          const wolMacEl = document.getElementById('edit-route-wol-mac');
          payload.target_peer_id = gwPeerEl && gwPeerEl.value ? parseInt(gwPeerEl.value, 10) : null;
          payload.target_lan_host = lanHostEl ? lanHostEl.value.trim() : null;
          payload.target_lan_port = lanPortEl && lanPortEl.value ? parseInt(lanPortEl.value, 10) : null;
          payload.wol_enabled = !!(wolEnabledEl && wolEnabledEl.checked);
          payload.wol_mac = wolMacEl && wolMacEl.value ? wolMacEl.value.trim() : null;
          // Don't leak the peer-fields' target_ip/peer_id into a gateway
          // route payload. The old `target_ip='127.0.0.1'` placeholder
          // from legacy gateway-route creates would otherwise trip the
          // server's SSRF private-IP guard on every edit-save.
          // `delete` (not `= null`) so the PUT handler's validateIp() and
          // SSRF checks see target_ip as undefined and skip — null would
          // still trigger validateIp("IP address is required") and block
          // the update silently (field-error attached to hidden input).
          delete payload.target_ip;
          delete payload.peer_id;
        }
        if (basic_auth_enabled) {
          payload.basic_auth_user = basic_auth_user.trim();
          if (basic_auth_password.trim()) {
            payload.basic_auth_password = basic_auth_password.trim();
          }
        }
        const data = await api.put('/api/routes/' + id, payload);
        if (!data.ok) {
          if (data.fields) {
            showFieldErrors(data.fields, {
              domain: 'edit-route-domain', target_port: 'edit-route-port',
              description: 'edit-route-desc', target_ip: 'edit-route-ip',
            });
          } else {
            showError('edit-route-error', data.error);
          }
          return;
        }

        // Handle auth type side effects
        if (authType === 'none') {
          // Delete route auth if it existed (ignore errors)
          try { await api.del('/api/routes/' + id + '/auth'); } catch (e) { /* ignore */ }
        } else if (authType === 'route') {
          var raMethod = document.getElementById('edit-ra-method')?.value || 'email_password';
          var ra2faActive = document.getElementById('edit-ra-2fa')?.classList.contains('on') || false;
          var raSessionDuration = document.getElementById('edit-ra-session-duration')?.value || '86400000';

          // Read from correct fields depending on 2FA mode
          var raEmailVal, raPasswordVal;
          if (ra2faActive) {
            raEmailVal = (document.getElementById('edit-ra-2fa-email') || {}).value || '';
            raPasswordVal = (document.getElementById('edit-ra-2fa-password') || {}).value || '';
          } else {
            raEmailVal = (document.getElementById('edit-ra-email') || {}).value || '';
            raPasswordVal = (document.getElementById('edit-ra-password') || {}).value || '';
          }

          var raPayload = {
            auth_type: ra2faActive ? 'email_password' : raMethod,
            two_factor_enabled: ra2faActive,
            two_factor_method: ra2faActive ? raMethod : null,
            email: raEmailVal,
            session_max_age: parseInt(raSessionDuration, 10)
          };
          if (raPasswordVal) raPayload.password = raPasswordVal;
          if (pendingTotpSecret) raPayload.totp_secret = pendingTotpSecret;

          try {
            const raData = await api.post('/api/routes/' + id + '/auth', raPayload);
            if (!raData.ok) {
              showError('edit-route-error', raData.error || 'Failed to save route auth');
              return;
            }
          } catch (err) {
            showError('edit-route-error', err.message);
            return;
          }
        }

        stopTracePolling();
        closeModal('modal-edit-route');
        loadRoutes();
      } catch (err) {
        showError('edit-route-error', err.message);
      } finally {
        btnReset(btn);
      }
    });
  }

  // ─── Toggle ──────────────────────────────────────────────
  async function toggleRoute(id) {
    try {
      var data = await api.put('/api/routes/' + id + '/toggle');
      if (data && !data.ok) {
        showToast(data.error || 'Error', 'error');
        return;
      }
      loadRoutes();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ─── Delete ──────────────────────────────────────────────
  let pendingDeleteId = null;

  function showConfirmDelete(id, domain) {
    pendingDeleteId = id;
    const msg = document.getElementById('confirm-message');
    if (msg) msg.textContent = (GC.t['routes.confirm_delete'] || 'Are you sure you want to delete this route?').replace('?', ' "' + (domain || id) + '"?');
    openModal('modal-confirm');
  }

  const btnConfirm = document.getElementById('btn-confirm-yes');
  if (btnConfirm) {
    // Remove any existing listener by cloning
    const newBtn = btnConfirm.cloneNode(true);
    btnConfirm.parentNode.replaceChild(newBtn, btnConfirm);

    newBtn.addEventListener('click', async function() {
      if (!pendingDeleteId) return;
      const btn = this;
      btnLoading(btn);
      try {
        await api.del('/api/routes/' + pendingDeleteId);
        closeModal('modal-confirm');
        pendingDeleteId = null;
        loadRoutes();
      } catch (err) {
        alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
      } finally {
        btnReset(btn);
      }
    });
  }

  // Modal helpers use global openModal/closeModal/showError/hideError/escapeHtml from app.js

  // Modal close/escape/focus-trap handled globally in app.js

  // ─── L4 toggle group helpers ────────────────────────────
  function setupToggleGroup(groupId, hiddenId) {
    const group = document.getElementById(groupId);
    const hidden = document.getElementById(hiddenId);
    if (!group || !hidden) return;
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        hidden.value = btn.dataset.value;
        if (groupId.startsWith('edit-')) {
          updateEditFieldVisibility();
        } else {
          updateFieldVisibility();
        }
      });
    });
  }

  function setToggleGroup(groupId, hiddenId, value) {
    const group = document.getElementById(groupId);
    const hidden = document.getElementById(hiddenId);
    if (!group || !hidden) return;
    hidden.value = value;
    group.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('on', btn.dataset.value === value);
    });
  }

  function applyDomainContext(routeType, tlsMode, input, wrap, label, ctxHint) {
    if (!input) return;
    const isL4None = routeType === 'l4' && tlsMode === 'none';
    const row = wrap ? wrap.parentElement : null;
    if (isL4None) {
      if (wrap) wrap.style.display = 'none';
      if (row) row.classList.add('gc-row-collapsed');
      input.required = false;
      input.value = '';
      const _ftClear = document.getElementById('create-route-domain-freetext');
      if (_ftClear) _ftClear.value = '';
      if (ctxHint) ctxHint.style.display = 'none';
    } else {
      if (wrap) wrap.style.display = '';
      if (row) row.classList.remove('gc-row-collapsed');
      input.required = true;
      const isSni = routeType === 'l4';
      const lt = label ? label.querySelector('.gc-label-text') : null;
      if (lt) lt.textContent = isSni
        ? (GC.t['routes.l4_sni_label'] || 'SNI hostname')
        : (GC.t['routes.domain'] || 'Domain');
      if (ctxHint) {
        if (isSni) { ctxHint.textContent = GC.t['routes.l4_sni_required_hint'] || ''; ctxHint.style.display = ''; }
        else { ctxHint.style.display = 'none'; }
      }
    }
  }

  function updateFieldVisibility() {
    const routeType = document.getElementById('route-type')?.value || 'http';
    const l4Fields = document.getElementById('l4-fields');
    const httpFields = document.getElementById('http-fields');
    if (l4Fields) l4Fields.style.display = routeType === 'l4' ? 'block' : 'none';
    if (httpFields) httpFields.style.display = routeType === 'http' ? 'block' : 'none';

    const tlsMode = document.getElementById('l4-tls-mode')?.value || 'none';
    applyDomainContext(
      routeType, tlsMode,
      document.getElementById('create-route-base-domain'),
      document.getElementById('create-route-domain-wrap'),
      document.getElementById('create-route-domain-label'),
      document.getElementById('create-route-domain-ctx-hint')
    );

    updateTlsHint('l4-tls-mode', 'l4-tls-hint');
  }

  function updateEditFieldVisibility() {
    const routeType = document.getElementById('edit-route-type')?.value || 'http';
    const isL4 = routeType === 'l4';
    const l4Fields = document.getElementById('edit-l4-fields');
    const httpFields = document.getElementById('edit-http-fields');
    const httpOnlyFeatures = document.getElementById('edit-http-only-features');
    if (l4Fields) l4Fields.style.display = isL4 ? 'block' : 'none';
    if (httpFields) httpFields.style.display = isL4 ? 'none' : 'block';
    if (httpOnlyFeatures) httpOnlyFeatures.style.display = isL4 ? 'none' : '';

    // Hide HTTP-only tabs for L4 routes
    ['headers', 'auth', 'security', 'branding', 'debug'].forEach(function(tab) {
      var tabBtn = document.querySelector('.edit-route-tabs .tab[data-edit-tab="' + tab + '"]');
      if (tabBtn) tabBtn.style.display = isL4 ? 'none' : '';
    });

    const editTlsMode = document.getElementById('edit-l4-tls-mode')?.value || 'none';
    applyDomainContext(
      routeType, editTlsMode,
      document.getElementById('edit-route-domain'),
      document.getElementById('edit-route-domain-wrap'),
      document.getElementById('edit-route-domain-label'),
      document.getElementById('edit-route-domain-ctx-hint')
    );

    updateTlsHint('edit-l4-tls-mode', 'edit-l4-tls-hint');
  }

  function updateTlsHint(selectId, hintId) {
    const select = document.getElementById(selectId);
    const hint = document.getElementById(hintId);
    if (!select || !hint) return;
    hint.textContent = hint.dataset['hint' + select.value.charAt(0).toUpperCase() + select.value.slice(1)] || '';
  }

  // ─── Basic auth field visibility toggles ─────────────────
  function setupAuthToggle(toggleSel, fieldsSel) {
    const toggle = document.querySelector(toggleSel);
    const fields = document.querySelector(fieldsSel);
    if (!toggle || !fields) return;
    function update() {
      fields.style.display = toggle.classList.contains('on') ? 'block' : 'none';
    }
    toggle.addEventListener('click', () => setTimeout(update, 0));
    update();
  }

  // ─── Create form: Auth type toggle ──────────────────────
  function updateCreateAuthTypeUI() {
    var authType = document.getElementById('create-auth-type')?.value || 'none';
    var basicFields = document.getElementById('create-basic-auth-fields');
    var routeAuthFields = document.getElementById('create-route-auth-fields');
    if (basicFields) basicFields.style.display = authType === 'basic' ? 'block' : 'none';
    if (routeAuthFields) routeAuthFields.style.display = authType === 'route' ? 'block' : 'none';
    if (authType === 'route') updateCreateRouteAuthMethodUI();
  }

  function updateCreateSingleFactorUI(method) {
    var emailGroup = document.getElementById('create-ra-sf-email-group');
    var passwordGroup = document.getElementById('create-ra-sf-password-group');
    var totpGroup = document.getElementById('create-ra-sf-totp-group');
    if (method === 'totp') {
      if (emailGroup) emailGroup.style.display = 'none';
      if (passwordGroup) passwordGroup.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
    } else if (method === 'email_code') {
      if (emailGroup) emailGroup.style.display = '';
      if (passwordGroup) passwordGroup.style.display = 'none';
      if (totpGroup) totpGroup.style.display = 'none';
    } else {
      if (emailGroup) emailGroup.style.display = '';
      if (passwordGroup) passwordGroup.style.display = '';
      if (totpGroup) totpGroup.style.display = 'none';
    }
  }

  function updateCreate2faMethodUI() {
    var method = document.getElementById('create-ra-method')?.value || 'email_code';
    var emailHint = document.getElementById('create-ra-2fa-email-hint');
    var totpGroup = document.getElementById('create-ra-2fa-totp-group');
    var label = document.getElementById('create-ra-2fa-factor2-label');
    if (method === 'totp') {
      if (emailHint) emailHint.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
      if (label) label.textContent = label.dataset.totp || 'Factor 2 — TOTP';
    } else {
      if (emailHint) emailHint.style.display = '';
      if (totpGroup) totpGroup.style.display = 'none';
      if (label) label.textContent = label.dataset.email || 'Factor 2 — Email Code';
    }
  }

  function updateCreateRouteAuthMethodUI() {
    var is2fa = document.getElementById('create-ra-2fa')?.classList.contains('on') || false;
    var singleView = document.getElementById('create-ra-single-factor');
    var tfaView = document.getElementById('create-ra-2fa-view');
    if (is2fa) {
      if (singleView) singleView.style.display = 'none';
      if (tfaView) tfaView.style.display = '';
      // Sync email from single-factor to 2FA
      var sfEmail = document.getElementById('create-ra-email');
      var tfaEmail = document.getElementById('create-ra-2fa-email');
      if (sfEmail && tfaEmail && !tfaEmail.value && sfEmail.value) tfaEmail.value = sfEmail.value;
      var sfPass = document.getElementById('create-ra-password');
      var tfaPass = document.getElementById('create-ra-2fa-password');
      if (sfPass && tfaPass && !tfaPass.value && sfPass.value) tfaPass.value = sfPass.value;
      updateCreate2faMethodUI();
    } else {
      if (singleView) singleView.style.display = '';
      if (tfaView) tfaView.style.display = 'none';
      var tfaEmail2 = document.getElementById('create-ra-2fa-email');
      var sfEmail2 = document.getElementById('create-ra-email');
      if (tfaEmail2 && sfEmail2 && !sfEmail2.value && tfaEmail2.value) sfEmail2.value = tfaEmail2.value;
      var tfaPass2 = document.getElementById('create-ra-2fa-password');
      var sfPass2 = document.getElementById('create-ra-password');
      if (tfaPass2 && sfPass2 && !sfPass2.value && tfaPass2.value) sfPass2.value = tfaPass2.value;
      updateCreateSingleFactorUI(document.getElementById('create-ra-method')?.value || 'email_password');
    }
  }

  // Auth type toggle
  var createAuthTypeGroup = document.getElementById('create-auth-type-group');
  if (createAuthTypeGroup) {
    createAuthTypeGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        createAuthTypeGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('create-auth-type').value = btn.dataset.value;
        updateCreateAuthTypeUI();
      });
    });
  }

  // Single-factor method toggle
  var createMethodGroup = document.getElementById('create-ra-method-group');
  if (createMethodGroup) {
    createMethodGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        createMethodGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('create-ra-method').value = btn.dataset.value;
        updateCreateSingleFactorUI(btn.dataset.value);
      });
    });
  }

  // 2FA Factor 2 method toggle
  var create2faMethodGroup = document.getElementById('create-ra-2fa-method-group');
  if (create2faMethodGroup) {
    create2faMethodGroup.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        create2faMethodGroup.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById('create-ra-method').value = btn.dataset.value;
        updateCreate2faMethodUI();
      });
    });
  }

  // 2FA toggle
  document.getElementById('create-ra-2fa')?.addEventListener('click', function () {
    this.classList.toggle('on');
    var is2fa = this.classList.contains('on');
    if (is2fa) {
      var currentMethod = document.getElementById('create-ra-method')?.value || 'email_password';
      if (currentMethod === 'email_password') {
        document.getElementById('create-ra-method').value = 'email_code';
        setToggleGroup('create-ra-2fa-method-group', 'create-ra-method', 'email_code');
      } else {
        setToggleGroup('create-ra-2fa-method-group', 'create-ra-method', currentMethod);
      }
    }
    updateCreateRouteAuthMethodUI();
  });

  // ─── Create rate limit toggle ──────────────────────────
  var createRlToggle = document.getElementById('create-route-rate-limit');
  var createRlFields = document.getElementById('create-rate-limit-fields');
  if (createRlToggle) {
    createRlToggle.addEventListener('click', function() {
      setTimeout(function() {
        if (createRlFields) createRlFields.style.display = createRlToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // ─── ACL helpers ──────────────────────────────────────
  function renderAclPeerChecklist(prefix, selectedPeerIds) {
    var list = document.getElementById(prefix + '-acl-peers-list');
    if (!list) return;
    list.textContent = '';
    var selected = new Set((selectedPeerIds || []).map(Number));
    for (var i = 0; i < allPeers.length; i++) {
      var p = allPeers[i];
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;font-size:12px;border-radius:var(--radius-xs)';
      label.onmouseenter = function() { this.style.background = 'var(--bg-panel)'; };
      label.onmouseleave = function() { this.style.background = ''; };
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.id;
      cb.checked = selected.has(p.id);
      cb.dataset.aclPeer = prefix;
      cb.addEventListener('change', function() { updateAclHint(prefix); });
      label.appendChild(cb);
      var text = document.createElement('span');
      var ip = p.ip || '?';
      var status = p.isOnline ? ' (online)' : p.enabled ? '' : ' (disabled)';
      text.textContent = p.name + ' — ' + ip + status;
      text.style.cssText = 'font-family:var(--font-mono)';
      label.appendChild(text);
      list.appendChild(label);
    }
    updateAclHint(prefix);
  }

  function getSelectedAclPeers(prefix) {
    var list = document.getElementById(prefix + '-acl-peers-list');
    if (!list) return [];
    var cbs = list.querySelectorAll('input[type="checkbox"]:checked');
    var ids = [];
    for (var i = 0; i < cbs.length; i++) ids.push(Number(cbs[i].value));
    return ids;
  }

  function updateAclHint(prefix) {
    var hint = document.getElementById(prefix + '-acl-hint');
    if (!hint) return;
    var count = getSelectedAclPeers(prefix).length;
    if (count === 0) {
      hint.textContent = GC.t['acl.no_peers_selected'] || 'No peers selected';
      hint.style.color = (isAurora() ? 'var(--amber)' : 'var(--yellow, #facc15)');
    } else {
      hint.textContent = (GC.t['acl.peers_selected'] || '{{count}} peer(s) allowed').replace('{{count}}', count);
      hint.style.color = 'var(--green, #4ade80)';
    }
  }

  function setupAclToggle(prefix) {
    var toggle = document.getElementById(prefix + '-route-acl');
    var fields = document.getElementById(prefix + '-acl-fields');
    if (!toggle) return;
    // Set up ARIA and visual toggle ourselves (app.js skips data-managed)
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-checked', toggle.classList.contains('on') ? 'true' : 'false');
    toggle.addEventListener('click', function() {
      toggle.classList.toggle('on');
      var isOn = toggle.classList.contains('on');
      toggle.setAttribute('aria-checked', isOn ? 'true' : 'false');
      if (fields) fields.style.display = isOn ? '' : 'none';
      if (isOn) renderAclPeerChecklist(prefix, []);
    });
    toggle.addEventListener('keydown', function(e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle.click(); }
    });
  }

  setupAclToggle('create');
  setupAclToggle('edit');

  // ─── IP filter helpers ─────────────────────────────────
  var editIpFilterRules = [];
  var createIpFilterRules = [];
  var createMirrorTargets = [];
  var editMirrorTargets = [];

  function setupIpFilter(prefix, rulesArr) {
    var toggle = document.getElementById(prefix + '-route-ip-filter');
    var fields = document.getElementById(prefix + '-ip-filter-fields');
    var modeGroup = document.getElementById(prefix + '-ip-filter-mode-group');
    var addBtn = document.getElementById(prefix + '-ip-filter-add');

    if (toggle) toggle.addEventListener('click', function() {
      setTimeout(function() {
        if (fields) fields.style.display = toggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });

    if (modeGroup) modeGroup.querySelectorAll('.toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        modeGroup.querySelectorAll('.toggle-btn').forEach(function(b) { b.classList.remove('on'); });
        btn.classList.add('on');
        document.getElementById(prefix + '-ip-filter-mode').value = btn.dataset.value;
      });
    });

    if (addBtn) addBtn.addEventListener('click', function() {
      var input = document.getElementById(prefix + '-ip-filter-input');
      var typeSelect = document.getElementById(prefix + '-ip-filter-type');
      var val = input.value.trim();
      if (!val) return;
      var arr = prefix === 'edit' ? editIpFilterRules : createIpFilterRules;
      arr.push({ type: typeSelect.value, value: val });
      input.value = '';
      renderIpFilterRules(prefix, arr);
    });
  }

  function renderIpFilterRules(prefix, rulesArr) {
    var list = document.getElementById(prefix + '-ip-filter-rules-list');
    if (!list) return;
    list.textContent = '';
    rulesArr.forEach(function(rule, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:12px';
      var label = document.createElement('span');
      label.style.cssText = 'flex:1;font-family:var(--font-mono)';
      label.textContent = '[' + rule.type.toUpperCase() + '] ' + rule.value;
      row.appendChild(label);
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '\u00d7';
      del.style.cssText = 'background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px';
      del.addEventListener('click', function() { rulesArr.splice(idx, 1); renderIpFilterRules(prefix, rulesArr); });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  setupIpFilter('edit', editIpFilterRules);

  // ─── External-block visibility ────────────────────────
  function syncBlockVisibility(prefix) {
    var ext = document.getElementById(prefix + '-route-external');
    var wrap = document.getElementById(prefix + '-route-block-wrap');
    var action = document.getElementById(prefix + '-route-block-action');
    var body = document.getElementById(prefix + '-route-block-body');
    var redir = document.getElementById(prefix + '-route-block-redirect');
    if (!wrap || !action) return;
    var internalOnly = !(ext && ext.classList.contains('on'));
    wrap.style.display = internalOnly ? '' : 'none';
    if (body) body.style.display = action.value === 'custom' ? '' : 'none';
    if (redir) redir.style.display = action.value === 'redirect' ? '' : 'none';
  }

  // Create: wire external toggle + block-action select
  var createExtToggle = document.getElementById('create-route-external');
  if (createExtToggle) {
    createExtToggle.addEventListener('click', function() {
      setTimeout(function() { syncBlockVisibility('create'); }, 0);
    });
  }
  var createBlockActionSel = document.getElementById('create-route-block-action');
  if (createBlockActionSel) {
    createBlockActionSel.addEventListener('change', function() { syncBlockVisibility('create'); });
  }

  // Edit: wire external toggle + block-action select
  var editExtToggle = document.getElementById('edit-route-external');
  if (editExtToggle) {
    editExtToggle.addEventListener('click', function() {
      setTimeout(function() { syncBlockVisibility('edit'); }, 0);
    });
  }
  var editBlockActionSel = document.getElementById('edit-route-block-action');
  if (editBlockActionSel) {
    editBlockActionSel.addEventListener('change', function() { syncBlockVisibility('edit'); });
  }

  // ─── Edit modal tab switching ─────────────────────────
  var currentEditRouteId = null;

  document.addEventListener('click', function(e) {
    var tab = e.target.closest('.edit-route-tabs .tab[data-edit-tab]');
    if (!tab) return;
    var modal = document.getElementById('modal-edit-route');
    modal.querySelectorAll('.edit-route-tabs .tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    modal.querySelectorAll('.edit-route-panel').forEach(function(p) { p.style.display = 'none'; });
    var panel = modal.querySelector('.edit-route-panel[data-panel="' + tab.dataset.editTab + '"]');
    if (panel) panel.style.display = '';
    var tabName = tab.dataset.editTab;
    // Start/stop trace polling based on active tab
    if (tabName === 'debug' && currentEditRouteId) {
      startTracePolling(currentEditRouteId);
    } else {
      stopTracePolling();
    }
  });
  setupIpFilter('create', createIpFilterRules);

  // ─── Backends helpers ─────────────────────────────────
  var editBackendsList = [];

  function buildBackendPeerOptions(selectedPeerId) {
    var opts = '<option value="">\u2014</option>';
    allPeers.forEach(function (p) {
      var sel = (p.id === selectedPeerId || String(p.id) === String(selectedPeerId)) ? ' selected' : '';
      var ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '';
      opts += '<option value="' + p.id + '"' + sel + '>' + escapeHtml(p.name) + ' (' + escapeHtml(ip) + ')</option>';
    });
    return opts;
  }

  function renderBackendsList() {
    var list = document.getElementById('edit-backends-list');
    if (!list) return;
    list.textContent = '';
    editBackendsList.forEach(function(b, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:12px';

      var peerSelect = document.createElement('select');
      peerSelect.innerHTML = buildBackendPeerOptions(b.peer_id);
      peerSelect.style.cssText = 'flex:2;padding:4px 8px;font-size:12px';
      peerSelect.addEventListener('change', function() { editBackendsList[idx].peer_id = parseInt(this.value, 10) || null; });
      row.appendChild(peerSelect);

      var portInput = document.createElement('input');
      portInput.type = 'number';
      portInput.value = b.port || 8080;
      portInput.placeholder = GC.t['routes.backends_port'] || 'Port';
      portInput.min = 1;
      portInput.max = 65535;
      portInput.style.cssText = 'flex:1;padding:4px 8px;font-size:12px';
      portInput.addEventListener('change', function() { editBackendsList[idx].port = parseInt(this.value, 10); });
      row.appendChild(portInput);

      var weightInput = document.createElement('input');
      weightInput.type = 'number';
      weightInput.value = b.weight || 1;
      weightInput.placeholder = GC.t['routes.backends_weight'] || 'Weight';
      weightInput.min = 1;
      weightInput.max = 100;
      weightInput.style.cssText = 'width:60px;padding:4px 8px;font-size:12px';
      weightInput.addEventListener('change', function() { editBackendsList[idx].weight = parseInt(this.value, 10); });
      row.appendChild(weightInput);

      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '\u00d7';
      del.style.cssText = 'background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px';
      del.addEventListener('click', function() { editBackendsList.splice(idx, 1); renderBackendsList(); });
      row.appendChild(del);

      list.appendChild(row);
    });
  }

  var backendsAddBtn = document.getElementById('edit-backends-add');
  if (backendsAddBtn) {
    backendsAddBtn.addEventListener('click', function() {
      editBackendsList.push({ peer_id: null, port: 8080, weight: 1 });
      renderBackendsList();
    });
  }

  // ─── Create retry toggle ──────────────────────────────
  var createRetryToggle = document.getElementById('create-route-retry');
  var createRetryFields = document.getElementById('create-retry-fields');
  if (createRetryToggle) {
    createRetryToggle.addEventListener('click', function() {
      setTimeout(function() {
        if (createRetryFields) createRetryFields.style.display = createRetryToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // ─── Create circuit breaker toggle ────────────────────
  var createCbToggle = document.getElementById('create-route-circuit-breaker');
  var createCbFields = document.getElementById('create-circuit-breaker-fields');
  if (createCbToggle) {
    createCbToggle.addEventListener('click', function() {
      setTimeout(function() {
        if (createCbFields) createCbFields.style.display = createCbToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // ─── Create mirror toggle ────────────────────────────
  var createMirrorToggle = document.getElementById('create-route-mirror');
  var createMirrorFields = document.getElementById('create-mirror-fields');
  if (createMirrorToggle) {
    createMirrorToggle.addEventListener('click', function() {
      setTimeout(function() {
        if (createMirrorFields) createMirrorFields.style.display = createMirrorToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // Mirror target rows use peer dropdown + port input
  function buildMirrorPeerOptions(selectedPeerId) {
    var opts = '<option value="">\u2014</option>';
    allPeers.forEach(function (p) {
      var sel = (p.id === selectedPeerId || String(p.id) === String(selectedPeerId)) ? ' selected' : '';
      var ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '';
      opts += '<option value="' + p.id + '"' + sel + '>' + escapeHtml(p.name) + ' (' + escapeHtml(ip) + ')</option>';
    });
    return opts;
  }

  function renderCreateMirrorTargets() {
    var list = document.getElementById('create-mirror-targets-list');
    var hint = document.getElementById('create-mirror-max-hint');
    var addBtn = document.getElementById('create-mirror-add-target');
    if (!list) return;
    list.innerHTML = '';
    createMirrorTargets.forEach(function (t, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center';
      row.innerHTML = '<select style="flex:2;padding:6px 10px;font-size:12px">' + buildMirrorPeerOptions(t.peer_id) + '</select>'
        + '<input type="number" placeholder="' + (GC.t['routes.mirror_target_port'] || 'Port') + '" value="' + (parseInt(t.port, 10) || 8080) + '" min="1" max="65535" style="flex:1;padding:6px 10px;font-size:12px">'
        + '<button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:12px;color:var(--red)">\u2715</button>';
      var sel = row.querySelector('select');
      var portInput = row.querySelector('input');
      sel.addEventListener('change', function () { createMirrorTargets[i].peer_id = parseInt(this.value, 10) || null; });
      portInput.addEventListener('input', function () { createMirrorTargets[i].port = parseInt(this.value, 10) || 8080; });
      row.querySelector('button').addEventListener('click', function () {
        createMirrorTargets.splice(i, 1);
        renderCreateMirrorTargets();
      });
      list.appendChild(row);
    });
    if (hint) hint.style.display = createMirrorTargets.length >= 5 ? '' : 'none';
    if (addBtn) addBtn.disabled = createMirrorTargets.length >= 5;
  }

  var createMirrorAddBtn = document.getElementById('create-mirror-add-target');
  if (createMirrorAddBtn) {
    createMirrorAddBtn.addEventListener('click', function () {
      if (createMirrorTargets.length < 5) {
        createMirrorTargets.push({ peer_id: null, port: 8080 });
        renderCreateMirrorTargets();
      }
    });
  }

  function renderEditMirrorTargets() {
    var list = document.getElementById('edit-mirror-targets-list');
    var hint = document.getElementById('edit-mirror-max-hint');
    var addBtn = document.getElementById('edit-mirror-add-target');
    if (!list) return;
    list.innerHTML = '';
    editMirrorTargets.forEach(function (t, i) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center';
      row.innerHTML = '<select style="flex:2;padding:6px 10px;font-size:12px">' + buildMirrorPeerOptions(t.peer_id) + '</select>'
        + '<input type="number" placeholder="' + (GC.t['routes.mirror_target_port'] || 'Port') + '" value="' + (parseInt(t.port, 10) || 8080) + '" min="1" max="65535" style="flex:1;padding:6px 10px;font-size:12px">'
        + '<button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:12px;color:var(--red)">\u2715</button>';
      var sel = row.querySelector('select');
      var portInput = row.querySelector('input');
      sel.addEventListener('change', function () { editMirrorTargets[i].peer_id = parseInt(this.value, 10) || null; });
      portInput.addEventListener('input', function () { editMirrorTargets[i].port = parseInt(this.value, 10) || 8080; });
      row.querySelector('button').addEventListener('click', function () {
        editMirrorTargets.splice(i, 1);
        renderEditMirrorTargets();
      });
      list.appendChild(row);
    });
    if (hint) hint.style.display = editMirrorTargets.length >= 5 ? '' : 'none';
    if (addBtn) addBtn.disabled = editMirrorTargets.length >= 5;
  }

  var editMirrorAddBtn = document.getElementById('edit-mirror-add-target');
  if (editMirrorAddBtn) {
    editMirrorAddBtn.addEventListener('click', function () {
      if (editMirrorTargets.length < 5) {
        editMirrorTargets.push({ peer_id: null, port: 8080 });
        renderEditMirrorTargets();
      }
    });
  }

  // ─── Custom Headers helpers ─────────────────────────
  var editHeadersRequest = [];
  var editHeadersResponse = [];

  function renderHeadersList(prefix, type, arr) {
    var list = document.getElementById(prefix + '-headers-' + type + '-list');
    if (!list) return;
    list.textContent = '';
    arr.forEach(function(h, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:12px';
      var label = document.createElement('span');
      label.style.cssText = 'flex:1;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      label.textContent = h.name + ': ' + h.value;
      row.appendChild(label);
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '\u00d7';
      del.style.cssText = 'background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:0 4px';
      del.addEventListener('click', function() { arr.splice(idx, 1); renderHeadersList(prefix, type, arr); });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function setupHeadersAdd(prefix, type, arr) {
    var addBtn = document.getElementById(prefix + '-headers-' + (type === 'request' ? 'req' : 'resp') + '-add');
    if (!addBtn) return;
    addBtn.addEventListener('click', function() {
      var nameInput = document.getElementById(prefix + '-headers-' + (type === 'request' ? 'req' : 'resp') + '-name');
      var valueInput = document.getElementById(prefix + '-headers-' + (type === 'request' ? 'req' : 'resp') + '-value');
      var name = nameInput.value.trim();
      var value = valueInput.value.trim();
      if (!name || !value) return;
      arr.push({ name: name, value: value });
      nameInput.value = '';
      valueInput.value = '';
      renderHeadersList(prefix, type, arr);
    });
  }

  setupHeadersAdd('edit', 'request', editHeadersRequest);
  setupHeadersAdd('edit', 'response', editHeadersResponse);

  // Presets dropdown
  var headersPreset = document.getElementById('edit-headers-preset');
  if (headersPreset) {
    headersPreset.addEventListener('change', function() {
      var val = this.value;
      if (!val) return;
      if (val === 'cors') {
        editHeadersResponse.push({ name: 'Access-Control-Allow-Origin', value: '*' });
        editHeadersResponse.push({ name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' });
        editHeadersResponse.push({ name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' });
      } else if (val === 'security') {
        editHeadersResponse.push({ name: 'X-Frame-Options', value: 'DENY' });
        editHeadersResponse.push({ name: 'X-Content-Type-Options', value: 'nosniff' });
        editHeadersResponse.push({ name: 'X-XSS-Protection', value: '1; mode=block' });
        editHeadersResponse.push({ name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' });
      }
      renderHeadersList('edit', 'response', editHeadersResponse);
      this.value = '';
    });
  }

  // ─── Branding logo upload/remove ──────────────────────
  var logoFileInput = document.getElementById('edit-branding-logo-file');
  if (logoFileInput) {
    logoFileInput.addEventListener('change', async function() {
      var file = this.files[0];
      if (!file) return;
      var routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;
      var formData = new FormData();
      formData.append('logo', file);
      try {
        var resp = await fetch('/api/v1/routes/' + routeId + '/branding/logo', {
          method: 'POST',
          headers: { 'X-CSRF-Token': window.GC.csrfToken },
          body: formData,
        });
        var data = await resp.json();
        if (data.ok) {
          document.getElementById('edit-branding-logo-current').textContent = data.filename;
          document.getElementById('edit-branding-logo-remove').style.display = '';
        } else {
          alert(data.error || 'Upload failed');
        }
      } catch (err) { alert(err.message); }
    });
  }

  var logoRemoveBtn = document.getElementById('edit-branding-logo-remove');
  if (logoRemoveBtn) {
    logoRemoveBtn.addEventListener('click', async function() {
      var routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;
      try {
        await api.del('/api/v1/routes/' + routeId + '/branding/logo');
        document.getElementById('edit-branding-logo-current').textContent = '';
        logoRemoveBtn.style.display = 'none';
      } catch (err) { alert(err.message); }
    });
  }

  var bgFileInput = document.getElementById('edit-branding-bg-file');
  if (bgFileInput) {
    bgFileInput.addEventListener('change', async function() {
      var file = this.files[0];
      if (!file) return;
      var routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;
      var formData = new FormData();
      formData.append('bg_image', file);
      try {
        var resp = await fetch('/api/v1/routes/' + routeId + '/branding/bg-image', {
          method: 'POST',
          headers: { 'X-CSRF-Token': window.GC.csrfToken },
          body: formData,
        });
        var data = await resp.json();
        if (data.ok) {
          document.getElementById('edit-branding-bg-current').textContent = data.filename;
          document.getElementById('edit-branding-bg-remove').style.display = '';
        } else {
          alert(data.error || 'Upload failed');
        }
      } catch (err) { alert(err.message); }
    });
  }

  var bgRemoveBtn = document.getElementById('edit-branding-bg-remove');
  if (bgRemoveBtn) {
    bgRemoveBtn.addEventListener('click', async function() {
      var routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;
      try {
        await api.del('/api/v1/routes/' + routeId + '/branding/bg-image');
        document.getElementById('edit-branding-bg-current').textContent = '';
        bgRemoveBtn.style.display = 'none';
      } catch (err) { alert(err.message); }
    });
  }

  // ─── Inline-Help Tooltips (gc-tip) ───────────────────────
  (function setupGcTips() {
    let bubble = document.getElementById('gc-tip-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'gc-tip-bubble';
      document.body.appendChild(bubble);
    }
    function show(tip) {
      const text = tip.getAttribute('data-tip');
      if (!text) return;
      bubble.textContent = text;
      bubble.style.display = 'block';
      const r = tip.getBoundingClientRect();
      const bb = bubble.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + bb.height > window.innerHeight - 8) top = r.top - bb.height - 6;
      let left = r.left + r.width / 2 - bb.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - bb.width - 8));
      bubble.style.top = top + 'px';
      bubble.style.left = left + 'px';
    }
    function hide() { bubble.style.display = 'none'; }
    function tipFrom(e) { return e.target && e.target.closest ? e.target.closest('.gc-tip') : null; }
    document.addEventListener('mouseover', (e) => { const t = tipFrom(e); if (t) show(t); });
    document.addEventListener('mouseout', (e) => { if (tipFrom(e)) hide(); });
    document.addEventListener('focusin', (e) => { const t = tipFrom(e); if (t) show(t); });
    document.addEventListener('focusout', (e) => { if (tipFrom(e)) hide(); });
    document.addEventListener('click', (e) => {
      const t = tipFrom(e);
      if (t) { e.preventDefault(); if (bubble.style.display === 'block') hide(); else show(t); }
      else if (e.target !== bubble) hide();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  })();

  // ─── L4 blocked-port validation ──────────────────────────
  const PORT_SVC = { 22: 'SSH', 53: 'DNS', 80: 'Caddy HTTP', 443: 'Caddy HTTPS', 2019: 'Caddy Admin', 3000: 'GateControl', 51820: 'WireGuard' };
  function parsePortRangeClient(str) {
    if (!str || typeof str !== 'string') return null;
    const t = str.trim();
    const m = t.match(/^(\d+)-(\d+)$/);
    if (m) { const s = parseInt(m[1], 10), e = parseInt(m[2], 10); return (s >= 1 && e <= 65535 && s <= e) ? { start: s, end: e } : null; }
    if (/^\d+$/.test(t)) { const n = parseInt(t, 10); if (n >= 1 && n <= 65535) return { start: n, end: n }; }
    return null;
  }
  function firstBlockedPort(str, blocked) {
    const range = parsePortRangeClient(str);
    if (!range) return null;
    for (let p = range.start; p <= range.end; p++) { if (blocked.indexOf(p) !== -1) return p; }
    return null;
  }
  function checkListenPortBlocked(inputId, errId) {
    const input = document.getElementById(inputId);
    const errEl = document.getElementById(errId);
    if (!input) return true;
    const blocked = (input.dataset.blockedPorts || '').split(',').map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    const hit = input.value ? firstBlockedPort(input.value, blocked) : null;
    if (hit != null) {
      input.classList.add('gc-port-error');
      if (errEl) {
        const svc = PORT_SVC[hit];
        const tpl = svc ? (GC.t['routes.l4_port_reserved'] || 'Port {port} is reserved ({service}).')
                        : (GC.t['routes.l4_port_reserved_generic'] || 'Port {port} is reserved by the system.');
        errEl.textContent = tpl.replace('{port}', hit).replace('{service}', svc || '');
        errEl.style.display = '';
      }
      return false;
    }
    input.classList.remove('gc-port-error');
    if (errEl) errEl.style.display = 'none';
    return true;
  }

  // ─── L4 listen port auto-fill ───────────────────────────
  function setupPortAutofill(portId, listenPortId, errId) {
    document.getElementById(portId)?.addEventListener('input', function() {
      const listenPort = document.getElementById(listenPortId);
      if (listenPort && !listenPort.dataset.userModified) {
        listenPort.value = this.value;
        checkListenPortBlocked(listenPortId, errId);
      }
    });
    const lp = document.getElementById(listenPortId);
    if (lp) {
      lp.addEventListener('input', function() { this.dataset.userModified = 'true'; checkListenPortBlocked(listenPortId, errId); });
      lp.addEventListener('change', function() { checkListenPortBlocked(listenPortId, errId); });
    }
  }
  setupPortAutofill('route-port', 'l4-listen-port', 'l4-listen-port-error');
  setupPortAutofill('edit-route-port', 'edit-l4-listen-port', 'edit-l4-listen-port-error');

  // ─── DNS check ──────────────────────────────────────────
  async function checkDns(domain, hintEl, inputEl) {
    if (!domain || !hintEl || !inputEl) return;
    const routeTypeId = inputEl.id === 'create-route-domain-freetext' ? 'route-type' : 'edit-route-type';
    const routeType = document.getElementById(routeTypeId)?.value || 'http';
    if (routeType === 'l4') {
      hintEl.style.display = 'none';
      return;
    }
    const checking = inputEl.dataset.dnsChecking || 'Checking DNS...';
    const okMsg = inputEl.dataset.dnsOk || 'DNS OK';
    const warnTpl = inputEl.dataset.dnsWarning || 'Domain does not point to this server (expected: {{ip}})';
    hintEl.textContent = checking;
    hintEl.style.color = 'var(--text-3)';
    hintEl.style.display = '';
    try {
      const data = await api.post('/api/routes/check-dns', { domain });
      if (!data || !data.ok) {
        hintEl.style.display = 'none';
        return;
      }
      if (data.resolves) {
        hintEl.textContent = okMsg;
        hintEl.style.color = 'var(--green, #4ade80)';
      } else if (data.expected) {
        hintEl.textContent = warnTpl.replace('{{ip}}', data.expected);
        hintEl.style.color = (isAurora() ? 'var(--amber)' : 'var(--yellow, #facc15)');
      } else {
        hintEl.style.display = 'none';
      }
    } catch (_) {
      hintEl.style.display = 'none';
    }
  }

  // Attach DNS check blur handlers
  (function setupDnsCheck() {
    const createDomainInput = document.getElementById('create-route-domain-freetext');
    const createDnsHint = document.getElementById('create-route-dns-hint');
    if (createDomainInput && createDnsHint) {
      createDomainInput.addEventListener('blur', function() {
        const val = this.value.trim();
        if (val) checkDns(val, createDnsHint, createDomainInput);
        else createDnsHint.style.display = 'none';
      });
    }

    const editDomainInput = document.getElementById('edit-route-domain');
    const editDnsHint = document.getElementById('edit-route-dns-hint');
    if (editDomainInput && editDnsHint) {
      editDomainInput.addEventListener('blur', function() {
        const val = this.value.trim();
        if (val) checkDns(val, editDnsHint, editDomainInput);
        else editDnsHint.style.display = 'none';
      });
    }
  })();

  // ─── Initialize toggle groups ─────────────────────────
  setupToggleGroup('route-type-group', 'route-type');
  setupToggleGroup('l4-protocol-group', 'l4-protocol');
  setupToggleGroup('edit-route-type-group', 'edit-route-type');
  setupToggleGroup('edit-l4-protocol-group', 'edit-l4-protocol');

  document.getElementById('l4-tls-mode')?.addEventListener('change', updateFieldVisibility);
  document.getElementById('edit-l4-tls-mode')?.addEventListener('change', function() {
    updateEditFieldVisibility();
  });

  // ─── Edit modal: one-time toggle handlers for show/hide fields ──
  // app.js handles the visual toggle (classList, ARIA, keyboard) since
  // data-managed was removed. We just react AFTER app.js toggles the state.
  function setupSimpleToggle(toggleId, fieldsId) {
    var toggle = document.getElementById(toggleId);
    var fields = document.getElementById(fieldsId);
    if (toggle && fields) {
      toggle.addEventListener('click', function() {
        setTimeout(function() {
          fields.style.display = toggle.classList.contains('on') ? '' : 'none';
        }, 0);
      });
    }
  }

  setupSimpleToggle('edit-route-rate-limit', 'edit-rate-limit-fields');
  setupSimpleToggle('edit-route-retry', 'edit-retry-fields');
  setupSimpleToggle('edit-route-backends', 'edit-backends-fields');
  setupSimpleToggle('edit-route-sticky', 'edit-sticky-fields');
  setupSimpleToggle('edit-route-circuit-breaker', 'edit-circuit-breaker-fields');
  setupSimpleToggle('edit-route-mirror', 'edit-mirror-fields');

  // Debug toggle show/hide container
  var editDebugToggle = document.getElementById('edit-route-debug');
  var editDebugContainer = document.getElementById('edit-debug-container');
  if (editDebugToggle && editDebugContainer) {
    editDebugToggle.addEventListener('click', function() {
      setTimeout(function() {
        editDebugContainer.style.display = editDebugToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // Bot blocker toggle (create)
  var createBbToggle = document.getElementById('create-route-bot-blocker');
  var createBbFields = document.getElementById('create-bot-blocker-fields');
  if (createBbToggle) {
    createBbToggle.classList.remove('on');
    createBbToggle.addEventListener('click', function() {
      setTimeout(function() {
        if (createBbFields) createBbFields.style.display = createBbToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // Bot blocker toggle (edit)
  var editBbToggle = document.getElementById('edit-route-bot-blocker');
  var editBbFields = document.getElementById('edit-bot-blocker-fields');
  if (editBbToggle && editBbFields) {
    editBbToggle.addEventListener('click', function() {
      setTimeout(function() {
        editBbFields.style.display = editBbToggle.classList.contains('on') ? '' : 'none';
      }, 0);
    });
  }

  // Mode-switch field visibility helper
  function updateBotBlockerFields(prefix) {
    var mode = document.getElementById(prefix + '-bot-blocker-mode')?.value || 'block';
    var redirectDiv = document.getElementById(prefix + '-bot-blocker-redirect');
    var customDiv = document.getElementById(prefix + '-bot-blocker-custom');
    if (redirectDiv) redirectDiv.style.display = mode === 'redirect' ? '' : 'none';
    if (customDiv) customDiv.style.display = mode === 'custom' ? '' : 'none';
  }

  // Mode change listeners
  var createBbMode = document.getElementById('create-bot-blocker-mode');
  if (createBbMode) createBbMode.addEventListener('change', function() { updateBotBlockerFields('create'); });
  var editBbMode = document.getElementById('edit-bot-blocker-mode');
  if (editBbMode) editBbMode.addEventListener('change', function() { updateBotBlockerFields('edit'); });

  // Trace polling system
  var traceInterval = null;
  var lastTraceSince = '';
  var currentTraceRouteId = null;

  function startTracePolling(routeId) {
    stopTracePolling();
    currentTraceRouteId = routeId;
    lastTraceSince = '';
    var log = document.getElementById('edit-debug-log');
    if (log) log.querySelectorAll('.trace-entry').forEach(function(el) { el.remove(); });
    var empty = document.getElementById('edit-debug-empty');
    if (empty) empty.style.display = '';
    fetchTraceEntries(routeId);
    traceInterval = setInterval(function() { fetchTraceEntries(routeId); }, 3000);
  }

  function stopTracePolling() {
    if (traceInterval) { clearInterval(traceInterval); traceInterval = null; }
    currentTraceRouteId = null;
  }

  function fetchTraceEntries(routeId) {
    var url = '/api/v1/routes/' + routeId + '/trace?limit=50';
    if (lastTraceSince) url += '&since=' + encodeURIComponent(lastTraceSince);
    window.api.get(url).then(function(res) {
      if (res.ok && res.data && res.data.entries) {
        renderTraceEntries(res.data.entries);
      }
    }).catch(function() {});
  }

  function renderTraceEntries(entries) {
    var log = document.getElementById('edit-debug-log');
    var empty = document.getElementById('edit-debug-empty');
    if (!log) return;
    if (entries.length === 0 && !log.querySelector('.trace-entry')) return;
    if (empty) empty.style.display = entries.length > 0 || log.querySelector('.trace-entry') ? 'none' : '';

    entries.forEach(function(e) {
      if (e.timestamp && e.timestamp > lastTraceSince) lastTraceSince = e.timestamp;
      var statusColor = e.status >= 500 ? 'var(--red, #f87171)' : e.status >= 400 ? (isAurora() ? 'var(--amber)' : 'var(--yellow, #facc15)') : 'var(--green, #4ade80)';

      var div = document.createElement('div');
      div.className = 'trace-entry';
      div.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);align-items:center;font-size:11px';

      var tsSpan = document.createElement('span');
      tsSpan.style.cssText = 'color:var(--text-3);min-width:70px';
      tsSpan.textContent = (e.timestamp.split('T')[1] || '').split('.')[0] || '';

      var methodSpan = document.createElement('span');
      methodSpan.style.cssText = 'font-weight:600;min-width:40px';
      methodSpan.textContent = e.method;

      var uriSpan = document.createElement('span');
      uriSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      uriSpan.textContent = e.uri;

      var statusSpan = document.createElement('span');
      statusSpan.style.cssText = 'color:' + statusColor + ';font-weight:600;min-width:30px';
      statusSpan.textContent = e.status || '-';

      var ipSpan = document.createElement('span');
      ipSpan.style.cssText = 'color:var(--text-3);min-width:80px';
      ipSpan.textContent = e.remote_ip;

      div.appendChild(tsSpan);
      div.appendChild(methodSpan);
      div.appendChild(uriSpan);
      div.appendChild(statusSpan);
      div.appendChild(ipSpan);

      log.insertBefore(div, log.firstChild);
    });
  }

  // Clear button
  var debugClear = document.getElementById('edit-debug-clear');
  if (debugClear) {
    debugClear.addEventListener('click', function() {
      var log = document.getElementById('edit-debug-log');
      if (log) {
        log.querySelectorAll('.trace-entry').forEach(function(el) { el.remove(); });
        var empty = document.getElementById('edit-debug-empty');
        if (empty) empty.style.display = '';
      }
      lastTraceSince = '';
    });
  }

  // ─── Batch mode (routes) ─────────────────────────────────
  var batchBtn = document.getElementById('btn-batch-routes');
  var batchBar = document.getElementById('batch-bar-routes');
  var batchCountEl = document.getElementById('batch-bar-routes-count');

  function enterBatchMode() {
    batchMode = true;
    batchSelected.clear();
    if (batchBtn) batchBtn.style.display = 'none';
    applyRouteFilter();
    updateBatchBar();
  }

  function exitBatchMode() {
    batchMode = false;
    batchSelected.clear();
    if (batchBtn) batchBtn.style.display = '';
    if (batchBar) batchBar.style.display = 'none';
    applyRouteFilter();
  }

  function updateBatchBar() {
    var count = batchSelected.size;
    if (batchMode && batchBar) {
      batchBar.style.display = '';
      if (count > 0) {
        batchCountEl.textContent = count + ' ' + (GC.t['batch.selected'] || 'selected');
        document.getElementById('batch-enable-routes').textContent = (GC.t['batch.enable'] || 'Enable ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-disable-routes').textContent = (GC.t['batch.disable'] || 'Disable ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-delete-routes').textContent = (GC.t['batch.delete'] || 'Delete ({{count}})').replace('{{count}}', count);
        document.getElementById('batch-enable-routes').disabled = false;
        document.getElementById('batch-disable-routes').disabled = false;
        document.getElementById('batch-delete-routes').disabled = false;
      } else {
        batchCountEl.textContent = GC.t['batch.none_selected'] || 'Select items...';
        // Strip the ' ({{count}})' placeholder so the button labels don't
        // leak raw template syntax while nothing is selected.
        document.getElementById('batch-enable-routes').textContent = (GC.t['batch.enable'] || 'Enable').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-disable-routes').textContent = (GC.t['batch.disable'] || 'Disable').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-delete-routes').textContent = (GC.t['batch.delete'] || 'Delete').replace(' ({{count}})', '').replace('({{count}})', '');
        document.getElementById('batch-enable-routes').disabled = true;
        document.getElementById('batch-disable-routes').disabled = true;
        document.getElementById('batch-delete-routes').disabled = true;
      }
    } else if (batchBar) {
      batchBar.style.display = 'none';
    }
  }

  if (batchBtn) batchBtn.addEventListener('click', enterBatchMode);
  var batchCancelBtn = document.getElementById('batch-cancel-routes');
  if (batchCancelBtn) batchCancelBtn.addEventListener('click', exitBatchMode);

  // Checkbox delegation on routes list
  routesList.addEventListener('change', function(e) {
    var cb = e.target.closest('.batch-checkbox');
    if (!cb) return;
    var id = String(cb.dataset.batchId);
    if (cb.checked) batchSelected.add(id);
    else batchSelected.delete(id);
    updateBatchBar();
  });

  // Click on a route entry in batch mode toggles its checkbox.
  // [data-route-id] matches both card entries and table rows.
  routesList.addEventListener('click', function(e) {
    if (!batchMode) return;
    // Don't toggle if clicking action buttons or the checkbox itself
    if (e.target.closest('[data-action]') || e.target.closest('[data-gaction]') || e.target.closest('.batch-checkbox')) return;
    var item = e.target.closest('[data-route-id]');
    if (!item) return;
    var cb = item.querySelector('.batch-checkbox');
    if (!cb) return;
    cb.checked = !cb.checked;
    var id = String(cb.dataset.batchId);
    if (cb.checked) batchSelected.add(id);
    else batchSelected.delete(id);
    updateBatchBar();
  });

  async function executeBatchAction(action) {
    var ids = Array.from(batchSelected).map(Number);
    if (ids.length === 0) return;
    try {
      var data = await api.post('/api/routes/batch', { action: action, ids: ids });
      if (data.ok) {
        exitBatchMode();
        loadRoutes();
      } else {
        alert(data.error || (GC.t['common.error'] || 'Error'));
      }
    } catch (err) {
      alert((GC.t['common.error'] || 'Error') + ': ' + err.message);
    }
  }

  var batchEnableBtn = document.getElementById('batch-enable-routes');
  var batchDisableBtn = document.getElementById('batch-disable-routes');
  var batchDeleteBtn = document.getElementById('batch-delete-routes');

  if (batchEnableBtn) batchEnableBtn.addEventListener('click', function() {
    executeBatchAction('enable');
  });
  if (batchDisableBtn) batchDisableBtn.addEventListener('click', function() {
    executeBatchAction('disable');
  });
  if (batchDeleteBtn) batchDeleteBtn.addEventListener('click', function() {
    var count = batchSelected.size;
    var msg = (GC.t['batch.confirm_delete_routes'] || 'Are you sure you want to delete {{count}} route(s)?').replace('{{count}}', count);
    if (confirm(msg)) {
      executeBatchAction('delete');
    }
  });

  // ─── Service wizard (bundle = http + n× l4 in one shot) ──
  (function initServiceWizard() {
    const overlay = document.getElementById('service-modal-overlay');
    const openBtn = document.getElementById('btn-add-service');
    if (!overlay || !openBtn) return;

    const steps = [1, 2, 3];
    let step = 1;
    const el = function (id) { return document.getElementById(id); };

    function showError(msg) {
      const box = el('service-error');
      box.textContent = msg || '';
      box.style.display = msg ? '' : 'none';
    }

    function hideConflict() {
      const banner = el('service-conflict');
      if (banner) banner.style.display = 'none';
    }

    function paintSteps() {
      document.querySelectorAll('#service-wizard-steps .service-step-pill').forEach(function (p) {
        const n = parseInt(p.dataset.sstep, 10);
        p.classList.toggle('on', n === step);
        p.classList.toggle('done', n < step);
      });
      steps.forEach(function (n) {
        el('service-step-' + n).style.display = n === step ? '' : 'none';
      });
      el('service-back').style.visibility = step === 1 ? 'hidden' : '';
      el('service-next').textContent = step === 3
        ? (GC.t['service_bundle.create'] || 'Create service')
        : (GC.t['service_bundle.next'] || 'Next');
      showError('');
    }

    function targetKind() {
      const sel = el('service-target-kind');
      return sel ? sel.value : 'peer';
    }

    function paintTargetFields() {
      const kind = targetKind();
      el('service-peer-fields').style.display = kind === 'peer' ? '' : 'none';
      el('service-gateway-fields').style.display = kind === 'gateway' ? '' : 'none';
      const poolFields = el('service-pool-fields');
      if (poolFields) poolFields.style.display = kind === 'pool' ? '' : 'none';
      el('service-lan-host-field').style.display = kind === 'peer' ? 'none' : '';
    }

    function addMappingRow(values) {
      const wrap = el('service-mappings');
      if (!wrap) return;
      values = values || {};
      const row = document.createElement('div');
      row.className = 'service-mapping-row';
      const proto = document.createElement('select');
      proto.style.cssText = 'padding:8px';
      ['tcp', 'udp'].forEach(function (p) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p.toUpperCase();
        if (values.protocol === p) o.selected = true;
        proto.appendChild(o);
      });
      const listen = document.createElement('input');
      listen.type = 'text';
      listen.className = 'service-listen-port';
      listen.placeholder = '2022';
      listen.style.cssText = 'width:100%;padding:8px 12px';
      if (values.listen) listen.value = values.listen;
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      const target = document.createElement('input');
      target.type = 'number'; target.min = '1'; target.max = '65535';
      target.className = 'service-target-port';
      target.placeholder = '22';
      target.style.cssText = 'width:100%;padding:8px 12px';
      if (values.target) target.value = values.target;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn icon-btn-danger';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      del.addEventListener('click', function () { row.remove(); hideConflict(); });
      row.appendChild(proto); row.appendChild(listen); row.appendChild(arrow);
      row.appendChild(target); row.appendChild(del);
      wrap.appendChild(row);
    }

    function readMappings() {
      const rows = document.querySelectorAll('#service-mappings .service-mapping-row');
      const out = [];
      for (const row of rows) {
        const listen = row.querySelector('.service-listen-port').value.trim();
        const target = row.querySelector('.service-target-port').value.trim();
        const protocol = row.querySelector('select').value;
        if (!listen && !target) continue; // empty row — ignore
        out.push({ l4_protocol: protocol, l4_listen_port: listen, target_port: target, l4_tls_mode: 'none', _row: row });
      }
      return out;
    }

    function httpEnabled() {
      const cb = el('service-http-enabled');
      return !!(cb && cb.checked);
    }

    function validateStep() {
      if (step === 1) {
        if (!el('service-name').value.trim()) return GC.t['service_bundle.err_name'] || 'Please enter a name';
        const kind = targetKind();
        if (kind === 'peer' && !el('service-peer-select').value) return GC.t['service_bundle.err_target'] || 'Please pick a target';
        if (kind === 'gateway' && !el('service-gateway-peer').value) return GC.t['service_bundle.err_target'] || 'Please pick a target';
        if (kind !== 'peer' && !el('service-lan-host').value.trim()) return GC.t['service_bundle.err_target'] || 'Please pick a target';
        return null;
      }
      if (step === 2) {
        const mappings = readMappings();
        if (!httpEnabled() && mappings.length === 0) return GC.t['service_bundle.err_no_exposure'] || 'Pick at least one exposure';
        if (httpEnabled()) {
          if (!el('service-domain').value.trim()) return GC.t['service_bundle.err_domain'] || 'Domain required';
          if (!el('service-http-port').value.trim()) return GC.t['service_bundle.err_mapping'] || 'Missing port';
        }
        for (const m of mappings) {
          if (!m.l4_listen_port || !m.target_port) return GC.t['service_bundle.err_mapping'] || 'Missing port';
        }
        return null;
      }
      return null;
    }

    function buildPayload() {
      const kind = targetKind();
      const target = { target_kind: kind === 'pool' ? 'gateway' : kind };
      if (kind === 'peer') {
        target.peer_id = parseInt(el('service-peer-select').value, 10) || null;
      } else {
        if (kind === 'pool') {
          const poolSel = el('service-pool-select');
          target.target_pool_id = poolSel ? (parseInt(poolSel.value, 10) || null) : null;
        } else {
          target.target_peer_id = parseInt(el('service-gateway-peer').value, 10) || null;
        }
        target.target_lan_host = el('service-lan-host').value.trim();
      }
      const payload = {
        name: el('service-name').value.trim(),
        domain: el('service-domain').value.trim() || undefined,
        description: el('service-description').value.trim() || undefined,
        target,
        http: httpEnabled() ? {
          target_port: parseInt(el('service-http-port').value, 10),
          backend_https: !!el('service-http-backend-https').checked,
        } : null,
        l4: readMappings().map(function (m) {
          return { l4_protocol: m.l4_protocol, l4_listen_port: m.l4_listen_port, target_port: parseInt(m.target_port, 10), l4_tls_mode: 'none' };
        }),
      };
      return payload;
    }

    function renderReview() {
      const p = buildPayload();
      const box = el('service-review');
      box.textContent = '';
      const row = function (k, v) {
        const div = document.createElement('div');
        div.style.cssText = 'display:grid;grid-template-columns:140px 1fr;padding:8px 12px;border-bottom:1px solid var(--border)';
        const kEl = document.createElement('span');
        kEl.style.cssText = 'color:var(--text-3);font-size:12px';
        kEl.textContent = k;
        const vEl = document.createElement('span');
        vEl.style.cssText = 'font-family:var(--font-mono);font-size:12px';
        vEl.textContent = v;
        div.appendChild(kEl); div.appendChild(vEl);
        box.appendChild(div);
      };
      row(GC.t['service_bundle.name'] || 'Name', p.name);
      if (p.domain) row('Domain', p.domain);
      const kind = targetKind();
      let targetTxt;
      if (kind === 'peer') {
        const sel = el('service-peer-select');
        targetTxt = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
      } else if (kind === 'pool') {
        const sel = el('service-pool-select');
        targetTxt = 'Pool: ' + (sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '') + ' → ' + p.target.target_lan_host;
      } else {
        const sel = el('service-gateway-peer');
        targetTxt = 'Gateway: ' + (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '') + ' → ' + p.target.target_lan_host;
      }
      row(GC.t['service_bundle.target'] || 'Target', targetTxt);
      if (p.http) row(GC.t['service_bundle.http_service'] || 'HTTP', '→ :' + p.http.target_port);
      p.l4.forEach(function (m) {
        row(m.l4_protocol.toUpperCase() + ' :' + m.l4_listen_port, '→ :' + m.target_port);
      });
      const count = (p.http ? 1 : 0) + p.l4.length;
      row('', (GC.t['service_bundle.review_creates'] || 'Creates {{count}} route(s)').replace('{{count}}', count));
    }

    function openWizard() {
      step = 1;
      el('service-name').value = '';
      el('service-domain').value = '';
      el('service-description').value = '';
      if (el('service-http-enabled')) el('service-http-enabled').checked = true;
      if (el('service-http-port')) el('service-http-port').value = '';
      if (el('service-http-backend-https')) el('service-http-backend-https').checked = false;
      const wrap = el('service-mappings');
      if (wrap) { wrap.textContent = ''; addMappingRow(); }
      hideConflict();
      renderPeerOptions(el('service-peer-select'));
      renderGatewayPeerOptions(el('service-gateway-peer'));
      paintTargetFields();
      paintSteps();
      overlay.style.display = 'flex';
    }

    function closeWizard() { overlay.style.display = 'none'; }

    // 409: highlight the colliding mapping and offer the suggested port
    function showConflict(conflict, message) {
      const banner = el('service-conflict');
      if (!banner) { showError(message); return; }
      el('service-conflict-msg').textContent = message;
      const fixBtn = el('service-conflict-fix');
      if (conflict.suggestedPort) {
        fixBtn.style.display = '';
        fixBtn.textContent = (GC.t['service_bundle.use_port'] || 'Use {{port}}').replace('{{port}}', conflict.suggestedPort);
        fixBtn.onclick = function () {
          const m = readMappings().find(function (x) { return String(x.l4_listen_port) === String(conflict.port); });
          if (m) m._row.querySelector('.service-listen-port').value = String(conflict.suggestedPort);
          hideConflict();
        };
      } else {
        fixBtn.style.display = 'none';
      }
      banner.style.display = 'flex';
      step = 2;
      paintSteps();
    }

    async function submit() {
      const btn = el('service-next');
      btn.disabled = true;
      try {
        const data = await api.post('/api/v1/service-bundles', buildPayload());
        if (data.ok) {
          closeWizard();
          loadRoutes();
        } else if (data.conflict) {
          showConflict(data.conflict, data.error || '');
        } else {
          showError(data.error || (GC.t['common.error'] || 'Error'));
        }
      } catch (err) {
        // api helper throws on non-2xx — surface conflict payload when present
        if (err && err.data && err.data.conflict) showConflict(err.data.conflict, err.data.error || err.message);
        else showError(err.message);
      } finally {
        btn.disabled = false;
      }
    }

    openBtn.addEventListener('click', openWizard);
    el('service-modal-close').addEventListener('click', closeWizard);
    // Intentionally NO overlay-click-to-close: a click outside the modal must
    // not discard an in-progress service. Close only via the X button or Escape.

    // DNS check on the service domain (mirrors the route wizard): on blur, warn
    // — but do not block — when the domain does not resolve to this server's
    // public IP. Lets DNS-propagation / proxy setups still proceed.
    (function () {
      const domainInput = el('service-domain');
      const dnsHint = el('service-domain-dns-hint');
      if (!domainInput || !dnsHint) return;
      domainInput.addEventListener('blur', async function () {
        const domain = this.value.trim();
        if (!domain) { dnsHint.style.display = 'none'; return; }
        const checking = this.dataset.dnsChecking || 'Checking DNS...';
        const okMsg = this.dataset.dnsOk || 'DNS OK';
        const warnTpl = this.dataset.dnsWarning || 'Domain does not point to this server (expected: {{ip}})';
        dnsHint.textContent = checking;
        dnsHint.style.color = 'var(--text-3)';
        dnsHint.style.display = '';
        try {
          const data = await api.post('/api/routes/check-dns', { domain: domain });
          if (!data || !data.ok) { dnsHint.style.display = 'none'; return; }
          if (data.resolves) {
            dnsHint.textContent = okMsg;
            dnsHint.style.color = 'var(--green, #4ade80)';
          } else if (data.expected) {
            dnsHint.textContent = warnTpl.replace('{{ip}}', data.expected);
            dnsHint.style.color = (isAurora() ? 'var(--amber)' : 'var(--yellow, #facc15)');
          } else {
            dnsHint.style.display = 'none';
          }
        } catch (_) {
          dnsHint.style.display = 'none';
        }
      });
    })();
    el('service-target-kind').addEventListener('change', paintTargetFields);
    const addBtn = el('service-add-mapping');
    if (addBtn) addBtn.addEventListener('click', function () { addMappingRow(); });
    const httpCb = el('service-http-enabled');
    if (httpCb) httpCb.addEventListener('change', function () {
      el('service-http-body').style.display = httpCb.checked ? '' : 'none';
    });
    el('service-back').addEventListener('click', function () {
      if (step > 1) { step--; paintSteps(); }
    });
    el('service-next').addEventListener('click', function () {
      const err = validateStep();
      if (err) { showError(err); return; }
      if (step < 3) {
        step++;
        if (step === 3) renderReview();
        paintSteps();
      } else {
        submit();
      }
    });
  })();

  // ─── Toolbar: filter chips, sort, view toggle ────────────
  (function initToolbar() {
    const chipBar = document.getElementById('route-filter-chips');
    if (chipBar) {
      chipBar.addEventListener('click', function (e) {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        const dim = chip.dataset.dim;
        const wasActive = chip.classList.contains('on');
        chipBar.querySelectorAll('.filter-chip[data-dim="' + dim + '"]').forEach(function (c) {
          c.classList.remove('on');
        });
        const field = dim === 'type' ? 'typeFilter' : dim === 'status' ? 'statusFilter' : 'targetFilter';
        if (wasActive) {
          viewState[field] = null;
        } else {
          chip.classList.add('on');
          viewState[field] = chip.dataset.value;
        }
        render();
      });
    }

    const sortSel = document.getElementById('route-sort');
    if (sortSel) {
      sortSel.value = viewState.sort;
      sortSel.addEventListener('change', function () {
        viewState.sort = sortSel.value;
        lsSet('gc_routes_sort_v1', viewState.sort);
        render();
      });
    }

    const viewToggle = document.getElementById('route-view-toggle');
    function paintViewToggle() {
      if (!viewToggle) return;
      viewToggle.querySelectorAll('[data-view]').forEach(function (b) {
        b.classList.toggle('on', b.dataset.view === viewState.view);
      });
    }
    if (viewToggle) {
      paintViewToggle();
      viewToggle.addEventListener('click', function (e) {
        const b = e.target.closest('[data-view]');
        if (!b) return;
        viewState.view = b.dataset.view === 'table' ? 'table' : 'cards';
        lsSet('gc_routes_view_v1', viewState.view);
        paintViewToggle();
        render();
      });
    }
  })();

  // Aurora-only: wire the type toggle-group in the Aurora toolbar
  if (isAurora()) auroraInitTypeToggle();
  if (isAurora()) auroraInitCollapseAll();

  // ─── Init ────────────────────────────────────────────────
  loadRoutes();
  loadPeers();
  setInterval(loadRoutes, 30000);

  document.addEventListener('gc:monitor', function () { loadRoutes(); });
  document.addEventListener('gc:reconnected', function () { loadRoutes(); });

  // -- RDP Port Hint ----------------------------------------------
  (function () {
    var portInput = document.getElementById('route-port') || document.getElementById('l4-listen-port') || document.getElementById('edit-l4-listen-port');
    var hintBanner = document.createElement('div');
    hintBanner.id = 'rdp-port-hint';
    hintBanner.className = 'alert alert-info';
    hintBanner.style.cssText = 'display:none;margin-top:8px;font-size:12px';

    var hintSpan = document.createElement('span');
    hintSpan.textContent = GC.t['rdp.port_hint'] || 'This port is commonly used for Remote Desktop (RDP). Would you like to create an RDP route instead?';
    hintBanner.appendChild(hintSpan);

    var rdpLink = document.createElement('a');
    rdpLink.href = '/rdp';
    rdpLink.style.cssText = 'font-weight:600;margin-left:8px';
    rdpLink.textContent = GC.t['rdp.create_rdp_route'] || 'Create RDP Route';
    hintBanner.appendChild(rdpLink);

    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'btn-link';
    dismissBtn.style.cssText = 'margin-left:8px;font-size:11px';
    dismissBtn.textContent = GC.t['rdp.continue_l4'] || 'Continue as L4';
    dismissBtn.addEventListener('click', function () { hintBanner.style.display = 'none'; });
    hintBanner.appendChild(dismissBtn);

    function checkRdpPort() {
      if (!portInput) return;
      var routeType = document.querySelector('[name="route_type"]:checked') || document.getElementById('edit-route-type');
      var isL4 = routeType && (routeType.value === 'l4');
      var val = parseInt(portInput.value, 10);
      if (isL4 && (val === 3389 || val === 3392)) {
        hintBanner.style.display = '';
      } else {
        hintBanner.style.display = 'none';
      }
    }

    if (portInput) {
      portInput.parentElement.appendChild(hintBanner);
      portInput.addEventListener('input', checkRdpPort);
      portInput.addEventListener('change', checkRdpPort);
    }

    var typeRadios = document.querySelectorAll('[name="route_type"]');
    typeRadios.forEach(function (radio) {
      radio.addEventListener('change', checkRdpPort);
    });
  })();

  // ─── Share links (Pro: share_links) ───────────────────
  // Tiny DOM builder so we never touch innerHTML (a hook blocks it).
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'dataset') Object.keys(props[k]).forEach(function (d) { node.dataset[d] = props[k][d]; });
        else if (k === 'style') node.setAttribute('style', props[k]);
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function shareT(key, fallback) {
    return (GC.t && GC.t[key]) || fallback;
  }

  function shareErrMsg(code) {
    var map = {
      disable_basic_auth: shareT('route_auth.share_err_basic_auth', 'This route uses HTTP Basic Auth. Disable Basic Auth before creating a share link.'),
      l4_not_supported: shareT('route_auth.share_err_l4', 'Share links are only available for HTTP routes.'),
      invalid_expiry: shareT('route_auth.share_err_expiry', 'Please choose a valid expiry time.'),
    };
    return map[code] || code;
  }

  // Toggle the route-auth credential selector vs. a read-only "share managed"
  // note. The note element is created on demand (it is not in the template).
  function setRouteAuthShareManaged(managed) {
    var fields = document.getElementById('edit-route-auth-fields');
    if (!fields) return;
    var single = document.getElementById('edit-ra-single-factor');
    var twoFa = document.getElementById('edit-ra-2fa-view');
    var note = document.getElementById('edit-ra-share-managed-note');
    if (managed) {
      if (single) single.style.display = 'none';
      if (twoFa) twoFa.style.display = 'none';
      if (!note) {
        note = el('div', {
          id: 'edit-ra-share-managed-note',
          class: 'form-hint',
          style: 'margin:8px 0',
          text: shareT('route_auth.share_managed', 'Managed by share links'),
        });
        fields.appendChild(note);
      } else {
        note.textContent = shareT('route_auth.share_managed', 'Managed by share links');
        note.style.display = '';
      }
    } else {
      if (single) single.style.display = '';
      if (note) note.style.display = 'none';
    }
  }

  function shareFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    if (opts.method && opts.method !== 'GET') {
      opts.headers['X-CSRF-Token'] = window.GC.csrfToken;
    }
    return fetch(url, opts);
  }

  function formatShareExpiry(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  async function loadShareLinks(routeId) {
    var list = document.getElementById('share-links-list');
    if (!list) return;
    // The secret URL box and create form are siblings of the list (not children),
    // so clearing the list alone would leak a previously shown one-time URL across
    // modal reopens — including for a different route. Remove them explicitly.
    document.getElementById('share-link-url-once')?.remove();
    document.getElementById('share-link-create-form')?.remove();
    list.textContent = '';
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var links = (data && data.links) || [];
      if (!links.length) {
        list.appendChild(el('div', { class: 'form-hint', text: shareT('route_auth.share_none', 'No share links yet.') }));
        return;
      }
      links.forEach(function (link) {
        list.appendChild(renderShareLinkRow(routeId, link));
      });
    } catch (err) {
      list.appendChild(el('div', { class: 'form-hint', text: err.message }));
    }
  }

  function renderShareLinkRow(routeId, link) {
    var meta = [];
    if (link.label) meta.push(link.label);
    meta.push(formatShareExpiry(link.expires_at));
    meta.push(link.one_time ? shareT('route_auth.share_one_time', 'One-time') : shareT('route_auth.share_reusable', 'Reusable'));
    meta.push(shareT('route_auth.share_redeemed', 'Redeemed') + ': ' + (link.redeemed_count || 0));

    var info = el('div', { style: 'flex:1;min-width:0' }, [
      el('div', { style: 'font-size:12px;color:var(--text-2)', text: meta.join(' · ') }),
    ]);
    var revokeBtn = el('button', {
      type: 'button',
      class: 'btn btn-sm',
      text: shareT('route_auth.share_revoke', 'Revoke'),
    });
    revokeBtn.addEventListener('click', function () {
      revokeShareLink(routeId, link.id);
    });
    return el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
    }, [info, revokeBtn]);
  }

  async function revokeShareLink(routeId, linkId) {
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links/' + linkId, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      loadShareLinks(routeId);
    } catch (err) {
      if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
    }
  }

  function showShareCreateForm(routeId) {
    var list = document.getElementById('share-links-list');
    if (!list) return;
    if (document.getElementById('share-link-create-form')) return;

    var expirySelect = el('select', { id: 'share-link-expiry', class: 'form-select', style: 'flex:1' }, [
      el('option', { value: '1', text: '1 h' }),
      el('option', { value: '24', text: '24 h' }),
      el('option', { value: '168', text: '168 h' }),
    ]);
    expirySelect.value = '24';

    var oneTime = el('input', { type: 'checkbox', id: 'share-link-one-time' });
    var oneTimeLabel = el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px' }, [
      oneTime,
      shareT('route_auth.share_one_time', 'One-time'),
    ]);

    var labelInput = el('input', {
      type: 'text',
      id: 'share-link-label',
      class: 'form-input',
      maxlength: '120',
      placeholder: shareT('route_auth.share_label', 'Label (optional)'),
      style: 'flex:1',
    });

    var submitBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: shareT('route_auth.share_create', 'Create share link') });
    submitBtn.addEventListener('click', function () {
      createShareLink(routeId, {
        expiresInHours: Number(expirySelect.value),
        oneTime: oneTime.checked,
        label: labelInput.value.trim(),
      }, false, form);
    });

    var form = el('div', {
      id: 'share-link-create-form',
      style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px',
    }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, [expirySelect, oneTimeLabel]),
      labelInput,
      submitBtn,
    ]);
    list.parentNode.insertBefore(form, list.nextSibling);
  }

  async function createShareLink(routeId, body, confirmGate, form) {
    var payload = {
      expiresInHours: body.expiresInHours,
      oneTime: body.oneTime,
    };
    if (body.label) payload.label = body.label;
    if (confirmGate) payload.confirmGate = true;
    try {
      var res = await shareFetch('/api/v1/routes/' + routeId + '/share-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        var conflict = await res.json().catch(function () { return {}; });
        if (conflict && conflict.error === 'needs_gate_confirm') {
          if (window.confirm(shareT('route_auth.share_gate_warning', 'This route is currently public. A share link makes it reachable only via share links.'))) {
            return createShareLink(routeId, body, true, form);
          }
          return;
        }
        throw new Error(shareErrMsg((conflict && conflict.error) || 'HTTP 409'));
      }
      if (res.status !== 201) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(shareErrMsg((errBody && errBody.error) || ('HTTP ' + res.status)));
      }
      var data = await res.json();
      if (form && form.parentNode) form.parentNode.removeChild(form);
      // Refresh the list FIRST — loadShareLinks() removes any #share-link-url-once
      // box at its start, so it must run before we show the new one (otherwise the
      // freshly generated URL would be wiped immediately).
      await loadShareLinks(routeId);
      showShareUrlOnce(routeId, data.url);
    } catch (err) {
      if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
    }
  }

  function showShareUrlOnce(routeId, url) {
    var list = document.getElementById('share-links-list');
    if (!list) return;
    var existing = document.getElementById('share-link-url-once');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var urlField = el('input', {
      type: 'text',
      class: 'form-input',
      readonly: 'readonly',
      style: 'flex:1;font-family:var(--font-mono)',
    });
    urlField.value = url || '';

    function svgEl(name, attrs) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', name);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }
    function copyIcon() {
      var s = svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      s.appendChild(svgEl('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }));
      s.appendChild(svgEl('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }));
      return s;
    }
    function checkIcon() {
      var s = svgEl('svg', { width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--green)', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      s.appendChild(svgEl('path', { d: 'M20 6 9 17l-5-5' }));
      return s;
    }

    var copyLabel = shareT('common.copy', 'Copy');
    var copyBtn = el('button', { type: 'button', class: 'btn btn-sm', title: copyLabel, 'aria-label': copyLabel, style: 'display:flex;align-items:center;justify-content:center;padding:8px 10px' });
    copyBtn.appendChild(copyIcon());
    copyBtn.addEventListener('click', function () {
      urlField.focus();
      urlField.select();
      var showCopied = function () {
        copyBtn.textContent = '';
        copyBtn.appendChild(checkIcon());
        setTimeout(function () { copyBtn.textContent = ''; copyBtn.appendChild(copyIcon()); }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(urlField.value).then(showCopied).catch(function () {});
      } else {
        try { document.execCommand('copy'); showCopied(); } catch (e) { /* clipboard unavailable */ }
      }
    });

    var box = el('div', {
      id: 'share-link-url-once',
      style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm)',
    }, [
      el('div', { style: 'display:flex;gap:8px;align-items:center' }, [urlField, copyBtn]),
      el('div', { class: 'form-hint', text: shareT('route_auth.share_copy_warning', "Anyone with this link gets in. Copy it now — it won't be shown again.") }),
    ]);
    list.parentNode.insertBefore(box, list.nextSibling);
  }

  var shareCreateBtn = document.getElementById('share-link-create');
  if (shareCreateBtn) {
    shareCreateBtn.addEventListener('click', function () {
      var section = document.getElementById('share-links-section');
      var routeId = section && section.getAttribute('data-route-id');
      if (routeId) showShareCreateForm(Number(routeId));
    });
  }

  // ─── Access windows (scheduled access control) ───────────────────────────
  // Mirrors the share-links subsection: a state badge, a rule list and an
  // add-rule form, all driven by /api/v1/routes/:id/access-rules. Safe-DOM only
  // (el()/textContent — never innerHTML); CSRF via shareFetch().

  function accessFmtBounds(rule) {
    var parts = [];
    if (rule.valid_from) parts.push(shareT('access.valid_from', 'Valid from') + ': ' + rule.valid_from);
    if (rule.valid_until) parts.push(shareT('access.valid_until', 'Valid until') + ': ' + rule.valid_until);
    return parts.join(' · ');
  }

  function renderAccessRuleRow(targetId, rule) {
    var isBlock = rule.mode === 'block';
    var chip = el('span', {
      style: 'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'
        + (isBlock
          ? 'background:rgba(229,72,77,0.15);color:var(--red,#e5484d)'
          : 'background:rgba(48,164,108,0.15);color:var(--green,#30a46c)'),
      text: isBlock ? shareT('access.mode_block', 'Block') : shareT('access.mode_allow', 'Allow'),
    });

    var lines = [el('div', { style: 'font-size:12px;font-family:var(--font-mono);color:var(--text-1)', text: rule.schedule || '' })];
    var bounds = accessFmtBounds(rule);
    if (bounds) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: bounds }));
    if (rule.label) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: rule.label }));

    var info = el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px' }, lines);

    var delBtn = el('button', {
      type: 'button',
      class: 'btn btn-sm',
      text: shareT('access.delete', 'Delete rule'),
    });
    delBtn.addEventListener('click', function () {
      deleteAccessRule(targetId, rule.id);
    });

    return el('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
    }, [chip, info, delBtn]);
  }

  function renderAccessStateBadge(state) {
    var badge = document.getElementById('access-state-badge');
    if (!badge) return;
    badge.textContent = '';
    if (state === 'denied') {
      badge.appendChild(document.createTextNode('🔴 ' + shareT('access.state_blocked', 'Blocked now')));
      badge.style.color = 'var(--red,#e5484d)';
    } else {
      badge.appendChild(document.createTextNode('🟢 ' + shareT('access.state_allowed', 'Allowed now')));
      badge.style.color = 'var(--green,#30a46c)';
    }
  }

  async function loadAccessRules(targetId) {
    var list = document.getElementById('access-rules-list');
    if (!list) return;
    list.textContent = '';
    var badge = document.getElementById('access-state-badge');
    if (badge) badge.textContent = '';
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      renderAccessStateBadge(data && data.state);
      var rules = (data && data.rules) || [];
      if (!rules.length) {
        list.appendChild(el('div', { class: 'form-hint', text: shareT('access.title', 'Access windows') + ' —' }));
      } else {
        rules.forEach(function (rule) {
          list.appendChild(renderAccessRuleRow(targetId, rule));
        });
      }
      renderAccessAddForm(targetId);
    } catch (err) {
      list.appendChild(el('div', { class: 'form-hint', text: err.message }));
    }
  }

  // Week order (Mo..So). Used to map day codes to indices for contiguity
  // detection when building the server-side schedule string.
  var ACCESS_DAY_CODES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Builds the legacy `Mo-Fr 09:00-17:00` schedule string the server parser
  // still expects. `dayCodes` is a subset of ACCESS_DAY_CODES in week order.
  // Contiguous (length > 1) → range; single → one day; non-contiguous → list.
  function buildScheduleString(dayCodes, from, to) {
    if (!dayCodes || !dayCodes.length) return '';
    var idx = dayCodes.map(function (d) { return ACCESS_DAY_CODES.indexOf(d); });
    var first = idx[0];
    var last = idx[idx.length - 1];
    var contiguous = (last - first) === (idx.length - 1);
    if (dayCodes.length > 1 && contiguous) {
      return ACCESS_DAY_CODES[first] + '-' + ACCESS_DAY_CODES[last] + ' ' + from + '-' + to;
    }
    if (dayCodes.length === 1) {
      return dayCodes[0] + ' ' + from + '-' + to;
    }
    return dayCodes.map(function (d) { return d + ' ' + from + '-' + to; }).join('; ');
  }

  // Shared access-rule builder used by BOTH the edit modal and the create
  // wizard. Renders labelled controls (mode toggle, day multi-select, time +
  // date pickers, optional label), validates, builds the schedule string and
  // invokes onAdd({ mode, schedule, valid_from, valid_until, label }). On a
  // successful add (onAdd returns a non-false value) the day/time/date/label
  // controls reset. Safe-DOM only (el()/textContent — never innerHTML).
  function renderAccessRuleForm(container, onAdd) {
    if (!container) return;
    container.textContent = '';

    function lbl(key, fallback) {
      return el('label', { class: 'form-label' }, [shareT(key, fallback)]);
    }
    function lblOpt(key, fallback) {
      return el('label', { class: 'form-label' }, [
        shareT(key, fallback) + ' (' + shareT('access.optional', 'optional') + ')',
      ]);
    }

    // Mode toggle (single-select).
    var selectedMode = 'allow';
    var modeAllowBtn = el('button', { type: 'button', class: 'toggle-btn on', text: shareT('access.mode_allow', 'Allow') });
    var modeBlockBtn = el('button', { type: 'button', class: 'toggle-btn', text: shareT('access.mode_block', 'Block') });
    function selectMode(mode) {
      selectedMode = mode;
      modeAllowBtn.className = 'toggle-btn' + (mode === 'allow' ? ' on' : '');
      modeBlockBtn.className = 'toggle-btn' + (mode === 'block' ? ' on' : '');
    }
    modeAllowBtn.addEventListener('click', function () { selectMode('allow'); });
    modeBlockBtn.addEventListener('click', function () { selectMode('block'); });
    var modeGroup = el('div', { class: 'toggle-group' }, [modeAllowBtn, modeBlockBtn]);

    // Day multi-select toggles (Mo..So).
    var dayBtns = ACCESS_DAY_CODES.map(function (code) {
      var btn = el('button', { type: 'button', class: 'toggle-btn', text: code });
      btn.dataset.day = code;
      btn.addEventListener('click', function () {
        if (btn.className.indexOf('on') >= 0) btn.className = 'toggle-btn';
        else btn.className = 'toggle-btn on';
      });
      return btn;
    });
    var dayGroup = el('div', { class: 'toggle-group' }, dayBtns);
    function selectedDays() {
      return dayBtns.filter(function (b) { return b.className.indexOf('on') >= 0; })
        .map(function (b) { return b.dataset.day; });
    }

    // Time pickers.
    var fromTime = el('input', { type: 'time', class: 'form-input' });
    var toTime = el('input', { type: 'time', class: 'form-input' });

    // Optional date bounds.
    var fromDate = el('input', { type: 'date', class: 'form-input' });
    var untilDate = el('input', { type: 'date', class: 'form-input' });

    // Optional label.
    var labelInput = el('input', { type: 'text', class: 'form-input', maxlength: '120' });

    var errBox = el('small', { class: 'form-hint', style: 'display:none;color:var(--red,#e5484d)' });
    var addBtn = el('button', { type: 'button', class: 'btn btn-sm', text: shareT('access.add_rule', 'Add rule') });

    addBtn.addEventListener('click', function () {
      errBox.style.display = 'none';
      errBox.textContent = '';
      var days = selectedDays();
      if (!days.length) {
        errBox.textContent = shareT('access.err_days', 'Select at least one day');
        errBox.style.display = '';
        return;
      }
      var von = fromTime.value;
      var bis = toTime.value;
      if (!von || !bis) {
        errBox.textContent = shareT('access.err_time', 'Select a from and to time');
        errBox.style.display = '';
        return;
      }
      var schedule = buildScheduleString(days, von, bis);
      var ok = onAdd({
        mode: selectedMode,
        schedule: schedule,
        valid_from: fromDate.value || null,
        valid_until: untilDate.value || null,
        label: labelInput.value.trim() || null,
      });
      // onAdd may be async/POST-based (returns undefined) or sync (returns
      // truthy). Only block reset on an explicit false.
      if (ok === false) return;
      dayBtns.forEach(function (b) { b.className = 'toggle-btn'; });
      fromTime.value = '';
      toTime.value = '';
      fromDate.value = '';
      untilDate.value = '';
      labelInput.value = '';
    });

    container.appendChild(el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:8px' }, [
      el('div', { class: 'form-group' }, [lbl('access.mode', 'Mode'), modeGroup]),
      el('div', { class: 'form-group' }, [lbl('access.days', 'Days'), dayGroup]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [lbl('access.time_from', 'From'), fromTime]),
        el('div', { class: 'form-group' }, [lbl('access.time_to', 'To'), toTime]),
      ]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [lblOpt('access.valid_from', 'Valid from'), fromDate]),
        el('div', { class: 'form-group' }, [lblOpt('access.valid_until', 'Valid until'), untilDate]),
      ]),
      el('div', { class: 'form-group' }, [lblOpt('access.label', 'Label'), labelInput]),
      el('div', {}, [addBtn]),
      errBox,
    ]));
  }

  function renderAccessAddForm(targetId) {
    var formWrap = document.getElementById('access-rules-form');
    if (!formWrap) return;
    var errBox = el('div', { class: 'form-error', style: 'display:none' });
    renderAccessRuleForm(formWrap, function (rule) {
      // addAccessRule POSTs then re-renders the whole form via loadAccessRules
      // on success (which resets it anyway), and keeps inputs on error. Return
      // false so the builder's own reset never fires for the edit modal.
      addAccessRule(targetId, rule, errBox);
      return false;
    });
    formWrap.appendChild(errBox);
  }

  async function addAccessRule(targetId, body, errBox) {
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    var payload = { mode: body.mode, schedule: body.schedule };
    if (body.valid_from) payload.valid_from = body.valid_from;
    if (body.valid_until) payload.valid_until = body.valid_until;
    if (body.label) payload.label = body.label;
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        await loadAccessRules(targetId);
        return;
      }
      var errData = await res.json().catch(function () { return {}; });
      var msg = (errData && errData.error) || ('HTTP ' + res.status);
      if (errBox) { errBox.textContent = msg; errBox.style.display = ''; }
      else if (typeof window.showToast === 'function') window.showToast(msg, 'error');
    } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.style.display = ''; }
      else if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
    }
  }

  async function deleteAccessRule(targetId, ruleId) {
    try {
      var res = await shareFetch('/api/v1/routes/' + targetId + '/access-rules/' + ruleId, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadAccessRules(targetId);
    } catch (err) {
      if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
    }
  }

  // ─── Access windows: create-route modal (buffer then POST) ───────────────
  // A new route has no id until created, so access rules are buffered
  // client-side here and POSTed after the route exists (see create-submit).
  var createAccessRules = [];

  function renderCreateAccessRules() {
    var list = document.getElementById('create-access-rules-list');
    if (!list) return;
    list.textContent = '';
    createAccessRules.forEach(function (rule, idx) {
      var isBlock = rule.mode === 'block';
      var chip = el('span', {
        style: 'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'
          + (isBlock
            ? 'background:rgba(229,72,77,0.15);color:var(--red,#e5484d)'
            : 'background:rgba(48,164,108,0.15);color:var(--green,#30a46c)'),
        text: isBlock ? shareT('access.mode_block', 'Block') : shareT('access.mode_allow', 'Allow'),
      });

      var lines = [el('div', { style: 'font-size:12px;font-family:var(--font-mono);color:var(--text-1)', text: rule.schedule || '' })];
      var bounds = accessFmtBounds(rule);
      if (bounds) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: bounds }));
      if (rule.label) lines.push(el('div', { style: 'font-size:11px;color:var(--text-2)', text: rule.label }));

      var info = el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px' }, lines);

      var delBtn = el('button', { type: 'button', class: 'btn btn-sm', title: shareT('access.delete', 'Delete rule'), text: '✕' });
      delBtn.addEventListener('click', function () {
        createAccessRules.splice(idx, 1);
        renderCreateAccessRules();
      });

      list.appendChild(el('div', {
        style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
      }, [chip, info, delBtn]));
    });
  }

  // The create-route access form is rendered by renderAccessRuleForm() from
  // openRouteWizard(); rules are buffered in createAccessRules and POSTed after
  // the route is created. No standalone add handler is needed here anymore.

  // HTTP-class ports → suggest an HTTP route (https for 443/8443); else L4. (spec §9.1, per-port.)
  var SUGGEST_HTTP_PORTS = [80, 443, 8080, 8443, 8000, 8081, 3000, 5000, 8096, 32400, 9000, 8123, 631];
  function classifyPort(port) {
    var isHttp = SUGGEST_HTTP_PORTS.indexOf(port) !== -1;
    return { routeType: isHttp ? 'http' : 'l4', https: port === 443 || port === 8443 };
  }
  function suggestDomainFrom(hostname) {
    if (!hostname) return '';
    return String(hostname).replace(/\.local\.?$/i, '').replace(/[^a-zA-Z0-9.-]/g, '').toLowerCase();
  }

  function initSuggestPicker() {
    var box = document.getElementById('create-route-suggest');
    if (!box) return; // feature not licensed → block not rendered
    var gwSel = document.getElementById('create-route-gateway-peer');
    var tkSel = document.getElementById('create-route-target-kind');
    var btn = document.getElementById('create-route-scan-btn');
    var statusEl = document.getElementById('create-route-suggest-status');
    var listEl = document.getElementById('create-route-suggest-list');
    var T = function (k, d) { return (window.GC && GC.t && GC.t[k]) || d; };
    var capable = {}; // peerId -> reports lan_discovery (telemetry)
    var enabled = {}; // peerId -> discovery_enabled (settings)

    // §9.1: show only when target=gateway AND the gateway reports capability AND
    // discovery is enabled on it. Otherwise show a hint and hide the scan button.
    function refreshCapability() {
      var pid = gwSel && gwSel.value;
      if (!(tkSel && tkSel.value === 'gateway') || !pid) { box.style.display = 'none'; return; }
      box.style.display = '';
      if (capable[pid] !== true) { statusEl.textContent = T('routes.suggested.unavailable', ''); btn.style.display = 'none'; return; }
      if (enabled[pid] !== true) { statusEl.textContent = T('gateways.discovery.not_enabled', ''); btn.style.display = 'none'; return; }
      btn.style.display = ''; statusEl.textContent = '';
    }
    // Load gateway capability + enabled-state once (from the fleet endpoint).
    fetch('/api/v1/gateways', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      (d.gateways || []).forEach(function (g) {
        var tel = (g.health && g.health.telemetry) || {};
        capable[String(g.peer_id)] = tel.lan_discovery === true;
        enabled[String(g.peer_id)] = !!(g.discovery && g.discovery.enabled);
      });
      refreshCapability();
    }).catch(function () {});
    if (gwSel) gwSel.addEventListener('change', refreshCapability);
    if (tkSel) tkSel.addEventListener('change', refreshCapability);

    function ageNote(updatedAt) {
      if (!updatedAt) return '';
      var mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
      return T('gateways.discovery.last_seen_min', 'results from {n} min ago').replace('{n}', mins);
    }

    function renderDevices(devices, updatedAt) {
      listEl.replaceChildren();
      if (!devices || !devices.length) { statusEl.textContent = T('gateways.discovery.no_devices', ''); return; }
      statusEl.textContent = ageNote(updatedAt);
      devices.forEach(function (dev) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)';
        var info = document.createElement('div');
        var name = document.createElement('div'); name.style.fontSize = '12px';
        name.textContent = (dev.hostname || dev.ip) + ' · ' + dev.ip; // textContent = safe (untrusted LAN)
        var ports = document.createElement('div'); ports.style.cssText = 'font-size:11px;color:var(--text-2)';
        ports.textContent = (dev.ports || []).map(function (p) { return p.port; }).join(', ');
        info.appendChild(name); info.appendChild(ports);
        var adopt = document.createElement('button');
        adopt.type = 'button'; adopt.className = 'btn btn-secondary'; adopt.style.fontSize = '11px';
        adopt.textContent = T('routes.suggested.adopt', 'Use');
        adopt.addEventListener('click', function () { adoptDevice(dev); });
        row.appendChild(info); row.appendChild(adopt);
        listEl.appendChild(row);
      });
    }

    function adoptDevice(dev) {
      var firstPort = (dev.ports && dev.ports[0] && dev.ports[0].port) || '';
      var cls = firstPort ? classifyPort(firstPort) : { routeType: 'http', https: false };
      var hostI = document.getElementById('create-route-lan-host'); if (hostI) hostI.value = dev.ip;
      var portI = document.getElementById('create-route-lan-port'); if (portI && firstPort) portI.value = firstPort;
      // Switch the modal to HTTP/L4 by setting #route-type and calling the modal's
      // own field-visibility refresh (a 'change' event on the hidden input is a no-op).
      var rt = document.getElementById('route-type');
      if (rt) { rt.value = cls.routeType; if (typeof updateFieldVisibility === 'function') updateFieldVisibility(); }
      var _dfBaseSel = document.getElementById('create-route-base-domain'); var _dfFt = document.getElementById('create-route-domain-freetext'); if (_dfFt && _dfBaseSel && !_dfFt.value) { _dfBaseSel.value = ''; _dfFt.value = suggestDomainFrom(dev.hostname); _dfBaseSel.dispatchEvent(new Event('change')); }
      if (dev.mac) { var wolCb = document.getElementById('create-route-wol-enabled'); var macI = document.getElementById('create-route-wol-mac');
        if (wolCb) { wolCb.checked = true; wolCb.dispatchEvent(new Event('change')); } if (macI) macI.value = dev.mac; }
    }

    function loadCached(pid) {
      fetch('/api/v1/gateways/' + pid + '/discovered', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) renderDevices(d.devices, d.updated_at); }).catch(function () {});
    }

    btn.addEventListener('click', function () {
      var pid = gwSel.value; if (!pid) return;
      statusEl.textContent = T('gateways.discovery.scanning', 'Scanning…');
      api.post('/api/v1/gateways/' + pid + '/discover', {})
        .then(function () { loadCached(pid); })
        .catch(function () { statusEl.textContent = T('gateways.discovery.scan_failed', 'Scan failed'); });
    });
    // When a gateway is (re)selected, show its cached results without auto-scanning.
    if (gwSel) gwSel.addEventListener('change', function () { if (gwSel.value && capable[gwSel.value] && enabled[gwSel.value]) loadCached(gwSel.value); });

    // Live results via SSE (filtered by the selected gateway).
    document.addEventListener('gc:gateway_discovery', function (e) {
      var p = e.detail || {};
      if (gwSel && String(p.peer_id) === String(gwSel.value)) {
        renderDevices(p.devices, Date.now());
        if (p.done && p.timed_out) statusEl.textContent = T('gateways.discovery.timed_out', '');
      }
    });
  }
  initSuggestPicker();
})();

(() => {
  document.querySelectorAll('select[name="target_kind"]').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const kind = e.target.value;
      const poolSel = sel.closest('form')?.querySelector('select[data-show-when-target-kind="pool"]');
      if (poolSel) poolSel.style.display = kind === 'pool' ? '' : 'none';
    });
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Printer-Preset Setup Wizard (Task 9)
// A self-contained 4-step wizard that assembles a printer preset and POSTs it to
// /api/v1/printer-presets. Styling uses .style.cssText only (no runtime <style>
// injection — CSP styleSrcElem blocks nonce-less tags). Field hints are always
// APPENDED to their wrapper, never used as an insertBefore reference (the egress
// NotFoundError bug). All user-facing text comes from window.GC.t.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var GC = window.GC || {};
  var feats = GC.features || {};
  function T(k, d) { return (GC.t && GC.t[k]) || d; }
  // License limits use -1 for "unlimited"; 0 means "none". A bare `> 0` check
  // (as the spec literally phrased it) would wrongly lock out unlimited Pro tiers.
  function limitAllows(v) { return v === -1 || (typeof v === 'number' && v > 0); }
  var canPrint = !!feats.gateway_tcp_routing && limitAllows(feats.l4_routes);
  var canEws = limitAllows(feats.http_routes);
  var canScan = feats.gateway_scan_egress === true;

  var openBtn = document.getElementById('open-printer-preset');
  var overlay = document.getElementById('printer-preset-overlay');
  if (!openBtn || !overlay) return; // page without the wizard markup

  // R1-G2: entry threshold is printing (TCP routing + at least one L4 route slot).
  openBtn.style.display = canPrint ? '' : 'none';
  if (!canPrint) return;

  var body = document.getElementById('printer-preset-body');
  var errorBox = document.getElementById('printer-preset-error');
  var footer = document.getElementById('printer-preset-footer');
  var backBtn = document.getElementById('printer-preset-back');
  var nextBtn = document.getElementById('printer-preset-next');
  var closeBtn = document.getElementById('printer-preset-close');
  var pills = Array.prototype.slice.call(document.querySelectorAll('#printer-preset-steps [data-pstep]'));
  var _discListener = null;
  var _discTimer = null;
  function _clearDisc() {
    if (_discListener) { document.removeEventListener('gc:gateway_discovery', _discListener); _discListener = null; }
    if (_discTimer) { clearTimeout(_discTimer); _discTimer = null; }
  }

  var LABEL_CSS = 'font-size:11px;font-family:var(--font-mono);color:var(--text-2);text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:6px;font-weight:600';
  var INPUT_CSS = 'width:100%;padding:8px 12px';
  var HINT_CSS = 'display:block;font-size:11px;color:var(--text-3);margin-top:6px';
  var LOCK_HINT_CSS = 'display:block;font-size:11px;color:var(--amber, var(--text-3));margin-top:6px';
  var ROW_CSS = 'margin-bottom:14px';

  var state = null;
  function resetState() {
    state = {
      step: 1,
      gateways: [],
      routes: [],
      near_peer_id: null,
      printer_ip: '',
      name: '',
      ports: { 9100: true, 631: false },
      ewsOn: false,
      ewsDomain: '',
      scanOn: false,
      vip: '',
      vipPrefix: 24,
      scanTargetMode: 'new',
      nasIp: '',
      nasPeerId: null,
      routeId: null,
    };
  }

  function elx(tag, css, props) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else n.setAttribute(k, props[k]);
    });
    return n;
  }

  // Build a labelled field. The optional hint is ALWAYS appended last — never used
  // as an insertBefore reference (guarded by the static test).
  function field(labelText, inputNode, hintNode) {
    var wrap = elx('div', ROW_CSS);
    var lab = elx('label', LABEL_CSS, { text: labelText });
    wrap.appendChild(lab);
    wrap.appendChild(inputNode);
    if (hintNode) wrap.appendChild(hintNode);
    return wrap;
  }

  function checkboxRow(labelText, checked, disabled, onChange) {
    var wrap = elx('label', 'display:flex;align-items:center;gap:8px;cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';margin-bottom:8px' + (disabled ? ';opacity:0.55' : ''));
    var cb = elx('input', 'accent-color:var(--accent)');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.disabled = !!disabled;
    cb.addEventListener('change', function () { onChange(cb.checked); });
    var span = elx('span', 'font-size:13px', { text: labelText });
    wrap.appendChild(cb);
    wrap.appendChild(span);
    return { row: wrap, cb: cb };
  }

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? '' : 'none';
  }

  function setPills(step) {
    pills.forEach(function (p) {
      p.classList.toggle('on', String(p.getAttribute('data-pstep')) === String(step));
    });
  }

  // ── Step 1: printer + gateway ──────────────────────────────────────────────
  function renderStep1() {
    body.replaceChildren();
    var gwSel = elx('select', INPUT_CSS);
    state.gateways.forEach(function (g) {
      var o = document.createElement('option');
      o.value = String(g.peer_id);
      o.textContent = (g.name || g.hostname || ('#' + g.peer_id));
      if (String(g.peer_id) === String(state.near_peer_id)) o.selected = true;
      gwSel.appendChild(o);
    });
    if (!state.near_peer_id && state.gateways.length) state.near_peer_id = state.gateways[0].peer_id;
    gwSel.addEventListener('change', function () { state.near_peer_id = parseInt(gwSel.value, 10); });
    body.appendChild(field(T('printer_preset.gateway', 'Gateway'), gwSel));

    var ipIn = elx('input', INPUT_CSS);
    ipIn.type = 'text'; ipIn.value = state.printer_ip; ipIn.placeholder = '192.168.1.50';
    ipIn.addEventListener('input', function () { state.printer_ip = ipIn.value.trim(); });
    body.appendChild(field(T('printer_preset.printer_ip', 'Printer IP'), ipIn));

    var nameIn = elx('input', INPUT_CSS);
    nameIn.type = 'text'; nameIn.value = state.name; nameIn.maxLength = 120;
    nameIn.addEventListener('input', function () { state.name = nameIn.value; });
    body.appendChild(field(T('printer_preset.name', 'Name'), nameIn));

    // "Use from discovery": capability/enabled-aware. Actively triggers a LAN
    // scan (POST .../discover) then polls the cache, instead of only reading the
    // in-memory cache and mislabelling an empty result as "no discovery support".
    var adoptBtn = elx('button', 'padding:7px 12px;border:1px dashed var(--border-hi, var(--border));border-radius:var(--radius-xs);background:transparent;color:var(--text-2);font-size:12px;cursor:pointer');
    adoptBtn.type = 'button';
    adoptBtn.textContent = T('printer_preset.adopt', 'Use from discovery');
    var adoptList = elx('div', 'margin-top:8px');
    function adoptMsg(key, fallback) {
      adoptList.replaceChildren();
      adoptList.appendChild(elx('div', 'font-size:11px;color:var(--text-3)', { text: T(key, fallback) }));
    }
    function renderAdoptDevices(devices) {
      adoptList.replaceChildren();
      if (!devices.length) { adoptMsg('printer_preset.adopt_none', 'No devices found on the LAN.'); return; }
      devices.forEach(function (dev) {
        var b = elx('button', 'display:block;width:100%;text-align:left;padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius-xs);background:transparent;color:var(--text-1);font-size:12px;cursor:pointer;margin-bottom:4px');
        b.type = 'button';
        b.textContent = (dev.hostname ? dev.hostname + ' · ' : '') + dev.ip; // textContent = safe (untrusted LAN)
        b.addEventListener('click', function () {
          state.printer_ip = dev.ip; ipIn.value = dev.ip;
          if (!state.name && dev.hostname) { state.name = dev.hostname; nameIn.value = dev.hostname; }
          adoptList.replaceChildren();
        });
        adoptList.appendChild(b);
      });
    }
    function startScan(pid) {
      adoptBtn.disabled = true;
      adoptMsg('printer_preset.adopt_scanning', 'Scanning the LAN… (up to 45s)');
      // IDS hint (spec §4) — appended (CSP: no insertBefore).
      adoptList.appendChild(elx('small', 'display:block;margin-top:4px;font-size:11px;color:var(--text-3)', { text: T('printer_preset.adopt_active_hint', 'Triggers an active port scan — may set off a LAN intrusion-detection system.') }));
      _clearDisc(); // clears any prior listener AND prior timer (no cross-scan race)
      var settled = false;
      function finish(fn) { if (settled) return; settled = true; _clearDisc(); adoptBtn.disabled = false; fn(); }
      _discListener = function (e) {
        var p = e.detail || {};
        if (String(p.peer_id) !== String(pid)) return;   // gateway filter
        if (state.step !== 1) return;                     // only step 1
        if (p.devices && p.devices.length) { finish(function () { renderAdoptDevices(p.devices); }); }
        else if (p.done) { finish(function () { adoptMsg('printer_preset.adopt_none', 'No devices found on the LAN.'); }); }
      };
      document.addEventListener('gc:gateway_discovery', _discListener);
      // Fallback ~ server terminal grace (SCAN_TIMEOUT 45s + 15s + buffer).
      _discTimer = setTimeout(function () {
        finish(function () {
          window.api.get('/api/v1/gateways/' + pid + '/discovered').then(function (d) {
            var devs = (d && d.devices) || [];
            if (devs.length) renderAdoptDevices(devs); else adoptMsg('printer_preset.adopt_none', 'No devices found on the LAN.');
          }).catch(function () { adoptMsg('printer_preset.adopt_none', 'No devices found on the LAN.'); });
        });
      }, 61000);
      window.api.post('/api/v1/gateways/' + pid + '/discover', { active_scan: true }).catch(function (err) {
        var code = (err && err.data && err.data.error) || '';
        if (code === 'scan_in_progress') return; // a scan is already running — keep our listener; results/done still arrive
        finish(function () {
          if (code === 'no_subnet') adoptMsg('printer_preset.adopt_none', 'No devices found on the LAN.');
          else adoptMsg('printer_preset.adopt_failed', 'LAN discovery scan failed.');
        });
      });
    }
    function enableDiscovery(pid, tel) {
      adoptList.replaceChildren();
      adoptList.appendChild(elx('div', 'font-size:11px;color:var(--text-3);margin-bottom:6px', { text: T('printer_preset.adopt_not_enabled', "Enable LAN discovery in this gateway's settings first.") }));
      var enableBtn = elx('button', 'padding:5px 10px;border:1px solid var(--accent);border-radius:var(--radius-xs);background:transparent;color:var(--accent);font-size:11px;cursor:pointer');
      enableBtn.type = 'button';
      enableBtn.textContent = T('printer_preset.adopt_enable', 'Enable discovery here');
      enableBtn.addEventListener('click', function () {
        enableBtn.disabled = true;
        var subs = (tel.lan_subnets || []);
        var primary = subs.filter(function (s) { return s.primary; })[0] || subs[0] || {};
        window.api.put('/api/v1/gateways/' + pid + '/discovery-settings', {
          enabled: true,
          subnets: primary.cidr ? [primary.cidr] : [],
          category_mode: 'include',
          categories: (tel.lan_discovery_categories || []).map(function (c) { return c.key; }),
        }).then(function (res) {
          if (res && res.ok === false) { adoptMsg('printer_preset.adopt_enable_failed', "Could not enable discovery — open this gateway's settings."); return; }
          var gw = state.gateways.filter(function (g) { return String(g.peer_id) === String(pid); })[0];
          if (gw) { gw.discovery = gw.discovery || {}; gw.discovery.enabled = true; }
          startScan(pid);
        }).catch(function () { adoptMsg('printer_preset.adopt_enable_failed', "Could not enable discovery — open this gateway's settings."); });
      });
      adoptList.appendChild(enableBtn);
    }
    adoptBtn.addEventListener('click', function () {
      var pid = state.near_peer_id;
      if (!pid) return;
      var gw = state.gateways.filter(function (g) { return String(g.peer_id) === String(pid); })[0];
      var tel = (gw && gw.health && gw.health.telemetry) || {};
      if (tel.lan_discovery !== true) { adoptMsg('printer_preset.adopt_unsupported', 'This gateway does not report LAN discovery support.'); return; }
      if (!(gw && gw.discovery && gw.discovery.enabled)) { enableDiscovery(pid, tel); return; }
      startScan(pid);
    });
    var adoptWrap = elx('div', ROW_CSS);
    adoptWrap.appendChild(adoptBtn);
    adoptWrap.appendChild(adoptList);
    body.appendChild(adoptWrap);
  }

  // ── Step 2: printing (ports + EWS) ─────────────────────────────────────────
  function renderStep2() {
    body.replaceChildren();
    var p9100 = checkboxRow(T('printer_preset.port_9100', 'Raw/JetDirect (9100)'), state.ports[9100], false, function (v) { state.ports[9100] = v; });
    var p631 = checkboxRow(T('printer_preset.port_631', 'IPP (631)'), state.ports[631], false, function (v) { state.ports[631] = v; });
    var portsWrap = elx('div', ROW_CSS);
    portsWrap.appendChild(p9100.row);
    portsWrap.appendChild(p631.row);
    body.appendChild(portsWrap);

    // EWS — license-gated (R1-G2). Disabled + hint when HTTP routes are not allowed.
    var ewsBox = checkboxRow(T('printer_preset.ews', 'Make web interface (EWS) reachable'), state.ewsOn && canEws, !canEws, function (v) {
      state.ewsOn = v; domainWrap.style.display = v ? '' : 'none';
    });
    var ewsWrap = elx('div', ROW_CSS);
    ewsWrap.appendChild(ewsBox.row);
    if (!canEws) {
      state.ewsOn = false;
      ewsWrap.appendChild(elx('small', LOCK_HINT_CSS, { text: T('printer_preset.ews_locked', 'Web interface exposure requires a Pro license.') }));
    }
    body.appendChild(ewsWrap);

    var domIn = elx('input', INPUT_CSS);
    domIn.type = 'text'; domIn.value = state.ewsDomain; domIn.placeholder = 'printer.example.com'; domIn.maxLength = 253;
    domIn.addEventListener('input', function () { state.ewsDomain = domIn.value.trim().toLowerCase(); });
    var domainWrap = field(T('printer_preset.ews_domain', 'EWS domain'), domIn);
    domainWrap.style.display = (canEws && state.ewsOn) ? '' : 'none';
    body.appendChild(domainWrap);
  }

  // ── Step 3: scanning (scan egress) ─────────────────────────────────────────
  function renderStep3() {
    body.replaceChildren();
    var scanBox = checkboxRow(T('printer_preset.scan', 'Set up scan-to-folder'), state.scanOn && canScan, !canScan, function (v) {
      state.scanOn = v; detailWrap.style.display = v ? '' : 'none';
    });
    var scanWrap = elx('div', ROW_CSS);
    scanWrap.appendChild(scanBox.row);
    if (!canScan) {
      state.scanOn = false;
      scanWrap.appendChild(elx('small', LOCK_HINT_CSS, { text: T('printer_preset.scan_locked', 'Scan-to-folder requires a Pro license.') }));
    }
    body.appendChild(scanWrap);

    var detailWrap = elx('div');
    detailWrap.style.display = (canScan && state.scanOn) ? '' : 'none';

    var vipIn = elx('input', INPUT_CSS);
    vipIn.type = 'text'; vipIn.value = state.vip; vipIn.placeholder = '192.168.1.250';
    vipIn.addEventListener('input', function () { state.vip = vipIn.value.trim(); });
    detailWrap.appendChild(field(T('printer_preset.vip', 'Gateway address (VIP)'), vipIn));

    // Target mode radios: existing NAS route vs. new NAS route.
    var modeWrap = elx('div', ROW_CSS);
    function modeRadio(value, labelText) {
      var l = elx('label', 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:6px');
      var r = elx('input');
      r.type = 'radio'; r.name = 'pp-scan-target'; r.value = value;
      r.checked = state.scanTargetMode === value;
      r.addEventListener('change', function () { if (r.checked) { state.scanTargetMode = value; refreshTarget(); } });
      l.appendChild(r);
      l.appendChild(elx('span', 'font-size:13px', { text: labelText }));
      return l;
    }
    modeWrap.appendChild(modeRadio('existing', T('printer_preset.target_existing', 'Existing NAS route')));
    modeWrap.appendChild(modeRadio('new', T('printer_preset.target_new', 'New NAS route')));
    detailWrap.appendChild(modeWrap);

    // Existing-route picker (internal-only L4 gateway routes).
    var existSel = elx('select', INPUT_CSS);
    state.routes.filter(function (r) {
      return r.route_type === 'l4' && r.target_kind === 'gateway' && (r.external_enabled === 0 || r.external_enabled === false || r.external_enabled == null);
    }).forEach(function (r) {
      var o = document.createElement('option');
      o.value = String(r.id);
      o.textContent = (r.domain || r.name || ('route #' + r.id)) + (r.l4_listen_port ? ' :' + r.l4_listen_port : '');
      if (String(r.id) === String(state.routeId)) o.selected = true;
      existSel.appendChild(o);
    });
    existSel.addEventListener('change', function () { state.routeId = parseInt(existSel.value, 10); });
    var existWrap = field(T('printer_preset.target_existing', 'Existing NAS route'), existSel);

    // New-route fields: NAS IP + NAS gateway.
    var nasIpIn = elx('input', INPUT_CSS);
    nasIpIn.type = 'text'; nasIpIn.value = state.nasIp; nasIpIn.placeholder = '192.168.1.10';
    nasIpIn.addEventListener('input', function () { state.nasIp = nasIpIn.value.trim(); });
    var nasIpWrap = field(T('printer_preset.nas_ip', 'NAS IP'), nasIpIn);

    var nasGwSel = elx('select', INPUT_CSS);
    state.gateways.forEach(function (g) {
      var o = document.createElement('option');
      o.value = String(g.peer_id);
      o.textContent = (g.name || g.hostname || ('#' + g.peer_id));
      if (String(g.peer_id) === String(state.nasPeerId)) o.selected = true;
      nasGwSel.appendChild(o);
    });
    if (!state.nasPeerId && state.gateways.length) state.nasPeerId = state.gateways[0].peer_id;
    nasGwSel.addEventListener('change', function () { state.nasPeerId = parseInt(nasGwSel.value, 10); });
    var nasGwWrap = field(T('printer_preset.nas_gateway', 'NAS gateway'), nasGwSel);

    detailWrap.appendChild(existWrap);
    detailWrap.appendChild(nasIpWrap);
    detailWrap.appendChild(nasGwWrap);

    function refreshTarget() {
      var isNew = state.scanTargetMode === 'new';
      existWrap.style.display = isNew ? 'none' : '';
      nasIpWrap.style.display = isNew ? '' : 'none';
      nasGwWrap.style.display = isNew ? '' : 'none';
    }
    refreshTarget();
    body.appendChild(detailWrap);
  }

  // ── Step 4: review ─────────────────────────────────────────────────────────
  function renderStep4() {
    body.replaceChildren();
    var box = elx('div', 'border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;font-size:13px');
    function row(k, v) {
      var r = elx('div', 'display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-bottom:1px solid var(--border)');
      r.appendChild(elx('span', 'color:var(--text-2)', { text: k }));
      r.appendChild(elx('span', 'font-family:var(--font-mono);text-align:right', { text: v }));
      return r;
    }
    var gw = state.gateways.filter(function (g) { return String(g.peer_id) === String(state.near_peer_id); })[0];
    box.appendChild(row(T('printer_preset.gateway', 'Gateway'), gw ? (gw.name || gw.hostname || ('#' + gw.peer_id)) : String(state.near_peer_id)));
    box.appendChild(row(T('printer_preset.printer_ip', 'Printer IP'), state.printer_ip));
    box.appendChild(row(T('printer_preset.name', 'Name'), state.name));
    var ports = [];
    if (state.ports[9100]) ports.push('9100');
    if (state.ports[631]) ports.push('631');
    box.appendChild(row(T('printer_preset.step_print', 'Printing'), ports.join(', ')));
    if (state.ewsOn) box.appendChild(row(T('printer_preset.ews', 'EWS'), state.ewsDomain));
    if (state.scanOn) box.appendChild(row(T('printer_preset.step_scan', 'Scanning'), state.vip + ' · ' + state.scanTargetMode));
    body.appendChild(box);
  }

  function renderStep(step) {
    state.step = step;
    showError('');
    setPills(step);
    backBtn.style.visibility = step > 1 ? '' : 'hidden';
    nextBtn.textContent = step === 4 ? T('printer_preset.create', 'Create') : T('service_bundle.next', 'Next');
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else if (step === 3) renderStep3();
    else renderStep4();
  }

  function validateStep(step) {
    if (step === 1) {
      if (!state.near_peer_id) return T('printer_preset.gateway', 'Gateway');
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(state.printer_ip)) return T('printer_preset.printer_ip', 'Printer IP');
      if (!state.name.trim()) return T('printer_preset.name', 'Name');
    } else if (step === 2) {
      if (!state.ports[9100] && !state.ports[631]) return T('printer_preset.step_print', 'Printing');
      if (state.ewsOn && !state.ewsDomain) return T('printer_preset.ews_domain', 'EWS domain');
    } else if (step === 3) {
      if (state.scanOn) {
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(state.vip)) return T('printer_preset.vip', 'VIP');
        if (state.scanTargetMode === 'new' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(state.nasIp)) return T('printer_preset.nas_ip', 'NAS IP');
        if (state.scanTargetMode === 'existing' && !state.routeId) return T('printer_preset.target_existing', 'Existing NAS route');
      }
    }
    return null;
  }

  function submit() {
    var formBody = window.buildPresetBody(state);
    nextBtn.disabled = true;
    showError('');
    window.api.post('/api/v1/printer-presets', formBody).then(function (res) {
      nextBtn.disabled = false;
      if (!res || res.ok === false) { showError((res && res.error) || T('printer_preset.save_failed', 'Could not set up printer')); return; }
      renderSuccess(res.preset || {});
    }).catch(function (err) {
      nextBtn.disabled = false;
      showError((err && err.message) || T('printer_preset.save_failed', 'Could not set up printer'));
    });
  }

  // R1-G3: confirm with the ACTUAL assigned public print ports (may differ from 9100/631).
  function renderSuccess(preset) {
    setPills(4);
    body.replaceChildren();
    var ok = elx('div', 'text-align:center;padding:8px 0 4px');
    ok.appendChild(elx('div', 'font-family:var(--font-display);font-size:18px;margin-bottom:6px', { text: T('printer_preset.title', 'Printer ready') }));
    var listenPorts = preset.listen_ports || []; // [[targetPort, listenPort], ...]
    var portsTxt = listenPorts.map(function (pair) { return pair[1] + ' → ' + pair[0]; }).join(', ');
    var pl = elx('div', 'border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;font-size:13px;text-align:left;margin-top:8px');
    pl.appendChild(elx('div', 'color:var(--text-2);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px', { text: T('printer_preset.step_print', 'Printing') }));
    pl.appendChild(elx('div', 'font-family:var(--font-mono)', { text: portsTxt || '—' }));
    ok.appendChild(pl);
    if (preset.warning) {
      ok.appendChild(elx('div', 'margin-top:10px;font-size:12px;color:var(--amber, var(--text-3))', { text: preset.warning }));
    }
    body.appendChild(ok);
    // Footer: turn next into a "Close" that closes + reloads routes.
    backBtn.style.visibility = 'hidden';
    nextBtn.textContent = T('common.close', 'Close');
    nextBtn.onclick = function () { closeWizard(); document.dispatchEvent(new Event('gc:monitor')); };
  }

  function openWizard() {
    resetState();
    showError('');
    overlay.style.display = 'flex';
    body.replaceChildren();
    body.appendChild(elx('div', 'font-size:13px;color:var(--text-3);padding:20px 0;text-align:center', { text: T('common.loading', 'Loading...') }));
    Promise.all([
      window.api.get('/api/v1/gateways').then(function (d) { return (d && d.gateways) || []; }).catch(function () { return []; }),
      window.api.get('/api/routes').then(function (d) { return (d && (d.routes || d)) || []; }).catch(function () { return []; }),
    ]).then(function (r) {
      state.gateways = (r[0] || []).filter(function (g) { return g.enabled !== false; });
      state.routes = r[1] || [];
      nextBtn.onclick = onNext; // restore (success may have overridden it)
      renderStep(1);
    });
  }

  function closeWizard() { _clearDisc(); overlay.style.display = 'none'; nextBtn.disabled = false; nextBtn.onclick = onNext; }

  function onNext() {
    var bad = validateStep(state.step);
    if (bad) { showError(bad); return; }
    if (state.step === 4) { submit(); return; }
    renderStep(state.step + 1);
  }
  function onBack() { if (state.step > 1) renderStep(state.step - 1); }

  openBtn.addEventListener('click', openWizard);
  closeBtn.addEventListener('click', closeWizard);
  backBtn.addEventListener('click', onBack);
  // nextBtn uses .onclick (not addEventListener) so renderSuccess can repurpose it
  // as a "Close" without leaving the step-advance handler still bound.
  nextBtn.onclick = onNext;
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeWizard(); });
})();
