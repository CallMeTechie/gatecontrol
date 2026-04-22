'use strict';

(function () {
  const certsList = document.getElementById('certificates-list');
  if (!certsList) return;

  function t(key, fallback) {
    return (window.GC && GC.t && GC.t[key]) || fallback;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function shieldIcon(color) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
    svg.appendChild(p);
    var icon = document.createElement('div');
    icon.className = 'route-icon';
    icon.style.color = color.text;
    icon.style.borderColor = color.border;
    icon.style.background = color.bg;
    icon.appendChild(svg);
    return icon;
  }

  function tag(cls, text, titleAttr) {
    var span = document.createElement('span');
    span.className = 'tag ' + cls;
    span.textContent = text;
    if (titleAttr) span.title = titleAttr;
    return span;
  }

  /**
   * Determine the certificate status of a route.
   *   - auto-tls:    Caddy manages a certificate (HTTP https_enabled=1, or L4 terminate).
   *   - http-only:   HTTP route with HTTPS disabled — no cert.
   *   - passthrough: L4 SNI passthrough — cert lives at the backend, not on the server.
   *   - plain-l4:    L4 without TLS (raw TCP/UDP) — no cert.
   */
  function certStatus(r) {
    if (r.route_type === 'l4') {
      if (r.l4_tls_mode === 'terminate') return 'auto-tls';
      if (r.l4_tls_mode === 'passthrough') return 'passthrough';
      return 'plain-l4';
    }
    return r.https_enabled ? 'auto-tls' : 'http-only';
  }

  function statusTag(status, caddyRunning) {
    if (status === 'auto-tls') {
      if (!caddyRunning) return tag('tag-amber', t('certificates.status_caddy_offline', 'Caddy offline'));
      return tag('tag-green', t('certificates.status_auto_tls', 'Auto-TLS'));
    }
    if (status === 'http-only') {
      return tag('tag-amber', t('certificates.status_http_only', 'HTTP ohne TLS'),
        t('certificates.status_http_only_hint', 'HTTPS in der Route-Bearbeitung aktivieren, um ein Let\'s-Encrypt-Zertifikat zu beziehen.'));
    }
    if (status === 'passthrough') {
      return tag('tag-grey', t('certificates.status_passthrough', 'TLS-Passthrough'),
        t('certificates.status_passthrough_hint', 'TLS wird zum Backend durchgereicht — kein Zertifikat auf dem Server.'));
    }
    return tag('tag-grey', t('certificates.status_plain_l4', 'L4 ohne TLS'));
  }

  function subtitleFor(status) {
    if (status === 'auto-tls') return t('certificates.sub_auto_tls', "Let's Encrypt · automatisch von Caddy verwaltet");
    if (status === 'http-only') return t('certificates.sub_http_only', 'HTTP-only · kein Zertifikat ausgestellt');
    if (status === 'passthrough') return t('certificates.sub_passthrough', 'TLS-Passthrough · Zertifikat am Backend');
    return t('certificates.sub_plain_l4', 'Layer-4 · TCP/UDP ohne Verschlüsselung');
  }

  function buildRow(r, caddyRunning) {
    var status = certStatus(r);
    var iconColor = (status === 'auto-tls')
      ? { text: 'var(--green)', border: 'var(--green-bd)', bg: 'var(--green-lt)' }
      : (status === 'http-only')
        ? { text: 'var(--amber)', border: 'var(--amber-bd)', bg: 'var(--amber-lt)' }
        : { text: 'var(--text-3)', border: 'var(--border)', bg: 'var(--bg-base)' };

    var row = document.createElement('div');
    row.className = 'route-item';
    row.appendChild(shieldIcon(iconColor));

    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';

    var domain = document.createElement('div');
    domain.className = 'route-domain';
    domain.textContent = r.domain || '—';
    info.appendChild(domain);

    var sub = document.createElement('div');
    sub.className = 'route-target';
    sub.style.cssText = 'font-size:11px;color:var(--text-3)';
    sub.textContent = subtitleFor(status);
    info.appendChild(sub);

    row.appendChild(info);
    row.appendChild(statusTag(status, caddyRunning));
    return row;
  }

  function emptyState() {
    var el = document.createElement('div');
    el.style.cssText = 'font-size:13px;color:var(--text-3);padding:20px 0;text-align:center';
    el.textContent = t('certificates.no_routes',
      'Keine Routen mit Domain konfiguriert. Lege eine HTTP- oder L4-Route mit Domain an, um ein Zertifikat zu erhalten.');
    return el;
  }

  function errorState(msg) {
    var el = document.createElement('div');
    el.style.cssText = 'color:var(--red);padding:20px;text-align:center';
    el.textContent = msg;
    return el;
  }

  async function loadCertificates() {
    try {
      var [routeData, caddyData] = await Promise.all([
        window.api.get('/api/routes'),
        window.api.get('/api/caddy/status'),
      ]);

      var routes = (routeData && routeData.ok && Array.isArray(routeData.routes)) ? routeData.routes : [];
      var caddyRunning = !!(caddyData && caddyData.running);

      // Show every enabled route that has a domain — the status tag tells the
      // admin whether a certificate is actually provisioned or why it isn't.
      var visible = routes.filter(function(r) { return r.enabled && r.domain; });

      clear(certsList);

      if (!visible.length) {
        certsList.appendChild(emptyState());
        return;
      }

      // Sort: Auto-TLS first (green/active), then http-only, then L4 variants.
      var order = { 'auto-tls': 0, 'http-only': 1, 'passthrough': 2, 'plain-l4': 3 };
      visible.sort(function(a, b) {
        var oa = order[certStatus(a)] || 9;
        var ob = order[certStatus(b)] || 9;
        if (oa !== ob) return oa - ob;
        return (a.domain || '').localeCompare(b.domain || '');
      });

      visible.forEach(function(r) {
        certsList.appendChild(buildRow(r, caddyRunning));
      });
    } catch (err) {
      clear(certsList);
      certsList.appendChild(errorState(err.message));
    }
  }

  var refreshBtn = document.getElementById('btn-certificates-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadCertificates);

  loadCertificates();
  setInterval(loadCertificates, 60000);
})();
