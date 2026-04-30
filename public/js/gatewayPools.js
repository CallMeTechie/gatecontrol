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

function csrfHeaders() {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken || '' };
}

async function createPool(data) {
  const r = await fetch('/api/v1/gateway-pools', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(data) });
  return r.json();
}

async function updatePool(id, data) {
  const r = await fetch('/api/v1/gateway-pools/' + id, { method: 'PUT', headers: csrfHeaders(), body: JSON.stringify(data) });
  return r.json();
}

async function deletePool(id) {
  return fetch('/api/v1/gateway-pools/' + id, { method: 'DELETE', headers: { 'X-CSRF-Token': window.csrfToken || '' } });
}

async function addMember(poolId, peerId, priority) {
  return fetch('/api/v1/gateway-pools/' + poolId + '/members', { method: 'POST', headers: csrfHeaders(), body: JSON.stringify({ peer_id: peerId, priority }) });
}

async function removeMember(poolId, peerId) {
  return fetch('/api/v1/gateway-pools/' + poolId + '/members/' + peerId, { method: 'DELETE', headers: { 'X-CSRF-Token': window.csrfToken || '' } });
}

// Cooldown preset dropdown
function initCooldownPresets() {
  const sel = document.getElementById('cooldown-preset');
  if (!sel) return;
  const opts = COOLDOWN_PRESETS.map(function(p) {
    const label = (window.GC && window.GC.t && window.GC.t[p.i18n]) || p.i18n;
    const opt = document.createElement('option');
    opt.value = p.value != null ? String(p.value) : '';
    opt.textContent = label;
    return opt;
  });
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '---';
  sel.appendChild(placeholder);
  opts.forEach(function(o) { sel.appendChild(o); });
  sel.addEventListener('change', function() {
    const v = sel.value;
    const inp = document.querySelector('input[name="failback_cooldown_s"]');
    if (v && inp) inp.value = v;
  });
}

// Mode toggle: show/hide lb_policy row
function initModeToggle() {
  const modeSel = document.querySelector('select[name="mode"]');
  const lbRow = document.querySelector('.lb-policy-row');
  if (!modeSel || !lbRow) return;
  const update = function() { lbRow.style.display = modeSel.value === 'load_balancing' ? '' : 'none'; };
  modeSel.addEventListener('change', update);
  update();
}

