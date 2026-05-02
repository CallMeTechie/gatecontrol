'use strict';

const COOLDOWN_PRESETS = [
  { i18n: 'gateway_pools.preset_lxc', value: 60 },
  { i18n: 'gateway_pools.preset_linux_vm', value: 180 },
  { i18n: 'gateway_pools.preset_proxmox', value: 600 },
  { i18n: 'gateway_pools.preset_nas', value: 900 },
  { i18n: 'gateway_pools.preset_windows', value: 1800 },
  { i18n: 'gateway_pools.preset_conservative', value: 3600 },
  { i18n: 'gateway_pools.preset_custom', value: null },
];

function csrfToken() {
  return (typeof GC !== 'undefined' && GC.csrfToken) ? GC.csrfToken : '';
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() };
}
function tr(key, fallback) {
  return (window.GC && window.GC.t && window.GC.t[key]) || fallback || key;
}

async function createPool(data) {
  const r = await fetch('/api/v1/gateway-pools', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(data) });
  return r.json();
}

async function updatePool(id, data) {
  const r = await fetch('/api/v1/gateway-pools/' + id, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(data) });
  return r.json();
}

async function deletePool(id) {
  return fetch('/api/v1/gateway-pools/' + id, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken() } });
}

// Replace the full member set in one atomic call. The server triggers a single
// caddy sync + companion confirm at the end (vs. one per add/remove if we
// looped client-side), which matters for pools with 3+ gateways.
async function replaceMembers(poolId, members) {
  const r = await fetch('/api/v1/gateway-pools/' + poolId + '/members', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(members),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.json().catch(() => ({})) };
}

// ── Source-of-truth for the gateway dropdown ──────────────────────────────
// Pool-members are kept entirely client-side until the user hits Save. To
// know which gateways are "still pickable" we need the full peer list
// (server-rendered on first load) plus the current member set in the DOM.
// The select is rebuilt on every add/remove/edit-modal-open from this list.
const ALL_GATEWAY_PEERS = [];

function snapshotInitialPeers() {
  if (ALL_GATEWAY_PEERS.length > 0) return;
  const sel = document.getElementById('new-member-peer');
  if (!sel) return;
  for (const opt of sel.options) {
    if (opt.value) ALL_GATEWAY_PEERS.push({ id: parseInt(opt.value, 10), name: opt.textContent });
  }
}

function getCurrentMemberPeerIds() {
  const container = document.getElementById('pool-members');
  if (!container) return new Set();
  const ids = new Set();
  container.querySelectorAll('.pool-member-row').forEach(function(row) {
    ids.add(parseInt(row.dataset.peerId, 10));
  });
  return ids;
}

function rebuildPeerDropdown() {
  const sel = document.getElementById('new-member-peer');
  if (!sel) return;
  const taken = getCurrentMemberPeerIds();
  const previousValue = parseInt(sel.value, 10);
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const available = ALL_GATEWAY_PEERS.filter(function(p) { return !taken.has(p.id); });
  if (available.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = sel.dataset.allEmptyText || tr('gateway_pools.no_more_gateways', 'All gateways already assigned');
    opt.disabled = true;
    sel.appendChild(opt);
    sel.disabled = true;
    const btn = document.getElementById('btn-add-member');
    if (btn) btn.disabled = true;
    return;
  }
  sel.disabled = false;
  const btn = document.getElementById('btn-add-member');
  if (btn) btn.disabled = false;
  available.forEach(function(p) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  // Best-effort: keep the user's prior selection if it's still available.
  if (previousValue && available.some(function(p) { return p.id === previousValue; })) {
    sel.value = String(previousValue);
  }
}

// ── Member row rendering (drag-and-drop ordered list) ────────────────────
function buildMemberRow(peerId, peerName) {
  const row = document.createElement('div');
  row.className = 'pool-member-row';
  row.dataset.peerId = String(peerId);
  row.draggable = true;

  const handle = document.createElement('span');
  handle.className = 'pool-member-handle';
  handle.textContent = '≡'; // ≡
  handle.setAttribute('aria-hidden', 'true');

  const pos = document.createElement('span');
  pos.className = 'pool-member-position';
  pos.textContent = '#1';

  const name = document.createElement('span');
  name.className = 'pool-member-name';
  name.textContent = peerName || ('Peer #' + peerId);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-sm btn-danger btn-remove-member';
  removeBtn.dataset.peerId = String(peerId);
  removeBtn.textContent = '×'; // ×
  removeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    row.remove();
    refreshPositions();
    rebuildPeerDropdown();
  });

  row.appendChild(handle);
  row.appendChild(pos);
  row.appendChild(name);
  row.appendChild(removeBtn);

  attachDragHandlers(row);
  return row;
}

