'use strict';

// The user profile (docs/feature-user-profile.md): one profile per person, kept by that person in the portal
// ("Mein Profil") and in the apps. The account keeps its name, e-mail address, language, picture and colour as
// before; new are first and last name, a short "about", the birthday, further e-mail addresses, the time zone (the
// same value as the quiet hours, notify_user_prefs.tz) and phone numbers — and per field who sees it.
//
//   visibility     per field 'self' | 'family' | 'all' ("Familie" = a GateControl group of the kind family both
//                  belong to). Phone numbers per number 'none' | 'family' | 'all' — 'none' is the default and means
//                  nobody, not even an administrator, not even a plugin acting for the person herself.
//   administrators see what they need to manage an account (name, user name, e-mail, language) and otherwise only
//                  what is visible to everybody. Of the phone numbers they see count, state and whether the
//                  recognition is on — never a digit (adminView).
//   phone numbers  up to 5. At rest the number is encrypted with the server's key (utils/crypto, AES-256-GCM) and,
//                  to compare, a keyed hash of its E.164 form (HMAC-SHA-256 with a key derived from the server's
//                  key). Neither ever leaves this module except the number to its owner (ownView, export).
//                  States: unconfirmed, whatsapp (the person's own linked WhatsApp has this number — services/bridges
//                  tells noteOwnNumbers after every whoami), admin (an administrator confirmed it without seeing it),
//                  directory (reserved for numbers of AD / Entra).
//   recognition    two consents, both off: by the own linked WhatsApp, by the phone numbers. matchContacts() is the
//                  only place that compares — for gc.bridges.matchAccounts: "which of my contacts at the bridge are
//                  accounts here?". A number in two accounts is never used; an unconfirmed number only as a medium
//                  hint and only while the administrator allows it (profile.match_confirmed_only).
//   e-mail         up to 3 further addresses, confirmed with a code by mail when the server can send mail.
//   directory      an account of an enabled directory (AD, Entra) gets name and e-mail from there: locked here.
//   plugins        gc.profile.get (permissions.profile: a list of fields; "phones" separately) — viewFor(); the hook
//                  profileChanged { userId, fields } names what changed, never a value. gc.users is unchanged.
//   log            the activity log names the field or the kind of a number, never a value or a digit.

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const activity = require('./activity');
const logger = require('../utils/logger');
const config = require('../../config/default');
const { encrypt, decrypt } = require('../utils/crypto');

const KINDS = Object.freeze(['mobile', 'work', 'home', 'other']);
const PHONE_VISIBILITY = Object.freeze(['none', 'family', 'all']);
const FIELD_VISIBILITY = Object.freeze(['self', 'family', 'all']);
const PHONE_STATES = Object.freeze(['unconfirmed', 'whatsapp', 'admin', 'directory']);
const CONFIRMED = new Set(['whatsapp', 'admin', 'directory']);
const VIS_FIELDS = Object.freeze(['firstName', 'lastName', 'about', 'birthday', 'email', 'language', 'timezone']);
const DEFAULT_VISIBILITY = Object.freeze({ firstName: 'all', lastName: 'all', about: 'all', birthday: 'family', email: 'self', language: 'self', timezone: 'self' });
// what a plugin may ask for (permissions.profile)
const PLUGIN_FIELDS = Object.freeze(['firstName', 'lastName', 'about', 'birthday', 'phones']);
const MAX_PHONES = 5;
const MAX_EMAILS = 3;
const ABOUT_MAX = 140;
const NAME_MAX = 60;
const DISPLAY_MAX = 100;
const NUMBER_RE = /^\+[1-9][0-9]{6,14}$/;
const CODE_TTL_MS = 30 * 60000;
const CODE_RESEND_MS = 60000;
const CODE_TRIES = 5;
const EXPORT_PLUGIN_MS = 5000;
const EXPORT_PLUGIN_BYTES = 256 * 1024;

class ProfileError extends Error {
  constructor(code, message, field) { super(message || code); this.code = code; if (field) this.field = field; }
}
const invalid = (field, message) => new ProfileError('ERR_INVALID', message || `${field}: invalid`, field);

// ─── Server settings ─────────────────────────────────────────────

/** "Telefonnummern im Profil erlauben" (on): off hides the numbers everywhere and nobody is recognised by them. */
function phonesEnabled() { return settings.get('profile.phones_enabled', '1') !== '0'; }
/** "Zum Erkennen nur bestätigte Nummern nutzen" (off): on drops the medium hint of unconfirmed numbers. */
function confirmedOnly() { return settings.get('profile.match_confirmed_only', '0') === '1'; }
function getSettings() { return { phonesEnabled: phonesEnabled(), confirmedOnly: confirmedOnly() }; }
function setSettings(patch, ctx = {}) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const changed = [];
  if (p.phonesEnabled !== undefined) {
    if (typeof p.phonesEnabled !== 'boolean') throw invalid('phonesEnabled');
    settings.set('profile.phones_enabled', p.phonesEnabled ? '1' : '0');
    changed.push('phonesEnabled');
  }
  if (p.confirmedOnly !== undefined) {
    if (typeof p.confirmedOnly !== 'boolean') throw invalid('confirmedOnly');
    settings.set('profile.match_confirmed_only', p.confirmedOnly ? '1' : '0');
    changed.push('confirmedOnly');
  }
  if (changed.length) {
    activity.log('profile_settings_changed', 'Profile settings changed', {
      source: 'admin', ipAddress: ctx.ip || null, severity: 'info', details: { by: ctx.actorId || null, ...getSettings() },
    });
  }
  return getSettings();
}

// ─── Numbers ─────────────────────────────────────────────────────

/** A phone number in E.164 form (+, country code, 7 to 15 digits; spaces, dashes, dots, brackets and 00 allowed) or null. */
function normalizeNumber(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  let n = v.replace(/[\s \-./()]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  return NUMBER_RE.test(n) ? n : null;
}

const hashKey = { src: null, key: null };
function numberKey() {
  const k = config.encryption && config.encryption.key;
  if (!k) throw new Error('GC_ENCRYPTION_KEY is not set — cannot store phone numbers');
  if (hashKey.src !== k) {
    hashKey.key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(k, 'hex'), Buffer.alloc(0), 'gatecontrol-profile-number-hash-v1', 32));
    hashKey.src = k;
  }
  return hashKey.key;
}
/** The keyed hash of a number in E.164 form (never leaves this module). */
function hashNumber(e164) { return crypto.createHmac('sha256', numberKey()).update(e164, 'utf8').digest('base64url'); }

