'use strict';

// Update / rollback e-mails (docs/feature-release-b.md §6).
//
// Recipient monitoring.alert_email, switch notify.update_email (default on),
// sent through the existing SMTP transport (services/email.js).
//
//  1. New version: once per version, ~90 s after the start (an image that dies
//     in its health check and gets rolled back never announces itself).
//     Downgrades (rollback to the previous image) are recorded silently.
//     The first start with this feature has no recorded version; an existing
//     installation (an older system_start in the activity log) still gets the
//     mail, a fresh install does not.
//  2. Failed update: whenever .auto-update-state.json shows a rolled_back /
//     failed entry — checked at the start and every 5 min. update.sh rewrites
//     the marker on every run (checked_at changes, a known-bad image stays
//     rolled_back until a newer :latest appears), so one mail per failure
//     streak: the same action + bad image in consecutive observations is not
//     mailed again, a failure after a success is.

const settings = require('./settings');
const logger = require('../utils/logger');
const changelog = require('./changelog');

const VERSION_DELAY_MS = 90 * 1000;
const STATE_FIRST_DELAY_MS = 15 * 1000;
const STATE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MAIL_ITEMS = 40;

const K_LAST_VERSION = 'notify.last_version';
const K_STATE_LAST = 'notify.update_state_last';

let timers = [];

const TEXT = {
  en: {
    updatedSubject: (v) => `[GateControl] GateControl updated to v${v}`,
    updatedIntro: (from, to) => (from ? `GateControl was updated from v${from} to v${to}.` : `GateControl was updated to v${to}.`),
    whatsNew: 'What\'s new:',
    rolledBackSubject: (v) => `[GateControl] Update${v ? ` to v${v}` : ''} failed — previous version restored`,
    rolledBackBody: (v, img) => `The new image${v ? ` (v${v})` : ''} did not pass its health check. update.sh restored the previous image; the failed image${img ? ` ${img}` : ''} is skipped until a newer release is published.`,
    failedRbSubject: '[GateControl] Update and rollback failed — action required',
    failedRbBody: (v) => `The new image${v ? ` (v${v})` : ''} failed its health check and restoring the previous image failed too. Please check the host: docker compose ps / docker compose logs gatecontrol.`,
    failedSubject: '[GateControl] Automatic update failed',
    failedBody: 'update.sh could not complete the update (for example the image pull failed). The running version is unchanged. Details: /var/log/gatecontrol-update.log on the host.',
    time: 'Time',
    footer: '— GateControl',
  },
  de: {
    updatedSubject: (v) => `[GateControl] GateControl auf v${v} aktualisiert`,
    updatedIntro: (from, to) => (from ? `GateControl wurde von v${from} auf v${to} aktualisiert.` : `GateControl wurde auf v${to} aktualisiert.`),
    whatsNew: 'Neu:',
    rolledBackSubject: (v) => `[GateControl] Update${v ? ` auf v${v}` : ''} fehlgeschlagen — Vorversion wiederhergestellt`,
    rolledBackBody: (v, img) => `Das neue Image${v ? ` (v${v})` : ''} hat den Health-Check nicht bestanden. update.sh hat das vorherige Image wiederhergestellt; das fehlerhafte Image${img ? ` ${img}` : ''} wird übersprungen, bis eine neuere Version erscheint.`,
    failedRbSubject: '[GateControl] Update und Rollback fehlgeschlagen — Eingriff nötig',
    failedRbBody: (v) => `Das neue Image${v ? ` (v${v})` : ''} hat den Health-Check nicht bestanden, und auch die Wiederherstellung des vorherigen Images ist gescheitert. Bitte auf dem Host prüfen: docker compose ps / docker compose logs gatecontrol.`,
    failedSubject: '[GateControl] Automatisches Update fehlgeschlagen',
    failedBody: 'update.sh konnte das Update nicht abschließen (z. B. weil der Pull des Images scheiterte). Die laufende Version ist unverändert. Details: /var/log/gatecontrol-update.log auf dem Host.',
    time: 'Zeit',
    footer: '— GateControl',
  },
};