function refreshPositions() {
  const container = document.getElementById('pool-members');
  if (!container) return;
  const rows = container.querySelectorAll('.pool-member-row');
  rows.forEach(function(row, i) {
    const pos = row.querySelector('.pool-member-position');
    if (pos) pos.textContent = '#' + (i + 1);
  });
}

// ── Native HTML5 drag-and-drop reorder ────────────────────────────────────
// We use HTML5 DnD instead of pulling in a library — the row count is small
// (typically 2–5) so the simpler implementation wins. Edge cases handled:
// dropping on the upper vs. lower half decides insertBefore vs. after, and
// dragging a row onto itself is a no-op.
let DRAG_SRC = null;

function attachDragHandlers(row) {
  row.addEventListener('dragstart', function(e) {
    DRAG_SRC = row;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox needs setData to start the drag.
      try { e.dataTransfer.setData('text/plain', row.dataset.peerId); } catch (_) {}
    }
  });
  row.addEventListener('dragend', function() {
    row.classList.remove('dragging');
    document.querySelectorAll('.pool-member-row').forEach(function(r) {
      r.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    DRAG_SRC = null;
  });
  row.addEventListener('dragover', function(e) {
    if (!DRAG_SRC || DRAG_SRC === row) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const halfway = rect.top + rect.height / 2;
    row.classList.toggle('drag-over-top', e.clientY < halfway);
    row.classList.toggle('drag-over-bottom', e.clientY >= halfway);
  });
  row.addEventListener('dragleave', function() {
    row.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  row.addEventListener('drop', function(e) {
    e.preventDefault();
    if (!DRAG_SRC || DRAG_SRC === row) return;
    const rect = row.getBoundingClientRect();
    const dropAfter = e.clientY >= rect.top + rect.height / 2;
    if (dropAfter) row.parentNode.insertBefore(DRAG_SRC, row.nextSibling);
    else row.parentNode.insertBefore(DRAG_SRC, row);
    row.classList.remove('drag-over-top', 'drag-over-bottom');
    refreshPositions();
  });
}

function renderMembersInForm(members) {
  const container = document.getElementById('pool-members');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!members || members.length === 0) return;
  // Server already returned them sorted by priority ASC; we keep that order
  // since the user-visible position IS the priority.
  members.forEach(function(m) {
    const peer = ALL_GATEWAY_PEERS.find(function(p) { return p.id === m.peer_id; });
    container.appendChild(buildMemberRow(m.peer_id, peer ? peer.name : (m.peer_name || 'Peer #' + m.peer_id)));
  });
  refreshPositions();
}

function collectMembersFromForm() {
  const container = document.getElementById('pool-members');
  if (!container) return [];
  const rows = container.querySelectorAll('.pool-member-row');
  return Array.from(rows).map(function(row, i) {
    return { peer_id: parseInt(row.dataset.peerId, 10), priority: i + 1 };
  });
}

// Cooldown preset dropdown — idempotent (clears previous options on re-init)
function initCooldownPresets() {
  const sel = document.getElementById('cooldown-preset');
  if (!sel) return;
  while (sel.firstChild) sel.removeChild(sel.firstChild);

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '---';
  sel.appendChild(placeholder);
  COOLDOWN_PRESETS.forEach(function(p) {
    const label = (window.GC && window.GC.t && window.GC.t[p.i18n]) || p.i18n;
    const opt = document.createElement('option');
    opt.value = p.value != null ? String(p.value) : '';
    opt.textContent = label;
    sel.appendChild(opt);
  });

  if (!sel.dataset.presetListenerAttached) {
    sel.addEventListener('change', function() {
      const v = sel.value;
      const inp = document.querySelector('input[name="failback_cooldown_s"]');
      if (v && inp) inp.value = v;
    });
    sel.dataset.presetListenerAttached = '1';
  }
}

// Mode toggle: show/hide lb_policy row.
function initModeToggle() {
  const modeSel = document.querySelector('select[name="mode"]');
  const lbRow = document.querySelector('.lb-policy-row');
  if (!modeSel || !lbRow) return;
  const update = function() { lbRow.style.display = modeSel.value === 'load_balancing' ? '' : 'none'; };
  if (!modeSel.dataset.modeListenerAttached) {
    modeSel.addEventListener('change', update);
    modeSel.dataset.modeListenerAttached = '1';
  }
  update();
}

function openCreateModal() {
  snapshotInitialPeers();
  const modal = document.getElementById('pool-form-modal');
  document.getElementById('pool-form').reset();
  document.querySelector('input[name="id"]').value = '';
  const titleEl = document.getElementById('pool-form-title');
  if (titleEl) titleEl.textContent = (window.GC && window.GC.t && window.GC.t['gateway_pools.create']) || 'Create Pool';
  renderMembersInForm([]);
  rebuildPeerDropdown();
  modal.style.display = 'flex';
  initModeToggle();
  initCooldownPresets();
}

function openEditModal(pool, members) {
  snapshotInitialPeers();
  const modal = document.getElementById('pool-form-modal');
  const form = document.getElementById('pool-form');
  form.reset();
  form.querySelector('input[name="id"]').value = pool.id;
  form.querySelector('input[name="name"]').value = pool.name || '';
  form.querySelector('select[name="mode"]').value = pool.mode || 'failover';
  const lbPol = form.querySelector('select[name="lb_policy"]');
  if (lbPol) lbPol.value = pool.lb_policy || 'round_robin';
  form.querySelector('input[name="failback_cooldown_s"]').value = pool.failback_cooldown_s != null ? pool.failback_cooldown_s : 60;
  const outage = form.querySelector('textarea[name="outage_message"]');
  if (outage) outage.value = pool.outage_message || '';
  const titleEl = document.getElementById('pool-form-title');
  if (titleEl) titleEl.textContent = (window.GC && window.GC.t && window.GC.t['gateway_pools.edit']) || 'Edit Pool';
  renderMembersInForm(members);
  rebuildPeerDropdown();
  modal.style.display = 'flex';
  initModeToggle();
  initCooldownPresets();
}

function closeFormModal() {
  document.getElementById('pool-form-modal').style.display = 'none';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const data = Object.fromEntries(fd);
  data.failback_cooldown_s = parseInt(data.failback_cooldown_s, 10);
  if (data.mode !== 'load_balancing') delete data.lb_policy;
  if (!data.outage_message) delete data.outage_message;
  const id = data.id;
  delete data.id;

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    let poolId;
    let result;
    if (id) {
      result = await updatePool(id, data);
      poolId = parseInt(id, 10);
      if (result && result.error) throw new Error(result.error);
    } else {
      result = await createPool(data);
      if (!result || !result.id) throw new Error((result && result.error) || 'create_failed');
      poolId = result.id;
    }

    // Persist the member list (in DOM order = priority order). This call is
    // what was missing before — without it the form changes never reached
    // the server and pools were created/updated empty.
    const members = collectMembersFromForm();
    const memberRes = await replaceMembers(poolId, members);
    if (!memberRes.ok) {
      throw new Error((memberRes.body && memberRes.body.error) || ('member_save_failed_' + memberRes.status));
    }

    closeFormModal();
    location.reload();
  } catch (err) {
    alert(tr('gateway_pools.save_failed', 'Save failed') + ': ' + (err.message || err));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleDelete(poolId) {
  if (!confirm(tr('gateway_pools.confirm_delete', 'Delete pool?'))) return;
  const r = await deletePool(poolId);
  if (r.ok || r.status === 204) location.reload();
  else {
    const j = await r.json().catch(function() { return {}; });
    alert(tr('common.error', 'Error') + ': ' + (j.error || r.status));
  }
}

async function handleEditClick(poolId) {
  try {
    const [poolsRes, membersRes] = await Promise.all([
      fetch('/api/v1/gateway-pools'),
      fetch('/api/v1/gateway-pools/' + poolId + '/members'),
    ]);
    const pools = await poolsRes.json();
    const members = await membersRes.json();
    const pool = Array.isArray(pools) ? pools.find(function(p) { return String(p.id) === String(poolId); }) : null;
    if (pool) openEditModal(pool, Array.isArray(members) ? members : []);
  } catch (err) {
    alert('Failed to load pool data');
  }
}

// ── Migrate-routes modal ───────────────────────────────────────────────────
// Lets the user move existing gateway-pinned routes onto a pool. Without
// this, creating a pool has no effect on traffic — routes still resolve
// to a fixed peer and fail when that peer goes down. Each route gets its
// own checkbox because some are intentionally bound to one gateway
// (e.g. ssh.* targeting 127.0.0.1 means "shell on THAT machine"); we
// can't safely migrate-all.
let MIGRATE_CANDIDATES = { routes: [], pools: [] };

function openMigrateModal() {
  const modal = document.getElementById('pool-migrate-modal');
  modal.style.display = 'flex';
  const list = document.getElementById('migrate-routes-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const loading = document.createElement('p');
  loading.style.color = 'var(--text-3)';
  loading.textContent = 'Loading…';
  list.appendChild(loading);

  fetch('/api/v1/gateway-pools/migration-candidates')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      MIGRATE_CANDIDATES = data || { routes: [], pools: [] };
      renderMigrateForm();
    })
    .catch(function() {
      while (list.firstChild) list.removeChild(list.firstChild);
      const p = document.createElement('p');
      p.style.color = 'var(--red)';
      p.textContent = 'Failed to load migration candidates.';
      list.appendChild(p);
    });
}

function renderMigrateForm() {
  const list = document.getElementById('migrate-routes-list');
  while (list.firstChild) list.removeChild(list.firstChild);

  const pools = MIGRATE_CANDIDATES.pools || [];
  const routes = MIGRATE_CANDIDATES.routes || [];

  if (pools.length === 0) {
    const p = document.createElement('p');
    p.style.color = 'var(--text-3)';
    p.textContent = tr('gateway_pools.no_pools_for_migration', 'No pools available — create a pool first.');
    list.appendChild(p);
    return;
  }

  const help = document.createElement('p');
  help.style.cssText = 'font-size:13px;margin-bottom:12px;color:var(--text-2)';
  help.textContent = tr('gateway_pools.migrate_help',
    'Assign existing gateway routes to a pool so traffic fails over when the pinned gateway goes down.');
  list.appendChild(help);

  // Pool picker
  const poolGroup = document.createElement('div');
  poolGroup.className = 'form-group';
  const poolLbl = document.createElement('label');
  poolLbl.className = 'form-label';
  poolLbl.textContent = tr('gateway_pools.target_pool', 'Target pool');
  const poolSel = document.createElement('select');
  poolSel.id = 'migrate-target-pool';
  poolSel.className = 'form-input';
  pools.forEach(function(pool) {
    const opt = document.createElement('option');
    opt.value = pool.id;
    opt.textContent = pool.name + ' (' + pool.mode + ')';
    poolSel.appendChild(opt);
  });
  poolGroup.appendChild(poolLbl);
  poolGroup.appendChild(poolSel);
  list.appendChild(poolGroup);

  if (routes.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:var(--text-3);margin-top:12px';
    p.textContent = tr('gateway_pools.migrate_no_routes', 'No gateway-pinned routes to migrate.');
    list.appendChild(p);
    return;
  }

  // Route checklist grouped by source peer
  const grouped = {};
  routes.forEach(function(r) {
    const key = r.peer_name || ('Peer #' + r.target_peer_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  const listLbl = document.createElement('label');
  listLbl.className = 'form-label';
  listLbl.style.marginTop = '12px';
  listLbl.textContent = tr('gateway_pools.migrate_routes_label', 'Routes to migrate');
  list.appendChild(listLbl);

  // Select-all / select-none controls
  const ctrl = document.createElement('div');
  ctrl.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;font-size:12px';
  const selAll = document.createElement('a');
  selAll.href = '#';
  selAll.textContent = tr('gateway_pools.select_all', 'Select all');
  selAll.addEventListener('click', function(e) {
    e.preventDefault();
    list.querySelectorAll('input[name="migrate-route"]').forEach(function(c) { c.checked = true; });
  });
  const selNone = document.createElement('a');
  selNone.href = '#';
  selNone.textContent = tr('gateway_pools.select_none', 'Select none');
  selNone.addEventListener('click', function(e) {
    e.preventDefault();
    list.querySelectorAll('input[name="migrate-route"]').forEach(function(c) { c.checked = false; });
  });
  ctrl.appendChild(selAll);
  ctrl.appendChild(document.createTextNode(' · '));
  ctrl.appendChild(selNone);
  list.appendChild(ctrl);

  Object.keys(grouped).forEach(function(peerName) {
    const groupHeader = document.createElement('div');
    groupHeader.style.cssText = 'font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.05em;margin-top:8px;margin-bottom:4px';
    groupHeader.textContent = peerName;
    list.appendChild(groupHeader);

    grouped[peerName].forEach(function(r) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer';
      row.addEventListener('mouseenter', function() { row.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))'; });
      row.addEventListener('mouseleave', function() { row.style.background = ''; });

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = 'migrate-route';
      cb.value = String(r.id);
      // Default-uncheck loopback routes — moving "ssh.*→127.0.0.1" to a pool
      // means the upstream changes machine on failover, which is rarely
      // desired. User can opt-in by checking manually.
      const isLoopback = r.target_ip === '127.0.0.1' || r.target_ip === '::1' || r.target_ip === 'localhost';
      cb.checked = !isLoopback;

      const label = document.createElement('span');
      label.style.cssText = 'flex:1;font-size:13px';
      const domSpan = document.createElement('strong');
      domSpan.textContent = r.domain;
      const tgtSpan = document.createElement('span');
      tgtSpan.style.cssText = 'color:var(--text-3);font-family:var(--font-mono);font-size:11px;margin-left:8px';
      tgtSpan.textContent = '→ ' + r.target_ip + ':' + r.target_port;
      label.appendChild(domSpan);
      label.appendChild(tgtSpan);

      if (isLoopback) {
        const warn = document.createElement('span');
        warn.style.cssText = 'color:var(--orange,#f59e0b);font-size:11px;margin-left:8px';
        warn.textContent = '⚠ ' + tr('gateway_pools.migrate_loopback_warn', 'loopback — verify before migrating');
        label.appendChild(warn);
      }

      row.appendChild(cb);
      row.appendChild(label);
      list.appendChild(row);
    });
  });
}

function closeMigrateModal() {
  document.getElementById('pool-migrate-modal').style.display = 'none';
}

async function handleMigrateSubmit() {
  const poolSel = document.getElementById('migrate-target-pool');
  if (!poolSel || !poolSel.value) {
    alert(tr('gateway_pools.no_pools_for_migration', 'No pools available'));
    return;
  }
  const poolId = parseInt(poolSel.value, 10);
  const checked = Array.from(document.querySelectorAll('input[name="migrate-route"]:checked'))
    .map(function(c) { return parseInt(c.value, 10); });
  if (checked.length === 0) {
    alert(tr('gateway_pools.migrate_no_selection', 'Select at least one route to migrate'));
    return;
  }
  const btn = document.getElementById('btn-migrate-submit');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/v1/gateway-pools/' + poolId + '/migrate-routes', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ route_ids: checked }),
    });
    const body = await r.json().catch(function() { return {}; });
    if (!r.ok) throw new Error(body.error || ('http_' + r.status));
    closeMigrateModal();
    location.reload();
  } catch (err) {
    alert(tr('gateway_pools.save_failed', 'Save failed') + ': ' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleAddMemberClick() {
  const peerSel = document.getElementById('new-member-peer');
  if (!peerSel || !peerSel.value) return;
  const peerId = parseInt(peerSel.value, 10);
  const peerName = peerSel.options[peerSel.selectedIndex] ? peerSel.options[peerSel.selectedIndex].text : ('Peer #' + peerId);
  const container = document.getElementById('pool-members');
  if (!container) return;
  if (container.querySelector('[data-peer-id="' + peerId + '"]')) return;
  container.appendChild(buildMemberRow(peerId, peerName));
  refreshPositions();
  rebuildPeerDropdown();
}

function initEventListeners() {
  document.getElementById('btn-create-pool')?.addEventListener('click', openCreateModal);
  document.getElementById('btn-cancel-pool')?.addEventListener('click', closeFormModal);
  document.getElementById('btn-cancel-pool-footer')?.addEventListener('click', closeFormModal);
  document.getElementById('pool-form')?.addEventListener('submit', handleFormSubmit);

  document.getElementById('btn-migrate-routes')?.addEventListener('click', openMigrateModal);
  document.getElementById('btn-migrate-cancel')?.addEventListener('click', closeMigrateModal);
  document.getElementById('btn-migrate-cancel-footer')?.addEventListener('click', closeMigrateModal);
  document.getElementById('btn-migrate-submit')?.addEventListener('click', handleMigrateSubmit);

  document.querySelectorAll('.btn-delete-pool').forEach(function(btn) {
    btn.addEventListener('click', function() { handleDelete(btn.dataset.poolId); });
  });

  document.querySelectorAll('.btn-edit-pool').forEach(function(btn) {
    btn.addEventListener('click', function() { handleEditClick(btn.dataset.poolId); });
  });

  document.getElementById('btn-add-member')?.addEventListener('click', handleAddMemberClick);
}

document.addEventListener('DOMContentLoaded', function() {
  snapshotInitialPeers();
  initCooldownPresets();
  initModeToggle();
  initEventListeners();
});
