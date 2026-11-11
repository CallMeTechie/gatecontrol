'use strict';

// Gateway detail › tabs "DNS-Filter" and "Zwischenspeicher" (phase 3b: DNS
// filter for the home network, home cache) and their rows in the card
// "Funktionen dieses Gateways". gateway-edge.js builds the tab bar and hands
// the two tabs to this module; gateway-net.js asks it for the card rows.
// Data: the admin API /api/v1/gateways/:id/{dns,cache} (session + CSRF,
// routes/api/gatewayHome.js).
//
//   window.GCGatewayHome.mount(box, g, tab, ctx)      → fills `box` with the tab 'dns' | 'cache'
//   window.GCGatewayHome.featureRows(id, d, changed)  → rows for the card (d = the features overview)
//   window.GCGatewayHome.badge(node, id, tab)         → the badge of a tab ("Ausfall")
//   window.GCGatewayHome.prefetch(g) / unmount()
//
// Pure rules live in gateway-home-kit.js. Dialogs are window.GCDialog frames;
// nothing here uses innerHTML — every node is built with GCDialog.el / textContent.
(function () {
  const E = window.GCGatewayEdge;
  const K = window.GCGatewayHomeKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !K || !D) return;
  const U = E.ui;
  const h = D.el;
  const t = U.t;
  const LANG = U.LANG;
  const LOCALE = LANG === 'en' ? 'en-GB' : 'de-DE';
  const API = '/api/v1/gateways/';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function url(id, rest) { return API + encodeURIComponent(String(id)) + (rest || ''); }
  function has(key) { return t(key) !== key; }
  function errText(e) {
    const code = e && e.code;
    if (code && has('gwh.err.' + code)) return t('gwh.err.' + code, { value: (e.body && e.body.value) || '' });
    if (code && has('gwn.err.' + code)) return t('gwn.err.' + code);
    if (e && e.status === 403) return t('gwn.err.forbidden');
    return U.errText(e);
  }
  function svg(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
    return n;
  }
  function icon(name, size) {
    const extra = {
      edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'm13.5 6.5 4 4' }]],
      copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }]],
      search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
      router: [['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 17h.01M11 17h.01M8 13V9M16 13V9M12 9a6 6 0 0 0-6-6M12 9a6 6 0 0 1 6-6' }]],
      disk: [['ellipse', { cx: 12, cy: 6, rx: 8, ry: 3 }], ['path', { d: 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }]],
      dot: [['circle', { cx: 12, cy: 12, r: 4 }]],
    };
    if (!extra[name]) return U.icon(name, size);
    const s = svg('svg', { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    extra[name].forEach((p) => s.appendChild(svg(p[0], p[1])));
    return s;
  }

  function nf(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString(LOCALE, { maximumFractionDigits: digits == null ? 0 : digits });
  }
  function bytes(n) {
    const p = K.bytesParts(n);
    return p ? nf(p.value, p.digits) + ' ' + p.unit : '—';
  }
  function clock(iso) {
    const v = Date.parse(iso);
    if (!Number.isFinite(v)) return '—';
    const d = new Date(v);
    const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return d.toLocaleDateString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' ' + time;
  }
  function dayNames() { return t('gwh.days.short').split(','); }
  function scheduleTitle(x) { return K.scheduleTitle(x, dayNames(), t('gwh.days.every'), t('gwh.sched.all_day')); }
  function catNames(list) { return (list || []).map((c) => t('gwh.cat.' + c)); }
  function joinAnd(list) {
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' ' + t('gwh.and') + ' ' + list[list.length - 1];
  }

  // ─── Data cache ───────────────────────────────────────────────────────
  const cache = { dns: {}, cache: {} };
  let cur = null; // { box, g, tab }

  function entry(kind, id) {
    const k = String(id);
    if (!cache[kind][k]) cache[kind][k] = { data: null, err: null, at: 0, inflight: null };
    return cache[kind][k];
  }
  function load(kind, id, force) {
    const e = entry(kind, id);
    if (e.inflight) return e.inflight;
    if (!force && e.data && Date.now() - e.at < 8000) return Promise.resolve(e.data);
    const p = U.api('GET', url(id, '/' + kind)).then((j) => {
      e.data = j; e.err = null; e.at = Date.now(); e.inflight = null;
      return j;
    }, (err) => { e.err = err; e.inflight = null; throw err; });
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
    return load(kind, id, true).then(() => { redraw(); badges(id); features(id); }, () => redraw());
  }
  function badges(id) { if (E.fillBadges) E.fillBadges(document, id); }
  function features(id) { if (window.GCGatewayNet && window.GCGatewayNet.reloadFeatures) window.GCGatewayNet.reloadFeatures(id); }

  function draw() {
    const e = entry(cur.tab, cur.g.peer_id);
    const nodes = [];
    if (!e.data) {
      if (e.err) nodes.push(errorPanel(e.err, cur.tab));
      else nodes.push(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    } else if (cur.tab === 'dns') nodes.push(...dnsPanel(cur.g, e.data));
    else nodes.push(...cachePanel(cur.g, e.data));
    if (e.data && e.err) nodes.unshift(U.note('warn', [errText(e.err)]));
    cur.box.replaceChildren(...nodes);
  }
  function errorPanel(err, kind) {
    const retry = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('gwe.retry'), 'data-fk': 'retry', on: { click: () => reload(kind, cur.g.peer_id) } });
    return h('div', { class: 'gw gwe-card' }, h('div', { class: 'body gwe-body' }, [U.note('crit', [h('strong', { text: t('gwe.load_failed') }), ' ', errText(err)]), h('div', null, retry)]));
  }
  function tooOld(sup) {
    return U.bigNote('warn', 'up', t('gwn.old.title', { min: sup.minGateway3b || '1.22.0' }), t('gwn.old.text', { version: sup.version || '—' }),
      [U.whatsNew(cur && cur.g)]);
  }
  function enableBtn(label, fk, run) {
    const b = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': fk }, [U.icon('power', 16), label]);
    b.addEventListener('click', () => { b.disabled = true; run().catch((e) => { b.disabled = false; D.alert({ message: errText(e), danger: true }); }); });
    return b;
  }
  function field(id, label, control, hint) {
    return h('div', { class: 'gwe-field' }, [h('label', { class: 'form-label', for: id, text: label }), control,
      hint ? h('span', { class: 'form-hint', id: id + '-hint', text: hint }) : null]);
  }
  function copyBtn(text, label) {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwh-copy', 'aria-label': t('gwh.copy_of', { what: label || text }) }, [icon('copy', 14), t('gwh.copy')]);
    b.addEventListener('click', () => {
      const done = () => U.toast(t('gwh.copied'));
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => D.alert({ message: text }));
        else D.alert({ message: text });
      } catch (_) { D.alert({ message: text }); }
    });
    return b;
  }
  function kpi(label, value, sub, tone) {
    return h('div', { class: 'gwn-kpi' + (tone ? ' gwn-kpi-' + tone : '') }, [
      h('span', { class: 'gwn-kpi-l', text: label }),
      h('span', { class: 'gwn-kpi-v' }, [value, sub ? h('span', { class: 'gwn-kpi-s', text: sub }) : null]),
    ]);
  }

  // ─── Settings ─────────────────────────────────────────────────────────
  function putDns(id, patch, okMsg) {
    return U.api('PUT', url(id, '/dns'), patch).then((j) => {
      if (okMsg) U.toast(okMsg);
      return reload('dns', id).then(() => j);
    });
  }
  function putCache(id, patch, okMsg) {
    return U.api('PUT', url(id, '/cache'), patch).then((j) => {
      if (okMsg) U.toast(okMsg);
      return reload('cache', id).then(() => j);
    });
  }
  function toggle(btn, run) {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.disabled = true;
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    return run(next).catch((e) => {
      btn.disabled = false;
      btn.setAttribute('aria-checked', next ? 'false' : 'true');
      D.alert({ message: errText(e), danger: true });
    });
  }

  // ═══ Tab "DNS-Filter" ═════════════════════════════════════════════════
  function dnsPanel(g, d) {
    const sup = d.gateway.support || {};
    const s = d.settings;
    const out = [];
    if (sup.dns === false) out.push(tooOld(sup));
    if (!s.enabled) {
      out.push(U.bigNote('grey', 'shield', t('gwh.dns.off_title'), t('gwh.dns.off_text'),
        [enableBtn(t('gwh.dns.enable'), 'gwh-dns-on', () => putDns(g.peer_id, { enabled: true }, t('gwh.dns.on_done')))]));
      if (homeNote(d)) out.push(homeNote(d));
      out.push(reserveNote());
      return out;
    }
    if (homeNote(d)) out.push(homeNote(d));
    out.push(statusCard(g, d));
    out.push(dnsKpis(d));
    out.push(h('div', { class: 'gwe-grid2 gwh-grid2' }, [profilesCard(g, d), topCard(g, d)]));
    out.push(privacyCard(g, d));
    out.push(reserveNote());
    return out;
  }

  // the other gateways of the home network (failover pool, same LAN): the settings hold for them as well
  function homeNote(d) {
    const home = (d.gateway && d.gateway.home) || [];
    if (!home.length) return null;
    return h('div', { class: 'gwh-foot-note', 'data-fk': 'gwh-home' }, U.note('info', [h('strong', { text: t('gwh.dns.home_b') }), ' ',
      t('gwh.dns.home', { gateways: home.map((x) => x.name).join(', ') })]));
  }

  function reserveNote() {
    return h('div', { class: 'gwh-foot-note' }, U.note('warn', [h('strong', { text: t('gwh.dns.reserve_b') }), ' ', t('gwh.dns.reserve')]));
  }

  function statePill(d) {
    const tel = d.gateway.telemetry;
    if (d.outage) return U.tag('red', t(d.outage.reason === 'port_busy' ? 'gwh.state.port_busy' : 'gwh.state.down'), true);
    if (!tel) return U.tag('grey', t('gwh.state.waiting'), true);
    if (tel.state === 'running') return U.tag('green', d.today.clients ? t('gwh.state.running_n', { n: d.today.clients }) : t('gwh.state.running'), true);
    if (tel.state === 'port_busy') return U.tag('red', t('gwh.state.port_busy'), true);
    if (tel.state === 'no_address') return U.tag('red', t('gwh.state.no_address'), true);
    if (tel.state === 'error') return U.tag('red', t('gwh.state.error'), true);
    if (tel.state === 'starting') return U.tag('grey', t('gwh.state.starting'), true);
    return U.tag('grey', t('gwh.state.off'), true);
  }

  function routerPill(d) {
    const st = d.router.state;
    if (st === 'ok') return U.tag('green', t('gwh.router.pill_ok'), true);
    if (st === 'partial') return U.tag('amber', t('gwh.router.pill_partial', { n: d.router.missingCount }), true);
    return U.tag('grey', t('gwh.router.pill_none'), true);
  }

  function statusCard(g, d) {
    const id = g.peer_id;
    const sw = U.switchBtn(true, t('gwh.dns.title'), 'gwh-dns-sw', async () => {
      if (!await D.confirm({ title: t('gwh.dns.off_q'), message: t('gwh.dns.off_msg'), okLabel: t('gwh.dns.off_ok'), danger: true })) return;
      toggle(sw, (v) => putDns(id, { enabled: v }, t('gwh.dns.off_done')));
    });
    const c = U.card(t('gwh.dns.title'), h('div', { class: 'gwh-head-r' }, [statePill(d), sw]), { id: 'dns-status', full: true, cls: 'gwh-status' });
    c.body.appendChild(h('p', { class: 'gwe-d gwh-lead' }, [t('gwh.dns.lead'), ' ', U.guide('feat.dns')]));
    const ip = d.addresses.v4[0] || d.gateway.lanIp;
    const guide = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-router' }, [icon('router', 15), t('gwh.router.open')]);
    guide.addEventListener('click', () => routerDialog(g));
    c.body.appendChild(h('div', { class: 'gwh-routerline' }, [
      h('span', { class: 'gwh-routerline-t' }, [t('gwh.dns.router_ip'), ' ', h('span', { class: 'gwe-mono gwh-ip', text: ip || '—' })]),
      routerPill(d), guide,
    ]));
    const tel = d.gateway.telemetry;
    if (d.outage && d.outage.reason === 'offline') c.body.appendChild(U.note('crit', [t('gwh.dns.down_offline', { since: clock(d.outage.since) })], 'warn'));
    if ((tel && tel.state === 'port_busy') || (d.outage && d.outage.reason === 'port_busy')) c.body.appendChild(U.note('crit', [h('strong', { text: t('gwh.dns.port_busy_b') }), ' ', t('gwh.dns.port_busy'), ' ', U.guide('faq.dns_port53')], 'warn'));
    else if (tel && tel.state === 'no_address') c.body.appendChild(U.note('crit', [t('gwh.dns.no_address')], 'warn'));
    else if (tel && tel.state === 'error' && tel.lastError) c.body.appendChild(U.note('warn', [t('gwh.dns.error', { error: tel.lastError.message })]));
    if (!tel && (d.gateway.support || {}).dns !== false) c.body.appendChild(U.note('info', [t('gwh.dns.waiting')]));
    if (d.paused && d.paused.length) {
      c.body.appendChild(h('div', { class: 'gwh-chips' }, d.paused.map((p) => U.tag(p.kind === 'pause' ? 'amber' : 'green',
        t(p.kind === 'pause' ? 'gwh.paused' : 'gwh.extended', { name: p.name, time: clock(p.until) })))));
    }
    return c.card;
  }

  function dnsKpis(d) {
    const td = d.today;
    return h('div', { class: 'gwn-kpis', role: 'group', 'aria-label': t('gwh.kpi.label') }, [
      kpi(t('gwh.kpi.queries'), nf(td.queries)),
      kpi(t('gwh.kpi.blocked'), td.blockedPct == null ? '—' : nf(td.blockedPct, 1) + ' %', td.blocked ? nf(td.blocked) : null),
      kpi(t('gwh.kpi.ms'), td.avgMs == null ? '—' : nf(td.avgMs, td.avgMs < 10 ? 1 : 0) + ' ms'),
      kpi(t('gwh.kpi.cached'), td.cachedPct == null ? '—' : nf(td.cachedPct, 1) + ' %'),
    ]);
  }

  function listName(id) { return has('gwh.list.' + id + '.name') ? t('gwh.list.' + id + '.name') : id; }

  function profileSummary(p, i, d) {
    const parts = [];
    if (i === 0) parts.push(t('gwh.prof.default_who'));
    else {
      const who = p.people.map((x) => x.name);
      if (who.length) parts.push(who.join(', '));
      parts.push(t(p.deviceCount === 1 ? 'gwh.prof.device_1' : 'gwh.prof.devices_n', { n: p.deviceCount }));
    }
    const what = p.lists.map(listName);
    if (p.safeSearch) what.push(t('gwh.prof.safesearch_short'));
    parts.push(what.length ? what.join(', ') : t('gwh.prof.nothing'));
    if (p.schedules.length) parts.push(t('gwh.prof.times', { first: scheduleTitle(p.schedules[0]) }) + (p.schedules.length > 1 ? ' ' + t('gwh.prof.times_more', { n: p.schedules.length - 1 }) : ''));
    void d;
    return parts.join(' · ');
  }

  function profilesCard(g, d) {
    const add = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-prof-new' }, [U.icon('plus', 15), t('gwh.prof.new')]);
    add.addEventListener('click', () => profileDialog(g, d, null));
    const c = U.card(t('gwh.prof.title'), add, { id: 'dns-prof' });
    d.profiles.forEach((p, i) => {
      const edit = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-prof:' + p.id, 'aria-label': t('gwh.prof.edit_of', { name: p.name }) }, [icon('edit', 14), t('gwh.prof.edit')]);
      edit.addEventListener('click', () => profileDialog(g, d, p));
      const pills = (p.paused || []).map((x) => U.tag(x.kind === 'pause' ? 'amber' : 'green', t(x.kind === 'pause' ? 'gwh.paused' : 'gwh.extended', { name: x.name, time: clock(x.until) })));
      c.body.appendChild(h('div', { class: 'gwh-prof', 'data-profile': p.id }, [
        h('div', { class: 'gwh-prof-t' }, [h('strong', { text: p.name }), h('span', { class: 'gwe-d', text: profileSummary(p, i, d) })]),
        ...pills, edit,
      ]));
    });
    return c.card;
  }

  function topCard(g, d) {
    const c = U.card(t('gwh.top.title'), null, { id: 'dns-top' });
    if (!d.top.length) c.body.appendChild(h('p', { class: 'gwe-empty', text: t('gwh.top.empty') }));
    d.top.forEach((x) => {
      c.body.appendChild(h('div', { class: 'gwh-li' }, [
        h('span', { class: 'gwe-mono gwh-dom', text: x.domain }),
        h('span', { class: 'gwe-d', text: nf(x.count) + (x.profileName && x.profileId !== 'default' ? ' · ' + t('gwh.top.profile', { name: x.profileName }) : '') }),
      ]));
    });
    const ex = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-allow' }, [U.icon('check', 15), t('gwh.allow.open')]);
    ex.addEventListener('click', () => allowDialog(g, d));
    const tb = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-test' }, [icon('search', 15), t('gwh.test.open')]);
    tb.addEventListener('click', () => testDialog(g, d));
    c.body.appendChild(h('div', { class: 'gwh-li gwh-li-foot' }, [h('span', { class: 'gwe-d gwh-grow', text: t('gwh.top.hint') }), h('div', { class: 'gwe-actions' }, [ex, tb])]));
    return c.card;
  }

  function providerLabel(s) {
    if (s.upstream.provider === 'custom') return t('gwh.up.custom_short', { url: s.upstream.url || '—' });
    return t('gwh.up.provider.' + s.upstream.provider);
  }

  function privacyCard(g, d) {
    const id = g.peer_id;
    const s = d.settings;
    const c = U.card(t('gwh.priv.title'), null, { id: 'dns-priv', full: true, cls: 'gwn-rows' });
    const sw = U.switchBtn(s.logQueries, t('gwh.priv.log'), 'gwh-log', () => toggle(sw, (v) => putDns(id, { logQueries: v }, t('gwn.feat.saved'))));
    c.body.appendChild(h('div', { class: 'gwh-row' }, [
      h('div', { class: 'gwh-row-t' }, [h('strong', { text: t('gwh.priv.log') }), h('span', { class: 'gwe-d', text: t(s.logQueries ? 'gwh.priv.log_on' : 'gwh.priv.log_off') })]), sw,
    ]));
    const change = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwh-up', text: t('gwh.priv.change') });
    change.addEventListener('click', () => upstreamDialog(g, d));
    c.body.appendChild(h('div', { class: 'gwh-row' }, [
      h('div', { class: 'gwh-row-t' }, [h('strong', { text: t('gwh.priv.forward') }),
        h('span', { class: 'gwe-d', text: t('gwh.priv.forward_d', { provider: providerLabel(s) }) + (s.upstream.fallbackRouter ? ' · ' + t('gwh.priv.fallback') : '') })]), change,
    ]));
    return c.card;
  }

  // ─── Dialog "Router einstellen" ───────────────────────────────────────
  const ROUTER_STEPS = {
    fritzbox: ['s1', 's2', { key: 's3', ip: 'v4' }, { key: 's4', ip: 'v6' }, 's5'],
    speedport: ['s1', { key: 's2', ip: 'v4' }, { key: 's3', ip: 'v4' }, 's4'],
    vodafone: [{ key: 's1', ip: 'v4' }, 's2', 's3'],
    other: ['s1', { key: 's2', ip: 'v4' }, 's3', { key: 's4', ip: 'v6' }, 's5'],
  };
  let lastRouter = 'fritzbox';
  try { const r = localStorage.getItem('gc-gwh-router'); if (K.ROUTERS.indexOf(r) >= 0) lastRouter = r; } catch (_) { /* no storage */ }

  function routerDialog(g) {
    const dlg = U.openDialog({ title: t('gwh.router.title'), wide: true, cls: 'gwh-routerdlg', returnFk: 'gwh-router' });
    const sel = h('select', { id: 'gwh-r-type', class: 'form-select' }, K.ROUTERS.map((r) => h('option', { value: r, text: t('gwh.router.type.' + r) })));
    sel.value = lastRouter;
    const steps = h('ol', { class: 'gwh-steps' });
    const pre = h('div');
    const check = h('div', { class: 'gwh-check', role: 'status', 'aria-live': 'polite' });
    dlg.body.append(field('gwh-r-type', t('gwh.router.yours'), sel), pre, steps,
      h('h4', { class: 'gwh-h4', text: t('gwh.router.check') }), check,
      h('p', { class: 'gwe-d' }, [t('gwh.router.undo'), ' ', U.guide('feat.dns')]));
    function addrRow(kind, d) {
      const v4 = d.addresses.v4[0] || d.gateway.lanIp;
      const v6 = K.pickV6(d.addresses.v6);
      const ip = kind === 'v6' ? v6 : v4;
      if (!ip) return null;
      return h('span', { class: 'gwh-addr' }, [h('span', { class: 'gwe-mono gwh-ip', text: ip }), copyBtn(ip, ip)]);
    }
    function fill() {
      const d = entry('dns', g.peer_id).data;
      if (!d) return;
      const type = sel.value;
      const v6 = K.pickV6(d.addresses.v6);
      pre.replaceChildren(...(has('gwh.router.' + type + '.note') ? [U.note('info', [t('gwh.router.' + type + '.note')])] : []));
      steps.replaceChildren(...ROUTER_STEPS[type].map((s) => {
        const st = typeof s === 'string' ? { key: s } : s;
        const key = 'gwh.router.' + type + '.' + st.key + (st.ip === 'v6' && !v6 ? '_no6' : '');
        const li = h('li', null, [h('span', { text: t(key) })]);
        if (st.ip && !(st.ip === 'v6' && !v6)) {
          const a = addrRow(st.ip, d);
          if (a) li.appendChild(a);
          if (has(key + '_after')) li.appendChild(h('span', { text: ' ' + t(key + '_after') }));
        }
        return li;
      }));
      const rc = K.routerCheck(d);
      const line = (tone, text) => h('div', { class: 'gwh-ck gwh-ck-' + tone }, [h('span', { class: 'gwh-ck-i' }, icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'x' : tone === 'warn' ? 'info' : 'dot', 13)), h('span', { text })]);
      const rows = [];
      if (rc.answers === 'ok') rows.push(line('ok', t('gwh.router.ck_answers')));
      else if (rc.answers === 'busy') rows.push(line('bad', t('gwh.router.ck_busy')));
      else if (rc.answers === 'no') rows.push(line('bad', t('gwh.router.ck_not_running')));
      else rows.push(line('wait', t('gwh.router.ck_unknown')));
      rows.push(rc.asking ? line('ok', t(rc.asking === 1 ? 'gwh.router.ck_asking_1' : 'gwh.router.ck_asking', { n: rc.asking })) : line('wait', t('gwh.router.ck_asking_none')));
      if (rc.missingCount) {
        const names = rc.missing.slice(0, 3).map((x) => x.name || x.ip || '?');
        rows.push(line('warn', t(rc.missingCount === 1 ? 'gwh.router.ck_missing_1' : 'gwh.router.ck_missing', { n: rc.missingCount, names: names.join(', ') })));
      } else if (rc.asking) rows.push(line('ok', t('gwh.router.ck_all')));
      check.replaceChildren(...rows);
    }
    sel.addEventListener('change', () => { lastRouter = sel.value; try { localStorage.setItem('gc-gwh-router', sel.value); } catch (_) { /* no storage */ } fill(); });
    const again = h('button', { type: 'button', class: 'btn btn-ghost', text: t('gwh.router.again') });
    again.addEventListener('click', () => { again.disabled = true; load('dns', g.peer_id, true).then(fill, () => {}).finally(() => { again.disabled = false; }); });
    const done = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwh.router.done'), on: { click: () => dlg.close(true) } });
    dlg.foot.append(again, done);
    fill();
    sel.focus();
  }

  // ─── Dialog "Profil bearbeiten" ───────────────────────────────────────
  let people = null;
  function loadPeople() {
    if (people) return Promise.resolve(people);
    return U.api('GET', '/api/v1/principals').then((j) => { people = (j.users || []).map((u) => ({ id: u.id, label: u.label })); return people; });
  }

  function textArea(id, value, ph, hintId) {
    const ta = h('textarea', { id, class: 'form-input gwe-mono gwh-ta', rows: '3', spellcheck: 'false', autocomplete: 'off', placeholder: ph || '', 'aria-describedby': hintId || null });
    ta.value = (value || []).join('\n');
    return ta;
  }

  function scheduleEditor(x, onDone, onCancel, idx) {
    const pre = 'gwh-s' + idx + '-';
    const names = t('gwh.days.long').split(',');
    const shortNames = dayNames();
    const days = h('fieldset', { class: 'gwh-days' }, [h('legend', { class: 'form-label', text: t('gwh.sched.days') }),
      ...K.DAYS.map((n) => {
        const cb = h('input', { type: 'checkbox', id: pre + 'd' + n, value: String(n) });
        cb.checked = (x.days || []).indexOf(n) >= 0;
        return h('label', { class: 'gwh-day', for: pre + 'd' + n, title: names[n - 1] }, [cb, h('span', { text: shortNames[n - 1], 'aria-hidden': 'true' }), h('span', { class: 'sr-only', text: names[n - 1] })]);
      })]);
    // the whole day is stored as 00:00–24:00 — a time field cannot show 24:00
    const whole = h('input', { type: 'checkbox', id: pre + 'whole' });
    whole.checked = K.allDay(x);
    const from = h('input', { type: 'time', id: pre + 'from', class: 'form-input gwh-time', value: whole.checked ? '21:00' : x.from || '21:00' });
    const to = h('input', { type: 'time', id: pre + 'to', class: 'form-input gwh-time', value: whole.checked ? '07:00' : x.to || '07:00' });
    const times = h('div', { class: 'gwh-times' }, [field(pre + 'from', t('gwh.sched.from'), from), field(pre + 'to', t('gwh.sched.to'), to)]);
    const overnight = h('p', { class: 'gwe-d gwh-overnight', 'aria-live': 'polite' });
    const syncNight = () => {
      times.hidden = whole.checked;
      overnight.textContent = whole.checked ? t('gwh.sched.all_day_hint') : from.value && to.value && to.value < from.value ? t('gwh.sched.overnight') : '';
    };
    from.addEventListener('input', syncNight); to.addEventListener('input', syncNight); whole.addEventListener('change', syncNight);
    const rAll = h('input', { type: 'radio', name: pre + 'block', id: pre + 'all', value: 'all' });
    const rCat = h('input', { type: 'radio', name: pre + 'block', id: pre + 'cat', value: 'categories' });
    (x.block === 'all' ? rAll : rCat).checked = true;
    const cats = K.CATEGORIES.map((c) => {
      const cb = h('input', { type: 'checkbox', id: pre + 'c-' + c, value: c });
      cb.checked = x.block === 'all' ? true : (x.categories || K.CATEGORIES).indexOf(c) >= 0;
      return { c, cb, label: h('label', { class: 'gwe-check gwh-sub', for: pre + 'c-' + c }, [cb, h('span', { text: t('gwh.cat.' + c) })]) };
    });
    const catBox = h('div', { class: 'gwh-cats' }, cats.map((x2) => x2.label));
    const syncBlock = () => { cats.forEach((x2) => { x2.cb.disabled = rAll.checked; }); };
    rAll.addEventListener('change', syncBlock); rCat.addEventListener('change', syncBlock);
    const allow = h('input', { type: 'text', id: pre + 'allow', class: 'form-input gwe-mono', autocomplete: 'off', spellcheck: 'false', value: (x.allowAlways || []).join(', '), placeholder: 'schulportal.de, anton.app' });
    const err = U.errorBox();
    const ok = h('button', { type: 'button', class: 'btn btn-primary btn-sm', text: t('gwh.sched.apply') });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: t('common.cancel'), on: { click: onCancel } });
    ok.addEventListener('click', () => {
      const ds = K.DAYS.filter((n) => days.querySelector('#' + pre + 'd' + n).checked);
      if (!ds.length) { U.showErr(err, t('gwh.sched.err_days')); return; }
      if (!whole.checked && (!/^\d\d:\d\d$/.test(from.value) || !/^\d\d:\d\d$/.test(to.value) || from.value === to.value)) { U.showErr(err, t('gwh.sched.err_time')); from.focus(); return; }
      const block = rAll.checked ? 'all' : 'categories';
      const cs = cats.filter((x2) => x2.cb.checked).map((x2) => x2.c);
      if (block === 'categories' && !cs.length) { U.showErr(err, t('gwh.sched.err_cats')); return; }
      onDone({ days: ds, from: whole.checked ? '00:00' : from.value, to: whole.checked ? '24:00' : to.value, block, categories: block === 'all' ? [] : cs, allowAlways: K.parsePatterns(allow.value) });
    });
    syncNight(); syncBlock();
    const box = h('div', { class: 'gwh-sched-ed', role: 'group', 'aria-label': t('gwh.sched.edit') }, [
      days,
      h('label', { class: 'gwe-check', for: pre + 'whole' }, [whole, h('span', { text: t('gwh.sched.all_day_pick') })]),
      times,
      overnight,
      h('fieldset', { class: 'gwh-block' }, [h('legend', { class: 'form-label', text: t('gwh.sched.block') }),
        h('label', { class: 'gwe-check', for: pre + 'cat' }, [rCat, h('span', { text: t('gwh.sched.block_cats') })]), catBox,
        h('label', { class: 'gwe-check', for: pre + 'all' }, [rAll, h('span', { text: t('gwh.sched.block_all') })])]),
      field(pre + 'allow', t('gwh.sched.allow'), allow, t('gwh.sched.allow_hint')),
      err,
      h('div', { class: 'gwe-actions' }, [cancel, ok]),
    ]);
    setTimeout(() => { const f = days.querySelector('input'); if (f) f.focus(); }, 0);
    return box;
  }

  function scheduleText(x) {
    const what = x.block === 'all' ? t('gwh.sched.all_off') : t('gwh.sched.cats_off', { cats: joinAnd(catNames(x.categories)) });
    const allow = x.allowAlways && x.allowAlways.length ? ' · ' + t('gwh.sched.allowed', { list: x.allowAlways.slice(0, 3).join(', ') + (x.allowAlways.length > 3 ? ' …' : '') }) : '';
    return what + allow + ' · ' + t('gwh.sched.gc_ok');
  }

  function profileDialog(g, d, p0) {
    const isNew = !p0;
    const isDefault = p0 && p0.id === 'default';
    const p = p0 ? JSON.parse(JSON.stringify(p0)) : { name: '', lists: d.catalog.lists.filter((l) => l.defaultOn).map((l) => l.id), safeSearch: false, allow: [], deny: [], schedules: [], users: [], devices: [] };
    const dlg = U.openDialog({ title: isNew ? t('gwh.pd.new_title') : t('gwh.pd.title', { name: p.name }), wide: true, cls: 'gwh-profdlg', returnFk: isNew ? 'gwh-prof-new' : 'gwh-prof:' + p.id });
    const name = h('input', { type: 'text', id: 'gwh-p-name', class: 'form-input', maxLength: 40, autocomplete: 'off', value: p.name || '', placeholder: t('gwh.pd.name_ph') });
    dlg.body.appendChild(field('gwh-p-name', t('gwh.pd.name'), name));

    // who
    const who = h('div', { class: 'gwh-sec' }, [h('span', { class: 'gwh-lab', id: 'gwh-p-who', text: t('gwh.pd.who') })]);
    const chips = h('div', { class: 'gwh-chips', 'aria-labelledby': 'gwh-p-who' });
    const picker = h('div', { class: 'gwh-picker' });
    picker.hidden = true;
    const deviceById = new Map(d.devices.map((x) => [x.id, x]));
    function drawChips() {
      const list = [];
      p.users.forEach((u) => {
        const n = d.devices.filter((x) => x.ownerUserId === u).length;
        const pn = (people || []).find((x) => x.id === u);
        const known = (d.profiles.flatMap((q) => q.people) || []).find((x) => x.id === u);
        list.push(U.chip('ok', t(n === 1 ? 'gwh.pd.person_1' : 'gwh.pd.person_n', { name: (pn && pn.label) || (known && known.name) || ('#' + u), n })));
      });
      p.devices.forEach((id) => { const x = deviceById.get(id); if (x) list.push(U.chip(null, x.name || x.ip || x.mac, 'list')); });
      chips.replaceChildren(...(list.length ? list : [h('span', { class: 'gwe-d', text: t('gwh.pd.nobody') })]));
    }
    const pick = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-expanded': 'false', 'aria-controls': 'gwh-p-picker', text: t('gwh.pd.pick') });
    picker.id = 'gwh-p-picker';
    pick.addEventListener('click', () => {
      const open = picker.hidden;
      picker.hidden = !open;
      pick.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) drawPicker();
    });
    function drawPicker() {
      const ppl = h('fieldset', { class: 'gwh-pick-col' }, [h('legend', { class: 'form-label', text: t('gwh.pd.people') }), h('p', { class: 'gwe-loading', text: t('gwe.loading') })]);
      const devs = h('fieldset', { class: 'gwh-pick-col' }, [h('legend', { class: 'form-label', text: t('gwh.pd.devices') })]);
      if (!d.devices.length) devs.appendChild(h('p', { class: 'gwe-d', text: t('gwh.pd.no_devices') }));
      d.devices.forEach((x) => {
        const cb = h('input', { type: 'checkbox', id: 'gwh-pd-d' + x.id });
        cb.checked = p.devices.indexOf(x.id) >= 0;
        cb.addEventListener('change', () => { p.devices = cb.checked ? p.devices.concat([x.id]) : p.devices.filter((v) => v !== x.id); drawChips(); });
        devs.appendChild(h('label', { class: 'gwe-check gwh-sub', for: 'gwh-pd-d' + x.id }, [cb, h('span', null, [x.name || x.ip || x.mac,
          x.ownerName ? h('span', { class: 'gwe-d', text: ' · ' + x.ownerName }) : null])]));
      });
      picker.replaceChildren(h('div', { class: 'gwh-pick' }, [ppl, devs]));
      loadPeople().then((list) => {
        ppl.replaceChildren(h('legend', { class: 'form-label', text: t('gwh.pd.people') }), ...list.map((u) => {
          const cb = h('input', { type: 'checkbox', id: 'gwh-pd-u' + u.id });
          cb.checked = p.users.indexOf(u.id) >= 0;
          cb.addEventListener('change', () => { p.users = cb.checked ? p.users.concat([u.id]) : p.users.filter((v) => v !== u.id); drawChips(); });
          const n = d.devices.filter((x) => x.ownerUserId === u.id).length;
          return h('label', { class: 'gwe-check gwh-sub', for: 'gwh-pd-u' + u.id }, [cb, h('span', null, [u.label, h('span', { class: 'gwe-d', text: ' · ' + t(n === 1 ? 'gwh.prof.device_1' : 'gwh.prof.devices_n', { n }) })])]);
        }));
        drawChips();
      }, () => { ppl.replaceChildren(h('legend', { class: 'form-label', text: t('gwh.pd.people') }), h('p', { class: 'gwe-d', text: t('gwe.load_failed') })); });
    }
    if (isDefault) who.appendChild(h('p', { class: 'gwe-d', text: t('gwh.pd.default_who') }));
    else {
      who.append(h('div', { class: 'gwh-who' }, [chips, pick]), picker, h('span', { class: 'gwe-d', text: t('gwh.pd.who_hint') }));
      drawChips();
      if (p.users.length) loadPeople().then(drawChips, () => {});
    }
    dlg.body.appendChild(who);

    // lists
    const lists = h('fieldset', { class: 'gwh-sec gwh-lists' }, [h('legend', { class: 'gwh-lab', text: t('gwh.pd.lists') })]);
    const listBoxes = d.catalog.lists.map((l) => {
      const cb = h('input', { type: 'checkbox', id: 'gwh-pl-' + l.id, 'aria-describedby': 'gwh-pl-' + l.id + '-d' });
      cb.checked = p.lists.indexOf(l.id) >= 0;
      lists.appendChild(h('label', { class: 'gwe-check gwh-chk', for: 'gwh-pl-' + l.id }, [cb, h('span', null, [
        h('strong', { text: listName(l.id) }), h('br'),
        h('span', { class: 'gwe-d', id: 'gwh-pl-' + l.id + '-d', text: (has('gwh.list.' + l.id + '.desc') ? t('gwh.list.' + l.id + '.desc') + ' · ' : '')
          + t('gwh.pd.source', { source: l.source, license: l.license, n: nf(l.entries) }) }),
      ])]));
      return { id: l.id, cb };
    });
    const safe = h('input', { type: 'checkbox', id: 'gwh-p-safe' });
    safe.checked = !!p.safeSearch;
    lists.appendChild(h('label', { class: 'gwe-check gwh-chk', for: 'gwh-p-safe' }, [safe, h('span', null, [h('strong', { text: t('gwh.pd.safe') }), h('br'), h('span', { class: 'gwe-d', text: t('gwh.pd.safe_d') })])]));
    lists.appendChild(h('p', { class: 'gwe-d', text: t('gwh.pd.mem', { mb: K.dnsMemMb(d.profiles.filter((q) => !p0 || q.id !== p0.id).concat([{ lists: p.lists }]), d.catalog.lists) }) }));
    dlg.body.appendChild(lists);

    // times
    const times = h('div', { class: 'gwh-sec' }, [h('span', { class: 'gwh-lab', id: 'gwh-p-times', text: t('gwh.pd.times') })]);
    const rules = h('div', { class: 'gwh-rules', 'aria-labelledby': 'gwh-p-times' });
    const addTime = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwh-addtime' }, [U.icon('plus', 14), t('gwh.pd.add_time')]);
    let editing = -1;
    function drawRules() {
      const out = p.schedules.map((x, i) => {
        if (editing === i) {
          return scheduleEditor(x, (nx) => { p.schedules[i] = nx; editing = -1; drawRules(); }, () => { editing = -1; drawRules(); }, i);
        }
        const ch = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': t('gwh.pd.time_change', { what: scheduleTitle(x) }), text: t('gwh.prof.change') });
        ch.addEventListener('click', () => { editing = i; drawRules(); });
        const rm = h('button', { type: 'button', class: 'icon-action danger', 'aria-label': t('gwh.pd.time_remove', { what: scheduleTitle(x) }), title: t('gwh.pd.time_remove', { what: scheduleTitle(x) }) }, U.icon('trash', 15));
        rm.addEventListener('click', () => { p.schedules.splice(i, 1); drawRules(); addTime.focus(); });
        return h('div', { class: 'gwh-rule' }, [h('div', { class: 'gwh-prof-t' }, [h('strong', { text: scheduleTitle(x) }), h('span', { class: 'gwe-d', text: scheduleText(x) })]), ch, rm]);
      });
      if (editing === p.schedules.length) {
        out.push(scheduleEditor({ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: K.CATEGORIES.slice(), allowAlways: [] },
          (nx) => { p.schedules.push(nx); editing = -1; drawRules(); }, () => { editing = -1; drawRules(); addTime.focus(); }, 'n'));
      }
      if (!out.length) out.push(h('p', { class: 'gwe-d', text: t('gwh.pd.no_times') }));
      rules.replaceChildren(...out);
      addTime.hidden = editing >= 0 || p.schedules.length >= 12;
    }
    addTime.addEventListener('click', () => { editing = p.schedules.length; drawRules(); });
    times.append(rules, addTime, h('span', { class: 'gwe-d', text: t('gwh.pd.times_hint', { tz: d.timezone }) }));
    dlg.body.appendChild(times);
    drawRules();

    // own exceptions
    const allow = textArea('gwh-p-allow', p.allow, 'anton.app\n*.schulportal.hessen.de', 'gwh-p-ex-hint');
    const deny = textArea('gwh-p-deny', p.deny, 'example.com', 'gwh-p-ex-hint');
    dlg.body.appendChild(h('div', { class: 'gwh-sec' }, [h('span', { class: 'gwh-lab', text: t('gwh.pd.own') }),
      h('div', { class: 'gwe-grid2 gwe-grid2-tight' }, [field('gwh-p-allow', t('gwh.pd.allow'), allow), field('gwh-p-deny', t('gwh.pd.deny'), deny)]),
      h('span', { class: 'form-hint', id: 'gwh-p-ex-hint', text: t('gwh.pd.own_hint') })]));
    dlg.body.appendChild(U.note('info', [t('gwh.pd.bypass')]));
    const err = U.errorBox();
    dlg.body.appendChild(err);

    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.save') });
    ok.addEventListener('click', () => {
      if (editing >= 0) { U.showErr(err, t('gwh.pd.err_editing')); return; }
      const nm = name.value.trim();
      if (!nm) { U.showErr(err, t('gwh.err.invalid_name')); name.focus(); return; }
      const body = {
        name: nm, lists: listBoxes.filter((x) => x.cb.checked).map((x) => x.id), safeSearch: safe.checked,
        allow: K.parsePatterns(allow.value), deny: K.parsePatterns(deny.value), schedules: p.schedules,
      };
      if (!isDefault) { body.users = p.users; body.devices = p.devices; }
      ok.disabled = true;
      U.showErr(err, '');
      const req = isNew ? U.api('POST', url(g.peer_id, '/dns/profiles'), body) : U.api('PUT', url(g.peer_id, '/dns/profiles/' + encodeURIComponent(p.id)), body);
      req.then(() => { dlg.close(true); U.toast(t('gwh.pd.saved', { name: nm })); reload('dns', g.peer_id); })
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    dlg.foot.classList.add('gwn-foot-split');
    const right = h('div', { class: 'gwn-foot-r' }, [cancel, ok]);
    if (!isNew && !isDefault) {
      const del = h('button', { type: 'button', class: 'btn btn-ghost gwn-forget', text: t('gwh.pd.delete') });
      del.addEventListener('click', async () => {
        if (!await D.confirm({ title: t('gwh.pd.delete_q', { name: p.name }), message: t('gwh.pd.delete_msg'), okLabel: t('gwh.pd.delete'), danger: true })) return;
        U.api('DELETE', url(g.peer_id, '/dns/profiles/' + encodeURIComponent(p.id)))
          .then(() => { dlg.close(true); U.toast(t('gwh.pd.deleted', { name: p.name })); reload('dns', g.peer_id); })
          .catch((e) => U.showErr(err, errText(e)));
      });
      dlg.foot.append(del, right);
    } else dlg.foot.append(right);
    name.focus();
  }

  // ─── Dialogs: exceptions, test, forwarding ────────────────────────────
  function allowDialog(g, d) {
    const dlg = U.openDialog({ title: t('gwh.allow.title'), wide: true, cls: 'gwh-allowdlg', returnFk: 'gwh-allow' });
    const ta = textArea('gwh-a-list', d.settings.allowAll, 'example.com', 'gwh-a-hint');
    ta.rows = 6;
    dlg.body.append(h('p', { class: 'gwe-intro', text: t('gwh.allow.intro') }), field('gwh-a-list', t('gwh.allow.label'), ta),
      h('span', { class: 'form-hint', id: 'gwh-a-hint', text: t('gwh.pd.own_hint') }));
    if (d.top.length) {
      const box = h('div', { class: 'gwh-quick', role: 'group', 'aria-label': t('gwh.allow.from_top') }, [h('span', { class: 'gwh-lab', text: t('gwh.allow.from_top') })]);
      d.top.slice(0, 8).forEach((x) => {
        const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwe-mono', 'aria-label': t('gwh.allow.add_of', { domain: x.domain }) }, [U.icon('plus', 13), x.domain]);
        b.addEventListener('click', () => {
          const cur0 = K.parsePatterns(ta.value);
          if (cur0.indexOf(x.domain) < 0) ta.value = cur0.concat([x.domain]).join('\n');
          b.disabled = true;
        });
        box.appendChild(b);
      });
      dlg.body.appendChild(box);
    }
    const err = U.errorBox();
    dlg.body.appendChild(err);
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.save') });
    ok.addEventListener('click', () => {
      ok.disabled = true;
      U.api('PUT', url(g.peer_id, '/dns'), { allowAll: K.parsePatterns(ta.value) })
        .then(() => { dlg.close(true); U.toast(t('gwn.feat.saved')); reload('dns', g.peer_id); })
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    dlg.foot.append(cancel, ok);
    ta.focus();
  }

  // gateway side 13: why the gateway decided so (unknown codes as they come)
  function reasonText(r) {
    const key = 'gwh.reason.' + r.reason;
    if (!has(key)) return r.reason;
    return t(key, { list: r.list ? listName(r.list) : '—', category: r.category ? (has('gwh.cat.' + r.category) ? t('gwh.cat.' + r.category) : r.category) : '—' });
  }

  function testDialog(g, d) {
    const dlg = U.openDialog({ title: t('gwh.test.title'), wide: false, cls: 'gwh-testdlg', returnFk: 'gwh-test', onEnter: () => run() });
    const dom = h('input', { type: 'text', id: 'gwh-t-dom', class: 'form-input gwe-mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'tiktok.com', inputmode: 'url' });
    const dev = h('select', { id: 'gwh-t-dev', class: 'form-select' }, [h('option', { value: '', text: t('gwh.test.no_device') }),
      ...d.devices.map((x) => h('option', { value: String(x.id), text: (x.name || x.ip || x.mac) + (x.ownerName ? ' · ' + x.ownerName : '') }))]);
    const result = h('div', { class: 'gwh-result', role: 'status', 'aria-live': 'polite' });
    const err = U.errorBox();
    dlg.body.append(h('p', { class: 'gwe-intro', text: t('gwh.test.intro') }), field('gwh-t-dom', t('gwh.test.domain'), dom),
      field('gwh-t-dev', t('gwh.test.device'), dev, t('gwh.test.device_hint')), result, err);
    const close = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.close'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary' }, [icon('search', 15), t('gwh.test.run')]);
    function run() {
      const v = K.parsePatterns(dom.value)[0];
      if (!v) { U.showErr(err, t('gwh.err.invalid_domain', { value: dom.value })); dom.focus(); return; }
      ok.disabled = true;
      U.showErr(err, '');
      result.replaceChildren(h('span', { class: 'gwe-loading', text: t('gwh.test.running') }));
      U.api('POST', url(g.peer_id, '/dns/test'), { domain: v, ...(dev.value ? { deviceId: Number(dev.value) } : {}) }).then((j) => {
        const r = j.result;
        result.replaceChildren(U.note(r.action === 'block' ? 'warn' : 'info', [
          h('strong', { text: t(r.action === 'block' ? 'gwh.test.blocked' : 'gwh.test.allowed', { domain: r.domain }) }), ' ',
          r.profileName ? t('gwh.test.profile', { name: r.profileName }) : '', r.reason ? ' ' + t('gwh.test.reason', { reason: reasonText(r) }) : '',
        ], r.action === 'block' ? 'shield' : 'check'));
      }).catch((e) => { result.replaceChildren(); U.showErr(err, errText(e)); }).finally(() => { ok.disabled = false; });
    }
    ok.addEventListener('click', run);
    dlg.foot.append(close, ok);
    dom.focus();
  }

  function upstreamDialog(g, d) {
    const s = d.settings;
    const dlg = U.openDialog({ title: t('gwh.up.title'), wide: false, cls: 'gwh-updlg', returnFk: 'gwh-up' });
    const radios = d.catalog.providers.map((p) => {
      const r = h('input', { type: 'radio', name: 'gwh-up-p', id: 'gwh-up-' + p.id, value: p.id });
      r.checked = s.upstream.provider === p.id;
      return { p, r };
    });
    const urlIn = h('input', { type: 'url', id: 'gwh-up-url', class: 'form-input gwe-mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://dns.example/dns-query', value: s.upstream.url || '', 'aria-describedby': 'gwh-up-url-hint' });
    const fb = h('input', { type: 'checkbox', id: 'gwh-up-fb' });
    fb.checked = s.upstream.fallbackRouter;
    const sync = () => { urlIn.disabled = !radios.find((x) => x.p.id === 'custom').r.checked; };
    radios.forEach((x) => x.r.addEventListener('change', sync));
    const err = U.errorBox();
    dlg.body.append(
      h('p', { class: 'gwe-intro', text: t('gwh.up.intro') }),
      h('fieldset', { class: 'gwh-sec' }, [h('legend', { class: 'gwh-lab', text: t('gwh.up.provider') }),
        ...radios.map((x) => h('label', { class: 'gwe-check gwh-chk', for: 'gwh-up-' + x.p.id }, [x.r, h('span', null, [h('strong', { text: t('gwh.up.provider.' + x.p.id) }),
          has('gwh.up.desc.' + x.p.id) ? h('span', { class: 'gwe-d', text: ' · ' + t('gwh.up.desc.' + x.p.id) }) : null])]))]),
      field('gwh-up-url', t('gwh.up.url'), urlIn, t('gwh.up.url_hint')),
      h('label', { class: 'gwe-check gwh-chk', for: 'gwh-up-fb' }, [fb, h('span', null, [h('strong', { text: t('gwh.up.fallback') }), h('br'), h('span', { class: 'gwe-d', text: t('gwh.up.fallback_d') })])]),
      err);
    sync();
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.save') });
    ok.addEventListener('click', () => {
      const prov = (radios.find((x) => x.r.checked) || radios[0]).p.id;
      const body = { upstream: { provider: prov, fallbackRouter: fb.checked, ...(prov === 'custom' ? { url: urlIn.value.trim() } : {}) } };
      if (prov === 'custom' && !/^https:\/\/[^\s/]+/.test(urlIn.value.trim())) { U.showErr(err, t('gwh.err.invalid_url')); urlIn.focus(); return; }
      ok.disabled = true;
      U.api('PUT', url(g.peer_id, '/dns'), body)
        .then(() => { dlg.close(true); U.toast(t('gwn.feat.saved')); reload('dns', g.peer_id); })
        .catch((e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    dlg.foot.append(cancel, ok);
    const first = radios.find((x) => x.r.checked) || radios[0];
    first.r.focus();
  }

  // ═══ Tab "Zwischenspeicher" ═══════════════════════════════════════════
  function cachePanel(g, d) {
    const sup = d.gateway.support || {};
    const s = d.settings;
    const out = [];
    if (sup.cache === false) out.push(tooOld(sup));
    if (!s.enabled) {
      out.push(U.bigNote('grey', 'power', t('gwh.cache.off_title'), t('gwh.cache.off_text'),
        [enableBtn(t('gwh.cache.enable'), 'gwh-cache-on', () => putCache(g.peer_id, { enabled: true }, t('gwh.cache.on_done')))]));
      if (d.pi) out.push(piNote(d));
      return out;
    }
    out.push(cacheStatus(g, d));
    out.push(cacheKpis(d));
    out.push(h('div', { class: 'gwe-grid2 gwh-grid2' }, [kindsCard(g, d), storageCard(g, d)]));
    if (d.pi) out.push(piNote(d));
    return out;
  }

  function piNote(d) {
    const s = d.suggestion;
    return h('div', { class: 'gwh-foot-note' }, U.note('info', [h('strong', { text: t('gwh.cache.pi_b') }), ' ', t('gwh.cache.pi'),
      s && s.removable ? ' ' + t('gwh.cache.pi_found', { mount: s.mount, free: bytes(s.freeBytes), dir: s.hostDir }) : ' ' + t('gwh.cache.pi_none')]));
  }

  function cacheStatus(g, d) {
    const id = g.peer_id;
    const st = d.state;
    // gateway side 18: running | starting | port_busy | no_address | path_unwritable | path_not_allowed | no_secret | error
    const bad = st && st.state && st.state !== 'running' && st.state !== 'starting' && st.state !== 'off';
    const pill = !st ? U.tag('grey', t('gwh.cstate.waiting'), true)
      : bad ? U.tag('red', has('gwh.cstate.' + st.state) ? t('gwh.cstate.' + st.state) : t('gwh.cstate.error'), true)
        : st.error ? U.tag('red', t('gwh.cstate.error'), true)
          : st.running ? U.tag('green', t('gwh.cstate.running'), true) : U.tag('grey', t('gwh.cstate.starting'), true);
    const sw = U.switchBtn(true, t('gwh.cache.title'), 'gwh-cache-sw', async () => {
      if (!await D.confirm({ title: t('gwh.cache.off_q'), message: t('gwh.cache.off_msg'), okLabel: t('gwh.cache.off_ok') })) return;
      toggle(sw, (v) => putCache(id, { enabled: v }, t('gwh.cache.off_done')));
    });
    const c = U.card(t('gwh.cache.title'), h('div', { class: 'gwh-head-r' }, [pill, sw]), { id: 'cache-status', full: true });
    c.body.appendChild(h('p', { class: 'gwe-d gwh-lead' }, [t('gwh.cache.lead'), ' ', U.guide('feat.cache')]));
    if (bad && has('gwh.cache.st_' + st.state)) c.body.appendChild(U.note('crit', [t('gwh.cache.st_' + st.state, { setting: d.hostSetting }), st.state === 'path_unwritable' ? ' ' : null, st.state === 'path_unwritable' ? U.guide('faq.cache_unwritable') : null], 'warn'));
    else if (st && st.error) c.body.appendChild(U.note('warn', [t('gwh.cache.error', { error: st.error })]));
    else if (!st && (d.gateway.support || {}).cache !== false) c.body.appendChild(U.note('info', [t('gwh.cache.waiting')]));
    else if (st && st.running && (!st.pinned || !st.reachable)) c.body.appendChild(U.note('info', [t('gwh.cache.no_pin')]));
    return c.card;
  }

  function cacheKpis(d) {
    const u = d.usage;
    return h('div', { class: 'gwn-kpis', role: 'group', 'aria-label': t('gwh.kpi.label') }, [
      kpi(t('gwh.ckpi.used'), u.usedBytes == null ? '—' : bytes(u.usedBytes), t('gwh.ckpi.of', { max: K.gibLabel(u.maxBytes) })),
      kpi(t('gwh.ckpi.hit'), d.today.hitPct == null ? '—' : nf(d.today.hitPct, 0) + ' %'),
      kpi(t('gwh.ckpi.saved'), bytes(d.today.bytesServed)),
      kpi(t('gwh.ckpi.faster'), d.speedup ? '≈ ' + nf(d.speedup, d.speedup < 10 ? 1 : 0) + '×' : '—', d.speedup ? null : t('gwh.ckpi.faster_none'), d.speedup ? null : 'small'),
    ]);
  }

  function kindsCard(g, d) {
    const id = g.peer_id;
    const c = U.card(t('gwh.kinds.title'), null, { id: 'cache-kinds', cls: 'gwn-rows' });
    K.KINDS.forEach((k) => {
      const on = !!d.settings.kinds[k];
      const sw = U.switchBtn(on, t('gwh.kinds.' + k), 'gwh-k-' + k, () => toggle(sw, (v) => putCache(id, { kinds: { [k]: v } }, t('gwn.feat.saved'))));
      const kd = d.kinds[k] || { bytes: 0, count: 0 };
      const size = on && kd.count ? ' · ' + t(kd.count === 1 ? 'gwh.kinds.have_1' : 'gwh.kinds.have', { size: bytes(kd.bytes), n: nf(kd.count) }) : '';
      c.body.appendChild(h('div', { class: 'gwh-row', 'data-kind': k }, [
        h('div', { class: 'gwh-row-t' }, [h('strong', { text: t('gwh.kinds.' + k) }), h('span', { class: 'gwe-d', text: t('gwh.kinds.' + k + '_d') + size })]), sw,
      ]));
    });
    return c.card;
  }

  function storageCard(g, d) {
    const id = g.peer_id;
    const s = d.settings;
    const c = U.card(t('gwh.store.title'), null, { id: 'cache-store' });
    // the folder is the gateway's volume /cache; where it lies on the host is set at the gateway (gateway side 14)
    const nas = d.gateway.platform && /synology|qnap|docker|nas/i.test(d.gateway.platform);
    c.body.appendChild(h('div', { class: 'gwh-folder' }, [
      h('span', { class: 'form-label', text: t(nas ? 'gwh.store.folder_nas' : 'gwh.store.folder') }),
      h('p', { class: 'gwe-d', text: t(d.hostSetting === 'CACHE_DIR' ? 'gwh.store.folder_pi' : 'gwh.store.folder_docker') }),
    ]));
    if (d.suggestion) {
      const line = d.suggestion.setting + '=' + d.suggestion.hostDir;
      c.body.appendChild(U.note('info', [t(d.suggestion.removable ? 'gwh.store.sugg_usb' : 'gwh.store.sugg', { free: bytes(d.suggestion.freeBytes) }), ' ',
        h('span', { class: 'gwh-addr' }, [h('span', { class: 'gwe-mono gwh-ip', text: line }), copyBtn(line, d.suggestion.setting)])]));
    }
    const max = h('select', { id: 'gwh-c-max', class: 'form-select' }, d.sizes.map((b) => h('option', { value: String(b), text: K.gibLabel(b) })));
    if (d.sizes.indexOf(s.maxBytes) < 0) max.appendChild(h('option', { value: String(s.maxBytes), text: K.gibLabel(s.maxBytes) }));
    max.value = String(s.maxBytes);
    max.addEventListener('change', () => {
      max.disabled = true;
      putCache(id, { maxBytes: Number(max.value) }, t('gwn.feat.saved')).catch((e) => { max.disabled = false; D.alert({ message: errText(e), danger: true }); });
    });
    c.body.append(field('gwh-c-max', t('gwh.store.max'), max),
      h('p', { class: 'gwe-d', text: t('gwh.store.lru') + (d.freeBytes ? ' ' + t('gwh.store.free', { free: bytes(d.freeBytes) }) : '') }));
    const clear = h('button', { type: 'button', class: 'btn btn-ghost btn-sm gwn-forget', 'data-fk': 'gwh-c-clear', text: t('gwh.store.clear') });
    clear.addEventListener('click', async () => {
      if (!await D.confirm({ title: t('gwh.store.clear_q'), message: t('gwh.store.clear_msg'), okLabel: t('gwh.store.clear'), danger: true })) return;
      clear.disabled = true;
      U.api('POST', url(id, '/cache/clear'), {}).then(() => { U.toast(t('gwh.store.cleared')); reload('cache', id); })
        .catch((e) => { clear.disabled = false; D.alert({ message: errText(e), danger: true }); });
    });
    c.body.appendChild(h('div', null, clear));
    return c.card;
  }

  // ═══ Card "Funktionen dieses Gateways" ════════════════════════════════
  function featRow(title, text, control, extra, key) {
    return h('div', { class: 'gwn-fr', 'data-feature': key }, [
      h('div', { class: 'gwn-fr-t' }, [h('strong', { text: title }), h('span', { class: 'gwe-d' }, [text, ' ', U.guide('feat.' + key)]), ...(extra || [])]),
      control || null,
    ]);
  }

  /** Rows for the card: DNS filter, home cache, the gateway's local time. `changed(id)` reloads the card. */
  function featureRows(id, d, changed) {
    const rows = [];
    const sup = d.support || {};
    const link = (tab, key) => h('a', { href: '#gw/' + encodeURIComponent(String(id)) + '/' + tab, class: 'gwn-link', text: t(key) });
    const act = (kind, patch, okKey) => U.api('PUT', url(id, '/' + kind), patch).then(() => {
      U.toast(okKey);
      const e = entry(kind, id); e.at = 0;
      if (changed) changed(id);
    });
    if (d.dns) {
      const sw = U.switchBtn(!!d.dns.enabled, t('gwh.feat.dns'), 'gwh-f-dns', () => toggle(sw, (v) => act('dns', { enabled: v }, t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwh.feat.dns') }))));
      const extra = [];
      if (sup.dns === false) extra.push(h('span', { class: 'gwn-hint' }, [U.icon('info', 14), t('gwh.feat.too_old', { min: sup.minGateway3b || '1.22.0' })]));
      if (d.dns.enabled && (d.dns.state === 'port_busy' || (d.dns.outage && d.dns.outage.reason === 'port_busy'))) extra.push(h('span', { class: 'gwn-hint' }, [U.icon('warn', 14), t('gwh.feat.port_busy')]));
      extra.push(link('dns', 'gwh.feat.to_dns'));
      rows.push(featRow(t('gwh.feat.dns'), t('gwh.feat.dns_d'), sw, extra, 'dns'));
    }
    if (d.cache) {
      const sw = U.switchBtn(!!d.cache.enabled, t('gwh.feat.cache'), 'gwh-f-cache', () => toggle(sw, (v) => act('cache', { enabled: v }, t(v ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name: t('gwh.feat.cache') }))));
      const extra = [];
      if (sup.cache === false) extra.push(h('span', { class: 'gwn-hint' }, [U.icon('info', 14), t('gwh.feat.too_old', { min: sup.minGateway3b || '1.22.0' })]));
      if (/^pi/.test((d.hardware && d.hardware.board) || '')) extra.push(h('span', { class: 'gwn-hint' }, [U.icon('info', 14), t('gwh.feat.cache_pi')]));
      extra.push(link('cache', 'gwh.feat.to_cache'));
      rows.push(featRow(t('gwh.feat.cache'), t('gwh.feat.cache_d'), sw, extra, 'cache'));
    }
    if (d.timezone) {
      rows.push(featRow(t('gwh.feat.tz'), t('gwh.feat.tz_d', { tz: d.timezone.tz }),
        d.timezone.utc ? U.tag('amber', 'UTC', true) : U.tag('green', d.timezone.tz, true),
        d.timezone.utc ? [h('span', { class: 'gwn-hint' }, [U.icon('warn', 14), h('span', null, [t('gwh.feat.tz_utc'), ' ', U.guide('faq.utc')])])] : [], 'timezone'));
    }
    return rows;
  }

  // ─── Tab badges ───────────────────────────────────────────────────────
  function badge(node, id, which) {
    node.replaceChildren();
    node.className = 'gwe-tab-badge';
    const d = entry(which, id).data;
    if (!d || !d.settings || !d.settings.enabled) return;
    if (which === 'dns') {
      const tel = d.gateway.telemetry;
      if (d.outage || (tel && (tel.state === 'port_busy' || tel.state === 'error'))) { node.className = 'gwe-tab-badge tag tag-red'; node.textContent = t('gwh.tabs.problem'); }
      else if (tel && tel.state === 'running') { node.className = 'gwe-tab-badge tag tag-green'; node.textContent = t('gwh.tabs.on'); }
    } else if (d.state && d.state.error) {
      node.className = 'gwe-tab-badge tag tag-amber'; node.textContent = t('gwh.tabs.problem');
    }
  }

  // ─── Public ───────────────────────────────────────────────────────────
  function mount(box, g, tab, ctx) {
    cur = { box, g, tab, ctx: ctx || {} };
    box.classList.add('gwe-panel', 'gwn-panel', 'gwh-panel');
    draw();
    load(tab, g.peer_id, false).then(() => { redraw(); badges(g.peer_id); }, () => redraw());
  }
  function prefetch(g) {
    load('dns', g.peer_id, false).then(() => badges(g.peer_id), () => {});
    load('cache', g.peer_id, false).then(() => badges(g.peer_id), () => {});
  }
  function unmount() { cur = null; }

  window.GCGatewayHome = { mount, unmount, prefetch, badge, featureRows, _cache: cache };
})();
