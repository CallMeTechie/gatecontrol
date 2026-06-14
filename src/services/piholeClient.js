'use strict';

/**
 * Pi-hole v6 REST client.
 * One client instance per Pi-hole server; caches the session SID.
 */

function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

function assertShape(obj, paths) {
  for (const path of paths) {
    if (getNestedValue(obj, path) === undefined) {
      throw new Error(`unsupported_version: missing ${path}`);
    }
  }
}

function createClient(instance) {
  const baseUrl = (instance.url || '').replace(/\/$/, '');
  const { id, app_password } = instance;
  // verify_tls defaults to true; only explicit false disables it
  const verifyTls = instance.verify_tls !== false;

  let sid = null;
  let authInFlight = null;

  function makeDispatcher() {
    // Only inject a custom dispatcher when TLS verification is disabled AND the
    // URL is HTTPS — for plain HTTP the option has no effect anyway.
    if (!verifyTls && baseUrl.startsWith('https://')) {
      try {
        const { Agent } = require('undici');
        return new Agent({ connect: { rejectUnauthorized: false } });
      } catch (_) {
        // undici not available; fall through to default
      }
    }
    return undefined;
  }

  const dispatcher = makeDispatcher();

  async function doFetch(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const fetchOptions = { ...options };
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }
    return fetch(url, fetchOptions);
  }

  async function authenticate() {
    if (authInFlight) return authInFlight;
    authInFlight = (async () => {
      const res = await doFetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: app_password }),
      });
      if (!res.ok) {
        throw new Error(`pihole_auth_failed:${res.status}`);
      }
      const data = await res.json();
      if (!data?.session?.sid) {
        throw new Error('pihole_auth_no_sid');
      }
      sid = data.session.sid;
      return sid;
    })();
    try {
      return await authInFlight;
    } finally {
      authInFlight = null;
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    if (!sid) {
      await authenticate();
    }

    const headers = { 'X-FTL-SID': sid };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await doFetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      // Re-authenticate once and retry
      sid = null;
      await authenticate();
      const headers2 = { 'X-FTL-SID': sid };
      if (body !== undefined) {
        headers2['Content-Type'] = 'application/json';
      }
      const res2 = await doFetch(path, {
        method,
        headers: headers2,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res2.ok) {
        throw new Error(`pihole_http_${res2.status}`);
      }
      return res2.json();
    }

    if (!res.ok) {
      throw new Error(`pihole_http_${res.status}`);
    }

    return res.json();
  }

  // --- Public API ---

  async function getSummary() {
    const p = await request('/api/padd');
    // Only the ESSENTIAL required paths are hard-asserted (queries.*). gravity_size/active_clients
    // can be absent on a fresh/empty Pi-hole → default instead of throwing unsupported_version.
    assertShape(p, ['queries.total', 'queries.blocked']);
    return {
      queries: { total: p.queries.total, blocked: p.queries.blocked },
      gravity: { domains_being_blocked: p.gravity_size ?? 0 },
      clients: { active: p.active_clients ?? 0 },
    };
  }

  async function getHistory() {
    const r = await request('/api/history');
    return (r.history || []).map(h => ({
      t: h.timestamp,
      allowed: Math.max(0, (h.total || 0) - (h.blocked || 0)),
      blocked: h.blocked || 0,
    }));
  }

  async function getTopDomains(blocked = false) {
    const r = await request(`/api/stats/top_domains${blocked ? '?blocked=true' : ''}`);
    return (r.domains || []).map(d => ({ domain: d.domain, count: d.count }));
  }

  async function getTopClients(blocked = false) {
    const r = await request(`/api/stats/top_clients${blocked ? '?blocked=true' : ''}`);
    return (r.clients || []).map(c => ({ ip: c.ip, count: c.count }));
  }

  async function getQueryTypes() {
    const r = await request('/api/stats/query_types');
    return r.types || {};
  }

  async function getBlocking() {
    const r = await request('/api/dns/blocking');
    return { blocking: r.blocking === 'enabled', timer: (r.timer ?? null) };
  }

  function setBlocking(enabled, timer) {
    const bodyObj = { blocking: enabled, ...(timer != null ? { timer } : {}) };
    return request('/api/dns/blocking', { method: 'POST', body: bodyObj });
  }

  function getVersion() {
    return request('/api/info/version');
  }

  async function logout() {
    if (!sid) return;
    try {
      await doFetch('/api/auth', { method: 'DELETE', headers: { 'X-FTL-SID': sid } });
    } catch { /* best effort */ }
    sid = null;
  }

  async function testConnection() {
    await authenticate();
    try {
      const v = await getVersion();
      return {
        connected: true,
        version: v?.version?.core?.local?.version || null,
      };
    } finally {
      await logout();
    }
  }

  return {
    id,
    getSummary,
    getHistory,
    getTopDomains,
    getTopClients,
    getQueryTypes,
    getBlocking,
    setBlocking,
    getVersion,
    testConnection,
  };
}

module.exports = { createClient };
