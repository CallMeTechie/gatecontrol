'use strict';

// plugin.json — validation and normalisation (schema: docs/plugins.md).
// validate() never throws: it returns { ok, manifest, errors[] }; error
// strings are stable codes ("field: problem") the UI shows as they are.

const semver = require('./semver');
const netPolicy = require('./netPolicy');
const { ID_RE, LIMITS } = require('./constants');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const GROUP_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const ICON_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,600}$/;
const SETTING_TYPES = new Set(['text', 'number', 'boolean', 'select', 'secret']);
const NOTIFY_TOPIC_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// Push budget of a plugin per hour: permissions.notify true → 30, { perHour } → 1…1000 (until 1.218.0: 120).
const NOTIFY_PER_HOUR_DEFAULT = 30;
const NOTIFY_PER_HOUR_MAX = 1000;
// permissions.background.intervalSeconds: shortest interval of the background tick
const BACKGROUND_MIN_S = 5;

// `media` (docs/plugins.md "Media"): files a plugin's users upload through
// GateControl (gc.media, services/plugins/media.js).
// Since 1.193.0 up to 2 GB (before 100 MB): files of GateDrop-like plugins.
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;     // largest maxBytes / handOverMaxBytes a plugin may declare
const MEDIA_QUOTA_DEFAULT = 1024 * 1024 * 1024;     // quotaDefault when none is declared (1 GB)
const MEDIA_QUOTA_MIN = 1024 * 1024;
const MEDIA_QUOTA_MAX = 1024 * 1024 * 1024 * 1024;  // 1 TB
const MEDIA_TYPES_MAX = 32;
// media.areas (since 1.204.0, docs/plugins.md "Media areas"): files kept on
// storage targets — up to 100 GB each, a plugin quota up to 1 PB, and the
// type "*/*" (any type; those of MIME_DENY_RE are stored but only ever
// served as application/octet-stream downloads).
const MEDIA_MAX_BYTES_AREAS = 100 * 1024 * 1024 * 1024;
const MEDIA_QUOTA_MAX_AREAS = 1024 * 1024 * 1024 * 1024 * 1024;
const MIME_ANY_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9.+_-]{0,99}$/;
const MIME_RE = /^(?:image|audio|video|application|text)\/[a-z0-9][a-z0-9.+-]{0,99}$/;
// Since 1.193.0 a type may also be a whole family: "image/*", "video/*",
// "audio/*", "application/*" (never "text/*") — every concrete type of it
// except MIME_DENY_RE (checked per upload, typeAllowed()).
const MIME_WILDCARD_RE = /^(?:image|audio|video|application)\/\*$/;
// Never stored or served from GateControl's origin, whatever a plugin
// declares: types a browser would run as a document, style or script, and
// the body types the host's own parsers take (the upload is a raw body).
const MIME_DENY_RE = /^(?:text\/(?:html|xml|css|javascript|ecmascript|x-javascript)|application\/(?:xhtml\+xml|xml|javascript|x-javascript|ecmascript|json|x-www-form-urlencoded)|image\/svg\+xml)$|\+(?:xml|json)$/;
const QUOTA_RE = /^(\d{1,7})\s?(KB|MB|GB|TB)$/i;
const QUOTA_UNIT = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
// services.provides / permissions.services (docs/plugins.md "Services")
const SERVICE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SERVICE_REF_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z][a-z0-9_]{0,31})$/;
const SERVICES_MAX = 32;
// storage.maxMB (since 1.206.0): the database of a plugin may grow up to 4 GB
const DB_MAX_MB_MIN = 256;
const DB_MAX_MB_MAX = 4096;
// permissions.ai (docs/plugins.md "AI requests"): what the plugin may ask the AI provider for
const AI_CAPABILITIES = Object.freeze(['text', 'vision', 'audio', 'video']);
const AI_PURPOSE_MAX = 200;
// permissions.mail (since 1.216.0, docs/plugins.md "Mail"): open IMAP sessions of a plugin at the same time
const MAIL_CONNECTIONS_DEFAULT = 50;
const MAIL_CONNECTIONS_MAX = 200;
// services.provides.<name>.maxPerHour (since 1.216.0): the provider's own budget per calling plugin and hour
const SERVICE_PER_HOUR_MIN = 60;
const SERVICE_PER_HOUR_MAX = 3600;

/** "x" or { de, en } → { de, en } (both filled); null when invalid. */
function locText(v, max) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s && s.length <= max ? { de: s, en: s } : null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const de = typeof v.de === 'string' ? v.de.trim() : '';
  const en = typeof v.en === 'string' ? v.en.trim() : '';
  if ((!de && !en) || de.length > max || en.length > max) return null;
  return { de: de || en, en: en || de };
}

/** Pick the language of a { de, en } text. */
function loc(text, lang) {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return (lang === 'en' ? text.en : text.de) || text.en || text.de || '';
}

function rangeStr([a, b]) { return a === b ? String(a) : `${a}-${b}`; }

// The old addresses of the plugin area (/plugins/catalog …, forwarded to
// /settings/plugins/…, routes/plugins.js) — a plugin cannot be called like one of them.
const RESERVED_IDS = new Set(['catalog', 'updates', 'licenses', 'security', 'manage']);

