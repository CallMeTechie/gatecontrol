'use strict';

// Domain modal of the zones page (host cards, "variant B") plus the small UI
// kit both zones scripts share (window.GCZonesUI). Loaded after
// zones-view.js and before zones-page.js. DOM is built with el() only —
// innerHTML is blocked by a hook (see routes.js el()). Every action saves
// immediately; after each mutation the page re-fetches GET /api/v1/zones and
// calls GCDomainModal.refresh(). Contract: docs/feature-domain-zones.md.
(function () {
  const V = window.GCZonesView;
  const GC = window.GC = window.GC || {};
  GC.t = GC.t || {};
  GC.features = GC.features || {};

  // Page strings arrive as a JSON island (zones.njk) instead of the layout's
  // global GC.t whitelist, so the layouts stay untouched.
  try {
    const island = document.getElementById('zones-i18n');
    if (island) Object.assign(GC.t, JSON.parse(island.textContent || '{}'));
  } catch (_) { /* keep whatever GC.t has */ }

  // ─── UI kit ────────────────────────────────────────────────────────────
  function t(key, params) {
    let s = (GC.t && GC.t[key]) || key;
    if (params) {
      Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    }
    return s;
  }

  const PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, placeholder: 1, maxLength: 1, htmlFor: 1, tabIndex: 1, href: 1, target: 1, rel: 1, name: 1 };
  function el(tag, props, children) {
    const node = document.createElement(tag);
    const p = props || {};
    if (p.type != null) node.type = p.type;
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (k === 'type' || v == null) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
      else if (k === 'style') node.setAttribute('style', v);
      else if (k === 'on') Object.keys(v).forEach((ev) => node.addEventListener(ev, v[ev]));
      else if (PROPS[k]) node[k] = v;
      else if (v === false) return;
      else node.setAttribute(k, v === true ? '' : v);
    });
    append(node, children);
    return node;
  }
  function append(node, children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) append(node, c);
      else node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
    plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    down: [['polyline', { points: '6 9 12 15 18 9' }]],
    pencil: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z' }]],
    ext: [['path', { d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
    trash: [['polyline', { points: '3 6 5 6 21 6' }], ['path', { d: 'M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6' }], ['path', { d: 'M10 11v6M14 11v6' }], ['path', { d: 'M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2' }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    printer: [['polyline', { points: '6 9 6 2 18 2 18 9' }], ['path', { d: 'M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2' }], ['rect', { x: 6, y: 14, width: 12, height: 8 }]],
    gateway: [['rect', { x: 2, y: 2, width: 20, height: 8, rx: 2 }], ['rect', { x: 2, y: 14, width: 20, height: 8, rx: 2 }], ['line', { x1: 6, y1: 6, x2: 6.01, y2: 6 }], ['line', { x1: 6, y1: 18, x2: 6.01, y2: 18 }]],
    pool: [['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }], ['path', { d: 'M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12' }], ['path', { d: 'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' }]],
    peer: [['circle', { cx: 17, cy: 7, r: 3 }], ['circle', { cx: 7, cy: 17, r: 3 }], ['path', { d: 'M14 10l-4 4' }], ['circle', { cx: 7, cy: 7, r: 3 }], ['circle', { cx: 17, cy: 17, r: 3 }]],
    more: [['circle', { cx: 12, cy: 5, r: 1.5 }], ['circle', { cx: 12, cy: 12, r: 1.5 }], ['circle', { cx: 12, cy: 19, r: 1.5 }]],
    tpl: [['path', { d: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z' }], ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }], ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }]],
    rdp: [['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }], ['line', { x1: 8, y1: 21, x2: 16, y2: 21 }], ['line', { x1: 12, y1: 17, x2: 12, y2: 21 }]],
    folder: [['path', { d: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' }]],
    refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 11-2.12-9.36L23 10' }]],
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' }]],
  };
  function icon(name, size) {
    const svg = document.createElementNS(SVGNS, 'svg');
    const s = String(size || 14);
    [['viewBox', '0 0 24 24'], ['width', s], ['height', s], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true'],
      ['class', 'zn-ic']].forEach((a) => svg.setAttribute(a[0], a[1]));
    (ICONS[name] || []).forEach((spec) => {
      const n = document.createElementNS(SVGNS, spec[0]);
      Object.keys(spec[1]).forEach((k) => n.setAttribute(k, String(spec[1][k])));
      svg.appendChild(n);
    });
    return svg;
  }

  // api.post/put resolve {ok:false,…} for 400/403/429 and throw otherwise;
  // call() turns both into a thrown Error carrying the body in err.data.
  async function call(promise) {
    const res = await promise;
    if (res && res.ok === false) {
      const e = new Error(res.error || t('zones.error_generic'));
      e.data = res;
      throw e;
    }
    return res || {};
  }
  function errMsg(err) { return (err && err.message) || t('zones.error_generic'); }
  function toastOk(msg) { if (window.showToast) window.showToast(msg, 'success'); }
  function toastError(err) {
    const msg = typeof err === 'string' ? err : errMsg(err);
    if (window.showToast) window.showToast(msg, 'error');
    else console.error(msg);
  }
  function portConflict(err) {
    const d = err && err.data;
    return d && d.code === 'BUNDLE_PORT_CONFLICT' && d.conflict ? d.conflict : null;
  }

  function fmtTime(d) {
    if (!d) return '—';
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function busy(btn, on) {
    if (!btn) return;
    if (btn.tagName === 'BUTTON' && window.btnLoading) {
      if (on) window.btnLoading(btn); else window.btnReset(btn);
    } else {
      btn.classList.toggle('zn-busy', !!on);
    }
  }

  // ── Small building blocks shared by page + modal ──
  const PROTO_CLASS = { HTTPS: 'zn-proto-https', HTTP: 'zn-proto-http', TCP: 'zn-proto-tcp', UDP: 'zn-proto-udp' };
  function chipEl(entry) {
    const c = V.entryChip(entry);
    return el('span', { class: 'zn-chip' + (entry.enabled ? '' : ' off'), title: entry.description || null }, [
      el('span', { class: 'zn-proto ' + PROTO_CLASS[c.proto], text: c.proto }),
      c.out ? el('span', { class: 'zn-chip-port', text: c.out }) : null,
      c.out ? el('span', { class: 'zn-arrow', text: '→' }) : null,
      c.out ? el('span', { class: 'zn-chip-port', text: c.in }) : null,
      c.note ? el('span', { class: 'zn-chip-note', text: '· ' + c.note }) : null,
    ]);
  }
  function tag(kind, text, dot, extraClass) {
    return el('span', { class: 'tag tag-' + kind + (extraClass ? ' ' + extraClass : '') }, [
      dot ? el('span', { class: 'tag-dot' }) : null, text,
    ]);
  }
  function accessTag(access) {
    return access === 'external'
      ? tag('green', t('host.access_external'), true, 'zn-access')
      : tag('grey', t('host.access_internal'), true, 'zn-access');
  }
  function verificationTag(zone) {
    const v = zone && zone.verification;
    if (v === 'verified') return tag('green', t('zones.dns_verified'), false, 'zn-dns');
    if (v === 'failed') return tag('red', t('zones.dns_failed'), false, 'zn-dns');
    if (v) return tag('amber', t('zones.dns_pending'), false, 'zn-dns');
    return null;
  }
  function healthDot(health) {
    return el('span', { class: 'zn-dot zn-dot-' + (health || 'ok'), 'aria-hidden': 'true' });
  }
  function hostStatusText(host, zone) {
    const h = V.hostHealth(host);
    if (h === 'disabled') return t('host.status_disabled');
    const gwOffline = zone && zone.gateway && zone.gateway.online === false && !host.gateway_override;
    if ((h === 'down' || h === 'degraded') && gwOffline) return t('host.status_gateway_offline');
    if (h === 'down') return t('host.status_down');
    if (h === 'degraded') return t('host.status_degraded');
    return t('host.status_ok');
  }
  function gatewayIconName(kind) { return kind === 'pool' ? 'pool' : kind === 'peer' ? 'peer' : 'gateway'; }
  function gatewayLabel(g) {
    if (!g || !g.kind) return t('zones.gateway_none');
    if (g.kind === 'pool') return t('zones.gateway_pool', { name: g.name || ('#' + g.pool_id) });
    return g.name || g.ip || ('#' + g.peer_id);
  }
  function toggleEl(on, label, onToggle) {
    const node = el('div', {
      class: 'toggle zn-toggle' + (on ? ' on' : ''), role: 'switch', tabindex: '0',
      'aria-checked': on ? 'true' : 'false', 'aria-label': label, title: label, 'data-managed': '1',
    });
    const fire = (e) => { e.stopPropagation(); if (!node.classList.contains('zn-busy')) onToggle(node); };
    node.addEventListener('click', fire);
    node.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(e); } });
    return node;
  }
  function ibtn(iconName, label, onClick, extraClass) {
    return el('button', {
      type: 'button', class: 'zn-ibtn' + (extraClass ? ' ' + extraClass : ''), title: label, 'aria-label': label,
      on: { click: (e) => { e.stopPropagation(); onClick(e.currentTarget, e); } },
    }, [icon(iconName, 13)]);
  }

  // ── Popup menu (one at a time, fixed-positioned so modal scroll never clips it) ──
  let menuState = null;
  const menuCloseHooks = [];
  function closeMenu() {
    if (!menuState) return;
    const m = menuState;
    menuState = null;
    m.node.remove();
    document.removeEventListener('mousedown', m.outside, true);
    document.removeEventListener('keydown', m.key, true);
    window.removeEventListener('resize', closeMenu);
    document.removeEventListener('scroll', m.scroll, true);
    if (m.anchor) m.anchor.setAttribute('aria-expanded', 'false');
    menuCloseHooks.slice().forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
  }
  function menuOpen() { return !!menuState; }
  function onMenuClosed(fn) { menuCloseHooks.push(fn); }
  function openMenu(anchor, items) {
    const same = menuState && menuState.anchor === anchor;
    closeMenu();
    if (same) return;
    const node = el('div', { class: 'zn-menu', role: 'menu' }, items.filter(Boolean).map((it) => {
      if (it === '-') return el('div', { class: 'zn-menu-sep', role: 'separator' });
      return el('button', {
        type: 'button', role: 'menuitem', class: 'zn-menu-item' + (it.danger ? ' danger' : ''), disabled: !!it.disabled,
        title: it.hint || null,
        on: { click: (e) => { e.stopPropagation(); closeMenu(); it.onClick(); } },
      }, [it.icon ? icon(it.icon, 13) : null, el('span', { text: it.label }), it.sub ? el('span', { class: 'zn-menu-sub', text: it.sub }) : null]);
    }));
    document.body.appendChild(node);
    const r = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    if (left < 8) left = 8;
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    const m = {
      node, anchor,
      outside: (e) => { if (!node.contains(e.target) && !anchor.contains(e.target)) closeMenu(); },
      key: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } },
      scroll: (e) => { if (!node.contains(e.target)) closeMenu(); },
    };
    menuState = m;
    document.addEventListener('mousedown', m.outside, true);
    document.addEventListener('keydown', m.key, true);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', m.scroll, true);
    const first = node.querySelector('.zn-menu-item:not([disabled])');
    if (first) first.focus();
  }

  // ── Dialogs (own overlays above the domain modal; independent of the
  // shared #modal-confirm, whose button the entry editor wires) ──
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot' });
    const titleId = 'zn-dlg-' + Math.random().toString(36).slice(2, 8);
    const box = el('div', { class: 'modal zn-dialog-box' + (opts.wide ? ' zn-dialog-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { class: 'modal-head' }, [el('span', { class: 'modal-title', id: titleId, text: opts.title || '' }), closeBtn]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay zn-dialog', style: 'display:flex' }, [box]);
    const prevFocus = document.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
      resolveFn(result);
    }
    // Capture phase so app.js's global Escape (which hides every overlay,
    // incl. the domain modal) never sees it while a dialog is on top.
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && opts.onEnter && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); opts.onEnter(); }
    }
    closeBtn.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    return { overlay, body, foot, close, promise };
  }

  function confirmDialog(o) {
    const d = dialog({ title: o.title || t('common.confirm') });
    d.body.appendChild(el('p', { class: 'zn-dialog-msg', text: o.message }));
    if (o.detail) d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: o.detail }));
    const ok = el('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okLabel || t('common.confirm'), on: { click: () => d.close(true) } });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(false) } }));
    d.foot.appendChild(ok);
    ok.focus();
    return d.promise.then((r) => r === true);
  }

  // → Promise<string|null>. validate(value) returns an error text or null.
  function promptDialog(o) {
    let submit;
    const d = dialog({ title: o.title, onEnter: () => submit() });
    const input = el('input', { type: 'text', class: 'form-input zn-input', value: o.value || '', placeholder: o.placeholder || '', 'aria-label': o.label, maxLength: o.maxLength || 253 });
    const err = el('div', { class: 'zn-field-error', role: 'alert' });
    err.hidden = true;
    const field = o.suffix
      ? el('div', { class: 'zn-affix' }, [input, el('span', { class: 'zn-affix-sfx', text: o.suffix })])
      : input;
    d.body.appendChild(el('label', { class: 'form-label', text: o.label }));
    d.body.appendChild(field);
    if (o.hint) d.body.appendChild(el('span', { class: 'form-hint', text: o.hint }));
    d.body.appendChild(err);
    submit = () => {
      const v = input.value.trim();
      const bad = o.validate ? o.validate(v) : null;
      if (bad) { err.textContent = bad; err.hidden = false; input.focus(); return; }
      d.close(v);
    };
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-primary', text: o.okLabel || t('common.save'), on: { click: () => submit() } }));
    input.focus();
    input.select();
    return d.promise.then((r) => (typeof r === 'string' ? r : null));
  }

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  window.GCZonesUI = {
    t, el, append, icon, call, errMsg, toastOk, toastError, portConflict, fmtTime, busy,
    chipEl, tag, accessTag, verificationTag, healthDot, hostStatusText, gatewayIconName, gatewayLabel,
    toggleEl, ibtn, openMenu, closeMenu, menuOpen, onMenuClosed, dialog, confirm: confirmDialog, prompt: promptDialog,
    lsGet, lsSet,
  };

  // ─── Domain modal ──────────────────────────────────────────────────────
  const overlay = document.getElementById('zn-domain-modal');
  if (!overlay || !V) return;
  const $ = (id) => document.getElementById(id);
  const bodyEl = $('zn-dm-body');
  const titleEl = $('zn-dm-title');
  const domainEl = $('zn-dm-domain');
  const tagsEl = $('zn-dm-tags');
  const countsEl = $('zn-dm-counts');
  const syncEl = $('zn-dm-sync');

  let ctx = { getData: () => null, reload: () => Promise.resolve(), lastSync: () => null };
  let current = null;          // { domainId } — null domainId = "Ohne Domain"
  let ui = null;               // transient view state (drafts, open forms, filter)
  let pendingRefresh = false;
  let templatesCache = null;
  let peersCache = null;

  function freshUi() {
    return {
      q: '',
      add: {},                 // hostId → { type, target, listen, bhttps, conflict }
      nh: { sub: '', desc: '', lan: '', type: 'http', target: '', listen: '', bhttps: false, template: null, conflict: null, error: null },
    };
  }

  function isOpen() { return overlay.style.display === 'flex'; }

  function zoneFromData() {
    const data = ctx.getData();
    if (!data || !current) return null;
    if (current.domainId == null) return V.buildUnassignedZone(data.unassigned || []);
    const z = (data.zones || []).find((x) => x.domain_id === current.domainId);
    return z ? Object.assign({}, z, { hosts: V.sortHosts(z.hosts) }) : null;
  }

  function fqdnOf(host, zone) {
    if (host.fqdn) return host.fqdn;
    if (zone && zone.domain) return V.previewFqdn(host.subdomain, zone.domain);
    return host.name || '';
  }

  function peerKind(zone) { return !!zone && !!zone.gateway && zone.gateway.kind === 'peer'; }

  async function afterMutation() {
    try { await ctx.reload(); } catch (err) { toastError(err); }
  }

  // ── Render ──
  function render(opts) {
    const zone = zoneFromData();
    if (!zone) {
      if (current && current.domainId != null && ctx.getData()) {
        close();
        toastError(t('zones.domain_gone'));
      }
      return;
    }
    // Preserve scroll position + focused input (incl. caret) across rebuilds.
    const scroll = bodyEl.scrollTop;
    const act = document.activeElement;
    const focusKey = act && bodyEl.contains(act) && act.dataset ? act.dataset.znKey : null;
    const selStart = focusKey && typeof act.selectionStart === 'number' ? act.selectionStart : null;

    renderHead(zone);
    const nodes = [];
    if (!zone.unassigned) nodes.push(renderPanel(zone));
    const visible = ui.q ? (V.filterZones([zone], { q: ui.q })[0] || { hosts: [] }).hosts : zone.hosts;
    nodes.push(el('div', { class: 'zn-sec' }, [
      el('span', { class: 'zn-sec-label', text: t('zones.hosts_section') }),
      el('span', { class: 'zn-sec-hint', text: t('zones.hosts_shown', { shown: visible.length, total: zone.hosts.length }) }),
    ]));
    const list = el('div', { class: 'zn-hcards' });
    visible.forEach((h) => list.appendChild(renderHostCard(h, zone)));
    if (!visible.length && zone.hosts.length) list.appendChild(el('div', { class: 'zn-empty-sm', text: t('zones.no_match') }));
    if (!zone.unassigned) list.appendChild(renderNewHostCard(zone));
    nodes.push(list);
    bodyEl.replaceChildren(...nodes);
    if (syncEl) syncEl.textContent = t('zones.last_sync', { time: fmtTime(ctx.lastSync()) });

    bodyEl.scrollTop = scroll;
    if (focusKey) {
      const n = bodyEl.querySelector('[data-zn-key="' + focusKey + '"]');
      if (n) {
        n.focus();
        if (selStart != null && typeof n.setSelectionRange === 'function') {
          try { n.setSelectionRange(selStart, selStart); } catch (_) { /* number inputs */ }
        }
      }
    }
    if (opts && opts.focusHostId != null) {
      const card = bodyEl.querySelector('.zn-hcard[data-host-id="' + opts.focusHostId + '"]');
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        card.classList.add('zn-flash');
        setTimeout(() => card.classList.remove('zn-flash'), 1600);
      }
    }
  }

  function renderHead(zone) {
    titleEl.textContent = zone.unassigned ? t('zones.unassigned') : t('zones.modal_title');
    domainEl.textContent = zone.unassigned ? '' : zone.domain;
    domainEl.hidden = !!zone.unassigned;
    tagsEl.replaceChildren();
    const vt = zone.unassigned ? null : verificationTag(zone);
    if (vt) tagsEl.appendChild(vt);
    const c = V.countEntries(zone);
    countsEl.textContent = t('zones.modal_counts', { hosts: c.hosts, entries: c.entries });
  }

  function gatewayOptions(zone) {
    const data = ctx.getData() || {};
    const groups = [];
    if (peerKind(zone)) {
      const peers = (data.peers || peersCache || []).filter((p) => p.peer_type !== 'gateway');
      groups.push({ label: t('zones.gw_group_peers'), items: peers.map((p) => ({ key: 'peer:' + p.id, label: p.name + (p.ip ? ' (' + p.ip + ')' : ''), off: p.isOnline === false })) });
    } else {
      const gws = (data.gateways || []).map((g) => ({
        id: g.peer_id != null ? g.peer_id : g.id, name: g.name || g.hostname, ip: g.ip,
        online: g.online != null ? g.online : g.isOnline,
      }));
      groups.push({ label: t('zones.gw_group_gateways'), items: gws.map((g) => ({ key: 'gateway:' + g.id, label: (g.name || '#' + g.id) + (g.ip ? ' (' + g.ip + ')' : ''), off: g.online === false })) });
      const pools = data.pools || [];
      if (pools.length) groups.push({ label: t('zones.gw_group_pools'), items: pools.map((p) => ({ key: 'pool:' + p.id, label: t('zones.gateway_pool', { name: p.name }) })) });
    }
    return groups;
  }

  function renderPanel(zone) {
    const curKey = V.zoneGatewayKey(zone);
    const sel = el('select', { class: 'form-select zn-select', 'data-zn-key': 'gw', 'aria-label': t(peerKind(zone) ? 'zones.target_peer_label' : 'zones.gateway_label') });
    if (!curKey) sel.appendChild(el('option', { value: '', text: t('zones.gateway_none') }));
    let found = !curKey;
    gatewayOptions(zone).forEach((g) => {
      if (!g.items.length) return;
      const og = el('optgroup', { label: g.label });
      g.items.forEach((it) => {
        if (it.key === curKey) found = true;
        og.appendChild(el('option', { value: it.key, text: it.label + (it.off ? ' · ' + t('zones.offline') : '') }));
      });
      sel.appendChild(og);
    });
    if (!found) sel.appendChild(el('option', { value: curKey, text: gatewayLabel(zone.gateway) }));
    sel.value = curKey || '';
    sel.addEventListener('change', () => changeGateway(zone, sel, curKey));
    if (peerKind(zone) && !(ctx.getData() || {}).peers && !peersCache) loadPeers();

    const gwHint = zone.gateway && zone.gateway.online === false
      ? el('span', { class: 'form-hint zn-hint-warn' }, [icon('alert', 11), ' ', t('zones.gateway_offline_hint')])
      : el('span', { class: 'form-hint', text: t('zones.gateway_hint') });

    const ext = !!zone.default_external_enabled;
    const grp = el('div', { class: 'toggle-group zn-access-group', role: 'group', 'aria-label': t('zones.default_access') }, [
      el('button', { type: 'button', class: 'toggle-btn' + (ext ? ' on' : ''), 'aria-pressed': ext ? 'true' : 'false', text: t('zones.default_external'), on: { click: (e) => changeDefaults(zone, true, e.currentTarget) } }),
      el('button', { type: 'button', class: 'toggle-btn' + (!ext ? ' on' : ''), 'aria-pressed': !ext ? 'true' : 'false', text: t('zones.default_internal'), on: { click: (e) => changeDefaults(zone, false, e.currentTarget) } }),
    ]);

    const q = el('input', { type: 'search', class: 'zn-input zn-search-sm', value: ui.q, placeholder: t('zones.host_filter_ph'), 'data-zn-key': 'q', 'aria-label': t('zones.host_filter') });
    q.addEventListener('input', () => { ui.q = q.value; render(); });

    return el('div', { class: 'zn-panel' }, [
      el('div', { class: 'zn-field' }, [el('label', { class: 'form-label', text: t(peerKind(zone) ? 'zones.target_peer_label' : 'zones.gateway_label') }), el('div', { class: 'zn-select-wrap' }, [icon(gatewayIconName(zone.gateway && zone.gateway.kind), 13), sel]), gwHint]),
      el('div', { class: 'zn-field' }, [el('span', { class: 'form-label', text: t('zones.default_access') }), grp, el('span', { class: 'form-hint', text: t('zones.default_access_hint') })]),
      el('div', { class: 'zn-field' }, [el('label', { class: 'form-label', text: t('zones.host_filter') }), el('div', { class: 'zn-search-wrap' }, [icon('search', 13), q])]),
    ]);
  }

  async function loadPeers() {
    try {
      const res = await api.get('/api/routes/peers');
      peersCache = (res && res.peers) || [];
      if (isOpen()) render();
    } catch (_) { peersCache = []; }
  }

  async function changeGateway(zone, sel, oldKey) {
    const key = sel.value;
    if (!key || key === oldKey) return;
    const target = V.parseGatewayKey(key);
    const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : key;
    const following = zone.hosts.filter((h) => !h.gateway_override);
    const entries = following.reduce((n, h) => n + (h.entries || []).filter((e) => !e.rdp_owned).length, 0);
    const overrides = zone.hosts.length - following.length;
    const ok = await confirmDialog({
      title: t(peerKind(zone) ? 'zones.target_peer_confirm_title' : 'zones.gateway_confirm_title'),
      message: t('zones.gateway_confirm', { domain: zone.domain, target: label, hosts: following.length, entries }),
      detail: overrides ? t('zones.gateway_confirm_overrides', { count: overrides }) : null,
      okLabel: t('zones.gateway_confirm_ok'),
    });
    if (!ok) { sel.value = oldKey || ''; return; }
    sel.disabled = true;
    try {
      await call(api.put('/api/v1/domains/' + zone.domain_id + '/gateway', target));
      toastOk(t('zones.gateway_saved', { domain: zone.domain }));
      await afterMutation();
    } catch (err) {
      sel.value = oldKey || '';
      toastError(err);
    } finally { sel.disabled = false; }
  }

  async function changeDefaults(zone, external, btn) {
    if (!!zone.default_external_enabled === external) return;
    busy(btn, true);
    try {
      await call(api.put('/api/v1/domains/' + zone.domain_id + '/defaults', { default_external_enabled: external }));
      toastOk(t('zones.defaults_saved'));
      await afterMutation();
    } catch (err) { toastError(err); } finally { busy(btn, false); }
  }

  // ── Host card ──
  function renderHostCard(host, zone) {
    const on = V.hostEnabled(host);
    const label = V.hostLabel(host);
    const sfx = zone.unassigned ? '' : (V.isApex(host) ? ' ' + zone.domain : '.' + zone.domain);
    const descBits = [];
    if (host.description) descBits.push(host.description);
    if (host.template) descBits.push(t('host.template_badge', { name: templateName(host.template) }));
    const printer = host.template === 'printer';

    const head = el('div', { class: 'zn-hhead' }, [
      el('div', { class: 'zn-hname' }, [
        printer ? icon('printer', 13) : null,
        el('span', { class: 'zn-name', text: label }),
        sfx ? el('span', { class: 'zn-sfx', text: sfx }) : null,
      ]),
      descBits.length ? el('span', { class: 'zn-hdesc', text: descBits.join(' · ') }) : null,
      host.gateway_override ? tag('amber', t('host.override_tag'), false, 'zn-override') : null,
      host.gateway_override && !zone.unassigned
        ? el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm', on: { click: (e) => clearOverride(host, zone, e.currentTarget) } }, [icon('refresh', 12), t('host.override_clear')])
        : null,
      el('span', { class: 'zn-spacer' }),
      accessTag(V.hostAccess(host)),
      toggleEl(on, on ? t('host.disable') : t('host.enable'), (node) => toggleHost(host, !on, node)),
      el('button', {
        type: 'button', class: 'zn-ibtn', title: t('host.menu'), 'aria-label': t('host.menu'), 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        on: { click: (e) => { e.stopPropagation(); openMenu(e.currentTarget, hostMenuItems(host, zone)); } },
      }, [icon('more', 13)]),
    ]);

    const rows = [el('div', { class: 'zn-pline zn-pline-th', 'aria-hidden': 'true' }, [
      el('div', { class: 'zn-th', text: t('entry.col_type') }),
      el('div', { class: 'zn-th', text: t('entry.col_target') }),
      el('div', { class: 'zn-th', text: t('entry.col_listen') }),
      el('div', { class: 'zn-th', text: t('entry.col_options') }),
      el('div', { class: 'zn-th', text: t('entry.col_active') }),
      el('div'),
    ])];
    V.sortEntries(host.entries).forEach((e) => rows.push(renderEntryLine(e, host, zone)));

    const extras = [];
    if (printer) {
      const canScan = GC.features.gateway_scan_egress === true;
      extras.push(el('div', { class: 'zn-hextra' }, [
        el('button', {
          type: 'button', class: 'btn btn-ghost zn-btn-sm', disabled: !canScan || peerKind(zone),
          title: canScan ? null : t('host.scan_locked'), on: { click: () => openScanDialog(host, zone) },
        }, [icon('folder', 12), t('host.scan_setup')]),
        !canScan ? el('span', { class: 'zn-hint-muted', text: t('host.scan_locked') }) : null,
      ]));
    }

    return el('div', { class: 'zn-hcard' + (on ? '' : ' off'), dataset: { hostId: String(host.id) } }, [
      head, rows, extras, renderAddEntry(host, zone),
    ]);
  }

  function templateName(id) {
    const tpl = (templatesCache || []).find((x) => x.id === id);
    return (tpl && (tpl.name || tpl.label)) || t('template.' + id);
  }

  function renderEntryLine(e, host, zone) {
    const c = V.entryChip(e);
    const opts = [];
    if (e.rdp_owned) opts.push(tag('purple', t('entry.rdp_tag'), false, 'zn-opt-tag'));
    opts.push(e.external_enabled ? tag('green', t('host.access_external'), false, 'zn-opt-tag') : tag('grey', t('host.access_internal'), false, 'zn-opt-tag'));
    const pl = V.entryPortLabel(e);
    if (pl && !e.rdp_owned) opts.push(tag('grey', pl, false, 'zn-opt-tag'));
    if (c.note) opts.push(tag('grey', c.note, false, 'zn-opt-tag'));
    if (!V.isL4(e) && (e.basic_auth_enabled || e.route_auth_enabled)) opts.push(tag('blue', t('entry.auth_tag'), false, 'zn-opt-tag'));
    if (e.enabled && V.entryHealth(e) === 'down') opts.push(tag('red', t('entry.down_tag'), false, 'zn-opt-tag'));
    if (e.baseUnverified) opts.push(tag('amber', t('entry.unverified_tag'), false, 'zn-opt-tag'));

    const target = el('div', { class: 'zn-tgt' }, [
      icon(e.target_kind === 'gateway' ? (e.target_pool_id != null ? 'pool' : 'gateway') : 'peer', 12),
      el('span', { text: V.entryTargetHost(e) || '?' }),
      el('span', { class: 'zn-muted', text: ':' }),
      el('span', { text: c.in || '?' }),
    ]);

    let active;
    let tools;
    if (e.rdp_owned) {
      active = el('a', { href: '/rdp', class: 'zn-link', title: t('entry.rdp_hint') }, [icon('rdp', 12), t('entry.rdp_link')]);
      tools = el('div', { class: 'zn-tools' });
    } else {
      active = toggleEl(!!e.enabled, e.enabled ? t('entry.disable') : t('entry.enable'), (node) => toggleEntry(e, node));
      tools = el('div', { class: 'zn-tools' }, [
        ibtn('pencil', t('entry.edit'), () => editEntry(e)),
        ibtn('trash', t('entry.delete'), (btn) => deleteEntry(e, host, zone, btn), 'zn-ibtn-danger'),
      ]);
    }

    return el('div', { class: 'zn-pline' + (e.enabled ? '' : ' off') + (e.rdp_owned ? ' zn-rdp' : ''), dataset: { entryId: String(e.id) } }, [
      el('div', { class: 'zn-cell-type' }, [el('span', { class: 'zn-tsel ' + PROTO_CLASS[c.proto], text: c.proto })]),
      target,
      el('div', { class: 'zn-prt', 'data-label': t('entry.col_listen') }, [c.out || '—']),
      el('div', { class: 'zn-opt' }, [opts, e.description && e.description !== host.description ? el('span', { class: 'zn-edesc', text: e.description }) : null]),
      el('div', { class: 'zn-cell-active' }, [active]),
      tools,
    ]);
  }

  // ── Entry form shared by "Eintrag hinzufügen" and "Neuer Host" ──
  function l4Allowed(zone) {
    const f = GC.features;
    if (f.l4_routes === 0) return false;
    if (zone && zone.gateway && (zone.gateway.kind === 'gateway' || zone.gateway.kind === 'pool') && f.gateway_tcp_routing === false) return false;
    return true;
  }

  function entryFields(draft, keyPrefix, zone, onChange) {
    const l4ok = l4Allowed(zone);
    const typeSel = el('select', { class: 'form-select zn-select zn-type-sel', 'data-zn-key': keyPrefix + 'type', 'aria-label': t('entry.col_type') }, [
      el('option', { value: 'http', text: 'HTTPS' }),
      el('option', { value: 'tcp', text: 'TCP', disabled: !l4ok }),
      el('option', { value: 'udp', text: 'UDP', disabled: !l4ok }),
    ]);
    typeSel.value = draft.type;
    typeSel.addEventListener('change', () => { draft.type = typeSel.value; draft.conflict = null; onChange(true); });
    const target = el('input', { type: 'text', inputmode: 'numeric', class: 'zn-input zn-port', value: draft.target, placeholder: t('entry.target_port_ph'), 'aria-label': t('entry.target_port'), 'data-zn-key': keyPrefix + 'target', maxLength: 5 });
    target.addEventListener('input', () => { draft.target = target.value.trim(); onChange(false); });
    const nodes = [
      el('div', { class: 'zn-f zn-f-type' }, [el('span', { class: 'zn-f-label', text: t('entry.col_type') }), typeSel]),
      el('div', { class: 'zn-f' }, [el('span', { class: 'zn-f-label', text: t('entry.target_port') }), target]),
    ];
    if (draft.type === 'http') {
      const cb = el('input', { type: 'checkbox', checked: !!draft.bhttps, 'data-zn-key': keyPrefix + 'bhttps' });
      cb.addEventListener('change', () => { draft.bhttps = cb.checked; onChange(false); });
      nodes.push(el('label', { class: 'zn-check', title: t('entry.backend_https_hint') }, [cb, t('entry.backend_https')]));
    } else {
      const listen = el('input', { type: 'text', inputmode: 'numeric', class: 'zn-input zn-port', value: draft.listen, placeholder: t('entry.listen_port_ph'), 'aria-label': t('entry.listen_port'), 'data-zn-key': keyPrefix + 'listen', maxLength: 11 });
      listen.addEventListener('input', () => { draft.listen = listen.value.trim(); draft.conflict = null; onChange(false); });
      nodes.push(el('div', { class: 'zn-f' }, [el('span', { class: 'zn-f-label', text: t('entry.listen_port') }), listen]));
    }
    return nodes;
  }

  function entryInputFromDraft(d) {
    if (!V.validPort(d.target, false)) return { error: t('entry.err_target_port') };
    const out = { type: d.type, target_port: parseInt(d.target, 10) };
    if (d.type === 'http') {
      out.backend_https = !!d.bhttps;
    } else {
      if (!V.validPort(d.listen, true)) return { error: t('entry.err_listen_port') };
      out.listen_port = /^\d+$/.test(d.listen) ? parseInt(d.listen, 10) : d.listen;
    }
    return { entry: out };
  }

  function conflictRow(conflict, onUse) {
    if (!conflict) return null;
    return el('div', { class: 'zn-conflict', role: 'alert' }, [
      icon('alert', 12),
      el('span', { text: t('entry.port_conflict', { port: conflict.port }) }),
      conflict.suggestedPort
        ? el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm', text: t('entry.use_port', { port: conflict.suggestedPort }), on: { click: onUse } })
        : null,
    ]);
  }

  function renderAddEntry(host, zone) {
    const d = ui.add[host.id];
    if (!d) {
      return el('button', {
        type: 'button', class: 'zn-addline',
        on: { click: () => {
          const hasHttp = (host.entries || []).some((x) => !V.isL4(x));
          ui.add[host.id] = { type: hasHttp ? 'tcp' : 'http', target: '', listen: '', bhttps: false, conflict: null, error: null };
          render();
          const n = bodyEl.querySelector('[data-zn-key="add' + host.id + 'target"]');
          if (n) n.focus();
        } },
      }, [icon('plus', 13), el('span', { class: 'zn-addline-label', text: t('entry.add') }), el('span', { class: 'zn-muted', text: 'HTTPS · TCP · UDP' })]);
    }
    const submitBtn = el('button', { type: 'button', class: 'btn btn-primary zn-btn-sm', on: { click: (e) => submitAddEntry(host, zone, e.currentTarget) } }, [icon('plus', 12), t('entry.add_submit')]);
    const form = el('div', { class: 'zn-addform', on: { keydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submitBtn.click(); } } } }, [
      el('div', { class: 'zn-addform-fields' }, [
        entryFields(d, 'add' + host.id, zone, (rerender) => { d.error = null; if (rerender) render(); }),
        el('div', { class: 'zn-addform-actions' }, [
          submitBtn,
          el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm', text: t('common.cancel'), on: { click: () => { delete ui.add[host.id]; render(); } } }),
        ]),
      ]),
      d.error ? el('div', { class: 'zn-field-error', role: 'alert', text: d.error }) : null,
      conflictRow(d.conflict, () => { d.listen = String(d.conflict.suggestedPort); d.conflict = null; render(); submitAddEntry(host, zone, null); }),
    ]);
    return form;
  }

  async function submitAddEntry(host, zone, btn) {
    const d = ui.add[host.id];
    if (!d) return;
    const r = entryInputFromDraft(d);
    if (r.error) { d.error = r.error; render(); return; }
    busy(btn, true);
    try {
      await call(api.post('/api/v1/hosts/' + host.id + '/entries', r.entry));
      delete ui.add[host.id];
      toastOk(t('entry.created', { host: fqdnOf(host, zone) }));
      await afterMutation();
    } catch (err) {
      const c = portConflict(err);
      if (c) { d.conflict = c; d.error = null; render(); } else { toastError(err); }
    } finally { busy(btn, false); }
  }

  // ── New host card ──
  async function loadTemplates() {
    if (templatesCache) return templatesCache;
    try {
      const res = await call(api.get('/api/v1/host-templates'));
      templatesCache = res.templates || [];
    } catch (err) {
      toastError(err);
      return [];
    }
    return templatesCache;
  }

  function templateEntryText(e) {
    const proto = e.type === 'http' ? 'HTTPS' : String(e.type || '').toUpperCase();
    const out = e.type === 'http' ? '443' : (e.listen_port != null ? String(e.listen_port) : '…');
    return proto + ' ' + out + ' → ' + (e.target_port != null ? e.target_port : '?') + (e.backend_https ? ' · Backend HTTPS' : '');
  }

  function renderNewHostCard(zone) {
    const nh = ui.nh;
    const kindPeer = peerKind(zone);
    const sub = el('input', { type: 'text', class: 'zn-input zn-mono', value: nh.sub, placeholder: t('host.subdomain_ph'), 'aria-label': t('host.subdomain'), 'data-zn-key': 'nhsub', maxLength: 190, autocomplete: 'off', spellcheck: 'false' });
    sub.addEventListener('input', () => { nh.sub = sub.value.trim(); nh.error = null; nh.conflict = null; preview.textContent = V.previewFqdn(nh.sub, zone.domain); });
    const preview = el('span', { class: 'zn-preview', text: V.previewFqdn(nh.sub, zone.domain) });
    const desc = el('input', { type: 'text', class: 'zn-input', value: nh.desc, placeholder: t('host.description_ph'), 'aria-label': t('host.description'), 'data-zn-key': 'nhdesc', maxLength: 200 });
    desc.addEventListener('input', () => { nh.desc = desc.value; });

    const tplBtn = el('button', { type: 'button', class: 'btn btn-ghost zn-btn-sm', 'aria-haspopup': 'menu', on: { click: (e) => openTemplateMenu(e.currentTarget) } }, [icon('tpl', 12), t('template.menu'), icon('down', 11)]);

    const head = el('div', { class: 'zn-hhead zn-newhead' }, [
      el('span', { class: 'zn-new-title', text: t('host.new') }),
      el('div', { class: 'zn-affix zn-affix-sub' }, [sub, el('span', { class: 'zn-affix-sfx', text: '.' + zone.domain })]),
      desc,
      el('span', { class: 'zn-spacer' }),
      tplBtn,
    ]);

    const lan = kindPeer ? null : el('input', { type: 'text', class: 'zn-input zn-mono', value: nh.lan, placeholder: t('host.lan_ph'), 'aria-label': t('host.lan_host'), 'data-zn-key': 'nhlan', maxLength: 253, autocomplete: 'off', spellcheck: 'false' });
    if (lan) lan.addEventListener('input', () => { nh.lan = lan.value.trim(); nh.error = null; });

    const createBtn = el('button', { type: 'button', class: 'btn btn-primary zn-btn-sm', on: { click: (e) => submitNewHost(zone, e.currentTarget) } }, [icon('plus', 12), t('host.create')]);

    let entryPart;
    if (nh.template) {
      const tpl = nh.template;
      const lines = Array.isArray(tpl.entries) && tpl.entries.length
        ? tpl.entries.map((e) => el('span', { class: 'zn-chip' }, [templateEntryText(e)]))
        : [el('span', { class: 'zn-muted', text: tpl.description || t('template.' + tpl.id + '_hint') })];
      entryPart = el('div', { class: 'zn-tpl-preview' }, [
        tag('blue', t('host.template_badge', { name: tpl.name || tpl.label || t('template.' + tpl.id) }), false),
        lines,
        el('button', { type: 'button', class: 'zn-link zn-link-btn', text: t('template.remove'), on: { click: () => { nh.template = null; render(); } } }),
      ]);
    } else {
      entryPart = el('div', { class: 'zn-entry-fields' }, entryFields(nh, 'nh', zone, (rerender) => { nh.error = null; if (rerender) render(); }));
    }

    const row = el('div', { class: 'zn-newrow', on: { keydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); createBtn.click(); } } } }, [
      lan ? el('div', { class: 'zn-f zn-f-lan' }, [el('span', { class: 'zn-f-label', text: t('host.lan_host') }), el('div', { class: 'zn-lan-wrap' }, [icon('gateway', 12), lan])]) : null,
      entryPart,
      el('div', { class: 'zn-newrow-actions' }, [createBtn]),
    ]);

    return el('div', { class: 'zn-hcard zn-newcard' }, [
      head,
      el('div', { class: 'zn-new-preview' }, [el('span', { class: 'zn-muted', text: t('host.fqdn_preview') }), preview]),
      row,
      nh.error ? el('div', { class: 'zn-field-error zn-pad', role: 'alert', text: nh.error }) : null,
      nh.conflict ? el('div', { class: 'zn-pad' }, [conflictRow(nh.conflict, () => { nh.listen = String(nh.conflict.suggestedPort); nh.conflict = null; render(); submitNewHost(zone, null); })]) : null,
      el('div', { class: 'form-hint zn-pad zn-tpl-hint', text: t('template.hint') }),
    ]);
  }

  async function openTemplateMenu(anchor) {
    const list = await loadTemplates();
    if (!list.length) { toastError(t('template.none')); return; }
    openMenu(anchor, list.map((tpl) => ({
      label: tpl.name || tpl.label || t('template.' + tpl.id),
      sub: tpl.description || t('template.' + tpl.id + '_hint'),
      icon: tpl.id === 'printer' ? 'printer' : 'tpl',
      onClick: () => { ui.nh.template = tpl; ui.nh.conflict = null; render(); },
    })));
  }

  async function submitNewHost(zone, btn) {
    const nh = ui.nh;
    const fail = (msg) => { nh.error = msg; render(); };
    if (!V.validSubdomain(nh.sub)) return fail(t('host.err_subdomain'));
    const body = { subdomain: nh.sub ? nh.sub.toLowerCase() : '@' };
    if (nh.desc.trim()) body.description = nh.desc.trim();
    if (!peerKind(zone)) {
      if (!nh.lan) return fail(t('host.err_lan_required'));
      body.lan_host = nh.lan;
    }
    if (nh.template) {
      body.template = nh.template.id;
    } else {
      const r = entryInputFromDraft(nh);
      if (r.error) return fail(r.error);
      body.entries = [r.entry];
    }
    busy(btn, true);
    try {
      const res = await call(api.post('/api/v1/domains/' + zone.domain_id + '/hosts', body));
      const created = res.host || {};
      ui.nh = freshUi().nh;
      toastOk(t('host.created', { host: created.fqdn || V.previewFqdn(body.subdomain, zone.domain) }));
      await afterMutation();
      if (created.id != null) render({ focusHostId: created.id });
    } catch (err) {
      const c = portConflict(err);
      if (c) { nh.conflict = c; nh.error = null; render(); } else { toastError(err); }
    } finally { busy(btn, false); }
  }

  // ── Host actions ──
  function hostMenuItems(host, zone) {
    const fqdn = fqdnOf(host, zone);
    const hasHttp = (host.entries || []).some((e) => !V.isL4(e));
    return [
      zone.unassigned ? null : { icon: 'pencil', label: t('host.rename'), onClick: () => renameHost(host, zone) },
      { icon: 'pencil', label: t('host.edit_description'), onClick: () => editDescription(host) },
      peerKind(zone) || (!host.lan_host && zone.unassigned) ? null : { icon: 'gateway', label: t('host.change_lan'), onClick: () => changeLan(host, zone) },
      hasHttp && host.fqdn ? { icon: 'ext', label: t('host.open'), onClick: () => window.open('https://' + host.fqdn, '_blank', 'noopener') } : null,
      '-',
      { icon: 'trash', label: t('host.delete'), danger: true, onClick: () => deleteHost(host, zone, fqdn) },
    ];
  }

  async function putHost(host, patch, okMsg) {
    try {
      await call(api.put('/api/v1/hosts/' + host.id, patch));
      toastOk(okMsg);
      await afterMutation();
    } catch (err) { toastError(err); }
  }

  async function renameHost(host, zone) {
    const v = await promptDialog({
      title: t('host.rename'), label: t('host.subdomain'), value: V.isApex(host) ? '@' : (host.subdomain || ''),
      suffix: '.' + zone.domain, hint: t('host.rename_hint'), okLabel: t('host.rename_ok'),
      validate: (s) => (V.validSubdomain(s) ? null : t('host.err_subdomain')),
    });
    if (v == null) return;
    const next = v ? v.toLowerCase() : '@';
    if (next === (host.subdomain || '')) return;
    await putHost(host, { subdomain: next }, t('host.renamed', { host: V.previewFqdn(next, zone.domain) }));
  }

  async function editDescription(host) {
    const v = await promptDialog({ title: t('host.edit_description'), label: t('host.description'), value: host.description || '', maxLength: 200 });
    if (v == null || v === (host.description || '')) return;
    await putHost(host, { description: v }, t('host.saved'));
  }

  async function changeLan(host, zone) {
    const v = await promptDialog({
      title: t('host.change_lan'), label: t('host.lan_host'), value: host.lan_host || '', hint: t('host.change_lan_hint'),
      validate: (s) => (s ? null : t('host.err_lan_required')),
    });
    if (v == null || v === (host.lan_host || '')) return;
    await putHost(host, { lan_host: v }, t('host.lan_saved', { host: fqdnOf(host, zone), ip: v }));
  }

  async function deleteHost(host, zone, fqdn) {
    const n = (host.entries || []).filter((e) => !e.rdp_owned).length;
    const rdp = (host.entries || []).some((e) => e.rdp_owned);
    const ok = await confirmDialog({
      title: t('host.delete'), message: t('host.confirm_delete', { host: fqdn, count: n }),
      detail: rdp ? t('host.confirm_delete_rdp') : null, okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return;
    try {
      await call(api.del('/api/v1/hosts/' + host.id));
      delete ui.add[host.id];
      toastOk(t('host.deleted', { host: fqdn }));
      await afterMutation();
    } catch (err) { toastError(err); }
  }

  async function toggleHost(host, enabled, node) {
    busy(node, true);
    try {
      await call(api.put('/api/v1/hosts/' + host.id + '/toggle', { enabled }));
      await afterMutation();
    } catch (err) { toastError(err); } finally { busy(node, false); }
  }

  async function clearOverride(host, zone, btn) {
    const ok = await confirmDialog({
      title: t('host.override_clear'),
      message: t('host.override_confirm', { host: fqdnOf(host, zone), target: gatewayLabel(zone.gateway) }),
      okLabel: t('host.override_clear_ok'),
    });
    if (!ok) return;
    busy(btn, true);
    try {
      await call(api.put('/api/v1/hosts/' + host.id + '/gateway-override', { override: false }));
      toastOk(t('host.override_cleared', { host: fqdnOf(host, zone) }));
      await afterMutation();
    } catch (err) { toastError(err); } finally { busy(btn, false); }
  }

  // ── Entry actions ──
  async function toggleEntry(e, node) {
    busy(node, true);
    try {
      await call(api.put('/api/routes/' + e.id + '/toggle', {}));
      await afterMutation();
    } catch (err) { toastError(err); } finally { busy(node, false); }
  }

  function editEntry(e) {
    const ed = window.GCEntryEditor;
    if (!ed || typeof ed.open !== 'function') { toastError(t('entry.editor_missing')); return; }
    try {
      ed.open(e.id, {
        lockTarget: true,
        onSaved: () => { afterMutation(); },
        onDeleted: () => { afterMutation(); },
      });
    } catch (err) { toastError(err); }
  }

  async function deleteEntry(e, host, zone, btn) {
    const c = V.entryChip(e);
    const last = (host.entries || []).filter((x) => !x.rdp_owned).length <= 1;
    const ok = await confirmDialog({
      title: t('entry.delete'),
      message: t('entry.confirm_delete', { entry: c.proto + ' ' + (c.out || '') + (c.in ? ' → ' + c.in : ''), host: fqdnOf(host, zone) }),
      detail: last ? t('entry.confirm_delete_last') : null,
      okLabel: t('common.delete'), danger: true,
    });
    if (!ok) return;
    busy(btn, true);
    try {
      await call(api.del('/api/routes/' + e.id));
      toastOk(t('entry.deleted'));
      await afterMutation();
    } catch (err) { toastError(err); } finally { busy(btn, false); }
  }

  // ── Scan-to-folder (printer hosts) ──
  function openScanDialog(host, zone) {
    const data = ctx.getData() || {};
    const gateways = (data.gateways || []).map((g) => ({ id: g.peer_id != null ? g.peer_id : g.id, name: g.name || g.hostname || ('#' + (g.peer_id != null ? g.peer_id : g.id)) }));
    const smb = V.smbEntries(zone);
    const st = { vip: '', mode: smb.length ? 'existing' : 'new', routeId: smb.length ? smb[0].id : null, nasIp: '', nasGw: zone.gateway && zone.gateway.kind === 'gateway' ? zone.gateway.peer_id : (gateways[0] && gateways[0].id) };
    const d = dialog({ title: t('host.scan_title'), wide: false });
    const err = el('div', { class: 'zn-field-error', role: 'alert' });
    err.hidden = true;

    const vip = el('input', { type: 'text', class: 'form-input zn-input zn-mono', placeholder: '192.168.1.250', 'aria-label': t('host.scan_vip') });
    vip.addEventListener('input', () => { st.vip = vip.value.trim(); });

    const radio = (value, label, disabled) => {
      const r = el('input', { type: 'radio', name: 'zn-scan-mode', value, checked: st.mode === value, disabled: !!disabled });
      r.addEventListener('change', () => { if (r.checked) { st.mode = value; sync(); } });
      return el('label', { class: 'zn-radio' }, [r, label]);
    };
    const exSel = el('select', { class: 'form-select zn-select', 'aria-label': t('host.scan_target_existing') },
      smb.map((s) => el('option', { value: String(s.id), text: fqdnOf(s.host, zone) + ' · TCP ' + s.entry.l4_listen_port + ' → 445' })));
    exSel.addEventListener('change', () => { st.routeId = parseInt(exSel.value, 10); });
    const exWrap = el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_target_existing') }), exSel]);

    const nasIp = el('input', { type: 'text', class: 'form-input zn-input zn-mono', placeholder: '192.168.1.10', 'aria-label': t('host.scan_nas_ip') });
    nasIp.addEventListener('input', () => { st.nasIp = nasIp.value.trim(); });
    const gwSel = el('select', { class: 'form-select zn-select', 'aria-label': t('host.scan_nas_gateway') }, gateways.map((g) => el('option', { value: String(g.id), text: g.name })));
    if (st.nasGw != null) gwSel.value = String(st.nasGw);
    gwSel.addEventListener('change', () => { st.nasGw = parseInt(gwSel.value, 10); });
    const newWrap = el('div', {}, [
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_nas_ip') }), nasIp]),
      el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_nas_gateway') }), gwSel]),
    ]);
    function sync() { exWrap.hidden = st.mode !== 'existing'; newWrap.hidden = st.mode !== 'new'; }

    d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: t('host.scan_intro', { host: fqdnOf(host, zone) }) }));
    d.body.appendChild(el('div', { class: 'form-group' }, [el('label', { class: 'form-label', text: t('host.scan_vip') }), vip, el('span', { class: 'form-hint', text: t('host.scan_vip_hint') })]));
    d.body.appendChild(el('div', { class: 'form-group zn-radios' }, [
      radio('existing', t('host.scan_target_existing'), !smb.length),
      radio('new', t('host.scan_target_new')),
    ]));
    if (!smb.length) d.body.appendChild(el('span', { class: 'form-hint', text: t('host.scan_no_smb') }));
    d.body.appendChild(exWrap);
    d.body.appendChild(newWrap);
    d.body.appendChild(err);
    sync();

    const submit = el('button', { type: 'button', class: 'btn btn-primary', text: t('host.scan_submit') });
    submit.addEventListener('click', async () => {
      const bad = (msg) => { err.textContent = msg; err.hidden = false; };
      if (!V.validIPv4(st.vip)) return bad(t('host.scan_err_vip'));
      let target;
      if (st.mode === 'existing') {
        if (!st.routeId) return bad(t('host.scan_err_route'));
        target = { mode: 'existing', route_id: st.routeId };
      } else {
        if (!V.validIPv4(st.nasIp)) return bad(t('host.scan_err_nas_ip'));
        if (!st.nasGw) return bad(t('host.scan_err_gateway'));
        target = { mode: 'new', nas_ip: st.nasIp, nas_gateway_peer_id: st.nasGw };
      }
      err.hidden = true;
      busy(submit, true);
      try {
        await call(api.post('/api/v1/hosts/' + host.id + '/scan-to-folder', { vip_ip: st.vip, target }));
        d.close(true);
        toastOk(t('host.scan_done', { host: fqdnOf(host, zone) }));
        await afterMutation();
      } catch (e2) { bad(errMsg(e2)); } finally { busy(submit, false); }
    });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.cancel'), on: { click: () => d.close(null) } }));
    d.foot.appendChild(submit);
    vip.focus();
  }

  // ── Public API ──
  function open(domainId, opts) {
    closeMenu();
    current = { domainId: domainId == null ? null : Number(domainId) };
    ui = freshUi();
    pendingRefresh = false;
    bodyEl.replaceChildren();
    bodyEl.scrollTop = 0;
    if (window.openModal) window.openModal('zn-domain-modal'); else overlay.style.display = 'flex';
    render({ focusHostId: opts && opts.focusHostId });
    if (!(opts && opts.focusHostId != null)) {
      const first = overlay.querySelector('.zn-dm-close');
      if (first) first.focus();
    }
  }

  function close() {
    closeMenu();
    if (window.closeModal) window.closeModal('zn-domain-modal'); else overlay.style.display = 'none';
  }

  // Called by the page after every GET /zones. While a menu is open the
  // rebuild waits (it would detach the menu's anchor) and runs on close.
  function refresh() {
    if (!isOpen() || !current) return;
    if (menuOpen()) { pendingRefresh = true; return; }
    pendingRefresh = false;
    render();
  }
  onMenuClosed(() => { if (pendingRefresh) setTimeout(refresh, 0); });

  function bind(c) { ctx = Object.assign(ctx, c || {}); }

  window.GCDomainModal = { open, close, refresh, isOpen, bind, currentDomainId: () => (current ? current.domainId : undefined) };
})();
