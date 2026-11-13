'use strict';

// Peers / Clients (docs/feature-peers-page.md): the devices of the VPN —
// gateways have their own page (/gateways) and are not loaded here
// (GET /api/peers?type=client).
//
//   view     cards or list, remembered per browser (localStorage, try/catch)
//   filters  search · status · group · device (platform) · owner · tags ·
//            "needs attention"; sort. They live in the address
//            (#status=online&group=3…) — #edit/<id> opens a device's dialog,
//            /peers?q=<text> fills the search (link from Benutzer).
//   select   checkboxes (list: always, cards: on hover or while selecting) →
//            the bulk bar (.sh-bulkbar): enable, disable, group, owner, tag,
//            delete (POST /api/peers/batch, /api/v1/peers/batch-owner).
//
// Every value from the server goes in with textContent (h() below) — no
// innerHTML with data.

// In-app dialogs instead of confirm()/alert() (docs/feature-wave2.md §W1.2).
var D = window.GCDialog;
var DT = function (k, p) { return D.t(k, p); };

(function () {
  // ─── Strings (peers.njk island) ──────────────────────────
  var I = {};
  try { I = JSON.parse((document.getElementById('pl-i18n') || {}).textContent || '{}') || {}; } catch (e) { I = {}; }
  function L(key, params) {
    var str = I[key] != null ? I[key] : ((window.GC && GC.t && GC.t[key]) || key);
    if (params) Object.keys(params).forEach(function (k) { str = str.split('{{' + k + '}}').join(String(params[k])); });
    return str;
  }

  // ─── DOM helpers (textContent only) ──────────────────────
  var SVGNS = 'http://www.w3.org/2000/svg';
  // attributes: a fixed set, each set under its own constant name (never on*);
  // links only to this server
  function attr(n, k, v) {
    switch (k) {
      case 'id': n.id = v; break;
      case 'type': n.setAttribute('type', v); break;
      case 'role': n.setAttribute('role', v); break;
      case 'title': n.title = v; break;
      case 'for': n.htmlFor = v; break;
      case 'download': n.setAttribute('download', v); break;
      case 'href': if (/^[#/][^/\\]/.test(v)) n.setAttribute('href', v); break;
      case 'aria-label': n.setAttribute('aria-label', v); break;
      case 'aria-hidden': n.setAttribute('aria-hidden', v); break;
      case 'aria-pressed': n.setAttribute('aria-pressed', v); break;
      case 'aria-checked': n.setAttribute('aria-checked', v); break;
      case 'aria-expanded': n.setAttribute('aria-expanded', v); break;
      case 'aria-haspopup': n.setAttribute('aria-haspopup', v); break;
      case 'data-id': n.dataset.id = v; break;
      case 'data-action': n.dataset.action = v; break;
      case 'data-peer-id': n.dataset.peerId = v; break;
      case 'data-batch-id': n.dataset.batchId = v; break;
      case 'data-state': n.dataset.state = v; break;
      case 'data-hint': n.dataset.hint = v; break;
      default: break;
    }
  }
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else attr(n, k, v === true ? '' : String(v));
    });
    // children: Element.append() — a node is inserted as it is, any other value
    // (a label, a search text from the address) only as plain text, never parsed as HTML
    (kids || []).forEach(function (c) { if (c != null) n.append(c instanceof Node ? c : String(c)); });
    return n;
  }
  // icons: static path data only
  var IC = {
    phone: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M11 18h2'],
    laptop: ['M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1z', 'M2 20h20'],
    wg: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z', 'M9 12h6'],
    qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3M21 14v7h-7'],
    edit: ['m14 6 4 4M4 20l1-4L16 5l3 3L8 19l-4 1Z'],
    more: ['M5 12h.01M12 12h.01M19 12h.01'],
    chart: ['M4 19V5M4 19h16M8 15l3-4 3 2 4-6'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
    power: ['M18.36 6.64a9 9 0 1 1-12.73 0', 'M12 2v10'],
    trash: ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'],
    search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'm20 20-3.5-3.5'],
    plus: ['M12 5v14M5 12h14'],
    alert: ['M12 3 2 21h20L12 3z', 'M12 10v5M12 18h.01'],
    box: ['M21 8v13H3V8', 'M1 3h22v5H1z'],
    clock: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 7v5l3 2'],
    x: ['M6 6l12 12M18 6 6 18'],
    check: ['m5 12 5 5 9-10'],
  };
  function icon(name, size) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'more' ? '3' : '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    (IC[name] || []).forEach(function (d) { var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { /* private mode */ }
    return null;
  }

  // ─── State ───────────────────────────────────────────────
  var VIEW_KEY = 'gc-peers-view';
  var searchInput = document.getElementById('peer-search');
  var results = document.getElementById('pl-results');
  var allPeers = [];
  var allGroups = [];
  var allUsers = {};
  var counts = null;
  var loaded = false;
  var updatePolicy = { default_channel: 'stable', min_versions: {} };
  var F = { status: 'all', group: '', device: '', owner: '', tags: [], hints: [], sort: 'status' };
  var view = store(VIEW_KEY) === 'list' ? 'list' : 'cards';
  var selected = new Set();
  var openMenu = null;

  // ─── Load groups / owners ────────────────────────────────
  async function loadGroups() {
    try {
      var data = await api.get('/api/peer-groups');
      if (data.ok) {
        allGroups = data.groups || [];
        renderGroupSelect();
        renderGroupDropdowns();
        if (loaded) render();
      }
    } catch (err) {
      console.error('Failed to load peer groups:', err);
    }
  }
  function getGroupById(id) {
    return allGroups.find(function (g) { return g.id === id; });
  }
  function renderGroupSelect() {
    var sel = document.getElementById('pl-group');
    if (!sel) return;
    var val = F.group;
    sel.replaceChildren(new Option(L('pl.f_all'), ''));
    allGroups.forEach(function (g) { sel.appendChild(new Option(g.name, String(g.id))); });
    sel.appendChild(new Option(L('pl.f_group_none'), 'none'));
    sel.value = val;
    if (sel.value !== val) sel.value = '';
  }

  function renderGroupDropdowns() {
    ['add-peer-group', 'edit-peer-group'].forEach(function(selectId) {
      var sel = document.getElementById(selectId);
      if (!sel) return;
      var val = sel.value;
      sel.replaceChildren();

      var optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = GC.t['peer_groups.none'] || 'No group';
      sel.appendChild(optNone);

      allGroups.forEach(function(g) {
        var opt = document.createElement('option');
        opt.value = String(g.id);
        opt.textContent = g.name;
        sel.appendChild(opt);
      });
      sel.value = val;
    });
  }

  // ─── Load owner selects ──────────────────────────────────
  function populateOwnerSelects(ids) {
    api.get('/api/v1/users').then(function (r) {
      var users = (r.data || r.users || []);
      allUsers = {};
      users.forEach(function (u) { allUsers[u.id] = u; });
      (ids || ['add-peer-owner', 'edit-peer-owner']).forEach(function (id) {
        var sel = document.getElementById(id); if (!sel) return;
        sel.replaceChildren(new Option((window.GC && GC.t && GC.t['peers.owner.none']) || '(no owner)', ''));
        users.forEach(function (u) { sel.appendChild(new Option(u.username, String(u.id))); });
      });
      if (loaded) render();
    }).catch(function (err) { console.warn('[peers] loading users for select failed', err); });
  }

  // ─── Load peers (clients only) ───────────────────────────
  async function loadPeers() {
    try {
      var data = await api.get('/api/peers?type=client');
      if (data.ok) {
        allPeers = data.peers || [];
        counts = data.counts || null;
        updatePolicy = data.update_policy || updatePolicy;
        var ids = new Set(allPeers.map(function (p) { return p.id; }));
        selected.forEach(function (id) { if (!ids.has(id)) selected.delete(id); });
        loaded = true;
        if (openMenu) return; // the next refresh draws it; an open menu stays open
        render();
        openDeepLink();
      }
    } catch (err) {
      results.replaceChildren(h('div', { class: 'rt-empty-page pl-error', text: L('pl.loading_error', { err: err.message }) }));
    }
  }

  // /peers#edit/<id> opens that device's dialog once (support bundle viewer,
  // user device page). A gateway has its page on /gateways.
  var deepLinkHandled = false;
  function openDeepLink() {
    if (deepLinkHandled) return;
    deepLinkHandled = true;
    var m = /^#edit\/(\d{1,9})$/.exec(window.location.hash || '');
    if (!m) return;
    var own = allPeers.find(function (p) { return String(p.id) === m[1]; });
    if (own) { showEditModal(own.id); return; }
    // a gateway: its page is /gateways (the id that goes on is the server's own)
    api.get('/api/peers?type=gateway').then(function (r) {
      var gw = ((r && r.peers) || []).find(function (p) { return String(p.id) === m[1]; });
      if (gw) window.location.replace('/gateways#gw/' + encodeURIComponent(Number(gw.id)));
    }).catch(function () { /* unknown id: stay on the list */ });
  }

  function cuT(key, params) {
    var str = (GC.t && GC.t[key]) || key;
    Object.keys(params || {}).forEach(function (k) { str = str.split('{{' + k + '}}').join(String(params[k])); });
    return str;
  }

  function clientProductLabel(product) {
    if (product === 'pro') return 'Pro';
    if (product === 'community') return 'Community';
    if (product === 'android') return 'Android';
    return '';
  }

  // ─── Peer facts ──────────────────────────────────────────
  function stateOf(p) { return !p.enabled ? 'disabled' : (p.isOnline ? 'online' : 'offline'); }
  function platformOf(p) { return p.client_platform === 'android' ? 'android' : p.client_platform === 'windows' ? 'windows' : 'none'; }
  function ipOf(p) { return p.allowed_ips ? String(p.allowed_ips).split('/')[0] : ''; }
  function rx(p) { return Number(p.transferRx != null ? p.transferRx : p.transfer_rx) || 0; }
  function tx(p) { return Number(p.transferTx != null ? p.transferTx : p.transfer_tx) || 0; }
  function handshakeMs(p) {
    var v = p.latestHandshake != null ? p.latestHandshake : p.latest_handshake;
    if (!v) return 0;
    var ms = typeof v === 'number' ? v * 1000 : new Date(String(v).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z')).getTime();
    return isNaN(ms) ? 0 : ms;
  }
  function ago(ms) {
    if (!ms) return L('pl.ago_never');
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return L('pl.ago_now');
    if (s < 3600) return L('pl.ago_min', { n: Math.floor(s / 60) });
    if (s < 86400) return L('pl.ago_h', { n: Math.floor(s / 3600) });
    var d = Math.floor(s / 86400);
    return d === 1 ? L('pl.ago_d_one') : L('pl.ago_d', { n: d });
  }
  function appLabel(p) {
    if (!p.client_version) return L('pl.app_none');
    if (p.client_product === 'android' || p.client_platform === 'android') return L('pl.app_android', { v: p.client_version });
    if (p.client_product === 'pro') return L('pl.app_pro', { v: p.client_version });
    if (p.client_product === 'community') return L('pl.app_community', { v: p.client_version });
    if (p.client_platform === 'windows') return L('pl.app_windows', { v: p.client_version });
    return L('pl.app_other', { v: p.client_version });
  }
  function expiryDays(p) {
    if (!p.expires_at) return null;
    var t = new Date(p.expires_at).getTime();
    if (isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  }
  function ownerName(p) {
    var u = p.user_id != null ? allUsers[p.user_id] : null;
    return u ? (u.display_name || u.username) : (p.owner_name || '');
  }
  function tagsOf(p) {
    var seen = {};
    return String(p.tags || '').split(',').map(function (t) { return t.trim(); }).filter(function (t) {
      var k = t.toLowerCase(); if (!t || seen[k]) return false; seen[k] = true; return true;
    });
  }
  function needsUpdate(p) { return !!p.client_below_min; }
  // older than the newest release of the device's app and channel (services/releaseWatch.js)
  function outdated(p) { return !!p.client_update_available; }
  function expiringSoon(p) { var d = expiryDays(p); return d != null && d <= 7; }
  function hasSupport(p) { return (Number(p.support_bundles_unviewed) || 0) > 0; }
  function longOffline(p) { var ms = handshakeMs(p); return p.enabled && !p.isOnline && (!ms || Date.now() - ms > 7 * 86400000); }
  // 'oldname': the name in the VPN comes from a restored backup and the device has
  // not confirmed it since ("veraltet" — Einstellungen › VPN & Netzwerk links here)
  function oldName(p) { return !!p.hostname && p.hostname_source === 'stale'; }
  var HINT_KEYS = ['update', 'outdated', 'expiring', 'support', 'stale', 'oldname'];
  function hint(k, p) {
    switch (k) {
      case 'update': return needsUpdate(p);
      case 'outdated': return outdated(p);
      case 'expiring': return expiringSoon(p);
      case 'support': return hasSupport(p);
      case 'stale': return longOffline(p);
      case 'oldname': return oldName(p);
      default: return false;
    }
  }

  // ─── Filters in the address ──────────────────────────────
  function readHash() {
    var raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw || /^edit\//.test(raw)) return;
    var q = new URLSearchParams(raw);
    if (['all', 'online', 'offline', 'disabled'].indexOf(q.get('status')) !== -1) F.status = q.get('status');
    if (/^(\d{1,9}|none)$/.test(q.get('group') || '')) F.group = q.get('group');
    if (['android', 'windows', 'none'].indexOf(q.get('device')) !== -1) F.device = q.get('device');
    if (/^(\d{1,9}|none)$/.test(q.get('owner') || '')) F.owner = q.get('owner');
    if (q.get('tags')) F.tags = q.get('tags').split(',').map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 10);
    if (q.get('hints')) F.hints = q.get('hints').split(',').filter(function (x) { return HINT_KEYS.indexOf(x) !== -1; });
    if (['status', 'name', 'seen', 'traffic', 'group', 'ip'].indexOf(q.get('sort')) !== -1) F.sort = q.get('sort');
    if (q.get('q')) searchInput.value = q.get('q').slice(0, 100);
  }
  function writeHash() {
    if (/^#edit\//.test(window.location.hash || '')) return;
    var q = new URLSearchParams();
    if (F.status !== 'all') q.set('status', F.status);
    if (F.group) q.set('group', F.group);
    if (F.device) q.set('device', F.device);
    if (F.owner) q.set('owner', F.owner);
    if (F.tags.length) q.set('tags', F.tags.join(','));
    if (F.hints.length) q.set('hints', F.hints.join(','));
    if (F.sort !== 'status') q.set('sort', F.sort);
    if (searchInput.value.trim()) q.set('q', searchInput.value.trim());
    var s = q.toString();
    try { history.replaceState(null, '', window.location.pathname + window.location.search + (s ? '#' + s : '')); } catch (e) { /* ignore */ }
  }

  function matches(p, skip) {
    if (skip !== 'status' && F.status !== 'all' && stateOf(p) !== F.status) return false;
    if (F.group === 'none' ? !!p.group_id : (F.group && String(p.group_id) !== F.group)) return false;
    if (F.device && platformOf(p) !== F.device) return false;
    if (F.owner === 'none' ? p.user_id != null : (F.owner && String(p.user_id) !== F.owner)) return false;
    if (F.tags.length) {
      var mine = tagsOf(p).map(function (t) { return t.toLowerCase(); });
      if (!F.tags.every(function (t) { return mine.indexOf(t.toLowerCase()) !== -1; })) return false;
    }
    if (!F.hints.every(function (k) { return hint(k, p); })) return false;
    var q = searchInput.value.toLowerCase().trim();
    if (q) {
      var hay = [p.name, p.description, p.allowed_ips, p.public_key, p.tags, ownerName(p), p.owner_name, p.hostname].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }
  var RANK = { online: 0, offline: 1, disabled: 2 };
  function byName(a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }); }
  function ipNum(p) { return ipOf(p).split('.').reduce(function (acc, x) { return acc * 256 + (Number(x) || 0); }, 0); }
  function sorted(list) {
    var cmp = {
      status: function (a, b) { return (RANK[stateOf(a)] - RANK[stateOf(b)]) || byName(a, b); },
      name: byName,
      seen: function (a, b) { return (stateOf(a) === 'online' ? -1 : 0) - (stateOf(b) === 'online' ? -1 : 0) || (handshakeMs(b) - handshakeMs(a)) || byName(a, b); },
      traffic: function (a, b) { return (rx(b) + tx(b)) - (rx(a) + tx(a)) || byName(a, b); },
      group: function (a, b) {
        var ga = getGroupById(a.group_id), gb = getGroupById(b.group_id);
        if (!ga !== !gb) return ga ? -1 : 1;
        return (ga && gb ? String(ga.name).localeCompare(String(gb.name)) : 0) || byName(a, b);
      },
      ip: function (a, b) { return ipNum(a) - ipNum(b); },
    }[F.sort] || byName;
    return list.slice().sort(cmp);
  }
  function visible() { return sorted(allPeers.filter(function (p) { return matches(p); })); }

  // ─── Render ──────────────────────────────────────────────
  function render() {
    if (!loaded) return;
    closeMenu();
    var c = { all: 0, online: 0, offline: 0, disabled: 0 };
    allPeers.forEach(function (p) { if (matches(p, 'status')) { c.all++; c[stateOf(p)]++; } });
    renderSummary();
    document.querySelectorAll('#pl-status [data-status]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.status === F.status));
      var em = b.querySelector('em'); if (em) em.textContent = String(c[b.dataset.status]);
    });
    document.querySelectorAll('#pl-view [data-view]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
    var gs = document.getElementById('pl-group'); if (gs) gs.value = F.group;
    var ds = document.getElementById('pl-device'); if (ds) ds.value = F.device;
    var ss = document.getElementById('pl-sort'); if (ss) ss.value = F.sort;
    var nMore = F.tags.length + (F.owner ? 1 : 0) + F.hints.length;
    var mc = document.getElementById('pl-more-count');
    if (mc) { mc.hidden = !nMore; mc.textContent = String(nMore); }
    renderActive();
    renderAttention();
    var list = visible();
    if (!allPeers.length) results.replaceChildren(emptyNone());
    else if (!list.length) results.replaceChildren(emptyNoResult());
    else results.replaceChildren(view === 'list' ? table(list) : grid(list));
    renderBulk(list);
    if (!document.getElementById('pl-more').hidden) renderMorePanel();
    writeHash();
  }

  function renderSummary() {
    var all = allPeers.length;
    var on = allPeers.filter(function (p) { return stateOf(p) === 'online'; }).length;
    var off = allPeers.filter(function (p) { return stateOf(p) === 'offline'; }).length;
    var dis = all - on - off;
    var sum = document.getElementById('pl-summary');
    sum.replaceChildren(
      h('b', { text: all === 1 ? L('pl.summary_one') : L('pl.summary', { n: all }) }), ' · ',
      h('span', { class: 'pl-sum-on' }, [h('i', { class: 'pl-dot pl-dot-on', 'aria-hidden': 'true' }), L('pl.sum_online', { n: on })]), ' · ',
      L('pl.sum_offline', { n: off }), ' · ', L('pl.sum_disabled', { n: dis }));
    var lic = document.getElementById('pl-licence');
    if (lic && counts) {
      var limit = Number(lic.dataset.limit) || 0;
      var kids = [L('pl.licence', { used: counts.total, limit: limit })];
      if (counts.gateways > 0) {
        kids.push(' – ', counts.gateways === 1 ? L('pl.licence_gw_one') : L('pl.licence_gw', { n: counts.gateways }), ' ');
        kids.push(h('a', { href: '/gateways', class: 'pl-link', text: L('pl.licence_gw_link') }));
      }
      lic.replaceChildren.apply(lic, kids);
      lic.classList.toggle('pl-lic-full', limit > 0 && counts.total >= limit);
      lic.hidden = false;
    }
  }

  function chip(label, onRemove) {
    var b = h('button', { type: 'button', class: 'pl-x' }, [icon('x', 12)]);
    b.setAttribute('aria-label', L('pl.chip_remove', { name: label }));
    b.addEventListener('click', onRemove);
    return h('span', { class: 'tag tag-blue pl-fchip' }, [label, b]);
  }
  function renderActive() {
    var box = document.getElementById('pl-active');
    var chips = [];
    var stLabel = { online: L('pl.st_online'), offline: L('pl.st_offline'), disabled: L('pl.st_disabled') };
    if (F.status !== 'all') chips.push(chip(L('pl.chip_status', { v: stLabel[F.status] }), function () { F.status = 'all'; render(); }));
    if (F.group) {
      var g = F.group === 'none' ? null : getGroupById(Number(F.group));
      chips.push(chip(L('pl.chip_group', { v: g ? g.name : L('pl.f_group_none') }), function () { F.group = ''; render(); }));
    }
    if (F.device) chips.push(chip(L('pl.chip_device', { v: L('pl.dev_' + F.device) }), function () { F.device = ''; render(); }));
    if (F.owner) {
      var u = allUsers[F.owner];
      chips.push(chip(L('pl.chip_owner', { v: F.owner === 'none' ? L('pl.f_owner_none') : (u ? (u.display_name || u.username) : '#' + F.owner) }), function () { F.owner = ''; render(); }));
    }
    F.tags.forEach(function (t) { chips.push(chip(L('pl.chip_tag', { v: t }), function () { F.tags = F.tags.filter(function (x) { return x !== t; }); render(); })); });
    F.hints.forEach(function (k) { chips.push(chip(L('pl.h_' + k), function () { F.hints = F.hints.filter(function (x) { return x !== k; }); render(); })); });
    if (searchInput.value.trim()) chips.push(chip(L('pl.chip_search', { v: searchInput.value.trim() }), function () { searchInput.value = ''; render(); }));
    if (chips.length) {
      var reset = h('button', { type: 'button', class: 'pl-link pl-reset', id: 'pl-reset', text: L('pl.reset_all') });
      reset.addEventListener('click', resetFilters);
      chips.push(reset);
    }
    box.replaceChildren.apply(box, chips);
    box.hidden = !chips.length;
  }
  function resetFilters() {
    F.status = 'all'; F.group = ''; F.device = ''; F.owner = ''; F.tags = []; F.hints = [];
    searchInput.value = '';
    render();
  }

  // "Needs attention": one click filters the list
  function renderAttention() {
    var box = document.getElementById('pl-attn');
    var defs = [
      ['update', 'pl-att-red', 'alert', 'pl.attn_update'],
      ['support', 'pl-att-coral', 'box', 'pl.attn_support'],
      ['expiring', 'pl-att-amber', 'clock', 'pl.attn_expiring'],
    ];
    var items = [];
    if (F.hints.length === 0) {
      defs.forEach(function (d) {
        var n = allPeers.filter(function (p) { return hint(d[0], p); }).length;
        if (!n) return;
        var b = h('button', { type: 'button', class: 'pl-att ' + d[1], 'data-hint': d[0] }, [icon(d[2], 14), n === 1 ? L(d[3] + '_one') : L(d[3], { n: n })]);
        b.addEventListener('click', function () { F.hints = [d[0]]; render(); });
        items.push(b);
      });
    }
    box.replaceChildren.apply(box, items);
    box.hidden = !items.length;
  }

  // ─── Pieces of a device ──────────────────────────────────
  function avatar(p, size) {
    var pf = platformOf(p);
    return h('span', { class: 'uav pl-av pl-av-' + pf, 'aria-hidden': 'true' }, [icon(pf === 'android' ? 'phone' : pf === 'windows' ? 'laptop' : 'wg', size || 19)]);
  }
  function statusTag(p) {
    var st = stateOf(p);
    return h('span', { class: 'tag tag-dot ' + (st === 'online' ? 'tag-green' : st === 'offline' ? 'tag-grey' : 'tag-amber'), 'data-state': st, text: L('pl.st_' + st) });
  }
  function groupChip(p) {
    var g = p.group_id ? getGroupById(p.group_id) : null;
    if (!g) return null;
    var dot = h('span', { class: 'pl-gdot' });
    dot.style.background = /^#[0-9a-fA-F]{3,8}$/.test(g.color || '') ? g.color : 'var(--muted)';
    return h('span', { class: 'pl-chip' }, [dot, g.name]);
  }
  function supportBadge(p) {
    var n = Number(p.support_bundles_unviewed) || 0;
    if (n <= 0) return null;
    var title = cuT('support_bundles.peer_badge', { count: n });
    return h('a', { class: 'sb-peer-badge', href: '/support-bundles?peer=' + encodeURIComponent(p.id), title: title, 'aria-label': title }, [icon('box', 11), String(n)]);
  }
  function expiryTag(p) {
    var d = expiryDays(p);
    if (d == null) return null;
    if (d < 0) return h('span', { class: 'tag tag-red pl-mini', text: L('pl.expired') });
    if (d <= 7) return h('span', { class: 'tag tag-amber pl-mini', text: d <= 0 ? L('pl.expires_today') : L('pl.expires_in', { n: d }) });
    return h('span', { class: 'tag tag-grey pl-mini', text: L('pl.expires_on', { date: new Date(p.expires_at).toLocaleDateString() }) });
  }
  function appExtras(p) {
    var out = [];
    if (needsUpdate(p)) out.push(h('span', { class: 'tag tag-red pl-mini', title: p.client_min_version ? L('pl.update_min', { v: p.client_min_version }) : null, text: L('pl.update_needed') }));
    else if (outdated(p)) out.push(h('span', { class: 'tag tag-amber pl-mini', title: p.client_latest_version ? L('pl.outdated_to', { v: p.client_latest_version }) : null, text: L('pl.outdated') }));
    if (p.update_channel_effective === 'beta') out.push(h('span', { class: 'tag tag-purple pl-mini', text: L('pl.beta') }));
    return out;
  }
  function subLine(p) { return [p.description, ownerName(p)].filter(Boolean).join(' · '); }
  function nameLink(p) {
    var a = h('a', { class: 'pl-un', href: '#edit/' + encodeURIComponent(p.id), 'data-action': 'edit', 'data-id': p.id, text: p.name });
    return a;
  }
  function checkbox(p) {
    var cb = h('input', { type: 'checkbox', class: 'pl-cb batch-checkbox', 'data-batch-id': p.id, 'aria-label': L('pl.select', { name: p.name }) });
    cb.checked = selected.has(p.id);
    return cb;
  }
  function iconAction(name, action, p, label, extra) {
    return h('button', { type: 'button', class: 'icon-action' + (extra ? ' ' + extra : ''), 'data-action': action, 'data-id': p.id, title: label, 'aria-label': label }, [icon(name, 15)]);
  }
  function actions(p) {
    return h('span', { class: 'row-actions pl-actions' }, [
      iconAction('qr', 'qr', p, L('pl.act_qr')),
      iconAction('edit', 'edit', p, L('pl.act_edit')),
      h('button', { type: 'button', class: 'icon-action pl-more', 'data-action': 'menu', 'data-id': p.id, title: L('pl.act_more', { name: p.name }), 'aria-label': L('pl.act_more', { name: p.name }), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [icon('more', 15)]),
    ]);
  }
  function enableSwitch(p) {
    var on = !!p.enabled;
    var label = L(on ? 'pl.toggle_off' : 'pl.toggle_on', { name: p.name });
    return h('span', { class: 'pl-swl' }, [
      h('button', { type: 'button', class: 'st-switch pl-sw', role: 'switch', 'aria-checked': String(on), 'aria-label': label, title: label, 'data-action': 'toggle', 'data-id': p.id }, [h('span', { class: 'st-knob', 'aria-hidden': 'true' })]),
      h('span', { 'aria-hidden': 'true', text: on ? L('pl.active') : L('pl.off') }),
    ]);
  }

  // ─── Cards ───────────────────────────────────────────────
  // Name im VPN (vpn-names.js): the full name with a copy button and where it
  // comes from; a device without one offers to give one.
  var VN = window.GCVpnNames || null;
  function nameLines(p) {
    if (!VN) return null;
    var nodes = VN.line(p, { onAssign: function (d) { showEditModal(d.id, 'hostname'); } });
    return nodes.length ? h('div', { class: 'pl-vn' }, nodes) : null;
  }
  function nameCell(p) {
    return VN && p.hostname ? h('div', { class: 'pl-vn pl-vn-row' }, VN.line(p, { noSource: p.hostname_source !== 'stale' })) : null;
  }
  function grid(list) {
    return h('div', { class: 'unit-grid pl-grid' + (selected.size ? ' pl-selecting' : ''), id: 'pl-grid' }, list.map(card));
  }
  function card(p) {
    var st = stateOf(p);
    var on = st === 'online';
    function row(k, v, mono) { return h('div', { class: 'urow' }, [h('span', { text: k }), h('b', { class: mono ? 'pl-mono' : 'pl-plain', text: v })]); }
    var chips = [groupChip(p)].concat(appExtras(p), [expiryTag(p)], tagsOf(p).map(function (t) { return h('span', { class: 'pl-tagname', text: '#' + t }); }));
    return h('div', { class: 'unit pl-card pl-' + st + (selected.has(p.id) ? ' pl-selected' : ''), 'data-peer-id': p.id }, [
      h('div', { class: 'uh pl-uh' }, [
        checkbox(p),
        avatar(p),
        h('div', { class: 'pl-ttl' }, [h('div', { class: 'pl-name' }, [nameLink(p), supportBadge(p)]), h('div', { class: 'pl-sub', text: subLine(p) || '—' })]),
        h('span', { class: 'pl-st' }, [statusTag(p)]),
      ]),
      nameLines(p),
      h('div', { class: 'pl-chips' }, chips),
      h('div', { class: 'pl-rows' }, [
        row(L('pl.row_app'), appLabel(p)),
        row(on ? L('pl.row_connected') : L('pl.row_seen'), on ? L('pl.handshake', { ago: ago(handshakeMs(p)) }) : ago(handshakeMs(p))),
        row(L('pl.row_traffic'), '↓ ' + formatBytes(rx(p)) + '   ↑ ' + formatBytes(tx(p)), true),
        row(L('pl.row_ip'), ipOf(p) || '—', true),
      ]),
      h('div', { class: 'pl-foot' }, [enableSwitch(p), actions(p)]),
    ]);
  }

  // ─── List ────────────────────────────────────────────────
  function table(list) {
    var all = list.every(function (p) { return selected.has(p.id); });
    var some = list.some(function (p) { return selected.has(p.id); });
    var head = h('input', { type: 'checkbox', class: 'pl-cb', id: 'pl-select-all', 'aria-label': L('pl.select_all') });
    head.checked = all; head.indeterminate = some && !all;
    var thead = h('thead', {}, [h('tr', {}, [
      h('th', { class: 'pl-c-cb' }, [head]),
      h('th', { text: L('pl.col_device') }), h('th', { text: L('pl.col_status') }), h('th', { text: L('pl.col_app') }),
      h('th', { text: L('pl.col_group') }), h('th', { text: L('pl.col_ip') }), h('th', { text: L('pl.col_traffic') }),
      h('th', { class: 'pl-c-act' }, [h('span', { class: 'rt-sr', text: L('pl.col_actions') })]),
    ])]);
    var tbody = h('tbody', { id: 'peers-tbody' }, list.map(function (p) {
      var st = stateOf(p);
      return h('tr', { class: 'pl-' + st + (selected.has(p.id) ? ' pl-row-sel' : ''), 'data-peer-id': p.id }, [
        h('td', { class: 'pl-c-cb' }, [checkbox(p)]),
        h('td', {}, [h('div', { class: 'pl-dev' }, [avatar(p, 16), h('div', { class: 'pl-ttl' }, [
          h('div', { class: 'pl-name' }, [nameLink(p), supportBadge(p), expiryTag(p)]),
          h('div', { class: 'pl-sub', text: subLine(p) }),
          nameCell(p),
        ])])]),
        h('td', {}, [h('div', { class: 'pl-stc' }, [statusTag(p), h('span', { class: 'pl-sub', text: ago(handshakeMs(p)) })])]),
        h('td', { class: 'pl-c-app' }, [h('div', { class: 'pl-stc' }, [h('span', { class: 'pl-app', text: appLabel(p) })].concat(appExtras(p)))]),
        h('td', { class: 'pl-c-grp' }, [groupChip(p)]),
        h('td', { class: 'mono pl-c-ip', text: ipOf(p) || '—' }),
        h('td', { class: 'mono pl-c-traffic', text: '↓ ' + formatBytes(rx(p)) + '  ↑ ' + formatBytes(tx(p)) }),
        h('td', { class: 'pl-c-act' }, [actions(p)]),
      ]);
    }));
    return h('div', { class: 'card span12 pl-tablecard' }, [h('table', { class: 'data-table pl-table', id: 'pl-table' }, [thead, tbody])]);
  }

  // ─── Empty states ────────────────────────────────────────
  function emptyNone() {
    var add = h('button', { type: 'button', class: 'btn btn-primary', id: 'pl-empty-add' }, [icon('plus', 16), h('span', { text: L('pl.add') })]);
    add.addEventListener('click', function () { document.getElementById('btn-add-peer').click(); });
    return h('div', { class: 'card rt-empty-card pl-empty', id: 'pl-empty' }, [
      h('div', { class: 'rt-empty-icon' }, [icon('phone', 24)]),
      h('div', { class: 'rt-empty-title', text: L('pl.empty_title') }),
      h('div', { class: 'rt-empty-text', text: L('pl.empty_text') }),
      h('div', { class: 'pl-empty-act' }, [add]),
      h('div', { class: 'pl-empty-hint' }, [L('pl.empty_gw') + ' ', h('a', { href: '/gateways', class: 'pl-link', text: L('pl.empty_gw_link') })]),
    ]);
  }
  function emptyNoResult() {
    var q = searchInput.value.trim();
    var kids = [];
    if (q) {
      var cs = h('button', { type: 'button', class: 'btn btn-ghost', id: 'pl-clear-search', text: L('pl.clear_search') });
      cs.addEventListener('click', function () { searchInput.value = ''; render(); searchInput.focus(); });
      kids.push(cs);
    }
    var rf = h('button', { type: 'button', class: 'btn btn-ghost', id: 'pl-noresult-reset', text: L('pl.reset_all') });
    rf.addEventListener('click', resetFilters);
    kids.push(rf);
    return h('div', { class: 'card rt-empty-card pl-empty', id: 'pl-noresult' }, [
      h('div', { class: 'rt-empty-icon' }, [icon('search', 24)]),
      h('div', { class: 'rt-empty-title', text: L('pl.nores_title') }),
      h('div', { class: 'rt-empty-text', text: q ? L('pl.nores_text_q', { q: q }) : L('pl.nores_text') }),
      h('div', { class: 'pl-empty-act' }, kids),
    ]);
  }

  // ─── "Weitere Filter" (popover; a bottom sheet on phones) ─
  var morePanel = document.getElementById('pl-more');
  var moreBtn = document.getElementById('pl-more-btn');
  function fbtn(label, on, fn) {
    var b = h('button', { type: 'button', class: 'pl-fbtn' + (on ? ' on' : ''), 'aria-pressed': String(!!on) }, [on ? icon('check', 13) : null, label]);
    b.addEventListener('click', function () { fn(); render(); });
    return b;
  }
  function fsec(title, kids, cls) {
    return h('div', { class: 'pl-fsec' + (cls ? ' ' + cls : '') }, [h('div', { class: 'pl-fh', text: title }), h('div', { class: 'pl-fwrap' }, kids)]);
  }
  function renderMorePanel() {
    var owners = {};
    var tags = {};
    allPeers.forEach(function (p) {
      if (p.user_id != null) owners[p.user_id] = (owners[p.user_id] || 0) + 1;
      tagsOf(p).forEach(function (t) { var k = t.toLowerCase(); if (!tags[k]) tags[k] = { name: t, n: 0 }; tags[k].n++; });
    });
    var secs = [];
    // phones: the toolbar's selects move in here
    var c = { all: allPeers.length };
    ['online', 'offline', 'disabled'].forEach(function (s) { c[s] = allPeers.filter(function (p) { return stateOf(p) === s; }).length; });
    secs.push(fsec(L('pl.status_label'), ['all', 'online', 'offline', 'disabled'].map(function (s) {
      return fbtn(L('pl.st_' + s) + ' ' + c[s], F.status === s, function () { F.status = s; });
    }), 'pl-narrow'));
    secs.push(fsec(L('pl.f_group'), [fbtn(L('pl.f_all'), !F.group, function () { F.group = ''; })].concat(allGroups.map(function (g) {
      return fbtn(g.name, F.group === String(g.id), function () { F.group = String(g.id); });
    }), [fbtn(L('pl.f_group_none'), F.group === 'none', function () { F.group = 'none'; })]), 'pl-narrow'));
    secs.push(fsec(L('pl.f_device'), [fbtn(L('pl.f_all'), !F.device, function () { F.device = ''; })].concat(['android', 'windows', 'none'].map(function (d) {
      return fbtn(L('pl.dev_' + d), F.device === d, function () { F.device = d; });
    })), 'pl-narrow'));
    secs.push(fsec(L('pl.f_sort'), ['status', 'name', 'seen', 'traffic', 'group', 'ip'].map(function (s) {
      return fbtn(L('pl.sort_' + s), F.sort === s, function () { F.sort = s; });
    }), 'pl-narrow'));
    secs.push(fsec(L('pl.f_owner'), [fbtn(L('pl.f_all'), !F.owner, function () { F.owner = ''; })].concat(Object.keys(owners).map(function (id) {
      var u = allUsers[id];
      var name = u ? (u.display_name || u.username) : ((allPeers.find(function (p) { return String(p.user_id) === id; }) || {}).owner_name || '#' + id);
      return fbtn(name + ' ' + owners[id], F.owner === id, function () { F.owner = F.owner === id ? '' : id; });
    }), [fbtn(L('pl.f_owner_none'), F.owner === 'none', function () { F.owner = F.owner === 'none' ? '' : 'none'; })])));
    var tagKeys = Object.keys(tags).sort();
    secs.push(fsec(L('pl.f_tags'), tagKeys.length ? tagKeys.map(function (k) {
      var t = tags[k].name;
      var on = F.tags.some(function (x) { return x.toLowerCase() === k; });
      return fbtn('#' + t + ' ' + tags[k].n, on, function () {
        F.tags = on ? F.tags.filter(function (x) { return x.toLowerCase() !== k; }) : F.tags.concat([t]);
      });
    }) : [h('span', { class: 'pl-fnone', text: L('pl.f_tags_none') })]));
    secs.push(fsec(L('pl.f_attn'), HINT_KEYS.map(function (k) {
      var on = F.hints.indexOf(k) !== -1;
      return fbtn(L('pl.h_' + k) + ' ' + allPeers.filter(function (p) { return hint(k, p); }).length, on, function () {
        F.hints = on ? F.hints.filter(function (x) { return x !== k; }) : F.hints.concat([k]);
      });
    })));
    var reset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: L('pl.reset') });
    reset.addEventListener('click', resetFilters);
    var n = visible().length;
    var done = h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'pl-more-done' }, [h('span', { class: 'pl-more-l', text: L('pl.done') }), h('span', { class: 'pl-more-s', text: L('pl.show_n', { n: n }) })]);
    done.addEventListener('click', function () { setMore(false); moreBtn.focus(); });
    morePanel.replaceChildren.apply(morePanel, [h('div', { class: 'pl-sheet-grip', 'aria-hidden': 'true' }), h('div', { class: 'pl-sheet-title', text: L('pl.filters_title') })]
      .concat(secs, [h('div', { class: 'pl-ffoot' }, [reset, done])]));
  }
  var tbwrap = morePanel.parentNode;
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };
  function setMore(open) {
    // phones: a bottom sheet above the bottom navigation — it moves to <body>
    // (<main> is a stacking context below the navigation); desktop: a popover under the button
    if (open && narrow.matches) { if (morePanel.parentNode !== document.body) document.body.appendChild(morePanel); morePanel.style.left = ''; }
    else if (morePanel.parentNode !== tbwrap) tbwrap.appendChild(morePanel);
    if (open && !narrow.matches) morePanel.style.left = Math.max(0, Math.min(moreBtn.offsetLeft, tbwrap.clientWidth - 400)) + 'px';
    morePanel.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(!!open));
    document.body.classList.toggle('pl-sheet-open', !!open && narrow.matches);
    if (open) {
      renderMorePanel();
      var first = morePanel.querySelector('button'); if (first) first.focus();
    }
  }
  moreBtn.addEventListener('click', function (e) { e.stopPropagation(); setMore(morePanel.hidden); });
  document.addEventListener('click', function (e) {
    if (!morePanel.hidden && !morePanel.contains(e.target) && !moreBtn.contains(e.target)) setMore(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (openMenu) { var b = openMenu.btn; closeMenu(); if (b) b.focus(); return; }
    if (!morePanel.hidden) { setMore(false); moreBtn.focus(); }
  });

  // ─── Toolbar events ──────────────────────────────────────
  var searchTimer = null;
  searchInput.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
  document.getElementById('pl-status').addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]'); if (!b) return;
    F.status = b.dataset.status; render();
  });
  document.getElementById('pl-view').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]'); if (!b) return;
    view = b.dataset.view === 'list' ? 'list' : 'cards';
    store(VIEW_KEY, view);
    render();
  });
  document.getElementById('pl-group').addEventListener('change', function () { F.group = this.value; render(); });
  document.getElementById('pl-device').addEventListener('change', function () { F.device = this.value; render(); });
  document.getElementById('pl-sort').addEventListener('change', function () { F.sort = this.value; render(); });

  // ─── Row / card actions ──────────────────────────────────
  function peerById(id) { return allPeers.find(function (p) { return String(p.id) === String(id); }); }
  results.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var id = t.dataset.id;
    switch (t.dataset.action) {
      case 'edit': e.preventDefault(); showEditModal(id); break;
      case 'qr': showQrModal(id); break;
      case 'toggle': togglePeer(id); break;
      case 'menu': e.stopPropagation(); toggleMenu(t, id); break;
    }
  });
  results.addEventListener('change', function (e) {
    if (e.target.id === 'pl-select-all') {
      var list = visible();
      list.forEach(function (p) { if (e.target.checked) selected.add(p.id); else selected.delete(p.id); });
      render();
      return;
    }
    var cb = e.target.closest('.pl-cb[data-batch-id]');
    if (!cb) return;
    var id = Number(cb.dataset.batchId);
    if (cb.checked) selected.add(id); else selected.delete(id);
    render();
    var again = results.querySelector('.pl-cb[data-batch-id="' + id + '"]'); if (again) again.focus();
  });

  // "⋯" menu of a device (download, traffic, enable/disable, delete)
  function closeMenu() {
    if (!openMenu) return;
    openMenu.el.remove();
    if (openMenu.btn) openMenu.btn.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  function toggleMenu(btn, id) {
    if (openMenu && openMenu.btn === btn) { closeMenu(); return; }
    closeMenu();
    var p = peerById(id); if (!p) return;
    function item(ic, label, fn, danger) {
      var b = h('button', { type: 'button', class: 'zn-menu-item' + (danger ? ' danger' : ''), role: 'menuitem' }, [h('span', { class: 'zn-ic' }, [icon(ic, 14)]), label]);
      b.addEventListener('click', function () { closeMenu(); fn(); });
      return b;
    }
    var dl = h('a', { class: 'zn-menu-item', role: 'menuitem', href: '/api/v1/peers/' + encodeURIComponent(p.id) + '/config?download=1', download: p.name + '.conf' }, [h('span', { class: 'zn-ic' }, [icon('download', 14)]), L('pl.act_download')]);
    var m = h('div', { class: 'zn-menu pl-menu', role: 'menu', id: 'pl-menu', 'aria-label': L('pl.act_more', { name: p.name }) }, [
      dl,
      item('chart', L('pl.act_traffic'), function () { showTrafficModal(p.id); }),
      h('div', { class: 'zn-menu-sep', role: 'separator' }),
      item('power', p.enabled ? L('pl.act_disable') : L('pl.act_enable'), function () { togglePeer(p.id); }),
      item('trash', L('pl.act_delete'), function () { showConfirmDelete(p.id, p.name); }, true),
    ]);
    document.body.appendChild(m);
    var r = btn.getBoundingClientRect();
    var w = m.offsetWidth || 230;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    var top = r.bottom + 6;
    if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
    m.style.top = top + 'px';
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { el: m, btn: btn };
    var first = m.querySelector('[role="menuitem"]'); if (first) first.focus();
    m.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(m.querySelectorAll('[role="menuitem"]'));
      var i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') closeMenu();
    });
  }
  document.addEventListener('click', function (e) { if (openMenu && !openMenu.el.contains(e.target)) closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);

  // ─── Enable / disable (asks first when the device is connected) ─
  async function togglePeer(id) {
    var p = peerById(id);
    if (p && p.enabled && p.isOnline) {
      var ok = await D.confirm({ message: L('pl.confirm_disable_online', { name: p.name }), danger: true, okLabel: L('pl.act_disable') });
      if (!ok) return;
    }
    try {
      var data = await api.put('/api/peers/' + id + '/toggle');
      if (data && !data.ok) {
        showToast(data.error || 'Error', 'error');
        return;
      }
      loadPeers();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ─── Bulk bar ────────────────────────────────────────────
  var bulkBar = document.getElementById('pl-bulkbar');
  function renderBulk(list) {
    var n = selected.size;
    bulkBar.hidden = !n;
    document.body.classList.toggle('sh-bulk-open', !!n);
    if (!n) return;
    document.getElementById('pl-bulk-count').textContent = L('pl.bulk_selected', { n: n });
    var all = document.getElementById('pl-bulk-all');
    var missing = list.filter(function (p) { return !selected.has(p.id); }).length;
    all.hidden = !missing;
    all.textContent = L('pl.bulk_select_visible', { n: list.length });
  }
  document.getElementById('pl-bulk-all').addEventListener('click', function () {
    visible().forEach(function (p) { selected.add(p.id); });
    render();
  });
  function selectedPeers() { return allPeers.filter(function (p) { return selected.has(p.id); }); }
  function bulkDone(r) {
    if (!r || r.ok === false) { D.alert({ message: (r && r.error) || DT('common.error'), danger: true }); return; }
    showToast(L('pl.bulk_done', { n: r.affected != null ? r.affected : selected.size }));
    selected.clear();
    loadPeers();
    loadGroups();
  }
  function bulkFail(err) { D.alert({ message: DT('common.error') + ': ' + err.message, danger: true }); }
  function ids() { return Array.from(selected).map(Number); }
  function chooseDialog(title, label, options, current) {
    var d = D.dialog({ title: title });
    var sel = h('select', { class: 'form-input', id: 'pl-bulk-select', 'aria-label': label });
    options.forEach(function (o) { sel.appendChild(new Option(o[1], o[0])); });
    if (current != null) sel.value = current;
    d.body.appendChild(h('label', { class: 'form-label', for: 'pl-bulk-select', text: label }));
    d.body.appendChild(sel);
    var cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: DT('common.cancel') });
    var ok = h('button', { type: 'button', class: 'btn btn-primary', id: 'pl-bulk-apply', text: L('pl.bulk_apply') });
    cancel.addEventListener('click', function () { d.close(null); });
    ok.addEventListener('click', function () { d.close({ value: sel.value }); });
    d.foot.appendChild(cancel);
    d.foot.appendChild(ok);
    sel.focus();
    return d.promise;
  }
  bulkBar.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-bulk]'); if (!b) return;
    var act = b.dataset.bulk;
    var n = selected.size;
    if (act === 'clear') { selected.clear(); render(); return; }
    if (!n) return;
    try {
      if (act === 'enable') return bulkDone(await api.post('/api/peers/batch', { action: 'enable', ids: ids() }));
      if (act === 'disable') {
        var online = selectedPeers().filter(function (p) { return p.enabled && p.isOnline; }).length;
        if (online && !await D.confirm({ message: L('pl.bulk_confirm_disable_online', { n: online }), danger: true, okLabel: L('pl.bulk_disable') })) return;
        return bulkDone(await api.post('/api/peers/batch', { action: 'disable', ids: ids() }));
      }
      if (act === 'delete') {
        if (!await D.confirm({ message: L('pl.bulk_confirm_delete', { n: n }), danger: true, okLabel: DT('common.delete') })) return;
        return bulkDone(await api.post('/api/peers/batch', { action: 'delete', ids: ids() }));
      }
      if (act === 'group') {
        var gr = await chooseDialog(L('pl.bulk_group_title', { n: n }), L('pl.f_group'),
          [['', L('pl.f_group_none')]].concat(allGroups.map(function (g) { return [String(g.id), g.name]; })));
        if (!gr) return;
        return bulkDone(await api.post('/api/peers/batch', { action: 'group', ids: ids(), group_id: gr.value === '' ? null : Number(gr.value) }));
      }
      if (act === 'owner') {
        var users = Object.keys(allUsers).map(function (id) { return allUsers[id]; });
        var ow = await chooseDialog(L('pl.bulk_owner_title', { n: n }), L('pl.f_owner'),
          [['', L('pl.owner_none')]].concat(users.map(function (u) { return [String(u.id), u.display_name ? u.display_name + ' (' + u.username + ')' : u.username]; })));
        if (!ow) return;
        var r = await api.post('/api/v1/peers/batch-owner', { peer_ids: ids(), user_id: ow.value === '' ? null : Number(ow.value) });
        return bulkDone(r);
      }
      if (act === 'tag') {
        var tag = await D.prompt({ title: L('pl.bulk_tag_title', { n: n }), label: L('pl.bulk_tag_label'), okLabel: L('pl.bulk_apply'), maxLength: 64,
          validate: function (v) { return !v || /[,<>"]/.test(v) ? L('pl.tag_invalid') : null; } });
        if (tag == null) return;
        return bulkDone(await api.post('/api/peers/batch', { action: 'tag', ids: ids(), tag: tag }));
      }
    } catch (err) { bulkFail(err); }
  });

  // ─── Expiry helpers ──────────────────────────────────────
  function computeExpiresAt(selectId, dateInputId) {
    var sel = document.getElementById(selectId);
    var dateInput = document.getElementById(dateInputId);
    var val = sel.value;
    if (!val) return null;
    if (val === 'custom') {
      if (!dateInput.value) return null;
      return dateInput.value + 'T23:59:59.000Z';
    }
    var days = parseInt(val, 10);
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  function setupExpiryToggle(selectId, dateInputId) {
    var sel = document.getElementById(selectId);
    var dateInput = document.getElementById(dateInputId);
    sel.addEventListener('change', function() {
      dateInput.style.display = sel.value === 'custom' ? '' : 'none';
    });
  }

  setupExpiryToggle('add-peer-expires', 'add-peer-expires-date');
  setupExpiryToggle('edit-peer-expires', 'edit-peer-expires-date');

  // ─── Add peer ────────────────────────────────────────────
  // Gateways are added with the assistant on /gateways (docs/feature-gateway-wizard.md).

  document.getElementById('btn-add-peer').addEventListener('click', function() {
    document.getElementById('add-peer-name').value = '';
    document.getElementById('add-peer-desc').value = '';
    document.getElementById('add-peer-tags').value = '';
    document.getElementById('add-peer-group').value = '';
    var addOwnerSel = document.getElementById('add-peer-owner');
    if (addOwnerSel) addOwnerSel.value = '';
    document.getElementById('add-peer-expires').value = '';
    document.getElementById('add-peer-expires-date').value = '';
    document.getElementById('add-peer-expires-date').style.display = 'none';
    if (addNameField) addNameField.set(null);
    hideError('add-peer-error');
    clearFieldErrors();
    renderGroupDropdowns();
    openModal('modal-add-peer');
    document.getElementById('add-peer-name').focus();
  });

  document.getElementById('btn-add-peer-submit').addEventListener('click', async function() {
    var btn = this;
    var name = document.getElementById('add-peer-name').value.trim();
    var description = document.getElementById('add-peer-desc').value.trim();
    var tags = document.getElementById('add-peer-tags').value.trim();
    var group_id = document.getElementById('add-peer-group').value ? parseInt(document.getElementById('add-peer-group').value, 10) : null;

    if (!name) {
      showError('add-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      var dns = document.getElementById('add-peer-dns') ? document.getElementById('add-peer-dns').value.trim() : undefined;
      var expires_at = computeExpiresAt('add-peer-expires', 'add-peer-expires-date');
      var addOwnerEl = document.getElementById('add-peer-owner');
      var payload = { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns || undefined,
        user_id: addOwnerEl ? (addOwnerEl.value === '' ? null : Number(addOwnerEl.value)) : null };
      var data = await api.post('/api/peers', payload);
      if (data.ok) {
        clearFieldErrors();

        // Hostname is a separate, license-gated endpoint. Only call when the
        // field is visible AND the admin entered a value. The device exists by
        // now: a name the server refuses (the live check knows the rules and
        // the other devices, not the routes) is corrected in "Bearbeiten".
        var addHostnameVal = addNameField ? addNameField.value() : '';
        if (addHostnameVal && data.peer && data.peer.id) {
          var hnRes = await api.patch('/api/peers/' + data.peer.id + '/hostname', { hostname: addHostnameVal }).catch(function (e) { return (e && e.data) || { ok: false, error: e.message }; });
          if (!hnRes.ok) {
            closeModal('modal-add-peer');
            await loadPeers();
            loadGroups();
            await showEditModal(data.peer.id, 'hostname');
            if (editNameField) { editNameField.input.value = addHostnameVal; editNameField.serverError(hnRes); }
            return;
          }
        }

        closeModal('modal-add-peer');
        showQrModal(data.peer.id);
        loadPeers();
        loadGroups();
      } else if (data.fields) {
        showFieldErrors(data.fields, { name: 'add-peer-name', description: 'add-peer-desc' });
      } else {
        showError('add-peer-error', data.error);
      }
    } catch (err) {
      showError('add-peer-error', err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Client policy (peer override) ───────────────────────
  var peerPolicyForm = null;
  var peerPolicyLoaded = null; // JSON of the override as loaded (change detection)
  function loadPeerPolicy(peer) {
    var box = document.getElementById('edit-peer-policy-form');
    var wrap = document.getElementById('edit-peer-policy-group');
    var badge = document.getElementById('edit-peer-policy-badge');
    peerPolicyLoaded = null;
    if (!box || !wrap || !window.ClientPolicyForm) return;
    wrap.style.display = peer.peer_type === 'gateway' ? 'none' : '';
    wrap.open = false;
    if (peer.peer_type === 'gateway') return;
    peerPolicyForm = ClientPolicyForm.create(box, { mode: 'override', idPrefix: 'edit-peer-cp' });
    var n = peer.client_policy ? Object.keys(peer.client_policy).length : 0;
    if (badge) { badge.style.display = n ? '' : 'none'; badge.textContent = String(n); }
    api.get('/api/peers/' + peer.id + '/client-policy').then(function (r) {
      if (!r || !r.ok || String(editingPeerId) !== String(peer.id)) return;
      peerPolicyForm.setInherited(r.data.inherited, r.data.inherited_sources);
      peerPolicyForm.setValue(r.data.override || {});
      peerPolicyLoaded = JSON.stringify(peerPolicyForm.getValue());
    }).catch(function (err) { console.warn('[peers] loading client policy failed', err); });
  }

  var editingPeerId = null;
  async function showEditModal(wanted, focusField) {
    var peer = allPeers.find(function(p) { return String(p.id) === String(wanted); });
    if (!peer) return;
    var id = peer.id;
    editingPeerId = id;

    document.getElementById('edit-peer-id').value = id;
    document.getElementById('edit-peer-name').value = peer.name || '';
    document.getElementById('edit-peer-desc').value = peer.description || '';
    document.getElementById('edit-peer-tags').value = peer.tags || '';

    renderGroupDropdowns();
    document.getElementById('edit-peer-group').value = peer.group_id ? String(peer.group_id) : '';
    var editOwnerSel = document.getElementById('edit-peer-owner');
    if (editOwnerSel) editOwnerSel.value = peer.user_id != null ? String(peer.user_id) : '';

    // Client policy override (inherited values from group/global shown in
    // the "Erben (…)" options; loaded per peer).
    loadPeerPolicy(peer);

    // Update channel (admin-assigned) + last reported client version
    var updGroup = document.getElementById('edit-peer-update-group');
    var updSel = document.getElementById('edit-peer-update-channel');
    if (updGroup && updSel) {
      updGroup.style.display = peer.peer_type === 'gateway' ? 'none' : '';
      var defLabel = cuT('client_updates.channel_' + (updatePolicy.default_channel || 'stable'));
      if (updSel.options[0]) updSel.options[0].textContent = cuT('client_updates.peer_channel_default', { channel: defLabel });
      updSel.value = peer.update_channel === 'stable' || peer.update_channel === 'beta' ? peer.update_channel : '';
      var info = document.getElementById('edit-peer-client-info');
      if (info) {
        while (info.firstChild) info.removeChild(info.firstChild);
        var span = document.createElement('span');
        if (peer.client_version) {
          span.className = 'mono';
          span.textContent = (clientProductLabel(peer.client_product) + ' ' + peer.client_version).trim();
          info.appendChild(span);
          if (peer.client_below_min) {
            var tag = document.createElement('span');
            tag.className = 'tag tag-red';
            tag.style.fontSize = '10px';
            tag.textContent = cuT('client_updates.overview_below_min') + (peer.client_min_version ? ' (' + peer.client_min_version + ')' : '');
            info.appendChild(tag);
          }
          if (peer.client_seen_at) {
            var seen = document.createElement('span');
            seen.style.color = 'var(--text-3)';
            seen.textContent = cuT('client_updates.peer_last_seen', { time: peer.client_seen_at + ' UTC' });
            info.appendChild(seen);
          }
        } else {
          span.style.color = 'var(--text-3)';
          span.textContent = cuT('client_updates.peer_client_none');
          info.appendChild(span);
        }
      }
    }

    // Support bundles of this device (public/js/support-bundles.js)
    if (window.GCSupportBundles) window.GCSupportBundles.open(peer);

    var editExpiresSel = document.getElementById('edit-peer-expires');
    var editExpiresDate = document.getElementById('edit-peer-expires-date');
    if (peer.expires_at) {
      editExpiresSel.value = 'custom';
      editExpiresDate.style.display = '';
      editExpiresDate.value = peer.expires_at.substring(0, 10);
    } else {
      editExpiresSel.value = '';
      editExpiresDate.style.display = 'none';
      editExpiresDate.value = '';
    }

    var editDns = document.getElementById('edit-peer-dns');
    if (editDns) editDns.value = peer.dns || '';

    if (editNameField) editNameField.set(peer);

    hideError('edit-peer-error');
    clearFieldErrors();
    openModal('modal-edit-peer');
    // "Namen vergeben" on a card leads straight to the field
    var first = focusField === 'hostname' && editNameField ? editNameField.input : document.getElementById('edit-peer-name');
    first.focus();
  }

  // Name im VPN in both dialogs (vpn-names.js): live check against the rules,
  // the reserved names and the names of the other devices; the server's answer
  // (PATCH …/hostname) is shown at the field with its suggestion.
  function nameField(prefix, saveBtnId) {
    var input = document.getElementById(prefix + '-peer-hostname');
    if (!input || !VN) return null;
    return VN.field({
      input: input,
      suffix: document.getElementById(prefix + '-peer-hostname-suffix'),
      hint: document.getElementById(prefix + '-peer-hostname-hint'),
      badge: document.getElementById(prefix + '-peer-hostname-badge'),
      saveBtn: document.getElementById(saveBtnId),
      others: function () { return allPeers; },
    });
  }
  var editNameField = nameField('edit', 'btn-edit-peer-submit');
  var addNameField = nameField('add', 'btn-add-peer-submit');

  document.getElementById('btn-edit-peer-submit').addEventListener('click', async function() {
    var btn = this;
    var id = editingPeerId;
    if (id == null) return;
    var name = document.getElementById('edit-peer-name').value.trim();
    var description = document.getElementById('edit-peer-desc').value.trim();
    var tags = document.getElementById('edit-peer-tags').value.trim();
    var group_id = document.getElementById('edit-peer-group').value ? parseInt(document.getElementById('edit-peer-group').value, 10) : null;

    if (!name) {
      showError('edit-peer-error', GC.t['peers.name_required'] || 'Name is required');
      return;
    }

    btnLoading(btn);
    try {
      var dns = document.getElementById('edit-peer-dns') ? document.getElementById('edit-peer-dns').value.trim() : undefined;
      var expires_at = computeExpiresAt('edit-peer-expires', 'edit-peer-expires-date');
      var editOwnerEl = document.getElementById('edit-peer-owner');
      var payload = { name: name, description: description, tags: tags, expires_at: expires_at, group_id: group_id, dns: dns || undefined,
        user_id: editOwnerEl ? (editOwnerEl.value === '' ? null : Number(editOwnerEl.value)) : null };
      // Only send the channel when it changed (separate audit entry server-side).
      var updSelEl = document.getElementById('edit-peer-update-channel');
      var updGroupEl = document.getElementById('edit-peer-update-group');
      if (updSelEl && (!updGroupEl || updGroupEl.style.display !== 'none')) {
        var prevPeer = allPeers.find(function(p) { return String(p.id) === String(id); }) || {};
        var prevChannel = prevPeer.update_channel || '';
        if (updSelEl.value !== prevChannel) payload.update_channel = updSelEl.value || null;
      }
      // Client policy override: only when loaded and changed (own audit entry).
      if (peerPolicyForm && peerPolicyLoaded !== null) {
        if (!peerPolicyForm.isValid()) {
          showError('edit-peer-error', GC.t['error.client_policy.invalid'] || 'Invalid client policy');
          return;
        }
        var policyNow = JSON.stringify(peerPolicyForm.getValue());
        if (policyNow !== peerPolicyLoaded) payload.client_policy = peerPolicyForm.getValue();
      }
      var data = await api.put('/api/peers/' + id, payload);
      if (!data.ok) {
        if (data.fields) {
          showFieldErrors(data.fields, { name: 'edit-peer-name', description: 'edit-peer-desc' });
        } else {
          showError('edit-peer-error', data.error);
        }
        return;
      }

      // Hostname is a separate endpoint (license-gated). Only call when the
      // field is visible AND the value actually changed.
      if (editNameField && editNameField.changed()) {
        var hnRes = await api.patch('/api/peers/' + id + '/hostname', { hostname: editNameField.value() }).catch(function (e) { return (e && e.data) || { ok: false, error: e.message }; });
        if (!hnRes.ok) {
          editNameField.serverError(hnRes);
          loadPeers();
          return;
        }
      }

      clearFieldErrors();
      closeModal('modal-edit-peer');
      loadPeers();
      loadGroups();
    } catch (err) {
      showError('edit-peer-error', err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── QR modal ────────────────────────────────────────────
  // "Set up Android app": swaps the bare WireGuard QR for a one-shot setup
  // code that gives the app VPN plus API access (public/js/client-enrollment.js).
  var qrPeerEnrollTarget = null;
  document.getElementById('qr-peer-enroll').addEventListener('click', function () {
    if (!qrPeerEnrollTarget || !window.openClientEnrollment) return;
    closeModal('modal-qr-peer');
    window.openClientEnrollment({
      peerId: qrPeerEnrollTarget.peerId,
      title: qrPeerEnrollTarget.name + ' \u2014 ' + document.getElementById('client-enroll-title').textContent,
    });
  });

  async function showQrModal(id) {
    try {
      var data = await api.get('/api/peers/' + id + '/qr');
      if (data.ok) {
        document.getElementById('qr-peer-title').textContent = data.name + ' \u2014 QR Code';
        document.getElementById('qr-peer-img').src = data.qr;
        document.getElementById('qr-peer-config').textContent = data.config;
        document.getElementById('qr-peer-download').href = '/api/v1/peers/' + id + '/config?download=1';
        document.getElementById('qr-peer-download').download = data.name + '.conf';
        qrPeerEnrollTarget = { peerId: id, name: data.name };
        openModal('modal-qr-peer');
      }
    } catch (err) {
      D.alert({ message: DT('common.error') + ': ' + err.message, danger: true });
    }
  }

  // ─── Copy config to clipboard ───────────────────────────
  document.getElementById('qr-peer-copy').addEventListener('click', async function() {
    var config = document.getElementById('qr-peer-config').textContent;
    var btn = document.getElementById('qr-peer-copy');
    var label = document.getElementById('qr-peer-copy-label');
    try {
      await navigator.clipboard.writeText(config);
      var original = label.textContent;
      label.textContent = btn.dataset.copiedText || 'Copied!';
      setTimeout(function() { label.textContent = original; }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });

  // ─── Delete ──────────────────────────────────────────────
  var pendingDeleteId = null;

  function showConfirmDelete(id, name) {
    pendingDeleteId = id;
    document.getElementById('confirm-message').textContent =
      (GC.t['peers.confirm_delete'] || 'Are you sure you want to delete this peer?').replace('?', ' "' + (name || id) + '"?');
    openModal('modal-confirm');
  }

  document.getElementById('btn-confirm-yes').addEventListener('click', async function() {
    if (!pendingDeleteId) return;
    var btn = this;
    btnLoading(btn);
    try {
      await api.del('/api/peers/' + pendingDeleteId);
      closeModal('modal-confirm');
      pendingDeleteId = null;
      loadPeers();
      loadGroups();
    } catch (err) {
      D.alert({ message: DT('common.error') + ': ' + err.message, danger: true });
    } finally {
      btnReset(btn);
    }
  });

  // ─── Traffic modal ─────────────────────────────────────
  var trafficPeerId = null;
  var trafficPeriod = '24h';

  async function showTrafficModal(id) {
    trafficPeerId = id;
    trafficPeriod = '24h';
    var modal = document.getElementById('modal-peer-traffic');
    if (!modal) return;
    modal.querySelectorAll('.tab[data-period]').forEach(function(t) {
      t.classList.toggle('active', t.dataset.period === '24h');
    });
    openModal('modal-peer-traffic');
    await loadTrafficChart();
  }

  async function loadTrafficChart() {
    if (!trafficPeerId) return;
    try {
      var data = await api.get('/api/peers/' + trafficPeerId + '/traffic?period=' + trafficPeriod);
      if (!data.ok) return;
      document.getElementById('traffic-peer-title').textContent = data.peer.name;
      document.getElementById('traffic-peer-total').textContent =
        '\u03A3 ' + formatBytes((data.peer.total_rx || 0) + (data.peer.total_tx || 0)) +
        '  \u2193' + formatBytes(data.peer.total_rx || 0) +
        '  \u2191' + formatBytes(data.peer.total_tx || 0);
      renderTrafficChart(data.data);
    } catch (err) {
      D.alert({ message: DT('common.error') + ': ' + err.message, danger: true });
    }
  }

  // Peer traffic as a bar chart (same .chart/.col/.bar markup as the dashboard).
  function renderTrafficBars(container, dataPoints) {
    if (!dataPoints || dataPoints.length === 0) {
      var none = h('div', { class: 'empty-state', text: (GC.t && GC.t['dashboard.chart_no_data']) || 'No traffic data' });
      none.style.cssText = 'padding:30px 0;text-align:center;color:var(--faint);font-size:13px';
      container.replaceChildren(none);
      return;
    }
    var maxVal = Math.max(1, Math.max.apply(null, dataPoints.map(function(d) { return Math.max(d.upload || 0, d.download || 0); })));
    var n = dataPoints.length;
    container.replaceChildren.apply(container, dataPoints.map(function(d, i) {
      var dn = h('div', { class: 'bar' });
      dn.style.height = Math.max(2, Math.round(((d.download || 0) / maxVal) * 130)) + 'px';
      var up = h('div', { class: 'bar up' });
      up.style.height = Math.max(2, Math.round(((d.upload || 0) / maxVal) * 130)) + 'px';
      var label = (n <= 12 || i % Math.ceil(n / 8) === 0) ? (d.label || '') : '';
      return h('div', { class: 'col' }, [dn, up, h('div', { class: 'lab', text: label })]);
    }));
  }

  function renderTrafficChart(dataPoints) {
    var svg = document.getElementById('traffic-peer-chart');
    if (!svg) return;
    renderTrafficBars(svg, dataPoints);
  }

  document.addEventListener('click', function(e) {
    var tab = e.target.closest('#modal-peer-traffic .tab[data-period]');
    if (!tab) return;
    document.getElementById('modal-peer-traffic').querySelectorAll('.tab[data-period]').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    trafficPeriod = tab.dataset.period;
    loadTrafficChart();
  });

  // ─── Start ───────────────────────────────────────────────
  readHash();
  try {
    var qParam = new URLSearchParams(window.location.search).get('q');
    if (qParam) searchInput.value = qParam.slice(0, 100);
  } catch (e) { /* ignore */ }
  loadGroups();
  loadPeers();
  populateOwnerSelects(['add-peer-owner', 'edit-peer-owner']);
  setInterval(loadPeers, 15000);
  setInterval(loadGroups, 30000);
  // the address changes without a reload (links, back/forward, a pasted #edit/<id>)
  window.addEventListener('hashchange', function () {
    if (/^#edit\//.test(window.location.hash || '')) { deepLinkHandled = false; openDeepLink(); return; }
    F.status = 'all'; F.group = ''; F.device = ''; F.owner = ''; F.tags = []; F.hints = []; F.sort = 'status';
    searchInput.value = '';
    readHash();
    render();
  });
  document.addEventListener('gc:peer', function () { loadPeers(); });
  document.addEventListener('gc:reconnected', function () { loadPeers(); });

  // ─── Access windows (scheduled access control) ───────────────────────────
  // A Pro-gated subsection in the peer-edit modal: a state badge, a rule list
  // and an add-rule form, driven by /api/v1/peers/:id/access-rules. Safe-DOM
  // only (el()/textContent — never innerHTML); CSRF via the X-CSRF-Token header.

  function accessT(key, fallback) {
    return (typeof GC !== 'undefined' && GC.t && GC.t[key]) || fallback;
  }

  function accessEl(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k === 'style') node.setAttribute('style', props[k]);
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function accessFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    if (opts.method && opts.method !== 'GET') {
      opts.headers['X-CSRF-Token'] = window.GC.csrfToken;
    }
    return fetch(url, opts);
  }

  function accessFmtBounds(rule) {
    var parts = [];
    if (rule.valid_from) parts.push(accessT('access.valid_from', 'Valid from') + ': ' + rule.valid_from);
    if (rule.valid_until) parts.push(accessT('access.valid_until', 'Valid until') + ': ' + rule.valid_until);
    return parts.join(' · ');
  }

  function renderAccessRuleRow(targetId, rule) {
    var isBlock = rule.mode === 'block';
    var chip = accessEl('span', {
      style: 'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;'
        + (isBlock
          ? 'background:rgba(229,72,77,0.15);color:var(--red,#e5484d)'
          : 'background:rgba(48,164,108,0.15);color:var(--green,#30a46c)'),
      text: isBlock ? accessT('access.mode_block', 'Block') : accessT('access.mode_allow', 'Allow'),
    });

    var lines = [accessEl('div', { style: 'font-size:12px;font-family:var(--font-mono);color:var(--text-1)', text: rule.schedule || '' })];
    var bounds = accessFmtBounds(rule);
    if (bounds) lines.push(accessEl('div', { style: 'font-size:11px;color:var(--text-2)', text: bounds }));
    if (rule.label) lines.push(accessEl('div', { style: 'font-size:11px;color:var(--text-2)', text: rule.label }));

    var info = accessEl('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px' }, lines);

    var delBtn = accessEl('button', {
      type: 'button',
      class: 'btn btn-sm',
      text: accessT('access.delete', 'Delete rule'),
    });
    delBtn.addEventListener('click', function () {
      deleteAccessRule(targetId, rule.id);
    });

    return accessEl('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)',
    }, [chip, info, delBtn]);
  }

  function renderAccessStateBadge(state) {
    var badge = document.getElementById('access-state-badge');
    if (!badge) return;
    badge.textContent = '';
    if (state === 'denied') {
      badge.appendChild(document.createTextNode('🔴 ' + accessT('access.state_blocked', 'Blocked now')));
      badge.style.color = 'var(--red,#e5484d)';
    } else {
      badge.appendChild(document.createTextNode('🟢 ' + accessT('access.state_allowed', 'Allowed now')));
      badge.style.color = 'var(--green,#30a46c)';
    }
  }

  async function loadAccessRules(targetId) {
    var list = document.getElementById('access-rules-list');
    if (!list) return;
    list.textContent = '';
    var badge = document.getElementById('access-state-badge');
    if (badge) badge.textContent = '';
    try {
      var res = await accessFetch('/api/v1/peers/' + targetId + '/access-rules');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      renderAccessStateBadge(data && data.state);
      var rules = (data && data.rules) || [];
      if (!rules.length) {
        list.appendChild(accessEl('div', { class: 'form-hint', text: accessT('access.title', 'Access windows') + ' —' }));
      } else {
        rules.forEach(function (rule) {
          list.appendChild(renderAccessRuleRow(targetId, rule));
        });
      }
      renderAccessAddForm(targetId);
    } catch (err) {
      list.appendChild(accessEl('div', { class: 'form-hint', text: err.message }));
    }
  }

  function renderAccessAddForm(targetId) {
    var formWrap = document.getElementById('access-rules-form');
    if (!formWrap) return;
    formWrap.textContent = '';

    var modeSelect = accessEl('select', { class: 'form-select', style: 'flex:0 0 110px' }, [
      accessEl('option', { value: 'allow', text: accessT('access.mode_allow', 'Allow') }),
      accessEl('option', { value: 'block', text: accessT('access.mode_block', 'Block') }),
    ]);

    var scheduleInput = accessEl('input', {
      type: 'text',
      class: 'form-input',
      placeholder: 'Mo-Fr 09:00-17:00',
      style: 'flex:1;font-family:var(--font-mono)',
    });

    var fromInput = accessEl('input', { type: 'date', class: 'form-input', style: 'flex:1' });
    var untilInput = accessEl('input', { type: 'date', class: 'form-input', style: 'flex:1' });

    var labelInput = accessEl('input', {
      type: 'text',
      class: 'form-input',
      maxlength: '120',
      placeholder: accessT('access.label', 'Label'),
      style: 'flex:1',
    });

    var errBox = accessEl('div', { class: 'form-error', style: 'display:none;font-size:12px' });

    var submitBtn = accessEl('button', { type: 'button', class: 'btn btn-primary btn-sm', text: accessT('access.add_rule', 'Add rule') });
    submitBtn.addEventListener('click', function () {
      addAccessRule(targetId, {
        mode: modeSelect.value,
        schedule: scheduleInput.value.trim(),
        valid_from: fromInput.value || undefined,
        valid_until: untilInput.value || undefined,
        label: labelInput.value.trim() || undefined,
      }, errBox);
    });

    formWrap.appendChild(accessEl('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' }, [
      accessEl('div', { style: 'display:flex;gap:8px;align-items:center' }, [modeSelect, scheduleInput]),
      accessEl('div', { style: 'display:flex;gap:8px;align-items:center' }, [
        accessEl('label', { style: 'flex:1;font-size:11px;color:var(--text-2);display:flex;flex-direction:column;gap:2px' }, [
          accessT('access.valid_from', 'Valid from'), fromInput,
        ]),
        accessEl('label', { style: 'flex:1;font-size:11px;color:var(--text-2);display:flex;flex-direction:column;gap:2px' }, [
          accessT('access.valid_until', 'Valid until'), untilInput,
        ]),
      ]),
      labelInput,
      errBox,
      accessEl('div', {}, [submitBtn]),
    ]));
  }

  async function addAccessRule(targetId, body, errBox) {
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    var payload = { mode: body.mode, schedule: body.schedule };
    if (body.valid_from) payload.valid_from = body.valid_from;
    if (body.valid_until) payload.valid_until = body.valid_until;
    if (body.label) payload.label = body.label;
    try {
      var res = await accessFetch('/api/v1/peers/' + targetId + '/access-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        await loadAccessRules(targetId);
        return;
      }
      var errData = await res.json().catch(function () { return {}; });
      var msg = (errData && errData.error) || ('HTTP ' + res.status);
      if (errBox) { errBox.textContent = msg; errBox.style.display = ''; }
    } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.style.display = ''; }
    }
  }

  async function deleteAccessRule(targetId, ruleId) {
    try {
      var res = await accessFetch('/api/v1/peers/' + targetId + '/access-rules/' + ruleId, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadAccessRules(targetId);
    } catch (err) {
      showError('edit-peer-error', err.message);
    }
  }
})();