// Render current members list inside form using DOM methods
function renderMembersInForm(members) {
  const container = document.getElementById('pool-members');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!members || members.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-3);font-size:12px';
    empty.textContent = '—';
    container.appendChild(empty);
    return;
  }
  members.forEach(function(m) {
    const row = document.createElement('div');
    row.className = 'pool-member-row';
    row.dataset.peerId = m.peer_id;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    nameSpan.textContent = m.peer_name || m.peer_id;

    const prioInput = document.createElement('input');
    prioInput.type = 'number';
    prioInput.className = 'pool-member-priority-input form-input';
    prioInput.value = m.priority;
    prioInput.dataset.peerId = m.peer_id;
    prioInput.style.width = '70px';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-danger btn-remove-member';
    removeBtn.dataset.peerId = m.peer_id;
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', function() { row.remove(); });

    row.appendChild(nameSpan);
    row.appendChild(prioInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function openCreateModal() {
  const modal = document.getElementById('pool-form-modal');
  document.getElementById('pool-form').reset();
  document.querySelector('input[name="id"]').value = '';
  const titleEl = document.getElementById('pool-form-title');
  if (titleEl) titleEl.textContent = (window.GC && window.GC.t && window.GC.t['gateway_pools.create']) || 'Create Pool';
  renderMembersInForm([]);
  modal.style.display = 'flex';
  initModeToggle();
  initCooldownPresets();
}

function openEditModal(pool, members) {
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
  let result;
  if (id) {
    result = await updatePool(id, data);
  } else {
    result = await createPool(data);
  }
  if (result && (result.id || result.ok)) {
    closeFormModal();
    location.reload();
  } else {
    alert('Error: ' + ((result && result.error) || 'unknown'));
  }
}

async function handleDelete(poolId) {
  if (!confirm('Delete pool?')) return;
  const r = await deletePool(poolId);
  if (r.ok || r.status === 204) location.reload();
  else {
    const j = await r.json();
    alert('Error: ' + j.error);
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

function openMigrateModal() {
  const modal = document.getElementById('pool-migrate-modal');
  modal.style.display = 'flex';
  const list = document.getElementById('migrate-routes-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const loadingP = document.createElement('p');
  loadingP.style.color = 'var(--text-3)';
  loadingP.textContent = 'Loading routes...';
  list.appendChild(loadingP);

  fetch('/api/v1/gateway-pools')
    .then(function(r) { return r.json(); })
    .then(function(pools) {
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!pools || pools.length === 0) {
        const p = document.createElement('p');
        p.style.color = 'var(--text-3)';
        p.textContent = 'No pools available. Create a pool first.';
        list.appendChild(p);
        return;
      }
      const helpText = (window.GC && window.GC.t && window.GC.t['gateway_pools.migrate_help']) || 'Assign existing gateway routes to a pool.';
      const p = document.createElement('p');
      p.style.cssText = 'font-size:13px;margin-bottom:12px';
      p.textContent = helpText;
      list.appendChild(p);

      const group = document.createElement('div');
      group.className = 'form-group';

      const lbl = document.createElement('label');
      lbl.className = 'form-label';
      lbl.textContent = (window.GC && window.GC.t && window.GC.t['gateway_pools.target_pool']) || 'Target pool';

      const sel = document.createElement('select');
      sel.id = 'migrate-target-pool';
      sel.className = 'form-input';
      pools.forEach(function(pool) {
        const opt = document.createElement('option');
        opt.value = pool.id;
        opt.textContent = pool.name;
        sel.appendChild(opt);
      });

      group.appendChild(lbl);
      group.appendChild(sel);
      list.appendChild(group);
    })
    .catch(function() {
      while (list.firstChild) list.removeChild(list.firstChild);
      const p = document.createElement('p');
      p.style.color = 'var(--red)';
      p.textContent = 'Failed to load pools.';
      list.appendChild(p);
    });
}

function closeMigrateModal() {
  document.getElementById('pool-migrate-modal').style.display = 'none';
}

function initEventListeners() {
  document.getElementById('btn-create-pool')?.addEventListener('click', openCreateModal);
  document.getElementById('btn-cancel-pool')?.addEventListener('click', closeFormModal);
  document.getElementById('btn-cancel-pool-footer')?.addEventListener('click', closeFormModal);
  document.getElementById('pool-form')?.addEventListener('submit', handleFormSubmit);

  document.getElementById('btn-migrate-routes')?.addEventListener('click', openMigrateModal);
  document.getElementById('btn-migrate-cancel')?.addEventListener('click', closeMigrateModal);
  document.getElementById('btn-migrate-cancel-footer')?.addEventListener('click', closeMigrateModal);
  document.getElementById('btn-migrate-submit')?.addEventListener('click', closeMigrateModal);

  document.querySelectorAll('.btn-delete-pool').forEach(function(btn) {
    btn.addEventListener('click', function() { handleDelete(btn.dataset.poolId); });
  });

  document.querySelectorAll('.btn-edit-pool').forEach(function(btn) {
    btn.addEventListener('click', function() { handleEditClick(btn.dataset.poolId); });
  });

  document.getElementById('btn-add-member')?.addEventListener('click', function() {
    const peerSel = document.getElementById('new-member-peer');
    const prioInp = document.getElementById('new-member-priority');
    if (!peerSel || !peerSel.value) return;
    const peerId = peerSel.value;
    const peerName = peerSel.options[peerSel.selectedIndex] ? peerSel.options[peerSel.selectedIndex].text : peerId;
    const priority = parseInt(prioInp ? prioInp.value : '100', 10) || 100;
    const container = document.getElementById('pool-members');
    if (!container) return;
    if (container.querySelector('[data-peer-id="' + peerId + '"]')) return;

    const row = document.createElement('div');
    row.className = 'pool-member-row';
    row.dataset.peerId = peerId;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    nameSpan.textContent = peerName;

    const prioInput = document.createElement('input');
    prioInput.type = 'number';
    prioInput.className = 'pool-member-priority-input form-input';
    prioInput.value = priority;
    prioInput.dataset.peerId = peerId;
    prioInput.style.width = '70px';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-danger btn-remove-member';
    removeBtn.dataset.peerId = peerId;
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', function() { row.remove(); });

    row.appendChild(nameSpan);
    row.appendChild(prioInput);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });

  // Close modals on overlay click
  document.getElementById('pool-form-modal')?.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeFormModal();
  });
  document.getElementById('pool-migrate-modal')?.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeMigrateModal();
  });
}

document.addEventListener('DOMContentLoaded', function() {
  initCooldownPresets();
  initModeToggle();
  initEventListeners();
});
