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
        renderPeerOptions(peerSelect);
      }
    } catch (err) {
      console.error('Failed to load peers:', err);
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

  // ─── Render route list ───────────────────────────────────
  function renderRoutes(routes) {
    if (!routes.length) {
      routesList.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">No routes configured</div>';
      return;
    }

    routesList.innerHTML = routes.map(r => {
      const peerIp = r.peer_ip ? r.peer_ip.split('/')[0] : r.target_ip;
      const peerLabel = r.peer_name || peerIp;
      const target = `${peerIp}:${r.target_port}`;
      const peerOnline = r.peer_enabled !== 0;
      const statusTag = !r.enabled
        ? '<span class="tag tag-amber"><span class="tag-dot"></span>Disabled</span>'
        : peerOnline
          ? '<span class="tag tag-green"><span class="tag-dot"></span>Active</span>'
          : '<span class="tag tag-red"><span class="tag-dot"></span>Peer offline</span>';
      const httpsTag = r.https_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> HTTPS</span>'
        : '';
      const backendHttpsTag = r.backend_https && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Backend HTTPS</span>'
        : '';
      const authTag = r.basic_auth_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Basic Auth</span>'
        : '';
      let routeAuthTags = '';
      if (r.route_auth_enabled && r.route_type !== 'l4') {
        // Auth method badge
        const methodLabels = { email_password: 'Email & Passwort', email_code: 'Email & Code', totp: 'TOTP' };
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

      return `<div class="route-item" data-route-id="${r.id}">
        <div class="route-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="route-domain">${escapeHtml(r.domain)}</div>
          <div class="route-target">${targetDisplay}</div>
          ${r.description ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(r.description)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${statusTag}${httpsTag}${backendHttpsTag}${authTag}${routeAuthTags}${l4Tags}
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

  // ─── Create route via inline form ────────────────────────
  routeForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fd = new FormData(routeForm);
    const domain = fd.get('domain').trim();
    const description = fd.get('description') ? fd.get('description').trim() : '';
    const peer_id = fd.get('peer_id') || null;
    const target_port = fd.get('target_port').trim();

    const httpsToggle = routeForm.querySelector('[data-field="https_enabled"]');
    const backendHttpsToggle = routeForm.querySelector('[data-field="backend_https"]');

    const https_enabled = httpsToggle ? httpsToggle.classList.contains('on') : true;
    const backend_https = backendHttpsToggle ? backendHttpsToggle.classList.contains('on') : false;

    const authType = document.getElementById('create-auth-type')?.value || 'none';
    const basic_auth_enabled = authType === 'basic';
    const basic_auth_user = fd.get('basic_auth_user') ? fd.get('basic_auth_user').trim() : '';
    const basic_auth_password = fd.get('basic_auth_password') ? fd.get('basic_auth_password').trim() : '';

    if (!domain || !target_port) return;

    if (basic_auth_enabled && (!basic_auth_user || !basic_auth_password)) {
      alert('Basic auth username and password are required when auth is enabled');
      return;
    }

    const submitBtn = routeForm.querySelector('button[type="submit"]');
    btnLoading(submitBtn);
    try {
      const payload = { domain, description, peer_id, target_port, https_enabled, backend_https, basic_auth_enabled };
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
        setToggleGroup('create-auth-type-group', 'create-auth-type', 'none');
        updateCreateAuthTypeUI();
        loadRoutes();
      } else {
        alert(data.error || 'Failed to create route');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      btnReset(submitBtn);
    }
  });

  // ─── Add route button (mobile) ───────────────────────────
  const btnAdd = document.getElementById('btn-add-route');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      // Scroll to the form on the right side
      const form = document.getElementById('route-form');
      if (form) {
        form.scrollIntoView({ behavior: 'smooth' });
        const firstInput = form.querySelector('input[name="domain"]');
        if (firstInput) firstInput.focus();
      }
    });
  }

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

    hideError('edit-route-error');
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
        const payload = { domain, description, target_port, peer_id, target_ip, https_enabled, backend_https, basic_auth_enabled };
        const editRouteType = document.getElementById('edit-route-type').value;
        payload.route_type = editRouteType;
        if (editRouteType === 'l4') {
          payload.l4_protocol = document.getElementById('edit-l4-protocol').value;
          payload.l4_listen_port = document.getElementById('edit-l4-listen-port').value;
          payload.l4_tls_mode = document.getElementById('edit-l4-tls-mode').value;
        }
        if (basic_auth_enabled) {
          payload.basic_auth_user = basic_auth_user.trim();
          if (basic_auth_password.trim()) {
            payload.basic_auth_password = basic_auth_password.trim();
          }
        }
        const data = await api.put('/api/routes/' + id, payload);
        if (!data.ok) {
          showError('edit-route-error', data.error);
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
      await api.post('/api/routes/' + id + '/toggle');
      loadRoutes();
    } catch (err) {
      console.error('Toggle error:', err);
    }
  }

  // ─── Delete ──────────────────────────────────────────────
  let pendingDeleteId = null;

  function showConfirmDelete(id, domain) {
    pendingDeleteId = id;
    const msg = document.getElementById('confirm-message');
    if (msg) msg.textContent = 'Are you sure you want to delete route "' + (domain || id) + '"? This will remove the Caddy proxy rule.';
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
        console.error('Delete error:', err);
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
    const l4Fields = document.getElementById('edit-l4-fields');
    const httpFields = document.getElementById('edit-http-fields');
    if (l4Fields) l4Fields.style.display = routeType === 'l4' ? 'block' : 'none';
    if (httpFields) httpFields.style.display = routeType === 'http' ? 'block' : 'none';

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

  // ─── Init ────────────────────────────────────────────────
  loadRoutes();
  loadPeers();
  setInterval(loadRoutes, 30000);
})();
