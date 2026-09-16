'use strict';

// Licence hint (docs/feature-release-b.md §11). Explains why a feature is
// locked — GET /api/v1/license `locked[feature]`:
//   'plan'          the licence carries the feature as false → upgrade, then refresh
//   'not_in_token'  the licence server does not deliver the key yet → refresh
//   'unlicensed'    community mode without a licence → enter a licence
// and offers „Lizenz aktualisieren“ (POST /api/v1/license/refresh; the page
// reloads when the feature is unlocked afterwards).
//
// API (stable — other pages call it):
//   GCLicenseHint.render(featureKey, opts) → HTMLElement (sync, filled once the
//     licence answer is there). opts: { compact: bool, title: string,
//     fallback: string (text until/unless the licence info is known) }
//   GCLicenseHint.mount(container, featureKey, opts) → the hint; replaces the
//     container's content (its text becomes the fallback), idempotent.
//   GCLicenseHint.load({ fresh }) → Promise<licence info> (one request per page)
// Every element with data-license-hint="<feature>" is mounted on load.
// Strings: window.GC.t license_hint.* (layout whitelist). DOM via
// createElement / textContent only — no markup from the server.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCLicenseHint = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  const REASONS = ['plan', 'not_in_token', 'unlicensed'];
  const PRICING_URL = 'https://callmetechie.de/products/gatecontrol/pricing';
  const SETTINGS_TAB_KEY = 'settings-active-tab';

  // 'plan' | 'not_in_token' | 'unlicensed' | null (not locked / unknown)
  function reasonOf(info, key) {
    const locked = info && info.locked && typeof info.locked === 'object' ? info.locked : null;
    if (!locked) return null;
    const r = locked[key];
    return REASONS.indexOf(r) >= 0 ? r : null;
  }
  // Text key + actions for a reason. known=false: licence info unavailable.
  function viewOf(reason, known) {
    if (!known) return { text: 'license_hint.generic', actions: [] };
    if (reason === 'plan') return { text: 'license_hint.plan', actions: ['refresh', 'upgrade'] };
    if (reason === 'not_in_token') return { text: 'license_hint.not_in_token', actions: ['refresh'] };
    if (reason === 'unlicensed') return { text: 'license_hint.unlicensed', actions: ['enter', 'upgrade'] };
    return { text: 'license_hint.unlocked', actions: ['reload'] };
  }
  function planLabel(plan) {
    const s = plan == null ? '' : String(plan).trim();
    if (!s) return '—';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // 'token' | 'plan_default' | 'community' | null — GET /api/v1/license
  // `source[feature]` (docs/feature-next-package.md §S2.3). 'plan_default'
  // means: the licence token does not carry the key, the paid plan switched it
  // on. The licence server should learn the key; this is only the bridge.
  const SOURCES = ['token', 'plan_default', 'community'];
  function sourceOf(info, key) {
    const src = info && info.source && typeof info.source === 'object' ? info.source : null;
    if (!src) return null;
    const s = src[key];
    return SOURCES.indexOf(s) >= 0 ? s : null;
  }

  const pure = { REASONS, PRICING_URL, SOURCES, reasonOf, sourceOf, viewOf, planLabel };
  if (!win || !win.document) return pure;

  // ─── Browser part ──────────────────────────────────────────────────────
  const doc = win.document;
  const FALLBACK = {
    'license_hint.title': 'Not included in your licence',
    'license_hint.generic': 'This feature is locked by the current licence.',
    'license_hint.plan': 'Your licence ({{plan}}) does not include this feature.',
    'license_hint.not_in_token': 'This feature is not in your licence token yet. Refreshing fetches the current state.',
    'license_hint.unlicensed': 'GateControl runs without a licence (community mode).',
    'license_hint.unlocked': 'Your licence includes this feature now — reload the page.',
    'license_hint.refresh': 'Refresh licence',
    'license_hint.refreshed': 'Licence refreshed — reloading.',
    'license_hint.still_locked': 'Licence refreshed, but the feature is still locked.',
    'license_hint.rate_limited': 'Please wait a minute and try again.',
    'license_hint.failed': 'The licence could not be refreshed.',
    'license_hint.enter': 'Enter licence',
    'license_hint.upgrade': 'See plans',
    'license_hint.reload': 'Reload page',
    'license_hint.plan_default': 'Derived from your plan — not yet in the licence token.',
  };
  function t(key, params) {
    const dict = (win.GC && win.GC.t) || {};
    let s = dict[key] != null ? dict[key] : (FALLBACK[key] != null ? FALLBACK[key] : key);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function el(tag, props, children) {
    const n = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') Object.keys(v).forEach((ev) => n.addEventListener(ev, v[ev]));
      else if (k === 'dataset') Object.keys(v).forEach((d) => { n.dataset[d] = v[d]; });
      else if (k === 'type' || k === 'href' || k === 'target' || k === 'rel' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return n;
  }
  function lockIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['width', '14'], ['height', '14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']].forEach((a) => svg.setAttribute(a[0], a[1]));
    const r = doc.createElementNS(NS, 'rect');
    [['x', '3'], ['y', '11'], ['width', '18'], ['height', '11'], ['rx', '2']].forEach((a) => r.setAttribute(a[0], a[1]));
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', 'M7 11V7a5 5 0 0110 0v4');
    svg.appendChild(r);
    svg.appendChild(p);
    return svg;
  }

  let cache = null;
  // GET /api/v1/license, shared by every hint on the page.
  function load(opts) {
    if (cache && !(opts && opts.fresh)) return cache;
    const p = win.fetch('/api/v1/license', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((res) => res.json().catch(() => null).then((data) => {
        if (!res.ok || !data || data.ok === false) throw new Error('licence ' + res.status);
        return data;
      }));
    cache = p;
    p.catch(() => { if (cache === p) cache = null; });
    return p;
  }

  async function refresh() {
    const res = await win.fetch('/api/v1/license/refresh', {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': (win.GC && win.GC.csrfToken) || '' },
      body: '{}',
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (data && data.csrfToken && win.GC) win.GC.csrfToken = data.csrfToken;
    if (res.status === 429) { const e = new Error(t('license_hint.rate_limited')); e.code = 'rate_limited'; throw e; }
    if (!res.ok || !data || data.ok === false) throw new Error(t('license_hint.failed'));
    cache = Promise.resolve(data);
    return data;
  }

  function render(featureKey, opts) {
    const o = opts || {};
    const key = String(featureKey || '');
    const text = el('div', { class: 'lh-text', text: o.fallback || t('license_hint.generic') });
    const actions = el('div', { class: 'lh-actions' });
    const msg = el('div', { class: 'lh-msg', role: 'status' });
    msg.hidden = true;
    const body = el('div', { class: 'lh-body' }, [
      o.compact ? null : el('div', { class: 'lh-title', text: o.title || t('license_hint.title') }),
      text, actions, msg,
    ]);
    const node = el('div', { class: 'lh-hint' + (o.compact ? ' lh-compact' : ''), role: 'note', dataset: { feature: key, reason: 'pending' } },
      [el('span', { class: 'lh-ic' }, [lockIcon()]), body]);

    function say(s, kind) {
      msg.textContent = s || '';
      msg.hidden = !s;
      msg.className = 'lh-msg' + (kind ? ' lh-msg-' + kind : '');
    }
    function show(info, known) {
      const reason = known ? reasonOf(info, key) : null;
      const view = viewOf(reason, known);
      node.dataset.reason = known ? (reason || 'unlocked') : 'unknown';
      text.textContent = known ? t(view.text, { plan: planLabel(info && info.plan) }) : (o.fallback || t(view.text));
      actions.replaceChildren(...view.actions.map((a) => action(a)));
    }
    function action(a) {
      if (a === 'refresh') {
        const btn = el('button', { type: 'button', class: 'btn btn-sm lh-refresh', text: t('license_hint.refresh') });
        btn.addEventListener('click', async () => {
          say('');
          btn.disabled = true;
          btn.classList.add('is-loading');
          try {
            const info = await refresh();
            if (reasonOf(info, key)) {
              show(info, true);
              say(t('license_hint.still_locked'), 'warn');
            } else {
              say(t('license_hint.refreshed'), 'ok');
              if (typeof o.onUnlocked === 'function') o.onUnlocked(info);
              else win.setTimeout(() => win.location.reload(), 700);
            }
          } catch (e) {
            say((e && e.message) || t('license_hint.failed'), 'error');
          } finally {
            btn.disabled = false;
            btn.classList.remove('is-loading');
          }
        });
        return btn;
      }
      if (a === 'enter') {
        return el('a', {
          class: 'btn btn-sm lh-enter', href: '/settings', text: t('license_hint.enter'),
          on: { click: () => { try { win.localStorage.setItem(SETTINGS_TAB_KEY, 'license'); } catch (_) { /* storage off */ } } },
        });
      }
      if (a === 'upgrade') return el('a', { class: 'lh-link lh-upgrade', href: PRICING_URL, target: '_blank', rel: 'noopener noreferrer', text: t('license_hint.upgrade') });
      if (a === 'reload') return el('button', { type: 'button', class: 'btn btn-sm lh-reload', text: t('license_hint.reload'), on: { click: () => win.location.reload() } });
      return null;
    }

    load().then((info) => show(info, true), () => show(null, false));
    return node;
  }

  /**
   * Small note for a feature that is only on because of the plan default
   * (source 'plan_default'). Stays empty for every other source, so it can sit
   * permanently next to an unlocked feature. Auto-mounted on elements with
   * data-license-source="<feature>".
   */
  function sourceNote(featureKey) {
    const key = String(featureKey || '');
    const node = el('span', { class: 'lh-src', dataset: { feature: key, source: 'pending' } });
    node.hidden = true;
    load().then((info) => {
      const src = sourceOf(info, key);
      node.dataset.source = src || 'unknown';
      if (src !== 'plan_default') { node.hidden = true; return; }
      node.replaceChildren(doc.createTextNode(t('license_hint.plan_default')));
      node.hidden = false;
    }, () => { node.dataset.source = 'unknown'; });
    return node;
  }

  function mount(container, featureKey, opts) {
    if (!container || !featureKey) return null;
    if (container.dataset.lhMounted === String(featureKey) && container.firstElementChild) return container.firstElementChild;
    const fallback = (container.textContent || '').trim();
    const node = render(featureKey, Object.assign({ fallback: fallback || undefined }, opts || {}));
    container.replaceChildren(node);
    container.dataset.lhMounted = String(featureKey);
    container.classList.add('lh-host');
    // A locked block is dimmed and click-through (.feature-locked); the hint
    // inside stays readable and clickable (public/css/security.css).
    const locked = container.closest && container.closest('.feature-locked');
    if (locked) locked.classList.add('lh-in-locked');
    return node;
  }

  function mountAll(root) {
    const scope = root || doc;
    scope.querySelectorAll('[data-license-hint]').forEach((n) => {
      const key = n.getAttribute('data-license-hint');
      if (key) mount(n, key, { compact: n.hasAttribute('data-license-hint-compact') });
    });
    scope.querySelectorAll('[data-license-source]').forEach((n) => {
      const key = n.getAttribute('data-license-source');
      if (!key || n.dataset.lhSource === key) return;
      n.dataset.lhSource = key;
      n.replaceChildren(sourceNote(key));
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => mountAll());
  else mountAll();

  return Object.assign(pure, { render, mount, mountAll, load, refresh });
});
