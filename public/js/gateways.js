(function () {
  'use strict';
  var GCt = (window.GC && GC.t) || {};
  var csrf = (window.GC && GC.csrfToken) || '';
  function T(k, d) { return GCt[k] || d; }
  var grid = document.getElementById('fleet-grid');
  var kpis = document.getElementById('fleet-kpis');
  var warn = document.getElementById('version-warning');
  var fleetView = document.getElementById('fleet-view');
  var detailView = document.getElementById('gw-detail-view');
  var GW_RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
  var last = [], latest = '', openId = null, routed = false;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function bar(p, lvl) { var b = el('div', 'bar'); var i = el('span', lvl ? 'fill ' + lvl : 'fill'); i.style.width = Math.max(0, Math.min(100, p)) + '%'; b.appendChild(i); return b; }
  function pct(used, total) { return total > 0 ? Math.round((used / total) * 100) : 0; }
  function status(g) {
    if (g.status === 'offline') return 'offline';
    if (!g.health || g.status === 'unknown') return 'pending';
    if (g.health.overall_healthy === false) return 'degraded';
    return 'online';
  }
  function statusPill(g) { var st = status(g); return el('span', 'pill ' + st, T('gateways.' + st, st)); }
  function ago(ms) { if (!ms) return '—'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; }
  function metricRow(parent, label, value, p, lvl) { var m = el('div', 'metric'); m.appendChild(el('span', null, label)); m.appendChild(el('span', null, value)); parent.appendChild(m); parent.appendChild(bar(p, lvl)); }
  function fmtGB(n) { return n ? (Math.round(n / 1e9 * 10) / 10) + ' GB' : '—'; }
  function kvRow(k, v, vcls) {
    var r = el('div', 'kv'); r.appendChild(el('div', 'k', k));
    if (v && v.nodeType) { var vn = el('div', vcls ? 'v ' + vcls : 'v'); vn.appendChild(v); r.appendChild(vn); }
    else r.appendChild(el('div', vcls ? 'v ' + vcls : 'v', v));
    return r;
  }

  // ── Fleet cards ──────────────────────────────────────────────────────────
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

  // ── Detail view (mirrors gateway-detail.html mockup) ──────────────────────
  function detailHead(g) {
    var ph = el('div', 'page-h');
    var left = el('div');
    var h1 = el('h1'); h1.appendChild(document.createTextNode(g.name + ' ')); h1.appendChild(statusPill(g));
    left.appendChild(h1);
    var parts = [];
    if (g.hostname) parts.push(g.hostname);
    if (g.ip) parts.push(T('gateways.sub_tunnel', 'Tunnel') + ' ' + g.ip);
    parts.push(T('gateways.sub_heartbeat', 'letzter Heartbeat vor') + ' ' + ago(g.last_seen_at));
    left.appendChild(el('p', 'page-sub', parts.join(' · ')));
    ph.appendChild(left);
    var act = el('div', 'gw-detail-actions');
    var rc = el('button', 'recheck', '↻ ' + T('gateways.recheck', 'Neu prüfen')); rc.dataset.id = g.peer_id; rc.dataset.act = 'recheck';
    act.appendChild(rc);
    if (g.update_available && latest) {
      var up = el('a', 'gw-update', T('gateways.update_to', 'Update auf') + ' ' + latest);
      up.href = GW_RELEASES; up.target = '_blank'; up.rel = 'noopener';
      act.appendChild(up);
    }
    ph.appendChild(act);
    return ph;
  }
  function versionsCard(g) {
    var t = (g.health && g.health.telemetry) || {}, h = g.health || {};
    var c = el('div', 'gw');
    var top = el('div', 'top'); top.appendChild(el('h3', null, T('gateways.sec_versions', 'Versionen & System'))); c.appendChild(top);
    var body = el('div', 'body');
    var gwVal = el('span'); gwVal.appendChild(document.createTextNode((t.gateway_version || '—') + ' '));
    if (g.update_available && latest) gwVal.appendChild(el('span', 'badge drift', '↑ ' + latest));
    var r1 = el('div', 'row3');
    r1.appendChild(kvRow(T('gateways.lbl_gateway', 'Gateway'), gwVal));
    r1.appendChild(kvRow(T('gateways.lbl_node', 'Node'), t.node_version || '—'));
    r1.appendChild(kvRow(T('gateways.lbl_wgtools', 'wg-tools'), t.wg_tools_version || '—'));
    body.appendChild(r1);
    var r2 = el('div', 'row3');
    r2.appendChild(kvRow(T('gateways.lbl_os', 'OS'), (t.os_platform || '—') + (t.os_release ? ' ' + t.os_release : '')));
    r2.appendChild(kvRow(T('gateways.lbl_arch', 'Arch'), t.arch || '—'));
    r2.appendChild(kvRow(T('gateways.lbl_cores', 'Kerne'), t.cpu_cores != null ? String(t.cpu_cores) : '—'));
    body.appendChild(r2);
    body.appendChild(kvRow(T('gateways.lbl_default_gw', 'Default-Gateway (LAN)'), t.default_gateway_ip || '—'));
    body.appendChild(kvRow(T('gateways.lbl_dns_resolvers', 'DNS-Resolver'), (t.dns_resolvers && t.dns_resolvers.length) ? t.dns_resolvers.join(', ') : '—'));
    var cfgVal;
    if (h.config_hash) {
      cfgVal = el('span'); cfgVal.appendChild(document.createTextNode('✓ ' + T('gateways.config_synced', 'synchron') + ' · '));
      cfgVal.appendChild(el('code', null, String(h.config_hash).slice(0, 8)));
    } else { cfgVal = T('gateways.config_unknown', 'unbekannt'); }
    body.appendChild(kvRow(T('gateways.lbl_config_hash', 'Config-Hash'), cfgVal));
    c.appendChild(body);
    return c;
  }
  function resourcesCard(g) {
    var t = (g.health && g.health.telemetry) || {}, h = g.health || {};
    var c = el('div', 'gw');
    var top = el('div', 'top'); top.appendChild(el('h3', null, T('gateways.sec_resources', 'Ressourcen'))); c.appendChild(top);
    var body = el('div', 'body');
    var metrics = el('div', 'gw-metrics');
    var cores = t.cpu_cores || 1, la = t.cpu_load_avg || [];
    metricRow(metrics, T('gateways.lbl_cpu_load', 'CPU-Last 1m / 5m / 15m'),
      la.length ? la.map(function (x) { return Number(x).toFixed(2); }).join(' · ') : '—',
      pct(la[0] || 0, cores), (pct(la[0] || 0, cores) > 90 ? 'bad' : null));
    if (t.mem_total) { var mp = pct(t.mem_used, t.mem_total); metricRow(metrics, T('gateways.lbl_ram', 'RAM'), fmtGB(t.mem_used) + ' / ' + fmtGB(t.mem_total) + ' · ' + mp + ' %', mp, (mp > 90 ? 'bad' : null)); }
    if (t.disk && t.disk.total) { var dp = pct(t.disk.used, t.disk.total); metricRow(metrics, T('gateways.lbl_disk', 'Disk (rootfs)'), fmtGB(t.disk.used) + ' / ' + fmtGB(t.disk.total) + ' · ' + dp + ' %', dp, (dp > 85 ? 'bad' : (dp > 70 ? 'warn' : null))); }
    body.appendChild(metrics);
    var r = el('div', 'row3');
    function chk(label, ok, okWord) {
      var row = el('div', 'kv'); row.appendChild(el('div', 'k', label));
      row.appendChild(el('div', 'v ' + (ok ? 'ok' : 'bad'), ok ? '✓ ' + okWord : '✗ ' + T('gateways.chk_fail', 'Fehler')));
      return row;
    }
    r.appendChild(chk(T('gateways.lbl_http_proxy', 'HTTP-Proxy'), !!h.http_proxy_healthy, T('gateways.chk_healthy', 'healthy')));
    r.appendChild(chk(T('gateways.lbl_mgmt_api', 'Mgmt-API'), !!h.api_healthy, T('gateways.chk_healthy', 'healthy')));
    r.appendChild(chk(T('gateways.lbl_dns_resolve', 'DNS-Resolve'), !!h.dns_resolve_ok, T('gateways.chk_ok', 'ok')));
    body.appendChild(r);
    c.appendChild(body);
    return c;
  }
  function routesCard(g) {
    var h = g.health || {};
    var rr = h.route_reachability || [];
    var cfg = g.routes || [];
    var cfgById = {}; cfg.forEach(function (rc) { cfgById[rc.id] = rc; });
    var upN = rr.filter(function (r) { return r.reachable; }).length;
    var c = el('div', 'gw full');
    var top = el('div', 'top');
    top.appendChild(el('h3', null, T('gateways.sec_routes', 'Routen-Erreichbarkeit (LAN)')));
    var pillCls = (rr.length && upN === rr.length) ? 'online' : (upN === 0 ? 'offline' : 'degraded');
    top.appendChild(el('span', 'pill ' + pillCls, upN + ' / ' + rr.length));
    c.appendChild(top);
    var body = el('div', 'body');
    if (rr.length) {
      var tbl = el('table', 'gw-routes');
      var thead = el('thead'), htr = el('tr');
      [T('gateways.col_domain', 'Domain'), T('gateways.col_lan_target', 'LAN-Ziel'), T('gateways.col_status', 'Status'), T('gateways.col_latency', 'Latenz'), T('gateways.col_checked', 'Geprüft')]
        .forEach(function (htxt) { htr.appendChild(el('th', null, htxt)); });
      thead.appendChild(htr); tbl.appendChild(thead);
      var tbody = el('tbody');
      rr.forEach(function (r) {
        var rc = cfgById[r.route_id] || {};
        var tr = el('tr');
        tr.appendChild(el('td', null, r.domain || rc.domain || ('#' + r.route_id)));
        tr.appendChild(el('td', 'sub', rc.target_lan_host ? rc.target_lan_host + (rc.target_lan_port ? ':' + rc.target_lan_port : '') : '—'));
        var sc = el('td'); sc.appendChild(el('span', 'pill ' + (r.reachable ? 'online' : 'offline'), r.reachable ? T('gateways.reachable', 'erreichbar') : T('gateways.unreachable', 'nicht erreichbar'))); tr.appendChild(sc);
        tr.appendChild(el('td', 'num', r.latency_ms != null ? r.latency_ms + ' ms' : '—'));
        tr.appendChild(el('td', 'num', ago(g.last_seen_at)));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      body.appendChild(tbl);
    } else {
      body.appendChild(el('div', 'gw-empty', T('gateways.routes_empty', 'Keine Routen auf dieses Gateway.')));
    }
    c.appendChild(body);
    var foot = el('div', 'foot');
    var tl = h.tcp_listeners;
    var l4n = (typeof tl === 'number') ? tl : (Array.isArray(tl) ? tl.length : cfg.filter(function (rc) { return rc.l4_listen_port; }).length);
    foot.appendChild(el('span', null, l4n + ' ' + T('gateways.foot_listeners', 'L4-Listener aktiv') + ' · ' + T('gateways.foot_probes', 'TCP-Probes alle 15 s')));
    var wol = cfg.filter(function (rc) { return rc.wol_enabled; }).map(function (rc) { return rc.domain; });
    if (wol.length) foot.appendChild(el('span', null, T('gateways.foot_wol', 'WoL verfügbar für') + ' „' + wol.join(', ') + '"'));
    c.appendChild(foot);
    return c;
  }
  function renderDetail(g) {
    var root = el('div', 'gw-detail');
    var back = el('button', 'gw-back', '← ' + T('gateways.back_to_fleet', 'Zurück zur Flotte')); back.dataset.act = 'back';
    root.appendChild(back);
    root.appendChild(detailHead(g));
    var grid2 = el('div', 'grid two');
    grid2.appendChild(versionsCard(g));
    grid2.appendChild(resourcesCard(g));
    grid2.appendChild(routesCard(g));
    root.appendChild(grid2);
    detailView.replaceChildren(root);
  }

  // ── View routing ──────────────────────────────────────────────────────────
  function showDetail(id) {
    var g = last.find(function (x) { return String(x.peer_id) === String(id); });
    if (!g) { showFleet(); return; }
    openId = String(id);
    renderDetail(g);
    fleetView.hidden = true; detailView.hidden = false;
    window.scrollTo(0, 0);
  }
  function showFleet() {
    openId = null; detailView.hidden = true; fleetView.hidden = false; detailView.replaceChildren();
  }
  function goFleet() {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showFleet();
  }
  function route() {
    var m = (location.hash || '').match(/^#gw\/(.+)$/);
    if (m) showDetail(decodeURIComponent(m[1])); else showFleet();
  }

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
    if (!routed) { routed = true; route(); }
    else if (openId) { var g = last.find(function (x) { return String(x.peer_id) === openId; }); if (g) renderDetail(g); else goFleet(); }
  }
  function load() { fetch('/api/v1/gateways', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(render).catch(function () {}); }
  function probe(id) { fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/probe', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }).then(function () { load(); }).catch(function () {}); }

  grid.addEventListener('click', function (e) {
    var rc = e.target.closest('.recheck'); if (rc) { e.stopPropagation(); probe(rc.dataset.id); return; }
    var c = e.target.closest('.gw'); if (!c) return;
    location.hash = '#gw/' + encodeURIComponent(c.dataset.id);
  });
  detailView.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="back"]')) { goFleet(); return; }
    var rc = e.target.closest('[data-act="recheck"]'); if (rc) { probe(rc.dataset.id); }
  });
  window.addEventListener('hashchange', route);

  var deb = null; function refresh() { clearTimeout(deb); deb = setTimeout(load, 1000); }
  document.addEventListener('gc:gateway', refresh);
  document.addEventListener('gc:reconnected', refresh);
  setInterval(load, 30000);
  load();
})();
