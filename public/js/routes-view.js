'use strict';

// Pure view helpers for the routes list — grouping, filtering, sorting.
// No DOM access: loaded before routes.js in the browser and required
// directly by node:test (see tests/routes_view_grouping.test.js).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GCRoutesView = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const NO_DOMAIN_KEY = '_nodomain';

  // 'down' (monitoring down or linked peer/gateway offline while enabled)
  // beats 'disabled' beats 'active'.
  function routeStatus(r) {
    if (!r.enabled) return 'disabled';
    if (r.monitoring_enabled && r.monitoring_status === 'down') return 'down';
    const peerOnline = r.target_kind === 'gateway'
      ? (r.target_peer_enabled !== 0)
      : (r.peer_enabled !== 0);
    if (!peerOnline) return 'down';
    return 'active';
  }

  // Bundle membership wins over the domain; domainless L4 routes share one
  // collapsible bucket.
  function routeGroupKey(r) {
    if (r.bundle_id != null) return 'b:' + r.bundle_id;
    if (r.domain) return 'd:' + String(r.domain).toLowerCase();
    return NO_DOMAIN_KEY;
  }

  function worstStatus(routes) {
    let worst = 'active';
    for (const r of routes) {
      const s = routeStatus(r);
      if (s === 'down') return 'down';
      if (s === 'disabled') worst = 'disabled';
    }
    if (worst === 'disabled' && routes.some((r) => r.enabled)) return 'mixed';
    return worst;
  }

  // HTTP before L4, then by listen port.
  function memberOrder(a, b) {
    const aL4 = a.route_type === 'l4' ? 1 : 0;
    const bL4 = b.route_type === 'l4' ? 1 : 0;
    if (aL4 !== bL4) return aL4 - bL4;
    return parseInt(a.l4_listen_port, 10) - parseInt(b.l4_listen_port, 10) || 0;
  }

  // → ordered [{ key, label, isBundle, bundleId, routes, status, single }]
  // Single non-bundle routes get single=true (rendered without group chrome).
  function buildGroups(routes) {
    const map = new Map();
    for (const r of routes) {
      const key = routeGroupKey(r);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const groups = [];
    for (const [key, members] of map) {
      members.sort(memberOrder);
      const isBundle = key.indexOf('b:') === 0;
      const first = members[0];
      groups.push({
        key,
        isBundle,
        bundleId: isBundle ? first.bundle_id : null,
        label: isBundle
          ? (first.bundle_name || first.bundle_domain || first.domain || '')
          : (key === NO_DOMAIN_KEY ? null : (first.domain || '')),
        routes: members,
        status: worstStatus(members),
        single: !isBundle && key !== NO_DOMAIN_KEY && members.length === 1,
      });
    }
    // No-domain bucket always sorts last; everything else by label.
    groups.sort((a, b) => {
      if (a.key === NO_DOMAIN_KEY) return 1;
      if (b.key === NO_DOMAIN_KEY) return -1;
      return String(a.label).localeCompare(String(b.label));
    });
    return groups;
  }

  // Chip filters AND the free-text search. All criteria are optional.
  function filterRoutes(routes, { q, type, status, target, exposure } = {}) {
    const needle = (q || '').toLowerCase().trim();
    return routes.filter((r) => {
      if (type && (r.route_type === 'l4' ? 'l4' : 'http') !== type) return false;
      if (status && routeStatus(r) !== status) return false;
      if (exposure === 'external' && !r.external_enabled) return false;
      if (exposure === 'internal' && r.external_enabled) return false;
      if (target && (r.target_kind === 'gateway'
        ? (r.target_pool_id != null ? 'pool' : 'gateway')
        : 'peer') !== target) return false;
      if (needle) {
        const hit = (r.domain && r.domain.toLowerCase().includes(needle))
          || (r.bundle_name && r.bundle_name.toLowerCase().includes(needle))
          || (r.description && r.description.toLowerCase().includes(needle))
          || (r.peer_name && r.peer_name.toLowerCase().includes(needle))
          || (r.target_peer_name && r.target_peer_name.toLowerCase().includes(needle))
          || (r.target_ip && r.target_ip.includes(needle))
          || (r.target_lan_host && r.target_lan_host.includes(needle))
          || (r.l4_listen_port && String(r.l4_listen_port).includes(needle))
          || (r.target_port != null && String(r.target_port).includes(needle))
          || (r.target_lan_port != null && String(r.target_lan_port).includes(needle))
          || ((l4Label(r) || '').toLowerCase().includes(needle));
        if (!hit) return false;
      }
      return true;
    });
  }

  // ── Display helpers (Aurora card redesign) ──────────────────────────
  // Ziel-Host/-Port wie der bisherige targetTxt in routes.js: Gateway-Routen
  // zeigen den LAN-Host, Peer-Routen die Peer-IP (ohne CIDR-Suffix).
  function routeTargetHost(r) {
    if (r.target_kind === 'gateway') return r.target_lan_host || '?';
    return (r.peer_ip ? String(r.peer_ip).split('/')[0] : r.target_ip) || '';
  }
  function routeTargetPort(r) {
    if (r.target_kind === 'gateway') return r.target_lan_port || r.target_port || '?';
    return r.target_port;
  }

  // Sprechender Name für L4-Weiterleitungen, abgeleitet aus dem ZIEL-Port.
  // Sprach-neutrale Protokollnamen — bewusst nicht i18n (Spec).
  const L4_PORT_LABELS = {
    22: 'SSH', 3389: 'RDP', 5900: 'VNC', 631: 'IPP', 9100: 'RAW-Print',
    445: 'SMB', 5432: 'PostgreSQL', 3306: 'MySQL',
  };
  function l4Label(r) {
    if (r.route_type !== 'l4') return null;
    return L4_PORT_LABELS[parseInt(routeTargetPort(r), 10)] || null;
  }

  // Titel-Kaskade: domain > description > l4Label > "PROTO :listen".
  function routeTitle(r) {
    if (r.domain) return r.domain;
    if (r.description) return r.description;
    const lbl = l4Label(r);
    if (lbl) return lbl;
    return (r.l4_protocol === 'udp' ? 'UDP' : 'TCP') + ' :' + (r.l4_listen_port || '');
  }

  // Mono-Subzeile: L4 "proto/listen → host:port", HTTP "→ host:port".
  // omitHost lässt nur den Host weg (Gruppen-Karte zeigt ihn im Kopf) —
  // der L4-Listen-Teil bleibt IMMER erhalten (Spec).
  function routeSubtitle(r, opts) {
    const omitHost = !!(opts && opts.omitHost);
    const host = omitHost ? '' : routeTargetHost(r);
    const prefix = r.route_type === 'l4'
      ? (r.l4_protocol === 'udp' ? 'udp' : 'tcp') + '/' + (r.l4_listen_port || '') + ' → '
      : '→ ';
    const desc = (r.description && r.description !== routeTitle(r))
      ? ' · ' + r.description : '';
    return prefix + host + ':' + routeTargetPort(r) + desc;
  }

  const STATUS_ORDER = { down: 0, mixed: 1, disabled: 2, active: 3 };

  function sortRoutes(routes, sortKey) {
    const arr = routes.slice();
    if (sortKey === 'status') {
      arr.sort((a, b) => (STATUS_ORDER[routeStatus(a)] - STATUS_ORDER[routeStatus(b)])
        || String(a.domain || '').localeCompare(String(b.domain || '')));
    } else if (sortKey === 'type') {
      arr.sort((a, b) => ((a.route_type === 'l4' ? 1 : 0) - (b.route_type === 'l4' ? 1 : 0))
        || String(a.domain || '').localeCompare(String(b.domain || '')));
    } else {
      arr.sort((a, b) => String(a.domain || a.bundle_domain || '￿')
        .localeCompare(String(b.domain || b.bundle_domain || '￿')));
    }
    return arr;
  }

  return { routeStatus, routeGroupKey, buildGroups, filterRoutes, sortRoutes,
    l4Label, routeTitle, routeSubtitle, routeTargetHost, NO_DOMAIN_KEY };
});
