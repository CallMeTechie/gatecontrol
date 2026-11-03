'use strict';

// Start page of the settings (/settings, public/js/settings.js section
// "start"): the tiles, "Braucht deine Aufmerksamkeit" and the current state
// of every section ("Alle Bereiche", the side navigation, the phone list).
//
//   build({ lang, now }) → { version, tiles, attention: [...], states: {...} }
//
// Nothing is measured or fetched here: every value is read from what
// GateControl already keeps (settings, the domains / backup target tables,
// the auto-update marker, the licence cache, the plugin registry, the TLS
// guard). WireGuard and Caddy are asked by the page itself through
// /api/v1/wg/status and /api/v1/caddy/status (those run commands) and join
// the list there.
//
// The answer carries no text: attention rows are { id, kind, tone, section,
// href, params } and states { key, params } — the page turns them into
// st.att.<kind>.* / st.state.* strings. Each source is read on its own; one
// that fails is left out instead of failing the page.

const settings = require('./settings');
const logger = require('../utils/logger');

const BACKUP_OK_STATUSES = ['ok', 'success', 'done', 'uploaded'];
const SCHEDULE_HOURS = { '6h': 6, '12h': 12, daily: 24, '3d': 72, weekly: 168 };
// Per kind: at most this many single rows, the rest is one summary row.
const MAX_ROWS = 3;

function tryRead(name, fn, fallback = null) {
  try { return fn(); } catch (err) {
    logger.debug({ err: err.message, source: name }, 'settings overview: source unavailable');
    return fallback;
  }
}

function db() { return require('../db/connection').getDb(); }

