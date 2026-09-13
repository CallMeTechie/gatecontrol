'use strict';

// Certificates page (certificates.njk, all three themes). Renders the TLS
// guard status from GET /api/v1/tls/status (docs/feature-tls-guard.md):
// summary tiles, ACME-e-mail banner, filter chips and one table row per host
// with status, issuer, last error, next retry and the actions "Prüfen" /
// "Erneut versuchen". Dialogs and tags come from tls-ui.js (GCTlsUI). Live
// reload on gc:tls / gc:routes (debounced). DOM via el() — no innerHTML.
(function () {
  const certsList = document.getElementById('certificates-list');
  if (!certsList) return;
  const TG = window.GCTlsUI;
  const $ = (id) => document.getElementById(id);

  // ─── Aurora theme detector (kept: tests/aurora_theme.test.js) ─────────
  function isAurora() { return !!document.querySelector('.app'); }

  if (!TG) {
    // tls-ui.js missing: keep the page readable instead of throwing.
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = 'tls-ui.js not loaded';
    tr.appendChild(td);
    certsList.replaceChildren(tr);
    return;
  }
  const { t, el, icon } = TG;
  const COLS = 7;

  const state = {
    hosts: null,       // TlsHost[] (sorted) or null before the first load
    summary: null,
    settings: null,
    filter: 'all',
    error: null,       // last load error (Error)
    missing: false,    // GET /tls/status answered 404 → backend not merged yet
    lastLoaded: null,
  };

  // ─── Loading ───────────────────────────────────────────────────────────
  let inflight = null;
  let rerun = false;
  function load() {
    if (inflight) { rerun = true; return inflight; }
    inflight = (async () => {
      try {
        do {
          rerun = false;
          const res = await TG.fetchStatus();
          state.hosts = TG.sortHosts(res.hosts || []);
          state.summary = res.summary || null;
          state.settings = res.settings || null;
          state.lastLoaded = new Date();
        } while (rerun);
        state.error = null;
        state.missing = false;
      } catch (err) {
        state.error = err;
        state.missing = TG.isNotFound(err);
        if (!state.missing && state.hosts) TG.toast(TG.errMsg(err), 'error');
      } finally {
        inflight = null;
        render();
      }
    })();
    return inflight;
  }

  let debounceTimer = null;
  let stale = false;
  function scheduleLoad() {
    if (document.hidden) { stale = true; return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  }

  // Kept for tests/aurora_theme.test.js — all themes share one loader now.
  async function auroraLoadCertificates() { return load(); }
  async function loadCertificates() {
    if (isAurora()) return auroraLoadCertificates();
    return load();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    renderTiles();
    renderBanner();
    renderChips();
    renderSummaryLine();
    renderRows();
  }

  function summary() {
    const s = state.summary || (state.hosts ? TG.summarize(state.hosts) : null);
    return s || { total: 0, issued: 0, expiring: 0, failed: 0, paused: 0, pending: 0, acme_email_missing: false };
  }

  function renderTiles() {
    const s = summary();
    [['issued', s.issued], ['expiring', s.expiring], ['failed', s.failed], ['paused', s.paused]].forEach(([k, n]) => {
      const v = $('tg-tile-' + k + '-val');
      if (v) v.textContent = state.hosts || state.summary ? String(n || 0) : '–';
      const tile = $('tg-tile-' + k);
      if (tile) {
        tile.classList.toggle('warn', k !== 'issued' && (n || 0) > 0);
        tile.classList.toggle('on', state.filter !== 'all' && tile.dataset.filter === state.filter);
      }
    });
  }

  function renderBanner() {
    const b = $('tg-email-banner');
    if (!b) return;
    const s = summary();
    b.hidden = !(s && s.acme_email_missing === true);
  }

  function renderChips() {
    const box = $('tg-chips');
    if (!box) return;
    const counts = TG.filterCounts(state.hosts || []);
    box.querySelectorAll('[data-filter]').forEach((btn) => {
      const f = btn.dataset.filter;
      const on = f === state.filter;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const c = btn.querySelector('.tg-count');
      if (c) c.textContent = state.hosts ? String(counts[f] || 0) : '';
    });
  }

  function renderSummaryLine() {
    const n = $('tg-summary');
    if (!n) return;
    if (!state.hosts) { n.textContent = t('tls.page_sub'); return; }
    const s = summary();
    n.textContent = t('tls.summary', { total: s.total || state.hosts.length, issued: s.issued || 0, problems: (s.failed || 0) + (s.paused || 0) + (s.expiring || 0) });
  }

  function messageRow(node, cls) {
    const td = el('td', { colSpan: COLS });
    td.colSpan = COLS;
    td.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
    return el('tr', { class: 'tg-empty' + (cls ? ' ' + cls : '') }, [td]);
  }

  function renderRows() {
    if (state.missing) {
      certsList.replaceChildren(messageRow(el('span', { class: 'tg-backend-missing', dataset: { tg: 'backend-missing' } }, [icon('alert', 14), t('tls.backend_missing')])));
      return;
    }
    if (!state.hosts) {
      certsList.replaceChildren(messageRow(state.error
        ? el('span', {}, [TG.errMsg(state.error) || t('tls.load_error'), ' ', el('button', { type: 'button', class: 'tg-link', text: t('common.refresh') || 'Reload', on: { click: () => load() } })])
        : t('common.loading'), state.error ? 'tg-error' : ''));
      return;
    }
    const rows = TG.filterHosts(state.hosts, state.filter);
    if (!state.hosts.length) { certsList.replaceChildren(messageRow(t('tls.empty'))); return; }
    if (!rows.length) {
      certsList.replaceChildren(messageRow(el('span', {}, [t('tls.no_match'), ' ',
        el('button', { type: 'button', class: 'tg-link', text: t('tls.filter_all'), on: { click: () => setFilter('all') } })])));
      return;
    }
    certsList.replaceChildren(...rows.map((h) => (isAurora() ? auroraTableRow(h) : buildRow(h))));
  }

  // Aurora keeps its .data-table cell classes; the row content is identical.
  function auroraTableRow(h) { return buildRow(h, true); }
  function auroraStatusTag(h) { return TG.stateTag(h, 'tag-dot'); }

  function zoneHref(h) {
    if (h.domain_id != null) return '/routes?domain=' + encodeURIComponent(h.domain_id) + (h.host_id != null ? '&host=' + encodeURIComponent(h.host_id) : '');
    return '/routes';
  }

  function buildRow(h, aurora) {
    const k = TG.stateKey(h);
    const problem = k === 'failed' || k === 'paused' || k === 'expiring';
    const sub = TG.stateSub(h);
    const canAct = h.kind !== 'none' && k !== 'internal';

    const actions = el('div', { class: 'tg-actions' }, [
      canAct ? el('button', { type: 'button', class: 'btn btn-ghost tg-check', title: t('tls.check'), on: { click: () => TG.openPreflight(h.host, h, { onChanged: scheduleLoad }) } }, [icon('search', 12), t('tls.check')]) : null,
      TG.isProblemState(h.state) ? el('button', { type: 'button', class: 'btn btn-primary tg-retry', title: t('tls.retry'), on: { click: (e) => retryHost(h, e.currentTarget) } }, [icon('refresh', 12), t('tls.retry')]) : null,
    ]);

    return el('tr', { class: 'tg-row' + (problem ? ' tg-row-problem' : ''), dataset: { host: h.host, state: k } }, [
      el('td', { class: aurora ? 'cell-name' : 'tg-cell-host' }, [
        el('a', { class: 'tg-host', href: zoneHref(h), title: t('tls.zone_link'), text: h.host }),
        // Alias rows (security options §A) name their primary host.
        h.alias_of ? el('span', { class: 'tg-sub so-alias-of', text: t('alias.of', { host: h.alias_of }) }) : null,
      ]),
      el('td', { class: 'tg-cell-status' }, [aurora ? auroraStatusTag(h) : TG.stateTag(h), sub ? el('span', { class: 'tg-sub', text: sub }) : null]),
      el('td', { class: 'tg-cell-issuer' + (aurora ? ' mono' : ''), text: h.issuer || '—' }),
      el('td', { class: 'tg-cell-valid' + (aurora ? ' mono' : '') }, [h.not_after ? TG.fmtDate(h.not_after) : '—']),
      el('td', { class: 'tg-cell-error' }, [TG.errorEl(h)]),
      el('td', { class: 'tg-cell-retry' + (aurora ? ' mono' : '') }, [k === 'failed' && h.next_retry_at ? el('span', { title: TG.fmtDateTime(h.next_retry_at), text: TG.fmtWhen(h.next_retry_at) }) : '—']),
      el('td', { class: 'tg-cell-actions' }, [actions]),
    ]);
  }

  async function retryHost(h, btn) {
    TG.busy(btn, true);
    try {
      const next = await TG.retry(h.host);
      TG.toast(t('tls.retry_ok', { host: h.host }), 'success');
      if (next) {
        const i = state.hosts.findIndex((x) => x.host === h.host);
        if (i >= 0) state.hosts[i] = next;
        state.hosts = TG.sortHosts(state.hosts);
        state.summary = null;
        render();
      }
      scheduleLoad();
    } catch (err) {
      const data = err && err.data;
      if (data && data.code === 'PREFLIGHT_FAILED') {
        TG.toast(t('tls.retry_failed', { host: h.host }), 'error');
        TG.openDetail(h.host, Object.assign({}, h, { preflight: data.result || h.preflight }), { onChanged: scheduleLoad });
      } else {
        TG.toast(TG.isNotFound(err) ? t('tls.backend_missing') : TG.errMsg(err), 'error');
      }
    } finally { TG.busy(btn, false); }
  }

  // ─── Filters ───────────────────────────────────────────────────────────
  function setFilter(f) {
    state.filter = TG.FILTERS.indexOf(f) >= 0 ? f : 'all';
    render();
  }
  const chips = $('tg-chips');
  if (chips) {
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (b) setFilter(b.dataset.filter);
    });
  }
  const tiles = $('tg-tiles');
  if (tiles) {
    const pick = (e) => {
      const tile = e.target.closest('[data-filter]');
      if (!tile) return;
      setFilter(state.filter === tile.dataset.filter ? 'all' : tile.dataset.filter);
    };
    tiles.addEventListener('click', pick);
    tiles.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  }

  // ─── Init ──────────────────────────────────────────────────────────────
  const refreshBtn = $('btn-certificates-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadCertificates);

  render();
  loadCertificates();
  setInterval(scheduleLoad, 60000);
  ['gc:tls', 'gc:routes', 'gc:reconnected'].forEach((ev) => document.addEventListener(ev, scheduleLoad));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && stale) { stale = false; scheduleLoad(); }
  });

  window.GCCertificatesPage = { reload: load, setFilter, getState: () => state };
})();
