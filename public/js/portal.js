// public/js/portal.js — GateControl VPN Landing Portal client
// Vanilla JS, no framework. Served as a static asset.
'use strict';
(function () {

  // ─── Locale detection ───────────────────────────────────────────────────────
  // NOTE: State CSS (.portal-fallback, .portal-error-state, gc-shimmer, etc.)
  // is served via portal.css ('self') — not injected here — so it is not
  // blocked by the page Content-Security-Policy (styleSrcElem = 'self' + nonce).
  const lang = (document.documentElement.lang || 'de').slice(0, 2).toLowerCase();
  const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ─── Client i18n map (injected by portal.njk) ──────────────────────────────
  var PT = {};
  try {
    var _pt = document.getElementById('portal-i18n');
    if (_pt) PT = JSON.parse(_pt.textContent || '{}');
  } catch (_) {}

  // ─── Theme toggle ───────────────────────────────────────────────────────────
  (function initTheme() {
    const html = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    function storedTheme() {
      try { return localStorage.getItem('gc-portal-theme'); } catch (_) { return null; }
    }

    // Follow OS until the user has manually overridden
    mq.addEventListener('change', function (e) {
      if (!storedTheme()) {
        html.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });

    const btn = document.getElementById('themeBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', next);
        try { localStorage.setItem('gc-portal-theme', next); } catch (_) {}
      });
    }
  })();

  // ─── Formatters ─────────────────────────────────────────────────────────────────
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    let v = Number(bytes);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
    const numStr = i === 0
      ? String(Math.round(v))
      : new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
    return numStr + ' ' + BYTE_UNITS[i];
  }

  var _rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  var _rtfAlways = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
  function fmtRelTime(ts) {
    if (!ts) return '—';
    const now = Date.now();
    const t = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
    const s = Math.floor((now - t) / 1000);
    if (s < 5)    return _rtf.format(0, 'second');
    if (s < 60)   return _rtfAlways.format(-s, 'second');
    const m = Math.floor(s / 60);
    if (s < 3600) return _rtfAlways.format(-m, 'minute');
    const h = Math.floor(s / 3600);
    if (s < 86400) return _rtfAlways.format(-h, 'hour');
    const d = Math.floor(s / 86400);
    return _rtfAlways.format(-d, 'day');
  }

  var _wdFmt = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' });
  function bucketLabel(isoStr, range, idx) {
    if (range === '30d') return 'W' + (idx + 1);
    const d = new Date(isoStr);
    if (range === '24h') return String(d.getUTCHours()).padStart(2, '0');
    return _wdFmt.format(d);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Shared state helpers ───────────────────────────────────────────────────

  function setLoading(card, on) {
    if (!card) return;
    card.classList.toggle('loading', on);
  }

  function showFallback(el) {
    if (!el) return;
    // Use the generic/neutral message — fits both gateway-identified and
    // unidentified contexts.
    el.replaceChildren();
    const p = document.createElement('p');
    p.className = 'portal-fallback';
    p.textContent = PT.fallbackUnknown || '';
    el.appendChild(p);
  }

  function showError(card, retryFn) {
    if (!card) return;
    let el = card.querySelector('.portal-error-state');
    if (!el) {
      el = document.createElement('div');
      el.className = 'portal-error-state';
      card.appendChild(el);
    }
    const msgSpan = document.createElement('span');
    msgSpan.className = 'portal-error-msg';
    msgSpan.textContent = PT.unavailable || '';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'portal-retry-btn';
    retryBtn.textContent = PT.retry || '';
    el.replaceChildren(msgSpan, retryBtn);
    retryBtn.addEventListener('click', function () {
      el.remove();
      retryFn();
    });
  }

  // ─── Device widget ──────────────────────────────────────────────────────────
  function hydrateDevice() {
    const card = document.querySelector('.c-device');
    if (!card) return;
    setLoading(card, true);

    fetch('/api/v1/portal/device')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (body) {
        setLoading(card, false);
        if (!body.ok || body.data === null) {
          const kv = document.getElementById('deviceKv');
          showFallback(kv);
          const xfer = card.querySelector('.xfer');
          if (xfer) xfer.style.display = 'none';
          return;
        }
        const d = body.data;
        const vpnIp = (d.allowed_ips || '').split('/')[0] || '';

        // Topbar pill
        const dot    = document.getElementById('devDot');
        const nameEl = document.getElementById('devName');
        const ipEl   = document.getElementById('devIp');
        if (dot)    dot.style.background = d.isOnline ? 'var(--green)' : 'var(--muted)';
        if (nameEl) nameEl.textContent = d.name || '';
        if (ipEl)   ipEl.textContent = vpnIp;

        // Status badge
        const statusEl = document.getElementById('deviceStatus');
        if (statusEl) {
          statusEl.replaceChildren();
          if (d.isOnline) {
            const badge = document.createElement('span');
            badge.className = 'badge-on';
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.setAttribute('style', 'animation:none');
            badge.appendChild(dot);
            badge.appendChild(document.createTextNode(PT.online || 'Online'));
            statusEl.appendChild(badge);
          } else {
            const offSpan = document.createElement('span');
            offSpan.setAttribute('style', 'color:var(--muted)');
            offSpan.textContent = PT.offline || 'Offline';
            statusEl.appendChild(offSpan);
          }
        }

        const hs = document.getElementById('deviceHandshake');
        if (hs) hs.textContent = fmtRelTime(d.latestHandshake);

        const addr = document.getElementById('deviceAddress');
        if (addr) addr.textContent = vpnIp || '—';

        const dns = document.getElementById('deviceDns');
        if (dns) dns.textContent = d.dns || '—';

        const rxEl = document.getElementById('deviceRx');
        if (rxEl) rxEl.textContent = fmtBytes(d.transferRx);

        const txEl = document.getElementById('deviceTx');
        if (txEl) txEl.textContent = fmtBytes(d.transferTx);
      })
      .catch(function () {
        setLoading(card, false);
        showError(card, hydrateDevice);
      });
  }

  // ─── Traffic widget ─────────────────────────────────────────────────────────
  let trafficData = null;
  let activeRange = '24h';

  function renderChart(range) {
    const chart  = document.getElementById('chart');
    const tTotal = document.getElementById('tTotal');
    const tAvg   = document.getElementById('tAvg');
    const tPeak  = document.getElementById('tPeak');
    if (!chart || !trafficData) return;

    const series = trafficData.series && trafficData.series[range];
    if (!series || !series.length) return;

    const rxValues = series.map(function (b) { return b.rx; });
    const maxRx    = Math.max.apply(null, rxValues.concat([1]));  // avoid /0
    const totalRx  = rxValues.reduce(function (sum, v) { return sum + v; }, 0);
    const peakRx   = Math.max.apply(null, rxValues);

    chart.innerHTML = series.map(function (b, i) {
      const dh  = Math.round(b.rx / maxRx * 116) + 6;
      const uh  = Math.round(b.tx / maxRx * 116) + 4;
      const lab = escHtml(bucketLabel(b.t, range, i));
      return '<div class="col">' +
        '<div class="bar up" style="height:0" data-h="' + uh + '"></div>' +
        '<div class="bar" style="height:0" data-h="' + dh + '"></div>' +
        '<div class="lab">' + lab + '</div>' +
        '</div>';
    }).join('');

    function applyHeights() {
      chart.querySelectorAll('.bar').forEach(function (bar) {
        bar.style.height = bar.dataset.h + 'px';
      });
    }
    if (noMotion) {
      applyHeights();
    } else {
      requestAnimationFrame(applyHeights);
    }

    if (tTotal) tTotal.textContent = fmtBytes(totalRx);
    if (tAvg)   tAvg.textContent   = series.length ? fmtBytes(Math.round(totalRx / series.length)) : '—';
    if (tPeak)  tPeak.textContent  = fmtBytes(peakRx);
  }

  function hydrateTraffic() {
    const card = document.querySelector('.c-traffic');
    if (!card) return;
    setLoading(card, true);

    fetch('/api/v1/portal/traffic')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (body) {
        setLoading(card, false);
        if (!body.ok || body.data === null) {
          const chart = document.getElementById('chart');
          showFallback(chart);
          return;
        }
        trafficData = body.data;

        // Wire range selector and confirm initial active state
        const seg = document.getElementById('seg');
        if (seg) {
          seg.querySelectorAll('button').forEach(function (b) {
            b.classList.toggle('on', b.dataset.r === activeRange);
          });
          seg.addEventListener('click', function (e) {
            const btn = e.target.closest('button');
            if (!btn) return;
            activeRange = btn.dataset.r;
            seg.querySelectorAll('button').forEach(function (b) {
              b.classList.toggle('on', b.dataset.r === activeRange);
            });
            renderChart(activeRange);
          });
        }

        renderChart(activeRange);
      })
      .catch(function () {
        setLoading(card, false);
        showError(card, hydrateTraffic);
      });
  }

  // ─── Services widget ────────────────────────────────────────────────────────
  // Two-letter monogram derived from the service name for the compact launcher tile.
  function serviceMonogram(name) {
    const trimmed = String(name || '').trim();
    return (trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1, 2).toLowerCase()) || '?';
  }

  function hydrateServices() {
    const card    = document.querySelector('.c-services');
    const tilesEl = document.getElementById('servicesTiles');
    if (!card || !tilesEl) return;
    setLoading(card, true);

    fetch('/api/v1/portal/services')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (body) {
        setLoading(card, false);
        if (!body.ok || body.data === null) {
          showFallback(tilesEl);
          return;
        }
        const services = body.data;
        if (!services.length) {
          const emptyDiv = document.createElement('div');
          emptyDiv.className = 'portal-empty';
          emptyDiv.textContent = PT.noServices || '';
          tilesEl.replaceChildren(emptyDiv);
          return;
        }
        tilesEl.innerHTML = services.map(function (s) {
          return '<a class="svc" href="https://' + escHtml(s.domain) +
            '" target="_blank" rel="noopener noreferrer">' +
            '<span class="si">' + escHtml(serviceMonogram(s.name)) + '</span>' +
            '<span class="st"><b>' + escHtml(s.name) + '</b><span>' + escHtml(s.domain) + '</span></span>' +
            '<span class="live"></span>' +
            '</a>';
        }).join('');
      })
      .catch(function () {
        setLoading(card, false);
        showError(card, hydrateServices);
      });
  }

  // ─── Pi-hole widget ─────────────────────────────────────────────────────────
  var piScopeActive = 'device';

  // Endpoint map for the three scopes (TP2a device + TP2b owner/household)
  var PI_ENDPOINTS = {
    device:    '/api/v1/portal/pihole',
    owner:     '/api/v1/portal/pihole/owner',
    household: '/api/v1/portal/pihole/household'
  };

  function hydratePiholeScope(scope) {
    var card = document.querySelector('.pihole-widget');
    if (!card) return;                       // widget toggled off → not in DOM → no fetch
    setLoading(card, true);
    // Whitelist scope to guard against proto-poisoning (__proto__, constructor, etc.)
    var url = (scope === 'device' || scope === 'owner' || scope === 'household') ? PI_ENDPOINTS[scope] : PI_ENDPOINTS.device;

    // ── Render helpers (inner functions — closed over card, scope) ────────

    function renderPiholeReason(msg, bodyEl, reason) {
      if (bodyEl) bodyEl.style.display = 'none';
      if (msg) {
        msg.replaceChildren();
        if (reason === 'no_owner' || reason === 'login_required') {
          // DOM-safe login affordance — no innerHTML with i18n text or /login href
          var hintKey = reason === 'no_owner' ? 'piholeNoOwner' : 'piholeLoginRequired';
          var hintSpan = document.createElement('span');
          hintSpan.textContent = PT[hintKey] || '';
          var a = document.createElement('a');
          a.href = '/login';
          a.textContent = PT.piholeLoginLink || 'Log in';
          msg.appendChild(hintSpan);
          msg.appendChild(document.createTextNode(' '));
          msg.appendChild(a);
        } else {
          var key = { collapsed:'piholeCollapsed', no_data:'piholeNoData', unidentified:'piholeUnidentified' }[reason] || 'piholeUnavailable';
          msg.textContent = PT[key] || ''; // PT = i18n map (portal.js ~line 14)
        }
        msg.style.display = 'block';
      }
    }

    function renderPiholeStats(d, msg) {
      // ── Scope-visibility: deterministically show/hide cross-scope fields ─
      var allowedWrap = document.getElementById('piAllowedWrap');
      if (allowedWrap) allowedWrap.style.display = (scope === 'household') ? 'none' : '';
      var ownerExtra = document.getElementById('piOwnerExtra');
      if (ownerExtra) ownerExtra.style.display = (scope === 'owner') ? '' : 'none';
      var hhExtra = document.getElementById('piHouseholdExtra');
      if (hhExtra) hhExtra.style.display = (scope === 'household') ? '' : 'none';

      // ── Stats common to all scopes ──────────────────────────────────────
      var pctEl = document.getElementById('piPct');
      if (pctEl) pctEl.textContent = String(d.blockedPct);
      var arc = document.getElementById('piDonut');
      if (arc) {
        var r = 50, C = 2 * Math.PI * r;           // r MUSS zum <circle r="50"> im Donut-Markup passen
        var frac = Math.max(0, Math.min(1, (Number(d.blockedPct) || 0) / 100));  // d.blockedPct = dieselbe Block-Rate, die auch #piPct setzt
        arc.setAttribute('stroke-dasharray', C.toFixed(1));
        arc.setAttribute('stroke-dashoffset', (C - frac * C).toFixed(1));
      }
      var totalEl = document.getElementById('piTotal');
      if (totalEl) totalEl.textContent = String(d.total);
      var blockedEl = document.getElementById('piBlocked');
      if (blockedEl) blockedEl.textContent = String(d.blocked);

      // ── Scope-specific fields ───────────────────────────────────────────
      if (scope !== 'household') {
        // device + owner: show allowed count
        var allowedEl = document.getElementById('piAllowed');
        if (allowedEl) allowedEl.textContent = String(d.allowed);
      }

      if (scope === 'owner') {
        // owner: device count across the owner's peers
        var devCountEl = document.getElementById('piOwnerDevices');
        if (devCountEl) {
          devCountEl.textContent = (PT['piholeOwnerDevices'] || '{n}').replace('{n}', String(d.deviceCount));
        }
        var devHintEl = document.getElementById('piOwnerDevicesHint');
        if (devHintEl) devHintEl.textContent = PT['piholeOwnerDevicesHint'] || '';
      }

      if (scope === 'household') {
        // household: active client count, no allowed stat
        var clientsEl = document.getElementById('piActiveClients');
        if (clientsEl) {
          clientsEl.textContent = (PT['piholeActiveClients'] || '{n}').replace('{n}', String(d.activeClients || 0));
        }
      }

      // ── Zero-queries notice (spec §5) ───────────────────────────────────
      if (msg) {
        msg.replaceChildren();
        if (d.total === 0) {
          msg.textContent = PT['piholeZeroQueries'] || '';
          msg.style.display = 'block';
        } else {
          msg.style.display = 'none';
        }
      }
    }

    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (body) {
        setLoading(card, false);
        var msg = document.getElementById('piMsg');
        var bodyEl = card.querySelector('.pihole-body');
        if (!body.ok || body.data === null) {
          var reason = body.reason;
          if (reason === 'unavailable' && scope === 'device') { card.style.display = 'none'; return; }
          renderPiholeReason(msg, bodyEl, reason);
          return;
        }
        if (bodyEl) bodyEl.style.display = '';
        renderPiholeStats(body.data, msg);
      })
      .catch(function () { setLoading(card, false); showError(card, function () { hydratePiholeScope(scope); }); });
  }

  // hydratePihole: TP2a entry point — wires the segment switcher once, then
  // loads the default 'device' scope (boot call below is unchanged).
  function hydratePihole() {
    var seg = document.getElementById('piholeSeg');
    if (seg) {
      seg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('on', btn.dataset.scope === piScopeActive);
      });
      seg.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn || !btn.dataset.scope) return;
        piScopeActive = btn.dataset.scope;
        seg.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('on', b.dataset.scope === piScopeActive);
        });
        hydratePiholeScope(piScopeActive);
      });
    }
    hydratePiholeScope(piScopeActive);
  }

  // ─── Klima (Midea) widget ───────────────────────────────────────────────────
  var _mideaCtl = null;     // AbortController for visibility/network listeners
  var _mideaTimer = null;   // poll interval
  var _mideaPollGen = 0;    // generation guard against stale 429 callbacks
  var _mideaLoggedIn = false;
  var _mideaDevices = [];
  var _mideaSendTimers = {}; // id → debounce timer for target-temp commits

  var MIDEA_MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
  var FAN_STEPS = [1, 20, 40, 60, 80, 100]; // Prozent-Stufen wie Midea-App (1–100, 100=Max); Auto=102 außerhalb der Skala
  function fanIndex(v) { return FAN_STEPS.reduce(function (b, val, i, a) { return Math.abs(val - v) < Math.abs(a[b] - v) ? i : b; }, 0); }
  // Static icon strings (no user data → safe to inline). Mirrors the admin /midea card.
  var MIDEA_AC_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M6 18v1M10 18v2M14 18v2M18 18v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var MIDEA_POWER_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v9M6.5 6.5a8 8 0 1011 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function mideaModeLabel(m) { return PT['mideaMode' + m.charAt(0).toUpperCase() + m.slice(1)] || m; }

  // Redesign: card grid with SVG target-temp ring (r=52, 16–30 °C arc) + stepper + text mode-segment + status pill
  // (mirrors the portal-redesign mockup's .ac/.ac-ring/.stepper/.modeseg). Data contract unchanged:
  // .midea-card[data-id], .midea-status[data-power], button[data-act=power]/[data-step]/[data-mode], .midea-target[data-val].
  function renderMideaCard(d) {
    var st = d.state || {};
    var offline = !d.state || !!d.state.offline;
    var powered = !offline && !!st.power;
    var indoor = Number(st.indoorTemp);
    var hasIndoor = !offline && !isNaN(indoor);
    var temp = hasIndoor ? Math.round(indoor) + '°' : '—';
    var tgt = Number(st.targetTemp);
    var hasTgt = !offline && !isNaN(tgt);
    var tgtVal = hasTgt ? String(tgt) : '';                               // dot-decimal → stepper math
    var tgtDisp = hasTgt ? (String(tgt).replace('.', ',') + ' °C') : '—'; // comma → display
    var statusCls = offline ? 'off-line' : (powered ? 'on' : 'off');
    var statusTxt = offline ? (PT.mideaOffline || 'Offline') : (powered ? (PT.mideaPowerOn || 'On') : (PT.mideaPowerOff || 'Off'));
    var dis = (_mideaLoggedIn && !offline) ? '' : ' disabled';
    var outdoor = (!offline && st.outdoorTemp != null && !isNaN(Number(st.outdoorTemp)))
      ? '<div class="ac-outdoor"><span class="ac-outdoor-v">' + escHtml((PT.mideaOutdoor || 'Outdoor') + ' ' + Math.round(Number(st.outdoorTemp)) + '°') + '</span></div>' : '';
    var isAuto = (!offline && st.fanSpeed === 102);
    var fanIdx = (offline || isNaN(Number(st.fanSpeed))) ? 3 : fanIndex(Number(st.fanSpeed));
    var fanValTxt = isAuto ? (PT.mideaFanAuto || 'Auto') : (FAN_STEPS[fanIdx] + '%');
    var fan =
      '<div><div class="fan-row' + (isAuto ? ' fan-auto' : '') + '">' +
        '<div class="fan-head"><div class="set-lbl">' + escHtml(PT.mideaFan || 'Fan') + '</div>' +
          '<button type="button" class="chip-tgl' + (isAuto ? ' active' : '') + '" data-act="fan-auto"' + dis + '>' + escHtml(PT.mideaFanAuto || 'Auto') + '</button>' +
          '<span class="fan-val">' + escHtml(fanValTxt) + '</span></div>' +
        '<div class="fan-slider"><input type="range" min="0" max="5" step="1" value="' + fanIdx + '" data-act="fan"' + dis + ' aria-label="' + escHtml(PT.mideaFan || 'Fan') + '">' +
          '<div class="fan-ticks"><span>1%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div></div>' +
      '</div></div>';
    var extras =
      '<div><div class="set-lbl">' + escHtml(PT.mideaExtras || 'Extras') + '</div><div class="chip-row">' +
        '<button type="button" class="chip-tgl' + ((!offline && st.turbo) ? ' active' : '') + '" data-act="turbo"' + dis + '>' + escHtml(PT.mideaTurbo || 'Turbo') + '</button>' +
        '<button type="button" class="chip-tgl' + ((!offline && st.eco) ? ' active' : '') + '" data-act="eco"' + dis + '>' + escHtml(PT.mideaEco || 'Eco') + '</button>' +
      '</div></div>';
    // Temperature ring (target-based, NOT a 0–100% gauge): r=52 circle, 16–30 °C mapped to the arc.
    var r = 52, C = 2 * Math.PI * r;
    var MIN = 16, MAX = 30;
    var frac = hasTgt ? Math.max(0, Math.min(1, (tgt - MIN) / (MAX - MIN))) : 0;
    var dash = C.toFixed(1);
    var dashOff = (C - frac * C).toFixed(1);
    var ringC = offline ? 'var(--faint)' : ((st.mode === 'heat') ? 'var(--coral)' : 'var(--teal)'); // heat → coral, else teal
    var ringBig = hasTgt ? String(Math.round(tgt)) : '—';
    var modeBtns = MIDEA_MODES.map(function (m) {
      var active = !offline && st.mode === m;
      var cls = 'modeseg-opt' + (active ? ' on' : '') + (active && m === 'heat' ? ' heat' : '');
      var lbl = escHtml(mideaModeLabel(m));
      return '<button type="button" class="' + cls + '" data-mode="' + m + '" aria-pressed="' + (active ? 'true' : 'false') + '"' + dis + '>' + lbl + '</button>';
    }).join('');
    var meta = d.transport ? '<div class="ac-meta">' + escHtml(d.transport === 'cloud' ? 'Cloud' : 'LAN') + '</div>' : '';
    var powerBtn = offline
      ? '<button type="button" class="btn-power" data-act="power" disabled>' + escHtml(PT.mideaOffline || 'Offline') + '</button>'
      : '<button type="button" class="btn-power' + (powered ? ' is-on' : '') + '" data-act="power"' + dis + '>' + MIDEA_POWER_ICON + '<span>' + escHtml(PT.mideaPower || '') + '</span></button>';
    var login = (_mideaLoggedIn || offline) ? '' :
      '<div class="midea-login-hint"><span>' + escHtml(PT.mideaLoginToControl || '') + '</span><a href="/login">' + escHtml(PT.mideaLoginLink || 'Log in') + '</a></div>';
    return '<div class="ac midea-card' + (offline ? ' offline' : '') + '" data-id="' + Number(d.id) + '">' +
      '<div class="ac-head">' +
        '<span class="ac-ic">' + MIDEA_AC_ICON + '</span>' +
        '<div class="ac-headtext"><div class="ac-name">' + escHtml(d.name) + '</div>' + meta + '</div>' +
        '<span class="ac-status midea-status ' + statusCls + '" data-power="' + (powered ? 'true' : 'false') + '"><span class="sdot"></span>' + escHtml(statusTxt) + '</span>' +
      '</div>' +
      '<div class="ac-climate ac-ring">' +
        '<div class="ring"><svg viewBox="0 0 120 120" width="106" height="106">' +
          '<circle cx="60" cy="60" r="52" fill="none" stroke="var(--track)" stroke-width="11"/>' +
          '<circle cx="60" cy="60" r="52" fill="none" stroke="' + ringC + '" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + dash + '" stroke-dashoffset="' + dashOff + '"/>' +
        '</svg><div class="rc"><div><div class="t">' + escHtml(ringBig) + '<sup>°</sup></div><div class="c">' + escHtml(PT.mideaTarget || '') + '</div></div></div></div>' +
        '<div class="ac-side">' +
          '<div class="ac-row"><span>' + escHtml(PT.mideaCurrent || '') + '</span><b>' + escHtml(temp) + '</b></div>' +
          outdoor +
          '<div class="ac-row"><span>' + escHtml(PT.mideaTarget || '') + '</span>' +
            '<div class="stepper"><button type="button" data-step="-1" aria-label="' + escHtml(PT.mideaCooler || '') + '"' + dis + '>−</button>' +
              '<span class="v midea-target" data-val="' + tgtVal + '">' + escHtml(tgtDisp) + '</span>' +
              '<button type="button" data-step="1" aria-label="' + escHtml(PT.mideaWarmer || '') + '"' + dis + '>+</button></div></div>' +
          '<div class="modeseg">' + modeBtns + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ac-set">' + fan + extras + '</div>' +
      '<div class="ac-foot">' + powerBtn + '</div>' + login +
    '</div>';
  }

  function renderMidea(devices) {
    var list = document.getElementById('midea-list');
    if (!list) return;
    list.innerHTML = devices.map(renderMideaCard).join('');
  }

  function mideaSetDevice(id, state) {
    _mideaDevices = _mideaDevices.map(function (d) { return d.id === id ? Object.assign({}, d, { state: state }) : d; });
  }

  // Re-render a single card in place (keeps other cards' optimistic/pending state intact).
  // confirmed=true marks the target green (device confirmed the setpoint).
  function mideaRenderCard(id, confirmed) {
    var dev = null;
    _mideaDevices.forEach(function (d) { if (d.id === id) dev = d; });
    var old = document.querySelector('.midea-card[data-id="' + id + '"]');
    if (!dev || !old) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = renderMideaCard(dev);
    var fresh = tmp.firstElementChild;
    if (confirmed) { var s = fresh.querySelector('.stepper'); if (s) s.classList.add('confirmed'); }
    old.parentNode.replaceChild(fresh, old);
  }

  function patchMideaCard(id, state) {
    mideaSetDevice(id, state);
    // Nicht neu rendern, während der Nutzer den Lüfter-Slider dieser Karte aktiv hat (Drag/Fokus).
    var a = document.activeElement;
    if (a && a.matches && a.matches('input[data-act="fan"]') &&
        a.closest('.midea-card') && Number(a.closest('.midea-card').dataset.id) === id) return;
    mideaRenderCard(id, false);
  }

  function mideaControl(cardEl, patch) {
    var id = Number(cardEl.dataset.id);
    fetch('/api/v1/portal/midea/' + id + '/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: patch }),
    }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (body) {
      var m = document.getElementById('mideaMsg');
      if (body && body.ok && body.data && body.data.state) { patchMideaCard(id, body.data.state); }
      else if (m) { m.textContent = PT.mideaError || ''; m.style.display = 'block'; }
    }).catch(function () { var m = document.getElementById('mideaMsg'); if (m) { m.textContent = PT.mideaError || ''; m.style.display = 'block'; } });
  }

  // Target-temp stepper: 1° steps (this AC rounds to whole degrees) + optimistic UI.
  // The displayed value changes immediately (amber = pending); the command is sent
  // debounced so rapid +/- clicks coalesce into one command with the final value;
  // the device's confirmed setpoint turns it green.
  function mideaStep(cardEl, delta) {
    var tEl = cardEl.querySelector('.midea-target');
    var cur = parseFloat(tEl.dataset.val);
    if (!Number.isFinite(cur)) return; // no state yet → don't send a default
    var next = Math.min(30, Math.max(16, Math.round(cur) + delta)); // whole-degree steps
    tEl.dataset.val = String(next);
    tEl.textContent = String(next) + ' °C';
    var stepper = cardEl.querySelector('.stepper');
    if (stepper) { stepper.classList.add('pending'); stepper.classList.remove('confirmed'); } // optimistic feedback
    mideaCommitTarget(Number(cardEl.dataset.id), next);
  }

  function mideaCommitTarget(id, value) {
    if (_mideaSendTimers[id]) clearTimeout(_mideaSendTimers[id]);
    _mideaSendTimers[id] = setTimeout(function () {
      delete _mideaSendTimers[id];
      fetch('/api/v1/portal/midea/' + id + '/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { targetTemp: value } }),
      }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (body) {
        if (body && body.ok && body.data && body.data.state) {
          mideaSetDevice(id, body.data.state); mideaRenderCard(id, true); // confirmed → green
        } else { mideaTargetError(id); }
      }).catch(function () { mideaTargetError(id); });
    }, 500); // coalesce rapid +/- clicks into one command with the final value
  }

  function mideaTargetError(id) {
    var stepper = document.querySelector('.midea-card[data-id="' + id + '"] .stepper');
    if (stepper) stepper.classList.remove('pending');
    var m = document.getElementById('mideaMsg');
    if (m) { m.textContent = PT.mideaError || ''; m.style.display = 'block'; }
  }

  function onMideaClick(ev) {
    var cardEl = ev.target.closest('.midea-card');
    if (!cardEl) return;
    var stepBtn = ev.target.closest('button[data-step]');
    if (stepBtn) { mideaStep(cardEl, Number(stepBtn.dataset.step)); return; } // optimistic + debounced
    var patch = null;
    var powerBtn = ev.target.closest('button[data-act="power"]');
    var modeBtn = ev.target.closest('button[data-mode]');
    var fanAutoBtn = ev.target.closest('button[data-act="fan-auto"]');
    var toggleBtn = ev.target.closest('button[data-act="turbo"],button[data-act="eco"]');
    if (powerBtn) {
      var powered = cardEl.querySelector('.midea-status').dataset.power === 'true';
      patch = { power: !powered };
    } else if (modeBtn) {
      patch = { mode: modeBtn.dataset.mode };
    } else if (fanAutoBtn) {
      patch = { fanSpeed: 102 };
    } else if (toggleBtn) {
      var act = toggleBtn.dataset.act;
      var cur = null; _mideaDevices.forEach(function (x) { if (x.id === Number(cardEl.dataset.id)) cur = x; });
      patch = {}; patch[act] = !(cur && cur.state && cur.state[act]);
    }
    if (patch) mideaControl(cardEl, patch);
  }

  // ─── Smart Home widget ──────────────────────────────────────────────────────
  function shControl(id, patch, card) {
    fetch('/api/v1/portal/smarthome/' + Number(id) + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: patch })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.reason === 'login_required') { showSmarthomeLogin(card); }
    }).catch(function () {});
  }
  function showSmarthomeLogin(card) {
    var msg = document.getElementById('smarthomeMsg');
    if (msg) { msg.style.display = 'block'; msg.textContent = PT.smarthomeLoginToControl || 'Login required'; }
  }
  // Static, hard-coded SVG per device kind — no user data interpolated, safe as innerHTML.
  var SH_ICONS = {
    light:  '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.2 1 2.5h6c0-1.3.3-1.8 1-2.5A6 6 0 0 0 12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    group:  '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.2 1 2.5h6c0-1.3.3-1.8 1-2.5A6 6 0 0 0 12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    plug:   '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M15 12h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
    switch: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 8h16M4 8l2-4h12l2 4M6 8v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    scene:  '<svg viewBox="0 0 24 24" fill="none"><path d="M4 8h16M4 8l2-4h12l2 4M6 8v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  };
  function shStatusText(st, caps) {
    var onLabel = st.on ? (PT.smarthomeOn || 'On') : (PT.smarthomeOff || 'Off');
    if (st.on && caps.bri && st.bri != null) return onLabel + ' · ' + Math.round(Number(st.bri)) + ' %';
    return onLabel;
  }
  function renderSmarthomeCard(d) {
    var el = document.createElement('div'); el.className = 'sh-tile';
    var st = d.state || {}, caps = d.capabilities || {};
    var ic = document.createElement('span'); ic.className = 'sh-ic'; ic.innerHTML = SH_ICONS[d.kind] || SH_ICONS.light; el.appendChild(ic);
    var nm = document.createElement('div'); nm.className = 'nm';
    var b = document.createElement('b'); b.textContent = d.name || ''; nm.appendChild(b);
    var sub = document.createElement('span'); nm.appendChild(sub);
    el.appendChild(nm);
    if (d.kind === 'scene') {
      var btn = document.createElement('button'); btn.className = 'btn btn-sm'; btn.textContent = PT.smarthomeActivate || 'Activate';
      btn.addEventListener('click', function () { shControl(d.id, {}, el); });
      el.appendChild(btn);
      return el;
    }
    sub.textContent = shStatusText(st, caps);
    el.classList.toggle('on', !!st.on);
    // a11y: toggle pill exposes role="switch" + aria-checked reflecting on/off state (WAI-ARIA switch pattern)
    var sw = document.createElement('span');
    sw.className = 'toggle';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('tabindex', '0');
    sw.setAttribute('aria-checked', st.on ? 'true' : 'false');
    sw.setAttribute('aria-label', d.name || '');
    el.appendChild(sw);
    var flip = function () {
      var on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sub.textContent = shStatusText({ on: on, bri: st.bri }, caps);
      shControl(d.id, { on: on }, el);
    };
    sw.addEventListener('click', flip);
    sw.addEventListener('keydown', function (ev) { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); flip(); } });
    if (caps.bri) {
      var range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 100; range.value = (st.bri != null ? st.bri : 0); range.className = 'c-sh-bri';
      range.addEventListener('change', function () { st.bri = Number(range.value); sub.textContent = shStatusText({ on: el.classList.contains('on'), bri: st.bri }, caps); shControl(d.id, { bri: Number(range.value) }, el); });
      el.appendChild(range);
    }
    return el;
  }
  // type-strings EXACTLY as sensorReading() in src/services/smarthome/index.js emits:
  // presence|open|water (boolean) · temperature|humidity|lightlevel (number, already /100 normalised) · button|unknown → "—"
  function formatSensor(type, value) {
    if (value === null || value === undefined || value === '') return '—';
    switch (type) {
      case 'temperature': return Number(value).toFixed(1) + ' °C';
      case 'humidity':    return Number(value) + ' %';
      case 'lightlevel':  return Number(value) + ' lux';
      case 'open':        return value ? (PT.smarthomeOpen || 'Open') : (PT.smarthomeClosed || 'Closed');
      case 'presence':    return value ? (PT.smarthomeMotion || 'Motion') : (PT.smarthomeNoMotion || 'No motion');
      case 'water':       return value ? (PT.smarthomeWet || 'Wet') : (PT.smarthomeDry || 'Dry');
      default:            return '—'; // ponytail: button/unknown/future types → safe fallback, no raw value render
    }
  }
  function renderSensorCard(s) {
    var el = document.createElement('div'); el.className = 'sensor';
    var st = s.state || {};
    var val = document.createElement('div'); val.className = 'v'; val.textContent = formatSensor(st.type, st.value); el.appendChild(val);
    var lbl = document.createElement('div'); lbl.className = 'l'; lbl.textContent = s.name || ''; el.appendChild(lbl);
    return el;
  }
  function hydrateSmarthome() {
    var card = document.querySelector('.c-smarthome');
    if (!card) return;
    fetch('/api/v1/portal/smarthome').then(function (r) { return r.json(); }).then(function (j) {
      var list = document.getElementById('smarthome-list'); if (!list) return;
      list.innerHTML = '';
      if (!j || !j.data) { card.style.display = 'none'; return; }
      card.style.display = '';
      (j.data.devices || []).forEach(function (d) { list.appendChild(renderSmarthomeCard(d)); });
      var sensorBox = document.getElementById('smarthome-sensors');
      if (sensorBox) {
        sensorBox.innerHTML = '';
        var sensors = (j && j.data && j.data.sensors) || [];
        sensorBox.setAttribute('aria-label', PT.smarthomeSensors || 'Sensors');
        if (sensors.length) {
          sensors.forEach(function (s) { sensorBox.appendChild(renderSensorCard(s)); });
          sensorBox.style.display = '';
        } else {
          sensorBox.style.display = 'none';
        }
      }
    }).catch(function () { card.style.display = 'none'; });
  }

  function hydrateMidea() {
    var card = document.querySelector('.c-midea');
    if (!card) return;
    if (!card.dataset.wired) { card.dataset.wired = '1'; card.addEventListener('click', onMideaClick); } // scoped, once
    if (!card.dataset.wiredChange) {
      card.dataset.wiredChange = '1';
      card.addEventListener('change', function (ev) {
        var slider = ev.target.closest('input[data-act="fan"]');
        if (!slider) return;
        var cardEl = slider.closest('.midea-card');
        if (!cardEl || slider.disabled) return;
        mideaControl(cardEl, { fanSpeed: FAN_STEPS[Number(slider.value)] });
      });
    }
    setLoading(card, true);
    fetch('/api/v1/portal/midea')
      .then(function (r) { if (!r.ok) { if (r.status === 404) card.style.display = 'none'; throw new Error('HTTP ' + r.status); } return r.json(); })
      .then(function (body) {
        setLoading(card, false);
        if (!body.ok || body.data === null) { card.style.display = 'none'; return; } // hide on unavailable/no_owner/no_data
        _mideaLoggedIn = !!body.data.loggedIn;
        _mideaDevices = body.data.devices || [];
        renderMidea(_mideaDevices);
        startMideaPoll();
      })
      .catch(function () { setLoading(card, false); showError(card, hydrateMidea); });
  }

  // Visibility + network-bound poll: one timer, teardown before re-bind. >=120s; pause on hidden/offline/429.
  function startMideaPoll() {
    if (_mideaTimer) { clearInterval(_mideaTimer); _mideaTimer = null; }
    if (_mideaCtl) { _mideaCtl.abort(); _mideaCtl = null; }
    if (!_mideaDevices.length) return;
    _mideaCtl = new AbortController();
    var run = function () {
      if (_mideaTimer) return;
      var gen = ++_mideaPollGen;
      _mideaTimer = setInterval(function () {
        _mideaDevices.forEach(function (d) {
          fetch('/api/v1/portal/midea/' + Number(d.id) + '/state', { signal: _mideaCtl.signal })
            .then(function (r) { if (r.status === 429) { if (gen === _mideaPollGen) { clearInterval(_mideaTimer); _mideaTimer = null; } return null; } return r.json(); })
            .then(function (body) { if (body && body.ok && body.data && body.data.state) patchMideaCard(Number(d.id), body.data.state); })
            .catch(function () {});
        });
      }, 120000);
    };
    var stop = function () { if (_mideaTimer) { clearInterval(_mideaTimer); _mideaTimer = null; } };
    if (!document.hidden) run();
    document.addEventListener('visibilitychange', function () { return document.hidden ? stop() : run(); }, { signal: _mideaCtl.signal });
    window.addEventListener('offline', stop, { signal: _mideaCtl.signal });
    window.addEventListener('online', run, { signal: _mideaCtl.signal });
  }

  function skodaEl() { return document.getElementById('skoda-list'); }

  function skodaRingSvg(soc, charging) {
    var r = 52, C = 2 * Math.PI * r;
    var frac = (typeof soc === 'number') ? Math.max(0, Math.min(1, soc / 100)) : 0;
    var dashOff = (C - frac * C).toFixed(1);
    var col = charging ? 'var(--teal)' : (frac <= 0.15 ? 'var(--coral)' : 'var(--green)');
    return '<div class="ring"><svg viewBox="0 0 120 120" width="106" height="106">'
      + '<circle cx="60" cy="60" r="52" fill="none" stroke="var(--track)" stroke-width="10"/>'
      + '<circle cx="60" cy="60" r="52" fill="none" stroke="' + col + '" stroke-width="10" stroke-linecap="round"'
      + ' stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + dashOff + '"/></svg>'
      + '<div class="rc"><strong>' + (typeof soc === 'number' ? soc + '%' : '—') + '</strong></div></div>';
  }

  function minutesAgo(iso) {
    if (!iso) return '';
    var t = Date.parse(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
    if (!isFinite(t)) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return PT.skodaAsOf + ': ' + (m < 60 ? m + ' min' : Math.round(m / 60) + ' h');
  }

  // Derived connection dot: TP1 has no true online flag, so a fresh last-sync
  // (< 60 min) is treated as "reachable". Purely indicative, paired with "as of".
  function skodaConnDot(fetchedAt) {
    var t = fetchedAt ? Date.parse(String(fetchedAt).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(fetchedAt) ? '' : 'Z')) : NaN;
    var on = isFinite(t) && (Date.now() - t) < 3600000;
    return '<span class="skoda-dot ' + (on ? 'on' : 'off') + '"></span>';
  }
  // Every value below ultimately comes from the external Skoda cloud, so escape
  // each one before it hits innerHTML — even the "always numeric" display fields.
  function numOr(v, unit) { return v != null ? escHtml(v + (unit || '')) : '—'; }
  function lockChip(label, active) {
    return '<span class="skoda-chip' + (active ? ' open' : '') + '">' + escHtml(label) + '</span>';
  }

  function renderSkodaCard(v) {
    var s = v.state || {};
    var ch = s.charging || {}, cl = s.climate || {}, hl = s.health || {}, mt = s.maintenance || {}, dt = s.detail || {};
    var up = function (x) { return String(x || '').toUpperCase(); };
    var lock = s.locked === true ? PT.skodaLocked : (s.locked === false ? PT.skodaUnlocked : '—');
    // Icon grid: each element shown individually, open/on ones highlighted.
    var chips = lockChip(PT.skodaDoors, s.doorsOpen === true)
      + lockChip(PT.skodaWindows, s.windowsOpen === true)
      + lockChip(PT.skodaBonnet, up(dt.bonnet) === 'OPEN')
      + lockChip(PT.skodaTrunk, up(dt.trunk) === 'OPEN')
      + (dt.sunroof != null && up(dt.sunroof) !== 'UNSUPPORTED' ? lockChip(PT.skodaSunroof, up(dt.sunroof) === 'OPEN') : '')
      + (s.lightsOn === true ? lockChip(PT.skodaLightsOn, true) : '');
    var pos = s.position;
    var plat = pos ? Number(pos.lat) : NaN, plon = pos ? Number(pos.lon) : NaN;
    var posOk = isFinite(plat) && isFinite(plon);
    var posText = posOk ? (pos.address || (plat.toFixed(4) + ', ' + plon.toFixed(4))) : (pos && pos.address ? pos.address : '—');
    var posLink = posOk
      ? '<a href="https://www.openstreetmap.org/?mlat=' + plat + '&mlon=' + plon + '" target="_blank" rel="noopener" title="' + escHtml(plat + ', ' + plon) + '">' + escHtml(posText) + '</a>'
      : escHtml(posText);
    return '<div class="skoda-card" data-id="' + escHtml(v.id) + '">'
      + '<div class="skoda-head">'
      + (v.has_image ? '<img class="skoda-img" src="/api/v1/portal/skoda/vehicles/' + encodeURIComponent(v.id) + '/image" alt="">' : '')
      + '<div><strong>' + skodaConnDot(v.fetched_at) + escHtml(v.name || v.model || '') + '</strong>'
      + '<div class="skoda-sub">' + escHtml(minutesAgo(v.fetched_at)) + '</div></div></div>'
      + '<div class="skoda-batt">' + skodaRingSvg(s.soc, up(ch.state) === 'CHARGING')
      + '<div class="skoda-batt-info"><div>' + PT.skodaSoc + ': ' + numOr(s.soc, '%') + '</div>'
      + '<div>' + PT.skodaRange + ': ' + numOr(s.rangeKm, ' km') + '</div>'
      + (up(ch.state) === 'CHARGING' ? '<div>' + PT.skodaCharging + ': ' + numOr(ch.powerKw, ' kW')
          + (ch.remainingMin != null ? ' · ' + numOr(ch.remainingMin, ' min') : '')
          + (ch.targetPercent != null ? ' · ' + numOr(ch.targetPercent, '%') : '') + '</div>' : '')
      + (ch.cableConnected ? '<div>' + PT.skodaCableConnected + '</div>' : '') + '</div></div>'
      + '<div class="skoda-row"><span class="skoda-lock">' + escHtml(lock) + '</span>'
      + '<span class="skoda-chips">' + chips + '</span></div>'
      + '<div class="skoda-row">' + PT.skodaClimate + ': ' + (cl.state == null ? '—' : (up(cl.state) === 'OFF' ? PT.skodaClimateOff : PT.skodaClimateOn))
      + (cl.targetC != null ? ' · ' + PT.skodaTargetTemp + ' ' + numOr(cl.targetC, '°C') : '')
      + (cl.remainingMin != null ? ' · ' + PT.skodaClimateRemaining + ' ' + numOr(cl.remainingMin, ' min') : '')
      + (cl.windowHeating === true ? ' · ' + PT.skodaWindowHeating : '') + '</div>'
      + '<details class="skoda-details"><summary>' + PT.skodaPosition + ' · ' + PT.skodaMileage + '</summary>'
      + '<div>' + PT.skodaPosition + ': ' + posLink + '</div>'
      + '<div>' + PT.skodaMileage + ': ' + numOr(hl.mileageKm, ' km') + '</div>'
      + '<div>' + PT.skodaInspection + ': ' + numOr(mt.dueInDays, ' d')
      + (mt.dueInKm != null ? ' · ' + numOr(mt.dueInKm, ' km') : '') + '</div>'
      + (mt.partner ? '<div>' + PT.skodaPartner + ': ' + escHtml(mt.partner) + '</div>' : '')
      + (hl.warnings && hl.warnings.length ? '<div>' + PT.skodaWarnings + ': ' + escHtml(hl.warnings.join(', ')) + '</div>' : '')
      + '</details></div>';
  }

  function renderSkoda(vehicles) {
    var el = skodaEl(); if (!el) return;
    // Preserve which cards had their <details> expanded across the full rebuild,
    // so a 120s poll never collapses what the user opened. Tracked by position
    // (card order is stable — server returns vehicles ORDER BY id) using only
    // the boolean `details.open`, so no DOM text ever feeds back into innerHTML.
    var wasOpen = [];
    var oldCards = el.querySelectorAll('.skoda-card');
    for (var i = 0; i < oldCards.length; i++) {
      var od = oldCards[i].querySelector('details');
      wasOpen[i] = !!(od && od.open);
    }
    el.innerHTML = vehicles.map(renderSkodaCard).join('');
    var newCards = el.querySelectorAll('.skoda-card');
    for (var j = 0; j < newCards.length; j++) {
      if (wasOpen[j]) { var nd = newCards[j].querySelector('details'); if (nd) nd.open = true; }
    }
  }

  function hydrateSkoda() {
    var card = document.querySelector('.c-skoda'); if (!card) return;
    fetch('/api/v1/portal/skoda').then(function (r) { return r.status === 404 ? null : r.json(); }).then(function (body) {
      if (!body || !body.ok || body.data === null) { card.style.display = 'none'; return; }
      renderSkoda(body.data.vehicles);
      startSkodaPoll(); // start polling only once we have data (mirrors hydrateMidea)
    }).catch(function () { card.style.display = 'none'; });
  }

  var _skodaTimer = null;
  function startSkodaPoll() {
    if (_skodaTimer) clearInterval(_skodaTimer);
    _skodaTimer = setInterval(function () {
      if (document.hidden) return;
      // Poll refresh: render on success, keep the last good cards on any
      // failure/null — a transient hiccup must never blank the whole section.
      fetch('/api/v1/portal/skoda').then(function (r) { return r.json(); }).then(function (body) {
        if (body && body.ok && body.data) renderSkoda(body.data.vehicles);
      }).catch(function () {});
    }, 120000);
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  hydrateDevice();
  hydrateTraffic();
  hydrateServices();
  hydratePihole();
  hydrateMidea();
  hydrateSmarthome();
  hydrateSkoda();

})();
