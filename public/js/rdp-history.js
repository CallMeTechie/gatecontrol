(function() {
  'use strict';
  var historyList = document.getElementById('rdp-history-list');
  if (!historyList) return; // Not on logs page

  var currentOffset = 0;
  var limit = 50;

  function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  async function loadHistory() {
    try {
      var periodSelect = document.getElementById('rdp-history-period');
      var statusSelect = document.getElementById('rdp-history-status');
      var period = periodSelect ? periodSelect.value : '24h';
      var status = statusSelect ? statusSelect.value : '';
      var url = '/api/v1/rdp/history?limit=' + limit + '&offset=' + currentOffset + '&period=' + period;
      if (status) url += '&status=' + status;

      var res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
      var data = await res.json();
      if (!data.ok) return;
      var history = data.history || [];
      var total = data.total || history.length;

      if (history.length === 0) {
        clearElement(historyList);
        var emptyDiv = document.createElement('div');
        emptyDiv.style.cssText = 'font-size:13px;color:var(--text-3);padding:20px 0;text-align:center';
        emptyDiv.textContent = GC && GC.t && GC.t['rdp.no_history'] || 'Keine Verbindungshistorie';
        historyList.appendChild(emptyDiv);
        return;
      }

      clearElement(historyList);
      var table = document.createElement('table');
      table.className = 'data-table';
      table.style.cssText = 'width:100%;font-size:12px';

      var thead = document.createElement('thead');
      var headerRow = document.createElement('tr');
      var headers = [
        GC && GC.t ? GC.t['rdp.history_time'] || 'Zeitpunkt' : 'Zeitpunkt',
        GC && GC.t ? GC.t['rdp.history_device'] || 'User / Gerät' : 'User / Gerät',
        GC && GC.t ? GC.t['rdp.name'] || 'VM' : 'VM',
        GC && GC.t ? GC.t['rdp.host'] || 'Host' : 'Host',
        GC && GC.t ? GC.t['rdp.history_duration'] || 'Dauer' : 'Dauer',
        GC && GC.t ? GC.t['rdp.status'] || 'Status' : 'Status'
      ];
      var tbody = document.createElement('tbody');
      headers.forEach(function(h, idx) {
        var th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'cursor:pointer;user-select:none;padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:var(--text-2);border-bottom:2px solid var(--border)';
        th.addEventListener('click', function() {
          var rows = Array.from(tbody.querySelectorAll('tr'));
          var asc = th.dataset.sortDir !== 'asc';
          // Reset all headers
          headerRow.querySelectorAll('th').forEach(function(t) { t.dataset.sortDir = ''; });
          th.dataset.sortDir = asc ? 'asc' : 'desc';
          rows.sort(function(a, b) {
            var aVal = a.children[idx] ? a.children[idx].textContent : '';
            var bVal = b.children[idx] ? b.children[idx].textContent : '';
            return asc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
          });
          rows.forEach(function(row) { tbody.appendChild(row); });
        });
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      history.forEach(function(s) {
        var tr = document.createElement('tr');

        // Timestamp
        var tdTime = document.createElement('td');
        tdTime.style.cssText = 'font-family:var(--font-mono);font-size:11px;padding:8px 10px';
        if (s.started_at) {
          try { tdTime.textContent = new Date(s.started_at + (s.started_at.includes('Z') ? '' : 'Z')).toLocaleString(); } catch(e) { tdTime.textContent = s.started_at; }
        } else { tdTime.textContent = '-'; }
        tr.appendChild(tdTime);

        // User / Device
        var tdDevice = document.createElement('td');
        tdDevice.style.cssText = 'padding:8px 10px';
        var userName = s.user_display_name || s.token_name || '-';
        tdDevice.textContent = userName;
        if (s.peer_name) {
          var sub = document.createElement('span');
          sub.style.cssText = 'display:block;font-size:11px;color:var(--text-3)';
          sub.textContent = s.peer_name;
          tdDevice.appendChild(sub);
        }
        tr.appendChild(tdDevice);

        // VM
        var tdVm = document.createElement('td');
        tdVm.style.cssText = 'font-weight:600;color:var(--text-1);padding:8px 10px';
        tdVm.textContent = s.route_name || '-';
        tr.appendChild(tdVm);

        // Host
        var tdHost = document.createElement('td');
        tdHost.style.cssText = 'font-family:var(--font-mono);font-size:11px;padding:8px 10px';
        tdHost.textContent = s.route_host ? (s.route_host + ':' + (s.route_port || 3389)) : '-';
        tr.appendChild(tdHost);

        // Duration
        var tdDur = document.createElement('td');
        tdDur.style.cssText = 'font-family:var(--font-mono);font-size:11px;padding:8px 10px';
        if (s.duration_seconds) {
          var m = Math.floor(s.duration_seconds / 60);
          var h = Math.floor(m / 60);
          if (h > 0) tdDur.textContent = h + 'h ' + (m % 60) + 'm';
          else if (m > 0) tdDur.textContent = m + 'm ' + (s.duration_seconds % 60) + 's';
          else tdDur.textContent = s.duration_seconds + 's';
        } else { tdDur.textContent = '-'; }
        tr.appendChild(tdDur);

        // Status
        var tdStatus = document.createElement('td');
        tdStatus.style.cssText = 'padding:8px 10px';
        var badge = document.createElement('span');
        badge.style.cssText = 'padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;';
        if (s.status === 'active') {
          badge.style.cssText += 'background:#dcfce7;color:#166534';
          badge.textContent = GC && GC.t ? GC.t['rdp.status_active'] || 'Aktiv' : 'Aktiv';
        } else {
          badge.style.cssText += 'background:var(--bg-hover);color:var(--text-3)';
          badge.textContent = GC && GC.t ? GC.t['rdp.status_ended'] || 'Beendet' : 'Beendet';
        }
        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      historyList.appendChild(table);

      // Pagination
      if (total > limit) {
        var pag = document.createElement('div');
        pag.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 0;font-size:12px;color:var(--text-2)';
        var info = document.createElement('span');
        info.textContent = (currentOffset + 1) + '\u2013' + Math.min(currentOffset + limit, total) + ' / ' + total;
        pag.appendChild(info);
        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:4px';
        if (currentOffset > 0) {
          var prev = document.createElement('button');
          prev.className = 'btn btn-ghost btn-sm';
          prev.textContent = '\u2190';
          prev.addEventListener('click', function() { currentOffset -= limit; loadHistory(); });
          btns.appendChild(prev);
        }
        if (currentOffset + limit < total) {
          var next = document.createElement('button');
          next.className = 'btn btn-ghost btn-sm';
          next.textContent = '\u2192';
          next.addEventListener('click', function() { currentOffset += limit; loadHistory(); });
          btns.appendChild(next);
        }
        pag.appendChild(btns);
        historyList.appendChild(pag);
      }
    } catch (err) {
      console.error('Failed to load RDP history:', err);
    }
  }

  // Event listeners
  var periodSelect = document.getElementById('rdp-history-period');
  var statusSelect = document.getElementById('rdp-history-status');
  if (periodSelect) periodSelect.addEventListener('change', function() { currentOffset = 0; loadHistory(); });
  if (statusSelect) statusSelect.addEventListener('change', function() { currentOffset = 0; loadHistory(); });

  // Export buttons
  var csvBtn = document.getElementById('rdp-history-export-csv');
  var jsonBtn = document.getElementById('rdp-history-export-json');
  if (csvBtn) csvBtn.addEventListener('click', function() {
    var period = periodSelect ? periodSelect.value : '24h';
    window.open('/api/v1/rdp/history/export?format=csv&period=' + period, '_blank');
  });
  if (jsonBtn) jsonBtn.addEventListener('click', function() {
    var period = periodSelect ? periodSelect.value : '24h';
    window.open('/api/v1/rdp/history/export?format=json&period=' + period, '_blank');
  });

  // Initial load
  loadHistory();
})();
