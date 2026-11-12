'use strict';

// Statistik für den 5-Min.-Bericht (Vertrag Phase 3b §1.2):
// { period: {from,to}, queries, blocked, cached, avgMs, topBlocked (≤ 20),
//   byProfile, clientsSeen } – keine Domains je Client.
// Scheitert ein Bericht, wird der Zeitraum mit dem nächsten zusammengelegt.

const MAX_TOP_KEYS = 4096;
const MAX_CLIENTS = 1024;
const TOP_N = 20;

function emptyPeriod(from) {
  return { from, queries: 0, blocked: 0, cached: 0, msSum: 0, top: new Map(), byProfile: new Map(), clients: new Set() };
}

class DnsStats {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.cur = emptyPeriod(now());
    this.total = { queries: 0, blocked: 0, cached: 0, since: now() };
  }

  record({ profileId = null, mac = null, blocked = false, cached = false, ms = 0, domain = null }) {
    const p = this.cur;
    p.queries++;
    this.total.queries++;
    p.msSum += ms;
    if (cached) { p.cached++; this.total.cached++; }
    const key = profileId || '';
    let bp = p.byProfile.get(key);
    if (!bp) { bp = { queries: 0, blocked: 0 }; p.byProfile.set(key, bp); }
    bp.queries++;
    if (blocked) {
      p.blocked++;
      this.total.blocked++;
      bp.blocked++;
      if (domain) {
        const k = `${domain}\n${key}`;
        const e = p.top.get(k);
        if (e) e.count++;
        else {
          p.top.set(k, { domain, count: 1, profileId });
          if (p.top.size > MAX_TOP_KEYS) this._pruneTop(p);
        }
      }
    }
    if (mac && p.clients.size < MAX_CLIENTS) p.clients.add(mac);
  }

  _pruneTop(p) {
    const keep = [...p.top.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_TOP_KEYS * 3 / 4);
    p.top = new Map(keep);
  }

  /** Aktuellen Zeitraum abschließen → { body, period } ; neuer Zeitraum beginnt. */
  take() {
    const p = this.cur;
    const to = this.now();
    this.cur = emptyPeriod(to);
    const byProfile = {};
    for (const [id, v] of p.byProfile) if (id) byProfile[id] = { ...v };
    const topBlocked = [...p.top.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
      .slice(0, TOP_N).map((e) => ({ domain: e.domain, count: e.count, profileId: e.profileId }));
    const body = {
      period: { from: p.from, to },
      queries: p.queries,
      blocked: p.blocked,
      cached: p.cached,
      avgMs: p.queries ? Math.round((p.msSum / p.queries) * 10) / 10 : null,
      topBlocked,
      byProfile,
      clientsSeen: [...p.clients].sort(),
    };
    return { body, period: p };
  }

  /** Nicht zugestellten Zeitraum zurücklegen (wird mit dem laufenden zusammengelegt). */
  giveBack(old) {
    const c = this.cur;
    c.from = Math.min(c.from, old.from);
    c.queries += old.queries;
    c.blocked += old.blocked;
    c.cached += old.cached;
    c.msSum += old.msSum;
    for (const [k, v] of old.top) {
      const e = c.top.get(k);
      if (e) e.count += v.count; else c.top.set(k, { ...v });
    }
    if (c.top.size > MAX_TOP_KEYS) this._pruneTop(c);
    for (const [k, v] of old.byProfile) {
      const e = c.byProfile.get(k);
      if (e) { e.queries += v.queries; e.blocked += v.blocked; } else c.byProfile.set(k, { ...v });
    }
    for (const m of old.clients) if (c.clients.size < MAX_CLIENTS) c.clients.add(m);
  }
}

module.exports = { DnsStats, TOP_N };
