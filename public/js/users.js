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

  // ─── Render users table ───────────────────────────────────
  function renderUsersTable(users) {
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
      var nameMain = document.createElement('div');
      nameMain.style.cssText = 'font-weight:600;font-size:13px';
      nameMain.textContent = u.username;
      tdName.appendChild(nameMain);
      if (u.display_name) {
        var nameSub = document.createElement('div');
        nameSub.style.cssText = 'font-size:11px;color:var(--text-3)';
        nameSub.textContent = u.display_name;
        tdName.appendChild(nameSub);
      }
      tr.appendChild(tdName);

      // Role
      var tdRole = document.createElement('td');
      var roleBadge = document.createElement('span');
      roleBadge.style.cssText = u.role === 'admin'
        ? 'background:var(--accent);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)'
        : 'background:var(--green);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)';
      roleBadge.textContent = u.role === 'admin'
        ? (GC.t['users.role_admin'] || 'Admin')
        : (GC.t['users.role_user'] || 'User');
      tdRole.appendChild(roleBadge);
      tr.appendChild(tdRole);

      // Tokens
      var tdTokens = document.createElement('td');
      tdTokens.textContent = u.tokenCount != null ? u.tokenCount : 0;
      tr.appendChild(tdTokens);

      // Peers
      var tdPeers = document.createElement('td');
      tdPeers.textContent = u.peerCount != null ? u.peerCount : 0;
      tr.appendChild(tdPeers);

      // Status
      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.style.cssText = u.enabled
        ? 'color:var(--green);font-size:12px;font-weight:500'
        : 'color:var(--text-3);font-size:12px;font-weight:500';
      statusBadge.textContent = u.enabled
        ? (GC.t['users.enabled'] || 'Enabled')
        : (GC.t['users.disabled'] || 'Disabled');
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // Last access
      var tdLast = document.createElement('td');
      tdLast.style.cssText = 'font-size:12px;color:var(--text-3)';
      tdLast.textContent = relativeTime(u.lastAccess);
      tr.appendChild(tdLast);

      // Actions
      var tdActions = document.createElement('td');
      tdActions.style.cssText = 'text-align:right;white-space:nowrap';

      var btnEdit = document.createElement('button');
      btnEdit.className = 'icon-btn';
      btnEdit.title = 'Edit';
      btnEdit.textContent = '\u270E';
      btnEdit.addEventListener('click', function () { openEditModal(u.id); });
      tdActions.appendChild(btnEdit);

      var btnToggle = document.createElement('button');
      btnToggle.className = 'icon-btn';
      btnToggle.title = u.enabled ? 'Disable' : 'Enable';
      btnToggle.style.cssText = 'margin-left:4px';
      btnToggle.textContent = u.enabled ? '\u23F8' : '\u25B6';
      btnToggle.addEventListener('click', function () { toggleUser(u.id, u.enabled); });
      tdActions.appendChild(btnToggle);

      var btnDelete = document.createElement('button');
      btnDelete.className = 'icon-btn';
      btnDelete.title = 'Delete';
      btnDelete.style.cssText = 'margin-left:4px;color:var(--red)';
      btnDelete.textContent = '\u2715';
      btnDelete.addEventListener('click', function () { deleteUser(u.id); });
      tdActions.appendChild(btnDelete);

      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
  }

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

  // ─── Token sub-modal ──────────────────────────────────────
  var tokenOverlay = document.getElementById('token-modal-overlay');
  var tokenResult = document.getElementById('token-created-result');
  var tokenValue = document.getElementById('token-created-value');
  var tokenFormError = document.getElementById('token-form-error');

  function renderScopeCheckboxes() {
    var container = document.getElementById('new-token-scopes');
    container.textContent = '';
    var role = userRoleSelect.value;
    var allowed = getAllowedScopes(role);
    allowed.forEach(function (scope) {
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;padding:4px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = scope;
      cb.className = 'new-token-scope-cb';
      cb.style.cssText = 'accent-color:var(--accent)';
      label.appendChild(cb);
      var txt = document.createTextNode(scope);
      label.appendChild(txt);
      container.appendChild(label);
    });
  }

  function openTokenModal() {
    tokenResult.style.display = 'none';
    hideError(tokenFormError);
    document.getElementById('new-token-name').value = '';
    document.getElementById('new-token-expiry').value = '';
    renderScopeCheckboxes();
    tokenOverlay.style.display = '';
  }

  function closeTokenModal() {
    tokenOverlay.style.display = 'none';
  }

  async function createToken() {
    var btn = document.getElementById('btn-create-token');
    var name = document.getElementById('new-token-name').value.trim();
    if (!name) {
      showError(tokenFormError, 'Token name is required');
      return;
    }

    var scopes = [];
    document.querySelectorAll('.new-token-scope-cb:checked').forEach(function (cb) {
      scopes.push(cb.value);
    });
    if (!scopes.length) {
      showError(tokenFormError, 'Select at least one scope');
      return;
    }

    var expiryDays = document.getElementById('new-token-expiry').value;
    var body = { name: name, scopes: scopes };
    if (expiryDays) {
      var d = new Date();
      d.setDate(d.getDate() + parseInt(expiryDays, 10));
      body.expires_at = d.toISOString();
    }

    hideError(tokenFormError);
    btnLoading(btn);
    try {
      var data = await api.post('/api/v1/users/' + editId + '/tokens', body);
      tokenValue.textContent = data.token || '';
      tokenResult.style.display = '';
      reloadEditTokens();
    } catch (err) {
      showError(tokenFormError, err.message || 'Failed to create token');
    } finally {
      btnReset(btn);
    }
  }

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
  document.getElementById('token-modal-cancel').addEventListener('click', closeTokenModal);
  document.getElementById('btn-create-token').addEventListener('click', function (e) {
    e.preventDefault();
    createToken();
  });
  document.getElementById('btn-add-token').addEventListener('click', function (e) {
    e.preventDefault();
    openTokenModal();
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
