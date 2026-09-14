'use strict';

(function () {
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

  // Note: All user-controlled values are escaped with escapeHtml() before being
  // inserted into HTML strings. Static structural markup (CSS classes,
  // layout divs, SVG icons) is safe and does not need escaping.

  // ─── Tab switching (Activity / Access) ────────────
  const typeTabs = document.getElementById('log-type-tabs');
  const activityPanel = document.getElementById('activity-panel');
  const accessPanel = document.getElementById('access-panel');
  const historyPanel = document.getElementById('history-panel');

  if (typeTabs) {
    typeTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      typeTabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.type;
      activityPanel.style.display = type === 'activity' ? '' : 'none';
      accessPanel.style.display = type === 'access' ? '' : 'none';
      if (historyPanel) historyPanel.style.display = type === 'history' ? '' : 'none';
      if (type === 'access' && !accessLoaded) loadAccessLogs(1);
    });
  }

  // ═══════════════════════════════════════════════════
  //  ACTIVITY LOG
  // ═══════════════════════════════════════════════════
  const logContainer = document.getElementById('full-activity-log');
  const logsCount = document.getElementById('logs-count');
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

  // ─── Severity class maps (log rows) ─────────────────
  var SEV_CLASS = { info: 'info', success: 'ok', warning: 'warn', error: 'err' };
  var STATUS_SEV = { 2: 'ok', 3: 'info', 4: 'warn', 5: 'err' };

  function formatTs(ts) {
    if (!ts) return '';
    var d = new Date(ts + (ts.includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderLogs(entries) {
    // Live search: filter by text if #log-search has a value
    var searchEl = document.getElementById('log-search');
    var q = searchEl ? searchEl.value.trim().toLowerCase() : '';
    var visible = q
      ? entries.filter(function (e) {
          return (e.message || '').toLowerCase().includes(q) ||
            (e.source || '').toLowerCase().includes(q) ||
            (e.event_type || '').toLowerCase().includes(q);
        })
      : entries;

    if (!visible.length) {
      logContainer.textContent = GC.t['logs.no_entries'] || 'No log entries';
      return;
    }

    var html = visible.map(function (e) {
      var sevClass = SEV_CLASS[e.severity] || 'info';
      var ts = escapeHtml(formatTs(e.created_at));
      var src = e.source || e.event_type || '';
      return '<div class="log-row" data-severity="' + escapeHtml(e.severity) + '">' +
        '<span class="sev ' + sevClass + '"></span>' +
        '<span class="ts">' + ts + '</span>' +
        '<span class="msg">' + escapeHtml(e.message) + '</span>' +
        (src ? '<span class="src">' + escapeHtml(src) + '</span>' : '') +
        '</div>';
    }).join('');

    if (totalPages > 1 && currentFilter === 'all' && !q) {
      html += '<div style="display:flex;justify-content:center;align-items:center;gap:10px;padding:16px 0;border-top:1px solid var(--line);margin-top:8px">';
      html += '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">« Prev</button>';
      html += '<span style="font-family:var(--font-mono);font-size:12px;color:var(--muted)">' + currentPage + ' / ' + totalPages + '</span>';
      html += '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">Next »</button>';
      html += '</div>';
    }

    logContainer.innerHTML = html;
  }

  function renderAccessLogs(entries) {
    if (!entries.length) {
      accessContainer.textContent = GC.t['logs.no_access_entries'] || 'No access log entries';
      return;
    }

    var html = entries.map(function (e) {
      var statusClass = Math.floor(e.status / 100);
      var sevClass = STATUS_SEV[statusClass] || 'info';
      var time = escapeHtml(formatTime(e.timestamp));
      var statusCode = parseInt(e.status, 10) || 0;
      var duration = parseInt(e.duration, 10) || 0;
      var method = escapeHtml(e.method || '');
      var path = escapeHtml((e.host || '') + (e.uri || ''));
      var ip = escapeHtml(e.remote_ip || '');
      var msg = method + ' ' + statusCode + ' ' + path + ' · ' + ip + ' · ' + duration + 'ms';
      var src = escapeHtml(e.host || '');
      return '<div class="log-row">' +
        '<span class="sev ' + sevClass + '"></span>' +
        '<span class="ts">' + time + '</span>' +
        '<span class="msg">' + msg + '</span>' +
        (src ? '<span class="src">' + src + '</span>' : '') +
        '</div>';
    }).join('');

    if (accessTotalPages > 1) {
      html += '<div style="display:flex;justify-content:center;align-items:center;gap:10px;padding:16px 0;border-top:1px solid var(--line);margin-top:8px">';
      html += '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ' + (accessPage <= 1 ? 'disabled' : '') + ' data-access-page="' + (accessPage - 1) + '">« Prev</button>';
      html += '<span style="font-family:var(--font-mono);font-size:12px;color:var(--muted)">' + accessPage + ' / ' + accessTotalPages + '</span>';
      html += '<button class="btn btn-ghost" style="font-size:12px;padding:6px 12px" ' + (accessPage >= accessTotalPages ? 'disabled' : '') + ' data-access-page="' + (accessPage + 1) + '">Next »</button>';
      html += '</div>';
    }

    accessContainer.innerHTML = html;
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

  // ═══════════════════════════════════════════════════
  //  EXPORT
  // ═══════════════════════════════════════════════════
  function triggerDownload(url) {
    // Rewrite /api/ to /api/v1/ to match server routes (same as apiUrl in app.js)
    if (url.startsWith('/api/') && !url.startsWith('/api/v1/')) {
      url = '/api/v1/' + url.slice(5);
    }
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Activity export buttons
  const activityExportCsv = document.getElementById('activity-export-csv');
  const activityExportJson = document.getElementById('activity-export-json');
  if (activityExportCsv) {
    activityExportCsv.addEventListener('click', () => {
      triggerDownload('/api/logs/activity/export?format=csv');
    });
  }
  if (activityExportJson) {
    activityExportJson.addEventListener('click', () => {
      triggerDownload('/api/logs/activity/export?format=json');
    });
  }

  // Access export buttons
  const accessExportCsv = document.getElementById('access-export-csv');
  const accessExportJson = document.getElementById('access-export-json');
  if (accessExportCsv) {
    accessExportCsv.addEventListener('click', () => {
      const params = new URLSearchParams({ format: 'csv' });
      if (accessStatusFilter) params.set('status', accessStatusFilter);
      triggerDownload('/api/logs/access/export?' + params.toString());
    });
  }
  if (accessExportJson) {
    accessExportJson.addEventListener('click', () => {
      const params = new URLSearchParams({ format: 'json' });
      if (accessStatusFilter) params.set('status', accessStatusFilter);
      triggerDownload('/api/logs/access/export?' + params.toString());
    });
  }

  // ─── Live search wiring ───────────────────────────
  var logSearchEl = document.getElementById('log-search');
  if (logSearchEl) {
    logSearchEl.addEventListener('input', function () { applyFilter(); });
  }

  // ─── Init ─────────────────────────────────────────
  loadLogs(1);
  setInterval(() => {
    loadLogs(currentPage);
    if (accessLoaded) loadAccessLogs(accessPage);
  }, 15000);

  document.addEventListener('gc:activity', function () { loadLogs(1); });
  document.addEventListener('gc:reconnected', function () { loadLogs(1); });
})();