function tableExists(name) {
  return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function count(sql, ...args) {
  const row = db().prepare(sql).get(...args);
  return row ? Number(row.c) || 0 : 0;
}

function isoOf(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function version() {
  try { return require('../../package.json').version; } catch { return null; }
}

// ─── Sources ─────────────────────────────────────────────

function domainsInfo() {
  const list = require('./domains').list();
  return {
    total: list.length,
    verified: list.filter((d) => d.status === 'verified').length,
    pending: list.filter((d) => d.status !== 'verified' && d.status !== 'failed').map((d) => d.domain),
    failed: list.filter((d) => d.status === 'failed').map((d) => d.domain),
    ipWarning: settings.get('domains.server_ip_warning', '0') === '1',
  };
}

function tlsInfo() {
  const st = require('./tlsGuard').listStatus();
  const hosts = st.hosts || [];
  const issued = hosts.filter((h) => h.state === 'issued' && h.days_left != null);
  return {
    failed: hosts.filter((h) => h.state === 'failed' || h.state === 'paused').map((h) => h.host),
    nextDays: issued.length ? Math.min(...issued.map((h) => h.days_left)) : null,
    issued: issued.length,
  };
}

function backupInfo(licensed, now) {
  const autobackup = require('./autobackup');
  const auto = autobackup.getSettings();
  const files = tryRead('backup files', () => autobackup.listBackupFiles(), []);
  const newest = files[0] || null;
  let targets = [];
  if (tableExists('backup_targets')) {
    targets = db().prepare('SELECT id, name, enabled, last_status, last_run_at FROM backup_targets ORDER BY id').all();
  }
  const enabled = targets.filter((t) => t.enabled);
  const failing = enabled.filter((t) => String(t.last_status || '').toLowerCase() === 'failed');
  const lastAt = isoOf(auto.lastRun) || (newest ? newest.created : null);
  const reminderDays = parseInt(settings.get('alerts.backup_reminder_days', '0'), 10) || 0;
  const ageDays = lastAt ? (now - Date.parse(lastAt)) / 86400000 : null;
  // An automatic backup that missed two runs in a row counts as stale too.
  const overdue = auto.enabled && lastAt && (now - Date.parse(lastAt)) > 2 * (SCHEDULE_HOURS[auto.schedule] || 24) * 3600000;
  return {
    licensed,
    auto: { enabled: !!auto.enabled, schedule: auto.schedule },
    last: lastAt ? { at: lastAt, size: newest ? newest.size : null } : null,
    files: files.length,
    offsite: { enabled: enabled.length, failing: failing.map((t) => t.name) },
    reminderDays,
    stale: (reminderDays > 0 && (ageDays == null || ageDays > reminderDays)) || !!overdue,
  };
}

function updatesInfo() {
  const st = require('./autoUpdate').getStatus();
  const u = st.update_sh || {};
  return {
    mode: st.mode,
    status: st.status,
    lastAction: st.last_action || null,
    badVersion: st.bad_version || null,
    window: st.window && st.window.enabled ? { start: st.window.start, end: st.window.end } : null,
    updateShOutdated: u.image_version != null && !u.matches,
  };
}

function licenseInfo() {
  const lic = require('./license');
  const info = lic.getLicenseInfo();
  return {
    plan: lic.getPlan(),
    unlicensed: lic.isUnlicensedMode(),
    expiresAt: info.expires_at || null,
    checkFailed: info.verification === 'signed_offline' && !!info.lastCheck && !info.lastCheck.ok,
  };
}

function pluginsInfo(lang) {
  const plugins = require('./plugins');
  const list = plugins.list(lang);
  const problems = list.filter((p) => p.status === 'crashed' || p.status === 'blocked')
    .map((p) => ({ id: p.id, name: p.name, reason: p.status === 'crashed' ? 'crashed' : (p.reason || 'broken') }));
  let updates = 0;
  try { updates = require('./plugins/updates').cachedCount(); } catch { updates = 0; }
  return { installed: list.length, running: list.filter((p) => p.status === 'running').length, problems, updates };
}

function emailInfo() {
  const email = require('./email');
  const smtp = email.getSmtpSettings();
  let recipient = '';
  try { recipient = require('./notifications').recipient() || ''; } catch { recipient = ''; }
  return { configured: !!email.isSmtpConfigured(), host: smtp.host || '', recipient };
}

// Sicherheit: IP-Sperre (bans, lists that fail, matcher missing in Caddy)
function ipBlockInfo() {
  const ipBlock = require('./ipBlock');
  const cfg = ipBlock.getConfig();
  const st = ipBlock.stats();
  return {
    enabled: cfg.enabled,
    blocked: st.blocked,
    failingLists: st.lists.filter((l) => l.on && l.licensed && l.error).map((l) => l.id),
    engineMissing: cfg.enabled && process.env.NODE_ENV !== 'test' && !ipBlock.engineAvailable(),
  };
}

// Sicherheit: Routenschutz (routes open to the internet without a login)
function routeGuardInfo() {
  const ov = require('./routeGuard').overview();
  return { attention: ov.attention, total: ov.stats.total };
}

// Sicherheit: Virenscan (quarantine, scanner state; asked without network — the cached state)
function scanInfo() {
  const scan = require('./scan');
  const st = scan.stats();
  const cfg = scan.getConfig();
  const last = scan._state.lastSig ? scan._state.lastSig.info : null;
  return {
    engine: scan.engineOf(cfg), quarantined: st.quarantined, pending: st.pending,
    down: !!scan._state.down, updateAvailable: !!(last && last.updateAvailable), version: last ? last.version : null,
    latest: last && last.latest ? last.latest.engine : null, local: cfg.engine === 'clamav_local', signaturesOld: !!(last && last.signaturesOld),
  };
}

function aiInfo() {
  const v = require('./ai').view();
  const providers = v.providers || [];
  return { enabled: !!v.enabled, active: providers.filter((p) => p.configured && p.enabled).length };
}

// ─── States per section ──────────────────────────────────

function sectionStates(src) {
  const s = {};
  const st = (id, key, params) => { s[id] = { key: 'st.state.' + key, params: params || {} }; };
  const d = src.domains;
  if (d) {
    if (d.failed.length) st('domains', 'domains_failed', { n: d.failed.length });
    else if (d.pending.length) st('domains', 'domains_pending', { n: d.pending.length });
    else st('domains', 'domains', { n: d.total });
  }
  tryRead('netzwerk', () => st('netzwerk', 'port', { port: require('../../config/default').wireguard.port }));
  tryRead('daten', () => st('daten', 'days', { n: parseInt(settings.get('data.retention_traffic_days', '30'), 10) }));
  tryRead('anmeldung', () => st('anmeldung', settings.get('security.require_2fa', 'false') === 'true' ? 'twofa_required' : 'twofa_optional'));
  tryRead('geraete', () => st('geraete', 'mb_' + (['off', 'global', 'individual'].includes(settings.get('machine_binding.mode', 'off')) ? settings.get('machine_binding.mode', 'off') : 'off')));
  tryRead('gruppen', () => st('gruppen', 'groups', { n: count('SELECT COUNT(*) AS c FROM peer_groups') }));
  tryRead('splittunnel', () => {
    let mode = 'off';
    try { mode = JSON.parse(settings.get('split_tunnel_preset', '{}')).mode || 'off'; } catch { mode = 'off'; }
    st('splittunnel', 'split_' + (['off', 'exclude', 'include'].includes(mode) ? mode : 'off'));
  });
  tryRead('clientupdates', () => st('clientupdates', 'channel_' + (require('./clientUpdates').getPolicy().default_channel === 'beta' ? 'beta' : 'stable')));
  if (src.email) st('email', src.email.configured ? 'connected' : 'not_set_up');
  if (src.email) st('benachrichtigungen', src.email.recipient ? 'recipient_set' : 'no_recipient');
  tryRead('webhooks', () => {
    if (!tableExists('webhooks')) return;
    st('webhooks', 'active', { n: count('SELECT COUNT(*) AS c FROM webhooks WHERE enabled = 1') });
  });
  tryRead('monitoring', () => st('monitoring', 'interval', { n: require('./monitor').getSettings().interval }));
  tryRead('pihole', () => {
    if (!require('./license').hasFeature('pihole_integration')) return;
    st('pihole', 'instances', { n: (require('./piholeConfig').load().instances || []).length });
  });
  tryRead('geoip', () => st('geoip', settings.get('ip2location.api_key', '') ? 'key_set' : 'no_key'));
  tryRead('portal', () => st('portal', require('./portalConfig')().enabled ? 'on' : 'off'));
  if (src.ipBlock) st('ipsperre', src.ipBlock.enabled ? 'blocked_now' : 'off', src.ipBlock.enabled ? { n: src.ipBlock.blocked } : {});
  if (src.routeGuard) {
    const open = src.routeGuard.attention.length;
    st('routenschutz', open ? 'routes_open' : 'routes_ok', open ? { n: open } : { n: src.routeGuard.total });
  }
  if (src.scan) {
    if (src.scan.quarantined) st('virenscan', 'quarantined', { n: src.scan.quarantined });
    else st('virenscan', src.scan.engine === 'none' ? 'scan_basic' : 'scan_engine_' + (src.scan.engine === 'icap' ? 'icap' : 'clamav'));
  }
  if (src.plugins) st('plugins', 'installed', { n: src.plugins.installed });
  if (src.ai) st('ki', src.ai.enabled ? 'providers' : 'ai_off', src.ai.enabled ? { n: src.ai.active } : {});
  if (src.backup) st('backup', src.backup.last ? 'last_backup' : 'no_backup', src.backup.last ? { at: src.backup.last.at } : {});
  if (src.updates) st('updates', src.updates.lastAction === 'waiting_window' ? 'update_ready' : 'mode_' + (src.updates.mode === 'manual' ? 'manual' : 'auto'));
  if (src.license) st('lizenz', 'plan', { plan: src.license.plan });
  return s;
}

// ─── Attention ───────────────────────────────────────────

function attention(src) {
  const rows = [];
  const add = (kind, tone, section, href, params, id) => rows.push({ id: id || kind, kind, tone, section, href, params: params || {} });

  const u = src.updates;
  if (u) {
    if (u.lastAction === 'rolled_back' || u.lastAction === 'failed') add('update_' + u.lastAction, 'crit', 'updates', '/settings/updates', { version: u.badVersion || '' });
    else if (u.lastAction === 'waiting_window') add('update_waiting', 'warn', 'updates', '/settings/updates', u.window || {});
    if (u.updateShOutdated) add('update_sh', 'warn', 'updates', '/settings/updates');
  }

  const b = src.backup;
  if (b) {
    if (b.offsite.failing.length) add('backup_target_failed', 'crit', 'backup', '/settings/backup', { names: b.offsite.failing.join(', '), n: b.offsite.failing.length });
    if (b.licensed && b.offsite.enabled === 0) add('backup_local_only', 'warn', 'backup', '/settings/backup');
    if (b.stale) add(b.last ? 'backup_stale' : 'backup_none', 'warn', 'backup', '/settings/backup', b.last ? { at: b.last.at } : {});
  }

  const d = src.domains;
  if (d) {
    const one = (list, kind, tone) => {
      list.slice(0, MAX_ROWS).forEach((domain) => add(kind, tone, 'domains', '/settings/domains', { domain }, kind + ':' + domain));
      if (list.length > MAX_ROWS) add(kind + '_more', tone, 'domains', '/settings/domains', { n: list.length - MAX_ROWS }, kind + ':more');
    };
    one(d.failed, 'domain_failed', 'crit');
    one(d.pending, 'domain_pending', 'warn');
    if (d.ipWarning) add('server_ip', 'warn', 'domains', '/settings/domains');
  }
  const tls = src.tls;
  if (tls) {
    tls.failed.slice(0, MAX_ROWS).forEach((host) => add('tls_failed', 'crit', 'domains', '/certificates', { host }, 'tls_failed:' + host));
    if (tls.failed.length > MAX_ROWS) add('tls_failed_more', 'crit', 'domains', '/certificates', { n: tls.failed.length - MAX_ROWS });
  }

  const rg = src.routeGuard;
  if (rg) {
    const high = rg.attention.filter((a) => a.risk === 'high');
    high.slice(0, MAX_ROWS).forEach((a) => add('route_open_high', 'crit', 'routenschutz', '/settings/routenschutz', { host: a.host }, 'route_open_high:' + a.id));
    if (high.length > MAX_ROWS) add('route_open_high_more', 'crit', 'routenschutz', '/settings/routenschutz', { n: high.length - MAX_ROWS });
    const check = rg.attention.length - high.length;
    if (check > 0) add('route_open_check', 'warn', 'routenschutz', '/settings/routenschutz', { n: check });
  }
  const ib = src.ipBlock;
  if (ib) {
    if (ib.failingLists.length) add('ipblock_list_failed', 'warn', 'ipsperre', '/settings/ipsperre', { n: ib.failingLists.length });
    if (ib.engineMissing) add('ipblock_engine', 'warn', 'ipsperre', '/settings/ipsperre');
  }

  const sc = src.scan;
  if (sc) {
    if (sc.quarantined) add('scan_quarantine', 'crit', 'virenscan', '/settings/virenscan', { n: sc.quarantined });
    if (sc.down) add('scan_down', 'crit', 'virenscan', '/settings/virenscan');
    if (sc.signaturesOld) add('scan_signatures_old', 'warn', 'virenscan', '/settings/virenscan');
    if (sc.updateAvailable) add(sc.local ? 'scan_update_local' : 'scan_update', 'warn', 'virenscan', '/settings/virenscan', { version: sc.version || '', latest: sc.latest || '' });
  }

  const p = src.plugins;
  if (p) {
    p.problems.forEach((x) => add('plugin_' + (x.reason === 'license' ? 'license' : x.reason === 'crashed' ? 'crashed' : 'blocked'),
      x.reason === 'license' || x.reason === 'crashed' ? 'crit' : 'warn', 'plugins', '/settings/plugins/manage/' + x.id, { name: x.name, reason: x.reason }, 'plugin:' + x.id));
    if (p.updates > 0) add('plugin_updates', 'warn', 'plugins', '/settings/plugins/updates', { n: p.updates });
  }

  const l = src.license;
  if (l && l.checkFailed) add('license_check', 'warn', 'lizenz', '/settings/lizenz');

  const e = src.email;
  if (e && e.recipient && !e.configured) add('smtp_missing', 'warn', 'email', '/settings/email');

  // critical first, the rest in the order above
  return rows.filter((r) => r.tone === 'crit').concat(rows.filter((r) => r.tone !== 'crit'));
}

// ─── Entry point ─────────────────────────────────────────

/**
 * @param {{ lang?: 'de'|'en', now?: number }} opts
 */
function build({ lang = 'de', now = Date.now() } = {}) {
  const hasFeature = (k) => tryRead('license', () => require('./license').hasFeature(k), false);
  const src = {
    domains: tryRead('domains', domainsInfo),
    tls: tryRead('tls', tlsInfo),
    backup: tryRead('backup', () => backupInfo(hasFeature('scheduled_backups'), now)),
    updates: tryRead('updates', updatesInfo),
    license: tryRead('license', licenseInfo),
    plugins: tryRead('plugins', () => pluginsInfo(lang === 'en' ? 'en' : 'de')),
    email: tryRead('email', emailInfo),
    ai: tryRead('ai', aiInfo),
    ipBlock: tryRead('ipBlock', ipBlockInfo),
    routeGuard: tryRead('routeGuard', routeGuardInfo),
    scan: tryRead('scan', scanInfo),
  };
  const att = attention(src);
  const bySection = {};
  att.forEach((r) => { bySection[r.section] = (bySection[r.section] || 0) + 1; });
  return {
    version: version(),
    tiles: {
      domains: src.domains ? { total: src.domains.total, verified: src.domains.verified, pending: src.domains.pending.length, failed: src.domains.failed.length } : null,
      backup: src.backup ? { last: src.backup.last, offsite: src.backup.offsite.enabled, failing: src.backup.offsite.failing.length, auto: src.backup.auto } : null,
      license: src.license ? { plan: src.license.plan, unlicensed: src.license.unlicensed, expiresAt: src.license.expiresAt } : null,
    },
    updates: src.updates ? { lastAction: src.updates.lastAction, mode: src.updates.mode } : null,
    attention: att,
    bySection,
    states: sectionStates(src),
  };
}

module.exports = { build, _attention: attention, _sectionStates: sectionStates };