function decryptNumber(enc) {
  try { return decrypt(enc); } catch { return null; }
}

// ─── Rows ────────────────────────────────────────────────────────

const USER_COLS = `id, username, display_name, email, language, role, enabled, created_at, last_login_at, self_service_enabled, avatar_color,
  first_name, last_name, about, birthday, birthday_year_hidden, profile_visibility,
  recognize_by_whatsapp, recognize_by_whatsapp_at, recognize_by_phone, recognize_by_phone_at`;

function userRow(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) || null;
}
function needUser(userId) {
  const u = userRow(userId);
  if (!u) throw new ProfileError('ERR_NOT_FOUND', 'unknown user');
  return u;
}

function visibilityOf(row) {
  let v = null;
  try { v = row && row.profile_visibility ? JSON.parse(row.profile_visibility) : null; } catch { v = null; }
  const out = { ...DEFAULT_VISIBILITY };
  if (v && typeof v === 'object') for (const f of VIS_FIELDS) if (FIELD_VISIBILITY.includes(v[f])) out[f] = v[f];
  return out;
}

/** The directory whose sync overwrites a member's name and e-mail (administrators keep theirs — directory/sync.js), or null. */
function lockedBy(u) { return u && u.role === 'user' ? directoryOf(u.id) : null; }

/** The directory an account's name and e-mail come from (an enabled AD / Entra connection), or null. */
function directoryOf(userId) {
  try {
    const r = getDb().prepare(`SELECT d.id, d.name FROM directory_links l JOIN directories d ON d.id = l.directory_id
      WHERE l.user_id = ? AND d.enabled = 1`).get(userId);
    return r ? { id: r.id, name: r.name } : null;
  } catch { return null; }
}

function familyIds(userId) {
  try {
    return require('./groups').groupsOfUser(userId).filter((g) => g.kind === 'family').map((g) => g.id);
  } catch { return []; }
}
/** Do both belong to one family group? */
function sameFamily(a, b) {
  if (!a || !b) return false;
  const fa = new Set(familyIds(a));
  return fa.size > 0 && familyIds(b).some((id) => fa.has(id));
}

function timezoneOf(userId) {
  try {
    const router = require('./notify/router');
    const p = router.userPrefs(userId);
    return { timezone: p && router.validTz(p.tz) ? p.tz : null, serverTimezone: router.serverTz() };
  } catch { return { timezone: null, serverTimezone: 'UTC' }; }
}

// ─── Birthday ────────────────────────────────────────────────────

function parseBirthday(s) {
  if (typeof s !== 'string') return null;
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = m[1] ? Number(m[1]) : null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const days = new Date(Date.UTC(year == null ? 2000 : year, month, 0)).getUTCDate();
  if (day > days) return null;
  if (year != null && (year < 1900 || year > new Date().getUTCFullYear())) return null;
  return { year, month, day };
}
const pad2 = (n) => String(n).padStart(2, '0');
/** The birthday as the viewer may see it: { date, month, day, year, yearHidden } (self) — the year never to others when hidden. */
function birthdayView(row, self) {
  const b = parseBirthday(row.birthday);
  if (!b) return null;
  const hidden = row.birthday_year_hidden === 1;
  if (self) return { date: row.birthday, month: b.month, day: b.day, year: b.year, yearHidden: hidden };
  const year = hidden ? null : b.year;
  return { date: year == null ? `--${pad2(b.month)}-${pad2(b.day)}` : `${year}-${pad2(b.month)}-${pad2(b.day)}`, month: b.month, day: b.day, year };
}

// ─── Own view ────────────────────────────────────────────────────

