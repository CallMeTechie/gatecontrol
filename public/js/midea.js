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
                ${['auto', 'cool', 'heat', 'dry', 'fan'].map((m) => `<button type="button" class="toggle-btn" data-act="mode" data-mode="${m}">${T('midea.mode.' + m)}</button>`).join('')}
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
      if (btn.dataset.act === 'save-owners') {
        const box = btn.closest('.midea-owners');
        const ids = [...box.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
        try {
          await api('PUT', `/devices/${Number(box.dataset.id)}/owners`, { user_ids: ids });
          btn.textContent = T('midea.owners.saved');   // transient feedback before the re-render
          await loadDevices();                          // re-renders the row (button text resets)
        } catch (e) { alert(e.code === 'MIDEA_OWNER_UNKNOWN_USER' ? T('midea.owners.error_unknown_user') : e.message); }
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
      $('#midea-cloud-list').innerHTML = devices.map((d) => `
        <div class="cloud-row">
          <span>${esc(d.name)} <span class="muted">${esc(d.sn)}</span></span>
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
    try { await api('POST', '/devices', { sn: add.dataset.add, name: add.dataset.name }); await loadDevices(); }
    catch (e) { alert(e.message); } finally { add.disabled = false; }
  });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-cloud-id]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api('POST', '/devices', { transport: 'cloud', cloud_appliance_id: btn.dataset.cloudId, name: btn.dataset.name });
      await loadDevices();
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
      await loadDevices();
    } catch (e) {
      msg.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  loadDevices();
  loadCloudDevices();
})();
