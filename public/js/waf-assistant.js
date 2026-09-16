'use strict';

// WAF page, release B §3 (docs/feature-release-b.md): tabs „Ereignisse“ /
// „Assistent“ / „Eigene IPs & Sperren“ on waf.njk (deep links /waf#assistant,
// /waf#protect), loaded after waf-ui.js (uses GCWafUI: t, el, icon, dialog,
// request, modeTag …) and before waf.js.
//   Assistent: GET /api/v1/waf/assistant[?route_id=] → per WAF route the
//     readiness pill, observed hours, top rules with verdict + reason, the
//     suggested exclusions (one click → POST /api/v1/waf/routes/:id/exclusions)
//     and „Auf Blockieren stellen“ (PUT /api/v1/routes/:id { waf_mode:'block' }).
//   Eigene IPs & Scanner-Sperre: GET/PUT /api/v1/settings/waf (session only).
//   Gesperrte IPs: GET/POST /api/v1/waf/bans, DELETE /api/v1/waf/bans/:ip
//     (CIDR '/' as %2F); live on gc:waf { kind: 'ban'|'unban' }.
// UMD: pure helpers testable in node:test; DOM via el() only (untrusted data).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCWafAssistant = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Pure helpers ──────────────────────────────────────────────────────
  const TABS = ['events', 'assistant', 'protect'];
  const READINESS = ['ready', 'review', 'too_early', 'no_traffic'];
  const READINESS_CLASS = { ready: 'tag-green', review: 'tag-amber', too_early: 'tag-grey', no_traffic: 'tag-grey' };
  const VERDICTS = ['attack', 'false_positive', 'unclear'];
  const VERDICT_CLASS = { attack: 'tag-red', false_positive: 'tag-amber', unclear: 'tag-grey' };
  const TRUSTED_MAX = 50;
  const LIMITS = { threshold: [1, 1000], window_min: [1, 1440], duration_h: [1, 8760] };
  const ERROR_KEYS = {
    WAF_TRUSTED_IPS_INVALID: 'waf.err.trusted_invalid',
    WAF_SETTINGS_INVALID: 'waf.err.settings_invalid',
    WAF_AUTOBAN_INVALID: 'waf.err.autoban_invalid',
    WAF_BAN_IP_INVALID: 'waf.err.ban_ip_invalid',
    WAF_BAN_TRUSTED: 'waf.err.ban_trusted',
    WAF_BAN_DURATION_INVALID: 'waf.err.ban_duration',
    WAF_BAN_NOT_FOUND: 'waf.err.ban_not_found',
    TOKEN_FORBIDDEN: 'waf.err.token_forbidden',
  };
  // `reason_code` of the server (services/wafAssistant.js: rules, wafBans.js:
  // bans) → i18n key. The English `reason` text is never parsed any more
  // (docs/feature-wave2.md §W1.3); it is only the last fallback when an older
  // server sends no code at all.
  const REASON_KEYS = {
    secret_path: 'waf.asst_reason_secret',
    scanner_rule: 'waf.asst_reason_scanner',
    series: 'waf.asst_reason_series',
    all_banned: 'waf.asst_reason_banned',
    shared_path: 'waf.asst_reason_fp',
    inconclusive: 'waf.asst_reason_unclear',
    scanner: 'waf.bans_reason_scanner',
    manual: 'waf.bans_reason_manual',
  };
  // waf.asst_reason_series names its placeholder {{n}}, the server counts `hits`.
  const REASON_PARAM_ALIAS = { series: { n: 'hits' } };

  function str(v) { return v == null ? '' : String(v); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function parseTab(hash) { const h = str(hash).replace(/^#/, ''); return TABS.indexOf(h) >= 0 ? h : 'events'; }
  function readinessOf(r) { return READINESS.indexOf(r && r.readiness) >= 0 ? r.readiness : 'too_early'; }
  function verdictOf(rule) { return VERDICTS.indexOf(rule && rule.verdict) >= 0 ? rule.verdict : 'unclear'; }
  // { reason_code, reason_params } of a rule or ban → { key, params } or null
  // (no/unknown code → the caller shows `reason` verbatim).
  function reasonText(item) {
    const o = isObj(item) ? item : {};
    const key = REASON_KEYS[str(o.reason_code)];
    if (!key) return null;
    const src = isObj(o.reason_params) ? o.reason_params : {};
    const alias = REASON_PARAM_ALIAS[o.reason_code] || null;
    const params = {};
    for (const k of Object.keys(src)) if (src[k] != null) params[k] = src[k];
    if (alias) for (const k of Object.keys(alias)) if (src[alias[k]] != null) params[k] = src[alias[k]];
    return { key, params };
  }
  // Order: detect routes ready → review → too_early → no_traffic, then block routes; by host.
  function sortRoutes(routes) {
    const rank = (r) => (r.mode === 'block' ? 10 : 0) + READINESS.indexOf(readinessOf(r));
    return (Array.isArray(routes) ? routes : []).filter(isObj).slice()
      .sort((a, b) => rank(a) - rank(b) || str(a.host).localeCompare(str(b.host)) || (a.route_id - b.route_id));
  }
  function readinessCounts(routes) {
    const out = { ready: 0, review: 0, too_early: 0, no_traffic: 0, block: 0 };
    (Array.isArray(routes) ? routes : []).filter(isObj).forEach((r) => { if (r.mode === 'block') out.block++; else out[readinessOf(r)]++; });
    return out;
  }
  function suggestionOf(r) {
    const s = isObj(r && r.suggestion) ? r.suggestion : {};
    const rules = (Array.isArray(s.exclude_rules) ? s.exclude_rules : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const paths = (Array.isArray(s.exclude_paths) ? s.exclude_paths : []).map(str).filter((p) => /^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]{0,255}$/.test(p));
    return { rules, paths };
  }
  function hoursText(h) {
    const n = Math.max(0, Math.floor(Number(h) || 0));
    if (n < 48) return { key: 'waf.asst_hours', params: { n } };
    return { key: 'waf.asst_days', params: { n: Math.floor(n / 24) } };
  }

  // ── Addresses (client-side check; the server validates again) ──
  function ipv4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    return !!m && m.slice(1).every((x) => Number(x) <= 255 && (x === '0' || x[0] !== '0'));
  }
  function ipv6(s) {
    if (!/^[0-9a-fA-F:.]+$/.test(s) || s.indexOf(':') < 0 || s.length > 45) return false;
    if ((s.match(/::/g) || []).length > 1) return false;
    let head = s;
    const lastColon = s.lastIndexOf(':');
    if (s.indexOf('.') >= 0) {
      // IPv4 tail (::ffff:1.2.3.4) counts as two groups.
      if (!ipv4(s.slice(lastColon + 1))) return false;
      head = s.slice(0, lastColon + 1) + '0:0';
    }
    const parts = head.split('::');
    const groups = (x) => (x === '' ? [] : x.split(':'));
    const a = groups(parts[0]);
    const b = parts.length > 1 ? groups(parts[1]) : [];
    if (a.concat(b).some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false;
    const n = a.length + b.length;
    return parts.length > 1 ? n < 8 : n === 8;
  }
  // 'ip' or 'ip/prefix' → { text, v6, prefix } or null.
  function parseAddr(v) {
    const s = str(v).trim();
    if (!s || s.length > 64) return null;
    const i = s.indexOf('/');
    const addr = i < 0 ? s : s.slice(0, i);
    const pre = i < 0 ? null : s.slice(i + 1);
    const v4 = ipv4(addr);
    const v6 = !v4 && ipv6(addr);
    if (!v4 && !v6) return null;
    if (pre !== null) {
      if (!/^\d{1,3}$/.test(pre)) return null;
      const p = Number(pre);
      if (p > (v4 ? 32 : 128)) return null;
      return { text: addr.toLowerCase() + '/' + p, v6, prefix: p };
    }
    return { text: addr.toLowerCase(), v6, prefix: v4 ? 32 : 128 };
  }
  // Add candidates (text, split on space/comma/newline) to a list:
  // { list, added, invalid, duplicate, overflow }.
  function addTrusted(list, text) {
    const out = (Array.isArray(list) ? list : []).slice();
    const res = { list: out, added: [], invalid: [], duplicate: [], overflow: false };
    str(text).split(/[\s,;]+/).filter(Boolean).forEach((raw) => {
      const p = parseAddr(raw);
      if (!p) { res.invalid.push(raw); return; }
      if (out.indexOf(p.text) >= 0) { res.duplicate.push(raw); return; }
      if (out.length >= TRUSTED_MAX) { res.overflow = true; return; }
      out.push(p.text);
      res.added.push(p.text);
    });
    return res;
  }
  function intIn(v, name) {
    const s = str(v).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    const [min, max] = LIMITS[name];
    return n >= min && n <= max ? n : null;
  }
  function sameList(a, b) { return (a || []).join('\n') === (b || []).join('\n'); }
  function banUrl(ip) { return '/api/v1/waf/bans/' + encodeURIComponent(str(ip)); }
  function errorKey(code) { return ERROR_KEYS[str(code).toUpperCase()] || null; }

  const pure = {
    TABS, READINESS, READINESS_CLASS, VERDICTS, VERDICT_CLASS, TRUSTED_MAX, LIMITS, ERROR_KEYS,
    parseTab, readinessOf, verdictOf, reasonText, sortRoutes, readinessCounts, suggestionOf, hoursText,
    parseAddr, addTrusted, intIn, sameList, banUrl, errorKey,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const W = win.GCWafUI;
  if (!W || !$('wf-tabs')) return pure;
  const { t, el, icon } = W;

  function errMsg(err) {
    const d = err && err.data;
    const k = errorKey(d && d.code);
    if (k) return t(k);
    return W.errMsg(err);
  }
  function licenceBlocked(err) { return !!(err && err.data && err.data.feature === 'waf' && err.data.status === 403); }
  function licenceNode() {
    return win.GCLicenseHint ? win.GCLicenseHint.render('waf') : el('div', { class: 'wfa-state', text: t('waf.err.license') });
  }
  function localTime(iso) { return iso ? W.fmtTime(iso) : '—'; }
  function reasonLabel(item) {
    const r = reasonText(item);
    return r ? t(r.key, r.params) : (str(item && item.reason) || '—');
  }
  function stateBox(text, cls, retry) {
    return el('div', { class: 'wfa-state' + (cls ? ' ' + cls : '') }, [
      el('span', { text }),
      retry ? el('button', { type: 'button', class: 'btn btn-sm wfa-retry', text: t('common.refresh'), on: { click: retry } }) : null,
    ]);
  }
  // Named confirmDialog, not confirm: public/js/** must contain no call that
  // reads as the browser's own dialog (docs/feature-wave2.md §W1.2, tests).
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const d = W.dialog({ title: opts.title, kind: opts.kind || 'confirm' });
      d.overlay.classList.add('wfa-dialog');
      d.body.appendChild(el('p', { class: 'zn-dialog-msg wf-dialog-msg', text: opts.message }));
      if (opts.warn) d.body.appendChild(W.hintEl(opts.warn, 'warn'));
      const ok = el('button', { type: 'button', class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' wfa-ok', text: opts.ok });
      d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(false) } }));
      d.foot.appendChild(ok);
      ok.addEventListener('click', () => d.close(true));
      ok.focus();
      d.promise.then((v) => resolve(!!v));
    });
  }

  // ─── Tabs ──────────────────────────────────────────────────────────────
  const state = {
    tab: parseTab(win.location.hash),
    asst: null, asstError: null, asstLoaded: false,
    settings: null, draft: null, settingsError: null,
    bans: null, bansError: null,
    applied: new Set(),   // 'rule:<route>:<id>' / 'path:<route>:<path>' applied on this page
  };
  function setTab(tab, opts) {
    state.tab = TABS.indexOf(tab) >= 0 ? tab : 'events';
    doc.querySelectorAll('#wf-tabs [data-wf-tab]').forEach((b) => {
      const on = b.dataset.wfTab === state.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    doc.querySelectorAll('[data-wf-panel]').forEach((p) => { p.hidden = p.dataset.wfPanel !== state.tab; });
    if (!(opts && opts.keepHash)) {
      try { win.history.replaceState(null, '', win.location.pathname + win.location.search + (state.tab === 'events' ? '' : '#' + state.tab)); } catch (_) { /* ignore */ }
    }
    if (state.tab === 'assistant' && !state.asstLoaded) loadAssistant();
    if (state.tab === 'protect' && !state.settings && !state.settingsError) loadProtect();
  }

  // ─── Assistant ─────────────────────────────────────────────────────────
  let asstSeq = 0;
  async function loadAssistant(routeId) {
    const my = ++asstSeq;
    try {
      const res = await W.request('GET', '/api/v1/waf/assistant' + (routeId ? '?route_id=' + encodeURIComponent(routeId) : ''));
      if (my !== asstSeq) return;
      const list = Array.isArray(res.routes) ? res.routes.filter(isObj) : [];
      if (routeId && state.asst) {
        state.asst = state.asst.map((r) => (r.route_id === Number(routeId) ? (list.find((x) => x.route_id === r.route_id) || r) : r));
      } else state.asst = list;
      state.asstError = null;
    } catch (err) {
      if (my !== asstSeq) return;
      state.asstError = err;
    } finally {
      state.asstLoaded = true;
      if (my === asstSeq) renderAssistant();
    }
  }
  function renderAssistant() {
    const box = $('wfa-routes');
    const sum = $('wfa-summary');
    if (!box) return;
    if (!state.asst) {
      if (sum) sum.textContent = '';
      if (state.asstError && licenceBlocked(state.asstError)) { box.replaceChildren(licenceNode()); return; }
      box.replaceChildren(state.asstError
        ? stateBox(t('waf.asst_load_error') + ' ' + errMsg(state.asstError), 'wfa-error', () => loadAssistant())
        : stateBox(t('common.loading'), 'wfa-loading'));
      return;
    }
    const c = readinessCounts(state.asst);
    if (sum) sum.textContent = state.asst.length ? t('waf.asst_summary', { ready: c.ready, review: c.review, early: c.too_early, quiet: c.no_traffic, block: c.block }) : '';
    if (!state.asst.length) { box.replaceChildren(stateBox(t('waf.asst_empty'), 'wfa-empty')); return; }
    box.replaceChildren(...sortRoutes(state.asst).map(routeCard));
  }
  function routeCard(r) {
    const rd = readinessOf(r);
    const block = r.mode === 'block';
    const since = r.detect_since ? t('waf.asst_since', { since: localTime(r.detect_since) }) : '';
    const ht = hoursText(r.observed_hours);
    const sugg = suggestionOf(r);
    const facts = el('div', { class: 'wfa-facts' }, [
      el('span', { class: 'wfa-fact' }, [icon('info', 12), t(ht.key, ht.params) + (since ? ' · ' + since : '')]),
      el('span', { class: 'wfa-fact' }, [t('waf.asst_events', { total: Number(r.events_total) || 0, external: Number(r.events_external) || 0 })]),
      el('span', { class: 'wfa-fact' }, [t('waf.paranoia_level', { n: Number(r.paranoia) || 1 })]),
    ]);
    const head = el('div', { class: 'wfa-route-head' }, [
      el('span', { class: 'wfa-host', text: str(r.host) || '—' }),
      W.modeTag(r.mode),
      block ? null : el('span', { class: 'tag ' + READINESS_CLASS[rd] + ' wfa-ready', dataset: { readiness: rd }, text: t('waf.asst_' + rd) }),
      el('span', { class: 'zn-spacer wfa-spacer' }),
      el('a', { class: 'wf-link wfa-events-link', href: W.pageHref(str(r.host).toLowerCase()), on: { click: (e) => { e.preventDefault(); showEvents(r.host); } } }, [icon('ext', 12), t('waf.asst_show_events')]),
    ]);
    const hint = el('p', { class: 'wfa-hint wfa-hint-' + (block ? 'block' : rd), text: block ? t('waf.asst_block_active') : t('waf.asst_' + rd + '_hint') });
    const nodes = [head, facts, hint, rulesEl(r)];
    if (!block && (sugg.rules.length || sugg.paths.length)) nodes.push(suggestionEl(r, sugg));
    if (!block) nodes.push(el('div', { class: 'wfa-actions' }, [blockButton(r, rd)]));
    return el('article', { class: 'card wfa-route wfa-rd-' + (block ? 'block' : rd), dataset: { routeId: str(r.route_id), readiness: rd, mode: block ? 'block' : 'detect' } }, nodes);
  }
  function rulesEl(r) {
    const rules = Array.isArray(r.top_rules) ? r.top_rules.filter(isObj) : [];
    if (!rules.length) return el('div', { class: 'wfa-rules-empty', text: t('waf.asst_rules_empty') });
    const rows = rules.map((x) => {
      const v = verdictOf(x);
      const paths = Array.isArray(x.paths) ? x.paths.map(str) : [];
      return el('tr', { class: 'wfa-rule-row wfa-v-' + v, dataset: { rule: str(x.rule_id), verdict: v } }, [
        el('td', { class: 'wfa-c-rule', 'data-label': t('waf.asst_col_rule') }, [el('code', { class: 'wf-rule', text: str(x.rule_id) }), el('div', { class: 'wfa-msg', text: str(x.message) || '—' })]),
        el('td', { class: 'wfa-c-num', 'data-label': t('waf.asst_col_hits'), text: String(Number(x.hits) || 0) }),
        el('td', { class: 'wfa-c-num', 'data-label': t('waf.asst_col_ips'), text: String(Number(x.ips) || 0) }),
        el('td', { class: 'wfa-c-paths', 'data-label': t('waf.asst_col_paths') }, paths.length ? paths.map((p) => el('code', { class: 'wfa-path', title: p, text: p })) : [el('span', { class: 'wf-muted', text: '—' })]),
        el('td', { class: 'wfa-c-verdict', 'data-label': t('waf.asst_col_verdict') }, [
          el('span', { class: 'tag ' + VERDICT_CLASS[v] + ' wfa-verdict', text: t('waf.asst_verdict_' + v) }),
          el('div', { class: 'wfa-reason', text: reasonLabel(x) }),
        ]),
      ]);
    });
    return el('div', { class: 'wfa-rules' }, [
      el('div', { class: 'wfa-sub-title', text: t('waf.asst_rules_title') }),
      el('div', { class: 'wfa-table-wrap' }, [el('table', { class: 'data-table wfa-rules-table' }, [
        el('thead', {}, [el('tr', {}, ['waf.asst_col_rule', 'waf.asst_col_hits', 'waf.asst_col_ips', 'waf.asst_col_paths', 'waf.asst_col_verdict'].map((k) => el('th', { text: t(k) })))]),
        el('tbody', {}, rows),
      ])]),
    ]);
  }
  function suggestionEl(r, sugg) {
    const id = r.route_id;
    const items = sugg.rules.map((n) => ({ kind: 'rule', value: n, label: t('waf.asst_suggest_rule', { rule: n }) }))
      .concat(sugg.paths.map((p) => ({ kind: 'path', value: p, label: t('waf.asst_suggest_path', { path: p }) })));
    const key = (it) => it.kind + ':' + id + ':' + it.value;
    const pending = items.filter((it) => !state.applied.has(key(it)));
    const all = el('button', { type: 'button', class: 'btn btn-sm wfa-apply-all', disabled: pending.length < 2 }, [icon('plus', 12), t('waf.asst_apply_all')]);
    all.addEventListener('click', async () => {
      W.busy(all, true);
      for (const it of items.filter((x) => !state.applied.has(key(x)))) {
        if (!(await apply(r, it, null))) break;
      }
      W.busy(all, false);
      loadAssistant(id);
    });
    return el('div', { class: 'wfa-suggest' }, [
      el('div', { class: 'wfa-sub-title' }, [t('waf.asst_suggest_title'), items.length > 1 ? all : null]),
      el('p', { class: 'wfa-suggest-hint', text: t('waf.asst_suggest_hint') }),
      el('div', { class: 'wfa-suggest-list' }, items.map((it) => {
        const done = state.applied.has(key(it));
        const btn = el('button', { type: 'button', class: 'btn btn-sm wfa-apply', disabled: done, dataset: { kind: it.kind, value: String(it.value) } }, [done ? icon('shield', 12) : icon('plus', 12), done ? t('waf.asst_applied') : t('waf.asst_apply')]);
        btn.addEventListener('click', async () => { if (await apply(r, it, btn)) loadAssistant(id); });
        return el('div', { class: 'wfa-suggest-item' + (done ? ' wfa-done' : ''), dataset: { kind: it.kind } }, [
          el('span', { class: 'tag tag-grey wf-excl-kind', text: t(it.kind === 'rule' ? 'waf.exclusion_type_rule' : 'waf.exclusion_type_path') }),
          el('code', { class: 'wfa-suggest-value', text: String(it.value) }),
          el('span', { class: 'zn-spacer' }),
          btn,
        ]);
      })),
    ]);
  }
  async function apply(r, it, btn) {
    if (btn) W.busy(btn, true);
    try {
      await W.addExclusion(r.route_id, W.exclusionBody(it.kind, it.value));
      state.applied.add(it.kind + ':' + r.route_id + ':' + it.value);
      W.toast(t('waf.asst_apply_ok'), 'success');
      return true;
    } catch (err) {
      W.toast(errMsg(err), 'error');
      if (btn) W.busy(btn, false);
      return false;
    }
  }
  function blockButton(r, rd) {
    const ready = rd === 'ready';
    const btn = el('button', { type: 'button', class: 'btn btn-sm ' + (ready ? 'btn-primary' : 'btn-secondary') + ' wfa-to-block' }, [icon('shield', 12), t('waf.asst_to_block')]);
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        kind: 'to-block', title: t('waf.asst_block_title'), ok: t('waf.asst_to_block'),
        message: t('waf.asst_block_msg', { host: str(r.host) }),
        warn: ready ? null : t('waf.asst_block_warn', { reason: t('waf.asst_' + rd + '_hint') }),
      });
      if (!ok) return;
      W.busy(btn, true);
      try {
        await W.request('PUT', '/api/v1/routes/' + encodeURIComponent(r.route_id), { waf_mode: 'block' });
        W.toast(t('waf.asst_block_ok', { host: str(r.host) }), 'success');
        loadAssistant(r.route_id);
        if (win.GCWafPage) win.GCWafPage.reload();
      } catch (err) {
        W.toast(errMsg(err), 'error');
        W.busy(btn, false);
      }
    });
    return btn;
  }
  function showEvents(host) {
    setTab('events');
    if (win.GCWafPage) win.GCWafPage.setFilter({ host: str(host).toLowerCase() });
  }

  // ─── Own IPs + scanner ban (settings) ──────────────────────────────────
  async function loadProtect() {
    await Promise.all([loadSettings(), loadBans()]);
  }
  async function loadSettings() {
    try {
      const res = await W.request('GET', '/api/v1/settings/waf');
      state.settings = normSettings(res);
      state.draft = JSON.parse(JSON.stringify(state.settings));
      state.settingsError = null;
    } catch (err) {
      state.settingsError = err;
    }
    renderSettings();
  }
  function normSettings(res) {
    const ab = isObj(res && res.autoban) ? res.autoban : {};
    return {
      trusted_ips: Array.isArray(res && res.trusted_ips) ? res.trusted_ips.map(str) : [],
      trusted_bypass: !!(res && res.trusted_bypass),
      autoban: { enabled: !!ab.enabled, threshold: Number(ab.threshold) || 5, window_min: Number(ab.window_min) || 10, duration_h: Number(ab.duration_h) || 24 },
    };
  }
  const AB_FIELDS = [['wfa-ab-threshold', 'threshold', 'waf.autoban_threshold'], ['wfa-ab-window', 'window_min', 'waf.autoban_window'], ['wfa-ab-duration', 'duration_h', 'waf.autoban_duration']];
  function setToggle(node, on, disabled) {
    if (!node) return;
    node.classList.toggle('on', !!on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
    node.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }
  function renderSettings() {
    const err = state.settingsError;
    const locked = err && licenceBlocked(err);
    ['wfa-trusted-card', 'wfa-autoban-card'].forEach((id) => { const c = $(id); if (c) c.classList.toggle('wfa-unavailable', !state.settings); });
    const status = $('wfa-settings-state');
    if (status) {
      if (!state.settings) {
        status.hidden = false;
        status.replaceChildren(locked ? licenceNode() : (err ? stateBox(t('waf.load_error') + ' ' + errMsg(err), 'wfa-error', () => loadSettings()) : stateBox(t('common.loading'), 'wfa-loading')));
      } else { status.hidden = true; status.replaceChildren(); }
    }
    if (!state.settings) return;
    renderTrusted();
    renderAutoban();
  }
  function renderTrusted() {
    const d = state.draft;
    const list = $('wfa-trusted-list');
    if (list) {
      list.replaceChildren(...(d.trusted_ips.length ? d.trusted_ips.map((ip) => el('span', { class: 'wfa-ip-chip', role: 'listitem', dataset: { ip } }, [
        el('code', { text: ip }),
        el('button', { type: 'button', class: 'wfa-ip-remove', title: t('waf.trusted_remove', { ip }), 'aria-label': t('waf.trusted_remove', { ip }),
          on: { click: () => { d.trusted_ips = d.trusted_ips.filter((x) => x !== ip); renderTrusted(); } } }, [icon('x', 11)]),
      ])) : [el('span', { class: 'wfa-ip-empty', text: t('waf.trusted_empty') })]));
    }
    const count = $('wfa-trusted-count');
    if (count) count.textContent = t('waf.trusted_count', { n: d.trusted_ips.length, max: TRUSTED_MAX });
    setToggle($('wfa-bypass'), d.trusted_bypass, false);
    const warn = $('wfa-bypass-warn');
    if (warn) warn.classList.toggle('wfa-warn-on', d.trusted_bypass);
    const dirty = !sameList(d.trusted_ips, state.settings.trusted_ips) || d.trusted_bypass !== state.settings.trusted_bypass;
    const save = $('wfa-trusted-save');
    if (save) save.disabled = !dirty;
    const mark = $('wfa-trusted-dirty');
    if (mark) mark.hidden = !dirty;
  }
  function renderAutoban() {
    const d = state.draft.autoban;
    setToggle($('wfa-autoban'), d.enabled, false);
    AB_FIELDS.forEach(([id, k]) => {
      const n = $(id);
      if (n && doc.activeElement !== n) n.value = String(d[k]);
    });
    const fields = $('wfa-autoban-fields');
    if (fields) fields.classList.toggle('wfa-fields-off', !d.enabled);
    const sum = $('wfa-autoban-summary');
    if (sum) sum.textContent = d.enabled ? t('waf.autoban_summary', { threshold: d.threshold, window: d.window_min, duration: d.duration_h }) : t('waf.autoban_off');
    const s = state.settings.autoban;
    const dirty = d.enabled !== s.enabled || d.threshold !== s.threshold || d.window_min !== s.window_min || d.duration_h !== s.duration_h;
    const save = $('wfa-autoban-save');
    if (save) save.disabled = !dirty || !!autobanError();
    const mark = $('wfa-autoban-dirty');
    if (mark) mark.hidden = !dirty;
  }
  function autobanError() {
    for (const [id, k, label] of AB_FIELDS) {
      const n = $(id);
      if (n && intIn(n.value, k) == null) return { id, k, label };
    }
    return null;
  }
  function fieldError(id, text) {
    const n = $(id);
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
  }
  async function saveSettings(body, btn, errId) {
    fieldError(errId, '');
    W.busy(btn, true);
    try {
      const res = await W.request('PUT', '/api/v1/settings/waf', body);
      state.settings = normSettings(res);
      const keepAb = body.autoban ? null : state.draft.autoban;
      const keepTr = body.trusted_ips ? null : { trusted_ips: state.draft.trusted_ips, trusted_bypass: state.draft.trusted_bypass };
      state.draft = JSON.parse(JSON.stringify(state.settings));
      if (keepAb) state.draft.autoban = keepAb;
      if (keepTr) Object.assign(state.draft, keepTr);
      W.toast(t(res.synced ? 'waf.saved_synced' : 'waf.saved'), 'success');
      if (body.trusted_ips) loadBans();   // bans of addresses that became own are gone
      if (win.GCWafPage) win.GCWafPage.reload();
    } catch (err) {
      fieldError(errId, errMsg(err));
    } finally {
      W.busy(btn, false);
      renderSettings();
    }
  }

  // ─── Bans ──────────────────────────────────────────────────────────────
  let bansSeq = 0;
  async function loadBans() {
    const my = ++bansSeq;
    try {
      const res = await W.request('GET', '/api/v1/waf/bans');
      if (my !== bansSeq) return;
      state.bans = Array.isArray(res.bans) ? res.bans.filter(isObj) : [];
      state.bansError = null;
    } catch (err) {
      if (my !== bansSeq) return;
      state.bansError = err;
    }
    renderBans();
  }
  function renderBans() {
    const body = $('wfa-bans-list');
    const count = $('wfa-bans-count');
    if (!body) return;
    const row = (node, cls) => { const td = el('td', { colSpan: 7 }, [node]); td.colSpan = 7; return el('tr', { class: 'wf-empty' + (cls ? ' ' + cls : '') }, [td]); };
    if (!state.bans) {
      if (count) count.textContent = '';
      body.replaceChildren(row(state.bansError
        ? (licenceBlocked(state.bansError) ? licenceNode() : stateBox(t('waf.load_error') + ' ' + errMsg(state.bansError), 'wfa-error', () => loadBans()))
        : el('span', { text: t('common.loading') })));
      return;
    }
    if (count) count.textContent = state.bans.length ? String(state.bans.length) : '';
    if (!state.bans.length) { body.replaceChildren(row(el('span', { class: 'wfa-bans-empty', text: t('waf.bans_empty') }))); return; }
    body.replaceChildren(...state.bans.map((b) => el('tr', { class: 'wfa-ban-row', dataset: { ip: str(b.ip), manual: b.manual ? '1' : '0' } }, [
      el('td', { 'data-label': t('waf.bans_col_ip') }, [el('code', { class: 'wf-mono wfa-ban-ip', text: str(b.ip) })]),
      el('td', { class: 'wfa-ban-reason', 'data-label': t('waf.bans_col_reason'), text: reasonLabel(b) }),
      el('td', { class: 'wfa-c-num', 'data-label': t('waf.bans_col_hits'), text: b.hits == null ? '—' : String(b.hits) }),
      el('td', { 'data-label': t('waf.bans_col_since'), text: localTime(b.banned_at) }),
      el('td', { 'data-label': t('waf.bans_col_until'), text: b.expires_at ? localTime(b.expires_at) : t('waf.bans_never') }),
      el('td', { 'data-label': t('waf.bans_col_kind') }, [el('span', { class: 'tag ' + (b.manual ? 'tag-blue' : 'tag-amber') + ' wfa-ban-kind', text: t(b.manual ? 'waf.bans_manual' : 'waf.bans_auto') })]),
      el('td', { class: 'wfa-c-act' }, [el('button', { type: 'button', class: 'btn btn-ghost btn-sm wfa-unban', on: { click: (e) => unban(b, e.currentTarget) } }, [icon('x', 12), t('waf.bans_unban')])]),
    ])));
  }
  async function unban(b, btn) {
    const ok = await confirmDialog({ kind: 'unban', title: t('waf.bans_unban_title'), message: t('waf.bans_unban_msg', { ip: str(b.ip) }), ok: t('waf.bans_unban') });
    if (!ok) return;
    W.busy(btn, true);
    try {
      await W.request('DELETE', banUrl(b.ip));
      W.toast(t('waf.bans_unbanned', { ip: str(b.ip) }), 'success');
    } catch (err) {
      if (!(err && err.data && err.data.code === 'WAF_BAN_NOT_FOUND')) { W.toast(errMsg(err), 'error'); W.busy(btn, false); return; }
    }
    loadBans();
  }
  function openBanDialog() {
    const d = W.dialog({ title: t('waf.bans_add_title'), kind: 'ban' });
    d.overlay.classList.add('wfa-dialog', 'wfa-ban-dialog');
    const ip = el('input', { type: 'text', class: 'form-input wf-mono wfa-ban-ip-input', maxLength: 64, autocomplete: 'off', spellcheck: 'false', placeholder: '203.0.113.7' });
    const hours = el('input', { type: 'number', class: 'form-input wfa-ban-hours', min: '1', max: '8760', step: '1', value: String((state.settings && state.settings.autoban.duration_h) || 24) });
    const reason = el('input', { type: 'text', class: 'form-input wfa-ban-reason-input', maxLength: 200, autocomplete: 'off', placeholder: t('waf.bans_reason_ph') });
    const err = el('div', { class: 'zn-field-error wf-field-error', role: 'alert' });
    err.hidden = true;
    const field = (label, input) => el('label', { class: 'wf-field wfa-field' }, [el('span', { class: 'wf-f-label', text: label }), input]);
    d.body.appendChild(field(t('waf.bans_ip_label'), ip));
    d.body.appendChild(el('div', { class: 'wfa-field-row' }, [field(t('waf.bans_duration_label'), hours), field(t('waf.bans_reason_label'), reason)]));
    d.body.appendChild(W.hintEl(t('waf.bans_add_hint')));
    d.body.appendChild(err);
    const ok = el('button', { type: 'button', class: 'btn btn-danger wfa-ban-ok', text: t('waf.bans_add') });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(ok);
    const show = (s) => { err.textContent = s || ''; err.hidden = !s; };
    [ip, hours, reason].forEach((n) => {
      n.addEventListener('input', () => show(''));
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
    });
    ok.addEventListener('click', async () => {
      show('');
      const p = parseAddr(ip.value);
      if (!p) { show(t('waf.err.ban_ip_invalid')); ip.focus(); return; }
      const h = intIn(hours.value, 'duration_h');
      if (h == null) { show(t('waf.err.ban_duration')); hours.focus(); return; }
      W.busy(ok, true);
      try {
        const body = { ip: p.text, duration_h: h };
        if (reason.value.trim()) body.reason = reason.value.trim();
        const res = await W.request('POST', '/api/v1/waf/bans', body);
        W.toast(t('waf.bans_added', { ip: str(res.ban && res.ban.ip) || p.text }), 'success');
        d.close(true);
        loadBans();
      } catch (e) {
        show(errMsg(e));
        W.busy(ok, false);
      }
    });
    ip.focus();
    return d;
  }

  // ─── Wiring ────────────────────────────────────────────────────────────
  const tabs = $('wf-tabs');
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-wf-tab]'); if (b) setTab(b.dataset.wfTab); });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.indexOf(state.tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    const b = tabs.querySelector('[data-wf-tab="' + next + '"]');
    if (b) b.focus();
  });
  win.addEventListener('hashchange', () => setTab(parseTab(win.location.hash), { keepHash: true }));

  // Own IPs editor
  const tInput = $('wfa-trusted-input');
  const tAdd = $('wfa-trusted-add');
  function addFromInput() {
    if (!state.draft || !tInput) return;
    const res = addTrusted(state.draft.trusted_ips, tInput.value);
    let msg = '';
    if (res.invalid.length) msg = t('waf.trusted_invalid', { value: res.invalid[0] });
    else if (res.duplicate.length && !res.added.length) msg = t('waf.trusted_duplicate', { value: res.duplicate[0] });
    else if (res.overflow) msg = t('waf.trusted_limit', { max: TRUSTED_MAX });
    state.draft.trusted_ips = res.list;
    if (!res.invalid.length) tInput.value = '';
    fieldError('wfa-trusted-error', msg);
    renderTrusted();
    tInput.focus();
  }
  if (tAdd) tAdd.addEventListener('click', addFromInput);
  if (tInput) {
    tInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } });
    tInput.addEventListener('input', () => fieldError('wfa-trusted-error', ''));
  }
  function toggleHandler(node, fn) {
    if (!node) return;
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fn(); } });
  }
  toggleHandler($('wfa-bypass'), async () => {
    if (!state.draft) return;
    if (!state.draft.trusted_bypass) {
      const ok = await confirmDialog({
        kind: 'bypass', title: t('waf.bypass_confirm_title'), danger: true, ok: t('waf.bypass_confirm_ok'),
        message: t('waf.bypass_confirm', { n: state.draft.trusted_ips.length }), warn: t('waf.bypass_warn'),
      });
      if (!ok) return;
    }
    state.draft.trusted_bypass = !state.draft.trusted_bypass;
    renderTrusted();
  });
  const tSave = $('wfa-trusted-save');
  if (tSave) tSave.addEventListener('click', () => {
    if (!state.draft) return;
    saveSettings({ trusted_ips: state.draft.trusted_ips, trusted_bypass: state.draft.trusted_bypass }, tSave, 'wfa-trusted-error');
  });
  toggleHandler($('wfa-autoban'), () => { if (!state.draft) return; state.draft.autoban.enabled = !state.draft.autoban.enabled; renderAutoban(); });
  AB_FIELDS.forEach(([id, k]) => {
    const n = $(id);
    if (!n) return;
    n.addEventListener('input', () => {
      if (!state.draft) return;
      const v = intIn(n.value, k);
      n.classList.toggle('wfa-invalid', v == null);
      n.setAttribute('aria-invalid', v == null ? 'true' : 'false');
      if (v != null) state.draft.autoban[k] = v;
      const bad = autobanError();
      fieldError('wfa-autoban-error', bad ? t('waf.autoban_range', { field: t(bad.label), min: LIMITS[bad.k][0], max: LIMITS[bad.k][1] }) : '');
      renderAutoban();
    });
  });
  const aSave = $('wfa-autoban-save');
  if (aSave) aSave.addEventListener('click', () => {
    if (!state.draft || autobanError()) return;
    saveSettings({ autoban: Object.assign({}, state.draft.autoban) }, aSave, 'wfa-autoban-error');
  });
  const banAdd = $('wfa-ban-add');
  if (banAdd) banAdd.addEventListener('click', openBanDialog);

  // Refresh button of the page: the active tab's data too.
  const refresh = $('btn-waf-refresh');
  if (refresh) refresh.addEventListener('click', () => {
    if (state.tab === 'assistant') loadAssistant();
    if (state.tab === 'protect') { loadBans(); if (!state.settings) loadSettings(); }
  });
  // Live: ban/unban → ban list; other WAF events / route changes → assistant (debounced).
  let asstTimer = null;
  function scheduleAssistant() {
    if (!state.asstLoaded) return;
    clearTimeout(asstTimer);
    asstTimer = setTimeout(() => loadAssistant(), 1500);
  }
  doc.addEventListener('gc:waf', (e) => {
    const d = e && e.detail;
    if (d && (d.kind === 'ban' || d.kind === 'unban')) { if (state.bans || state.bansError) loadBans(); return; }
    scheduleAssistant();
  });
  doc.addEventListener('gc:routes', scheduleAssistant);
  doc.addEventListener('gc:waf-exclusions', scheduleAssistant);

  setTab(state.tab, { keepHash: true });
  renderAssistant();
  renderBans();

  return Object.assign(pure, { setTab, loadAssistant, loadBans, loadSettings, getState: () => state });
});
