'use strict';

// Pure view helpers for the domain-zones page (zones.njk). No DOM access:
// loaded before domain-modal.js / zones-page.js in the browser and required
// directly by node:test (tests/zones_view.test.js). Data shapes follow
// docs/feature-domain-zones.md (GET /api/v1/zones).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.GCZonesView = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const UNASSIGNED_KEY = 'z:none';
  const HEALTH_ORDER = { down: 0, degraded: 1, disabled: 2, ok: 3 };

  function str(v) { return v == null ? '' : String(v); }
  function lc(v) { return str(v).toLowerCase(); }

  // ── Hosts ──────────────────────────────────────────────────────────────
  function isApex(host) {
    return !!host && host.subdomain === '@';
  }

  // Display label: '@' for the base domain, else the subdomain, else the name
  // (unassigned hosts have no subdomain).
  function hostLabel(host) {
    if (!host) return '';
    if (isApex(host)) return '@';
    return host.subdomain || host.name || host.fqdn || '';
  }

  // '@' first, then alphabetically by subdomain (hosts without a subdomain —
  // "Ohne Domain" — sort by name). Never mutates the input.
  function sortHosts(hosts) {
    return (hosts || []).slice().sort((a, b) => {
      const aa = isApex(a) ? 0 : 1;
      const bb = isApex(b) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      const ka = lc(a.subdomain || a.name || a.fqdn);
      const kb = lc(b.subdomain || b.name || b.fqdn);
      return ka.localeCompare(kb) || ((a.id || 0) - (b.id || 0));
    });
  }

  // ── Entries ────────────────────────────────────────────────────────────
  function isL4(e) { return !!e && e.route_type === 'l4'; }

  // HTTP before L4, then by listen port (ranges sort by their first port).
  function sortEntries(entries) {
    return (entries || []).slice().sort((a, b) => {
      const la = isL4(a) ? 1 : 0;
      const lb = isL4(b) ? 1 : 0;
      if (la !== lb) return la - lb;
      return (parseInt(a.l4_listen_port, 10) || 0) - (parseInt(b.l4_listen_port, 10) || 0)
        || ((a.id || 0) - (b.id || 0));
    });
  }

  // LAN target of an entry: gateway routes point at target_lan_host, peer
  // routes at the peer's WG address (without CIDR suffix).
  function entryTargetHost(e) {
    if (!e) return '';
    if (e.target_kind === 'gateway') return str(e.target_lan_host);
    return str(e.peer_ip ? String(e.peer_ip).split('/')[0] : e.target_ip);
  }

  function entryTargetPort(e) {
    if (!e) return '';
    if (e.target_kind === 'gateway') return str(e.target_lan_port || e.target_port);
    return str(e.target_port);
  }

  function entryListenPort(e) {
    if (!e) return '';
    if (isL4(e)) return str(e.l4_listen_port);
    return e.https_enabled ? '443' : '80';
  }

  // One exposure chip: HTTPS 443 → 8092 · TCP 2028 → 22 · UDP 5000-5010 → 5000-5010
  // The HTTPS chip carries the note 'HSTS' when the entry has it active
  // (docs/feature-hsts.md); opts.hsts === false leaves it out (the domain
  // dialog shows its own HSTS tag instead).
  function entryChip(e, opts) {
    if (isL4(e)) {
      const out = str(e.l4_listen_port);
      const chip = {
        proto: e.l4_protocol === 'udp' ? 'UDP' : 'TCP',
        out,
        in: entryTargetPort(e) || out,
      };
      if (e.l4_tls_mode && e.l4_tls_mode !== 'none') chip.note = 'TLS-SNI';
      return chip;
    }
    const chip = {
      proto: e && e.https_enabled ? 'HTTPS' : 'HTTP',
      out: entryListenPort(e),
      in: entryTargetPort(e),
    };
    if (e && e.backend_https) chip.note = 'Backend HTTPS';
    if (hstsActive(e) && !(opts && opts.hsts === false)) chip.note = chip.note ? chip.note + ' · HSTS' : 'HSTS';
    // Web Application Firewall (docs/feature-waf.md): 'WAF' / 'WAF (erkennt)';
    // opts.waf === false leaves it out (the domain dialog has its own tag),
    // opts.wafLabel(state) supplies the translated text.
    const waf = wafState(e);
    if (waf && !(opts && opts.waf === false)) {
      const label = opts && typeof opts.wafLabel === 'function' ? opts.wafLabel(waf) : (waf === 'block' ? 'WAF' : 'WAF (erkennt)');
      chip.note = chip.note ? chip.note + ' · ' + label : label;
    }
    return chip;
  }

  // Visible name of an entry (docs/feature-next-package.md S3 §3): the label
  // from GET /zones, trimmed; null = no name, the port/target stays the name.
  function entryName(e) {
    const s = e && e.label != null ? String(e.label).trim() : '';
    return s || null;
  }

  // "Nur bei Bedarf" (S3 §2): never a problem, only the note.
  function isOnDemand(e) {
    return !!(e && e.on_demand);
  }

  // entry.hsts = { enabled, … } from GET /zones; unknown shape → off.
  function hstsActive(e) {
    return !!(e && e.https_enabled && e.hsts && typeof e.hsts === 'object' && e.hsts.enabled === true);
  }

  // WAF state of an HTTP entry from GET /zones (entry.waf_enabled / waf_mode,
  // or entry.waf = { enabled, mode }): null | 'detect' | 'block'.
  function wafState(e) {
    if (!e || isL4(e) || e.rdp_owned) return null;
    const w = e.waf && typeof e.waf === 'object' ? e.waf : { enabled: e.waf_enabled, mode: e.waf_mode };
    const on = w.enabled === true || w.enabled === 1 || w.enabled === '1';
    if (!on) return null;
    return String(w.mode || '').toLowerCase() === 'block' ? 'block' : 'detect';
  }

  // ── Protections, shield, risk filters (docs/feature-release-b.md §9) ──
  // Same classification as src/services/securityCheck.js protectionsOf():
  // "öffentlich" = enabled AND external_enabled; auth, mTLS and IP filter are
  // the access protections; L4 entries have none of them.
  const PROTECTIONS = ['auth', 'mtls', 'ip_filter', 'waf', 'hsts', 'rate_limit'];
  const HTTPS_ONLY = { mtls: 1, hsts: 1 };
  const RISKS = ['nowaf', 'unprotected', 'nohsts'];
  function on(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

  function isPublicEntry(e) { return !!e && on(e.enabled) && on(e.external_enabled); }
  function isHttpsEntry(e) { return !!e && !isL4(e) && on(e.https_enabled); }

  // → { auth: 'basic'|'route_auth'|null, mtls, ip_filter, waf: 'block'|'detect'|null, hsts, rate_limit }
  function entryProtections(e) {
    const http = !!e && !isL4(e);
    const https = http && on(e.https_enabled);
    let auth = null;
    if (http && on(e.basic_auth_enabled)) auth = 'basic';
    else if (http && on(e.route_auth_enabled)) auth = 'route_auth';
    const hsts = e && e.hsts && typeof e.hsts === 'object' ? hstsActive(e) : https && on(e && e.hsts_enabled);
    return {
      auth,
      // mtls_ca_pem is part of the zones rows; without a CA the switch does nothing.
      mtls: https && on(e.mtls_enabled) && (e.mtls_ca_pem === undefined || !!e.mtls_ca_pem),
      ip_filter: http && (on(e.ip_filter_enabled) || on(e.acl_enabled)),
      waf: wafState(e),
      hsts: !!hsts,
      rate_limit: http && on(e.rate_limit_enabled),
    };
  }

  function hasAccessProtection(p) { return !!(p.auth || p.mtls || p.ip_filter); }

  // Shield of one HTTP entry: which protections apply, which are on, which
  // are missing. Missing ones are only reported for public entries (for an
  // internal entry nothing is "missing"). null for L4 and RDP-owned entries.
  // level: 'internal' | 'open' (public, no auth/mTLS/IP filter) | 'ok'.
  function entryShield(e) {
    if (!e || isL4(e) || e.rdp_owned) return null;
    const p = entryProtections(e);
    const https = isHttpsEntry(e);
    const pub = isPublicEntry(e);
    const applicable = PROTECTIONS.filter((k) => https || !HTTPS_ONLY[k]);
    const active = applicable.filter((k) => !!p[k]);
    const missing = pub ? applicable.filter((k) => !p[k]) : [];
    let level = 'ok';
    if (!pub) level = 'internal';
    else if (!hasAccessProtection(p)) level = 'open';
    return { protections: p, applicable, active, missing, count: active.length, public: pub, https, level };
  }

  // Toolbar risk filters, evaluated per entry:
  //   nowaf       public HTTP entry without WAF
  //   unprotected public HTTP entry without auth, mTLS and IP filter
  //   nohsts      active HTTPS entry without HSTS
  function entryRisk(e, risk) {
    if (!e || isL4(e) || e.rdp_owned) return false;
    const p = entryProtections(e);
    if (risk === 'nowaf') return isPublicEntry(e) && !p.waf;
    if (risk === 'unprotected') return isPublicEntry(e) && !hasAccessProtection(p);
    if (risk === 'nohsts') return on(e.enabled) && isHttpsEntry(e) && !p.hsts;
    return false;
  }

  // Language-neutral protocol names derived from the TARGET port (same table
  // as routes-view.js l4Label).
  const PORT_LABELS = {
    22: 'SSH', 3389: 'RDP', 5900: 'VNC', 631: 'IPP', 9100: 'JetDirect',
    445: 'SMB', 5432: 'PostgreSQL', 3306: 'MySQL',
  };
  function entryPortLabel(e) {
    if (!isL4(e)) return null;
    return PORT_LABELS[parseInt(entryTargetPort(e), 10)] || null;
  }

  // 'ok' | 'down' | 'disabled' for one entry (monitoring down or target peer
  // disabled while enabled → down).
  function entryHealth(e) {
    if (!e || !e.enabled) return 'disabled';
    if (e.monitoring_enabled && e.monitoring_status === 'down') return 'down';
    const peerOn = e.target_kind === 'gateway' ? (e.target_peer_enabled !== 0) : (e.peer_enabled !== 0);
    return peerOn ? 'ok' : 'down';
  }

  function worstHealth(list) {
    let worst = 'ok';
    for (const h of list) {
      if ((HEALTH_ORDER[h] ?? 3) < (HEALTH_ORDER[worst] ?? 3)) worst = h;
    }
    return worst;
  }

  // Backend health wins; derived from the entries when absent.
  function hostHealth(host) {
    if (!host) return 'disabled';
    if (host.health) return host.health;
    const entries = host.entries || [];
    if (!entries.length) return 'disabled';
    const hs = entries.map(entryHealth);
    if (hs.every((h) => h === 'disabled')) return 'disabled';
    const live = hs.filter((h) => h !== 'disabled');
    if (live.every((h) => h === 'down')) return 'down';
    if (live.some((h) => h === 'down')) return 'degraded';
    return 'ok';
  }

  function hostEnabled(host) {
    if (!host) return false;
    if (typeof host.enabled_count === 'number') return host.enabled_count > 0;
    return (host.entries || []).some((e) => !!e.enabled);
  }

  // 'external' when any entry is reachable from outside, else 'internal'.
  function hostAccess(host) {
    const entries = (host && host.entries) || [];
    return entries.some((e) => !!e.external_enabled) ? 'external' : 'internal';
  }

  // Shared LAN address of a host; peer-routed hosts fall back to the peer IP.
  function hostTarget(host) {
    if (!host) return '';
    if (host.lan_host) return host.lan_host;
    const first = (host.entries || []).find((e) => !e.rdp_owned) || (host.entries || [])[0];
    return first ? entryTargetHost(first) : '';
  }

  // Common target port when the host has exactly one distinct one (shown as
  // "192.168.2.151 : 8092" in the row), else null.
  function hostSinglePort(host) {
    const ports = new Set((host && host.entries || []).map(entryTargetPort).filter(Boolean));
    return ports.size === 1 ? Array.from(ports)[0] : null;
  }

  // ── Gateways ───────────────────────────────────────────────────────────
  function gatewayKey(kind, id) {
    if (!kind || id == null || id === '') return null;
    return kind + ':' + id;
  }

  function zoneGatewayKey(zone) {
    const g = zone && zone.gateway;
    if (!g || !g.kind) return null;
    return gatewayKey(g.kind, g.kind === 'pool' ? g.pool_id : g.peer_id);
  }

  function entryGatewayKey(e) {
    if (!e) return null;
    if (e.target_kind === 'gateway') {
      return e.target_pool_id != null ? gatewayKey('pool', e.target_pool_id) : gatewayKey('gateway', e.target_peer_id);
    }
    return gatewayKey('peer', e.peer_id);
  }

  // A host follows its zone's gateway unless it carries a legacy override
  // (or has no zone) — then its entries tell.
  function hostGatewayKey(host, zone) {
    if (host && !host.gateway_override && zone && zone.domain_id != null) {
      const k = zoneGatewayKey(zone);
      if (k) return k;
    }
    const first = ((host && host.entries) || []).find((e) => !e.rdp_owned);
    return first ? entryGatewayKey(first) : null;
  }

  function parseGatewayKey(key) {
    const m = /^(gateway|pool|peer):(\d+)$/.exec(str(key));
    if (!m) return null;
    const id = parseInt(m[2], 10);
    if (m[1] === 'pool') return { kind: 'pool', pool_id: id };
    return { kind: m[1], peer_id: id };
  }

  // ── Filtering ──────────────────────────────────────────────────────────
  function entryMatchesQuery(e, needle) {
    return lc(e.domain).includes(needle)
      || lc(e.label).includes(needle)
      || lc(e.description).includes(needle)
      || lc(entryTargetHost(e)).includes(needle)
      || str(e.l4_listen_port).includes(needle)
      || entryTargetPort(e).includes(needle)
      || (!isL4(e) && entryListenPort(e).includes(needle))
      || lc(entryPortLabel(e)).includes(needle);
  }

  function hostMatchesQuery(host, needle) {
    if (!needle) return true;
    if (lc(host.fqdn).includes(needle) || lc(host.name).includes(needle)
      || lc(host.subdomain).includes(needle) || lc(host.description).includes(needle)
      || lc(host.lan_host).includes(needle)) return true;
    return (host.entries || []).some((e) => entryMatchesQuery(e, needle));
  }

  // Entry-level criteria must hold for ONE entry together ("external TCP"
  // means an entry that is both), not spread across a host's entries.
  function entryPasses(e, f) {
    if (f.type === 'http' && isL4(e)) return false;
    if (f.type === 'l4' && !isL4(e)) return false;
    if (f.access === 'external' && !e.external_enabled) return false;
    if (f.access === 'internal' && e.external_enabled) return false;
    if (f.state === 'disabled' && e.enabled) return false;
    if (f.risk && !entryRisk(e, f.risk)) return false;
    return true;
  }

  // An entry-level filter is set (host rows then show only the entries that
  // pass it — used by the bulk selection).
  function entryFilterActive(f) {
    return !!(f && (f.type || f.access || f.state === 'disabled' || f.risk));
  }

  function hostMatches(host, zone, f) {
    if (entryFilterActive(f)
      && !(host.entries || []).some((e) => entryPasses(e, f))) return false;
    if (f.state === 'problem') {
      const h = hostHealth(host);
      if (h !== 'down' && h !== 'degraded') return false;
    }
    if (f.gatewayKey && hostGatewayKey(host, zone) !== f.gatewayKey) return false;
    return hostMatchesQuery(host, f.needle);
  }

  function isFilterActive(opts) {
    const o = opts || {};
    return !!(str(o.q).trim() || o.type || o.access || o.state || o.risk || o.gatewayKey);
  }

  // → Zone[] with only the matching hosts; zones without hits drop out.
  // Returns shallow zone copies — the input is never mutated.
  function filterZones(zones, opts) {
    const o = opts || {};
    const f = {
      needle: lc(o.q).trim(),
      type: o.type || null,
      access: o.access || null,
      state: o.state || null,
      risk: RISKS.indexOf(o.risk) !== -1 ? o.risk : null,
      gatewayKey: o.gatewayKey || null,
    };
    const active = isFilterActive(o);
    const out = [];
    for (const z of zones || []) {
      const hosts = (z.hosts || []).filter((h) => !active || hostMatches(h, z, f));
      if (active && !hosts.length) continue;
      out.push(Object.assign({}, z, { hosts }));
    }
    return out;
  }

  // ── Filter state in the URL hash (#q=nas&type=http&risk=nowaf&gw=pool:3) ──
  const HASH_VALUES = {
    type: ['http', 'l4'],
    access: ['external', 'internal'],
    state: ['disabled', 'problem'],
    risk: RISKS,
  };

  function filtersToHash(f) {
    const o = f || {};
    const parts = [];
    const q = str(o.q).trim();
    if (q) parts.push('q=' + encodeURIComponent(q));
    Object.keys(HASH_VALUES).forEach((k) => {
      if (o[k] && HASH_VALUES[k].indexOf(o[k]) !== -1) parts.push(k + '=' + o[k]);
    });
    if (o.gatewayKey && parseGatewayKey(o.gatewayKey)) parts.push('gw=' + o.gatewayKey);
    return parts.join('&');
  }

  // Unknown keys and values are dropped; never throws.
  function filtersFromHash(hash) {
    const out = { q: '', type: null, access: null, state: null, risk: null, gatewayKey: null };
    const s = str(hash).replace(/^#/, '');
    if (!s) return out;
    s.split('&').forEach((pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) return;
      const k = pair.slice(0, i);
      let v = pair.slice(i + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (_) { return; }
      if (k === 'q') out.q = v.slice(0, 200);
      else if (k === 'gw') out.gatewayKey = parseGatewayKey(v) ? v : null;
      else if (HASH_VALUES[k] && HASH_VALUES[k].indexOf(v) !== -1) out[k] = v;
    });
    return out;
  }

  // ── Bulk selection (POST /api/v1/routes/bulk, feature-release-b §2) ──
  const BULK_MAX = 200;
  const HSTS_BULK_MAX_AGE = 31536000;   // 1 year, no includeSubDomains / preload (like the security check fix)

  // Entries of a host that can be selected: everything but RDP-owned routes
  // (the RDP page manages those). With an entry-level filter only the
  // entries passing it (the row then stands for exactly those).
  function selectableEntries(host, f) {
    const list = ((host && host.entries) || []).filter((e) => !e.rdp_owned && e.id != null);
    if (!entryFilterActive(f)) return list;
    const ff = { type: f.type || null, access: f.access || null, state: f.state || null, risk: f.risk || null };
    return list.filter((e) => entryPasses(e, ff));
  }

  // action → { ids, skipped, set }. set = the bulk body's `set` object.
  //   waf        HTTP entries; opts { mode, paranoia }
  //   hsts       HTTPS entries
  //   monitoring / enable / disable  every selected entry
  function bulkPlan(entries, action, opts) {
    const o = opts || {};
    let fits = () => true;
    let set = null;
    if (action === 'waf') {
      fits = (e) => !isL4(e);
      set = { waf_enabled: true, waf_mode: o.mode === 'block' ? 'block' : 'detect', waf_paranoia: [1, 2, 3, 4].indexOf(Number(o.paranoia)) !== -1 ? Number(o.paranoia) : 1 };
    } else if (action === 'hsts') {
      fits = isHttpsEntry;
      set = { hsts_enabled: true, hsts_max_age: HSTS_BULK_MAX_AGE };
    } else if (action === 'monitoring') set = { monitoring_enabled: true };
    else if (action === 'enable') set = { enabled: true };
    else if (action === 'disable') set = { enabled: false };
    else return null;
    const ids = [];
    let skipped = 0;
    (entries || []).forEach((e) => {
      if (!e || e.rdp_owned || e.id == null) return;
      if (fits(e)) { if (ids.indexOf(e.id) === -1) ids.push(e.id); } else skipped++;
    });
    return { ids, skipped, set, tooMany: ids.length > BULK_MAX };
  }

  // Every entry of the page by id (zones + "Ohne Domain") → { entry, host, zone }.
  function entryIndex(zones) {
    const map = new Map();
    (zones || []).forEach((z) => (z.hosts || []).forEach((h) => (h.entries || []).forEach((e) => {
      if (e && e.id != null) map.set(e.id, { entry: e, host: h, zone: z });
    })));
    return map;
  }

  // ── Aggregates ─────────────────────────────────────────────────────────
  // domains: real zones (the "Ohne Domain" pseudo-zone is not a domain);
  // hosts: all hosts; l4: port forwards; disabled: disabled entries.
  function summarize(zones) {
    const s = { domains: 0, hosts: 0, l4: 0, disabled: 0 };
    for (const z of zones || []) {
      if (z.domain_id != null) s.domains++;
      for (const h of z.hosts || []) {
        s.hosts++;
        for (const e of h.entries || []) {
          if (isL4(e)) s.l4++;
          if (!e.enabled) s.disabled++;
        }
      }
    }
    return s;
  }

  function countEntries(zone) {
    const c = { hosts: 0, entries: 0, http: 0, l4: 0, disabled: 0 };
    for (const h of (zone && zone.hosts) || []) {
      c.hosts++;
      for (const e of h.entries || []) {
        c.entries++;
        if (isL4(e)) c.l4++; else c.http++;
        if (!e.enabled) c.disabled++;
      }
    }
    return c;
  }

  // Pseudo-zone for hosts without a domain — rendered last as "Ohne Domain".
  function buildUnassignedZone(hosts) {
    const sorted = sortHosts(hosts);
    const zone = {
      domain_id: null,
      domain: null,
      verification: null,
      unassigned: true,
      gateway: { kind: null, peer_id: null, pool_id: null, name: null, ip: null, online: null },
      default_external_enabled: false,
      hosts: sorted,
    };
    zone.counts = countEntries(zone);
    zone.health = sorted.length ? worstHealth(sorted.map(hostHealth)) : 'ok';
    return zone;
  }

  // Zones as rendered: API order, hosts sorted, unassigned last (if any).
  function pageZones(data) {
    const d = data || {};
    const list = (d.zones || []).map((z) => Object.assign({}, z, { hosts: sortHosts(z.hosts) }));
    if (d.unassigned && d.unassigned.length) list.push(buildUnassignedZone(d.unassigned));
    return list;
  }

  function zoneKey(zone) {
    return zone && zone.domain_id != null ? 'z:' + zone.domain_id : UNASSIGNED_KEY;
  }

  // Distinct gateway choices actually used on the page, for the toolbar
  // select: [{ key, kind, name }] sorted by name.
  function gatewayChoices(zones) {
    const map = new Map();
    function add(key, kind, name) {
      if (!key || map.has(key)) return;
      map.set(key, { key, kind, name: name || key });
    }
    for (const z of zones || []) {
      const zk = zoneGatewayKey(z);
      if (zk) add(zk, z.gateway.kind, z.gateway.name);
      for (const h of z.hosts || []) {
        if (!h.gateway_override && z.domain_id != null && zk) continue;
        const first = (h.entries || []).find((e) => !e.rdp_owned);
        if (!first) continue;
        const k = entryGatewayKey(first);
        const p = parseGatewayKey(k);
        const name = p && p.kind === 'peer' ? first.peer_name
          : p && p.kind === 'gateway' ? first.target_peer_name : null;
        add(k, p ? p.kind : null, name);
      }
    }
    return Array.from(map.values()).sort((a, b) => lc(a.name).localeCompare(lc(b.name)));
  }

  // Existing SMB (port 445) entries of a zone — candidates for the
  // scan-to-folder "existing NAS route" picker.
  function smbEntries(zone) {
    const out = [];
    for (const h of (zone && zone.hosts) || []) {
      for (const e of h.entries || []) {
        if (isL4(e) && !e.rdp_owned && parseInt(entryTargetPort(e), 10) === 445) {
          out.push({ id: e.id, host: h, entry: e });
        }
      }
    }
    return out;
  }

  // "name.domain" preview for the new-host input ('' / '@' → the base).
  function previewFqdn(subdomain, domain) {
    const s = str(subdomain).trim().toLowerCase().replace(/\.+$/, '');
    if (!domain) return s;
    if (!s || s === '@') return domain;
    return s + '.' + domain;
  }

  // Client-side sanity check only; hosts.js validates for real.
  function validSubdomain(s) {
    const v = str(s).trim().toLowerCase();
    if (v === '' || v === '@') return true;
    return v.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
  }

  function validIPv4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str(s).trim());
    return !!m && m.slice(1).every((n) => parseInt(n, 10) <= 255);
  }

  // Single port 1-65535 or a range 'a-b' (a < b), as the L4 listen-port field allows.
  function validPort(s, allowRange) {
    const v = str(s).trim();
    const one = (p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;
    if (one(v)) return true;
    if (!allowRange) return false;
    const m = /^(\d{1,5})-(\d{1,5})$/.exec(v);
    return !!m && one(m[1]) && one(m[2]) && +m[1] < +m[2];
  }

  return {
    UNASSIGNED_KEY,
    isApex, hostLabel, sortHosts, sortEntries, isL4,
    entryTargetHost, entryTargetPort, entryListenPort, entryChip, entryName, isOnDemand, hstsActive, wafState, entryPortLabel, entryHealth,
    worstHealth, hostHealth, hostEnabled, hostAccess, hostTarget, hostSinglePort,
    gatewayKey, zoneGatewayKey, entryGatewayKey, hostGatewayKey, parseGatewayKey,
    isFilterActive, filterZones, summarize, countEntries, buildUnassignedZone, pageZones,
    zoneKey, gatewayChoices, smbEntries, previewFqdn, validSubdomain, validIPv4, validPort,
    PROTECTIONS, RISKS, BULK_MAX, HSTS_BULK_MAX_AGE, isPublicEntry, isHttpsEntry, entryProtections, entryShield, entryRisk,
    entryFilterActive, filtersToHash, filtersFromHash, selectableEntries, bulkPlan, entryIndex,
  };
});

