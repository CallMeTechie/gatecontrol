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
  const TILE_COLORS = [
    'linear-gradient(145deg,#ffb27a,#e8763f)',
    'linear-gradient(145deg,#7ae0d2,#28b3a2)',
    'linear-gradient(145deg,#9db8ff,#5b76d6)',
    'linear-gradient(145deg,var(--teal),var(--teal-dim))',
  ];
  const TILE_ICON =
    '<svg viewBox="0 0 24 24" fill="none">' +
    '<rect x="3" y="4" width="18" height="6" rx="2" stroke="currentColor" stroke-width="2"/>' +
    '<rect x="3" y="14" width="18" height="6" rx="2" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M7 7h.01M7 17h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';

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
        tilesEl.innerHTML = services.map(function (s, i) {
          const color = TILE_COLORS[i % TILE_COLORS.length];
          return '<a class="tile" href="https://' + escHtml(s.domain) +
            '" target="_blank" rel="noopener noreferrer">' +
            '<span class="ti" style="background:' + color + '">' + TILE_ICON + '</span>' +
            '<span class="tn">' + escHtml(s.name) + '</span>' +
            '<span class="td">' + escHtml(s.domain) + '</span>' +
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
      var bar = document.getElementById('piBar');
      if (bar) bar.style.width = d.blockedPct + '%';
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

  var MIDEA_MODES = ['auto', 'cool', 'heat', 'dry', 'fan'];
  // Static icon strings (no user data → safe to inline). Mirrors the admin /midea card.
  var MIDEA_MODE_ICONS = {
    auto: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v18M3 12h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    cool: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2v20M4 7l16 10M20 7L4 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    heat: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 22c4-3 5-6 3-9-1.4-2.1-1-4 .5-6-3 .5-6 2.5-6 6 0 1.7.7 2.6-1 3.5C7 12 7 9 7 9c-2 2-3 4.5-3 7a8 8 0 008 6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    dry: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3s6 6.5 6 11a6 6 0 11-12 0c0-4.5 6-11 6-11z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    fan: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 12c0-4 1-6 3-6s3 2 1 4-4 2-4 2zm0 0c4 0 6 1 6 3s-2 3-4 1-2-4-2-4zm0 0c0 4-1 6-3 6s-3-2-1-4 4-2 4-2zm0 0c-4 0-6-1-6-3s2-3 4-1 2 4 2 4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  };
  var MIDEA_AC_ICON = '<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M6 18v1M10 18v2M14 18v2M18 18v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var MIDEA_POWER_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v9M6.5 6.5a8 8 0 1011 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function mideaModeLabel(m) { return PT['mideaMode' + m.charAt(0).toUpperCase() + m.slice(1)] || m; }

  // Redesign: card grid with conic-gradient temp-ring + stepper + icon mode-segment + status pill
  // (modeled on the admin /midea card, in the portal design system). Data contract unchanged:
  // .midea-card[data-id], .midea-status[data-power], button[data-act=power]/[data-step]/[data-mode], .midea-target[data-val].
  function renderMideaCard(d) {
    var st = d.state || {};
    var offline = !d.state || !!d.state.offline;
    var powered = !offline && !!st.power;
    var indoor = Number(st.indoorTemp);
    var hasIndoor = !offline && !isNaN(indoor);
    var pct = hasIndoor ? Math.max(0, Math.min(100, ((indoor - 16) / 14) * 100)) : 0; // ring fill, 16–30 °C span
    var ringC = (!offline && st.mode === 'heat') ? 'var(--coral)' : 'var(--teal)';     // heat → coral, else teal
    var temp = hasIndoor ? Math.round(indoor) + '°' : '—';
    var tgt = Number(st.targetTemp);
    var hasTgt = !offline && !isNaN(tgt);
    var tgtVal = hasTgt ? String(tgt) : '';                               // dot-decimal → stepper math
    var tgtDisp = hasTgt ? (String(tgt).replace('.', ',') + ' °C') : '—'; // comma → display
    var statusCls = offline ? 'off-line' : (powered ? 'on' : 'off');
    var statusTxt = offline ? (PT.mideaOffline || 'Offline') : (powered ? (PT.mideaPowerOn || 'On') : (PT.mideaPowerOff || 'Off'));
    var dis = (_mideaLoggedIn && !offline) ? '' : ' disabled';
    var modeBtns = MIDEA_MODES.map(function (m) {
      var active = (!offline && st.mode === m) ? ' active' : '';
      var lbl = escHtml(mideaModeLabel(m));
      return '<button type="button" class="m midea-mode' + active + '" data-mode="' + m + '" title="' + lbl + '" aria-label="' + lbl + '"' + dis + '>' + MIDEA_MODE_ICONS[m] + '</button>';
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
      '<div class="ac-climate">' +
        '<div class="ring" style="--ring-val:' + pct + '%;--ring-c:' + ringC + '"><div class="ring-in"><span class="ring-v">' + escHtml(temp) + '</span><span class="ring-l">' + escHtml(PT.mideaCurrent || '') + '</span></div></div>' +
        '<div class="ac-set">' +
          '<div><div class="set-lbl">' + escHtml(PT.mideaTarget || '') + '</div>' +
            '<div class="stepper"><button type="button" data-step="-1"' + dis + '>−</button><span class="v midea-target" data-val="' + tgtVal + '">' + escHtml(tgtDisp) + '</span><button type="button" data-step="1"' + dis + '>+</button></div></div>' +
          '<div><div class="set-lbl">' + escHtml(PT.mideaMode || '') + '</div><div class="modes">' + modeBtns + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="ac-foot">' + powerBtn + '</div>' + login +
    '</div>';
  }

  function renderMidea(devices) {
    var list = document.getElementById('midea-list');
    if (!list) return;
    list.innerHTML = devices.map(renderMideaCard).join('');
  }

  function patchMideaCard(id, state) {
    _mideaDevices = _mideaDevices.map(function (d) { return d.id === id ? Object.assign({}, d, { state: state }) : d; });
    renderMidea(_mideaDevices);
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

  function onMideaClick(ev) {
    var cardEl = ev.target.closest('.midea-card');
    if (!cardEl) return;
    var patch = null;
    var powerBtn = ev.target.closest('button[data-act="power"]');
    var stepBtn = ev.target.closest('button[data-step]');
    var modeBtn = ev.target.closest('button[data-mode]');
    if (powerBtn) {
      var powered = cardEl.querySelector('.midea-status').dataset.power === 'true';
      patch = { power: !powered };
    } else if (stepBtn) {
      var cur = parseFloat(cardEl.querySelector('.midea-target').dataset.val);
      if (!Number.isFinite(cur)) return;
      patch = { targetTemp: Math.min(30, Math.max(16, cur + Number(stepBtn.dataset.step) * 0.5)) };
    } else if (modeBtn) {
      patch = { mode: modeBtn.dataset.mode };
    }
    if (patch) mideaControl(cardEl, patch);
  }

  function hydrateMidea() {
    var card = document.querySelector('.c-midea');
    if (!card) return;
    if (!card.dataset.wired) { card.dataset.wired = '1'; card.addEventListener('click', onMideaClick); } // scoped, once
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

  // ─── Boot ───────────────────────────────────────────────────────────────────
  hydrateDevice();
  hydrateTraffic();
  hydrateServices();
  hydratePihole();
  hydrateMidea();

})();
