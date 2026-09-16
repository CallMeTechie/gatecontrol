'use strict';

// Problems section of the dashboard (docs/feature-next-package.md S3 §1).
//
// GET /api/v1/dashboard/problems → one row per finding, each with a link to
// the place that fixes it. Live updates ride on the SSE types that already
// exist (gateway, monitor, tls, backup, routes, security); the poll below is
// only the fallback for a dead stream.
//
// Safe DOM only (el()/textContent), no innerHTML.

(function () {
  var REFRESH_MS = 30000;
  var DEBOUNCE_MS = 400;
  var host = document.getElementById('dash-problems');
  if (!host) return;

  var list = document.getElementById('dash-problems-list');
  var countEl = document.getElementById('dash-problems-count');
  var hintEl = document.getElementById('dash-problems-hint');
  var odBox = document.getElementById('dash-problems-ondemand');
  var odList = document.getElementById('dash-problems-ondemand-list');

  function t(key, params) {
    var s = (window.GC && GC.t && GC.t[key]) || key;
    if (params) {
      Object.keys(params).forEach(function (k) { s = s.split('{{' + k + '}}').join(String(params[k])); });
    }
    return s;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // "seit 12 min" from an ISO timestamp; null when unknown.
  function since(iso) {
    if (!iso) return null;
    var ts = new Date(iso).getTime();
    if (!isFinite(ts)) return null;
    var min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return t('problems.ago_now');
    if (min < 60) return t('problems.ago_minutes', { n: min });
    if (min < 1440) return t('problems.ago_hours', { n: Math.floor(min / 60) });
    return t('problems.ago_days', { n: Math.floor(min / 1440) });
  }

  // "SSH DS918+" or, without a name, "TCP 2023 → 22" — plus the host when known.
  function entryText(e) {
    if (!e) return '';
    if (e.label) return e.label;
    var ports = e.listen ? e.listen + (e.target ? ' → ' + e.target : '') : (e.target || '');
    return (e.proto + (ports ? ' ' + ports : '')).trim();
  }

  function entryTitle(e) {
    var name = entryText(e);
    return e && e.fqdn && e.fqdn !== name ? name + ' · ' + e.fqdn : name;
  }

  function targetText(e) {
    if (!e) return '';
    if (e.lan_host) return e.lan_host + (e.target ? ':' + e.target : '');
    return e.fqdn || entryText(e);
  }

  // → { title, detail: [strings] } per problem kind.
  function describe(p) {
    switch (p.kind) {
      case 'gateway_offline':
        return {
          title: t('problems.gateway_offline', { name: (p.gateway && p.gateway.name) || '?' }),
          detail: [p.gateway && p.gateway.entries
            ? t('problems.gateway_offline_detail', { count: p.gateway.entries })
            : t('problems.gateway_offline_none')],
        };
      case 'entry_down': {
        var key = p.reason === 'refused' ? 'problems.entry_refused'
          : p.reason === 'unreachable' ? 'problems.entry_unreachable' : 'problems.entry_unknown';
        var detail = [];
        if (p.reason === 'refused') detail.push(t('problems.detail_refused', { target: targetText(p.entry) }));
        else if (p.reason === 'unreachable') detail.push(t('problems.detail_unreachable', { target: targetText(p.entry) }));
        else detail.push(t('problems.detail_monitor'));
        // Wake-on-LAN: only for a gateway target with the licence, and only
        // when nothing answered at all (S3 §2).
        if (p.reason === 'unreachable' && p.wol && p.wol.licensed) {
          detail.push(p.wol.enabled ? t('problems.wol_on') : t('problems.wol_hint'));
        }
        return { title: t(key, { entry: entryTitle(p.entry) }), detail: detail };
      }
      case 'tls_failed':
      case 'tls_paused': {
        var tls = p.tls || {};
        var d = [];
        if (tls.paused_reason) d.push(String(tls.paused_reason));
        else if (tls.code) d.push(String(tls.code));
        if (tls.max_attempts) d.push(t('problems.tls_attempts', { attempts: tls.attempts || 0, max: tls.max_attempts }));
        return {
          title: t(p.kind === 'tls_failed' ? 'problems.tls_failed' : 'problems.tls_paused', { host: tls.host || '?' }),
          detail: d,
        };
      }
      case 'update_failed':
      case 'update_rolled_back': {
        var u = p.update || {};
        var ud = [];
        if (u.bad_version) ud.push(t('problems.update_detail', { version: 'v' + u.bad_version, running: 'v' + (u.running_version || '?') }));
        if (u.rollback_failed) ud.push(t('problems.update_rollback_failed'));
        return { title: t(p.kind === 'update_failed' ? 'problems.update_failed' : 'problems.update_rolled_back'), detail: ud };
      }
      case 'backup_failed':
        return {
          title: t('problems.backup_failed', { name: (p.backup && p.backup.name) || '?' }),
          detail: [t('problems.backup_detail', { status: (p.backup && p.backup.status) || '?' })],
        };
      case 'waf_engine_missing':
        return {
          title: t('problems.waf_engine_missing'),
          detail: [t('problems.waf_engine_detail', { count: (p.waf && p.waf.routes) || 0 })],
        };
      default:
        return { title: p.kind, detail: [] };
    }
  }

  function rowEl(p) {
    var d = describe(p);
    var ago = since(p.since);
    return el('div', {
      class: 'pr-row pr-' + p.severity,
      dataset: { kind: p.kind, severity: p.severity, problemId: p.id },
    }, [
      el('span', { class: 'pr-dot', 'aria-hidden': 'true' }),
      el('div', { class: 'pr-body' }, [
        el('div', { class: 'pr-row-title', text: d.title }),
        el('div', { class: 'pr-row-detail' }, d.detail.filter(Boolean).map(function (x) {
          return el('span', { class: 'pr-detail-part', text: x });
        })),
      ]),
      ago ? el('span', { class: 'pr-since', text: ago }) : null,
      el('a', { class: 'pr-link', href: p.href, text: t('problems.open') }),
    ]);
  }

  function odRowEl(p) {
    // The section heading already says "nur bei Bedarf" — the row only names
    // the entry.
    return el('div', { class: 'pr-od-row', dataset: { problemId: p.id, kind: 'on_demand' } }, [
      el('span', { class: 'pr-od-text', text: t('problems.on_demand_note', { entry: entryTitle(p.entry) }) }),
      el('a', { class: 'pr-link', href: p.href, text: t('problems.open') }),
    ]);
  }

  function render(data) {
    var problems = (data && data.problems) || [];
    var onDemand = (data && data.on_demand) || [];
    var summary = (data && data.summary) || {};

    list.replaceChildren.apply(list, problems.map(rowEl));
    odList.replaceChildren.apply(odList, onDemand.map(odRowEl));
    odBox.hidden = onDemand.length === 0;

    if (problems.length > 0) {
      countEl.hidden = false;
      countEl.textContent = String(problems.length);
      countEl.className = 'pr-count' + (summary.error ? ' pr-count-error' : '');
    } else {
      countEl.hidden = true;
      list.appendChild(el('div', { class: 'pr-empty', text: t('problems.none') }));
    }

    var hint = summary.access_log === 'unavailable' && problems.some(function (p) { return p.kind === 'entry_down' && !p.reason; })
      ? t('problems.access_log_unavailable') : '';
    hintEl.hidden = !hint;
    hintEl.textContent = hint;

    // The card stays out of the way while there is nothing to say.
    host.hidden = problems.length === 0 && onDemand.length === 0;
  }

  function renderError() {
    list.replaceChildren(el('div', { class: 'pr-empty pr-error', text: t('problems.load_error') }));
    countEl.hidden = true;
    odBox.hidden = true;
    hintEl.hidden = true;
    host.hidden = false;
  }

  var inflight = false;
  async function load() {
    if (inflight) return;
    inflight = true;
    try {
      var data = await window.api.get('/api/v1/dashboard/problems');
      if (!data || data.ok === false) { renderError(); return; }
      render(data);
    } catch (err) {
      renderError();
    } finally {
      inflight = false;
    }
  }

  var debounce = null;
  function reload() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { debounce = null; load(); }, DEBOUNCE_MS);
  }

  load();
  var timer = setInterval(load, REFRESH_MS);
  window.addEventListener('beforeunload', function () { clearInterval(timer); });

  // Existing SSE types (public/js/events.js).
  ['gc:gateway', 'gc:monitor', 'gc:tls', 'gc:backup', 'gc:routes', 'gc:security', 'gc:reconnected']
    .forEach(function (ev) { document.addEventListener(ev, reload); });

  window.GCDashProblems = { reload: load, render: render };
})();
