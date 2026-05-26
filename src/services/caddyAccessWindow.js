'use strict';

// Render the "access window closed" page served (HTTP 403) for a route that
// is currently access-denied by a scheduled access rule.
//
// Mirrors caddyMaintenance.renderMaintenancePage in role, but the copy is
// HARDCODED bilingual DE/EN — this page is rendered server-side at config-
// build time where the t() helper is identity (returns the key, not localized
// text), so i18n keys would surface as raw key strings. The body contains NO
// timestamp / `now` value so buildCaddyConfig stays deterministic.
//
// ctx.schedule (optional): human-readable schedule string ('' if unknown) to
// surface so the visitor knows when the route is reachable.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAccessWindowPage(ctx = {}) {
  const schedule = escapeHtml(ctx.schedule || '');
  const scheduleBlock = schedule
    ? `<div class="detail">
      <strong>Freigegebene Zeiten / Allowed hours:</strong><br>
      <code>${schedule}</code>
    </div>`
    : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Zugriff außerhalb der Freigabezeiten · Access outside permitted hours</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f8f9fa; color: #212529; margin: 0; padding: 2rem; }
    .container { max-width: 500px; margin: 10vh auto; text-align: center; }
    h1 { color: #dc3545; font-size: 1.75rem; }
    p { line-height: 1.6; color: #6c757d; }
    .detail { background: #fff; border-radius: 8px; padding: 1rem; margin-top: 1.5rem; font-size: 0.875rem; }
    code { background: #e9ecef; padding: 0.125rem 0.375rem; border-radius: 3px; }
    .lang-sep { margin-top: 1.25rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Zugriff nicht freigegeben</h1>
    <p>Dieser Dienst ist nur innerhalb der konfigurierten Freigabezeiten erreichbar. Bitte versuchen Sie es zu einem freigegebenen Zeitpunkt erneut.</p>
    <p class="lang-sep"><strong>Access not permitted</strong></p>
    <p>This service is only available during the configured access hours. Please try again within the permitted time window.</p>
    ${scheduleBlock}
  </div>
</body>
</html>`;
}

module.exports = { renderAccessWindowPage };
