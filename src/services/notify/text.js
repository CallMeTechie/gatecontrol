'use strict';

// Server-side strings of the notification center (i18n prefix `push.`):
// titles of core events, topic labels, test/manual texts, the timeline of the
// delivery log. A notification is stored once, in the server language (the
// language of the first administrator, like the update mails); topic labels
// in `hello` and the portal follow the person's own language.

const { translate, loadLocales } = require('../../middleware/i18n');
const appConfig = require('../../../config/default');
const { CORE_TOPICS } = require('./constants');

let _loaded = false;
function ensureLocales() {
  if (_loaded) return;
  _loaded = true;
  if (translate('en', 'push.topic.security') === 'push.topic.security') {
    try { loadLocales(); } catch { /* keys come back as keys */ }
  }
}

function normLang(l) {
  const s = String(l || '').slice(0, 2).toLowerCase();
  return appConfig.i18n.availableLanguages.includes(s) ? s : appConfig.i18n.defaultLanguage;
}

function t(lang, key, params) {
  ensureLocales();
  return translate(normLang(lang), key, params);
}

/** Has `key` a translation (and not just the key back)? */
function has(lang, key) { return t(lang, key) !== key; }

/** Language of stored notifications: the first administrator's. */
function serverLang() {
  try {
    const row = require('../../db/connection').getDb()
      .prepare("SELECT language FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    return normLang(row && row.language);
  } catch { return normLang(null); }
}

function userLang(userId) {
  if (userId == null) return serverLang();
  try {
    const row = require('../../db/connection').getDb().prepare('SELECT language FROM users WHERE id = ?').get(userId);
    return row && row.language ? normLang(row.language) : serverLang();
  } catch { return serverLang(); }
}

/** { de, en } or string → text in `lang`. */
function loc(text, lang) {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return (lang === 'en' ? text.en : text.de) || text.en || text.de || '';
}

/** Label of a topic ('security', 'plugin:skoda:charging', …). */
function topicLabel(topic, lang) {
  if (CORE_TOPICS.includes(topic)) return t(lang, `push.topic.${topic}`);
  const pt = require('./rules').pluginTopic(topic);
  if (pt) {
    const name = loc(pt.plugin_name, lang);
    return pt.id === 'default' ? name : `${name} · ${loc(pt.label, lang)}`;
  }
  return topic;
}

module.exports = { t, has, serverLang, userLang, normLang, loc, topicLabel };
