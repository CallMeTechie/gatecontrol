'use strict';

// Device page of the user profile (docs/feature-device-location.md): last
// location on an OpenStreetMap map (Leaflet, vendored), device data, history
// of the last positions. The profile itself (/users/:id) is rendered by
// users.js. Strings: #up-i18n (up.*, us.role.*, common.*, error.users.*).
// No innerHTML — every node is built with el()/textContent.
(function () {
  const doc = document;
  const devicePage = doc.getElementById('ud-page');
  if (!devicePage) return;

  let I18N = {};
  try { I18N = JSON.parse((doc.getElementById('up-i18n') || {}).textContent || '{}') || {}; } catch (_) { I18N = {}; }
  const LANG = doc.documentElement.lang || 'de';

  function T(key, params) {
    let s = I18N[key];
    if (s == null && window.GC && window.GC.t) s = window.GC.t[key];
    if (s == null) s = key;
    s = String(s);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{{' + k + '}}').join(String(params[k])); });
    return s;
  }
  function P(base, n, params) {
    return T(base + (n === 1 ? '_one' : '_other'), Object.assign({ count: n }, params || {}));
  }

  // ── DOM helpers ────────────────────────────────────────────────────
  const SVGNS = 'http://www.w3.org/2000/svg';
  function safeHref(v) {
    const s = String(v == null ? '' : v);
    if (/^\/(?![/\\])/.test(s) && s.indexOf('\\') < 0) return s;
    try {
      const u = new URL(s);
      if (u.protocol === 'https:') return u.href;
    } catch (_) { /* not a URL */ }
    return '#';
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
      else if (k === 'href') n.setAttribute('href', safeHref(v));
      else if (k === 'title') n.title = String(v);
      else if (k === 'datetime') n.setAttribute('datetime', String(v));
      else if (k === 'aria-hidden' || k === 'aria-label' || k === 'aria-current' || k === 'aria-pressed') n.setAttribute(k, String(v));
      else if (k === 'type' || k === 'disabled') n[k] = v;
    });
    [].concat(children == null ? [] : children).forEach((c) => {
      if (c == null || c === false) return;
      n.append(c instanceof window.Node ? c : String(c));
    });
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function icon(paths, size) {
    const svg = doc.createElementNS(SVGNS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.9'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['width', String(size || 20)], ['height', String(size || 20)]]
      .forEach((a) => svg.setAttribute(a[0], a[1]));
    [].concat(paths).forEach((d) => {
      const path = doc.createElementNS(SVGNS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }
  const IC = {
    phone: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M11 18h2'],
    laptop: ['M4 5h16v10H4z', 'M2 19h20'],
    router: ['M3 14h18v6H3z', 'M7 17h.01', 'M11 17h.01', 'M8 10a6 6 0 0 1 8 0', 'M5 7a10 10 0 0 1 14 0'],
  };

  async function call(method, url, body) {
    const api = window.api;
    let res;
    if (method === 'GET') res = await api.get(url);
    else if (method === 'PUT') res = await api.put(url, body);
    else if (method === 'DELETE') res = await api.del(url);
    else res = await api.post(url, body);
    if (res && res.ok === false) throw new Error(res.error || T('common.error'));
    return res;
  }
  function toast(msg, type) { if (window.showToast) window.showToast(msg, type || 'success'); }

  // ── time / number formatting ───────────────────────────────────────
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' }); } catch (_) { rtf = null; }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtTime(d) {
    try { return d.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString().slice(11, 16); }
  }
  function fmtDate(v) {
    const d = toDate(v);
    if (!d) return '';
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }
  function fmtDateTime(v) {
    const d = toDate(v);
    if (!d) return '';
    try { return d.toLocaleString(LANG, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return d.toISOString(); }
  }
  /** "heute 08:42", "gestern 19:05", else "10.10. 14:22". */
  function fmtWhen(v) {
    const d = toDate(v);
    if (!d) return '';
    const now = new Date();
    const y = new Date(now.getTime() - 86400000);
    if (sameDay(d, now)) return T('up.time.today', { time: fmtTime(d) });
    if (sameDay(d, y)) return T('up.time.yesterday', { time: fmtTime(d) });
    try { return d.toLocaleDateString(LANG, { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(d); } catch (_) { return fmtDateTime(d); }
  }
  function rel(v) {
    const d = toDate(v);
    if (!d) return '';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return T('up.time.now');
    if (!rtf) return fmtDateTime(d);
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
    return fmtDate(d);
  }
  function bytes(n) {
    const v = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return (i === 0 ? String(x) : x.toFixed(x >= 100 ? 0 : 1)) + ' ' + units[i];
  }
  function meters(v) { return v == null ? '' : '±' + Math.round(Number(v)) + ' m'; }
  function coord(v) { return Number(v).toFixed(5); }

  // ── shared bits ────────────────────────────────────────────────────
  function nameOf(u) { return (u && (u.display_name || u.username)) || ''; }
  function platformLabel(p) {
    if (!p) return null;
    if (p.platform === 'android') return 'Android';
    if (p.platform === 'windows') return 'Windows';
    return null;
  }
  function clientLabel(p) {
    if (!p || !p.client_version) return null;
    const prod = p.product === 'pro' ? 'GateControl Pro' : (p.product === 'community' ? 'GateControl Community' : 'GateControl');
    return prod + ' ' + p.client_version;
  }
  function errText(err) { return (err && err.message) || T('common.error'); }

  // ── device page ────────────────────────────────────────────────────
  async function initDevice() {
    const uid = Number(devicePage.dataset.userId);
    const pid = Number(devicePage.dataset.peerId);
    const url = '/api/v1/users/' + uid + '/devices/' + pid;
    const mapEl = doc.getElementById('ud-map');
    const empty = doc.getElementById('ud-map-empty');
    const facts = doc.getElementById('ud-loc-facts');
    const actions = doc.getElementById('ud-loc-actions');
    const hist = doc.getElementById('ud-history');
    let map = null;
    let marker = null;
    let circle = null;

    function fact(host, k, v, mono) {
      host.appendChild(el('dt', null, k));
      host.appendChild(el('dd', { class: mono ? 'up-mono' : null }, v));
    }

    function ensureMap() {
      if (map || !window.L) return map;
      map = window.L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        // OpenStreetMap's tile policy asks for a referrer; the admin page
        // itself sends none (helmet), so the tiles get the origin only.
        referrerPolicy: 'strict-origin-when-cross-origin',
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
      }).addTo(map);
      return map;
    }

    function show(loc, label) {
      clear(facts);
      if (!loc) {
        mapEl.hidden = true;
        empty.hidden = false;
        actions.hidden = true;
        return;
      }
      mapEl.hidden = false;
      empty.hidden = true;
      actions.hidden = false;
      const m = ensureMap();
      if (m) {
        const ll = [loc.lat, loc.lng];
        const acc = Math.max(Number(loc.accuracy) || 0, 5);
        if (!marker) {
          marker = window.L.marker(ll, { keyboard: false }).addTo(m);
          circle = window.L.circle(ll, { radius: acc, color: '#ff6b6b', weight: 1.5, fillColor: '#ff6b6b', fillOpacity: 0.12 }).addTo(m);
        } else {
          marker.setLatLng(ll);
          circle.setLatLng(ll).setRadius(acc);
        }
        marker.bindTooltip(label + ' · ' + fmtWhen(loc.at) + (loc.accuracy != null ? ' · ' + meters(loc.accuracy) : ''));
        m.setView(ll, acc > 1500 ? 12 : (acc > 300 ? 14 : 16));
        setTimeout(() => m.invalidateSize(), 0);
      }
      fact(facts, T('up.device.coords'), coord(loc.lat) + ', ' + coord(loc.lng), true);
      fact(facts, T('up.device.accuracy'), loc.accuracy != null ? meters(loc.accuracy) + (loc.provider ? ' (' + loc.provider + ')' : '') : '—');
      fact(facts, T('up.device.via'), loc.via === 'tunnel' ? T('up.device.via_tunnel') : T('up.device.via_direct'));
      fact(facts, T('up.device.sent_at'), fmtDateTime(loc.at));
      const osm = doc.getElementById('ud-osm');
      osm.setAttribute('href', safeHref('https://www.openstreetmap.org/?mlat=' + coord(loc.lat) + '&mlon=' + coord(loc.lng) + '#map=17/' + coord(loc.lat) + '/' + coord(loc.lng)));
    }

    let res;
    try { res = await call('GET', url); } catch (err) {
      doc.getElementById('ud-name').textContent = T('up.device.not_found');
      empty.hidden = false;
      mapEl.hidden = true;
      doc.getElementById('ud-map-empty-text').textContent = errText(err);
      return;
    }
    const dv = res.device;
    const p = dv.peer;
    const owner = res.user;
    doc.getElementById('ud-crumb-device').textContent = p.name;
    doc.getElementById('ud-name').textContent = p.name;
    doc.title = p.name + ' · GateControl';
    const icHost = doc.getElementById('ud-icon');
    icHost.appendChild(icon(dv.token ? (p.platform === 'windows' ? IC.laptop : IC.phone) : IC.router, 22));
    const chips = clear(doc.getElementById('ud-head-chips'));
    chips.appendChild(p.online
      ? el('span', { class: 'us-chip us-chip-good' }, T('up.dev.online'))
      : el('span', { class: 'us-chip us-chip-off' }, p.enabled ? T('up.dev.offline') : T('up.dev.disabled')));
    doc.getElementById('ud-sub').textContent = [T('up.device.owner', { name: nameOf(owner) }), platformLabel(p), clientLabel(p)]
      .filter(Boolean).join(' · ');

    // device data
    const data = clear(doc.getElementById('ud-data'));
    fact(data, T('up.device.tunnel_ip'), p.ip || '—', true);
    if (p.hostname) fact(data, T('up.device.hostname'), p.hostname, true);
    const pk = String(p.public_key || '');
    fact(data, T('up.device.public_key'), pk.length > 12 ? pk.slice(0, 6) + '…' + pk.slice(-6) : pk || '—', true);
    fact(data, T('up.device.handshake'), p.last_handshake ? rel(p.last_handshake) : T('up.dev.never'));
    fact(data, T('up.device.traffic'), '↓ ' + bytes(p.transfer_rx) + ' · ↑ ' + bytes(p.transfer_tx));
    if (dv.token) {
      fact(data, T('up.device.binding'), dv.token.machine_binding ? T('up.on') : T('up.off'));
      fact(data, T('up.device.app_used'), dv.token.last_used_at ? rel(dv.token.last_used_at) : T('up.never'));
    }
    fact(data, T('up.device.push'), dv.push
      ? (dv.push.enabled ? T('up.device.push_on', { via: dv.push.via === 'tunnel' ? T('up.device.via_tunnel') : T('up.device.via_direct') }) : T('up.off'))
      : T('up.device.push_none'));
    fact(data, T('up.device.created'), fmtDate(p.created_at));

    function renderHistory(list) {
      clear(hist);
      doc.getElementById('ud-hist-count').textContent = list.length ? P('up.device.hist_count', list.length) : '';
      doc.getElementById('ud-hist-hint').textContent = list.length > 1 ? T('up.device.hist_hint') : '';
      if (!list.length) hist.appendChild(el('li', { class: 'up-muted' }, T('up.device.hist_empty')));
      list.forEach((loc, i) => {
        const btn = el('button', { type: 'button', class: 'ud-hist-btn', 'aria-pressed': i === 0 ? 'true' : 'false' }, [
          el('span', { class: 'ud-hist-when' }, fmtWhen(loc.at)),
          el('span', { class: 'ud-hist-acc' }, loc.accuracy != null ? meters(loc.accuracy) : ''),
        ]);
        btn.addEventListener('click', () => {
          hist.querySelectorAll('.ud-hist-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          btn.setAttribute('aria-pressed', 'true');
          doc.getElementById('ud-map-sub').textContent = T('up.device.shown', { when: fmtWhen(loc.at) });
          show(loc, p.name);
        });
        hist.appendChild(el('li', null, btn));
      });
    }

    function paint(locs) {
      const last = locs[0] || null;
      doc.getElementById('ud-map-sub').textContent = last ? T('up.device.sent_from', { when: fmtWhen(last.at) }) : '';
      if (!last) {
        doc.getElementById('ud-map-empty-text').textContent = !dv.token
          ? T('up.device.no_app')
          : (res.location && res.location.allowed ? T('up.device.never_sent') : T('up.device.not_allowed'));
      }
      show(last, p.name);
      renderHistory(locs);
    }
    paint(dv.locations || []);

    doc.getElementById('ud-delete').addEventListener('click', async () => {
      const ok = await window.GCDialog.confirm({ title: T('up.device.delete_title'), message: T('up.device.delete_text'), okLabel: T('up.device.delete_ok'), danger: true });
      if (!ok) return;
      try {
        await call('DELETE', url + '/locations');
        toast(T('up.device.deleted'));
        paint([]);
      } catch (err) { toast(errText(err), 'error'); }
    });
  }

  initDevice();
}());
