'use strict';

// E-mail channel of plugin topics (since 1.225.0, docs/plugins.md
// "Notifications by e-mail"): a plugin push may also go out as an e-mail —
// through the server's SMTP (Einstellungen › E-Mail) to the account address
// of each GateControl person it reaches. Plugins never name an address: the
// people are the push's own recipients (`users`, `groups`, or the rule's
// recipients), so there is no way to mail anybody outside GateControl.
//
// Per person and topic (notify_email_subscriptions, migration 125): a row is
// the person's choice; without one the topic's default — on when the plugin
// declares the topic with `email: true` (plugin.json notifyTopics), else off.
// Chat topics, silent data pushes and pushes to single devices are never
// mailed. A person who switched the topic off, or has no valid address,
// gets no mail; `critical` reaches them like the push does. Each person gets
// an own mail (no shared To:), in their language, at most MAIL_PER_HOUR
// mails per plugin and hour (every recipient counts).

const { getDb } = require('../../db/connection');
const text = require('./text');
const logger = require('../../utils/logger');

const MAIL_PER_HOUR = 200;
const HOUR_MS = 60 * 60 * 1000;
const sentAt = new Map(); // plugin id → timestamps (ms) of the mails of the last hour

/** The plugin topic when it has an e-mail channel (not a chat topic), else null. */
function mailTopic(topic) {
  if (!String(topic || '').startsWith('plugin:')) return null;
  const pt = require('./rules').pluginTopic(topic);
  return pt && !pt.chat ? pt : null;
}

/** Default of the e-mail channel of a topic (plugin.json notifyTopics[].email). */
function emailDefault(topic) {
  const pt = mailTopic(topic);
  return !!(pt && pt.email === true);
}

/** Does this person get the topic by e-mail (own choice or the default)? false without an e-mail channel. */
function emailOn(userId, topic) {
  if (!mailTopic(topic)) return false;
  const r = getDb().prepare('SELECT enabled FROM notify_email_subscriptions WHERE user_id = ? AND topic = ?').get(userId, topic);
  return r ? r.enabled === 1 : emailDefault(topic);
}

function setEmail(userId, topic, on) {
  getDb().prepare(`INSERT INTO notify_email_subscriptions (user_id, topic, enabled) VALUES (?, ?, ?)
    ON CONFLICT(user_id, topic) DO UPDATE SET enabled = excluded.enabled`).run(userId, topic, on ? 1 : 0);
}

/** The account address of an enabled person ('' when there is none or it is not valid). */
function addressOf(userId) {
  const r = getDb().prepare('SELECT email FROM users WHERE id = ? AND enabled = 1').get(userId);
  const a = r && typeof r.email === 'string' ? r.email.trim() : '';
  if (!a || a.length > 255 || require('../../utils/validate').validateEmail(a)) return '';
  return a;
}

/** Is the server's SMTP set up (Einstellungen › E-Mail)? */
function smtpReady() {
  try { return require('../email').isSmtpConfigured(); } catch { return false; }
}

/**
 * The people a plugin push reaches by e-mail: `users` when given, else the
 * rule's recipients — minus those who switched the topic or its e-mail off
 * (critical ignores the topic switch, like the push) or have no address.
 */
function recipients({ topic, users, rule, priority }) {
  const R = require('./router');
  const people = new Set();
  if (Array.isArray(users) && users.length) {
    for (const id of users) if (Number.isSafeInteger(id)) people.add(id);
  } else {
    const r = (rule && rule.recipients) || {};
    if (r.admins) for (const id of R.adminIds()) people.add(id);
    if (r.subscribers) for (const id of R.subscriberIds(topic)) people.add(id);
    if (Array.isArray(r.users)) for (const id of r.users) people.add(id);
    if (Array.isArray(r.person_groups) && r.person_groups.length) {
      for (const id of require('../groups').effectiveUserIds(r.person_groups)) people.add(id);
    }
    // device groups: the people whose app devices are in them
    if (Array.isArray(r.groups) && r.groups.length) {
      for (const d of R.devicesInGroups(r.groups)) if (d.user_id != null) people.add(d.user_id);
    }
  }
  const out = [];
  for (const uid of people) {
    if (priority !== 'critical' && !R.topicOn(uid, topic)) continue;
    if (!emailOn(uid, topic)) continue;
    const to = addressOf(uid);
    if (to) out.push({ userId: uid, to });
  }
  return out;
}

/** Take up to `n` mails of the plugin's hourly budget → how many may go. */
function takeBudget(pluginId, n) {
  const now = Date.now();
  const list = (sentAt.get(pluginId) || []).filter((t) => now - t < HOUR_MS);
  const ok = Math.max(0, Math.min(n, MAIL_PER_HOUR - list.length));
  for (let i = 0; i < ok; i++) list.push(now);
  sentAt.set(pluginId, list);
  return ok;
}

function portalLink() {
  try {
    const base = String(require('../../../config/default').app.baseUrl || '').replace(/\/+$/, '');
    return /^https?:\/\//.test(base) ? base + '/portal#benachrichtigungen' : '';
  } catch { return ''; }
}

/** Subject and text of the mail for one person (their language). */
function compose(pt, n, lang) {
  const plugin = text.loc(pt.plugin_name, lang);
  const topic = text.topicLabel(pt.topic, lang);
  const link = portalLink();
  const lines = [n.title, ''];
  if (n.body) lines.push(n.body, '');
  lines.push('— ', text.t(lang, 'push.mail.footer', { plugin, topic }));
  lines.push(text.t(lang, 'push.mail.unsubscribe', { topic }) + (link ? ' ' + link : ''));
  return { subject: `[GateControl] ${n.title}`, text: lines.join('\n') };
}

/**
 * Mail a plugin push to its people (after the push itself). n: { topic (full
 * plugin:<id>:<topic>), title, body, priority, users, devices, silent, chat }.
 * → number of mails handed to SMTP (sent in the background).
 */
function send(pluginId, n, rule) {
  if (!n || n.chat === true || n.silent === true || (Array.isArray(n.devices) && n.devices.length)) return 0;
  const pt = mailTopic(n.topic);
  if (!pt || !smtpReady()) return 0;
  let list;
  try { list = recipients({ topic: n.topic, users: n.users, rule, priority: n.priority }); } catch (err) {
    logger.warn({ err: err.message, pluginId }, 'plugin notification e-mail: recipients failed');
    return 0;
  }
  if (!list.length) return 0;
  const ok = takeBudget(pluginId, list.length);
  if (ok < list.length) logger.warn({ pluginId, topic: n.topic, skipped: list.length - ok, perHour: MAIL_PER_HOUR }, 'plugin notification e-mails over the hourly limit: skipped');
  const email = require('../email');
  for (const r of list.slice(0, ok)) {
    const mail = compose(pt, n, text.userLang(r.userId));
    email.sendMail({ to: r.to, subject: mail.subject, text: mail.text })
      .catch((err) => logger.warn({ err: err.message, pluginId, userId: r.userId }, 'plugin notification e-mail failed'));
  }
  return ok;
}

/**
 * The e-mail channel of a person's topics for the prefs answers (portal and
 * app): { <topic>: boolean } for the topics that have one.
 */
function choicesFor(userId, topics) {
  const out = {};
  for (const t of topics) if (mailTopic(t)) out[t] = emailOn(userId, t);
  return out;
}

function _resetForTest() { sentAt.clear(); }

module.exports = {
  MAIL_PER_HOUR, mailTopic, emailDefault, emailOn, setEmail, addressOf, smtpReady, recipients, send, compose, choicesFor, _resetForTest,
};
