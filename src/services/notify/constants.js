'use strict';

// Notification center — shared constants (docs/feature-notification-center.md).

const PRIORITIES = ['info', 'normal', 'high', 'critical'];
const PRIORITY_RANK = { info: 0, normal: 1, high: 2, critical: 3 };

// System topics. `system` is admin-only like `security` (server restarts,
// backups, updates, resources); `admin_notice` (manual messages, tests) is
// always delivered and cannot be unsubscribed.
const CORE_TOPICS = ['security', 'devices', 'services', 'system', 'admin_notice'];
const ADMIN_ONLY_TOPICS = new Set(['security', 'system']);
const LOCKED_TOPICS = new Set(['admin_notice']);

// CATALOGUE group → topic.
const GROUP_TOPIC = { security: 'security', peers: 'devices', routes: 'services', system: 'system' };

// Plugin topic ids (plugin.json notifyTopics[].id) and the full topic name.
const PLUGIN_TOPIC_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TOPIC_RE = /^(?:security|devices|services|system|admin_notice|plugin:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z][a-z0-9_-]{0,31})$/;

const DELIVERY_STATES = ['queued', 'sent', 'delivered', 'read', 'dismissed', 'expired', 'suppressed'];
const ACK_STATES = ['delivered', 'read', 'dismissed'];
const RECOVERY_MODES = ['off', 'silent', 'normal'];

// Actions a notification may carry (fixed list, docs "Sicherheit").
const ACTION_TYPES = new Set(['open_app_route', 'open_portal', 'mute_1h', 'ack', 'done']);
const APP_ROUTE_RE = /^(?:vpn|services|gateways|inbox|plg-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

const LIMITS = {
  title: 120,
  body: 1000,
  dataBytes: 4096,
  ackSeqs: 200,
  inbox: 100,
  mutedTopics: 100,
  actions: 4,
  collapseKey: 120,
};

const ENDPOINT = '/api/v1/client/push';

module.exports = {
  PRIORITIES, PRIORITY_RANK, CORE_TOPICS, ADMIN_ONLY_TOPICS, LOCKED_TOPICS, GROUP_TOPIC,
  PLUGIN_TOPIC_ID_RE, TOPIC_RE, DELIVERY_STATES, ACK_STATES, RECOVERY_MODES,
  ACTION_TYPES, APP_ROUTE_RE, LIMITS, ENDPOINT,
};
