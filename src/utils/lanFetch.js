'use strict';

/**
 * fetch() für admin-konfigurierte LAN-Integrationen (Pi-hole).
 *
 * Anders als Webhooks (utils/outboundGuard.js) zeigen diese URLs absichtlich
 * ins LAN — und wegen `network_mode: host` unter Umständen auch auf
 * 127.0.0.1 (Pi-hole auf demselben Host). Das konfigurierte Ziel selbst
 * bleibt deshalb erlaubt: der Admin hat es gewählt.
 *
 * Was verhindert wird: dass das Gerät hinter der URL (kompromittiert oder
 * gefälscht) den Server per HTTP-Redirect auf andere interne Endpunkte
 * umlenkt, etwa die Caddy-Admin-API auf 127.0.0.1:2019 oder Cloud-Metadaten.
 *
 *   - Redirects werden nie automatisch verfolgt (`redirect: 'manual'`).
 *   - Ein Redirect auf denselben Origin (Schema + Host + Port) wird höchstens
 *     `maxRedirects`-mal verfolgt. Zusätzlich erlaubt ist genau das
 *     Schema-Upgrade http://host(:80) → https://host(:443) auf demselben
 *     Hostnamen (Pi-hole v6 und manche Reverse-Proxies leiten so um).
 *     Alles andere — fremder Host oder Port, https → http — ist ein Fehler.
 *   - Bekannte Cloud-Metadaten-Adressen sind als Ziel immer gesperrt
 *     (nur als IP-Literal — ein Hostname, der dorthin auflöst, wäre eine
 *     bewusste Admin-Konfiguration, und Redirects dorthin sind ohnehin
 *     cross-origin).
 */

const net = require('node:net');

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

class LanFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LanFetchError';
    this.code = code;
  }
}

function normalizeHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv6(h)) {
    // IPv4-mapped (::ffff:169.254.169.254 → WHATWG-URL: ::ffff:a9fe:a9fe)
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    const d = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (d) return d[1];
    // kanonische Kurzform, damit fd00:ec2:0::254 u. ä. ebenfalls greift
    try { return new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { return h; }
  }
  return h;
}

function isMetadataHost(hostname) {
  return METADATA_HOSTS.has(normalizeHost(hostname));
}

function parseTarget(url, label) {
  let u;
  try { u = new URL(url); } catch {
    throw new LanFetchError(`${label}_invalid_url`, 'LAN_INVALID_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new LanFetchError(`${label}_invalid_protocol`, 'LAN_INVALID_PROTOCOL');
  }
  if (isMetadataHost(u.hostname)) {
    throw new LanFetchError(`${label}_target_forbidden`, 'LAN_TARGET_FORBIDDEN');
  }
  return u;
}

/** Erlaubter Hop: gleicher Origin oder http:80 → https:443 auf demselben Host. */
function isAllowedHop(from, to) {
  if (to.origin === from.origin) return true;
  return from.protocol === 'http:' && to.protocol === 'https:'
    && from.hostname === to.hostname
    && from.port === '' && to.port === ''; // WHATWG-URL normalisiert :80/:443 zu ''
}

function discardBody(res) {
  try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => { /* body already consumed/closed — nothing to discard */ }); } catch { /* ignore */ }
}

/**
 * @param {string} url
 * @param {object} [options] fetch-Optionen (method, headers, body, dispatcher, signal …)
 * @param {object} [opts]
 * @param {number} [opts.maxRedirects=3] erlaubte Same-Origin-Redirects
 * @param {string} [opts.label='lan'] Präfix der Fehlermeldungen
 */
async function lanFetch(url, options = {}, { maxRedirects = DEFAULT_MAX_REDIRECTS, label = 'lan' } = {}) {
  parseTarget(url, label);
  let current = String(url);
  let init = { ...options, redirect: 'manual' };

  for (let hop = 0; ; hop++) {
    const res = await fetch(current, init);
    const location = REDIRECT_STATUSES.has(res.status) && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('location')
      : null;
    if (!location) return res;

    discardBody(res);
    const from = new URL(current);
    let next;
    try { next = new URL(location, current); } catch {
      throw new LanFetchError(`${label}_redirect_invalid`, 'LAN_REDIRECT_INVALID');
    }
    if (!isAllowedHop(from, next)) {
      throw new LanFetchError(
        `${label}_redirect_blocked: ${res.status} to ${next.origin} (enter the final URL)`,
        'LAN_REDIRECT_CROSS_ORIGIN',
      );
    }
    if (hop >= maxRedirects) {
      throw new LanFetchError(`${label}_too_many_redirects`, 'LAN_TOO_MANY_REDIRECTS');
    }
    // Fetch-Semantik: 303 immer, 301/302 bei POST → GET ohne Body.
    const method = String(init.method || 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      init = { ...init, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined };
    }
    current = next.href;
  }
}

module.exports = { lanFetch, LanFetchError, isMetadataHost, isAllowedHop, DEFAULT_MAX_REDIRECTS };
