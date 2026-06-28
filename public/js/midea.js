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

    if (!devices.length) { el.innerHTML = `<p class="muted">${T('midea.devices.none')}</p>`; return; }
    el.innerHTML = devices.map((d) => {
      // ponytail: O(n)-Checkbox-Liste, Suche erst wenn n>50 relevant.
      const ownerIds = new Set((d.owners || []).map((o) => o.id));
      const ownerLabel = (d.owners && d.owners.length)
        ? d.owners.map((o) => esc(o.username)).join(', ')
        : T('midea.owners.none');
      const ownerPicker = `
  <div class="midea-owners" data-id="${d.id}">
    <span class="muted">${T('midea.owners.label')}: ${ownerLabel}</span>
    <details>
      <summary>${T('midea.owners.label')}</summary>
      ${usersList.map((u) => `<label><input type="checkbox" value="${u.id}" ${ownerIds.has(u.id) ? 'checked' : ''}> ${esc(u.username)}</label>`).join('')}
      <button class="btn btn-sm" data-act="save-owners">${T('midea.owners.save')}</button>
    </details>
  </div>`;
      return `
      <div class="device-row" data-id="${d.id}">
        <strong>${esc(d.name)}</strong> ${d.transport === 'cloud'
          ? `<span class="muted tag">${esc(T('midea.transport.cloud'))}</span>`
          : `<span class="muted">${esc(d.ip || '')} · v${d.protocol_version}</span>`}
        <span class="device-state"></span>
        <label>${T('midea.device.target')} <input type="number" step="0.5" min="16" max="30" data-act="target" style="width:5em"></label>
        <select data-act="mode">
          ${['auto','cool','heat','dry','fan'].map((m) => `<option value="${m}">${T('midea.mode.' + m)}</option>`).join('')}
        </select>${d.transport === 'cloud'
          ? `\n        <button class="btn btn-sm" data-act="refresh">${T('midea.device.refresh')}</button>`
          : `\n        <button class="btn btn-sm" data-act="test">${T('midea.device.test')}</button>`}
        <button class="btn btn-sm" data-act="power">${T('midea.device.power')}</button>
        <button class="btn btn-sm" data-act="remove">${T('midea.device.remove')}</button>
        ${ownerPicker}
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
              const row = el.querySelector(`.device-row[data-id="${cid}"]`);
              if (row) {
                // eslint-disable-next-line no-await-in-loop
                const r = await refreshState(cid, row);
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

  async function refreshState(id, row) {
    try {
      const { state } = await api('GET', `/devices/${id}/state`);
      row.querySelector('.device-state').textContent = state.offline
        ? T('midea.device.offline')
        : `${state.power ? T('midea.device.on') : T('midea.device.off')} · ${T('midea.device.indoor')} ${state.indoorTemp}° · → ${state.targetTemp}° · ${T('midea.mode.' + state.mode)}`;
      return { suspend: !!state.offline };
    } catch (e) {
      row.querySelector('.device-state').textContent = e.message;
      return { suspend: e.code === 'MIDEA_CLOUD_RATE_LIMITED' };
    }
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.device-row');
    const id = row.dataset.id;
    try {
      if (btn.dataset.act === 'test') { await api('POST', `/devices/${id}/test`); await refreshState(id, row); }
      if (btn.dataset.act === 'refresh') { await refreshState(id, row); }
      if (btn.dataset.act === 'power') {
        const { state } = await api('GET', `/devices/${id}/state`);
        await api('POST', `/devices/${id}/state`, { patch: { power: !(state && state.power) } });
        await refreshState(id, row);
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
    } catch (e) { alert(e.message); }
  });

  document.addEventListener('change', async (ev) => {
    const ctrl = ev.target.closest('[data-act="target"],[data-act="mode"]');
    if (!ctrl) return;
    const row = ctrl.closest('.device-row'); const id = row.dataset.id;
    const patch = ctrl.dataset.act === 'target' ? { targetTemp: Number(ctrl.value) } : { mode: ctrl.value };
    try { await api('POST', `/devices/${id}/state`, { patch }); await refreshState(id, row); }
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
