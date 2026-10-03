'use strict';

// Shared UI kit of the zones page (window.GCZonesUI), the "Domain-
// Einstellungen" dialog (window.GCDomainModal) and the LAN discovery used by
// "Neuer Host" (GCZonesUI.discovery). Loaded after zones-view.js and before
// host-dialogs.js / zones-page.js. DOM is built with el() only — innerHTML is
// blocked by a hook. Dialogs save explicitly; after each save the page
// re-fetches GET /api/v1/zones and calls GCDomainModal.refresh().
// Contract: docs/feature-domain-zones.md.
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
    pencil: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }]],
    ext: [['path', { d: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6' }], ['polyline', { points: '15 3 21 3 21 9' }], ['line', { x1: 10, y1: 14, x2: 21, y2: 3 }]],
    trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
    x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    printer: [['polyline', { points: '6 9 6 2 18 2 18 9' }], ['path', { d: 'M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2' }], ['rect', { x: 6, y: 14, width: 12, height: 8 }]],
    gateway: [['rect', { x: 3, y: 5, width: 18, height: 6, rx: 1.5 }], ['rect', { x: 3, y: 13, width: 18, height: 6, rx: 1.5 }]],
    pool: [['ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }], ['path', { d: 'M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12' }], ['path', { d: 'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5' }]],
    peer: [['circle', { cx: 17, cy: 7, r: 3 }], ['circle', { cx: 7, cy: 17, r: 3 }], ['path', { d: 'M14 10l-4 4' }], ['circle', { cx: 7, cy: 7, r: 3 }], ['circle', { cx: 17, cy: 17, r: 3 }]],
    more: [['circle', { cx: 5, cy: 12, r: 1.6 }], ['circle', { cx: 12, cy: 12, r: 1.6 }], ['circle', { cx: 19, cy: 12, r: 1.6 }]],
    tpl: [['path', { d: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z' }], ['polyline', { points: '3.27 6.96 12 12.01 20.73 6.96' }], ['line', { x1: 12, y1: 22.08, x2: 12, y2: 12 }]],
    rdp: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
    folder: [['path', { d: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' }]],
    refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 11-2.12-9.36L23 10' }]],
    alert: [['path', { d: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 8v5M12 16v.5' }]],
    link: [['path', { d: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71' }]],
    shield: [['path', { d: 'M12 2 4 5v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V5l-8-3z' }]],
    check: [['polyline', { points: '20 6 9 17 4 12' }]],
    settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18' }]],
    sliders: [['path', { d: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12' }], ['circle', { cx: 16, cy: 6, r: 2 }], ['circle', { cx: 10, cy: 12, r: 2 }], ['circle', { cx: 18, cy: 18, r: 2 }]],
    arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
    power: [['path', { d: 'M12 3v9' }], ['path', { d: 'M6.3 6.3a8 8 0 1011.4 0' }]],
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

  // ── Small building blocks shared by page + dialogs ──
  // Coloured type chip (HTTPS teal, TCP blue, UDP purple).
  function typeChip(type, extra) {
    const ty = String(type || '').toUpperCase();
    return el('span', { class: 'rt-chip rt-chip-' + ty.toLowerCase() + (extra ? ' ' + extra : ''), text: ty });
  }

  function accessTag(access) {
    return access === 'external'
      ? el('span', { class: 'rt-access rt-access-ext', text: t('host.access_external') })
      : el('span', { class: 'rt-access', text: t('host.access_internal') });
  }
  function verificationTag(zone) {
    const v = zone && zone.verification;
    if (v === 'verified') return el('span', { class: 'rt-tag rt-tag-green zn-dns', text: t('zones.dns_verified') });
    if (v === 'failed') return el('span', { class: 'rt-tag rt-tag-red zn-dns', text: t('zones.dns_failed') });
    if (v) return el('span', { class: 'rt-tag rt-tag-amber zn-dns', text: t('zones.dns_pending') });
    return null;
  }
  function healthDot(health) {
    return el('span', { class: 'zn-dot rt-dot zn-dot-' + (health || 'ok'), 'aria-hidden': 'true' });
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
  // "Gateway home-gw" / "Pool „x“" / "VPN-Peer office-server".
  function targetText(g) {
    if (!g || !g.kind) return t('zones.gateway_none');
    if (g.kind === 'pool') return t('zones.gateway_pool', { name: g.name || ('#' + g.pool_id) });
    return t(g.kind === 'peer' ? 'zones.target_peer_name' : 'zones.target_gateway_name', { name: g.name || g.ip || ('#' + g.peer_id) });
  }
  function ibtn(iconName, label, onClick, extraClass) {
    return el('button', {
      type: 'button', class: 'zn-ibtn rt-ibtn' + (extraClass ? ' ' + extraClass : ''), title: label, 'aria-label': label,
      on: { click: (e) => { e.stopPropagation(); onClick(e.currentTarget, e); } },
    }, [icon(iconName, 15)]);
  }
  // Real <button role="switch">; onToggle(next, node) decides what happens.
  function switchEl(on, label, onToggle, opts) {
    const o = opts || {};
    const node = el('button', {
      type: 'button', class: 'rt-switch' + (on ? ' on' : '') + (o.className ? ' ' + o.className : ''), role: 'switch',
      'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled: !!o.disabled,
    }, [el('span', { class: 'rt-switch-knob', 'aria-hidden': 'true' })]);
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = node.getAttribute('aria-checked') !== 'true';
      if (onToggle(next, node) === false) return;
      setSwitch(node, next);
    });
    return node;
  }
  function setSwitch(node, on) {
    node.classList.toggle('on', !!on);
    node.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  // Segmented control: buttons with aria-pressed. items: [{ value, label, disabled, title }].
  function seg(items, value, onPick, opts) {
    const o = opts || {};
    const group = el('div', { class: 'rt-seg' + (o.small ? ' rt-seg-sm' : '') + (o.className ? ' ' + o.className : ''), role: 'group', 'aria-label': o.label || null, 'aria-labelledby': o.labelledBy || null });
    items.forEach((it) => {
      const b = el('button', {
        type: 'button', class: 'rt-seg-btn', 'aria-pressed': it.value === value ? 'true' : 'false',
        disabled: !!it.disabled, title: it.title || null, dataset: { value: String(it.value) },
        text: it.label,
      });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        group.querySelectorAll('.rt-seg-btn').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        onPick(it.value);
      });
      group.appendChild(b);
    });
    return group;
  }
  function proChip() { return el('span', { class: 'rt-pro', text: t('zones.pro') }); }
  let uid = 0;
  function nextId(p) { uid += 1; return (p || 'rt') + '-' + uid; }
  // Label + control (+ hint) with a real <label for>.
  function field(label, control, opts) {
    const o = opts || {};
    if (!control.id) control.id = nextId('rtf');
    return el('div', { class: 'rt-field' + (o.className ? ' ' + o.className : '') }, [
      el('label', { class: 'rt-label', htmlFor: control.id, text: label }),
      o.wrap || control,
      o.hint ? el('div', { class: 'rt-hint' + (o.hintClass ? ' ' + o.hintClass : ''), text: o.hint }) : null,
    ]);
  }

  // ── Protection shield (docs/feature-release-b.md §9) ──
  function protectionLabel(key, p) {
    if (key === 'auth') return p && p.auth === 'basic' ? t('shield.auth_basic') : p && p.auth === 'route_auth' ? t('shield.auth_route') : t('shield.auth');
    if (key === 'waf') return p && p.waf === 'block' ? t('shield.waf_block') : p && p.waf === 'detect' ? t('shield.waf_detect') : t('shield.waf');
    return t('shield.' + key);
  }
  function shieldText(s) {
    const lines = [t('shield.count', { count: s.count })];
    lines.push(t('shield.active') + ': ' + (s.active.length ? s.active.map((k) => protectionLabel(k, s.protections)).join(', ') : t('shield.none')));
    if (s.missing.length) lines.push(t('shield.missing') + ': ' + s.missing.map((k) => protectionLabel(k, s.protections)).join(', '));
    if (!s.public) lines.push(t('shield.internal'));
    return lines.join('\n');
  }
  function shieldEl(entry, opts) {
    const s = V.entryShield(entry);
    // Internal entries without any protection have nothing to say — no "0" noise.
    if (!s || (!s.public && !s.count)) return null;
    const o = opts || {};
    const text = shieldText(s);
    const btn = el('button', {
      type: 'button', class: 'sh-shield sh-shield-' + s.level + (s.count ? '' : ' sh-shield-zero'),
      title: text, 'aria-label': text.split('\n').join('. '), 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      dataset: { count: String(s.count), level: s.level, missing: s.missing.join(' ') },
    }, [icon('shield', 12), el('span', { class: 'sh-shield-n', text: String(s.count) })]);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pick = (k, act) => (o.onPick ? () => o.onPick(k, act) : () => {});
      const items = [{ heading: t('shield.active') }];
      if (s.active.length) s.active.forEach((k) => items.push({ icon: 'check', cls: 'sh-mi-on', label: protectionLabel(k, s.protections), onClick: pick(k, true) }));
      else items.push({ label: t('shield.none'), disabled: true, cls: 'sh-mi-none' });
      if (s.missing.length) {
        items.push({ heading: t('shield.missing') });
        s.missing.forEach((k) => items.push({ icon: 'alert', cls: 'sh-mi-off', label: protectionLabel(k, s.protections), sub: o.onPick ? t('shield.fix') : null, onClick: pick(k, false) }));
      }
      if (!s.public) items.push({ heading: t('shield.internal') });
      openMenu(btn, items);
    });
    return btn;
  }

  // ── Popup menu (one at a time, fixed-positioned so dialog scroll never clips it) ──
  let menuState = null;
  const menuCloseHooks = [];
  function closeMenu(restoreFocus) {
    if (!menuState) return;
    const m = menuState;
    menuState = null;
    m.node.remove();
    document.removeEventListener('mousedown', m.outside, true);
    document.removeEventListener('keydown', m.key, true);
    window.removeEventListener('resize', m.resize);
    document.removeEventListener('scroll', m.scroll, true);
    if (m.anchor) {
      m.anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && document.contains(m.anchor)) m.anchor.focus();
    }
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
      if (it.heading) return el('div', { class: 'sh-menu-head', role: 'presentation', text: it.heading });
      return el('button', {
        type: 'button', role: 'menuitem', class: 'zn-menu-item' + (it.danger ? ' danger' : '') + (it.cls ? ' ' + it.cls : ''), disabled: !!it.disabled,
        title: it.hint || null,
        on: { click: (e) => { e.stopPropagation(); closeMenu(); it.onClick(); } },
      }, [it.icon ? icon(it.icon, 14) : null, el('span', { text: it.label }), it.sub ? el('span', { class: 'zn-menu-sub', text: it.sub }) : null]);
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
    const items$ = () => Array.from(node.querySelectorAll('.zn-menu-item:not([disabled])'));
    const m = {
      node, anchor,
      outside: (e) => { if (!node.contains(e.target) && !anchor.contains(e.target)) closeMenu(); },
      key: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(true); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const list = items$();
          if (!list.length) return;
          e.preventDefault();
          const i = list.indexOf(document.activeElement);
          const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
          list[n].focus();
        } else if (e.key === 'Tab') { closeMenu(); }
      },
      scroll: (e) => { if (!node.contains(e.target)) closeMenu(); },
      resize: () => closeMenu(),
    };
    menuState = m;
    document.addEventListener('mousedown', m.outside, true);
    document.addEventListener('keydown', m.key, true);
    window.addEventListener('resize', m.resize);
    document.addEventListener('scroll', m.scroll, true);
    const first = items$()[0];
    if (first) first.focus();
  }

  // ── Dialog stacking: the topmost visible overlay owns Escape and Tab ──
  // Overlays: rt dialogs (z 1000) < entry editor (1050) < small dialogs
  // (.zn-dialog 1100). Highest z-index wins, later in the DOM on a tie.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function topOverlay() {
    let best = null;
    let bestZ = -Infinity;
    document.querySelectorAll('.modal-overlay').forEach((o) => {
      if (o.style.display === 'none') return;
      const cs = window.getComputedStyle(o);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const z = parseInt(cs.zIndex, 10) || 0;
      if (z >= bestZ) { best = o; bestZ = z; }
    });
    return best;
  }
  function visibleFocusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }
  // Tab / Shift+Tab stays inside `box`. Returns true when the key was handled.
  function trapTab(e, box) {
    if (e.key !== 'Tab') return false;
    const list = visibleFocusables(box);
    if (!list.length) { e.preventDefault(); return true; }
    const first = list[0];
    const last = list[list.length - 1];
    const inside = box.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    return true;
  }

  // Small dialogs (confirm / prompt / scan / add domain) above everything.
  function dialog(opts) {
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const closeBtn = el('button', { type: 'button', class: 'modal-close', 'aria-label': t('common.close') }, [icon('x', 16)]);
    const body = el('div', { class: 'modal-body zn-dialog-body' });
    const foot = el('div', { class: 'modal-foot zn-dialog-foot' });
    const titleId = nextId('zn-dlg');
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
    // Capture phase so app.js's global Escape (which hides every overlay)
    // never sees it while a dialog is on top.
    function onKey(e) {
      if (topOverlay() !== overlay) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      else if (e.key === 'Tab') { e.stopPropagation(); trapTab(e, box); }
      else if (e.key === 'Enter' && opts.onEnter && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); opts.onEnter(); }
    }
    closeBtn.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    return { overlay, body, foot, close, promise };
  }

  // Large dialogs of the redesign (Host bearbeiten, Neuer Host,
  // Domain-Einstellungen): head with icon, title and sub line, scrolling body,
  // footer. Escape / × / cancel ask opts.beforeClose() first (unsaved
  // changes); focus is trapped inside and returns to the opener on close.
  // → { overlay, box, sub, body, foot, close(result), requestClose(), promise }
  function bigDialog(opts) {
    const o = opts || {};
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });
    const titleId = nextId('rt-dlg');
    const closeBtn = el('button', { type: 'button', class: 'rt-dlg-close', 'aria-label': t('common.close') }, [icon('x', 18)]);
    const sub = el('div', { class: 'rt-dlg-sub' });
    const body = el('div', { class: 'rt-dlg-body' });
    const foot = el('div', { class: 'rt-dlg-foot' });
    const box = el('div', {
      class: 'rt-dlg' + (o.className ? ' ' + o.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    }, [
      el('div', { class: 'rt-dlg-head' }, [
        el('span', { class: 'rt-dlg-icon' + (o.iconClass ? ' ' + o.iconClass : ''), 'aria-hidden': 'true' }, [icon(o.icon || 'settings', 19)]),
        el('div', { class: 'rt-dlg-titles' }, [el('h2', { class: 'rt-dlg-title', id: titleId, text: o.title || '' }), sub]),
        closeBtn,
      ]),
      body, foot,
    ]);
    const overlay = el('div', { class: 'modal-overlay rt-overlay', style: 'display:flex', dataset: { rtDialog: o.kind || 'dialog' } }, [box]);
    const prevFocus = document.activeElement;
    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (!document.querySelector('.modal-overlay[style*="display: flex"], .modal-overlay[style*="display:flex"]')) document.body.classList.remove('rt-dialog-open');
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
      resolveFn(result);
    }
    async function requestClose() {
      if (o.beforeClose) {
        const ok = await o.beforeClose();
        if (!ok) return false;
      }
      close(null);
      return true;
    }
    function onKey(e) {
      if (topOverlay() !== overlay) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); requestClose(); }
      else if (e.key === 'Tab') { e.stopPropagation(); trapTab(e, box); }
    }
    closeBtn.addEventListener('click', () => requestClose());
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    document.body.classList.add('rt-dialog-open');
    return { overlay, box, sub, body, foot, close, requestClose, promise, titleId };
  }

  function confirmDialog(o) {
    const d = dialog({ title: o.title || t('common.confirm') });
    d.body.appendChild(el('p', { class: 'zn-dialog-msg', text: o.message }));
    if (o.detail) d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: o.detail }));
    if (o.list && o.list.length) d.body.appendChild(el('ul', { class: 'rt-confirm-list' }, o.list.map((x) => el('li', { text: x }))));
    const ok = el('button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okLabel || t('common.confirm'), on: { click: () => d.close(true) } });
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: o.cancelLabel || t('common.cancel'), on: { click: () => d.close(false) } }));
    d.foot.appendChild(ok);
    ok.focus();
    return d.promise.then((r) => r === true);
  }

  // "Änderungen verwerfen?" before a dirty dialog closes.
  function confirmDiscard(count) {
    return confirmDialog({
      title: t('zones.discard_title'), message: t(count === 1 ? 'zones.discard_msg_one' : 'zones.discard_msg', { count }),
      okLabel: t('zones.discard_ok'), cancelLabel: t('zones.discard_keep'), danger: true,
    });
  }

  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  const UI = window.GCZonesUI = {
    t, el, append, icon, call, errMsg, toastOk, toastError, portConflict, fmtTime, busy,
    typeChip, accessTag, verificationTag, healthDot, hostStatusText, gatewayIconName, gatewayLabel, targetText,
    ibtn, switchEl, setSwitch, seg, proChip, field, nextId, openMenu, closeMenu, menuOpen, onMenuClosed,
    dialog, bigDialog, confirm: confirmDialog, confirmDiscard, topOverlay, trapTab,
    lsGet, lsSet, shieldEl, shieldText, protectionLabel,
  };

  if (!V) return;

  // Page context (zones-page.js binds getData / reload / lastSync).
  let ctx = { getData: () => null, reload: () => Promise.resolve(), lastSync: () => null };
  function bind(c) { ctx = Object.assign(ctx, c || {}); }
  UI.ctx = () => ctx;

  function zoneById(domainId) {
    const data = ctx.getData();
    if (!data) return null;
    const z = (data.zones || []).find((x) => x.domain_id === Number(domainId));
    return z ? Object.assign({}, z, { hosts: V.sortHosts(z.hosts) }) : null;
  }
  function peerKind(zone) { return !!zone && !!zone.gateway && zone.gateway.kind === 'peer'; }

  // Gateway / pool / peer choices for the domain target select.
  let peersCache = null;
  function loadPeers() {
    if (peersCache) return Promise.resolve(peersCache);
    return api.get('/api/routes/peers').then((res) => { peersCache = (res && res.peers) || []; return peersCache; }).catch(() => { peersCache = []; return peersCache; });
  }
  function targetGroups(zone) {
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
      groups.push({ label: t('zones.gw_group_gateways'), items: gws.map((g) => ({ key: 'gateway:' + g.id, label: (g.name || '#' + g.id) + (g.online === false ? ' · ' + t('zones.offline') : ' · ' + t('zones.online')), off: g.online === false })) });
      const pools = data.pools || [];
      if (pools.length) groups.push({ label: t('zones.gw_group_pools'), items: pools.map((p) => ({ key: 'pool:' + p.id, label: t('zones.gateway_pool', { name: p.name }) })) });
    }
    return groups;
  }

  // ─── Domain-Einstellungen (GCDomainModal) ───────────────────────────────
  // Target (gateway / pool / peer, confirm with the affected hosts), the
  // standards for new entries (access, HSTS, WAF, TLS minimum) with one
  // "also apply to the n existing entries" box, DNS & certificates. Saved
  // explicitly with PUT /domains/:id/gateway and PUT /domains/:id/defaults.
  const WAF_LEVELS = [1, 2, 3, 4];
  let dm = null;   // { domainId, dlg, st, initial, render }

  function wafDefaultOf(zone) {
    const d = zone && zone.waf_default;
    const paranoia = d && WAF_LEVELS.indexOf(Number(d.paranoia)) !== -1 ? Number(d.paranoia) : 1;
    if (!d || typeof d !== 'object' || !d.enabled) return { mode: 'off', paranoia };
    return { mode: d.mode === 'block' ? 'block' : 'detect', paranoia };
  }
  // Canonical { enabled, max_age, include_subdomains, preload } (hsts-ui.js).
  function hstsDefaultOf(zone) {
    const H = window.GCHstsUI;
    if (H && typeof H.fromZone === 'function') return H.fromZone(zone);
    const d = (zone && zone.hsts_default) || {};
    return { enabled: !!d.enabled, max_age: d.max_age || 31536000, include_subdomains: !!d.include_subdomains, preload: !!d.preload };
  }
  function hstsHeader(cfg) {
    const H = window.GCHstsUI;
    return H && typeof H.headerValue === 'function' ? H.headerValue(cfg) : 'max-age=' + cfg.max_age;
  }
  function zoneHttpEntries(zone) {
    const out = [];
    ((zone && zone.hosts) || []).forEach((h) => (h.entries || []).forEach((e) => { if (!V.isL4(e) && !e.rdp_owned) out.push(e); }));
    return out;
  }
  function settingsState(zone) {
    const h = hstsDefaultOf(zone);
    return {
      target: V.zoneGatewayKey(zone) || '',
      external: !!zone.default_external_enabled,
      hsts: { enabled: !!h.enabled, max_age: h.max_age, include_subdomains: !!h.include_subdomains, preload: !!h.preload },
      waf: wafDefaultOf(zone),
      tls: window.GCSecOptUI ? window.GCSecOptUI.zoneTlsMin(zone) : (zone.tls_min_version === '1.3' ? '1.3' : '1.2'),
      apply: false,
    };
  }
  function settingsChanges(a, b) {
    const out = [];
    if (a.target !== b.target) out.push('target');
    if (a.external !== b.external) out.push('external');
    if (JSON.stringify(a.hsts) !== JSON.stringify(b.hsts)) out.push('hsts');
    if (a.waf.mode !== b.waf.mode || (a.waf.mode !== 'off' && a.waf.paranoia !== b.waf.paranoia)) out.push('waf');
    if (a.tls !== b.tls) out.push('tls');
    if (b.apply) out.push('apply');
    return out;
  }

  function openSettings(domainId) {
    const zone = zoneById(domainId);
    if (!zone) { toastError(t('zones.domain_gone')); return; }
    if (dm) dm.dlg.close(null);
    const st = settingsState(zone);
    const initial = JSON.parse(JSON.stringify(st));
    const dlg = bigDialog({
      title: t('zones.settings_title'), icon: 'globe', kind: 'domain-settings', className: 'rt-dlg-settings',
      beforeClose: () => {
        const n = settingsChanges(initial, st).length;
        return n ? confirmDiscard(n) : Promise.resolve(true);
      },
    });
    dm = { domainId: Number(domainId), dlg, st, initial, saving: false };
    dlg.promise.then(() => { if (dm && dm.dlg === dlg) dm = null; });
    if (peerKind(zone) && !(ctx.getData() || {}).peers && !peersCache) loadPeers().then(() => { if (dm && dm.dlg === dlg) renderSettings(); });
    renderSettings();
    const first = dlg.body.querySelector('select, button');
    if (first) first.focus();
  }

  function renderSettings() {
    if (!dm) return;
    const zone = zoneById(dm.domainId);
    if (!zone) { dm.dlg.close(null); toastError(t('zones.domain_gone')); return; }
    const { dlg, st, initial } = dm;
    const c = V.countEntries(zone);
    dlg.sub.replaceChildren(
      el('span', { class: 'rt-mono rt-strong', text: zone.domain }), ' · ',
      t('zones.settings_counts', { hosts: c.hosts, entries: c.entries }),
    );
    const scroll = dlg.body.scrollTop;
    const nodes = [];

    // ── 1 · Target ──
    const sel = el('select', { class: 'rt-select', id: 'rt-ds-target' });
    let found = !st.target;
    if (!st.target) sel.appendChild(el('option', { value: '', text: t('zones.gateway_none') }));
    targetGroups(zone).forEach((g) => {
      if (!g.items.length) return;
      const og = el('optgroup', { label: g.label });
      g.items.forEach((it) => { if (it.key === st.target) found = true; og.appendChild(el('option', { value: it.key, text: it.label })); });
      sel.appendChild(og);
    });
    if (!found) sel.appendChild(el('option', { value: st.target, text: gatewayLabel(zone.gateway) }));
    sel.value = st.target;
    sel.addEventListener('change', () => { st.target = sel.value; syncFoot(); });
    const following = zone.hosts.filter((h) => !h.gateway_override);
    const targetHint = zone.gateway && zone.gateway.online === false
      ? el('div', { class: 'rt-hint rt-hint-warn' }, [icon('alert', 12), ' ', t('zones.gateway_offline_hint')])
      : el('div', { class: 'rt-hint', text: t('zones.settings_target_hint') });
    nodes.push(el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-ds-s1' }, [
      el('h3', { class: 'rt-sec-title', id: 'rt-ds-s1', text: t('zones.settings_target') }),
      el('p', { class: 'rt-sec-hint', text: t('zones.settings_target_intro', { count: following.length }) }),
      field(t(peerKind(zone) ? 'zones.target_peer_label' : 'zones.settings_target_label'), sel, {}),
      targetHint,
    ]));

    // ── 2 · Standards for new entries ──
    const rows = [];
    const accId = nextId('rt-ds-acc');
    rows.push(el('div', { class: 'rt-ds-row' }, [
      el('div', { class: 'rt-ds-text' }, [el('div', { class: 'rt-ds-label', id: accId, text: t('zones.default_access') }), el('div', { class: 'rt-hint', text: t('zones.settings_access_hint') })]),
      seg([{ value: 'ext', label: t('zones.default_external') }, { value: 'int', label: t('zones.default_internal') }],
        st.external ? 'ext' : 'int', (v) => { st.external = v === 'ext'; syncFoot(); }, { labelledBy: accId }),
    ]));
    // HSTS: switch + (when on) max-age / includeSubDomains / preload.
    const H = window.GCHstsUI;
    const hstsRow = el('div', { class: 'rt-ds-row rt-ds-hsts' });
    const hstsDetails = el('div', { class: 'rt-ds-details' });
    function renderHsts() {
      hstsDetails.replaceChildren();
      hstsDetails.hidden = !st.hsts.enabled;
      if (st.hsts.enabled && H && typeof H.fieldsEl === 'function') {
        const fields = H.fieldsEl(Object.assign({}, st.hsts, { enabled: true }), {
          className: 'hs-def-fields', onChange: (next) => {
            const prev = st.hsts.preload;
            st.hsts = { enabled: true, max_age: next.max_age, include_subdomains: !!next.include_subdomains, preload: !!next.preload };
            // A newly set preload is practically irreversible: confirm it.
            if (st.hsts.preload && !prev && typeof H.confirmPreload === 'function') {
              H.confirmPreload().then((ok) => { if (!ok) { st.hsts.preload = false; fields.set(Object.assign({}, st.hsts)); } syncFoot(); });
            }
            syncFoot();
          },
        });
        hstsDetails.appendChild(fields.node);
      }
    }
    hstsRow.appendChild(el('div', { class: 'rt-ds-text' }, [el('div', { class: 'rt-ds-label', text: t('hsts.title') }), el('div', { class: 'rt-hint', text: t('zones.settings_hsts_hint') })]));
    hstsRow.appendChild(switchEl(st.hsts.enabled, t('hsts.title'), (next) => { st.hsts.enabled = next; renderHsts(); syncFoot(); }));
    renderHsts();
    rows.push(el('div', { class: 'rt-ds-block' }, [hstsRow, hstsDetails]));
    // WAF: mode + paranoia; locked without the licence.
    const locked = GC.features.waf === false;
    const mode = el('select', { class: 'rt-select rt-select-auto sh-wafdef-mode', disabled: locked, 'aria-label': t('zones.wafdef.label') + ' – ' + t('waf.mode_label') }, [
      el('option', { value: 'off', text: t('zones.wafdef.off') }),
      el('option', { value: 'detect', text: t('waf.mode_detect') }),
      el('option', { value: 'block', text: t('waf.mode_block') }),
    ]);
    mode.value = st.waf.mode;
    const level = el('select', { class: 'rt-select rt-select-auto sh-wafdef-level', disabled: locked || st.waf.mode === 'off', 'aria-label': t('zones.wafdef.label') + ' – ' + t('waf.paranoia_label') },
      WAF_LEVELS.map((n) => el('option', { value: String(n), text: t('waf.paranoia_level', { n }) })));
    level.value = String(st.waf.paranoia);
    mode.addEventListener('change', () => { st.waf.mode = mode.value; level.disabled = locked || st.waf.mode === 'off'; syncFoot(); });
    level.addEventListener('change', () => { st.waf.paranoia = parseInt(level.value, 10) || 1; syncFoot(); });
    rows.push(el('div', { class: 'rt-ds-row sh-wafdef' + (locked ? ' rt-locked' : ''), dataset: { wafDefault: st.waf.mode } }, [
      el('div', { class: 'rt-ds-text' }, [
        el('div', { class: 'rt-ds-label' }, [t('waf.title'), locked ? proChip() : null]),
        el('div', { class: 'rt-hint', text: locked ? t('waf.err.license') : t('zones.settings_waf_hint') }),
      ]),
      el('div', { class: 'rt-ds-ctrl' }, [mode, level]),
    ]));
    // TLS minimum.
    const tlsId = nextId('rt-ds-tls');
    rows.push(el('div', { class: 'rt-ds-row' }, [
      el('div', { class: 'rt-ds-text' }, [el('div', { class: 'rt-ds-label', id: tlsId, text: t('tls_profile.label') }), el('div', { class: 'rt-hint', text: t('zones.settings_tls_hint') })]),
      seg([{ value: '1.2', label: t('tls_profile.v12') }, { value: '1.3', label: t('tls_profile.v13') }], st.tls, (v) => { st.tls = v; syncFoot(); }, { labelledBy: tlsId, className: 'so-tls-min' }),
    ]));
    // "Also apply to the n existing entries" + preview.
    const httpEntries = zoneHttpEntries(zone);
    const httpsEntries = httpEntries.filter((e) => V.isHttpsEntry(e));
    const nExisting = httpEntries.length;
    const applyCb = el('input', { type: 'checkbox', class: 'rt-check-input', checked: st.apply, disabled: !nExisting });
    const preview = el('div', { class: 'rt-apply-preview', role: 'status' });
    function renderPreview() {
      preview.replaceChildren();
      preview.hidden = !st.apply;
      if (!st.apply) return;
      const items = [];
      items.push(st.hsts.enabled
        ? t('zones.apply_hsts_on', { n: httpsEntries.length, value: hstsHeader(st.hsts) })
        : t('zones.apply_hsts_off', { n: httpsEntries.length }));
      if (!locked || st.waf.mode === 'off') {
        items.push(st.waf.mode === 'off' ? t('zones.apply_waf_off', { n: httpEntries.length })
          : t('zones.apply_waf_on', { n: httpEntries.length, value: t(st.waf.mode === 'block' ? 'waf.mode_block' : 'waf.mode_detect') + ' · ' + t('waf.paranoia_level', { n: st.waf.paranoia }) }));
      }
      items.push(t('zones.apply_access_note'));
      preview.appendChild(el('ul', { class: 'rt-apply-list' }, items.map((x) => el('li', { text: x }))));
    }
    applyCb.addEventListener('change', () => { st.apply = applyCb.checked; renderPreview(); syncFoot(); });
    renderPreview();
    rows.push(el('label', { class: 'rt-apply' + (nExisting ? '' : ' rt-disabled') }, [
      applyCb,
      el('span', {}, [
        el('strong', { text: nExisting ? t('zones.apply_existing_label', { n: nExisting }) : t('zones.apply_existing_none') }),
        el('span', { class: 'rt-hint rt-block', text: t('zones.apply_existing_hint') }),
      ]),
    ]));
    rows.push(preview);
    nodes.push(el('section', { class: 'rt-sec rt-sec-card', 'aria-labelledby': 'rt-ds-s2' }, [
      el('h3', { class: 'rt-sec-title', id: 'rt-ds-s2', text: t('zones.settings_defaults') }),
      el('p', { class: 'rt-sec-hint', text: t('zones.settings_defaults_intro') }),
      rows,
    ]));

    // ── 3 · DNS & certificates ──
    const v = zone.verification;
    const dnsText = v === 'verified' ? t('zones.settings_dns_ok') : v === 'failed' ? t('zones.settings_dns_failed') : t('zones.settings_dns_pending');
    const tg = window.GCTlsUI && window.GCTlsUI.dnsTag(zone, { onChanged: () => ctx.reload() });
    const recheck = el('button', { type: 'button', class: 'btn btn-secondary rt-btn', text: t('zones.reverify') });
    recheck.addEventListener('click', async () => {
      busy(recheck, true);
      try {
        const res = await call(api.post('/api/settings/domains/' + zone.domain_id + '/verify', {}));
        const status = res.data && res.data.status;
        if (status === 'verified') toastOk(t('zones.reverify_ok', { domain: zone.domain }));
        else toastError(t('zones.reverify_pending', { domain: zone.domain }));
        await ctx.reload();
      } catch (err) { toastError(err); } finally { busy(recheck, false); }
    });
    nodes.push(el('section', { class: 'rt-sec', 'aria-labelledby': 'rt-ds-s3' }, [
      el('h3', { class: 'rt-sec-title', id: 'rt-ds-s3', text: t('zones.settings_dns') }),
      el('div', { class: 'rt-dns-card' }, [
        el('span', { class: 'rt-dot rt-dot-lg zn-dot-' + (v === 'verified' ? 'ok' : v === 'failed' ? 'down' : 'degraded'), 'aria-hidden': 'true' }),
        el('div', { class: 'rt-dns-text' }, [
          el('div', { class: 'rt-strong', text: dnsText }),
          el('div', { class: 'rt-hint', text: t('zones.settings_dns_hint', { time: fmtTime(ctx.lastSync()) }) }),
          tg,
        ]),
        recheck,
      ]),
      el('p', { class: 'rt-sec-hint' }, [t('zones.settings_more'), ' ', el('a', { href: '/settings', class: 'rt-link', text: t('zones.settings_more_link') })]),
    ]));

    dlg.body.replaceChildren(...nodes);
    dlg.body.scrollTop = scroll;

    // ── Footer ──
    const note = el('span', { class: 'rt-dlg-note', 'aria-live': 'polite' });
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost rt-btn', text: t('common.cancel'), on: { click: () => dlg.requestClose() } });
    const save = el('button', { type: 'button', class: 'btn btn-primary rt-btn rt-ds-save', text: t('common.save'), on: { click: () => saveSettings(zone) } });
    function syncFoot() {
      const n = settingsChanges(initial, st).length;
      note.textContent = n ? t(n === 1 ? 'zones.dirty_one' : 'zones.dirty', { count: n }) : t('zones.no_changes');
      note.classList.toggle('rt-dirty', n > 0);
      save.disabled = !n || dm.saving;
    }
    dm.syncFoot = syncFoot;
    dlg.foot.replaceChildren(note, cancel, save);
    syncFoot();
  }

  async function saveSettings(zone) {
    if (!dm || dm.saving) return;
    const { st, initial, dlg } = dm;
    const changes = settingsChanges(initial, st);
    if (!changes.length) return;
    const saveBtn = dlg.foot.querySelector('.rt-ds-save');
    // Target change: confirm with the affected hosts first.
    if (changes.indexOf('target') !== -1) {
      const following = zone.hosts.filter((h) => !h.gateway_override);
      const entries = following.reduce((n, h) => n + (h.entries || []).filter((e) => !e.rdp_owned).length, 0);
      const overrides = zone.hosts.length - following.length;
      const label = (() => { const o = dlg.body.querySelector('#rt-ds-target'); return o && o.options[o.selectedIndex] ? o.options[o.selectedIndex].textContent : st.target; })();
      const ok = await confirmDialog({
        title: t(peerKind(zone) ? 'zones.target_peer_confirm_title' : 'zones.gateway_confirm_title'),
        message: t('zones.gateway_confirm', { domain: zone.domain, target: label, hosts: following.length, entries }),
        detail: overrides ? t('zones.gateway_confirm_overrides', { count: overrides }) : null,
        list: following.slice(0, 12).map((h) => h.fqdn || V.hostLabel(h)).concat(following.length > 12 ? ['…'] : []),
        okLabel: t('zones.gateway_confirm_ok'),
      });
      if (!ok) return;
    }
    if (changes.indexOf('tls') !== -1 && st.tls === '1.3' && window.GCSecOptUI && typeof window.GCSecOptUI.confirmTlsProfile === 'function') {
      if (!(await window.GCSecOptUI.confirmTlsProfile(zone, '1.3'))) return;
    }
    dm.saving = true;
    busy(saveBtn, true);
    try {
      if (changes.indexOf('target') !== -1) {
        await call(api.put('/api/v1/domains/' + zone.domain_id + '/gateway', V.parseGatewayKey(st.target)));
        initial.target = st.target;
      }
      const body = {};
      if (changes.indexOf('external') !== -1) body.default_external_enabled = st.external;
      if (changes.indexOf('hsts') !== -1 || st.apply) {
        body.hsts_default = st.hsts.enabled
          ? { enabled: true, max_age: st.hsts.max_age, include_subdomains: st.hsts.include_subdomains, preload: st.hsts.preload }
          : null;
      }
      if (changes.indexOf('waf') !== -1) body.waf_default = st.waf.mode === 'off' ? null : { enabled: true, mode: st.waf.mode, paranoia: st.waf.paranoia };
      if (changes.indexOf('tls') !== -1) body.tls_min_version = st.tls;
      if (st.apply) {
        body.apply_hsts_to_existing = true;
        // Enabling the WAF on existing entries needs the licence; switching it off does not.
        if (GC.features.waf !== false || st.waf.mode === 'off') body.apply_waf_to_existing = true;
      }
      let applied = null;
      if (Object.keys(body).length) {
        const res = await call(api.put('/api/v1/domains/' + zone.domain_id + '/defaults', body));
        applied = (res.applied || 0) + (res.applied_waf || 0);
      }
      toastOk(st.apply && applied ? t('zones.settings_saved_applied', { n: applied }) : t('zones.settings_saved', { domain: zone.domain }));
      dm.saving = false;
      dlg.close(true);
      await ctx.reload();
    } catch (err) {
      dm.saving = false;
      busy(saveBtn, false);
      if (dm && dm.syncFoot) dm.syncFoot();
      const box = el('div', { class: 'rt-err rt-err-box', role: 'alert', text: errMsg(err) });
      const old = dlg.body.querySelector('.rt-err-box');
      if (old) old.remove();
      dlg.body.prepend(box);
      dlg.body.scrollTop = 0;
      ctx.reload();
    }
  }

  // Called by the page after every GET /zones. The open settings dialog keeps
  // its unsaved choices; only the zone facts (counts, DNS) are redrawn.
  function refresh() {
    if (!dm || dm.saving) return;
    if (menuOpen()) return;
    renderSettings();
  }

  window.GCDomainModal = {
    open: openSettings, close: () => { if (dm) dm.dlg.close(null); }, refresh, bind,
    isOpen: () => !!dm, currentDomainId: () => (dm ? dm.domainId : undefined),
  };

  // ─── LAN discovery ("Im LAN suchen" in "Neuer Host") ─────────────────────
  // docs/feature-tls-guard.md, "LAN-Erkennung". Capability (GET
  // /api/v1/gateways: health.telemetry.lan_discovery + discovery.enabled) and
  // pool members (GET /api/v1/gateway-pools/:id/members) are loaded once per
  // dialog — discReset() runs when "Neuer Host" opens. Pure helpers live in
  // zones-view.js (V.suggestSubdomain, V.entryDraftFromPort, …). Adopting a
  // device only prefills the dialog (onAdopt), nothing is submitted.
  const DISC_SCAN_WAIT_MS = 60000;   // gateway scans stop after 45 s; wait a bit longer
  const DISC_POLL_MS = 5000;         // fallback while a scan runs and no SSE arrives
  const disc = { gateways: null, gatewaysLoading: null, members: {}, membersLoading: {}, pending: false };

  function discReset() {
    disc.gateways = null;
    disc.gatewaysLoading = null;
    disc.members = {};
    disc.membersLoading = {};
    disc.pending = false;
  }

  // Discovery target of a zone: a gateway peer or a pool; null hides the feature.
  function discTarget(zone) {
    const g = zone && !zone.unassigned && zone.gateway;
    if (!g || !g.kind || g.kind === 'peer') return null;
    if (g.kind === 'gateway') return g.peer_id != null ? { kind: 'gateway', peerId: g.peer_id } : null;
    if (g.kind === 'pool') return g.pool_id != null ? { kind: 'pool', poolId: g.pool_id } : null;
    return null;
  }

  function discLoadGateways() {
    if (disc.gateways) return Promise.resolve(disc.gateways);
    if (!disc.gatewaysLoading) {
      disc.gatewaysLoading = api.get('/api/v1/gateways').then((res) => {
        const map = {};
        ((res && res.gateways) || []).forEach((g) => {
          const st = V.discoveryStateOf(g);
          map[String(g.peer_id)] = { id: g.peer_id, name: g.name || g.hostname || ('#' + g.peer_id), capable: st.capable, enabled: st.enabled };
        });
        return map;
      }).catch(() => ({})).then((map) => { disc.gateways = map; disc.gatewaysLoading = null; return map; });
    }
    return disc.gatewaysLoading;
  }

  function discLoadMembers(poolId) {
    const key = String(poolId);
    if (disc.members[key]) return Promise.resolve(disc.members[key]);
    if (!disc.membersLoading[key]) {
      disc.membersLoading[key] = api.get('/api/v1/gateway-pools/' + encodeURIComponent(key) + '/members')
        .then((rows) => (Array.isArray(rows) ? rows : []).filter((m) => m && m.peer_id != null).map((m) => ({ id: m.peer_id, name: m.peer_name })))
        .catch(() => [])
        .then((list) => { disc.members[key] = list; delete disc.membersLoading[key]; return list; });
    }
    return disc.membersLoading[key];
  }

  // Candidate gateways of a zone with their discovery state; null while loading.
  function discCandidates(zone) {
    const tg = discTarget(zone);
    if (!tg || !disc.gateways) return null;
    let ids;
    if (tg.kind === 'gateway') ids = [{ id: tg.peerId }];
    else { ids = disc.members[String(tg.poolId)]; if (!ids) return null; }
    return ids.map((m) => {
      const g = disc.gateways[String(m.id)];
      return { id: m.id, name: m.name || (g && g.name) || ('#' + m.id), capable: !!(g && g.capable), enabled: !!(g && g.enabled), known: !!g };
    });
  }

  function discEnsureLoaded(zone, onReady) {
    const tg = discTarget(zone);
    if (!tg || disc.pending) return;
    const need = [];
    if (!disc.gateways) need.push(discLoadGateways());
    if (tg.kind === 'pool' && !disc.members[String(tg.poolId)]) need.push(discLoadMembers(tg.poolId));
    if (!need.length) return;
    disc.pending = true;
    Promise.all(need).then(() => { disc.pending = false; if (onReady) onReady(); }, () => { disc.pending = false; });
  }

  // Remember a state the discover endpoint reported (409) so the button shows the hint.
  function discMark(peerId, patch) {
    if (!disc.gateways) return;
    disc.gateways[String(peerId)] = Object.assign(disc.gateways[String(peerId)] || { id: peerId, name: '#' + peerId, capable: true, enabled: true }, patch);
  }

  // "Im LAN suchen" button, or a muted hint linking to the gateway page.
  // onAdopt(dev, port) prefills the caller; onReady() re-renders it once the
  // capability has loaded.
  function renderDiscoveryControl(zone, onAdopt, onReady) {
    const tg = discTarget(zone);
    if (!tg) return null;
    discEnsureLoaded(zone, onReady);
    const cands = discCandidates(zone);
    if (!cands) {
      return el('button', { type: 'button', class: 'btn btn-secondary rt-btn zn-disc-btn', disabled: true, title: t('zones.discovery.loading'), 'data-zn-key': 'nhdisc' }, [icon('search', 15), t('zones.discovery.button')]);
    }
    if (cands.some((c) => c.capable && c.enabled)) {
      return el('button', { type: 'button', class: 'btn btn-secondary rt-btn zn-disc-btn', 'data-zn-key': 'nhdisc', on: { click: () => openDiscoveryDialog(zone, onAdopt, onReady) } }, [icon('search', 15), t('zones.discovery.button')]);
    }
    let msg;
    if (tg.kind === 'pool') msg = t('zones.discovery.hint_pool_none');
    else msg = cands[0].capable ? t('zones.discovery.hint_disabled') : t('zones.discovery.hint_unavailable');
    return el('span', { class: 'zn-hint-muted zn-disc-hint' }, [
      msg, ' ', el('a', { href: '/gateways', class: 'zn-link zn-disc-link', text: t('zones.discovery.hint_link') }),
    ]);
  }

  function discErrCode(err) { return err && err.data && err.data.error ? String(err.data.error) : ''; }
  function discIsLicense(err) {
    const d = err && err.data;
    return !!(d && (d.feature === 'gateway_lan_discovery' || /not licensed|feature_not_available/i.test(String(d.error || ''))));
  }
  function discErrText(err) {
    const code = discErrCode(err);
    if (code === 'no_subnet') return t('zones.discovery.err_no_subnet');
    if (code === 'gateway_unreachable') return t('zones.discovery.err_gateway_unreachable');
    return errMsg(err);
  }

  function openDiscoveryDialog(zone, onAdopt, onMarked) {
    const tg = discTarget(zone);
    const cands = discCandidates(zone) || [];
    if (!tg || !cands.length) return;
    const first = cands.find((c) => c.capable && c.enabled) || cands[0];
    const st = { peerId: first.id, devices: [], updatedAt: null, inFlight: false, timedOut: false, q: '', hint: null, error: null, loading: false, waitUntil: 0, marked: false };
    let closed = false;
    let pollTimer = null;
    const cand = () => cands.find((c) => String(c.id) === String(st.peerId)) || cands[0];

    const d = dialog({ title: t('zones.discovery.title'), wide: true });
    d.overlay.classList.add('zn-disc-dialog');

    let gwNode;
    if (tg.kind === 'pool') {
      const sel = el('select', { class: 'form-select zn-select zn-disc-gw', 'aria-label': t('zones.discovery.gateway') },
        cands.map((c) => el('option', { value: String(c.id), text: c.name + (c.capable && c.enabled ? '' : ' · ' + t('zones.discovery.member_unavailable')) })));
      sel.value = String(st.peerId);
      sel.addEventListener('change', () => {
        st.peerId = Number(sel.value);
        st.devices = []; st.updatedAt = null; st.inFlight = false; st.timedOut = false; st.error = null;
        stopPoll();
        load(false);
      });
      gwNode = el('label', { class: 'zn-disc-gwwrap' }, [el('span', { class: 'zn-f-label', text: t('zones.discovery.gateway') }), sel]);
    } else {
      gwNode = el('div', { class: 'zn-disc-gwwrap' }, [
        el('span', { class: 'zn-f-label', text: t('zones.discovery.gateway') }),
        el('span', { class: 'zn-disc-gwname' }, [icon('gateway', 12), first.name]),
      ]);
    }
    const filter = el('input', { type: 'search', class: 'zn-input zn-search-sm zn-disc-filter', placeholder: t('zones.discovery.filter_ph'), 'aria-label': t('zones.discovery.filter'), autocomplete: 'off' });
    filter.addEventListener('input', () => { st.q = filter.value; renderList(); });
    const scanBtn = el('button', { type: 'button', class: 'btn btn-primary zn-btn-sm zn-disc-scan', on: { click: () => scan() } }, [icon('refresh', 12), t('zones.discovery.scan')]);
    const status = el('div', { class: 'zn-disc-status', role: 'status', 'aria-live': 'polite' });
    const hintBox = el('div', { class: 'zn-disc-hintbox', role: 'alert' }, [
      el('span', { class: 'zn-disc-hintmsg' }), ' ', el('a', { href: '/gateways', class: 'zn-link', text: t('zones.discovery.hint_link') }),
    ]);
    hintBox.hidden = true;
    const list = el('div', { class: 'zn-disc-list' });

    d.body.appendChild(el('p', { class: 'zn-dialog-detail', text: t('zones.discovery.intro') }));
    d.body.appendChild(el('div', { class: 'zn-disc-bar' }, [gwNode, el('div', { class: 'zn-search-wrap zn-disc-search' }, [icon('search', 13), filter]), scanBtn]));
    d.body.appendChild(status);
    d.body.appendChild(hintBox);
    d.body.appendChild(list);
    d.foot.appendChild(el('button', { type: 'button', class: 'btn btn-ghost', text: t('common.close'), on: { click: () => d.close(null) } }));

    function setHint(msg) {
      st.hint = msg || null;
      hintBox.querySelector('.zn-disc-hintmsg').textContent = msg || '';
      hintBox.hidden = !msg;
      scanBtn.hidden = !!msg;
    }
    function renderStatus() {
      status.replaceChildren();
      scanBtn.disabled = st.inFlight;
      if (st.inFlight) {
        status.appendChild(el('span', { class: 'zn-disc-spin', 'aria-hidden': 'true' }, [icon('refresh', 12)]));
        status.appendChild(el('span', { class: 'zn-disc-scanning', text: t('zones.discovery.scanning') }));
        return;
      }
      if (st.error) { status.appendChild(el('span', { class: 'zn-disc-err', text: st.error })); return; }
      if (st.timedOut) status.appendChild(el('span', { class: 'zn-disc-warn' }, [icon('alert', 11), ' ', t('zones.discovery.timed_out')]));
      const mins = V.discoveryAgeMinutes(st.updatedAt);
      if (mins != null && st.devices.length) {
        status.appendChild(el('span', { class: 'zn-disc-age', text: mins === 0 ? t('zones.discovery.age_now') : t('zones.discovery.age', { n: mins }) }));
      }
    }
    function renderList() {
      list.replaceChildren();
      const shown = V.filterDiscovered(st.devices, st.q);
      if (!shown.length) {
        const txt = st.devices.length ? t('zones.discovery.no_match') : (st.loading ? t('common.loading') : t('zones.discovery.empty'));
        list.appendChild(el('div', { class: 'zn-disc-empty', text: txt }));
        return;
      }
      shown.forEach((dev) => list.appendChild(renderDeviceRow(dev)));
    }
    function renderDeviceRow(dev) {
      const ports = V.devicePorts(dev);
      const name = dev.hostname ? String(dev.hostname) : t('zones.discovery.no_hostname');
      const chips = ports.length
        ? ports.map((p) => {
          const c = V.classifyDiscoveredPort(p);
          const http = !!(c && c.type === 'http');
          return el('span', { class: 'zn-disc-chip' + (http ? ' zn-disc-chip-http' : ''), text: String(p) + ' ' + (http ? 'HTTPS' : 'TCP') });
        })
        : [el('span', { class: 'zn-muted', text: t('zones.discovery.ports_none') })];
      const info = el('div', { class: 'zn-disc-info' }, [
        el('div', { class: 'zn-disc-name' }, [el('span', { class: 'zn-disc-host', text: name }), el('span', { class: 'zn-disc-sep', text: ' · ' }), el('span', { class: 'zn-disc-ip', text: String(dev.ip || '') })]),
        el('div', { class: 'zn-disc-ports' }, chips),
      ]);
      let portSel = null;
      if (ports.length > 1) {
        portSel = el('select', { class: 'form-select zn-select zn-disc-port', 'aria-label': t('zones.discovery.port') }, ports.map((p) => el('option', { value: String(p), text: String(p) })));
        portSel.value = String(ports[0]);
      }
      const adopt = el('button', {
        type: 'button', class: 'btn btn-secondary zn-btn-sm zn-disc-adopt',
        on: { click: () => { const port = portSel ? Number(portSel.value) : ports[0]; d.close(true); if (onAdopt) onAdopt(dev, port); } },
      }, [icon('plus', 12), t('zones.discovery.adopt')]);
      return el('div', { class: 'zn-disc-row', dataset: { ip: String(dev.ip || '') } }, [
        info,
        portSel ? el('label', { class: 'zn-disc-portwrap' }, [el('span', { class: 'zn-f-label', text: t('zones.discovery.port') }), portSel]) : el('span', { class: 'zn-disc-portwrap' }),
        adopt,
      ]);
    }

    // Snapshot from GET …/discovered or from a gc:gateway_discovery event.
    function apply(snap, fromEvent) {
      const was = st.inFlight;
      st.devices = Array.isArray(snap.devices) ? snap.devices : [];
      if (snap.updated_at != null) st.updatedAt = snap.updated_at; else if (fromEvent) st.updatedAt = Date.now();
      st.inFlight = fromEvent ? !snap.done : !!snap.in_flight;
      st.timedOut = !!snap.timed_out;
      if (st.inFlight) { if (!was) st.waitUntil = Date.now() + DISC_SCAN_WAIT_MS; startPoll(); } else stopPoll();
      renderStatus();
      renderList();
    }
    function startPoll() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (closed || !st.inFlight) { stopPoll(); return; }
        if (Date.now() > st.waitUntil) { stopPoll(); st.inFlight = false; st.timedOut = true; renderStatus(); return; }
        load(true);
      }, DISC_POLL_MS);
    }
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    async function load(quiet) {
      const pid = st.peerId;
      const c = cand();
      if (!(c.capable && c.enabled)) {
        setHint(c.capable ? t('zones.discovery.hint_disabled') : t('zones.discovery.hint_unavailable'));
        st.devices = []; renderStatus(); renderList();
        return;
      }
      setHint(null);
      if (!quiet) { st.loading = true; st.error = null; renderList(); }
      try {
        const res = await api.get('/api/v1/gateways/' + encodeURIComponent(String(pid)) + '/discovered');
        if (closed || pid !== st.peerId) return;
        apply(res || {}, false);
      } catch (err) {
        if (closed || pid !== st.peerId) return;
        if (discIsLicense(err)) setHint(t('zones.discovery.hint_license'));
        else { st.error = t('zones.discovery.err_load', { error: errMsg(err) }); renderStatus(); }
      } finally {
        if (!closed && pid === st.peerId) { st.loading = false; renderList(); }
      }
    }

    async function scan() {
      const pid = st.peerId;
      st.error = null; st.timedOut = false; st.inFlight = true; st.waitUntil = Date.now() + DISC_SCAN_WAIT_MS;
      renderStatus();
      try {
        await call(api.post('/api/v1/gateways/' + encodeURIComponent(String(pid)) + '/discover', {}));
        if (closed || pid !== st.peerId) return;
        startPoll();
      } catch (err) {
        if (closed || pid !== st.peerId) return;
        const code = discErrCode(err);
        if (code === 'scan_in_progress') { startPoll(); return; } // keep waiting for the running scan
        st.inFlight = false;
        if (discIsLicense(err)) setHint(t('zones.discovery.hint_license'));
        else if (code === 'discovery_disabled') { discMark(pid, { enabled: false }); st.marked = true; setHint(t('zones.discovery.hint_disabled')); }
        else if (code === 'capability_unavailable') { discMark(pid, { capable: false }); st.marked = true; setHint(t('zones.discovery.hint_unavailable')); }
        else st.error = t('zones.discovery.err_scan', { error: discErrText(err) });
        renderStatus();
      }
    }

    const onEvent = (e) => {
      const p = (e && e.detail) || {};
      if (closed || String(p.peer_id) !== String(st.peerId)) return;
      apply({ devices: p.devices, done: p.done, timed_out: p.timed_out, updated_at: Date.now() }, true);
    };
    document.addEventListener('gc:gateway_discovery', onEvent);
    d.promise.then(() => {
      closed = true;
      stopPoll();
      document.removeEventListener('gc:gateway_discovery', onEvent);
      if (st.marked && onMarked) onMarked();
    });

    renderStatus();
    renderList();
    load(false);
    filter.focus();
  }

  UI.discovery = { reset: discReset, control: renderDiscoveryControl, open: openDiscoveryDialog, target: discTarget };
  UI.loadPeers = loadPeers;
  UI.targetGroups = targetGroups;
})();
