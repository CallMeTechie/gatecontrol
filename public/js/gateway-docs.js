// "Versionen" and "Handbuch" of a gateway (#gw/<id>/versions, #gw/<id>/handbook)
// — the same building blocks as Einstellungen › Plugins › <plugin> (tabs
// "Versionen" and "Handbuch", the pgx-* classes of app.css): the release notes
// of every gateway version with the installed one marked and the newer ones
// flagged (GET /api/v1/gateways/releases: the notes as lines of
// GCPluginsUI.noteLines, made on the server, rendered here as text) and the gateway chapters of the user guide
// (GET /api/v1/gateways/handbook, rendered on the server by the safe Markdown
// renderer of the plugin handbooks and rebuilt here from a whitelist).
// gateways.js routes to it (GCGatewayDocs.show) from the "Mehr" menu of the
// gateway, "Was ist neu?" of its state and the "too old" notes of its tabs.
(function () {
  'use strict';
  const K = window.GCGatewayDocsKit;
  const D = window.GCDialog;
  if (!K || !D) return;
  const el = D.el;
  const lang = (window.GC && window.GC.language) === 'en' ? 'en' : 'de';
  const RELEASES = 'https://github.com/CallMeTechie/gatecontrol-gateway/releases';
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
    const d = new Date(iso || '');
    if (!iso || Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
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

  /** Release notes as a list (plugins-page.js notesBlock: the lines of GCPluginsUI.noteLines, text only). */
  function notesBlock(v) {
    const lines = Array.isArray(v.lines) ? v.lines.filter((x) => x && typeof x.text === 'string')
      : String(v.notes || '').split('\n').filter((x) => x.trim()).map((x) => ({ kind: 'p', level: 0, text: x.trim() }));
    const box = el('div', { class: 'pgx-notes' });
    let list = null;
    lines.forEach((ln) => {
      if (ln.kind === 'li') {
        if (!list) { list = el('ul'); box.appendChild(list); }
        list.appendChild(el('li', { 'data-level': String(Math.min(2, Math.max(0, ln.level | 0))), text: ln.text }));
      } else { list = null; box.appendChild(el('p', { text: ln.text })); }
    });
    if (!lines.length) box.appendChild(el('p', { class: 'pgx-muted', text: t('gwd.ver.no_notes') }));
    return box;
  }

  // ── state ──
  let gw = null;           // the gateway (a row of GET /api/v1/gateways)
  let latest = '';         // the newest gateway version the server knows
  let cur = null;          // { id, view, target }
  let host = null;         // the view's element (#gw-docs-view)
  let rel = null;          // the last answer of /releases
  let hb = null;           // { lang, data }
  let olderOpen = false;   // "Ältere anzeigen" of "Alle Versionen" is open (kept across the poll, closed for another gateway)

  function installedOf(g) { return K.cleanVersion(g && g.health && g.health.telemetry ? g.health.telemetry.gateway_version : null); }

  // ════════════════════════════════════════════════════════════
  // Versionen (plugins-page.js versionsCard)
  // ════════════════════════════════════════════════════════════
  function versionRow(v, installed, newest) {
    const st = K.stateOf(v.version, installed);
    return el('div', { class: 'pgx-vr', 'data-version': v.version, 'data-state': st }, [
      el('span', { class: 'pgx-vr-v' + (st === 'newer' || (st === 'unknown' && v.version === newest) ? ' pgx-vr-new' : ''), text: v.version }),
      el('span', { class: 'pgx-t' }, [
        el('span', { class: 'pgx-vr-m' }, [
          st === 'installed' ? pill(t('gwd.ver.installed'), 'good') : null,
          st === 'newer' ? pill(t('gwd.ver.newer'), 'new') : null,
          v.version === newest && st !== 'installed' ? pill(t('gwd.ver.latest'), 'info') : null,
          v.published_at ? el('small', { text: fmtDate(v.published_at) }) : null,
        ]),
        v.notes ? notesBlock(v) : el('small', { text: t('gwd.ver.no_notes') }),
      ]),
    ]);
  }

  function versionsBody(panel, d) {
    clear(panel);
    const url = (d && typeof d.releases_url === 'string' && d.releases_url.indexOf(RELEASES) === 0) ? d.releases_url : RELEASES;
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
    const versions = Array.isArray(d.versions) ? d.versions : [];
    const installed = installedOf(gw);
    const newest = K.cleanVersion(latest) || K.cleanVersion(d.latest_version) || (versions[0] ? versions[0].version : '');
    const s = K.summary(versions, installed);
    if (s.newer) {
      panel.appendChild(el('div', { class: 'pgx-banner', 'data-tone': 'info', role: 'status', id: 'gwd-ver-newer' }, [
        el('span', { class: 'pgx-grow' }, [el('b', { text: t('gwd.ver.update', { version: newest }) }), ' ',
          el('span', { class: 'pgx-muted', text: t(s.newer === 1 ? 'gwd.ver.newer_one' : 'gwd.ver.newer_n', { n: s.newer, installed: s.installed }) })])]));
    }
    // the newest ones (and everything down to the installed one); the rest behind "Ältere anzeigen"
    const first = K.visibleCount(versions, installed);
    const rows = versions.slice(0, first).map((v) => versionRow(v, installed, newest));
    if (!rows.length) rows.push(el('p', { class: 'pgx-empty', text: t('gwd.ver.empty') }));
    if (versions.length > first) {
      const rest = versions.length - first;
      const older = el('div', { id: 'gwd-ver-older', hidden: !olderOpen }, versions.slice(first).map((v) => versionRow(v, installed, newest)));
      const label = () => t(olderOpen ? 'gwd.ver.older_hide' : 'gwd.ver.older_show', { n: rest });
      const btn = linkBtn(label(), () => {
        olderOpen = !olderOpen;
        older.hidden = !olderOpen;
        btn.textContent = label();
        btn.setAttribute('aria-expanded', String(olderOpen));
        // opened: on to the first of the older ones (keyboard and screen reader land where the new rows start)
        if (olderOpen && older.firstChild) { older.firstChild.setAttribute('tabindex', '-1'); try { older.firstChild.focus({ preventScroll: true }); } catch (_) { /* old browser */ } }
      }, { id: 'gwd-ver-older-btn', 'aria-expanded': String(olderOpen), 'aria-controls': 'gwd-ver-older' });
      rows.push(older, el('p', { class: 'pgx-acts gwd-older' }, [btn]));
    }
    // the installed version is older than the list (or the gateway reports none)
    let note = null;
    if (!installed) note = t('gwd.ver.unknown');
    else if (!s.listed && versions.length && K.compare(installed, versions[versions.length - 1].version) < 0) note = t('gwd.ver.older_than_list', { version: installed });
    if (note) rows.push(el('p', { class: 'pgx-empty', id: 'gwd-ver-note', text: note }));
    const sub = d.fetched_at ? t('gwd.ver.checked', { time: fmtDateTime(d.fetched_at) }) : null;
    const right = el('span', { class: 'pgx-push pgx-acts' }, [
      d.stale ? null : linkBtn(t('gwd.ver.reload'), () => reload(), { class: 'pgx-a pgx-small', id: 'gwd-ver-refresh' }),
      ext(t('gwd.ver.github'), url, { class: 'pgx-a pgx-small' })]);
    const head = el('div', { class: 'pgx-card-h' }, [h2(t('gwd.ver.all'), 'gwd-versions-h'), sub ? el('span', { class: 'pgx-sec-s', text: sub }) : null, right]);
    panel.appendChild(card([head].concat(rows), { 'aria-labelledby': 'gwd-versions-h', id: 'gwd-versions' }, 'pgx-flush'));
  }

  async function panelVersions(panel, refresh) {
    panel.appendChild(el('p', { class: 'pgx-loading', text: t('gwd.ver.loading') }));
    const d = await getJson('/api/v1/gateways/releases' + (refresh ? '?refresh=1' : ''));
    if (!panel.isConnected) return;
    rel = d;
    versionsBody(panel, d);
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
    return el('a', { href: K.handbookHash(cur.id, anchor), class: cls || null, 'data-hb-anchor': anchor, on: { click: (e) => {
      e.preventDefault();
      // the address without a hashchange: the page's router keeps the view
      try { history.replaceState(null, '', location.pathname + location.search + K.handbookHash(cur.id, anchor)); } catch (_) { /* ignore */ }
      cur.target = anchor;
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
    if (cur.target) setTimeout(() => { if (!hbJump(cur.target, false)) window.scrollTo(0, 0); }, 0);
    else window.scrollTo(0, 0);
  }

  // ════════════════════════════════════════════════════════════
  // The view: crumb, head, tabs "Versionen" | "Handbuch", the panel
  // ════════════════════════════════════════════════════════════
  function setTab(view) {
    if (!cur || cur.view === view) return;
    cur = { id: cur.id, view, target: null };
    try { history.replaceState(null, '', location.pathname + location.search + (view === 'versions' ? K.versionsHash(cur.id) : K.handbookHash(cur.id))); } catch (_) { /* ignore */ }
    render(false);
    const tb = document.getElementById('gwd-tab-' + view);
    if (tb) tb.focus();
  }

  function headSub() {
    const installed = installedOf(gw);
    const newest = K.cleanVersion(latest);
    const parts = [installed ? t('gwd.head.installed', { version: installed }) : t('gwd.head.no_version')];
    if (newest && installed && K.compare(newest, installed) > 0) parts.push(t('gwd.head.update', { version: newest }));
    else if (newest && installed) parts.push(t('gwd.head.current'));
    return parts.join(' · ');
  }

  function render(refresh) {
    if (!host || !cur) return;
    clear(host);
    const view = el('div', { class: 'pgx-view' });
    const back = '#gw/' + encodeURIComponent(cur.id);
    const name = gw && gw.name ? String(gw.name) : cur.id;
    view.appendChild(el('nav', { class: 'pgx-crumb', 'aria-label': t('gwd.path') }, [
      el('a', { href: '#', 'data-act': 'docs-fleet', text: t('gwd.crumb') }),
      el('span', { 'aria-hidden': 'true', text: '›' }),
      el('a', { href: back, 'data-act': 'docs-back', id: 'gwd-back', text: name }),
      el('span', { 'aria-hidden': 'true', text: '›' }),
      el('span', { 'aria-current': 'page', text: cur.view === 'versions' ? t('gwd.btn.versions') : t('gwd.btn.handbook') })]));
    view.appendChild(el('div', { class: 'pgx-ph' }, [el('div', { class: 'pgx-ph-t' }, [
      el('h2', { class: 'pgx-h1', id: 'gwd-title', text: name }),
      el('p', { class: 'pgx-sub', id: 'gwd-sub', text: headSub() })])]));
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
   * Show #gw/<id>/versions or #gw/<id>/handbook[/<anchor>] in `container`.
   * @param {HTMLElement} container
   * @param {{id:string, view:string, target?:string}} route  K.parseHash
   * @param {{gateway:object, latest?:string}} c  the gateway (GET /api/v1/gateways) and the newest version
   */
  function show(container, route, c) {
    gw = (c && c.gateway) || null;
    latest = (c && c.latest) || '';
    const same = cur && host === container && container.isConnected && container.firstChild && cur.id === route.id && cur.view === route.view;
    host = container;
    if (same) {
      // only the heading changed (back/forward): jump there
      if (route.view === 'handbook' && route.target) { cur.target = route.target; hbJump(route.target, true); }
      return;
    }
    if (!cur || cur.id !== route.id) olderOpen = false;
    cur = { id: route.id, view: route.view, target: route.target || null };
    render(false);
    if (route.view === 'versions') window.scrollTo(0, 0);
  }

  /** New data of the fleet (the poll): the head and, when the version changed, the marks of the list. */
  function update(c) {
    if (!host || !cur) return;
    const before = installedOf(gw) + '|' + latest;
    gw = (c && c.gateway) || gw;
    latest = (c && c.latest) || latest;
    const sub = document.getElementById('gwd-sub');
    if (sub) sub.textContent = headSub();
    if (before === installedOf(gw) + '|' + latest || cur.view !== 'versions' || !rel) return;
    const panel = document.getElementById('gwd-panel');
    if (panel && !panel.querySelector('.pgx-loading')) versionsBody(panel, rel);
  }
  function hide() { cur = null; olderOpen = false; if (host) clear(host); }

  /** The address of "Versionen" of a gateway — for "Was ist neu?" of the other tabs. */
  function versionsHref(g) { return g && g.peer_id != null ? K.versionsHash(g.peer_id) : RELEASES; }

  window.GCGatewayDocs = { show, update, hide, parseHash: K.parseHash, versionsHash: K.versionsHash, handbookHash: K.handbookHash, versionsHref };
})();
