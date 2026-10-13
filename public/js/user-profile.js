'use strict';

// User profile and device page (docs/feature-device-location.md).
// Profile: header, devices with the last shared location, latest activity,
// access / security / location-sharing cards. Device page: last location on
// an OpenStreetMap map (Leaflet, vendored), device data, history of the
// last positions. Strings: #up-i18n (up.*, us.role.*, common.*,
// error.users.*). No innerHTML — every node is built with el()/textContent.
(function () {
  const doc = document;
  const profilePage = doc.getElementById('up-page');
  const devicePage = doc.getElementById('ud-page');
  if (!profilePage && !devicePage) return;

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
    satellite: ['M13 7 9 3 5 7l4 4', 'm17 11 4 4-4 4-4-4', 'm8 12 4 4 6-6-4-4Z', 'm16 8 3-3', 'M9 21a6 6 0 0 0-6-6'],
    chevron: ['M9 6l6 6-6 6'],
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
  function initials(u) {
    const words = nameOf(u).trim().split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return '?';
    const chars = words.length > 1 ? [Array.from(words[0])[0], Array.from(words[1])[0]] : Array.from(words[0]).slice(0, 2);
    return chars.join('').toUpperCase();
  }
  function roleTone(role) { return role === 'admin' ? 'admin' : 'member'; }
  function roleLabel(role) { return role === 'admin' ? T('us.role.admin') : T('us.role.member'); }
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
  function deviceIcon(d) {
    if (!d.app) return IC.router;
    return d.peer && d.peer.platform === 'windows' ? IC.laptop : IC.phone;
  }
  function deviceSub(d) {
    const p = d.peer;
    if (!p) return T('up.dev.not_registered');
    if (!d.app) return [T('up.dev.no_app_kind'), p.ip].filter(Boolean).join(' · ');
    return [platformLabel(p), clientLabel(p), p.ip].filter(Boolean).join(' · ');
  }
  function statusLine(p) {
    if (!p) return el('span', { class: 'up-status' }, [el('span', { class: 'us-dot us-dot-off', 'aria-hidden': 'true' }), T('up.dev.waiting')]);
    if (!p.enabled) return el('span', { class: 'up-status' }, [el('span', { class: 'us-dot us-dot-crit', 'aria-hidden': 'true' }), T('up.dev.disabled')]);
    if (p.online) return el('span', { class: 'up-status up-status-on' }, [el('span', { class: 'us-dot us-dot-good', 'aria-hidden': 'true' }), T('up.dev.online')]);
    if (p.last_handshake) {
      return el('span', { class: 'up-status' }, [el('span', { class: 'us-dot us-dot-off', 'aria-hidden': 'true' }),
        el('span', { title: fmtDateTime(p.last_handshake) }, T('up.dev.last_seen', { when: rel(p.last_handshake) }))]);
    }
    return el('span', { class: 'up-status' }, [el('span', { class: 'us-dot us-dot-off', 'aria-hidden': 'true' }), T('up.dev.never')]);
  }
  function locationChip(d, allowed) {
    if (!d.app) return el('span', { class: 'up-loc up-loc-none' }, T('up.dev.loc_no_app'));
    if (d.location) {
      const d2 = toDate(d.location.at);
      return el('span', { class: 'up-loc up-loc-on', title: fmtDateTime(d.location.at) }, [icon(IC.satellite, 14),
        T('up.dev.loc_at', { time: d2 && sameDay(d2, new Date()) ? fmtTime(d2) : fmtWhen(d.location.at) })]);
    }
    if (!allowed) return el('span', { class: 'up-loc up-loc-none' }, T('up.dev.loc_not_allowed'));
    return el('span', { class: 'up-loc up-loc-none' }, T('up.dev.loc_never'));
  }
  function errText(err) { return (err && err.message) || T('common.error'); }

  // ── profile page ───────────────────────────────────────────────────
  async function initProfile() {
    const uid = Number(profilePage.dataset.userId);
    const base = '/api/v1/users/' + uid;
    const devList = doc.getElementById('up-devices');
    const actList = doc.getElementById('up-activity');
    devList.appendChild(el('li', { class: 'up-muted' }, T('common.loading')));

    let detail;
    try { detail = await call('GET', base); } catch (err) {
      clear(devList).appendChild(el('li', { class: 'up-error' }, errText(err)));
      return;
    }
    const u = detail.user;

    // header
    const av = doc.getElementById('up-avatar');
    av.className = 'up-avatar us-tone-' + roleTone(u.role) + (u.enabled === 1 ? '' : ' us-avatar-off');
    av.textContent = initials(u);
    const chips = clear(doc.getElementById('up-head-chips'));
    chips.appendChild(el('span', { class: 'us-chip us-chip-' + roleTone(u.role) }, roleLabel(u.role)));
    chips.appendChild(el('span', { class: 'us-chip ' + (u.enabled === 1 ? 'us-chip-good' : 'us-chip-crit') }, u.enabled === 1 ? T('up.active') : T('up.disabled')));
    doc.getElementById('up-sub').textContent = ['@' + u.username, u.email, u.language ? T('up.lang_' + (u.language === 'en' ? 'en' : 'de')) : null]
      .filter(Boolean).join(' · ');
    doc.getElementById('up-sub2').textContent = [T('up.created', { date: fmtDate(u.created_at) }),
      u.last_login_at ? T('up.last_login', { when: rel(u.last_login_at) }) : T('up.never_logged_in')].join(' · ');

    // security card
    const sec = clear(doc.getElementById('up-security'));
    const fact = (host, k, v) => { host.appendChild(el('dt', null, k)); host.appendChild(el('dd', null, v)); };
    fact(sec, T('up.sec.passkeys'), String((detail.passkeys || []).length));
    fact(sec, T('up.sec.totp'), u.totp_enabled === 1 ? T('up.on') : T('up.off'));
    fact(sec, T('up.sec.tokens'), String((detail.tokens || []).length));
    fact(sec, T('up.sec.self_service'), u.self_service_enabled === 1 ? T('up.on') : T('up.off'));

    // location sharing card
    const sw = doc.getElementById('up-loc-switch');
    const locText = doc.getElementById('up-loc-text');
    function paintLoc(allowed, info) {
      sw.checked = !!allowed;
      locText.textContent = allowed
        ? T('up.loc.allowed_text', { days: info.retention_days, keep: info.keep })
        : T('up.loc.denied_text');
    }

    async function loadDevices() {
      const res = await call('GET', base + '/devices');
      const info = res.location || { allowed: false, keep: 20, retention_days: 30 };
      paintLoc(info.allowed, info);
      const devices = res.devices || [];
      doc.getElementById('up-dev-count').textContent = P('up.dev.count', devices.length);
      clear(devList);
      if (!devices.length) devList.appendChild(el('li', { class: 'up-muted up-empty' }, T('up.dev.empty')));
      devices.forEach((d) => {
        const inner = [
          el('span', { class: 'up-dev-ic' + (d.peer && d.peer.online ? ' is-on' : ''), 'aria-hidden': 'true' }, icon(deviceIcon(d), 20)),
          el('span', { class: 'up-dev-text' }, [
            el('span', { class: 'up-dev-name' }, (d.peer && d.peer.name) || (d.token && d.token.name) || '—'),
            el('span', { class: 'up-dev-sub' }, deviceSub(d)),
            el('span', { class: 'up-dev-meta' }, [statusLine(d.peer), locationChip(d, info.allowed)]),
          ]),
        ];
        if (d.peer) {
          inner.push(el('span', { class: 'up-dev-go', 'aria-hidden': 'true' }, icon(IC.chevron, 18)));
          devList.appendChild(el('li', null, el('a', { class: 'up-dev', href: '/users/' + uid + '/devices/' + d.peer.id }, inner)));
        } else {
          devList.appendChild(el('li', null, el('div', { class: 'up-dev is-static' }, inner)));
        }
      });
      return info;
    }

    let info;
    try { info = await loadDevices(); } catch (err) { clear(devList).appendChild(el('li', { class: 'up-error' }, errText(err))); }

    sw.addEventListener('change', async () => {
      const want = sw.checked;
      sw.disabled = true;
      try {
        await call('PUT', base + '/location-sharing', { enabled: want });
        info = Object.assign({}, info || { keep: 20, retention_days: 30 }, { allowed: want });
        paintLoc(want, info);
        toast(want ? T('up.loc.toast_on') : T('up.loc.toast_off'));
        loadDevices().catch(() => {});
      } catch (err) {
        sw.checked = !want;
        toast(errText(err), 'error');
      } finally { sw.disabled = false; }
    });

    // access card (visibility) and activity, independent of each other
    const acc = clear(doc.getElementById('up-access'));
    fact(acc, T('up.acc.role'), roleLabel(u.role));
    call('GET', base + '/visibility').then((v) => {
      const services = v.services && v.services.visible ? v.services.visible.length : 0;
      const rdp = v.rdp && v.rdp.visible ? v.rdp.visible.length : 0;
      fact(acc, T('up.acc.services'), String(services));
      fact(acc, T('up.acc.rdp'), String(rdp));
      fact(acc, T('up.acc.web'), T('up.acc.web_' + (v.web === 'all' || v.web === 'self_service' ? v.web : 'none')));
    }).catch(() => {});

    actList.appendChild(el('li', { class: 'up-muted' }, T('common.loading')));
    call('GET', base + '/activity?limit=8').then((res) => {
      clear(actList);
      const entries = res.entries || [];
      if (!entries.length) actList.appendChild(el('li', { class: 'up-muted' }, T('up.act.empty')));
      entries.forEach((e) => {
        const tone = e.severity === 'warning' || e.severity === 'error' ? 'us-dot-warn' : (e.severity === 'success' ? 'us-dot-good' : 'us-dot-accent');
        actList.appendChild(el('li', { class: 'up-act' + (String(e.event_type).indexOf('location') >= 0 ? ' is-loc' : '') }, [
          el('time', { class: 'up-act-time', datetime: e.created_at, title: fmtDateTime(e.created_at) }, fmtWhen(e.created_at)),
          el('span', { class: 'us-dot ' + tone, 'aria-hidden': 'true' }),
          el('span', { class: 'up-act-text' }, e.message),
        ]));
      });
    }).catch((err) => { clear(actList).appendChild(el('li', { class: 'up-error' }, errText(err))); });
  }

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
      fact(data, T('up.device.app_used'), dv.token.last_used_at ? rel(dv.token.last_used_at) : T('up.dev.never'));
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

  if (profilePage) initProfile();
  if (devicePage) initDevice();
}());
