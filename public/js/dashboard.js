'use strict';

(function() {
  const REFRESH_INTERVAL = 15000; // 15 seconds
  let refreshTimer = null;

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function formatTrafficValue(bytes) {
    if (!bytes || bytes === 0) return '0 <span style="font-size:14px;font-weight:400">B</span>';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const val = v < 10 ? v.toFixed(1) : Math.round(v);
    return `${val}<span style="font-size:14px;font-weight:400"> ${units[i]}</span>`;
  }

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
      // bad_image on a failed marker = update.sh could not roll back either.
      fail.textContent = d.bad_image ? T('autoupdate.rollback_failed', 'Update and rollback failed — check the host')
        : T('autoupdate.failed', 'Last update failed');
      host.appendChild(fail);
    } else if (d.last_action === 'rolled_back') {
      var rb = document.createElement('span');
      rb.className = 'au-pill au-amber';
      var what = d.bad_version ? 'v' + d.bad_version : (d.bad_image ? d.bad_image.replace(/^sha256:/, '').slice(0, 12) : '');
      rb.textContent = T('autoupdate.rolled_back', 'Update {x} failed — previous version restored').replace('{x}', what).replace(/\s+/g, ' ');
      rb.title = T('autoupdate.rolled_back_hint', 'The new image failed its health check. Automatic mode skips it until a newer release is published.');
      host.appendChild(rb);
    } else if (d.last_action === 'waiting_window') {
      // update.sh pulled a new image outside the maintenance window (release B §6).
      var ww = document.createElement('span');
      ww.className = 'au-pill au-amber';
      ww.id = 'au-waiting-window';
      var win = d.window || {};
      ww.textContent = T('autoupdate.waiting_window', 'Update waiting for the maintenance window')
        + (win.start && win.end ? ' (' + win.start + '–' + win.end + ')' : '');
      ww.title = T('autoupdate.waiting_window_hint', 'A new version is ready and will be deployed in the next window. "Update now" deploys it right away.');
      host.appendChild(ww);
    }

    // Version badge doubles as the entry to "What's new" (all recent releases).
    var badge = document.createElement('button'); badge.type = 'button'; badge.className = 'au-badge au-badge-btn';
    badge.textContent = (d.mode === 'manual' ? T('autoupdate.mode_manual', 'Manual') : T('autoupdate.mode_auto', 'Automatic'))
      + (d.running_version ? ' · v' + d.running_version : '');
    badge.title = T('autoupdate.version_whats_new', "What's new?");
    badge.addEventListener('click', function () { loadWhatsNew(true, true); });
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

    // Re-check is an icon button (refresh) rather than a text button.
    var recheck = document.createElement('button'); recheck.className = 'icon-btn';
    recheck.style.cssText = 'width:30px;height:30px';
    recheck.title = T('autoupdate.recheck', 'Re-check');
    recheck.setAttribute('aria-label', recheck.title);
    recheck.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
    recheck.addEventListener('click', loadAutoUpdate); host.appendChild(recheck);

    // Setup button only while auto-update is NOT actually set up (status !== 'active');
    // once configured (cron running + recent check) it is hidden.
    if (d.status !== 'active') {
      var setup = document.createElement('button'); setup.className = 'btn btn-ghost btn-sm';
      setup.textContent = T('autoupdate.setup', 'Set up auto-update');
      setup.addEventListener('click', openAuSetup); host.appendChild(setup);
    }

    // Manual mode, or Automatic with a maintenance window: "Update now" drops
    // the trigger flag and update.sh deploys without waiting for the window.
    var windowOn = !!(d.window && d.window.enabled);
    if (d.mode === 'manual' || windowOn) {
      var trig = document.createElement('button'); trig.className = 'btn btn-primary';
      trig.id = 'au-trigger';
      trig.textContent = T('autoupdate.trigger', 'Update now');
      if (d.mode !== 'manual') trig.title = T('autoupdate.trigger_now_window', 'Deploys the update right away without waiting for the window.');
      if (d.status !== 'active') { trig.disabled = true; trig.title = T('autoupdate.not_configured', 'Auto-update not set up'); }
      trig.addEventListener('click', triggerAuUpdate); host.appendChild(trig);
    }

    // Narrow screens show the status pills as dots only (ops.css): every pill
    // gets a dot + text span; the text stays for screen readers and as tooltip.
    Array.prototype.forEach.call(host.querySelectorAll('.au-pill'), function (p) {
      var text = p.textContent.trim();
      if (!p.title) p.title = text;
      if (!p.querySelector('.au-dot')) {
        var s = document.createElement('span'); s.textContent = text;
        var dt = document.createElement('span'); dt.className = 'au-dot';
        p.textContent = '';
        p.appendChild(dt); p.appendChild(s);
      }
    });
  }

  function loadAutoUpdate() {
    window.api.get('/api/system/auto-update').then(renderAutoUpdate).catch(function () {});
  }

  // Why a trigger was not queued (autoUpdate.requestUpdate reasons).
  var TRIGGER_REASONS = {
    cooldown: ['autoupdate.trigger_cooldown', 'Just requested — please wait a moment.'],
    stale_no_cron: ['autoupdate.not_configured', 'Auto-update not set up'],
    not_manual_mode: ['autoupdate.trigger_not_manual', 'Only in Manual mode or with a maintenance window.'],
  };
  function triggerAuUpdate() {
    window.api.post('/api/system/auto-update/trigger', {}).then(function (j) {
      var queued = !!(j && j.queued);
      var r = !queued && j && TRIGGER_REASONS[j.reason];
      if (window.showToast) window.showToast(r ? T(r[0], r[1]) : T('autoupdate.trigger_queued', 'Update queued'), queued ? 'success' : 'error');
      loadAutoUpdate();
    }).catch(function () {});
  }

  // ─── "Was ist neu" card (release B §6) ─────────────────────────────────────
  // GET /system/whats-new → { current, unseen, sections:[{version,date,groups}] }.
  // Shown only while unseen (or on request via the version badge / "Alle
  // Neuerungen" with ?all=1). "Gelesen" → POST /whats-new/seen {version}.
  var whatsNewCurrent = null;
  function loadWhatsNew(all, reveal) {
    var card = document.getElementById('whats-new');
    if (!card || !window.GCOpsUI) return;
    window.api.get('/api/system/whats-new' + (all ? '?all=1' : '')).then(function (d) {
      if (!d || !d.ok) return;
      whatsNewCurrent = d.current || null;
      if (!all && !d.unseen) { card.hidden = true; return; }
      renderWhatsNew(card, d, all);
      if (reveal && typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function () {
      if (reveal && window.showToast) window.showToast(T('whatsnew.load_error', 'Could not load the changes.'), 'error');
    });
  }
  function renderWhatsNew(card, d, all) {
    var O = window.GCOpsUI;
    var sections = Array.isArray(d.sections) ? d.sections : [];
    var title = document.getElementById('whats-new-title');
    var sub = document.getElementById('whats-new-sub');
    var body = document.getElementById('whats-new-body');
    var allBtn = document.getElementById('whats-new-all');
    title.textContent = all ? (card.dataset.titleAll || "What's new")
      : O.fmt(card.dataset.title || 'New in GateControl {v}', { v: d.current || '' });
    var versions = sections.map(function (s) { return 'v' + s.version; });
    sub.textContent = versions.length > 1 ? versions.join(' · ') : (sections[0] && sections[0].date ? O.fmtDate(sections[0].date, (window.GC && GC.language) || undefined) : '');
    body.replaceChildren.apply(body, sections.length
      ? O.whatsNewNodes(document, sections, (window.GC && GC.language) || undefined)
      : [O.el(document, 'p', { class: 'op-empty', text: T('whatsnew.empty', 'No entries in the changelog.') })]);
    // One release: title + date already name it, the per-release head would repeat it.
    body.classList.toggle('op-wn-single', sections.length === 1 && !all);
    body.scrollTop = 0;
    if (allBtn) allBtn.hidden = !!all;
    card.dataset.mode = all ? 'all' : 'new';
    card.hidden = false;
  }
  function dismissWhatsNew() {
    var card = document.getElementById('whats-new');
    if (card) card.hidden = true;
    var body = whatsNewCurrent ? { version: whatsNewCurrent } : {};
    window.api.post('/api/system/whats-new/seen', body).catch(function () {});
  }
  (function initWhatsNew() {
    var allBtn = document.getElementById('whats-new-all');
    if (allBtn) allBtn.addEventListener('click', function () { loadWhatsNew(true, false); });
    var dismiss = document.getElementById('whats-new-dismiss');
    if (dismiss) dismiss.addEventListener('click', dismissWhatsNew);
    loadWhatsNew(false, false);
  })();

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
    note.textContent = T('autoupdate.setup_note', 'update.sh must run from /opt/gatecontrol. */5 interval is required. A new image that fails its health check is rolled back automatically.');
    det.appendChild(note);
    body.appendChild(det);
    if (window.openModal) window.openModal('au-setup-modal-overlay');
  }
  // No custom close handler — the modal closes via the global
  // [data-close-modal] handler in app.js.

  // ─── Refresh all ───────────────────────────────────────────────────────────
  async function refreshAll() {
    await Promise.all([
      refreshStats(),
      refreshResources(),
      refreshActivity(),
      refreshChart('24h'),
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

  // ── Renderers (Aurora is the only theme) ───────────────────────────────────

  async function refreshStats() {
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
        // Availability KPI only shows when ≥1 route has monitoring enabled.
        var monCard = document.getElementById('kpi-monitoring');
        if (monCard) monCard.style.display = total > 0 ? '' : 'none';
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
      console.error('Failed to refresh stats:', err);
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
      refreshDonut();
    }
  }

  async function refreshDonut() {
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

  // Resource bars + radial donut gauges (CPU/RAM)
  async function refreshResources() {
    try {
      var data = await api.get('/api/system/resources');
      var cpuPct = data.cpu.percent;
      var ramPct = data.memory.percent;

      // Resource IDs (bars/labels) + the radial donut gauges
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
      setResourceDonut('cpu-donut', cpuPct);
      setResourceDonut('ram-donut', ramPct);

    } catch (err) {
      console.error('Failed to refresh resources:', err);
    }
  }

  // Set stroke-dasharray + color on a resource donut arc by load percentage
  function setResourceDonut(donutId, pct) {
    var donut = document.getElementById(donutId);
    if (!donut) return;
    var arc = donut.querySelector('.val');
    if (!arc) return;
    var p = Math.min(100, Math.max(0, Number(pct) || 0));
    arc.setAttribute('stroke-dasharray', p + ' ' + (100 - p));
    arc.style.stroke = p > 90 ? 'var(--red)' : p > 70 ? 'var(--amber)' : 'var(--teal)';
  }

  async function refreshActivity() {
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
      console.error('Failed to refresh activity:', err);
    }
  }

  async function refreshChart(period) {
    try {
      var data = await api.get('/api/dashboard/traffic?period=' + (period || '24h'));
      renderChart(data.data);
    } catch (err) {
      console.error('Failed to refresh chart:', err);
    }
  }

  function renderChart(dataPoints) {
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

  // ─── Traffic period toggle-group ────────────────────────────────────────────
  document.querySelectorAll('.toggle-group .toggle-btn[data-r]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.toggle-group .toggle-btn[data-r]').forEach(function(b) {
        b.classList.remove('on');
      });
      btn.classList.add('on');
      refreshChart(btn.dataset.r);
    });
  });

})();
