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
        ? '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Auth</span>'
        : '';
      const routeAuthTag = r.route_auth_enabled && r.route_type !== 'l4'
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Route Auth</span>'
        : '';
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
          ${statusTag}${httpsTag}${backendHttpsTag}${authTag}${routeAuthTag}${l4Tags}
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
          const raMethod = document.getElementById('create-ra-method')?.value || 'email_password';
          const is2fa = document.getElementById('create-ra-2fa')?.classList.contains('on') || false;
          const raPayload = {
            auth_type: is2fa ? (raMethod === 'email_password' ? 'email_code' : raMethod) : raMethod,
            two_factor_enabled: is2fa,
            two_factor_method: is2fa ? raMethod : null,
            email: document.getElementById('create-ra-email')?.value || null,
            password: document.getElementById('create-ra-password')?.value || null,
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
    const method = document.getElementById('edit-ra-method')?.value || 'email_password';
    const is2fa = document.getElementById('edit-ra-2fa')?.classList.contains('on') || false;

    const emailGroup = document.getElementById('edit-ra-email-group');
    const passwordGroup = document.getElementById('edit-ra-password-group');
    const totpGroup = document.getElementById('edit-ra-totp-group');
    const methodHint = document.getElementById('edit-ra-method-hint');
    const emailPwBtn = document.querySelector('#edit-ra-method-group [data-value="email_password"]');

    if (is2fa) {
      if (emailPwBtn) {
        emailPwBtn.style.opacity = '0.4';
        emailPwBtn.style.pointerEvents = 'none';
      }
      if (methodHint) methodHint.style.display = '';
    } else {
      if (emailPwBtn) {
        emailPwBtn.style.opacity = '';
        emailPwBtn.style.pointerEvents = '';
      }
      if (methodHint) methodHint.style.display = 'none';
    }

    if (method === 'totp') {
      if (emailGroup) emailGroup.style.display = 'none';
      if (passwordGroup) passwordGroup.style.display = 'none';
      if (totpGroup) totpGroup.style.display = '';
    } else {
      if (emailGroup) emailGroup.style.display = '';
      if (passwordGroup) passwordGroup.style.display = method === 'email_password' ? '' : 'none';
      if (totpGroup) totpGroup.style.display = 'none';
    }
  }

  function updateEditAuthTypeUI() {
    const authType = document.getElementById('edit-auth-type')?.value || 'none';
    const basicFields = document.getElementById('edit-basic-auth-fields');
    const routeAuthFields = document.getElementById('edit-route-auth-fields');

    if (basicFields) basicFields.style.display = authType === 'basic' ? 'block' : 'none';
    if (routeAuthFields) routeAuthFields.style.display = authType === 'route' ? 'block' : 'none';

    if (authType === 'route') {
      updateRouteAuthMethodUI();
    }
  }

  // Setup auth type toggle group
  const authTypeGroup = document.getElementById('edit-auth-type-group');
  if (authTypeGroup) {
    authTypeGroup.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        authTypeGroup.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        document.getElementById('edit-auth-type').value = btn.dataset.value;
        updateEditAuthTypeUI();
      });
    });
  }

  // Setup route auth method toggle group
  const raMethodGroup = document.getElementById('edit-ra-method-group');
  if (raMethodGroup) {
    raMethodGroup.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        raMethodGroup.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        document.getElementById('edit-ra-method').value = btn.dataset.value;
        updateRouteAuthMethodUI();
      });
    });
  }

  // Setup 2FA toggle
  const ra2faToggle = document.getElementById('edit-ra-2fa');
  if (ra2faToggle) {
    ra2faToggle.addEventListener('click', () => {
      ra2faToggle.classList.toggle('on');
      const is2fa = ra2faToggle.classList.contains('on');
      const currentMethod = document.getElementById('edit-ra-method')?.value || 'email_password';

      // When 2FA is enabled and method is email_password, switch to email_code
      if (is2fa && currentMethod === 'email_password') {
        setToggleGroup('edit-ra-method-group', 'edit-ra-method', 'email_code');
      }
      updateRouteAuthMethodUI();
    });
  }

  // TOTP generate button
  const btnTotpGenerate = document.getElementById('btn-ra-totp-generate');
  if (btnTotpGenerate) {
    btnTotpGenerate.addEventListener('click', async () => {
      const routeId = document.getElementById('edit-route-id')?.value;
      if (!routeId) return;

      btnLoading(btnTotpGenerate);
      try {
        const data = await api.post('/api/routes/' + routeId + '/auth/totp-setup', {});
        if (data.ok && data.data) {
          pendingTotpSecret = data.data.secret;

          // Show secret text
          const secretEl = document.getElementById('edit-ra-totp-secret');
          if (secretEl) {
            secretEl.textContent = data.data.secret;
            secretEl.style.display = '';
          }

          // Show QR code
          const qrEl = document.getElementById('edit-ra-totp-qr');
          if (qrEl && data.data.uri) {
            qrEl.textContent = '';
            try {
              var qr = qrcode(0, 'M');
              qr.addData(data.data.uri);
              qr.make();
              var img = document.createElement('img');
              img.src = qr.createDataURL(4, 4);
              img.alt = 'TOTP QR Code';
              img.style.cssText = 'display:block;margin:0 auto;border-radius:var(--radius-sm);';
              qrEl.appendChild(img);
            } catch (e) {
              // Fallback: show URI text
              var uriDiv = document.createElement('div');
              uriDiv.style.cssText = 'font-size:11px;color:var(--text-3);word-break:break-all;padding:6px';
              uriDiv.textContent = data.data.uri;
              qrEl.appendChild(uriDiv);
            }
            qrEl.style.display = '';
          }

          // Show verify section
          const verifyEl = document.getElementById('edit-ra-totp-verify');
          if (verifyEl) verifyEl.style.display = '';
        } else {
          alert(data.error || 'Failed to generate TOTP setup');
        }
      } catch (err) {
        alert(err.message);
      } finally {
        btnReset(btnTotpGenerate);
      }
    });
  }

  // TOTP confirm button
  const btnTotpConfirm = document.getElementById('btn-ra-totp-confirm');
  if (btnTotpConfirm) {
    btnTotpConfirm.addEventListener('click', async () => {
      const routeId = document.getElementById('edit-route-id')?.value;
      const code = document.getElementById('edit-ra-totp-code')?.value?.trim();
      const statusEl = document.getElementById('edit-ra-totp-status');

      if (!routeId || !pendingTotpSecret || !code) return;

      btnLoading(btnTotpConfirm);
      try {
        const data = await api.post('/api/routes/' + routeId + '/auth/totp-verify', {
          secret: pendingTotpSecret,
          token: code
        });
        if (statusEl) {
          statusEl.style.display = '';
          if (data.ok) {
            statusEl.style.color = 'var(--green)';
            statusEl.textContent = 'TOTP verified successfully';
          } else {
            statusEl.style.color = 'var(--red)';
            statusEl.textContent = data.error || 'Invalid code';
          }
        }
      } catch (err) {
        if (statusEl) {
          statusEl.style.display = '';
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = err.message;
        }
      } finally {
        btnReset(btnTotpConfirm);
      }
    });
  }

  // ─── Edit route modal ───────────────────────────────────
  async function showEditModal(id) {
    const route = allRoutes.find(r => String(r.id) === String(id));
    if (!route) return;

    document.getElementById('edit-route-id').value = id;
    document.getElementById('edit-route-domain').value = route.domain || '';
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
    const ra2fa = document.getElementById('edit-ra-2fa');
    if (ra2fa) ra2fa.classList.remove('on');
    setToggleGroup('edit-ra-method-group', 'edit-ra-method', 'email_password');
    const raEmail = document.getElementById('edit-ra-email');
    if (raEmail) raEmail.value = '';
    const raPass = document.getElementById('edit-ra-password');
    if (raPass) raPass.value = '';
    const raDuration = document.getElementById('edit-ra-session-duration');
    if (raDuration) raDuration.value = '86400000';
    // Reset TOTP state
    pendingTotpSecret = null;
    const totpSecret = document.getElementById('edit-ra-totp-secret');
    if (totpSecret) { totpSecret.textContent = ''; totpSecret.style.display = 'none'; }
    const totpQr = document.getElementById('edit-ra-totp-qr');
    if (totpQr) { totpQr.textContent = ''; totpQr.style.display = 'none'; }
    const totpVerify = document.getElementById('edit-ra-totp-verify');
    if (totpVerify) totpVerify.style.display = 'none';
    const totpCode = document.getElementById('edit-ra-totp-code');
    if (totpCode) totpCode.value = '';
    const totpStatus = document.getElementById('edit-ra-totp-status');
    if (totpStatus) { totpStatus.textContent = ''; totpStatus.style.display = 'none'; }

    // Reset basic auth fields
    const authUser = document.getElementById('edit-route-auth-user');
    if (authUser) authUser.value = route.basic_auth_user || '';
    const authPass = document.getElementById('edit-route-auth-pass');
    if (authPass) authPass.value = '';

    // Load route auth config from API
    try {
      const authData = await api.get('/api/routes/' + id + '/auth');
      if (authData.ok && authData.auth) {
        // Route Auth is configured
        setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'route');
        const auth = authData.auth;
        if (auth.two_factor_enabled) {
          if (ra2fa) ra2fa.classList.add('on');
        }
        const method = auth.two_factor_method || auth.auth_type || 'email_password';
        setToggleGroup('edit-ra-method-group', 'edit-ra-method', method);
        if (raEmail) raEmail.value = auth.email || '';
        if (raDuration) raDuration.value = String(auth.session_max_age || 86400000);
      } else if (route.basic_auth_enabled) {
        setToggleGroup('edit-auth-type-group', 'edit-auth-type', 'basic');
      }
      // else: stays 'none'
    } catch (err) {
      // If auth endpoint fails, fall back to basic auth state from route
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
          const raMethod = document.getElementById('edit-ra-method')?.value || 'email_password';
          const ra2faActive = document.getElementById('edit-ra-2fa')?.classList.contains('on') || false;
          const raEmailVal = (document.getElementById('edit-ra-email') || {}).value || '';
          const raPasswordVal = (document.getElementById('edit-ra-password') || {}).value || '';
          const raSessionDuration = document.getElementById('edit-ra-session-duration')?.value || '86400000';

          const raPayload = {
            auth_type: raMethod,
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
    const authType = document.getElementById('create-auth-type')?.value || 'none';
    const basicFields = document.getElementById('create-basic-auth-fields');
    const routeAuthFields = document.getElementById('create-route-auth-fields');
    if (basicFields) basicFields.style.display = authType === 'basic' ? 'block' : 'none';
    if (routeAuthFields) routeAuthFields.style.display = authType === 'route' ? 'block' : 'none';
    if (authType === 'route') updateCreateRouteAuthMethodUI();
  }

  function updateCreateRouteAuthMethodUI() {
    const method = document.getElementById('create-ra-method')?.value || 'email_password';
    const is2fa = document.getElementById('create-ra-2fa')?.classList.contains('on');
    const emailGroup = document.getElementById('create-ra-email-group');
    const passwordGroup = document.getElementById('create-ra-password-group');
    const totpGroup = document.getElementById('create-ra-totp-group');
    const methodHint = document.getElementById('create-ra-method-hint');

    if (is2fa) {
      if (emailGroup) emailGroup.style.display = 'block';
      if (passwordGroup) passwordGroup.style.display = 'block';
      if (totpGroup) totpGroup.style.display = method === 'totp' ? 'block' : 'none';
      if (methodHint) methodHint.style.display = 'block';
    } else {
      const needsEmail = method === 'email_password' || method === 'email_code';
      const needsPassword = method === 'email_password';
      if (emailGroup) emailGroup.style.display = needsEmail ? 'block' : 'none';
      if (passwordGroup) passwordGroup.style.display = needsPassword ? 'block' : 'none';
      if (totpGroup) totpGroup.style.display = method === 'totp' ? 'block' : 'none';
      if (methodHint) methodHint.style.display = 'none';
    }
  }

  const createAuthTypeGroup = document.getElementById('create-auth-type-group');
  if (createAuthTypeGroup) {
    createAuthTypeGroup.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        createAuthTypeGroup.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        document.getElementById('create-auth-type').value = btn.dataset.value;
        updateCreateAuthTypeUI();
      });
    });
  }

  const createMethodGroup = document.getElementById('create-ra-method-group');
  if (createMethodGroup) {
    createMethodGroup.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        createMethodGroup.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        document.getElementById('create-ra-method').value = btn.dataset.value;
        updateCreateRouteAuthMethodUI();
      });
    });
  }

  document.getElementById('create-ra-2fa')?.addEventListener('click', function () {
    this.classList.toggle('on');
    const is2fa = this.classList.contains('on');
    const methodGroup = document.getElementById('create-ra-method-group');
    if (is2fa && document.getElementById('create-ra-method').value === 'email_password') {
      setToggleGroup('create-ra-method-group', 'create-ra-method', 'email_code');
    }
    if (methodGroup) {
      const epBtn = methodGroup.querySelector('[data-value="email_password"]');
      if (epBtn) {
        epBtn.style.opacity = is2fa ? '0.4' : '1';
        epBtn.style.pointerEvents = is2fa ? 'none' : 'auto';
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
