'use strict';

// Gateway detail › tabs "Netzwerk" and "Internet" and the card "Funktionen
// dieses Gateways" in the tab "Übersicht" (phase 3a: network watch, internet
// quality, presence over the home network, UPS). gateway-edge.js builds the
// tab bar and hands the two tabs to this module; gateways.js asks it for the
// card. Data: the admin API /api/v1/gateways/:id/{features,netwatch,inetq}
// (session + CSRF, routes/api/gatewayNet.js).
//
//   window.GCGatewayNet.mount(box, g, tab, ctx)  → fills `box` with the tab 'net' | 'inet'
//   window.GCGatewayNet.featuresCard(g)          → the card for the overview (fills itself)
//   window.GCGatewayNet.badge(node, id, tab)     → the badge of a tab ("2 neu", "Ausfall")
//   window.GCGatewayNet.prefetch(g) / unmount()
//
// Pure rules (risky ports, list filter, chart geometry, UPS states) live in
// gateway-net-kit.js. Dialogs are window.GCDialog frames; nothing here uses
// innerHTML — every node is built with GCDialog.el / textContent.
(function () {
  const E = window.GCGatewayEdge;
  const K = window.GCGatewayNetKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !K || !D) return;
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
  function updateBadges(id) { if (E.fillBadges) E.fillBadges(document, id); }

  function draw() {
    const e = entry(cur.tab, cur.g.peer_id);
    const nodes = [];
    if (!e.data) {
      if (e.err) nodes.push(errorPanel(e.err, cur.tab));
      else nodes.push(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    } else if (cur.tab === 'net') nodes.push(...netPanel(cur.g, e.data));
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
      if (cur && String(cur.g.peer_id) === String(id)) reload(cur.tab, id);
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

  function newCard(g, d, list) {
    const c = U.card(t('gwn.new.title'), h('span', { class: 'gwe-sum', text: t('gwn.new.hint') }), { id: 'new', full: true, cls: 'gwn-newcard' });
    list.forEach((x) => {
      const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'look:' + x.id, 'aria-label': t('gwn.new.look_at', { name: devTitle(x) }), text: t('gwn.new.look') });
      b.addEventListener('click', () => deviceDialog(g, x, 'new'));
      c.body.appendChild(h('div', { class: 'gwn-newrow', 'data-device': x.mac }, [
        h('div', { class: 'gwn-newrow-t' }, [
          h('strong', { text: devTitle(x) + (x.vendor ? ' · ' + x.vendor : '') }),
          h('span', { class: 'gwe-d' }, [h('span', { class: 'gwe-mono', text: addrLine(x) }), ' · ' + t('gwn.new.first_seen', { when: when(x.firstSeen) }) + ' · ' + t('gwn.new.ports', { ports: portsText(x) })]),
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
          edit.addEventListener('click', () => deviceDialog(g, x, x.status === 'new' ? 'new' : 'edit'));
          const sub = [x.vendor, x.status === 'watch' ? t('gwn.status.watch') : null].filter(Boolean).join(' · ');
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

  function deviceDialog(g, x, mode) {
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

  // ─── Card "Funktionen dieses Gateways" (overview) ─────────────────────
  const featNodes = new Map(); // gateway id → the card node in the page

  function featuresCard(g) {
    const node = h('section', { class: 'gw gwe-card gwn-features', 'aria-labelledby': 'gwn-feat-h' });
    featNodes.set(String(g.peer_id), { node, g });
    fillFeatures(node, g);
    const e = entry('feat', g.peer_id);
    if (!e.data || Date.now() - e.at > 30000) load('feat', g.peer_id, true).then(() => refreshFeatures(g.peer_id), () => refreshFeatures(g.peer_id));
    return node;
  }

  function refreshFeatures(id) {
    const f = featNodes.get(String(id));
    if (!f || !f.node.isConnected) return;
    const fk = f.node.contains(document.activeElement) ? U.focusKey() : null;
    fillFeatures(f.node, f.g);
    U.restoreFocus(f.node, fk);
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

  function fillFeatures(node, g) {
    const e = entry('feat', g.peer_id);
    const d = e.data;
    const head = h('div', { class: 'top gwe-top' }, [h('h3', { id: 'gwn-feat-h', text: t('gwn.feat.title') }), d ? h('span', { class: 'gwe-sum', text: hwLine(d.hardware || {}) }) : null]);
    const body = h('div', { class: 'body gwe-body gwn-feat-body' });
    node.replaceChildren(head, body);
    if (!d) {
      body.appendChild(e.err ? U.note('warn', [t('gwe.load_failed'), ' ', errText(e.err)]) : h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
      return;
    }
    const f = d.features;
    const id = g.peer_id;
    const sup = d.support || {};
    if (sup.netwatch === false || sup.inetq === false) body.appendChild(U.note('warn', [t('gwn.feat.too_old', { min: sup.minGateway, version: sup.version || '—' })]));
    // network watch (+ the nightly port check)
    const swNet = U.switchBtn(f.netwatch.enabled, t('gwn.feat.netwatch'), 'gwn-f-net', () => toggle(swNet, id, (v) => ({ netwatch: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.netwatch') })));
    const portscan = h('input', { type: 'checkbox', id: 'gwn-f-ports', 'data-fk': 'gwn-f-ports', disabled: !f.netwatch.enabled });
    portscan.checked = !!f.netwatch.portscan;
    portscan.addEventListener('change', () => {
      portscan.disabled = true;
      putFeatures(id, { netwatch: { portscan: portscan.checked } }, t('gwn.feat.saved')).catch((err) => { portscan.checked = !portscan.checked; portscan.disabled = false; D.alert({ message: errText(err), danger: true }); });
    });
    const netLink = h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/net', class: 'gwn-link', text: t('gwn.feat.to_net') });
    body.appendChild(featRow(t('gwn.feat.netwatch'), t('gwn.feat.netwatch_d'), swNet,
      [h('label', { class: 'gwn-sub', for: 'gwn-f-ports' }, [portscan, h('span', { text: t('gwn.feat.portscan') })]), netLink], 'netwatch'));
    // internet quality
    const swInet = U.switchBtn(f.inetq.enabled, t('gwn.feat.inetq'), 'gwn-f-inet', () => toggle(swInet, id, (v) => ({ inetq: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.inetq') })));
    const lim = speedLimitText(d.speedLimit);
    body.appendChild(featRow(t('gwn.feat.inetq'), t('gwn.feat.inetq_d'), swInet,
      [lim ? h('span', { class: 'gwn-hint' }, [U.icon('info', 14), lim]) : null,
        h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/inet', class: 'gwn-link', text: t('gwn.feat.to_inet') })], 'inetq'));
    // presence (needs the network watch)
    const swPres = U.switchBtn(f.netwatch.enabled && f.presence.enabled, t('gwn.feat.presence'), 'gwn-f-pres', () => toggle(swPres, id, (v) => ({ presence: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.presence') })), !f.netwatch.enabled);
    body.appendChild(featRow(t('gwn.feat.presence'), t('gwn.feat.presence_d'), swPres, [], 'presence'));
    // UPS
    const swUps = U.switchBtn(f.ups.enabled, t('gwn.feat.ups'), 'gwn-f-ups', () => {
      if (!f.ups.enabled && !f.ups.host) { upsDialog(id, f.ups); return; }
      toggle(swUps, id, (v) => ({ ups: { enabled: v } }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.ups') }));
    });
    const upsLink = h('button', { type: 'button', class: 'gwn-linkbtn', 'data-fk': 'gwn-f-ups-set', text: f.ups.host ? t('gwn.feat.ups_change', { host: f.ups.host }) : t('gwn.feat.ups_set') });
    upsLink.addEventListener('click', () => upsDialog(id, f.ups));
    body.appendChild(featRow(t('gwn.feat.ups'), t('gwn.feat.ups_d'), swUps, [upsLink], 'ups'));
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
      body.appendChild(featRow(t('gwn.feat.edge'), t('gwn.feat.edge_d'), swEdge,
        [h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/edge', class: 'gwn-link', text: t('gwn.feat.to_edge') })], 'edge'));
    }
    // Zigbee (deCONZ): decided on the gateway (image setting ZIGBEE=), shown here
    if (d.zigbee) {
      body.appendChild(featRow(t('gwn.feat.zigbee'), t(d.zigbee.enabled ? 'gwn.feat.zigbee_on' : 'gwn.feat.zigbee_found'),
        U.tag(d.zigbee.enabled ? 'green' : 'grey', t(d.zigbee.enabled ? 'gwn.feat.running' : 'gwn.feat.not_running'), true), [], 'zigbee'));
    }
    // LAN discovery for routes (existing; licence gateway_lan_discovery)
    if (d.lanDiscovery && d.lanDiscovery.available) {
      const swLan = U.switchBtn(!!d.lanDiscovery.enabled, t('gwn.feat.lan'), 'gwn-f-lan', () => toggle(swLan, id, (v) => ({ lanDiscovery: v }), (v) => t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwn.feat.lan') })), !d.lanDiscovery.licensed);
      if (!d.lanDiscovery.licensed) swLan.title = t('gwn.feat.lan_license');
      body.appendChild(featRow(t('gwn.feat.lan'), t('gwn.feat.lan_d'), swLan,
        d.lanDiscovery.licensed ? [] : [h('span', { class: 'gwe-d gwe-muted', text: t('gwn.feat.lan_license') })], 'lan'));
    }
    // DNS filter, home cache, local time (phase 3b, gateway-home.js)
    if (window.GCGatewayHome) window.GCGatewayHome.featureRows(id, d, (gid) => load('feat', gid, true).then(() => refreshFeatures(gid), () => refreshFeatures(gid))).forEach((r) => body.appendChild(r));
    // memory
    const m = d.memory || {};
    if (m.totalMb) {
      const tone = m.level === 'too_much' ? 'crit' : m.level === 'tight' ? 'warn' : 'info';
      body.appendChild(h('div', { class: 'gwn-mem' }, U.note(tone, [h('strong', { text: t('gwn.feat.mem_label') }), ' ',
        t('gwn.feat.mem', { used: K.ramLabel(m.usedMb), total: K.ramLabel(m.totalMb) }), ' ', t('gwn.feat.mem_' + m.level)])));
    }
  }

  // ─── Tab badges ───────────────────────────────────────────────────────
  function badge(node, id, which) {
    node.replaceChildren();
    node.className = 'gwe-tab-badge';
    const d = entry(which, id).data;
    if (!d) return;
    if (which === 'net') {
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
    draw();
    load(tab, g.peer_id, false).then(() => { redraw(); updateBadges(g.peer_id); }, () => redraw());
  }
  function prefetch(g) {
    load('net', g.peer_id, false).then(() => updateBadges(g.peer_id), () => {});
    load('inet', g.peer_id, false).then(() => updateBadges(g.peer_id), () => {});
  }
  function unmount() { cur = null; }

  // the card again after a change elsewhere (tabs "DNS-Filter" / "Zwischenspeicher", gateway-home.js)
  function reloadFeatures(id) { return load('feat', id, true).then(() => refreshFeatures(id), () => refreshFeatures(id)); }

  window.GCGatewayNet = { mount, unmount, prefetch, featuresCard, badge, reloadFeatures, _cache: cache, _view: view };
})();
