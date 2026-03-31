'use strict';

// Note: btn.innerHTML usage below is safe - only hardcoded SVG paths are inserted, no user input.

(function () {
  var tokensList = document.getElementById('tokens-list');
  if (!tokensList) return;

  // ─── Full-access master toggle ─────────────────────────
  var fullAccessCb = document.getElementById('scope-full-access');
  var resourceCbs = document.querySelectorAll('.token-scope-resource');
  var resourceSection = document.getElementById('token-scope-resources');

  if (fullAccessCb) {
    fullAccessCb.addEventListener('change', function () {
      resourceCbs.forEach(function (cb) {
        cb.checked = fullAccessCb.checked;
        cb.disabled = fullAccessCb.checked;
      });
      if (resourceSection) {
        resourceSection.style.opacity = fullAccessCb.checked ? '0.5' : '1';
      }
      updateClientSubScopes();
    });
  }

  // ─── Client scope → sub-scopes toggle ─────────────────
  var clientCb = document.getElementById('scope-client');
  var clientSubScopes = document.getElementById('client-sub-scopes');
  var clientSubCbs = document.querySelectorAll('.token-scope-client-sub');

  function updateClientSubScopes() {
    if (!clientCb || !clientSubScopes) return;
    var enabled = clientCb.checked && !clientCb.disabled;
    clientSubScopes.style.display = clientCb.checked ? '' : 'none';
    clientSubCbs.forEach(function (cb) {
      if (!enabled) {
        cb.checked = false;
        cb.disabled = true;
      } else {
        cb.disabled = false;
      }
    });
  }

  if (clientCb) {
    clientCb.addEventListener('change', updateClientSubScopes);
    updateClientSubScopes();
  }

  // ─── Expiry select toggle ──────────────────────────────
  var expiresSelect = document.getElementById('token-expires');
  var expiresCustom = document.getElementById('token-expires-custom');

  if (expiresSelect) {
    expiresSelect.addEventListener('change', function () {
      expiresCustom.style.display = expiresSelect.value === 'custom' ? '' : 'none';
    });
  }

  // ─── Load tokens ────────────────────────────────────────
  async function loadTokens() {
    try {
      var data = await api.get('/api/v1/tokens');
      if (data.ok) renderTokens(data.tokens);
    } catch (err) {
      console.error('Failed to load tokens:', err);
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderTokens(tokens) {
    if (!tokens || tokens.length === 0) {
      tokensList.textContent = '';
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);text-align:center;padding:8px 0';
      empty.textContent = GC.t['tokens.no_tokens'] || 'No API tokens configured';
      tokensList.appendChild(empty);
      return;
    }

    tokensList.textContent = '';
    tokens.forEach(function (tk) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';
      row.dataset.tokenId = tk.id;

      var info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      var nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-size:12px;font-weight:600';
      nameEl.textContent = tk.name;
      info.appendChild(nameEl);

      var scopesEl = document.createElement('div');
      scopesEl.style.cssText = 'font-size:10px;color:var(--text-3);margin-top:2px;display:flex;flex-wrap:wrap;gap:4px';
      (tk.scopes || []).forEach(function (s) {
        var badge = document.createElement('span');
        badge.style.cssText = 'padding:1px 6px;background:var(--bg-2);border-radius:3px;font-family:var(--font-mono)';
        badge.textContent = s;
        scopesEl.appendChild(badge);
      });
      info.appendChild(scopesEl);

      var metaEl = document.createElement('div');
      metaEl.style.cssText = 'font-size:10px;color:var(--text-3);margin-top:3px';
      var createdLabel = GC.t['tokens.created'] || 'Created';
      var lastUsedLabel = GC.t['tokens.last_used'] || 'Last used';
      var neverLabel = GC.t['tokens.last_used_never'] || 'Never';
      var expiresLabel = GC.t['tokens.expires'] || 'Expires';
      metaEl.textContent = createdLabel + ': ' + formatDate(tk.created_at) + ' | ' +
        lastUsedLabel + ': ' + (tk.last_used_at ? formatDate(tk.last_used_at) : neverLabel);
      if (tk.expires_at) {
        metaEl.textContent += ' | ' + expiresLabel + ': ' + formatDate(tk.expires_at);
      }
      info.appendChild(metaEl);

      row.appendChild(info);

      // Check if expired
      var isExpired = tk.expires_at && new Date(tk.expires_at) <= new Date();
      if (isExpired) {
        var expTag = document.createElement('span');
        expTag.className = 'tag tag-red';
        expTag.style.fontSize = '10px';
        expTag.textContent = 'Expired';
        row.appendChild(expTag);
      }

      var delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.title = GC.t['tokens.revoke'] || 'Revoke';
      delBtn.dataset.tokenAction = 'delete';
      delBtn.dataset.tokenId = tk.id;
      delBtn.style.cssText = 'width:24px;height:24px;flex-shrink:0';
      // Safe: only hardcoded SVG, no user input
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      var polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', '3 6 5 6 21 6');
      svg.appendChild(polyline);
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2');
      svg.appendChild(path);
      delBtn.appendChild(svg);
      row.appendChild(delBtn);

      tokensList.appendChild(row);
    });
  }

  // ─── Token list actions ──────────────────────────────────
  tokensList.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-token-action]');
    if (!btn) return;
    var action = btn.dataset.tokenAction;
    var id = btn.dataset.tokenId;

    if (action === 'delete') {
      try {
        await api.del('/api/v1/tokens/' + id);
        loadTokens();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  });

  // ─── Create token ────────────────────────────────────────
  var btnCreate = document.getElementById('btn-create-token');
  if (btnCreate) {
    btnCreate.addEventListener('click', async function () {
      var name = document.getElementById('token-name').value.trim();
      if (!name) {
        showMessage('tokens-message', GC.t['error.tokens.name_required'] || 'Token name is required', 'error');
        return;
      }

      // Collect scopes — full-access alone is sufficient
      var scopes = [];
      if (fullAccessCb && fullAccessCb.checked) {
        scopes.push('full-access');
      } else {
        document.querySelectorAll('.token-scope-cb:checked').forEach(function (cb) {
          scopes.push(cb.value);
        });
      }
      if (scopes.length === 0) {
        showMessage('tokens-message', GC.t['error.tokens.scopes_required'] || 'At least one scope is required', 'error');
        return;
      }

      // Calculate expiry
      var expiresVal = expiresSelect.value;
      var expiresAt = null;
      if (expiresVal === '30d') {
        expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      } else if (expiresVal === '90d') {
        expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
      } else if (expiresVal === '1y') {
        expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
      } else if (expiresVal === 'custom') {
        var customDate = expiresCustom.value;
        if (!customDate) {
          showMessage('tokens-message', 'Please select an expiry date', 'error');
          return;
        }
        expiresAt = new Date(customDate + 'T23:59:59').toISOString();
      }

      btnLoading(btnCreate);
      try {
        var data = await api.post('/api/v1/tokens', {
          name: name,
          scopes: scopes,
          expires_at: expiresAt,
        });

        if (data.ok) {
          // Show the raw token (only shown once)
          var resultEl = document.getElementById('token-created-result');
          resultEl.textContent = '';
          resultEl.style.cssText = 'display:block;padding:10px;border-radius:6px;background:var(--green-bg);border:1px solid var(--green-bd)';

          var msgEl = document.createElement('div');
          msgEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--green);margin-bottom:6px';
          msgEl.textContent = GC.t['tokens.created_success'] || 'Token created successfully. Copy it now — it won\'t be shown again!';
          resultEl.appendChild(msgEl);

          var tokenBox = document.createElement('div');
          tokenBox.style.cssText = 'display:flex;gap:6px;align-items:center';

          var tokenInput = document.createElement('input');
          tokenInput.type = 'text';
          tokenInput.readOnly = true;
          tokenInput.value = data.token;
          tokenInput.style.cssText = 'flex:1;font-family:var(--font-mono);font-size:11px;padding:6px 8px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-xs)';
          tokenBox.appendChild(tokenInput);

          var copyBtn = document.createElement('button');
          copyBtn.className = 'btn btn-ghost';
          copyBtn.style.cssText = 'font-size:11px;padding:6px 10px;flex-shrink:0';
          copyBtn.textContent = GC.t['tokens.copy_token'] || 'Copy Token';
          copyBtn.addEventListener('click', function () {
            navigator.clipboard.writeText(data.token).then(function () {
              copyBtn.textContent = GC.t['tokens.token_copied'] || 'Copied!';
              setTimeout(function () {
                copyBtn.textContent = GC.t['tokens.copy_token'] || 'Copy Token';
              }, 2000);
            });
          });
          tokenBox.appendChild(copyBtn);

          resultEl.appendChild(tokenBox);

          // Reset form
          document.getElementById('token-name').value = '';
          document.querySelectorAll('.token-scope-cb').forEach(function (cb) { cb.checked = false; cb.disabled = false; });
          if (resourceSection) resourceSection.style.opacity = '1';
          expiresSelect.value = '';
          expiresCustom.style.display = 'none';

          loadTokens();
        } else {
          showMessage('tokens-message', data.error || 'Failed to create token', 'error');
        }
      } catch (err) {
        showMessage('tokens-message', err.message, 'error');
      } finally {
        btnReset(btnCreate);
      }
    });
  }

  // ─── Init ────────────────────────────────────────────────
  loadTokens();
})();