// ─── LAN discovery helpers (docs/feature-tls-guard.md, "LAN-Erkennung im
// Domain-Dialog"). Pure functions, merged into the export above so the
// browser (window.GCZonesView) and node:test see the same object.
(function (root) {
  const V = (typeof module !== 'undefined' && module.exports) ? module.exports : root.GCZonesView;
  if (!V || V.classifyDiscoveredPort) return;

  // Ports that get an HTTPS entry; everything else becomes TCP.
  const DISCOVERY_HTTP_PORTS = [80, 443, 8080, 8443, 8000, 8081, 3000, 5000, 8096, 32400, 9000, 8123, 631];
  const DISCOVERY_BACKEND_HTTPS_PORTS = [443, 8443];

  // Subdomain suggestion from an mDNS/NetBIOS hostname: drop `.local`, keep
  // the first label, lowercase, collapse everything outside [a-z0-9] into a
  // single hyphen, trim hyphens. '' when nothing usable is left.
  function suggestSubdomain(hostname) {
    let s = hostname == null ? '' : String(hostname).trim().toLowerCase();
    s = s.replace(/\.local\.?$/, '');
    s = s.split('.')[0] || '';
    s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.length > 63 ? s.slice(0, 63).replace(/-+$/g, '') : s;
  }

  function validDiscoveredPort(p) {
    const n = Number(p);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  }

  // → { type: 'http', target, bhttps } | { type: 'tcp', target, listen }
  // Listen-port suggestion for TCP: same value as the target port (the
  // server answers a conflict with a suggested alternative on submit).
  function classifyDiscoveredPort(port) {
    const n = Number(port);
    if (!validDiscoveredPort(n)) return null;
    if (DISCOVERY_HTTP_PORTS.indexOf(n) !== -1) {
      return { type: 'http', target: n, bhttps: DISCOVERY_BACKEND_HTTPS_PORTS.indexOf(n) !== -1 };
    }
    return { type: 'tcp', target: n, listen: n };
  }

  // Draft for the new-host entry fields (nh.type/target/listen/bhttps).
  // With L4 not allowed for the zone, non-HTTP ports fall back to an HTTPS
  // entry so the disabled TCP option is never selected.
  function entryDraftFromPort(port, l4Allowed) {
    const c = classifyDiscoveredPort(port);
    if (!c) return null;
    if (c.type === 'tcp' && l4Allowed === false) return { type: 'http', target: String(c.target), listen: '', bhttps: false };
    return c.type === 'http'
      ? { type: 'http', target: String(c.target), listen: '', bhttps: !!c.bhttps }
      : { type: 'tcp', target: String(c.target), listen: String(c.listen), bhttps: false };
  }

  // Port numbers of a discovered device, unique, ascending, invalid dropped.
  function devicePorts(dev) {
    const seen = {};
    return ((dev && dev.ports) || [])
      .map((p) => (p && typeof p === 'object' ? p.port : p))
      .filter((p) => validDiscoveredPort(p) && !seen[p] && (seen[p] = true))
      .map(Number)
      .sort((a, b) => a - b);
  }

  function ipSortKey(ip) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip || ''));
    return m ? m.slice(1).map((n) => String(n).padStart(3, '0')).join('.') : '999.' + String(ip || '');
  }

  // Text filter over hostname/IP (case-insensitive substring), sorted by IP.
  function filterDiscovered(devices, q) {
    const needle = (q == null ? '' : String(q)).trim().toLowerCase();
    return (devices || [])
      .filter((d) => d && (d.ip || d.hostname))
      .filter((d) => !needle || String(d.hostname || '').toLowerCase().includes(needle) || String(d.ip || '').toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => (ipSortKey(a.ip) < ipSortKey(b.ip) ? -1 : ipSortKey(a.ip) > ipSortKey(b.ip) ? 1 : 0));
  }

  // Whole minutes since `updatedAt` (ms epoch); null when unknown.
  function discoveryAgeMinutes(updatedAt, now) {
    const ts = Number(updatedAt);
    if (!ts) return null;
    return Math.max(0, Math.round(((now == null ? Date.now() : now) - ts) / 60000));
  }

  // Gateway capability/enabled state from GET /api/v1/gateways rows.
  function discoveryStateOf(gateway) {
    const tel = (gateway && gateway.health && gateway.health.telemetry) || {};
    return { capable: tel.lan_discovery === true, enabled: !!(gateway && gateway.discovery && gateway.discovery.enabled) };
  }

  Object.assign(V, {
    DISCOVERY_HTTP_PORTS, suggestSubdomain, classifyDiscoveredPort, entryDraftFromPort, devicePorts,
    filterDiscovered, discoveryAgeMinutes, discoveryStateOf,
  });
})(typeof self !== 'undefined' ? self : this);
