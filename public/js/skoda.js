(() => {
  'use strict';
  const GC = window.GC || {};
  const T = (k, params) => {
    let s = (GC.t && GC.t[k]) || k;
    for (const [p, v] of Object.entries(params || {})) s = s.replace(`{{${p}}}`, v);
    return s;
  };
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': GC.csrfToken };
  async function api(method, path, body) {
    const res = await fetch('/api/v1/skoda' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }
  async function apiRoot(method, path, body) {
    const res = await fetch('/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showModal = (id) => { el(id).style.display = 'flex'; };
  const hideModal = (id) => { el(id).style.display = 'none'; };
  let current = { accounts: [], vehicles: [] };
  let ownerVehicleId = null;
  let spinAccountId = null;

  function accountRow(a) {
    const statusKey = `skoda.accounts.status.${a.status}`;
    const statusText = a.status === 'rate_limited'
      ? T(statusKey, { time: a.next_retry_at ? new Date(a.next_retry_at).toLocaleTimeString() : '—' })
      : T(statusKey);
    return `<div class="skoda-account" data-id="${a.id}">
      <span class="skoda-account-email">${esc(a.email)}</span>
      <span class="skoda-badge skoda-badge-${esc(a.status)}" title="${esc(a.status_detail || '')}">${esc(statusText)}</span>
      <button class="btn btn-sm" data-action="password">${T('skoda.accounts.change_password')}</button>
      <button class="btn btn-sm" data-action="spin">${T('skoda.cmd.spin')}</button>
      <button class="btn btn-sm btn-danger" data-action="remove">${T('skoda.accounts.remove')}</button>
    </div>`;
  }

  function vehicleCard(v) {
    const s = v.state || {};
    const lock = s.locked === true ? T('skoda.vehicle.locked') : s.locked === false ? T('skoda.vehicle.unlocked') : '—';
    // sqlite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC -> proper ISO first
    const fetched = v.fetched_at ? T('skoda.vehicle.fetched', { time: new Date(v.fetched_at.replace(' ', 'T') + 'Z').toLocaleString() }) : '—';
    return `<div class="skoda-card" data-id="${v.id}">
      ${v.has_image ? `<img class="skoda-card-img" src="/api/v1/skoda/vehicles/${v.id}/image" alt="">` : ''}
      <div class="skoda-card-head"><strong>${esc(v.name || v.model || v.vin)}</strong><span class="skoda-vin">${esc(v.vin)}</span></div>
      <div class="skoda-card-stats">
        <span>${T('skoda.vehicle.soc')}: ${s.soc ?? '—'}${s.soc != null ? '%' : ''}</span>
        <span>${T('skoda.vehicle.range')}: ${s.rangeKm ?? '—'}${s.rangeKm != null ? ' km' : ''}</span>
        <span>${lock}</span>
        <span>${T('skoda.vehicle.mileage')}: ${s.health && s.health.mileageKm != null ? s.health.mileageKm + ' km' : '—'}</span>
      </div>
      <div class="skoda-card-meta">${esc(fetched)} · ${T('skoda.vehicle.owners')}: ${esc((v.owners || []).map((o) => o.username).join(', ') || '—')}</div>
      <div class="skoda-card-actions">
        <button class="btn btn-sm" data-action="owners">${T('skoda.vehicle.owners')}</button>
        <button class="btn btn-sm" data-action="refresh">${T('skoda.vehicle.refresh')}</button>
      </div>
      <div class="skoda-cmds" data-veh="${v.id}">
        <button class="btn btn-sm" data-cmd="ac_start" data-temp="21">${T('skoda.cmd.ac_on')}</button>
        <button class="btn btn-sm" data-cmd="ac_stop">${T('skoda.cmd.ac_off')}</button>
        <label>${T('skoda.cmd.set_temp')} <input type="number" min="15.5" max="30" step="0.5" value="21" data-temp-input></label>
        <button class="btn btn-sm" data-cmd="ac_temp">${T('skoda.cmd.set_temp')}</button>
        <button class="btn btn-sm" data-cmd="charge_start">${T('skoda.cmd.charge_on')}</button>
        <button class="btn btn-sm" data-cmd="charge_stop">${T('skoda.cmd.charge_off')}</button>
        <button class="btn btn-sm" data-cmd="window_heat_start">${T('skoda.cmd.window_heat_on')}</button>
        <button class="btn btn-sm" data-cmd="window_heat_stop">${T('skoda.cmd.window_heat_off')}</button>
        <button class="btn btn-sm" data-cmd="lock">${T('skoda.cmd.lock')}</button>
        <button class="btn btn-sm btn-danger" data-cmd="unlock">${T('skoda.cmd.unlock')}</button>
        <label>${T('skoda.cmd.set_limit')} <select data-cmd="charge_limit"><option>50</option><option>60</option><option>70</option><option>80</option><option>90</option><option>100</option></select></label>
      </div>
    </div>`;
  }

  async function command(vehicleId, action, args, el) {
    if (action === 'unlock' && !confirm(T('skoda.cmd.confirm_unlock'))) return;
    if (el && el.disabled) return; // already in flight → no command storm
    var isBtn = el && el.tagName === 'BUTTON';
    var restore = isBtn ? el.textContent : null;
    var reset = function () { if (el) { el.disabled = false; if (isBtn && restore != null) el.textContent = restore; } };
    if (el) { el.disabled = true; if (isBtn) el.textContent = T('skoda.cmd.running'); }
    var watchdog = setTimeout(reset, 30000); // hard fallback if the request never settles
    try {
      await api('POST', `/vehicles/${vehicleId}/command`, { action, args: args || {} });
      setTimeout(load, 3000); // let the 30s post-command refresh begin; reload state
    } catch (e) {
      alert(e.code === 'SKODA_SPIN_REQUIRED' ? T('skoda.cmd.spin') + '?' : (e.message || T('skoda.cmd.failed')));
    } finally {
      clearTimeout(watchdog);
      setTimeout(reset, 3000);
    }
  }

  async function load() {
    current = await api('GET', '');
    el('skoda-poll-interval').value = current.poll_interval_min;
    el('skoda-accounts').innerHTML = current.accounts.map(accountRow).join('') || '';
    el('skoda-vehicles').innerHTML = current.vehicles.map(vehicleCard).join('') || `<p>${T('skoda.vehicles.empty')}</p>`;
  }

  function fail(e) { alert(e.code === 'SKODA_REFRESH_COOLDOWN' ? T('skoda.error.cooldown') : (e.message || T('skoda.error.generic'))); }

  el('skoda-account-add-open').addEventListener('click', () => showModal('skoda-account-modal'));
  el('skoda-acc-cancel').addEventListener('click', () => hideModal('skoda-account-modal'));
  el('skoda-acc-save').addEventListener('click', async () => {
    try {
      const created = await api('POST', '/accounts', { email: el('skoda-acc-email').value, password: el('skoda-acc-password').value });
      api('POST', `/accounts/${created.account.id}/sync`).catch(() => {}); // fire and forget, status lands on the account row
      hideModal('skoda-account-modal');
      el('skoda-acc-email').value = ''; el('skoda-acc-password').value = '';
      await load();
    } catch (e) { fail(e); }
  });

  el('skoda-accounts').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const id = Number(btn.closest('.skoda-account').dataset.id);
    try {
      if (btn.dataset.action === 'remove') { await api('DELETE', `/accounts/${id}`); await load(); }
      if (btn.dataset.action === 'password') {
        const pw = prompt(T('skoda.accounts.password'));
        if (pw) {
          await api('PUT', `/accounts/${id}`, { password: pw });
          api('POST', `/accounts/${id}/sync`).catch(() => {});
          await load();
        }
      }
      if (btn.dataset.action === 'spin') {
        spinAccountId = id;
        el('skoda-spin-input').value = '';
        showModal('skoda-spin-modal');
      }
    } catch (e) { fail(e); }
  });

  el('skoda-spin-cancel').addEventListener('click', () => hideModal('skoda-spin-modal'));
  el('skoda-spin-save').addEventListener('click', async () => {
    try {
      await api('PUT', `/accounts/${spinAccountId}/spin`, { spin: el('skoda-spin-input').value });
      hideModal('skoda-spin-modal');
    } catch (e) { fail(e); }
  });

  el('skoda-vehicles').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button'); if (!btn) return;
    const id = Number(btn.closest('.skoda-card').dataset.id);
    try {
      if (btn.dataset.action === 'refresh') { await api('POST', `/vehicles/${id}/refresh`); await load(); }
      if (btn.dataset.action === 'owners') {
        ownerVehicleId = id;
        const users = (await apiRoot('GET', '/users')).users || [];
        const owned = new Set(((current.vehicles.find((v) => v.id === id) || {}).owners || []).map((o) => o.id));
        el('skoda-owner-list').innerHTML = users.map((u) =>
          `<label class="skoda-owner-item"><input type="checkbox" value="${u.id}" ${owned.has(u.id) ? 'checked' : ''}> ${esc(u.username)}</label>`).join('');
        showModal('skoda-owner-modal');
      }
    } catch (e) { fail(e); }
  });

  el('skoda-vehicles').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-cmd]'); if (!b) return;
    const box = b.closest('.skoda-cmds'); const veh = Number(box.dataset.veh);
    let args = {};
    if (b.dataset.cmd === 'ac_start' || b.dataset.cmd === 'ac_temp') {
      var inp = box.querySelector('[data-temp-input]');
      var tv = Number(inp && inp.value);
      args = { temp: (isFinite(tv) && tv) ? tv : 21 };
    } else if (b.dataset.temp) args = { temp: Number(b.dataset.temp) };
    command(veh, b.dataset.cmd, args, b);
  });
  el('skoda-vehicles').addEventListener('change', (ev) => {
    const s = ev.target.closest('select[data-cmd="charge_limit"]'); if (!s) return;
    command(Number(s.closest('.skoda-cmds').dataset.veh), 'charge_limit', { limit: Number(s.value) }, s);
  });

  el('skoda-owner-cancel').addEventListener('click', () => hideModal('skoda-owner-modal'));
  el('skoda-owner-save').addEventListener('click', async () => {
    const ids = [...el('skoda-owner-list').querySelectorAll('input:checked')].map((i) => Number(i.value));
    try { await api('PUT', `/vehicles/${ownerVehicleId}/owners`, { user_ids: ids }); hideModal('skoda-owner-modal'); await load(); }
    catch (e) { fail(e); }
  });

  el('skoda-poll-interval').addEventListener('change', async (ev) => {
    try { await api('PUT', '/settings', { poll_interval_min: Number(ev.target.value) }); } catch (e) { fail(e); }
  });

  load().catch(fail);
})();
