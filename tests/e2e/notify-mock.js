'use strict';

// Answers of the notification centre admin API (/api/v1/notify/*) for the
// browser scenario 09-notifications.js. The page only consumes that API; the
// scenario serves it through page.route(), so it runs against any server —
// with or without the backend of the notification centre. Shapes follow the
// contract in docs/feature-notification-center.md (admin API).

const MIN = 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const isoIn = (msAhead) => new Date(Date.now() + msAhead).toISOString();

function rule(event_id, group, label, priority, recipients, ch, extra) {
  return Object.assign({
    event_id, group, label, priority,
    recipients: Object.assign({ admins: false, owner: false, subscribers: false, users: [], groups: [] }, recipients),
    ch_app: ch[0], ch_email: ch[1], ch_webhook: ch[2],
    email_fallback_s: 600, delay_s: 0, bundle_s: 0, recovery: 'off', enabled: true, plugin_id: null,
  }, extra || {});
}

function create(opts) {
  const pro = !(opts && opts.pro === false);
  const users = [{ id: 1, name: 'Markus' }, { id: 3, name: 'Sabine' }, { id: 4, name: 'Tom' }];
  const groups = [{ id: 7, name: 'IT' }, { id: 8, name: 'Haushalt' }];
  const rules = [
    rule('login_failed', 'security', 'Mehrere fehlgeschlagene Logins', 'high', { admins: true }, [true, true, false]),
    rule('waf_blocked', 'security', 'IP durch WAF gesperrt', 'high', { admins: true }, [true, false, true], { bundle_s: 900 }),
    rule('account_locked', 'security', 'Konto gesperrt', 'critical', { admins: true, owner: true }, [true, true, false]),
    rule('gateway_offline', 'peers', 'Gateway offline', 'critical', { admins: true, groups: [7] }, [true, true, false], { delay_s: 120, bundle_s: 900, recovery: 'silent' }),
    rule('peer_expiring', 'peers', 'Gerät läuft bald ab', 'normal', { owner: true }, [true, true, false]),
    rule('peer_created', 'peers', 'Neues Gerät eingerichtet', 'info', { admins: true }, [true, false, false]),
    rule('route_down', 'routes', 'Route nicht erreichbar', 'high', { admins: true }, [true, true, true]),
    rule('cert_expiring', 'routes', 'Zertifikat läuft ab', 'high', { admins: true }, [true, true, false]),
    rule('update_available', 'system', 'Update verfügbar / installiert', 'info', { admins: true }, [true, true, false]),
    rule('resource_alert', 'system', 'CPU, RAM oder Festplatte über Grenzwert', 'high', { admins: true }, [true, true, false], { enabled: false }),
    rule('plugin:gatecontrol-skoda:charging', 'plugins', 'Fahrzeuge · Laden abgeschlossen', 'normal', { subscribers: true }, [true, false, false], { plugin_id: 'gatecontrol-skoda' }),
    rule('plugin:gatecontrol-waste:reminder', 'plugins', 'Müllabfuhr · Erinnerung am Vorabend', 'info', { groups: [8] }, [true, false, false], { plugin_id: 'gatecontrol-waste' }),
  ];
  const devices = [
    { token_id: 11, name: 'Pixel 8', user: { id: 1, name: 'Markus', role: 'admin' }, platform: 'android', client_type: 'android', app_version: '1.18', state: 'connected', via: 'direct', connected_since: iso(134 * MIN), last_seen: iso(3000), queued: 0, last_ack_at: iso(3000), buffer_until: null },
    { token_id: 12, name: 'Laptop-Büro', user: { id: 1, name: 'Markus', role: 'admin' }, platform: 'windows', client_type: 'pro', app_version: '2.4', state: 'connected', via: 'tunnel', connected_since: iso(360 * MIN), last_seen: iso(12000), queued: 0, last_ack_at: iso(12000), buffer_until: null },
    { token_id: 13, name: 'Galaxy A54', user: { id: 3, name: 'Sabine', role: 'user' }, platform: 'android', client_type: 'android', app_version: '1.18', state: 'connected', via: 'direct', connected_since: iso(26 * 60 * MIN), last_seen: iso(41000), queued: 0, last_ack_at: iso(41000), buffer_until: null },
    { token_id: 14, name: 'Tablet Kinder', user: { id: 5, name: 'Haushalt (geteilt)', role: 'user' }, platform: 'android', client_type: 'android', app_version: '1.17', state: 'restricted', via: 'direct', connected_since: iso(50 * MIN), last_seen: iso(9 * MIN), queued: 1, last_ack_at: iso(9 * MIN), buffer_until: null },
    { token_id: 15, name: 'PC-Wohnzimmer', user: { id: 3, name: 'Sabine', role: 'user' }, platform: 'windows', client_type: 'community', app_version: '2.4', state: 'offline', via: null, connected_since: null, last_seen: iso(120 * MIN), queued: 2, last_ack_at: iso(26 * 60 * MIN), buffer_until: isoIn(70 * 60 * MIN) },
    { token_id: 16, name: 'iPhone Gast', user: { id: 4, name: 'Tom', role: 'user' }, platform: 'ios', client_type: 'wireguard', app_version: '', state: 'unsupported', via: null, connected_since: null, last_seen: null, queued: 0, last_ack_at: null, buffer_until: null },
  ];
  const items = [
    { id: 108, title: 'Gateway „Zuhause“ wieder online', body: 'Wieder erreichbar nach 2 Minuten.', event_id: 'gateway_offline', source: 'system', topic: 'devices', priority: 'info', created_at: iso(2 * MIN), delivered: 3, total: 3, read: 0, recipients_label: 'Alle Admins', silent: true, status: 'ok' },
    { id: 107, title: 'Gateway „Zuhause“ ist offline', body: 'Seit 2 Min. ohne Lebenszeichen.', event_id: 'gateway_offline', source: 'system', topic: 'devices', priority: 'critical', created_at: iso(4 * MIN), delivered: 3, total: 3, read: 3, recipients_label: 'Alle Admins', silent: false, status: 'ok' },
    { id: 106, title: 'IP 185.220.101.4 durch WAF gesperrt', body: '14 Treffer auf nas.example.com', event_id: 'waf_blocked', source: 'system', topic: 'security', priority: 'high', created_at: iso(32 * MIN), delivered: 3, total: 3, read: 1, recipients_label: 'Alle Admins', silent: false, status: 'ok' },
    { id: 105, title: 'Škoda Enyaq: Laden abgeschlossen (80 %)', body: 'Enyaq · 80 % · ca. 390 km', event_id: 'plugin:gatecontrol-skoda:charging', topic: 'plugin:gatecontrol-skoda:charging', source: 'plugin:gatecontrol-skoda', priority: 'normal', created_at: iso(46 * MIN), delivered: 2, total: 2, read: 2, recipients_label: 'Markus', silent: false, status: 'ok' },
    { id: 104, title: 'Morgen: Gelber Sack', body: 'Erinnerung 18:00', event_id: 'plugin:gatecontrol-waste:reminder', topic: 'plugin:gatecontrol-waste:reminder', source: 'plugin:gatecontrol-waste', priority: 'info', created_at: iso(3 * 60 * MIN), delivered: 4, total: 5, read: 2, recipients_label: 'Gruppe „Haushalt“', silent: false, status: 'waiting' },
    { id: 103, title: 'Wartung heute Abend', body: 'Zwischen 22 und 23 Uhr startet der Server neu.', event_id: null, source: 'manual:1', topic: 'admin_notice', priority: 'normal', created_at: iso(4 * 60 * MIN), delivered: 4, total: 4, read: 3, recipients_label: 'Sabine, Markus', silent: false, status: 'ok' },
    { id: 102, title: 'Zertifikat für portal.example.com läuft in 7 Tagen ab', body: 'Automatische Erneuerung schlug fehl.', event_id: 'cert_expiring', source: 'system', topic: 'services', priority: 'high', created_at: iso(12 * 60 * MIN), delivered: 3, total: 3, read: 3, recipients_label: 'Alle Admins', silent: false, status: 'ok' },
    { id: 101, title: 'Offsite-Backup erfolgreich (1,8 GB)', body: '', event_id: 'backup_ok', source: 'system', topic: 'system', priority: 'info', created_at: iso(20 * 60 * MIN), delivered: 0, total: 0, read: 0, recipients_label: 'Alle Admins', silent: true, status: 'ok' },
  ];
  const settings = { enabled: true, retention_h: 72, history_days: 30, max_queue: 200, keepalive_s: 25, allow_direct: true, email_fallback_s: 600, max_streams: 500 };

  const calls = [];
  const state = { pro, users, groups, rules, devices, items, settings, calls, unavailable: false };

  function overview() {
    return {
      kpis: { devices_connected: 4, devices_total: 6, direct: 3, tunnel: 1, delivered_24h: 142, read_24h: 118, queued: 3, queued_devices: 2, failed_7d: 0, median_latency_ms: 400 },
      recent: items.slice(1, 7).map((x) => ({ id: x.id, title: x.title, event_id: x.event_id, topic: x.topic, priority: x.priority, source: x.source, created_at: x.created_at, recipients_label: x.recipients_label, delivered: x.delivered, total: x.total, read: x.read, silent: x.silent })),
      hub: { enabled: settings.enabled, endpoint: '/api/v1/client/push', keepalive_s: settings.keepalive_s, retention_h: settings.retention_h, max_queue: settings.max_queue, allow_direct: settings.allow_direct },
      sources: [{ id: 'security', count: 41 }, { id: 'devices', count: 29 }, { id: 'services', count: 12 }, { id: 'system', count: 9 }, { id: 'plugins', count: 23 }],
    };
  }
  function detail(id) {
    const n = items.find((x) => String(x.id) === String(id));
    if (!n) return null;
    const t0 = new Date(n.created_at).getTime();
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    return {
      notification: n,
      timeline: [
        { at: at(0), kind: 'created', text: 'Erstellt für 3 Geräte' },
        { at: at(0.1), kind: 'sent', text: 'An 3 Geräte gesendet' },
        { at: at(0.3), kind: 'delivered', text: '3 Geräte haben bestätigt' },
        { at: at(67), kind: 'read', text: '2 Geräte haben geöffnet' },
      ],
      deliveries: [
        { token_id: 11, device_name: 'Pixel 8', user_name: 'Markus', state: 'read', via: 'direct', queued_at: at(0), sent_at: at(0.1), delivered_at: at(0.3), read_at: at(67), latency_ms: 300, action: 'Details' },
        { token_id: 12, device_name: 'Laptop-Büro', user_name: 'Markus', state: 'read', via: 'tunnel', queued_at: at(0), sent_at: at(0.1), delivered_at: at(0.6), read_at: at(70), latency_ms: 600, action: null },
        { token_id: 13, device_name: 'Galaxy A54', user_name: 'Sabine', state: 'delivered', via: 'direct', queued_at: at(0), sent_at: at(0.1), delivered_at: at(0.4), read_at: null, latency_ms: 400, action: null },
      ],
      email: { sent: false, at: null },
    };
  }
  // Like the real API: every success carries ok:true.
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? Object.assign({ ok: true }, body) : body) });
  const licensed = (route) => json(route, 403, { ok: false, error: 'Feature not available in your plan', feature: 'email_alerts' });

  /** page.route handler for /api/v1/notify/** */
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1\/notify/, '');
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = null; }
    calls.push({ method, path, query: url.search, body });
    if (state.unavailable) return json(route, 404, { ok: false, error: 'Not found' });

    if (method === 'GET' && path === '/overview') return json(route, 200, overview());
    if (method === 'GET' && path === '/rules') return json(route, 200, { rules, users, groups, webhooks_count: 1, pro: state.pro });
    let m = /^\/rules\/(.+)$/.exec(path);
    if (method === 'PUT' && m) {
      const id = decodeURIComponent(m[1]);
      const r = rules.find((x) => x.event_id === id);
      if (!r) return json(route, 404, { ok: false, error: 'unknown event' });
      if (!state.pro && (r.plugin_id || (body.recipients && ((body.recipients.users || []).length || (body.recipients.groups || []).length)))) return licensed(route);
      Object.assign(r, body);
      return json(route, 200, { ok: true, rule: r });
    }
    if (method === 'GET' && path === '/devices') return json(route, 200, { devices });
    if (method === 'POST' && path === '/send') {
      if (!state.pro) return licensed(route);
      const id = 200 + calls.length;
      items.unshift({ id, title: body.title, body: body.body, event_id: 'manual', source: 'manual:1', topic: 'admin_notice', priority: body.priority, created_at: new Date().toISOString(), delivered: 0, total: 2, read: 0, recipients_label: 'manual', silent: false, status: 'waiting' });
      return json(route, 200, { ok: true, notification_id: id, devices_now: 2, devices_later: 1 });
    }
    if (method === 'POST' && path === '/test') return json(route, 200, { ok: true, devices: 2 });
    if (method === 'GET' && path === '/history') {
      const f = url.searchParams.get('filter') || 'all';
      const before = url.searchParams.get('before');
      let list = items.slice();
      if (f === 'important') list = list.filter((x) => x.priority === 'critical' || x.priority === 'high');
      if (f === 'undelivered') list = list.filter((x) => x.delivered < x.total);
      if (f === 'plugins') list = list.filter((x) => /^plugin/.test(x.source));
      if (f === 'manual') list = list.filter((x) => /^manual:/.test(x.source));
      if (before) list = list.filter((x) => x.id < Number(before));
      const page = list.slice(0, 5);
      return json(route, 200, { items: page, next_before: list.length > 5 ? page[page.length - 1].id : null });
    }
    m = /^\/history\/(\d+)(\/resend)?$/.exec(path);
    if (m && method === 'GET' && !m[2]) { const d = detail(m[1]); return d ? json(route, 200, d) : json(route, 404, { ok: false }); }
    if (m && method === 'POST' && m[2]) return json(route, 200, { ok: true });
    if (path === '/settings' && method === 'GET') return json(route, 200, settings);
    if (path === '/settings' && method === 'PUT') { Object.assign(settings, body); return json(route, 200, Object.assign({ ok: true }, settings)); }
    return json(route, 404, { ok: false, error: 'Not found' });
  }
  return { state, handle, calls };
}

module.exports = { create };
