'use strict';
(function () {
  const GC = window.GC || {};
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': GC.csrfToken };
  const T = (k) => (GC.t && GC.t[k]) || k;
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, path, body) {
    const res = await fetch('/api/v1/midea' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }

  async function apiRoot(method, path, body) {
    const res = await fetch('/api/v1' + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { code: json.code });
    return json;
  }
  let _usersCache = null;
  let _devicesCache = [];
  async function loadUsers() {
    if (_usersCache) return _usersCache;
    try { const r = await apiRoot('GET', '/users'); _usersCache = r.users || []; } catch { _usersCache = []; }
    return _usersCache;   // GET /api/v1/users → { ok:true, users:[{id,username,…}] }
  }

  const $ = (sel) => document.querySelector(sel);

  // Mode segment: icons instead of text labels (label kept as title/aria-label for i18n + a11y).
  const MODE_ICONS = {
    auto: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/></svg>',
    cool: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>',
    heat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/></svg>',
    dry: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7S6 9 6 14a6 6 0 0 0 12 0c0-5-6-11.3-6-11.3z"/></svg>',
    fan: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/><path d="M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2"/></svg>',
  };

  // Module-scope handles so repeated loadDevices() calls never stack listeners or intervals.
  let _visController = null;
  let _visTimer = null;

  async function loadDevices() {
    const [{ devices }, statusData, usersList] = await Promise.all([
      api('GET', '/devices'),
      api('GET', '/status').catch(() => ({})),
      loadUsers(),
    ]);
    const el = $('#midea-devices');

    // Re-auth banner: show when cloud account needs re-authentication.
    let banner = el.previousElementSibling && el.previousElementSibling.dataset.role === 'reauth-banner'
      ? el.previousElementSibling : null;
    if (statusData.cloud_needs_reauth) {
      if (!banner) {
        banner = document.createElement('p');
        banner.dataset.role = 'reauth-banner';
        banner.style.cssText = 'color:var(--color-danger,#d9534f);margin-bottom:8px';
        el.parentNode.insertBefore(banner, el);
      }
      banner.textContent = T('midea.cloud.reauth');
    } else if (banner) {
      banner.remove();
    }

    _devicesCache = devices; // module-scope cache (for the owner-dialog lookup); see Step 0
    const kpis = $('#midea-kpis'); // ponytail: statisches Skelett — NIEMALS hier createInsert (bricht Banner previousElementSibling)
    if (kpis) {
      const total = devices.length;
      const withOwner = devices.filter((d) => (d.owners || []).length).length;
      const cloud = devices.some((d) => d.transport === 'cloud');
      kpis.innerHTML = `
        <div class="kpi"><span class="kpi-l">${T('midea.kpi.devices')}</span><span class="kpi-v">${total}</span></div>
        <div class="kpi"><span class="kpi-l">${T('midea.kpi.online')}</span><span class="kpi-v" id="midea-kpi-online">0<small> / ${total}</small></span></div>
        <div class="kpi"><span class="kpi-l">${T('midea.kpi.assigned')}</span><span class="kpi-v">${withOwner}<small> / ${total}</small></span></div>
        <div class="kpi"><span class="kpi-l">${T('midea.kpi.cloud')}</span><span class="kpi-v" style="font-size:15px"><span class="tag ${cloud ? 'tag-green' : 'tag-grey'}"><span class="tag-dot"></span>${cloud ? T('midea.cloud.connected') : '—'}</span></span></div>`;
    }

    if (!devices.length) { el.innerHTML = `<p class="muted">${T('midea.devices.none')}</p>`; return; }
    const AVS = ['av-accent', 'av-blue', 'av-purple', 'av-green', 'av-amber'];
    const acIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="10" rx="2"/><path d="M6 18v1M10 18v2M14 18v2M18 18v1"/><line x1="6" y1="9" x2="18" y2="9"/></svg>';
    el.innerHTML = devices.map((d) => {
      const chips = (d.owners && d.owners.length)
        ? `<div class="chips">${d.owners.map((o) => `<span class="owner-chip"><span class="avatar ${AVS[o.id % 5]}">${esc((o.username || '?')[0].toUpperCase())}</span>${esc(o.username)}</span>`).join('')}</div>`
        : `<div class="chips"><span class="no-owner">${T('midea.owners.none')}</span></div>`;
      const ownerBtn = (d.owners && d.owners.length)
        ? `<button class="btn btn-sm btn-secondary" data-act="owners">${T('midea.owners.manage')}</button>`
        : `<button class="btn btn-sm btn-primary" data-act="owners">${T('midea.owners.assign')}</button>`;
      const transportTag = d.transport === 'cloud'
        ? `<span class="tag tag-blue">${esc(T('midea.transport.cloud'))}</span>`
        : `<span class="tag tag-grey">${esc(d.ip || '')} · v${esc(String(d.protocol_version ?? ''))}</span>`;
      const actionBtn = d.transport === 'cloud'
        ? `<button class="btn btn-sm btn-ghost" data-act="refresh">${T('midea.device.refresh')}</button>`
        : `<button class="btn btn-sm btn-ghost" data-act="test">${T('midea.device.test')}</button>`;
      return `
      <div class="card ac-card" data-id="${Number(d.id)}">
        <div class="ac-head">
          <div class="ac-ic">${acIcon}</div>
          <div style="flex:1;min-width:0">
            <div class="ac-name">${esc(d.name)}</div>
            <div class="ac-sub">${transportTag}</div>
          </div>
          <span class="tag tag-grey device-status"><span class="tag-dot"></span>—</span>
        </div>
        <div class="ac-climate">
          <div class="ac-ring"><div class="ac-ring-in"><span class="ac-ring-v">—</span><span class="ac-ring-l">${T('midea.device.current')}</span></div></div>
          <div class="ac-set">
            <div>
              <div class="ac-set-lbl">${T('midea.device.target')}</div>
              <div class="stepper">
                <button type="button" data-step="-1">−</button>
                <span class="v">— °C</span>
                <input type="number" step="0.5" min="16" max="30" data-act="target">
                <button type="button" data-step="1">+</button>
              </div>
            </div>
            <div>
              <div class="ac-set-lbl">${T('midea.device.mode')}</div>
              <div class="toggle-group mode-group">
                ${['auto', 'cool', 'heat', 'dry', 'fan'].map((m) => `<button type="button" class="toggle-btn mode-btn" data-act="mode" data-mode="${m}" title="${esc(T('midea.mode.' + m))}" aria-label="${esc(T('midea.mode.' + m))}">${MODE_ICONS[m]}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
        <div class="ac-owners">
          <span class="ac-owners-l">${T('midea.owners.label')}</span>
          ${chips}
          ${ownerBtn}
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <button class="btn btn-sm btn-ghost" style="flex:1;justify-content:center" data-act="power">${T('midea.device.power')}</button>
          ${actionBtn}
          <button class="btn btn-sm btn-danger" data-act="remove">${T('midea.device.remove')}</button>
        </div>
      </div>`;
    }).join('');

    // Initial state load: fetch every device's live status right after render so the
    // card shows the real state on page load (not "—"/offline until a manual Refresh).
    // Fire-and-forget + parallel → does not block render; refreshState handles
    // offline/errors/rate-limit per card.
    devices.forEach((d) => {
      const card = el.querySelector(`.ac-card[data-id="${d.id}"]`);
      if (card) refreshState(d.id, card);
    });

    // Page-Visibility-bound cloud refresh: poll Cloud devices while tab is visible, ≥120s interval.
    // Always tear down the previous listener + interval first so repeated loadDevices() calls
    // never stack (each call produces exactly one listener and one interval at most).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      if (_visTimer) { clearInterval(_visTimer); _visTimer = null; }
      if (_visController) { _visController.abort(); _visController = null; }

      const cloudIds = devices.filter((d) => d.transport === 'cloud').map((d) => d.id);
      if (cloudIds.length) {
        _visController = new AbortController();
        const startVis = () => {
          if (_visTimer) return;
          _visTimer = setInterval(async () => {
            for (const cid of cloudIds) {
              const card = el.querySelector(`.ac-card[data-id="${cid}"]`);
              if (card) {
                // eslint-disable-next-line no-await-in-loop
                const r = await refreshState(cid, card);
                if (r && r.suspend) { clearInterval(_visTimer); _visTimer = null; break; }
              }
            }
          }, 120000);
        };
        const stopVis = () => { clearInterval(_visTimer); _visTimer = null; };
        const onVisChange = () => (document.hidden ? stopVis() : startVis());
        if (!document.hidden) startVis();
        document.addEventListener('visibilitychange', onVisChange, { signal: _visController.signal });
      }
    }
  }

  function updateOnlineKpi() {
    const el = document.getElementById('midea-kpi-online');
    if (!el) return;
    const total = document.querySelectorAll('.ac-card').length;
    const online = total - document.querySelectorAll('.ac-card.offline').length;
    el.innerHTML = `${online}<small> / ${total}</small>`;
  }

  function setCardState(card, state) {
    const ring = card.querySelector('.ac-ring');
    const ringV = card.querySelector('.ac-ring-v');
    const status = card.querySelector('.device-status');
    const stepperV = card.querySelector('.stepper .v');
    const input = card.querySelector('input[data-act="target"]');
    if (!state || state.offline) {
      card.classList.add('offline');
      if (ring) ring.style.setProperty('--ring-val', '0%');
      if (ringV) ringV.textContent = '—';
      if (status) status.innerHTML = `<span class="tag-dot"></span>${T('midea.device.offline')}`;
      updateOnlineKpi();
      return;
    }
    card.classList.remove('offline');
    const indoorNum = Number(state.indoorTemp);
    const pct = isNaN(indoorNum) ? 0 : Math.max(0, Math.min(100, ((indoorNum - 16) / (30 - 16)) * 100));
    if (ring) ring.style.setProperty('--ring-val', pct + '%');
    if (ringV) ringV.textContent = isNaN(indoorNum) ? '—' : Math.round(indoorNum) + '°';
    if (status) status.innerHTML = `<span class="tag-dot"></span>${state.power ? T('midea.device.on') : T('midea.device.off')}`;
    const targetNum = Number(state.targetTemp);
    if (input && !isNaN(targetNum)) input.value = targetNum;
    if (stepperV) stepperV.textContent = isNaN(targetNum) ? '— °C' : targetNum + ' °C';
    card.querySelectorAll('.mode-group .toggle-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === state.mode));
    updateOnlineKpi();
  }

  async function refreshState(id, card) {
    try {
      const { state } = await api('GET', `/devices/${id}/state`);
      setCardState(card, state);
      return { suspend: !!state.offline };
    } catch (e) {
      const status = card.querySelector('.device-status');
      if (status) status.innerHTML = `<span class="tag-dot"></span>${esc(e.message)}`;
      return { suspend: e.code === 'MIDEA_CLOUD_RATE_LIMITED' };
    }
  }

  // Owner-assign dialog. Opened per device; reuses the cached usersList.
  let _ownerDeviceId = null;
  function openOwnerModal(device, usersList) {
    _ownerDeviceId = device.id;
    const ownerIds = new Set((device.owners || []).map((o) => o.id));
    $('#midea-owner-device').textContent = T('midea.owners.modal_sub') + ' — ' + device.name;
    const search = $('#midea-owner-search');
    search.value = '';
    const list = $('#midea-owner-list');
    list.innerHTML = usersList.map((u) => {
      const sel = ownerIds.has(u.id) ? ' sel' : '';
      const role = u.role ? ` · ${esc(u.role)}` : '';
      return `<div class="pick-row${sel}" data-uid="${u.id}">
        <span class="avatar lg ${['av-accent','av-blue','av-purple','av-green','av-amber'][u.id % 5]}">${esc((u.username || '?')[0].toUpperCase())}</span>
        <span class="pick-name"><b>${esc(u.username)}</b><small>${esc(u.username)}${role}</small></span>
        <span class="pick-check">✓</span></div>`;
    }).join('');
    updateOwnerCount();
    window.openModal('midea-owner-modal');
    search.focus();
  }
  function updateOwnerCount() {
    const list = $('#midea-owner-list');
    const total = list.querySelectorAll('.pick-row').length;
    const sel = list.querySelectorAll('.pick-row.sel').length;
    $('#midea-owner-count').innerHTML = `<b>${sel}</b> / ${total} ${T('midea.owners.selected')}`;
  }
  function closeOwnerModal() { window.closeModal('midea-owner-modal'); _ownerDeviceId = null; }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.ac-card'); const id = card.dataset.id;
    try {
      if (btn.dataset.act === 'test') { await api('POST', `/devices/${id}/test`); await refreshState(id, card); }
      if (btn.dataset.act === 'refresh') { await refreshState(id, card); }
      if (btn.dataset.act === 'power') {
        const { state } = await api('GET', `/devices/${id}/state`);
        await api('POST', `/devices/${id}/state`, { patch: { power: !(state && state.power) } });
        await refreshState(id, card);
      }
      if (btn.dataset.act === 'remove') { await api('DELETE', `/devices/${id}`); await loadDevices(); }
      if (btn.dataset.act === 'owners') {
        const device = _devicesCache.find((d) => String(d.id) === card.dataset.id);
        if (device) openOwnerModal(device, await loadUsers());
      }
      if (btn.dataset.act === 'mode') {
        const card = btn.closest('.ac-card'); const id = Number(card.dataset.id);
        await api('POST', `/devices/${id}/state`, { patch: { mode: btn.dataset.mode } });
        await refreshState(id, card);
      }
    } catch (e) { alert(e.message); }
  });

  document.addEventListener('click', (ev) => {
    const step = ev.target.closest('button[data-step]');
    if (!step) return;
    const wrap = step.closest('.stepper');
    const input = wrap.querySelector('input[data-act="target"]');
    if (!input.value) return; // ponytail: noch kein State — kein Default-22-Senden
    const cur = Number(input.value);
    input.value = Math.min(30, Math.max(16, cur + Number(step.dataset.step) * 0.5));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  document.addEventListener('change', async (ev) => {
    const ctrl = ev.target.closest('[data-act="target"]');
    if (!ctrl) return;
    const card = ctrl.closest('.ac-card'); const id = Number(card.dataset.id);
    try { await api('POST', `/devices/${id}/state`, { patch: { targetTemp: Number(ctrl.value) } }); await refreshState(id, card); }
    catch (e) { alert(e.message); }
  });

  $('#midea-cloud-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const msg = $('#midea-cloud-msg');
    msg.textContent = '…';
    try {
      await api('POST', '/cloud/connect', { app: f.app.value, email: f.email.value, password: f.password.value });
      msg.textContent = T('midea.cloud.connected');
      await loadCloudDevices();
    } catch (e) {
      msg.textContent = e.code === 'MIDEA_CLOUD_2FA_REQUIRED' ? T('midea.cloud.twofa') : e.message;
    }
  });

  async function loadCloudDevices() {
    try {
      const { devices } = await api('GET', '/cloud/devices');
      // Hide devices already added locally (match by serial or cloud appliance id) —
      // the long serial is no longer rendered (caused horizontal overflow), and an
      // already-added device should not reappear in the "add" list.
      const added = _devicesCache || [];
      const isAdded = (d) => added.some((x) =>
        x.device_sn === d.sn || x.device_sn === 'cloud-' + d.id || String(x.cloud_appliance_id) === String(d.id));
      const pending = devices.filter((d) => !isAdded(d));
      $('#midea-cloud-list').innerHTML = pending.map((d) => `
        <div class="cloud-row">
          <span class="cloud-name">${esc(d.name)}</span>
          <button class="btn btn-sm" data-add="${esc(d.sn)}" data-name="${esc(d.name)}">${T('midea.devices.add')}</button>
          <button class="btn btn-sm" data-cloud-id="${esc(String(d.id))}" data-name="${esc(d.name)}">${T('midea.cloud.add')}</button>
        </div>`).join('');
      // Populate the manual-by-IP cloud-device picker (keep the static first
      // "no cloud" option; append cloud entries via DOM API → XSS-safe).
      const sel = document.querySelector('#midea-ip-form select[name="sn"]');
      if (sel) {
        sel.options.length = 1; // keep the static "no cloud" option, drop prior cloud entries
        for (const d of devices) {
          const o = document.createElement('option');
          o.value = d.sn;
          o.textContent = `${d.name} (${d.sn})`;
          sel.appendChild(o);
        }
      }
    } catch { /* not connected yet */ }
  }

  document.addEventListener('click', async (ev) => {
    const add = ev.target.closest('button[data-add]');
    if (!add) return;
    add.disabled = true;
    try { await api('POST', '/devices', { sn: add.dataset.add, name: add.dataset.name }); await loadDevices(); await loadCloudDevices(); window.closeModal('midea-add-modal'); }
    catch (e) { alert(e.message); } finally { add.disabled = false; }
  });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-cloud-id]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api('POST', '/devices', { transport: 'cloud', cloud_appliance_id: btn.dataset.cloudId, name: btn.dataset.name });
      await loadDevices(); await loadCloudDevices(); window.closeModal('midea-add-modal');
    } catch (e) { alert(e.message); } finally { btn.disabled = false; }
  });

  $('#midea-discover').addEventListener('click', async () => {
    try { const { devices } = await api('POST', '/discover'); alert(`${devices.length} ${T('midea.discover.result')}`); }
    catch (e) { alert(e.message); }
  });

  // Manual add by IP (when discovery can't reach the device). A selected cloud
  // device (sn) makes it a V3 add (keys fetched from the cloud); none = V2.
  const ipForm = $('#midea-ip-form');
  if (ipForm) ipForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const ip = (f.ip.value || '').trim();
    const name = (f.name.value || '').trim();
    const sn = f.sn ? f.sn.value : '';
    const msg = $('#midea-ip-msg');
    if (!ip) { f.ip.focus(); return; }
    const btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    msg.textContent = '…';
    try {
      const body = { ip };
      if (name) body.name = name;
      if (sn) body.sn = sn;
      const { device } = await api('POST', '/devices', body);
      msg.textContent = '✓ ' + ((device && device.name) || ip);
      f.reset();
      await loadDevices(); window.closeModal('midea-add-modal');
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Toggle a user row
  $('#midea-owner-list').addEventListener('click', (ev) => {
    const row = ev.target.closest('.pick-row');
    if (!row) return;
    row.classList.toggle('sel');
    updateOwnerCount();
  });
  // Client-side filter (// ponytail: O(n)-Filter, reicht ≤50 Nutzer)
  $('#midea-owner-search').addEventListener('input', (ev) => {
    const q = ev.target.value.toLowerCase();
    $('#midea-owner-list').querySelectorAll('.pick-row').forEach((r) => {
      r.style.display = r.querySelector('b').textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  // (Schließen via data-close-modal + Escape von app.js — kein eigener Listener nötig.)
  // Da app.js direkt `display:none` setzt, wird `_ownerDeviceId` beim nächsten Öffnen ohnehin neu gesetzt — Reset ist unkritisch.
  $('#midea-owner-save').addEventListener('click', async () => {
    if (_ownerDeviceId == null) return;
    const ids = [...$('#midea-owner-list').querySelectorAll('.pick-row.sel')].map((r) => Number(r.dataset.uid));
    try {
      await api('PUT', `/devices/${_ownerDeviceId}/owners`, { user_ids: ids });
      window.closeModal('midea-owner-modal');
      await loadDevices();
    } catch (e) {
      alert(e.code === 'MIDEA_OWNER_UNKNOWN_USER' ? T('midea.owners.error_unknown_user') : e.message);
    }
  });

  // Add-device dialog open + segment switch (close via data-close-modal + Escape from app.js).
  const addModal = $('#midea-add-modal');
  if (addModal) {
    $('#midea-add-open').addEventListener('click', () => window.openModal('midea-add-modal'));
    const tabCloud = $('#midea-add-tab-cloud');
    const tabManual = $('#midea-add-tab-manual');
    const paneCloud = $('#midea-pane-cloud');
    const paneManual = $('#midea-pane-manual');
    function showPane(cloud) {
      tabCloud.classList.toggle('active', cloud);
      tabManual.classList.toggle('active', !cloud);
      paneCloud.hidden = !cloud;
      paneManual.hidden = cloud;
    }
    tabCloud.addEventListener('click', () => showPane(true));
    tabManual.addEventListener('click', () => showPane(false));
  }

  loadDevices();
  loadCloudDevices();
})();
