'use strict';

(function () {
  var tbody = document.getElementById('users-tbody');
  var editId = null;

  // ─── Scope definitions by role ────────────────────────────
  var adminScopes = [
    'full-access', 'read-only', 'peers', 'routes', 'settings',
    'webhooks', 'logs', 'system', 'backup',
    'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp'
  ];
  var userScopes = [
    'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp'
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

  function renderUsersDesktop(users) {
    document.getElementById('users-table').style.display = '';
    var mc = document.getElementById('users-mobile-cards');
    if (mc) mc.remove();
    tbody.textContent = '';

    if (!users.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 7;
      td.style.cssText = 'text-align:center;color:var(--text-3);padding:20px 0';
      td.textContent = 'No users found';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    users.forEach(function (u) {
      var tr = document.createElement('tr');
      // Name
      var tdName = document.createElement('td');
      var nm = document.createElement('div');
      nm.style.cssText = 'font-weight:600;font-size:13px';
      nm.textContent = u.username;
      tdName.appendChild(nm);
      if (u.display_name) { var ns = document.createElement('div'); ns.style.cssText = 'font-size:11px;color:var(--text-3)'; ns.textContent = u.display_name; tdName.appendChild(ns); }
      tr.appendChild(tdName);
      // Role
      var tdRole = document.createElement('td');
      var rb = document.createElement('span');
      rb.style.cssText = u.role === 'admin' ? 'background:var(--accent);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)' : 'background:var(--green);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)';
      rb.textContent = u.role === 'admin' ? (GC.t['users.role_admin'] || 'Admin') : (GC.t['users.role_user'] || 'User');
      tdRole.appendChild(rb); tr.appendChild(tdRole);
      // Tokens
      var tdTk = document.createElement('td'); tdTk.textContent = u.tokenCount != null ? u.tokenCount : 0; tr.appendChild(tdTk);
      // Peers
      var tdPr = document.createElement('td'); tdPr.textContent = u.peerCount != null ? u.peerCount : 0; tr.appendChild(tdPr);
      // Status
      var tdSt = document.createElement('td');
      var sb = document.createElement('span');
      sb.style.cssText = u.enabled ? 'color:var(--green);font-size:12px;font-weight:500' : 'color:var(--text-3);font-size:12px;font-weight:500';
      sb.textContent = u.enabled ? (GC.t['users.enabled'] || 'Enabled') : (GC.t['users.disabled'] || 'Disabled');
      tdSt.appendChild(sb); tr.appendChild(tdSt);
      // Last access
      var tdLa = document.createElement('td'); tdLa.style.cssText = 'font-size:12px;color:var(--text-3)'; tdLa.textContent = relativeTime(u.lastAccess); tr.appendChild(tdLa);
      // Actions
      var tdAc = document.createElement('td'); tdAc.className = 'user-actions';
      appendIconBtns(tdAc, u);
      tr.appendChild(tdAc);
      tbody.appendChild(tr);
    });
  }

  function appendIconBtns(container, u) {
    var be = document.createElement('button'); be.className = 'icon-btn'; be.title = 'Edit'; be.textContent = '\u270E';
    be.addEventListener('click', function () { openEditModal(u.id); }); container.appendChild(be);
    var bt = document.createElement('button'); bt.className = 'icon-btn'; bt.title = u.enabled ? 'Disable' : 'Enable'; bt.textContent = u.enabled ? '\u23F8' : '\u25B6';
    bt.addEventListener('click', function () { toggleUser(u.id, u.enabled); }); container.appendChild(bt);
    var bd = document.createElement('button'); bd.className = 'icon-btn'; bd.title = 'Delete'; bd.style.cssText = 'color:var(--red)'; bd.textContent = '\u2715';
    bd.addEventListener('click', function () { deleteUser(u.id); }); container.appendChild(bd);
  }

  function renderUsersCards(users) {
    document.getElementById('users-table').style.display = 'none';
    var mc = document.getElementById('users-mobile-cards');
    if (mc) mc.remove();

    var container = document.createElement('div');
    container.id = 'users-mobile-cards';
    container.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px';

    if (!users.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:var(--text-3);padding:20px 0';
      empty.textContent = 'No users found';
      container.appendChild(empty);
      usersCard.appendChild(container);
      return;
    }

    users.forEach(function (u) {
      var card = document.createElement('div');
      card.style.cssText = 'padding:14px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-sm)';

      // Header: name + badges
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap';
      var nameEl = document.createElement('span'); nameEl.style.cssText = 'font-weight:700;font-size:14px'; nameEl.textContent = u.username; hdr.appendChild(nameEl);
      if (u.display_name) { var sn = document.createElement('span'); sn.style.cssText = 'font-size:12px;color:var(--text-3)'; sn.textContent = u.display_name; hdr.appendChild(sn); }
      var rb = document.createElement('span');
      rb.style.cssText = u.role === 'admin' ? 'background:var(--accent);color:#fff;font-size:10px;padding:2px 6px;border-radius:var(--radius-sm)' : 'background:var(--green);color:#fff;font-size:10px;padding:2px 6px;border-radius:var(--radius-sm)';
      rb.textContent = u.role === 'admin' ? (GC.t['users.role_admin'] || 'Admin') : (GC.t['users.role_user'] || 'User');
      hdr.appendChild(rb);
      var stEl = document.createElement('span');
      stEl.style.cssText = u.enabled ? 'color:var(--green);font-size:11px;font-weight:500' : 'color:var(--text-3);font-size:11px;font-weight:500';
      stEl.textContent = u.enabled ? (GC.t['users.enabled'] || 'Aktiv') : (GC.t['users.disabled'] || 'Deaktiviert');
      hdr.appendChild(stEl);
      card.appendChild(hdr);

      // Meta: labeled values
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:12px;color:var(--text-2);margin-bottom:10px';
      var tokens = u.tokenCount != null ? u.tokenCount : 0;
      var peers = u.peerCount != null ? u.peerCount : 0;
      meta.textContent = tokens + ' Tokens \u00B7 ' + peers + ' Peers \u00B7 ' + relativeTime(u.lastAccess);
      card.appendChild(meta);

      // Actions: labeled text buttons in a flex row
      var acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      var be = document.createElement('button'); be.className = 'btn btn-sm btn-ghost'; be.textContent = GC.t['rdp.edit'] || 'Bearbeiten';
      be.addEventListener('click', function () { openEditModal(u.id); }); acts.appendChild(be);
      var bt = document.createElement('button'); bt.className = 'btn btn-sm btn-ghost';
      bt.textContent = u.enabled ? (GC.t['users.disable'] || 'Deaktivieren') : (GC.t['users.enable'] || 'Aktivieren');
      bt.addEventListener('click', function () { toggleUser(u.id, u.enabled); }); acts.appendChild(bt);
      var bd = document.createElement('button'); bd.className = 'btn btn-sm'; bd.style.cssText = 'color:var(--red);border-color:var(--red)';
      bd.textContent = GC.t['rdp.delete'] || 'Loeschen';
      bd.addEventListener('click', function () { deleteUser(u.id); }); acts.appendChild(bd);
      card.appendChild(acts);

      container.appendChild(card);
    });
    usersCard.appendChild(container);
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
    userOverlay.style.display = '';
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
    document.getElementById('user-username').removeAttribute('readonly');
    updatePasswordVisibility();
    openUserModal();
  }

  async function openEditModal(userId) {
    try {
      var data = await api.get('/api/v1/users/' + userId);
      var u = data.user;
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
      alert((GC.t['error.users.get'] || 'Failed to load user') + ': ' + err.message);
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
    if (!confirm(GC.t['users.confirm_delete'] || 'Delete this user? All their tokens will be revoked.')) return;
    try {
      await api.del('/api/v1/users/' + id);
      loadUsers();
    } catch (err) {
      alert((GC.t['error.users.delete'] || 'Failed to delete user') + ': ' + err.message);
    }
  }

  // ─── Toggle user ──────────────────────────────────────────
  async function toggleUser(id, currentlyEnabled) {
    if (currentlyEnabled) {
      if (!confirm(GC.t['users.confirm_disable'] || 'Disable this user? All their tokens will stop working.')) return;
    }
    try {
      await api.put('/api/v1/users/' + id + '/toggle');
      loadUsers();
    } catch (err) {
      alert((GC.t['error.users.toggle'] || 'Failed to toggle user') + ': ' + err.message);
    }
  }

  // ─── Token list in edit modal ─────────────────────────────
  var tokensList = document.getElementById('user-tokens-list');

  function renderUserTokens(tokens) {
    tokensList.textContent = '';
    if (!tokens.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);text-align:center;padding:8px 0';
      empty.textContent = 'No tokens';
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
        lastUsed.textContent = 'Used ' + relativeTime(tk.last_used_at);
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
    if (!confirm('Revoke this token?')) return;
    try {
      await api.del('/api/v1/tokens/' + tokenId);
      reloadEditTokens();
    } catch (err) {
      alert('Failed to revoke token: ' + err.message);
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

    tokenOverlay.style.display = '';
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
          alert(err.message || 'Failed to assign token');
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
