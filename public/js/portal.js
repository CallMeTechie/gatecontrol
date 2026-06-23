// public/js/portal.js — GateControl VPN Landing Portal client
// Vanilla JS, no framework. Served as a static asset.
'use strict';
(function () {

  // ─── Inject minimal portal-JS CSS (loading skeleton + state elements) ──────
  (function injectCSS() {
    const s = document.createElement('style');
    s.textContent =
      '.card.loading{pointer-events:none}' +
      '@keyframes gc-shimmer{0%,100%{opacity:.38}50%{opacity:.15}}' +
      '@media(prefers-reduced-motion:no-preference){' +
        '.card.loading>*:not(h2){animation:gc-shimmer 1.5s ease infinite}' +
      '}' +
      '.portal-fallback{padding:16px 0;color:var(--muted);font-size:13px;line-height:1.55}' +
      '.portal-error-state{margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;' +
        'padding:10px 12px;border-radius:10px;background:rgba(245,196,81,.08);border:1px solid rgba(245,196,81,.2)}' +
      '.portal-error-msg{font-size:13px;color:var(--amber);flex:1}' +
      '.portal-retry-btn{background:transparent;border:1px solid var(--amber);color:var(--amber);' +
        'padding:4px 10px;border-radius:8px;cursor:pointer;font-size:12px;font-family:var(--font-body);' +
        'transition:.15s}' +
      '.portal-retry-btn:hover{background:rgba(245,196,81,.12)}' +
      '.portal-empty{padding:24px 0;color:var(--faint);font-size:13px;text-align:center;grid-column:1/-1}';
    document.head.appendChild(s);
  })();

  // ─── Locale detection ───────────────────────────────────────────────────────
  const lang = (document.documentElement.lang || 'de').slice(0, 2).toLowerCase();
  const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  // ─── Formatters ─────────────────────────────────────────────────────────────
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    let v = Number(bytes);
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
    const numStr = i === 0 ? String(Math.round(v)) : v.toFixed(1);
    const localized = lang === 'de' ? numStr.replace('.', ',') : numStr;
    return localized + ' ' + BYTE_UNITS[i];
  }

  function fmtRelTime(ts) {
    if (!ts) return '—';
    const now = Date.now();
    const t = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
    const s = Math.floor((now - t) / 1000);
    if (s < 5)  return lang === 'de' ? 'gerade eben' : 'just now';
    if (s < 60) return lang === 'de' ? 'vor ' + s + ' Sek.' : s + 's ago';
    const m = Math.floor(s / 60);
    if (s < 3600) return lang === 'de' ? 'vor ' + m + ' Min.' : m + 'm ago';
    const h = Math.floor(s / 3600);
    if (s < 86400) return lang === 'de' ? 'vor ' + h + ' Std.' : h + 'h ago';
    const d = Math.floor(s / 86400);
    return lang === 'de' ? 'vor ' + d + ' Tagen' : d + 'd ago';
  }

  const WKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const WKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function bucketLabel(isoStr, range, idx) {
    if (range === '30d') return 'W' + (idx + 1);
    const d = new Date(isoStr);
    if (range === '24h') return String(d.getUTCHours()).padStart(2, '0');
    return (lang === 'de' ? WKDAYS_DE : WKDAYS_EN)[d.getUTCDay()];
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Shared state helpers ───────────────────────────────────────────────────
  const FALLBACK_MSG = lang === 'de'
    ? 'Dieses Gerät verbindet sich über ein Gateway — gerätespezifische Daten sind nicht verfügbar.'
    : 'This device connects via a gateway — per-device data is unavailable.';

  function setLoading(card, on) {
    if (!card) return;
    card.classList.toggle('loading', on);
  }

  function showFallback(el) {
    if (!el) return;
    el.innerHTML = '<p class="portal-fallback">' + FALLBACK_MSG + '</p>';
  }

  function showError(card, retryFn) {
    if (!card) return;
    let el = card.querySelector('.portal-error-state');
    if (!el) {
      el = document.createElement('div');
      el.className = 'portal-error-state';
      card.appendChild(el);
    }
    const unavail = lang === 'de' ? 'Nicht verfügbar' : 'Unavailable';
    const retry   = lang === 'de' ? '↺ Erneut versuchen' : '↺ Retry';
    el.innerHTML =
      '<span class="portal-error-msg">' + unavail + '</span>' +
      '<button class="portal-retry-btn">' + retry + '</button>';
    el.querySelector('.portal-retry-btn').addEventListener('click', function () {
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
          if (d.isOnline) {
            statusEl.innerHTML =
              '<span class="badge-on">' +
              '<span class="dot" style="animation:none"></span>' +
              (lang === 'de' ? 'Online' : 'Online') +
              '</span>';
          } else {
            statusEl.innerHTML =
              '<span style="color:var(--muted)">' +
              (lang === 'de' ? 'Offline' : 'Offline') +
              '</span>';
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
          const empty = lang === 'de' ? 'Noch keine Dienste freigegeben' : 'No services shared yet';
          tilesEl.innerHTML = '<div class="portal-empty">' + empty + '</div>';
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

  // ─── Boot ───────────────────────────────────────────────────────────────────
  hydrateDevice();
  hydrateTraffic();
  hydrateServices();

})();