function phoneRows(userId) {
  return getDb().prepare('SELECT * FROM user_phones WHERE user_id = ? ORDER BY id').all(userId);
}
function emailRows(userId) {
  return getDb().prepare('SELECT * FROM user_emails WHERE user_id = ? ORDER BY id').all(userId);
}
function selfHashes(userId, network = null) {
  const rows = network
    ? getDb().prepare('SELECT number_hash FROM user_bridge_selves WHERE user_id = ? AND network = ?').all(userId, network)
    : getDb().prepare('SELECT number_hash FROM user_bridge_selves WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => r.number_hash));
}

function mailReady() {
  try { return require('./email').isSmtpConfigured(); } catch { return false; }
}

function phoneOwn(p) {
  return {
    id: p.id, kind: p.kind, number: decryptNumber(p.number_enc), visibility: p.visibility,
    useForRecognition: p.use_for_recognition === 1, state: p.state, confirmed: CONFIRMED.has(p.state), createdAt: p.created_at,
  };
}
function emailOwn(e) {
  return { id: e.id, address: e.address, state: e.state, codePending: e.state !== 'confirmed' && !!e.code_hash && Number(e.code_expires_at) > Date.now() };
}

/** Everything of the profile for the person herself (portal, apps, web). */
function ownView(userId) {
  const u = needUser(userId);
  const dir = lockedBy(u);
  const phonesOn = phonesEnabled();
  const phones = phonesOn ? phoneRows(u.id).map(phoneOwn) : [];
  const tz = timezoneOf(u.id);
  return {
    userId: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    firstName: u.first_name || null,
    lastName: u.last_name || null,
    about: u.about || null,
    birthday: birthdayView(u, true),
    email: u.email || null,
    emails: emailRows(u.id).map(emailOwn),
    language: u.language || null,
    timezone: tz.timezone,
    serverTimezone: tz.serverTimezone,
    visibility: visibilityOf(u),
    phones,
    recognition: {
      byWhatsapp: u.recognize_by_whatsapp === 1,
      byPhone: u.recognize_by_phone === 1,
      whatsappAnswered: !!u.recognize_by_whatsapp_at,
      phoneAnswered: !!u.recognize_by_phone_at,
      whatsappLinked: selfHashes(u.id, 'whatsapp').size > 0,
      phonesForRecognition: phones.filter((p) => p.useForRecognition).length,
    },
    locked: { displayName: !!dir, email: !!dir, directory: dir ? dir.name : null },
    family: familyIds(u.id).length > 0,
    features: { phones: phonesOn, emailConfirm: mailReady(), recognition: true },
    limits: { phones: MAX_PHONES, emails: MAX_EMAILS, about: ABOUT_MAX, name: NAME_MAX, displayName: DISPLAY_MAX },
    options: { kinds: [...KINDS], phoneVisibility: [...PHONE_VISIBILITY], fieldVisibility: [...FIELD_VISIBILITY], phoneStates: [...PHONE_STATES] },
  };
}

// ─── Hook and log ────────────────────────────────────────────────

/** Tell running plugins with permissions.users that a profile changed: { userId, fields } — never a value. */
function emitChanged(userId, fields) {
  const list = [...new Set(fields)].filter(Boolean);
  if (!list.length) return;
  setImmediate(() => {
    let rows;
    try { rows = require('./plugins/registry').list(); } catch { return; }
    for (const p of rows) {
      const perms = p.manifest && p.manifest.permissions;
      if (!p.enabled || !perms || perms.users !== true) continue;
      // "phones" only to a plugin that may read numbers at all
      const out = list.filter((f) => f !== 'phones' || (Array.isArray(perms.profile) && perms.profile.includes('phones')));
      if (!out.length) continue;
      try {
        const rt = require('./plugins/runtime');
        if (rt.info(p.id).state !== 'running') continue;
        rt.call(p.id, 'profileChanged', { userId, fields: out }, 10000).catch(() => {});
      } catch { /* the plugin reads it at its next request */ }
    }
  });
}

const KIND_LABEL = { mobile: 'Mobil', work: 'Geschäftlich', home: 'Privat', other: 'Sonstige' };

function log(type, message, userId, ctx, extra) {
  try {
    activity.log(type, message, {
      source: ctx && ctx.source ? ctx.source : 'user', ipAddress: ctx && ctx.ip ? ctx.ip : null, severity: 'info',
      details: { userId, ...(ctx && ctx.actorId && ctx.actorId !== userId ? { by: ctx.actorId } : {}), ...(extra || {}) },
    });
  } catch (err) { logger.debug({ err: err.message }, 'profile: activity not written'); }
}

// ─── Changes by the person ───────────────────────────────────────

function text(v, max, field, { required = false } = {}) {
  if (v === null || v === '') { if (required) throw invalid(field); return null; }
  if (typeof v !== 'string') throw invalid(field);
  const s = v.replace(/[\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) { if (required) throw invalid(field); return null; }
  if (Array.from(s).length > max) throw invalid(field, `${field}: at most ${max} characters`);
  return s;
}

/**
 * update(userId, patch, ctx) → ownView — the person's own change. patch: displayName, firstName, lastName, about,
 * birthday ({ date: 'YYYY-MM-DD' | '--MM-DD' | null, yearHidden }), email, language, timezone, visibility
 * ({ field: level }), recognition ({ byWhatsapp?, byPhone? }). Unknown keys are refused.
 * ctx: { ip, source: 'user' | 'api', actorId }.
 */
function update(userId, patch, ctx = {}) {
  const u = needUser(userId);
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw invalid('body');
  const known = ['displayName', 'firstName', 'lastName', 'about', 'birthday', 'email', 'language', 'timezone', 'visibility', 'recognition'];
  for (const k of Object.keys(p)) if (!known.includes(k)) throw invalid(k, `${k}: unknown field`);
  const dir = lockedBy(u);
  const sets = [];
  const vals = [];
  const changed = [];
  const set = (col, val, field) => { sets.push(`${col} = ?`); vals.push(val); changed.push(field); };

  if (p.displayName !== undefined) {
    const v = text(p.displayName, DISPLAY_MAX, 'displayName', { required: true });
    if (v !== (u.display_name || null)) {
      if (dir) throw new ProfileError('ERR_LOCKED', 'from the directory', 'displayName');
      set('display_name', v, 'displayName');
    }
  }
  if (p.firstName !== undefined) { const v = text(p.firstName, NAME_MAX, 'firstName'); if (v !== (u.first_name || null)) set('first_name', v, 'firstName'); }
  if (p.lastName !== undefined) { const v = text(p.lastName, NAME_MAX, 'lastName'); if (v !== (u.last_name || null)) set('last_name', v, 'lastName'); }
  if (p.about !== undefined) { const v = text(p.about, ABOUT_MAX, 'about'); if (v !== (u.about || null)) set('about', v, 'about'); }
  if (p.birthday !== undefined) {
    let date = null;
    let hidden = 0;
    if (p.birthday !== null) {
      const b = p.birthday;
      if (!b || typeof b !== 'object' || (b.date !== null && typeof b.date !== 'string') || (b.yearHidden != null && typeof b.yearHidden !== 'boolean')) throw invalid('birthday');
      if (b.date) {
        const parsed = parseBirthday(b.date);
        if (!parsed) throw invalid('birthday');
        date = parsed.year == null ? `--${pad2(parsed.month)}-${pad2(parsed.day)}` : `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`;
        hidden = parsed.year != null && b.yearHidden === true ? 1 : 0;
      }
    }
    if (date !== (u.birthday || null) || hidden !== (u.birthday_year_hidden || 0)) {
      sets.push('birthday = ?', 'birthday_year_hidden = ?');
      vals.push(date, hidden);
      changed.push('birthday');
    }
  }
  if (p.email !== undefined) {
    const v = p.email === null || p.email === '' ? null : (typeof p.email === 'string' ? p.email.trim() : undefined);
    if (v === undefined || (v && (v.length > 255 || require('../utils/validate').validateEmail(v)))) throw invalid('email');
    if (v !== (u.email || null)) {
      if (dir) throw new ProfileError('ERR_LOCKED', 'from the directory', 'email');
      set('email', v, 'email');
    }
  }
  if (p.language !== undefined) {
    const langs = (config.i18n && config.i18n.availableLanguages) || ['en', 'de'];
    if (typeof p.language !== 'string' || !langs.includes(p.language)) throw invalid('language');
    if (p.language !== u.language) set('language', p.language, 'language');
  }
  let tz;
  if (p.timezone !== undefined) {
    const router = require('./notify/router');
    if (p.timezone !== null && p.timezone !== '' && !router.validTz(p.timezone)) throw invalid('timezone');
    tz = p.timezone || null;
    if (tz === timezoneOf(u.id).timezone) tz = undefined;
    else changed.push('timezone');
  }
  if (p.visibility !== undefined) {
    const v = p.visibility;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('visibility');
    const cur = visibilityOf(u);
    const next = { ...cur };
    for (const [k, level] of Object.entries(v)) {
      if (!VIS_FIELDS.includes(k) || !FIELD_VISIBILITY.includes(level)) throw invalid('visibility', `visibility.${k}: invalid`);
      next[k] = level;
    }
    const diff = VIS_FIELDS.filter((k) => next[k] !== cur[k]);
    if (diff.length) {
      sets.push('profile_visibility = ?');
      vals.push(JSON.stringify(next));
      // a field another person now sees (or no longer sees) changed for them
      for (const k of diff) changed.push(k === 'email' || k === 'language' || k === 'timezone' ? 'visibility' : k);
    }
  }
  if (p.recognition !== undefined) {
    const r = p.recognition;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalid('recognition');
    for (const [k, col] of [['byWhatsapp', 'recognize_by_whatsapp'], ['byPhone', 'recognize_by_phone']]) {
      if (r[k] === undefined) continue;
      if (typeof r[k] !== 'boolean') throw invalid('recognition', `recognition.${k}: true or false`);
      // the answer is kept with its time even when unchanged: "asked once" for the apps and the portal
      sets.push(`${col} = ?`, `${col}_at = datetime('now')`);
      vals.push(r[k] ? 1 : 0);
      if ((u[col] === 1) !== r[k]) changed.push(k === 'byWhatsapp' ? 'recognitionWhatsapp' : 'recognitionPhone');
    }
  }

  const db = getDb();
  db.transaction(() => {
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, u.id);
    if (tz !== undefined) {
      db.prepare(`INSERT INTO notify_user_prefs (user_id, tz) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET tz = excluded.tz`).run(u.id, tz);
    }
  })();
  const fields = [...new Set(changed)];
  if (fields.length) {
    log('profile_updated', `Profile of "${u.username}" changed: ${fields.join(', ')}`, u.id, ctx, { fields });
    // what plugins may care about (never e-mail, language, time zone or the consents)
    emitChanged(u.id, fields.filter((f) => ['displayName', 'firstName', 'lastName', 'about', 'birthday'].includes(f)));
  }
  return ownView(u.id);
}

// ─── Phone numbers ───────────────────────────────────────────────

function needPhones() { if (!phonesEnabled()) throw new ProfileError('ERR_PHONES_OFF', 'phone numbers are switched off on this server'); }
function phoneOf(userId, phoneId) {
  const id = Number(phoneId);
  const row = Number.isSafeInteger(id) && id > 0 ? getDb().prepare('SELECT * FROM user_phones WHERE id = ? AND user_id = ?').get(id, userId) : null;
  if (!row) throw new ProfileError('ERR_NOT_FOUND', 'no such number');
  return row;
}
function phoneFields(input, { partial }) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!i) throw invalid('body');
  for (const k of Object.keys(i)) if (!['kind', 'number', 'visibility', 'useForRecognition'].includes(k)) throw invalid(k, `${k}: unknown field`);
  const out = {};
  if (i.kind !== undefined || !partial) { if (!KINDS.includes(i.kind === undefined ? 'mobile' : i.kind)) throw invalid('kind'); out.kind = i.kind === undefined ? 'mobile' : i.kind; }
  if (i.number !== undefined || !partial) { const n = normalizeNumber(i.number); if (!n) throw invalid('number', 'number: + and the country code'); out.number = n; }
  if (i.visibility !== undefined || !partial) { const v = i.visibility === undefined ? 'none' : i.visibility; if (!PHONE_VISIBILITY.includes(v)) throw invalid('visibility'); out.visibility = v; }
  if (i.useForRecognition !== undefined || !partial) {
    const v = i.useForRecognition === undefined ? true : i.useForRecognition;
    if (typeof v !== 'boolean') throw invalid('useForRecognition');
    out.useForRecognition = v;
  }
  return out;
}

