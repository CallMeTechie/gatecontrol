'use strict';

// Gateway pools on the gateways page (the former page /gateway-pools):
// the group header of a pool in the fleet, the card "Pool" of a gateway's
// overview, the pool page #pool/<id>, the dialogs "Pool anlegen" / "Pool
// bearbeiten", "Zu einem Pool hinzufügen", "Routen hierher umziehen" (the
// migration dialog of the former page, with "Dauerhaft auf Gateway
// verschieben") and "Pool auflösen". gateways.js owns the views and the poll;
// this module renders into what it is given.
//
// Data: GET /api/v1/gateway-pools/state (src/services/gatewayPoolState.js) —
// who serves each pool now, the others, the reserve check, routes, switches;
// changes through the pool API (src/routes/api/gatewayPools.js). Licence:
// #fleet-view data-pools="on" (gateway_pools) / data-pools-lb="on"
// (gateway_pool_load_balancing); without it the actions open the licence hint
// and nothing asks the pool API.
//
//   window.GCGatewayPools.init({ fleet: () => gateways, changed: () => reload })
//   .load() → Promise<state|null>       .state() / .pools() / .poolsOf(peerId) / .pool(id)
//   .groupSection(pool, cards)          → the pool group of the fleet
//   .poolCard(g)                        → the card "Pool" of the overview
//   .renderPool(box, id)                → the pool page
//   .openCreate({ preselect }) / .openEdit(pool) / .openAddTo(g) / .openMigrate(poolId) / .lockDialog()
//   .busy(box)                          → do not redraw now (drag, typing, saving)
//
// Pure rules (grouping, roles, presets, same LAN) live in gateway-pool-kit.js.
// Nothing here uses innerHTML — every node is built with GCDialog.el.
(function () {
  const E = window.GCGatewayEdge;
  const PK = window.GCGatewayPoolKit;
  const D = window.GCDialog;
  if (!E || !E.ui || !PK || !D) return;
  const U = E.ui;
  const h = D.el;
  const t = U.t;
  const LOCALE = U.LANG === 'en' ? 'en-GB' : 'de-DE';
  const API = '/api/v1/gateway-pools';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const root = document.getElementById('fleet-view');
  const licensed = !!root && root.getAttribute('data-pools') === 'on';
  const lbLicensed = !!root && root.getAttribute('data-pools-lb') === 'on';

  let st = null;         // last GET /state
  let fleet = () => [];  // gateways of the last poll (gateways.js)
  let changed = () => {};
  // UI state that must survive the redraw of every poll
  const ui = { all: {}, saving: false, dragging: false, cur: null };

  function init(o) { fleet = (o && o.fleet) || fleet; changed = (o && o.changed) || changed; }
  function load() {
    if (!licensed) return Promise.resolve(null);
    return U.api('GET', API + '/state').then((j) => { st = j; return j; });
  }
  function state() { return st; }
  function pools() { return (st && st.pools) || []; }
  function poolsOf(peerId) { return PK.poolsOf(pools(), peerId); }
  function pool(id) { return pools().find((p) => String(p.id) === String(id)) || null; }
  function gw(id) { return fleet().find((g) => String(g.peer_id) === String(id)) || null; }
  function nameOf(id, fallback) {
    const g = gw(id);
    if (g) return g.name;
    return fallback || ('#' + id);
  }
  function memberName(m) { return nameOf(m.peer_id, m.name); }
  // Countdowns ({{left}} → "m:ss", the failback wait): nodes with data-gw-until
  // and the template data-gw-tpl, rewritten every second by gateways.js.
  function dur(s) { const d = PK.duration(s); return t(d.key, { n: d.n }); }
  function ago(ms) {
    if (!ms) return '—';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return t('gwn.ago.now');
    if (s < 3600) return t('gwn.ago.min', { n: Math.round(s / 60) });
    if (s < 86400) return t('gwn.ago.h', { n: Math.round(s / 3600) });
    return t('gwn.ago.d', { n: Math.round(s / 86400) });
  }
  function when(ms) {
    const d = new Date(ms);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function platformText(id) {
    const g = gw(id);
    if (!g) return '';
    const tel = (g.health && g.health.telemetry) || {};
    if (tel.hardware && tel.hardware.model) return String(tel.hardware.model);
    return g.platform ? t('gwiz.platform.' + g.platform) : '';
  }
  function errText(e) {
    const msg = String((e && e.message) || '');
    if (/UNIQUE/.test(msg) || (e && e.status === 409 && /name/i.test(msg))) return t('gwp.err.name_taken');
    if (/gateway_pools_limit/.test(msg)) return t('gwp.err.limit');
    if (/feature_locked|not licensed|feature_not_available/.test(msg) || (e && e.status === 403)) return t('gwp.err.locked');
    if (/last_member_in_use/.test(msg)) return t('gwp.err.last_member');
    if (/pool_mutation_companion_confirm_timeout/.test(msg)) return t('gwp.err.confirm_timeout');
    if (/pool_in_use/.test(msg)) return t('gwp.err.in_use');
    if (/pool_not_found/.test(msg)) return t('gwp.err.not_found');
    return U.errText(e);
  }
  // A companion did not confirm in time: the change is saved and reaches it with its next poll.
  function savedAnyway(e) { return /pool_mutation_companion_confirm_timeout/.test(String((e && e.message) || '')); }

  function svg(paths, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', String(size || 18)], ['height', String(size || 18)], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']]
      .forEach((a) => s.setAttribute(a[0], a[1]));
    paths.forEach((p) => {
      const n = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach((k) => n.setAttribute(k, String(p[1][k])));
      s.appendChild(n);
    });
    return s;
  }
  const IC = {
    pool: [['rect', { x: 3, y: 4, width: 18, height: 6, rx: 2 }], ['rect', { x: 3, y: 14, width: 18, height: 6, rx: 2 }], ['path', { d: 'M7 7h.01M7 17h.01' }]],
    grip: [['path', { d: 'M5 9h14M5 15h14' }]],
    up: [['path', { d: 'm6 15 6-6 6 6' }]],
    down: [['path', { d: 'm6 9 6 6 6-6' }]],
    shield: [['path', { d: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z' }], ['path', { d: 'm8.5 12 2.5 2.5 4.5-5' }]],
    warn: [['path', { d: 'M12 3 3 20h18z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
    x: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm9 9 6 6M15 9l-6 6' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
  };
  function lockTag() { return h('span', { class: 'feature-lock' }, [svg(IC.lock, 14), t('common.pro')]); }

  // ─── Licence ──────────────────────────────────────────────────────────
  function lockDialog() {
    const dlg = U.openDialog({ title: t('gwp.lock.title') });
    dlg.body.append(h('p', { class: 'gwe-d', text: t('gwp.lock.text') }));
    if (window.GCLicenseHint) dlg.body.append(window.GCLicenseHint.render('gateway_pools', { compact: true }));
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.close'), on: { click: () => dlg.close(true) } });
    dlg.foot.append(ok);
    ok.focus();
    return dlg.promise;
  }

  // ─── Fleet: the group of a pool ───────────────────────────────────────
  function routeCount(p) { return (p.routes || []).length; }
  // what the pool keeps reachable: its own routes plus the routes pinned to a member (gatewayHealth
  // pivots those to an alive sibling on an outage) — shown in the group, the banner and the routes card
  function safeCount(p) { return routeCount(p) + (p.mode === 'load_balancing' ? 0 : (p.pinned_routes || []).length); }
  function groupSection(p, cards) {
    const hid = 'gwp-g-' + p.id;
    const status = PK.effectiveStatus(p);
    const tone = PK.statusTone(status);
    const meta = [t(safeCount(p) === 1 ? 'gwp.group.routes_one' : 'gwp.group.routes', { n: safeCount(p) })];
    if (p.last_switch_at) meta.push(t('gwp.group.switched', { ago: ago(p.last_switch_at) }));
    const head = h('div', { class: 'gwp-group-head' }, [
      h('span', { class: 'gwp-group-ic' }, svg(IC.pool, 20)),
      h('h2', { id: hid, class: 'gwp-group-title', text: t('gwp.pool_name', { name: p.name }) }),
      U.tag('grey', t('gwp.mode.' + p.mode)),
      h('span', { class: 'tag tag-dot tag-' + tone, 'data-status': status, text: t('gwp.status.' + status) }),
      h('span', { class: 'gwp-grow' }),
      h('span', { class: 'gwe-d', text: meta.join(' · ') }),
      h('a', { class: 'btn btn-ghost btn-sm', href: '#pool/' + p.id, 'data-fk': 'gwp-open:' + p.id, text: t('gwp.open') }),
    ]);
    return h('section', { class: 'gwp-group gwp-tone-' + tone, 'aria-labelledby': hid, 'data-pool': String(p.id) }, [head, h('div', { class: 'grid gwp-grid' }, cards)]);
  }

  // ─── Overview: the card "Pool" ────────────────────────────────────────
  function stateTag(p, m) {
    if (m.state === 'standby' && PK.reserveGap(p, m)) return h('span', { class: 'tag tag-amber', 'data-state': 'standby_partial', text: t('gwp.mstate.standby_partial') });
    // away on purpose (live state): "Update läuft" / "startet neu" instead of a plain offline
    if (m.state === 'offline' && (m.live_state === 'updating' || m.live_state === 'restarting')) {
      return h('span', { class: 'tag tag-blue', 'data-state': m.live_state, text: t('gwp.mstate.' + m.live_state) });
    }
    const r = PK.roleOf(p, m);
    const key = { active: p.mode === 'load_balancing' ? 'gwp.mstate.lb_active' : 'gwp.mstate.active', standby: 'gwp.mstate.standby', recovering: 'gwp.mstate.recovering', offline: 'gwp.mstate.offline' }[m.state];
    return h('span', { class: 'tag tag-' + (r.tone === 'blue' ? 'green' : r.tone === 'grey' ? 'green' : r.tone), 'data-state': m.state, text: t(key || 'gwp.mstate.offline') });
  }
  function routesOfSelf(p, selfId) {
    return routeCount(p) + (p.pinned_routes || []).filter((r) => String(r.peer_id) === String(selfId)).length;
  }
  /** The plain sentence: what happens when the serving gateway fails, and when it comes back. */
  function outageSentence(p, selfId) {
    const thr = dur((st && st.threshold_s) || 90);
    const back = dur(p.failback_cooldown_s);
    if (p.status === 'off') return t('gwp.ov.off');
    if (p.status === 'down') return t('gwp.ov.down');
    if (p.mode === 'load_balancing') return t('gwp.ov.lb', { threshold: thr });
    if ((p.members || []).length < 2) return t('gwp.ov.single');
    const active = PK.activeMember(p);
    const self = PK.memberOf(p, selfId);
    const next = PK.standbys(p)[0] || null;
    const n = active ? routesOfSelf(p, active.peer_id) : routeCount(p);
    if (active && self && String(active.peer_id) === String(selfId)) {
      if (!next) return t('gwp.ov.no_reserve_self', { n });
      const gap = PK.reserveGap(p, next);
      return gap ? t('gwp.ov.if_self_partial', { threshold: thr, next: memberName(next), k: gap.k, n: gap.n, back })
        : t('gwp.ov.if_self', { threshold: thr, next: memberName(next), n, back });
    }
    if (self && self.state === 'standby' && active) {
      const gap = PK.reserveGap(p, self);
      return gap ? t('gwp.ov.if_other_partial', { active: memberName(active), threshold: thr, k: gap.k, n: gap.n, back })
        : t('gwp.ov.if_other', { active: memberName(active), threshold: thr, n, back });
    }
    if (self && self.state === 'recovering' && active) {
      const r = PK.roleOf(p, self);
      // {{left}} stays in: poolCard counts it down
      return t(self.failback_takes_routes === false ? 'gwp.ov.recovering_reserve' : 'gwp.ov.recovering', { active: memberName(active), min: r.params.min || 1, left: r.until ? '{{left}}' : '—' });
    }
    if (active) return t('gwp.ov.offline_self', { active: memberName(active) });
    return t('gwp.ov.down');
  }
  function memberRows(p, selfId) {
    return h('div', { class: 'gwp-mrows' }, (p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m, i) => {
      const self = String(m.peer_id) === String(selfId);
      const label = self ? h('strong', { class: 'gwp-mrow-n', text: t('gwp.ov.self', { name: memberName(m) }) })
        : h('a', { class: 'gwp-mrow-n', href: '#gw/' + encodeURIComponent(String(m.peer_id)), text: memberName(m) });
      return h('div', { class: 'gwp-mrow' + (self ? ' gwp-mrow-self' : '') }, [
        h('span', { class: 'tag ' + (i === 0 ? 'tag-blue' : 'tag-grey'), text: String(i + 1) }), label, stateTag(p, m)]);
    }));
  }
  function poolCard(g) {
    const c = U.card(t('gwp.ov.title'), null, { id: 'ov-pool', cls: 'gwp-ovcard' });
    const add = () => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-act': 'pool-add', 'data-id': String(g.peer_id), 'data-fk': 'gwp-ov-add' },
      [licensed ? null : svg(IC.lock, 14), t('gwp.add_to_pool')]);
    const own = (g.routes || []).length;
    if (!licensed) {
      c.body.append(h('p', { class: 'gwe-d', text: t(own === 0 ? 'gwp.ov.alone_none' : own === 1 ? 'gwp.ov.alone_one' : 'gwp.ov.alone', { n: own }) }), h('div', null, add()));
      return c.card;
    }
    if (!st) { c.body.append(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') })); return c.card; }
    const ps = poolsOf(g.peer_id);
    if (!ps.length) {
      c.body.append(h('p', { class: 'gwe-d', text: t(own === 0 ? 'gwp.ov.alone_none' : own === 1 ? 'gwp.ov.alone_one' : 'gwp.ov.alone', { n: own }) }), h('div', null, add()));
      return c.card;
    }
    if (ps.length === 1) c.top.appendChild(h('a', { class: 'btn btn-ghost btn-sm', href: '#pool/' + ps[0].id, 'data-fk': 'gwp-ov-open', text: t('gwp.open') }));
    ps.forEach((p) => {
      const lead = h('p', { class: 'gwe-d' }, [t('gwp.ov.member_a'), ' ', h('strong', { class: 'gwe-strong', text: '„' + p.name + '“' }), ' ', t('gwp.ov.member_b', { mode: t('gwp.mode.' + p.mode) })]);
      const extra = ps.length > 1 ? h('a', { class: 'gwn-link', href: '#pool/' + p.id, text: t('gwp.open_named', { name: p.name }) }) : null;
      const sentence = outageSentence(p, g.peer_id);
      const selfM = PK.memberOf(p, g.peer_id);
      const until = selfM && selfM.state === 'recovering' ? PK.roleOf(p, selfM).until : null;
      const outage = until && sentence.indexOf('{{left}}') >= 0
        ? h('p', { class: 'gwe-d', 'data-outage': String(p.id), 'data-gw-until': String(until), 'data-gw-tpl': sentence, text: sentence.split('{{left}}').join(PK.clock(until - Date.now())) })
        : h('p', { class: 'gwe-d', 'data-outage': String(p.id), text: sentence });
      c.body.append(...[lead, memberRows(p, g.peer_id), outage, extra].filter(Boolean));
    });
    return c.card;
  }

  // ─── Pool page #pool/<id> ─────────────────────────────────────────────
  function busy(box) {
    if (ui.saving || ui.dragging) return true;
    const a = document.activeElement;
    return !!(box && a && box.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|number)$/.test(a.type))));
  }
  function backBtn() { return h('button', { type: 'button', class: 'gw-back', 'data-act': 'back', 'data-fk': 'gwp-back', text: '← ' + t('gwp.back') }); }

  function renderPool(box, id) {
    ui.cur = { box, id: String(id) };
    const fk = box.contains(document.activeElement) ? U.focusKey() : null;
    const root2 = h('div', { class: 'gw-detail gwp-page', 'data-pool-page': String(id) });
    root2.appendChild(backBtn());
    if (!licensed) {
      root2.append(h('div', { class: 'gw gwe-card' }, h('div', { class: 'body gwe-body' }, [h('p', { class: 'gwe-d', text: t('gwp.lock.text') }),
        window.GCLicenseHint ? window.GCLicenseHint.render('gateway_pools', { compact: true }) : null])));
      box.replaceChildren(root2);
      return;
    }
    const p = pool(id);
    if (!st) root2.appendChild(h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    else if (!p) root2.appendChild(U.note('warn', [t('gwp.err.not_found')]));
    else {
      root2.append(pageHead(p), banner(p),
        h('div', { class: 'gwe-grid2 gwp-row' }, [membersCard(p), behaviourCard(p)]),
        h('div', { class: 'gwe-grid2 gwp-row' }, [routesCard(p), historyCard(p)]));
    }
    box.replaceChildren(root2);
    U.restoreFocus(box, fk);
  }
  function redrawPool() { if (ui.cur && ui.cur.box.isConnected) renderPool(ui.cur.box, ui.cur.id); }
  // after a change: the gateways page loads gateways and pools again and redraws (gateways.js)
  function refresh() { return Promise.resolve(changed()); }

  function pageHead(p) {
    const members = p.members || [];
    const sub = [t('gwp.mode.' + p.mode), t(members.length === 1 ? 'gwp.page.n_gw_one' : 'gwp.page.n_gw', { n: members.length }),
      t(safeCount(p) === 1 ? 'gwp.group.routes_one' : 'gwp.group.routes', { n: safeCount(p) }),
      t('gwp.page.jumps', { threshold: dur((st && st.threshold_s) || 90) })];
    const status = PK.effectiveStatus(p);
    const tone = PK.statusTone(status);
    const edit = h('button', { type: 'button', class: 'btn btn-ghost', 'data-fk': 'gwp-edit', text: t('gwp.edit') });
    edit.addEventListener('click', () => openEdit(p));
    return h('div', { class: 'page-h gwp-head' }, [
      h('div', { class: 'gwp-head-t' }, [
        h('h2', null, [t('gwp.pool_name', { name: p.name }), ' ', h('span', { class: 'tag tag-dot tag-' + tone, 'data-status': status, text: t('gwp.status_short.' + status) })]),
        h('p', { class: 'page-sub', text: sub.join(' · ') }),
      ]),
      h('div', { class: 'gw-detail-actions' }, [edit]),
    ]);
  }

  function banner(p) {
    const active = PK.activeMember(p);
    const members = (p.members || []).slice().sort((a, b) => a.priority - b.priority);
    const first = members[0];
    const standby = PK.standbys(p)[0];
    const n = safeCount(p);
    let tone = 'ok';
    let lead;
    let rest = '';
    let restUntil = null; // the failback of the first member, counted down in `rest`
    if (p.status === 'off') { tone = 'grey'; lead = t('gwp.ban.off'); } else if (p.status === 'down') {
      tone = 'bad'; lead = t('gwp.ban.down'); rest = t(p.outage_message ? 'gwp.ban.down_msg' : 'gwp.ban.down_rest', { n });
    } else if (p.mode === 'load_balancing') {
      tone = p.status === 'protected' ? 'ok' : 'warn';
      lead = t('gwp.ban.lb', { n: (p.active_peer_ids || []).length });
      rest = t(p.status === 'protected' ? 'gwp.ban.lb_rest' : 'gwp.ban.lb_one');
    } else if (p.status === 'single') {
      tone = 'warn'; lead = t('gwp.ban.single'); rest = t('gwp.ban.single_rest');
    } else if (p.status === 'on_reserve') {
      tone = 'warn'; lead = t('gwp.ban.on_reserve', { active: memberName(active), first: memberName(first) });
      const fr = first.state === 'recovering' ? PK.roleOf(p, first) : null;
      if (fr && fr.until) restUntil = fr.until;
      rest = fr ? t('gwp.ban.back_in', { first: memberName(first), min: fr.params.min || 1, left: fr.until ? '{{left}}' : '—' })
        : (first.live_state === 'updating' || first.live_state === 'restarting')
          ? t('gwp.ban.first_' + first.live_state, { first: memberName(first) })
          : t('gwp.ban.first_down', { first: memberName(first), ago: ago(first.offline_since || first.went_down_at || first.last_seen_at) });
    } else if (p.status === 'no_reserve') {
      tone = 'warn'; lead = t('gwp.ban.no_reserve', { active: memberName(active) }); rest = t('gwp.ban.no_reserve_rest', { active: memberName(active), n });
    } else if (PK.effectiveStatus(p) === 'partial') {
      // the next reserve does not reach every target (reserve check): say how many routes stay
      const gap = PK.reserveGap(p, standby);
      tone = 'warn'; lead = t('gwp.ban.partial', { active: memberName(active), standby: memberName(standby) });
      rest = t('gwp.ban.partial_rest', { active: memberName(active), k: gap ? gap.k : 0, n: gap ? gap.n : n });
    } else {
      lead = t('gwp.ban.protected', { active: memberName(active), standby: memberName(standby) });
      rest = t('gwp.ban.protected_rest', { active: memberName(active), n });
    }
    const ic = tone === 'ok' ? IC.shield : tone === 'bad' ? IC.x : IC.warn;
    const restNode = restUntil && rest.indexOf('{{left}}') >= 0
      ? h('span', { 'data-gw-until': String(restUntil), 'data-gw-tpl': ' ' + rest, text: ' ' + rest.split('{{left}}').join(PK.clock(restUntil - Date.now())) })
      : (rest ? ' ' + rest : '');
    return h('div', { class: 'gwp-banner gwp-banner-' + tone, role: 'status', 'data-status': PK.effectiveStatus(p) }, [svg(ic, 22),
      h('p', null, [h('strong', { text: lead }), restNode])]);
  }

  // Members: order (drag or the arrow buttons), add, remove
  function saveMembers(p, ids, okMsg) {
    ui.saving = true;
    const list = document.querySelector('.gwp-mlist');
    if (list) list.setAttribute('aria-busy', 'true');
    return U.api('PUT', API + '/' + p.id + '/members', { members: ids.map((id, i) => ({ peer_id: Number(id), priority: i + 1 })) })
      .then(() => { if (okMsg) U.toast(okMsg); }, (e) => {
        if (savedAnyway(e)) { U.toast(t('gwp.err.confirm_timeout'), 'warning'); return; }
        D.alert({ message: errText(e), danger: true });
      })
      .then(() => { ui.saving = false; return refresh(); }, () => { ui.saving = false; })
      .catch(() => {});
  }
  function memberSub(p, m) {
    const parts = [];
    const pl = platformText(m.peer_id);
    if (pl) parts.push(pl);
    const away = m.state === 'offline' && (m.live_state === 'updating' || m.live_state === 'restarting') ? m.live_state : null;
    parts.push(t(m.state === 'active' || m.state === 'standby' ? 'gwp.mem.online' : m.state === 'recovering' ? 'gwp.mem.back' : away ? 'gwp.mem.' + away : 'gwp.mem.offline'));
    if (m.last_seen_at) parts.push(t('gwp.mem.heartbeat', { ago: ago(m.last_seen_at) }));
    const r = m.reserve;
    if (r && m.state !== 'active') parts.push(r.reachable === r.checked ? t('gwp.mem.reaches_all', { n: r.checked }) : t('gwp.mem.reaches', { k: r.reachable, n: r.checked }));
    return parts.join(' · ');
  }
  function membersCard(p) {
    const addBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwp-add', text: t('gwp.mem.add') });
    addBtn.addEventListener('click', () => addMemberDialog(p));
    const c = U.card(t('gwp.mem.title'), addBtn, { id: 'mem', cls: 'gwp-members' });
    c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwp.mem.help') }));
    const members = (p.members || []).slice().sort((a, b) => a.priority - b.priority);
    const ids = members.map((m) => String(m.peer_id));
    const move = (id, delta) => {
      const i = ids.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ids.length) return;
      const next = ids.slice();
      next.splice(j, 0, next.splice(i, 1)[0]);
      saveMembers(p, next, t('gwp.mem.order_saved'));
    };
    const list = h('ol', { class: 'gwp-mlist', 'aria-label': t('gwp.mem.title') });
    let dragId = null;
    members.forEach((m, i) => {
      const id = String(m.peer_id);
      const name = memberName(m);
      const up = h('button', { type: 'button', class: 'gwp-icbtn', 'aria-label': t('gwp.mem.up', { name }), title: t('gwp.mem.up', { name }), 'data-fk': 'gwp-up:' + id, disabled: i === 0 }, svg(IC.up, 16));
      const down = h('button', { type: 'button', class: 'gwp-icbtn', 'aria-label': t('gwp.mem.down', { name }), title: t('gwp.mem.down', { name }), 'data-fk': 'gwp-down:' + id, disabled: i === members.length - 1 }, svg(IC.down, 16));
      up.addEventListener('click', () => move(id, -1));
      down.addEventListener('click', () => move(id, 1));
      const rm = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': t('gwp.mem.remove_label', { name }), 'data-fk': 'gwp-rm:' + id, text: t('gwp.mem.remove') });
      rm.addEventListener('click', async () => {
        if (!await D.confirm({ title: t('gwp.mem.remove_q', { name }), message: t('gwp.mem.remove_msg', { pool: p.name }), danger: true, okLabel: t('gwp.mem.remove') })) return;
        saveMembers(p, ids.filter((x) => x !== id), t('gwp.mem.removed', { name }));
      });
      const li = h('li', { class: 'gwp-mem' + (m.state === 'active' ? ' gwp-mem-active' : ''), draggable: 'true', 'data-peer': id }, [
        h('span', { class: 'gwp-grip', 'aria-hidden': 'true', title: t('gwp.mem.drag') }, svg(IC.grip, 16)),
        h('span', { class: 'tag ' + (i === 0 ? 'tag-blue' : 'tag-grey'), text: String(i + 1) }),
        h('span', { class: 'gwp-mem-t' }, [h('a', { href: '#gw/' + encodeURIComponent(id), text: name }), h('span', { class: 'gwe-d', text: memberSub(p, m) })]),
        stateTag(p, m),
        h('span', { class: 'gwp-mem-a' }, [up, down, rm]),
      ]);
      li.addEventListener('dragstart', (e) => {
        dragId = id; ui.dragging = true; li.classList.add('gwp-dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (x) { /* some browsers reject the type */ } }
      });
      li.addEventListener('dragend', () => { ui.dragging = false; dragId = null; li.classList.remove('gwp-dragging'); list.querySelectorAll('.gwp-drop-before, .gwp-drop-after').forEach((n) => n.classList.remove('gwp-drop-before', 'gwp-drop-after')); });
      li.addEventListener('dragover', (e) => {
        if (!dragId || dragId === id) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        const after = e.clientY >= r.top + r.height / 2;
        li.classList.toggle('gwp-drop-after', after);
        li.classList.toggle('gwp-drop-before', !after);
      });
      li.addEventListener('dragleave', () => li.classList.remove('gwp-drop-before', 'gwp-drop-after'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragId || dragId === id) return;
        const r = li.getBoundingClientRect();
        const after = e.clientY >= r.top + r.height / 2;
        const next = ids.filter((x) => x !== dragId);
        next.splice(next.indexOf(id) + (after ? 1 : 0), 0, dragId);
        ui.dragging = false;
        if (next.join() !== ids.join()) saveMembers(p, next, t('gwp.mem.order_saved'));
      });
      list.appendChild(li);
    });
    c.body.appendChild(list);
    // the reserve check: what the standbys report about the targets of the pool's routes
    const checked = members.filter((m) => m.state !== 'active' && m.reserve);
    if (checked.length) {
      const bad = checked.filter((m) => m.reserve.reachable < m.reserve.checked);
      const text = bad.length
        ? bad.map((m) => t('gwp.mem.reserve_missing', { name: memberName(m), list: m.reserve.missing.map((x) => x.domain).join(', ') })).join(' ')
        : t('gwp.mem.reserve_ok', { names: checked.map(memberName).join(', ') });
      c.body.appendChild(h('div', { class: 'gwp-reserve gwp-reserve-' + (bad.length ? 'warn' : 'ok'), 'data-reserve': bad.length ? 'missing' : 'ok' },
        [svg(bad.length ? IC.warn : IC.shield, 18), h('p', null, [h('strong', { text: t('gwp.mem.reserve_title') }), ' ', text, bad.length ? ' ' + t('gwp.mem.reserve_why') : ''])]));
    }
    return c.card;
  }

  function addMemberDialog(p) {
    const inPool = new Set((p.members || []).map((m) => String(m.peer_id)));
    const candidates = fleet().filter((g) => !inPool.has(String(g.peer_id)));
    const dlg = U.openDialog({ title: t('gwp.mem.add_title', { pool: p.name }), cls: 'gwp-dlg' });
    if (!candidates.length) {
      dlg.body.append(h('p', { class: 'gwe-d', text: t('gwp.mem.add_none') }));
      const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('common.close'), on: { click: () => dlg.close(true) } });
      dlg.foot.append(ok); ok.focus();
      return;
    }
    const first = gw((p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m) => m.peer_id)[0]);
    const sel = h('select', { id: 'gwp-add-peer', class: 'form-select' }, candidates.map((g) => {
      const lan = first ? PK.sameLan(first, g) : null;
      return h('option', { value: String(g.peer_id), text: g.name + (lan ? ' · ' + t('gwp.dlg.same_lan', { lan }) : '') });
    }));
    const err = U.errorBox();
    dlg.body.append(h('label', { class: 'form-label', for: 'gwp-add-peer', text: t('gwp.mem.add_label') }), sel,
      h('p', { class: 'form-hint', text: t('gwp.mem.add_hint') }), err);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwp.mem.add') });
    ok.addEventListener('click', () => {
      ok.disabled = true;
      const ids = (p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m) => String(m.peer_id)).concat([sel.value]);
      U.api('PUT', API + '/' + p.id + '/members', { members: ids.map((id, i) => ({ peer_id: Number(id), priority: i + 1 })) })
        .then(() => true, (e) => { if (savedAnyway(e)) return true; ok.disabled = false; U.showErr(err, errText(e)); return false; })
        .then((done) => { if (!done) return; dlg.close(true); U.toast(t('gwp.mem.added', { name: nameOf(sel.value) })); refresh().catch(() => {}); });
    });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok);
    sel.focus();
  }

  // Behaviour: mode, failback, outage message — each change is saved at once
  function putPool(p, patch, okMsg) {
    ui.saving = true;
    return U.api('PUT', API + '/' + p.id, patch).then(() => { if (okMsg) U.toast(okMsg); }, (e) => {
      if (savedAnyway(e)) { U.toast(t('gwp.err.confirm_timeout'), 'warning'); return; }
      D.alert({ message: errText(e), danger: true });
    }).then(() => { ui.saving = false; return refresh().catch(() => {}); });
  }
  function cooldownSelect(id, value, proposedKey, onPick) {
    const sel = h('select', { id, class: 'form-select gwp-cool' });
    PK.COOLDOWN_PRESETS.forEach((pr) => {
      sel.appendChild(h('option', { value: String(pr.s), text: t('gwp.cool.opt', { time: dur(pr.s), what: t('gwp.cool.' + pr.key) }) + (pr.key === proposedKey ? ' ' + t('gwp.cool.proposed') : '') }));
    });
    sel.appendChild(h('option', { value: 'custom', text: t('gwp.cool.custom') }));
    sel.value = PK.presetFor(value) ? String(value) : 'custom';
    const num = h('input', { type: 'number', id: id + '-s', class: 'form-input gwp-cool-s', min: '0', max: '86400', step: '1', value: String(value), 'aria-label': t('gwp.cool.custom_label') });
    const wrap = h('span', { class: 'gwp-cool-custom' }, [num, h('span', { class: 'gwe-d', text: t('gwp.cool.seconds') })]);
    wrap.hidden = sel.value !== 'custom';
    sel.addEventListener('change', () => {
      wrap.hidden = sel.value !== 'custom';
      if (sel.value !== 'custom') { num.value = sel.value; if (onPick) onPick(Number(sel.value)); } else num.focus();
    });
    return { sel, num, wrap, value: () => (sel.value === 'custom' ? parseInt(num.value, 10) : Number(sel.value)) };
  }
  function firstPlatform(p) {
    const m = (p.members || []).slice().sort((a, b) => a.priority - b.priority)[0];
    const g = m ? gw(m.peer_id) : null;
    return g ? g.platform : (m ? m.platform : null);
  }
  function modeSeg(current, onPick, idp) {
    const seg = h('div', { class: 'gwp-seg', role: 'group', 'aria-labelledby': idp + '-l' });
    [['failover', true], ['load_balancing', lbLicensed]].forEach(([mode, ok]) => {
      const b = h('button', { type: 'button', class: 'gwp-seg-b', 'aria-pressed': current === mode ? 'true' : 'false', 'data-mode': mode, 'data-fk': idp + ':' + mode, disabled: !ok },
        [h('strong', { text: t('gwp.mode.' + mode) }), h('span', { class: 'gwe-d', text: t('gwp.mode.' + mode + '_d') + (ok ? '' : ' · ' + t('gwp.mode.lb_locked')) })]);
      b.addEventListener('click', () => { if (current !== mode) onPick(mode, b); });
      seg.appendChild(b);
    });
    return seg;
  }
  function lbSelect(id, value) {
    return h('select', { id, class: 'form-select' }, ['round_robin', 'least_conn', 'ip_hash'].map((v) => {
      const o = h('option', { value: v, text: t('gateway_pools.lb_policy_' + v) });
      if (v === value) o.selected = true;
      return o;
    }));
  }
  function behaviourCard(p) {
    const c = U.card(t('gwp.beh.title'), null, { id: 'beh', cls: 'gwp-beh' });
    const fld = (label, idFor, control, hint) => h('div', { class: 'gwp-fld' }, [
      idFor ? h('label', { class: 'form-label', for: idFor, id: idFor + '-l', text: label }) : h('span', { class: 'form-label', id: 'gwp-mode-l', text: label }),
      control, hint ? h('p', { class: 'form-hint', text: hint }) : null]);
    c.body.appendChild(fld(t('gwp.beh.mode'), null, modeSeg(p.mode, (mode) => {
      putPool(p, mode === 'load_balancing' ? { mode, lb_policy: p.lb_policy || 'round_robin' } : { mode, lb_policy: null }, t('gwp.saved'));
    }, 'gwp-mode'), lbLicensed ? null : null));
    if (!lbLicensed && window.GCLicenseHint) c.body.appendChild(h('div', { class: 'gwp-lbhint' }, window.GCLicenseHint.render('gateway_pool_load_balancing', { compact: true })));
    if (p.mode === 'load_balancing') {
      const lb = lbSelect('gwp-lb', p.lb_policy);
      lb.addEventListener('change', () => putPool(p, { lb_policy: lb.value }, t('gwp.saved')));
      c.body.appendChild(fld(t('gwp.beh.lb'), 'gwp-lb', lb));
    }
    const proposed = PK.proposeCooldown(firstPlatform(p));
    const cs = cooldownSelect('gwp-cool', p.failback_cooldown_s, proposed && proposed.key, (s) => putPool(p, { failback_cooldown_s: s }, t('gwp.saved')));
    const apply = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwp-cool-apply', text: t('gwp.beh.apply') });
    apply.addEventListener('click', () => {
      const v = cs.value();
      if (!Number.isInteger(v) || v < 0) { cs.num.focus(); return; }
      putPool(p, { failback_cooldown_s: v }, t('gwp.saved'));
    });
    cs.wrap.appendChild(apply);
    c.body.appendChild(fld(p.mode === 'load_balancing' ? t('gwp.beh.cool_lb') : t('gwp.beh.cool'), 'gwp-cool', h('div', { class: 'gwp-cool-row' }, [cs.sel, cs.wrap]), t('gwp.beh.cool_hint')));
    const msg = h('textarea', { id: 'gwp-msg', class: 'form-input', rows: '2', maxLength: 500, placeholder: t('gwp.beh.msg_ph') });
    msg.value = p.outage_message || '';
    const save = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwp-msg-save', text: t('common.save') });
    save.addEventListener('click', () => putPool(p, { outage_message: msg.value.trim() || null }, t('gwp.saved')));
    c.body.appendChild(fld(t('gwp.beh.msg'), 'gwp-msg', h('div', { class: 'gwp-msg' }, [msg, h('div', null, save)]), t('gwp.beh.msg_hint')));
    return c.card;
  }

  // Routes of the pool and the ones pinned to a member
  const ROUTE_LIMIT = 8;
  function target(r) { return r.target_lan_host ? r.target_lan_host + (r.target_lan_port ? ':' + r.target_lan_port : '') : (r.l4_listen_port ? ':' + r.l4_listen_port : '—'); }
  function routesCard(p) {
    const right = h('span', { class: 'gwp-card-r' });
    right.append(U.tag('grey', String(safeCount(p))));
    const mig = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwp-migrate', text: t('gwp.rt.migrate') });
    mig.addEventListener('click', () => openMigrate(p.id));
    right.append(mig);
    const c = U.card(t('gwp.rt.title'), right, { id: 'rt', cls: 'gwp-routes' });
    const rows = [];
    (p.routes || []).forEach((r) => rows.push(h('div', { class: 'gwp-li', 'data-route': String(r.id) }, [
      h('span', { class: 'gwp-li-m', text: r.domain || ('#' + r.id) }), h('code', { class: 'gwe-mono', text: target(r) })])));
    const pinned = p.mode === 'load_balancing' ? [] : (p.pinned_routes || []);
    pinned.forEach((r) => {
      const take = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-fk': 'gwp-take:' + r.id, text: t('gwp.rt.take'), disabled: !!r.failed_over, title: r.failed_over ? t('gwp.rt.failed_over') : null });
      take.addEventListener('click', () => {
        take.disabled = true;
        ui.saving = true;
        U.api('POST', API + '/' + p.id + '/migrate-routes', { route_ids: [r.id] })
          .then(() => U.toast(t('gwp.rt.taken', { domain: r.domain })), (e) => D.alert({ message: errText(e), danger: true }))
          .then(() => { ui.saving = false; return refresh().catch(() => {}); });
      });
      rows.push(h('div', { class: 'gwp-li gwp-li-pinned', 'data-route': String(r.id), 'data-pinned': '1' }, [
        h('span', { class: 'gwp-li-m' }, [r.domain || ('#' + r.id), ' ', h('span', { class: 'gwe-d', text: '· ' + t('gwp.rt.pinned', { name: nameOf(r.peer_id, r.peer_name) }) })]),
        take]));
    });
    if (!rows.length) c.body.appendChild(h('p', { class: 'gwe-empty', text: t('gwp.rt.none') }));
    const all = !!ui.all['rt:' + p.id];
    const list = h('div', { class: 'gwp-list' }, all ? rows : rows.slice(0, ROUTE_LIMIT));
    c.body.appendChild(list);
    if (rows.length > ROUTE_LIMIT) {
      const more = h('button', { type: 'button', class: 'gwn-linkbtn', 'aria-expanded': all ? 'true' : 'false', 'data-fk': 'gwp-rt-all', text: all ? t('gwp.less') : t('gwp.all', { n: rows.length }) });
      more.addEventListener('click', () => { ui.all['rt:' + p.id] = !all; redrawPool(); });
      c.body.appendChild(more);
    }
    if (pinned.length) c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwp.rt.pinned_help') }));
    if (p.rdp_routes) c.body.appendChild(h('p', { class: 'gwe-d', text: t('gwp.rt.rdp', { n: p.rdp_routes }) }));
    return c.card;
  }

  // Last switches and "Pool auflösen"
  const KIND_TONE = { failover: 'amber', failback: 'green', outage: 'red', restored: 'green', change: 'grey' };
  function minutes(ms) { const m = Math.max(1, Math.round(ms / 60000)); return m < 120 ? t('gwp.hist.min', { n: m }) : t('gwp.hist.h', { n: Math.round(m / 60) }); }
  function historyCard(p) {
    const c = U.card(t('gwp.hist.title'), null, { id: 'hist', cls: 'gwp-hist' });
    const list = p.history || [];
    if (!list.length) {
      c.body.appendChild(h('p', { class: 'gwe-empty', text: p.since && p.since.peer_id != null
        ? t('gwp.hist.since', { name: nameOf(p.since.peer_id, p.since.name), date: when(p.since.at) }) : t('gwp.hist.none') }));
    } else {
      const all = !!ui.all['hist:' + p.id];
      const rows = (all ? list : list.slice(0, 8)).map((e) => h('div', { class: 'gwp-li', 'data-kind': e.kind }, [
        U.tag(KIND_TONE[e.kind] || 'grey', t('gwp.hist.kind_' + e.kind)),
        h('span', { class: 'gwp-li-m', text: when(e.at) + ' – ' + t('gwp.hist.' + e.kind, { from: nameOf(e.from_peer_id, e.from_name || '—'), to: nameOf(e.to_peer_id, e.to_name || '—') }) }),
        e.duration_ms != null ? h('span', { class: 'gwe-d', text: minutes(e.duration_ms) }) : null,
      ]));
      c.body.appendChild(h('div', { class: 'gwp-list' }, rows));
      if (list.length > 8) {
        const more = h('button', { type: 'button', class: 'gwn-linkbtn', 'aria-expanded': all ? 'true' : 'false', 'data-fk': 'gwp-hist-all', text: all ? t('gwp.less') : t('gwp.all', { n: list.length }) });
        more.addEventListener('click', () => { ui.all['hist:' + p.id] = !all; redrawPool(); });
        c.body.appendChild(more);
      }
    }
    const pinTo = pinTarget(p);
    const total = routeCount(p) + (p.rdp_routes || 0);
    const dis = h('button', { type: 'button', class: 'btn btn-ghost gwp-danger', 'data-fk': 'gwp-dissolve', text: t('gwp.dis.button') });
    dis.addEventListener('click', () => dissolveDialog(p));
    c.body.appendChild(h('div', { class: 'gwp-dissolve' }, [dis, h('span', { class: 'gwe-d', text: total
      ? t(total === 1 ? 'gwp.dis.keeps_one' : 'gwp.dis.keeps', { n: total, name: pinTo ? memberName(pinTo) : '—' }) : t('gwp.dis.empty') })]));
    return c.card;
  }
  function pinTarget(p) {
    return PK.activeMember(p) || (p.members || []).slice().sort((a, b) => a.priority - b.priority)[0] || null;
  }
  function dissolveDialog(p) {
    const total = routeCount(p) + (p.rdp_routes || 0);
    const dlg = U.openDialog({ title: t('gwp.dis.title', { name: p.name }), cls: 'gwp-dlg' });
    const err = U.errorBox();
    let sel = null;
    dlg.body.append(h('p', { class: 'gwe-d', text: t(total ? 'gwp.dis.text' : 'gwp.dis.text_empty', { n: total }) }));
    if (total) {
      const pin = pinTarget(p);
      const options = fleet().map((g) => {
        const o = h('option', { value: String(g.peer_id), text: g.name });
        if (pin && String(pin.peer_id) === String(g.peer_id)) o.selected = true;
        return o;
      });
      sel = h('select', { id: 'gwp-dis-pin', class: 'form-select' }, options);
      dlg.body.append(h('label', { class: 'form-label', for: 'gwp-dis-pin', text: t('gwp.dis.pin') }), sel,
        h('p', { class: 'form-hint', text: t('gwp.dis.hint') }));
    }
    dlg.body.append(err);
    const ok = h('button', { type: 'button', class: 'btn btn-danger', 'data-fk': 'gwp-dis-ok', text: t('gwp.dis.ok') });
    ok.addEventListener('click', () => {
      ok.disabled = true;
      U.api('POST', API + '/' + p.id + '/dissolve', sel ? { pin_to: Number(sel.value) } : {}).then(() => {
        dlg.close(true);
        U.toast(t('gwp.dis.done', { name: p.name }));
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
        refresh().catch(() => {}).then(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
      }, (e) => { ok.disabled = false; U.showErr(err, errText(e)); });
    });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    dlg.foot.append(cancel, ok);
    cancel.focus();
  }

  // ─── Dialog "Pool anlegen" / "Pool bearbeiten" ────────────────────────
  function openCreate(opts) {
    if (!licensed) return lockDialog();
    return poolDialog(null, (opts && opts.preselect) || []);
  }
  function openEdit(p) {
    if (!licensed) return lockDialog();
    return poolDialog(p, (p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m) => m.peer_id));
  }
  function stepHead(n, label, forId) {
    return h('div', { class: 'gwp-step-h' }, [h('span', { class: 'gwp-num', 'aria-hidden': 'true', text: String(n) }),
      forId ? h('label', { class: 'gwp-step-l', for: forId, text: label }) : h('span', { class: 'gwp-step-l', id: 'gwp-dlg-gw-l', text: label })]);
  }
  function poolDialog(p, preselect) {
    const edit = !!p;
    const dlg = U.openDialog({ title: edit ? t('gwp.dlg.edit_title', { name: p.name }) : t('gwp.dlg.create_title'), wide: true, cls: 'gwp-dlg' });
    dlg.box.classList.add('gwp-pooldlg');
    const sel = preselect.map(String).filter((id) => gw(id));
    let coolTouched = edit;
    let candidates = null; // GET /migration-candidates (create only)
    const err = U.errorBox();
    const name = h('input', { type: 'text', id: 'gwp-dlg-name', class: 'form-input', maxLength: 80, autocomplete: 'off', value: edit ? p.name : '' });
    if (!edit && sel.length) name.value = gw(sel[0]).name;
    const gwBox = h('div', { class: 'gwp-opts', role: 'group', 'aria-labelledby': 'gwp-dlg-gw-l' });
    const coolNote = h('p', { class: 'form-hint' });
    const cs = cooldownSelect('gwp-dlg-cool', edit ? p.failback_cooldown_s : (PK.proposeCooldown(sel.length ? gw(sel[0]).platform : null) || {}).s || 180, null, () => { coolTouched = true; });
    cs.num.addEventListener('input', () => { coolTouched = true; });
    const routesBox = h('div', { class: 'gwp-fld' });
    let mode = edit ? p.mode : 'failover';
    const lb = edit ? lbSelect('gwp-dlg-lb', p.lb_policy || 'round_robin') : null;
    const lbWrap = lb ? h('div', { class: 'gwp-fld' }, [h('label', { class: 'form-label', for: 'gwp-dlg-lb', text: t('gwp.beh.lb') }), lb]) : null;
    const msg = edit ? h('textarea', { id: 'gwp-dlg-msg', class: 'form-input', rows: '2', maxLength: 500, placeholder: t('gwp.beh.msg_ph') }) : null;
    if (msg) msg.value = p.outage_message || '';
    let seg = null;
    function drawSeg() {
      const next = modeSeg(mode, (m2) => { mode = m2; drawSeg(); if (lbWrap) lbWrap.hidden = mode !== 'load_balancing'; }, 'gwp-dlg-mode');
      if (seg) seg.replaceWith(next);
      seg = next;
    }
    if (edit) { drawSeg(); lbWrap.hidden = mode !== 'load_balancing'; }

    function drawGateways() {
      const fk = gwBox.contains(document.activeElement) ? U.focusKey() : null;
      const first = sel.length ? gw(sel[0]) : null;
      const all = fleet().slice().sort((a, b) => {
        const ia = sel.indexOf(String(a.peer_id));
        const ib = sel.indexOf(String(b.peer_id));
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
        const la = first && PK.sameLan(first, a) ? 0 : 1;
        const lb2 = first && PK.sameLan(first, b) ? 0 : 1;
        return la - lb2 || String(a.name).localeCompare(String(b.name));
      });
      gwBox.replaceChildren(...all.map((g) => {
        const id = String(g.peer_id);
        const i = sel.indexOf(id);
        const cb = h('input', { type: 'checkbox', id: 'gwp-dlg-gw-' + id, 'data-fk': 'gwp-dlg-gw:' + id });
        cb.checked = i >= 0;
        cb.addEventListener('change', () => {
          const j = sel.indexOf(id);
          if (cb.checked && j < 0) sel.push(id);
          if (!cb.checked && j >= 0) sel.splice(j, 1);
          drawGateways(); proposal(); drawRoutes();
        });
        const sub = [platformText(id)];
        const lan = first && String(first.peer_id) !== id ? PK.sameLan(first, g) : null;
        if (lan) sub.push(t('gwp.dlg.same_lan', { lan }));
        const others = poolsOf(id).filter((x) => !p || x.id !== p.id);
        if (others.length) sub.push(t('gwp.dlg.in_pool', { pool: others.map((x) => x.name).join(', ') }));
        const online = g.status === 'online' || g.status === 'degraded';
        return h('label', { class: 'gwp-opt' + (i >= 0 ? ' gwp-opt-on' : ''), for: 'gwp-dlg-gw-' + id }, [cb,
          i >= 0 ? h('span', { class: 'tag ' + (i === 0 ? 'tag-blue' : 'tag-grey'), text: String(i + 1) }) : h('span', { class: 'gwp-opt-gap', 'aria-hidden': 'true' }),
          h('span', { class: 'gwp-opt-t' }, [h('strong', { text: g.name }), sub.filter(Boolean).length ? h('span', { class: 'gwe-d', text: ' · ' + sub.filter(Boolean).join(' · ') }) : null]),
          h('span', { class: 'tag tag-dot ' + (online ? 'tag-green' : 'tag-grey'), text: t(online ? 'gateways.online' : 'gateways.offline') })]);
      }));
      U.restoreFocus(gwBox, fk);
    }
    function proposal() {
      const first = sel.length ? gw(sel[0]) : null;
      if (!coolTouched) {
        const pr = PK.proposeCooldown(first ? first.platform : null);
        cs.sel.value = String(pr.s); cs.num.value = String(pr.s); cs.wrap.hidden = true;
        Array.from(cs.sel.options).forEach((o) => {
          const pre = PK.COOLDOWN_PRESETS.find((x) => String(x.s) === o.value);
          if (pre) o.textContent = t('gwp.cool.opt', { time: dur(pre.s), what: t('gwp.cool.' + pre.key) }) + (pre.key === pr.key ? ' ' + t('gwp.cool.proposed') : '');
        });
      }
      coolNote.textContent = edit ? t('gwp.beh.cool_hint')
        : (first ? t('gwp.dlg.cool_hint', { name: first.name }) : t('gwp.dlg.cool_hint_none')) + ' ' + t('gwp.dlg.mode_hint');
    }
    function drawRoutes() {
      if (edit) return;
      routesBox.replaceChildren();
      const first = sel.length ? gw(sel[0]) : null;
      if (!first || !candidates) { routesBox.hidden = true; return; }
      const mine = (candidates.routes || []).filter((r) => String(r.target_peer_id) === String(first.peer_id));
      if (!mine.length) { routesBox.hidden = true; return; }
      routesBox.hidden = false;
      const cb = h('input', { type: 'checkbox', id: 'gwp-dlg-take', 'data-fk': 'gwp-dlg-take' });
      cb.checked = true;
      const shown = mine.slice(0, 4).map((r) => r.domain).join(', ') + (mine.length > 4 ? ', …' : '');
      routesBox.append(stepHead(4, t('gwp.dlg.routes'), null),
        h('label', { class: 'gwp-opt', for: 'gwp-dlg-take' }, [cb, h('span', { class: 'gwp-opt-t' }, [
          t(mine.length === 1 ? 'gwp.dlg.take_one' : 'gwp.dlg.take', { n: mine.length, name: first.name }), ' ', h('span', { class: 'gwe-d', text: '· ' + shown })])]),
        h('p', { class: 'form-hint', text: t('gwp.dlg.take_hint') }));
      routesBox.querySelector('.gwp-step-l').removeAttribute('id');
      routesBox._ids = mine.map((r) => r.id);
    }

    dlg.body.append(...[h('p', { class: 'gwe-d', text: t('gwp.dlg.intro') }),
      h('div', { class: 'gwp-fld' }, [stepHead(1, t('gwp.dlg.name'), 'gwp-dlg-name'), name]),
      h('div', { class: 'gwp-fld' }, [stepHead(2, t('gwp.dlg.gateways'), null), h('p', { class: 'form-hint', text: t('gwp.dlg.gateways_hint') }), gwBox]),
      h('div', { class: 'gwp-fld' }, [stepHead(3, t('gwp.dlg.cool'), 'gwp-dlg-cool'), h('div', { class: 'gwp-cool-row' }, [cs.sel, cs.wrap]), coolNote]),
      edit ? h('div', { class: 'gwp-fld' }, [h('span', { class: 'form-label', id: 'gwp-dlg-mode-l', text: t('gwp.beh.mode') }), seg]) : null,
      lbWrap,
      edit ? h('div', { class: 'gwp-fld' }, [h('label', { class: 'form-label', for: 'gwp-dlg-msg', text: t('gwp.beh.msg') }), msg]) : null,
      routesBox, err].filter(Boolean));
    drawGateways(); proposal(); drawRoutes();
    if (!edit) {
      U.api('GET', API + '/migration-candidates').then((j) => { candidates = j || { routes: [] }; drawRoutes(); }, () => { candidates = null; });
    }

    const ok = h('button', { type: 'button', class: 'btn btn-primary', 'data-fk': 'gwp-dlg-ok', text: edit ? t('common.save') : t('gwp.dlg.create') });
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } });
    dlg.foot.append(cancel, ok);
    ok.addEventListener('click', async () => {
      U.showErr(err, '');
      const nm = name.value.trim();
      if (!nm) { U.showErr(err, t('gwp.err.name')); name.focus(); return; }
      if (!sel.length) { U.showErr(err, t('gwp.err.gateways')); const f = gwBox.querySelector('input'); if (f) f.focus(); return; }
      const cool = cs.value();
      if (!Number.isInteger(cool) || cool < 0) { U.showErr(err, t('gwp.err.cool')); cs.num.focus(); return; }
      ok.disabled = true;
      const members = sel.map((id, i) => ({ peer_id: Number(id), priority: i + 1 }));
      let id = edit ? p.id : null;
      let warn = false;
      try {
        if (edit) {
          const patch = { name: nm, failback_cooldown_s: cool, outage_message: msg.value.trim() || null, mode,
            lb_policy: mode === 'load_balancing' ? lb.value : null };
          try { await U.api('PUT', API + '/' + id, patch); } catch (e) { if (!savedAnyway(e)) throw e; warn = true; }
        } else {
          const r = await U.api('POST', API, { name: nm, mode: 'failover', failback_cooldown_s: cool });
          id = r.id;
        }
        const before = edit ? (p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m) => String(m.peer_id)).join() : null;
        if (!edit || before !== sel.join()) {
          try { await U.api('PUT', API + '/' + id + '/members', { members }); } catch (e) { if (!savedAnyway(e)) throw e; warn = true; }
        }
        const take = routesBox.querySelector('#gwp-dlg-take');
        if (!edit && take && take.checked && routesBox._ids && routesBox._ids.length) {
          await U.api('POST', API + '/' + id + '/migrate-routes', { route_ids: routesBox._ids });
        }
      } catch (e) {
        ok.disabled = false;
        U.showErr(err, errText(e));
        if (!edit && id) refresh().catch(() => {}); // created, but a later step failed: the pool is there
        return;
      }
      dlg.close(true);
      U.toast(warn ? t('gwp.err.confirm_timeout') : t(edit ? 'gwp.saved' : 'gwp.dlg.created', { name: nm }), warn ? 'warning' : 'success');
      await refresh().catch(() => {});
      if (location.hash !== '#pool/' + id) location.hash = '#pool/' + id;
    });
    name.focus();
    return dlg.promise;
  }

  // ─── "Zu einem Pool hinzufügen …" (gateway's "Mehr" menu) ─────────────
  function openAddTo(g) {
    if (!licensed) return lockDialog();
    const list = pools();
    if (!list.length) return openCreate({ preselect: [g.peer_id] });
    const dlg = U.openDialog({ title: t('gwp.addto.title', { name: g.name }), cls: 'gwp-dlg' });
    const box = h('div', { class: 'gwp-opts', role: 'radiogroup', 'aria-label': t('gwp.addto.title', { name: g.name }) });
    let firstFree = null;
    list.forEach((p) => {
      const inIt = !!PK.memberOf(p, g.peer_id);
      const r = h('input', { type: 'radio', name: 'gwp-addto', id: 'gwp-addto-' + p.id, value: String(p.id), disabled: inIt });
      if (!inIt && !firstFree) { firstFree = r; r.checked = true; }
      const lanWith = (p.members || []).map((m) => gw(m.peer_id)).filter(Boolean).map((x) => PK.sameLan(x, g)).find(Boolean);
      box.appendChild(h('label', { class: 'gwp-opt', for: 'gwp-addto-' + p.id }, [r, h('span', { class: 'gwp-opt-t' }, [
        h('strong', { text: t('gwp.pool_name', { name: p.name }) }),
        h('span', { class: 'gwe-d', text: ' · ' + (inIt ? t('gwp.addto.already') : (lanWith ? t('gwp.dlg.same_lan', { lan: lanWith }) : t('gwp.addto.members', { n: (p.members || []).length }))) })])]));
    });
    const nr = h('input', { type: 'radio', name: 'gwp-addto', id: 'gwp-addto-new', value: 'new' });
    if (!firstFree) nr.checked = true;
    box.appendChild(h('label', { class: 'gwp-opt', for: 'gwp-addto-new' }, [nr, h('span', { class: 'gwp-opt-t' }, [h('strong', { text: t('gwp.addto.new', { name: g.name }) })])]));
    const err = U.errorBox();
    dlg.body.append(h('p', { class: 'gwe-d', text: t('gwp.addto.text') }), box, err);
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwp.addto.ok') });
    ok.addEventListener('click', () => {
      const v = (box.querySelector('input:checked') || {}).value;
      if (!v) return;
      if (v === 'new') { dlg.close(true); openCreate({ preselect: [g.peer_id] }); return; }
      const p = pool(v);
      ok.disabled = true;
      const ids = (p.members || []).slice().sort((a, b) => a.priority - b.priority).map((m) => m.peer_id).concat([g.peer_id]);
      U.api('PUT', API + '/' + p.id + '/members', { members: ids.map((id, i) => ({ peer_id: Number(id), priority: i + 1 })) })
        .then(() => true, (e) => { if (savedAnyway(e)) return true; ok.disabled = false; U.showErr(err, errText(e)); return false; })
        .then((done) => {
          if (!done) return;
          dlg.close(true);
          U.toast(t('gwp.mem.added', { name: g.name }));
          refresh().catch(() => {}).then(() => { location.hash = '#pool/' + p.id; });
        });
    });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok);
    (firstFree || nr).focus();
    return dlg.promise;
  }

  // ─── "Routen hierher umziehen" (the migration dialog of the former page) ─
  function loopback(host) {
    const s = String(host || '').toLowerCase();
    return s === '::1' || s === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
  }
  function openMigrate(poolId) {
    if (!licensed) return lockDialog();
    const dlg = U.openDialog({ title: t('gateway_pools.migrate_routes'), wide: true, cls: 'gwp-dlg' });
    dlg.box.classList.add('gwp-migdlg');
    const err = U.errorBox();
    const box = h('div', { class: 'gwp-mig' }, h('p', { class: 'gwe-loading', role: 'status', text: t('gwe.loading') }));
    let data = { routes: [], pools: [] };
    let mode = 'pool';
    const modeBox = h('div', { class: 'gwp-opts', role: 'radiogroup', 'aria-label': t('gateway_pools.migrate_mode') }, ['pool', 'relocate'].map((m) => {
      const r = h('input', { type: 'radio', name: 'gwp-mig-mode', id: 'gwp-mig-mode-' + m, value: m });
      r.checked = m === mode;
      r.addEventListener('change', () => { mode = m; draw(); });
      return h('label', { class: 'gwp-opt', for: 'gwp-mig-mode-' + m }, [r, h('span', { class: 'gwp-opt-t', text: t('gateway_pools.migrate_mode_' + m) })]);
    }));
    dlg.body.append(modeBox, box, err);
    const checks = () => Array.from(box.querySelectorAll('input[name="gwp-mig-route"]'));
    function draw() {
      box.replaceChildren();
      const routes = data.routes || [];
      const ps = data.pools || [];
      box.appendChild(h('p', { class: 'gwe-d', text: t('gateway_pools.migrate_help') }));
      let poolSel = null;
      let gwSel = null;
      let dl = null;
      if (mode === 'pool') {
        if (!ps.length) { box.appendChild(h('p', { class: 'gwe-empty', text: t('gateway_pools.no_pools_for_migration') })); return; }
        poolSel = h('select', { id: 'gwp-mig-pool', class: 'form-select' }, ps.map((x) => {
          const o = h('option', { value: String(x.id), text: x.name + ' (' + t('gwp.mode.' + x.mode) + ')' });
          if (String(x.id) === String(poolId)) o.selected = true;
          return o;
        }));
        box.append(h('label', { class: 'form-label', for: 'gwp-mig-pool', text: t('gateway_pools.target_pool') }), poolSel);
      } else {
        gwSel = h('select', { id: 'gwp-mig-gw', class: 'form-select' }, fleet().map((g) => h('option', { value: String(g.peer_id), text: g.name })));
        const bulk = h('input', { type: 'text', class: 'form-input', id: 'gwp-mig-bulk', placeholder: t('gateway_pools.relocate_bulk_ip'), 'aria-label': t('gateway_pools.relocate_bulk_ip') });
        bulk.addEventListener('input', () => box.querySelectorAll('input[data-lan]').forEach((i) => { i.value = bulk.value; }));
        dl = h('datalist', { id: 'gwp-mig-hosts' });
        box.append(h('label', { class: 'form-label', for: 'gwp-mig-gw', text: t('gateway_pools.relocate_target_gateway') }), gwSel, bulk, dl);
        const hosts = () => {
          fetch('/api/v1/gateways/' + encodeURIComponent(gwSel.value) + '/discovered', { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null)).then((d) => {
              if (!d || !Array.isArray(d.devices)) return;
              dl.replaceChildren(...d.devices.map((x) => h('option', { value: x.ip, label: x.hostname ? x.hostname + ' (' + x.ip + ')' : x.ip })));
            }).catch(() => { /* free text always works */ });
        };
        gwSel.addEventListener('change', hosts);
        if (gwSel.value) hosts();
      }
      if (!routes.length) { box.appendChild(h('p', { class: 'gwe-empty', text: t('gateway_pools.migrate_no_routes') })); return; }
      const selAll = h('button', { type: 'button', class: 'gwn-linkbtn', text: t('gateway_pools.select_all'), on: { click: () => checks().forEach((c) => { c.checked = true; }) } });
      const selNone = h('button', { type: 'button', class: 'gwn-linkbtn', text: t('gateway_pools.select_none'), on: { click: () => checks().forEach((c) => { c.checked = false; }) } });
      box.append(h('div', { class: 'gwp-mig-head' }, [h('span', { class: 'form-label', text: t('gateway_pools.migrate_routes_label') }), selAll, ' · ', selNone]));
      const groups = new Map();
      routes.forEach((r) => {
        const k = r.peer_name || ('#' + r.target_peer_id);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      });
      groups.forEach((list, k) => {
        box.appendChild(h('div', { class: 'gwp-mig-group', text: k }));
        list.forEach((r) => {
          const cb = h('input', { type: 'checkbox', name: 'gwp-mig-route', id: 'gwp-mig-r' + r.id, value: String(r.id) });
          cb.checked = !loopback(r.target_lan_host);
          const tgt = (r.target_lan_host || r.target_ip) + ':' + (r.target_lan_port || r.target_port);
          const row = h('div', { class: 'gwp-mig-row' }, [h('label', { class: 'gwp-opt', for: 'gwp-mig-r' + r.id }, [cb, h('span', { class: 'gwp-opt-t' }, [
            h('strong', { text: r.domain }), ' ', h('code', { class: 'gwe-mono', text: '→ ' + tgt }),
            loopback(r.target_lan_host) ? h('span', { class: 'gwn-hint', text: ' ⚠ ' + t('gateway_pools.migrate_loopback_warn') }) : null])])]);
          if (mode === 'relocate') {
            row.appendChild(h('input', { type: 'text', class: 'form-input gwp-mig-lan', 'data-lan': String(r.id), 'data-port': String(r.target_lan_port || r.target_port || ''),
              list: 'gwp-mig-hosts', value: r.target_lan_host || '', 'aria-label': t('gateway_pools.relocate_lan_host') + ': ' + r.domain }));
          }
          box.appendChild(row);
        });
      });
      box._poolSel = poolSel; box._gwSel = gwSel;
    }
    U.api('GET', API + '/migration-candidates').then((j) => { data = j || data; draw(); }, (e) => { box.replaceChildren(U.note('crit', [t('gateway_pools.migrate_load_failed'), ' ', errText(e)])); });
    const ok = h('button', { type: 'button', class: 'btn btn-primary', text: t('gwp.mig.ok') });
    ok.addEventListener('click', () => {
      U.showErr(err, '');
      const ids = checks().filter((c) => c.checked).map((c) => parseInt(c.value, 10));
      if (!ids.length) { U.showErr(err, t('gateway_pools.migrate_no_selection')); return; }
      let call;
      if (mode === 'relocate') {
        if (!box._gwSel || !box._gwSel.value) { U.showErr(err, t('gateway_pools.relocate_no_gateway')); return; }
        const items = ids.map((id) => {
          const inp = box.querySelector('input[data-lan="' + id + '"]');
          return { id, target_lan_host: inp ? inp.value.trim() : '', target_lan_port: inp ? parseInt(inp.getAttribute('data-port'), 10) : null };
        });
        call = U.api('POST', '/api/v1/routes/relocate', { target_peer_id: parseInt(box._gwSel.value, 10), items });
      } else {
        if (!box._poolSel || !box._poolSel.value) { U.showErr(err, t('gateway_pools.no_pools_for_migration')); return; }
        call = U.api('POST', API + '/' + box._poolSel.value + '/migrate-routes', { route_ids: ids });
      }
      ok.disabled = true;
      call.then((j) => {
        dlg.close(true);
        U.toast(t('gwp.mig.done', { n: (j && (j.migrated != null ? j.migrated : j.moved)) || 0 }));
        refresh().catch(() => {});
      }, (e) => { ok.disabled = false; U.showErr(err, (e && e.body && e.body.error) || errText(e)); });
    });
    dlg.foot.append(h('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => dlg.close(null) } }), ok);
    modeBox.querySelector('input').focus();
    return dlg.promise;
  }

  window.GCGatewayPools = {
    licensed, lbLicensed, init, load, state, pools, poolsOf, pool,
    groupSection, poolCard, renderPool, busy, lockTag,
    openCreate, openEdit, openAddTo, openMigrate, lockDialog,
  };
})();