const TARGET_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * permissions.network: an array (= internet hosts) or
 *   { internet: [...], homeTargets: [{ id, label, protocols, multiple }], localDiscovery: { udp: [ports] } }
 * protocols: "http", "tcp:<ports>", "udp:<ports>".
 */
function validateNetwork(n, err) {
  const out = { internet: [], homeTargets: [], localDiscovery: null, images: false };
  if (n == null) return out;
  const obj = Array.isArray(n) ? { internet: n } : n;
  if (!obj || typeof obj !== 'object') { err('permissions.network: invalid'); return null; }
  for (const k of Object.keys(obj)) if (!['internet', 'homeTargets', 'localDiscovery', 'images'].includes(k)) { err('permissions.network: unknown key ' + k); return null; }
  // images (since 1.216.0): pictures of any public host through the host (gc.http.fetchImage), e.g. those of mails
  if (obj.images != null) {
    if (typeof obj.images !== 'boolean') err('permissions.network.images: invalid');
    else out.images = obj.images;
  }
  try {
    const entries = netPolicy.parseList(obj.internet);
    if (entries.some((e) => e.type === 'cidr' && netPolicy.classify(e.net[0].toString()) !== 'public')) throw new Error('private');
    out.internet = (obj.internet || []).map((s) => String(s).trim());
  } catch { err('permissions.network.internet: invalid'); }
  if (obj.homeTargets != null) {
    if (!Array.isArray(obj.homeTargets) || obj.homeTargets.length > 16) err('permissions.network.homeTargets: invalid');
    else {
      for (const t of obj.homeTargets) {
        const label = locText(t && t.label, 60);
        if (!t || typeof t.id !== 'string' || !TARGET_ID_RE.test(t.id) || !label || !Array.isArray(t.protocols) || !t.protocols.length || t.protocols.length > 4) {
          err('permissions.network.homeTargets: invalid'); break;
        }
        if (out.homeTargets.some((x) => x.id === t.id)) { err('permissions.network.homeTargets: duplicate'); break; }
        const proto = { http: false, tcp: [], udp: [] };
        let bad = false;
        for (const pr of t.protocols) {
          const m = /^(http|tcp|udp)(?::([0-9,\- ]+))?$/.exec(String(pr));
          if (!m || (m[1] === 'http' && m[2]) || (m[1] !== 'http' && !m[2])) { bad = true; break; }
          if (m[1] === 'http') proto.http = true;
          else { try { proto[m[1]] = netPolicy.parsePorts(m[2]).map(rangeStr); } catch { bad = true; break; } }
        }
        if (bad) { err('permissions.network.homeTargets: invalid protocol'); break; }
        if (t.multiple != null && typeof t.multiple !== 'boolean') { err('permissions.network.homeTargets: invalid'); break; }
        out.homeTargets.push({ id: t.id, label, protocols: t.protocols.map(String), proto, multiple: !!t.multiple });
      }
    }
  }
  if (obj.localDiscovery != null) {
    try {
      const ld = obj.localDiscovery;
      if (!ld || typeof ld !== 'object' || Object.keys(ld).some((k) => k !== 'udp')) throw new Error('x');
      out.localDiscovery = { udp: netPolicy.parsePorts(ld.udp).map(rangeStr) };
    } catch { err('permissions.network.localDiscovery: invalid'); }
  }
  return out;
}

// GateControl portal tabs a plugin may add sections to (docs/plugins.md
// "Portal"): "home" = Zuhause, "car" = Fahrzeug.
const PORTAL_SECTION_TABS = new Set(['home', 'car']);

/** ui.portal.sections → [{ id, tab, title, order }] (null when invalid). */
function portalSections(raw, err) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 8) { err('ui.portal.sections: invalid'); return null; }
  const out = [];
  for (const s of raw) {
    const title = locText(s && s.title, 60);
    const order = s && s.order != null ? Number(s.order) : 100;
    if (!s || typeof s.id !== 'string' || !SLUG_RE.test(s.id) || s.id.length > 40 || !PORTAL_SECTION_TABS.has(s.tab) || !title
      || !Number.isInteger(order) || order < 0 || order > 1000) { err('ui.portal.sections: invalid'); return null; }
    if (out.some((x) => x.id === s.id)) { err('ui.portal.sections: duplicate'); return null; }
    out.push({ id: s.id, tab: s.tab, title, order });
  }
  return out;
}

// Since 1.188.0: sections on the viewer's own profile in the portal ("Meine
// Geräte", below picture and colour) — ui.portal.profileSections
// [{ id, title, order }], normalised to sections with tab 'profile'. A key of
// its own, so an older GateControl ignores it (the plugin still installs there).
const PROFILE_SECTIONS_MAX = 4;