/** addPhone(userId, { kind, number, visibility = 'none', useForRecognition = true }, ctx) → the number as its owner sees it. */
function addPhone(userId, input, ctx = {}) {
  needPhones();
  const u = needUser(userId);
  const f = phoneFields(input, { partial: false });
  const db = getDb();
  const hash = hashNumber(f.number);
  const row = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS c FROM user_phones WHERE user_id = ?').get(u.id).c >= MAX_PHONES) throw new ProfileError('ERR_LIMIT', `at most ${MAX_PHONES} numbers`);
    if (db.prepare('SELECT 1 FROM user_phones WHERE user_id = ? AND number_hash = ?').get(u.id, hash)) throw new ProfileError('ERR_DUPLICATE', 'this number is in the profile already', 'number');
    const state = selfHashes(u.id).has(hash) ? 'whatsapp' : 'unconfirmed';
    const id = db.prepare(`INSERT INTO user_phones (user_id, kind, number_enc, number_hash, visibility, use_for_recognition, state, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${state === 'unconfirmed' ? 'NULL' : "datetime('now')"})`)
      .run(u.id, f.kind, encrypt(f.number), hash, f.visibility, f.useForRecognition ? 1 : 0, state).lastInsertRowid;
    return db.prepare('SELECT * FROM user_phones WHERE id = ?').get(id);
  })();
  log('profile_phone_added', `Telefonnummer hinzugefügt (${KIND_LABEL[row.kind]})`, u.id, ctx, { phoneId: row.id, kind: row.kind, visibility: row.visibility });
  emitChanged(u.id, ['phones']);
  return phoneOwn(row);
}

