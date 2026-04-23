'use strict';

const nunjucks = require('nunjucks');
const nodePath = require('node:path');

// Render the gateway-offline maintenance page. Nunjucks-based so i18n
// keys are resolved via the t() helper. Uses an identity fallback
// because this page is rendered server-side at config-build time
// (no request-scoped t() available).
function renderMaintenancePage(ctx) {
  const tmplDir = nodePath.join(__dirname, '..', '..', 'templates');
  const env = nunjucks.configure(tmplDir, { autoescape: true, noCache: false });
  env.addGlobal('t', (key) => key);
  return env.render('gateway-offline.njk', { lang: 'de', ...ctx });
}

module.exports = { renderMaintenancePage };