/** ui.portal.profileSections → [{ id, tab: 'profile', title, order }] (null when invalid). */
function profileSections(raw, err) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > PROFILE_SECTIONS_MAX) { err('ui.portal.profileSections: invalid'); return null; }
  const out = [];
  for (const s of raw) {
    const title = locText(s && s.title, 60);
    const order = s && s.order != null ? Number(s.order) : 100;
    if (!s || typeof s.id !== 'string' || !SLUG_RE.test(s.id) || s.id.length > 40 || !title || s.tab !== undefined
      || !Number.isInteger(order) || order < 0 || order > 1000) { err('ui.portal.profileSections: invalid'); return null; }
    if (out.some((x) => x.id === s.id)) { err('ui.portal.profileSections: duplicate'); return null; }
    out.push({ id: s.id, tab: 'profile', title, order });
  }
  return out;
}

/** "10GB", "500 MB", or a number of bytes → bytes (null when invalid). */
function quotaBytes(v) {
  if (Number.isSafeInteger(v)) return v;
  const mm = typeof v === 'string' ? QUOTA_RE.exec(v.trim()) : null;
  return mm ? Number(mm[1]) * QUOTA_UNIT[mm[2].toUpperCase()] : null;
}

/**
 * Is `mime` (a base type, lower case) one of the declared `types` — listed
 * itself, or within a declared family ("image/*", since 1.193.0)? Never a
 * type of MIME_DENY_RE, whatever is declared.
 */
function typeAllowed(types, mime) {
  const m = String(mime || '');
  if (Array.isArray(types) && types.includes('*/*')) return MIME_ANY_RE.test(m);
  if (!MIME_RE.test(m) || MIME_DENY_RE.test(m) || !Array.isArray(types)) return false;
  return types.includes(m) || types.includes(m.split('/')[0] + '/*');
}

const MEDIA_KEYS = ['maxBytes', 'types', 'quotaDefault', 'uploads', 'resumable', 'handOverMaxBytes', 'areas', 'previews'];

/**
 * media → { maxBytes, types, quotaDefault, uploads, resumable, handOverMaxBytes } (null when invalid).
 * uploads (since 1.190.0, default true): false = the plugin's users cannot
 * upload (PUT …/media → 403 uploads_disabled), only gc.media.fetch adds files.
 * Since 1.193.0: maxBytes up to 2 GB; types may name families ("video/*");
 * resumable (default false): an upload may continue after an abort
 * (PUT …/media?uploadId=…&offset=… with Content-Range, media.js storePart);
 * handOverMaxBytes (default maxBytes): the largest file another plugin may
 * hand over to this one (gc.media.handOver) — e.g. a messenger keeping
 * 25 MB for its own uploads but taking 2 GB files from GateDrop.
 * Since 1.204.0: areas (default false) — the plugin keeps files in areas on
 * storage targets (mediaAreas.js); then maxBytes / handOverMaxBytes up to
 * 100 GB, quotaDefault up to 1 PB and the type "*" + "/*" (any type).
 * Since 1.208.0: previews (default false) — GateControl makes small pictures
 * of the files and takes those of the uploaders' devices (mediaPreviews.js).
 */
