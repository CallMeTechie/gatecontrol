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
    var tel0 = (g.health && g.health.telemetry) || {};
    // Discovery-settings gear, only when the gateway reports the capability flag.
    if (tel0.lan_discovery === true) {
      var ds = el('button', 'recheck');
      ds.appendChild(discGearIcon()); // static DOM-built SVG
      ds.title = T('gateways.discovery.settings_tooltip', 'Discovery-Einstellungen');
      ds.setAttribute('aria-label', T('gateways.discovery.settings_tooltip', 'Discovery-Einstellungen'));
      ds.dataset.id = g.peer_id;
      ds.dataset.act = 'disc-settings';
      ds.style.cssText = 'padding:6px 10px;display:inline-flex;align-items:center;justify-content:center';
      act.appendChild(ds);
    }
    // Auto-update setup, color-coded: green when migrated, amber when pending.
    var setupDone = !!tel0.state_dir_writable;
    var su = el('button', 'recheck');
    su.appendChild(discPackageIcon());
    su.title = T(setupDone ? 'gateways.setup.tooltip_done' : 'gateways.setup.tooltip_pending', setupDone ? 'Auto-update is set up' : 'Auto-update needs setup');
    su.setAttribute('aria-label', su.title);
    su.dataset.id = g.peer_id;
    su.dataset.act = 'setup';
    su.style.cssText = 'padding:6px 10px;display:inline-flex;align-items:center;justify-content:center;color:' + (setupDone ? 'var(--green,#16a34a)' : 'var(--amber,#d97706)');
    act.appendChild(su);
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
        // Prefer the user-configured domain (`rc.domain`) over the gateway's
        // synthetic `l4:<port>` reachability label — L4 routes don't carry a
        // real domain on the gateway side so the synthetic value would shadow
        // the friendly name the admin actually chose.
        tr.appendChild(el('td', null, rc.domain || r.domain || ('#' + r.route_id)));
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
  // Auto-update setup form populated into the modal body (previously the
  // standalone `setupCard` in the right-column grid). Same content, modal frame.
  function populateSetupForm(g, body) {
    var t = (g.health && g.health.telemetry) || {};
    var migrated = !!t.state_dir_writable;

    var status = el('div', null);
    status.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:14px;'
      + (migrated ? 'background:var(--green-light,rgba(34,197,94,0.15));color:var(--green-text,var(--green,#16a34a))'
                  : 'background:var(--amber-light,rgba(245,158,11,0.15));color:var(--amber-text,var(--amber,#d97706))');
    status.textContent = migrated ? T('gateways.setup_done', '✓ Set up') : T('gateways.setup_pending', '⚠ Not set up yet');
    body.appendChild(status);

    if (!migrated) {
      var note = el('div', null, T('gateways.setup_note', 'The automatic Update button only works after this one-time host setup.'));
      note.style.cssText = 'background:var(--bg-body);padding:10px 12px;border-radius:6px;border-left:3px solid var(--amber,#d97706);font-size:13px;margin-bottom:14px';
      body.appendChild(note);
    }

    var dl = el('a', 'btn btn-primary', '⬇ ' + T('gateways.setup_download_update', 'Download update.sh'));
    dl.href = '/api/v1/gateways/' + g.peer_id + '/update-sh';
    dl.style.cssText = 'display:inline-flex;align-items:center;gap:6px;text-decoration:none';
    body.appendChild(dl);

    var CMD = 'PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=<compose-dir>/gateway-state <compose-dir>/update.sh';
    var d = el('details');
    d.style.cssText = 'margin-top:16px';
    var sum = el('summary', null, T('gateways.setup_guide', 'Step-by-step guide'));
    sum.style.cssText = 'cursor:pointer;font-weight:600;padding:6px 0';
    d.appendChild(sum);
    function steps(hostKey, hostDefault, stepKeys) {
      var h = el('h4', null, T(hostKey, hostDefault));
      h.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-2);margin:14px 0 6px';
      d.appendChild(h);
      var ol = el('ol'); ol.style.cssText = 'margin:0 0 10px 20px;padding:0;font-size:13px;line-height:1.5';
      stepKeys.forEach(function (sk) { ol.appendChild(el('li', null, T(sk[0], sk[1]))); });
      d.appendChild(ol);
      var pre = el('pre', null, CMD);
      pre.style.cssText = 'background:var(--bg-body);padding:10px 12px;border-radius:6px;font-size:11px;font-family:var(--font-mono);overflow-x:auto;border:1px solid var(--border);margin:0';
      d.appendChild(pre);
    }
    steps('gateways.setup_synology', 'Synology (DSM)', [
      ['gateways.setup_syn_1', "Put update.sh into your gateway's docker-compose folder."],
      ['gateways.setup_syn_2', 'DSM → Task Scheduler → Create → user-defined script (user root, repeat every 1 minute) with this command:'],
    ]);
    steps('gateways.setup_linux', 'Linux (systemd)', [
      ['gateways.setup_lin_1', "Put update.sh into your gateway's docker-compose folder."],
      ['gateways.setup_lin_2', 'Run it every minute (cron, or a systemd .path watching /state/pending-update) with this command:'],
    ]);
    var hint = el('p', null, T('gateways.setup_legacy_hint', "Gateway created before auto-update? Also add '- ./gateway-state:/state' to its compose volumes and recreate the container once."));
    hint.style.cssText = 'font-size:12px;color:var(--text-2);margin:12px 0 0;line-height:1.45';
    d.appendChild(hint);
    body.appendChild(d);
  }
  function openSetupModal(id) {
    var g = last.find(function (x) { return String(x.peer_id) === String(id); });
    if (!g) return;
    var bodyEl = document.getElementById('gw-setup-modal-body');
    if (!bodyEl) return;
    bodyEl.replaceChildren();
    populateSetupForm(g, bodyEl);
    if (window.openModal) window.openModal('gw-setup-modal-overlay');
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
  // `.top` (header with h3 + optional right-aligned action node) + `.body`
  // (padded content area). The CSS lives in `.gw-fleet .gw .top {...}` /
  // `.gw-fleet .gw .body {...}` (justify-content: space-between on .top).
  function _discCard(title, actionNode) {
    var card = el('div', 'gw');
    var top = el('div', 'top');
    top.appendChild(el('h3', null, title));
    if (actionNode) top.appendChild(actionNode);
    card.appendChild(top);
    var body = el('div', 'body');
    card.appendChild(body);
    return { card: card, body: body };
  }

  // Build a Lucide-style icon entirely via the DOM (no innerHTML, no XSS surface).
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function _icon(size, paths) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (p) {
      var n = document.createElementNS(SVG_NS, p.tag);
      Object.keys(p.attrs).forEach(function (k) { n.setAttribute(k, p.attrs[k]); });
      s.appendChild(n);
    });
    return s;
  }
  function discGearIcon() {
    return _icon(16, [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
      { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' } },
    ]);
  }
  function discScanIcon() {
    return _icon(16, [
      { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
      { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
    ]);
  }
  // Lucide "package" — used for the auto-update setup indicator.
  function discPackageIcon() {
    return _icon(16, [
      { tag: 'path', attrs: { d: 'M16.5 9.4 7.5 4.21' } },
      { tag: 'path', attrs: { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' } },
      { tag: 'polyline', attrs: { points: '3.27 6.96 12 12.01 20.73 6.96' } },
      { tag: 'line', attrs: { x1: '12', y1: '22.08', x2: '12', y2: '12' } },
    ]);
  }
  // Inject the spin keyframe once (used by the scan-icon during a running scan).
  // `<style>.textContent =` is the safe equivalent of an innerHTML CSS injection.
  (function injectSpinKeyframes() {
    if (document.getElementById('gw-css-inject')) return;
    var s = document.createElement('style');
    s.id = 'gw-css-inject';
    s.textContent = '@keyframes gw-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  })();

  // Well-known port → friendly service label (used only when service_hint is absent).
  var DISC_WELL_KNOWN = {
    21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3',
    139: 'SMB', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 515: 'LPD', 548: 'AFP', 631: 'IPP',
    1883: 'MQTT', 2049: 'NFS', 3000: 'HTTP', 3306: 'MySQL', 3389: 'RDP', 5000: 'HTTP',
    5432: 'PostgreSQL', 5683: 'CoAP', 5900: 'VNC', 6379: 'Redis', 8000: 'HTTP',
    8080: 'HTTP', 8081: 'HTTP', 8096: 'Jellyfin', 8123: 'HomeAssistant', 8200: 'DLNA',
    8443: 'HTTPS', 9000: 'HTTP', 9100: 'Print', 27017: 'MongoDB', 32400: 'Plex',
  };
  // Generic / uninformative SSDP Search-Target values that show up on essentially
  // every UPnP device — render them as "no hint" so the well-known port label can
  // win (or the chip stays clean with just the port number).
  var DISC_SSDP_GENERIC = { 'upnp:rootdevice': 1, 'ssdp:all': 1, 'urn:schemas-upnp-org:device:Basic:1': 1 };
  function discPortLabel(p) {
    var hint = p && p.service_hint ? String(p.service_hint) : '';
    if (hint && !DISC_SSDP_GENERIC[hint]) {
      // mDNS: `_http._tcp` / `_airplay._tcp.local` → http, airplay
      var m = hint.match(/^_([^.]+)\._(?:tcp|udp)(?:\.local\.?)?$/);
      if (m) return m[1];
      // SSDP URN: `urn:schemas-upnp-org:device:MediaServer:1` → MediaServer
      var u = hint.match(/^urn:[^:]+:(?:device|service):([^:]+)(?::\d+)?$/);
      if (u) return u[1];
      return hint.length > 24 ? hint.slice(0, 22) + '…' : hint;
    }
    return Object.prototype.hasOwnProperty.call(DISC_WELL_KNOWN, p.port) ? DISC_WELL_KNOWN[p.port] : '';
  }
  function discSourceLabel(src) { return T('gateways.discovery.source_' + src, String(src).toUpperCase()); }
  function discSourceTagClass(src) {
    return src === 'mdns' ? 'tag-blue' : src === 'ssdp' ? 'tag-purple' : src === 'tcp' ? 'tag-grey' : 'tag-neutral';
  }

  // One device row in the discovered-devices list. Hostname/IP/MAC + per-port
  // chips with service hints + source chips on the primary line. All untrusted
  // strings render via `el()` (textContent) — never `innerHTML`.
  function discDeviceRow(dev, isFirst) {
    var row = el('div', null);
    row.style.cssText = 'padding:10px 0' + (isFirst ? '' : ';border-top:1px solid var(--border)');

    var primary = el('div', null);
    primary.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
    var name = el('div', null, dev.hostname || dev.ip);
    name.style.cssText = 'font-weight:600;font-size:14px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    primary.appendChild(name);

    var chips = el('div', null);
    chips.style.cssText = 'display:flex;gap:4px;flex-shrink:0';
    (dev.sources || []).forEach(function (s) {
      var t = el('span', 'tag ' + discSourceTagClass(s), discSourceLabel(s));
      t.style.cssText = 'font-size:10px;padding:2px 6px;line-height:1.2';
      chips.appendChild(t);
    });
    primary.appendChild(chips);
    row.appendChild(primary);

    // Meta line: never repeat the IP when it's already the primary line
    // (i.e. no hostname). If hostname is present, show both IP + MAC; otherwise
    // only the MAC. Skip the line entirely when there's nothing to add.
    var metaParts = [];
    if (dev.hostname) metaParts.push(dev.ip);
    if (dev.mac) metaParts.push(dev.mac);
    if (metaParts.length) {
      var meta = el('div', null);
      meta.style.cssText = 'font-size:12px;color:var(--text-2);font-family:var(--font-mono);margin-top:3px;letter-spacing:-0.01em';
      meta.textContent = metaParts.join('  ·  ');
      row.appendChild(meta);
    }

    var ports = Array.isArray(dev.ports) ? dev.ports : [];
    if (ports.length) {
      var pwrap = el('div', null);
      pwrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px';
      ports.forEach(function (p) {
        var chip = el('span', 'tag tag-neutral');
        chip.style.cssText = 'font-size:11px;padding:3px 8px;display:inline-flex;align-items:center;gap:5px';
        var num = el('span', null, p.port);
        num.style.cssText = 'font-family:var(--font-mono);font-weight:600';
        chip.appendChild(num);
        var label = discPortLabel(p);
        if (label) {
          var sep = el('span', null, '·'); sep.style.cssText = 'color:var(--text-3)'; chip.appendChild(sep);
          chip.appendChild(el('span', null, label));
        }
        pwrap.appendChild(chip);
      });
      row.appendChild(pwrap);
    }

    return row;
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

  // Populate a container (the modal-body) with the discovery settings form for
  // gateway `g`. Closes the modal on a successful save (with a brief "saved"
  // confirmation). Extracted from the previous in-grid settings card.
  function populateDiscoverySettingsForm(g, body) {
    var tel = (g.health && g.health.telemetry) || {};
    if (tel.lan_discovery !== true) {
      body.appendChild(discMuted(T('routes.suggested.unavailable', 'Dieses Gateway unterstützt keine Discovery.')));
      return;
    }
    body.appendChild(discMuted(T('gateways.discovery.subtitle', '')));

    var subnets = Array.isArray(tel.lan_subnets) ? tel.lan_subnets : [];
    var cats = Array.isArray(tel.lan_discovery_categories) ? tel.lan_discovery_categories : [];
    var multi = !!(window.GC && GC.features && GC.features.gateway_lan_discovery_multi_subnet);

    function section(titleKey, titleFallback) {
      var h = el('div', null, T(titleKey, titleFallback));
      h.style.cssText = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-2);margin:14px 0 6px';
      return h;
    }
    function rowToggle(labelText, input, warn) {
      var row = el('label', null);
      row.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0';
      row.appendChild(input);
      var txt = el('span', null, labelText); txt.style.cssText = 'flex:1';
      row.appendChild(txt);
      if (warn) {
        var w = discMuted(warn);
        w.style.cssText = 'font-size:11px;color:var(--text-3);flex:0 0 auto;max-width:55%;text-align:right;line-height:1.35';
        row.appendChild(w);
      }
      return row;
    }

    var enableCb = el('input'); enableCb.type = 'checkbox';
    var activeCb = el('input'); activeCb.type = 'checkbox';
    var modeSel = el('select');
    modeSel.style.cssText = 'padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text-primary)';
    ['include', 'exclude'].forEach(function (m) { var o = el('option', null, T('gateways.discovery.mode_' + m, m)); o.value = m; modeSel.appendChild(o); });
    var subBoxes = subnets.map(function (s) { var c = el('input'); c.type = 'checkbox'; c.value = s.cidr; c.checked = !!s.primary; if (!multi && !s.primary) c.disabled = true; return { cb: c, s: s }; });
    var catBoxes = cats.map(function (c0) { var c = el('input'); c.type = 'checkbox'; c.value = c0.key; c.checked = true; return { cb: c, c: c0 }; });

    body.appendChild(section('gateways.discovery.title', 'Discovery'));
    body.appendChild(rowToggle(T('gateways.discovery.enable', 'Discovery aktivieren'), enableCb));
    body.appendChild(rowToggle(T('gateways.discovery.active_scan', 'Aktiver Portscan'), activeCb, T('gateways.discovery.active_scan_warn', '')));

    body.appendChild(section('gateways.discovery.subnets', 'Subnets to scan'));
    subBoxes.forEach(function (sb) { body.appendChild(rowToggle(sb.s.cidr + (sb.s.primary ? ' ★' : ''), sb.cb)); });
    if (!multi) {
      var locked = discMuted(T('gateways.discovery.multi_subnet_locked', ''));
      locked.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:4px';
      body.appendChild(locked);
    }

    body.appendChild(section('gateways.discovery.categories', 'Categories'));
    var modeRow = el('div', null);
    modeRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0';
    var modeLbl = el('span', null, T('gateways.discovery.category_mode', 'Category mode'));
    modeLbl.style.cssText = 'flex:1';
    modeRow.appendChild(modeLbl); modeRow.appendChild(modeSel);
    body.appendChild(modeRow);
    var catGrid = el('div', null);
    catGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:2px 12px;margin-top:4px';
    catBoxes.forEach(function (cb) { catGrid.appendChild(rowToggle(cb.c.label, cb.cb)); });
    body.appendChild(catGrid);

    // Prefill from saved settings (Task 2b fleet payload).
    enableCb.checked = !!(g.discovery && g.discovery.enabled);
    activeCb.checked = !!(g.discovery && g.discovery.active_scan);
    if (g.discovery && g.discovery.category_mode === 'exclude') modeSel.value = 'exclude';

    var footer = el('div', null);
    footer.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)';
    var saveMsg = el('div', null);
    saveMsg.style.cssText = 'font-size:12px;color:var(--text-2);margin-right:auto';
    var cancelBtn = el('button', 'btn', T('gateways.discovery.cancel', 'Cancel'));
    cancelBtn.type = 'button';
    cancelBtn.setAttribute('data-close-modal', '');
    var saveBtn = el('button', 'btn btn-primary', T('gateways.discovery.save', 'Save'));
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', function () {
      var payload = {
        enabled: enableCb.checked,
        active_scan: activeCb.checked,
        subnets: subBoxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.cb.value; }),
        category_mode: modeSel.value,
        categories: catBoxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.cb.value; }),
      };
      saveBtn.disabled = true;
      fetch('/api/v1/gateways/' + g.peer_id + '/discovery-settings', {
        method: 'PUT', credentials: 'same-origin', headers: discCsrfHeaders(), body: JSON.stringify(payload),
      }).then(function (r) {
        saveBtn.disabled = false;
        if (r.ok) {
          saveMsg.textContent = T('gateways.discovery.saved', 'Saved');
          // Reflect in-memory so the modal next time prefills correctly + the
          // empty-state hint in the devices card knows enabled.
          g.discovery = g.discovery || {};
          g.discovery.enabled = payload.enabled ? 1 : 0;
          g.discovery.active_scan = payload.active_scan ? 1 : 0;
          g.discovery.category_mode = payload.category_mode;
          setTimeout(function () { if (window.closeModal) window.closeModal('gw-discovery-modal-overlay'); }, 500);
          return;
        }
        return _discErrText(r, T('gateways.discovery.scan_failed', 'Save failed')).then(function (t) { saveMsg.textContent = t; });
      }).catch(function () { saveBtn.disabled = false; saveMsg.textContent = T('gateways.discovery.scan_failed', 'Save failed'); });
    });
    footer.appendChild(saveMsg);
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    body.appendChild(footer);
  }

  // Opens the discovery settings modal for the gateway with the given peer id,
  // populating it fresh from the in-memory `last` snapshot.
  function openDiscoverySettings(id) {
    var g = last.find(function (x) { return String(x.peer_id) === String(id); });
    if (!g) return;
    var bodyEl = document.getElementById('gw-discovery-modal-body');
    if (!bodyEl) return;
    bodyEl.replaceChildren();
    populateDiscoverySettingsForm(g, bodyEl);
    if (window.openModal) window.openModal('gw-discovery-modal-overlay');
  }

  function discoveredDevicesCard(g) {
    var tel = (g.health && g.health.telemetry) || {};

    // Title-row scan icon button (right-aligned in the .top row by .gw .top's
    // justify-content: space-between). The SVG itself is stored so we can spin
    // it via inline animation while a scan is running.
    var scanBtn = el('button', null);
    scanBtn.type = 'button';
    var scanIconNode = discScanIcon();
    scanBtn.appendChild(scanIconNode);
    scanBtn.title = T('gateways.discovery.scan_tooltip', 'Scan LAN');
    scanBtn.setAttribute('aria-label', T('gateways.discovery.scan_tooltip', 'Scan LAN'));
    scanBtn.style.cssText = 'background:none;border:1px solid var(--border);border-radius:6px;padding:5px 8px;cursor:pointer;color:var(--text-2);display:inline-flex;align-items:center;justify-content:center;transition:background 120ms ease, color 120ms ease';
    scanBtn.addEventListener('mouseenter', function () { if (this.disabled) return; this.style.background = 'var(--bg-hover, var(--bg-body))'; this.style.color = 'var(--text-primary)'; });
    scanBtn.addEventListener('mouseleave', function () { if (this.disabled) return; this.style.background = 'none'; this.style.color = 'var(--text-2)'; });
    function setScanRunning(running) {
      scanBtn.disabled = !!running;
      scanBtn.style.opacity = running ? '0.65' : '1';
      scanBtn.style.cursor = running ? 'wait' : 'pointer';
      scanIconNode.style.animation = running ? 'gw-spin 0.9s linear infinite' : '';
    }

    var frame = _discCard(T('gateways.discovery.devices_title', 'Discovered devices'), scanBtn);
    var body = frame.body;

    if (tel.lan_discovery !== true) {
      scanBtn.disabled = true; scanBtn.style.opacity = '0.4'; scanBtn.style.cursor = 'not-allowed';
      body.appendChild(discMuted(T('routes.suggested.unavailable', 'Dieses Gateway unterstützt keine Discovery.')));
      return frame.card;
    }

    var status = el('div', null);
    status.style.cssText = 'font-size:12px;color:var(--text-2);min-height:18px';
    var list = el('div', null);

    function emptyState() {
      var msg = (g.discovery && !g.discovery.enabled)
        ? T('gateways.discovery.not_enabled', 'Erst Discovery aktivieren und speichern.')
        : T('gateways.discovery.never_scanned', 'Noch nicht gescannt — Scan-Icon klicken, um zu starten.');
      var box = el('div', null, msg);
      box.style.cssText = 'padding:18px 0;text-align:center;color:var(--text-3);font-size:13px';
      return box;
    }
    function statusLine(devices, done, timedOut, updatedAt) {
      var parts = [];
      if (devices && devices.length) {
        var key = devices.length === 1 ? 'gateways.discovery.devices_count_one' : 'gateways.discovery.devices_count_other';
        parts.push(T(key, devices.length + ' devices').replace('{n}', devices.length));
      }
      if (done && timedOut) parts.push(T('gateways.discovery.timed_out', 'Scan timed out'));
      else if (updatedAt) parts.push(discAgeNote(updatedAt));
      return parts.join('  ·  ');
    }
    function render(devices, done, timedOut, updatedAt, inFlight) {
      list.replaceChildren();
      if (!devices || !devices.length) {
        list.appendChild(emptyState());
      } else {
        devices.forEach(function (dev, i) { list.appendChild(discDeviceRow(dev, i === 0)); });
      }
      status.textContent = statusLine(devices, done, timedOut, updatedAt);
      // Stop the spinner once the gateway reports a terminal batch.
      if (done) setScanRunning(false);
      // Surface a discoverability hint when the only data we have is passive
      // (no TCP-sweep) — explains the "only one port" feel without active scan.
      if (done && devices && devices.length && !(g.discovery && g.discovery.active_scan)) {
        var allPassive = devices.every(function (d) { return !(d.sources || []).some(function (s) { return s === 'tcp'; }); });
        if (allPassive) {
          var hint = el('div', null, T('gateways.discovery.active_scan_hint', 'Tip: enable Active port scan in the settings to find more ports.'));
          hint.style.cssText = 'font-size:11px;color:var(--text-3);font-style:italic;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)';
          list.appendChild(hint);
        }
      }
    }

    function loadCached() {
      fetch('/api/v1/gateways/' + g.peer_id + '/discovered', { credentials: 'same-origin' })
        .then(function (r) {
          if (r.ok) return r.json().then(function (d) {
            if (d.ok) {
              render(d.devices, d.done, d.timed_out, d.updated_at, d.in_flight);
              // If the server says a scan is still in flight when we mount,
              // keep the spinner running until the terminal SSE arrives.
              if (d.in_flight) setScanRunning(true);
            } else render([], false, false, null);
          });
          // 403 (license-locked) or 404 — surface so the admin knows why the card is empty.
          render([], false, false, null);
          return _discErrText(r, '').then(function (t) { if (t) status.textContent = t; });
        }).catch(function () {});
    }
    scanBtn.addEventListener('click', function () {
      setScanRunning(true);
      status.textContent = T('gateways.discovery.scanning', 'Scanning…');
      fetch('/api/v1/gateways/' + g.peer_id + '/discover', {
        method: 'POST', credentials: 'same-origin', headers: discCsrfHeaders(), body: '{}',
      }).then(function (r) {
        if (r.ok || r.status === 202) { status.textContent = T('gateways.discovery.scanning', 'Scanning…'); loadCached(); return; }
        setScanRunning(false);
        return _discErrText(r, T('gateways.discovery.scan_failed', 'Scan failed')).then(function (t) { status.textContent = t; });
      }).catch(function () { setScanRunning(false); status.textContent = T('gateways.discovery.scan_failed', 'Scan failed'); });
    });

    // Replace the previous SSE listener so it doesn't pile up across renderDetail re-runs.
    if (_discoveryListener) document.removeEventListener('gc:gateway_discovery', _discoveryListener);
    _discoveryListener = function (e) {
      var p = e.detail || {};
      if (String(p.peer_id) === String(g.peer_id)) render(p.devices, p.done, p.timed_out, Date.now(), !p.done);
    };
    document.addEventListener('gc:gateway_discovery', _discoveryListener);

    body.appendChild(status);
    body.appendChild(list);
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
    var ds = e.target.closest('[data-act="disc-settings"]'); if (ds) { openDiscoverySettings(ds.dataset.id); return; }
    var su = e.target.closest('[data-act="setup"]'); if (su) { openSetupModal(su.dataset.id); return; }
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
