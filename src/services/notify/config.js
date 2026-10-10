'use strict';

// Settings of the notification center (key/value settings table, `notify.*`;
// none of them is on the public allowlist). GET/PUT /api/v1/notify/settings.

const settings = require('../settings');

const DEFAULTS = {
  enabled: true,
  retention_h: 72,
  history_days: 30,
  max_queue: 200,
  keepalive_s: 25,
  allow_direct: true,
  email_fallback_s: 600,
  max_streams: 500,
};

// Integer settings: [min, max].
const RANGES = {
  retention_h: [1, 720],
  history_days: [1, 365],
  max_queue: [10, 1000],
  keepalive_s: [10, 300],
  email_fallback_s: [0, 86400],
  max_streams: [1, 10000],
};
const BOOLEANS = ['enabled', 'allow_direct'];

const key = (k) => `notify.${k}`;

function readInt(k) {
  const raw = settings.get(key(k), null);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  const [min, max] = RANGES[k];
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : DEFAULTS[k];
}

function readBool(k) {
  const raw = settings.get(key(k), null);
  if (raw == null) return DEFAULTS[k];
  return raw === '1' || raw === 'true';
}

/** All settings with defaults filled in. */
function get() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = BOOLEANS.includes(k) ? readBool(k) : readInt(k);
  return out;
}

function value(k) { return BOOLEANS.includes(k) ? readBool(k) : readInt(k); }

/** Store already validated values ({ key: int|bool }). */
function set(values) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFAULTS)) continue;
    settings.set(key(k), BOOLEANS.includes(k) ? (v ? '1' : '0') : String(v));
  }
  return get();
}

module.exports = { DEFAULTS, RANGES, BOOLEANS, get, set, value };
