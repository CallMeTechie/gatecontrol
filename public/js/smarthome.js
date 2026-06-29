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

  // Category key: sensors get a subtype (caps.reading), everything else is its kind.
  function catKey(r) {
    if (r.kind === 'sensor') return 'sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown');
    return r.kind;
  }
  function subLabel(r) {
    return r.kind === 'sensor' ? T('smarthome.sensor.' + ((r.capabilities && r.capabilities.reading) || 'unknown'))
                               : T('smarthome.kind.' + r.kind);
  }
  // Minimal inline SVG icon per category (stroke-based, theme color).
  const ICONS = {
    light: '<circle cx="12" cy="9" r="5"/><path d="M9 18h6M10 21h4"/>',
    plug: '<path d="M9 2v5M15 2v5"/><path d="M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v7"/>',
    group: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><circle cx="12" cy="16" r="3"/>',
    scene: '<path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z"/>',
    switch: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/><path d="M10 14h4"/>',
    'sensor.presence': '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4.5 4.5a11 11 0 0 0 0 15M19.5 4.5a11 11 0 0 1 0 15"/>',
    'sensor.open': '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M14 3v18"/><circle cx="11.5" cy="12" r="1"/>',
    'sensor.water': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    'sensor.temperature': '<path d="M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0z"/>',
    'sensor.humidity': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9 14a3 3 0 0 0 3 3"/>',
    'sensor.lightlevel': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    'sensor.button': '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="8" r="1.6"/>',
    'sensor.unknown': '<circle cx="12" cy="12" r="8"/><path d="M12 8v4M12 16h.01"/>',
  };
  function iconSvg(r) {
    const body = ICONS[catKey(r)] || ICONS['sensor.unknown'];
    return `<svg class="sh-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }

  function cardShell(r) {
    const el = document.createElement('div');
    el.className = 'sh-card';
    el.innerHTML = `<div class="sh-name">${iconSvg(r)}<span>${esc(r.name || '')}</span></div><div class="sh-sub">${esc(subLabel(r))}</div>`;
    return el;
  }

  function renderControllable(r) {
    const el = cardShell(r);
    const caps = r.capabilities || {};
    const body = document.createElement('div'); body.className = 'sh-body';
    // Power
    const pwr = document.createElement('div'); pwr.className = 'sh-pwr';
    pwr.innerHTML = `<span>${T('smarthome.power')}</span><div class="sh-switch${(r.state && r.state.on) ? ' on' : ''}"><i></i></div>`;
    pwr.querySelector('.sh-switch').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('on');
      e.currentTarget.classList.toggle('on', on);
      send(r.id, { on }).catch(() => {});
    });
    body.appendChild(pwr);
    // Brightness
    if (caps.bri) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="sh-ctl-lbl">${T('smarthome.brightness')}</div><input class="sh-bri" type="range" min="0" max="100" value="${(r.state && r.state.bri != null) ? Number(r.state.bri) : 0}">`;
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
    if (r.kind === 'light' || r.kind === 'plug' || r.kind === 'group') {
      const own = document.createElement('div');
      const names = (r.owners || []).map((o) => o.username);
      own.innerHTML = `<div class="sh-owner-chips">${names.length ? esc(names.join(', ')) : esc(T('smarthome.owners.none'))}</div>`;
      const btn = document.createElement('button'); btn.className = 'sh-owner-btn'; btn.type = 'button';
      btn.textContent = T('smarthome.owners.manage');
      btn.addEventListener('click', () => openOwners(r));
      own.appendChild(btn);
      body.appendChild(own);
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
    if (r.owners && r.owners.length) {
      const chip = document.createElement('div'); chip.className = 'sh-owner-chips';
      chip.textContent = r.owners.map((o) => o.username).join(', ');
      el.appendChild(chip);
    }
    return el;
  }

  function formatValue(r) {
    const s = r.state || {}; const v = s.value;
    switch (s.type) {
      case 'temperature': return v == null ? '—' : `${v} °C`;
      case 'humidity': return v == null ? '—' : `${v} %`;
      case 'lightlevel': return v == null ? '—' : `${v} lx`;
      case 'presence': return T(v ? 'smarthome.val.motion' : 'smarthome.val.idle');
      case 'open': return T(v ? 'smarthome.val.open' : 'smarthome.val.closed');
      case 'water': return T(v ? 'smarthome.val.wet' : 'smarthome.val.dry');
      default: return v == null ? '—' : String(v);
    }
  }

  function renderSensor(r) {
    const el = cardShell(r);
    const v = document.createElement('div'); v.className = 'sh-sensorval'; v.id = `sv-${r.id}`;
    v.textContent = formatValue(r);
    el.appendChild(v);
    return el;
  }

  // Switches/button remotes are inputs (read-only here). Button→action binding = TP3.
  function renderSwitch(r) {
    return cardShell(r);
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
      section(T('smarthome.section.plugs'), res.filter((r) => r.kind === 'plug'), renderControllable),
      section(T('smarthome.section.groups'), res.filter((r) => r.kind === 'group' || r.kind === 'scene'), (r) => r.kind === 'scene' ? renderScene(r) : renderControllable(r)),
      section(T('smarthome.section.switches'), res.filter((r) => r.kind === 'switch'), renderSwitch),
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

  // Live-value refresh: server polls deCONZ ~30s; mirror that here. Pause when the
  // tab is hidden or a control is focused (don't yank an active slider/select).
  let autoTimer = null;
  function startAutoPoll() {
    if (autoTimer) return;
    autoTimer = setInterval(() => {
      if (document.hidden) return;
      const ae = document.activeElement;
      if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
      if ($('#sh-connect-modal') && $('#sh-connect-modal').style.display === 'flex') return;
      if ($('#sh-owner-modal') && $('#sh-owner-modal').style.display === 'flex') return;
      const sel = $('#sh-gateway-select');
      loadResources(sel && sel.value ? Number(sel.value) : undefined);
    }, 30000);
  }

  async function fillRoutes() {
    const sel = $('#sh-c-route'); if (!sel) return;
    try {
      const r = await (await fetch('/api/v1/routes')).json();
      const list = (r.routes || r || []).filter((x) => x.domain);
      sel.innerHTML = list.map((x) => `<option value="${x.id}">${esc(x.domain)}</option>`).join('');
    } catch (_) { /* leer lassen */ }
  }

  // Modal open/close wired in JS (CSP blocks inline onclick: script-src-attr 'none').
  function wireModal() {
    const modal = $('#sh-connect-modal');
    const open = $('#sh-connect-open');
    if (open && modal) open.addEventListener('click', () => { modal.style.display = 'flex'; });
    document.querySelectorAll('[data-sh-close]').forEach((el) =>
      el.addEventListener('click', () => { if (modal) modal.style.display = 'none'; }));
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

  let allUsers = null;
  async function fetchUsers() {
    if (allUsers) return allUsers;
    try {
      // /api/v1/users returns { ok:true, users:[...] }
      const r = await (await fetch('/api/v1/users')).json(); allUsers = (r.users || []).map((u) => ({ id: u.id, username: u.username }));
    } catch (_) { allUsers = []; }
    return allUsers;
  }
  let ownerTarget = null;
  async function openOwners(r) {
    ownerTarget = r;
    const modal = $('#sh-owner-modal'); if (!modal) return;
    $('#sh-owner-sub').textContent = r.name || '';
    $('#sh-owner-search').value = '';
    const users = await fetchUsers();
    const ownedIds = new Set((r.owners || []).map((o) => o.id));
    const list = $('#sh-owner-list');
    list.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('label'); row.className = 'sh-owner-row'; row.dataset.name = (u.username || '').toLowerCase();
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = String(u.id); cb.checked = ownedIds.has(u.id);
      const span = document.createElement('span'); span.textContent = u.username;
      row.appendChild(cb); row.appendChild(span); list.appendChild(row);
    });
    modal.style.display = 'flex';
  }
  function wireOwners() {
    const search = $('#sh-owner-search');
    if (search) search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      document.querySelectorAll('#sh-owner-list .sh-owner-row').forEach((row) => {
        row.style.display = row.dataset.name.includes(q) ? '' : 'none';
      });
    });
    const save = $('#sh-owner-save');
    if (save) save.addEventListener('click', async () => {
      if (!ownerTarget) return;
      const ids = [...document.querySelectorAll('#sh-owner-list input:checked')].map((c) => Number(c.value));
      try {
        await api(`/resources/${ownerTarget.id}/owners`, { method: 'PUT', body: JSON.stringify({ userIds: ids }) });
        $('#sh-owner-modal').style.display = 'none';
        const sel = $('#sh-gateway-select'); await loadResources(sel && sel.value ? Number(sel.value) : undefined);
      } catch (e) { alert(e.message); }
    });
    document.querySelectorAll('[data-sh-close-owner]').forEach((el) =>
      el.addEventListener('click', () => { const m = $('#sh-owner-modal'); if (m) m.style.display = 'none'; }));
  }

  document.addEventListener('DOMContentLoaded', () => { wireModal(); fillRoutes(); wireConnect(); wireTest(); loadGateways(); startAutoPoll(); wireOwners(); });
  window.SmartHome = { loadGateways, loadResources, api };
})();
