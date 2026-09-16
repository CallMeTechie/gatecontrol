'use strict';

// Operations UI kit (docs/feature-release-b.md §6, §7, §13b): pure helpers for
// the off-site backup card and the maintenance window (settings.js), the
// "What's new" card and the auto-update status (dashboard.js). Loaded before
// those scripts on settings.njk and dashboard.njk. UMD like secopt-ui.js: the
// helpers are testable in node:test (tests/ops_ui.test.js); DOM is only built
// through el() / textContent — never innerHTML. Strings come from window.GC.t
// (layout.njk whitelist) with English fallbacks.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(null);
  else root.GCOpsUI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {

  // ─── Text helpers ────────────────────────────────────────────────────────
  function str(v) { return v == null ? '' : String(v); }
  /** "{name} kept" + {name:'x'} → "x kept" (single braces, like autoupdate.*). */
  function fmt(template, params) {
    let s = str(template);
    if (params) Object.keys(params).forEach((k) => { s = s.split('{' + k + '}').join(str(params[k])); });
    return s;
  }
  function tr(key, fallback, params) {
    const dict = (win && win.GC && win.GC.t) || {};
    return fmt(dict[key] != null && dict[key] !== '' ? dict[key] : fallback, params);
  }

  // ─── Passphrase (§7: ≥ 12 characters, write-only) ────────────────────────
  const MIN_PASSPHRASE = 12;
  const MAX_PASSPHRASE = 1024;
  /**
   * Rough strength for the hint under the passphrase field. Only "short" blocks
   * saving (the server's rule); the rest is advice.
   * @returns {{level:'empty'|'short'|'weak'|'ok'|'strong', missing:number, score:number}}
   */
  function passphraseStrength(p) {
    const s = str(p);
    const len = Array.from(s).length;
    if (len === 0) return { level: 'empty', missing: MIN_PASSPHRASE, score: 0 };
    if (len < MIN_PASSPHRASE) return { level: 'short', missing: MIN_PASSPHRASE - len, score: 1 };
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
    const unique = new Set(Array.from(s.toLowerCase())).size;
    if (unique < 6) return { level: 'weak', missing: 0, score: 2 };
    if (len >= 20 || (len >= 16 && classes >= 3)) return { level: 'strong', missing: 0, score: 4 };
    if (len >= 14 || classes >= 3) return { level: 'ok', missing: 0, score: 3 };
    return { level: 'weak', missing: 0, score: 2 };
  }

  // ─── Gateway backend TLS fingerprint (§13b; same rule as routesValidation) ─
  /** '' → '' (clear), valid → 64 lower-case hex, anything else → null. */
  function normalizeFingerprint(value) {
    let s = str(value).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^sha-?256\s*[:=]\s*/, '');
    const hex = s.replace(/[:\s-]/g, '');
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  }
  function formatFingerprint(hex) {
    const h = str(hex).toUpperCase();
    return /^[0-9A-F]{64}$/.test(h) ? h.match(/../g).join(':') : str(hex);
  }

  // ─── Maintenance window (§6) ─────────────────────────────────────────────
  const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DEFAULT_TZ = 'Europe/Berlin';
  const FALLBACK_TZS = ['UTC', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Paris',
    'Europe/Amsterdam', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Helsinki', 'America/New_York',
    'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney'];
  function isHHMM(v) { return HHMM_RE.test(str(v)); }
  function overMidnight(start, end) { return isHHMM(start) && isHHMM(end) && end < start; }
  /** Client-side mirror of autoUpdate.validateWindow + the start ≠ end rule. */
  function windowProblem(w) {
    if (!w || !w.enabled) return null;
    if (!isHHMM(w.start) || !isHHMM(w.end)) return 'format';
    if (w.start === w.end) return 'same';
    return null;
  }
  /** All IANA zones the browser knows (+ UTC and `keep`), sorted; fallback list without Intl support. */
  function timeZones(intl, keep) {
    let list = [];
    try { if (intl && typeof intl.supportedValuesOf === 'function') list = intl.supportedValuesOf('timeZone').slice(); } catch (_) { list = []; }
    if (!list.length) list = FALLBACK_TZS.slice();
    if (list.indexOf('UTC') < 0) list.push('UTC');
    if (keep && list.indexOf(keep) < 0) list.push(keep);
    return list.sort();
  }
  function browserTimeZone(intl) {
    try { return (intl || Intl).DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { return null; }
  }
  /** "HH:MM" wall-clock time in `tz` (null when the zone is unknown). */
  function timeIn(tz, date) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date || new Date());
      const hh = String(Number(parts.find((p) => p.type === 'hour').value) % 24).padStart(2, '0');
      return hh + ':' + parts.find((p) => p.type === 'minute').value;
    } catch (_) { return null; }
  }
  /** Same rule as autoUpdate.isInWindow / update.sh: [start, end), over midnight when end < start. */
  function inWindow(w, date) {
    if (!w || !isHHMM(w.start) || !isHHMM(w.end)) return null;
    const now = timeIn(w.tz, date);
    if (!now) return null;
    if (w.start === w.end) return true;
    return w.start < w.end ? (now >= w.start && now < w.end) : (now >= w.start || now < w.end);
  }

  // ─── API error codes → UI text keys ──────────────────────────────────────
  // The APIs answer in English with a machine code; the UI shows its own text.
  const ERROR_KEYS = {
    PASSPHRASE_TOO_SHORT: ['offsite.err.passphrase_short', 'The passphrase needs at least 12 characters.'],
    PASSPHRASE_NOT_SET: ['offsite.err.passphrase_not_set', 'Set the passphrase first.'],
    NO_LOCAL_BACKUP: ['offsite.err.no_local_backup', 'There is no local backup to upload yet.'],
    UPLOAD_FAILED: ['offsite.err.upload_failed', 'Upload failed.'],
    TRANSPORT_FAILED: ['offsite.err.transport_failed', 'Connection failed.'],
    INVALID_CONFIG: ['offsite.err.invalid_config', 'Please check the field “{field}”.'],
    INVALID_NAME: ['offsite.err.invalid_name', 'Name: 1–64 characters.'],
    INVALID_KEEP: ['offsite.err.invalid_keep', 'Keep: 1 to 365 archives.'],
    INVALID_TYPE: ['offsite.err.invalid_type', 'Unknown target type.'],
    TYPE_IMMUTABLE: ['offsite.err.type_immutable', 'The type of a target cannot change — create a new one.'],
    TOO_MANY_TARGETS: ['offsite.err.too_many', 'At most 10 targets.'],
    NOT_FOUND: ['offsite.err.not_found', 'This target no longer exists.'],
    NO_REMOTE_BACKUP: ['offsite.err.no_remote_backup', 'There is no GateControl archive on this target yet.'],
    CONFIG_UNREADABLE: ['offsite.err.config_unreadable', 'The stored credentials cannot be read — enter them again.'],
    SESSION_REQUIRED: ['offsite.err.admin', 'Only for signed-in administrators.'],
    ADMIN_REQUIRED: ['offsite.err.admin', 'Only for signed-in administrators.'],
    LICENSE: ['offsite.err.license', 'This needs the “Scheduled backups” licence.'],
    PASSPHRASE_REQUIRED: ['offsite.err.passphrase_required', 'The archive is encrypted — enter its passphrase.'],
    DECRYPT_FAILED: ['offsite.err.decrypt_failed', 'Wrong passphrase or damaged file.'],
    CORRUPT: ['offsite.err.corrupt', 'The file is damaged or not a GateControl backup.'],
    NOT_GCBK: ['offsite.err.corrupt', 'The file is damaged or not a GateControl backup.'],
    UNSUPPORTED: ['offsite.err.unsupported', 'This version cannot read that archive format.'],
    INVALID_WINDOW: ['autoupdate.err.invalid_window', 'Invalid maintenance window: times as HH:MM, start ≠ end, a valid time zone.'],
    INVALID_MODE: ['autoupdate.err.generic', 'Could not save.'],
    INVALID_NOTIFY_EMAIL: ['autoupdate.err.generic', 'Could not save.'],
  };
  const GENERIC = ['offsite.err.generic', 'That did not work.'];
  // Config field names (INVALID_CONFIG "host: required") → label keys.
  const FIELD_KEYS = {
    host: ['offsite.field.host', 'Host'], port: ['offsite.field.port', 'Port'], username: ['offsite.field.username', 'User'],
    path: ['offsite.field.path', 'Path'], share: ['offsite.field.share', 'Share'], password: ['offsite.field.password', 'Password'],
    domain: ['offsite.field.domain', 'Domain'], endpoint: ['offsite.field.endpoint', 'Endpoint'], region: ['offsite.field.region', 'Region'],
    bucket: ['offsite.field.bucket', 'Bucket'], prefix: ['offsite.field.prefix', 'Prefix'],
    access_key_id: ['offsite.field.access_key_id', 'Access key ID'], secret_access_key: ['offsite.field.secret_access_key', 'Secret access key'],
    url: ['offsite.field.url', 'URL'],
  };

  /** Normalised error code of an API answer / thrown api error ({feature} = licence gate). */
  function errorCode(body) {
    const b = body && body.data && !body.code && !body.feature ? body.data : body;
    if (!b) return null;
    if (b.feature) return 'LICENSE';
    return b.code ? String(b.code).toUpperCase() : null;
  }
  /** Field name of an INVALID_CONFIG answer ("bucket: invalid bucket name" → 'bucket'). */
  function configField(body) {
    const m = /^([a-z_]+):/.exec(str(body && (body.error || (body.data && body.data.error))));
    return m && FIELD_KEYS[m[1]] ? m[1] : null;
  }
  function errorKey(code) { return (ERROR_KEYS[code] || GENERIC)[0]; }
  /** UI text for an API error. `fallback` = [key, english] used for unknown codes. */
  function errorText(body, fallback) {
    const code = errorCode(body);
    const e = ERROR_KEYS[code] || fallback || GENERIC;
    const field = code === 'INVALID_CONFIG' ? configField(body) : null;
    const label = field ? tr(FIELD_KEYS[field][0], FIELD_KEYS[field][1]) : (code === 'INVALID_CONFIG' ? '—' : '');
    return tr(e[0], e[1], { field: label });
  }
  /** Technical remote detail worth showing (transport/upload errors). */
  function errorDetail(body) {
    const code = errorCode(body);
    const b = body && body.data && !body.code ? body.data : body;
    if (code !== 'TRANSPORT_FAILED' && code !== 'UPLOAD_FAILED') return '';
    return str(b && (b.detail || b.error)).slice(0, 500);
  }

  // ─── Off-site targets ────────────────────────────────────────────────────
  const TYPES = ['sftp', 'smb', 's3', 'webdav'];
  const TYPE_LABELS = { sftp: 'SFTP', smb: 'SMB', s3: 'S3', webdav: 'WebDAV' };
  const DEFAULT_PORTS = { sftp: 22, smb: 445 };
  /** One-line destination of a target ("nas.lan:22 · /backup", "bucket/prefix · s3.eu…"). */
  function targetSummary(t) {
    const c = (t && t.config) || {};
    switch (t && t.type) {
      case 'sftp':
      case 'smb': {
        const port = c.port && Number(c.port) !== DEFAULT_PORTS[t.type] ? ':' + c.port : '';
        const where = t.type === 'smb' ? '/' + str(c.share) + (c.path ? '/' + str(c.path).replace(/^\/+/, '') : '') : str(c.path);
        return [str(c.username) ? str(c.username) + '@' + str(c.host) + port : str(c.host) + port, where].filter(Boolean).join(' · ');
      }
      case 's3': {
        let host = 'AWS';
        try { if (c.endpoint) host = new URL(c.endpoint).host; } catch (_) { host = str(c.endpoint); }
        return [str(c.bucket) + (c.prefix ? '/' + str(c.prefix) : ''), host + (c.region ? ' (' + c.region + ')' : '')].join(' · ');
      }
      case 'webdav': {
        try { const u = new URL(c.url); return u.host + u.pathname; } catch (_) { return str(c.url); }
      }
      default: return '';
    }
  }
  /** Status chip of a target row: {cls, key, fallback}. */
  function targetStatus(t, running) {
    if (running) return { cls: 'tag-blue', key: 'offsite.status_running', fallback: 'Running …' };
    if (!t || !t.last_status) return { cls: 'tag-grey', key: 'offsite.never_run', fallback: 'Not run yet' };
    if (t.last_status === 'ok') return { cls: 'tag-green', key: 'offsite.status_ok', fallback: 'OK' };
    if (t.last_status === 'running') return { cls: 'tag-blue', key: 'offsite.status_running', fallback: 'Running …' };
    return { cls: 'tag-red', key: 'offsite.status_failed', fallback: 'Failed' };
  }
  // ─── Restore test (§S2.1) ────────────────────────────────────────────────
  // Warning codes of POST /targets/:id/verify → text keys. Unknown codes are
  // dropped (the server may learn new ones before the UI does).
  const VERIFY_WARNING_KEYS = {
    archive_old: ['offsite.verify_warn_archive_old', 'The newest archive is older than 48 hours.'],
    no_encryption_key: ['offsite.verify_warn_no_encryption_key', 'Without the archived key a restore on new hardware also needs the GC_ENCRYPTION_KEY.'],
    version_differs: ['offsite.verify_warn_version_differs', 'The archive comes from a different GateControl version.'],
    no_routes: ['offsite.verify_warn_no_routes', 'The archive contains no entries.'],
    no_users: ['offsite.verify_warn_no_users', 'The archive contains no users.'],
  };
  const VERIFY_WARNINGS = Object.keys(VERIFY_WARNING_KEYS);
  function verifyWarningText(code) {
    const e = VERIFY_WARNING_KEYS[str(code)];
    return e ? tr(e[0], e[1]) : null;
  }
  /** Lines of a successful restore test: [size, created, version, counts]. */
  function verifyLines(r, lang) {
    if (!r) return [];
    const c = r.counts || {};
    const out = [tr('offsite.verify_size', 'size {x}', { x: fmtBytes(r.size) })];
    if (r.created_at) out.push(tr('offsite.verify_created', 'as of {x}', { x: fmtDateTime(r.created_at, lang) }));
    if (r.gc_version) out.push(tr('offsite.verify_version', 'version {x}', { x: str(r.gc_version) }));
    out.push(tr('offsite.verify_counts', '{routes} entries · {peers} devices · {users} users · {settings} settings', {
      routes: Number(c.routes) || 0, peers: Number(c.peers) || 0, users: Number(c.users) || 0, settings: Number(c.settings) || 0,
    }));
    return out;
  }

  /** L4 candidates in picker order: suggested for `type` first, then internal, enabled, by port. */
  function sortCandidates(list, type) {
    const rank = (c) => (c.suggested_type === type ? 0 : c.suggested_type ? 2 : 1) * 4 + (c.internal ? 0 : 2) + (c.enabled ? 0 : 1);
    return (list || []).slice().sort((a, b) => rank(a) - rank(b) || a.listen_port - b.listen_port);
  }
  /** The body for POST/PUT /targets from form values (secrets only when typed). */
  function targetPayload(type, v, editing) {
    const cfg = {};
    const set = (k, val) => { if (val !== undefined) cfg[k] = val; };
    const s = (k) => str(v[k]).trim();
    if (type === 'sftp' || type === 'smb') { set('host', s('host')); set('port', s('port') || undefined); set('path', s('path')); set('username', s('username')); }
    if (type === 'smb') { set('share', s('share')); set('domain', s('domain')); }
    if (type === 's3') {
      set('endpoint', s('endpoint')); set('region', s('region') || 'us-east-1'); set('bucket', s('bucket'));
      set('prefix', s('prefix')); set('access_key_id', s('access_key_id')); set('path_style', !!v.path_style);
      if (str(v.secret_access_key) !== '') set('secret_access_key', str(v.secret_access_key));
    }
    if (type === 'webdav') { set('url', s('url')); set('username', s('username')); }
    if (type === 'smb' || type === 'webdav') {
      if (str(v.password) !== '') set('password', str(v.password));
      else if (v.clear_password) set('clear_password', true);
    }
    const body = { name: s('name'), keep: s('keep') === '' ? undefined : Number(s('keep')), enabled: !!v.enabled, config: cfg };
    if (!editing) body.type = type;
    return body;
  }

  // ─── Formatting ──────────────────────────────────────────────────────────
  function fmtBytes(n) {
    const v = Number(n);
    if (!isFinite(v) || v < 0) return '—';
    if (v < 1024) return v + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024; let i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (x < 10 ? x.toFixed(1) : Math.round(x)) + ' ' + u[i];
  }
  function fmtDateTime(iso, lang) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return str(iso);
    try { return d.toLocaleString(lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return d.toISOString(); }
  }
  function fmtDate(ymd, lang) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(ymd))) return str(ymd);
    try { return new Date(ymd + 'T00:00:00Z').toLocaleDateString(lang || undefined, { timeZone: 'UTC', dateStyle: 'medium' }); } catch (_) { return ymd; }
  }
  /** "vor 3 Stunden" / "3 hours ago" (Intl.RelativeTimeFormat), '' without a date. */
  function fmtAgo(iso, lang, now) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    const s = Math.round((d.getTime() - (now || Date.now())) / 1000);
    const abs = Math.abs(s);
    const [n, unit] = abs < 60 ? [s, 'second'] : abs < 3600 ? [Math.round(s / 60), 'minute'] : abs < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
    try { return new Intl.RelativeTimeFormat(lang || undefined, { numeric: 'auto' }).format(n, unit); } catch (_) { return fmtDateTime(iso, lang); }
  }

  // ─── DOM (browser, or any document-like object in tests) ────────────────
  function el(doc, tag, props, children) {
    const node = doc.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = str(v);
      else if (k === 'on') Object.keys(v).forEach((ev) => node.addEventListener(ev, v[ev]));
      else if (k === 'dataset') Object.keys(v).forEach((d) => { node.dataset[d] = v[d]; });
      else if (k === 'hidden' || k === 'disabled') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : str(v));
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });
    return node;
  }

  // What's new: inline tokens {t:'text'|'code'|'strong', v} → nodes. Unknown
  // token types render as plain text; nothing is ever parsed as HTML.
  function tokenNodes(doc, tokens) {
    return (Array.isArray(tokens) ? tokens : []).map((tok) => {
      const v = str(tok && tok.v);
      if (tok && tok.t === 'code') return el(doc, 'code', { class: 'op-wn-code', text: v });
      if (tok && tok.t === 'strong') return el(doc, 'strong', { text: v });
      return doc.createTextNode(v);
    });
  }
  /** Sections of GET /system/whats-new → one element per release. */
  function whatsNewNodes(doc, sections, lang) {
    return (Array.isArray(sections) ? sections : []).map((s) => {
      const head = el(doc, 'div', { class: 'op-wn-ver' }, [
        el(doc, 'span', { class: 'op-wn-vnum', text: 'v' + str(s.version) }),
        s.date ? el(doc, 'span', { class: 'op-wn-date', text: fmtDate(s.date, lang) }) : null,
      ]);
      const groups = (s.groups || []).map((g) => el(doc, 'div', { class: 'op-wn-group' }, [
        g.title ? el(doc, 'div', { class: 'op-wn-gtitle', text: str(g.title) }) : null,
        el(doc, 'ul', { class: 'op-wn-list' }, (g.items || []).map((item) => el(doc, 'li', null, tokenNodes(doc, item)))),
      ]));
      return el(doc, 'section', { class: 'op-wn-section', 'data-version': str(s.version) }, [head].concat(groups));
    });
  }

  /**
   * Confirm dialog in the zones dialog look (.modal-overlay.zn-dialog, pro.css)
   * → Promise<boolean>. o = {title, message, detail, okLabel, danger}.
   */
  function confirmDialog(doc, o) {
    return new Promise((resolve) => {
      const titleId = 'op-dlg-' + Math.random().toString(36).slice(2, 8);
      let overlay = null;
      const close = (v) => { doc.removeEventListener('keydown', onKey, true); if (overlay) overlay.remove(); resolve(v === true); };
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(false); } }
      const ok = el(doc, 'button', { type: 'button', class: 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary'), text: o.okLabel || tr('offsite.ok', 'OK'), on: { click: () => close(true) } });
      const box = el(doc, 'div', { class: 'modal zn-dialog-box op-dialog-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
        el(doc, 'div', { class: 'modal-head' }, [
          el(doc, 'span', { class: 'modal-title', id: titleId, text: o.title }),
          el(doc, 'button', { type: 'button', class: 'modal-close', 'aria-label': tr('common.close', 'Close'), text: '×', on: { click: () => close(false) } }),
        ]),
        el(doc, 'div', { class: 'modal-body zn-dialog-body' }, [
          el(doc, 'p', { class: 'zn-dialog-msg', text: o.message }),
          o.detail ? el(doc, 'p', { class: 'zn-dialog-detail', text: o.detail }) : null,
        ]),
        el(doc, 'div', { class: 'modal-foot' }, [
          el(doc, 'button', { type: 'button', class: 'btn btn-ghost', text: tr('offsite.cancel', 'Cancel'), on: { click: () => close(false) } }),
          ok,
        ]),
      ]);
      overlay = el(doc, 'div', { class: 'modal-overlay zn-dialog op-dialog', style: 'display:flex' }, [box]);
      doc.addEventListener('keydown', onKey, true);
      doc.body.appendChild(overlay);
      ok.focus();
    });
  }

  return {
    fmt, tr, MIN_PASSPHRASE, MAX_PASSPHRASE, passphraseStrength,
    normalizeFingerprint, formatFingerprint,
    DEFAULT_TZ, isHHMM, overMidnight, windowProblem, timeZones, browserTimeZone, timeIn, inWindow,
    ERROR_KEYS, FIELD_KEYS, errorCode, configField, errorKey, errorText, errorDetail,
    TYPES, TYPE_LABELS, DEFAULT_PORTS, targetSummary, targetStatus, sortCandidates, targetPayload,
    VERIFY_WARNINGS, verifyWarningText, verifyLines,
    fmtBytes, fmtDateTime, fmtDate, fmtAgo,
    el, tokenNodes, whatsNewNodes, confirmDialog,
  };
});
