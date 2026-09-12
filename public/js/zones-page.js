'use strict';

// Domains & Routen — zones page (zones.njk). Lists zones (base domains) as
// collapsible cards with one row per host; editing happens in the domain
// modal (domain-modal.js). Data: GET /api/v1/zones, re-fetched after every
// mutation and on gc:routes / gc:monitor / gc:reconnected.
(function () {
  const V = window.GCZonesView;
  const UI = window.GCZonesUI;
  const DM = window.GCDomainModal;
  const root = document.getElementById('zn-zones');
  if (!V || !UI || !root) return;
  const { t, el, icon } = UI;
  const $ = (id) => document.getElementById(id);

  const LS_COLLAPSED = 'gc_zones_collapsed_v1';
  const MANY_HOSTS = 12;       // zones above this show the first PREVIEW_HOSTS + "n more"
  const PREVIEW_HOSTS = 10;

  const state = {
    data: null,
    lastSync: null,
    error: null,
    errorToasted: false,
    stale: false,
    f: { q: '', type: null, access: null, state: null, gatewayKey: null },
    collapsed: readCollapsed(),
    showAll: new Set(),
  };

  function readCollapsed() {
    try { return new Set(JSON.parse(UI.lsGet(LS_COLLAPSED, '[]'))); } catch (_) { return new Set(); }
  }
  function saveCollapsed() { UI.lsSet(LS_COLLAPSED, JSON.stringify(Array.from(state.collapsed))); }

  // "1 Domain" / "4 Domains": optional '<key>_one' variant for count 1.
  function tn(key, n) {
    const one = window.GC.t && window.GC.t[key + '_one'];
    return n === 1 && one ? one.split('{{count}}').join('1') : t(key, { count: n });
  }

  // ─── Loading ───────────────────────────────────────────────────────────
  let inflight = null;
  let rerun = false;
  function load() {
    if (inflight) { rerun = true; return inflight; }
    inflight = (async () => {
      try {
        do {
          rerun = false;
          const res = await UI.call(api.get('/api/v1/zones'));
          state.data = {
            zones: res.zones || [],
            unassigned: res.unassigned || [],
            gateways: res.gateways || [],
            pools: res.pools || [],
            peers: res.peers || null,
          };
          state.lastSync = new Date();
        } while (rerun);
        state.error = null;
        state.errorToasted = false;
        render();
        if (DM) DM.refresh();
      } catch (err) {
        state.error = err;
        if (!state.data) render();
        else if (!state.errorToasted) { state.errorToasted = true; UI.toastError(err); }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  let debounceTimer = null;
  function scheduleLoad() {
    if (document.hidden) { state.stale = true; return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  // Page re-renders wait while a popup menu is open (it would lose its anchor).
  let renderPending = false;
  UI.onMenuClosed(() => { if (renderPending) setTimeout(render, 0); });

  // Nearest scrolling ancestor (default/aurora: <main>, pro: the wrapper).
  function scroller() {
    for (let n = root.parentElement; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function render() {
    if (UI.menuOpen() && root.querySelector('.zn-ibtn[aria-expanded="true"]')) { renderPending = true; return; }
    renderPending = false;
    const sc = scroller();
    const top = sc.scrollTop;
    if (!state.data) {
      root.replaceChildren(state.error
        ? el('div', { class: 'zn-empty zn-error', role: 'alert' }, [icon('alert', 16), UI.errMsg(state.error),
          el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm', text: t('zones.retry'), on: { click: () => load() } })])
        : el('div', { class: 'zn-empty', text: t('common.loading') }));
      return;
    }
    const all = V.pageZones(state.data);
    renderSummary(all);
    renderGatewayFilter(all);
    const active = V.isFilterActive(state.f);
    const zones = V.filterZones(all, state.f);
    renderChips(all);

    const nodes = [];
    if (!all.length) {
      nodes.push(el('div', { class: 'card zn-empty-card' }, [
        el('div', { class: 'zn-empty-title', text: t('zones.empty_title') }),
        el('div', { class: 'zn-empty-text', text: t('zones.empty_text') }),
        el('button', { type: 'button', class: 'btn btn-primary', on: { click: openAddDomain } }, [icon('plus', 14), t('zones.add_domain')]),
      ]));
    } else if (!zones.length) {
      nodes.push(el('div', { class: 'zn-empty' }, [t('zones.no_match'), ' ',
        el('button', { type: 'button', class: 'zn-link zn-link-btn', text: t('zones.reset_filters'), on: { click: resetFilters } })]));
    } else {
      const fullByKey = new Map(all.map((z) => [V.zoneKey(z), z]));
      zones.forEach((z) => nodes.push(renderZone(z, fullByKey.get(V.zoneKey(z)) || z, active)));
    }
    root.replaceChildren(...nodes);
    updateCollapseAll(zones, active);
    sc.scrollTop = top;
  }

  function renderSummary(all) {
    const s = V.summarize(all);
    const parts = [tn('zones.sum_domains', s.domains), tn('zones.sum_hosts', s.hosts), tn('zones.sum_l4', s.l4)];
    if (s.disabled) parts.push(tn('zones.sum_disabled', s.disabled));
    const sum = $('zn-summary');
    if (sum) sum.textContent = parts.join(' · ');
    const kpis = $('zn-kpis');
    if (kpis) {
      const chip = (n, key, cls) => el('div', { class: 'aurora-routes-kpi' + (cls ? ' ' + cls : '') }, [el('b', { text: String(n) }), el('span', { text: t(key) })]);
      kpis.replaceChildren(...[
        chip(s.domains, 'zones.kpi_domains'),
        chip(s.hosts, 'zones.kpi_hosts'),
        chip(s.l4, 'zones.kpi_l4'),
        s.disabled ? chip(s.disabled, 'zones.kpi_disabled', 'dim') : null,
      ].filter(Boolean));
    }
  }

  function renderChips(all) {
    const box = $('zn-chips');
    if (!box) return;
    const f = state.f;
    box.querySelectorAll('[data-dim]').forEach((b) => {
      const dim = b.dataset.dim;
      const on = dim === 'all' ? !(f.type || f.access || f.state) : f[dim] === b.dataset.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const cnt = $('zn-chip-all-count');
    if (cnt) cnt.textContent = String(V.summarize(all).hosts);
  }

  function renderGatewayFilter(all) {
    const sel = $('zn-gateway-filter');
    if (!sel) return;
    const choices = V.gatewayChoices(all);
    if (state.f.gatewayKey && !choices.some((c) => c.key === state.f.gatewayKey)) state.f.gatewayKey = null;
    const opts = [el('option', { value: '', text: t('zones.gateway_filter_all') })];
    choices.forEach((c) => {
      const label = c.kind === 'pool' ? t('zones.gateway_pool', { name: c.name }) : c.name;
      opts.push(el('option', { value: c.key, text: label }));
    });
    sel.replaceChildren(...opts);
    sel.value = state.f.gatewayKey || '';
    sel.hidden = choices.length < 2 && !state.f.gatewayKey;
  }

  function updateCollapseAll(zones, active) {
    const btn = $('zn-collapse-all');
    if (!btn) return;
    const keys = zones.map(V.zoneKey);
    btn.hidden = !keys.length || active;
    const allCollapsed = keys.length > 0 && keys.every((k) => state.collapsed.has(k));
    const lbl = btn.querySelector('.zn-collapse-lbl') || btn;
    lbl.textContent = allCollapsed ? t('zones.expand_all') : t('zones.collapse_all');
    btn.dataset.allCollapsed = allCollapsed ? '1' : '';
  }

  function zoneMeta(zone) {
    const c = V.countEntries(zone);
    const parts = [tn('zones.meta_hosts', c.hosts), tn('zones.meta_l4', c.l4)];
    if (c.disabled) parts.push(tn('zones.meta_disabled', c.disabled));
    return parts.join(' · ');
  }

  // zone: filtered copy (rows); full: unfiltered zone (health, counts).
  function renderZone(zone, full, filterActive) {
    const key = V.zoneKey(zone);
    const collapsed = !filterActive && state.collapsed.has(key);
    const g = zone.gateway || {};

    const editBtn = el('button', {
      type: 'button', class: 'btn btn-ghost zn-btn-sm zn-edit-domain',
      on: { click: (e) => { e.stopPropagation(); openDomain(zone.domain_id); } },
    }, [icon('pencil', 13), zone.unassigned ? t('zones.edit_hosts') : t('zones.edit_domain')]);

    const head = el('div', {
      class: 'zn-zone-head', role: 'button', tabindex: '0', 'aria-expanded': collapsed ? 'false' : 'true',
      on: {
        click: (e) => { if (!e.target.closest('button,a,.zn-ibtn')) toggleZone(key, filterActive); },
        keydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleZone(key, filterActive); } },
      },
    }, [
      el('span', { class: 'zn-chev' }, [icon('down', 16)]),
      UI.healthDot(full.health || V.worstHealth(full.hosts.map(V.hostHealth))),
      el('span', { class: 'zn-domain', text: zone.unassigned ? t('zones.unassigned') : zone.domain }),
      zone.unassigned ? null : UI.verificationTag(zone),
      zone.unassigned ? null : el('span', { class: 'zn-gw-pill' + (g.online === false ? ' off' : ''), title: g.online === false ? t('zones.gateway_offline_hint') : null }, [
        icon(UI.gatewayIconName(g.kind), 12), UI.gatewayLabel(g),
      ]),
      el('span', { class: 'zn-meta', text: zoneMeta(full) }),
      el('span', { class: 'zn-spacer' }),
      editBtn,
      zone.unassigned ? null : el('button', {
        type: 'button', class: 'zn-ibtn', title: t('zones.domain_menu'), 'aria-label': t('zones.domain_menu'), 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        on: { click: (e) => { e.stopPropagation(); UI.openMenu(e.currentTarget, zoneMenuItems(zone)); } },
      }, [icon('more', 13)]),
    ]);

    const card = el('div', { class: 'card zn-zone' + (collapsed ? ' zn-collapsed' : ''), dataset: { zoneKey: key } }, [head]);
    if (collapsed) return card;

    const rows = [zone.hosts.length ? el('div', { class: 'zn-hrow zn-hrow-th', 'aria-hidden': 'true' }, [
      el('div', { class: 'zn-col-name zn-th', text: t('zones.col_name') }),
      el('div', { class: 'zn-col-target zn-th', text: t('zones.col_target') }),
      el('div', { class: 'zn-col-entries zn-th', text: t('zones.col_entries') }),
      el('div', { class: 'zn-col-access zn-th', text: t('zones.col_access') }),
      el('div', { class: 'zn-col-status zn-th', text: t('zones.col_status') }),
      el('div', { class: 'zn-col-actions' }),
    ]) : null];
    let hosts = zone.hosts;
    let hidden = 0;
    if (!filterActive && hosts.length > MANY_HOSTS && !state.showAll.has(key)) {
      hidden = hosts.length - PREVIEW_HOSTS;
      hosts = hosts.slice(0, PREVIEW_HOSTS);
    }
    hosts.forEach((h) => rows.push(renderHostRow(h, zone)));
    if (hidden) {
      rows.push(el('button', { type: 'button', class: 'zn-hrow zn-more', on: { click: () => { state.showAll.add(key); render(); } } }, [
        t('zones.more_hosts', { count: hidden }),
      ]));
    }
    if (!zone.hosts.length) {
      rows.push(el('div', { class: 'zn-hrow zn-zone-empty' }, [
        el('span', { class: 'zn-muted', text: t('zones.zone_empty') }), ' ',
        el('button', { type: 'button', class: 'zn-link zn-link-btn', text: t('zones.zone_empty_add'), on: { click: () => openDomain(zone.domain_id) } }),
      ]));
    }
    card.appendChild(el('div', { class: 'zn-zone-body' }, rows));
    return card;
  }

  function renderHostRow(host, zone) {
    const on = V.hostEnabled(host);
    const health = V.hostHealth(host);
    const apex = V.isApex(host);
    const port = V.hostSinglePort(host);
    const target = V.hostTarget(host);
    const httpEntry = (host.entries || []).find((e) => !V.isL4(e));

    const nameLine = el('div', { class: 'zn-name-line' }, [
      host.template === 'printer' ? icon('printer', 12) : null,
      el('span', { class: 'zn-name', text: V.hostLabel(host) }),
      apex && host.fqdn ? el('span', { class: 'zn-fqdn', text: host.fqdn }) : null,
      host.gateway_override ? UI.tag('amber', t('host.override_tag'), false, 'zn-tag-sm') : null,
    ]);
    const desc = [];
    if (host.description) desc.push(host.description);
    if (host.template) desc.push(t('host.template_badge', { name: t('template.' + host.template) }));

    const actions = el('div', { class: 'zn-col-actions' }, [
      UI.ibtn('pencil', t('zones.edit_host'), () => openDomain(zone.domain_id, host.id)),
      httpEntry && httpEntry.enabled && host.fqdn
        ? el('a', { class: 'zn-ibtn', href: 'https://' + host.fqdn, target: '_blank', rel: 'noopener', title: t('host.open'), 'aria-label': t('host.open'), on: { click: (e) => e.stopPropagation() } }, [icon('ext', 13)])
        : null,
    ]);

    return el('div', {
      class: 'zn-hrow zn-host' + (on ? '' : ' off'), role: 'button', tabindex: '0', title: host.fqdn || null,
      dataset: { hostId: String(host.id) },
      on: {
        click: (e) => { if (!e.target.closest('button,a')) openDomain(zone.domain_id, host.id); },
        keydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openDomain(zone.domain_id, host.id); } },
      },
    }, [
      el('div', { class: 'zn-col-name' }, [nameLine, desc.length ? el('div', { class: 'zn-desc', text: desc.join(' · ') }) : null]),
      el('div', { class: 'zn-col-target' }, [
        icon(UI.gatewayIconName((V.parseGatewayKey(V.hostGatewayKey(host, zone)) || {}).kind), 13),
        el('span', { class: 'zn-mono', text: target ? (port ? target + ' : ' + port : target) : '—' }),
      ]),
      el('div', { class: 'zn-col-entries' }, V.sortEntries(host.entries).map((e) => (e.rdp_owned
        ? el('span', { class: 'zn-chip zn-chip-rdp', title: t('entry.rdp_hint') }, [icon('rdp', 11), el('span', { class: 'zn-chip-port', text: String(e.l4_listen_port || '') }), el('span', { class: 'zn-chip-note', text: t('entry.rdp_tag') })])
        : UI.chipEl(e)))),
      el('div', { class: 'zn-col-access' }, [UI.accessTag(V.hostAccess(host))]),
      el('div', { class: 'zn-col-status' }, [UI.healthDot(health), el('span', { class: 'zn-status-text', text: UI.hostStatusText(host, zone) })]),
      actions,
    ]);
  }

  function zoneMenuItems(zone) {
    return [
      { icon: 'pencil', label: t('zones.edit_domain'), onClick: () => openDomain(zone.domain_id) },
      { icon: 'refresh', label: t('zones.reverify'), onClick: () => reverify(zone) },
      { icon: 'settings', label: t('zones.domain_settings'), onClick: () => { window.location.href = '/settings'; } },
    ];
  }

  async function reverify(zone) {
    try {
      const res = await UI.call(api.post('/api/settings/domains/' + zone.domain_id + '/verify', {}));
      const status = res.data && res.data.status;
      if (status === 'verified') UI.toastOk(t('zones.reverify_ok', { domain: zone.domain }));
      else UI.toastError(t('zones.reverify_pending', { domain: zone.domain }));
      await load();
    } catch (err) { UI.toastError(err); }
  }

  function toggleZone(key, filterActive) {
    if (filterActive) return;
    if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key);
    saveCollapsed();
    render();
  }

  function openDomain(domainId, hostId) {
    if (!DM) return;
    DM.open(domainId, { focusHostId: hostId });
  }

  function resetFilters() {
    state.f = { q: '', type: null, access: null, state: null, gatewayKey: null };
    const s = $('zn-search');
    if (s) s.value = '';
    render();
  }

  // ─── "Domain hinzufügen" ───────────────────────────────────────────────
  function openAddDomain() {
    let submit;
    const d = UI.dialog({ title: t('zones.add_domain'), onEnter: () => submit.click() });
    const input = el('input', { type: 'text', class: 'form-input zn-input zn-mono', placeholder: 'example.com', 'aria-label': t('zones.domain_name'), maxLength: 253, autocomplete: 'off', spellcheck: 'false' });
    const status = el('div', { class: 'zn-domain-status', 'aria-live': 'polite' });
    d.body.appendChild(el('label', { class: 'form-label', text: t('zones.domain_name') }));
    d.body.appendChild(input);
    d.body.appendChild(el('span', { class: 'form-hint', text: t('zones.add_domain_hint') }));
    d.body.appendChild(status);
    let added = null;

    function showStatus(row) {
      const verified = row.status === 'verified';
      status.replaceChildren(el('div', { class: 'zn-domain-result' }, [
        UI.verificationTag({ verification: row.status || 'pending' }),
        el('span', { class: 'zn-mono', text: row.domain }),
      ]));
      if (!verified) {
        status.appendChild(el('p', { class: 'zn-dialog-detail', text: row.status === 'failed' ? t('zones.domain_failed_hint') : t('zones.domain_pending_hint') }));
        if (row.resolved_ip) status.appendChild(el('p', { class: 'zn-dialog-detail zn-mono', text: t('zones.domain_resolves_to', { ip: row.resolved_ip }) }));
      }
    }

    submit = el('button', { type: 'button', class: 'btn btn-primary', text: t('zones.add_domain_submit') });
    submit.addEventListener('click', async () => {
      if (added) { // second click = re-check DNS
        UI.busy(submit, true);
        try {
          const res = await UI.call(api.post('/api/settings/domains/' + added.id + '/verify', {}));
          added = res.data || added;
          showStatus(added);
          if (added.status === 'verified') { UI.toastOk(t('zones.domain_added_verified', { domain: added.domain })); d.close(true); }
          load();
        } catch (err) { UI.toastError(err); } finally { UI.busy(submit, false); }
        return;
      }
      const domain = input.value.trim().toLowerCase().replace(/\.+$/, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        status.replaceChildren(el('div', { class: 'zn-field-error', role: 'alert', text: t('zones.domain_invalid') }));
        input.focus();
        return;
      }
      UI.busy(submit, true);
      try {
        const res = await UI.call(api.post('/api/settings/domains', { domain }));
        const row = res.data || { domain, status: 'pending' };
        load();
        if (row.status === 'verified') {
          UI.toastOk(t('zones.domain_added_verified', { domain: row.domain || domain }));
          d.close(true);
          return;
        }
        added = row;
        input.disabled = true;
        showStatus(row);
        UI.busy(submit, false);
        submit.textContent = t('zones.reverify');
        cancel.textContent = t('common.close');
        return;
      } catch (err) {
        status.replaceChildren(el('div', { class: 'zn-field-error', role: 'alert', text: UI.errMsg(err) }));
      }
      UI.busy(submit, false);
    });
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } });
    d.foot.appendChild(cancel);
    d.foot.appendChild(submit);
    input.focus();
  }

  // ─── Toolbar wiring ────────────────────────────────────────────────────
  function initToolbar() {
    const search = $('zn-search');
    let qTimer = null;
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => { state.f.q = search.value; render(); }, 150);
      });
    }
    const chips = $('zn-chips');
    if (chips) {
      chips.addEventListener('click', (e) => {
        const b = e.target.closest('[data-dim]');
        if (!b) return;
        const dim = b.dataset.dim;
        if (dim === 'all') { state.f.type = null; state.f.access = null; state.f.state = null; }
        else state.f[dim] = state.f[dim] === b.dataset.value ? null : b.dataset.value;
        render();
      });
    }
    const gw = $('zn-gateway-filter');
    if (gw) gw.addEventListener('change', () => { state.f.gatewayKey = gw.value || null; render(); });

    const ca = $('zn-collapse-all');
    if (ca) {
      ca.addEventListener('click', () => {
        const keys = V.filterZones(V.pageZones(state.data), state.f).map(V.zoneKey);
        const expand = ca.dataset.allCollapsed === '1';
        keys.forEach((k) => { if (expand) state.collapsed.delete(k); else state.collapsed.add(k); });
        saveCollapsed();
        render();
      });
    }
    const add = $('zn-add-domain');
    if (add) add.addEventListener('click', openAddDomain);

    const legacy = $('zn-legacy-link');
    if (legacy) {
      legacy.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await UI.call(api.put('/api/v1/zones/ui-mode', { mode: 'legacy' }));
          window.location.href = '/routes';
        } catch (_) {
          window.location.href = legacy.getAttribute('href') || '/routes/legacy';
        }
      });
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────
  if (DM) DM.bind({ getData: () => state.data, reload: load, lastSync: () => state.lastSync });
  initToolbar();
  render();
  load();

  ['gc:routes', 'gc:monitor', 'gc:reconnected'].forEach((ev) => document.addEventListener(ev, scheduleLoad));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.stale) { state.stale = false; scheduleLoad(); }
  });

  window.GCZonesPage = { reload: load, openDomain, openAddDomain, getData: () => state.data };
})();
