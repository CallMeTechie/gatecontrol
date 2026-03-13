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
      const httpsTag = r.https_enabled
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> HTTPS</span>'
        : '';
      const backendHttpsTag = r.backend_https
        ? '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Backend HTTPS</span>'
        : '';
      const authTag = r.basic_auth_enabled
        ? '<span class="tag tag-amber" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Auth</span>'
        : '';

      return `<div class="route-item" data-route-id="${r.id}">
        <div class="route-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="route-domain">${escapeHtml(r.domain)}</div>
          <div class="route-target">→ ${escapeHtml(peerLabel)} (${escapeHtml(target)})</div>
          ${r.description ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${escapeHtml(r.description)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${statusTag}${httpsTag}${backendHttpsTag}${authTag}
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
    const authToggle = routeForm.querySelector('[data-field="basic_auth_enabled"]');

    const https_enabled = httpsToggle ? httpsToggle.classList.contains('on') : true;
    const backend_https = backendHttpsToggle ? backendHttpsToggle.classList.contains('on') : false;
    const basic_auth_enabled = authToggle ? authToggle.classList.contains('on') : false;

    const basic_auth_user = fd.get('basic_auth_user') ? fd.get('basic_auth_user').trim() : '';
    const basic_auth_password = fd.get('basic_auth_password') ? fd.get('basic_auth_password').trim() : '';

    if (!domain || !target_port) return;

    if (basic_auth_enabled && (!basic_auth_user || !basic_auth_password)) {
      alert('Basic auth username and password are required when auth is enabled');
      return;
    }

    try {
      const payload = { domain, description, peer_id, target_port, https_enabled, backend_https, basic_auth_enabled };
      if (basic_auth_enabled) {
        payload.basic_auth_user = basic_auth_user;
        payload.basic_auth_password = basic_auth_password;
      }
      const data = await api.post('/api/routes', payload);
      if (data.ok) {
        routeForm.reset();
        // Reset toggles
        if (httpsToggle) httpsToggle.classList.add('on');
        if (backendHttpsToggle) backendHttpsToggle.classList.remove('on');
        if (authToggle) authToggle.classList.remove('on');
        loadRoutes();
      } else {
        alert(data.error || 'Failed to create route');
      }
    } catch (err) {
      alert(err.message);
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

    const authToggleEdit = document.getElementById('edit-route-auth');
    if (authToggleEdit) {
      if (route.basic_auth_enabled) authToggleEdit.classList.add('on');
      else authToggleEdit.classList.remove('on');
    }
    const authUser = document.getElementById('edit-route-auth-user');
    if (authUser) authUser.value = route.basic_auth_user || '';
    const authPass = document.getElementById('edit-route-auth-pass');
    if (authPass) authPass.value = '';
    const authFields = document.getElementById('edit-auth-fields');
    if (authFields) authFields.style.display = route.basic_auth_enabled ? 'block' : 'none';

    hideError('edit-route-error');
    openModal('modal-edit-route');
    document.getElementById('edit-route-domain').focus();
  }

  const btnEditSubmit = document.getElementById('btn-edit-route-submit');
  if (btnEditSubmit) {
    btnEditSubmit.addEventListener('click', async () => {
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
      const authToggle = document.getElementById('edit-route-auth');
      const basic_auth_enabled = authToggle ? authToggle.classList.contains('on') : false;
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

      try {
        const payload = { domain, description, target_port, peer_id, target_ip, https_enabled, backend_https, basic_auth_enabled };
        if (basic_auth_enabled) {
          payload.basic_auth_user = basic_auth_user.trim();
          if (basic_auth_password.trim()) {
            payload.basic_auth_password = basic_auth_password.trim();
          }
        }
        const data = await api.put('/api/routes/' + id, payload);
        if (data.ok) {
          closeModal('modal-edit-route');
          loadRoutes();
        } else {
          showError('edit-route-error', data.error);
        }
      } catch (err) {
        showError('edit-route-error', err.message);
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

    newBtn.addEventListener('click', async () => {
      if (!pendingDeleteId) return;
      try {
        await api.del('/api/routes/' + pendingDeleteId);
        closeModal('modal-confirm');
        pendingDeleteId = null;
        loadRoutes();
      } catch (err) {
        console.error('Delete error:', err);
      }
    });
  }

  // Modal helpers use global openModal/closeModal from app.js
  function showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function hideError(id) {
    const el = document.getElementById(id);
    if (el) { el.style.display = 'none'; el.textContent = ''; }
  }
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Modal close/escape/focus-trap handled globally in app.js

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

  setupAuthToggle('[data-field="basic_auth_enabled"]', '#basic-auth-fields');
  setupAuthToggle('#edit-route-auth', '#edit-auth-fields');

  // ─── Init ────────────────────────────────────────────────
  loadRoutes();
  loadPeers();
  setInterval(loadRoutes, 30000);
})();