/** updatePhone(userId, phoneId, { kind?, number?, visibility?, useForRecognition? }, ctx) — a new number starts unconfirmed again. */
function updatePhone(userId, phoneId, input, ctx = {}) {
  needPhones();
  const u = needUser(userId);
  const row = phoneOf(u.id, phoneId);
  const f = phoneFields(input, { partial: true });
  const db = getDb();
  const sets = [];
  const vals = [];
  const what = [];
  if (f.kind !== undefined && f.kind !== row.kind) { sets.push('kind = ?'); vals.push(f.kind); what.push('kind'); }
  if (f.visibility !== undefined && f.visibility !== row.visibility) { sets.push('visibility = ?'); vals.push(f.visibility); what.push('visibility'); }
  if (f.useForRecognition !== undefined && f.useForRecognition !== (row.use_for_recognition === 1)) { sets.push('use_for_recognition = ?'); vals.push(f.useForRecognition ? 1 : 0); what.push('useForRecognition'); }
  if (f.number !== undefined) {
    const hash = hashNumber(f.number);
    if (hash !== row.number_hash) {
      if (db.prepare('SELECT 1 FROM user_phones WHERE user_id = ? AND number_hash = ? AND id <> ?').get(u.id, hash, row.id)) throw new ProfileError('ERR_DUPLICATE', 'this number is in the profile already', 'number');
      const state = selfHashes(u.id).has(hash) ? 'whatsapp' : 'unconfirmed';
      sets.push('number_enc = ?', 'number_hash = ?', 'state = ?', `confirmed_at = ${state === 'unconfirmed' ? 'NULL' : "datetime('now')"}`);
      vals.push(encrypt(f.number), hash, state);
      what.push('number');
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE user_phones SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, row.id);
    log('profile_phone_changed', `Telefonnummer geändert (${KIND_LABEL[f.kind || row.kind]}): ${what.join(', ')}`, u.id, ctx, { phoneId: row.id, kind: f.kind || row.kind, fields: what });
    emitChanged(u.id, ['phones']);
  }
  return phoneOwn(db.prepare('SELECT * FROM user_phones WHERE id = ?').get(row.id));
}

function removePhone(userId, phoneId, ctx = {}) {
  const u = needUser(userId);
  const row = phoneOf(u.id, phoneId);
  getDb().prepare('DELETE FROM user_phones WHERE id = ?').run(row.id);
  log('profile_phone_removed', `Telefonnummer entfernt (${KIND_LABEL[row.kind]})`, u.id, ctx, { phoneId: row.id, kind: row.kind });
  emitChanged(u.id, ['phones']);
  return { ok: true };
}

// ─── Further e-mail addresses ────────────────────────────────────

function emailOf(userId, emailId) {
  const id = Number(emailId);
  const row = Number.isSafeInteger(id) && id > 0 ? getDb().prepare('SELECT * FROM user_emails WHERE id = ? AND user_id = ?').get(id, userId) : null;
  if (!row) throw new ProfileError('ERR_NOT_FOUND', 'no such address');
  return row;
}
const codeHash = (code) => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

async function sendCode(u, row, lang) {
  if (!mailReady()) return false;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  getDb().prepare('UPDATE user_emails SET code_hash = ?, code_expires_at = ?, code_tries = 0 WHERE id = ?').run(codeHash(code), Date.now() + CODE_TTL_MS, row.id);
  const de = lang !== 'en';
  const subject = de ? 'Bestätige deine E-Mail-Adresse' : 'Confirm your e-mail address';
  const body = de
    ? `Hallo ${u.display_name || u.username},\n\ndein Code für GateControl lautet: ${code}\n\nGib ihn in deinem Profil unter „E-Mail“ ein. Er gilt 30 Minuten.\nHast du diese Adresse nicht eingetragen, kannst du diese Nachricht ignorieren.`
    : `Hello ${u.display_name || u.username},\n\nyour GateControl code is: ${code}\n\nEnter it in your profile under "Email". It is valid for 30 minutes.\nIf you did not add this address, you can ignore this message.`;
  try {
    await require('./email').sendMail({ to: row.address, subject, text: body });
    return true;
  } catch (err) {
    logger.warn({ err: err.message, userId: u.id }, 'profile: confirmation code not sent');
    getDb().prepare('UPDATE user_emails SET code_hash = NULL, code_expires_at = NULL WHERE id = ?').run(row.id);
    return false;
  }
}

/** addEmail(userId, { address }, ctx) → { email, codeSent } — confirmed with a code when the server can send mail. */
async function addEmail(userId, input, ctx = {}) {
  const u = needUser(userId);
  const i = input && typeof input === 'object' ? input : {};
  const address = typeof i.address === 'string' ? i.address.trim() : '';
  if (!address || address.length > 255 || require('../utils/validate').validateEmail(address)) throw invalid('address');
  const lc = address.toLowerCase();
  if (u.email && u.email.toLowerCase() === lc) throw new ProfileError('ERR_DUPLICATE', 'this is the main address', 'address');
  const db = getDb();
  const row = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS c FROM user_emails WHERE user_id = ?').get(u.id).c >= MAX_EMAILS) throw new ProfileError('ERR_LIMIT', `at most ${MAX_EMAILS} further addresses`);
    if (db.prepare('SELECT 1 FROM user_emails WHERE user_id = ? AND address_lc = ?').get(u.id, lc)) throw new ProfileError('ERR_DUPLICATE', 'this address is in the profile already', 'address');
    const id = db.prepare('INSERT INTO user_emails (user_id, address, address_lc) VALUES (?, ?, ?)').run(u.id, address, lc).lastInsertRowid;
    return db.prepare('SELECT * FROM user_emails WHERE id = ?').get(id);
  })();
  log('profile_email_added', 'Weitere E-Mail-Adresse hinzugefügt', u.id, ctx, { emailId: row.id });
  const codeSent = await sendCode(u, row, ctx.lang || u.language);
  return { email: emailOwn(emailOf(u.id, row.id)), codeSent };
}

/** resendCode(userId, emailId, ctx) → { email, codeSent } — at most once a minute. */
async function resendCode(userId, emailId, ctx = {}) {
  const u = needUser(userId);
  const row = emailOf(u.id, emailId);
  if (row.state === 'confirmed') return { email: emailOwn(row), codeSent: false };
  if (!mailReady()) throw new ProfileError('ERR_NO_MAIL', 'this server cannot send mail');
  if (row.code_expires_at && Number(row.code_expires_at) - CODE_TTL_MS + CODE_RESEND_MS > Date.now()) throw new ProfileError('ERR_RATE_LIMIT', 'a code was sent a moment ago');
  const codeSent = await sendCode(u, row, ctx.lang || u.language);
  return { email: emailOwn(emailOf(u.id, row.id)), codeSent };
}

