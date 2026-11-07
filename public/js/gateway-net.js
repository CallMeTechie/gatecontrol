'use strict';

// Gateway detail › tabs "Funktionen", "Netzwerk" and "Internet" and the card
// "Funktionen" in the tab "Übersicht" (phase 3a: network watch, internet
// quality, presence over the home network, UPS; the switches of every
// function of the gateway). gateway-edge.js builds the tab bar and hands the
// three tabs to this module; gateways.js asks it for the overview card. Data:
// the admin API /api/v1/gateways/:id/{features,netwatch,inetq} (session +
// CSRF, routes/api/gatewayNet.js).
//
//   window.GCGatewayNet.mount(box, g, tab, ctx)  → fills `box` with the tab 'features' | 'net' | 'inet'
//   window.GCGatewayNet.summaryCard(g)           → the card "Funktionen" for the overview (fills itself)
//   window.GCGatewayNet.badge(node, id, tab)     → the badge of a tab ("7 an", "2 neu", "Ausfall")
//   window.GCGatewayNet.tabOff(id, tab)          → the tab's function is switched off
//   window.GCGatewayNet.fresh(id)                → new devices of the network watch (null: unknown / off)
//   window.GCGatewayNet.prefetch(g) / unmount()
//
// After new data of a gateway it fires `gc:gwnet` ({ detail: { id } }) so the
// overview's card "Zustand" can count the new devices.
//
// Pure rules (risky ports, list filter, chart geometry, UPS states) live in
// gateway-net-kit.js. Dialogs are window.GCDialog frames; nothing here uses
// innerHTML — every node is built with GCDialog.el / textContent.
(function () {
  const E = window.GCGatewayEdge;
  const K = window.GCGatewayNetKit;
  const PK = window.GCGatewayPoolKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !K || !D || !PK) return;
  const U = E.ui;
  const h = D.el;
  const t = U.t;
  const LANG = U.LANG;
  const LOCALE = LANG === 'en' ? 'en-GB' : 'de-DE';
  const API = '/api/v1/gateways/';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GW_RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';

  function url(id, rest) { return API + encodeURIComponent(String(id)) + (rest || ''); }
  function has(key) { const s = t(key); return s !== key; }
  function errText(e) {
    const code = e && e.code;
    if (code && has('gwn.err.' + code)) return t('gwn.err.' + code);
    if (e && e.status === 403) return t('gwn.err.forbidden');
    return U.errText(e);
  }
  function svg(tag, attrs, kids) {
    const n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => { if (attrs[k] != null) n.setAttribute(k, String(attrs[k])); });
    (kids || []).forEach((c) => { if (c) n.appendChild(c); });
    return n;
  }
  function icon(name, size) {
    const extra = {
      edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'm13.5 6.5 4 4' }]],
      scan: [['path', { d: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3' }], ['path', { d: 'M7 12h10' }]],
      speed: [['path', { d: 'M12 14 16 9' }], ['path', { d: 'M4.5 18a9 9 0 1 1 15 0' }]],
      battery: [['rect', { x: 3, y: 7, width: 16, height: 10, rx: 2 }], ['path', { d: 'M21 11v2' }], ['path', { d: 'M6 10v4M9 10v4' }]],
      net: [['rect', { x: 9, y: 3, width: 6, height: 5, rx: 1 }], ['rect', { x: 3, y: 16, width: 6, height: 5, rx: 1 }], ['rect', { x: 15, y: 16, width: 6, height: 5, rx: 1 }], ['path', { d: 'M12 8v4M6 16v-2h12v2' }]],
      globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }]],
    };
    if (!extra[name]) return U.icon(name, size);
    const s = svg('svg', { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    extra[name].forEach((p) => s.appendChild(svg(p[0], p[1])));
    return s;
  }

  // ─── Times ────────────────────────────────────────────────────────────
  function ms(iso) { const v = Date.parse(iso); return Number.isFinite(v) ? v : null; }
  function ago(iso) {
    const v = ms(iso);
    if (v == null) return '—';
    const s = Math.max(0, Math.round((Date.now() - v) / 1000));
    if (s < 60) return t('gwn.ago.now');
    if (s < 3600) return t('gwn.ago.min', { n: Math.round(s / 60) });
    if (s < 86400) return t('gwn.ago.h', { n: Math.round(s / 3600) });
    return t('gwn.ago.d', { n: Math.round(s / 86400) });
  }
  function when(iso) {
    const v = ms(iso);
    if (v == null) return '—';
    const d = new Date(v);
    const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    const yest = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return t('gwn.time.today', { time });
    if (d.toDateString() === yest.toDateString()) return t('gwn.time.yesterday', { time });
    if (today - d < 6 * 86400000) return d.toLocaleDateString(LOCALE, { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + time;
  }
  function clock(iso) { const v = ms(iso); return v == null ? '—' : new Date(v).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }); }
  function nf(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString(LOCALE, { maximumFractionDigits: digits == null ? 0 : digits });
  }

  // ─── Data cache ───────────────────────────────────────────────────────
  const cache = { net: {}, inet: {}, feat: {} };
  const view = { q: '', filter: 'all', range: '24h', scroll: 0 };
  let cur = null; // { box, g, tab, ctx }

  function kindOf(tab) { return tab === 'features' ? 'feat' : tab; }
  function entry(kind, id) {
    const k = String(id);
    if (!cache[kind][k]) cache[kind][k] = { data: null, err: null, at: 0, inflight: null, key: null };
    return cache[kind][k];
  }
  function pathOf(kind) {
    if (kind === 'net') return '/netwatch';
    if (kind === 'inet') return '/inetq?range=' + encodeURIComponent(view.range);
    return '/features';
  }
  function load(kind, id, force) {
    const e = entry(kind, id);
    const key = pathOf(kind);
    if (e.inflight && e.key === key) return e.inflight;
    if (!force && e.data && e.key === key && Date.now() - e.at < 8000) return Promise.resolve(e.data);
    e.key = key;
    const p = U.api('GET', url(id, key)).then((j) => {
      if (e.key !== key) return e.data; // a newer request (other range) wins
      e.data = kind === 'feat' ? j.gateway : j; e.err = null; e.at = Date.now(); e.inflight = null;
      announce(id);
      return e.data;
    }, (err) => { if (e.key === key) { e.err = err; e.inflight = null; } throw err; });
    e.inflight = p;
    return p;
  }

  function redraw() {
    if (!cur || !cur.box.isConnected) return;
    const fk = cur.box.contains(document.activeElement) ? U.focusKey() : null;
    draw();
    U.restoreFocus(cur.box, fk);
  }
  function reload(kind, id) {
    return load(kind, id, true).then(() => { redraw(); updateBadges(id); refreshFeatures(id); }, () => redraw());
  }
  function announce(id) {
    try { document.dispatchEvent(new CustomEvent('gc:gwnet', { detail: { id: String(id) } })); } catch (e) { /* old browser */ }
  }
  function updateBadges(id) { if (E.fillBadges) E.fillBadges(document, id); }

  function draw() {
    const e = entry(kindOf(cur.tab), cur.g.peer_id);
    const nodes = [];
    if (!e.data) {
      if (e.err) nodes.push(errorPanel(e.err, kindOf(cur.tab)));
      else nodes.push(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    } else if (cur.tab === 'features') nodes.push(...featuresPanel(cur.g, e.data));
    else if (cur.tab === 'net') nodes.push(...netPanel(cur.g, e.data));
    else nodes.push(...inetPanel(cur.g, e.data));
    if (e.data && e.err) nodes.unshift(U.note('warn', [errText(e.err)]));
    cur.box.replaceChildren(...nodes);
  }

  function errorPanel(err, kind) {
    const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.retry'), 'data-fk': 'retry', on: { click: () => reload(kind, cur.g.peer_id) } });
    return h('div', { class: 'gw gwe-card' }, h('div', { class: 'body gwe-body' }, [U.note('crit', [h('strong', { text: t('gwe.load_failed') }), ' ', errText(err)]), h('div', null, retry)]));
  }

  function tooOld(sup) {
    return U.bigNote('warn', 'up', t('gwn.old.title', { min: sup.minGateway }), t('gwn.old.text', { version: sup.version || '—' }),
      [h('a', { class: 'btn btn-ghost', href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwe.old.whats_new') })]);
  }

  // ─── Settings (shared by the tabs and the card) ───────────────────────
  function putFeatures(id, patch, okMsg) {
    return U.api('PUT', url(id, '/features'), patch).then((j) => {
      const e = entry('feat', id);
      e.data = j.gateway; e.at = Date.now(); e.err = null;
      // the tabs carry the switches as well: load them again when they are shown
      entry('net', id).at = 0;
      entry('inet', id).at = 0;
      if (okMsg) U.toast(okMsg);
      refreshFeatures(id);
      if (cur && String(cur.g.peer_id) === String(id) && cur.tab !== 'features') reload(cur.tab, id);
      return j.gateway;
    });
  }
  function toggle(btn, id, patch, okMsg) {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    return putFeatures(id, patch(next), okMsg ? okMsg(next) : null).catch((e) => {
      btn.disabled = false;
      btn.setAttribute('aria-checked', next ? 'false' : 'true');
      D.alert({ message: errText(e), danger: true });
    });
  }
  function enableBtn(id, patch, label, fk) {
    const b = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': fk }, [U.icon('power', 16), label]);
    b.addEventListener('click', () => { b.disabled = true; putFeatures(id, patch, t('gwn.feat.saved')).catch((e) => { b.disabled = false; D.alert({ message: errText(e), danger: true }); }); });
    return b;
  }

  // ─── Tab "Netzwerk" ───────────────────────────────────────────────────
  function netPanel(g, d) {
    const sup = d.gateway.support || {};
    const f = d.gateway.features || {};
    if (!f.netwatch || !f.netwatch.enabled) {
      return [U.bigNote('grey', 'power', t('gwn.net.off_title'), t('gwn.net.off_text'),
        [enableBtn(g.peer_id, { netwatch: { enabled: true } }, t('gwn.net.enable'), 'gwn-net-on')])];
    }
    const out = [];
    if (sup.netwatch === false) out.push(tooOld(sup));
    out.push(kpiRow(d));
    const fresh = K.sortDevices((d.devices || []).filter((x) => x.status === 'new'));
    // the new devices from the full list (the shown list may be filtered)
    if (fresh.length) out.push(newCard(g, d, fresh));
    out.push(listCard(g, d));
    return out;
  }

  function kpi(label, value, sub, tone) {
    return h('div', { class: 'gwn-kpi' + (tone ? ' gwn-kpi-' + tone : '') }, [
      h('span', { class: 'gwn-kpi-l', text: label }),
      h('span', { class: 'gwn-kpi-v' }, [value, sub ? h('span', { class: 'gwn-kpi-s', text: sub }) : null]),
    ]);
  }
  function kpiRow(d) {
    const k = d.kpis || {};
    return h('div', { class: 'gwn-kpis', role: 'group', 'aria-label': t('gwn.kpi.label') }, [
      kpi(t('gwn.kpi.devices'), String(k.total || 0), t('gwn.kpi.online', { n: k.online || 0 })),
      kpi(t('gwn.kpi.new'), String(k.fresh || 0), null, k.fresh ? 'amber' : null),
      kpi(t('gwn.kpi.ports'), String(k.risky || 0), null, k.risky ? 'red' : null),
      kpi(t('gwn.kpi.scan'), d.lastScanAt ? ago(d.lastScanAt) : t('gwn.kpi.scan_none'), null, 'small'),
    ]);
  }

  function devTitle(x) {
    const n = K.displayName(x);
    if (n && x.name) return n;
    if (n) return t('gwn.dev.quoted', { name: n });
    return t('gwn.dev.unknown');
  }
  function addrLine(x) {
    return [x.ip || '—', x.randomMac ? t('gwn.dev.random_mac') : x.mac].join(' · ');
  }
  function portsText(x) {
    if (!Array.isArray(x.ports)) return t('gwn.dev.ports_unknown');
    if (!x.ports.length) return t('gwn.dev.ports_none');
    return x.ports.map((p) => p.port).join(', ');
  }

  // "Auch gesehen von Pi Garage" — the other gateways of the home network that see the device too
  function alsoSeen(x) {
    const list = Array.isArray(x.alsoSeenBy) ? x.alsoSeenBy : [];
    return list.length ? t('gwn.home.also_seen', { gateways: list.map((o) => o.name).join(', ') }) : null;
  }
  function homeNames(d) {
    const list = (d.home && d.home.gateways) || [];
    return list.length ? list.map((o) => o.name).join(', ') : null;
  }

  function newCard(g, d, list) {
    const c = U.card(t('gwn.new.title'), h('span', { class: 'gwe-sum', text: t('gwn.new.hint') }), { id: 'new', full: true, cls: 'gwn-newcard' });
    list.forEach((x) => {
      const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'look:' + x.id, 'aria-label': t('gwn.new.look_at', { name: devTitle(x) }), text: t('gwn.new.look') });
      b.addEventListener('click', () => deviceDialog(g, x, 'new', d));
      c.body.appendChild(h('div', { class: 'gwn-newrow', 'data-device': x.mac }, [
        h('div', { class: 'gwn-newrow-t' }, [
          h('strong', { text: devTitle(x) + (x.vendor ? ' · ' + x.vendor : '') }),
          h('span', { class: 'gwe-d' }, [h('span', { class: 'gwe-mono', text: addrLine(x) }), ' · ' + t('gwn.new.first_seen', { when: when(x.firstSeen) }) + ' · ' + t('gwn.new.ports', { ports: portsText(x) })
            + (alsoSeen(x) ? ' · ' + alsoSeen(x) : '')]),
        ]),
        b,
      ]));
    });
    return c.card;
  }

  function ownerCell(x) {
    if (x.ownerUserId == null) return h('td', { class: 'gwe-muted', text: '—' });
    return h('td', null, [x.ownerName || ('#' + x.ownerUserId), x.presence ? h('span', { class: 'gwe-muted', text: ' · ' + t('gwn.dev.presence_short') }) : null]);
  }
  function portChips(x) {
    if (!Array.isArray(x.ports)) return h('td', { class: 'gwe-muted', text: t('gwn.dev.ports_unknown') });
    if (!x.ports.length) return h('td', { class: 'gwe-muted', text: t('gwn.dev.ports_none') });
    const risky = new Set((x.risks || []).map((r) => r.port));
    return h('td', null, h('div', { class: 'gwn-ports' }, x.ports.map((p) => h('span', {
      class: 'gwn-port' + (risky.has(p.port) ? ' gwn-port-risk' : ''),
      title: risky.has(p.port) ? t('gwn.dev.port_risky') : null,
      text: p.port + (p.service ? ' ' + p.service : ''),
    }))));
  }

  function label(td, key) {
    td.setAttribute('data-label', t(key));
    const v = h('div', { class: 'gwn-td-v' });
    while (td.firstChild) v.appendChild(td.firstChild);
    td.appendChild(v);
    return td;
  }

  function listCard(g, d) {
    const search = h('input', { type: 'search', id: 'gwn-q', class: 'form-input gwn-search', 'data-fk': 'gwn-q', placeholder: t('gwn.list.search_ph'), value: view.q, autocomplete: 'off', spellcheck: 'false' });
    const filter = h('select', { id: 'gwn-filter', class: 'form-select gwn-filter', 'data-fk': 'gwn-filter' },
      K.FILTERS.map((f) => h('option', { value: f, text: t('gwn.filter.' + f) })));
    filter.value = view.filter;
    const scanB = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-scan' }, [icon('scan', 15), t('gwn.list.scan')]);
    scanB.addEventListener('click', () => scanNow(g, scanB));
    const head = h('div', { class: 'gwn-listhead' }, [
      h('label', { class: 'sr-only', for: 'gwn-q', text: t('gwn.list.search') }), search,
      h('label', { class: 'sr-only', for: 'gwn-filter', text: t('gwn.list.filter') }), filter,
      scanB,
    ]);
    const c = U.card(t('gwn.list.title'), null, { id: 'list', full: true, cls: 'gwn-listcard' });
    c.top.appendChild(head);
    const status = h('p', { class: 'gwe-d gwn-count', role: 'status' });
    const tableBox = h('div', { class: 'gwe-table-wrap gwn-scroll', tabIndex: 0, role: 'region', 'aria-label': t('gwn.list.title') });
    const risksBox = h('div', { class: 'gwn-risks' });
    // gateways of one home network (failover pool, same LAN): one device, one decision
    if (homeNames(d)) c.body.append(h('div', { 'data-fk': 'gwn-home' }, U.note('info', [h('strong', { text: t('gwn.home.title') }), ' ', t('gwn.home.text', { gateways: homeNames(d) })])));
    c.body.append(status, tableBox, risksBox);
    function fill() {
      const shown = K.sortDevices(K.filterDevices(d.devices, view.q, view.filter));
      status.textContent = d.total ? t('gwn.list.count', { n: shown.length, total: d.total }) : '';
      if (!d.total) {
        tableBox.replaceChildren(h('p', { class: 'gwe-empty gwn-pad', text: t('gwn.list.empty') }));
      } else if (!shown.length) {
        tableBox.replaceChildren(h('p', { class: 'gwe-empty gwn-pad', text: t('gwn.list.none') }));
      } else {
        const thead = h('thead', null, h('tr', null, [
          h('th', { scope: 'col', text: t('gwn.col.device') }), h('th', { scope: 'col', text: t('gwn.col.address') }),
          h('th', { scope: 'col', text: t('gwn.col.owner') }), h('th', { scope: 'col', text: t('gwn.col.ports') }),
          h('th', { scope: 'col', text: t('gwn.col.last') }), h('th', { scope: 'col' }, h('span', { class: 'sr-only', text: t('gwn.col.actions') })),
        ]));
        const tbody = h('tbody', null, shown.map((x) => {
          const edit = h('button', { type: 'button', class: 'icon-action', 'data-fk': 'edit:' + x.id, 'aria-label': t('gwn.dev.edit_of', { name: devTitle(x) }), title: t('gwn.dev.edit') }, icon('edit', 15));
          edit.addEventListener('click', () => deviceDialog(g, x, x.status === 'new' ? 'new' : 'edit', d));
          const sub = [x.vendor, x.status === 'watch' ? t('gwn.status.watch') : null, alsoSeen(x)].filter(Boolean).join(' · ');
          // data-label: the column name, shown in front of the value when the table becomes cards (narrow screens)
          return h('tr', { 'data-device': x.mac, 'data-status': x.status }, [
            h('td', { class: 'gwn-td-dev' }, [h('strong', { text: devTitle(x) }), x.status === 'new' ? h('span', { class: 'tag tag-amber gwn-newtag', text: t('gwn.status.new') }) : null,
              sub ? h('div', { class: 'gwe-d', text: sub }) : null]),
            label(h('td', { class: 'gwe-mono' }, [x.ip || '—', h('br'), h('span', { title: x.randomMac ? x.mac : null, text: x.randomMac ? t('gwn.dev.random_mac') : x.mac })]), 'gwn.col.address'),
            label(ownerCell(x), 'gwn.col.owner'),
            label(portChips(x), 'gwn.col.ports'),
            label(h('td', null, x.online ? U.tag('green', t('gwn.dev.online'), true) : h('span', { class: 'gwe-muted', text: ago(x.lastSeen) })), 'gwn.col.last'),
            h('td', { class: 'gwe-actions-cell gwn-td-act' }, edit),
          ]);
        }));
        tableBox.replaceChildren(h('table', { class: 'gwe-table gwn-table' }, [thead, tbody]));
      }
      // risky open ports of the shown devices: what it means and what to do
      const notes = [];
      shown.forEach((x) => (x.risks || []).forEach((r) => notes.push({ x, r })));
      risksBox.replaceChildren(...notes.slice(0, 6).map((n) => U.note('crit', [
        h('strong', { text: t('gwn.risk.title', { device: devTitle(n.x), what: t('gwn.risk.' + n.r.key + '.name'), port: n.r.port }) }), ' ',
        t('gwn.risk.' + n.r.key + '.text'),
      ], 'warn')), ...(notes.length > 6 ? [h('p', { class: 'gwe-d', text: t('gwn.risk.more', { n: notes.length - 6 }) })] : []));
    }
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { view.q = search.value; fill(); }, 150); });
    filter.addEventListener('change', () => { view.filter = filter.value; fill(); });
    tableBox.addEventListener('scroll', () => { view.scroll = tableBox.scrollTop; }, { passive: true });
    fill();
    requestAnimationFrame(() => { if (tableBox.isConnected && view.scroll) tableBox.scrollTop = view.scroll; });
    return c.card;
  }

  function scanNow(g, btn) {
    btn.disabled = true;
    U.api('POST', url(g.peer_id, '/netwatch/scan'), {}).then((j) => {
      U.toast(t(j.busy ? 'gwn.list.scan_busy' : 'gwn.list.scan_started'));
      setTimeout(() => { if (cur && cur.tab === 'net') reload('net', g.peer_id); }, 20000);
    }).catch((e) => D.alert({ message: errText(e), danger: true })).finally(() => { setTimeout(() => { btn.disabled = false; }, 3000); });
  }

  // ─── Dialog: new device / edit device ─────────────────────────────────
  let people = null;
  function loadPeople() {
    if (people) return Promise.resolve(people);
    return U.api('GET', '/api/v1/principals').then((j) => { people = (j.users || []).map((u) => ({ id: u.id, label: u.label })); return people; });
  }

  function vendorHint(v) {
    const s = String(v || '').toLowerCase();
    if (/espressif/.test(s)) return t('gwn.vendor.espressif');
    if (/raspberry/.test(s)) return t('gwn.vendor.raspberry');
    if (/tuya|shenzhen/.test(s)) return t('gwn.vendor.tuya');
    return null;
  }

  function deviceDialog(g, x, mode, d) {
    const isNew = mode === 'new';
    const dlg = U.openDialog({ title: t(isNew ? 'gwn.dlg.new_title' : 'gwn.dlg.edit_title', { name: devTitle(x) }), wide: true, cls: 'gwn-dlg' });
    const hint = vendorHint(x.vendor);
    const kv = (k, v, mono) => [h('dt', { text: k }), h('dd', { class: mono ? 'gwe-mono' : null, text: v })];
    const facts = h('dl', { class: 'gwn-facts' }, [
      ...kv(t('gwn.dlg.vendor'), x.vendor ? x.vendor + (hint ? ' (' + hint + ')' : '') : t('gwn.dlg.vendor_unknown')),
      ...kv(t('gwn.dlg.address'), [x.ip || '—', x.mac].join(' · ') + (x.randomMac ? ' · ' + t('gwn.dev.random_mac') : ''), true),
      ...kv(t('gwn.dlg.hostname'), x.hostname || '—', !!x.hostname),
      ...kv(t('gwn.dlg.first_seen'), t('gwn.dlg.first_seen_v', { when: when(x.firstSeen), gateway: g.name })),
      ...kv(t('gwn.dlg.ports'), Array.isArray(x.ports) ? (x.ports.length ? x.ports.map((p) => p.port + (p.service ? ' ' + p.service : '')).join(', ') : t('gwn.dev.ports_none')) : t('gwn.dev.ports_unknown')),
      ...(Array.isArray(x.alsoSeenBy) && x.alsoSeenBy.length ? kv(t('gwn.dlg.also_seen'), x.alsoSeenBy.map((o) => o.name).join(', ')) : []),
    ]);
    const name = h('input', { type: 'text', id: 'gwn-d-name', class: 'form-input', maxLength: 80, autocomplete: 'off', value: x.name || '', placeholder: x.hostname || x.vendor || '' });
    const owner = h('select', { id: 'gwn-d-owner', class: 'form-select' }, [h('option', { value: '', text: t('gwn.dlg.owner_none') })]);
    if (x.ownerUserId != null) owner.appendChild(h('option', { value: String(x.ownerUserId), text: x.ownerName || ('#' + x.ownerUserId) }));
    owner.value = x.ownerUserId != null ? String(x.ownerUserId) : '';
    const counts = h('input', { type: 'checkbox', id: 'gwn-d-presence' });
    counts.checked = !!x.presence;
    const countsLabel = h('label', { class: 'gwe-check gwn-check', for: 'gwn-d-presence' }, [counts, h('span', null, [
      h('strong', { text: t('gwn.dlg.presence') }), h('br'), h('span', { class: 'gwe-d', id: 'gwn-d-presence-d' }),
    ])]);
    const presenceD = countsLabel.querySelector('#gwn-d-presence-d');
    const status = h('select', { id: 'gwn-d-status', class: 'form-select' }, ['known', 'watch'].map((s) => h('option', { value: s, text: t('gwn.status.' + s) })));
    status.value = x.status === 'watch' ? 'watch' : 'known';
    const err = U.errorBox();
    const field = (id, label, control) => h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: id, text: label }), control]);
    const fields = h('div', { class: 'gwe-grid2 gwe-grid2-tight' }, [field('gwn-d-name', t('gwn.dlg.name'), name), field('gwn-d-owner', t('gwn.dlg.owner'), owner)]);
    dlg.body.append(facts, fields);
    if (!isNew) dlg.body.append(field('gwn-d-status', t('gwn.dlg.status'), status));
    dlg.body.append(h('p', { class: 'gwe-d', text: t('gwn.dlg.owner_hint') }));
    // what is decided here holds on every gateway of the home network
    if (homeNames(d || {})) dlg.body.append(h('p', { class: 'gwe-d', 'data-fk': 'gwn-d-home', text: t('gwn.dlg.home_hint', { gateways: homeNames(d) }) }));
    if (!isNew) dlg.body.append(countsLabel);
    dlg.body.append(U.note('info', [t('gwn.dlg.unknown_hint')]), err);
    function syncPresence() {
      const hasOwner = owner.value !== '';
      counts.disabled = !hasOwner;
      if (!hasOwner) counts.checked = false;
      const sel = hasOwner && x.ownerUserId != null && String(x.ownerUserId) === owner.value;
      presenceD.textContent = !hasOwner ? t('gwn.dlg.presence_needs_owner')
        : (sel && x.ownerConsent ? t('gwn.dlg.presence_consent_on', { name: owner.options[owner.selectedIndex].text }) : t('gwn.dlg.presence_consent_off'));
    }
    owner.addEventListener('change', syncPresence);
    syncPresence();
    loadPeople().then((list) => {
      const keep = owner.value;
      owner.replaceChildren(h('option', { value: '', text: t('gwn.dlg.owner_none') }), ...list.map((p) => h('option', { value: String(p.id), text: p.label })));
      owner.value = keep;
      if (owner.value !== keep) owner.value = '';
      syncPresence();
    }, () => { /* the select keeps what it has */ });

    function body(extra) {
      const b = { name: name.value.trim() || null, ownerUserId: owner.value ? Number(owner.value) : null };
      return Object.assign(b, extra || {});
    }
    function save(extra, okKey, btn) {
      btn.disabled = true;
      U.showErr(err, '');
      return U.api('PUT', url(g.peer_id, '/netwatch/devices/' + encodeURIComponent(x.id)), body(extra))
        .then(() => { dlg.close(true); U.toast(t(okKey, { name: name.value.trim() || K.displayName(x) || x.vendor || t('gwn.dev.unknown') })); reload('net', g.peer_id); })
        .catch((e) => { btn.disabled = false; U.showErr(err, errText(e)); });
    }
    if (isNew) {
      const later = h('button', { type: 'button', class: 'btn btn-ghost', text: t('gwn.dlg.later'), on: { click: () => dlg.close(null) } });
      const watch = h('button', { type: 'button', class: 'btn btn-ghost', text: t('gwn.dlg.watch') });
      const mine = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwn.dlg.mine') });
      watch.addEventListener('click', () => save({ status: 'watch' }, 'gwn.dlg.watch_done', watch));
      mine.addEventListener('click', () => save({ status: 'known' }, 'gwn.dlg.mine_done', mine));
      dlg.foot.classList.add('gwn-foot-split');
      dlg.foot.append(later, h('div', { class: 'gwn-foot-r' }, [watch, mine]));
    } else {
      const forget = h('button', { type: 'button', class: 'btn btn-ghost gwn-forget', text: t('gwn.dlg.forget') });
      forget.addEventListener('click', async () => {
        const ok = await D.confirm({ title: t('gwn.dlg.forget_title', { name: devTitle(x) }), message: t('gwn.dlg.forget_msg'), okLabel: t('gwn.dlg.forget'), danger: true });
        if (!ok) return;
        U.api('DELETE', url(g.peer_id, '/netwatch/devices/' + encodeURIComponent(x.id)))
          .then(() => { dlg.close(true); U.toast(t('gwn.dlg.forgotten')); reload('net', g.peer_id); })
          .catch((e) => U.showErr(err, errText(e)));
      });
      const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
      const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.save') });
      ok.addEventListener('click', () => save({ status: status.value, presence: !!counts.checked && owner.value !== '' }, 'gwn.dlg.saved', ok));
      dlg.foot.classList.add('gwn-foot-split');
      dlg.foot.append(forget, h('div', { class: 'gwn-foot-r' }, [cancel, ok]));
    }
    name.focus();
  }

  // ─── Tab "Internet" ───────────────────────────────────────────────────
  function inetPanel(g, d) {
    const sup = d.gateway.support || {};
    const f = d.gateway.features || {};
    if (!f.inetq || !f.inetq.enabled) {
      return [U.bigNote('grey', 'power', t('gwn.inet.off_title'), t('gwn.inet.off_text'),
        [enableBtn(g.peer_id, { inetq: { enabled: true } }, t('gwn.inet.enable'), 'gwn-inet-on')])];
    }
    const out = [];
    if (sup.inetq === false) out.push(tooOld(sup));
    out.push(h('div', { class: 'gwn-grid3' }, [nowCard(d), speedCard(g, d), upsCard(g, d)]));
    out.push(historyCard(g, d));
    out.push(h('div', { class: 'gwe-grid2 gwn-grid2-wide' }, [outagesCard(d), settingsCard(g, d)]));
    return out;
  }

  function big(label, value, unit) {
    return h('div', { class: 'gwn-big' }, [h('div', { class: 'gwn-kpi-l', text: label }),
      h('div', { class: 'gwn-big-v' }, [value, unit ? h('span', { class: 'gwn-unit', text: ' ' + unit }) : null])]);
  }

  function nowCard(d) {
    const n = d.now || {};
    const pill = n.state === 'outage' ? U.tag('red', t('gwn.now.outage'), true)
      : n.state === 'ok' ? U.tag('green', t('gwn.now.ok'), true)
        : U.tag('grey', t(n.state === 'stale' ? 'gwn.now.stale' : 'gwn.now.none'), true);
    const c = U.card(t('gwn.now.title'), pill, { id: 'now' });
    c.body.appendChild(h('div', { class: 'gwn-bigs gwn-bigs-3' }, [
      big(t('gwn.now.ping'), nf(n.rttInetMs), 'ms'), big(t('gwn.now.loss'), nf(n.lossInetPct, 1), '%'), big(t('gwn.now.router'), nf(n.rttRouterMs), 'ms'),
    ]));
    if (n.state === 'outage') c.body.appendChild(U.note('crit', [t('gwn.now.outage_since', { when: when(n.outageSince), cause: t('gwn.cause.' + (n.outageCause || 'unknown')) })], 'warn'));
    c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwn.now.text') + (n.at ? ' ' + t('gwn.now.last', { when: ago(n.at) }) : '') }));
    return c.card;
  }

  function speedLimitText(sl) {
    if (!sl) return null;
    if (sl.key === 'pi3bplus') return t('gwn.speed.limit_pi3bplus');
    if (sl.key === 'pi3') return t('gwn.speed.limit_pi3');
    if (sl.key === 'pi_zero') return t('gwn.speed.limit_pi_zero');
    return null;
  }

  function speedCard(g, d) {
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-speed' }, [icon('speed', 15), t('gwn.speed.now')]);
    if (d.speedPending) { btn.disabled = true; btn.textContent = t('gwn.speed.running'); }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      U.api('POST', url(g.peer_id, '/inetq/speedtest'), {}).then((j) => {
        U.toast(t(j.busy ? 'gwn.speed.busy' : 'gwn.speed.started'));
        btn.textContent = t('gwn.speed.running');
        setTimeout(() => { if (cur && cur.tab === 'inet') reload('inet', g.peer_id); }, 45000);
      }).catch((e) => { btn.disabled = false; D.alert({ message: errText(e), danger: true }); });
    });
    const c = U.card(t('gwn.speed.title'), btn, { id: 'speed' });
    const s = d.speed;
    c.body.appendChild(h('div', { class: 'gwn-bigs gwn-bigs-2' }, [
      big(t('gwn.speed.down'), s ? nf(s.downMbps) : '—', 'Mbit/s'), big(t('gwn.speed.up'), s ? nf(s.upMbps) : '—', 'Mbit/s'),
    ]));
    const parts = [];
    if (s) parts.push(when(s.at), t('gwn.speed.against'));
    else parts.push(t('gwn.speed.never'));
    if (s && s.bytes) parts.push(t('gwn.speed.used', { mb: nf(s.bytes / 1e6) }));
    const plan = d.gateway.features && d.gateway.features.inetq ? d.gateway.features.inetq.speedtest : '4x';
    parts.push(t('gwn.speed.plan_' + plan));
    c.body.appendChild(h('p', { class: 'gwe-d', text: parts.join(' · ') }));
    const lim = speedLimitText(d.gateway.speedLimit);
    if (lim) c.body.appendChild(U.note('info', [lim]));
    // the server's daily volume for speed tests is used up (contract server side 16)
    if (d.speedBudget && d.speedBudget.exhausted) {
      c.body.appendChild(U.note('warn', [t(d.speedBudget.resetAt ? 'gwn.speed.budget_until' : 'gwn.speed.budget', { when: when(d.speedBudget.resetAt), gb: nf(d.speedBudget.limitBytes / 1e9) })]));
    }
    return c.card;
  }

  function upsCard(g, d) {
    const f = d.gateway.features || {};
    const u = d.ups;
    if (!f.ups || !f.ups.enabled) {
      const set = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-ups-set', text: t('gwn.ups.set') });
      set.addEventListener('click', () => upsDialog(g.peer_id, f.ups || {}));
      const c = U.card(t('gwn.ups.title'), U.tag('grey', t('gwn.ups.off'), true), { id: 'ups' });
      c.body.append(h('p', { class: 'gwe-d', text: t('gwn.ups.off_text') }), h('div', null, set));
      return c.card;
    }
    let pill;
    if (!u) pill = U.tag('grey', t('gwn.ups.waiting'), true);
    else if (u.error) pill = U.tag('red', t('gwn.ups.error'), true);
    else pill = U.tag(u.state === 'online' ? 'green' : u.state === 'unknown' ? 'grey' : 'red', t('gwn.ups.state.' + u.state), true);
    const c = U.card(t('gwn.ups.title'), pill, { id: 'ups' });
    if (u && !u.error) {
      c.body.appendChild(h('div', { class: 'gwn-bigs gwn-bigs-2' }, [
        big(t('gwn.ups.charge'), nf(u.charge), '%'),
        big(t('gwn.ups.runtime'), u.runtimeSec != null ? nf(u.runtimeSec / 60) : '—', u.runtimeSec != null ? t('gwn.ups.min') : null),
      ]));
    } else if (u && u.error) c.body.appendChild(U.note('warn', [t('gwn.ups.error_text', { error: u.error })]));
    const where = (u && u.model ? u.model + ' · ' : '') + t('gwn.ups.via', { host: f.ups.host, port: f.ups.port });
    const edit = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-ups-edit', text: t('gwn.ups.change') });
    edit.addEventListener('click', () => upsDialog(g.peer_id, f.ups));
    c.body.append(h('p', { class: 'gwe-d', text: where }), h('div', null, edit));
    return c.card;
  }

  function upsDialog(id, ups) {
    const dlg = U.openDialog({ title: t('gwn.ups.dlg_title'), wide: false, cls: 'gwn-upsdlg' });
    const host = h('input', { type: 'text', id: 'gwn-u-host', class: 'form-input gwe-mono', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: ups.host || '', placeholder: '192.168.1.10', 'aria-describedby': 'gwn-u-host-hint' });
    const port = h('input', { type: 'number', id: 'gwn-u-port', class: 'form-input gwe-mono', min: '1', max: '65535', value: String(ups.port || 3493) });
    const name = h('input', { type: 'text', id: 'gwn-u-name', class: 'form-input gwe-mono', maxLength: 64, autocomplete: 'off', spellcheck: 'false', value: ups.name || '', 'aria-describedby': 'gwn-u-name-hint' });
    const err = U.errorBox();
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwn.ups.dlg_intro') }),
      h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwn-u-host', text: t('gwn.ups.host') }), host, h('span', { class: 'form-hint', id: 'gwn-u-host-hint', text: t('gwn.ups.host_hint') })]),
      h('div', { class: 'gwe-grid2 gwe-grid2-tight' }, [
        h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwn-u-port', text: t('gwn.ups.port') }), port]),
        h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwn-u-name', text: t('gwn.ups.name') }), name, h('span', { class: 'form-hint', id: 'gwn-u-name-hint', text: t('gwn.ups.name_hint') })]),
      ]),
      err);
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwn.ups.save') });
    dlg.foot.append(cancel, ok);
    ok.addEventListener('click', () => {
      const p = Number(port.value);
      if (!/^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host.value.trim())) { U.showErr(err, t('gwn.err.invalid_host')); host.setAttribute('aria-invalid', 'true'); host.focus(); return; }
      if (!Number.isInteger(p) || p < 1 || p > 65535) { U.showErr(err, t('gwn.ups.port_invalid')); port.focus(); return; }
      ok.disabled = true;
      putFeatures(id, { ups: { enabled: true, host: host.value.trim(), port: p, name: name.value.trim() || null } }, t('gwn.ups.saved'))
        .then(() => dlg.close(true))
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    host.focus();
  }

  // history chart with a text alternative (summary) and a table view
  function historyCard(g, d) {
    const seg = h('div', { class: 'gwe-seg', role: 'group', 'aria-label': t('gwn.hist.range') }, K.RANGES.map((r) => {
      const b = h('button', { type: 'button', class: 'gwe-seg-b', 'aria-pressed': r === view.range ? 'true' : 'false', 'data-fk': 'range:' + r, text: t('gwn.hist.r_' + r) });
      b.addEventListener('click', () => {
        if (view.range === r) return;
        view.range = r;
        reload('inet', g.peer_id);
      });
      return b;
    }));
    const asTable = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': view.table ? 'true' : 'false', 'data-fk': 'gwn-astable', text: t(view.table ? 'gwn.hist.as_chart' : 'gwn.hist.as_table') });
    asTable.addEventListener('click', () => { view.table = !view.table; redraw(); });
    const c = U.card(t('gwn.hist.title'), h('div', { class: 'gwn-histhead' }, [seg, asTable]), { id: 'hist', full: true });
    const from = ms(d.from);
    const to = ms(d.to);
    const outs = (d.outages || []).map((o) => ({ start: ms(o.start), end: o.end ? ms(o.end) : null }));
    const sum = K.summary(d.points);
    const nOut = outs.filter((o) => (o.end == null || o.end >= from)).length;
    const summary = sum
      ? t('gwn.hist.summary', { range: t('gwn.hist.r_' + view.range), avg: sum.avg, min: sum.min, max: sum.max, loss: sum.loss == null ? '—' : nf(sum.loss, 1) })
        + ' ' + t(nOut === 1 ? 'gwn.hist.outages_one' : 'gwn.hist.outages', { n: nOut })
      : t('gwn.hist.empty');
    if (!sum) {
      c.body.appendChild(h('p', { class: 'gwe-empty', text: summary }));
      return c.card;
    }
    if (view.table) {
      c.body.append(h('p', { class: 'gwe-d', text: summary }), tableOf(d.points));
      return c.card;
    }
    const geo = K.chartGeometry(d.points, outs, { from, to, range: view.range, width: 1000, height: 160 });
    const s = svg('svg', { viewBox: '0 0 1000 160', preserveAspectRatio: 'none', class: 'gwn-chart-svg', 'aria-hidden': 'true', focusable: 'false' }, [
      svg('line', { x1: 0, x2: 1000, y1: geo.baseY, y2: geo.baseY, class: 'gwn-grid', 'vector-effect': 'non-scaling-stroke' }),
      ...geo.ticks.map((tk) => svg('line', { x1: 0, x2: 1000, y1: tk.y, y2: tk.y, class: 'gwn-grid gwn-grid-dash', 'vector-effect': 'non-scaling-stroke' })),
      ...geo.bands.map((b) => svg('rect', { x: b.x, y: 0, width: b.w, height: 160, class: 'gwn-band' })),
      ...geo.lines.map((pts) => svg('polyline', { points: pts, class: 'gwn-line', fill: 'none', 'vector-effect': 'non-scaling-stroke' })),
    ]);
    const yAxis = h('div', { class: 'gwn-chart-y', 'aria-hidden': 'true' }, geo.ticks.map((tk) => {
      const n = h('span', { class: 'gwn-ytick', text: nf(tk.value) + ' ms' });
      n.style.top = (tk.y / 160 * 100) + '%';
      return n;
    }));
    const fmtX = (v) => (view.range === '24h' ? clock(new Date(v).toISOString()) : new Date(v).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }));
    const xAxis = h('div', { class: 'gwn-chart-x', 'aria-hidden': 'true' }, [
      h('span', { text: fmtX(from) }), h('span', { text: fmtX(from + (to - from) / 2) }), h('span', { text: t('gwn.hist.now') }),
    ]);
    c.body.append(
      h('div', { class: 'gwn-chart', role: 'img', 'aria-label': summary }, [yAxis, h('div', { class: 'gwn-chart-plot' }, [s, xAxis])]),
      h('div', { class: 'gwn-legend', 'aria-hidden': 'true' }, [
        h('span', null, [h('span', { class: 'gwn-key gwn-key-line' }), t('gwn.hist.key_ping')]),
        h('span', null, [h('span', { class: 'gwn-key gwn-key-band' }), t('gwn.hist.key_outage')]),
      ]),
      h('p', { class: 'gwe-d gwn-summary', text: summary }));
    return c.card;
  }

  /** Table view: one row per hour (24 h) or per day (7 / 30 days). */
  function tableOf(points) {
    const bucket = view.range === '24h' ? 3600e3 : 86400e3;
    const groups = new Map();
    (points || []).forEach((p) => {
      const tz = new Date(p.t).getTimezoneOffset() * 60000;
      const k = Math.floor((p.t - tz) / bucket) * bucket + tz;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    const rows = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([k, list]) => {
      const s = K.summary(list);
      const label = view.range === '24h' ? clock(new Date(k).toISOString()) : new Date(k).toLocaleDateString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' });
      return h('tr', null, [h('th', { scope: 'row', text: label }), h('td', { text: s ? s.avg + ' ms' : '—' }), h('td', { text: s ? s.max + ' ms' : '—' }),
        h('td', { text: s && s.loss != null ? nf(s.loss, 1) + ' %' : '—' })]);
    });
    return h('div', { class: 'gwe-table-wrap gwn-scroll', tabIndex: 0, role: 'region', 'aria-label': t('gwn.hist.table') },
      h('table', { class: 'gwe-table gwn-htable' }, [
        h('caption', { class: 'sr-only', text: t('gwn.hist.table') }),
        h('thead', null, h('tr', null, [h('th', { scope: 'col', text: t(view.range === '24h' ? 'gwn.hist.col_hour' : 'gwn.hist.col_day') }),
          h('th', { scope: 'col', text: t('gwn.hist.col_avg') }), h('th', { scope: 'col', text: t('gwn.hist.col_max') }), h('th', { scope: 'col', text: t('gwn.hist.col_loss') })])),
        h('tbody', null, rows),
      ]));
  }

  function outagesCard(d) {
    const list = d.outages || [];
    const c = U.card(t('gwn.out.title'), list.length ? h('span', { class: 'gwe-sum', text: t('gwn.out.count', { n: list.length }) }) : null, { id: 'out', cls: 'gwn-rows' });
    if (!list.length) { c.body.appendChild(h('p', { class: 'gwe-empty', text: t('gwn.out.none') })); return c.card; }
    list.slice(0, 12).forEach((o) => {
      const end = o.end ? clock(o.end) : t('gwn.out.ongoing');
      c.body.appendChild(h('div', { class: 'gwn-row' }, [
        h('span', { class: 'gwn-row-m' }, [h('strong', { text: when(o.start) + ' – ' + end }), o.minutes ? ' · ' + t('gwn.out.minutes', { n: o.minutes }) : '']),
        h('span', { class: 'gwe-d', text: t('gwn.cause.' + o.cause) }),
      ]));
    });
    return c.card;
  }

  function settingsCard(g, d) {
    const f = d.gateway.features;
    const c = U.card(t('gwn.set.title'), null, { id: 'set', cls: 'gwn-rows' });
    const plan = h('select', { id: 'gwn-plan', class: 'form-select gwn-plan', 'data-fk': 'gwn-plan', 'aria-describedby': f.inetq.speedtest === 'hourly' ? 'gwn-plan-hint' : null }, ['off', '4x', 'hourly'].map((p) => h('option', { value: p, text: t('gwn.set.plan_' + p) })));
    plan.value = f.inetq.speedtest;
    plan.addEventListener('change', () => {
      plan.disabled = true;
      putFeatures(g.peer_id, { inetq: { speedtest: plan.value } }, t('gwn.feat.saved')).catch((e) => { plan.disabled = false; plan.value = f.inetq.speedtest; D.alert({ message: errText(e), danger: true }); });
    });
    const swOut = U.switchBtn(!!f.notify.outage, t('gwn.set.notify_outage'), 'gwn-n-out', () => toggle(swOut, g.peer_id, (v) => ({ notify: { outage: v } })));
    const swUps = U.switchBtn(!!f.notify.ups, t('gwn.set.notify_ups'), 'gwn-n-ups', () => toggle(swUps, g.peer_id, (v) => ({ notify: { ups: v } })));
    c.body.append(
      h('div', { class: 'gwn-row' }, [h('label', { class: 'gwn-row-m', for: 'gwn-plan', text: t('gwn.set.plan') }), plan]),
      // every hour costs a lot of volume on a fast line: say so where it is chosen
      f.inetq.speedtest === 'hourly' ? h('div', { class: 'gwn-pad-b', id: 'gwn-plan-hint' }, U.note('warn', [t('gwn.set.plan_hourly_hint', { gb: nf((d.speedBudget ? d.speedBudget.limitBytes : 12e9) / 1e9) })])) : null,
      h('div', { class: 'gwn-row' }, [h('span', { class: 'gwn-row-m', text: t('gwn.set.notify_outage') }), swOut]),
      h('div', { class: 'gwn-row' }, [h('span', { class: 'gwn-row-m', text: t('gwn.set.notify_ups') }), swUps]),
      h('p', { class: 'gwe-d gwn-pad-t', text: t('gwn.set.note') }));
    return c.card;
  }

  // ─── Tab "Funktionen" and the card "Funktionen" of the overview ───────
  const summaryNodes = new Map(); // gateway id → { node, g } of the overview card in the page

  /** After new feature data: the overview card, the tab "Funktionen" (when shown) and the tab badges. */
  function refreshFeatures(id) {
    const f = summaryNodes.get(String(id));
    if (f && f.node.isConnected) {
      const fk = f.node.contains(document.activeElement) ? U.focusKey() : null;
      fillSummary(f.node, f.g);
      U.restoreFocus(f.node, fk);
    }
    if (cur && cur.tab === 'features' && String(cur.g.peer_id) === String(id)) redraw();
    updateBadges(id);
  }

  function hwLine(hw) {
    const parts = [];
    if (hw.model) parts.push(hw.model);
    if (hw.cores) parts.push(t('gwn.feat.cores', { n: hw.cores }));
    if (hw.memTotal) parts.push(t('gwn.feat.ram', { ram: K.ramLabel(hw.memTotal / 1048576) }));
    if (hw.storageFree) parts.push(t('gwn.feat.free', { gb: nf(hw.storageFree / 1e9) }));
    return parts.join(' · ');
  }

  function featRow(title, text, control, extra, key) {
    return h('div', { class: 'gwn-fr', 'data-feature': key }, [
      h('div', { class: 'gwn-fr-t' }, [h('strong', { text: title }), h('span', { class: 'gwe-d' }, [text, ' ', U.guide('feat.' + key)]), ...(extra || [])]),
      control || null,
    ]);
  }

  /** The row "Drucken & Scannen": switch, what this gateway found, the way to the plugin (or "Gateway zu alt"). */
  function printRow(id, d, g) {
    const p = d.print;
    const sup = d.support || {};
    const old = sup.print === false;
    const sw = U.switchBtn(!!p.enabled, t('gwn.feat.print'), 'gwn-f-print', () => toggle(sw, id, (v) => ({ print: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.print') })), old && !p.enabled);
    const extra = [];
    if (old) extra.push(h('span', { class: 'gwn-hint', 'data-print-old': '' }, [U.icon('info', 14), t('gwn.feat.print_old', { min: p.minGateway || sup.minGatewayPrint || '1.24.0', version: sup.version || '—' })]));
    if (p.enabled && !old) {
      const list = (p.devices || []).map((x) => x.name + ' (' + t(x.printer && x.scanner ? 'gwn.feat.print_both' : (x.printer ? 'gwn.feat.print_printer' : 'gwn.feat.print_scanner')) + ')');
      extra.push(h('span', { class: 'gwe-d', 'data-print-found': String(p.count || 0) }, list.length
        ? t('gwn.feat.print_found', { list: list.slice(0, 4).join(', ') + (list.length > 4 ? ' …' : '') })
        : t('gwn.feat.print_none')));
      if ((p.devices || []).some((x) => x.problem === 'cert_changed')) extra.push(h('span', { class: 'gwn-hint' }, [U.icon('warn', 14), t('gwn.feat.print_cert')]));
      // the last search (how many answers, what was dropped and why) — an older gateway reports none
      if (p.search) extra.push(h('span', { class: 'gwe-d', 'data-print-search': '' }, printSearchText(p.search)));
      else if (p.searchKnown) extra.push(h('span', { class: 'gwe-d', 'data-print-search': 'pending', text: t('gwn.feat.print_search_pending') }));
      else extra.push(h('span', { class: 'gwn-hint', 'data-print-nosearch': '' }, [U.icon('info', 14), t('gwn.feat.print_nosearch', { version: sup.version || '—' })]));
      const errs = (p.search && p.search.errors) || [];
      if (errs.length) extra.push(h('span', { class: 'gwn-hint', 'data-print-err': errs.join(' ') }, [U.icon('warn', 14), errs.map((e) => t('gwn.feat.print_err_' + e)).join(' ')]));
      const again = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-print-again', text: t('gwn.feat.print_again') });
      again.addEventListener('click', () => printDiscover(id, again));
      const add = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-print-manual', 'aria-haspopup': 'dialog',
        text: (p.manual || []).length ? t('gwn.feat.print_manual_list', { list: p.manual.join(', ') }) : t('gwn.feat.print_manual_add') });
      add.addEventListener('click', () => printManualDialog(id, p));
      extra.push(h('span', { class: 'gwn-print-acts' }, [again, add]));
      printConvert(id, p, sup).forEach((x) => extra.push(x));
      printExtras(id, g, p, sup).forEach((x) => extra.push(x));
    }
    const plug = p.plugin || {};
    if (plug.installed) extra.push(h('a', { href: '/plugins/gatecontrol-print', class: 'gwn-link', 'data-print-link': 'plugin', text: t('gwn.feat.print_to_plugin') }));
    else extra.push(h('a', { href: '/settings/plugins/catalog/gatecontrol-print', class: 'gwn-link', 'data-print-link': 'catalog', text: t('gwn.feat.print_install') }));
    return featRow(t('gwn.feat.print'), t('gwn.feat.print_d'), sw, extra, 'print');
  }

  /**
   * PDF for printers without PDF (features.print.convert, gateway docs/print.md "Umwandeln"): the checkbox (gateway
   * 1.30.0 or later), which printers take no PDF and whether this gateway converts for them, "Gateway zu alt",
   * a missing tool, a hint for a Raspberry Pi 3/Zero (never a ban).
   */
  function printConvert(id, p, sup) {
    const out = [];
    const noPdf = (p.devices || []).filter((x) => x.noPdf);
    const names = (list) => list.map((x) => x.name).slice(0, 3).join(', ') + (list.length > 3 ? ' …' : '');
    if (!p.convertSupported) {
      if (noPdf.length) out.push(h('span', { class: 'gwn-hint', 'data-print-convert': 'old' }, [U.icon('info', 14), t('gwn.feat.print_convert_old', { list: names(noPdf), min: p.minGatewayConvert || '1.30.0', version: sup.version || '—' })]));
      return out;
    }
    const box = h('input', { type: 'checkbox', id: 'gwn-f-pdfconv', 'data-fk': 'gwn-f-pdfconv' });
    box.checked = p.convert !== false;
    box.addEventListener('change', () => {
      box.disabled = true;
      putFeatures(id, { print: { convert: box.checked } }, t('gwn.feat.saved')).catch((err) => { box.checked = !box.checked; box.disabled = false; D.alert({ message: errText(err), danger: true }); });
    });
    out.push(h('label', { class: 'gwn-sub', for: 'gwn-f-pdfconv' }, [box, h('span', { text: t('gwn.feat.print_convert') })]));
    if (p.convert !== false && p.convertAvailable === false) out.push(h('span', { class: 'gwn-hint', 'data-print-convert': 'tool' }, [U.icon('warn', 14), t('gwn.feat.print_convert_tool')]));
    if (noPdf.length) {
      const done = noPdf.filter((x) => x.convert);
      const none = noPdf.filter((x) => !x.convert);
      if (p.convert === false) out.push(h('span', { class: 'gwn-hint', 'data-print-convert': 'off' }, [U.icon('info', 14), t('gwn.feat.print_convert_off', { list: names(noPdf) })]));
      else {
        if (done.length) out.push(h('span', { class: 'gwe-d', 'data-print-convert': 'on' }, t('gwn.feat.print_convert_on', { list: names(done) })));
        if (none.length && p.convertAvailable !== false) out.push(h('span', { class: 'gwn-hint', 'data-print-convert': 'none' }, [U.icon('info', 14), t('gwn.feat.print_convert_none', { list: names(none) })]));
      }
    }
    if (p.convert !== false && p.convertHint === 'slow') out.push(h('span', { class: 'gwn-hint', 'data-print-convert': 'slow' }, [U.icon('info', 14), t('gwn.feat.print_convert_slow')]));
    return out;
  }

  /** A checkbox under "Drucken & Scannen" (features.print.<key>) – saved at once, reset on an error. */
  function printBox(id, key, on, label) {
    const box = h('input', { type: 'checkbox', id: 'gwn-f-print-' + key, 'data-fk': 'gwn-f-print-' + key });
    box.checked = !!on;
    box.addEventListener('change', () => {
      box.disabled = true;
      putFeatures(id, { print: { [key]: box.checked } }, t('gwn.feat.saved')).catch((err) => { box.checked = !box.checked; box.disabled = false; D.alert({ message: errText(err), danger: true }); });
    });
    return h('label', { class: 'gwn-sub', for: 'gwn-f-print-' + key }, [box, h('span', { text: label })]);
  }

  /**
   * „Texterkennung“ (searchable PDFs of scans) and „Office-Dateien drucken“ (the service office with LibreOffice) –
   * gateway docs/print.md, gateway 1.32.0 or later: the checkboxes, a missing tool, the size of the office service,
   * the compose file it needs, hints for weak hardware (never a ban).
   */
  function printExtras(id, g, p, sup) {
    const out = [];
    if (!p.ocrSupported && !p.officeSupported) {
      if (p.ocrSupported === false) out.push(h('span', { class: 'gwn-hint', 'data-print-extras': 'old' }, [U.icon('info', 14), t('gwn.feat.print_extras_old', { min: p.minGatewayP3c || '1.32.0', version: sup.version || '—' })]));
      return out;
    }
    if (p.ocrSupported) {
      out.push(printBox(id, 'ocr', p.ocr, t('gwn.feat.print_ocr')));
      if (p.ocr && p.ocrAvailable === false) out.push(h('span', { class: 'gwn-hint', 'data-print-ocr': 'tool' }, [U.icon('warn', 14), t('gwn.feat.print_ocr_tool')]));
      else if (p.ocr && p.ocrHint === 'slow') out.push(h('span', { class: 'gwn-hint', 'data-print-ocr': 'slow' }, [U.icon('info', 14), t('gwn.feat.print_ocr_slow')]));
      else if (p.ocr) out.push(h('span', { class: 'gwe-d', 'data-print-ocr': 'on', text: t('gwn.feat.print_ocr_on') }));
    }
    if (p.officeSupported) {
      out.push(printBox(id, 'office', p.office, t('gwn.feat.print_office')));
      if (!p.office) out.push(h('span', { class: 'gwe-d', 'data-print-office': 'size', text: t('gwn.feat.print_office_size') }));
      else if (p.officeService === 'managed') out.push(h('span', { class: 'gwe-d', 'data-print-office': 'on', text: t('gwn.feat.print_office_on') }));
      else if (p.officeCompose === 'compose' && window.GCGatewayCompose) {
        const dl = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-print-office-compose', text: t('gwn.feat.ai_compose_btn') });
        dl.addEventListener('click', () => window.GCGatewayCompose.open(g, 'gwn-print-office-compose'));
        out.push(h('span', { class: 'gwn-hint', 'data-print-office': 'compose' }, [U.icon('info', 14), t('gwn.feat.print_office_compose'), ' ', dl]));
      } else if (p.officeCompose === 'image') {
        out.push(h('span', { class: 'gwn-hint', 'data-print-office': 'image' }, [U.icon('info', 14), t('gwn.feat.print_office_image'), ' ',
          h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwn.feat.ai_releases') })]));
      } else out.push(h('span', { class: 'gwe-d', 'data-print-office': 'starting', text: t('gwn.feat.print_office_starting') }));
      if (p.office && p.officeHint === 'small') out.push(h('span', { class: 'gwn-hint', 'data-print-office': 'small' }, [U.icon('info', 14), t('gwn.feat.print_office_small')]));
    }
    return out;
  }

  /** "Letzte Suche 12:03: 14 mDNS-Antworten, 2 Druck-/Scandienste, 1 Gerät · verworfen: 1 × anderes Subnetz (192.168.20.5)" */
  function printSearchText(s) {
    const at = s.at ? when(new Date(s.at).toISOString()) : '—';
    let text = s.interfaces === 0 ? t('gwn.feat.print_search_nolan', { when: at })
      : t('gwn.feat.print_search', { when: at, responses: nf(s.responses), services: nf(s.services), devices: nf(s.devices) });
    const dropped = Object.keys(s.dropped || {}).map((r) => {
      const ips = (s.hosts || []).filter((x) => x.reason === r).map((x) => x.ip);
      return t('gwn.feat.print_drop', { n: s.dropped[r], reason: t('gwn.feat.print_drop_' + r) }) + (ips.length ? ' (' + ips.join(', ') + ')' : '');
    });
    if (dropped.length) text += ' · ' + t('gwn.feat.print_dropped', { list: dropped.join(', ') });
    return text;
  }

  /** "Neu suchen": the gateway searches at once; the result shows up with its report (some seconds). */
  function printDiscover(id, btn) {
    btn.disabled = true;
    U.api('POST', url(id, '/print/discover'), {}).then((r) => {
      U.toast(t(r && r.busy ? 'gwn.feat.print_again_busy' : 'gwn.feat.print_again_done'));
      [8000, 20000].forEach((ms2) => setTimeout(() => { if (cur && String(cur.g.peer_id) === String(id)) reloadFeatures(id); }, ms2));
    }).catch((e) => D.alert({ message: errText(e), danger: true })).finally(() => { btn.disabled = false; });
  }

  const RFC1918 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;
  const isRfc1918 = (v) => RFC1918.test(v) && v.split('.').every((o) => Number(o) <= 255 && String(Number(o)) === o);

  /**
   * "Drucker nicht gefunden? Per IP-Adresse hinzufügen": the addresses the gateway asks directly
   * (features.print.manual — private IPv4 only, at most 16; checked again by the server).
   */
  function printManualDialog(id, p) {
    const max = p.manualMax || 16;
    const list = (p.manual || []).slice();
    const status = new Map(((p.search && p.search.manual) || []).map((m) => [m.ip, m]));
    const named = new Map((p.devices || []).map((d) => [d.ip, d]));
    const dlg = U.openDialog({ title: t('gwn.print.dlg_title'), wide: false, cls: 'gwn-printdlg' });
    const rows = h('div', { class: 'gwn-rows', 'data-print-manual-list': '' });
    const input = h('input', { type: 'text', id: 'gwn-p-ip', class: 'form-input gwe-mono', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: '192.168.1.70', 'aria-describedby': 'gwn-p-ip-hint' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'data-fk': 'gwn-p-add', text: t('gwn.print.add') });
    const err = U.errorBox();
    const stateOf = (ip) => {
      const m = status.get(ip);
      if (!m) return h('span', { class: 'gwe-d', text: t('gwn.print.st_pending') });
      if (m.found) {
        const d = named.get(ip);
        return h('span', { class: 'gwe-d' }, [U.tag('green', t('gwn.print.st_found'), true), ' ', d ? d.name : '', m.via === 'mdns' ? ' · ' + t('gwn.print.st_via_mdns') : '']);
      }
      return h('span', { class: 'gwe-d' }, [U.tag('red', t(m.error === 'no_service' ? 'gwn.print.st_no_service' : 'gwn.print.st_unreachable'), true)]);
    };
    const draw = () => {
      rows.textContent = '';
      if (!list.length) rows.appendChild(h('p', { class: 'gwe-empty', text: t('gwn.print.none') }));
      list.forEach((ip, i) => {
        const rm = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-p-rm:' + ip, 'aria-label': t('gwn.print.remove_aria', { ip }), text: t('gwn.print.remove') });
        rm.addEventListener('click', () => { list.splice(i, 1); draw(); input.focus(); });
        rows.appendChild(h('div', { class: 'gwn-row', 'data-print-ip': ip }, [h('span', { class: 'gwn-row-m' }, [h('strong', { class: 'gwe-mono', text: ip }), ' ', stateOf(ip)]), rm]));
      });
      addBtn.disabled = list.length >= max;
      input.disabled = list.length >= max;
    };
    const add = (raw) => {
      const ip = String(raw || '').trim();
      U.showErr(err, '');
      input.removeAttribute('aria-invalid');
      if (!isRfc1918(ip)) { U.showErr(err, t('gwn.err.invalid_host')); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      if (list.includes(ip)) { U.showErr(err, t('gwn.print.dup', { ip })); input.focus(); return; }
      if (list.length >= max) { U.showErr(err, t('gwn.print.max', { n: max })); return; }
      list.push(ip);
      input.value = '';
      draw();
      input.focus();
    };
    addBtn.addEventListener('click', () => add(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
    // what the search saw in another private subnet: one click to allow it
    const sugg = ((p.search && p.search.hosts) || []).filter((x) => x.private && x.reason === 'other_subnet');
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwn.print.dlg_intro') }),
      rows,
      h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwn-p-ip', text: t('gwn.print.ip') }),
        h('div', { class: 'gwn-print-add' }, [input, addBtn]),
        h('span', { class: 'form-hint', id: 'gwn-p-ip-hint', text: t('gwn.print.ip_hint', { n: max }) })]),
      sugg.length ? h('div', { class: 'gwe-field', 'data-print-sugg': '' }, [h('span', { class: 'form-label', text: t('gwn.print.sugg') }),
        ...sugg.map((x) => {
          const b = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-p-sugg:' + x.ip, text: t('gwn.print.sugg_add', { ip: x.ip, name: x.name || '—' }) });
          b.addEventListener('click', () => add(x.ip));
          return b;
        })]) : null,
      err);
    draw();
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwn-p-save', text: t('gwn.print.save') });
    dlg.foot.append(cancel, ok);
    ok.addEventListener('click', () => {
      // a typed but not added address counts as well
      if (input.value.trim()) { add(input.value); if (input.value.trim()) return; }
      ok.disabled = true;
      putFeatures(id, { print: { manual: list } }, t('gwn.print.saved'))
        .then(() => {
          dlg.close(true);
          // the gateway pulls its config and asks the addresses at once
          [10000, 25000].forEach((ms2) => setTimeout(() => { if (cur && String(cur.g.peer_id) === String(id)) reloadFeatures(id); }, ms2));
        })
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    input.focus();
  }

  /**
   * The row "Lokale KI" (phase 3c, step 3): the switch (features.ai), the model of this gateway when it serves
   * the local AI, the way to Einstellungen › KI-Anbieter; hints instead of bans (too little memory, the compose
   * file without the service ki, "Gateway zu alt").
   */
  function aiRow(id, g, d) {
    const a = d.ai;
    const sup = d.support || {};
    const old = a.supported === false;
    const sw = U.switchBtn(!!a.enabled, t('gwn.feat.ai'), 'gwn-f-ai', () => toggle(sw, id, (v) => ({ ai: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.ai') })), old && !a.enabled);
    const extra = [];
    if (old) extra.push(h('span', { class: 'gwn-hint', 'data-ai-old': '' }, [U.icon('info', 14), t('gwn.feat.ai_old', { min: a.minGateway || sup.minGatewayAi || '1.26.0', version: sup.version || '—' })]));
    let text = t('gwn.feat.ai_d');
    if (a.enabled && a.chosen && a.model) {
      const mem = a.model.ramMb ? t('gwn.feat.ai_model_mem', { dl: nf(a.model.downloadMb / 1000, 1), ram: nf(a.model.ramMb / 1000, 1) }) : '';
      text = a.source === 'lan' ? t('gwn.feat.ai_on_lan', { url: a.lanUrl || '' }) : t('gwn.feat.ai_on');
      extra.push(h('span', { class: 'gwe-d', 'data-ai-model': a.model.id }, [t('gwn.feat.ai_model'), ' ', h('strong', { text: a.model.name }), mem ? ' ' + mem : '']));
    } else if (a.enabled && !a.chosen) {
      extra.push(h('span', { class: 'gwn-hint' }, [U.icon('info', 14), t('gwn.feat.ai_not_chosen')]));
    }
    const st = a.state || {};
    if (a.enabled && st.pull && st.pull.state === 'pulling') {
      extra.push(h('span', { class: 'gwe-d', role: 'status' }, t('gwn.feat.ai_pulling', { done: nf((st.pull.completed || 0) / 1e9, 1), total: nf((st.pull.total || 0) / 1e9, 1) })));
    }
    if (a.hint === 'memory' && !old) extra.push(h('span', { class: 'gwn-hint', 'data-ai-hint': 'memory' }, [U.icon('warn', 14), t('gwn.feat.ai_memory')]));
    if (a.compose === 'compose' && window.GCGatewayCompose) {
      const dl = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-ai-compose', text: t('gwn.feat.ai_compose_btn') });
      dl.addEventListener('click', () => window.GCGatewayCompose.open(g, 'gwn-ai-compose'));
      extra.push(h('span', { class: 'gwn-hint', 'data-ai-compose': '' }, [U.icon('info', 14), t('gwn.feat.ai_compose'), ' ', dl]));
    } else if (a.compose === 'image') {
      extra.push(h('span', { class: 'gwn-hint', 'data-ai-compose': 'image' }, [U.icon('info', 14), t('gwn.feat.ai_old_image'), ' ',
        h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwn.feat.ai_releases') })]));
    }
    extra.push(h('a', { href: '/settings/ki', class: 'gwn-link', 'data-ai-link': '', text: t('gwn.feat.ai_to_settings') }));
    return featRow(t('gwn.feat.ai'), text, sw, extra, 'ai');
  }

  /**
   * The row "Kameras" (phase 3c, step 4): the switch (features.cameras), how many cameras are set up, the way into
   * "Tür & Kamera"; hints instead of bans (Raspberry Pi: at most one camera with motion detection, the compose file
   * without the service kameras, "Gateway zu alt").
   */
  function camerasRow(id, g, d) {
    const c = d.cameras;
    const sup = d.support || {};
    const old = c.supported === false;
    const sw = U.switchBtn(!!c.enabled, t('gwn.feat.cameras'), 'gwn-f-cameras', () => toggle(sw, id, (v) => ({ cameras: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.cameras') })), old && !c.enabled);
    const extra = [];
    if (old) extra.push(h('span', { class: 'gwn-hint', 'data-cameras-old': '' }, [U.icon('info', 14), t('gwn.feat.cameras_old', { min: c.minGateway || sup.minGatewayCameras || '1.28.0', version: sup.version || '—' })]));
    const parts = [t('gwn.feat.cameras_d')];
    if (c.enabled || c.count) parts.push(t(c.count === 1 ? 'gwn.feat.cameras_one' : 'gwn.feat.cameras_n', { n: nf(c.count || 0) }));
    const st = c.storage;
    if (c.enabled && st && st.free != null) extra.push(h('span', { class: 'gwe-d', 'data-cameras-storage': '' }, t('gwn.feat.cameras_storage', { free: bytesLabel(st.free) })));
    if (c.enabled && st && st.problem) extra.push(h('span', { class: 'gwn-hint', 'data-cameras-disk': st.problem }, [U.icon('warn', 14), t('gwn.feat.cameras_' + st.problem)]));
    // where the clips lie (gateway ≥ 1.29.0) and whether the folder chosen here is in use
    if (c.enabled && !old) {
      const where = c.storagePath ? t('gwn.feat.cameras_where_folder', { path: c.storagePath }) : t('gwn.feat.cameras_where_volume');
      extra.push(h('span', { class: 'gwe-d', 'data-cameras-where': c.storagePath ? 'folder' : 'volume' }, where));
      if ((c.subnets || []).length) extra.push(h('span', { class: 'gwe-d', 'data-cameras-subnets': '' }, t('gwn.feat.cameras_subnets_list', { list: c.subnets.join(', ') })));
      if (c.storageState === 'compose' && window.GCGatewayCompose) {
        const dl2 = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-cameras-storage-compose', text: t('gwn.feat.ai_compose_btn') });
        dl2.addEventListener('click', () => window.GCGatewayCompose.open(g, 'gwn-cameras-storage-compose'));
        extra.push(h('span', { class: 'gwn-hint', 'data-cameras-storage-state': 'compose' }, [U.icon('info', 14), t('gwn.feat.cameras_storage_compose'), ' ', dl2]));
      } else if (c.storageState === 'container') {
        extra.push(h('span', { class: 'gwn-hint', 'data-cameras-storage-state': 'container' }, [U.icon('warn', 14), t('gwn.feat.cameras_storage_container')]));
      }
      const set = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-cameras-settings', 'aria-haspopup': 'dialog', text: t('gwn.feat.cameras_settings') });
      set.addEventListener('click', () => camerasDialog(id, c));
      extra.push(h('span', { class: 'gwn-print-acts' }, [set]));
    }
    if (c.hint && !old) {
      extra.push(h('span', { class: 'gwn-hint', 'data-cameras-hint': c.hint.key }, [U.icon(c.hint.over ? 'warn' : 'info', 14), t('gwn.feat.cameras_hint_' + c.hint.key, { max: c.hint.max })]));
    }
    if (c.compose === 'compose' && window.GCGatewayCompose) {
      const dl = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-cameras-compose', text: t('gwn.feat.ai_compose_btn') });
      dl.addEventListener('click', () => window.GCGatewayCompose.open(g, 'gwn-cameras-compose'));
      extra.push(h('span', { class: 'gwn-hint', 'data-cameras-compose': '' }, [U.icon('info', 14), t('gwn.feat.cameras_compose'), ' ', dl]));
    } else if (c.compose === 'image') {
      extra.push(h('span', { class: 'gwn-hint', 'data-cameras-compose': 'image' }, [U.icon('info', 14), t('gwn.feat.cameras_old_image'), ' ',
        h('a', { href: GW_RELEASES, target: '_blank', rel: 'noopener noreferrer', text: t('gwn.feat.ai_releases') })]));
    }
    const plug = c.plugin || {};
    if (plug.installed) extra.push(h('a', { href: '/plugins/gatecontrol-door', class: 'gwn-link', 'data-cameras-link': 'plugin', text: t('gwn.feat.cameras_to_plugin') }));
    else extra.push(h('a', { href: '/settings/plugins/catalog/gatecontrol-door', class: 'gwn-link', 'data-cameras-link': 'catalog', text: t('gwn.feat.cameras_install') }));
    return featRow(t('gwn.feat.cameras'), parts.join(' '), sw, extra, 'cameras');
  }

  // the same check as the server (services/homeCameras.js storagePath): an absolute, plain folder of the host
  const STORAGE_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,15}\/?$/;
  const storageOk = (v) => v.length <= 200 && STORAGE_RE.test(v) && v.split('/').every((x) => x !== '.' && x !== '..');

  /**
   * Gateway › Funktionen › Kameras › "Einstellungen": the folder for the clips (into the compose file the gateway
   * page downloads — GC_CAMERA_DIR, no SSH) and up to 8 more private networks the gateway may reach (a camera VLAN
   * behind the router). Both checked again by the server.
   */
  function camerasDialog(id, c) {
    const max = 8;
    const list = (c.subnets || []).slice();
    const rpi = c.platform === 'rpi';
    const dlg = U.openDialog({ title: t('gwn.cam.dlg_title'), wide: false, cls: 'gwn-printdlg' });
    const err = U.errorBox();
    // ── the folder for the clips ──
    const path = h('input', { type: 'text', id: 'gwn-cam-path', class: 'form-input gwe-mono', autocomplete: 'off', spellcheck: 'false', placeholder: '/volume1/kameras', 'aria-describedby': 'gwn-cam-path-hint', disabled: rpi });
    path.value = c.storagePath || '';
    // ── more networks ──
    const rows = h('div', { class: 'gwn-rows', 'data-cameras-subnet-list': '' });
    const input = h('input', { type: 'text', id: 'gwn-cam-net', class: 'form-input gwe-mono', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: '192.168.20.0/24', 'aria-describedby': 'gwn-cam-net-hint' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'data-fk': 'gwn-cam-net-add', text: t('gwn.print.add') });
    const cidrOk = (v) => {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(v);
      return !!m && isRfc1918(m[1]) && Number(m[2]) >= 16 && Number(m[2]) <= 30;
    };
    const draw = () => {
      rows.textContent = '';
      if (!list.length) rows.appendChild(h('p', { class: 'gwe-empty', text: t('gwn.cam.nets_none') }));
      list.forEach((n, i) => {
        const rm = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwn-cam-net-rm:' + n, 'aria-label': t('gwn.print.remove_aria', { ip: n }), text: t('gwn.print.remove') });
        rm.addEventListener('click', () => { list.splice(i, 1); draw(); input.focus(); });
        rows.appendChild(h('div', { class: 'gwn-row', 'data-cameras-subnet': n }, [h('span', { class: 'gwn-row-m' }, [h('strong', { class: 'gwe-mono', text: n })]), rm]));
      });
      addBtn.disabled = list.length >= max;
      input.disabled = list.length >= max;
    };
    const add = (raw) => {
      const v = String(raw || '').trim();
      U.showErr(err, '');
      input.removeAttribute('aria-invalid');
      if (!cidrOk(v)) { U.showErr(err, t('gwn.cam.net_invalid')); input.setAttribute('aria-invalid', 'true'); input.focus(); return false; }
      if (list.includes(v)) { U.showErr(err, t('gwn.print.dup', { ip: v })); input.focus(); return false; }
      if (list.length >= max) { U.showErr(err, t('gwn.print.max', { n: max })); return false; }
      list.push(v);
      input.value = '';
      draw();
      input.focus();
      return true;
    };
    addBtn.addEventListener('click', () => add(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwn.cam.dlg_intro') }),
      h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: 'gwn-cam-path', text: t('gwn.cam.path') }), path,
        h('span', { class: 'form-hint', id: 'gwn-cam-path-hint', text: t(rpi ? 'gwn.cam.path_hint_rpi' : 'gwn.cam.path_hint') })]),
      h('div', { class: 'gwe-field' }, [h('span', { class: 'form-label', text: t('gwn.cam.nets') }), rows,
        h('label', { class: 'sr-only', for: 'gwn-cam-net', text: t('gwn.cam.net') }),
        h('div', { class: 'gwn-print-add' }, [input, addBtn]),
        h('span', { class: 'form-hint', id: 'gwn-cam-net-hint', text: t('gwn.cam.nets_hint', { n: max }) })]),
      err);
    draw();
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwn-cam-save', text: t('gwn.print.save') });
    dlg.foot.append(cancel, ok);
    ok.addEventListener('click', () => {
      // a typed but not added network counts as well
      if (input.value.trim() && !add(input.value)) return;
      const p = path.value.trim();
      path.removeAttribute('aria-invalid');
      if (!rpi && p && !storageOk(p)) { U.showErr(err, t('gwn.cam.path_invalid')); path.setAttribute('aria-invalid', 'true'); path.focus(); return; }
      ok.disabled = true;
      const patch = { subnets: list };
      if (!rpi) patch.storagePath = p || null;
      const changedPath = !rpi && (p.replace(/\/$/, '') || null) !== (c.storagePath || null);
      putFeatures(id, { cameras: patch }, t(changedPath && p ? 'gwn.cam.saved_path' : 'gwn.cam.saved'))
        .then(() => dlg.close(true))
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    path.focus();
  }

  function bytesLabel(n) {
    if (!(n >= 0)) return '—';
    if (n >= 1e12) return t('gwn.feat.cameras_tb', { n: nf(n / 1e12, 1) });
    return t('gwn.feat.cameras_gb', { n: nf(n / 1e9, n >= 1e10 ? 0 : 1) });
  }

  /** Every switch row of the gateway by its data-feature key (same API and behaviour as before: putFeatures). */
  function featureRows(g, d) {
    const rows = new Map();
    const f = d.features;
    const id = g.peer_id;
    // network watch (+ the nightly port check)
    const swNet = U.switchBtn(f.netwatch.enabled, t('gwn.feat.netwatch'), 'gwn-f-net', () => toggle(swNet, id, (v) => ({ netwatch: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.netwatch') })));
    const portscan = h('input', { type: 'checkbox', id: 'gwn-f-ports', 'data-fk': 'gwn-f-ports', disabled: !f.netwatch.enabled });
    portscan.checked = !!f.netwatch.portscan;
    portscan.addEventListener('change', () => {
      portscan.disabled = true;
      putFeatures(id, { netwatch: { portscan: portscan.checked } }, t('gwn.feat.saved')).catch((err) => { portscan.checked = !portscan.checked; portscan.disabled = false; D.alert({ message: errText(err), danger: true }); });
    });
    const netLink = h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/net', class: 'gwn-link', text: t('gwn.feat.to_net') });
    rows.set('netwatch', featRow(t('gwn.feat.netwatch'), t('gwn.feat.netwatch_d'), swNet,
      [h('label', { class: 'gwn-sub', for: 'gwn-f-ports' }, [portscan, h('span', { text: t('gwn.feat.portscan') })]), netLink], 'netwatch'));
    // internet quality
    const swInet = U.switchBtn(f.inetq.enabled, t('gwn.feat.inetq'), 'gwn-f-inet', () => toggle(swInet, id, (v) => ({ inetq: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.inetq') })));
    const lim = speedLimitText(d.speedLimit);
    rows.set('inetq', featRow(t('gwn.feat.inetq'), t('gwn.feat.inetq_d'), swInet,
      [lim ? h('span', { class: 'gwn-hint' }, [U.icon('info', 14), lim]) : null,
        h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/inet', class: 'gwn-link', text: t('gwn.feat.to_inet') })], 'inetq'));
    // presence (needs the network watch)
    const swPres = U.switchBtn(f.netwatch.enabled && f.presence.enabled, t('gwn.feat.presence'), 'gwn-f-pres', () => toggle(swPres, id, (v) => ({ presence: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.presence') })), !f.netwatch.enabled);
    rows.set('presence', featRow(t('gwn.feat.presence'), t('gwn.feat.presence_d'), swPres, [], 'presence'));
    // UPS
    const swUps = U.switchBtn(f.ups.enabled, t('gwn.feat.ups'), 'gwn-f-ups', () => {
      if (!f.ups.enabled && !f.ups.host) { upsDialog(id, f.ups); return; }
      toggle(swUps, id, (v) => ({ ups: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.ups') }));
    });
    const upsLink = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-f-ups-set', text: f.ups.host ? t('gwn.feat.ups_change', { host: f.ups.host }) : t('gwn.feat.ups_set') });
    upsLink.addEventListener('click', () => upsDialog(id, f.ups));
    rows.set('ups', featRow(t('gwn.feat.ups'), t('gwn.feat.ups_d'), swUps, [upsLink], 'ups'));
    // edge parts & MQTT (the switch of the tab "Edge-Plugins")
    if (d.edge) {
      const swEdge = U.switchBtn(!!d.edge.enabled, t('gwn.feat.edge'), 'gwn-f-edge', async () => {
        const next = swEdge.getAttribute('aria-checked') !== 'true';
        if (!next && !await D.confirm({ title: t('gwe.edge.off_title'), message: t('gwe.edge.off_msg'), okLabel: t('gwe.edge.off_ok'), danger: true })) return;
        swEdge.disabled = true;
        swEdge.setAttribute('aria-checked', next ? 'true' : 'false');
        U.api('PUT', '/api/v1/edge/gateways/' + encodeURIComponent(String(id)) + '/settings', { edgeEnabled: next })
          .then(() => { U.toast(t(next ? 'gwe.edge.on_done' : 'gwe.edge.off_done')); return load('feat', id, true); })
          .then(() => refreshFeatures(id))
          .catch((err) => { swEdge.disabled = false; swEdge.setAttribute('aria-checked', next ? 'false' : 'true'); D.alert({ message: errText(err), danger: true }); });
      });
      rows.set('edge', featRow(t('gwn.feat.edge'), t('gwn.feat.edge_d'), swEdge,
        [h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/edge', class: 'gwn-link', text: t('gwn.feat.to_edge') })], 'edge'));
    }
    // Funk (phase 3c, step 2): Zigbee, Bluetooth, Thread — the row of gateway-radio.js; the old
    // Zigbee row only for a server answer without it
    const radioRow = d.radio && window.GCGatewayRadio ? window.GCGatewayRadio.featureRow(id, d, (gid) => reloadFeatures(gid)) : null;
    if (radioRow) rows.set('radio', radioRow);
    else if (d.zigbee) {
      rows.set('zigbee', featRow(t('gwn.feat.zigbee'), t(d.zigbee.enabled ? 'gwn.feat.zigbee_on' : 'gwn.feat.zigbee_found'),
        U.tag(d.zigbee.enabled ? 'green' : 'grey', t(d.zigbee.enabled ? 'gwn.feat.running' : 'gwn.feat.not_running'), true), [], 'zigbee'));
    }
    // LAN discovery for routes (existing; licence gateway_lan_discovery)
    if (d.lanDiscovery && d.lanDiscovery.available) {
      const swLan = U.switchBtn(!!d.lanDiscovery.enabled, t('gwn.feat.lan'), 'gwn-f-lan', () => toggle(swLan, id, (v) => ({ lanDiscovery: v }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.lan') })), !d.lanDiscovery.licensed);
      if (!d.lanDiscovery.licensed) swLan.title = t('gwn.feat.lan_license');
      rows.set('lan', featRow(t('gwn.feat.lan'), t('gwn.feat.lan_d'), swLan,
        d.lanDiscovery.licensed ? [] : [h('span', { class: 'gwe-d gwe-muted', text: t('gwn.feat.lan_license') })], 'lan'));
    }
    // Drucken & Scannen (phase 3c): the switch here, everything else in the plugin "Drucken & Scannen"
    if (d.print) rows.set('print', printRow(id, d, g));
    // Kameras (phase 3c, step 4): the switch here, the cameras themselves in the plugin "Tür & Kamera"
    if (d.cameras) rows.set('cameras', camerasRow(id, g, d));
    // Lokale KI (phase 3c, step 3): the switch here, the setup in Einstellungen › KI-Anbieter
    if (d.ai) rows.set('ai', aiRow(id, g, d));
    // DNS filter, home cache, local time (phase 3b, gateway-home.js)
    if (window.GCGatewayHome) {
      window.GCGatewayHome.featureRows(id, d, (gid) => reloadFeatures(gid)).forEach((r) => rows.set(r.getAttribute('data-feature'), r));
    }
    return rows;
  }

  // "≈ 40 MB" next to the switch — only for a part the memory estimate names (switched on)
  function memTag(row, d) {
    const key = row.getAttribute('data-feature');
    const mb = PK.memoryOf(d, key);
    if (mb == null) return;
    // the local AI in GB and blue, like its part of the memory bar
    const tagNode = key === 'ai'
      ? h('span', { class: 'tag tag-blue gwn-fr-mem', text: t('gwp.feat.mem_row_gb', { gb: nf(mb / 1000, 1) }) })
      : h('span', { class: 'tag tag-grey gwn-fr-mem', text: t('gwp.feat.mem_row', { mb: nf(mb) }) });
    const control = row.children.length > 1 ? row.lastElementChild : null;
    if (control) row.insertBefore(tagNode, control); else row.appendChild(tagNode);
  }

  function memBar(d) {
    const m = d.memory || {};
    const hw = hwLine(d.hardware || {});
    if (!m.totalMb) return hw ? h('p', { class: 'gwe-d gwn-hwline', text: hw }) : null;
    const pct = Math.max(1, Math.min(100, Math.round((m.usedMb / m.totalMb) * 100)));
    const tone = m.level === 'too_much' ? 'red' : m.level === 'tight' ? 'amber' : 'green';
    const head = t('gwp.feat.mem_head', { used: K.ramLabel(m.usedMb), total: K.ramLabel(m.totalMb) });
    // phase 3c, step 3: the model of the local AI as its own (blue) part of the bar
    const aiMb = (m.parts || []).filter((x) => x && x.kind === 'ai').reduce((a, x) => a + (x.mb > 0 ? x.mb : 0), 0);
    const fill = h('span', { class: 'gwn-membar-fill gwn-membar-' + (m.level || 'ok') });
    const bar = h('span', { class: 'gwn-membar-bar' + (aiMb ? ' gwn-membar-split' : ''), role: 'img', 'aria-label': pct + ' %' }, fill);
    if (aiMb) {
      const aiPct = Math.max(1, Math.min(pct, Math.round((aiMb / m.totalMb) * 100)));
      fill.style.width = Math.max(0, pct - aiPct) + '%';
      const ai = h('span', { class: 'gwn-membar-ai', 'data-membar': 'ai' });
      ai.style.width = aiPct + '%';
      bar.appendChild(ai);
    } else fill.style.width = pct + '%';
    return h('section', { class: 'gw gwe-card gwn-membar', 'aria-label': t('gwp.feat.mem_label') }, h('div', { class: 'body gwe-body' }, [
      h('div', { class: 'gwn-membar-row' }, [
        h('div', { class: 'gwn-membar-t' }, [h('strong', { text: head }), bar,
          aiMb ? h('span', { class: 'gwe-d gwn-membar-legend', text: t('gwp.feat.mem_legend_ai') }) : null]),
        m.level ? U.tag(tone, t('gwp.feat.level_' + m.level), true) : null,
      ]),
      hw ? h('p', { class: 'gwe-d gwn-hwline', text: hw }) : null,
      m.level ? h('p', { class: 'gwe-d', text: t('gwn.feat.mem_' + m.level) }) : null,
    ]));
  }

  // the text under a group's title; "Für das ganze Heimnetz" names the other gateways it holds for
  function groupText(g, d, key) {
    if (key === 'home') return t('gwp.fgrp.home_d');
    if (key === 'devices') return t('gwp.fgrp.devices_d');
    if (key !== 'wide') return null;
    const names = (d.home || []).map((x) => x.name).filter(Boolean);
    if (!names.length) return t('gwp.fgrp.wide_d');
    const P = window.GCGatewayPools;
    const pools = P && P.poolsOf ? P.poolsOf(g.peer_id) : [];
    if (pools.length) return t('gwp.fgrp.wide_pool', { gateways: names.join(', '), pool: pools.map((p) => p.name).join(', ') });
    return t('gwp.fgrp.wide_home', { gateways: names.join(', ') });
  }

  function featuresPanel(g, d) {
    const out = [];
    const sup = d.support || {};
    if (sup.netwatch === false || sup.inetq === false) out.push(U.note('warn', [t('gwn.feat.too_old', { min: sup.minGateway, version: sup.version || '—' })]));
    const mb = memBar(d);
    if (mb) out.push(mb);
    const rows = featureRows(g, d);
    PK.FEATURE_GROUPS.forEach((grp) => {
      const list = grp.features.map((k) => rows.get(k)).filter(Boolean);
      if (!list.length) return;
      list.forEach((r) => memTag(r, d));
      const c = U.card(t('gwp.fgrp.' + grp.key), null, { id: 'fg-' + grp.key, cls: 'gwn-features gwn-fgroup' });
      c.card.setAttribute('data-fgroup', grp.key);
      const text = groupText(g, d, grp.key);
      if (text) c.body.appendChild(h('p', { class: 'gwe-d gwn-fgroup-d', text }));
      list.forEach((r) => c.body.appendChild(r));
      out.push(c.card);
    });
    // "Ein Schalter genügt" and "Hinweise statt Verbote" (phase 3c) — once the gateway offers the local AI
    if (d.ai || d.cameras) {
      out.push(h('div', { class: 'gwn-fhints' }, [
        U.note('info', [h('strong', { text: t('gwn.feat.hint_switch_t') }), ' ', t('gwn.feat.hint_switch')]),
        U.note('warn', [h('strong', { text: t('gwn.feat.hint_hints_t') }), ' ', t('gwn.feat.hint_hints')]),
      ]));
    }
    return out;
  }

  /** The card "Funktionen" of the overview: what is on, what is off, the memory — the switches live in the tab. */
  function summaryCard(g) {
    const node = h('section', { class: 'gw gwe-card gwn-fsum', 'aria-labelledby': 'gwn-fsum-h' });
    summaryNodes.set(String(g.peer_id), { node, g });
    fillSummary(node, g);
    const e = entry('feat', g.peer_id);
    if (!e.data || Date.now() - e.at > 30000) load('feat', g.peer_id, true).then(() => refreshFeatures(g.peer_id), () => refreshFeatures(g.peer_id));
    return node;
  }

  function fillSummary(node, g) {
    const e = entry('feat', g.peer_id);
    const d = e.data;
    const manage = h('a', { class: 'btn btn-ghost btn-sm', href: '#gw/' + encodeURIComponent(String(g.peer_id)) + '/features', 'data-fk': 'gwn-fsum-manage', text: t('gwp.fsum.manage') });
    const head = h('div', { class: 'top gwe-top' }, [h('h3', { id: 'gwn-fsum-h', text: t('gwp.fsum.title') }), manage]);
    const body = h('div', { class: 'body gwe-body' });
    node.replaceChildren(head, body);
    if (!d) {
      body.appendChild(e.err ? U.note('warn', [t('gwe.load_failed'), ' ', errText(e.err)]) : h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
      return;
    }
    const st = PK.featureStates(d);
    const on = st.filter((x) => x.on);
    const off = st.filter((x) => !x.on);
    body.appendChild(h('p', { class: 'gwe-d', text: t(on.length ? 'gwp.fsum.on' : 'gwp.fsum.none') }));
    if (on.length) body.appendChild(h('div', { class: 'gwe-chips gwn-fsum-chips' }, on.map((x) => h('span', { class: 'tag tag-green', 'data-fon': x.key, text: t('gwp.fname.' + x.key) }))));
    if (off.length) body.appendChild(h('p', { class: 'gwe-d gwn-fsum-off', text: t('gwp.fsum.off', { list: off.map((x) => t('gwp.fname.' + x.key)).join(', ') }) }));
    const m = d.memory || {};
    if (m.totalMb && m.level) {
      body.appendChild(h('p', { class: 'gwe-d', text: t('gwp.fsum.mem', { total: K.ramLabel(m.totalMb), used: K.ramLabel(m.usedMb), verdict: t('gwp.feat.level_' + m.level) }) }));
    }
  }

  // ─── Tab badges ───────────────────────────────────────────────────────
  function badge(node, id, which) {
    node.replaceChildren();
    node.className = 'gwe-tab-badge';
    const d = entry(kindOf(which), id).data;
    if (!d) return;
    if (which === 'features') {
      const n = PK.featureStates(d).filter((x) => x.on).length;
      if (n) { node.className = 'gwe-tab-badge tag tag-grey'; node.textContent = t('gwp.tab.on', { n }); }
    } else if (which === 'net') {
      const n = d.kpis && d.kpis.fresh;
      if (n && d.gateway.features.netwatch.enabled) { node.className = 'gwe-tab-badge tag tag-amber'; node.textContent = t('gwn.tabs.new', { n }); }
    } else if (d.now && d.now.state === 'outage') {
      node.className = 'gwe-tab-badge tag tag-red'; node.textContent = t('gwn.tabs.outage');
    }
  }

  // ─── Public ───────────────────────────────────────────────────────────
  function mount(box, g, tab, ctx) {
    cur = { box, g, tab, ctx: ctx || {} };
    box.classList.add('gwe-panel', 'gwn-panel');
    if (tab === 'features') box.classList.add('gwn-ftab');
    draw();
    load(kindOf(tab), g.peer_id, false).then(() => { redraw(); updateBadges(g.peer_id); }, () => redraw());
  }
  function prefetch(g) {
    load('feat', g.peer_id, false).then(() => updateBadges(g.peer_id), () => {});
    load('net', g.peer_id, false).then(() => updateBadges(g.peer_id), () => {});
    load('inet', g.peer_id, false).then(() => updateBadges(g.peer_id), () => {});
  }
  function unmount() { cur = null; }

  /** The tab's function is switched off (feature data loaded) — the tab shows "· aus". */
  function tabOff(id, tab) { return PK.tabOff(entry('feat', id).data, tab); }
  /** New devices of the network watch (0 when none); null when unknown or switched off. */
  function fresh(id) {
    const d = entry('net', id).data;
    if (!d || !d.gateway || !d.gateway.features || !d.gateway.features.netwatch.enabled) return null;
    return (d.kpis && d.kpis.fresh) || 0;
  }

  // the card again after a change elsewhere (tabs "DNS-Filter" / "Zwischenspeicher", gateway-home.js)
  function reloadFeatures(id) { return load('feat', id, true).then(() => refreshFeatures(id), () => refreshFeatures(id)); }

  /** The features overview of a gateway as loaded (null before) — the tab "Funk" badge reads it. */
  function features(id) { return entry('feat', id).data; }

  window.GCGatewayNet = { mount, unmount, prefetch, summaryCard, badge, tabOff, fresh, reloadFeatures, features, _cache: cache, _view: view };
})();
