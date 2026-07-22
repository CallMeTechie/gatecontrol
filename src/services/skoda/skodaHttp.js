'use strict';

// Minimal in-memory cookie jar + manual redirect follower for the VW identity
// login flow (HTML form posts + 302 chains across hosts). Native fetch has no
// cookie handling, so this exists. Per-login lifetime only, never persisted.

class CookieJar {
  constructor() {
    this.cookies = new Map(); // `${host}|${name}` -> value
  }

  storeFrom(res, url) {
    const getSetCookie = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    const host = new URL(url).host;
    for (const line of getSetCookie) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      this.cookies.set(`${host}|${pair.slice(0, eq).trim()}`, pair.slice(eq + 1).trim());
    }
  }

  headerFor(url) {
    const host = new URL(url).host;
    const parts = [];
    for (const [key, value] of this.cookies) {
      const sep = key.indexOf('|');
      if (key.slice(0, sep) === host) parts.push(`${key.slice(sep + 1)}=${value}`);
    }
    return parts.length ? parts.join('; ') : null;
  }
}

async function requestWithJar(jar, url, opts = {}, fetchImpl = fetch) {
  const headers = { ...(opts.headers || {}) };
  const cookie = jar.headerFor(url);
  if (cookie) headers.cookie = cookie;
  const res = await fetchImpl(url, { ...opts, headers, redirect: 'manual' });
  jar.storeFrom(res, url);
  return res;
}

async function followRedirects(jar, url, opts, { maxHops = 15, stopPrefix = null, fetchImpl = fetch } = {}) {
  let current = url;
  let init = opts || {};
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await requestWithJar(jar, current, init, fetchImpl);
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return { res, location: current };
    const next = /^[a-z][a-z0-9+.-]*:/i.test(loc) ? loc : new URL(loc, current).toString();
    if (stopPrefix && next.startsWith(stopPrefix)) return { res, location: next };
    current = next;
    init = { method: 'GET' };
  }
  throw new Error('too many redirects');
}

module.exports = { CookieJar, requestWithJar, followRedirects };
