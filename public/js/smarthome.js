'use strict';
(function () {
  const API = '/api/v1/smarthome';
  const T = (k) => (window.GC && GC.t && GC.t[k]) || k;
  const $ = (s, r = document) => r.querySelector(s);
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 8 Farb-Presets → hue/sat (deCONZ hue 0–65535, sat 0–254)
  const SWATCHES = [
    { c: '#ff7a59', hue: 2000, sat: 200 }, { c: '#ff5d8f', hue: 60000, sat: 200 },
    { c: '#9d7bff', hue: 47000, sat: 180 }, { c: '#5b8cff', hue: 44000, sat: 200 },
    { c: '#36d6c3', hue: 33000, sat: 200 }, { c: '#8be36b', hue: 23000, sat: 200 },
    { c: '#ffd27a', hue: 8000, sat: 160 }, { c: '#ffffff', hue: 0, sat: 0 },
  ];

  async function api(path, opts) {
    const csrf = window.GC && GC.csrfToken;
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      ...opts,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return res.json();
  }
  function send(id, body) { return api(`/resources/${id}/state`, { method: 'POST', body: JSON.stringify(body) }); }

  function cardShell(r) {
    const el = document.createElement('div');
    el.className = 'sh-card';
    el.innerHTML = `<div class="sh-name">${esc(r.name || '')}</div><div class="sh-sub">${esc(r.kind)}</div>`;
    return el;
  }

  function renderControllable(r) {
    const el = cardShell(r);
    const caps = r.capabilities || {};
    const body = document.createElement('div'); body.className = 'sh-body';
    // Power
    const pwr = document.createElement('div'); pwr.className = 'sh-pwr';
    pwr.innerHTML = `<span>${T('smarthome.power')}</span><div class="sh-switch"><i></i></div>`;
    pwr.querySelector('.sh-switch').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('on');
      e.currentTarget.classList.toggle('on', on);
      send(r.id, { on }).catch(() => {});
    });
    body.appendChild(pwr);
    // Brightness
    if (caps.bri) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="sh-ctl-lbl">${T('smarthome.brightness')}</div><input class="sh-bri" type="range" min="0" max="100" value="0">`;
      wrap.querySelector('input').addEventListener('change', (e) => send(r.id, { bri: Number(e.target.value) }).catch(() => {}));
      body.appendChild(wrap);
    }
    // Color
    if (caps.color === 'hs' || caps.color === 'xy') {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="sh-ctl-lbl">${T('smarthome.color')}</div><div class="sh-swatches"></div>`;
      const row = wrap.querySelector('.sh-swatches');
      SWATCHES.forEach((sw) => {
        const dot = document.createElement('span'); dot.className = 'sh-sw'; dot.style.background = sw.c;
        dot.addEventListener('click', () => send(r.id, { hue: sw.hue, sat: sw.sat }).catch(() => {}));
        row.appendChild(dot);
      });
      body.appendChild(wrap);
    } else if (caps.color === 'ct') {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="sh-ctl-lbl">${T('smarthome.warmth')}</div><input class="sh-bri" type="range" min="153" max="500" value="300">`;
      wrap.querySelector('input').addEventListener('change', (e) => send(r.id, { ct: Number(e.target.value) }).catch(() => {}));
      body.appendChild(wrap);
    }
    el.appendChild(body);
    return el;
  }

  function renderScene(r) {
    const el = cardShell(r);
    const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-primary'; btn.style.marginTop = '12px';
    btn.textContent = T('smarthome.activate');
    btn.addEventListener('click', () => send(r.id, {}).catch(() => {}));
    el.appendChild(btn);
    return el;
  }

  function renderSensor(r) {
    const el = cardShell(r);
    const v = document.createElement('div'); v.className = 'sh-sensorval'; v.id = `sv-${r.id}`; v.textContent = '—';
    el.appendChild(v);
    return el;
  }

  function renderKpis(resources) {
    const host = $('#smarthome-kpis'); if (!host) return;
    const by = (k) => resources.filter((r) => r.kind === k).length;
    host.innerHTML = [
      [T('smarthome.section.lights'), by('light')],
      [T('smarthome.kpi.groups'), by('group') + by('scene')],
      [T('smarthome.section.sensors'), by('sensor')],
    ].map(([l, v]) => `<div class="sh-kpi"><span class="l">${l}</span><span class="v">${v}</span></div>`).join('');
  }

  function section(title, items, renderer) {
    if (!items.length) return null;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="sh-section-title">${esc(title)}<span class="ln"></span></div>`;
    const grid = document.createElement('div'); grid.className = 'sh-grid';
    items.forEach((r) => grid.appendChild(renderer(r)));
    wrap.appendChild(grid);
    return wrap;
  }

  let gateways = [];
  async function loadResources(gatewayId) {
    const host = $('#smarthome-devices'); if (!host) return;
    host.innerHTML = '';
    let data;
    try { data = await api(`/resources${gatewayId ? `?gateway_id=${gatewayId}` : ''}`); }
    catch (_) { host.innerHTML = `<div class="sh-empty">${T('smarthome.load_error')}</div>`; return; }
    const res = data.resources.filter((r) => r.enabled);
    renderKpis(res);
    const blocks = [
      section(T('smarthome.section.lights'), res.filter((r) => r.kind === 'light'), renderControllable),
      section(T('smarthome.section.groups'), res.filter((r) => r.kind === 'group' || r.kind === 'scene'), (r) => r.kind === 'scene' ? renderScene(r) : renderControllable(r)),
      section(T('smarthome.section.sensors'), res.filter((r) => r.kind === 'sensor'), renderSensor),
    ].filter(Boolean);
    if (!blocks.length) { host.innerHTML = `<div class="sh-empty">${T('smarthome.empty')}</div>`; return; }
    blocks.forEach((b) => host.appendChild(b));
  }

  async function loadGateways() {
    const sel = $('#sh-gateway-select');
    const data = await api('/gateways').catch(() => ({ gateways: [] }));
    gateways = data.gateways || [];
    if (sel) {
      sel.innerHTML = gateways.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      sel.onchange = () => loadResources(Number(sel.value));
    }
    const first = gateways.find((g) => g.enabled) || gateways[0];
    await loadResources(first ? first.id : undefined);
  }

  async function fillRoutes() {
    const sel = $('#sh-c-route'); if (!sel) return;
    try {
      const r = await (await fetch('/api/v1/routes')).json();
      const list = (r.routes || r || []).filter((x) => x.domain);
      sel.innerHTML = list.map((x) => `<option value="${x.id}">${esc(x.domain)}</option>`).join('');
    } catch (_) { /* leer lassen */ }
  }

  function wireConnect() {
    const btn = $('#sh-c-submit'); if (!btn) return;
    btn.addEventListener('click', async () => {
      const body = { name: $('#sh-c-name').value, route_id: Number($('#sh-c-route').value), apiKey: $('#sh-c-key').value || undefined };
      try { await api('/gateways', { method: 'POST', body: JSON.stringify(body) }); $('#sh-connect-modal').style.display = 'none'; await loadGateways(); }
      catch (e) { alert(e.message); }
    });
    const sync = $('#sh-sync');
    if (sync) sync.addEventListener('click', async () => {
      const sel = $('#sh-gateway-select'); if (!sel || !sel.value) return;
      await api(`/gateways/${sel.value}/sync`, { method: 'POST' }).catch(() => {});
      await loadResources(Number(sel.value));
    });
  }

  function wireTest() {
    const btn = $('#sh-test'); if (!btn) return;
    btn.addEventListener('click', async () => {
      const sel = $('#sh-gateway-select');
      if (!sel || !sel.value) return;
      const result = $('#sh-test-result');
      if (result) { result.style.display = 'block'; result.textContent = '…'; result.style.color = ''; }
      try {
        const data = await api(`/gateways/${sel.value}/test`, { method: 'POST' });
        if (result) {
          if (data.reachable) {
            result.style.color = 'var(--green,#4ade80)';
            result.textContent = `✓ ${T('smarthome.test_ok')} (${esc(data.baseUrl || '')})`;
          } else {
            result.style.color = 'var(--coral,#ff7a59)';
            result.textContent = `✗ ${T('smarthome.test_fail')}: ${esc(data.detail || data.code || '')}`;
          }
        }
      } catch (e) {
        if (result) {
          result.style.color = 'var(--coral,#ff7a59)';
          result.textContent = `✗ ${esc(e.message)}`;
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => { fillRoutes(); wireConnect(); wireTest(); loadGateways(); });
  window.SmartHome = { loadGateways, loadResources, api };
})();
