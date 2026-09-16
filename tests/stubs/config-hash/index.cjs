'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  TEST-STUB — NICHT das echte @callmetechie/gatecontrol-config-hash
// ─────────────────────────────────────────────────────────────────────────────
//
// Das echte Paket liegt in der privaten GitHub-Registry; ohne Token bricht
// `npm ci` mit E401 ab und nichts im Repo läuft. Damit auch jemand ohne
// Zugriff die Testsuite fahren kann, legt `npm run test:config-hash-stub`
// (scripts/install-config-hash-stub.js) diese Datei als Paket in
// node_modules ab.
//
// Der Stub bildet den in der README des Pakets beschriebenen Algorithmus nach
// (RFC 8785 JCS + die dort genannten Erweiterungen: Schlüssel sortiert,
// Arrays nach kanonischem Text sortiert, null/undefined fallen weg, keine
// Exponentialschreibweise, Ausgabe `sha256:` + 64 Hex). Er ist ein Ersatz für
// den ENTWICKLERRECHNER, keine zweite Quelle der Wahrheit:
//
//   * Die CI installiert immer das echte Paket (Job „test“ mit
//     NODE_AUTH_TOKEN) — tests/config_hash_stub_guard.test.js schlägt fehl,
//     wenn in der CI trotzdem der Stub geladen ist.
//   * `require` wirft ausserhalb von NODE_ENV=test. Ein Server, der mit dem
//     Stub startet, würde Gateways Hashes liefern, die niemand nachrechnen
//     kann — das muss knallen, nicht durchrutschen.
//   * `src/` bekommt keinen Fallback: Produktionscode kennt den Stub nicht.
//
// Wer Hashes gegen ein echtes Gateway vergleichen will, braucht das echte
// Paket. Für alles, was die Testsuite prüft (Selbstkonsistenz von
// gateways.computeConfigHash, Hash-Format, Schema-Strip, CONFIG_HASH_VERSION),
// genügt der Stub.

if (process.env.NODE_ENV !== 'test') {
  throw new Error(
    '@callmetechie/gatecontrol-config-hash: this is the TEST STUB from tests/stubs/config-hash '
    + '(installed by scripts/install-config-hash-stub.js), not the real package. It refuses to load '
    + `outside NODE_ENV=test (got ${JSON.stringify(process.env.NODE_ENV)}). `
    + 'Install the real package with a GH_PACKAGES_TOKEN — see docs/testing-local.md.'
  );
}

const { createHash } = require('node:crypto');

const CONFIG_HASH_VERSION = 2;

// ─── Kanonisierung ──────────────────────────────────────────────────────────

function canonicalizeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += '\\\\';
    else if (c === 8) out += '\\b';
    else if (c === 9) out += '\\t';
    else if (c === 10) out += '\\n';
    else if (c === 12) out += '\\f';
    else if (c === 13) out += '\\r';
    else if (c < 32 || (c >= 0xd800 && c <= 0xdfff)) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out + '"';
}

function canonicalizeNumber(n) {
  if (Number.isNaN(n)) throw new Error('NaN is not allowed in canonicalized JSON');
  if (!Number.isFinite(n)) throw new Error('Infinity is not allowed in canonicalized JSON');
  if (Number.isInteger(n)) {
    if (Math.abs(n) >= 1e21) throw new Error(`Number ${n} is outside safe integer range`);
    return n.toString(10);
  }
  const str = n.toString(10);
  if (/[eE]/.test(str)) throw new Error(`Number ${n} serializes to exponential notation (${str})`);
  return str;
}

/** null/undefined → null (der Aufrufer lässt den Eintrag dann weg). */
function canonicalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return canonicalizeString(v);
  if (typeof v === 'number') return canonicalizeNumber(v);
  if (Array.isArray(v)) {
    const rendered = [];
    for (const item of v) {
      const r = canonicalizeValue(item);
      if (r !== null) rendered.push(r);
    }
    rendered.sort();
    return '[' + rendered.join(',') + ']';
  }
  if (typeof v === 'object') {
    const parts = [];
    for (const key of Object.keys(v).sort()) {
      const r = canonicalizeValue(v[key]);
      if (r !== null) parts.push(`${canonicalizeString(key)}:${r}`);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`Unsupported value type: ${typeof v}`);
}

function canonicalize(v) {
  const r = canonicalizeValue(v);
  return r === null ? '' : r;
}

