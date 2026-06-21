(function () {
  'use strict';

  // ── Aurora detection (reads layout DOM; must NOT be a GC field) ──────────────
  function isAurora() { return !!document.querySelector('.app'); }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d)) return '—';
      return d.toLocaleString();
    } catch { return '—'; }
  }

  function fmtNum(n) {
    if (n == null || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return '—';
    return num.toLocaleString();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      }
    }
    return node;
  }

  function setText(id, val) {
    const node = document.getElementById(id);
    if (node) node.textContent = val == null ? '—' : String(val);
  }

  function replaceChildren(node, kids) {
    while (node.firstChild) node.removeChild(node.firstChild);
    const arr = Array.isArray(kids) ? kids : [kids];
    for (const k of arr) if (k != null) node.appendChild(k);
  }

  function badge(cls, text) {
    return el('span', { class: 'tag ' + cls }, text);
  }

  function T(k, d) { return (window.GC && GC.t && GC.t[k]) || d; }

  // ── Aurora: Summary (donut + pi-stats) ───────────────────────
  function auroraRenderSummary(data) {
    const q = data.queries || {};
    setText('ph-stat-queries', fmtNum(q.total));
    setText('ph-stat-blocked', fmtNum(q.blocked));

    // Donut center: show percentage rounded to integer
    const pct = q.percent != null ? Number(q.percent) : 0;
    const pctText = pct.toFixed(1) + ' %';
    setText('ph-stat-blocked-pct', pctText);

    // Animate SVG donut arc: r=52, circumference = 2*π*52 ≈ 326.73
    var CIRC = 326.73;
    var offset = CIRC - (pct / 100) * CIRC;
    var donutEl = document.getElementById('pi-donut');
    if (donutEl) donutEl.setAttribute('stroke-dashoffset', offset.toFixed(1));

    // Allowed count (total - blocked)
    var allowedEl = document.getElementById('ph-stat-allowed');
    if (allowedEl) {
      var total = Number(q.total) || 0;
      var blocked = Number(q.blocked) || 0;
      allowedEl.textContent = fmtNum(Math.max(0, total - blocked));
    }

    setText('ph-stat-gravity', fmtNum(data.gravity));
    const cl = data.clients;
    const clActive = cl && typeof cl === 'object' ? cl.active : cl;
    setText('ph-stat-clients', fmtNum(clActive));

    const blocking = data.blocking || {};
    const badgeEl = document.getElementById('ph-blocking-badge');
    if (badgeEl) {
      const state = blocking.state;
      let cls = 'tag-grey', txt = '—';
      if (state === 'enabled')  { cls = 'tag-green';  txt = T('pihole.blocking_on',      'On'); }
      else if (state === 'disabled') { cls = 'tag-red';   txt = T('pihole.blocking_off', 'Off'); }
      else if (state === 'partial')  { cls = 'tag-amber'; txt = T('pihole.blocking_partial', 'Partial'); }
      replaceChildren(badgeEl, badge(cls, txt));
    }

    const warn = document.getElementById('ph-attribution-warn');
    if (warn) warn.style.display = data.attribution === 'collapsed' ? '' : 'none';
  }

  // ── Aurora: Top Blocked Domains (toplist <li> renderer) ──────
  function auroraRenderTopDomains(domains) {
    const ul = document.getElementById('ph-top-domains-tbody');
    if (!ul) return;
    replaceChildren(ul, []);
    if (!domains || !domains.length) {
      ul.appendChild(el('li', null, el('span', { class: 'd' }, T('common.no_data', '—'))));
      return;
    }
    const maxCount = Math.max(1, ...domains.map(function (d) { return d.count || 0; }));
    var MAX_BAR = 100;
    for (const d of domains) {
      const count = d.count || 0;
      const barW = Math.round(count / maxCount * MAX_BAR);
      ul.appendChild(el('li', null, [
        el('span', { class: 'd' }, d.domain || d.name || '—'),
        el('span', { class: 'bar', style: 'width:' + barW + 'px' }),
        el('span', { class: 'cnt' }, fmtNum(count)),
      ]));
    }
  }

  // ── Aurora: Top Clients (toplist <li> renderer) ───────────────
  function auroraRenderTopClients(clients) {
    const ul = document.getElementById('ph-top-clients-tbody');
    if (!ul) return;
    replaceChildren(ul, []);
    if (!clients || !clients.length) {
      ul.appendChild(el('li', null, el('span', { class: 'd' }, T('common.no_data', '—'))));
      return;
    }
    const maxCount = Math.max(1, ...clients.map(function (c) { return c.count || 0; }));
    var MAX_BAR = 100;
    for (const c of clients) {
      const nameCell = _attribution === 'per_peer' && c.peerName ? c.peerName : (c.ip || '—');
      const count = c.count || 0;
      const barW = Math.round(count / maxCount * MAX_BAR);
      ul.appendChild(el('li', null, [
        el('span', { class: 'd' }, nameCell),
        el('span', { class: 'bar', style: 'width:' + barW + 'px' }),
        el('span', { class: 'cnt' }, fmtNum(count)),
      ]));
    }
  }

  // ── Summary ──────────────────────────────────────────────────
  function renderSummary(data) {
    if (isAurora()) return auroraRenderSummary(data);
    const q = data.queries || {};
    setText('ph-stat-queries', fmtNum(q.total));
    setText('ph-stat-blocked', fmtNum(q.blocked));
    setText('ph-stat-blocked-pct', q.percent != null ? Number(q.percent).toFixed(1) + ' %' : '—');
    setText('ph-stat-gravity', fmtNum(data.gravity));
    const cl = data.clients;
    const clActive = cl && typeof cl === 'object' ? cl.active : cl;
    setText('ph-stat-clients', fmtNum(clActive));

    const blocking = data.blocking || {};
    const badgeEl = document.getElementById('ph-blocking-badge');
    if (badgeEl) {
      const state = blocking.state;
      let cls = 'tag-grey', txt = '—';
      if (state === 'enabled')  { cls = 'tag-green';  txt = T('pihole.blocking_on',      'On'); }
      else if (state === 'disabled') { cls = 'tag-red';   txt = T('pihole.blocking_off', 'Off'); }
      else if (state === 'partial')  { cls = 'tag-amber'; txt = T('pihole.blocking_partial', 'Partial'); }
      replaceChildren(badgeEl, badge(cls, txt));
    }

    const warn = document.getElementById('ph-attribution-warn');
    if (warn) warn.style.display = data.attribution === 'collapsed' ? '' : 'none';
  }

  // ── History chart (simple SVG polylines) ─────────────────────
  function renderHistory(history) {
    const svg = document.getElementById('ph-chart-svg');
    if (!svg || !Array.isArray(history) || !history.length) return;
    const W = 560, H = 120;
    const maxQ = Math.max(1, ...history.map(function (b) { return (b.allowed || 0) + (b.blocked || 0); }));

    function pts(key) {
      return history.map(function (b, i) {
        var x = (i / Math.max(1, history.length - 1)) * W;
        var y = H - ((b[key] || 0) / maxQ) * (H - 10) - 5;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var ns = 'http://www.w3.org/2000/svg';

    var polyAllowed = document.createElementNS(ns, 'polyline');
    polyAllowed.setAttribute('points', pts('allowed'));
    polyAllowed.setAttribute('fill', 'none');
    polyAllowed.setAttribute('stroke', 'var(--accent, #2563eb)');
    polyAllowed.setAttribute('stroke-width', '1.5');
    svg.appendChild(polyAllowed);

    var polyBlocked = document.createElementNS(ns, 'polyline');
    polyBlocked.setAttribute('points', pts('blocked'));
    polyBlocked.setAttribute('fill', 'none');
    polyBlocked.setAttribute('stroke', 'var(--red, #dc2626)');
    polyBlocked.setAttribute('stroke-width', '1.5');
    svg.appendChild(polyBlocked);
  }

  // ── Top Blocked Domains ──────────────────────────────────────
  function renderTopDomains(domains) {
    if (isAurora()) return auroraRenderTopDomains(domains);
    const tbody = document.getElementById('ph-top-domains-tbody');
    if (!tbody) return;
    replaceChildren(tbody, []);
    if (!domains || !domains.length) {
      tbody.appendChild(el('tr', null,
        el('td', { colspan: '2', style: 'text-align:center;color:var(--text-3);padding:20px' },
          T('common.no_data', '—'))));
      return;
    }
    for (const d of domains) {
      tbody.appendChild(el('tr', null, [
        el('td', null, el('span', { style: 'font-family:var(--font-mono);font-size:11px' }, d.domain || d.name || '—')),
        el('td', null, fmtNum(d.count)),
      ]));
    }
  }

  // ── Top Clients ──────────────────────────────────────────────
  var _attribution = 'per_peer';

  function renderTopClients(clients) {
    if (isAurora()) return auroraRenderTopClients(clients);
    const tbody = document.getElementById('ph-top-clients-tbody');
    if (!tbody) return;
    replaceChildren(tbody, []);
    if (!clients || !clients.length) {
      tbody.appendChild(el('tr', null,
        el('td', { colspan: '2', style: 'text-align:center;color:var(--text-3);padding:20px' },
          T('common.no_data', '—'))));
      return;
    }
    for (const c of clients) {
      const nameCell = _attribution === 'per_peer' && c.peerName ? c.peerName : (c.ip || '—');
      tbody.appendChild(el('tr', null, [
        el('td', null, el('span', { style: 'font-size:12px' }, nameCell)),
        el('td', null, fmtNum(c.count)),
      ]));
    }
  }

  // ── Query Types (types is a plain object { type: count }) ────
  function renderQueryTypes(types) {
    const list = document.getElementById('ph-query-types-list');
    if (!list) return;
    replaceChildren(list, []);
    if (!types || typeof types !== 'object') {
      list.appendChild(el('div', { style: 'text-align:center;color:var(--text-3);padding:20px' },
        T('common.no_data', '—')));
      return;
    }
    const entries = Object.entries(types).sort(function (a, b) { return b[1] - a[1]; });
    if (!entries.length) {
      list.appendChild(el('div', { style: 'text-align:center;color:var(--text-3);padding:20px' },
        T('common.no_data', '—')));
      return;
    }
    const total = entries.reduce(function (s, e) { return s + e[1]; }, 0) || 1;
    for (const [type, count] of entries) {
      const pct = Math.round(count / total * 100);
      list.appendChild(el('div', { style: 'margin-bottom:8px' }, [
        el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px' }, [
          el('span', null, type),
          el('span', { style: 'color:var(--text-3);font-family:var(--font-mono)' }, pct + ' %'),
        ]),
        el('div', { class: 'meter-bar' },
          el('div', { class: 'meter-fill',
            style: 'width:' + pct + '%;background:var(--accent,#2563eb)' })),
      ]));
    }
  }

  // ── Health / Connection ───────────────────────────────────────
  function renderHealth(health) {
    _attribution = health.attribution || 'per_peer';
    setText('ph-health-sync', fmtDate(health.lastSyncAt));

    const instances = health.instances || [];
    setText('ph-health-instances', String(instances.length));

    const warn = document.getElementById('ph-attribution-warn');
    if (warn) warn.style.display = _attribution === 'collapsed' ? '' : 'none';

    const online = instances.some(function (i) { return i.connected; });
    const statusBadge = document.getElementById('ph-status-badge');
    if (statusBadge) {
      replaceChildren(statusBadge, badge(
        online ? 'tag-green' : 'tag-red',
        online ? T('pihole.status_online', 'Online') : T('pihole.status_offline', 'Offline')
      ));
    }
    const healthStatus = document.getElementById('ph-health-status');
    if (healthStatus) {
      replaceChildren(healthStatus, badge(
        online ? 'tag-green' : 'tag-red',
        online ? T('pihole.status_online', 'Online') : T('pihole.status_offline', 'Offline')
      ));
    }

    const peerCol = document.getElementById('ph-client-col-peer');
    if (peerCol) {
      peerCol.textContent = _attribution === 'per_peer'
        ? T('pihole.peer', 'Peer')
        : T('pihole.client_ip', 'Client IP');
    }
  }

  // ── Blocking control ─────────────────────────────────────────
  async function setBlocking(enabled, timer) {
    try {
      const body = { enabled: enabled };
      if (timer) body.timer = timer;
      await api.post('/api/v1/pihole/blocking', body);
      await load();
    } catch (err) {
      console.error('Pi-hole blocking change failed:', err.message);
    }
  }

  // ── Load all endpoints ────────────────────────────────────────
  async function load() {
    try {
      const [summary, history, domains, clients, qtypes, health] = await Promise.all([
        api.get('/api/v1/pihole/summary'),
        api.get('/api/v1/pihole/history'),
        api.get('/api/v1/pihole/top-domains'),
        api.get('/api/v1/pihole/top-clients'),
        api.get('/api/v1/pihole/query-types'),
        api.get('/api/v1/pihole/health'),
      ]);
      renderSummary(summary.data || {});
      renderHistory(history.data || []);
      renderTopDomains(domains.data || []);
      renderTopClients(clients.data || []);
      renderQueryTypes(qtypes.data || {});
      renderHealth(health.data || {});
    } catch (err) {
      console.error('Pi-hole load failed:', err.message);
    }
  }

  // ── Button wiring ─────────────────────────────────────────────
  var btnReload = document.getElementById('btn-pihole-reload');
  if (btnReload) btnReload.addEventListener('click', load);

  var btnPause30s = document.getElementById('btn-ph-pause-30s');
  if (btnPause30s) btnPause30s.addEventListener('click', function () { setBlocking(false, 30); });

  var btnPause5m = document.getElementById('btn-ph-pause-5m');
  if (btnPause5m) btnPause5m.addEventListener('click', function () { setBlocking(false, 300); });

  var btnPause30m = document.getElementById('btn-ph-pause-30m');
  if (btnPause30m) btnPause30m.addEventListener('click', function () { setBlocking(false, 1800); });

  var btnEnable = document.getElementById('btn-ph-enable');
  if (btnEnable) btnEnable.addEventListener('click', function () { setBlocking(true); });

  // ── SSE live refresh (dispatched by events.js as 'gc:pihole') ─
  document.addEventListener('gc:pihole', function () {
    load();
  });

  load();
})();
