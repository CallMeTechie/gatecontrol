'use strict';

// Pure helpers of the plugin area (no DOM) — public/js/plugins-page.js uses
// them in the browser, tests/plugins_ui.test.js in node.
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
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB';
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

  /** ['image/jpeg', 'image/png', 'audio/ogg', 'application/pdf'] → "JPEG, PNG, OGG, PDF" */
  function mediaTypes(list) {
    const out = [];
    (list || []).forEach((m) => {
      // "*/*" (media.areas, since 1.204.0): every type
      if (String(m) === '*/*') { if (out.indexOf('*') < 0) out.push('*'); return; }
      const sub = String(m).split('/')[1] || String(m);
      // a whole family ("video/*", since 1.193.0) is named as such
      const name = sub === '*' ? String(m) : sub.replace(/^(?:x-|vnd\.)/, '').split(/[.+;-]/)[0].toUpperCase();
      if (name && out.indexOf(name) < 0) out.push(name);
    });
    return out.indexOf('*') >= 0 ? '*' : out.join(', ');
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
    if (perm.appTab) ui.push(t('plugins.perm.ui_app', { tab: perm.appTab }));
    if (perm.settings) ui.push(t('plugins.perm.ui_settings', { n: perm.settings }));
    rows.push({ label: t('plugins.perm.ui'), value: ui.length ? ui.join(' · ') : t('plugins.perm.none') });
    rows.push({ label: t('plugins.perm.users'), value: t(perm.users ? 'plugins.perm.users_on' : 'plugins.perm.none') });
    if (perm.app) rows.push({ label: t('plugins.perm.app'), value: t('plugins.perm.app_on') });
    if (perm.kiosk) rows.push({ label: t('plugins.perm.kiosk'), value: t('plugins.perm.kiosk_on') });
    if (perm.actions) rows.push({ label: t('plugins.perm.actions'), value: t('plugins.perm.actions_on') });
    if (perm.actionsInteractive) rows.push({ label: t('plugins.perm.actions_interactive'), value: t('plugins.perm.actions_interactive_on') });
    if (perm.maps) rows.push({ label: t('plugins.perm.maps'), value: t('plugins.perm.maps_on') });
    if (perm.geolocation) rows.push({ label: t('plugins.perm.geolocation'), value: t('plugins.perm.geolocation_on') });
    if (perm.camera) rows.push({ label: t('plugins.perm.camera'), value: t('plugins.perm.camera_on') });
    // since 1.196.0: GC.scanQr — GateControl's own dialog reads the code, the plugin gets the text
    if (perm.scanQr) rows.push({ label: t('plugins.perm.scan_qr'), value: t('plugins.perm.scan_qr_on') });
    if (perm.inbox) rows.push({ label: t('plugins.perm.inbox'), value: t('plugins.perm.inbox_on') });
    if (perm.background) rows.push({ label: t('plugins.perm.background'), value: t('plugins.perm.background_v', { s: perm.background }) });
    if (perm.notify) {
      rows.push({ label: t('plugins.perm.notify'), value: t('plugins.perm.notify_on') + (perm.notifyPerHour ? ' · ' + t('plugins.perm.notify_rate', { n: perm.notifyPerHour }) : '') });
      if (perm.criticalTopics && perm.criticalTopics.length) {
        rows.push({ label: t('plugins.perm.notify_critical'), value: t('plugins.perm.notify_critical_v', { topics: perm.criticalTopics.join(', ') }) });
      }
      if (perm.chatTopics && perm.chatTopics.length) {
        rows.push({ label: t('plugins.perm.chat'), value: t('plugins.perm.chat_v', { topics: perm.chatTopics.join(', ') }) });
      }
    }
    // messenger foundations (docs/plugins.md "Media", "Realtime events", "Services")
    if (perm.media) {
      // media.uploads false (since 1.190.0): no uploads, only files the plugin fetches itself (gc.media.fetch)
      rows.push({ label: t('plugins.perm.media'), value: t(perm.media.uploads === false ? 'plugins.perm.media_fetch_v' : 'plugins.perm.media_v', {
        max: fmtBytes(perm.media.maxBytes), quota: fmtBytes(perm.media.quotaDefault),
        types: mediaTypes(perm.media.types) === '*' ? t('plugins.perm.media_all_types') : mediaTypes(perm.media.types),
      }) });
      // media areas (since 1.204.0): the administrator decides per area where the files live
      if (perm.media.areas) rows.push({ label: t('plugins.perm.media_areas'), value: t('plugins.perm.media_areas_on') });
    }
    if (perm.events) rows.push({ label: t('plugins.perm.events'), value: t('plugins.perm.events_on') });
    // since 1.193.0 (GateDrop): public download links (an administrator still has to allow them), the people's devices
    if (perm.publicLinks) rows.push({ label: t('plugins.perm.public_links'), value: t('plugins.perm.public_links_on') });
    if (perm.devices) rows.push({ label: t('plugins.perm.devices'), value: t('plugins.perm.devices_on') });
    // person groups (docs/plugins.md "Groups"): read, or read and manage its own groups
    if (perm.groups === 'read' || perm.groups === 'manage') rows.push({ label: t('plugins.perm.groups'), value: t(perm.groups === 'manage' ? 'plugins.perm.groups_manage' : 'plugins.perm.groups_read') });
    if (perm.notifySink) rows.push({ label: t('plugins.perm.notify_sink'), value: t('plugins.perm.notify_sink_on') });
    if (perm.services && perm.services.length) {
      rows.push({ label: t('plugins.perm.services'), value: t('plugins.perm.services_v', { services: perm.services.map((x) => x.replace(':', ': ')).join(', ') }) });
    }
    if (perm.servicesProvided && perm.servicesProvided.length) {
      rows.push({ label: t('plugins.perm.services_provided'), value: t('plugins.perm.services_provided_v', { services: perm.servicesProvided.join(', ') }) });
    }
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
    if (p.app) out.push({ title: t('plugins.adds.app', { name: p.app.label }), text: t('plugins.adds.app_d') });
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

  // ── Plugin area (Meine Plugins, Katalog, Updates) ──

  // Store categories of catalog-meta.json (catalog.js CATEGORIES), in display order.
  const CATEGORIES = ['family', 'home', 'work', 'mobility', 'infrastructure', 'other'];

  // Icons of catalog-meta.json (catalog.js ICONS): 24×24 stroke paths.
  const ICON_PATHS = {
    family: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6',
    chat: 'M4 5h16v11H9l-5 4z',
    calendar: 'M6 5h12a2.5 2.5 0 0 1 2.5 2.5v10A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-10A2.5 2.5 0 0 1 6 5zM3.5 10h17M8 3v4M16 3v4',
    door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14.5 11.5v1',
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
    snowflake: 'M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11M9 4l3 2 3-2M9 20l3-2 3 2',
    car: 'M4 17v-5l2.2-5.2A1.5 1.5 0 0 1 7.6 6h8.8a1.5 1.5 0 0 1 1.4.8L20 12v5zM4 12h16M7.5 17v2.5M16.5 17v2.5',
    server: 'M5.5 4h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM5.5 13h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2zM7 7.5h.01M7 16.5h.01',
    nas: 'M7.5 3h9A2.5 2.5 0 0 1 19 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18.5v-13A2.5 2.5 0 0 1 7.5 3zM9 7h6M9 10.5h6M12 17h.01',
    puzzle: 'M14 4h-4v3H7v4h3v3h4v-3h3V7h-3zM5 20h14',
    cloud: 'M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.6 9.3 4.9 4.9 0 0 0 7 19z',
  };

  // Symbols of the detail lists (catalog.js DETAIL_ICONS): 24×24 stroke paths.
  const DETAIL_ICON_PATHS = {
    page: 'M6 3h8l4 4v14H6zM14 3v4h4',
    app: 'M9 2.5h6A2.5 2.5 0 0 1 17.5 5v14a2.5 2.5 0 0 1-2.5 2.5H9A2.5 2.5 0 0 1 6.5 19V5A2.5 2.5 0 0 1 9 2.5zM11 18.5h2',
    portal: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4zM3 9h18',
    widget: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    tile: 'M9 2.5h6A2.5 2.5 0 0 1 17.5 5v14a2.5 2.5 0 0 1-2.5 2.5H9A2.5 2.5 0 0 1 6.5 19V5A2.5 2.5 0 0 1 9 2.5zM11 18.5h2',
    action: 'M13 3L5 14h6l-1 7 8-11h-6z',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    network: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
    chat: 'M4 5h16v11H9l-5 4z',
    key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l9-9M16 7l3 3',
    location: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6',
    door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14.5 11.5v1',
    calendar: 'M6 5h12a2.5 2.5 0 0 1 2.5 2.5v10A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-10A2.5 2.5 0 0 1 6 5zM3.5 10h17M8 3v4M16 3v4',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    car: 'M4 17v-5l2.2-5.2A1.5 1.5 0 0 1 7.6 6h8.8a1.5 1.5 0 0 1 1.4.8L20 12v5zM4 12h16M7.5 17v2.5M16.5 17v2.5',
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
    server: 'M5.5 4h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM5.5 13h13a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z',
    shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    cloud: 'M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6.5 6.5 0 0 0 5.6 9.3 4.9 4.9 0 0 0 7 19z',
  };

  /**
   * "Was … hinzufügt" of an installed plugin: [{ icon, title, text, kind }] —
   * page, portal (area, sections), app tab, quick actions and widgets it lists
   * right now (`contrib` = { actions, widgets } of /api/v1/plugins/contributions),
   * notifications, background, settings, services for other plugins.
   */
  function addRows(p, contrib, t) {
    const out = [];
    if (!p) return out;
    const c = contrib || {};
    const perm = p.permissions || {};
    if (p.app) out.push({ kind: 'app', icon: 'app', title: t('plugins.adds.app', { name: p.app.label }), text: t('plugins.adds.app_d') });
    if (p.portal && p.portal.label) out.push({ kind: 'portal', icon: 'portal', title: t('plugins.adds.portal', { name: p.portal.label }), text: t('plugins.adds.portal_d') });
    if (p.portal) (p.portal.sections || []).forEach((s) => out.push({ kind: 'portal', icon: 'portal', title: t('plugins.adds.portal_section', { title: s.title, tab: t('plugins.portal_tab.' + s.tab) }), text: t('plugins.adds.portal_section_d') }));
    if (p.nav) out.push({ kind: 'page', icon: 'page', title: t('plugins.adds.page', { name: p.nav.label }), text: t('plugins.adds.page_d') });
    if (c.widgets) out.push({ kind: 'widgets', icon: 'widget', title: t('plugins.x.add_widgets', { n: c.widgets }), text: t('plugins.x.add_widgets_d') });
    if (c.actions) out.push({ kind: 'actions', icon: 'action', title: t('plugins.x.add_actions', { n: c.actions }), text: t('plugins.x.add_actions_d') });
    if (perm.background) out.push({ kind: 'background', icon: 'clock', title: t('plugins.adds.background'), text: t('plugins.perm.background_v', { s: perm.background }) });
    if (perm.notify) out.push({ kind: 'notify', icon: 'bell', title: t('plugins.x.add_notify_t'), text: t('plugins.x.add_notify_d') });
    if (p.provides && p.provides.length) out.push({ kind: 'services', icon: 'link', title: t('plugins.x.add_services', { n: p.provides.length }), text: t('plugins.x.add_services_d') });
    if (p.settingsCount) out.push({ kind: 'settings', icon: 'key', title: t('plugins.adds.settings'), text: t('plugins.perm.ui_settings', { n: p.settingsCount }) });
    return out;
  }

  /** Short chips of a plugin row ("App-Tab", "Portal „Zuhause“", "4 Widgets" …), at most `max`. */
  function addChips(p, contrib, t, max) {
    const out = [];
    if (!p) return out;
    const c = contrib || {};
    if (p.app) out.push(t('plugins.x.add_app'));
    if (p.portal && p.portal.label) out.push(t('plugins.x.add_portal_named', { name: p.portal.label }));
    else if (p.portal && (p.portal.sections || []).length) out.push(t('plugins.x.add_portal_named', { name: p.portal.sections[0].title }));
    if (p.nav) out.push(t('plugins.x.add_page'));
    if (c.actions) out.push(t('plugins.x.chip_actions', { n: c.actions }));
    if (c.widgets) out.push(t('plugins.x.chip_widgets', { n: c.widgets }));
    if (p.provides && p.provides.length) out.push(t('plugins.x.add_services_short', { n: p.provides.length }));
    if (p.permissions && p.permissions.notify && out.length < 3) out.push(t('plugins.x.add_notify'));
    if (p.permissions && p.permissions.background && out.length < 3) out.push(t('plugins.x.add_bg'));
    return out.slice(0, max || 4);
  }

  /** Whole days from now until `iso` (negative when past), null without a date. */
  function daysUntil(iso, now) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return null;
    return Math.ceil((at - (now == null ? Date.now() : now)) / 86400000);
  }

  function categoryOf(meta) {
    const c = meta && meta.category;
    return CATEGORIES.indexOf(c) >= 0 ? c : 'other';
  }

  /** The icon path of a plugin: catalogue icon name, else its nav icon path, else the default. */
  function iconPath(meta, installed) {
    if (meta && ICON_PATHS[meta.icon]) return ICON_PATHS[meta.icon];
    if (installed && installed.nav && installed.nav.icon) return installed.nav.icon;
    return ICON_PATHS.puzzle;
  }

  /** Installed plugin that should run but does not (not just switched off). */
  function isProblem(p) {
    return !!p && (p.status === 'crashed' || p.status === 'blocked');
  }

  function licenseExpiring(p) {
    return !!(p && p.license && p.license.required && p.license.state === 'expiring');
  }

  /**
   * "Braucht deine Aufmerksamkeit": [{ kind, id?, ids? }] — crashed /
   * license / unsigned / incompatible / broken per plugin, expiring licences,
   * and one entry for all updates (`updates`: catalogue items with state update).
   */
  function attention(plugins, updates) {
    const out = [];
    (plugins || []).forEach((p) => {
      if (p.status === 'crashed') out.push({ kind: 'crashed', id: p.id });
      else if (p.status === 'blocked') {
        const r = p.reason;
        out.push({ kind: r === 'license' || r === 'unsigned' || r === 'incompatible' ? r : 'broken', id: p.id });
      } else if (licenseExpiring(p)) out.push({ kind: 'expiring', id: p.id });
    });
    const ups = (updates || []).filter((u) => u && u.state === 'update');
    if (ups.length) out.push({ kind: 'updates', ids: ups.map((u) => u.id) });
    return out;
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /** Does a plugin/catalogue item match the search text (name, id, summary, description, keywords)? */
  function matches(item, q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = norm([item.name, item.id, item.summary, item.description, item.publisher].concat(item.keywords || []).join(' '));
    return words.every((w) => hay.indexOf(w) >= 0);
  }

  /** Installed plugins by filter: all | active | problems | off. */
  function filterInstalled(plugins, filter) {
    return (plugins || []).filter((p) => {
      if (filter === 'active') return p.status === 'running' || p.status === 'starting';
      if (filter === 'problems') return isProblem(p) || licenseExpiring(p);
      if (filter === 'off') return p.status === 'disabled';
      return true;
    });
  }

  /** Items grouped by category in display order: [{ category, items }] (empty groups left out). */
  function groupByCategory(items, metaOf) {
    const by = {};
    (items || []).forEach((it) => {
      const c = categoryOf(metaOf ? metaOf(it) : it);
      (by[c] = by[c] || []).push(it);
    });
    return CATEGORIES.filter((c) => by[c]).map((c) => ({ category: c, items: by[c] }));
  }

  /** Catalogue order: recommended (not installed first, then updates, then installed) | recent | name. */
  function sortCatalog(items, sort, lang) {
    const list = (items || []).slice();
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), lang === 'en' ? 'en' : 'de');
    if (sort === 'name') return list.sort(byName);
    if (sort === 'recent') {
      const at = (x) => Date.parse((x.latest && x.latest.publishedAt) || '') || 0;
      return list.sort((a, b) => at(b) - at(a) || byName(a, b));
    }
    const rank = { not_installed: 0, update: 1, installed: 2, incompatible: 3 };
    return list.sort((a, b) => (rank[a.state] ?? 4) - (rank[b.state] ?? 4) || byName(a, b));
  }

  /** 'major' | 'minor' | 'patch' between two x.y.z versions. */
  function updateKind(from, to) {
    const a = /^(\d+)\.(\d+)\.(\d+)/.exec(String(from || ''));
    const b = /^(\d+)\.(\d+)\.(\d+)/.exec(String(to || ''));
    if (!a || !b) return 'major';
    if (a[1] !== b[1]) return 'major';
    if (a[2] !== b[2]) return 'minor';
    return 'patch';
  }

  /**
   * CHANGELOG markdown → lines to render as text: [{ kind: 'p'|'li', level, text }].
   * Headings and empty lines are dropped, **bold** and `code` lose their markers.
   */
  function noteLines(md, max) {
    const out = [];
    const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    String(md || '').split(/\r?\n/).forEach((raw) => {
      if (!raw.trim() || /^\s*#/.test(raw)) return;
      const m = /^(\s*)[-*]\s+(.*)$/.exec(raw);
      if (m) out.push({ kind: 'li', level: Math.min(2, Math.floor(m[1].length / 2)), text: clean(m[2]) });
      else if (out.length && out[out.length - 1].kind === 'li' && /^\s{2,}\S/.test(raw)) out[out.length - 1].text += ' ' + clean(raw);
      else out.push({ kind: 'p', level: 0, text: clean(raw) });
    });
    return max ? out.slice(0, max) : out;
  }

  /** Permission rows the install dialog marks as sensitive: i18n label keys. */
  function sensitivePerms(perm) {
    if (!perm) return [];
    const n = perm.network || {};
    const out = [];
    if ((n.homeTargets || []).length || n.discovery) out.push('plugins.perm.lan');
    if ((n.internet || []).length) out.push('plugins.perm.internet');
    if (perm.actions) out.push('plugins.perm.actions');
    if (perm.geolocation) out.push('plugins.perm.geolocation');
    if (perm.camera) out.push('plugins.perm.camera');
    if (perm.criticalTopics && perm.criticalTopics.length) out.push('plugins.perm.notify_critical');
    if (perm.users) out.push('plugins.perm.users');
    if (perm.kiosk) out.push('plugins.perm.kiosk');
    if (perm.publicLinks) out.push('plugins.perm.public_links');
    if (perm.groups) out.push('plugins.perm.groups');
    return out;
  }

  return { MAX_PACKAGE_BYTES, protoText, statusChip, licenseTone, checkSymbol, checkKeys, fmtBytes, fmtDate, mediaTypes, permRows, permDiff, catalogChip, catalogAction, addsOf, wipeConfirmed,
    CATEGORIES, ICON_PATHS, DETAIL_ICON_PATHS, addRows, addChips, daysUntil, categoryOf, iconPath, isProblem, licenseExpiring, attention, matches, filterInstalled, groupByCategory, sortCatalog, updateKind, noteLines, sensitivePerms };
});
