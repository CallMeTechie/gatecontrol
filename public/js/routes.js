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

  // ─── Render route list ───────────────────────────────────
  function renderRoutes(routes) {
    if (!routes.length) {
      routesList.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">No routes configured</div>';
      return;
    }

    routesList.innerHTML = routes.map(r => {
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
      const authTag = r.basic_auth_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Basic Auth</span>'
        : '';
      let routeAuthTags = '';
      if (r.route_auth_enabled && r.route_type !== 'l4') {
        // Auth method badge
        const methodLabels = { email_password: GC.t['route_auth.method_email_password'] || 'Email & Password', email_code: GC.t['route_auth.method_email_code'] || 'Email & Code', totp: GC.t['route_auth.method_totp'] || 'TOTP' };
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

      // r.id is a numeric DB id, safe for attribute use; checked is a static string
      var batchChecked = batchSelected.has(String(r.id)) ? ' checked' : '';
      var batchCbHtml = batchMode ? '<div class="batch-checkbox-wrap" style="display:flex;align-items:center;padding-right:10px"><input type="checkbox" class="batch-checkbox" data-batch-id="' + r.id + '"' + batchChecked + '></div>' : '';

      return `<div class="route-item${batchMode ? ' batch-mode' : ''}" data-route-id="${r.id}">
        ${batchCbHtml}
        <div class="route-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="route-domain">${escapeHtml(r.domain)}</div>
          <div class="route-target">${targetDisplay}</div>
          ${r.description ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(r.description)}</div>` : ''}
        </div>
        <div class="route-tags">
          ${statusTag}${monitorTag}${cbTag}${debugTag}${botTag}${aclTag}${ipFilterTag}${rateLimitTag}${retryTag}${backendsTag}${stickyTag}${httpsTag}${backendHttpsTag}${compressTag}${authTag}${routeAuthTags}${headersTag}${mirrorTag}${l4Tags}
        </div>
        <div class="route-actions">
          <button class="icon-btn" title="Edit" data-action="edit" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn" title="Toggle" data-action="toggle" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>
          <button class="icon-btn" title="Delete" data-action="delete" data-id="${r.id}" data-domain="${escapeHtml(r.domain)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  // ─── Search routes ──────────────────────────────────────
  function applyRouteFilter() {
    const q = routeSearch ? routeSearch.value.toLowerCase().trim() : '';
    if (!q) return renderRoutes(allRoutes);
    const filtered = allRoutes.filter(r =>
      (r.domain && r.domain.toLowerCase().includes(q)) ||
      (r.description && r.description.toLowerCase().includes(q)) ||
      (r.peer_name && r.peer_name.toLowerCase().includes(q)) ||
      (r.target_ip && r.target_ip.includes(q))
    );
    renderRoutes(filtered);
  }

  if (routeSearch) {
    routeSearch.addEventListener('input', () => applyRouteFilter());
  }

  // ─── Route list action delegation ────────────────────────
  routesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;

    switch (action) {
      case 'edit': showEditModal(id); break;
      case 'toggle': toggleRoute(id); break;
      case 'delete': showConfirmDelete(id, btn.dataset.domain); break;
    }
  });

  // ─── Create form: target-kind (peer vs gateway) toggle ───
  (function initCreateTargetKindToggle() {
    const tkSel = document.getElementById('create-route-target-kind');
    const peerFields = document.getElementById('create-route-peer-fields');
    const gwFields = document.getElementById('create-route-gateway-fields');
    const wolCb = document.getElementById('create-route-wol-enabled');
    const wolMacField = document.getElementById('create-route-wol-mac-field');
    if (tkSel && peerFields && gwFields) {
      const sync = () => {
        const gw = tkSel.value === 'gateway';
        peerFields.style.display = gw ? 'none' : '';
        gwFields.style.display = gw ? '' : 'none';
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
    const domain = fd.get('domain').trim();
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

    if (!domain) {
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
        routeForm.reset();
        // Reset toggles
        if (httpsToggle) httpsToggle.classList.add('on');
        if (backendHttpsToggle) backendHttpsToggle.classList.remove('on');
        var ccmp = document.getElementById('create-route-compress');
        if (ccmp) ccmp.classList.remove('on');
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
          domain: 'create-route-domain',
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

  function validateWizardStep(n) {
    if (n !== 1) return true;
    const domainEl = document.getElementById('create-route-domain');
    const domain = (domainEl && domainEl.value || '').trim();
    if (!domain) {
      alert((GC.t && GC.t['routes.domain_required']) || 'Domain is required');
      if (domainEl) domainEl.focus();
      return false;
    }
    if (isL4Route()) {
      const lpEl = document.getElementById('l4-listen-port');
      if (!lpEl || !lpEl.value.trim()) {
        alert((GC.t && GC.t['routes.l4_listen_port_required']) || 'Listen-Port erforderlich');
        if (lpEl) lpEl.focus();
        return false;
      }
      return true;
    }
    const tk = (document.getElementById('create-route-target-kind') || {}).value || 'peer';
    if (tk === 'gateway') {
      const gw = (document.getElementById('create-route-gateway-peer') || {}).value || '';
      const host = ((document.getElementById('create-route-lan-host') || {}).value || '').trim();
      const port = (document.getElementById('create-route-lan-port') || {}).value || '';
      if (!gw) { alert((GC.t && GC.t['route_gateway_peer_required']) || 'Gateway erforderlich'); return false; }
      if (!host) { alert((GC.t && GC.t['route_lan_host_required']) || 'LAN-Host erforderlich'); return false; }
      if (!port) { alert((GC.t && GC.t['route_lan_port_required']) || 'LAN-Port erforderlich'); return false; }
    } else {
      const peer = (document.getElementById('route-peer-select') || {}).value || '';
      const port = ((document.getElementById('route-port') || {}).value || '').trim();
      if (!peer) { alert((GC.t && GC.t['routes.peer_required']) || 'Peer erforderlich'); return false; }
      if (!port) { alert((GC.t && GC.t['routes.target_port_required']) || 'Target-Port erforderlich'); return false; }
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

    const domain = ((document.getElementById('create-route-domain') || {}).value || '').trim() || '—';
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

    const rows = [
      [(GC.t && GC.t['routes.domain']) || 'Domain', domain],
      [(GC.t && GC.t['routes.type']) || 'Typ', type.toUpperCase()],
      [(GC.t && GC.t['routes.target_peer']) || 'Ziel', target],
    ];
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
    routeModalOverlay.style.display = 'flex';
    showWizardStep(1);
    setTimeout(() => {
      const f = document.getElementById('create-route-domain');
      if (f) f.focus();
    }, 50);
  }

  function closeRouteWizard() {
    if (!routeModalOverlay) return;
    routeModalOverlay.style.display = 'none';
  }

  window.openRouteWizard = openRouteWizard;
  window.closeRouteWizard = closeRouteWizard;

  if (btnAdd) btnAdd.addEventListener('click', openRouteWizard);
  if (routeModalClose) routeModalClose.addEventListener('click', closeRouteWizard);
  if (routeModalOverlay) {
    routeModalOverlay.addEventListener('click', (e) => {
      if (e.target === routeModalOverlay) closeRouteWizard();
    });
  }
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

    // Reset auth type to none first
    setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'none');

    // Reset route auth fields
    var ra2fa = document.getElementById('edit-ra-2fa');
    if (ra2fa) ra2fa.classList.remove('on');
    setToggleGroup('edit-ra-method-group', 'edit-ra-method', 'email_password');
    setToggleGroup('edit-ra-2fa-method-group', 'edit-ra-method', 'email_code');
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

    // Load route auth config from API
    try {
      var authData = await api.get('/api/routes/' + id + '/auth');
      if (authData.ok && authData.data) {
        setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'route');
        var auth = authData.data;
        var email = auth.email || '';
        var sessionAge = String(auth.session_max_age || 86400000);

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
      } else if (route.basic_auth_enabled) {
        setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'basic');
      }
    } catch (err) {
      if (route.basic_auth_enabled) {
        setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'basic');
      }
    }

    updateEditAuthTypeUI();

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
    // Circuit breaker status indicator
    var cbStatusIndicator = document.getElementById('edit-cb-status-indicator');
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
        cbStatusIndicator.style.background = 'var(--yellow, #facc15)';
        cbStatusIndicator.style.color = '#000';
        cbStatusIndicator.textContent = GC.t['circuit_breaker.status_half_open'] || 'Half-Open';
      }
    } else if (cbStatusIndicator) {
      cbStatusIndicator.style.display = 'none';
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

      if (!domain || !target_port) {
        showError('edit-route-error', 'Domain and port are required');
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

  function updateFieldVisibility() {
    const routeType = document.getElementById('route-type')?.value || 'http';
    const l4Fields = document.getElementById('l4-fields');
    const httpFields = document.getElementById('http-fields');
    if (l4Fields) l4Fields.style.display = routeType === 'l4' ? 'block' : 'none';
    if (httpFields) httpFields.style.display = routeType === 'http' ? 'block' : 'none';

    const domainInput = document.getElementById('route-domain');
    const tlsMode = document.getElementById('l4-tls-mode')?.value;
    if (routeType === 'l4' && tlsMode === 'none' && domainInput) {
      domainInput.required = false;
    } else if (domainInput) {
      domainInput.required = true;
    }

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
      hint.style.color = 'var(--yellow, #facc15)';
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

  // ─── L4 listen port auto-fill ───────────────────────────
  function setupPortAutofill(portId, listenPortId) {
    document.getElementById(portId)?.addEventListener('input', function() {
      const listenPort = document.getElementById(listenPortId);
      if (listenPort && !listenPort.dataset.userModified) {
        listenPort.value = this.value;
      }
    });
    document.getElementById(listenPortId)?.addEventListener('input', function() {
      this.dataset.userModified = 'true';
    });
  }
  setupPortAutofill('route-port', 'l4-listen-port');
  setupPortAutofill('edit-route-port', 'edit-l4-listen-port');

  // ─── DNS check ──────────────────────────────────────────
  async function checkDns(domain, hintEl, inputEl) {
    if (!domain || !hintEl || !inputEl) return;
    const routeTypeId = inputEl.id === 'create-route-domain' ? 'route-type' : 'edit-route-type';
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
        hintEl.style.color = 'var(--yellow, #facc15)';
      } else {
        hintEl.style.display = 'none';
      }
    } catch (_) {
      hintEl.style.display = 'none';
    }
  }

  // Attach DNS check blur handlers
  (function setupDnsCheck() {
    const createDomainInput = document.getElementById('create-route-domain');
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
      var statusColor = e.status >= 500 ? 'var(--red, #f87171)' : e.status >= 400 ? 'var(--yellow, #facc15)' : 'var(--green, #4ade80)';

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

  // Click on route-item in batch mode toggles checkbox
  routesList.addEventListener('click', function(e) {
    if (!batchMode) return;
    // Don't toggle if clicking action buttons or the checkbox itself
    if (e.target.closest('[data-action]') || e.target.closest('.batch-checkbox')) return;
    var item = e.target.closest('.route-item');
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

  // ─── Init ────────────────────────────────────────────────
  loadRoutes();
  loadPeers();
  setInterval(loadRoutes, 30000);

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
})();
