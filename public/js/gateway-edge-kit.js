'use strict';

// Pure helpers of the gateway tabs "Edge-Plugins" and "MQTT" (no DOM) —
// public/js/gateway-edge.js uses them in the browser, tests/gateway_edge_ui.test.js
// in node. The rules they mirror live on the server (src/services/edge/*):
// user names and topic filters as mqtt.js / manifest.js check them, the
// states of an edge assignment as index.js / state.js report them.
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./handbook') : root.GCHandbook);
  if (node) module.exports = api;
  else root.GCGatewayEdgeKit = api;
})(typeof self !== 'undefined' ? self : this, function (HB) {
  // 'net' / 'inet' (phase 3a): tabs "Netzwerk" and "Internet" (public/js/gateway-net.js)
  // 'dns' / 'cache' (phase 3b): tabs "DNS-Filter" and "Zwischenspeicher" (public/js/gateway-home.js)
  // 'features': tab "Funktionen" — the switches of the gateway (public/js/gateway-net.js)
  // 'radio' (phase 3c, step 2): tab "Funk" (public/js/gateway-radio.js)
  const TABS = ['overview', 'features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt'];

  /**
   * #gw/<id>[/<tab>] → { id, tab } (tab 'overview' when absent or unknown); null for any other hash.
   * The id is the URL-encoded peer id as gateways.js writes it.
   */
  function parseHash(hash) {
    const m = /^#gw\/([^/]+)(?:\/([a-z]+))?$/.exec(String(hash || ''));
    if (!m) return null;
    let id;
    try { id = decodeURIComponent(m[1]); } catch (e) { return null; }
    return { id, tab: TABS.indexOf(m[2]) > 0 ? m[2] : 'overview' };
  }

  function hashFor(id, tab) {
    return '#gw/' + encodeURIComponent(String(id)) + (tab && tab !== 'overview' && TABS.indexOf(tab) > 0 ? '/' + tab : '');
  }

  // Why the edge channel is down (services/edge/reason.js) — the server reports state 'offline'
  // plus `reason`; a row shows the reason in place of the plain 'offline'.
  const REASONS = ['gateway_offline', 'edge_missing', 'edge_not_running', 'compose_outdated', 'edge_fence', 'edge_not_connected'];

  // State of one plugin's edge part on the gateway → tone + i18n key (gwe.state.<state>).
  // 'not_set_up': installed with an edge part, never switched on here.
  const STATE_TONE = {
    running: 'green', starting: 'blue', pending: 'blue', crashed: 'red', denied: 'red', stopped: 'grey',
    offline: 'grey', disabled: 'grey', update_pending: 'amber', unsigned: 'grey', plugin_off: 'grey',
    gateway_too_old: 'amber', edge_off: 'grey', not_set_up: 'grey', no_edge: 'grey',
    gateway_offline: 'grey', edge_missing: 'amber', edge_not_running: 'red', compose_outdated: 'amber', edge_fence: 'red', edge_not_connected: 'amber',
  };
  const STATES = Object.keys(STATE_TONE);

  // Where the user guide explains the next step (public/js/handbook.js): a missing edge service
  // means an old compose file — chapter 6 per platform; the Pi image only needs EDGE=on (chapter 4);
  // the Proxmox container runs without Docker and so without edge (chapter 3.5).
  const REASON_TOPICS = {
    gateway_offline: { other: 'edge.gateway_offline' },
    edge_missing: { rpi: 'edge.edge_missing', synology: 'update.synology', linux: 'update.linux', proxmox: 'gw.proxmox', other: 'update' },
    edge_not_running: { other: 'edge.edge_not_running' },
    compose_outdated: { rpi: 'edge.compose_outdated', synology: 'update.synology', linux: 'update.linux', other: 'edge.compose_outdated' },
    edge_fence: { other: 'edge.edge_fence' },
    edge_not_connected: { other: 'edge.edge_not_connected' },
  };

  /**
   * The help topic for a reason (null: none) — `platform` as the gateway assistant stores it (rpi, synology, …).
   * gateway-edge.js opens it in the handbook of the Gateways page.
   */
  function reasonTopic(reason, platform) {
    const d = Object.prototype.hasOwnProperty.call(REASON_TOPICS, reason) ? REASON_TOPICS[reason] : null;
    if (!d) return null;
    return (platform && d[platform]) || d.other;
  }

  /**
   * The same topic in the user guide outside the app (null: none) — `lang` the language of the interface ('de' | 'en').
   */
  function reasonDoc(reason, platform, lang) {
    const topic = reasonTopic(reason, platform);
    if (!topic || !HB) return null;
    return HB.url(topic, lang);
  }

  /** What a plugin row shows: { state, tone, key }. */
  function pluginState(p, settings) {
    const s = settings || {};
    const a = p && p.assignment;
    let state;
    if (a && a.state === 'offline' && REASONS.indexOf(a.reason) >= 0) state = a.reason;
    else if (a && a.state) state = a.state;
    else if (!s.edgeEnabled) state = 'edge_off';
    else if (p && !p.verified && !s.allowUnsignedEdge) state = 'unsigned';
    else state = 'not_set_up';
    if (!STATE_TONE[state]) state = 'stopped';
    return { state, tone: STATE_TONE[state], key: 'gwe.state.' + state };
  }

  /**
   * How the edge container is fenced off, from the gateway's hello → { key, tone, backend, composeOutdated }.
   * Gateway >= 1.23.0 reports isolation.mode: 'isolated' = no network at all (compose network_mode: none,
   * everything through the gateway socket — no fence needed); 'fence' = an older compose file with the
   * edge container in the host network, which needs the gateway's network fence — without it the way out
   * is the current compose file (composeOutdated). Older gateways only report the fence.
   */
  function boundaryState(hello) {
    if (!hello) return { key: 'gwe.edge.fence_unknown', tone: '', backend: null, composeOutdated: false };
    const iso = hello.isolation && typeof hello.isolation === 'object' ? hello.isolation : null;
    const fence = hello.fence && typeof hello.fence === 'object' ? hello.fence : null;
    if (iso && iso.mode === 'isolated') {
      return iso.active ? { key: 'gwe.edge.isolated', tone: 'ok', backend: null, composeOutdated: false }
        : { key: 'gwe.edge.isolation_off', tone: 'bad', backend: null, composeOutdated: false };
    }
    if (fence && fence.active) return { key: 'gwe.edge.fence_on', tone: 'ok', backend: fence.backend || 'nftables', composeOutdated: false };
    if (iso && iso.mode === 'fence') return { key: 'gwe.edge.compose_outdated', tone: 'bad', backend: null, composeOutdated: true };
    // no isolation report at all: the edge container runs software from before gateway 1.23.0 — update the
    // gateway first, then the current compose file (updateFirst)
    return { key: 'gwe.edge.fence_off', tone: 'bad', backend: null, composeOutdated: false, updateFirst: !iso };
  }

  /**
   * The control a plugin row offers:
   *   'review'  → button "Prüfen und einschalten" (capabilities dialog)
   *   'switch'  → on/off switch (switching on opens the capabilities dialog)
   *   'blocked' → a switch that cannot be used (unsigned and not allowed)
   */
  function pluginControl(p, settings) {
    const st = pluginState(p, settings).state;
    if (st === 'update_pending') return 'review';
    if (st === 'unsigned' && !(p.assignment && p.assignment.enabled)) return 'blocked';
    return 'switch';
  }

  /** Counts for the list head and the tab badge. */
  function summary(plugins, settings) {
    const out = { installed: 0, running: 0, attention: 0, enabled: 0 };
    (plugins || []).forEach((p) => {
      out.installed++;
      const st = pluginState(p, settings).state;
      if (st === 'running') out.running++;
      if (['update_pending', 'crashed', 'denied', 'gateway_too_old'].indexOf(st) >= 0) out.attention++;
      if (p.assignment && p.assignment.enabled) out.enabled++;
    });
    return out;
  }

  /**
   * Capabilities for the confirmation dialog: every capability of the
   * installed version, `mark` 'new' for those not approved yet (an update),
   * 'prior' for those approved before; no marks on a first approval.
   */
  function capabilityRows(p) {
    const caps = (p && p.edge && Array.isArray(p.edge.capabilities)) ? p.edge.capabilities : [];
    const a = p && p.assignment;
    const approved = a && a.approved && Array.isArray(a.approved.capabilities) ? a.approved.capabilities : [];
    const fresh = new Set((a && Array.isArray(a.newCapabilities) ? a.newCapabilities : []).map((c) => c.key));
    const marks = approved.length > 0;
    return caps.map((c) => ({
      key: c.key, text: c.text, warning: c.warning === true,
      mark: !marks ? null : (fresh.has(c.key) || approved.indexOf(c.key) < 0 ? 'new' : 'prior'),
    }));
  }

  /**
   * An edge part that reads or writes MQTT, is switched on, but the gateway's MQTT broker is off: it cannot get
   * its device messages — the edge card shows a hint with a button that switches the broker on (a hint, no ban).
   */
  function needsMqtt(p, settings) {
    const caps = (p && p.edge && Array.isArray(p.edge.capabilities)) ? p.edge.capabilities : [];
    const usesMqtt = caps.some((c) => c && typeof c.key === 'string' && (c.key === 'mqtt' || c.key.indexOf('mqtt:') === 0));
    return usesMqtt && !!(p.assignment && p.assignment.enabled) && !(settings && settings.mqttEnabled);
  }

  /** The keys the enable request confirms — exactly the list shown. */
  function capabilityKeys(p) { return capabilityRows(p).map((c) => c.key); }

  // Edge needs about 50 MB, each plugin 30–50 MB more (docs/plugins.md "Edge part").
  // A hint, never a ban: up to a quarter of the RAM counts as comfortable.
  const EDGE_BASE_MB = 50;
  const PER_PLUGIN_MB = 50;

  /** → null (RAM unknown) | { memMb, plugins, max, tight } */
  function memoryHint(memTotalBytes, plugins) {
    const total = Number(memTotalBytes);
    if (!Number.isFinite(total) || total <= 0) return null;
    const memMb = Math.round(total / (1024 * 1024));
    const budget = memMb / 4;
    const max = Math.max(0, Math.floor((budget - EDGE_BASE_MB) / PER_PLUGIN_MB));
    const n = Math.max(0, Number(plugins) || 0);
    return { memMb, plugins: n, max, tight: n > max };
  }

  /** "1 GB" / "512 MB" — RAM as people name it. */
  function ramLabel(memMb) {
    if (memMb >= 900) return Math.round(memMb / 1024 * 2) / 2 + ' GB';
    return memMb + ' MB';
  }

  // ─── MQTT ───────────────────────────────────────────────

  const ACCOUNTS_MAX = 256;
  const TOPICS_MAX = 16;
  const USER_RE = /^[a-z0-9][a-z0-9_.-]{1,47}$/;
  const RESERVED_USERS = ['gc-edge', 'gatecontrol', 'edge', 'admin', 'root'];
  const ACCESS = ['readwrite', 'read', 'write'];

  // Device templates of "Konto anlegen": the vendor topic the device puts its
  // own name under (server: vendorPrefix → <prefix>/<user>/#). Every account
  // also gets devices/<user>/#.
  const TEMPLATES = [
    { id: 'shelly', vendorPrefix: 'shellies' },
    { id: 'tasmota', vendorPrefix: 'tasmota' },
    { id: 'esphome', vendorPrefix: 'esphome' },
    { id: 'homeassistant', vendorPrefix: 'homeassistant' },
    { id: 'custom', vendorPrefix: null },
  ];
  function template(id) { return TEMPLATES.find((t) => t.id === id) || TEMPLATES[TEMPLATES.length - 1]; }

  /** null when fine, else the i18n key of the problem. */
  function usernameProblem(v) {
    const s = String(v == null ? '' : v);
    if (!s) return 'gwe.mqtt.new.user_required';
    if (!USER_RE.test(s)) return 'gwe.mqtt.new.user_invalid';
    if (RESERVED_USERS.indexOf(s) >= 0) return 'gwe.mqtt.new.user_reserved';
    return null;
  }

  /** A topic filter as the server allows it (manifest.topicFilterOk). */
  function topicOk(t) {
    if (typeof t !== 'string' || !t || t.length > 128 || /[\0-\x1f\x7f]/.test(t)) return false;
    if (t[0] === '$' || t[0] === '#' || t[0] === '+') return false;
    const levels = t.split('/');
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      if (!l) return false;
      if (l.indexOf('#') >= 0 && (l !== '#' || i !== levels.length - 1)) return false;
      if (l.indexOf('+') >= 0 && l !== '+') return false;
    }
    return true;
  }

  /** Topics the account will get (shown in the dialog before it is created). */
  function plannedTopics(templateId, username, extra) {
    const u = username || '…';
    const tp = template(templateId);
    const out = [];
    if (tp.vendorPrefix) out.push({ topic: tp.vendorPrefix + '/' + u + '/#', access: 'readwrite', source: 'template' });
    out.push({ topic: 'devices/' + u + '/#', access: 'readwrite', source: 'always' });
    (extra || []).forEach((x) => { if (!out.some((o) => o.topic === x.topic)) out.push({ topic: x.topic, access: x.access, source: 'extra' }); });
    return out;
  }

  /** The POST body of a new account. */
  function accountBody(templateId, username, label, extra) {
    const tp = template(templateId);
    const topics = [{ topic: 'devices/' + username + '/#', access: 'readwrite' }];
    (extra || []).forEach((x) => { if (!topics.some((o) => o.topic === x.topic)) topics.push({ topic: x.topic, access: ACCESS.indexOf(x.access) >= 0 ? x.access : 'readwrite' }); });
    const body = { username, label: label || '', topics };
    if (tp.vendorPrefix) body.vendorPrefix = tp.vendorPrefix;
    return body;
  }

  /** "Topic-Präfix" the device is set up with: the vendor topic of the account, else devices/<user>. */
  function topicPrefix(account) {
    const acl = (account && account.acl) || [];
    const user = account ? account.username : '';
    const own = acl.find((x) => x.topic !== 'devices/' + user + '/#' && /\/#$/.test(x.topic) && x.topic.slice(0, -2).split('/').pop() === user);
    const t = own ? own.topic : 'devices/' + user + '/#';
    return t.replace(/\/#$/, '');
  }

  // mDNS name of a gateway: one label + ".local" (what the gateway asks its LAN for, gatecontrol-gateway
  // src/health/mdnsName.js) — anything else a gateway reports is not shown
  const MDNS_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/;

  /**
   * The gateway's mDNS name ("pi-keller.local") or null: from the heartbeat (telemetry.mdns_name, gateway
   * with that field), else from the hardware profile of the edge hello or of the heartbeat.
   */
  function mdnsName(hello, telemetry) {
    const tel = telemetry && typeof telemetry === 'object' ? telemetry : {};
    const cands = [tel.mdns_name, hello && hello.hardware && hello.hardware.mdns_name, tel.hardware && tel.hardware.mdns_name];
    for (let i = 0; i < cands.length; i++) {
      const v = typeof cands[i] === 'string' ? cands[i].trim().toLowerCase() : '';
      if (v.length <= 69 && MDNS_NAME_RE.test(v)) return v;
    }
    return null;
  }

  /**
   * A gateway without Docker (the Proxmox LXC installer runs it natively under systemd): there is no edge
   * container and no MQTT broker on it. Known from the telemetry (`runtime: 'native'`, gateways that report
   * it), else from the platform the assistant stored — never for a gateway that reports an edge service or
   * says it runs in a container. A hint for the page, never a ban.
   */
  function nativeGateway(g) {
    const tel = (g && g.health && g.health.telemetry) || (g && g.telemetry) || {};
    if (tel.edge && typeof tel.edge === 'object') return false;
    if (tel.runtime === 'native') return true;
    return !!(g && g.platform === 'proxmox' && tel.runtime !== 'container');
  }

  /** broker address "<lan ip>:<port>" or null. */
  function brokerAddress(lanIp, tls) {
    if (typeof lanIp !== 'string' || !lanIp) return null;
    return lanIp + ':' + (tls ? 8883 : 1883);
  }

  /**
   * Status line of the broker: { key, tone } (gwe.mqtt.status.<key>); while the edge channel is down
   * and the server knows why (connection.reason), also `reason` with the tone of that reason.
   */
  function brokerStatus(settings, status, online, reason) {
    const s = settings || {};
    if (!s.mqttEnabled) return { key: 'off', tone: 'grey' };
    if (!s.edgeEnabled) return { key: 'waits_edge', tone: 'amber' };
    if (!online) return REASONS.indexOf(reason) >= 0 ? { key: 'offline', tone: STATE_TONE[reason], reason } : { key: 'offline', tone: 'grey' };
    if (!status) return { key: 'pending', tone: 'blue' };
    return status.running ? { key: 'running', tone: 'green' } : { key: 'stopped', tone: 'red' };
  }

  /** Account status: { key, tone } (gwe.mqtt.acc.<key>). */
  function accountStatus(account, status) {
    if (account.locked) return { key: 'locked', tone: 'grey' };
    const list = status && Array.isArray(status.accounts) ? status.accounts : [];
    const s = list.find((x) => x.user === account.username);
    if (s && s.connected) return { key: 'connected', tone: 'green' };
    return { key: 'idle', tone: 'grey' };
  }

  // ─── Errors and the log ─────────────────────────────────

  const ERROR_CODES = ['not_found', 'plugin_not_found', 'account_not_found', 'not_assigned', 'no_edge', 'caps_mismatch',
    'unsigned_blocked', 'exists', 'limit', 'confirm_mismatch', 'invalid', 'session_required', 'forbidden', 'network'];

  /** API error → i18n key (gwe.err.<code>). */
  function errorKey(code, status) {
    if (ERROR_CODES.indexOf(code) >= 0) return 'gwe.err.' + code;
    if (status === 403) return 'gwe.err.forbidden';
    return 'gwe.err.internal';
  }

  const LOG_FILTERS = [
    { id: 'all', kind: null }, { id: 'log', kind: 'log' }, { id: 'event', kind: 'event' }, { id: 'system', kind: 'system' },
  ];

  /** The label of a log line: kind, or the level for messages (Fehler/Warnung/Info). */
  function logLabel(entry) {
    if (entry.kind === 'event') return 'gwe.log.k.event';
    if (entry.kind === 'system') return entry.level === 'error' ? 'gwe.log.k.system_error' : 'gwe.log.k.system';
    return 'gwe.log.k.' + (entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info');
  }

  return {
    TABS, STATES, REASONS, reasonDoc, reasonTopic, parseHash, hashFor, pluginState, boundaryState, pluginControl, summary, capabilityRows, capabilityKeys, needsMqtt,
    memoryHint, ramLabel, EDGE_BASE_MB, PER_PLUGIN_MB,
    ACCOUNTS_MAX, TOPICS_MAX, USER_RE, ACCESS, TEMPLATES, template, usernameProblem, topicOk, plannedTopics, accountBody,
    topicPrefix, brokerAddress, brokerStatus, accountStatus, errorKey, LOG_FILTERS, logLabel, mdnsName, nativeGateway,
  };
});
