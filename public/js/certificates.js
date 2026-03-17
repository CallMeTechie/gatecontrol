'use strict';

(function () {
  const certsList = document.getElementById('certificates-list');

  async function loadCertificates() {
    try {
      // Get routes to show which domains have active HTTPS
      const routeData = await api.get('/api/routes');
      const caddyData = await api.get('/api/caddy/status');

      const routes = routeData.ok ? routeData.routes : [];
      const httpsRoutes = routes.filter(r => r.https_enabled && r.enabled);
      const caddyRunning = caddyData.running;

      if (!httpsRoutes.length) {
        certsList.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:20px 0;text-align:center">No HTTPS routes configured. Add a route with HTTPS enabled to get automatic certificates.</div>';
        return;
      }

      certsList.innerHTML = httpsRoutes.map(r => {
        const statusTag = caddyRunning
          ? '<span class="tag tag-green"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Auto-TLS</span>'
          : '<span class="tag tag-amber">Caddy offline</span>';

        return `<div class="route-item">
          <div class="route-icon" style="color:var(--green);border-color:var(--green-bd);background:var(--green-lt)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div class="route-domain">${escapeHtml(r.domain)}</div>
            <div class="route-target" style="font-size:11px;color:var(--text-3)">Let's Encrypt · Auto-managed by Caddy</div>
          </div>
          ${statusTag}
        </div>`;
      }).join('');

    } catch (err) {
      certsList.innerHTML = '<div style="color:var(--red);padding:20px;text-align:center">' + escapeHtml(err.message) + '</div>';
    }
  }

  loadCertificates();
  setInterval(loadCertificates, 60000);
})();