function computeHash(value) {
  if (value === null || value === undefined) {
    throw new Error('computeHash: null/undefined input not allowed');
  }
  return 'sha256:' + createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

// ─── Schema (zod-frei nachgebildet: .strip() + Vorgabewerte) ────────────────

class ConfigSchemaError extends Error {
  constructor(issues) {
    super('GatewayConfig validation failed: ' + issues.join('; '));
    this.name = 'ConfigSchemaError';
    this.issues = issues;
  }
}

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isPort = (v) => isInt(v) && v >= 1 && v <= 65535;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const nullish = (v) => v === null || v === undefined;

/**
 * Nimmt nur die bekannten Felder (strip), setzt Vorgabewerte und prüft die
 * Typen. Unbekannte Schlüssel — z. B. backend_https oder
 * backend_tls_fingerprint — fallen hier heraus und gehen damit nicht in den
 * Hash ein; genau darauf verlässt sich src/services/gateways.js.
 */
function shape(obj, fields, where, issues) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    issues.push(`${where}: expected object`);
    return {};
  }
  const out = {};
  for (const [name, spec] of Object.entries(fields)) {
    let v = obj[name];
    if (nullish(v)) {
      if (spec.default !== undefined) v = spec.default;
      else if (spec.optional) continue;
      else { issues.push(`${where}.${name}: required`); continue; }
    }
    if (!spec.check(v)) { issues.push(`${where}.${name}: invalid (${JSON.stringify(v)})`); continue; }
    out[name] = v;
  }
  return out;
}

const HTTP_ROUTE = {
  id: { check: (v) => isInt(v) && v > 0 },
  domain: { check: isStr },
  target_kind: { check: (v) => v === 'peer' || v === 'gateway' },
  target_lan_host: { check: isStr, optional: true },
  target_lan_port: { check: isPort, optional: true },
  protocol: { check: (v) => v === 'http' || v === 'https', default: 'http' },
  wol_enabled: { check: (v) => typeof v === 'boolean', default: false },
  wol_mac: { check: (v) => isStr(v) && MAC_RE.test(v), optional: true },
};

const L4_ROUTE = {
  id: { check: (v) => isInt(v) && v > 0 },
  listen_port: { check: isPort },
  target_lan_host: { check: isStr },
  target_lan_port: { check: isPort },
  wol_enabled: { check: (v) => typeof v === 'boolean', default: false },
  wol_mac: { check: (v) => isStr(v) && MAC_RE.test(v), optional: true },
};

const EGRESS_ROUTE = {
  id: { check: (v) => isInt(v) && v > 0 },
  vip_ip: { check: isStr },
  vip_prefix: { check: (v) => isInt(v) && v >= 0 && v <= 32, default: 24 },
  lan_listen_port: { check: isPort },
  tunnel_target_host: { check: isStr },
  tunnel_target_port: { check: isPort },
  allowed_source_ips: { check: (v) => Array.isArray(v) && v.every((x) => isStr(x) && CIDR_RE.test(x)), default: [] },
  near_peers: { check: (v) => Array.isArray(v) && v.every(isStr), default: [] },
};

const GatewayConfigSchema = {
  parse(raw) {
    const issues = [];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigSchemaError(['expected object']);
    const list = (key, fields) => {
      const arr = nullish(raw[key]) ? [] : raw[key];
      if (!Array.isArray(arr)) { issues.push(`${key}: expected array`); return []; }
      return arr.map((item, i) => shape(item, fields, `${key}[${i}]`, issues));
    };
    const out = {
      config_hash_version: raw.config_hash_version,
      peer_id: raw.peer_id,
      routes: list('routes', HTTP_ROUTE),
      l4_routes: list('l4_routes', L4_ROUTE),
      egress_routes: list('egress_routes', EGRESS_ROUTE),
    };
    if (!isInt(out.config_hash_version) || out.config_hash_version < 1) issues.push('config_hash_version: invalid');
    if (!isInt(out.peer_id) || out.peer_id <= 0) issues.push('peer_id: invalid');
    if (issues.length) throw new ConfigSchemaError(issues);
    return out;
  },
};

function computeConfigHash(rawConfig) {
  return computeHash(GatewayConfigSchema.parse(rawConfig));
}

// Nicht nachgebildet: der WireGuard-Konfigurationsprüfer. Er wird im
// Server-Repo nirgends aufgerufen; ein Aufruf soll auffallen, nicht ein
// falsches „ok“ liefern.
function validateWgConfig() {
  throw new Error('validateWgConfig is not available in the config-hash TEST STUB — install the real package.');
}

module.exports = {
  CONFIG_HASH_VERSION,
  GatewayConfigSchema,
  canonicalize,
  canonicalizeValue,
  computeConfigHash,
  computeHash,
  validateWgConfig,
  // Kennzeichen für tests/config_hash_stub_guard.test.js.
  __isTestStub: true,
};
