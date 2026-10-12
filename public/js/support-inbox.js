'use strict';

// Support-Pakete — admin page /support-bundles (System › Support-Pakete,
// docs/feature-support-bundle.md "Admin-Oberfläche").
//
// List of every support bundle of every device (newest first, "neu" until an
// admin opened it), filter by device (?peer=<id>) and status (?status=new|
// viewed), pages of 50. The viewer (#view/<peerId>/<bundleId>) renders one
// bundle: summary, tunnel, settings, network, WireGuard config, recent
// errors, logs (search + level filter), other data and the raw JSON.
//   GET    /api/v1/support-bundles                          list
//   GET    /api/v1/peers/:id/support-bundles/:bid           viewer (marks it viewed)
//   GET    /api/v1/peers/:id/support-bundles/:bid/download  JSON attachment
//   DELETE /api/v1/peers/:id/support-bundles/:bid
// Live: gc:activity support_bundle_uploaded (events.js) reloads the list.
//
// Strings: the #sb-i18n island (support_bundles.*, common.*). DOM only through
// el()/textContent — no innerHTML; bundle content is device data. The pure
// helpers are exported for node:test (tests/support_inbox.test.js); in the
// browser the file mounts itself.
(function (root, factory) {
  const core = factory(typeof window !== 'undefined' ? window : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof self !== 'undefined' ? self : this, function (win) {
  const PAGE_SIZE = 50;
  const STATUSES = ['', 'new', 'viewed'];
  const LEVELS = ['error', 'warn', 'info', 'debug'];
  const MAX_LOG_ROWS = 2000;
  const KNOWN_KEYS = ['schema', 'createdAt', 'reason', 'client', 'tunnel', 'settings', 'wireguardConfig', 'network', 'logs', 'errors', 'server'];
  const PRODUCTS = { pro: 'Pro', community: 'Community', android: 'Android' };

  // ─── Pure helpers ────────────────────────────────────────────────────────

  function str(v) { return v == null ? '' : String(v); }

  /** '#view/12/34' → { peerId: 12, bundleId: 34 }, anything else → null. */
  function parseRoute(hash) {
    const m = /^#view\/(\d{1,9})\/(\d{1,12})$/.exec(str(hash));
    return m ? { peerId: Number(m[1]), bundleId: Number(m[2]) } : null;
  }
  function viewHash(peerId, bundleId) {
    return '#view/' + encodeURIComponent(peerId) + '/' + encodeURIComponent(bundleId);
  }

  /** ?peer=&status= of the page → filter state (invalid values dropped). */
  function parseSearch(search) {
    const out = { peerId: null, status: '' };
    str(search).replace(/^\?/, '').split('&').forEach((pair) => {
      const i = pair.indexOf('=');
      const k = i < 0 ? pair : pair.slice(0, i);
      const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      if (k === 'peer' && /^\d{1,9}$/.test(v) && Number(v) > 0) out.peerId = Number(v);
      if (k === 'status' && STATUSES.indexOf(v) >= 0) out.status = v;
    });
    return out;
  }
  function searchFor(f) {
    const parts = [];
    if (f.peerId) parts.push('peer=' + encodeURIComponent(f.peerId));
    if (f.status) parts.push('status=' + encodeURIComponent(f.status));
    return parts.length ? '?' + parts.join('&') : '';
  }
  /** Query string of the list API. */
  function listQuery(f) {
    const parts = ['limit=' + (f.limit || PAGE_SIZE), 'offset=' + (f.offset || 0)];
    if (f.peerId) parts.push('peerId=' + encodeURIComponent(f.peerId));
    if (f.status) parts.push('status=' + encodeURIComponent(f.status));
    return '?' + parts.join('&');
  }

  function productLabel(p) { return PRODUCTS[p] || ''; }
  /** "Android 1.17.0" / "Pro 2.5.0" / "1.2.3" / "". */
  function clientLabel(b) {
    return (productLabel(b && b.client_product) + ' ' + str(b && b.client_version)).trim();
  }

  /** SQLite UTC 'YYYY-MM-DD HH:MM:SS' or ISO → Date (null when unparseable). */
  function parseTime(v) {
    const s = str(v).trim();
    if (!s) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  function fmtTime(v, lang) {
    const d = parseTime(v);
    if (!d) return str(v);
    try {
      return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /** Level of a log line from its head: error | warn | info | debug | ''. */
  function logLevel(line) {
    const s = str(line);
    const head = s.slice(0, 120);
    let m = /\[(error|err|fatal|crit(?:ical)?|warn(?:ing)?|info|notice|debug|trace|verbose)\]/i.exec(head)
      || /\blevel["']?\s*[=:]\s*["']?(error|err|fatal|warn(?:ing)?|info|debug|trace)\b/i.exec(head)
      || /(?:^|\s)([VDIWEF])\/[^\s]/.exec(head)
      || /\s([VDIWEF])\s+[^\s:]{1,64}\s*:/.exec(head)
      || /\b(ERROR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)\b/.exec(head);
    if (!m) return '';
    const t = m[1].toLowerCase();
    if (t === 'e' || t === 'f' || t === 'err' || t === 'error' || t === 'fatal' || t.startsWith('crit')) return 'error';
    if (t === 'w' || t.startsWith('warn')) return 'warn';
    if (t === 'i' || t === 'info' || t === 'notice') return 'info';
    return 'debug';
  }

  /** One log entry (string or { time, level, tag, message }) → { text, level }. */
  function logEntry(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const time = raw.time || raw.ts || raw.timestamp || '';
      const lvl = str(raw.level || raw.severity || raw.priority).toLowerCase();
      const msg = raw.message != null ? raw.message : (raw.msg != null ? raw.msg : '');
      const text = [time, lvl ? '[' + lvl + ']' : '', raw.tag || '', typeof msg === 'string' ? msg : JSON.stringify(msg)]
        .filter((x) => x !== '' && x != null).join(' ');
      return { text: text || JSON.stringify(raw), level: logLevel('[' + lvl + ']') || logLevel(text) };
    }
    const text = str(raw);
    return { text, level: logLevel(text) };
  }

  /** bundle.logs in any shape → { lines: [{ text, level }], total, truncated }. */
  function normLogs(logs) {
    let raw = [];
    let total = null;
    let truncated = false;
    if (Array.isArray(logs)) raw = logs;
    else if (typeof logs === 'string') raw = logs.split(/\r?\n/);
    else if (logs && typeof logs === 'object') {
      if (Array.isArray(logs.lines)) raw = logs.lines;
      else if (typeof logs.lines === 'string') raw = logs.lines.split(/\r?\n/);
      else if (typeof logs.text === 'string') raw = logs.text.split(/\r?\n/);
      const n = Number(logs.totalLines);
      total = Number.isFinite(n) && n >= 0 ? n : null;
      truncated = logs.truncated === true || (total != null && total > raw.length);
    }
    if (raw.length && raw[raw.length - 1] === '') raw = raw.slice(0, -1);
    const lines = raw.map(logEntry);
    return { lines, total: total == null ? lines.length : total, truncated };
  }

  /** Lines matching a search text (case-insensitive) and a level ('' = all). */
  function filterLines(lines, query, level) {
    const q = str(query).trim().toLowerCase();
    return lines.filter((l) => (!level || l.level === level) && (!q || l.text.toLowerCase().indexOf(q) >= 0));
  }

  /** Split text at the (case-insensitive) matches of q: [{ text, hit }]. */
  function splitHits(text, query) {
    const q = str(query).trim().toLowerCase();
    const s = str(text);
    if (!q) return [{ text: s, hit: false }];
    const out = [];
    const low = s.toLowerCase();
    let at = 0;
    for (let i = low.indexOf(q); i >= 0 && out.length < 200; i = low.indexOf(q, at)) {
      if (i > at) out.push({ text: s.slice(at, i), hit: false });
      out.push({ text: s.slice(i, i + q.length), hit: true });
      at = i + q.length;
    }
    if (at < s.length) out.push({ text: s.slice(at), hit: false });
    return out;
  }

  /** Nested object → [[ 'a.b', value ], …] (arrays of primitives stay values). */
  function flatten(obj, prefix, out, depth) {
    const res = out || [];
    const d = depth || 0;
    if (obj == null || typeof obj !== 'object') {
      res.push([prefix || '', obj]);
      return res;
    }
    const keys = Object.keys(obj);
    if (Array.isArray(obj)) {
      if (obj.every((v) => v == null || typeof v !== 'object') || d >= 6) { res.push([prefix || '', obj]); return res; }
      obj.forEach((v, i) => flatten(v, (prefix ? prefix : '') + '[' + i + ']', res, d + 1));
      return res;
    }
    if (!keys.length && prefix) { res.push([prefix, obj]); return res; }
    if (d >= 6) { res.push([prefix || '', obj]); return res; }
    keys.forEach((k) => flatten(obj[k], prefix ? prefix + '.' + k : k, res, d + 1));
    return res;
  }

  /** Bundle keys the viewer does not render in a section of its own. */
  function otherKeys(data) {
    return data && typeof data === 'object' ? Object.keys(data).filter((k) => KNOWN_KEYS.indexOf(k) < 0) : [];
  }

  const pure = {
    PAGE_SIZE, STATUSES, LEVELS, KNOWN_KEYS, MAX_LOG_ROWS,
    parseRoute, viewHash, parseSearch, searchFor, listQuery, productLabel, clientLabel, parseTime, fmtTime,
    logLevel, logEntry, normLogs, filterLines, splitHits, flatten, otherKeys,
  };
  if (!win || !win.document) return pure;

  // ─── Browser part ────────────────────────────────────────────────────────
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const page = $('sb-page');
  if (!page) return pure;

  function readJson(id) {
    const n = $(id);
    if (!n) return {};
    try { return JSON.parse(n.textContent || '{}') || {}; } catch { return {}; }
  }
  const I18N = readJson('sb-i18n');
  const LANG = (win.GC && win.GC.language) || doc.documentElement.lang || 'de';
  function T(key, params) {
    let s = I18N[key];
    if (s == null && win.GC && win.GC.t) s = win.GC.t[key];
    if (s == null) s = key;
    Object.keys(params || {}).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  const D = win.GCDialog;

  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'hidden' || k === 'type' || k === 'value' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof win.Node ? c : String(c));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(d) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '14'], ['height', '14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    d.split('|').forEach((part) => {
      const path = doc.createElementNS(SVGNS, 'path');
      path.setAttribute('d', part);
      svg.append(path);
    });
    return svg;
  }
  const ICON_DOWNLOAD = 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3';
  const ICON_DELETE = 'M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13';
  function bytes(n) { return win.formatBytes ? win.formatBytes(n) : String(n) + ' B'; }
  function apiBase(peerId) { return '/api/v1/peers/' + encodeURIComponent(peerId) + '/support-bundles'; }
  function toast(msg, type) { if (win.showToast) win.showToast(msg, type); }

  async function getJson(url) {
    const res = await win.fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body: body || {} };
  }

  function setBadge(n) {
    const b = $('sb-nav-badge');
    if (!b) return;
    const v = Number(n) || 0;
    b.textContent = v > 0 ? String(v) : '';
    b.hidden = v <= 0;
    if (v > 0) b.title = T('support_bundles.nav_badge', { count: v });
  }

  // ─── List ────────────────────────────────────────────────────────────────
  const listView = $('sb-list-view');
  const viewer = $('sb-viewer');
  const tbody = $('sb-tbody');
  const peerSel = $('sb-filter-peer');
  const state = Object.assign({ offset: 0, loaded: false, viewing: null }, parseSearch(win.location.search));

  function reasonTag(reason) {
    return reason === 'admin_request'
      ? el('span', { class: 'tag tag-purple sb-tag', text: T('support_bundles.reason_admin_request') })
      : el('span', { class: 'sb-faint', text: T('support_bundles.reason_user') });
  }
  function statusCell(b) {
    if (b.is_new) return el('span', { class: 'tag tag-amber sb-tag', text: T('support_bundles.badge_new') });
    const title = b.viewed_by_name
      ? T('support_bundles.viewed_by', { time: fmtTime(b.viewed_at, LANG), name: b.viewed_by_name })
      : T('support_bundles.viewed_at', { time: fmtTime(b.viewed_at, LANG) });
    return el('span', { class: 'sb-faint', title }, T('support_bundles.status_viewed'));
  }

  function renderPeers(peers) {
    const keep = state.peerId ? String(state.peerId) : '';
    while (peerSel.options.length > 1) peerSel.remove(1);
    (peers || []).forEach((p) => {
      const label = str(p.name) + ' (' + p.count + (p.unviewed ? ', ' + T('support_bundles.badge_new') + ' ' + p.unviewed : '') + ')';
      peerSel.append(el('option', { value: String(p.id), text: label }));
    });
    if (keep && !Array.prototype.some.call(peerSel.options, (o) => o.value === keep)) {
      peerSel.append(el('option', { value: keep, text: '#' + keep }));
    }
    peerSel.value = keep;
  }

  function renderRows(data) {
    clear(tbody);
    const list = data.bundles || [];
    const empty = $('sb-empty');
    const filtered = !!(state.peerId || state.status);
    empty.hidden = list.length > 0;
    $('sb-table').hidden = list.length === 0;
    if (!list.length) {
      $('sb-empty-title').textContent = filtered ? T('support_bundles.empty_filtered') : T('support_bundles.empty_title');
      $('sb-empty-text').hidden = filtered;
      $('sb-empty-peers').hidden = filtered;
    }
    list.forEach((b) => {
      const open = viewHash(b.peer_id, b.id);
      const tr = el('tr', { 'data-bundle-id': String(b.id), 'data-peer-id': String(b.peer_id), class: b.is_new ? 'sb-row-new' : null });
      tr.append(
        el('td', { class: 'sb-nowrap' }, el('a', { href: open, class: 'sb-time-link', text: fmtTime(b.created_at, LANG), title: str(b.created_at) + ' UTC' })),
        el('td', { class: 'cell-name' }, el('a', { href: '/support-bundles' + searchFor({ peerId: b.peer_id, status: state.status }), class: 'sb-peer-link', text: str(b.peer_name) || '#' + b.peer_id })),
        el('td', { text: str(b.user_name) || '—', class: b.user_name ? null : 'sb-faint' }),
        el('td', { class: 'mono', text: clientLabel(b) || '—', title: str(b.os) || null }),
        el('td', null, reasonTag(b.reason)),
        el('td', { class: 'mono sb-r', text: bytes(b.size_bytes) }),
        el('td', null, statusCell(b)),
        el('td', { class: 'sb-r sb-nowrap' }, [
          el('a', { class: 'btn btn-sm btn-ghost', href: open, 'data-action': 'view', text: T('support_bundles.view') }),
          el('a', { class: 'btn btn-sm btn-ghost sb-icon-btn', href: apiBase(b.peer_id) + '/' + encodeURIComponent(b.id) + '/download', download: '',
            'data-action': 'download', title: T('support_bundles.download'), 'aria-label': T('support_bundles.download') }, icon(ICON_DOWNLOAD)),
          el('button', { class: 'btn btn-sm btn-ghost sb-icon-btn sb-danger', type: 'button', 'data-action': 'delete', title: T('common.delete'),
            'aria-label': T('common.delete'), on: { click: () => removeBundle(b.peer_id, b.id, false) } }, icon(ICON_DELETE)),
        ]),
      );
      tbody.append(tr);
    });
    const total = Number(data.total) || 0;
    $('sb-count').textContent = T('support_bundles.count', { count: total, new: Number(data.unviewed) || 0 });
    const pager = $('sb-pager');
    pager.hidden = total <= PAGE_SIZE;
    if (!pager.hidden) {
      $('sb-page-info').textContent = T('support_bundles.page_info', { from: state.offset + 1, to: Math.min(total, state.offset + list.length), total });
      $('sb-prev').disabled = state.offset <= 0;
      $('sb-next').disabled = state.offset + PAGE_SIZE >= total;
    }
  }

  function listError(msg) {
    clear(tbody);
    $('sb-table').hidden = false;
    $('sb-empty').hidden = true;
    tbody.append(el('tr', null, el('td', { colspan: '8', class: 'sb-loading sb-error' }, [
      el('span', { text: msg || T('support_bundles.load_failed') + ' ' }),
      el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: T('common.refresh'), on: { click: () => loadList() } }),
    ])));
  }

  let listSeq = 0;
  async function loadList() {
    const seq = ++listSeq;
    try {
      const r = await getJson('/api/v1/support-bundles' + listQuery({ peerId: state.peerId, status: state.status, offset: state.offset, limit: PAGE_SIZE }));
      if (seq !== listSeq) return;
      if (r.status !== 200 || !r.body.ok) { listError(r.body.error); return; }
      if (!r.body.bundles.length && state.offset > 0 && r.body.total > 0) {
        state.offset = Math.max(0, Math.floor((r.body.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        loadList();
        return;
      }
      state.loaded = true;
      renderPeers(r.body.peers);
      renderRows(r.body);
      setBadge(r.body.unviewed);
    } catch (err) {
      if (seq === listSeq) listError(err && err.message);
    }
  }

  function setFilter(patch) {
    Object.assign(state, patch, { offset: 0 });
    Array.prototype.forEach.call($('sb-chips').querySelectorAll('.filter-chip'), (c) => {
      const on = c.getAttribute('data-status') === state.status;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const keepHash = parseRoute(win.location.hash) ? win.location.hash : '';
    try { win.history.replaceState(null, '', win.location.pathname + searchFor(state) + keepHash); } catch { /* ignore */ }
    loadList();
  }

  peerSel.addEventListener('change', () => setFilter({ peerId: peerSel.value ? Number(peerSel.value) : null }));
  $('sb-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (chip) setFilter({ status: chip.getAttribute('data-status') || '' });
  });
  $('sb-prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadList(); });
  $('sb-next').addEventListener('click', () => { state.offset += PAGE_SIZE; loadList(); });
  $('sb-refresh').addEventListener('click', () => {
    if (state.viewing) openViewer(state.viewing.peerId, state.viewing.bundleId);
    else loadList();
  });

  async function removeBundle(peerId, id, fromViewer) {
    const ok = D ? await D.confirm({ message: T('support_bundles.confirm_delete'), danger: true, okLabel: T('common.delete') }) : false;
    if (!ok) return;
    try {
      const res = await win.api.del(apiBase(peerId) + '/' + encodeURIComponent(id));
      if (res && res.ok === false) throw new Error(res.error || T('support_bundles.error_delete'));
      toast(T('support_bundles.deleted'), 'success');
    } catch (err) {
      toast((err && err.message) || T('support_bundles.error_delete'), 'error');
      return;
    }
    if (fromViewer) closeViewer();
    else loadList();
  }

  // ─── Viewer ──────────────────────────────────────────────────────────────

  function section(title, body, opts) {
    const o = opts || {};
    return el('section', { class: 'card sb-sec' + (o.wide ? ' sb-sec-wide' : ''), 'data-sec': o.id || null }, [
      el('div', { class: 'sb-sec-head' }, [el('h3', { class: 'sb-sec-title', text: title })].concat(o.tools || [])),
      body,
    ]);
  }
  function none() { return el('p', { class: 'sb-faint sb-none', text: T('support_bundles.none') }); }

  function valueNode(v) {
    if (v === true) return el('span', { class: 'tag tag-green sb-tag', text: T('support_bundles.yes') });
    if (v === false) return el('span', { class: 'tag tag-grey sb-tag', text: T('support_bundles.no') });
    if (v == null || v === '') return el('span', { class: 'sb-faint', text: '—' });
    if (v === '[REDACTED]') return el('span', { class: 'sb-redacted', text: '[REDACTED]' });
    if (Array.isArray(v)) return el('span', { class: 'sb-mono', text: v.length ? v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : str(x))).join(', ') : '—' });
    if (typeof v === 'object') return el('span', { class: 'sb-mono', text: Object.keys(v).length ? JSON.stringify(v) : '—' });
    return el('span', { class: 'sb-mono', text: str(v) });
  }

  /** rows: [[label, value(node|primitive), opts?]] → key/value table. */
  function kvTable(rows, keyMono) {
    if (!rows.length) return none();
    const tb = el('tbody');
    rows.forEach((r) => {
      tb.append(el('tr', null, [
        el('th', { scope: 'row', class: keyMono ? 'sb-mono' : null, text: r[0] }),
        el('td', null, r[1] instanceof win.Node ? r[1] : valueNode(r[1])),
      ]));
    });
    return el('div', { class: 'sb-kv-wrap' }, el('table', { class: 'sb-kv' }, tb));
  }

  function summary(meta, data) {
    const c = (data.client && typeof data.client === 'object') ? data.client : {};
    const items = [
      ['support_bundles.sum_device', el('a', { href: '/peers#edit/' + encodeURIComponent(meta.peer_id), text: str(meta.peer_name) || '#' + meta.peer_id })],
      ['support_bundles.sum_user', meta.user_name || null],
      ['support_bundles.sum_received', fmtTime(meta.created_at, LANG)],
      ['support_bundles.sum_created', data.createdAt ? fmtTime(data.createdAt, LANG) : null],
      ['support_bundles.sum_reason', reasonTag(meta.reason)],
      ['support_bundles.sum_client', (productLabel(c.product || meta.client_product) + ' ' + str(c.version || meta.client_version)).trim() || null],
      ['support_bundles.sum_core', c.coreVersion || null],
      ['support_bundles.sum_os', c.os || meta.os || null],
      ['support_bundles.sum_platform', c.platform || meta.client_platform || null],
      ['support_bundles.sum_arch', c.arch || null],
      ['support_bundles.sum_locale', c.locale || null],
      ['support_bundles.sum_size', bytes(meta.size_bytes) + (meta.json_bytes ? ' (' + bytes(meta.json_bytes) + ' JSON)' : '')],
    ];
    return el('dl', { class: 'sb-summary' }, items.map((it) => el('div', { class: 'sb-sum-item' }, [
      el('dt', { text: T(it[0]) }),
      el('dd', null, it[1] instanceof win.Node ? it[1] : (it[1] == null || it[1] === '' ? el('span', { class: 'sb-faint', text: '—' }) : str(it[1]))),
    ])));
  }

  function tunnelSection(t) {
    if (!t || typeof t !== 'object') return section(T('support_bundles.sec_tunnel'), none(), { id: 'tunnel' });
    const rows = [];
    const used = {};
    const take = (key, label, fmt) => {
      if (!(key in t)) return;
      used[key] = true;
      rows.push([T(label), fmt ? fmt(t[key]) : t[key]]);
    };
    take('connected', 'support_bundles.tunnel_connected', (v) => (typeof v === 'boolean'
      ? el('span', { class: 'tag sb-tag ' + (v ? 'tag-green' : 'tag-red'), text: v ? T('support_bundles.tunnel_up') : T('support_bundles.tunnel_down') })
      : v));
    take('connectedSince', 'support_bundles.tunnel_since', (v) => (v ? fmtTime(v, LANG) : v));
    take('lastHandshakeAgeSec', 'support_bundles.tunnel_handshake', (v) => (Number.isFinite(Number(v)) && v !== null && v !== ''
      ? T('support_bundles.tunnel_handshake_ago', { count: Math.round(Number(v)) }) : v));
    take('endpoint', 'support_bundles.tunnel_endpoint');
    take('rxBytes', 'support_bundles.tunnel_rx', (v) => (Number.isFinite(Number(v)) && v !== null ? bytes(Number(v)) : v));
    take('txBytes', 'support_bundles.tunnel_tx', (v) => (Number.isFinite(Number(v)) && v !== null ? bytes(Number(v)) : v));
    take('killSwitch', 'support_bundles.tunnel_kill_switch');
    const rest = {};
    Object.keys(t).forEach((k) => { if (!used[k]) rest[k] = t[k]; });
    flatten(rest).forEach((kv) => { if (kv[0]) rows.push([kv[0], kv[1]]); });
    return section(T('support_bundles.sec_tunnel'), kvTable(rows, false), { id: 'tunnel' });
  }

  function objectTable(list) {
    const cols = [];
    list.forEach((o) => Object.keys(o).forEach((k) => { if (cols.indexOf(k) < 0 && cols.length < 8) cols.push(k); }));
    const head = el('tr', null, cols.map((c) => el('th', { text: c })));
    const tb = el('tbody', null, list.map((o) => el('tr', null, cols.map((c) => el('td', null, valueNode(o[c]))))));
    return el('div', { class: 'sb-kv-wrap' }, el('table', { class: 'data-table sb-mini' }, [el('thead', null, head), tb]));
  }

  function listOrTable(v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return none();
    if (typeof v === 'string') return el('pre', { class: 'sb-pre', text: v });
    if (Array.isArray(v)) {
      if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return objectTable(v);
      return el('pre', { class: 'sb-pre', text: v.map((x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : str(x))).join('\n') });
    }
    if (typeof v === 'object') return kvTable(flatten(v).filter((kv) => kv[0]), true);
    return el('p', { class: 'sb-mono', text: str(v) });
  }

  function networkSection(n) {
    if (!n || typeof n !== 'object') return section(T('support_bundles.sec_network'), typeof n === 'string' ? el('pre', { class: 'sb-pre', text: n }) : none(), { id: 'network' });
    const parts = [];
    const sub = (label, v) => parts.push(el('div', { class: 'sb-sub' }, [el('h4', { class: 'sb-sub-title', text: label }), listOrTable(v)]));
    sub(T('support_bundles.net_interfaces'), n.interfaces);
    sub(T('support_bundles.net_dns'), Array.isArray(n.dnsServers) ? n.dnsServers.join('\n') : n.dnsServers);
    sub(T('support_bundles.net_routes'), n.routes);
    const rest = {};
    Object.keys(n).forEach((k) => { if (['interfaces', 'dnsServers', 'routes'].indexOf(k) < 0) rest[k] = n[k]; });
    if (Object.keys(rest).length) parts.push(el('div', { class: 'sb-sub' }, kvTable(flatten(rest).filter((kv) => kv[0]), true)));
    return section(T('support_bundles.sec_network'), el('div', null, parts), { id: 'network', wide: true });
  }

  function lineNode(l, query) {
    const row = el('div', { class: 'sb-line' + (l.level ? ' sb-lv-' + l.level : '') });
    splitHits(l.text, query).forEach((p) => row.append(p.hit ? el('mark', { text: p.text }) : doc.createTextNode(p.text)));
    return row;
  }

  function errorsSection(errors) {
    let list = [];
    if (Array.isArray(errors)) list = errors.map(logEntry);
    else if (typeof errors === 'string' && errors) list = errors.split(/\r?\n/).filter(Boolean).map(logEntry);
    const body = list.length
      ? el('div', { class: 'sb-log sb-log-errors' }, list.map((l) => lineNode({ text: l.text, level: l.level || 'error' }, '')))
      : el('p', { class: 'sb-faint sb-none', text: T('support_bundles.no_errors') });
    return section(T('support_bundles.sec_errors'), body, { id: 'errors', wide: true });
  }

  function logsSection(logs) {
    const n = normLogs(logs);
    const box = el('div', { class: 'sb-log', role: 'log', 'aria-label': T('support_bundles.sec_logs'), tabindex: '0' });
    const count = el('span', { class: 'sb-faint sb-small', 'aria-live': 'polite' });
    const capped = el('p', { class: 'sb-faint sb-small', hidden: true });
    const search = el('input', { type: 'search', class: 'sb-log-search', placeholder: T('support_bundles.logs_search'), 'aria-label': T('support_bundles.logs_search') });
    const level = el('select', { class: 'sb-log-level', 'aria-label': T('support_bundles.logs_level') },
      [el('option', { value: '', text: T('support_bundles.logs_level_all') })].concat(LEVELS.map((lv) => el('option', { value: lv, text: T('support_bundles.logs_level_' + lv) }))));
    function draw() {
      const hits = filterLines(n.lines, search.value, level.value);
      clear(box);
      const frag = doc.createDocumentFragment();
      hits.slice(0, MAX_LOG_ROWS).forEach((l) => frag.append(lineNode(l, search.value)));
      box.append(frag);
      if (!hits.length) box.append(el('div', { class: 'sb-faint sb-line', text: T('support_bundles.logs_empty') }));
      count.textContent = T('support_bundles.logs_count', { shown: hits.length, total: n.lines.length });
      capped.hidden = hits.length <= MAX_LOG_ROWS;
      capped.textContent = T('support_bundles.logs_capped', { count: MAX_LOG_ROWS });
    }
    let timer = null;
    search.addEventListener('input', () => { win.clearTimeout(timer); timer = win.setTimeout(draw, 120); });
    level.addEventListener('change', draw);
    draw();
    const parts = [];
    if (n.truncated) {
      parts.push(el('p', { class: 'sb-note sb-small', text: n.total > n.lines.length
        ? T('support_bundles.logs_truncated', { total: n.total, count: n.lines.length })
        : T('support_bundles.logs_truncated_short') }));
    }
    parts.push(el('div', { class: 'sb-log-tools' }, [search, level, count]), capped, box);
    return section(T('support_bundles.sec_logs'), el('div', null, parts), { id: 'logs', wide: true });
  }

  function renderViewer(meta, data) {
    clear(viewer);
    const head = el('div', { class: 'sb-view-head' }, [
      el('a', { href: '#', class: 'sb-back', 'data-action': 'back', text: '← ' + T('support_bundles.back'),
        on: { click: (e) => { e.preventDefault(); closeViewer(); } } }),
      el('div', { class: 'sb-view-row' }, [
        el('h2', { class: 'sb-view-title', id: 'sb-view-title', text: T('support_bundles.view_title', { name: str(meta.peer_name) || '#' + meta.peer_id }) }),
        el('div', { class: 'sb-view-actions' }, [
          el('a', { class: 'btn btn-ghost btn-sm', href: '/peers#edit/' + encodeURIComponent(meta.peer_id), text: T('support_bundles.open_peer') }),
          el('a', { class: 'btn btn-ghost btn-sm', href: apiBase(meta.peer_id) + '/' + encodeURIComponent(meta.id) + '/download', download: '', 'data-action': 'download', text: T('support_bundles.download') }),
          el('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-action': 'delete', text: T('common.delete'),
            on: { click: () => removeBundle(meta.peer_id, meta.id, true) } }),
        ]),
      ]),
      el('p', { class: 'sb-note', text: T('support_bundles.redacted_note') }),
    ]);
    const settingsRows = data.settings && typeof data.settings === 'object' ? flatten(data.settings).filter((kv) => kv[0]) : [];
    const other = otherKeys(data);
    const grid = el('div', { class: 'sb-grid' }, [
      tunnelSection(data.tunnel),
      section(T('support_bundles.sec_settings'), data.settings && typeof data.settings === 'object' ? kvTable(settingsRows, true) : listOrTable(data.settings), { id: 'settings' }),
      networkSection(data.network),
      section(T('support_bundles.sec_wireguard'), data.wireguardConfig ? el('pre', { class: 'sb-pre', text: typeof data.wireguardConfig === 'string' ? data.wireguardConfig : JSON.stringify(data.wireguardConfig, null, 2) }) : none(), { id: 'wireguard', wide: true }),
      errorsSection(data.errors),
      logsSection(data.logs),
      other.length ? section(T('support_bundles.sec_other'), el('div', null, other.map((k) => el('div', { class: 'sb-sub' }, [
        el('h4', { class: 'sb-sub-title sb-mono', text: k }),
        el('pre', { class: 'sb-pre', text: typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k], null, 2) }),
      ]))), { id: 'other', wide: true }) : null,
    ]);
    const raw = el('details', { class: 'card sb-raw', 'data-sec': 'raw' }, [
      el('summary', { class: 'sb-sec-title', text: T('support_bundles.sec_raw') }),
      el('pre', { class: 'sb-pre sb-pre-raw', text: JSON.stringify(data, null, 2) }),
    ]);
    viewer.append(head, el('div', { class: 'card sb-sum-card' }, summary(meta, data)), grid, raw);
  }

  function viewerMessage(msg, peerId, bundleId, withDownload) {
    clear(viewer);
    viewer.append(
      el('a', { href: '#', class: 'sb-back', text: '← ' + T('support_bundles.back'), on: { click: (e) => { e.preventDefault(); closeViewer(); } } }),
      el('div', { class: 'card sb-msg' }, [
        el('p', { text: msg }),
        withDownload ? el('a', { class: 'btn btn-primary btn-sm', href: apiBase(peerId) + '/' + encodeURIComponent(bundleId) + '/download', download: '', text: T('support_bundles.download') }) : null,
      ]),
    );
  }

  let viewSeq = 0;
  async function openViewer(peerId, bundleId) {
    const seq = ++viewSeq;
    state.viewing = { peerId, bundleId };
    listView.hidden = true;
    viewer.hidden = false;
    clear(viewer);
    viewer.append(el('p', { class: 'sb-faint sb-loading', text: T('common.loading') }));
    try {
      const r = await getJson(apiBase(peerId) + '/' + encodeURIComponent(bundleId));
      if (seq !== viewSeq) return;
      if (r.status === 413) { viewerMessage(r.body.error || T('support_bundles.error_too_large'), peerId, bundleId, true); return; }
      if (r.status !== 200 || !r.body.ok) { viewerMessage(r.body.error || T('support_bundles.error_not_found'), peerId, bundleId, false); return; }
      renderViewer(r.body.bundle || { id: bundleId, peer_id: peerId }, r.body.data || {});
      const title = $('sb-view-title');
      if (title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
      win.scrollTo(0, 0);
      refreshBadge();
    } catch (err) {
      if (seq === viewSeq) viewerMessage((err && err.message) || T('support_bundles.load_failed'), peerId, bundleId, false);
    }
  }

  function closeViewer() {
    state.viewing = null;
    viewSeq++;
    viewer.hidden = true;
    clear(viewer);
    listView.hidden = false;
    if (win.location.hash) {
      try { win.history.replaceState(null, '', win.location.pathname + win.location.search); } catch { win.location.hash = ''; }
    }
    loadList();
  }

  async function refreshBadge() {
    try {
      const r = await getJson('/api/v1/support-bundles?limit=1');
      if (r.status === 200 && r.body.ok) setBadge(r.body.unviewed);
    } catch { /* badge only */ }
  }

  function route() {
    const r = parseRoute(win.location.hash);
    if (r) openViewer(r.peerId, r.bundleId);
    else if (state.viewing) closeViewer();
    else loadList();
  }
  win.addEventListener('hashchange', route);

  // A device just sent a bundle (events.js forwards the activity stream).
  doc.addEventListener('gc:activity', (e) => {
    const d = (e && e.detail) || {};
    if (d.eventType !== 'support_bundle_uploaded') return;
    if (!state.viewing) loadList();
  });
  doc.addEventListener('gc:reconnected', () => { if (!state.viewing) loadList(); });

  // ─── Start ───────────────────────────────────────────────────────────────
  setFilter({});
  if (parseRoute(win.location.hash)) route();
  win.GCSupportInbox = { pure, state: () => state };
  return pure;
});
