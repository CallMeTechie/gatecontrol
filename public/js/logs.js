'use strict';

(function () {
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
      logContainer.innerHTML = '<div style="color:var(--red);padding:20px;text-align:center">' + esc(err.message) + '</div>';
    }
  }

  function applyFilter() {
    const filtered = currentFilter === 'all'
      ? allEntries
      : allEntries.filter(e => e.severity === currentFilter);
    renderLogs(filtered, filtered.length);
  }

  function renderLogs(entries, total) {
    if (!entries.length) {
      logContainer.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">No log entries</div>';
      return;
    }

    let html = entries.map(e => {
      const color = SEVERITY_COLORS[e.severity] || SEVERITY_COLORS.info;
      const time = formatTime(e.created_at);
      const typeTag = `<span class="tag tag-grey" style="font-size:10px;padding:1px 6px">${esc(e.event_type)}</span>`;

      return `<div class="activity-item" data-severity="${e.severity}">
        <div class="activity-dot" style="background:${color}"></div>
        <div style="flex:1;min-width:0">
          <div class="activity-text">${esc(e.message)} ${typeTag}</div>
          <div class="activity-time">${time}${e.source ? ' · ' + esc(e.source) : ''}${e.ip_address ? ' · ' + esc(e.ip_address) : ''}</div>
        </div>
      </div>`;
    }).join('');

    // Pagination
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

  // Pagination clicks
  logContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    loadLogs(parseInt(btn.dataset.page, 10));
  });

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts + 'Z');
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);

    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';

    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  loadLogs(1);
  setInterval(() => loadLogs(currentPage), 15000);
})();
