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

  const $ = (sel) => document.querySelector(sel);

  async function loadDevices() {
    const { devices } = await api('GET', '/devices');
    const el = $('#midea-devices');
    if (!devices.length) { el.innerHTML = `<p class="muted">${T('midea.devices.none')}</p>`; return; }
    el.innerHTML = devices.map((d) => `
      <div class="device-row" data-id="${d.id}">
        <strong>${esc(d.name)}</strong> ${d.transport === 'cloud'
          ? `<span class="muted tag">${esc(T('midea.transport.cloud'))}</span>`
          : `<span class="muted">${esc(d.ip || '')} · v${d.protocol_version}</span>`}
        <span class="device-state"></span>
        <label>${T('midea.device.target')} <input type="number" step="0.5" min="16" max="30" data-act="target" style="width:5em"></label>
        <select data-act="mode">
          ${['auto','cool','heat','dry','fan'].map((m) => `<option value="${m}">${T('midea.mode.' + m)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-act="test">${T('midea.device.test')}</button>
        <button class="btn btn-sm" data-act="power">${T('midea.device.power')}</button>
        <button class="btn btn-sm" data-act="remove">${T('midea.device.remove')}</button>
      </div>`).join('');
  }

  async function refreshState(id, row) {
    try {
      const { state } = await api('GET', `/devices/${id}/state`);
      row.querySelector('.device-state').textContent = state.offline
        ? T('midea.device.offline')
        : `${state.power ? T('midea.device.on') : T('midea.device.off')} · ${T('midea.device.indoor')} ${state.indoorTemp}° · → ${state.targetTemp}° · ${T('midea.mode.' + state.mode)}`;
    } catch (e) { row.querySelector('.device-state').textContent = e.message; }
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.device-row');
    const id = row.dataset.id;
    try {
      if (btn.dataset.act === 'test') { await api('POST', `/devices/${id}/test`); await refreshState(id, row); }
      if (btn.dataset.act === 'power') {
        const { state } = await api('GET', `/devices/${id}/state`);
        await api('POST', `/devices/${id}/state`, { patch: { power: !(state && state.power) } });
        await refreshState(id, row);
      }
      if (btn.dataset.act === 'remove') { await api('DELETE', `/devices/${id}`); await loadDevices(); }
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