/** confirmEmail(userId, emailId, code, ctx) → the address — 5 tries per code, 30 minutes. */
function confirmEmail(userId, emailId, code, ctx = {}) {
  const u = needUser(userId);
  const row = emailOf(u.id, emailId);
  if (row.state === 'confirmed') return emailOwn(row);
  if (!row.code_hash || !(Number(row.code_expires_at) > Date.now())) throw new ProfileError('ERR_CODE_EXPIRED', 'no valid code — ask for a new one');
  if (row.code_tries >= CODE_TRIES) throw new ProfileError('ERR_CODE_EXPIRED', 'too many tries — ask for a new one');
  const c = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  const ok = /^\d{6}$/.test(c) && crypto.timingSafeEqual(Buffer.from(codeHash(c), 'hex'), Buffer.from(row.code_hash, 'hex'));
  const db = getDb();
  if (!ok) {
    db.prepare('UPDATE user_emails SET code_tries = code_tries + 1 WHERE id = ?').run(row.id);
    throw new ProfileError('ERR_CODE', 'wrong code', 'code');
  }
  db.prepare("UPDATE user_emails SET state = 'confirmed', confirmed_at = datetime('now'), code_hash = NULL, code_expires_at = NULL, code_tries = 0 WHERE id = ?").run(row.id);
  log('profile_email_confirmed', 'Weitere E-Mail-Adresse bestätigt', u.id, ctx, { emailId: row.id });
  return emailOwn(emailOf(u.id, row.id));
}

function removeEmail(userId, emailId, ctx = {}) {
  const u = needUser(userId);
  const row = emailOf(u.id, emailId);
  getDb().prepare('DELETE FROM user_emails WHERE id = ?').run(row.id);
  log('profile_email_removed', 'Weitere E-Mail-Adresse entfernt', u.id, ctx, { emailId: row.id });
  return { ok: true };
}

// ─── The own messenger login (services/bridges) ──────────────────

/**
 * noteOwnNumbers(userId, network, numbers) — after every whoami of the person's own link: the numbers of her logins
 * (E.164). Keeps their keyed hashes (user_bridge_selves) and sets the state of her profile numbers: "whatsapp" while
 * a login has that number, back to "unconfirmed" when none has it any more. Never throws, never logs a number.
 */
function noteOwnNumbers(userId, network, numbers) {
  try {
    if (!userRow(userId)) return;
    const hashes = [...new Set((numbers || []).map(normalizeNumber).filter(Boolean).map(hashNumber))];
    const db = getDb();
    let confirmed = 0;
    let dropped = 0;
    db.transaction(() => {
      const have = selfHashes(userId, network);
      for (const h of have) if (!hashes.includes(h)) db.prepare('DELETE FROM user_bridge_selves WHERE user_id = ? AND network = ? AND number_hash = ?').run(userId, network, h);
      for (const h of hashes) {
        db.prepare(`INSERT INTO user_bridge_selves (user_id, network, number_hash) VALUES (?, ?, ?)
          ON CONFLICT(user_id, network, number_hash) DO UPDATE SET seen_at = datetime('now')`).run(userId, network, h);
      }
      const all = selfHashes(userId);
      for (const p of db.prepare("SELECT id, state, number_hash FROM user_phones WHERE user_id = ? AND state IN ('unconfirmed', 'whatsapp')").all(userId)) {
        const on = all.has(p.number_hash);
        if (on && p.state === 'unconfirmed') { db.prepare("UPDATE user_phones SET state = 'whatsapp', confirmed_at = datetime('now') WHERE id = ?").run(p.id); confirmed++; }
        else if (!on && p.state === 'whatsapp') { db.prepare("UPDATE user_phones SET state = 'unconfirmed', confirmed_at = NULL WHERE id = ?").run(p.id); dropped++; }
      }
    })();
    if (confirmed || dropped) {
      log('profile_phone_whatsapp', `Telefonnummern über das eigene ${network === 'whatsapp' ? 'WhatsApp' : network}: ${confirmed} bestätigt, ${dropped} nicht mehr bestätigt`, userId,
        { source: 'system' }, { network, confirmed, dropped });
      emitChanged(userId, ['phones']);
    }
  } catch (err) { logger.warn({ err: err.message }, 'profile: own numbers not noted'); }
}

/** Forget the own login's numbers (the link was ended). */
function forgetOwnNumbers(userId, network) { noteOwnNumbers(userId, network, []); }

// ─── Recognition (gc.bridges.matchAccounts) ──────────────────────

function inChunks(list, size, fn) { for (let i = 0; i < list.length; i += size) fn(list.slice(i, i + size)); }

/**
 * matchContacts(viewerId, network, pairs) → [{ contactId, userId, strength, via }] — which of the viewer's contacts at
 * a bridge ([{ contactId, number }], the numbers straight from the bridge's contact list) are accounts here:
 *   via own_whatsapp    the account's own linked login on this network has the number — strong; needs its consent
 *                       recognize_by_whatsapp
 *   via profile_phone   the number is in the account's profile with "Zum Erkennen nutzen" — strong when confirmed,
 *                       medium when not (not at all with profile.match_confirmed_only); needs recognize_by_phone and
 *                       the server's switch for numbers
 * Never: the viewer, a disabled account, a number that stands in two accounts (profile or own login), a contact that
 * would name two accounts. Numbers and hashes stay here; what goes out is the pairing only.
 */
