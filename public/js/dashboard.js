'use strict';

(function() {
  const REFRESH_INTERVAL = 15000; // 15 seconds
  let refreshTimer = null;

  // ── Aurora detection (reads layout DOM; must NOT be a GC field) ──────────
  function isAurora() { return !!document.querySelector('.app'); }

  // ─── Stat Cards ─────────────────────────────────────────────────────────────
  async function refreshStats() {
    if (isAurora()) return auroraRefreshStats();
    try {
      const data = await api.get('/api/dashboard/stats');

      // Peers connected
      const peersEl = document.getElementById('stat-peers');
      if (peersEl) peersEl.textContent = data.peers.online;

      // Active routes
      const routesEl = document.getElementById('stat-routes');
      if (routesEl) routesEl.textContent = data.routes.active;

      // Monitoring summary — parseInt guards against type-coercion XSS
      const monitorEl = document.getElementById('stat-monitoring');
      const monitorSubEl = document.getElementById('stat-monitoring-sub');
      if (monitorEl && data.monitoring) {
        var up = parseInt(data.monitoring.up, 10) || 0;
        var total = parseInt(data.monitoring.total, 10) || 0;
        var down = parseInt(data.monitoring.down, 10) || 0;
        if (total > 0) {
          monitorEl.textContent = '';
          var spanUp = document.createElement('span');
          spanUp.style.color = down > 0 ? 'var(--amber)' : 'var(--green)';
          spanUp.textContent = up;
          var spanTotal = document.createElement('span');
          spanTotal.style.color = 'var(--text-2)';
          spanTotal.textContent = '/' + total;
          monitorEl.appendChild(spanUp);
          monitorEl.appendChild(spanTotal);
          if (monitorSubEl) {
            monitorSubEl.textContent = '';
            if (down > 0) {
              var downMsg = (GC.t && GC.t['monitoring.dashboard_down']) || '{n} down';
              monitorSubEl.style.color = 'var(--red)';
              monitorSubEl.textContent = downMsg.replace('{n}', String(down));
            } else {
              monitorSubEl.style.color = 'var(--green)';
              monitorSubEl.textContent = (GC.t && GC.t['monitoring.dashboard_all_ok']) || 'Alle erreichbar';
            }
          }
        } else {
          monitorEl.textContent = '—';
          if (monitorSubEl) {
            monitorSubEl.style.color = 'var(--text-3)';
            monitorSubEl.textContent = (GC.t && GC.t['monitoring.dashboard_empty']) || 'Monitoring nicht aktiv';
          }
        }
      }
      // Traffic today
      const trafficEl = document.getElementById('stat-traffic');
      if (trafficEl) trafficEl.innerHTML = formatTrafficValue(data.traffic.today);

      // Upload/Download rates
      const upRateEl = document.getElementById('stat-upload-rate');
      if (upRateEl) upRateEl.textContent = formatBytes(data.traffic.uploadRate) + '/s';

      const dnRateEl = document.getElementById('stat-download-rate');
      if (dnRateEl) dnRateEl.textContent = formatBytes(data.traffic.downloadRate) + '/s';

      // Avg latency
      const latencyEl = document.getElementById('stat-latency');
      if (latencyEl) {
        latencyEl.textContent = data.latency != null ? data.latency + ' ms' : '—';
      }

      // WireGuard status in topbar
      const wgStatusEl = document.getElementById('wg-status');
      if (wgStatusEl) {
        if (data.wireguard.running) {
          wgStatusEl.classList.remove('inactive');
        } else {
          wgStatusEl.classList.add('inactive');
        }
      }

      // Sidebar badges
      const peerBadge = document.getElementById('peer-count-badge');
      if (peerBadge) peerBadge.textContent = data.peers.total;

      const routeBadge = document.getElementById('route-count-badge');
      if (routeBadge) routeBadge.textContent = data.routes.active;

    } catch (err) {
      console.error('Failed to refresh stats:', err);
    }
  }

  function formatTrafficValue(bytes) {
    if (!bytes || bytes === 0) return '0 <span style="font-size:14px;font-weight:400">B</span>';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const val = v < 10 ? v.toFixed(1) : Math.round(v);
    return `${val}<span style="font-size:14px;font-weight:400"> ${units[i]}</span>`;
  }

  // ─── System Resources ───────────────────────────────────────────────────────
  async function refreshResources() {
    if (isAurora()) return auroraRefreshResources();
    try {
      const data = await api.get('/api/system/resources');

      // CPU
      const cpuPct = document.getElementById('cpu-pct');
      if (cpuPct) cpuPct.textContent = data.cpu.percent + ' %';

      const cpuBar = document.getElementById('cpu-bar');
      if (cpuBar) {
        cpuBar.style.width = data.cpu.percent + '%';
        cpuBar.style.background = data.cpu.percent > 80 ? 'var(--red)' :
          data.cpu.percent > 50 ? 'var(--amber)' : 'var(--green)';
      }

      const cpuInfo = document.getElementById('cpu-info');
      if (cpuInfo) cpuInfo.textContent = `${data.cpu.cores} Cores · ${data.cpu.model.split(' ').slice(0, 3).join(' ')}`;

      // RAM
      const ramPct = document.getElementById('ram-pct');
      if (ramPct) ramPct.textContent = data.memory.percent + ' %';

      const ramBar = document.getElementById('ram-bar');
      if (ramBar) {
        ramBar.style.width = data.memory.percent + '%';
        ramBar.style.background = data.memory.percent > 90 ? 'var(--red)' :
          data.memory.percent > 70 ? 'var(--amber)' : 'var(--blue)';
      }

      const ramInfo = document.getElementById('ram-info');
      if (ramInfo) ramInfo.textContent = `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`;

      // Uptime
      const uptimeValue = document.getElementById('uptime-value');
      if (uptimeValue) uptimeValue.textContent = data.uptime.formatted;

      const uptimeBoot = document.getElementById('uptime-boot');
      if (uptimeBoot && data.uptime && data.uptime.bootTime) {
        const label = (GC.t && GC.t['dashboard.booted_on']) || 'Seit {date}';
        uptimeBoot.textContent = label.replace('{date}', data.uptime.bootTime);
      }

    } catch (err) {
      console.error('Failed to refresh resources:', err);
    }
  }

  // ─── Activity Feed ──────────────────────────────────────────────────────────
  async function refreshActivity() {
    if (isAurora()) return auroraRefreshActivity();
    try {
      const data = await api.get('/api/logs/recent?limit=6');
      const feed = document.getElementById('activity-feed');
      if (!feed) return;

      if (!data.entries || data.entries.length === 0) {
        feed.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">No events yet</div>';
        return;
      }

      feed.innerHTML = data.entries.map(entry => {
        const colorMap = { green: 'var(--green)', red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)' };
        const dotColor = colorMap[entry.color] || 'var(--blue)';
        const time = formatRelativeTime(entry.created_at);

        return `
          <div class="activity-item">
            <div class="activity-dot" style="background:${dotColor}"></div>
            <div>
              <div class="activity-text">${escapeHtml(entry.message)}</div>
              <div class="activity-time">${time}${entry.ip_address ? ' · ' + escapeHtml(entry.ip_address) : ''}</div>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('Failed to refresh activity:', err);
    }
  }

  // ─── Traffic Chart ──────────────────────────────────────────────────────────
  async function refreshChart(period) {
    if (isAurora()) return auroraRefreshChart(period);
    try {
      const data = await api.get(`/api/dashboard/traffic?period=${period || '1h'}`);
      renderChart(data.data);
    } catch (err) {
      console.error('Failed to refresh chart:', err);
    }
  }

  function renderChart(dataPoints) {
    const svg = document.querySelector('#traffic-chart .chart-svg');
    if (!svg || !dataPoints || dataPoints.length === 0) return;

    const w = 560, h = 120;
    const maxVal = Math.max(1, ...dataPoints.map(d => Math.max(d.upload, d.download)));

    function toPath(points, key) {
      if (points.length === 0) return '';
      const step = w / Math.max(1, points.length - 1);
      return points.map((p, i) => {
        const x = i * step;
        const y = h - 10 - ((p[key] / maxVal) * (h - 20));
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
    }

    const upPath = toPath(dataPoints, 'upload');
    const dnPath = toPath(dataPoints, 'download');

    // Area paths (close to bottom)
    const upArea = upPath + ` L${w},${h} L0,${h} Z`;
    const dnArea = dnPath + ` L${w},${h} L0,${h} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0a6e4f" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#0a6e4f" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="gDn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1d4ed8" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="30" x2="${w}" y2="30" stroke="#e4e0d6" stroke-width="1"/>
      <line x1="0" y1="60" x2="${w}" y2="60" stroke="#e4e0d6" stroke-width="1"/>
      <line x1="0" y1="90" x2="${w}" y2="90" stroke="#e4e0d6" stroke-width="1"/>
      <path d="${upArea}" fill="url(#gUp)"/>
      <path d="${upPath}" fill="none" stroke="#0a6e4f" stroke-width="2"/>
      <path d="${dnArea}" fill="url(#gDn)"/>
      <path d="${dnPath}" fill="none" stroke="#1d4ed8" stroke-width="2"/>
    `;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function formatRelativeTime(isoStr) {
    if (!isoStr) return '—';
    const now = Date.now();
    const ts = new Date(isoStr + (isoStr.includes('Z') ? '' : 'Z')).getTime();
    const diff = Math.floor((now - ts) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ─── Auto-update status (header) ────────────────────────────────────────────
  function T(k, d) { return (window.GC && GC.t && GC.t[k]) || d; }

  function auAgo(s) { if (s == null) return '—'; return s < 60 ? T('autoupdate.ago_seconds','{x}s').replace('{x}', s) : T('autoupdate.ago_minutes','{x}m').replace('{x}', Math.round(s/60)); }

  function renderAutoUpdate(d) {
    var host = document.getElementById('au-status'); if (!host) return;
    host.replaceChildren();
    var pill = document.createElement('span'); pill.className = 'au-pill ';
    var dot = document.createElement('span'); dot.className = 'au-dot'; pill.appendChild(dot);
    var label = document.createElement('span');
    if (d.status === 'active') {
      pill.className += 'au-active';
      label.textContent = T('autoupdate.active', 'Auto-update active') + ' · ' +
        T('autoupdate.last_checked', 'checked {x} ago').replace('{x}', auAgo(d.age_s));
    } else if (d.status === 'stale') {
      pill.className += 'au-red';
      label.textContent = T('autoupdate.stale', 'Cron no longer running?');
    } else {
      pill.className += 'au-amber';
      label.textContent = T('autoupdate.not_configured', 'Auto-update not set up');
    }
    pill.appendChild(label); host.appendChild(pill);

    if (d.last_action === 'failed') {
      var fail = document.createElement('span');
      fail.className = 'au-pill au-red';
      fail.textContent = T('autoupdate.failed', 'Last update failed');
      host.appendChild(fail);
    }

    var badge = document.createElement('span'); badge.className = 'au-badge';
    badge.textContent = (d.mode === 'manual' ? T('autoupdate.mode_manual', 'Manual') : T('autoupdate.mode_auto', 'Automatic'))
      + (d.running_version ? ' · v' + d.running_version : '');
    host.appendChild(badge);

    if (d.mode_mismatch) {
      var w = document.createElement('span'); w.className = 'au-pill au-red';
      w.textContent = T('autoupdate.mismatch', 'Mode mismatch — host update.sh is outdated');
      host.appendChild(w);
    } else if (d.mode_pending) {
      var p = document.createElement('span'); p.className = 'au-badge';
      p.textContent = T('autoupdate.pending', 'Mode applies on the next cron run');
      host.appendChild(p);
    }

    var recheck = document.createElement('button'); recheck.className = 'btn btn-ghost';
    recheck.textContent = T('autoupdate.recheck', 'Re-check');
    recheck.addEventListener('click', loadAutoUpdate); host.appendChild(recheck);

    var setup = document.createElement('button'); setup.className = 'btn btn-ghost';
    setup.textContent = T('autoupdate.setup', 'Set up');
    setup.addEventListener('click', openAuSetup); host.appendChild(setup);

    if (d.mode === 'manual') {
      var trig = document.createElement('button'); trig.className = 'btn btn-primary';
      trig.textContent = T('autoupdate.trigger', 'Update now');
      if (d.status !== 'active') { trig.disabled = true; trig.title = T('autoupdate.not_configured', 'Auto-update not set up'); }
      trig.addEventListener('click', triggerAuUpdate); host.appendChild(trig);
    }
  }

  function loadAutoUpdate() {
    window.api.get('/api/system/auto-update').then(renderAutoUpdate).catch(function () {});
  }

  function triggerAuUpdate() {
    window.api.post('/api/system/auto-update/trigger', {}).then(function (j) {
      if (window.showToast) window.showToast(T('autoupdate.trigger_queued', 'Update queued'), (j && j.queued) ? 'success' : 'error');
      loadAutoUpdate();
    }).catch(function () {});
  }

  function openAuSetup() {
    var body = document.getElementById('au-setup-body'); if (!body) return;
    document.getElementById('au-setup-title').textContent = T('autoupdate.setup_title', 'Set up auto-update');
    body.replaceChildren();
    var dl = document.createElement('a'); dl.className = 'btn btn-primary';
    dl.textContent = T('autoupdate.download', '⬇ Download update.sh');
    dl.href = '/api/v1/system/update-sh';
    body.appendChild(dl);
    var det = document.createElement('details'); det.style.marginTop = '14px';
    var sum = document.createElement('summary'); sum.textContent = T('autoupdate.guide', 'Step-by-step guide');
    det.appendChild(sum);
    var pre = document.createElement('pre');
    pre.textContent = '# /etc/cron.d/gatecontrol-update\n*/5 * * * * root /opt/gatecontrol/update.sh';
    pre.style.cssText = 'background:var(--bg-base, #f0ede7);padding:10px 12px;border-radius:6px;font-size:11px;overflow-x:auto;border:1px solid var(--border)';
    det.appendChild(pre);
    var note = document.createElement('p'); note.style.cssText = 'font-size:12px;color:var(--text-2)';
    note.textContent = T('autoupdate.setup_note', 'update.sh must run from /opt/gatecontrol. */5 interval is required. No auto-rollback — monitor separately.');
    det.appendChild(note);
    body.appendChild(det);
    if (window.openModal) window.openModal('au-setup-modal-overlay');
  }
  // No custom close handler — the modal closes via the global
  // [data-close-modal] handler in app.js.

  // ─── Tab switching for chart ────────────────────────────────────────────────
  document.querySelectorAll('.tabs .tab[data-period]').forEach(tab => {
    tab.addEventListener('click', () => {
      refreshChart(tab.dataset.period);
    });
  });

  // ─── Reload button ─────────────────────────────────────────────────────────
  const reloadBtn = document.getElementById('btn-reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => refreshAll());
  }

  // ─── Refresh all ───────────────────────────────────────────────────────────
  async function refreshAll() {
    await Promise.all([
      refreshStats(),
      refreshResources(),
      refreshActivity(),
      refreshChart(isAurora() ? '24h' : '1h'),
    ]);
    loadAutoUpdate();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  refreshAll();
  loadAutoUpdate();
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);

  // Cleanup on page leave
  window.addEventListener('beforeunload', () => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  ['gc:gateway', 'gc:peer', 'gc:monitor', 'gc:reconnected'].forEach(function (ev) {
    document.addEventListener(ev, function () { refreshAll(); });
  });

  // ── Aurora-only sibling functions ────────────────────────────────────────────
  // These functions are ONLY called when isAurora() is true.
  // The original refreshStats/refreshActivity/renderChart else-paths remain byte-identical.

  async function auroraRefreshStats() {
    var peerOnlineCount = 0; // Bug 2: captured here, applied after gateways fetch

    try {
      const data = await api.get('/api/dashboard/stats');

      // Bug 2: save count; will be adjusted after gateway subtraction below
      peerOnlineCount = (data.peers && typeof data.peers.online === 'number') ? data.peers.online : 0;

      // Active routes
      var routesEl = document.getElementById('stat-routes');
      if (routesEl) routesEl.textContent = data.routes.active;

      // Traffic today
      var trafficEl = document.getElementById('stat-traffic');
      if (trafficEl) trafficEl.innerHTML = formatTrafficValue(data.traffic.today);

      // Avg latency
      var latencyEl = document.getElementById('stat-latency');
      if (latencyEl) latencyEl.textContent = data.latency != null ? data.latency + ' ms' : '—';

      // Monitoring summary
      var monitorEl = document.getElementById('stat-monitoring');
      var monitorSubEl = document.getElementById('stat-monitoring-sub');
      if (monitorEl && data.monitoring) {
        var up = parseInt(data.monitoring.up, 10) || 0;
        var total = parseInt(data.monitoring.total, 10) || 0;
        var down = parseInt(data.monitoring.down, 10) || 0;
        if (total > 0) {
          monitorEl.textContent = up + '/' + total;
          if (monitorSubEl) {
            if (down > 0) {
              monitorSubEl.style.color = 'var(--coral)';
              monitorSubEl.textContent = down + ' down';
            } else {
              monitorSubEl.style.color = 'var(--green)';
              monitorSubEl.textContent = (GC.t && GC.t['monitoring.dashboard_all_ok']) || 'All reachable';
            }
          }
        } else {
          monitorEl.textContent = '—';
          if (monitorSubEl) monitorSubEl.textContent = '';
        }
      }

      // WireGuard status in topbar
      var wgStatusEl = document.getElementById('wg-status');
      if (wgStatusEl) {
        if (data.wireguard.running) {
          wgStatusEl.classList.remove('inactive');
        } else {
          wgStatusEl.classList.add('inactive');
        }
      }

      // Sidebar badges
      var peerBadge = document.getElementById('peer-count-badge');
      if (peerBadge) peerBadge.textContent = data.peers.total;

      var routeBadge = document.getElementById('route-count-badge');
      if (routeBadge) routeBadge.textContent = data.routes.active;

    } catch (err) {
      console.error('Aurora: Failed to refresh stats:', err);
    }

    // Separate fetch for gateways KPI (Bug 1: API returns { gateways:[…] }, not a bare array)
    var onlineGateways = 0;
    try {
      var gwData = await api.get('/api/v1/gateways');
      var gwEl = document.getElementById('stat-gateways');
      if (gwData && Array.isArray(gwData.gateways)) {
        onlineGateways = gwData.gateways.filter(function(g) { return g.status === 'online'; }).length;
        if (gwEl) gwEl.textContent = onlineGateways + '/' + gwData.gateways.length;
      }
    } catch (err) {
      // non-fatal — gateways KPI stays at '—'
    }

    // Peers KPI: subtract online gateways so only real (non-gateway) peers are shown (Bug 2)
    var peersEl = document.getElementById('stat-peers');
    if (peersEl) peersEl.textContent = Math.max(0, peerOnlineCount - onlineGateways);

    // Pi-hole donut (3-state: no card if gated off; donut on ok; empty-state on error)
    var donutCard = document.getElementById('pihole-donut-card');
    if (donutCard) {
      auroraRefreshDonut();
    }
  }

  async function auroraRefreshDonut() {
    var donut = document.getElementById('dash-donut');
    var donutPct = document.getElementById('donut-pct');
    var statsBody = document.getElementById('pihole-stats-body');
    var donutSub = document.getElementById('pihole-donut-sub');
    if (!donut) return;

    try {
      // Bug 3: correct URL (/api/v1/pihole/summary) and response keys (ph.data.*)
      var ph = await api.get('/api/v1/pihole/summary');
      var pct = (ph && ph.data && ph.data.queries && ph.data.queries.percent) || 0;
      var pctRounded = Math.round(pct * 10) / 10;

      // Animate the donut arc
      // SVG circle r=15.9155 → circumference ≈ 100 (convenient unit)
      var dashVal = pctRounded;
      var valCircle = donut.querySelector('.val');
      if (valCircle) {
        valCircle.setAttribute('stroke-dasharray', dashVal + ' ' + (100 - dashVal));
      }
      if (donutPct) donutPct.textContent = pctRounded + '%';

      // Pi-hole stats body
      if (statsBody) {
        var blocked = (ph.data && ph.data.queries && ph.data.queries.blocked) || 0;
        var totalQ = (ph.data && ph.data.queries && ph.data.queries.total) || 0;
        var gravity = (ph.data && ph.data.gravity) || 0;
        statsBody.innerHTML =
          '<div class="s"><span class="n blk">' + blocked.toLocaleString() + '</span><span class="t">' + T('dashboard.pihole_blocked', 'Blocked') + '</span></div>' +
          '<div class="s"><span class="n">' + totalQ.toLocaleString() + '</span><span class="t">' + T('dashboard.pihole_total_queries', 'Total queries') + '</span></div>' +
          '<div class="s"><span class="n">' + gravity.toLocaleString() + '</span><span class="t">' + T('dashboard.pihole_gravity', 'Gravity lists') + '</span></div>';
      }
      if (donutSub) donutSub.textContent = T('dashboard.pihole_enabled', 'Blocking');

    } catch (err) {
      // error state: show empty-state inside card (card stays visible)
      var valCircle2 = donut.querySelector('.val');
      if (valCircle2) valCircle2.setAttribute('stroke-dasharray', '0 100');
      if (donutPct) donutPct.textContent = '—';
      if (statsBody) {
        statsBody.innerHTML = '<div class="empty-state">' + T('dashboard.pihole_unavailable', 'Pi-hole unavailable') + '</div>';
      }
      if (donutSub) donutSub.textContent = '';
    }
  }

  // Enhancement 4: Aurora resource donut gauge update
  async function auroraRefreshResources() {
    try {
      var data = await api.get('/api/system/resources');
      var cpuPct = data.cpu.percent;
      var ramPct = data.memory.percent;

      // Write shared IDs (shared refreshResources() bypassed for aurora; we write here)
      var cpuPctEl = document.getElementById('cpu-pct');
      if (cpuPctEl) cpuPctEl.textContent = cpuPct + ' %';

      var cpuBar = document.getElementById('cpu-bar');
      if (cpuBar) {
        cpuBar.style.width = cpuPct + '%';
        cpuBar.style.background = cpuPct > 80 ? 'var(--red)' :
          cpuPct > 50 ? 'var(--amber)' : 'var(--green)';
      }

      var cpuInfo = document.getElementById('cpu-info');
      if (cpuInfo) cpuInfo.textContent = data.cpu.cores + ' Cores · ' + data.cpu.model.split(' ').slice(0, 3).join(' ');

      var ramPctEl = document.getElementById('ram-pct');
      if (ramPctEl) ramPctEl.textContent = ramPct + ' %';

      var ramBar = document.getElementById('ram-bar');
      if (ramBar) {
        ramBar.style.width = ramPct + '%';
        ramBar.style.background = ramPct > 90 ? 'var(--red)' :
          ramPct > 70 ? 'var(--amber)' : 'var(--blue)';
      }

      var ramInfo = document.getElementById('ram-info');
      if (ramInfo) ramInfo.textContent = formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total);

      var uptimeValue = document.getElementById('uptime-value');
      if (uptimeValue) uptimeValue.textContent = data.uptime.formatted;

      var uptimeBoot = document.getElementById('uptime-boot');
      if (uptimeBoot && data.uptime && data.uptime.bootTime) {
        var label = (GC.t && GC.t['dashboard.booted_on']) || 'Seit {date}';
        uptimeBoot.textContent = label.replace('{date}', data.uptime.bootTime);
      }

      // Update radial donut gauge arcs
      auroraSetResourceDonut('cpu-donut', cpuPct);
      auroraSetResourceDonut('ram-donut', ramPct);

    } catch (err) {
      console.error('Aurora: Failed to refresh resources:', err);
    }
  }

  // Set stroke-dasharray + color on a resource donut arc by load percentage
  function auroraSetResourceDonut(donutId, pct) {
    var donut = document.getElementById(donutId);
    if (!donut) return;
    var arc = donut.querySelector('.val');
    if (!arc) return;
    var p = Math.min(100, Math.max(0, Number(pct) || 0));
    arc.setAttribute('stroke-dasharray', p + ' ' + (100 - p));
    arc.style.stroke = p > 90 ? 'var(--red)' : p > 70 ? 'var(--amber)' : 'var(--teal)';
  }

  async function auroraRefreshActivity() {
    try {
      var data = await api.get('/api/logs/recent?limit=8');
      var feed = document.getElementById('activity-feed');
      if (!feed) return;

      if (!data.entries || data.entries.length === 0) {
        feed.innerHTML = '<div class="empty-state">' + (T('dashboard.no_events', 'No events yet')) + '</div>';
        return;
      }

      var sevMap = { success: 'ok', info: 'info', warning: 'warn', error: 'err' };

      feed.innerHTML = data.entries.map(function(entry) {
        var sev = sevMap[entry.severity] || 'info';
        var time = formatRelativeTime(entry.created_at);
        return '<div class="log-row">' +
          '<span class="sev ' + sev + '"></span>' +
          '<span class="ts">' + time + '</span>' +
          '<span class="msg">' + escapeHtml(entry.message) + '</span>' +
          (entry.ip_address ? '<span class="src">' + escapeHtml(entry.ip_address) + '</span>' : '') +
          '</div>';
      }).join('');
    } catch (err) {
      console.error('Aurora: Failed to refresh activity:', err);
    }
  }

  async function auroraRefreshChart(period) {
    try {
      var data = await api.get('/api/dashboard/traffic?period=' + (period || '24h'));
      auroraRenderChart(data.data);
    } catch (err) {
      console.error('Aurora: Failed to refresh chart:', err);
    }
  }

  function auroraRenderChart(dataPoints) {
    var container = document.getElementById('traffic-chart');
    if (!container) return;

    if (!dataPoints || dataPoints.length === 0) {
      container.innerHTML = '<div class="empty-state">' + T('dashboard.chart_no_data', 'No traffic data') + '</div>';
      document.getElementById('t-total') && (document.getElementById('t-total').textContent = '—');
      document.getElementById('t-avg') && (document.getElementById('t-avg').textContent = '—');
      document.getElementById('t-peak') && (document.getElementById('t-peak').textContent = '—');
      return;
    }

    // Compute totals (upload + download per point)
    var totalBytes = 0, peakBytes = 0;
    var combined = dataPoints.map(function(d) {
      var v = (d.upload || 0) + (d.download || 0);
      totalBytes += v;
      if (v > peakBytes) peakBytes = v;
      return v;
    });
    var avgBytes = combined.length > 0 ? totalBytes / combined.length : 0;
    var maxVal = Math.max(1, peakBytes);

    // Build bar columns
    var cols = dataPoints.map(function(d, i) {
      var dnH = Math.max(2, Math.round(((d.download || 0) / maxVal) * 130));
      var upH = Math.max(2, Math.round(((d.upload || 0) / maxVal) * 130));
      var label = '';
      // show every Nth label to avoid clutter
      var n = dataPoints.length;
      if (n <= 12 || i % Math.ceil(n / 8) === 0) {
        label = d.label || '';
      }
      return '<div class="col">' +
        '<div class="bar" style="height:' + dnH + 'px"></div>' +
        '<div class="bar up" style="height:' + upH + 'px"></div>' +
        '<div class="lab">' + escapeHtml(label) + '</div>' +
        '</div>';
    }).join('');

    container.innerHTML = cols;

    // Footer stats
    var tTotal = document.getElementById('t-total');
    var tAvg = document.getElementById('t-avg');
    var tPeak = document.getElementById('t-peak');
    if (tTotal) tTotal.textContent = formatBytes(totalBytes);
    if (tAvg) tAvg.textContent = formatBytes(avgBytes) + '/pt';
    if (tPeak) tPeak.textContent = formatBytes(peakBytes);
  }

  // ─── Aurora toggle-group wiring ─────────────────────────────────────────────
  if (isAurora()) {
    document.querySelectorAll('.toggle-group .toggle-btn[data-r]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.toggle-group .toggle-btn[data-r]').forEach(function(b) {
          b.classList.remove('on');
        });
        btn.classList.add('on');
        auroraRefreshChart(btn.dataset.r);
      });
    });
  }

})();