function validateMedia(v, err) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !MEDIA_KEYS.includes(k))) { err('media: invalid'); return null; }
  if (v.uploads !== undefined && typeof v.uploads !== 'boolean') { err('media.uploads: invalid'); return null; }
  if (v.resumable !== undefined && typeof v.resumable !== 'boolean') { err('media.resumable: invalid'); return null; }
  if (v.areas !== undefined && typeof v.areas !== 'boolean') { err('media.areas: invalid'); return null; }
  if (v.previews !== undefined && typeof v.previews !== 'boolean') { err('media.previews: invalid'); return null; }
  const areas = v.areas === true;
  const maxBytes = areas ? MEDIA_MAX_BYTES_AREAS : MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(v.maxBytes) || v.maxBytes < 1024 || v.maxBytes > maxBytes) { err('media.maxBytes: invalid'); return null; }
  const types = Array.isArray(v.types) ? [...new Set(v.types.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')))] : null;
  if (!types || !types.length || types.length > MEDIA_TYPES_MAX
    || !types.every((x) => (areas && x === '*/*') || MIME_WILDCARD_RE.test(x) || (MIME_RE.test(x) && !MIME_DENY_RE.test(x)))) { err('media.types: invalid'); return null; }
  const quota = v.quotaDefault == null ? MEDIA_QUOTA_DEFAULT : quotaBytes(v.quotaDefault);
  if (quota == null || quota < MEDIA_QUOTA_MIN || quota > (areas ? MEDIA_QUOTA_MAX_AREAS : MEDIA_QUOTA_MAX) || quota < v.maxBytes) { err('media.quotaDefault: invalid'); return null; }
  const handOver = v.handOverMaxBytes == null ? v.maxBytes : v.handOverMaxBytes;
  if (!Number.isSafeInteger(handOver) || handOver < 1024 || handOver > maxBytes || handOver > quota) { err('media.handOverMaxBytes: invalid'); return null; }
  return { maxBytes: v.maxBytes, types, quotaDefault: quota, uploads: v.uploads !== false, resumable: v.resumable === true, handOverMaxBytes: handOver, ...(areas ? { areas: true } : {}),
    ...(v.previews === true ? { previews: true } : {}) };
}

function isFile(p) {
  return typeof p === 'string' && p.length <= 200 && FILE_RE.test(p) && !p.split('/').some((s) => s === '..' || s === '.');
}

function validate(raw, opts = {}) {
  const errors = [];
  const err = (e) => { errors.push(e); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['plugin.json: not an object'] };

  const m = {};
  if (typeof raw.id !== 'string' || raw.id.length < 2 || raw.id.length > 64 || !ID_RE.test(raw.id)) err('id: invalid');
  else if (RESERVED_IDS.has(raw.id)) err('id: reserved');
  else m.id = raw.id;

  m.name = locText(raw.name, 60);
  if (!m.name) err('name: invalid');
  if (typeof raw.version !== 'string' || !semver.valid(raw.version)) err('version: invalid');
  else m.version = raw.version.trim();
  if (typeof raw.publisher !== 'string' || !raw.publisher.trim() || raw.publisher.length > 80) err('publisher: invalid');
  else m.publisher = raw.publisher.trim();
  m.description = raw.description == null ? { de: '', en: '' } : locText(raw.description, 600);
  if (!m.description) err('description: invalid');
  // replaces (since 1.185.0): ids of plugins this one takes over (a new id for the same plugin) —
  // only honoured for first-party (trusted) packages, see replace.js
  m.replaces = [];
  if (raw.replaces != null) {
    if (!Array.isArray(raw.replaces) || raw.replaces.length > 3
      || !raw.replaces.every((x) => typeof x === 'string' && x.length >= 2 && x.length <= 64 && ID_RE.test(x) && !RESERVED_IDS.has(x) && x !== raw.id)
      || new Set(raw.replaces).size !== raw.replaces.length) err('replaces: invalid');
    else m.replaces = raw.replaces.slice();
  }
  if (typeof raw.gatecontrol !== 'string' || !semver.validRange(raw.gatecontrol)) err('gatecontrol: invalid');
  else m.gatecontrol = raw.gatecontrol.trim();
  if (!isFile(raw.entry) || !/\.(c?js)$/.test(raw.entry)) err('entry: invalid');
  else m.entry = raw.entry;
  if (opts.files && m.entry && !opts.files.has(m.entry)) err('entry: missing');

  // permissions
  const p = raw.permissions == null ? {} : raw.permissions;
  if (!p || typeof p !== 'object' || Array.isArray(p)) err('permissions: invalid');
  const perms = { network: { internet: [], homeTargets: [], localDiscovery: null, images: false }, storage: false, portal: false, users: false, notify: false, notifyPerHour: null, app: false, kiosk: false, actions: false, actionsInteractive: false, background: null, events: false, services: [], notifySink: false, publicLinks: false, devices: false, groups: null, ai: null, cloudImport: null, publicEndpoints: null, mail: null };
  if (p && typeof p === 'object') {
    if (p.lan != null) err('permissions.lan: replaced by permissions.network.homeTargets / localDiscovery');
    const net = validateNetwork(p.network, err);
    if (net) perms.network = net;
    // kiosk: may mark users as kiosk devices (gc.kiosk.*, docs/feature-kiosk-devices.md)
    // actions: may list/run other plugins' quick actions for a user (gc.actions.*)
    // events: may send realtime events to devices and frames (gc.events.emit)
    // notifySink: delivers notifications people route into chats (hooks
    // deliverNotice / mayRouteToFamily, docs/plugins.md "Notifications in chats")
    // publicLinks (since 1.193.0): download links without sign-in (gc.publicLinks,
    // only while an administrator allows them — publicLinks.js)
    // devices (since 1.193.0): a person's app installations (gc.devices.list,
    // gc.notify devices / silent, user.device on app requests)
    for (const k of ['storage', 'portal', 'users', 'app', 'kiosk', 'events', 'notifySink', 'publicLinks', 'devices']) {
      if (p[k] == null) continue;
      if (typeof p[k] !== 'boolean') err(`permissions.${k}: invalid`);
      else perms[k] = p[k];
    }
    // actions: true, or { interactive: boolean } — interactive: may also run
    // them as a person's tap in this plugin's UI (gc.actions.run interactive: true)
    if (p.actions != null) {
      const a = p.actions;
      if (typeof a === 'boolean') perms.actions = a;
      else if (a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === 1 && typeof a.interactive === 'boolean') {
        perms.actions = true;
        perms.actionsInteractive = a.interactive;
      } else err('permissions.actions: invalid');
    }
    // notify: true (NOTIFY_PER_HOUR_DEFAULT pushes per hour) or { perHour: 1…NOTIFY_PER_HOUR_MAX }
    if (p.notify != null) {
      const n = p.notify;
      if (typeof n === 'boolean') {
        perms.notify = n;
        perms.notifyPerHour = n ? NOTIFY_PER_HOUR_DEFAULT : null;
      } else if (n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length === 1
        && Number.isInteger(n.perHour) && n.perHour >= 1 && n.perHour <= NOTIFY_PER_HOUR_MAX) {
        perms.notify = true;
        perms.notifyPerHour = n.perHour;
      } else err('permissions.notify: invalid');
    }
    // groups: "read" (gc.groups.list/get/members/isMember/leadersOf, hooks groupsChanged /
    // groupUsage / groupDeleting, gc.notify groups, GC.pickPrincipals) or "manage" (also
    // gc.groups.ensure/remove of its own groups, source plugin:<id>) — docs/plugins.md "Groups"
    if (p.groups != null) {
      if (p.groups === 'read' || p.groups === 'manage') perms.groups = p.groups;
      else err('permissions.groups: invalid');
    }
    // services: ["<plugin>:<service>"] — services of other plugins it may call (gc.services.call)
    if (p.services != null) {
      const list = p.services;
      if (!Array.isArray(list) || list.length > SERVICES_MAX || !list.every((x) => typeof x === 'string' && SERVICE_REF_RE.test(x))) err('permissions.services: invalid');
      else if (m.id && list.some((x) => SERVICE_REF_RE.exec(x)[1] === m.id)) err('permissions.services: own service');
      else perms.services = [...new Set(list)];
    }
    // ai (since 1.214.0): { purpose: {de, en}, capabilities: ['text', 'vision', 'audio', 'video'] } — requests to the
    // AI provider set up in GateControl (gc.ai, services/ai/); the administrator agrees in the install dialog
    if (p.ai != null) {
      const a = p.ai;
      const purpose = a && typeof a === 'object' && !Array.isArray(a) ? locText(a.purpose, AI_PURPOSE_MAX) : null;
      const caps = a && Array.isArray(a.capabilities) ? a.capabilities : null;
      if (!purpose || !caps || !caps.length || caps.length > AI_CAPABILITIES.length || !caps.every((c) => AI_CAPABILITIES.includes(c))
        || new Set(caps).size !== caps.length || Object.keys(a).some((k) => k !== 'purpose' && k !== 'capabilities')) err('permissions.ai: invalid');
      else if (!caps.includes('text')) err('permissions.ai.capabilities: needs "text"');
      else perms.ai = { purpose, capabilities: AI_CAPABILITIES.filter((c) => caps.includes(c)) };
    }
    // publicEndpoints (since 1.211.0): requests without a session under /plugin-public/<id>/…, each with a token
    // the plugin minted (gc.publicEndpoints.token) — e.g. a WOPI host for an office server. true, or
    // { maxBodyBytes } — request bodies up to that size become an unclaimed media file (needs `media`,
    // checked below); without it a body is refused (publicEndpoints.js)
    if (p.publicEndpoints != null && p.publicEndpoints !== false) {
      const pe = p.publicEndpoints;
      if (pe === true) perms.publicEndpoints = { maxBodyBytes: 0 };
      else if (pe && typeof pe === 'object' && !Array.isArray(pe) && Object.keys(pe).every((k) => k === 'maxBodyBytes')
        && (pe.maxBodyBytes == null || (Number.isSafeInteger(pe.maxBodyBytes) && pe.maxBodyBytes >= 0 && pe.maxBodyBytes <= MEDIA_MAX_BYTES_AREAS))) {
        perms.publicEndpoints = { maxBodyBytes: pe.maxBodyBytes || 0 };
      } else err('permissions.publicEndpoints: invalid');
    }
    // background: { intervalSeconds: 5…86400 } — one tick at a time (runtime.js)
    if (p.background != null) {
      const iv = p.background && Number(p.background.intervalSeconds);
      if (!Number.isInteger(iv) || iv < BACKGROUND_MIN_S || iv > 86400) err('permissions.background.intervalSeconds: invalid');
      else perms.background = { intervalSeconds: iv };
    }
    // cloudImport: { purpose: { de, en } } — Google Drive / OneDrive of a person (gc.cloud, docs/plugins.md
    // "Cloud import"); the purpose is shown when the administrator installs the plugin
    if (p.cloudImport != null) {
      const c = p.cloudImport;
      const purpose = c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).every((k) => k === 'purpose') ? locText(c.purpose, 200) : null;
      if (!purpose) err('permissions.cloudImport: invalid (needs a purpose)');
      else perms.cloudImport = { purpose };
    }
    // mail (since 1.216.0): { purpose: { de, en }, maxConnections: 1…200 (default 50) } — IMAP and SMTP to the
    // mail servers people enter (gc.mail, docs/plugins.md "Mail"), encrypted only, public addresses only.
    // dav (since 1.219.0, optional): { purpose: { de, en } } — CalDAV/CardDAV to those servers (gc.mail.dav)
    if (p.mail != null) {
      const ml = p.mail;
      const ok = ml && typeof ml === 'object' && !Array.isArray(ml) && Object.keys(ml).every((k) => k === 'purpose' || k === 'maxConnections' || k === 'dav');
      const purpose = ok ? locText(ml.purpose, 200) : null;
      const max = ok && ml.maxConnections != null ? ml.maxConnections : MAIL_CONNECTIONS_DEFAULT;
      const d = ok ? ml.dav : null;
      const davPurpose = d != null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).every((k) => k === 'purpose') ? locText(d.purpose, 200) : null;
      if (!ok) err('permissions.mail: invalid');
      else if (!purpose) err('permissions.mail: invalid (needs a purpose)');
      else if (!Number.isInteger(max) || max < 1 || max > MAIL_CONNECTIONS_MAX) err('permissions.mail.maxConnections: invalid');
      else if (d != null && !davPurpose) err('permissions.mail.dav: invalid (needs a purpose)');
      else perms.mail = { purpose, maxConnections: max, ...(davPurpose ? { dav: { purpose: davPurpose } } : {}) };
    }
  }
  m.permissions = perms;

  // notifyTopics (notification center): own push topics, plugin:<id>:<topic>
  if (raw.notifyTopics != null) {
    const list = raw.notifyTopics;
    const topics = [];
    if (!Array.isArray(list) || list.length > 20) err('notifyTopics: invalid');
    else if (!perms.notify) err('notifyTopics: needs permissions.notify');
    else {
      for (const t of list) {
        const label = locText(t && t.label, 60);
        if (!t || typeof t.id !== 'string' || !NOTIFY_TOPIC_RE.test(t.id) || !label || (t.default != null && typeof t.default !== 'boolean')
          || (t.allowCritical != null && typeof t.allowCritical !== 'boolean') || (t.chat != null && typeof t.chat !== 'boolean')) {
          err('notifyTopics: invalid'); break;
        }
        if (topics.some((x) => x.id === t.id)) { err('notifyTopics: duplicate'); break; }
        // a chat topic is for messages between people: never critical, never the 'default' topic
        if (t.chat === true && (t.allowCritical === true || t.id === 'default')) { err('notifyTopics: chat topic cannot be critical or default'); break; }
        // allowCritical: priority 'critical' is kept for this topic (bypasses quiet hours like core critical events)
        // chat: chat notifications (conversation, sender, reply / mark_read — docs/plugins.md "Chat notifications")
        topics.push({ id: t.id, label, default: t.default !== false, ...(t.allowCritical === true ? { allowCritical: true } : {}), ...(t.chat === true ? { chat: true } : {}) });
      }
      m.notifyTopics = topics;
    }
  }

  // ui
  const u = raw.ui == null ? {} : raw.ui;
  const ui = { nav: null, pages: [], settings: [], settingsGroups: [], settingsPage: null, portal: null, app: null, maps: false, geolocation: false, camera: false, scanQr: false, inbox: false };
  if (!u || typeof u !== 'object' || Array.isArray(u)) err('ui: invalid');
  else {
    if (u.nav != null) {
      const label = locText(u.nav && u.nav.label, 40);
      const icon = u.nav && u.nav.icon != null ? String(u.nav.icon) : 'M4 4h16v16H4z';
      if (!label || !ICON_RE.test(icon)) err('ui.nav: invalid');
      else ui.nav = { label, icon };
    }
    if (u.pages != null) {
      if (!Array.isArray(u.pages) || u.pages.length > 10) err('ui.pages: invalid');
      else {
        for (const pg of u.pages) {
          const title = locText(pg && pg.title, 60);
          if (!pg || typeof pg.id !== 'string' || !SLUG_RE.test(pg.id) || pg.id.length > 40 || !title) { err('ui.pages: invalid'); break; }
          if (ui.pages.some((x) => x.id === pg.id) || pg.id === 'frame') { err('ui.pages: duplicate'); break; }
          ui.pages.push({ id: pg.id, title });
        }
      }
    }
    if (ui.nav && !ui.pages.length) err('ui.nav: needs ui.pages');
    // ui.settingsPage (since 1.188.0): one of the pages (never the first: the navigation opens
    // that one) shown inside the plugin's settings tab instead of as a page tab of its own
    if (u.settingsPage != null) {
      const i = typeof u.settingsPage === 'string' ? ui.pages.findIndex((x) => x.id === u.settingsPage) : -1;
      if (i < 1) err('ui.settingsPage: invalid');
      else ui.settingsPage = u.settingsPage;
    }
    // ui.settingsGroups (since 1.185.0): headings of the settings form, in this order
    if (u.settingsGroups != null) {
      if (!Array.isArray(u.settingsGroups) || u.settingsGroups.length > 10) err('ui.settingsGroups: invalid');
      else {
        for (const g of u.settingsGroups) {
          const label = locText(g && g.label, 60);
          if (!g || typeof g.id !== 'string' || !GROUP_RE.test(g.id) || !label) { err('ui.settingsGroups: invalid'); break; }
          if (ui.settingsGroups.some((x) => x.id === g.id)) { err('ui.settingsGroups: duplicate'); break; }
          ui.settingsGroups.push({ id: g.id, label, help: g.help == null ? null : locText(g.help, 300) });
        }
      }
    }
    if (u.settings != null) {
      if (!Array.isArray(u.settings) || u.settings.length > 50) err('ui.settings: invalid');
      else {
        for (const s of u.settings) {
          const label = locText(s && s.label, 80);
          if (!s || typeof s.key !== 'string' || !KEY_RE.test(s.key) || !SETTING_TYPES.has(s.type) || !label) { err('ui.settings: invalid'); break; }
          if (ui.settings.some((x) => x.key === s.key)) { err('ui.settings: duplicate'); break; }
          const def = { key: s.key, type: s.type, label, help: s.help == null ? null : locText(s.help, 300) };
          if (s.group != null) {
            if (!ui.settingsGroups.some((g) => g.id === s.group)) { err('ui.settings: unknown group'); break; }
            def.group = s.group;
          }
          if (s.type === 'select') {
            if (!Array.isArray(s.options) || !s.options.length || s.options.length > 50) { err('ui.settings: invalid'); break; }
            def.options = [];
            for (const o of s.options) {
              const ol = locText(o && o.label, 80);
              if (!o || typeof o.value !== 'string' || o.value.length > 100 || !ol) { def.options = null; break; }
              def.options.push({ value: o.value, label: ol });
            }
            if (!def.options) { err('ui.settings: invalid'); break; }
          }
          if (s.type === 'number') {
            def.min = Number.isFinite(s.min) ? s.min : null;
            def.max = Number.isFinite(s.max) ? s.max : null;
          }
          if (s.default !== undefined && s.type !== 'secret') {
            const okDefault = (s.type === 'boolean' && typeof s.default === 'boolean')
              || (s.type === 'number' && Number.isFinite(s.default))
              || ((s.type === 'text' || s.type === 'select') && typeof s.default === 'string' && s.default.length <= 1000);
            if (!okDefault) { err('ui.settings: invalid'); break; }
            def.default = s.default;
          }
          ui.settings.push(def);
        }
      }
    }
    if (u.portal != null) {
      // own tab (label, icon) and/or sections in GateControl's portal tabs
      const po = u.portal && typeof u.portal === 'object' && !Array.isArray(u.portal) ? u.portal : null;
      const label = po && po.label != null ? locText(po.label, 40) : null;
      const icon = po && po.icon != null ? String(po.icon) : 'M4 4h16v16H4z';
      const own = po ? portalSections(po.sections, err) : null;
      const profile = po ? profileSections(po.profileSections, err) : null;
      if (own && profile && profile.some((p) => own.some((x) => x.id === p.id))) { err('ui.portal.profileSections: duplicate'); }
      const sections = own && profile ? own.concat(profile) : null;
      if (!po || (po.label != null && !label) || !ICON_RE.test(icon) || !sections || (!label && !sections.length)) err('ui.portal: invalid');
      else if (!perms.portal) err('ui.portal: needs permissions.portal');
      else ui.portal = { label: label || null, icon, sections };
    }
    if (u.app != null) {
      // own tab in the GateControl apps: { label, icon } (icon like ui.nav.icon)
      const ap = u.app && typeof u.app === 'object' && !Array.isArray(u.app) ? u.app : null;
      const label = ap ? locText(ap.label, 40) : null;
      const icon = ap && ap.icon != null ? ap.icon : 'M4 4h16v16H4z';
      if (!ap || Object.keys(ap).some((k) => k !== 'label' && k !== 'icon') || !label || typeof icon !== 'string' || !ICON_RE.test(icon)) err('ui.app: invalid');
      else if (!perms.app) err('ui.app: needs permissions.app');
      else ui.app = { label, icon };
    }
    if (u.maps != null) {
      // OpenStreetMap tiles + the host's Leaflet in the plugin's frames (frame.js)
      if (typeof u.maps !== 'boolean') err('ui.maps: invalid');
      else ui.maps = u.maps;
    }
    if (u.geolocation != null) {
      // the browser's location in the plugin's frames: <iframe allow="geolocation *"> (frame.js);
      // the browser still asks the person, the frame gets nothing else
      if (typeof u.geolocation !== 'boolean') err('ui.geolocation: invalid');
      else ui.geolocation = u.geolocation;
    }
    if (u.camera != null) {
      // since 1.188.0: the camera in the plugin's frames (e.g. scanning a QR code):
      // <iframe allow="camera *"> (frame.js); the browser still asks the person.
      // Chromium refuses getUserMedia in the sandboxed (opaque-origin) frame whatever
      // the allow attribute says, so since 1.196.0 the flag also grants GC.scanQr
      // (below) — kept for plugins that declared it, new ones declare ui.scanQr.
      if (typeof u.camera !== 'boolean') err('ui.camera: invalid');
      else ui.camera = u.camera;
    }
    if (u.scanQr != null) {
      // since 1.196.0: window.GC.scanQr() — GateControl's own page opens the camera,
      // reads a QR code and hands the plugin only the text (frame.js, plugin-bridge.js,
      // qr-scan.js); the plugin never sees a picture, its frame gets no camera
      if (typeof u.scanQr !== 'boolean') err('ui.scanQr: invalid');
      else ui.scanQr = u.scanQr;
    }
    if (u.inbox != null) {
      // the viewer's own notification inbox in the portal frames: unread count and the newest
      // title (window.GC.inbox, frame.js / plugin-bridge.js) — only together with a portal UI
      if (typeof u.inbox !== 'boolean') err('ui.inbox: invalid');
      else if (u.inbox && !ui.portal) err('ui.inbox: needs ui.portal');
      else ui.inbox = u.inbox;
    }
  }
  m.ui = ui;

  // storage (since 1.206.0): { maxMB } — the largest size of the plugin's database (256 … 4096 MB,
  // default 256), only with permissions.storage; for plugins that keep many records (GateControl Drive)
  m.storage = { maxBytes: LIMITS.dbMaxBytes };
  if (raw.storage != null) {
    const st = raw.storage;
    if (!st || typeof st !== 'object' || Array.isArray(st) || Object.keys(st).some((k) => k !== 'maxMB')
      || !Number.isSafeInteger(st.maxMB) || st.maxMB < DB_MAX_MB_MIN || st.maxMB > DB_MAX_MB_MAX) err('storage: invalid');
    else if (!m.permissions || !m.permissions.storage) err('storage: needs permissions.storage');
    else m.storage = { maxBytes: st.maxMB * 1024 * 1024 };
  }

  // media: { maxBytes, types, quotaDefault, uploads, resumable, handOverMaxBytes } — files through GateControl (gc.media)
  m.media = raw.media == null ? null : validateMedia(raw.media, err);
  // a body of a public endpoint is stored as media: within the plugin's own maxBytes
  const pe = m.permissions && m.permissions.publicEndpoints;
  if (pe && pe.maxBodyBytes > 0 && (!m.media || pe.maxBodyBytes > m.media.maxBytes)) err('permissions.publicEndpoints.maxBodyBytes: needs media');

  // services: { provides: { <name>: { label, maxPerHour? } } } — offered to other plugins (gc.services.call);
  // maxPerHour (since 1.216.0, 60…3600): calls per calling plugin and hour of this service instead of the shared 60
  m.services = { provides: {} };
  if (raw.services != null) {
    const sv = raw.services;
    const prov = sv && typeof sv === 'object' && !Array.isArray(sv) && Object.keys(sv).every((k) => k === 'provides') ? sv.provides : null;
    if (!prov || typeof prov !== 'object' || Array.isArray(prov) || Object.keys(prov).length > SERVICES_MAX) err('services: invalid');
    else {
      const out = new Map();
      for (const [name, def] of Object.entries(prov)) {
        const label = locText(def && def.label, 60);
        if (!SERVICE_NAME_RE.test(name) || !label || Object.keys(def).some((k) => k !== 'label' && k !== 'maxPerHour')) { err('services.provides: invalid'); break; }
        if (def.maxPerHour != null && (!Number.isInteger(def.maxPerHour) || def.maxPerHour < SERVICE_PER_HOUR_MIN || def.maxPerHour > SERVICE_PER_HOUR_MAX)) {
          err('services.provides.maxPerHour: invalid'); break;
        }
        out.set(name, def.maxPerHour != null ? { label, maxPerHour: def.maxPerHour } : { label });
      }
      m.services = { provides: Object.fromEntries(out) };
    }
  }

  // license
  const l = raw.license == null ? { required: false } : raw.license;
  if (!l || typeof l !== 'object' || typeof (l.required ?? false) !== 'boolean') err('license: invalid');
  else {
    m.license = { required: !!l.required, server: null };
    if (l.server != null) {
      let ok = false;
      try { const su = new URL(String(l.server)); ok = su.protocol === 'https:' && !su.username && !su.password && String(l.server).length <= 300; } catch { ok = false; }
      if (!ok) err('license.server: must be an https URL');
      else m.license.server = String(l.server);
    }
  }

  // migrations
  if (raw.migrations != null && !isFile(raw.migrations)) err('migrations: invalid');
  else m.migrations = raw.migrations || 'migrations';

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m, errors: [] };
}

