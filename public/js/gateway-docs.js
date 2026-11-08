// "Versionen" and "Handbuch" of the Gateways page (#versions, #handbook) — the
// same building blocks as Einstellungen › Plugins › <plugin> (tabs "Versionen"
// and "Handbuch", the pgx-* classes of app.css): the release notes of every
// gateway version (GET /api/v1/gateways/releases, rendered as text with
// GCPluginsUI.noteLines) and the gateway chapters of the user guide
// (GET /api/v1/gateways/handbook, rendered on the server by the safe Markdown
// renderer of the plugin handbooks and rebuilt here from a whitelist).
// gateways.js routes to it (GCGatewayDocs.show); the help links of the page
// (a[data-guide], public/js/handbook.js) open the in-app handbook — the GitHub
// address stays their href (new tab, middle click, no script).
(function () {
  'use strict';
  const K = window.GCGatewayDocsKit;
  const PUI = window.GCPluginsUI;
  const D = window.GCDialog;
  if (!K || !D) return;
  const el = D.el;
  const lang = (window.GC && window.GC.language) === 'en' ? 'en' : 'de';
  let STR = {};
  try { STR = JSON.parse((document.getElementById('gwiz-i18n') || {}).textContent || '{}') || {}; } catch (_) { STR = {}; }
  function t(key, params) {
    let s = STR[key] != null ? STR[key] : ((window.GC && window.GC.t && window.GC.t[key] != null) ? window.GC.t[key] : key);
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  async function getJson(url) {
    try {
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      return d || { ok: false };
    } catch (_) { return { ok: false }; }
  }
  function fmtDate(iso) {
    if (PUI && PUI.fmtDate) return PUI.fmtDate(iso, lang);
    const d = new Date(iso || '');
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE');
  }
  function fmtDateTime(ms) {
    const d = new Date(ms || 0);
    if (!ms || Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }

  // ── building blocks (plugins-page.js) ──
  const TONES = { good: 'good', warn: 'warn', info: 'blue', new: 'new', mute: 'mute' };
  function pill(text, tone) { return el('span', { class: 'pgx-pill', 'data-tone': TONES[tone] || 'mute' }, [text]); }
  function card(kids, attrs, cls) { return el('section', Object.assign({ class: 'pgx-card' + (cls ? ' ' + cls : '') }, attrs || {}), kids); }
  function h2(text, id) { return el('h2', { class: 'pgx-h2', id: id || null, text }); }
  function lbl(text, attrs) { return el('span', Object.assign({ class: 'pgx-lbl' }, attrs || {}), [text]); }
  function ext(text, href, attrs) { return el('a', Object.assign({ class: 'pgx-a', href, target: '_blank', rel: 'noopener noreferrer' }, attrs || {}), [text + ' ↗']); }
  function linkBtn(text, onClick, attrs) { return el('button', Object.assign({ type: 'button', class: 'pgx-a', on: { click: onClick } }, attrs || {}), [text]); }

  /** Release notes as a list (plugins-page.js notesBlock: GCPluginsUI.noteLines, text only). */
  function notesBlock(md) {
    const lines = PUI && PUI.noteLines ? PUI.noteLines(md) : String(md || '').split('\n').filter((x) => x.trim()).map((x) => ({ kind: 'p', level: 0, text: x.trim() }));
    const box = el('div', { class: 'pgx-notes' });
    let list = null;
    lines.forEach((ln) => {
      if (ln.kind === 'li') {
        if (!list) { list = el('ul'); box.appendChild(list); }
        list.appendChild(el('li', { 'data-level': String(ln.level), text: ln.text }));
      } else { list = null; box.appendChild(el('p', { text: ln.text })); }
    });
    if (!lines.length) box.appendChild(el('p', { class: 'pgx-muted', text: t('gwd.ver.no_notes') }));
    return box;
  }

  // ── state ──
  let ctx = { gateways: [], latest: '', back: '' };
  let cur = null;          // { view, from, target }
  let host = null;         // the view's element (#gw-docs-view)
  let rel = null;          // the last answer of /releases (per `from`)
  let hb = null;           // { lang, data }

  // ════════════════════════════════════════════════════════════
  // Versionen
  // ════════════════════════════════════════════════════════════
  function versionRow(v, i, run, latest) {
    const names = run[v.version] || [];
    return el('div', { class: 'pgx-vr', 'data-version': v.version }, [
      el('span', { class: 'pgx-vr-v' + (i === 0 ? ' pgx-vr-new' : ''), text: v.version }),
      el('span', { class: 'pgx-t' }, [
        el('span', { class: 'pgx-vr-m' }, [
          v.version === latest ? pill(t('gwd.ver.latest'), 'new') : null,
          names.length ? pill(t('gwd.ver.running', { names: K.namesText(names, 3, t('gwd.ver.more_names')) }), 'good') : null,
          v.published_at ? el('small', { text: fmtDate(v.published_at) }) : null,
        ]),
        v.notes ? notesBlock(v.notes) : el('small', { text: t('gwd.ver.no_notes') }),
      ]),
    ]);
  }
  function versionsCard(list, title, id, opts) {
    const o = opts || {};
    const run = K.runningOn(ctx.gateways);
    const rows = list.map((v, i) => versionRow(v, i, run, o.latest));
    if (!rows.length) rows.push(el('p', { class: 'pgx-empty', text: o.empty || t('gwd.ver.empty') }));
    const head = el('div', { class: 'pgx-card-h' }, [h2(title, id + '-h'), o.sub ? el('span', { class: 'pgx-sec-s', text: o.sub }) : null, o.right || null]);
    return card([head].concat(rows), { 'aria-labelledby': id + '-h', id }, 'pgx-flush');
  }

  async function panelVersions(panel, refresh) {
    panel.appendChild(el('p', { class: 'pgx-loading', text: t('gwd.ver.loading') }));
    const from = cur.from;
    const q = [from ? 'from=' + encodeURIComponent(from) : null, refresh ? 'refresh=1' : null].filter(Boolean).join('&');
    const d = await getJson('/api/v1/gateways/releases' + (q ? '?' + q : ''));
    if (!panel.isConnected) return;
    rel = d;
    clear(panel);
    const url = (d && d.releases_url) || 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
    if (!d || !d.ok || !d.available) {
      panel.appendChild(card([el('p', { class: 'pgx-empty', id: 'gwd-ver-unavailable', text: t('gwd.ver.unavailable') }),
        el('p', { class: 'pgx-acts gwd-center' }, [linkBtn(t('gwd.ver.reload'), () => reload(), { id: 'gwd-ver-reload' }), ext(t('gwd.ver.github'), url)])], null, 'pgx-pad'));
      return;
    }
    if (d.stale) {
      panel.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'warn', role: 'status', id: 'gwd-ver-stale' }, [
        el('span', { class: 'pgx-grow', text: t('gwd.ver.stale', { time: fmtDateTime(d.fetched_at) }) }),
        linkBtn(t('gwd.ver.reload'), () => reload(), { id: 'gwd-ver-reload' })]));
    }
    const latest = d.latest_version || '';
    if (from) {
      const since = Array.isArray(d.since) ? d.since : [];
      const sub = latest ? t('gwd.ver.since_sub', { from, to: d.to || latest }) : null;
      panel.appendChild(versionsCard(since, t('gwd.ver.since', { from }), 'gwd-since', { sub, latest, empty: t('gwd.ver.none_since', { from }) }));
    }
    const right = el('span', { class: 'pgx-push pgx-acts' }, [
      d.stale ? null : linkBtn(t('gwd.ver.reload'), () => reload(), { class: 'pgx-a pgx-small', id: 'gwd-ver-refresh' }),
      ext(t('gwd.ver.github'), url, { class: 'pgx-a pgx-small' })]);
    panel.appendChild(versionsCard(Array.isArray(d.versions) ? d.versions : [], t('gwd.ver.all'), 'gwd-versions',
      { latest, right, sub: d.fetched_at ? t('gwd.ver.checked', { time: fmtDateTime(d.fetched_at) }) : null }));
  }
  function reload() { if (cur && cur.view === 'versions') render(true); }

  // ════════════════════════════════════════════════════════════
  // Handbuch (plugins-page.js panelHandbook)
  // ════════════════════════════════════════════════════════════
  const HB_SLUG = K.SLUG_RE;
  const HB_TAGS = new Set(['h2', 'h3', 'h4', 'h5', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'a', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div']);

  function hbJump(anchor, smooth) {
    const target = anchor && HB_SLUG.test(anchor) ? document.getElementById('hb-' + anchor) : null;
    if (!target) return false;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    try { target.focus({ preventScroll: true }); } catch (_) { /* old browser */ }
    return true;
  }
  function hbLink(anchor, kids, cls) {
    return el('a', { href: K.handbookHash(anchor), class: cls || null, 'data-hb-anchor': anchor, on: { click: (e) => {
      e.preventDefault();
      // the address without a hashchange: the page's router keeps the view
      try { history.replaceState(null, '', location.pathname + location.search + K.handbookHash(anchor)); } catch (_) { /* ignore */ }
      if (cur) cur.target = anchor;
      hbJump(anchor, true);
    } } }, kids);
  }
  function hbClean(from, into) {
    Array.prototype.forEach.call(from.childNodes, (n) => {
      if (n.nodeType === 3) { into.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (!HB_TAGS.has(tag)) { hbClean(n, into); return; }
      let e;
      if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        const anchor = n.getAttribute('data-hb-anchor') || '';
        if (HB_SLUG.test(anchor) && href === '#' + anchor) e = hbLink(anchor, []);
        else if (/^https:\/\/[^\s]+$/i.test(href)) e = el('a', { href, target: '_blank', rel: 'noopener noreferrer' });
        else { hbClean(n, into); return; }
      } else e = document.createElement(tag);
      const id = n.getAttribute('id');
      if (id && /^hb-[a-z0-9][a-z0-9-]{0,99}$/.test(id)) e.id = id;
      const cls = n.getAttribute('class');
      if (cls && /^hb-[a-z-]{1,20}$/.test(cls)) e.className = cls;
      const tone = n.getAttribute('data-tone');
      if (tag === 'blockquote' && (tone === 'info' || tone === 'warn')) e.setAttribute('data-tone', tone);
      const start = n.getAttribute('start');
      if (tag === 'ol' && start && /^\d{1,9}$/.test(start)) e.setAttribute('start', start);
      hbClean(n, e);
      into.appendChild(e);
    });
  }

  async function panelHandbook(panel) {
    panel.appendChild(el('p', { class: 'pgx-loading', text: t('gwd.hb.loading') }));
    let d = hb && hb.lang === lang ? hb.data : null;
    if (!d) {
      d = await getJson('/api/v1/gateways/handbook?lang=' + lang);
      if (d && d.ok) hb = { lang, data: d };
    }
    if (!panel.isConnected) return;
    clear(panel);
    const fallback = window.GCHandbook ? window.GCHandbook.url('index', lang) : null;
    if (!d || !d.ok) {
      panel.appendChild(card([el('p', { class: 'pgx-empty', id: 'gwd-hb-error', text: (d && d.error) || t('gwd.hb.missing') }),
        fallback ? el('p', { class: 'pgx-acts gwd-center' }, [ext(t('gwd.hb.github'), fallback)]) : null], null, 'pgx-pad'));
      return;
    }
    const doc = el('article', { class: 'pgx-hb-doc', id: 'gwd-hb-doc', lang: d.lang === 'en' ? 'en' : 'de' });
    hbClean(new DOMParser().parseFromString(String(d.html || ''), 'text/html').body, doc);
    const src = typeof d.source_url === 'string' && /^https:\/\/github\.com\//.test(d.source_url) ? d.source_url : fallback;
    const head = el('div', { class: 'pgx-hb-meta' }, [lbl(t('gwd.hb.title'), { id: 'gwd-hb-h' }),
      el('span', { class: 'pgx-acts' }, [src ? ext(t('gwd.hb.github'), src, { class: 'pgx-a pgx-small', id: 'gwd-hb-ext' }) : null,
        d.version ? el('span', { class: 'pgx-mono pgx-muted', text: 'v' + d.version }) : null])]);
    const toc = Array.isArray(d.toc) ? d.toc.filter((x) => x && HB_SLUG.test(x.anchor || '')) : [];
    const nav = toc.length > 1 ? el('details', { class: 'pgx-card pgx-hb-toc', id: 'gwd-hb-toc', open: window.matchMedia && window.matchMedia('(min-width: 900px)').matches ? true : null }, [
      el('summary', { class: 'pgx-lbl', text: t('gwd.hb.toc') }),
      el('nav', { 'aria-label': t('gwd.hb.toc') }, [el('ol', { class: 'pgx-hb-tl' }, toc.map((x) => el('li', { 'data-level': String(Math.min(3, Math.max(1, x.level | 0))) },
        [hbLink(x.anchor, [String(x.text || '')])])))]),
    ]) : null;
    panel.appendChild(el('div', { class: 'pgx-hb' + (nav ? '' : ' pgx-hb-solo') }, [nav, card([head, doc], { 'aria-labelledby': 'gwd-hb-h' }, 'pgx-pad pgx-hb-card')]));
    // a topic of a help link → its heading; the address then names the heading
    const want = K.resolve(cur.target, d.anchors, lang);
    if (cur.target && want && want !== cur.target) {
      cur.target = want;
      try { history.replaceState(null, '', location.pathname + location.search + K.handbookHash(want)); } catch (_) { /* ignore */ }
    }
    if (want) setTimeout(() => hbJump(want, false), 0);
    else window.scrollTo(0, 0);
  }

  // ════════════════════════════════════════════════════════════
  // The view: crumb, tabs "Versionen" | "Handbuch", the panel
  // ════════════════════════════════════════════════════════════
  function setTab(view) {
    if (!cur || cur.view === view) return;
    const next = view === 'versions' ? { view, from: cur.lastFrom || null } : { view, target: null };
    next.lastFrom = cur.view === 'versions' ? cur.from : cur.lastFrom;
    cur = next;
    try { history.replaceState(null, '', location.pathname + location.search + (view === 'versions' ? K.versionsHash(cur.from) : K.handbookHash(null))); } catch (_) { /* ignore */ }
    render(false);
    const tb = document.getElementById('gwd-tab-' + view);
    if (tb) tb.focus();
  }

  function render(refresh) {
    if (!host || !cur) return;
    clear(host);
    const view = el('div', { class: 'pgx-view' });
    const back = ctx.back || '';
    view.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('gwd.path') }, [
      el('a', { href: back || '#', 'data-act': 'docs-back', text: t('gwd.crumb') }),
      el('span', { 'aria-hidden': 'true', text: '›' }),
      el('span', { 'aria-current': 'page', text: cur.view === 'versions' ? t('gwd.btn.versions') : t('gwd.btn.handbook') })]));
    const tl = el('div', { class: 'pgx-tabs', role: 'tablist', 'aria-label': t('gwd.tabs') });
    [['versions', t('gwd.btn.versions')], ['handbook', t('gwd.btn.handbook')]].forEach((x) => {
      tl.appendChild(el('button', { type: 'button', class: 'pgx-tab', role: 'tab', id: 'gwd-tab-' + x[0], 'aria-selected': String(cur.view === x[0]), 'aria-controls': 'gwd-panel',
        'data-tab': x[0], on: { click: () => setTab(x[0]) } }, [x[1]]));
    });
    view.appendChild(tl);
    const panel = el('div', { class: 'pgx-panel' + (cur.view === 'handbook' ? ' pgx-hb-panel' : ''), id: 'gwd-panel', role: 'tabpanel', 'aria-labelledby': 'gwd-tab-' + cur.view });
    view.appendChild(panel);
    host.appendChild(view);
    if (cur.view === 'versions') panelVersions(panel, refresh);
    else panelHandbook(panel);
  }

  /**
   * Show #versions… / #handbook… in `container`.
   * @param {HTMLElement} container
   * @param {{view:string, from?:string, target?:string}} route  K.parseHash
   * @param {{gateways?:object[], latest?:string, back?:string}} c  the fleet, the address of "Gateways"
   */
  function show(container, route, c) {
    ctx = Object.assign({ gateways: [], latest: '', back: '' }, c || {});
    const same = cur && host === container && container.isConnected && container.firstChild
      && cur.view === route.view && (route.view === 'versions' ? cur.from === route.from : true);
    host = container;
    if (same) {
      // only the heading changed (back/forward): jump there
      if (route.view === 'handbook' && route.target && hb) {
        const a = K.resolve(route.target, hb.data.anchors, lang);
        cur.target = a || route.target;
        if (a && a !== route.target) {
          try { history.replaceState(null, '', location.pathname + location.search + K.handbookHash(a)); } catch (_) { /* ignore */ }
        }
        hbJump(cur.target, true);
      }
      return;
    }
    cur = { view: route.view, from: route.from || null, target: route.target || null, lastFrom: route.view === 'versions' ? route.from : (cur && cur.lastFrom) || null };
    render(false);
    if (route.view === 'versions') window.scrollTo(0, 0);
  }
  /** New data of the fleet (the poll): the pills "Läuft auf …" of the version list. */
  function update(c) {
    ctx = Object.assign(ctx, c || {});
    if (!host || !cur || cur.view !== 'versions' || !rel || !rel.ok) return;
    const run = K.runningOn(ctx.gateways);
    Array.prototype.forEach.call(host.querySelectorAll('.pgx-vr[data-version]'), (row) => {
      const v = row.getAttribute('data-version');
      const m = row.querySelector('.pgx-vr-m');
      if (!m) return;
      const old = m.querySelector('.pgx-pill[data-tone="good"]');
      const names = run[v] || [];
      const next = names.length ? pill(t('gwd.ver.running', { names: K.namesText(names, 3, t('gwd.ver.more_names')) }), 'good') : null;
      if (old && next) { if (old.textContent !== next.textContent) old.replaceWith(next); } else if (old) old.remove();
      else if (next) m.insertBefore(next, m.querySelector('small'));
    });
  }
  function hide() { cur = null; if (host) clear(host); }

  // the help links of the page (public/js/handbook.js): into the in-app handbook; in the
  // assistant (a dialog with its progress) in a new tab, so the assistant stays open
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest('a[data-guide]') : null;
    if (!a) return;
    const topic = a.getAttribute('data-guide') || '';
    if (!K.isTopic(topic)) return;
    e.preventDefault();
    const hash = K.handbookHash(topic);
    if (a.closest('#gwz-overlay, .modal-overlay, .gcd-dialog')) window.open(location.pathname + hash, '_blank', 'noopener');
    else location.hash = hash;
  });

  window.GCGatewayDocs = { show, update, hide, parseHash: K.parseHash, versionsHash: K.versionsHash, handbookHash: K.handbookHash };
})();
