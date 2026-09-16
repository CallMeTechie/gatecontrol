'use strict';

// Quick search / command palette (docs/feature-release-b.md §8).
// Ctrl+K / ⌘K anywhere, "/" outside text fields, or the search button in the
// topbar (touch). Searches the pages of the sidebar (read from the DOM, so it
// stays in sync with licences and new items), the settings sections, hosts
// and entries (GET /api/v1/zones), peers and gateways — the data is loaded on
// the first opening. Arrow keys + Enter, Esc; recently used items live in
// localStorage (every access wrapped in try/catch). DOM only via
// createElement/textContent (innerHTML is blocked by a hook).
//
// The pure core (scoring, grouping, item builders) is exported for node:test
// (tests/nav_palette.test.js); in the browser it mounts itself.
(function (root, factory) {
  const core = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else {
    root.GCPalette = core;
    if (root.document) core.mount(root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const RECENT_KEY = 'gc_palette_recent_v1';
  const RECENT_MAX = 8;
  const PEER_Q_KEY = 'gc_palette_peer_q';
  const DATA_TTL_MS = 120000;
  const GROUP_LIMIT = { recent: 5, pages: 8, actions: 3, settings: 6, hosts: 8, entries: 6, peers: 6, gateways: 5 };
  const GROUP_ORDER = ['recent', 'pages', 'actions', 'settings', 'hosts', 'entries', 'peers', 'gateways'];
  const KIND_GROUP = { page: 'pages', action: 'actions', setting: 'settings', host: 'hosts', entry: 'entries', peer: 'peers', gateway: 'gateways' };
  const KIND_BOOST = { page: 6, setting: 3, action: 2, host: 4, gateway: 2, peer: 1, entry: 0 };

  // Settings sections (tabs of settings.njk, data-settings-tab). `pihole`
  // only when the sidebar shows Pi-hole (same licence flag).
  const SETTINGS = [
    { tab: 'general', key: 'settings.tab_general' },
    { tab: 'security', key: 'settings.tab_security' },
    { tab: 'backup', key: 'settings.tab_backup' },
    { tab: 'email', key: 'settings.tab_email' },
    { tab: 'monitoring', key: 'settings.tab_monitoring' },
    { tab: 'advanced', key: 'settings.tab_advanced' },
    { tab: 'license', key: 'settings.tab_license' },
    { tab: 'split-tunnel', key: 'settings.tab_split_tunnel' },
    { tab: 'pihole', key: 'settings.tab_pihole', needsPath: '/pihole' },
    { tab: 'portal', key: 'settings.portal.title' },
  ];

  // ── Pure helpers ──────────────────────────────────────────────────────
  function str(v) { return v == null ? '' : String(v); }

  // lower case, without diacritics (ä → a, é → e), ß → ss
  function norm(s) {
    let v = str(s).toLowerCase().replace(/ß/g, 'ss');
    try { v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* old engines */ }
    return v;
  }

  function tokens(q) { return norm(q).trim().split(/\s+/).filter(Boolean); }

  function prep(item) {
    item._l = norm(item.label);
    item._s = norm(item.sub);
    item._k = norm([].concat(item.keywords || []).join(' '));
    return item;
  }

  // -1 = no match. Every token must occur in label, keywords or sub line;
  // label hits weigh most (exact > prefix > word start > inside). ownOnly
  // items (entries) need at least one token in their own label/keywords, so
  // a host name alone does not list all of its entries.
  function scoreItem(item, toks) {
    if (!item._l && item.label) prep(item);
    if (!toks.length) return 0;
    let score = 0;
    let own = false;
    for (const tk of toks) {
      let s = -1;
      const L = item._l || '';
      if (L === tk) s = 60;
      else if (L.startsWith(tk)) s = 40;
      else {
        const i = L.indexOf(tk);
        if (i > 0) s = /[\s.\-_/:·(→]/.test(L[i - 1]) ? 28 : 18;
      }
      if (s >= 0) own = true;
      else if ((item._k || '').indexOf(tk) !== -1) { s = 10; own = true; }
      else if ((item._s || '').indexOf(tk) !== -1) s = 6;
      if (s < 0) return -1;
      score += s;
    }
    if (item.ownOnly && !own) return -1;
    return score + (KIND_BOOST[item.kind] || 0) - Math.min((item._l || '').length, 60) / 30;
  }

  // → [{ group, items: [{ item, score }] }], groups ordered by their best hit
  // (empty query: fixed order), items by score, each group capped.
  function search(items, query, opts) {
    const o = opts || {};
    const toks = tokens(query);
    const byGroup = {};
    (items || []).forEach((item, idx) => {
      if (!toks.length && !item.showEmpty) return;
      const sc = scoreItem(item, toks);
      if (sc < 0) return;
      const g = item.group || KIND_GROUP[item.kind] || 'pages';
      (byGroup[g] = byGroup[g] || []).push({ item, score: sc, idx });
    });
    if (!toks.length && o.recent && o.recent.length) {
      byGroup.recent = o.recent.slice(0, GROUP_LIMIT.recent).map((item, idx) => ({ item, score: 0, idx }));
    }
    const groups = Object.keys(byGroup).map((g) => {
      const list = byGroup[g].sort((a, b) => (b.score - a.score) || (a.idx - b.idx)).slice(0, GROUP_LIMIT[g] || 6);
      return { group: g, items: list, best: list.length ? list[0].score : -1 };
    }).filter((g) => g.items.length);
    groups.sort((a, b) => (toks.length && b.best !== a.best ? b.best - a.best : GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)));
    return groups;
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = str(el.type).toLowerCase();
      return ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].indexOf(type) === -1;
    }
    return !!el.isContentEditable;
  }

  // 'toggle' for Ctrl/⌘+K (also in text fields), 'open' for "/" outside
  // text fields without modifiers, else null.
  function shortcutOf(e) {
    if (!e || e.defaultPrevented || e.isComposing) return null;
    const k = str(e.key);
    if ((k === 'k' || k === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) return 'toggle';
    if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) return 'open';
    return null;
  }

  // Recent list: newest first, unique by key, only serialisable fields.
  function pushRecent(list, item, max) {
    const keep = { key: item.key, kind: item.kind, label: str(item.label), sub: str(item.sub), href: item.href || null };
    const out = [keep].concat((Array.isArray(list) ? list : []).filter((x) => x && x.key && x.key !== item.key));
    return out.slice(0, max || RECENT_MAX);
  }

  // Entry name (docs/feature-next-package.md S3 §3): the label wins over the
  // port/target text, which then becomes the sub-line.
  function entryName(e) {
    const s = e && e.label != null ? String(e.label).trim() : '';
    return s || null;
  }

  function entryText(e) {
    if (e.route_type === 'l4') {
      const out = str(e.l4_listen_port);
      const tgt = str(e.target_kind === 'gateway' ? (e.target_lan_port || e.target_port) : e.target_port) || out;
      return (e.l4_protocol === 'udp' ? 'UDP ' : 'TCP ') + out + ' → ' + tgt;
    }
    const tgt = str(e.target_kind === 'gateway' ? (e.target_lan_port || e.target_port) : e.target_port);
    return (e.https_enabled ? 'HTTPS 443' : 'HTTP 80') + (tgt ? ' → ' + tgt : '');
  }

  // Hosts + entries from GET /api/v1/zones. t(key) translates.
  function hostItems(data, t) {
    const tr = t || ((k) => k);
    const out = [];
    const zones = (data && data.zones) || [];
    const addHost = (h, z) => {
      const fqdn = h.fqdn || h.name || '';
      const domainId = z ? z.domain_id : null;
      const target = h.lan_host || (h.target && (h.target.ip || h.target.name)) || '';
      const ports = [];
      const names = [];
      (h.entries || []).forEach((e) => {
        ports.push(str(e.l4_listen_port), str(e.target_lan_port || e.target_port));
        const n = entryName(e);
        if (n) names.push(n);
      });
      out.push({
        key: 'host:' + h.id, kind: 'host', label: fqdn, sub: [target, h.description, z ? null : tr('palette.unassigned')].filter(Boolean).join(' · '),
        keywords: [h.name, h.subdomain, h.description, target].concat(names).concat(ports).filter(Boolean),
        domainId, hostId: h.id, hostName: fqdn,
      });
      (h.entries || []).forEach((e) => {
        if (e.rdp_owned) return;
        const name = entryName(e);
        out.push({
          key: 'entry:' + e.id, kind: 'entry', ownOnly: true, label: name || entryText(e),
          sub: [name ? entryText(e) : null, fqdn, e.description && e.description !== h.description ? e.description : null].filter(Boolean).join(' · '),
          keywords: [name, name ? entryText(e) : null, e.description && e.description !== h.description ? e.description : null, e.l4_listen_port, e.target_lan_port, e.target_port, e.target_lan_host, e.route_type === 'l4' ? e.l4_protocol : 'http https'].filter((x) => x != null && x !== ''),
          domainId, hostId: h.id, hostName: fqdn,
        });
      });
    };
    zones.forEach((z) => (z.hosts || []).forEach((h) => addHost(h, z)));
    ((data && data.unassigned) || []).forEach((h) => addHost(h, null));
    return out;
  }

  function peerItems(res) {
    return (((res && res.peers) || [])).filter((p) => p && p.peer_type !== 'gateway').map((p) => ({
      key: 'peer:' + p.id, kind: 'peer', label: str(p.name),
      sub: [p.allowed_ips ? str(p.allowed_ips).split('/')[0] : null, p.description].filter(Boolean).join(' · '),
      keywords: [p.description, p.tags, p.owner_name, p.allowed_ips].filter(Boolean),
      peerName: str(p.name),
    }));
  }

  // status → 'gateways.<status>' when translated (online/offline/degraded/pending), else left out.
  function gatewayItems(res, t) {
    const status = (s) => { const k = 'gateways.' + str(s); const v = t ? t(k) : k; return v && v !== k ? v : null; };
    return (((res && res.gateways) || [])).map((g) => ({
      key: 'gateway:' + g.peer_id, kind: 'gateway', label: str(g.name || g.hostname || ('#' + g.peer_id)),
      sub: [g.ip, g.hostname && g.hostname !== g.name ? g.hostname : null, status(g.status)].filter(Boolean).join(' · '),
      keywords: [g.hostname, g.ip].filter(Boolean),
      href: '/gateways#gw/' + encodeURIComponent(String(g.peer_id)),
    }));
  }

  // ── Browser part ──────────────────────────────────────────────────────
  function mount(win) {
    const doc = win.document;
    const GC = win.GC || {};
    const t = (key, params) => {
      let s = (GC.t && GC.t[key]) || key;
      if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
      return s;
    };
    const SVGNS = 'http://www.w3.org/2000/svg';
    const ICONS = {
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-4.2-4.2'],
      host: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
      entry: ['M5 12h14', 'm13 6 6 6-6 6'],
      peer: ['M7 7a3 3 0 1 0 0 .01', 'M17 17a3 3 0 1 0 0 .01', 'M14 10l-4 4'],
      gateway: ['M4 4h16v6H4z', 'M4 14h16v6H4z'],
      setting: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1'],
      action: ['M13 2 4 14h7l-1 8 9-12h-7z'],
      recent: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
      page: ['M5 3h10l4 4v14H5z', 'M15 3v4h4'],
    };
    function svgIcon(name) {
      const svg = doc.createElementNS(SVGNS, 'svg');
      [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
        .forEach((a) => svg.setAttribute(a[0], a[1]));
      (ICONS[name] || ICONS.page).forEach((d) => { const p = doc.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
      return svg;
    }
    function el(tag, props, children) {
      const n = doc.createElement(tag);
      Object.keys(props || {}).forEach((k) => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'type' || k === 'value' || k === 'placeholder' || k === 'id') n[k] = v;
        else n.setAttribute(k, v === true ? '' : v);
      });
      (children || []).forEach((c) => { if (c != null) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
      return n;
    }
    function lsGet(k) { try { return win.localStorage.getItem(k); } catch (_) { return null; } }
    function lsSet(k, v) { try { win.localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
    function readRecent() { try { const v = JSON.parse(lsGet(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }

    const isMac = /Mac|iPhone|iPad/.test(str(win.navigator && (win.navigator.platform || win.navigator.userAgent)));
    const kbd = doc.getElementById('cp-kbd');
    if (kbd && isMac) kbd.textContent = '⌘K';

    // ── Static items ──
    function pageItems() {
      const out = [];
      const nav = doc.getElementById('sidebar');
      let group = '';
      if (nav) {
        Array.from(nav.children).forEach((n) => {
          if (n.classList.contains('nav-section-label')) { group = n.textContent.trim(); return; }
          if (!n.matches || !n.matches('a.nav-item[href]')) return;
          const clone = n.cloneNode(true);
          clone.querySelectorAll('.nav-badge').forEach((b) => b.remove());
          const label = clone.textContent.replace(/\s+/g, ' ').trim();
          const svg = n.querySelector('svg');
          out.push({ key: 'page:' + n.getAttribute('href'), kind: 'page', label, sub: group, href: n.getAttribute('href'), showEmpty: true, iconNode: svg ? svg.cloneNode(true) : null });
        });
      }
      doc.querySelectorAll('#topbar-dropdown a.topbar-dropdown-item[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (out.some((p) => p.href === href)) return;
        out.push({ key: 'page:' + href, kind: 'page', label: a.textContent.trim(), sub: '', href, showEmpty: true });
      });
      return out;
    }
    function settingItems(pages) {
      const hasPath = (p) => pages.some((x) => x.href === p);
      return SETTINGS.filter((s) => !s.needsPath || hasPath(s.needsPath)).map((s) => ({
        key: 'setting:' + s.tab, kind: 'setting', label: t(s.key), sub: t('nav.settings'), keywords: [s.tab], tab: s.tab, href: '/settings#' + s.tab,
      }));
    }
    function actionItems() {
      return [
        { key: 'action:add-domain', kind: 'action', label: t('palette.action_add_domain'), sub: t('palette.group_actions'), href: '/routes?action=add', showEmpty: true,
          run: () => { const b = doc.getElementById('zn-add-domain'); if (b && win.location.pathname === '/routes') b.click(); else win.location.href = '/routes?action=add'; } },
        { key: 'action:add-peer', kind: 'action', label: t('palette.action_add_peer'), sub: t('palette.group_actions'), href: '/peers?action=add', showEmpty: true,
          run: () => { const b = doc.getElementById('btn-add-peer'); if (b && win.location.pathname === '/peers') b.click(); else win.location.href = '/peers?action=add'; } },
        { key: 'action:theme', kind: 'action', label: t('palette.action_theme'), sub: t('palette.group_actions'), keywords: ['dark', 'light', 'hell', 'dunkel', 'theme'],
          run: () => { const b = doc.getElementById('theme-btn'); if (b) b.click(); } },
      ];
    }

    // ── Remote data (first opening, refreshed after DATA_TTL_MS) ──
    // Each source renders as soon as it answers; a failed one only adds a
    // note in the status line.
    const data = { items: [], loadedAt: 0, loading: null, failed: false };
    function loadData(onPart) {
      if (data.loading) return data.loading;
      if (data.loadedAt && Date.now() - data.loadedAt < DATA_TTL_MS) return Promise.resolve();
      const api = win.api;
      if (!api) return Promise.resolve();
      const zp = win.GCZonesPage && win.GCZonesPage.getData && win.GCZonesPage.getData();
      const parts = { hosts: [], peers: [], gateways: [] };
      let failed = false;
      const merge = () => { data.items = parts.hosts.concat(parts.peers, parts.gateways); if (onPart) onPart(); };
      const job = (p, key, fn) => Promise.resolve(p).then((res) => { parts[key] = fn(res).map(prep); merge(); }, () => { failed = true; });
      data.loading = Promise.all([
        job(zp || api.get('/api/v1/zones'), 'hosts', (res) => hostItems(res, t)),
        job(api.get('/api/v1/peers'), 'peers', peerItems),
        job(api.get('/api/v1/gateways'), 'gateways', (res) => gatewayItems(res, t)),
      ]).then(() => {
        data.failed = failed;
        data.loadedAt = Date.now();
        data.loading = null;
        if (onPart) onPart();
      });
      return data.loading;
    }

    // ── DOM ──
    let ui = null;
    let open = false;
    let results = [];     // flat list of { item } in display order
    let active = -1;
    let keepActive = false;   // true: a new query resets the highlight to the first hit
    let prevFocus = null;
    let staticItems = [];

    function build() {
      const input = el('input', {
        type: 'text', id: 'cp-input', class: 'cp-input', placeholder: t('palette.placeholder'), autocomplete: 'off', spellcheck: 'false',
        role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 'cp-list', 'aria-labelledby': 'cp-title', enterkeyhint: 'go',
      });
      const closeBtn = el('button', { type: 'button', class: 'cp-close', 'aria-label': t('common.close') }, [el('kbd', { text: 'Esc' })]);
      const list = el('div', { id: 'cp-list', class: 'cp-list', role: 'listbox', 'aria-labelledby': 'cp-title' });
      const status = el('div', { class: 'cp-status', role: 'status', 'aria-live': 'polite' });
      const foot = el('div', { class: 'cp-foot', text: t('palette.hint') });
      const dlg = el('div', { class: 'cp-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-title' }, [
        el('h2', { id: 'cp-title', class: 'cp-sr', text: t('palette.title') }),
        el('div', { class: 'cp-inputrow' }, [svgIcon('search'), input, closeBtn]),
        list, status, foot,
      ]);
      const overlay = el('div', { class: 'cp-overlay', id: 'cp-overlay' }, [dlg]);
      overlay.hidden = true;
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { e.preventDefault(); close(); } });
      closeBtn.addEventListener('click', () => close());
      input.addEventListener('input', () => { active = 0; keepActive = true; render(); });
      list.addEventListener('mousedown', (e) => { if (e.target.closest('[role="option"]')) e.preventDefault(); });
      list.addEventListener('click', (e) => {
        const o = e.target.closest('[role="option"]');
        if (o) activate(Number(o.dataset.idx));
      });
      list.addEventListener('mousemove', (e) => {
        const o = e.target.closest('[role="option"]');
        if (o && Number(o.dataset.idx) !== active) setActive(Number(o.dataset.idx), false);
      });
      doc.body.appendChild(overlay);
      ui = { overlay, dlg, input, list, status, closeBtn };
    }

    function highlight(label, toks) {
      const nodes = [];
      const L = norm(label);
      if (L.length !== label.length || !toks.length) return [label];
      const marks = [];
      toks.forEach((tk) => { const i = L.indexOf(tk); if (i !== -1) marks.push([i, i + tk.length]); });
      marks.sort((a, b) => a[0] - b[0]);
      let pos = 0;
      marks.forEach(([a, b]) => {
        if (a < pos) return;
        if (a > pos) nodes.push(label.slice(pos, a));
        nodes.push(el('mark', { text: label.slice(a, b) }));
        pos = b;
      });
      if (pos < label.length) nodes.push(label.slice(pos));
      return nodes;
    }

    function render() {
      const q = ui.input.value;
      const toks = tokens(q);
      const items = staticItems.concat(data.items);
      const groups = search(items, q, { recent: readRecent().map((r) => resolveRecent(r, items)).filter(Boolean) });
      const keepKey = results[active] ? results[active].key : null;   // stay on the same item when data arrives
      results = [];
      const frag = [];
      groups.forEach((g, gi) => {
        const hid = 'cp-g-' + gi;
        const rows = g.items.map(({ item }) => {
          const idx = results.length;
          results.push(item);
          const icon = item.iconNode ? item.iconNode.cloneNode(true) : svgIcon(g.group === 'recent' ? 'recent' : item.kind);
          return el('div', { id: 'cp-opt-' + idx, class: 'cp-opt', role: 'option', 'aria-selected': 'false', 'data-idx': String(idx), 'data-kind': item.kind, 'data-key': item.key }, [
            el('span', { class: 'cp-ic' }, [icon]),
            el('span', { class: 'cp-txt' }, [
              el('span', { class: 'cp-label' }, highlight(str(item.label), toks)),
              item.sub ? el('span', { class: 'cp-sub', text: item.sub }) : null,
            ]),
            el('span', { class: 'cp-enter', 'aria-hidden': 'true', text: '↵' }),
          ]);
        });
        frag.push(el('div', { class: 'cp-group', role: 'group', 'aria-labelledby': hid }, [
          el('div', { class: 'cp-group-label', id: hid, role: 'presentation', text: t('palette.group_' + g.group) }),
        ].concat(rows)));
      });
      ui.list.replaceChildren(...frag);
      if (!results.length && toks.length && !data.loading) ui.list.appendChild(el('div', { class: 'cp-empty', text: t('palette.empty', { q: q.trim() }) }));
      let msg = '';
      if (data.loading) msg = t('palette.loading');
      else if (toks.length) msg = t('palette.results', { count: results.length });
      if (data.failed && !data.loading) msg = (msg ? msg + ' · ' : '') + t('palette.load_failed');
      ui.status.textContent = msg;
      if (keepKey && !keepActive) {
        const i = results.findIndex((r) => r.key === keepKey);
        if (i !== -1) active = i;
      }
      keepActive = false;
      if (active >= results.length) active = results.length - 1;
      if (active < 0 && results.length) active = 0;
      setActive(active, true);
    }

    function setActive(i, scroll) {
      active = i;
      ui.list.querySelectorAll('[role="option"][aria-selected="true"]').forEach((o) => o.setAttribute('aria-selected', 'false'));
      const o = i >= 0 ? doc.getElementById('cp-opt-' + i) : null;
      if (o) {
        o.setAttribute('aria-selected', 'true');
        ui.input.setAttribute('aria-activedescendant', o.id);
        if (scroll && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
      } else ui.input.removeAttribute('aria-activedescendant');
    }

    // A recent entry → the live item with the same key (so a host still
    // opens its dialog), else a plain link.
    function resolveRecent(r, items) {
      if (!r || !r.key) return null;
      const live = items.find((x) => x.key === r.key);
      if (live) return Object.assign({}, live, { showEmpty: true });
      if (!r.href) return null;
      return prep({ key: r.key, kind: r.kind || 'page', label: r.label, sub: r.sub, href: r.href });
    }

    function remember(item) {
      const href = item.href || hrefOf(item);
      lsSet(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), Object.assign({}, item, { href }))));
    }

    function hrefOf(item) {
      if (item.kind === 'host' || item.kind === 'entry') {
        if (item.domainId != null) return '/routes?domain=' + item.domainId + '&host=' + item.hostId;
        return '/routes#q=' + encodeURIComponent(item.hostName || '');
      }
      if (item.kind === 'peer') return '/peers';
      return item.href || null;
    }

    function activate(i) {
      const item = results[i];
      if (!item) return;
      remember(item);
      close(true);
      const here = win.location.pathname;
      if (item.run) { item.run(); return; }
      if (item.kind === 'setting') {
        lsSet('settings-active-tab', item.tab);
        const tab = here === '/settings' ? doc.querySelector('.settings-tabs > .tab[data-settings-tab="' + item.tab + '"]') : null;
        if (tab) tab.click(); else win.location.href = item.href;
        return;
      }
      if (item.kind === 'host' || item.kind === 'entry') {
        if (here === '/routes' && win.GCZonesPage && item.domainId != null) { win.GCZonesPage.openDomain(item.domainId, item.hostId); return; }
        if (here === '/routes' && item.domainId == null) { win.location.hash = 'q=' + encodeURIComponent(item.hostName || ''); return; }
        win.location.href = hrefOf(item);
        return;
      }
      if (item.kind === 'peer') {
        try { win.sessionStorage.setItem(PEER_Q_KEY, item.peerName || item.label); } catch (_) { /* ignore */ }
        if (here === '/peers') prefillPeerSearch(); else win.location.href = '/peers';
        return;
      }
      if (item.href) {
        if (item.href.split('#')[0] === here && item.href.indexOf('#') !== -1) win.location.hash = item.href.split('#')[1];
        else win.location.href = item.href;
      }
    }

    function openPalette() {
      if (open) return;
      if (!ui) build();
      staticItems = pageItems();
      staticItems = staticItems.concat(settingItems(staticItems), actionItems()).map(prep);
      prevFocus = doc.activeElement;
      open = true;
      ui.overlay.hidden = false;
      doc.documentElement.classList.add('cp-is-open');
      ui.input.value = '';
      active = 0;
      render();
      ui.input.focus();
      loadData(() => { if (open) render(); });
    }

    function close(skipFocus) {
      if (!open) return;
      open = false;
      ui.overlay.hidden = true;
      doc.documentElement.classList.remove('cp-is-open');
      if (!skipFocus && prevFocus && prevFocus.focus && doc.contains(prevFocus)) prevFocus.focus();
      prevFocus = null;
    }

    // Window capture phase: runs before app.js (global Escape closes every
    // .modal-overlay; Tab trap of open modals) and before the zones dialogs'
    // document-capture key handlers, so nothing underneath reacts while the
    // palette is open.
    win.addEventListener('keydown', (e) => {
      if (!open) {
        const s = shortcutOf(e);
        if (!s) return;
        e.preventDefault();
        openPalette();
        return;
      }
      const k = e.key;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (shortcutOf(e) === 'toggle' || k === 'Escape') { stop(); close(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        stop();
        if (!results.length) return;
        const n = results.length;
        setActive(k === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n, true);
        return;
      }
      if ((k === 'PageDown' || k === 'PageUp') && results.length) {
        stop();
        setActive(k === 'PageDown' ? Math.min(results.length - 1, active + 5) : Math.max(0, active - 5), true);
        return;
      }
      if (k === 'Enter') { stop(); if (!e.isComposing) activate(active); return; }
      if (k === 'Tab') {
        stop();   // focus trap: input ↔ close button
        (doc.activeElement === ui.input ? ui.closeBtn : ui.input).focus();
      }
    }, true);

    const trigger = doc.getElementById('cp-open');
    if (trigger) trigger.addEventListener('click', () => openPalette());

    // ── Navigation glue (§8): bottom-nav "Mehr" opens the grouped sidebar ──
    const more = doc.getElementById('bn-more');
    if (more) {
      more.addEventListener('click', () => {
        const tgl = doc.getElementById('sidebar-toggle');
        if (tgl) tgl.click();
      });
    }

    // Peer chosen in the palette on another page → prefill the peers search.
    function prefillPeerSearch() {
      let q = null;
      try { q = win.sessionStorage.getItem(PEER_Q_KEY); win.sessionStorage.removeItem(PEER_Q_KEY); } catch (_) { /* ignore */ }
      const input = doc.getElementById('peer-search');
      if (!q || !input) return;
      input.value = q;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    if (win.location.pathname === '/peers') {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', prefillPeerSearch);
      else win.setTimeout(prefillPeerSearch, 0);
    }

    win.GCPalette.open = openPalette;
    win.GCPalette.close = () => close();
  }

  return {
    RECENT_KEY, RECENT_MAX, SETTINGS, norm, tokens, prep, scoreItem, search, isTypingTarget, shortcutOf, pushRecent,
    entryText, hostItems, peerItems, gatewayItems, mount,
  };
});
