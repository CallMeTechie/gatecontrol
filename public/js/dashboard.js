'use strict';

(function() {
  const REFRESH_INTERVAL = 15000; // 15 seconds
  let refreshTimer = null;

  // ─── Stat Cards ─────────────────────────────────────
  async function refreshStats() {
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
      if (monitorEl && data.monitoring) {
        var up = parseInt(data.monitoring.up, 10) || 0;
        var total = parseInt(data.monitoring.total, 10) || 0;
        var down = parseInt(data.monitoring.down, 10) || 0;
        if (total > 0) {
          monitorEl.textContent = '';
          var spanUp = document.createElement('span');
          spanUp.style.color = 'var(--green)';
          spanUp.textContent = up;
          var spanTotal = document.createElement('span');
          spanTotal.textContent = total;
          monitorEl.appendChild(spanUp);
          monitorEl.appendChild(document.createTextNode('/'));
          monitorEl.appendChild(spanTotal);
          if (down > 0) {
            var spanDown = document.createElement('span');
            spanDown.style.cssText = 'color:var(--red);font-size:12px';
            spanDown.textContent = ' (' + down + ' down)';
            monitorEl.appendChild(spanDown);
          }
        } else {
          monitorEl.textContent = '\u2014';
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
      if (peerBadge) peerBadge.textContent = data.peers.online;

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

  // ─── System Resources ───────────────────────────────
  async function refreshResources() {
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

      const uptimePct = document.getElementById('uptime-pct');
      if (uptimePct) uptimePct.textContent = '99.9 %';

    } catch (err) {
      console.error('Failed to refresh resources:', err);
    }
  }

  // ─── Activity Feed ──────────────────────────────────
  async function refreshActivity() {
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

  // ─── Traffic Chart ──────────────────────────────────
  async function refreshChart(period) {
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

  // ─── Helpers ────────────────────────────────────────
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

  // ─── Tab switching for chart ────────────────────────
  document.querySelectorAll('.tabs .tab[data-period]').forEach(tab => {
    tab.addEventListener('click', () => {
      refreshChart(tab.dataset.period);
    });
  });

  // ─── Reload button ─────────────────────────────────
  const reloadBtn = document.getElementById('btn-reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => refreshAll());
  }

  // ─── Refresh all ───────────────────────────────────
  async function refreshAll() {
    await Promise.all([
      refreshStats(),
      refreshResources(),
      refreshActivity(),
      refreshChart('1h'),
    ]);
  }

  // ─── Init ──────────────────────────────────────────
  refreshAll();
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);

  // Cleanup on page leave
  window.addEventListener('beforeunload', () => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
})();
