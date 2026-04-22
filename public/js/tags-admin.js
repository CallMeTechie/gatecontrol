'use strict';

// Tags admin card — lives in the /settings "Allgemein" tab.
// Parallels peer-groups-admin.js but for the simpler Tags model (registry
// table + distinct-from-peers union). Exits early when the expected DOM
// isn't present so it's safe to include on any page.

(function () {
  var listEl = document.getElementById('tags-list');
  var addBtn = document.getElementById('btn-add-tag');
  var nameEl = document.getElementById('tag-name');
  var errorEl = document.getElementById('tag-error');
  if (!listEl && !addBtn) return;

  function t(key, fallback) {
    return (window.GC && window.GC.t && window.GC.t[key]) || fallback;
  }

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = '';
  }
  function hideError() {
    if (errorEl) errorEl.style.display = 'none';
  }

  function emptyState() {
    var el = document.createElement('div');
    el.style.cssText = 'font-size:12px;color:var(--text-3);padding:8px 0';
    el.textContent = t('tags.no_tags', 'Keine Tags vorhanden');
    return el;
  }

  function trashIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '3 6 5 6 21 6');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2');
    svg.appendChild(poly);
    svg.appendChild(path);
    return svg;
  }

  function buildRow(tag) {
    var row = document.createElement('div');
    row.dataset.tagName = tag.name;
    row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)';

    var name = document.createElement('span');
    name.className = 'tag tag-grey';
    name.style.cssText = 'font-size:12px;padding:2px 10px';
    name.textContent = tag.name;
    row.appendChild(name);

    // In-use vs orphan hint — registered-only entries are greyed to show
    // they're pre-registered but unused.
    var meta = document.createElement('span');
    meta.style.cssText = 'flex:1;font-size:11px;color:var(--text-3);font-family:var(--font-mono)';
    if (tag.peer_count > 0) {
      meta.textContent = tag.peer_count + ' peer' + (tag.peer_count === 1 ? '' : 's');
    } else {
      meta.textContent = t('tags.unused', 'ungenutzt');
      meta.style.opacity = '0.7';
    }
    row.appendChild(meta);

    // Tags used by peers are auto-registered in the tags registry on
    // create/update (and backfilled at server start), so every visible
    // tag is "registered" — no badge needed.

    var delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = t('common.delete', 'Löschen');
    delBtn.dataset.tagAction = 'delete';
    delBtn.dataset.tagName = tag.name;
    delBtn.appendChild(trashIcon());
    row.appendChild(delBtn);

    return row;
  }

  async function loadTags() {
    try {
      var data = await window.api.get('/api/tags');
      if (!data || !data.ok) return;
      clear(listEl);
      var arr = Array.isArray(data.tags) ? data.tags : [];
      if (!arr.length) {
        listEl.appendChild(emptyState());
        return;
      }
      arr.forEach(function (tag) {
        listEl.appendChild(buildRow(tag));
      });
    } catch (err) {
      console.error('tags: load failed', err);
    }
  }

  // Event delegation for the delete button, scoped to the list.
  if (listEl) {
    listEl.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-tag-action="delete"]');
      if (!btn) return;
      var name = btn.dataset.tagName;
      if (!name) return;
      var prompt = (t('tags.confirm_delete', 'Tag "{name}" aus allen Peers entfernen?')).replace('{name}', name);
      if (!confirm(prompt)) return;
      try {
        var res = await window.api.del('/api/tags/' + encodeURIComponent(name));
        if (res && res.ok) {
          if (typeof window.showToast === 'function') {
            var msg = (t('tags.deleted', 'Tag gelöscht ({n} Peers angepasst)')).replace('{n}', String(res.peers_affected || 0));
            window.showToast(msg, 'success');
          }
          loadTags();
        } else if (typeof window.showToast === 'function') {
          window.showToast((res && res.error) || 'Delete failed', 'error');
        }
      } catch (err) {
        if (typeof window.showToast === 'function') window.showToast(err.message, 'error');
      }
    });
  }

  // Add handler
  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var name = nameEl ? nameEl.value.trim() : '';
      if (!name) {
        showError(t('tags.error_name_required', 'Name erforderlich'));
        return;
      }
      hideError();
      if (typeof window.btnLoading === 'function') window.btnLoading(addBtn);
      try {
        var data = await window.api.post('/api/tags', { name: name });
        if (data && data.ok) {
          if (nameEl) nameEl.value = '';
          loadTags();
        } else {
          showError((data && data.error) || 'Create failed');
        }
      } catch (err) {
        showError(err.message);
      } finally {
        if (typeof window.btnReset === 'function') window.btnReset(addBtn);
      }
    });

    // Enter in the name input submits.
    if (nameEl) {
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addBtn.click();
        }
      });
    }
  }

  loadTags();
  setInterval(loadTags, 30000);
})();