function lang() {
  try {
    const row = require('../db/connection').getDb()
      .prepare("SELECT language FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    return row && row.language === 'de' ? 'de' : 'en';
  } catch { return 'en'; }
}

/** Recipient or null when mails are off / not deliverable. */
function recipient() {
  if (settings.get('notify.update_email', 'true') === 'false') return null;
  const to = String(settings.get('monitoring.alert_email', '') || '').trim();
  if (!to) return null;
  const email = require('./email');
  if (!email.isSmtpConfigured()) return null;
  return to;
}

async function deliver(subject, text) {
  const to = recipient();
  if (!to) return false;
  const { sendMail } = require('./email');
  await sendMail({ to, subject, text });
  return true;
}

function currentVersion() { return require('../../package.json').version; }

/** Was GateControl running before this process (i.e. not a fresh install)? */
function hadEarlierStart() {
  try {
    const bootSec = Math.floor(Date.now() / 1000 - process.uptime()) - 60;
    const row = require('../db/connection').getDb().prepare(
      "SELECT 1 FROM activity_log WHERE event_type = 'system_start' AND created_at < datetime(?, 'unixepoch') LIMIT 1"
    ).get(bootSec);
    return !!row;
  } catch { return false; }
}

function changelogLines(from, to) {
  const all = changelog.getSections();
  const sections = all
    .filter((s) => changelog.compareVersions(s.version, to) <= 0 && (!from || changelog.compareVersions(s.version, from) > 0))
    .sort((a, b) => changelog.compareVersions(b.version, a.version))
    .slice(0, changelog.MAX_SECTIONS);
  const lines = [];
  let n = 0;
  for (const s of sections) {
    lines.push('', `v${s.version}${s.date ? ` (${s.date})` : ''}`);
    for (const g of s.groups) {
      if (g.title) lines.push(`${g.title}:`);
      for (const it of g.items) {
        if (n >= MAX_MAIL_ITEMS) break;
        lines.push(`- ${changelog.itemToText(it)}`);
        n++;
      }
    }
  }
  return lines;
}

/**
 * Once per version. Returns what happened (for tests):
 * 'same' | 'recorded' (fresh install / downgrade) | 'sent' | 'skipped' (no recipient)
 */
async function checkVersion() {
  const current = currentVersion();
  const prev = settings.get(K_LAST_VERSION, null);
  if (prev === current) return 'same';
  settings.set(K_LAST_VERSION, current); // dedupe first: never twice, even if SMTP throws
  if (prev && changelog.compareVersions(current, prev) <= 0) return 'recorded';
  if (!prev && !hadEarlierStart()) return 'recorded';
  const t = TEXT[lang()];
  const lines = changelogLines(prev, current);
  const body = [t.updatedIntro(prev, current)];
  if (lines.length) body.push('', t.whatsNew, ...lines);
  body.push('', t.footer);
  const sent = await deliver(t.updatedSubject(current), body.join('\n'));
  if (sent) logger.info({ version: current, from: prev }, 'Update notification e-mail sent');
  return sent ? 'sent' : 'skipped';
}

function readMarker() {
  try { return require('./autoUpdate').readMarker(); } catch { return null; }
}
function safeRef(v) { return typeof v === 'string' && /^[A-Za-z0-9._:+-]{1,128}$/.test(v) ? v : ''; }

/**
 * Returns 'none' | 'repeat' | 'sent' | 'skipped'.
 */
async function checkState() {
  const marker = readMarker();
  if (!marker || !marker.checked_at || typeof marker.action !== 'string') return 'none';
  const cur = { action: marker.action, bad_image: safeRef(marker.bad_image), checked_at: String(marker.checked_at) };
  let prev = null;
  try { prev = JSON.parse(settings.get(K_STATE_LAST, 'null')); } catch { prev = null; }
  if (prev && prev.checked_at === cur.checked_at && prev.action === cur.action) return 'none';
  settings.set(K_STATE_LAST, JSON.stringify(cur));
  if (cur.action !== 'rolled_back' && cur.action !== 'failed') return 'none';
  if (prev && prev.action === cur.action && prev.bad_image === cur.bad_image) return 'repeat';

  const t = TEXT[lang()];
  const ver = safeRef(marker.bad_version);
  let subject;
  let text;
  if (cur.action === 'rolled_back') { subject = t.rolledBackSubject(ver); text = t.rolledBackBody(ver, cur.bad_image); }
  else if (cur.bad_image) { subject = t.failedRbSubject; text = t.failedRbBody(ver); }
  else { subject = t.failedSubject; text = t.failedBody; }
  const body = [text, '', `${t.time}: ${cur.checked_at}`, '', t.footer].join('\n');
  const sent = await deliver(subject, body);
  if (sent) logger.info({ action: cur.action }, 'Update failure e-mail sent');
  return sent ? 'sent' : 'skipped';
}

function run(name, fn) {
  fn().catch((err) => logger.warn({ err: err.message }, `update notification (${name}) failed`));
}

function start() {
  stop();
  const t1 = setTimeout(() => run('version', checkVersion), VERSION_DELAY_MS);
  const t2 = setTimeout(() => run('state', checkState), STATE_FIRST_DELAY_MS);
  const t3 = setInterval(() => run('state', checkState), STATE_INTERVAL_MS);
  for (const t of [t1, t2, t3]) if (t.unref) t.unref();
  timers = [t1, t2, t3];
}

function stop() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
}

module.exports = { start, stop, checkVersion, checkState, K_LAST_VERSION, K_STATE_LAST };
