(function () {
  'use strict';
  var GCt = (window.GC && GC.t) || {};
  var csrf = (window.GC && GC.csrfToken) || '';
  function T(k, d) { return GCt[k] || d; }
  var grid = document.getElementById('fleet-grid');
  var kpis = document.getElementById('fleet-kpis');
  var warn = document.getElementById('version-warning');
  var modal = document.getElementById('gw-modal');
  var modalBody = document.getElementById('gw-modal-body');
  var last = [], latest = '';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function bar(p, lvl) { var b = el('div', 'bar'); var i = el('span', lvl ? 'fill ' + lvl : 'fill'); i.style.width = Math.max(0, Math.min(100, p)) + '%'; b.appendChild(i); return b; }
  function pct(used, total) { return total > 0 ? Math.round((used / total) * 100) : 0; }
  function status(g) {
    if (g.status === 'offline') return 'offline';
    if (!g.health || g.status === 'unknown') return 'pending';
    if (g.health.overall_healthy === false) return 'degraded';
    return 'online';
  }
  function ago(ms) { if (!ms) return '—'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; }
  function metricRow(parent, label, value, p, lvl) { var m = el('div', 'metric'); m.appendChild(el('span', null, label)); m.appendChild(el('span', null, value)); parent.appendChild(m); parent.appendChild(bar(p, lvl)); }
  function fmtGB(n) { return n ? (Math.round(n / 1e9 * 10) / 10) + ' GB' : '—'; }

  // Formatted drilldown panel (safe DOM) — replaces the raw last_health JSON dump.
  function detail(g) {
    var h = g.health || {}, t = h.telemetry || {};
    var box = el('div', 'gwd');
    var hd = el('div', 'gwd-head');
    var hb = el('div'); hb.appendChild(el('h2', null, g.name)); hb.appendChild(el('div', 'host', (g.hostname || '') + ' · ' + (g.ip || '')));
    hd.appendChild(hb); hd.appendChild(el('span', 'pill ' + status(g), T('gateways.' + status(g), status(g)))); box.appendChild(hd);

    box.appendChild(el('h3', 'gwd-sec', 'Versionen & System'));
    var kvw = el('div', 'gwd-kv');
    function kv(k, v) { var r = el('div', 'gwd-row'); r.appendChild(el('span', 'k', k)); if (typeof v === 'string') r.appendChild(el('span', 'v', v)); else r.appendChild(v); kvw.appendChild(r); }
    var vv = el('span', 'v', (t.gateway_version || '—') + ' '); if (g.update_available) vv.appendChild(el('span', 'badge drift', '↑ ' + latest));
    kv(T('gateways.version', 'Version'), vv);
    kv('Node', t.node_version || '—');
    kv('wg-tools', t.wg_tools_version || '—');
    kv('OS', (t.os_platform || '—') + (t.os_release ? ' ' + t.os_release : ''));
    kv('Arch', t.arch || '—');
    kv('CPU-Kerne', String(t.cpu_cores || '—'));
    kv('Default-Gateway', t.default_gateway_ip || '—');
    kv('DNS', (t.dns_resolvers || []).join(', ') || '—');
    kv('Config', h.config_hash ? '✓ ' + String(h.config_hash).slice(0, 10) : '—');
    box.appendChild(kvw);

    box.appendChild(el('h3', 'gwd-sec', 'Ressourcen'));
    var res = el('div');
    var cores = t.cpu_cores || 1, la = t.cpu_load_avg || [];
    metricRow(res, 'CPU-Last (1/5/15m)', la.length ? la.map(function (x) { return Number(x).toFixed(2); }).join(' · ') : '—', pct(la[0] || 0, cores), (pct(la[0] || 0, cores) > 90 ? 'bad' : null));
    if (t.mem_total) metricRow(res, 'RAM', fmtGB(t.mem_used) + ' / ' + fmtGB(t.mem_total), pct(t.mem_used, t.mem_total), null);
    if (t.disk && t.disk.total) metricRow(res, 'Disk', fmtGB(t.disk.used) + ' / ' + fmtGB(t.disk.total), pct(t.disk.used, t.disk.total), (pct(t.disk.used, t.disk.total) > 85 ? 'bad' : (pct(t.disk.used, t.disk.total) > 70 ? 'warn' : null)));
    box.appendChild(res);

    box.appendChild(el('h3', 'gwd-sec', 'Health-Checks'));
    var hcw = el('div', 'gwd-checks');
    function chk(label, ok) { var c = el('span', 'gwd-chk ' + (ok ? 'ok' : 'bad')); c.appendChild(el('span', 'dot')); c.appendChild(el('span', null, label)); hcw.appendChild(c); }
    chk('HTTP-Proxy', h.http_proxy_healthy);
    chk('Mgmt-API', h.api_healthy);
    chk('DNS', h.dns_resolve_ok);
    chk('WG' + (h.wg_handshake_age_s != null ? ' (' + h.wg_handshake_age_s + 's)' : ''), h.wg_handshake_age_s != null && h.wg_handshake_age_s < 180);
    box.appendChild(hcw);

    var routes = h.route_reachability || [];
    var upN = routes.filter(function (r) { return r.reachable; }).length;
    box.appendChild(el('h3', 'gwd-sec', T('gateways.routes', 'Routes') + ' (' + upN + ' / ' + routes.length + ')'));
    if (routes.length) {
      var tbl = el('table', 'gwd-table');
      routes.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', null, r.domain || ('#' + r.route_id)));
        var sc = el('td'); sc.appendChild(el('span', 'pill ' + (r.reachable ? 'online' : 'offline'), r.reachable ? 'OK' : 'offline')); tr.appendChild(sc);
        tr.appendChild(el('td', 'mono', r.latency_ms != null ? r.latency_ms + ' ms' : '—'));
        tbl.appendChild(tr);
      });
      box.appendChild(tbl);
    } else { box.appendChild(el('div', 'gwd-empty', '—')); }
    return box;
  }

  function card(g) {
    var t = (g.health && g.health.telemetry) || {};
    var routes = (g.health && g.health.route_reachability) || [];
    var up = routes.filter(function (r) { return r.reachable; }).length;
    var st = status(g);
    var wrap = el('div', 'gw'); wrap.dataset.id = g.peer_id;
    var top = el('div', 'top');
    var tb = el('div'); tb.appendChild(el('h3', null, g.name)); tb.appendChild(el('div', 'host', (g.hostname || '') + ' · ' + (g.ip || '')));
    top.appendChild(tb); top.appendChild(el('span', 'pill ' + st, T('gateways.' + st, st))); wrap.appendChild(top);
    var body = el('div', 'body');
    var verKv = el('div', 'kv'); verKv.appendChild(el('div', 'k', T('gateways.version', 'Version')));
    var verV = el('div', 'v', (t.gateway_version || '—') + ' '); if (g.update_available) verV.appendChild(el('span', 'badge drift', '↑ ' + latest));
    verKv.appendChild(verV); body.appendChild(verKv);
    var cores = (t.cpu_cores || 1); var load1 = (t.cpu_load_avg && t.cpu_load_avg[0]) || 0;
    metricRow(body, 'CPU', load1.toFixed(2), pct(load1, cores), pct(load1, cores) > 90 ? 'bad' : null);
    if (t.mem_total) metricRow(body, 'RAM', (Math.round(t.mem_used / 1e9 * 10) / 10) + '/' + Math.round(t.mem_total / 1e9) + ' GB', pct(t.mem_used, t.mem_total), null);
    if (t.disk && t.disk.total) metricRow(body, 'Disk', pct(t.disk.used, t.disk.total) + '%', pct(t.disk.used, t.disk.total), pct(t.disk.used, t.disk.total) > 85 ? 'bad' : (pct(t.disk.used, t.disk.total) > 70 ? 'warn' : null));
    var rt = el('div', 'kv'); rt.appendChild(el('div', 'k', T('gateways.routes', 'Routes'))); rt.appendChild(el('div', 'v', up + ' / ' + routes.length)); body.appendChild(rt);
    wrap.appendChild(body);
    var foot = el('div', 'foot');
    foot.appendChild(el('span', null, 'WG ' + (g.health && g.health.wg_handshake_age_s != null ? g.health.wg_handshake_age_s + 's' : '—') + ' · ' + ago(g.last_seen_at)));
    var btn = el('button', 'btn ghost recheck', '↻'); btn.dataset.id = g.peer_id; foot.appendChild(btn);
    wrap.appendChild(foot);
    return wrap;
  }
  function kpi(cls, n, label) { var k = el('div', 'kpi' + (cls ? ' ' + cls : '')); k.appendChild(el('div', 'n', n)); k.appendChild(el('div', 'l', label)); return k; }
  function render(data) {
    last = data.gateways || []; latest = data.latest_version || ''; warn.hidden = !!data.latest_version;
    var on = 0, off = 0, deg = 0, upd = 0;
    last.forEach(function (g) { var s = status(g); if (s === 'online') on++; else if (s === 'offline') off++; else if (s === 'degraded') deg++; if (g.update_available) upd++; });
    kpis.replaceChildren(
      kpi('', last.length, T('gateways.kpi_total', 'Gateways')),
      kpi('ok', on, T('gateways.online', 'Online')),
      kpi('warn', deg, T('gateways.degraded', 'Degraded')),
      kpi('bad', off, T('gateways.offline', 'Offline')),
      kpi('warn', upd, T('gateways.kpi_update', 'Update')));
    grid.replaceChildren.apply(grid, last.map(card));
  }
  function load() { fetch('/api/v1/gateways', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(render).catch(function () {}); }
  grid.addEventListener('click', function (e) {
    var rc = e.target.closest('.recheck'); if (rc) { e.stopPropagation(); probe(rc.dataset.id); return; }
    var c = e.target.closest('.gw'); if (!c) return;
    var g = last.find(function (x) { return String(x.peer_id) === c.dataset.id; });
    if (g) { modalBody.replaceChildren(detail(g)); modal.hidden = false; }
  });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.hidden = true; }); // backdrop-only close
  function probe(id) { fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/probe', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }).then(function () { load(); }).catch(function () {}); }
  var deb = null; function refresh() { clearTimeout(deb); deb = setTimeout(load, 1000); }
  document.addEventListener('gc:gateway', refresh);
  document.addEventListener('gc:reconnected', refresh);
  setInterval(load, 30000);
  load();
})();