/**
 * Migration files of a package: <migrations>/<number>_<name>.sql, ordered.
 * @param {Map<string,Buffer>} files
 */
function migrationsOf(manifest, files) {
  const dir = manifest.migrations.replace(/\/+$/, '') + '/';
  const out = [];
  for (const [p, buf] of files) {
    if (!p.startsWith(dir)) continue;
    const name = p.slice(dir.length);
    const mm = /^(\d{1,6})_([A-Za-z0-9_-]{1,80})\.sql$/.exec(name);
    if (!mm) continue;
    out.push({ version: Number(mm[1]), name: mm[2], file: p, sql: buf.toString('utf8') });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) if (out[i].version === out[i - 1].version) throw new Error('duplicate migration version ' + out[i].version);
  return out;
}

module.exports = {
  validate, loc, locText, migrationsOf, isFile, quotaBytes, PORTAL_SECTION_TABS, NOTIFY_PER_HOUR_DEFAULT, NOTIFY_PER_HOUR_MAX, BACKGROUND_MIN_S,
  DB_MAX_MB_MIN, DB_MAX_MB_MAX, AI_CAPABILITIES, MAIL_CONNECTIONS_DEFAULT, MAIL_CONNECTIONS_MAX, SERVICE_PER_HOUR_MIN, SERVICE_PER_HOUR_MAX, MEDIA_MAX_BYTES, MEDIA_MAX_BYTES_AREAS, MEDIA_QUOTA_DEFAULT, MEDIA_QUOTA_MIN, MEDIA_QUOTA_MAX, MEDIA_QUOTA_MAX_AREAS, MIME_DENY_RE, SERVICE_REF_RE, SERVICE_NAME_RE, typeAllowed,
};
