'use strict';

// Ablauf einer Anfrage: zerlegen → Client (MAC) → Entscheidung → gesperrte
// Antwort, sichere Suche oder Weiterleitung (mit Zwischenspeicher und
// Bündelung gleicher Anfragen). Liefert die Antwort als Buffer oder null
// (verwerfen).
//
// Wer der Client ist, wird eingesteckt:
//   neighbors.macFor(ip)  – Gateway: MAC zur Absender-Adresse
//   clientFor(ip)         – allgemein: Schlüssel zur Client-Adresse (oder null)
//   ecsClient             – Client-Adresse aus EDNS Client Subnet statt vom
//                           Absender (Standard aus). Für Resolver hinter einem
//                           Weiterleiter, der die echte Adresse anhängt
//                           (dnsmasq `add-subnet=32,128`). `true` = nur von
//                           Loopback-Absendern annehmen, Funktion (ip) → bool
//                           = selbst entscheiden. Gilt nur für volle Adressen
//                           (/32 bzw. /128); sonst zählt der Absender.
//                           Ohne `clientFor` ist die Adresse selbst der Schlüssel.

const wire = require('./wire');
const { ResponseCache } = require('./responseCache');

const { TYPE, RCODE } = wire;
const MAX_CHAIN = 8;
const SAFE_CNAME_TTL = 300;
const BLOCK_TTL = 60;
const MAX_LOG = 2000;

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || String(ip).startsWith('127.');
}

class Resolver {
  constructor({
    getPolicy, upstream, neighbors, stats, now = Date.now, cache = new ResponseCache({ now }), blockResponse = () => 'zero', logEnabled = () => false,
    clientFor = null, ecsClient = false,
  }) {
    Object.assign(this, { getPolicy, upstream, neighbors, stats, now, cache, blockResponse, logEnabled, clientFor, ecsClient });
    this.inflight = new Map();
    this.log = [];
  }

  clearLog() { this.log = []; }

