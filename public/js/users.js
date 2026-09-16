'use strict';

(function () {
  // In-app dialogs instead of confirm()/alert() (docs/feature-wave2.md §W1.2).
  var D = window.GCDialog;
  var DT = function (k, p) { return D.t(k, p); };
  var tbody = document.getElementById('users-tbody');
  var editId = null;

  // ─── Scope definitions by role ────────────────────────────
  var adminScopes = [
    'full-access', 'read-only', 'peers', 'routes', 'settings',
    'webhooks', 'logs', 'system', 'backup',
    'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp',
    'pihole', 'pihole:control'
  ];
  var userScopes = [
    'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp',
    'pihole'
  ];

  function getAllowedScopes(role) {
    return role === 'admin' ? adminScopes : userScopes;
  }

  // ─── Relative time helper ─────────────────────────────────
  function relativeTime(iso) {
    if (!iso) return '\u2014';
    var diff = Date.now() - new Date(iso).getTime();
    var sec = Math.floor(diff / 1000);
    if (sec < 60) return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  // ─── Load users ───────────────────────────────────────────
  async function loadUsers() {
    try {
      var data = await api.get('/api/v1/users');
      renderUsersTable(data.users || []);
    } catch (err) {
      tbody.textContent = '';
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 7;
      td.style.cssText = 'text-align:center;color:var(--text-3);padding:20px 0';
      td.textContent = GC.t['error.users.list'] || 'Failed to load users';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  // ─── Render users (responsive: table on desktop, cards on mobile) ──
  var isMobile = function () { return window.innerWidth < 768; };
  var usersCard = document.getElementById('users-table').parentElement;
  var cachedUserList = [];

  function renderUsersTable(users) {
    cachedUserList = users;
    if (isMobile()) { renderUsersCards(users); } else { renderUsersDesktop(users); }
  }

  // ─── action buttons (icon-action class, SVG icons) ───
  function userActionBtns(u) {
    var editSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m14 6 4 4M4 20l1-4L16 5l3 3L8 19l-4 1Z"/></svg>';
    var toggleSvg = u.enabled
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>';
    var deleteSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
    var editTitle = GC.t['rdp.edit'] || 'Bearbeiten';
    var toggleTitle = u.enabled ? (GC.t['users.disable'] || 'Deaktivieren') : (GC.t['users.enable'] || 'Aktivieren');
    var deleteTitle = GC.t['rdp.delete'] || 'Löschen';
    return '<div class="row-actions">' +
      '<button class="icon-action" title="' + escapeHtml(editTitle) + '" data-action="edit-user" data-uid="' + u.id + '">' + editSvg + '</button>' +
      '<button class="icon-action" title="' + escapeHtml(toggleTitle) + '" data-action="toggle-user" data-uid="' + u.id + '" data-enabled="' + (u.enabled ? '1' : '0') + '">' + toggleSvg + '</button>' +
      '<button class="icon-action danger" title="' + escapeHtml(deleteTitle) + '" data-action="delete-user" data-uid="' + u.id + '">' + deleteSvg + '</button>' +
    '</div>';
  }

  // ─── MFA status tag ────────────────────────────────
  function mfaTag(u) {
    // MFA field is not yet returned by the API; fall back gracefully
    if (u.totp_enabled) {
      return '<span class="tag tag-green tag-dot">' + escapeHtml(GC.t['users.mfa_totp'] || 'TOTP') + '</span>';
    }
    return '<span class="tag tag-grey tag-dot">' + escapeHtml(GC.t['users.mfa_off'] || 'Off') + '</span>';
  }

  // ─── desktop table render ─────────────────────────
  function renderUsersDesktop(users) {
    document.getElementById('users-table').style.display = '';
    var mc = document.getElementById('users-mobile-cards');
    if (mc) mc.remove();
    tbody.textContent = '';

    if (!users.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
      td.style.cssText = 'text-align:center;color:var(--text-3);padding:20px 0';
      td.textContent = GC.t['users.no_users'] || 'No users found';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    tbody.innerHTML = users.map(function (u) {
      var roleTag = u.role === 'admin'
        ? '<span class="tag tag-blue">' + escapeHtml(GC.t['users.role_admin'] || 'Admin') + '</span>'
        : '<span class="tag tag-grey">' + escapeHtml(GC.t['users.role_user'] || 'User') + '</span>';
      var displaySub = u.display_name ? '<div style="font-size:11px;color:var(--text-3)">' + escapeHtml(u.display_name) + '</div>' : '';
      var lastLogin = relativeTime(u.lastAccess);
      return '<tr>' +
        '<td class="cell-name">' + escapeHtml(u.username) + displaySub + '</td>' +
        '<td>' + roleTag + '</td>' +
        '<td>' + mfaTag(u) + '</td>' +
        '<td style="font-size:12px;color:var(--muted)">' + escapeHtml(lastLogin) + '</td>' +
        '<td>' + userActionBtns(u) + '</td>' +
      '</tr>';
    }).join('');

    // Wire up delegated action buttons
    tbody.addEventListener('click', handleUserAction, { once: false });
  }

  // ─── mobile cards render ──────────────────────────
  function renderUsersCards(users) {
    document.getElementById('users-table').style.display = 'none';
    tbody.textContent = '';
    var mc = document.getElementById('users-mobile-cards');
    if (mc) mc.remove();

    var container = document.createElement('div');
    container.id = 'users-mobile-cards';
    container.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px';

    if (!users.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:var(--text-3);padding:20px 0';
      empty.textContent = GC.t['users.no_users'] || 'No users found';
      container.appendChild(empty);
      usersCard.appendChild(container);
      return;
    }

    users.forEach(function (u) {
      var card = document.createElement('div');
      card.className = 'aurora-user-card';

      var roleTag = u.role === 'admin'
        ? '<span class="tag tag-blue">' + escapeHtml(GC.t['users.role_admin'] || 'Admin') + '</span>'
        : '<span class="tag tag-grey">' + escapeHtml(GC.t['users.role_user'] || 'User') + '</span>';

      var displaySub = u.display_name ? '<div class="card-meta" style="margin-top:2px">' + escapeHtml(u.display_name) + '</div>' : '';
      var lastLogin = relativeTime(u.lastAccess);

      card.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
          '<span class="cell-name">' + escapeHtml(u.username) + '</span>' +
          roleTag +
          mfaTag(u) +
        '</div>' +
        (displaySub ? displaySub : '') +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">' + escapeHtml(lastLogin) + '</div>' +
        userActionBtns(u);

      container.appendChild(card);
    });

    usersCard.appendChild(container);
    container.addEventListener('click', handleUserAction);
  }

  // ─── delegated click handler for row-actions ──────
  function handleUserAction(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var uid = btn.dataset.uid;
    if (action === 'edit-user') { openEditModal(uid); }
    else if (action === 'toggle-user') { toggleUser(uid, btn.dataset.enabled === '1'); }
    else if (action === 'delete-user') { deleteUser(uid); }
  }

  // Re-render on resize crossing mobile/desktop boundary
  var lastMobile = isMobile();
  window.addEventListener('resize', function () {
    var now = isMobile();
    if (now !== lastMobile) { lastMobile = now; renderUsersTable(cachedUserList); }
  });

  // ─── User modal helpers ───────────────────────────────────
  var userOverlay = document.getElementById('user-modal-overlay');
  var userForm = document.getElementById('user-form');
  var userTitle = document.getElementById('user-modal-title');
  var userEditIdEl = document.getElementById('user-edit-id');
  var userPasswordGroup = document.getElementById('user-password-group');
  var userTokensSection = document.getElementById('user-tokens-section');
  var userRoleSelect = document.getElementById('user-role');
  var userFormError = document.getElementById('user-form-error');

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = '';
  }

  function hideError(el) {
    el.style.display = 'none';
    el.textContent = '';
  }

  function openUserModal() {
    hideError(userFormError);
    // Explicit 'flex' (not '') so the overlay overrides aurora.css's base
    // `.modal-overlay{display:none}`; inline style beats the class rule.
    // Opening with '' would fall back to that rule and stay hidden.
    userOverlay.style.display = 'flex';
  }

  function closeUserModal() {
    userOverlay.style.display = 'none';
  }

  function openCreateModal() {
    editId = null;
    userEditIdEl.value = '';
    userForm.reset();
    userTitle.textContent = GC.t['users.add_user'] || 'Add User';
    userPasswordGroup.style.display = 'none';
    userTokensSection.style.display = 'none';
    if (tfSection) tfSection.style.display = 'none';
    document.getElementById('user-username').removeAttribute('readonly');
    updatePasswordVisibility();
    openUserModal();
  }

  // ─── 2FA (docs/feature-admin-2fa.md) ─────────────────────────
  var tfI18n = {};
  try { tfI18n = JSON.parse(document.getElementById('tf-users-i18n').textContent); } catch (e) { tfI18n = {}; }
  function tfT(k, fb) { return tfI18n[k] || fb; }
  var tfSection = document.getElementById('user-2fa-section');
  var tfResetBtn = document.getElementById('btn-user-2fa-reset');
  var tfCurrentUser = tfSection ? parseInt(tfSection.getAttribute('data-current-user'), 10) : NaN;

  function renderUser2fa(u) {
    if (!tfSection) return;
    var st = document.getElementById('user-2fa-status');
    var on = !!u.totp_enabled;
    st.textContent = on ? tfT('users_active', '2FA active') : tfT('users_inactive', 'No 2FA');
    st.className = 'tf-badge ' + (on ? 'tf-badge-on' : 'tf-badge-off');
    // Own account is handled on the profile page (disable); reset is for others.
    tfResetBtn.style.display = (on && u.id !== tfCurrentUser) ? '' : 'none';
    tfResetBtn.dataset.uid = u.id;
    tfResetBtn.dataset.uname = u.username;
    tfSection.style.display = 'flex';
  }

  if (tfResetBtn) {
    tfResetBtn.addEventListener('click', async function () {
      var id = tfResetBtn.dataset.uid;
      var name = tfResetBtn.dataset.uname || '';
      if (!id) return;
      if (!await D.confirm({ message: tfT('users_reset_confirm', 'Reset 2FA for {{name}}?').replace('{{name}}', name), danger: true })) return;
      btnLoading(tfResetBtn);
      try {
        var data = await api.del('/api/v1/users/' + id + '/2fa');
        if (data.ok) {
          renderUser2fa(data.user || { id: parseInt(id, 10), totp_enabled: 0 });
          if (window.showToast) showToast(tfT('users_reset_done', '2FA reset'), 'success');
          loadUsers();
        } else {
          showError(userFormError, data.error || 'Error');
        }
      } catch (err) {
        showError(userFormError, err.message);
      } finally {
        btnReset(tfResetBtn);
      }
    });
  }

  async function openEditModal(userId) {
    try {
      var data = await api.get('/api/v1/users/' + userId);
      var u = data.user;
      renderUser2fa(u);
      editId = u.id;
      userEditIdEl.value = u.id;
      userTitle.textContent = GC.t['users.edit_user'] || 'Edit User';
      document.getElementById('user-username').value = u.username;
      document.getElementById('user-username').setAttribute('readonly', 'readonly');
      document.getElementById('user-display-name').value = u.display_name || '';
      document.getElementById('user-email').value = u.email || '';
      userRoleSelect.value = u.role;
      document.getElementById('user-password').value = '';
      updatePasswordVisibility();
      userTokensSection.style.display = '';
      renderUserTokens(data.tokens || []);
      openUserModal();
    } catch (err) {
      D.alert({ message: DT('error.users.get') + ': ' + err.message, danger: true });
    }
  }

  function updatePasswordVisibility() {
    userPasswordGroup.style.display = userRoleSelect.value === 'admin' ? '' : 'none';
  }

  userRoleSelect.addEventListener('change', updatePasswordVisibility);

  // ─── Save user ────────────────────────────────────────────
  async function saveUser() {
    var btn = document.getElementById('user-modal-save');
    var body = {
      username: document.getElementById('user-username').value.trim(),
      displayName: document.getElementById('user-display-name').value.trim(),
      email: document.getElementById('user-email').value.trim(),
      role: userRoleSelect.value,
    };
    var pw = document.getElementById('user-password').value;
    if (pw) body.password = pw;

    hideError(userFormError);
    btnLoading(btn);
    try {
      if (editId) {
        await api.patch('/api/v1/users/' + editId, body);
      } else {
        await api.post('/api/v1/users', body);
      }
      closeUserModal();
      loadUsers();
    } catch (err) {
      showError(userFormError, err.message || 'Failed to save user');
    } finally {
      btnReset(btn);
    }
  }

  // ─── Delete user ──────────────────────────────────────────
  async function deleteUser(id) {
    if (!await D.confirm({ message: DT('users.confirm_delete'), danger: true, okLabel: DT('common.delete') })) return;
    try {
      await api.del('/api/v1/users/' + id);
      loadUsers();
    } catch (err) {
      D.alert({ message: DT('error.users.delete') + ': ' + err.message, danger: true });
    }
  }

  // ─── Toggle user ──────────────────────────────────────────
  async function toggleUser(id, currentlyEnabled) {
    if (currentlyEnabled) {
      if (!await D.confirm({ message: DT('users.confirm_disable'), danger: true, okLabel: DT('users.disable') })) return;
    }
    try {
      await api.put('/api/v1/users/' + id + '/toggle');
      loadUsers();
    } catch (err) {
      D.alert({ message: DT('error.users.toggle') + ': ' + err.message, danger: true });
    }
  }

  // ─── Token list in edit modal ─────────────────────────────
  var tokensList = document.getElementById('user-tokens-list');

  function renderUserTokens(tokens) {
    tokensList.textContent = '';
    if (!tokens.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);text-align:center;padding:8px 0';
      empty.textContent = DT('users.no_tokens');
      tokensList.appendChild(empty);
      return;
    }
    tokens.forEach(function (tk) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      var nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:12px;font-weight:600';
      nameEl.textContent = tk.name;
      info.appendChild(nameEl);

      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-3);display:flex;gap:6px;flex-wrap:wrap;margin-top:2px';

      if (tk.scopes && tk.scopes.length) {
        tk.scopes.forEach(function (s) {
          var badge = document.createElement('span');
          badge.className = 'tag-grey';
          badge.style.cssText = 'font-size:10px;padding:1px 5px';
          badge.textContent = s;
          meta.appendChild(badge);
        });
      }

      if (tk.last_used_at) {
        var lastUsed = document.createElement('span');
        lastUsed.textContent = DT('users.token_last_used', { when: relativeTime(tk.last_used_at) });
        meta.appendChild(lastUsed);
      }

      info.appendChild(meta);
      row.appendChild(info);

      var revokeBtn = document.createElement('button');
      revokeBtn.className = 'icon-btn';
      revokeBtn.title = 'Revoke';
      revokeBtn.style.cssText = 'color:var(--red);flex-shrink:0';
      revokeBtn.textContent = '\u2715';
      revokeBtn.addEventListener('click', function () { revokeToken(tk.id); });
      row.appendChild(revokeBtn);

      tokensList.appendChild(row);
    });
  }

  async function reloadEditTokens() {
    if (!editId) return;
    try {
      var data = await api.get('/api/v1/users/' + editId);
      renderUserTokens(data.tokens || []);
    } catch {}
  }

  async function revokeToken(tokenId) {
    if (!await D.confirm({ message: DT('users.token_revoke_confirm'), danger: true, okLabel: DT('users.token_revoke') })) return;
    try {
      await api.del('/api/v1/tokens/' + tokenId);
      reloadEditTokens();
    } catch (err) {
      D.alert({ message: DT('users.token_revoke_failed') + ': ' + err.message, danger: true });
    }
  }

  // ─── Token Wizard (4-step) ─────────────────────────────────
  var tokenOverlay = document.getElementById('token-modal-overlay');
  var tokenFormError = document.getElementById('token-form-error');
  var twStep = 1;
  var twUserId = null; // set when opened from user-edit or standalone

  var scopePresets = {
    client: ['client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp'],
    'full-access': ['full-access'],
    'read-only': ['read-only'],
  };

  function twShowStep(n) {
    twStep = n;
    for (var i = 1; i <= 4; i++) {
      var el = document.getElementById('tw-step-' + i);
      if (el) el.style.display = i === n ? '' : 'none';
    }
    document.getElementById('token-wizard-step').textContent = n + '/4';
    document.getElementById('tw-back').style.display = n > 1 && n < 4 ? '' : 'none';
    var nextBtn = document.getElementById('tw-next');
    var cancelBtn = document.getElementById('tw-cancel');
    if (n === 3) { nextBtn.textContent = GC.t['users.create_token'] || 'Erstellen'; }
    else if (n === 4) { nextBtn.textContent = GC.t['common.done'] || 'Fertig'; cancelBtn.style.display = 'none'; }
    else { nextBtn.textContent = (GC.t['common.next'] || 'Weiter') + ' →'; cancelBtn.style.display = ''; }
    hideError(tokenFormError);
  }

  async function openTokenWizard(forUserId) {
    twUserId = forUserId || null;
    twShowStep(1);
    document.getElementById('tw-name').value = '';
    document.getElementById('tw-copy-confirm').style.display = 'none';
    document.getElementById('tw-token-value').textContent = '';

    // Reset split-tunnel override
    document.getElementById('tw-st-override').checked = false;
    document.getElementById('tw-st-section').style.display = 'none';
    document.getElementById('tw-st-private').checked = false;
    document.getElementById('tw-st-linklocal').checked = false;
    document.getElementById('tw-st-locked').checked = false;

    // Populate user dropdown
    var sel = document.getElementById('tw-user');
    sel.textContent = '';
    try {
      var uData = await api.get('/api/v1/users');
      (uData.users || []).forEach(function (u) {
        var opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.username + (u.display_name ? ' (' + u.display_name + ')' : '');
        if (twUserId && u.id === twUserId) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch {}

    // Populate peer dropdown
    var peerSel = document.getElementById('tw-peer');
    peerSel.textContent = '';
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = GC.t['users.no_peer_binding'] || '— Keiner (beim Verbinden) —';
    peerSel.appendChild(noneOpt);
    try {
      var pData = await api.get('/api/v1/peers');
      (pData.peers || []).forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + ' (' + p.allowed_ips + ')';
        peerSel.appendChild(opt);
      });
    } catch {}

    // Custom scopes checkboxes
    renderCustomScopes();

    // Explicit 'flex' (not '') — see openUserModal: aurora.css base hides
    // .modal-overlay, so '' would fall back to display:none and stay hidden.
    tokenOverlay.style.display = 'flex';
  }

  function renderCustomScopes() {
    var container = document.getElementById('tw-custom-scopes');
    container.textContent = '';
    var sel = document.getElementById('tw-user');
    var userId = sel.value;
    // Determine role from cached users or default to admin scopes
    var role = 'admin';
    var allowed = getAllowedScopes(role);
    allowed.forEach(function (scope) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = scope; cb.className = 'tw-scope-cb'; cb.style.cssText = 'accent-color:var(--accent)';
      label.appendChild(cb);
      label.appendChild(document.createTextNode(scope));
      container.appendChild(label);
    });
  }

  // Show/hide custom scopes based on preset selection
  document.getElementById('tw-presets').addEventListener('change', function () {
    var val = document.querySelector('input[name="tw-preset"]:checked').value;
    document.getElementById('tw-custom-scopes').style.display = val === 'custom' ? 'flex' : 'none';
  });

  // Split-tunnel override toggle
  var stOverride = document.getElementById('tw-st-override');
  var stSection = document.getElementById('tw-st-section');
  if (stOverride && stSection) {
    stOverride.addEventListener('change', function() {
      stSection.style.display = stOverride.checked ? '' : 'none';
    });
  }

  function getWizardScopes() {
    var preset = document.querySelector('input[name="tw-preset"]:checked').value;
    if (preset === 'custom') {
      var scopes = [];
      document.querySelectorAll('.tw-scope-cb:checked').forEach(function (cb) { scopes.push(cb.value); });
      return scopes;
    }
    return scopePresets[preset] || scopePresets.client;
  }

  async function twNext() {
    if (twStep === 1) {
      var name = document.getElementById('tw-name').value.trim();
      if (!name) { showError(tokenFormError, GC.t['users.token_name_required'] || 'Token-Name erforderlich'); return; }
      twShowStep(2);
    } else if (twStep === 2) {
      var scopes = getWizardScopes();
      if (!scopes.length) { showError(tokenFormError, GC.t['users.token_scopes_required'] || 'Mindestens eine Berechtigung wählen'); return; }
      twShowStep(3);
    } else if (twStep === 3) {
      // Create the token
      var btn = document.getElementById('tw-next');
      var userId = document.getElementById('tw-user').value;
      var body = {
        name: document.getElementById('tw-name').value.trim(),
        scopes: getWizardScopes(),
      };
      var peerId = document.getElementById('tw-peer').value;
      if (peerId) body.peer_id = parseInt(peerId, 10);
      var expiryDays = document.querySelector('input[name="tw-expiry"]:checked').value;
      if (expiryDays) {
        var d = new Date();
        d.setDate(d.getDate() + parseInt(expiryDays, 10));
        body.expires_at = d.toISOString();
      }
      if (document.getElementById('tw-st-override').checked) {
        var stNets = [];
        if (document.getElementById('tw-st-private').checked) {
          stNets.push({cidr:'10.0.0.0/8',label:'Private 10.x'},{cidr:'172.16.0.0/12',label:'Private 172.x'},{cidr:'192.168.0.0/16',label:'Private 192.x'});
        }
        if (document.getElementById('tw-st-linklocal').checked) {
          stNets.push({cidr:'169.254.0.0/16',label:'Link-Local'});
        }
        body.split_tunnel_override = {
          mode: document.getElementById('tw-st-mode').value,
          networks: stNets,
          locked: document.getElementById('tw-st-locked').checked,
        };
      }
      hideError(tokenFormError);
      btnLoading(btn);
      try {
        var data = await api.post('/api/v1/users/' + userId + '/tokens', body);
        document.getElementById('tw-token-value').textContent = data.token || '';
        twShowStep(4);
        reloadEditTokens();
      } catch (err) {
        showError(tokenFormError, err.message || 'Token-Erstellung fehlgeschlagen');
      } finally {
        btnReset(btn);
      }
    } else if (twStep === 4) {
      closeTokenModal();
      loadUsers();
    }
  }

  function closeTokenModal() { tokenOverlay.style.display = 'none'; }

  // Copy button
  document.getElementById('tw-copy-btn').addEventListener('click', function () {
    var token = document.getElementById('tw-token-value').textContent;
    if (token) {
      navigator.clipboard.writeText(token).then(function () {
        document.getElementById('tw-copy-confirm').style.display = '';
      });
    }
  });

  // Wizard navigation
  document.getElementById('tw-next').addEventListener('click', function (e) { e.preventDefault(); twNext(); });
  document.getElementById('tw-back').addEventListener('click', function (e) { e.preventDefault(); if (twStep > 1) twShowStep(twStep - 1); });

  // ─── Unassigned tokens ────────────────────────────────────
  var unassignedBanner = document.getElementById('unassigned-banner');
  var unassignedList = document.getElementById('unassigned-list');
  var cachedUsers = [];

  async function loadUnassigned() {
    try {
      var data = await api.get('/api/v1/users/unassigned-tokens');
      var tokens = data.tokens || [];
      if (tokens.length > 0) {
        document.getElementById('unassigned-count').textContent = tokens.length;
        unassignedBanner.style.display = '';

        // Cache user list for dropdowns
        var userData = await api.get('/api/v1/users');
        cachedUsers = userData.users || [];

        renderUnassignedTokens(tokens);
      } else {
        unassignedBanner.style.display = 'none';
      }
    } catch {}
  }

  function renderUnassignedTokens(tokens) {
    unassignedList.textContent = '';
    tokens.forEach(function (tk) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:6px';

      // Token info
      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      var nameEl = document.createElement('span');
      nameEl.style.cssText = 'font-size:12px;font-weight:600';
      nameEl.textContent = tk.name;
      info.appendChild(nameEl);
      if (tk.scopes && tk.scopes.length) {
        tk.scopes.forEach(function (s) {
          var badge = document.createElement('span');
          badge.className = 'tag-grey';
          badge.style.cssText = 'font-size:10px;padding:1px 5px;margin-left:4px';
          badge.textContent = s;
          info.appendChild(badge);
        });
      }
      row.appendChild(info);

      // User select dropdown
      var select = document.createElement('select');
      select.style.cssText = 'padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-xs);background:var(--bg-panel);flex-shrink:0';
      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '\u2014 User \u2014';
      select.appendChild(defaultOpt);
      cachedUsers.forEach(function (u) {
        var opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = u.username + (u.display_name ? ' (' + u.display_name + ')' : '');
        select.appendChild(opt);
      });
      row.appendChild(select);

      // Assign button
      var assignBtn = document.createElement('button');
      assignBtn.className = 'btn btn-primary';
      assignBtn.style.cssText = 'font-size:11px;padding:4px 10px;flex-shrink:0';
      assignBtn.textContent = GC.t['users.assign'] || 'Assign';
      assignBtn.addEventListener('click', async function () {
        var userId = select.value;
        if (!userId) return;
        btnLoading(assignBtn);
        try {
          await api.put('/api/v1/tokens/' + tk.id + '/assign', { userId: parseInt(userId, 10) });
          loadUnassigned();
          loadUsers();
        } catch (err) {
          D.alert({ message: err.message || DT('users.token_assign_failed'), danger: true });
        } finally {
          btnReset(assignBtn);
        }
      });
      row.appendChild(assignBtn);

      unassignedList.appendChild(row);
    });
  }

  // ─── Modal close handlers (no backdrop click — prevent accidental data loss) ──
  document.getElementById('user-modal-close').addEventListener('click', closeUserModal);
  document.getElementById('user-modal-cancel').addEventListener('click', closeUserModal);
  document.getElementById('user-modal-save').addEventListener('click', function (e) {
    e.preventDefault();
    saveUser();
  });

  document.getElementById('token-modal-close').addEventListener('click', closeTokenModal);
  document.getElementById('tw-cancel').addEventListener('click', closeTokenModal);
  document.getElementById('btn-add-token').addEventListener('click', function (e) {
    e.preventDefault();
    openTokenWizard(editId);
  });
  // Standalone token creation from page header
  document.getElementById('btn-create-token-standalone').addEventListener('click', function (e) {
    e.preventDefault();
    openTokenWizard(null);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (tokenOverlay.style.display !== 'none') {
        closeTokenModal();
      } else if (userOverlay.style.display !== 'none') {
        closeUserModal();
      }
    }
  });

  // ─── Add user button ──────────────────────────────────────
  document.getElementById('btn-add-user').addEventListener('click', openCreateModal);

  // ─── Init ─────────────────────────────────────────────────
  loadUsers();
  loadUnassigned();
})();