function matchContacts(viewerId, network, pairs) {
  const byHash = new Map();
  for (const x of Array.isArray(pairs) ? pairs : []) {
    if (!x || typeof x.contactId !== 'string') continue;
    const n = normalizeNumber(x.number);
    if (!n) continue;
    const h = hashNumber(n);
    if (!byHash.has(h)) byHash.set(h, new Set());
    byHash.get(h).add(x.contactId);
  }
  if (!byHash.size) return [];
  const db = getDb();
  const owners = new Map(); // hash → Set(userId) over every account, whatever its consent
  const own = new Map(); // hash → userId with that own login on this network
  const prof = new Map(); // hash → { userId, state, use }
  const users = new Map();
  const add = (h, uid) => { if (!owners.has(h)) owners.set(h, new Set()); owners.get(h).add(uid); };
  inChunks([...byHash.keys()], 400, (hs) => {
    const q = hs.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT user_id, network, number_hash FROM user_bridge_selves WHERE number_hash IN (${q})`).all(...hs)) {
      add(r.number_hash, r.user_id);
      if (r.network === network) own.set(r.number_hash, r.user_id);
    }
    for (const r of db.prepare(`SELECT user_id, number_hash, state, use_for_recognition FROM user_phones WHERE number_hash IN (${q})`).all(...hs)) {
      add(r.number_hash, r.user_id);
      prof.set(r.number_hash, { userId: r.user_id, state: r.state, use: r.use_for_recognition === 1 });
    }
  });
  const ids = new Set();
  for (const s of owners.values()) for (const u of s) ids.add(u);
  inChunks([...ids], 400, (list) => {
    for (const r of db.prepare(`SELECT id, enabled, recognize_by_whatsapp, recognize_by_phone FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list)) users.set(r.id, r);
  });
  const phonesOn = phonesEnabled();
  const onlyConfirmed = confirmedOnly();
  const rank = (m) => (m.strength === 'strong' ? 2 : 1) + (m.via === 'own_whatsapp' ? 0.5 : 0);
  const perContact = new Map(); // contactId → { users: Set, best }
  for (const [h, contacts] of byHash) {
    const who = owners.get(h);
    if (!who || who.size !== 1) continue; // nobody, or in two accounts: never
    const uid = [...who][0];
    const u = users.get(uid);
    if (uid === viewerId || !u || u.enabled !== 1) continue;
    let m = null;
    if (own.get(h) === uid && u.recognize_by_whatsapp === 1) m = { userId: uid, strength: 'strong', via: 'own_whatsapp' };
    const p = prof.get(h);
    if (!m && phonesOn && p && p.userId === uid && p.use && u.recognize_by_phone === 1) {
      if (CONFIRMED.has(p.state)) m = { userId: uid, strength: 'strong', via: 'profile_phone' };
      else if (!onlyConfirmed) m = { userId: uid, strength: 'medium', via: 'profile_phone' };
    }
    for (const cid of contacts) {
      const e = perContact.get(cid) || { users: new Set(), best: null };
      e.users.add(uid);
      if (m && (!e.best || rank(m) > rank(e.best))) e.best = m;
      perContact.set(cid, e);
    }
  }
  const out = [];
  for (const [contactId, e] of perContact) {
    if (e.users.size !== 1 || !e.best) continue; // one contact, two accounts: nobody
    out.push({ contactId, userId: e.best.userId, strength: e.best.strength, via: e.best.via });
  }
  return out.sort((a, b) => (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
}

// ─── Administrators ──────────────────────────────────────────────

/** Hashes of `hashes` that stand in another account too (profile number or own messenger login). */
function sharedHashes(userId, hashes) {
  if (!hashes.length) return new Set();
  const q = hashes.map(() => '?').join(',');
  const db = getDb();
  const rows = db.prepare(`SELECT number_hash FROM user_phones WHERE user_id <> ? AND number_hash IN (${q})
    UNION SELECT number_hash FROM user_bridge_selves WHERE user_id <> ? AND number_hash IN (${q})`).all(userId, ...hashes, userId, ...hashes);
  return new Set(rows.map((r) => r.number_hash));
}

/**
 * adminView(userId, adminId) → the "Profil" card of the user page: what an administrator needs (name, user name,
 * e-mail, language — editable as before) and the rest only where it is visible to everybody; of the numbers count,
 * state, recognition and "in another account too" — never a digit.
 */
function adminView(userId, adminId) {
  const u = needUser(userId);
  const vis = visibilityOf(u);
  const self = adminId === u.id;
  const field = (key, value) => {
    const shown = self || vis[key] === 'all';
    return { visibility: vis[key], hidden: !shown && value != null, value: shown ? value : null };
  };
  const tz = timezoneOf(u.id);
  const phonesOn = phonesEnabled();
  const rows = phoneRows(u.id);
  const shared = sharedHashes(u.id, rows.map((r) => r.number_hash));
  const list = rows.map((p) => ({ id: p.id, kind: p.kind, state: p.state, confirmed: CONFIRMED.has(p.state), useForRecognition: p.use_for_recognition === 1, duplicate: shared.has(p.number_hash) }));
  const emails = emailRows(u.id);
  return {
    userId: u.id,
    displayName: u.display_name || u.username,
    username: u.username,
    email: u.email || null,
    language: u.language || null,
    firstName: field('firstName', u.first_name || null),
    lastName: field('lastName', u.last_name || null),
    about: field('about', u.about || null),
    birthday: field('birthday', birthdayView(u, self)),
    timezone: field('timezone', tz.timezone),
    emails: { count: emails.length, confirmed: emails.filter((e) => e.state === 'confirmed').length, ...field('email', null) },
    phones: {
      enabled: phonesOn,
      count: list.length,
      confirmed: list.filter((p) => p.confirmed).length,
      recognition: u.recognize_by_phone === 1 && list.some((p) => p.useForRecognition),
      duplicate: list.some((p) => p.duplicate),
      list,
    },
    recognition: { byWhatsapp: u.recognize_by_whatsapp === 1, byPhone: u.recognize_by_phone === 1 },
    directory: directoryOf(u.id),
  };
}

/** An administrator confirms a number without seeing it ("Vom Admin bestätigt"). */
function adminConfirmPhone(userId, phoneId, ctx = {}) {
  needPhones();
  const u = needUser(userId);
  const row = phoneOf(u.id, phoneId);
  if (row.state !== 'admin') {
    getDb().prepare("UPDATE user_phones SET state = 'admin', confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(row.id);
    log('profile_phone_confirmed', `Telefonnummer vom Admin bestätigt (${KIND_LABEL[row.kind]})`, u.id, { ...ctx, source: 'admin' }, { phoneId: row.id, kind: row.kind });
    emitChanged(u.id, ['phones']);
  }
  return adminView(u.id, ctx.actorId);
}

/** An administrator removes a number without seeing it. */
function adminRemovePhone(userId, phoneId, ctx = {}) {
  removePhone(userId, phoneId, { ...ctx, source: 'admin' });
  return adminView(userId, ctx.actorId);
}

// ─── Plugins (gc.profile.get) ────────────────────────────────────

/**
 * viewFor(userId, viewerId, allowed) → { userId, firstName?, lastName?, about?, birthday?, phones? } or null — what a
 * plugin with permissions.profile = `allowed` gets about an enabled account for this viewer: only the allowed fields,
 * only what the viewer may see (self / family / all; no viewer: what everybody sees). Numbers only with "phones",
 * only those set to "Familie" or "Alle" and seen by the viewer — "Niemand" never, not even to the person herself.
 */
function viewFor(userId, viewerId, allowed) {
  const u = userRow(userId);
  if (!u || u.enabled !== 1) return null;
  const want = new Set((allowed || []).filter((f) => PLUGIN_FIELDS.includes(f)));
  const viewer = Number.isSafeInteger(viewerId) && viewerId > 0 ? viewerId : null;
  const rel = viewer === u.id ? 'self' : (viewer && sameFamily(viewer, u.id) ? 'family' : 'other');
  const sees = (level) => level === 'all' || (level === 'family' && rel !== 'other') || (level === 'self' && rel === 'self');
  const vis = visibilityOf(u);
  const out = { userId: u.id };
  if (want.has('firstName') && sees(vis.firstName)) out.firstName = u.first_name || null;
  if (want.has('lastName') && sees(vis.lastName)) out.lastName = u.last_name || null;
  if (want.has('about') && sees(vis.about)) out.about = u.about || null;
  if (want.has('birthday') && sees(vis.birthday)) out.birthday = birthdayView(u, false);
  if (want.has('phones')) {
    out.phones = !phonesEnabled() ? [] : phoneRows(u.id)
      .filter((p) => p.visibility === 'all' || (p.visibility === 'family' && rel !== 'other'))
      .map((p) => ({ kind: p.kind, number: decryptNumber(p.number_enc), confirmed: CONFIRMED.has(p.state) }))
      .filter((p) => p.number);
  }
  return out;
}

// ─── "Meine Daten" ───────────────────────────────────────────────

/** Running plugins with permissions.users that answer the hook myData — their part of the export (≤ 5 s, ≤ 256 KB each). */
async function pluginParts(userId) {
  let rows;
  try { rows = require('./plugins/registry').list(); } catch { return []; }
  const rt = require('./plugins/runtime');
  const wanted = rows.filter((p) => p.enabled && p.manifest && p.manifest.permissions && p.manifest.permissions.users === true)
    .filter((p) => { try { return rt.info(p.id).state === 'running'; } catch { return false; } });
  const parts = await Promise.all(wanted.map(async (p) => {
    try {
      const r = await rt.call(p.id, 'myData', { userId }, EXPORT_PLUGIN_MS);
      const data = r && Object.prototype.hasOwnProperty.call(r, 'data') ? r.data : null;
      if (data == null) return null;
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > EXPORT_PLUGIN_BYTES) return { plugin: p.id, name: p.manifest.name || p.id, data: null, truncated: true };
      return { plugin: p.id, name: p.manifest.name || p.id, data };
    } catch { return null; }
  }));
  return parts.filter(Boolean);
}

/**
 * exportFor(userId) → "Meine Daten herunterladen": the account with every profile field, the numbers in plain text
 * (only ever for the person herself), further addresses, consents, groups, devices — and what plugins add (hook
 * myData). No secrets: no password hash, no keys, no tokens, no codes.
 */
async function exportFor(userId, ctx = {}) {
  const u = needUser(userId);
  const db = getDb();
  const tz = timezoneOf(u.id);
  let groups = [];
  try { groups = require('./groups').groupsOfUser(u.id, { includeInherited: true }).map((g) => ({ name: g.name, path: g.path, kind: g.kind, role: g.role, direct: g.direct })); } catch { groups = []; }
  let devices = [];
  try {
    devices = db.prepare(`SELECT t.name, t.created_at, t.last_used_at, p.name AS peer_name, p.created_at AS peer_created_at
      FROM api_tokens t LEFT JOIN peers p ON p.id = t.peer_id WHERE t.user_id = ? ORDER BY t.id`).all(u.id)
      .map((d) => ({ name: d.peer_name || d.name, createdAt: d.peer_created_at || d.created_at, lastUsedAt: d.last_used_at || null }));
  } catch { devices = []; }
  let look = null;
  try { const f = require('./avatars').info(u.id); look = f ? { picture: !!f.avatarUrl, color: f.color } : null; } catch { look = null; }
  const out = {
    format: 'gatecontrol-my-data',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: {
      id: u.id, username: u.username, displayName: u.display_name || u.username, email: u.email || null, role: u.role,
      language: u.language || null, enabled: u.enabled === 1, createdAt: u.created_at, lastLoginAt: u.last_login_at || null,
      selfService: u.self_service_enabled === 1, directory: (directoryOf(u.id) || {}).name || null,
    },
    profile: {
      firstName: u.first_name || null, lastName: u.last_name || null, about: u.about || null,
      birthday: birthdayView(u, true), timezone: tz.timezone, visibility: visibilityOf(u), look,
    },
    phones: phoneRows(u.id).map((p) => ({ kind: p.kind, number: decryptNumber(p.number_enc), visibility: p.visibility, useForRecognition: p.use_for_recognition === 1,
      state: p.state, confirmedAt: p.confirmed_at || null, createdAt: p.created_at })),
    emails: emailRows(u.id).map((e) => ({ address: e.address, state: e.state, confirmedAt: e.confirmed_at || null, createdAt: e.created_at })),
    recognition: {
      byWhatsapp: u.recognize_by_whatsapp === 1, byWhatsappAnsweredAt: u.recognize_by_whatsapp_at || null,
      byPhone: u.recognize_by_phone === 1, byPhoneAnsweredAt: u.recognize_by_phone_at || null,
    },
    groups,
    devices,
    plugins: await pluginParts(u.id),
  };
  log('profile_exported', `Meine Daten von "${u.username}" heruntergeladen`, u.id, ctx);
  return out;
}

module.exports = {
  KINDS, PHONE_VISIBILITY, FIELD_VISIBILITY, PHONE_STATES, VIS_FIELDS, DEFAULT_VISIBILITY, PLUGIN_FIELDS,
  MAX_PHONES, MAX_EMAILS, ABOUT_MAX, NAME_MAX, ProfileError,
  phonesEnabled, confirmedOnly, getSettings, setSettings,
  normalizeNumber, ownView, update, addPhone, updatePhone, removePhone,
  addEmail, resendCode, confirmEmail, removeEmail,
  noteOwnNumbers, forgetOwnNumbers, matchContacts,
  adminView, adminConfirmPhone, adminRemovePhone,
  viewFor, exportFor, emitChanged, directoryOf, sameFamily,
  _hashNumber: hashNumber,
};
