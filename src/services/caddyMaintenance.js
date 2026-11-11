'use strict';

const nunjucks = require('nunjucks');
const nodePath = require('node:path');

// Render the gateway-offline maintenance page. Nunjucks-based so i18n
// keys are resolved via the t() helper. This page is rendered server-side at
// config-build time (no request-scoped t() available): it speaks the default
// language of the instance (GC_DEFAULT_LANGUAGE). Where the locales are not
// loaded (the boot export, unit tests) the keys stay as they are.
function renderMaintenancePage(ctx) {
  const tmplDir = nodePath.join(__dirname, '..', '..', 'templates');
  const env = nunjucks.configure(tmplDir, { autoescape: true, noCache: false });
  let lang = 'de';
  let t = (key) => key;
  try {
    lang = require('../../config/default').i18n.defaultLanguage || lang;
    const { translate } = require('../middleware/i18n');
    t = (key) => translate(lang, key);
  } catch { /* identity fallback above */ }
  env.addGlobal('t', t);
  return env.render('gateway-offline.njk', { lang, ...ctx });
}

module.exports = { renderMaintenancePage };
