(function () {
  'use strict';
  var GCt = (window.GC && GC.t) || {};
  var csrf = (window.GC && GC.csrfToken) || '';
  // Strings of the gateway assistant (gwiz.*) come in the page's JSON island.
  var GW = {};
  try { GW = JSON.parse((document.getElementById('gwiz-i18n') || {}).textContent || '{}') || {}; } catch (e) { GW = {}; }
  function T(k, d) { return GCt[k] || GW[k] || d; }
  // T with {{placeholders}} (the gwp.* strings come in the page's JSON island)
  function TT(k, params, d) {
    var s = String(T(k, d == null ? k : d));
    if (params) Object.keys(params).forEach(function (p) { s = s.split('{{' + p + '}}').join(String(params[p])); });
    return s;
  }
  // "vor 12 s", "vor 3 Min." …
  function agoT(ms) {
    if (!ms) return '—';
    var sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return TT('gwp.ago.s', { n: sec });
    if (sec < 3600) return TT('gwn.ago.min', { n: Math.round(sec / 60) });
    if (sec < 86400) return TT('gwn.ago.h', { n: Math.round(sec / 3600) });
    return TT('gwn.ago.d', { n: Math.round(sec / 86400) });
  }
  function UI() { return window.GCGatewayEdge && window.GCGatewayEdge.ui; }
  // In-app dialogs instead of confirm()/alert() (docs/feature-wave2.md §W1.2).
  var D = window.GCDialog;
  var grid = document.getElementById('fleet-grid');
  var kpis = document.getElementById('fleet-kpis');
  var warn = document.getElementById('version-warning');
  var fleetView = document.getElementById('fleet-view');
  var detailView = document.getElementById('gw-detail-view');
  var poolView = document.getElementById('gw-pool-view');
  // "Versionen" and "Handbuch" of a gateway (#gw/<id>/versions, #gw/<id>/handbook — gateway-docs.js)
  var docsView = document.getElementById('gw-docs-view');
  var DOCS = window.GCGatewayDocs;
  var GW_RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
  var last = [], latest = '', openId = null, openPool = null, routed = false;
  // Pools on this page (gateway-pool-kit.js: pure rules, gateway-pools-ui.js: views and dialogs)
  var PK = window.GCGatewayPoolKit;
  var P = window.GCGatewayPools;
  // Gateway-Standorte (gateway-locations.js): dialogs, sections per location, tags
  var L = window.GCGatewayLocations;
  // UI state of the detail view that must survive the redraw of every poll
  var menuOpen = false;           // the "Mehr" menu of the head
  var techOpen = {};              // peer id → <details> "Technische Details" open
  var routesAll = {};             // peer id → "Alle n Routen anzeigen" expanded
  var netExtra = null;            // { id, caps, node }: "Erkannte Geräte" + "Scan-Ziele" of the tab "Netzwerk", kept across polls
  var _discoveryListener = null; // replaced on every discoveredDevicesCard build to avoid leak on renderDetail re-runs

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function bar(p, lvl) { var b = el('div', 'bar'); var i = el('span', lvl ? 'fill ' + lvl : 'fill'); i.style.width = Math.max(0, Math.min(100, p)) + '%'; b.appendChild(i); return b; }
  function pct(used, total) { return total > 0 ? Math.round((used / total) * 100) : 0; }
  // The live state of the server (gateway-pool-kit.js liveOf: online | degraded |
  // updating | restarting | offline | pending) — the same answer on every card,
  // the head, the KPIs and the pool views.
  function status(g) {
    if (PK && PK.liveOf) return PK.liveOf(g).key;
    if (g.status === 'offline') return 'offline';
    if (!g.health || g.status === 'unknown') return 'pending';
    if (g.health.overall_healthy === false) return 'degraded';
    return 'online';
  }
  function liveLabel(st) { return st === 'updating' || st === 'restarting' ? T('gwp.live.' + st, st) : T('gateways.' + st, st); }
  function statusPill(g) { var st = status(g); return el('span', 'pill ' + st, liveLabel(st)); }
  // "14:20" (the end of an expected restart)
  function clockTime(ms) {
    try { return new Date(ms).toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; }
  }
  // A text that counts down to `until` ({{left}} → "m:ss"): data-gw-until + the
  // template data-gw-tpl, rewritten every second by liveTick().
  function countdownEl(tag, cls, key, params, until) {
    var tpl = TT(key, Object.assign({}, params || {}, { left: '{{left}}' }));
    var n = el(tag, cls, tpl.split('{{left}}').join(PK.clock(until - Date.now())));
    n.dataset.gwUntil = String(until); n.dataset.gwTpl = tpl;
    return n;
  }
  // The line under the status: back online but the routes wait for the
  // failback cooldown, or until when an update / restart may take.
  function liveHint(g, cls) {
    var lv = PK && PK.liveOf ? PK.liveOf(g) : null;
    if (!lv || !lv.hint) return null;
    if (lv.hint.key === 'gwp.live.expected_by') return el('div', cls, TT('gwp.live.expected_by', { time: clockTime(lv.hint.until) }));
    return countdownEl('div', cls, lv.hint.key, {}, lv.hint.until);
  }
  function ago(ms) { if (!ms) return '—'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; }
  function metricRow(parent, label, value, p, lvl) { var m = el('div', 'metric'); m.appendChild(el('span', null, label)); m.appendChild(el('span', null, value)); parent.appendChild(m); parent.appendChild(bar(p, lvl)); }
  function fmtGB(n) { return n ? (Math.round(n / 1e9 * 10) / 10) + ' GB' : '—'; }
  function kvRow(k, v, vcls) {
    var r = el('div', 'kv'); r.appendChild(el('div', 'k', k));
    if (v && v.nodeType) { var vn = el('div', vcls ? 'v ' + vcls : 'v'); vn.appendChild(v); r.appendChild(vn); }
    else r.appendChild(el('div', vcls ? 'v ' + vcls : 'v', v));
    return r;
  }

  // ── Fleet cards + detail view (Aurora unit-grid / 3-column detail) ────────
  function gwAvatarGradient(g) {
    if (status(g) !== 'online') return 'linear-gradient(145deg,#9aa6b2,#6b7682)';
    var id = String(g.peer_id || ''), sum = 0;
    for (var ci = 0; ci < id.length; ci++) sum += id.charCodeAt(ci);
    var p = ['linear-gradient(145deg,#7ae0d2,#28b3a2)', 'linear-gradient(145deg,#9db8ff,#5b76d6)', 'linear-gradient(145deg,#c4b5fd,#7c3aed)', 'linear-gradient(145deg,#fda4af,#e11d48)'];
    return p[sum % p.length];
  }
  function gwCardIcon() {
    var s = document.createElementNS(SVG_NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    [['3', '4'], ['3', '14']].forEach(function (xy) {
      var r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', xy[0]); r.setAttribute('y', xy[1]); r.setAttribute('width', '18'); r.setAttribute('height', '6');
      r.setAttribute('rx', '2'); r.setAttribute('stroke', 'currentColor'); r.setAttribute('stroke-width', '2');
      s.appendChild(r);
    });
    return s;
  }
  function resRow(parent, label, valueText, pctVal, isHot) {
    var row = el('div', 'urow'); row.appendChild(el('span', null, label)); row.appendChild(el('b', null, valueText));
    parent.appendChild(row);
    var rb = el('div', 'resbar'); var fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, pctVal)) + '%';
    if (isHot) fill.className = 'hot'; rb.appendChild(fill); parent.appendChild(rb);
  }
  // A gateway that never reported yet: "wartet auf ersten Start" + "Einrichtung fortsetzen"
  // (opens the assistant at step 3 for its platform — docs/feature-gateway-wizard.md).
  function agoLong(ms) {
    if (!ms) return '—';
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return T('gwiz.card.min', '{{n}} Min.').replace('{{n}}', m);
    var h = Math.round(m / 60);
    if (h < 48) return T('gwiz.card.hours', '{{n}} Std.').replace('{{n}}', h);
    return T('gwiz.card.days', '{{n}} Tagen').replace('{{n}}', Math.round(h / 24));
  }
  function platformLabel(p) { return p ? T('gwiz.platform.' + p, p) : ''; }
  function waitIcon() {
    var s = document.createElementNS(SVG_NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('aria-hidden', 'true');
    var c = document.createElementNS(SVG_NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9');
    var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', 'M12 7v5l3 2');
    [c, p].forEach(function (n) { n.setAttribute('stroke', 'currentColor'); n.setAttribute('stroke-width', '2'); n.setAttribute('stroke-linecap', 'round'); s.appendChild(n); });
    return s;
  }
  function waitingCard(g) {
    var wrap = el('div', 'gw unit gw-waiting'); wrap.dataset.id = g.peer_id;
    var uh = el('div', 'uh');
    var uav = el('span', 'uav gw-waiting-ic'); uav.appendChild(waitIcon());
    uh.appendChild(uav);
    var nameWrap = el('div'); nameWrap.style.cssText = 'flex:1;min-width:0;overflow:hidden';
    var unEl = el('div', 'un', g.name); unEl.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    nameWrap.appendChild(unEl);
    var sub = [platformLabel(g.platform), T('gwiz.card.created_ago', 'angelegt vor {{x}}').replace('{{x}}', agoLong(g.created_at))].filter(Boolean).join(' · ');
    nameWrap.appendChild(el('div', 'ud', sub));
    uh.appendChild(nameWrap);
    var tag = el('span', 'tag tag-amber tag-dot', T('gwiz.card.waiting', 'wartet auf ersten Start'));
    tag.style.cssText = 'margin-left:auto;flex-shrink:0';
    uh.appendChild(tag);
    wrap.appendChild(uh);
    wrap.appendChild(el('p', 'gw-waiting-text', T('gwiz.card.never_connected', 'Noch nie verbunden. Die Einrichtung kannst du jederzeit fortsetzen.')));
    var btn = el('button', 'btn btn-ghost btn-sm gw-resume', T('gwiz.card.resume', 'Einrichtung fortsetzen'));
    btn.type = 'button'; btn.dataset.id = g.peer_id;
    wrap.appendChild(btn);
    return wrap;
  }
  function zigbeeRadio(t) {
    var hw = t && t.hardware;
    var r = hw && Array.isArray(hw.radios) ? hw.radios.find(function (x) { return x && x.kind === 'zigbee' && (x.detected || x.enabled); }) : null;
    if (!r) return null;
    var onGpio = /ttyAMA|serial0|ttyS/.test(r.device || '');
    var names = { 'raspbee2-conbee2': onGpio ? 'RaspBee II' : 'ConBee II', conbee3: 'ConBee III', 'raspbee-conbee-1': onGpio ? 'RaspBee' : 'ConBee', 'conbee-usb': 'ConBee' };
    return (names[r.type] || T('gwiz.s4.zigbee_radio', 'Funkmodul')) + ' · Zigbee';
  }
  // The switched-on functions of a gateway as chips (features_on of GET
  // /api/v1/gateways, gateway-pool-kit.js featureChips): three names, the rest
  // behind "+N" — a link to the tab "Funktionen", where the switches are.
  function featureChips(g) {
    var fc = PK && PK.featureChips ? PK.featureChips(g.features_on) : { shown: [], more: [] };
    if (!fc.shown.length) return null;
    var name = function (k) { return T('gwp.fname.' + k, k); };
    var row = el('div', 'gwe-chips gw-card-feats');
    row.setAttribute('role', 'list');
    row.setAttribute('aria-label', T('gwp.card.features', 'Eingeschaltete Funktionen'));
    fc.shown.forEach(function (k) {
      var c = el('span', 'gwe-chip', name(k)); c.dataset.feature = k; c.setAttribute('role', 'listitem');
      row.appendChild(c);
    });
    if (fc.more.length) {
      var rest = fc.more.map(name).join(', ');
      var m = el('a', 'gwe-chip gw-card-feats-more', '+' + fc.more.length);
      m.href = '#gw/' + encodeURIComponent(g.peer_id) + '/features';
      m.title = rest; m.dataset.more = fc.more.join(' '); m.setAttribute('role', 'listitem');
      m.setAttribute('aria-label', TT('gwp.card.features_more', { n: fc.more.length, list: rest }));
      row.appendChild(m);
    }
    return row;
  }
  // A fleet card. `role` ({ pool, member }) when shown in a pool group: the tag
  // "1 · arbeitet gerade" / "2 · Reserve, springt ein" / "2 · offline".
  // byLoc: the card sits in a section of a location (gateway-locations.js) — the role tag names the pool
  function card(g, role, byLoc) {
    if (g.never_connected) return withLocTag(waitingCard(g), g, byLoc);
    var t = (g.health && g.health.telemetry) || {};
    var st = status(g);
    var wrap = el('div', 'gw unit'); wrap.dataset.id = g.peer_id; wrap.dataset.live = st;
    if (st === 'offline') wrap.style.opacity = '0.7';
    // Header: avatar + name/version + status tag
    var uh = el('div', 'uh');
    var uav = el('span', 'uav'); uav.style.background = gwAvatarGradient(g); uav.appendChild(gwCardIcon());
    uh.appendChild(uav);
    var nameWrap = el('div'); nameWrap.style.cssText = 'flex:1;min-width:0;overflow:hidden';
    var unEl = el('a', 'un gw-card-link', g.name); unEl.href = '#gw/' + encodeURIComponent(g.peer_id);
    unEl.style.cssText = 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    nameWrap.appendChild(unEl);
    var hwModel = t.hardware && t.hardware.model ? String(t.hardware.model) : platformLabel(g.platform);
    nameWrap.appendChild(el('div', 'ud', [hwModel, t.gateway_version || '—'].filter(Boolean).join(' · ')));
    uh.appendChild(nameWrap);
    var tone = PK && PK.liveOf ? PK.liveOf(g).tone : (st === 'online' ? 'green' : st === 'degraded' ? 'amber' : 'grey');
    var stTag = el('span', 'tag tag-' + tone + ' tag-dot', liveLabel(st));
    stTag.dataset.live = st;
    // Header right cluster: status badge (left) + update-check icon (right).
    var right = el('span'); right.style.cssText = 'margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex-shrink:0';
    right.appendChild(stTag);
    // Update-check icon button (.recheck → grid click handler → probe()); replaces
    // the former full-width "Check update" button at the card foot.
    var rcBtn = el('button', 'icon-action recheck'); rcBtn.dataset.id = g.peer_id;
    rcBtn.title = T('gateways.update_check', 'Check update');
    rcBtn.setAttribute('aria-label', rcBtn.title);
    rcBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
    right.appendChild(rcBtn);
    uh.appendChild(right);
    wrap.appendChild(uh);
    // Name im VPN (vpn-names.js): what the gateway is reachable as, with a copy button
    if (g.hostname && window.GCVpnNames) wrap.appendChild(window.GCVpnNames.chip(g.hostname, 'gw-vn'));
    // Role in the pool group (or the route count of a single gateway)
    var tags = el('div', 'gw-card-tags');
    if (role && PK) {
      var r = PK.roleOf(role.pool, role.member);
      var rt = r.until ? countdownEl('span', 'tag tag-' + r.tone, r.key, r.params, r.until) : el('span', 'tag tag-' + r.tone, TT(r.key, r.params));
      rt.setAttribute('data-role', role.member.state);
      if (byLoc) {
        var pre = TT('gwp.loc.pool_tag', { name: role.pool.name }) + ' · ';
        if (rt.dataset.gwTpl) rt.dataset.gwTpl = pre + rt.dataset.gwTpl;
        rt.textContent = pre + rt.textContent;
      }
      tags.appendChild(rt);
    }
    var nr = (g.routes || []).length;
    if (!role && nr) tags.appendChild(el('span', 'tag tag-grey', TT(nr === 1 ? 'gwp.card.routes_one' : 'gwp.card.routes', { n: nr })));
    var lt = L && !byLoc ? L.cardTag(g) : null;
    if (lt) tags.appendChild(lt);
    if (tags.childNodes.length) wrap.appendChild(tags);
    // the failback wait (in a pool group the role tag already counts it down);
    // an update / restart says its expected time in the body below
    var hint = role || (st !== 'online' && st !== 'degraded') ? null : liveHint(g, 'gw-live-hint');
    if (hint) wrap.appendChild(hint);
    // Body: resource bars (online/degraded) or empty-state (offline / updating / restarting)
    if (st === 'offline' || st === 'updating' || st === 'restarting') {
      var emptyTxt = st === 'offline' ? T('gateways.sub_heartbeat', 'last heartbeat') + ' ' + ago(g.last_seen_at)
        : TT('gwp.live.' + st + '_card', { ago: agoT(g.offline_since || g.last_seen_at) });
      if (st !== 'offline' && g.expected_back_by) emptyTxt += ' · ' + TT('gwp.live.expected_by', { time: clockTime(g.expected_back_by) });
      if (st === 'offline' && g.update_available && latest) emptyTxt += ' · Drift: ' + (t.gateway_version || '—') + ' → ' + latest;
      wrap.appendChild(el('div', 'empty-state', emptyTxt));
    } else {
      var cores = t.cpu_cores || 1; var load1 = (t.cpu_load_avg && t.cpu_load_avg[0]) || 0; var cpuPct = pct(load1, cores);
      resRow(wrap, 'CPU', cpuPct + '%', cpuPct, cpuPct > 90);
      if (t.mem_total) { var mp = pct(t.mem_used, t.mem_total); resRow(wrap, 'RAM', mp + '%', mp, mp > 90); }
      if (t.disk && t.disk.total) { var dp = pct(t.disk.used, t.disk.total); resRow(wrap, T('gateways.lbl_disk', 'Disk'), dp + '%', dp, dp > 85); }
    }
    var feats = featureChips(g);
    if (feats) wrap.appendChild(feats);
    var zr = zigbeeRadio(t);
    if (zr) { var zt = el('span', 'tag tag-blue gw-radio', zr); wrap.appendChild(zt); }
    // (Update-check moved to the header icon button above.)
    return wrap;
  }
  // "Was ist neu?": "Versionen" of the gateway, the newer versions flagged (gateway-docs.js)
  function whatsNewLink(g) {
    var a = el('a', 'gwn-link gw-whats-new', T('gwd.whats_new', 'Was ist neu?'));
    a.href = DOCS ? DOCS.versionsHref(g) : GW_RELEASES;
    if (!DOCS) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.dataset.act = 'whats-new';
    return a;
  }
  // ── Detail view: head, tabs, the tab "Übersicht" ──────────────────────────
  function cardFrame(title, right, id, cls) {
    var U = UI();
    if (U) return U.card(title, right, { id: id, cls: cls });
    var c = el('section', 'gw gwe-card' + (cls ? ' ' + cls : '')); var top = el('div', 'top gwe-top'); top.appendChild(el('h3', null, title));
    if (right) top.appendChild(right); var body = el('div', 'body gwe-body'); c.appendChild(top); c.appendChild(body);
    return { card: c, top: top, body: body };
  }
  function tagEl(tone, text, dot) { return el('span', 'tag tag-' + tone + (dot ? ' tag-dot' : ''), text); }
  function shortDigest(t) {
    if (!t.image_digest) return null;
    var di = String(t.image_digest); var at = di.lastIndexOf('@sha256:'); if (at !== -1) di = di.slice(at + 8);
    return di.slice(-12);
  }
  // "Gerät & Software" (was "Versionen & System"): the everyday facts on top,
  // the technical rows in <details> "Technische Details" (open state kept per gateway).
  function deviceCard(g) {
    var t = (g.health && g.health.telemetry) || {}, h = g.health || {};
    var c = cardFrame(T('gwp.dev.title', 'Gerät & Software'), null, 'dev', 'gwo-dev');
    var body = c.body;
    if (L) body.appendChild(L.deviceRow(g, kvRow));
    var dev = [t.hardware && t.hardware.model ? String(t.hardware.model) : platformLabel(g.platform), t.arch,
      t.cpu_cores != null ? TT('gwn.feat.cores', { n: t.cpu_cores }) : null, t.os_platform ? (t.os_platform + (t.os_release ? ' ' + t.os_release : '')) : null].filter(Boolean);
    body.appendChild(kvRow(T('gwp.dev.device', 'Gerät'), dev.length ? dev.join(' · ') : '—'));
    var gwVal = el('span'); gwVal.appendChild(document.createTextNode((t.gateway_version || '—') + ' '));
    if (g.update_available && latest) gwVal.appendChild(el('span', 'badge drift', '↑ ' + latest));
    else if (t.gateway_version && latest) gwVal.appendChild(el('span', 'gwe-d', TT('gwp.head.current')));
    body.appendChild(kvRow(T('gateways.lbl_gateway', 'Gateway'), gwVal));
    var lan = el('span');
    if (t.lan_ip) lan.appendChild(el('code', null, t.lan_ip));
    if (t.default_gateway_ip) { if (t.lan_ip) lan.appendChild(document.createTextNode(' · ')); lan.appendChild(document.createTextNode(TT('gwp.dev.router') + ' ')); lan.appendChild(el('code', null, t.default_gateway_ip)); }
    body.appendChild(kvRow(T('gwp.dev.lan', 'Heimnetz'), lan.childNodes.length ? lan : '—'));
    var upd = [t.last_pull_at ? agoT(t.last_pull_at) : T('gateways.last_pull_never', 'never')];
    var dg = shortDigest(t); if (dg) upd.push(TT('gwp.dev.image', { digest: dg }));
    body.appendChild(kvRow(T('gwp.dev.updated', 'Letztes Update'), upd.join(' · ')));
    var d = el('details', 'gwo-tech'); d.open = !!techOpen[g.peer_id];
    d.addEventListener('toggle', function () { techOpen[g.peer_id] = d.open; });
    var sum = el('summary', null, T('gwp.dev.tech', 'Technische Details')); sum.dataset.fk = 'gwo-tech'; d.appendChild(sum);
    var tb = el('div', 'gwo-tech-b');
    tb.appendChild(kvRow(T('gateways.lbl_node', 'Node'), t.node_version || '—'));
    tb.appendChild(kvRow(T('gateways.lbl_wgtools', 'wg-tools'), t.wg_tools_version || '—'));
    tb.appendChild(kvRow(T('gateways.lbl_dns_resolvers', 'DNS resolvers'), (t.dns_resolvers && t.dns_resolvers.length) ? t.dns_resolvers.join(', ') : '—'));
    var cfgVal;
    if (h.config_hash) {
      cfgVal = el('span'); cfgVal.appendChild(document.createTextNode('✓ ' + T('gateways.config_synced', 'synchron') + ' · '));
      cfgVal.appendChild(el('code', null, String(h.config_hash).slice(0, 8)));
    } else { cfgVal = T('gateways.config_unknown', 'unbekannt'); }
    tb.appendChild(kvRow(T('gateways.lbl_config_hash', 'Config hash'), cfgVal));
    tb.appendChild(kvRow(T('gateways.lbl_image_digest', 'Image'), dg || '—'));
    tb.appendChild(kvRow(T('gateways.lbl_default_gw', 'Default gateway (LAN)'), t.default_gateway_ip || '—'));
    d.appendChild(tb);
    body.appendChild(d);
    return c.card;
  }
  // "Zustand": "Alles in Ordnung" or what needs a look first (gateway-pool-kit.js healthChecks)
  var MARK = { ok: '✓', warn: '!', bad: '✗', info: 'i' };
  function stateCard(g) {
    var net = window.GCGatewayNet;
    var lv = PK.liveOf ? PK.liveOf(g) : null;
    var fb = lv && lv.hint && lv.hint.key !== 'gwp.live.expected_by' ? { key: lv.hint.key, left: PK.clock(lv.hint.until - Date.now()), until: lv.hint.until } : null;
    var checks = PK.healthChecks(g, { status: status(g), latest: latest, fresh: net && net.fresh ? net.fresh(g.peer_id) : null, agoText: agoT(g.last_seen_at),
      untilText: g.expected_back_by ? clockTime(g.expected_back_by) : null, failback: fb });
    var tone = PK.overall(checks);
    var c = cardFrame(T('gwp.state.title', 'Zustand'), null, 'state', 'gwo-state');
    var ban = el('div', 'gwo-banner gwo-banner-' + tone); ban.setAttribute('data-tone', tone);
    var U = UI(); if (U) ban.appendChild(U.icon(tone === 'ok' ? 'check' : 'warn', 20));
    ban.appendChild(el('strong', null, T('gwp.state.overall_' + tone)));
    c.body.appendChild(ban);
    var ul = el('ul', 'gwo-checks');
    checks.forEach(function (ch) {
      var li = el('li'); li.setAttribute('data-tone', ch.tone); li.setAttribute('data-check', ch.key.replace('gwp.state.', ''));
      var mk = el('span', 'tag gwo-mark tag-' + ({ ok: 'green', warn: 'amber', bad: 'red', info: 'blue' }[ch.tone]), MARK[ch.tone]); mk.setAttribute('aria-hidden', 'true');
      li.appendChild(mk);
      li.appendChild(el('span', 'sr-only', T('gwp.state.tone_' + ch.tone) + ': '));
      li.appendChild(ch.until ? countdownEl('span', null, ch.key, ch.params, ch.until) : el('span', null, TT(ch.key, ch.params)));
      if (ch.note) li.appendChild(document.createTextNode(' ' + TT(ch.note.key, ch.note.params)));
      if (ch.link) { li.appendChild(document.createTextNode(' – ')); var a = el('a', 'gwn-link', T('gwp.state.look')); a.href = '#gw/' + encodeURIComponent(g.peer_id) + '/' + ch.link; li.appendChild(a); }
      if (ch.key === 'gwp.state.update') { li.appendChild(document.createTextNode(' – ')); li.appendChild(whatsNewLink(g)); }
      ul.appendChild(li);
    });
    c.body.appendChild(ul);
    return c.card;
  }
  // The tab "Übersicht": Zustand · Pool · Funktionen, then Gerät & Software · Auslastung, then the routes.
  function overview(panel, g) {
    var top = el('div', 'gwo-top');
    top.appendChild(stateCard(g));
    if (P) top.appendChild(P.poolCard(g));
    if (window.GCGatewayNet) top.appendChild(window.GCGatewayNet.summaryCard(g));
    panel.appendChild(top);
    var two = el('div', 'gwo-two');
    two.appendChild(deviceCard(g));
    two.appendChild(resourcesCard(g));
    panel.appendChild(two);
    panel.appendChild(routesCard(g));
  }
  // "Erkannte Geräte" + "Scan-Ziele (Egress)" below the tab "Netzwerk" — independent of the
  // network watch (shown under its off-note too). Built once per visit: their own loads and the
  // open add form survive the redraw of every poll. Both cards are built from what the gateway
  // reported (lan_discovery, scan_egress): a report that changes that builds them anew — a page
  // opened before the gateway's first heartbeat must not keep "unterstützt keine Discovery".
  function netExtras(g) {
    var telE = (g.health && g.health.telemetry) || {};
    var caps = (telE.lan_discovery === true ? 'd' : '') + (telE.scan_egress === true ? 'e' : '');
    if (netExtra && netExtra.id === String(g.peer_id) && netExtra.caps === caps) return netExtra.node;
    var row = el('div', 'gw-half-row gw-net-extras');
    row.appendChild(discoveredDevicesCard(g));
    if (telE.scan_egress === true) row.appendChild(egressCard(g));
    netExtra = { id: String(g.peer_id), caps: caps, node: row };
    return row;
  }
  // Tabs of the detail view: "Übersicht" (below), "Funktionen", "Netzwerk" and "Internet"
  // (gateway-net.js), "DNS-Filter" and "Zwischenspeicher" (gateway-home.js), "Edge-Plugins"
  // and "MQTT" (gateway-edge.js). The tab is part of the address:
  // #gw/<id>[/features|/net|/inet|/dns|/cache|/edge|/mqtt].
  var openTab = 'overview';
  function renderDetail(g) {
    // typing in the add form of "Scan-Ziele": do not take the field away (next poll draws)
    if (netExtra && openTab === 'net' && netExtra.node.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    // The view is rebuilt on every poll: keep the focus on the same control.
    var act = document.activeElement, fkNode = act && detailView.contains(act) && act.closest ? act.closest('[data-fk]') : null;
    var fk = fkNode ? fkNode.getAttribute('data-fk') : null;
    var root = el('div', 'gw-detail');
    var back = el('button', 'gw-back', '← ' + T('gwp.back', 'Alle Gateways')); back.dataset.act = 'back'; back.type = 'button'; back.dataset.fk = 'gw-back';
    root.appendChild(back);
    root.appendChild(detailHead(g));
    var E = window.GCGatewayEdge;
    var tab = E ? openTab : 'overview';
    if (tab !== 'net') netExtra = null;
    var panel = el('div', 'gw-tabpanel');
    if (E) {
      root.appendChild(E.tabs(g, tab));
      panel.id = 'gwe-tabpanel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'gwe-tab-' + tab);
    }
    root.appendChild(panel);
    if (tab === 'net') {
      panel.classList.add('gw-tabpanel-stack');
      var netBox = el('div');
      panel.appendChild(netBox);
      E.mount(netBox, g, tab, { latest: latest });
      panel.appendChild(netExtras(g));
      detailView.replaceChildren(root);
      restoreFk(fk);
      return;
    }
    if (tab !== 'overview') {
      E.mount(panel, g, tab, { latest: latest });
      detailView.replaceChildren(root);
      restoreFk(fk);
      return;
    }
    if (E) { E.unmount(); E.prefetch(g); }
    overview(panel, g);
    detailView.replaceChildren(root);
    restoreFk(fk);
  }
  function restoreFk(fk) {
    if (!fk) return;
    var n = detailView.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(fk) : fk) + '"]');
    if (n && !n.disabled) n.focus({ preventScroll: true });
  }

  function kpi(cls, n, label, sub) {
    var k = el('div', 'kpi' + (cls ? ' ' + cls : '')); k.appendChild(el('div', 'n', n)); k.appendChild(el('div', 'l', label));
    if (sub) k.appendChild(el('div', 's', sub));
    return k;
  }

  // ── Head: name, status, facts, pool chip, "Neu prüfen", "Update auf X", "Mehr" ──
  var CHEVRON = [{ tag: 'path', attrs: { d: 'm6 9 6 6 6-6' } }];
  function detailHead(g) {
    var tel0 = (g.health && g.health.telemetry) || {};
    var ph = el('div', 'page-h gw-head');
    var left = el('div', 'gw-head-t');
    var hd = el('h2'); hd.appendChild(document.createTextNode(g.name + ' ')); hd.appendChild(statusPill(g));
    left.appendChild(hd);
    var sub = el('p', 'page-sub');
    var parts = [];
    if (g.ip) { var tn = el('span'); tn.appendChild(document.createTextNode(T('gateways.sub_tunnel', 'Tunnel') + ' ')); tn.appendChild(el('code', null, g.ip)); parts.push(tn); }
    parts.push(document.createTextNode(TT('gwp.head.heartbeat', { ago: agoT(g.last_seen_at) })));
    if (tel0.gateway_version) {
      parts.push(document.createTextNode(TT(g.update_available && latest ? 'gwp.head.version_drift' : (latest ? 'gwp.head.version_current' : 'gwp.head.version'), { v: tel0.gateway_version, latest: latest })));
    }
    parts.forEach(function (n, i) { if (i) sub.appendChild(document.createTextNode(' · ')); sub.appendChild(n); });
    left.appendChild(sub);
    // Name im VPN: the full name with a copy button, next to the VPN address
    if (g.hostname && window.GCVpnNames) left.appendChild(window.GCVpnNames.chip(g.hostname, 'gw-vn'));
    var hh = liveHint(g, 'page-sub gw-live-hint');
    if (hh) left.appendChild(hh);
    // chips: location (→ "Standort von …"), pool membership (→ pool page), auto-update
    var chips = el('div', 'gw-head-chips');
    var lc = L ? L.headChip(g) : null;
    if (lc) chips.appendChild(lc);
    if (P && PK) {
      PK.poolsOf(P.pools(), g.peer_id).forEach(function (p) {
        var m = PK.memberOf(p, g.peer_id);
        var a = el('a', 'tag tag-blue gw-pool-chip', TT('gwp.head.pool_chip', { name: p.name, role: T('gwp.mstate.' + (m && m.state === 'active' && p.mode === 'load_balancing' ? 'lb_active'
          : (m && m.state === 'standby' && PK.reserveGap(p, m) ? 'standby_partial' : (m ? m.state : 'offline')))) }));
        a.href = '#pool/' + p.id; a.dataset.fk = 'gw-pool-chip:' + p.id;
        chips.appendChild(a);
      });
    }
    var setupDone = !!tel0.state_dir_writable;
    chips.appendChild(tagEl(setupDone ? 'green' : 'amber', T(setupDone ? 'gwp.head.au_on' : 'gwp.head.au_off'), true));
    left.appendChild(chips);
    ph.appendChild(left);

    var act = el('div', 'gw-detail-actions gw-head-actions');
    var rc = el('button', 'btn btn-ghost', T('gateways.recheck', 'Neu prüfen')); rc.type = 'button'; rc.dataset.id = g.peer_id; rc.dataset.act = 'recheck'; rc.dataset.fk = 'gw-recheck';
    act.appendChild(rc);
    if (g.update_available) {
      var migrated = !!tel0.state_dir_writable;
      var up = el('button', 'btn btn-primary gw-update', T('gateways.update_to', 'Update auf') + ' ' + (latest || ''));
      up.type = 'button'; up.dataset.act = 'update'; up.dataset.id = g.peer_id; up.dataset.fk = 'gw-update';
      if (!migrated) { up.disabled = true; up.title = T('gateways.update_not_migrated', 'Gateway not migrated for in-place updates'); }
      if (g.update_state === 'updating') up.disabled = true;
      act.appendChild(up);
    }
    // "Mehr": the rarer actions as a real menu (keyboard: ↓/↑, Home/End, Escape)
    var wrap = el('div', 'gw-more');
    var more = el('button', 'btn btn-ghost gw-more-btn');
    more.type = 'button'; more.id = 'gw-more-btn'; more.dataset.fk = 'gw-more'; more.dataset.act = 'more';
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-controls', 'gw-more-menu'); more.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    more.appendChild(document.createTextNode(T('gwp.menu.more', 'Mehr') + ' '));
    more.appendChild(_icon(14, CHEVRON));
    var menu = el('div', 'gw-menu'); menu.id = 'gw-more-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', 'gw-more-btn');
    menu.hidden = !menuOpen;
    function item(action, label, danger) {
      var b = el('button', 'gw-menu-item' + (danger ? ' gw-menu-danger' : ''), label);
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
      b.dataset.act = action; b.dataset.id = g.peer_id; b.dataset.fk = 'gw-menu:' + action;
      menu.appendChild(b);
      return b;
    }
    // "Nur docker-compose.yml herunterladen" (gateway-edge.js): the current compose, no new keys —
    // not for the Pi image, which keeps its compose itself.
    if (window.GCGatewayCompose && g.platform !== 'rpi') item('compose', T('gwe.compose.button', 'Nur docker-compose.yml herunterladen'));
    item('setup', T(setupDone ? 'gwp.menu.setup_done' : 'gwp.menu.setup', 'Auto-Update einrichten'));
    // Discovery settings, only when the gateway reports the capability flag.
    if (tel0.lan_discovery === true) item('disc-settings', T('gwp.menu.discovery', 'Geräte-Erkennung einstellen'));
    if (L) item('location', T('gwp.loc.menu', 'Standort ändern …'));
    var pa = item('pool-add', T('gwp.menu.pool', 'Zu einem Pool hinzufügen …'));
    if (P && !P.licensed) pa.appendChild(P.lockTag());
    // "Versionen" (each version with its changes, the installed one marked) and "Handbuch",
    // like the tabs of a plugin (gateway-docs.js); without it the releases on GitHub
    function link(action, label, href) {
      var a = el('a', 'gw-menu-item', label);
      a.href = href; a.setAttribute('role', 'menuitem'); a.tabIndex = -1; a.dataset.fk = 'gw-menu:' + action; a.dataset.act = action;
      if (/^https:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      menu.appendChild(a);
      return a;
    }
    link('versions', T('gwp.menu.versions', 'Versionen'), DOCS ? DOCS.versionsHash(g.peer_id) : GW_RELEASES);
    if (DOCS) link('handbook', T('gwp.menu.handbook', 'Handbuch'), DOCS.handbookHash(g.peer_id));
    // rename, connection data, proxy port, disable, delete (gateway-manage.js; moved here from Peers)
    if (window.GCGatewayManage) window.GCGatewayManage.menuItems(g, item, menu);
    wrap.appendChild(more);
    wrap.appendChild(menu);
    act.appendChild(wrap);
    ph.appendChild(act);
    // Update progress is surfaced via a global, colour-coded toast (see
    // reconcileUpdateToast, driven from render()) — NOT inline. Inline status
    // text reflowed the action row's buttons/icons on every status change.
    return ph;
  }
  function menuItems() { var m = detailView.querySelector('#gw-more-menu'); return m ? Array.prototype.filter.call(m.querySelectorAll('[role="menuitem"]'), function (n) { return !n.disabled; }) : []; }
  function setMenu(open, focus) {
    menuOpen = !!open;
    var btn = detailView.querySelector('#gw-more-btn'), menu = detailView.querySelector('#gw-more-menu');
    if (!btn || !menu) return;
    menu.hidden = !menuOpen;
    btn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    var items = menuItems();
    if (menuOpen && focus === 'first' && items[0]) items[0].focus();
    else if (menuOpen && focus === 'last' && items.length) items[items.length - 1].focus();
    else if (!menuOpen && focus === 'button') btn.focus();
  }
  function resourcesCard(g) {
    var t = (g.health && g.health.telemetry) || {}, h = g.health || {};
    var c = cardFrame(T('gwp.load.title', 'Auslastung'), null, 'load', 'gwo-load');
    var body = c.body;
    var metrics = el('div', 'gw-metrics');
    var cores = t.cpu_cores || 1, la = t.cpu_load_avg || [];
    metricRow(metrics, T('gateways.lbl_cpu_load', 'CPU-Last 1m / 5m / 15m'),
      la.length ? la.map(function (x) { return Number(x).toFixed(2); }).join(' · ') : '—',
      pct(la[0] || 0, cores), (pct(la[0] || 0, cores) > 90 ? 'bad' : null));
    if (t.mem_total) { var mp = pct(t.mem_used, t.mem_total); metricRow(metrics, T('gateways.lbl_ram', 'RAM'), fmtGB(t.mem_used) + ' / ' + fmtGB(t.mem_total) + ' · ' + mp + ' %', mp, (mp > 90 ? 'bad' : null)); }
    if (t.disk && t.disk.total) { var dp = pct(t.disk.used, t.disk.total); metricRow(metrics, T('gwp.load.disk', 'Speicher'), fmtGB(t.disk.used) + ' / ' + fmtGB(t.disk.total) + ' · ' + dp + ' %', dp, (dp > 85 ? 'bad' : (dp > 70 ? 'warn' : null))); }
    body.appendChild(metrics);
    // the gateway's self-checks in plain words
    var chips = el('div', 'gwe-chips gwo-selfchecks');
    [['proxy', !!h.http_proxy_healthy], ['api', !!h.api_healthy], ['dns', !!h.dns_resolve_ok]].forEach(function (x) {
      var tg = tagEl(x[1] ? 'green' : 'red', T('gwp.load.' + x[0] + (x[1] ? '_ok' : '_bad')), true);
      tg.setAttribute('data-check', x[0]); chips.appendChild(tg);
    });
    body.appendChild(chips);
    return c.card;
  }
  var ROUTES_FIRST = 5;
  function routesCard(g) {
    var h = g.health || {};
    var rr = h.route_reachability || [];
    var cfg = g.routes || [];
    var cfgById = {}; cfg.forEach(function (rc) { cfgById[rc.id] = rc; });
    // routes pinned to a pool partner: this gateway only checks their targets as the reserve
    var rsvById = {}; (g.reserve_routes || []).forEach(function (rc) { rsvById[rc.id] = rc; });
    var upN = rr.filter(function (r) { return r.reachable; }).length;
    var pillCls = (rr.length && upN === rr.length) ? 'green' : (upN === 0 ? 'red' : 'amber');
    var c = cardFrame(T('gwp.routes.title', 'Routen über dieses Gateway'), rr.length ? tagEl(pillCls, TT('gwp.routes.reach', { up: upN, n: rr.length })) : null, 'routes', 'full gwo-routes');
    c.card.classList.add('full');
    var body = c.body;
    if (rr.length) {
      var all = !!routesAll[g.peer_id];
      var wrapT = el('div', 'gwe-table-wrap gwo-routes-wrap');
      var tbl = el('table', 'gw-routes');
      var thead = el('thead'), htr = el('tr');
      [T('gateways.col_domain', 'Domain'), T('gateways.col_lan_target', 'LAN-Ziel'), T('gateways.col_status', 'Status'), T('gateways.col_latency', 'Latenz'), T('gateways.col_checked', 'Geprüft')]
        .forEach(function (htxt) { var th = el('th', null, htxt); th.scope = 'col'; htr.appendChild(th); });
      thead.appendChild(htr); tbl.appendChild(thead);
      var tbody = el('tbody');
      (all ? rr : rr.slice(0, ROUTES_FIRST)).forEach(function (r) {
        var rsv = rsvById[r.route_id] || null;
        var rc = cfgById[r.route_id] || rsv || {};
        var tr = el('tr');
        // Prefer the user-configured domain (`rc.domain`) over the gateway's
        // synthetic `l4:<port>` reachability label — L4 routes don't carry a
        // real domain on the gateway side so the synthetic value would shadow
        // the friendly name the admin actually chose.
        var dom = el('td', null, rc.domain || r.domain || ('#' + r.route_id));
        if (rsv) {
          tr.dataset.reserve = '1';
          dom.appendChild(document.createTextNode(' '));
          dom.appendChild(tagEl('grey', TT('gwp.routes.reserve_for', { name: rsv.peer_name || ('#' + rsv.peer_id) })));
        }
        tr.appendChild(dom);
        tr.appendChild(el('td', 'sub', rc.target_lan_host ? rc.target_lan_host + (rc.target_lan_port ? ':' + rc.target_lan_port : '') : '—'));
        var sc = el('td'); sc.appendChild(el('span', 'pill ' + (r.reachable ? 'online' : 'offline'), r.reachable ? T('gateways.reachable', 'erreichbar') : T('gateways.unreachable', 'nicht erreichbar'))); tr.appendChild(sc);
        tr.appendChild(el('td', 'num', r.latency_ms != null ? r.latency_ms + ' ms' : '—'));
        tr.appendChild(el('td', 'num', ago(g.last_seen_at)));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrapT.appendChild(tbl);
      body.appendChild(wrapT);
      if (rr.length > ROUTES_FIRST) {
        var more = el('button', 'gwn-linkbtn gwo-routes-all', all ? T('gwp.less', 'Weniger anzeigen') : TT('gwp.routes.all', { n: rr.length }));
        more.type = 'button'; more.dataset.fk = 'gwo-routes-all'; more.setAttribute('aria-expanded', all ? 'true' : 'false');
        more.addEventListener('click', function () { routesAll[g.peer_id] = !all; renderDetail(g); });
        body.appendChild(more);
      }
    } else {
      body.appendChild(el('div', 'gw-empty', T('gateways.routes_empty', 'Keine Routen auf dieses Gateway.')));
    }
    var foot = el('div', 'foot');
    var tl = h.tcp_listeners;
    var l4n = (typeof tl === 'number') ? tl : (Array.isArray(tl) ? tl.length : cfg.filter(function (rc) { return rc.l4_listen_port; }).length);
    foot.appendChild(el('span', null, l4n + ' ' + T('gateways.foot_listeners', 'L4-Listener aktiv') + ' · ' + T('gateways.foot_probes', 'TCP-Probes alle 15 s')));
    var wol = cfg.filter(function (rc) { return rc.wol_enabled; }).map(function (rc) { return rc.domain; });
    if (wol.length) foot.appendChild(el('span', null, T('gateways.foot_wol', 'WoL verfügbar für') + ' „' + wol.join(', ') + '"'));
    c.card.appendChild(foot);
    return c.card;
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

  function discScanIcon() {
    return _icon(16, [
      { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
      { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
    ]);
  }


  // The scan-icon spinner (@keyframes gw-spin) and the indeterminate progress
  // bar (.gw-progress) live in the linked stylesheet (pro.css, under aurora.css).
  // A runtime-injected <style> is blocked by our CSP (styleSrcElem requires a
  // nonce; only style="" attributes get 'unsafe-inline'), so keyframe/class
  // rules MUST be served from a stylesheet, not injected here.

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
      // the licence middleware answers with a translated sentence and names the feature in `feature`
      if (d && d.feature === 'gateway_lan_discovery') return T('gateways.discovery.feature_locked', 'LAN-Erkennung ist im aktuellen Plan nicht aktiviert.');
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
      // Licence hint (docs/feature-release-b.md §11): reason + "Lizenz aktualisieren".
      if (window.GCLicenseHint) body.appendChild(window.GCLicenseHint.render('gateway_lan_discovery_multi_subnet', { compact: true }));
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
    var scanProgress = el('div', 'gw-progress'); scanProgress.style.display = 'none';
    function setScanRunning(running) {
      scanBtn.disabled = !!running;
      scanBtn.style.opacity = running ? '0.65' : '1';
      scanBtn.style.cursor = running ? 'wait' : 'pointer';
      scanIconNode.style.animation = running ? 'gw-spin 0.9s linear infinite' : '';
      scanProgress.style.display = running ? 'block' : 'none';
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

    // Without the licence feature the server answers with an empty list and licensed: false —
    // a note in place of the list, the scan button off (scanning would only end in a 403).
    function showLocked() {
      setScanRunning(false);
      scanBtn.disabled = true; scanBtn.style.opacity = '0.4'; scanBtn.style.cursor = 'not-allowed';
      status.textContent = '';
      var hint = discMuted(T('gateways.discovery.feature_locked', 'LAN-Erkennung ist im aktuellen Plan nicht aktiviert.'));
      hint.setAttribute('data-disc-locked', '');
      list.replaceChildren(hint);
    }
    function loadCached() {
      fetch('/api/v1/gateways/' + g.peer_id + '/discovered', { credentials: 'same-origin' })
        .then(function (r) {
          if (r.ok) return r.json().then(function (d) {
            if (d.ok && d.licensed === false) { showLocked(); return; }
            if (d.ok) {
              render(d.devices, d.done, d.timed_out, d.updated_at, d.in_flight);
              // If the server says a scan is still in flight when we mount,
              // keep the spinner running until the terminal SSE arrives.
              if (d.in_flight) setScanRunning(true);
            } else render([], false, false, null);
          });
          // 404, or 403 from a server before `licensed: false` — say why the card is empty.
          render([], false, false, null);
          if (r.status === 403) { showLocked(); return; }
          return _discErrText(r, '').then(function (t) { if (t) status.textContent = t; });
        }).catch(function (err) { console.warn('[gateways] discovery request failed', err); });
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
    body.appendChild(scanProgress);
    body.appendChild(list);
    loadCached();
    return frame.card;
  }

  // ── Scan-Egress card (capability-gated on telemetry.scan_egress) ──────────
  // Mirrors the LAN-Discovery card: rendered only when the near gateway reports
  // the `scan_egress` capability flag. Lists egress routes whose near gateway is
  // this peer, with an inline add form (raw fetch + CSRF, same convention as the
  // discovery card). Target-route dropdown is filtered to internal-only L4
  // gateway routes (route_type='l4' AND target_kind='gateway' AND !external_enabled)
  // — the only valid target_route_id values per the server-side validation.
  function egressFieldLabel(key, fallback, hintKey, hint) {
    var wrap = el('div', null);
    wrap.style.cssText = 'margin:10px 0 0';
    var lbl = el('label', null, T(key, fallback));
    lbl.style.cssText = 'display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:4px';
    wrap.appendChild(lbl);
    // Append the hint so buildForm() can use it as an insertBefore reference
    // (input goes between label and hint). Without appendChild, insertBefore
    // throws NotFoundError and the whole form fails to open.
    if (hintKey) { var h = discMuted(T(hintKey, hint)); h.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:3px'; wrap.appendChild(h); wrap._hint = h; }
    return wrap;
  }
  function egressInput(ph) {
    var i = el('input'); i.type = 'text'; if (ph) i.placeholder = ph;
    i.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text-primary);font-size:13px';
    return i;
  }
  function egressCard(g) {
    var tel = (g.health && g.health.telemetry) || {};
    var addBtn = el('button', 'btn', '+ ' + T('egress.add', 'Add scan target'));
    addBtn.type = 'button';
    addBtn.style.cssText = 'font-size:12px;padding:5px 10px';
    var frame = _discCard(T('egress.section_title', 'Scan targets (egress)'), addBtn);
    var body = frame.body;

    if (tel.scan_egress !== true) {
      addBtn.disabled = true; addBtn.style.opacity = '0.4'; addBtn.style.cursor = 'not-allowed';
      body.appendChild(discMuted(T('egress.unavailable', 'This gateway does not support scan egress (update it first).')));
      return frame.card;
    }

    body.appendChild(discMuted(T('egress.subtitle', '')));
    var listEl = el('div', null); listEl.style.cssText = 'margin-top:8px';
    var formEl = el('div', null); formEl.hidden = true;
    body.appendChild(listEl);
    body.appendChild(formEl);

    function renderList(rows) {
      listEl.replaceChildren();
      var mine = (rows || []).filter(function (r) { return String(r.near_peer_id) === String(g.peer_id); });
      if (!mine.length) {
        var empty = el('div', null, T('egress.empty', 'No scan targets yet.'));
        empty.style.cssText = 'padding:14px 0;text-align:center;color:var(--text-3);font-size:13px';
        listEl.appendChild(empty);
        return;
      }
      mine.forEach(function (r, i) {
        var row = el('div', null);
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0' + (i ? ';border-top:1px solid var(--border)' : '');
        var info = el('div', null);
        var title = el('div', null, r.name || ('#' + r.id));
        title.style.cssText = 'font-weight:600;font-size:14px;color:var(--text-primary)';
        info.appendChild(title);
        var srcs = [];
        try { srcs = JSON.parse(r.allowed_source_ips || '[]'); } catch (e) { srcs = []; }
        var meta = el('div', null);
        meta.style.cssText = 'font-size:12px;color:var(--text-2);font-family:var(--font-mono);margin-top:3px';
        meta.textContent = r.vip_ip + '/' + r.vip_prefix + ':' + r.lan_listen_port + '  ·  ' + (srcs.join(', ') || '*');
        info.appendChild(meta);
        row.appendChild(info);
        var del = el('button', 'btn', T('egress.delete', 'Delete'));
        del.type = 'button'; del.style.cssText = 'font-size:12px;padding:4px 10px;color:var(--red,#dc2626)';
        del.addEventListener('click', async function () {
          if (!await D.confirm({ message: T('egress.delete_confirm', 'Delete this scan target?'), danger: true, okLabel: T('common.delete', 'Delete') })) return;
          fetch('/api/v1/egress-routes/' + r.id, { method: 'DELETE', credentials: 'same-origin', headers: discCsrfHeaders() })
            .then(function () { load(); }).catch(function (err) { console.warn('[gateways] deleting scan target failed', err); });
        });
        row.appendChild(del);
        listEl.appendChild(row);
      });
    }

    function load() {
      fetch('/api/v1/egress-routes', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { renderList(d && d.data); })
        .catch(function () { renderList([]); });
    }

    function buildForm() {
      formEl.replaceChildren();
      formEl.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid var(--border)';

      var nameW = egressFieldLabel('egress.name', 'Name'); var nameI = egressInput(); nameW.appendChild(nameI); formEl.appendChild(nameW);

      var vipRow = el('div', null); vipRow.style.cssText = 'display:flex;gap:10px';
      var vipW = egressFieldLabel('egress.vip_ip', 'Gateway address (VIP)', 'egress.vip_hint', 'Free static IP outside the DHCP range');
      vipW.style.flex = '2'; var vipI = egressInput('192.168.1.240'); vipW.insertBefore(vipI, vipW._hint || null); formEl.appendChild(vipW);
      var prefW = egressFieldLabel('egress.vip_prefix', 'Prefix'); prefW.style.flex = '1';
      var prefI = egressInput('24'); prefI.value = '24'; prefW.appendChild(prefI);
      vipRow.appendChild(vipW); vipRow.appendChild(prefW); formEl.appendChild(vipRow);

      var portW = egressFieldLabel('egress.listen_port', 'Listen port', 'egress.listen_port_hint', 'High port (1024-65535) the gateway listens on');
      var portI = egressInput('14450'); portW.insertBefore(portI, portW._hint || null); formEl.appendChild(portW);

      var trW = egressFieldLabel('egress.target_route', 'Target NAS route (internal-only L4)');
      var trSel = el('select');
      trSel.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text-primary);font-size:13px';
      // Loading placeholder + progress bar until /api/routes resolves, so the
      // click produces immediate visible feedback while the dropdown fills.
      var trLoadingOpt = el('option', null, T('egress.loading_routes', 'Loading routes…'));
      trLoadingOpt.value = ''; trLoadingOpt.disabled = true; trLoadingOpt.selected = true;
      trSel.appendChild(trLoadingOpt);
      var trProgress = el('div', 'gw-progress');
      trW.appendChild(trSel); trW.appendChild(trProgress); formEl.appendChild(trW);

      var srcW = egressFieldLabel('egress.source_lock', 'Allowed source (printer)', 'egress.source_lock_hint', 'One or more CIDRs, e.g. 192.168.1.50/32');
      var srcI = egressInput('192.168.1.50/32'); srcW.insertBefore(srcI, srcW._hint || null); formEl.appendChild(srcW);

      var warn = el('div', null, T('egress.auth_warning', 'The target NAS must enforce authentication (no guest shares).'));
      warn.style.cssText = 'margin-top:12px;background:var(--bg-body);padding:10px 12px;border-radius:6px;border-left:3px solid var(--amber,#d97706);font-size:12px;line-height:1.45;color:var(--text-2)';
      formEl.appendChild(warn);

      var footer = el('div', null);
      footer.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px';
      var msg = el('div', null); msg.style.cssText = 'font-size:12px;color:var(--text-2);margin-right:auto';
      var cancel = el('button', 'btn', T('egress.cancel', 'Cancel')); cancel.type = 'button';
      cancel.addEventListener('click', function () { formEl.hidden = true; });
      var save = el('button', 'btn btn-primary', T('egress.save', 'Save')); save.type = 'button';
      save.disabled = true; // re-enabled once the target-route list has loaded
      save.addEventListener('click', function () {
        var srcs = srcI.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var payload = {
          name: nameI.value.trim(),
          near_peer_id: g.peer_id,
          vip_ip: vipI.value.trim(),
          vip_prefix: Number(prefI.value) || 24,
          lan_listen_port: Number(portI.value),
          target_route_id: Number(trSel.value),
          allowed_source_ips: srcs,
        };
        save.disabled = true;
        fetch('/api/v1/egress-routes', { method: 'POST', credentials: 'same-origin', headers: discCsrfHeaders(), body: JSON.stringify(payload) })
          .then(function (r) {
            save.disabled = false;
            if (r.ok || r.status === 201) { formEl.hidden = true; load(); return; }
            return r.json().then(function (d) { msg.textContent = (d && d.error) || T('egress.save_failed', 'Save failed'); })
              .catch(function () { msg.textContent = T('egress.save_failed', 'Save failed'); });
          }).catch(function () { save.disabled = false; msg.textContent = T('egress.save_failed', 'Save failed'); });
      });
      footer.appendChild(msg); footer.appendChild(cancel); footer.appendChild(save);
      formEl.appendChild(footer);

      // Populate the target dropdown with internal-only L4 gateway routes only.
      // Keep the loading bar up for a minimum span so it stays perceptible even
      // when /api/routes answers almost instantly (local server).
      var loadStart = Date.now();
      fetch('/api/routes', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var apply = function () {
            trProgress.style.display = 'none';
            var routes = Array.isArray(d) ? d : (d && (d.routes || d.data)) || [];
            var l4 = routes.filter(function (rt) { return rt.route_type === 'l4' && rt.target_kind === 'gateway' && !rt.external_enabled; });
            trSel.replaceChildren();
            if (!l4.length) {
              var o = el('option', null, T('egress.target_route_empty', 'No internal-only L4 gateway route available.'));
              o.value = ''; o.disabled = true; o.selected = true; trSel.appendChild(o);
              save.disabled = true;
              return;
            }
            l4.forEach(function (rt) {
              var lbl = (rt.domain || (':' + (rt.l4_listen_port || ''))) + (rt.l4_listen_port ? ' (:' + rt.l4_listen_port + ')' : '');
              var o = el('option', null, lbl); o.value = rt.id; trSel.appendChild(o);
            });
            save.disabled = false;
          };
          var elapsed = Date.now() - loadStart;
          if (elapsed < 500) setTimeout(apply, 500 - elapsed); else apply();
        }).catch(function () { trProgress.style.display = 'none'; });
    }

    addBtn.addEventListener('click', function () {
      if (!formEl.hidden) { formEl.hidden = true; return; }
      buildForm();
      formEl.hidden = false;
    });

    load();
    return frame.card;
  }

  // ── View routing ──────────────────────────────────────────────────────────
  var pendingDetail = null; // #gw/<id> of a gateway the list does not have yet (just created)
  var pendingTab = 'overview';
  function showDetail(id, tab) {
    var g = last.find(function (x) { return String(x.peer_id) === String(id); });
    if (!g) { showFleet(); if (pendingDetail !== String(id)) { pendingDetail = String(id); pendingTab = tab || 'overview'; load(); } return; }
    pendingDetail = null;
    var same = openId === String(id) && !detailView.hidden;
    if (!same) menuOpen = false;
    openId = String(id); openPool = null;
    openTab = tab || 'overview';
    renderDetail(g);
    hideDocs();
    fleetView.hidden = true; if (poolView) poolView.hidden = true; detailView.hidden = false;
    // switching tabs keeps the scroll position; a new gateway starts at the top
    if (!same) window.scrollTo(0, 0);
  }
  function showPool(id) {
    var same = openPool === String(id) && poolView && !poolView.hidden;
    openId = null; openPool = String(id); menuOpen = false; netExtra = null;
    detailView.hidden = true; detailView.replaceChildren(); fleetView.hidden = true; hideDocs();
    if (window.GCGatewayEdge) window.GCGatewayEdge.unmount();
    if (!poolView || !P) { showFleet(); return; }
    poolView.hidden = false;
    P.renderPool(poolView, id);
    if (!same) window.scrollTo(0, 0);
  }
  function showFleet() {
    openId = null; openPool = null; menuOpen = false; netExtra = null;
    detailView.hidden = true; if (poolView) { poolView.hidden = true; poolView.replaceChildren(); }
    hideDocs();
    fleetView.hidden = false; detailView.replaceChildren();
    if (window.GCGatewayEdge) window.GCGatewayEdge.unmount();
  }
  function hideDocs() {
    if (!docsView || docsView.hidden) return;
    docsView.hidden = true;
    if (DOCS) DOCS.hide();
  }
  // #gw/<id>/versions, #gw/<id>/handbook[/<anchor>]: "Versionen" and "Handbuch" of a gateway
  var docsId = null;
  function showDocs(dm) {
    var g = last.find(function (x) { return String(x.peer_id) === String(dm.id); });
    if (!g) { goFleet(); return; }
    openId = null; openPool = null; menuOpen = false; netExtra = null;
    detailView.hidden = true; detailView.replaceChildren(); fleetView.hidden = true;
    if (poolView) { poolView.hidden = true; poolView.replaceChildren(); }
    if (window.GCGatewayEdge) window.GCGatewayEdge.unmount();
    docsId = String(dm.id);
    docsView.hidden = false;
    DOCS.show(docsView, dm, { gateway: g, latest: latest });
  }
  function goFleet() {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showFleet();
  }
  var TAB_NAMES = ['features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt'];
  function route() {
    var h = location.hash || '';
    var dm = DOCS && docsView ? DOCS.parseHash(h) : null;
    if (dm) { showDocs(dm); return; }
    // #gw/<id>, #gw/<id>/features, …/net, …/inet, …/dns, …/cache, …/radio, …/edge, …/mqtt (an unknown tab shows the overview)
    var m = h.match(/^#gw\/([^/]+)(?:\/([a-z]+))?$/);
    if (m) {
      var tabName = TAB_NAMES.indexOf(m[2]) >= 0 ? m[2] : 'overview';
      var gid; try { gid = decodeURIComponent(m[1]); } catch (e) { gid = null; }
      if (gid !== null) { showDetail(gid, tabName); return; }
    }
    // #pool/<id>: the pool page
    var pm = PK && PK.parsePoolHash(h);
    if (pm) { showPool(pm.id); return; }
    showFleet();
    // Assistant: #add = new gateway, #setup/<id> = continue the set-up.
    var W = window.GCGatewayWizard;
    if (!W) return;
    if (h === '#add') { if (!W.isOpen()) W.open({ mode: 'add' }); return; }
    var s = h.match(/^#setup\/(\d+)$/);
    if (s && !W.isOpen()) W.open({ mode: 'resume', id: Number(s[1]) });
  }

  // ── Gateway update toast ────────────────────────────────────────────────
  // Update progress shows as a colour-coded toast (bottom-right, stacked),
  // pulsing while running and static when terminal — instead of inline card
  // text that reflowed the action row on every status change. The toast lives
  // on document.body, so it survives the periodic full re-render of the view.
  var GW_UPDATE_DONE_MS = 20000; // keep the "done" toast ~20s, then fade out
  var _gwToasts = {};            // peerId → { state, sig, node, dot, msg, timer, closeBtn }
  var _gwToastAcked = {};        // peerId → last terminal sig already shown+dismissed

  function _gwToastStack() {
    var s = document.getElementById('gw-update-toast-stack');
    if (!s) { s = el('div'); s.id = 'gw-update-toast-stack'; document.body.appendChild(s); }
    return s;
  }
  function dismissUpdateToast(peerId, ackSig) {
    var t = _gwToasts[peerId];
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    if (ackSig) _gwToastAcked[peerId] = ackSig;
    var node = t.node;
    node.classList.remove('show');
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 300);
    delete _gwToasts[peerId];
  }
  // state: 'updating' | 'done' | 'failed' | 'unknown'
  function showUpdateToast(peerId, state, version) {
    var sig = state + ':' + (version || '');
    var t = _gwToasts[peerId];
    if (t && t.sig === sig) return; // already showing this exact state — no-op (don't reset timers)
    if (!t) {
      t = { dot: el('span', 'gw-toast-dot'), msg: el('span', 'gw-toast-msg'), node: el('div', 'gw-toast') };
      t.node.setAttribute('role', 'status');
      t.node.setAttribute('aria-live', 'polite');
      t.node.appendChild(t.dot); t.node.appendChild(t.msg);
      _gwToastStack().appendChild(t.node);
      requestAnimationFrame(function () { t.node.classList.add('show'); });
      _gwToasts[peerId] = t;
    } else if (t.closeBtn) { t.node.removeChild(t.closeBtn); t.closeBtn = null; }
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    t.sig = sig; t.state = state;
    t.node.className = 'gw-toast show gw-toast-' + state;
    if (state === 'updating') {
      t.msg.textContent = T('gateways.update_running', 'Update läuft …');
    } else if (state === 'done') {
      t.msg.textContent = T('gateways.update_done', 'Update auf Version {x} abgeschlossen').replace('{x}', version || latest || '—');
      t.timer = setTimeout(function () { dismissUpdateToast(peerId, sig); }, GW_UPDATE_DONE_MS);
    } else { // failed | unknown — persist until the operator dismisses it
      t.msg.textContent = (state === 'failed')
        ? T('gateways.update_failed', 'Update fehlgeschlagen')
        : T('gateways.update_unknown', 'Update-Status unbekannt');
      var x = el('button', 'gw-toast-close', '✕');
      x.setAttribute('aria-label', T('gateways.update_dismiss', 'Verwerfen'));
      x.addEventListener('click', function () { dismissUpdateToast(peerId, sig); });
      t.node.appendChild(x); t.closeBtn = x;
    }
  }
  function reconcileUpdateToast(g) {
    var st = g.update_state;
    if (!st || st === 'idle') {
      // No active update. Clear a lingering "updating" toast; terminal toasts
      // self-dismiss via their own timer / close button. Reset the ack so a
      // future update is shown again.
      var cur = _gwToasts[g.peer_id];
      if (cur && cur.state === 'updating') dismissUpdateToast(g.peer_id);
      delete _gwToastAcked[g.peer_id];
      return;
    }
    var version = g.update_target_version || latest || '';
    // Don't re-pop a terminal toast we already showed and dismissed.
    if (st !== 'updating' && _gwToastAcked[g.peer_id] === st + ':' + version) return;
    showUpdateToast(g.peer_id, st, version);
  }

  // ── Fleet: pools as groups, then "Einzelne Gateways" ──────────────────────
  var HINT_KEY = 'gc.gw.poolHintHidden';
  function hintHidden(id) { try { return (localStorage.getItem(HINT_KEY) || '').split(',').indexOf(String(id)) >= 0; } catch (e) { return false; } }
  function hideHint(id) {
    try { var l = (localStorage.getItem(HINT_KEY) || '').split(',').filter(Boolean); l.push(String(id)); localStorage.setItem(HINT_KEY, l.join(',')); } catch (e) { /* per viewer only */ }
  }
  // The dashed card "X absichern?" — a hint, never a must (dismissable per viewer).
  function hintCard(singles) {
    var sg = PK.suggestion(singles);
    if (!sg || (!sg.partner && !(sg.g.routes || []).length) || hintHidden(sg.g.peer_id)) return null;
    var d = el('div', 'gwp-hint');
    d.setAttribute('data-hint', String(sg.g.peer_id));
    d.appendChild(el('strong', null, TT('gwp.hint.title', { name: sg.g.name })));
    d.appendChild(el('p', 'gwe-d', sg.partner ? TT('gwp.hint.partner', { partner: sg.partner.name, lan: sg.lan }) : T('gwp.hint.text')));
    var acts = el('div', 'gwe-actions');
    var b = el('button', 'btn btn-ghost btn-sm', sg.partner ? TT('gwp.hint.create_two', { name: sg.g.name, partner: sg.partner.name }) : TT('gwp.hint.create', { name: sg.g.name }));
    b.type = 'button'; b.dataset.act = 'pool-create'; b.dataset.ids = [sg.g.peer_id].concat(sg.partner ? [sg.partner.peer_id] : []).join(',');
    if (P && !P.licensed) b.appendChild(P.lockTag());
    acts.appendChild(b);
    var x = el('button', 'btn btn-ghost btn-sm', T('gwp.hint.hide', 'Ausblenden')); x.type = 'button'; x.dataset.act = 'hint-hide'; x.dataset.id = sg.g.peer_id;
    acts.appendChild(x);
    d.appendChild(acts);
    return d;
  }
  function singlesSection(singles) {
    var sec = el('section', 'gwp-group gwp-singles'); sec.setAttribute('aria-labelledby', 'gwp-singles-h');
    var head = el('div', 'gwp-group-head');
    var h2 = el('h2', 'gwp-group-title', T('gwp.singles.title', 'Einzelne Gateways')); h2.id = 'gwp-singles-h';
    head.appendChild(h2); head.appendChild(el('span', 'gwp-grow')); head.appendChild(el('span', 'gwe-d', T('gwp.singles.sub')));
    sec.appendChild(head);
    var g2 = el('div', 'grid gwp-grid');
    singles.forEach(function (g) { g2.appendChild(card(g)); });
    var hc = hintCard(singles);
    if (hc) g2.appendChild(hc);
    sec.appendChild(g2);
    return sec;
  }
  // the location tag of a waiting card (pool view)
  function withLocTag(node, g, byLoc) {
    var lt = L && !byLoc ? L.cardTag(g) : null;
    if (lt) { var tg = el('div', 'gw-card-tags'); tg.appendChild(lt); node.querySelector('.uh').after(tg); }
    return node;
  }
  function fleet() {
    var nodes = [];
    var pools = P ? P.pools() : [];
    var fg = PK ? PK.fleetGroups(last, pools) : { groups: [], singles: last };
    var lbar = L ? L.bar() : null;
    if (lbar) nodes.push(lbar);
    // "Gruppieren nach: Standorte" — one section per location, "Ohne Standort" last
    if (L && L.mode() === 'locations') {
      var roles = {};
      fg.groups.forEach(function (gr) { gr.members.forEach(function (x) { if (!roles[x.g.peer_id]) roles[x.g.peer_id] = { pool: gr.pool, member: x.member }; }); });
      return nodes.concat(L.sections(last, {
        card: function (g) { return card(g, roles[g.peer_id] || null, true); },
        online: function (g) { var s = status(g); return s === 'online' || s === 'degraded'; },
      }));
    }
    fg.groups.forEach(function (gr) {
      var cards = gr.members.map(function (x) { return card(x.g, { pool: gr.pool, member: x.member }); });
      if (!cards.length) cards = [el('p', 'gwe-empty', T('gwp.group.empty'))];
      nodes.push(P.groupSection(gr.pool, cards));
    });
    if (fg.singles.length) nodes.push(singlesSection(fg.singles));
    return nodes;
  }

  function render(data) {
    last = data.gateways || []; latest = data.latest_version || ''; warn.hidden = !!data.latest_version;
    last.forEach(function (g) { reconcileUpdateToast(g); });
    schedulePoll();
    var on = 0, off = 0, deg = 0, upd = 0, back = 0;
    last.forEach(function (g) {
      var s = status(g);
      if (s === 'online') on++; else if (s === 'offline') off++; else if (s === 'degraded') deg++; else if (s === 'updating' || s === 'restarting') back++;
      if (g.update_available) upd++;
    });
    var st = P && P.state();
    var onSub = [off ? TT('gwp.kpi.offline_n', { n: off }) : null, back ? TT('gwp.kpi.restarting_n', { n: back }) : null,
      deg ? TT('gwp.kpi.degraded_n', { n: deg }) : null].filter(Boolean).join(' · ');
    var tiles = [kpi('', last.length, T('gateways.kpi_total', 'Gateways')),
      kpi(off ? 'warn' : 'ok', on, T('gateways.online', 'Online'), onSub || null)];
    if (st) {
      tiles.push(kpi('', (st.pools || []).length, T('gwp.kpi.pools', 'Pools')));
      tiles.push(kpi(st.routes_pooled ? 'ok' : '', TT('gwp.kpi.safe_v', { k: st.routes_pooled, n: st.routes_total }), T('gwp.kpi.safe', 'Ausfallsicher'), T('gwp.kpi.safe_sub')));
    }
    tiles.push(kpi('warn', upd, T('gateways.kpi_update', 'Update')));
    kpis.replaceChildren.apply(kpis, tiles);
    grid.replaceChildren.apply(grid, last.length ? fleet() : [emptyFleet()]);
    if (pendingDetail && last.some(function (x) { return String(x.peer_id) === pendingDetail; })) { showDetail(pendingDetail, pendingTab); return; }
    if (!routed) { routed = true; route(); }
    else if (openId) { var g = last.find(function (x) { return String(x.peer_id) === openId; }); if (g) renderDetail(g); else goFleet(); }
    else if (openPool && P && !P.busy(poolView)) P.renderPool(poolView, openPool);
    else if (DOCS && docsView && !docsView.hidden) {
      var dg = last.find(function (x) { return String(x.peer_id) === docsId; });
      if (dg) DOCS.update({ gateway: dg, latest: latest }); else goFleet();
    }
  }
  var loading = null;
  function load(force) {
    // a change of a pool (force) must not take the answer of a poll that left before it
    if (loading) return force ? loading.then(function () { return load(true); }) : loading;
    var pools = P ? P.load().catch(function (err) { console.warn('[gateways] loading pools failed', err); return null; }) : Promise.resolve(null);
    var gws = fetch('/api/v1/gateways', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    if (L) pools = Promise.all([pools, L.load()]).then(function (r) { return r[0]; });
    loading = Promise.all([gws, pools]).then(function (res) { loading = null; render(res[0]); }, function (err) { loading = null; schedulePoll(); console.warn('[gateways] loading gateways failed', err); });
    return loading;
  }
  function probe(id) { fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/probe', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }).then(function () { load(); }).catch(function (err) { console.warn('[gateways] probe failed', err); }); }

  function emptyFleet() {
    var d = el('div', 'gw-empty-fleet');
    d.appendChild(el('p', null, T('gwiz.card.empty', 'Noch kein Gateway. Mit „Gateway hinzufügen“ richtest du das erste ein.')));
    return d;
  }
  var addBtn = document.getElementById('btn-add-gateway');
  if (addBtn) addBtn.addEventListener('click', function () {
    if (location.hash === '#add' && window.GCGatewayWizard) window.GCGatewayWizard.open({ mode: 'add' });
    else location.hash = '#add';
  });
  var addPoolBtn = document.getElementById('btn-add-pool');
  if (addPoolBtn && P) addPoolBtn.addEventListener('click', function () { P.openCreate({}); });
  if (P) P.init({ fleet: function () { return last; }, changed: function () { return load(true); } });
  if (L) L.init({ fleet: function () { return last; }, pools: function () { return P ? P.pools() : []; }, changed: function () { return load(true); },
    redraw: function () { if (last.length) grid.replaceChildren.apply(grid, fleet()); } });
  grid.addEventListener('click', function (e) {
    var pc = e.target.closest('[data-act="pool-create"]');
    if (pc) { e.stopPropagation(); if (P) P.openCreate({ preselect: (pc.dataset.ids || '').split(',').filter(Boolean) }); return; }
    var hh = e.target.closest('[data-act="hint-hide"]');
    if (hh) { e.stopPropagation(); hideHint(hh.dataset.id); var card0 = hh.closest('.gwp-hint'); if (card0) card0.remove(); return; }
    var rs = e.target.closest('.gw-resume');
    if (rs) { e.stopPropagation(); location.hash = '#setup/' + encodeURIComponent(rs.dataset.id); return; }
    var rc = e.target.closest('.recheck'); if (rc) { e.stopPropagation(); probe(rc.dataset.id); return; }
    if (e.target.closest('a[href]')) return; // the card's name link / "Pool öffnen" navigate themselves
    var c = e.target.closest('.gw[data-id]'); if (!c) return;
    location.hash = '#gw/' + encodeURIComponent(c.dataset.id);
  });
  if (poolView) poolView.addEventListener('click', function (e) { if (e.target.closest('[data-act="back"]')) goFleet(); });
  // the crumb of "Versionen" / "Handbuch": "Gateways" → the fleet (the gateway's name is a plain link)
  if (docsView) docsView.addEventListener('click', function (e) {
    if (!e.target.closest('[data-act="docs-fleet"]')) return;
    e.preventDefault();
    goFleet();
  });
  // "Mehr" menu: keyboard and outside clicks
  detailView.addEventListener('keydown', function (e) {
    var btn = e.target.closest && e.target.closest('#gw-more-btn');
    if (btn && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setMenu(true, e.key === 'ArrowDown' ? 'first' : 'last'); return; }
    if (!menuOpen || !(e.target.closest && e.target.closest('#gw-more-menu'))) {
      if (menuOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false, 'button'); }
      return;
    }
    var items = menuItems();
    var i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false, 'button'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') setMenu(false);
  });
  document.addEventListener('click', function (e) {
    if (menuOpen && !(e.target.closest && e.target.closest('.gw-more'))) setMenu(false);
  });
  detailView.addEventListener('click', async function (e) {
    if (e.target.closest('[data-act="back"]')) { goFleet(); return; }
    if (e.target.closest('[data-act="more"]')) { setMenu(!menuOpen, menuOpen ? null : 'first'); return; }
    var mi = e.target.closest('.gw-menu-item');
    if (mi) {
      // the dialog gives the focus back to "Mehr", not to the hidden item
      var nav = mi.tagName === 'A';
      setMenu(false, nav ? null : 'button');
      if (nav) return; // "Versionen", "Handbuch": the link opens it
    }
    var rc = e.target.closest('[data-act="recheck"]'); if (rc) { probe(rc.dataset.id); return; }
    var gm = e.target.closest('[data-act^="gm-"]');
    if (gm && window.GCGatewayManage) { window.GCGatewayManage.run(gm.dataset.act, gm.dataset.id, last.find(function (x) { return String(x.peer_id) === String(gm.dataset.id); })); return; }
    var ds = e.target.closest('[data-act="disc-settings"]'); if (ds) { openDiscoverySettings(ds.dataset.id); return; }
    var su = e.target.closest('[data-act="setup"]'); if (su) { openSetupModal(su.dataset.id); return; }
    var lo = e.target.closest('[data-act="location"]');
    if (lo) {
      var lg = last.find(function (x) { return String(x.peer_id) === String(lo.dataset.id); });
      if (lg && L) L.openChange(lg);
      return;
    }
    var pa = e.target.closest('[data-act="pool-add"]');
    if (pa) {
      var pg = last.find(function (x) { return String(x.peer_id) === String(pa.dataset.id); });
      if (pg && P) P.openAddTo(pg);
      return;
    }
    var cp = e.target.closest('[data-act="compose"]');
    if (cp) {
      var cg = last.find(function (x) { return String(x.peer_id) === String(cp.dataset.id); });
      if (cg && window.GCGatewayCompose) window.GCGatewayCompose.open(cg);
      return;
    }
    var up = e.target.closest('[data-act="update"]');
    if (up) {
      if (!await D.confirm({ message: T('gateways.update_confirm', 'Update dieses Gateway jetzt anstoßen?'), okLabel: T('gateways.update', 'Update') })) return;
      var id = up.dataset.id;
      fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/update', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.reason === 'cooldown') {
            if (typeof window.showToast === 'function') {
              window.showToast(T('gateways.update_cooldown', 'Update auf Cooldown — bitte später erneut versuchen'), 'error');
            }
          } else {
            // Optimistic: show the pulsing "running" toast immediately; the poll
            // cycle then keeps it in sync (→ done/failed) from server state.
            showUpdateToast(id, 'updating', latest);
          }
          load();
        }).catch(function (err) { console.warn('[gateways] triggering gateway update failed', err); });
      return;
    }
  });
  window.addEventListener('hashchange', route);
  // new data of the network watch (gateway-net.js): the overview's "Zustand" counts the new devices
  document.addEventListener('gc:gwnet', function (e) {
    if (!openId || openTab !== 'overview' || !e.detail || String(e.detail.id) !== openId) return;
    var g = last.find(function (x) { return String(x.peer_id) === openId; });
    var old = detailView.querySelector('.gwo-state');
    if (g && old && PK) old.replaceWith(stateCard(g));
  });

  var deb = null; function refresh() { clearTimeout(deb); deb = setTimeout(function () { load(); }, 1000); }
  // a 'gateway' SSE event (gatewayHealth transitions, live state changes of
  // gatewayLiveState: back online, going down, offline at the threshold)
  document.addEventListener('gc:gateway', refresh);
  document.addEventListener('gc:gateway-wizard', refresh);
  document.addEventListener('gc:reconnected', refresh);
  // The poll: every 30 s, every 5 s while a gateway is on its way back or just
  // went away (gateway-pool-kit.js pollDelay) — re-armed by every render.
  var pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    var ms = PK && PK.pollDelay ? PK.pollDelay(last) : 30000;
    pollTimer = setTimeout(function () { if (document.hidden) { schedulePoll(); return; } load(); }, ms);
  }
  // countdowns (data-gw-until / data-gw-tpl, see countdownEl) once a second;
  // at 0:00 the page asks again (the failback is due)
  function liveTick() {
    if (!PK || !PK.clock) return;
    var due = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-gw-until]'), function (n) {
      var left = Number(n.dataset.gwUntil) - Date.now();
      var tx = String(n.dataset.gwTpl || '').split('{{left}}').join(PK.clock(left));
      if (n.textContent !== tx) n.textContent = tx;
      if (left <= 0 && !n.dataset.gwDue) { n.dataset.gwDue = '1'; due = true; }
    });
    if (due) refresh();
  }
  setInterval(liveTick, 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  load();
})();
