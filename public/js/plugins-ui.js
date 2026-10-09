'use strict';

// Pure helpers of Settings → Plugins (no DOM) — public/js/settings-plugins.js
// uses them in the browser, tests/plugins_ui.test.js in node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCPluginsUI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
  const LICENSE_TONE = {
    valid: 'good', not_required: 'good', expiring: 'warn', unreachable: 'warn',
    missing: 'crit', expired: 'crit', invalid: 'crit', bound_elsewhere: 'crit', wrong_plugin: 'off', grace_over: 'crit', unreachable_new: 'warn',
  };

  /** State chip of a plugin card: { tone, key } (key = i18n key). */
  function statusChip(p) {
    if (!p) return { tone: 'off', key: 'plugins.state.disabled' };
    if (p.status === 'running') return { tone: 'good', key: 'plugins.state.running' };
    if (p.status === 'starting') return { tone: 'info', key: 'plugins.state.starting' };
    if (p.status === 'crashed') return { tone: 'crit', key: 'plugins.state.crashed' };
    if (p.status === 'disabled') return { tone: 'off', key: 'plugins.state.disabled' };
    if (p.reason === 'license') return { tone: 'crit', key: 'plugins.lic.state.' + ((p.license && p.license.state) || 'missing') };
    if (p.reason === 'unsigned') return { tone: 'warn', key: 'plugins.state.unsigned' };
    if (p.reason === 'incompatible') return { tone: 'crit', key: 'plugins.state.incompatible' };
    return { tone: 'crit', key: 'plugins.state.broken' };
  }

  function licenseTone(state) { return LICENSE_TONE[state] || 'off'; }

  function checkSymbol(status) { return status === 'ok' ? '✓' : (status === 'warn' ? '!' : '✕'); }

  /** i18n keys of one install check. */
  function checkKeys(c) {
    const base = 'plugins.check.' + c.key + '.' + c.code;
    return { title: base, detail: base + '_d' };
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(iso, lang) {
    if (!iso) return '';
    const d = new Date(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) || String(iso).includes('T') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); }
  }

  /**
   * Permission rows in human terms: [{ label, value }] — `t(key, params)`
   * translates. Used by the install step "Berechtigungen" and the tab.
   */
  /** "http" → "HTTP", "tcp:6444" → "TCP 6444", "udp:6445,20086" → "UDP 6445, 20086" */
  function protoText(p) {
    const m = /^(http|tcp|udp)(?::(.+))?$/.exec(String(p));
    if (!m) return String(p);
    return m[1].toUpperCase() + (m[2] ? ' ' + m[2].split(',').map((x) => x.trim()).join(', ') : '');
  }

  function permRows(perm, t) {
    if (!perm) return [];
    const n = perm.network || { internet: [], homeTargets: [], discovery: null };
    const rows = [];
    rows.push({ label: t('plugins.perm.internet'), value: n.internet.length ? n.internet.join(', ') : t('plugins.perm.none') });
    const ht = n.homeTargets || [];
    rows.push({
      label: t('plugins.perm.lan'),
      value: ht.length
        ? t(ht.length === 1 ? 'plugins.perm.home_targets_one' : 'plugins.perm.home_targets_other', { n: ht.length })
          + ' ' + ht.map((x) => x.label + ' (' + x.protocols.map(protoText).join(' · ') + ')').join(', ')
        : t('plugins.perm.none'),
    });
    if (n.discovery) rows.push({ label: t('plugins.perm.discovery'), value: t('plugins.perm.discovery_v', { ports: n.discovery.udp.join(', ') }) });
    rows.push({ label: t('plugins.perm.data'), value: t(perm.storage ? 'plugins.perm.storage_on' : 'plugins.perm.storage_off') });
    const ui = [];
    if (perm.pages && perm.pages.length) ui.push(t('plugins.perm.ui_pages', { pages: perm.pages.join(', ') }));
    if (perm.portalTab) ui.push(t('plugins.perm.ui_portal', { tab: perm.portalTab }));
    (perm.portalSections || []).forEach((s) => ui.push(t('plugins.perm.ui_portal_section', { title: s.title, tab: t('plugins.portal_tab.' + s.tab) })));
    if (perm.settings) ui.push(t('plugins.perm.ui_settings', { n: perm.settings }));
    rows.push({ label: t('plugins.perm.ui'), value: ui.length ? ui.join(' · ') : t('plugins.perm.none') });
    rows.push({ label: t('plugins.perm.users'), value: t(perm.users ? 'plugins.perm.users_on' : 'plugins.perm.none') });
    if (perm.background) rows.push({ label: t('plugins.perm.background'), value: t('plugins.perm.background_v', { s: perm.background }) });
    if (perm.notify) rows.push({ label: t('plugins.perm.notify'), value: t('plugins.perm.notify_on') });
    return rows;
  }

  /**
   * Permission rows of an update compared with the installed version:
   * { rows: [{ label, value, change: null|'added'|'changed', old? }], removed: [{ label, value }], changed: n }.
   * Without `oldPerm` (a new install) every row has change null.
   */
  function permDiff(perm, oldPerm, t) {
    const now = permRows(perm, t);
    if (!oldPerm) return { rows: now.map((r) => ({ label: r.label, value: r.value, change: null })), removed: [], changed: 0 };
    const before = permRows(oldPerm, t);
    const old = {};
    before.forEach((r) => { old['k:' + r.label] = r.value; });
    const rows = now.map((r) => {
      const k = 'k:' + r.label;
      if (!Object.prototype.hasOwnProperty.call(old, k)) return { label: r.label, value: r.value, change: 'added' };
      return old[k] === r.value ? { label: r.label, value: r.value, change: null } : { label: r.label, value: r.value, change: 'changed', old: old[k] };
    });
    const labels = now.map((r) => r.label);
    const removed = before.filter((r) => labels.indexOf(r.label) < 0);
    return { rows, removed, changed: rows.filter((r) => r.change).length + removed.length };
  }

  /**
   * Chip of a catalogue plugin: { tone, key } or null (not installed needs none).
   * state: not_installed | installed | update | incompatible (GET /api/v1/plugin-catalog)
   */
  function catalogChip(item) {
    if (!item) return null;
    if (item.state === 'installed') return { tone: 'good', key: 'plugins.cat.state.installed' };
    if (item.state === 'update') return { tone: 'info', key: 'plugins.cat.state.update' };
    if (item.state === 'incompatible') return { tone: 'warn', key: 'plugins.cat.state.incompatible' };
    return null;
  }

  /** The catalogue action of a plugin: 'install' | 'update' | null. */
  function catalogAction(item) {
    if (!item || !item.latest) return null;
    if (item.state === 'not_installed') return 'install';
    if (item.state === 'update') return 'update';
    return null;
  }

  /** What the plugin adds (overview list). */
  function addsOf(p, t) {
    const out = [];
    if (p.nav) out.push({ title: t('plugins.adds.page', { name: p.nav.label }), text: t('plugins.adds.page_d') });
    if (p.portal && p.portal.label) out.push({ title: t('plugins.adds.portal', { name: p.portal.label }), text: t('plugins.adds.portal_d') });
    if (p.portal) (p.portal.sections || []).forEach((s) => out.push({ title: t('plugins.adds.portal_section', { title: s.title, tab: t('plugins.portal_tab.' + s.tab) }), text: t('plugins.adds.portal_section_d') }));
    if (p.permissions && p.permissions.background) out.push({ title: t('plugins.adds.background'), text: t('plugins.perm.background_v', { s: p.permissions.background }) });
    if (p.settingsCount) out.push({ title: t('plugins.adds.settings'), text: t('plugins.perm.ui_settings', { n: p.settingsCount }) });
    return out;
  }

  /** Is `typed` the confirmation for wiping plugin `p`? */
  function wipeConfirmed(p, typed) {
    const v = String(typed || '').trim();
    if (!v || !p) return false;
    const n = p.names || {};
    return v === p.name || v === n.de || v === n.en;
  }

  return { MAX_PACKAGE_BYTES, protoText, statusChip, licenseTone, checkSymbol, checkKeys, fmtBytes, fmtDate, permRows, permDiff, catalogChip, catalogAction, addsOf, wipeConfirmed };
});
