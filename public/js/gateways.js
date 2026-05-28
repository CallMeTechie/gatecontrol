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
  var _discoveryListener = null; // replaced on every discoveredDevicesCard build to avoid leak on renderDetail re-runs

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
    var rel = el('a', 'gw-relnotes', T('gateways.release_notes', 'Release notes'));
    rel.href = GW_RELEASES; rel.target = '_blank'; rel.rel = 'noopener';
    act.appendChild(rel);
    if (g.update_available) {
      var migrated = !!(g.health && g.health.telemetry && g.health.telemetry.state_dir_writable);
      var up = el('button', 'gw-update', T('gateways.update_to', 'Update auf') + ' ' + (latest || ''));
      up.dataset.act = 'update'; up.dataset.id = g.peer_id;
      if (!migrated) { up.disabled = true; up.title = T('gateways.update_not_migrated', 'Gateway not migrated for in-place updates'); }
      if (g.update_state === 'updating') up.disabled = true;
      act.appendChild(up);
    }
    ph.appendChild(act);
    if (g.update_state && g.update_state !== 'idle') {
      var banner = el('div', 'gw-update-banner ' + g.update_state);
      if (g.update_state === 'updating') {
        banner.textContent = T('gateways.update_running', 'Update läuft … ({x})').replace('{x}', ago(g.update_requested_at));
      } else if (g.update_state === 'done') {
        banner.textContent = T('gateways.update_done', 'Update auf {x} abgeschlossen').replace('{x}', g.update_target_version || latest || '—');
      } else if (g.update_state === 'failed') {
        banner.textContent = T('gateways.update_failed', 'Update fehlgeschlagen');
      } else if (g.update_state === 'unknown') {
        banner.appendChild(document.createTextNode(T('gateways.update_unknown', 'Update-Status unbekannt') + ' '));
        var dm = el('button', 'gw-update-dismiss', T('gateways.update_dismiss', 'Ausblenden'));
        dm.dataset.act = 'dismiss';
        banner.appendChild(dm);
      }
      ph.appendChild(banner);
    }
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
    var shortDigest = '—';
    if (t.image_digest) { var di = String(t.image_digest); var at = di.lastIndexOf('@sha256:'); if (at !== -1) di = di.slice(at + 8); shortDigest = di.slice(-12); }
    body.appendChild(kvRow(T('gateways.lbl_image_digest', 'Image'), shortDigest));
    body.appendChild(kvRow(T('gateways.lbl_last_pull', 'Last pull'), t.last_pull_at ? ago(t.last_pull_at) : T('gateways.last_pull_never', 'never')));
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
  function setupCard(g) {
    var t = (g.health && g.health.telemetry) || {};
    var migrated = !!t.state_dir_writable;
    var c = el('div', 'gw gw-setup' + (migrated ? ' done' : ''));
    var top = el('div', 'top');
    top.appendChild(el('h3', null, T('gateways.setup_title', 'Set up auto-update')));
    top.appendChild(el('span', 'gw-setup-status ' + (migrated ? 'done' : 'pending'), migrated ? T('gateways.setup_done', '✓ Set up') : T('gateways.setup_pending', '⚠ Not set up yet')));
    c.appendChild(top);
    var body = el('div', 'body');
    if (!migrated) {
      body.appendChild(el('div', 'note', T('gateways.setup_note', 'The automatic Update button only works after this one-time host setup.')));
    }
    var acts = el('div', 'gw-actions');
    var dl = el('a', 'recheck', '⬇ ' + T('gateways.setup_download_update', 'Download update.sh'));
    dl.href = '/api/v1/gateways/' + g.peer_id + '/update-sh';
    acts.appendChild(dl);
    body.appendChild(acts);
    var CMD = 'PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=<compose-dir>/gateway-state <compose-dir>/update.sh';
    var d = el('details');
    d.appendChild(el('summary', null, T('gateways.setup_guide', 'Step-by-step guide')));
    function steps(hostKey, hostDefault, stepKeys) {
      d.appendChild(el('h4', 'gw-setup-host', T(hostKey, hostDefault)));
      var ol = el('ol');
      stepKeys.forEach(function (sk) { ol.appendChild(el('li', null, T(sk[0], sk[1]))); });
      d.appendChild(ol);
      d.appendChild(el('pre', 'gw-setup-cmd', CMD));
    }
    steps('gateways.setup_synology', 'Synology (DSM)', [
      ['gateways.setup_syn_1', "Put update.sh into your gateway's docker-compose folder."],
      ['gateways.setup_syn_2', 'DSM → Task Scheduler → Create → user-defined script (user root, repeat every 1 minute) with this command:'],
    ]);
    steps('gateways.setup_linux', 'Linux (systemd)', [
      ['gateways.setup_lin_1', "Put update.sh into your gateway's docker-compose folder."],
      ['gateways.setup_lin_2', 'Run it every minute (cron, or a systemd .path watching /state/pending-update) with this command:'],
    ]);
    d.appendChild(el('p', 'gw-setup-hint', T('gateways.setup_legacy_hint', "Gateway created before auto-update? Also add '- ./gateway-state:/state' to its compose volumes and recreate the container once.")));
    body.appendChild(d);
    c.appendChild(body);
    return c;
  }
  // ── LAN Discovery cards ───────────────────────────────────────────────────
  // Inline-muted helper — there is no `.muted` CSS class in the gateway-detail view.
  function discMuted(txt) { var d = el('div', null, txt); d.style.cssText = 'font-size:12px;color:var(--text-2)'; return d; }
  // Raw fetch + CSRF, matching gateways.js's convention (it does not use window.api).
  function discCsrfHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': (window.GC && GC.csrfToken) || '' }; }
  function discAgeNote(updatedAt) {
    if (!updatedAt) return '';
    var mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
    return T('gateways.discovery.last_seen_min', 'results from {n} min ago').replace('{n}', mins);
  }

  // Build a card frame matching the other detail-page cards: outer `.gw` →
  // `.top` (header with h3) + `.body` (padded content area). The CSS lives in
  // `.gw-fleet .gw .top {...}` / `.gw-fleet .gw .body {...}` — without these
  // two wrappers the heading and content render unstyled.
  function _discCard(title) {
    var card = el('div', 'gw');
    var top = el('div', 'top'); top.appendChild(el('h3', null, title)); card.appendChild(top);
    var body = el('div', 'body');
    card.appendChild(body);
    return { card: card, body: body };
  }
  // Surface the actual server error from the response JSON (e.g. `discovery_disabled`,
  // `capability_unavailable`, `gateway_lan_discovery not licensed`) instead of the
  // generic "Scan failed", so the admin can self-diagnose.
  function _discErrText(r, fallback) {
    return r.json().then(function (d) {
      var err = d && d.error ? String(d.error) : '';
      if (!err) return fallback;
      if (/not licensed|feature_not_available|gateway_lan_discovery/i.test(err)) return T('gateways.discovery.feature_locked', 'LAN-Erkennung ist im aktuellen Plan nicht aktiviert.');
      if (err === 'discovery_disabled') return T('gateways.discovery.not_enabled', 'Erst Discovery aktivieren und speichern.');
      if (err === 'capability_unavailable') return T('routes.suggested.unavailable', 'Dieses Gateway unterstützt keine Discovery.');
      if (err === 'scan_in_progress') return T('gateways.discovery.scanning', 'Scan läuft bereits…');
      if (err === 'no_subnet') return T('gateways.discovery.no_subnet', 'Kein scanbares Subnetz konfiguriert.');
      if (err === 'gateway_unreachable') return T('gateways.discovery.gateway_unreachable', 'Gateway nicht erreichbar.');
      return fallback + ' (' + err + ')';
    }).catch(function () { return fallback; });
  }

  function discoverySettingsCard(g) {
    var tel = (g.health && g.health.telemetry) || {};
    var frame = _discCard(T('gateways.discovery.title', 'LAN device discovery'));
    var body = frame.body;
    if (tel.lan_discovery !== true) { body.appendChild(discMuted(T('routes.suggested.unavailable', 'Dieses Gateway unterstützt keine Discovery.'))); return frame.card; }
    body.appendChild(discMuted(T('gateways.discovery.subtitle', '')));

    var subnets = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
    var cats = Array.isArray(tel.lan_discovery_categories) ? tel.lan_discovery_categories : [];
    var multi = !!(window.GC && GC.features && GC.features.gateway_lan_discovery_multi_subnet);

    var enableCb = el('input'); enableCb.type = 'checkbox';
    var activeCb = el('input'); activeCb.type = 'checkbox';
    var modeSel = el('select'); ['include', 'exclude'].forEach(function (m) { var o = el('option', null, T('gateways.discovery.mode_' + m, m)); o.value = m; modeSel.appendChild(o); });
    var subBoxes = subnets.map(function (s) { var c = el('input'); c.type = 'checkbox'; c.value = s.cidr; c.checked = !!s.primary; if (!multi && !s.primary) c.disabled = true; return { cb: c, s: s }; });
    var catBoxes = cats.map(function (c0) { var c = el('input'); c.type = 'checkbox'; c.value = c0.key; c.checked = true; return { cb: c, c: c0 }; });

    function rowToggle(labelText, input, warn) {
      var row = el('label', null); row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0';
      row.appendChild(input); row.appendChild(el('span', null, labelText));
      if (warn) { var w = discMuted(warn); w.style.marginLeft = '8px'; row.appendChild(w); }
      return row;
    }
    body.appendChild(rowToggle(T('gateways.discovery.enable', ''), enableCb));
    body.appendChild(rowToggle(T('gateways.discovery.active_scan', ''), activeCb, T('gateways.discovery.active_scan_warn', '')));

    body.appendChild(discMuted(T('gateways.discovery.subnets', '')));
    subBoxes.forEach(function (sb) { body.appendChild(rowToggle(sb.s.cidr + (sb.s.primary ? ' ★' : ''), sb.cb)); });
    if (!multi) body.appendChild(discMuted(T('gateways.discovery.multi_subnet_locked', '')));

    var modeRow = el('div', null); modeRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
    modeRow.appendChild(el('span', null, T('gateways.discovery.category_mode', ''))); modeRow.appendChild(modeSel); body.appendChild(modeRow);
    body.appendChild(discMuted(T('gateways.discovery.categories', '')));
    catBoxes.forEach(function (cb) { body.appendChild(rowToggle(cb.c.label, cb.cb)); });

    // Prefill from saved settings exposed in the fleet payload (Task 2b).
    enableCb.checked = !!(g.discovery && g.discovery.enabled);
    activeCb.checked = !!(g.discovery && g.discovery.active_scan);

    var saveBtn = el('button', 'btn btn-primary', T('gateways.discovery.save', 'Save')); saveBtn.type = 'button';
    var saveMsg = discMuted('');
    saveBtn.addEventListener('click', function () {
      var payload = {
        enabled: enableCb.checked, active_scan: activeCb.checked,
        subnets: subBoxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.cb.value; }),
        category_mode: modeSel.value,
        categories: catBoxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.cb.value; }),
      };
      fetch('/api/v1/gateways/' + g.peer_id + '/discovery-settings', { method: 'PUT', credentials: 'same-origin', headers: discCsrfHeaders(), body: JSON.stringify(payload) })
        .then(function (r) {
          if (r.ok) { saveMsg.textContent = T('gateways.discovery.saved', 'Saved'); return; }
          return _discErrText(r, T('gateways.discovery.scan_failed', 'Failed')).then(function (t) { saveMsg.textContent = t; });
        })
        .catch(function () { saveMsg.textContent = T('gateways.discovery.scan_failed', 'Failed'); });
    });
    var actions = el('div', null); actions.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px';
    actions.appendChild(saveBtn); actions.appendChild(saveMsg); body.appendChild(actions);
    return frame.card;
  }

  function discoveredDevicesCard(g) {
    var tel = (g.health && g.health.telemetry) || {};
    var frame = _discCard(T('gateways.discovery.devices_title', 'Discovered devices'));
    var body = frame.body;
    if (tel.lan_discovery !== true) { body.appendChild(discMuted(T('routes.suggested.unavailable', 'Dieses Gateway unterstützt keine Discovery.'))); return frame.card; }
    var scanBtn = el('button', 'btn btn-secondary', T('gateways.discovery.scan_button', 'Scan LAN')); scanBtn.type = 'button';
    var status = discMuted('');
    var list = el('div', null);
    function render(devices, done, timedOut, updatedAt) {
      list.replaceChildren();
      if (!devices || !devices.length) { list.appendChild(discMuted(T('gateways.discovery.no_devices', ''))); }
      else devices.forEach(function (dev) {
        var row = el('div', null); row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)';
        row.appendChild(el('div', null, (dev.hostname || dev.ip) + ' · ' + dev.ip)); // el() → textContent (safe)
        row.appendChild(discMuted((dev.ports || []).map(function (p) { return p.port; }).join(', ')));
        list.appendChild(row);
      });
      status.textContent = (done && timedOut) ? T('gateways.discovery.timed_out', '') : discAgeNote(updatedAt);
    }
    function loadCached() {
      fetch('/api/v1/gateways/' + g.peer_id + '/discovered', { credentials: 'same-origin' })
        .then(function (r) {
          if (r.ok) return r.json().then(function (d) { if (d.ok) render(d.devices, d.done, d.timed_out, d.updated_at); });
          // 403 (license-locked) or 404 — surface so the admin knows why the card is empty.
          return _discErrText(r, '').then(function (t) { if (t) status.textContent = t; });
        }).catch(function () {});
    }
    scanBtn.addEventListener('click', function () {
      status.textContent = T('gateways.discovery.scanning', 'Scanning…');
      fetch('/api/v1/gateways/' + g.peer_id + '/discover', { method: 'POST', credentials: 'same-origin', headers: discCsrfHeaders(), body: '{}' })
        .then(function (r) {
          if (r.ok || r.status === 202) { status.textContent = ''; loadCached(); return; }
          return _discErrText(r, T('gateways.discovery.scan_failed', 'Scan failed')).then(function (t) { status.textContent = t; });
        })
        .catch(function () { status.textContent = T('gateways.discovery.scan_failed', 'Scan failed'); });
    });
    if (_discoveryListener) document.removeEventListener('gc:gateway_discovery', _discoveryListener);
    _discoveryListener = function (e) {
      var p = e.detail || {}; if (String(p.peer_id) === String(g.peer_id)) render(p.devices, p.done, p.timed_out, Date.now());
    };
    document.addEventListener('gc:gateway_discovery', _discoveryListener);
    body.appendChild(scanBtn); body.appendChild(status); body.appendChild(list);
    loadCached();
    return frame.card;
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
    grid2.appendChild(discoveredDevicesCard(g));
    grid2.appendChild(discoverySettingsCard(g));
    grid2.appendChild(setupCard(g));
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
    var rc = e.target.closest('[data-act="recheck"]'); if (rc) { probe(rc.dataset.id); return; }
    var up = e.target.closest('[data-act="update"]');
    if (up) {
      if (!confirm(T('gateways.update_confirm', 'Update dieses Gateway jetzt anstoßen?'))) return;
      var id = up.dataset.id;
      fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/update', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (typeof window.showToast === 'function') {
            window.showToast(
              j.reason === 'cooldown' ? T('gateways.update_cooldown', 'Update auf Cooldown — bitte später erneut versuchen') : T('gateways.update_requested', 'Update angefordert'),
              j.reason === 'cooldown' ? 'error' : 'success');
          }
          load();
        }).catch(function () {});
      return;
    }
    var dm = e.target.closest('[data-act="dismiss"]');
    if (dm) { var b = dm.closest('.gw-update-banner'); if (b && b.parentNode) b.parentNode.removeChild(b); }
  });
  window.addEventListener('hashchange', route);

  var deb = null; function refresh() { clearTimeout(deb); deb = setTimeout(load, 1000); }
  document.addEventListener('gc:gateway', refresh);
  document.addEventListener('gc:reconnected', refresh);
  setInterval(load, 30000);
  load();
})();
