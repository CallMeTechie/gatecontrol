'use strict';

// Peer-Groups management card.
// Originally lived inside public/js/peers.js; extracted so the card can move
// to /settings while /peers still loads its own peer-specific JS. Exits
// early if the expected DOM isn't on the page — safe to include anywhere.

(function () {
  var pgList = document.getElementById('peer-groups-list');
  var btnAdd = document.getElementById('btn-add-peer-group');
  if (!pgList && !btnAdd) return;

  var groups = [];
  var editingId = null;

  function t(key, fallback) {
    return (window.GC && window.GC.t && window.GC.t[key]) || fallback;
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function safeColor(c) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : '#6b7280';
  }

  function iconBtn(action, id, title, svgInner) {
    var btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.title = title;
    btn.dataset.pgAction = action;
    if (id != null) btn.dataset.pgId = String(id);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svgInner.forEach(function(node) { svg.appendChild(node); });
    btn.appendChild(svg);
    return btn;
  }

  function svgPath(d) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    return p;
  }
  function svgPolyline(points) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p.setAttribute('points', points);
    return p;
  }
  function svgLine(x1, y1, x2, y2) {
    var l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    return l;
  }

  function buildDisplayRow(g) {
    var row = document.createElement('div');
    row.dataset.groupId = g.id;
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)';

    var dot = document.createElement('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;flex-shrink:0';
    dot.style.background = safeColor(g.color);

    var name = document.createElement('span');
    name.style.cssText = 'font-size:13px;font-weight:500;flex:1';
    name.textContent = g.name;

    row.appendChild(dot);
    row.appendChild(name);

    if (g.description) {
      var desc = document.createElement('span');
      desc.style.cssText = 'font-size:11px;color:var(--text-3);flex:1';
      desc.textContent = g.description;
      row.appendChild(desc);
    }

    var count = document.createElement('span');
    count.className = 'tag tag-grey';
    count.style.fontSize = '10px';
    count.textContent = (g.peer_count || 0) + ' peer(s)';
    row.appendChild(count);

    row.appendChild(iconBtn('edit', g.id, t('common.edit', 'Edit'), [
      svgPath('M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7'),
      svgPath('M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z'),
    ]));
    row.appendChild(iconBtn('delete', g.id, t('common.delete', 'Delete'), [
      svgPolyline('3 6 5 6 21 6'),
      svgPath('M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2'),
    ]));

    return row;
  }

  function buildEditRow(g) {
    var row = document.createElement('div');
    row.dataset.groupId = g.id;
    row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)';

    var color = document.createElement('input');
    color.type = 'color';
    color.className = 'pg-edit-color';
    color.value = safeColor(g.color);
    color.style.cssText = 'width:28px;height:28px;padding:1px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer';

    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'pg-edit-name';
    name.value = g.name || '';
    name.maxLength = 100;
    name.style.cssText = 'flex:1;padding:4px 8px;font-size:12px';

    var desc = document.createElement('input');
    desc.type = 'text';
    desc.className = 'pg-edit-desc';
    desc.value = g.description || '';
    desc.placeholder = t('peer_groups.description_placeholder', 'Description');
    desc.maxLength = 255;
    desc.style.cssText = 'flex:1;padding:4px 8px;font-size:12px';

    var save = iconBtn('save', g.id, t('common.save', 'Save'), [
      svgPolyline('20 6 9 17 4 12'),
    ]);
    save.style.color = 'var(--green)';

    var cancel = iconBtn('cancel', null, t('common.cancel', 'Cancel'), [
      svgLine('18', '6', '6', '18'),
      svgLine('6', '6', '18', '18'),
    ]);
    cancel.style.color = 'var(--text-3)';

    row.appendChild(color);
    row.appendChild(name);
    row.appendChild(desc);
    row.appendChild(save);
    row.appendChild(cancel);
    return row;
  }

  function render() {
    if (!pgList) return;
    clearChildren(pgList);

    if (!groups.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-3);padding:8px 0';
      empty.textContent = t('peer_groups.no_groups', 'No peer groups configured');
      pgList.appendChild(empty);
      return;
    }

    groups.forEach(function(g) {
      pgList.appendChild(editingId === g.id ? buildEditRow(g) : buildDisplayRow(g));
    });
  }

  async function loadGroups() {
    try {
      var data = await window.api.get('/api/peer-groups');
      if (data && data.ok) {
        groups = Array.isArray(data.groups) ? data.groups : [];
        render();
      }
    } catch (err) {
      console.error('peer-groups: load failed', err);
    }
  }

  // Event delegation for edit/cancel/save/delete buttons inside the card.
  // Scoped to the card to avoid conflicting with any other data-pg-action
  // listeners elsewhere (e.g. peers.js still carries its legacy code).
  var cardRoot = pgList ? pgList.closest('.card') : null;
  if (cardRoot) {
    cardRoot.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-pg-action]');
      if (!btn || !cardRoot.contains(btn)) return;
      var action = btn.dataset.pgAction;
      var id = btn.dataset.pgId ? parseInt(btn.dataset.pgId, 10) : null;

      if (action === 'edit') {
        editingId = id;
        render();
      } else if (action === 'cancel') {
        editingId = null;
        render();
      } else if (action === 'save' && id) {
        var row = btn.closest('[data-group-id]');
        if (!row) return;
        var nameEl = row.querySelector('.pg-edit-name');
        var colorEl = row.querySelector('.pg-edit-color');
        var descEl = row.querySelector('.pg-edit-desc');
        window.api.put('/api/peer-groups/' + id, {
          name: nameEl.value.trim(),
          color: colorEl.value,
          description: descEl.value.trim(),
        }).then(function(data) {
          if (data && data.ok) {
            editingId = null;
            loadGroups();
          } else if (typeof window.showToast === 'function') {
            window.showToast((data && data.error) || 'Save failed', 'error');
          } else {
            alert((data && data.error) || 'Save failed');
          }
        }).catch(function(err) {
          if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
          else alert(err.message);
        });
      } else if (action === 'delete' && id) {
        if (!confirm(t('peer_groups.confirm_delete', 'Delete this peer group?'))) return;
        window.api.del('/api/peer-groups/' + id).then(function(data) {
          if (data && data.ok) {
            loadGroups();
          } else if (typeof window.showToast === 'function') {
            window.showToast((data && data.error) || 'Delete failed', 'error');
          } else {
            alert((data && data.error) || 'Delete failed');
          }
        }).catch(function(err) {
          if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
          else alert(err.message);
        });
      }
    });
  }

  // Add button
  if (btnAdd) {
    btnAdd.addEventListener('click', async function() {
      var nameEl = document.getElementById('pg-name');
      var colorEl = document.getElementById('pg-color');
      var descEl = document.getElementById('pg-desc');
      var errorEl = document.getElementById('pg-error');
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) {
        if (errorEl) {
          errorEl.textContent = t('error.peer_groups.name_required', 'Group name is required');
          errorEl.style.display = '';
        }
        return;
      }
      if (errorEl) errorEl.style.display = 'none';
      if (typeof window.btnLoading === 'function') window.btnLoading(btnAdd);
      try {
        var data = await window.api.post('/api/peer-groups', {
          name: name,
          color: colorEl ? colorEl.value : '#6b7280',
          description: descEl ? descEl.value.trim() : '',
        });
        if (data && data.ok) {
          if (nameEl) nameEl.value = '';
          if (colorEl) colorEl.value = '#6b7280';
          if (descEl) descEl.value = '';
          loadGroups();
        } else if (errorEl) {
          errorEl.textContent = (data && data.error) || 'Create failed';
          errorEl.style.display = '';
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.style.display = '';
        }
      } finally {
        if (typeof window.btnReset === 'function') window.btnReset(btnAdd);
      }
    });
  }

  // Initial load + soft refresh (30s) so peer counts stay current.
  loadGroups();
  setInterval(loadGroups, 30000);
})();
