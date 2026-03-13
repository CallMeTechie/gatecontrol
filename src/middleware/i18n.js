'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config/default');
const logger = require('../utils/logger');

const locales = {};

function loadLocales() {
  const i18nDir = path.join(__dirname, '..', 'i18n');

  for (const lang of config.i18n.availableLanguages) {
    const filePath = path.join(i18nDir, `${lang}.json`);
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      locales[lang] = JSON.parse(data);
      logger.info({ language: lang, keys: Object.keys(locales[lang]).length }, 'Locale loaded');
    } catch (err) {
      logger.warn({ language: lang, error: err.message }, 'Failed to load locale');
      locales[lang] = {};
    }
  }
}

function translate(lang, key, params) {
  const locale = locales[lang] || locales[config.i18n.defaultLanguage] || {};
  let text = locale[key];

  if (text === undefined) {
    const fallback = locales[config.i18n.defaultLanguage] || {};
    text = fallback[key];
  }

  if (text === undefined) {
    return key;
  }

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    }
  }

  return text;
}

function detectLanguage(req) {
  // 1. Session/user preference
  if (req.session && req.session.language) {
    return req.session.language;
  }

  // 2. Query parameter
  if (req.query.lang && config.i18n.availableLanguages.includes(req.query.lang)) {
    return req.query.lang;
  }

  // 3. Accept-Language header
  const acceptLang = req.headers['accept-language'];
  if (acceptLang) {
    const preferred = acceptLang.split(',')
      .map(part => part.split(';')[0].trim().substring(0, 2).toLowerCase())
      .find(lang => config.i18n.availableLanguages.includes(lang));
    if (preferred) return preferred;
  }

  return config.i18n.defaultLanguage;
}

function i18nMiddleware(req, res, next) {
  const lang = detectLanguage(req);
  req.language = lang;
  res.locals.language = lang;
  res.locals.availableLanguages = config.i18n.availableLanguages;
  req.t = (key, params) => translate(lang, key, params);
  res.locals.t = req.t;
  next();
}

module.exports = { i18nMiddleware, loadLocales, translate };
