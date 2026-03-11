'use strict';

(function () {
  // ─── Shared helpers ───────────────────────────────
  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts + (ts.includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  // Note: All user-controlled values are escaped with esc() before being
  // inserted into HTML strings. Static structural markup (CSS classes,
  // layout divs, SVG icons) is safe and does not need escaping.

  // ─── Tab switching (Activity / Access) ────────────
  const typeTabs = document.getElementById('log-type-tabs');
  const activityPanel = document.getElementById('activity-panel');
  const accessPanel = document.getElementById('access-panel');

  if (typeTabs) {
    typeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      typeTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.type;
      activityPanel.style.display = type === 'activity' ? '' : 'none';
      accessPanel.style.display = type === 'access' ? '' : 'none';
      if (type === 'access' && !accessLoaded) loadAccessLogs(1);
    });
  }

  // ═══════════════════════════════════════════════════
  //  ACTIVITY LOG
  // ═══════════════════════════════════════════════════
  const logContainer = document.getElementById('full-activity-log');
  const logsCount = document.getElementById('logs-count');
  const SEVERITY_COLORS = { info: 'var(--blue)', success: 'var(--green)', warning: 'var(--amber)', error: 'var(--red)' };

  let currentPage = 1;
  let totalPages = 1;
  let currentFilter = 'all';
  let allEntries = [];

  async function loadLogs(page) {
    try {
      const data = await api.get('/api/logs/activity?page=' + page + '&limit=100');
      currentPage = data.page;
      totalPages = data.totalPages;
      allEntries = data.entries;
      applyFilter();
      if (logsCount) logsCount.textContent = data.total + ' entries';
    } catch (err) {
      logContainer.textContent = err.message;
    }
  }

  function applyFilter() {
    const filtered = currentFilter === 'all'
      ? allEntries
      : allEntries.filter(e => e.severity === currentFilter);
    renderLogs(filtered);
  }

  function renderLogs(entries) {
    if (!entries.length) {
      logContainer.textContent = 'No log entries';
      return;
    }

    let html = entries.map(e => {
      const color = SEVERITY_COLORS[e.severity] || SEVERITY_COLORS.info;
      const time = esc(formatTime(e.created_at));
      const typeTag = `<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">${esc(e.event_type)}</span>`;

      return `<div class="activity-item" data-severity="${esc(e.severity)}">
        <div class="activity-dot" style="background:${color}"></div>
        <div style="flex:1;min-width:0">
          <div class="activity-text">${esc(e.message)} ${typeTag}</div>
          <div class="activity-time">${time}${e.source ? ' · ' + esc(e.source) : ''}${e.ip_address ? ' · ' + esc(e.ip_address) : ''}</div>
        </div>
      </div>`;
    }).join('');

    if (totalPages > 1 && currentFilter === 'all') {
      html += '<div style="display:flex;justify-content:center;align-items:center;gap:10px;padding:16px 0;border-top:1px solid var(--border);margin-top:8px">';
      html += `<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo; Prev</button>`;
      html += `<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-2)">${currentPage} / ${totalPages}</span>`;
      html += `<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next &raquo;</button>`;
      html += '</div>';
    }

    logContainer.innerHTML = html;
  }

  // Severity filter tabs
  const filterTabs = document.getElementById('log-severity-filter');
  if (filterTabs) {
    filterTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      filterTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.severity;
      applyFilter();
    });
  }

  // Activity pagination clicks
  logContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    loadLogs(parseInt(btn.dataset.page, 10));
  });

  // ═══════════════════════════════════════════════════
  //  ACCESS LOG
  // ═══════════════════════════════════════════════════
  const accessContainer = document.getElementById('access-log-container');
  const accessCount = document.getElementById('access-count');
  let accessLoaded = false;
  let accessPage = 1;
  let accessTotalPages = 1;
  let accessStatusFilter = '';

  const STATUS_COLORS = {
    2: 'var(--green)',
    3: 'var(--blue)',
    4: 'var(--amber)',
    5: 'var(--red)',
  };

  async function loadAccessLogs(page) {
    try {
      const params = new URLSearchParams({ page, limit: 50 });
      if (accessStatusFilter) params.set('status', accessStatusFilter);

      const data = await api.get('/api/logs/access?' + params.toString());
      accessPage = data.page;
      accessTotalPages = data.totalPages;
      accessLoaded = true;

      if (accessCount) accessCount.textContent = data.total + ' requests';
      renderAccessLogs(data.entries);
    } catch (err) {
      accessContainer.textContent = err.message;
    }
  }

  function renderAccessLogs(entries) {
    if (!entries.length) {
      accessContainer.textContent = 'No access log entries';
      return;
    }

    let html = entries.map(e => {
      const statusClass = Math.floor(e.status / 100);
      const dotColor = STATUS_COLORS[statusClass] || 'var(--text-3)';
      const time = esc(formatTime(e.timestamp));
      const methodTag = `<span class="tag tag-grey" style="font-size:10px;padding:1px 6px;font-family:var(--font-mono)">${esc(e.method)}</span>`;
      const statusCode = parseInt(e.status, 10) || 0;
      const statusTag = `<span style="font-family:var(--font-mono);font-weight:600;color:${dotColor}">${statusCode}</span>`;
      const duration = parseInt(e.duration, 10) || 0;
      const size = parseInt(e.size, 10) || 0;

      return `<div class="activity-item">
        <div class="activity-dot" style="background:${dotColor}"></div>
        <div style="flex:1;min-width:0">
          <div class="activity-text">${methodTag} ${statusTag} <span style="font-family:var(--font-mono);font-size:12px">${esc(e.host)}${esc(e.uri)}</span></div>
          <div class="activity-time">${time} · ${esc(e.remote_ip)} · ${duration}ms · ${formatBytes(size)}</div>
        </div>
      </div>`;
    }).join('');

    // Pagination
    if (accessTotalPages > 1) {
      html += '<div style="display:flex;justify-content:center;align-items:center;gap:10px;padding:16px 0;border-top:1px solid var(--border);margin-top:8px">';
      html += `<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ${accessPage <= 1 ? 'disabled' : ''} data-access-page="${accessPage - 1}">&laquo; Prev</button>`;
      html += `<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-2)">${accessPage} / ${accessTotalPages}</span>`;
      html += `<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ${accessPage >= accessTotalPages ? 'disabled' : ''} data-access-page="${accessPage + 1}">Next &raquo;</button>`;
      html += '</div>';
    }

    accessContainer.innerHTML = html;
  }

  // Access status filter tabs
  const accessFilterTabs = document.getElementById('access-status-filter');
  if (accessFilterTabs) {
    accessFilterTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      accessFilterTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      accessStatusFilter = tab.dataset.status;
      loadAccessLogs(1);
    });
  }

  // Access pagination clicks
  accessContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-access-page]');
    if (!btn || btn.disabled) return;
    loadAccessLogs(parseInt(btn.dataset.accessPage, 10));
  });

  // ─── Init ─────────────────────────────────────────
  loadLogs(1);
  setInterval(() => {
    loadLogs(currentPage);
    if (accessLoaded) loadAccessLogs(accessPage);
  }, 15000);
})();
