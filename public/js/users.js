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
    'read-only', 'peers', 'client',
    'client:services', 'client:traffic', 'client:dns', 'client:rdp'
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
      console.error('Failed to load users:', err);
      tbody.textContent = '';
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 7;
      td.style.cssText = 'text-align:center;color:var(--text-3);font-size:13px;padding:20px 0';
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
      td.style.cssText = 'text-align:center;color:var(--text-3);font-size:13px;padding:20px 0';
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
      roleBadge.className = 'badge';
      roleBadge.style.cssText = u.role === 'admin'
        ? 'background:var(--accent);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)'
        : 'background:var(--green, #22c55e);color:#fff;font-size:11px;padding:2px 8px;border-radius:var(--radius-sm)';
      roleBadge.textContent = u.role === 'admin'
        ? (GC.t['users.role_admin'] || 'Admin')
        : (GC.t['users.role_user'] || 'User');
      tdRole.appendChild(roleBadge);
      tr.appendChild(tdRole);

      // Tokens
      var tdTokens = document.createElement('td');
      tdTokens.textContent = u.token_count != null ? u.token_count : 0;
      tr.appendChild(tdTokens);

      // Peers
      var tdPeers = document.createElement('td');
      tdPeers.textContent = u.peer_count != null ? u.peer_count : 0;
      tr.appendChild(tdPeers);

      // Status
      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.style.cssText = u.enabled
        ? 'color:var(--green, #22c55e);font-size:12px;font-weight:500'
        : 'color:var(--text-3);font-size:12px;font-weight:500';
      statusBadge.textContent = u.enabled
        ? (GC.t['users.enabled'] || 'Enabled')
        : (GC.t['users.disabled'] || 'Disabled');
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // Last access
      var tdLast = document.createElement('td');
      tdLast.style.cssText = 'font-size:12px;color:var(--text-3)';
      tdLast.textContent = relativeTime(u.last_login);
      tr.appendChild(tdLast);

      // Actions
      var tdActions = document.createElement('td');
      tdActions.style.cssText = 'text-align:right;white-space:nowrap';

      var btnEdit = document.createElement('button');
      btnEdit.className = 'btn btn-ghost btn-sm';
      btnEdit.textContent = 'Edit';
      btnEdit.addEventListener('click', function () { openEditModal(u.id); });
      tdActions.appendChild(btnEdit);

      var btnToggle = document.createElement('button');
      btnToggle.className = 'btn btn-ghost btn-sm';
      btnToggle.textContent = u.enabled ? 'Disable' : 'Enable';
      btnToggle.style.cssText = 'margin-left:4px';
      btnToggle.addEventListener('click', function () { toggleUser(u.id, u.enabled); });
      tdActions.appendChild(btnToggle);

      var btnDelete = document.createElement('button');
      btnDelete.className = 'btn btn-ghost btn-sm';
      btnDelete.textContent = 'Delete';
      btnDelete.style.cssText = 'margin-left:4px;color:var(--red, #ef4444)';
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

  function openUserModal() {
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
      loadUserTokens(userId);
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
      display_name: document.getElementById('user-display-name').value.trim(),
      email: document.getElementById('user-email').value.trim(),
      role: userRoleSelect.value,
    };
    var pw = document.getElementById('user-password').value;
    if (pw) body.password = pw;

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
      var key = editId ? 'error.users.update' : 'error.users.create';
      alert((GC.t[key] || 'Failed to save user') + ': ' + err.message);
    } finally {
      btnReset(btn);
    }
  }

  // ─── Delete user ──────────────────────────────────────────
  async function deleteUser(id) {
    if (!confirm(GC.t['users.confirm_delete'] || 'Delete this user? All their tokens will be revoked.')) return;
    try {
      await api.delete('/api/v1/users/' + id);
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

  // ─── Token management in edit modal ───────────────────────
  var tokensList = document.getElementById('user-tokens-list');

  async function loadUserTokens(userId) {
    tokensList.textContent = '';
    try {
      var data = await api.get('/api/v1/users/' + userId + '/tokens');
      var tokens = data.tokens || [];
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
            badge.style.cssText = 'background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);padding:1px 5px;font-size:10px';
            badge.textContent = s;
            meta.appendChild(badge);
          });
        }

        if (tk.last_used) {
          var lastUsed = document.createElement('span');
          lastUsed.textContent = 'Used ' + relativeTime(tk.last_used);
          meta.appendChild(lastUsed);
        }

        info.appendChild(meta);
        row.appendChild(info);

        var revokeBtn = document.createElement('button');
        revokeBtn.className = 'btn btn-ghost btn-sm';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.style.cssText = 'color:var(--red, #ef4444);flex-shrink:0';
        revokeBtn.addEventListener('click', function () { revokeToken(tk.id); });
        row.appendChild(revokeBtn);

        tokensList.appendChild(row);
      });
    } catch (err) {
      console.error('Failed to load tokens:', err);
    }
  }

  async function revokeToken(tokenId) {
    if (!confirm('Revoke this token?')) return;
    try {
      await api.delete('/api/v1/tokens/' + tokenId);
      if (editId) loadUserTokens(editId);
    } catch (err) {
      alert('Failed to revoke token: ' + err.message);
    }
  }

  // ─── Token sub-modal ──────────────────────────────────────
  var tokenOverlay = document.getElementById('token-modal-overlay');
  var tokenResult = document.getElementById('token-created-result');
  var tokenValue = document.getElementById('token-created-value');

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
    if (!name) return;

    var scopes = [];
    document.querySelectorAll('.new-token-scope-cb:checked').forEach(function (cb) {
      scopes.push(cb.value);
    });

    var expiryDays = document.getElementById('new-token-expiry').value;
    var body = { name: name, scopes: scopes };
    if (expiryDays) {
      var d = new Date();
      d.setDate(d.getDate() + parseInt(expiryDays, 10));
      body.expires_at = d.toISOString();
    }

    btnLoading(btn);
    try {
      var data = await api.post('/api/v1/users/' + editId + '/tokens', body);
      tokenValue.textContent = data.raw_token || data.token;
      tokenResult.style.display = '';
      if (editId) loadUserTokens(editId);
    } catch (err) {
      alert('Failed to create token: ' + err.message);
    } finally {
      btnReset(btn);
    }
  }

  // ─── Unassigned tokens ────────────────────────────────────
  async function loadUnassigned() {
    try {
      var data = await api.get('/api/v1/users/unassigned-tokens');
      var count = data.count || 0;
      if (count > 0) {
        document.getElementById('unassigned-count').textContent = count;
        document.getElementById('unassigned-banner').style.display = '';
      }
    } catch (err) {
      // Silently ignore if endpoint not available
    }
  }

  // ─── Modal close handlers ─────────────────────────────────
  userOverlay.addEventListener('click', function (e) {
    if (e.target === userOverlay) closeUserModal();
  });
  document.getElementById('user-modal-close').addEventListener('click', closeUserModal);
  document.getElementById('user-modal-cancel').addEventListener('click', closeUserModal);
  document.getElementById('user-modal-save').addEventListener('click', function (e) {
    e.preventDefault();
    saveUser();
  });

  tokenOverlay.addEventListener('click', function (e) {
    if (e.target === tokenOverlay) closeTokenModal();
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