  _log(entry) {
    if (!this.logEnabled()) return;
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  /** Client-Adresse einer Anfrage: aus ECS, wenn eingeschaltet und vom Absender angenommen, sonst der Absender. */
  _clientIp(q, ip) {
    if (!this.ecsClient) return ip;
    const ecs = q.edns && q.edns.ecs;
    if (!ecs || ecs.sourcePrefix !== (ecs.family === 4 ? 32 : 128)) return ip;
    const trusted = typeof this.ecsClient === 'function' ? this.ecsClient(ip) : !!ip && isLoopback(ip);
    return trusted ? ecs.address : ip;
  }

  /** Schlüssel des Clients (MAC, Peer-Kennung …) oder null. */
  async _clientKey(ip) {
    if (!ip || isLoopback(ip)) return null;
    if (this.clientFor) return (await this.clientFor(ip)) || null;
    if (this.neighbors) return this.neighbors.macFor(ip);
    return this.ecsClient ? ip : null;
  }

  /** Antwort an den Client (über UDP höchstens 512 Bytes bzw. EDNS-Größe, sonst TC). */
  async handle(msg, { ip = null, udp = false } = {}) {
    const t0 = process.hrtime.bigint();
    const q = wire.parseQuery(msg);
    if (!q) return null;
    if (q.opcode !== 0) return wire.buildResponse({ ...q, question: q.question || null }, { rcode: RCODE.NOTIMP });
    if (!q.question) return wire.buildResponse({ ...q, question: null }, { rcode: RCODE.FORMERR });
    if (q.qclass !== wire.CLASS_IN || !q.nameOk || q.name === null) return wire.buildResponse(q, { rcode: RCODE.REFUSED });

    const from = ip; // Absender der Verbindung (Schleifenschutz der Weiterleitung)
    ip = this._clientIp(q, ip);
    const mac = await this._clientKey(ip);
    const now = this.now();
    const policy = this.getPolicy();
    const d = policy.decide(q.name, mac, now);
    let out;
    let cached = false;
    let via = null;
    try {
      if (d.action === 'block') {
        out = this._blocked(q, d);
      } else if (d.safeSearch && (q.qtype === TYPE.A || q.qtype === TYPE.AAAA)) {
        const r = await this._safeSearch(q, d.safeSearch, from);
        out = r.out; cached = r.cached; via = r.via;
      } else if (d.safeSearch) {
        out = wire.buildResponse(q, {}); // andere Typen (HTTPS, …) für Suchmaschinen: leer
      } else {
        const r = await this._forward(q, { local: !!d.local, ip: from });
        out = wire.adaptResponse(r.wire, { id: q.id, question: q.question, ttlOffsets: r.ttlOffsets, ageSec: r.ageSec });
        cached = r.cached; via = r.via;
      }
    } catch (_err) {
      out = wire.buildResponse(q, { rcode: RCODE.SERVFAIL });
    }
    const maxUdp = udp ? (q.edns ? Math.min(q.edns.udpSize, 4096) : 512) : 0;
    if (maxUdp && out.length > maxUdp) {
      const meta = wire.parseResponse(out);
      out = wire.buildResponse(q, { rcode: meta ? meta.rcode : RCODE.NOERROR, tc: true });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const blocked = d.action === 'block';
    if (this.stats) this.stats.record({ profileId: d.profileId, mac, blocked, cached, ms, domain: blocked ? q.name : null });
    this._log({
      at: now, mac, ip, name: q.name, type: wire.typeName(q.qtype), action: d.action, reason: d.reason,
      profileId: d.profileId, list: d.list || null, category: d.category || null, cached, via, ms: Math.round(ms * 10) / 10,
    });
    return out;
  }

  _blocked(q, d) {
    if (d.nxdomain || this.blockResponse() === 'nxdomain') {
      return wire.buildResponse(q, { rcode: RCODE.NXDOMAIN, ede: wire.EDE_BLOCKED });
    }
    const answers = [];
    if (q.qtype === TYPE.A) answers.push({ name: q.name, type: TYPE.A, ttl: BLOCK_TTL, rdata: Buffer.alloc(4) });
    if (q.qtype === TYPE.AAAA) answers.push({ name: q.name, type: TYPE.AAAA, ttl: BLOCK_TTL, rdata: Buffer.alloc(16) });
    return wire.buildResponse(q, { answers, ede: wire.EDE_BLOCKED });
  }

  /** Upstream mit Zwischenspeicher und Bündelung. → { wire, ttlOffsets, ageSec, cached, via } */
  async _forward({ name, qtype, qclass = wire.CLASS_IN, edns = null, cd = false }, { local = false, ip = null } = {}) {
    const key = `${local ? 'L' : 'U'}|${qtype}|${qclass}|${name}|${edns ? 1 : 0}${edns && edns.do ? 1 : 0}${cd ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return { wire: hit.wire, ttlOffsets: hit.ttlOffsets, ageSec: hit.ageSec, cached: true, via: 'cache' };
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        const query = wire.buildQuery({ name, qtype, qclass, edns: edns ? { do: edns.do } : null, cd });
        const r = local ? await this.upstream.local(query, { fromIp: ip }) : await this.upstream.query(query, { fromIp: ip });
        const meta = wire.parseResponse(r.wire);
        if (!meta) throw new Error('bad upstream response');
        this.cache.set(key, r.wire, meta);
        return { wire: r.wire, ttlOffsets: meta.ttlOffsets, ageSec: 0, cached: false, via: r.via };
      })();
      this.inflight.set(key, p);
      p.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return p;
  }

  /** CNAME auf das Ziel der sicheren Suche + dessen Adressen. */
  async _safeSearch(q, target, ip) {
    const r = await this._forward({ name: target, qtype: q.qtype, edns: q.edns, cd: q.cd }, { ip });
    const meta = wire.parseResponse(r.wire);
    if (!meta || meta.rcode !== RCODE.NOERROR) return { out: wire.buildResponse(q, { rcode: meta ? meta.rcode : RCODE.SERVFAIL }), cached: r.cached, via: r.via };
    const answers = [{ name: q.name, type: TYPE.CNAME, ttl: SAFE_CNAME_TTL, rdata: wire.encodeName(target) }];
    let cur = target;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const c = meta.answers.find((a) => a.name === cur && a.type === TYPE.CNAME && a.target);
      if (!c) break;
      answers.push({ name: cur, type: TYPE.CNAME, ttl: Math.max(0, c.ttl - r.ageSec), rdata: wire.encodeName(c.target) });
      cur = c.target;
    }
    for (const a of meta.answers) {
      if (a.name === cur && a.type === q.qtype) answers.push({ name: cur, type: a.type, ttl: Math.max(0, a.ttl - r.ageSec), rdata: Buffer.from(a.rdata) });
    }
    return { out: wire.buildResponse(q, { answers }), cached: r.cached, via: r.via };
  }
}

module.exports = { Resolver, MAX_LOG, isLoopback };
