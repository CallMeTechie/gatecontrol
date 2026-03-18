'use strict';

(function () {
  var configView = document.getElementById('caddy-config-view');
  var configInfo = document.getElementById('caddy-config-info');

  // ─── JSON Syntax Highlighting (safe — input is from our own API) ──
  function highlightJson(json) {
    var str = escapeHtml(JSON.stringify(json, null, 2));
    // Keys
    str = str.replace(
      /&quot;([^&]+?)&quot;\s*:/g,
      '<span class="wg-key">&quot;$1&quot;</span>:'
    );
    // String values
    str = str.replace(
      /:\s*&quot;([^&]*?)&quot;/g,
      ': <span class="wg-val">&quot;$1&quot;</span>'
    );
    // Numbers
    str = str.replace(
      /:\s*(\d+\.?\d*)([,\n])/g,
      ': <span class="wg-val">$1</span>$2'
    );
    // Booleans / null
    str = str.replace(
      /:\s*(true|false|null)([,\n])/g,
      ': <span class="wg-section">$1</span>$2'
    );
    return str;
  }

  // ─── Load Caddy Config ────────────────────────────────────
  async function loadCaddyConfig() {
    try {
      var data = await api.get('/api/caddy/status');
      if (!data.running || !data.config) {
        configView.textContent = 'Caddy is not running or config not available.';
        return;
      }

      // Safe: escapeHtml is applied inside highlightJson before any markup
      configView.innerHTML = highlightJson(data.config);

      // Count info
      var hostCount = 0;
      var l4Count = 0;
      var apps = data.config.apps || {};
      if (apps.http && apps.http.servers) {
        Object.values(apps.http.servers).forEach(function (srv) {
          if (srv.routes) hostCount += srv.routes.length;
        });
      }
      if (apps.layer4 && apps.layer4.servers) {
        l4Count = Object.keys(apps.layer4.servers).length;
      }
      var parts = [];
      if (hostCount) parts.push(hostCount + ' HTTP routes');
      if (l4Count) parts.push(l4Count + ' L4 routes');
      if (configInfo) configInfo.textContent = parts.join(' \u00b7 ') || 'No routes';
    } catch (err) {
      configView.textContent = 'Failed to load config: ' + err.message;
    }
  }

  // ─── Export Config ────────────────────────────────────────
  var btnExport = document.getElementById('btn-export-caddy');
  if (btnExport) {
    btnExport.addEventListener('click', async function () {
      var btn = this;
      btnLoading(btn);
      try {
        var data = await api.get('/api/caddy/status');
        if (!data.config) {
          alert('No config available');
          return;
        }
        var json = JSON.stringify(data.config, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'caddy-config.json';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        alert('Export failed: ' + err.message);
      } finally {
        btnReset(btn);
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────
  loadCaddyConfig();
})();
