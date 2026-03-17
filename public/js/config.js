'use strict';

(function () {
  const configView = document.getElementById('wg-config-view');
  const caddyStatus = document.getElementById('caddy-status-indicator');
  const caddyInfo = document.getElementById('caddy-info');

  // ─── Load WireGuard config ───────────────────────────────
  async function loadWgConfig() {
    try {
      const data = await api.get('/api/wg/config');
      if (data.config) {
        configView.innerHTML = highlightWgConfig(data.config);
      } else {
        configView.textContent = 'No WireGuard config found.';
      }
    } catch (err) {
      configView.textContent = 'Failed to load config: ' + err.message;
    }
  }

  function highlightWgConfig(raw) {
    return raw
      .split('\n')
      .map(line => {
        if (line.startsWith('#')) {
          return '<span class="wg-comment">' + escapeHtml(line) + '</span>';
        }
        if (line.startsWith('[')) {
          return '<span class="wg-section">' + escapeHtml(line) + '</span>';
        }
        const eq = line.indexOf('=');
        if (eq > 0) {
          const key = line.substring(0, eq).trim();
          const val = line.substring(eq + 1).trim();
          return '<span class="wg-key">' + escapeHtml(key) + '</span> = <span class="wg-val">' + escapeHtml(val) + '</span>';
        }
        return escapeHtml(line);
      })
      .join('\n');
  }

  // ─── Load Caddy status ──────────────────────────────────
  async function loadCaddyStatus() {
    try {
      const data = await api.get('/api/caddy/status');
      if (data.running) {
        caddyStatus.innerHTML = '<div class="pulse-dot"></div><span style="font-size:13px;color:var(--green);font-weight:600">Caddy running</span>';
        // Count virtual hosts
        let hostCount = 0;
        if (data.config && data.config.apps && data.config.apps.http && data.config.apps.http.servers) {
          for (const srv of Object.values(data.config.apps.http.servers)) {
            if (srv.routes) hostCount += srv.routes.length;
          }
        }
        caddyInfo.textContent = hostCount + ' virtual hosts · HTTPS active · Let\'s Encrypt';
      } else {
        caddyStatus.innerHTML = '<div style="width:7px;height:7px;border-radius:50%;background:var(--red)"></div><span style="font-size:13px;color:var(--red);font-weight:600">Caddy stopped</span>';
        caddyInfo.textContent = 'Service not running';
      }
    } catch {
      caddyStatus.innerHTML = '<div style="width:7px;height:7px;border-radius:50%;background:var(--amber)"></div><span style="font-size:13px;color:var(--amber);font-weight:600">Unknown</span>';
      caddyInfo.textContent = 'Could not reach Caddy API';
    }
  }

  // ─── WG Restart / Stop ──────────────────────────────────
  document.getElementById('btn-wg-restart').addEventListener('click', async function() {
    if (!confirm('Restart WireGuard interface?')) return;
    const btn = this;
    btnLoading(btn);
    try {
      const data = await api.post('/api/wg/restart');
      if (data.success) {
        loadWgConfig();
      } else {
        alert('Failed to restart WireGuard');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  document.getElementById('btn-wg-stop').addEventListener('click', async function() {
    if (!confirm('Stop WireGuard interface? All peers will disconnect.')) return;
    const btn = this;
    btnLoading(btn);
    try {
      await api.post('/api/wg/stop');
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Caddy Reload ───────────────────────────────────────
  document.getElementById('btn-caddy-reload').addEventListener('click', async function() {
    const btn = this;
    btnLoading(btn);
    try {
      const data = await api.post('/api/caddy/reload');
      if (data.success) {
        loadCaddyStatus();
      } else {
        alert('Failed to reload Caddy');
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Export config ──────────────────────────────────────
  document.getElementById('btn-export-config').addEventListener('click', async function() {
    const btn = this;
    btnLoading(btn);
    try {
      const data = await api.get('/api/wg/config');
      if (!data.config) return alert('No config to export');

      const blob = new Blob([data.config], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'wg0.conf';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      btnReset(btn);
    }
  });

  // ─── Init ───────────────────────────────────────────────
  loadWgConfig();
  loadCaddyStatus();
})();
