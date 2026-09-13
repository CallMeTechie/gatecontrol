'use strict';

// WAF page (waf.njk, all three themes; docs/feature-waf.md, "Oberfläche").
// Tiles and the routes-with-WAF list from GET /api/v1/waf/status, the event
// table from GET /api/v1/waf/events (filters host / action / period, cursor
// pagination "Ältere Ereignisse laden"), row actions "Regel für diese Route
// ausschließen" / "Pfad ausschließen" (dialogs from waf-ui.js → POST
// /waf/routes/:id/exclusions), live reload on gc:waf (debounced). Deep link
// /waf?host=<fqdn>[&action=blocked|detected][&range=7d|30d]. A 404 of the
// WAF API or engine_available:false degrade to hints. DOM via el() only.
(function () {
  const list = document.getElementById('wf-events-list');
  if (!list) return;
  const W = window.GCWafUI;
  const $ = (id) => document.getElementById(id);
  const COLS = 8;
  const ROUTE_COLS = 6;

  if (!W) {
    // waf-ui.js missing: keep the page readable instead of throwing.
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = COLS;
    td.textContent = 'waf-ui.js not loaded';
    tr.appendChild(td);
    list.replaceChildren(tr);
    return;
  }
  const { t, el, icon } = W;

  const state = {
    filter: W.parseDeepLink(window.location.search),
    status: null,          // W.statusFrom() result, null before the first load
    statusError: null,
    events: null,          // loaded events (all pages), null before the first load
    next: null,            // cursor of the next (older) page
    pages: 0,
    eventsError: null,
    missing: false,        // WAF API answers 404 (backend without the feature)
    loadingMore: false,
    pendingNew: false,     // gc:waf while older pages are shown → notice instead of reload
    expanded: new Set(),   // event keys with the raw record open
    excluded: new Set(),   // 'rule:<route>:<id>' / 'path:<route>:<path>' added on this page
    lastLoaded: null,
  };

  // ─── Loading ───────────────────────────────────────────────────────────
  let seq = 0;
  async function loadStatus() {
    try {
      state.status = await W.fetchStatus({ fresh: true });
      state.statusError = null;
      state.missing = false;
    } catch (err) {
      state.statusError = err;
      if (W.isNotFound(err)) state.missing = true;
    }
  }
  async function loadEvents() {
    const my = ++seq;
    const filter = Object.assign({}, state.filter);
    try {
      const res = await W.fetchEvents(filter);
      if (my !== seq) return;
      state.events = res.events.filter((e) => W.matchesFilter(e, filter));
      state.next = res.next_cursor;
      state.pages = 1;
      state.eventsError = null;
      state.pendingNew = false;
      state.lastLoaded = new Date();
    } catch (err) {
      if (my !== seq) return;
      state.eventsError = err;
      if (W.isNotFound(err)) state.missing = true;
    }
  }
  let inflight = null;
  let rerun = false;
  function reload() {
    if (inflight) { rerun = true; return inflight; }
    inflight = (async () => {
      try {
        do {
          rerun = false;
          await Promise.all([loadStatus(), loadEvents()]);
        } while (rerun);
      } finally {
        inflight = null;
        render();
      }
    })();
    return inflight;
  }
  async function loadMore(btn) {
    if (!state.next || state.loadingMore) return;
    state.loadingMore = true;
    W.busy(btn, true);
    const my = seq;
    const filter = Object.assign({}, state.filter);
    try {
      const res = await W.fetchEvents(filter, { cursor: state.next });
      if (my !== seq) return;
      state.events = W.mergeEvents(state.events || [], res.events.filter((e) => W.matchesFilter(e, filter)));
      state.next = res.next_cursor;
      state.pages += 1;
    } catch (err) {
      W.toast(W.errMsg(err), 'error');
    } finally {
      state.loadingMore = false;
      W.busy(btn, false);
      render();
    }
  }
  async function reloadStatusOnly() {
    await loadStatus();
    render();
  }

  // Live reload: gc:waf ({ host, action, rule_id }) — debounced. With older
  // pages loaded the list stays and a notice offers the refresh.
  let debounceTimer = null;
  let stale = false;
  let pendingNewEvent = false;   // a gc:waf that matches the current filter
  let pendingList = false;       // periodic / reconnect: refresh the first page
  function onWafEvent(e) {
    const d = e && e.detail;
    if (!d || eventAffectsList(d)) pendingNewEvent = true;
    schedule();
  }
  function scheduleReload() { pendingList = true; schedule(); }
  function schedule() {
    if (document.hidden) { stale = true; return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const fresh = pendingNewEvent;
      const list = pendingList || fresh;
      pendingNewEvent = false;
      pendingList = false;
      // With older pages loaded the list stays put: notice instead of reload.
      if (state.pages > 1) { if (fresh) state.pendingNew = true; reloadStatusOnly(); return; }
      if (list) reload(); else reloadStatusOnly();
    }, 800);
  }
  function eventAffectsList(d) {
    const f = state.filter;
    if (f.host && d.host && String(d.host).toLowerCase() !== f.host) return false;
    if (f.action !== 'all' && d.action && W.actionKey(d.action) !== f.action) return false;
    return true;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    renderTiles();
    renderBanner();
    renderFilters();
    renderSummary();
    renderRows();
    renderPager();
    renderRoutes();
  }
  function totals() { return state.status ? state.status.totals : null; }
  function routes() { return state.status ? state.status.routes : []; }

  function renderTiles() {
    const s = totals();
    [['events', s && s.events_24h], ['blocked', s && s.blocked_24h], ['routes', s && s.routes]].forEach(([k, n]) => {
      const v = $('wf-tile-' + k + '-val');
      if (v) v.textContent = s ? String(n || 0) : '–';
      const tile = $('wf-tile-' + k);
      if (tile) {
        tile.classList.toggle('warn', k === 'blocked' && (n || 0) > 0);
        tile.classList.toggle('on', !!tile.dataset.action && tile.dataset.action !== 'all' && tile.dataset.action === state.filter.action);
      }
    });
  }
  function renderBanner() {
    const b = $('wf-engine-banner');
    if (b) b.hidden = !(state.status && state.status.engine_available === false);
  }
  function renderFilters() {
    const sel = $('wf-host');
    if (sel) {
      const hosts = W.hostOptions(routes(), state.events || [], state.filter.host);
      const want = [''].concat(hosts);
      const have = Array.from(sel.options).map((o) => o.value);
      if (want.join('\n') !== have.join('\n')) {
        sel.replaceChildren(el('option', { value: '', text: t('waf.filter_host_all') }), ...hosts.map((h) => el('option', { value: h, text: h })));
      }
      sel.value = state.filter.host;
    }
    [['wf-action-chips', 'action'], ['wf-range-chips', 'range']].forEach(([id, dim]) => {
      const box = $(id);
      if (!box) return;
      box.querySelectorAll('[data-' + dim + ']').forEach((btn) => {
        const on = btn.dataset[dim] === state.filter[dim];
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
    const n = $('wf-new-events');
    if (n) n.hidden = !state.pendingNew;
  }
  function renderSummary() {
    const n = $('wf-summary');
    if (!n) return;
    const s = totals();
    n.textContent = s ? t('waf.summary', { events: s.events_24h, blocked: s.blocked_24h, routes: s.routes }) : t('waf.page_sub');
  }

  function messageRow(node, cls, cols) {
    const td = el('td', { colSpan: cols || COLS });
    td.colSpan = cols || COLS;
    td.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
    return el('tr', { class: 'wf-empty' + (cls ? ' ' + cls : '') }, [td]);
  }
  function filterActive() { const f = state.filter; return !!f.host || f.action !== 'all' || f.range !== '24h'; }

  function renderRows() {
    if (state.missing) {
      list.replaceChildren(messageRow(el('span', { class: 'wf-backend-missing', dataset: { wf: 'backend-missing' } }, [icon('alert', 14), t('waf.backend_missing')])));
      return;
    }
    if (!state.events) {
      list.replaceChildren(messageRow(state.eventsError
        ? el('span', {}, [W.errMsg(state.eventsError) || t('waf.load_error'), ' ', el('button', { type: 'button', class: 'wf-link', text: t('common.refresh'), on: { click: () => reload() } })])
        : t('common.loading'), state.eventsError ? 'wf-error' : ''));
      return;
    }
    if (!state.events.length) {
      list.replaceChildren(messageRow(el('div', { class: 'wf-empty-box', dataset: { wf: 'empty' } }, [
        el('div', { class: 'wf-empty-title', text: t('waf.empty') }),
        el('div', { class: 'wf-empty-hint', text: t('waf.empty_hint') }),
        filterActive() ? el('button', { type: 'button', class: 'wf-link wf-reset', text: t('waf.reset_filters'), on: { click: () => setFilter({ host: '', action: 'all', range: '24h' }) } }) : null,
      ])));
      return;
    }
    list.replaceChildren(...state.events.map(buildRow));
  }

  function buildRow(ev) {
    const routeId = W.routeIdFor(ev, routes());
    const key = W.eventKey(ev);
    const raw = W.rawText(ev.raw);
    const hasRule = ev.rule_id != null;
    const path = W.pathOfUri(ev.uri);
    const ruleDone = hasRule && routeId != null && state.excluded.has('rule:' + routeId + ':' + ev.rule_id);
    const pathDone = routeId != null && Array.from(state.excluded).some((x) => x.indexOf('path:' + routeId + ':') === 0 && path.indexOf(x.slice(('path:' + routeId + ':').length)) === 0);

    const msg = el('div', { class: 'wf-msg-wrap' }, [
      el('div', { class: 'wf-msg', text: ev.message || '—' }),
      ev.severity ? el('span', { class: 'wf-sub', text: t('waf.severity', { severity: ev.severity }) }) : null,
    ]);
    if (raw) {
      const pre = el('pre', { class: 'wf-raw', text: raw });
      const open = state.expanded.has(key);
      pre.hidden = !open;
      const toggle = el('button', { type: 'button', class: 'wf-link wf-raw-toggle', 'aria-expanded': open ? 'true' : 'false', text: open ? t('waf.raw_hide') : t('waf.raw_show') });
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        pre.hidden = !pre.hidden;
        if (pre.hidden) state.expanded.delete(key); else state.expanded.add(key);
        toggle.setAttribute('aria-expanded', pre.hidden ? 'false' : 'true');
        toggle.textContent = pre.hidden ? t('waf.raw_show') : t('waf.raw_hide');
      });
      msg.appendChild(toggle);
      msg.appendChild(pre);
    }

    // Compact icon buttons (the table is wide); title + aria-label carry the full text.
    const ruleTitle = routeId == null ? t('waf.no_route') : (!hasRule ? t('waf.no_rule') : t('waf.exclude_rule'));
    const ruleBtn = el('button', {
      type: 'button', class: 'btn btn-ghost wf-act wf-act-icon wf-exclude-rule', title: ruleTitle, 'aria-label': t('waf.exclude_rule'),
      disabled: routeId == null || !hasRule || ruleDone,
    }, [icon('ban', 13)]);
    ruleBtn.addEventListener('click', () => exclude('rule', ev, routeId));
    const pathBtn = el('button', {
      type: 'button', class: 'btn btn-ghost wf-act wf-act-icon wf-exclude-path',
      title: routeId == null ? t('waf.no_route') : t('waf.exclude_path'), 'aria-label': t('waf.exclude_path'),
      disabled: routeId == null || pathDone,
    }, [icon('path', 13)]);
    pathBtn.addEventListener('click', () => exclude('path', ev, routeId));

    const a = W.actionKey(ev.action);
    return el('tr', { class: 'wf-row wf-row-' + a + (ruleDone || pathDone ? ' wf-row-excluded' : ''), dataset: { eventKey: key, action: a, host: ev.host } }, [
      el('td', { class: 'wf-cell-time', title: ev.ts ? W.fmtTime(ev.ts) : null }, timeParts(ev.ts)),
      el('td', { class: 'wf-cell-host' }, [el('button', { type: 'button', class: 'wf-host-link', title: t('waf.show_events'), text: ev.host || '—', on: { click: () => setFilter({ host: ev.host }) } })]),
      el('td', { class: 'wf-cell-action' }, [W.actionTag(ev.action)]),
      el('td', { class: 'wf-cell-rule' }, [hasRule ? el('code', { class: 'wf-rule', text: String(ev.rule_id) }) : el('span', { class: 'wf-muted', text: '—' }),
        ruleDone || pathDone ? el('span', { class: 'tag tag-grey wf-excluded-tag', text: t('waf.excluded_tag') }) : null]),
      el('td', { class: 'wf-cell-message' }, [msg]),
      el('td', { class: 'wf-cell-client' }, [el('code', { class: 'wf-mono', text: ev.client_ip || '—' })]),
      el('td', { class: 'wf-cell-request' }, [el('code', { class: 'wf-req', title: W.requestLine(ev), text: W.requestLine(ev) })]),
      el('td', { class: 'wf-cell-actions' }, [el('div', { class: 'wf-actions' }, [ruleBtn, pathBtn])]),
    ]);
  }

  // Date and time on two lines: keeps the time column narrow.
  function timeParts(ts) {
    const d = new Date(ts);
    if (!ts || isNaN(d.getTime())) return [el('span', { class: 'wf-date', text: ts ? String(ts) : '—' })];
    const lang = (window.GC && window.GC.language) || document.documentElement.lang || 'de';
    let date = d.toISOString().slice(0, 10);
    let clock = d.toISOString().slice(11, 19);
    try {
      date = d.toLocaleDateString(lang, { year: 'numeric', month: '2-digit', day: '2-digit' });
      clock = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) { /* ISO fallback */ }
    return [el('span', { class: 'wf-date', text: date }), el('span', { class: 'wf-clock', text: clock })];
  }

  async function exclude(kind, ev, routeId) {
    if (routeId == null) return;
    const res = await W.openExclusionDialog(kind, { routeId, host: ev.host, ruleId: ev.rule_id, uri: ev.uri });
    if (!res) return;
    state.excluded.add(kind + ':' + routeId + ':' + res.value);
    renderRows();
    reloadStatusOnly();
  }

  function renderPager() {
    const more = $('wf-more');
    const info = $('wf-page-info');
    const n = state.events ? state.events.length : 0;
    if (more) more.hidden = !(state.events && state.next);
    if (info) {
      if (!state.events || !n) info.textContent = '';
      else info.textContent = t('waf.shown', { n }) + (state.next ? '' : ' · ' + t('waf.end'));
    }
  }

  function renderRoutes() {
    const body = $('wf-routes-list');
    if (!body) return;
    if (state.missing) { body.replaceChildren(messageRow(t('waf.backend_missing'), 'wf-backend-missing-row', ROUTE_COLS)); return; }
    if (!state.status) {
      body.replaceChildren(messageRow(state.statusError ? W.errMsg(state.statusError) : t('common.loading'), state.statusError ? 'wf-error' : '', ROUTE_COLS));
      return;
    }
    const rs = routes();
    if (!rs.length) { body.replaceChildren(messageRow(t('waf.routes_empty'), '', ROUTE_COLS)); return; }
    body.replaceChildren(...rs.map((r) => el('tr', { class: 'wf-route-row' + (r.host === state.filter.host ? ' wf-route-current' : ''), dataset: { routeId: String(r.route_id), host: r.host } }, [
      el('td', { class: 'wf-cell-host' }, [el('button', { type: 'button', class: 'wf-host-link', title: t('waf.show_events'), text: r.host, on: { click: () => { setFilter({ host: r.host }); scrollToEvents(); } } })]),
      el('td', {}, [W.modeTag(r.mode)]),
      el('td', { class: 'wf-num' }, [el('span', { title: t(W.paranoiaHintKey(r.paranoia)), text: t('waf.paranoia_level', { n: r.paranoia }) })]),
      el('td', { class: 'wf-num', text: String(r.events_24h) }),
      el('td', { class: 'wf-num' + (r.blocked_24h ? ' wf-num-blocked' : ''), text: String(r.blocked_24h) }),
      el('td', {}, [el('button', { type: 'button', class: 'btn btn-ghost wf-act wf-show-events', on: { click: () => { setFilter({ host: r.host }); scrollToEvents(); } } }, [icon('ext', 12), t('waf.show_events')])]),
    ])));
  }
  function scrollToEvents() {
    const card = $('wf-events-card');
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ─── Filters ───────────────────────────────────────────────────────────
  function setFilter(patch) {
    const next = W.normFilter(Object.assign({}, state.filter, patch));
    const same = next.host === state.filter.host && next.action === state.filter.action && next.range === state.filter.range;
    state.filter = next;
    try { window.history.replaceState(null, '', '/waf' + W.deepLinkQuery(next)); } catch (_) { /* ignore */ }
    if (same) { render(); return; }
    state.events = null;
    state.next = null;
    state.pages = 0;
    state.pendingNew = false;
    render();
    loadEvents().then(render);
  }
  const host = $('wf-host');
  if (host) host.addEventListener('change', () => setFilter({ host: host.value }));
  [['wf-action-chips', 'action'], ['wf-range-chips', 'range']].forEach(([id, dim]) => {
    const box = $(id);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-' + dim + ']');
      if (b) setFilter({ [dim]: b.dataset[dim] });
    });
  });
  const tiles = $('wf-tiles');
  if (tiles) {
    const pick = (e) => {
      const tile = e.target.closest('.wf-tile');
      if (!tile) return;
      if (tile.dataset.target) {
        const card = $(tile.dataset.target);
        if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const a = tile.dataset.action || 'all';
      setFilter({ action: state.filter.action === a ? 'all' : a });
    };
    tiles.addEventListener('click', pick);
    tiles.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  }
  const more = $('wf-more');
  if (more) more.addEventListener('click', () => loadMore(more));
  const fresh = $('wf-new-events');
  if (fresh) fresh.addEventListener('click', () => { state.pendingNew = false; reload(); });
  const refreshBtn = $('btn-waf-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => reload());

  // ─── Init ──────────────────────────────────────────────────────────────
  render();
  reload();
  setInterval(scheduleReload, 60000);
  document.addEventListener('gc:waf', onWafEvent);
  // gc:routes: WAF switched on/off or mode changed → routes list + tiles.
  document.addEventListener('gc:routes', () => schedule());
  document.addEventListener('gc:reconnected', scheduleReload);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && stale) { stale = false; scheduleReload(); }
  });

  window.GCWafPage = { reload, setFilter, getState: () => state };
})();
