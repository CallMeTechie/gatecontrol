'use strict';

// UDP- und TCP-Listener des DNS-Filters. Auf welchen Adressen gelauscht wird,
// bestimmt der Aufrufer (`addresses`) – nie 0.0.0.0. Belegt ein anderer
// Dienst den Port (DSM-DNS-Server, Pi-hole, systemd-resolved), wird nichts
// erzwungen: Zustand `port_busy`, neuer Versuch beim nächsten Abgleich.

const dgram = require('node:dgram');
const net = require('node:net');

const MAX_UDP_INFLIGHT = 512;
const MAX_TCP_CONN = 128;
const TCP_IDLE_MS = 10_000;
const MAX_TCP_PIPELINE = 32;

class DnsListener {
  /**
   * @param handle async (msg, { ip, udp }) → Buffer|null
   * @param addresses () → [{ address, family }]
   */
  constructor({ handle, port = 53, addresses }) {
    Object.assign(this, { handle, port, addresses });
    this.bound = new Map(); // address → { udp, tcp }
    this.busy = new Set();
    this.failed = new Map(); // address → code
    this.udpInflight = 0;
    this.tcpConns = 0;
    this.dropped = 0;
  }

  _udp(address, family) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: family === 6 ? 'udp6' : 'udp4', reuseAddr: false });
      s.once('error', reject);
      s.bind({ address, port: this.port, exclusive: true }, () => {
        s.removeListener('error', reject);
        s.on('error', () => { /* einzelne Sendefehler */ });
        s.on('message', (msg, rinfo) => this._onUdp(s, msg, rinfo));
        resolve(s);
      });
    });
  }

  _onUdp(sock, msg, rinfo) {
    if (this.udpInflight >= MAX_UDP_INFLIGHT) { this.dropped++; return; }
    this.udpInflight++;
    Promise.resolve()
      .then(() => this.handle(msg, { ip: rinfo.address, udp: true }))
      .then((out) => { if (out) sock.send(out, rinfo.port, rinfo.address, () => {}); })
      .catch(() => {})
      .finally(() => { this.udpInflight--; });
  }

  _tcp(address) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer({ allowHalfOpen: true }, (c) => this._onTcp(c));
      srv.maxConnections = MAX_TCP_CONN;
      srv.once('error', reject);
      srv.listen({ host: address, port: this.port, exclusive: true }, () => {
        srv.removeListener('error', reject);
        srv.on('error', () => {});
        resolve(srv);
      });
    });
  }

  _onTcp(c) {
    let buf = Buffer.alloc(0);
    let pending = 0;
    let ended = false;
    // Halb offen: Clients schicken oft „Anfrage + FIN“; die Antwort kommt danach.
    const maybeEnd = () => { if (ended && pending === 0 && !c.destroyed) c.end(); };
    c.setTimeout(TCP_IDLE_MS, () => c.destroy());
    c.on('error', () => {});
    c.on('end', () => { ended = true; maybeEnd(); });
    c.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (len < 12) { c.destroy(); return; }
        if (buf.length < 2 + len) break;
        const msg = Buffer.from(buf.subarray(2, 2 + len));
        buf = buf.subarray(2 + len);
        if (++pending > MAX_TCP_PIPELINE) { c.destroy(); return; }
        Promise.resolve()
          .then(() => this.handle(msg, { ip: c.remoteAddress, udp: false }))
          .then((out) => {
            if (!out || c.destroyed) return;
            const l = Buffer.alloc(2);
            l.writeUInt16BE(out.length, 0);
            c.write(Buffer.concat([l, out]));
          })
          .catch(() => {})
          .finally(() => { pending--; maybeEnd(); });
      }
      if (buf.length > 65537) c.destroy();
    });
  }

  /** Adressen abgleichen (neue binden, verschwundene schließen). → status() */
  async reconcile() {
    const want = new Map(this.addresses().map((a) => [a.address, a]));
    for (const [addr, socks] of this.bound) {
      if (!want.has(addr)) { this._close(socks); this.bound.delete(addr); }
    }
    this.busy.clear();
    this.failed.clear();
    for (const [addr, a] of want) {
      if (this.bound.has(addr)) continue;
      let udp = null;
      try {
        udp = await this._udp(addr, a.family);
        const tcp = await this._tcp(addr);
        this.bound.set(addr, { udp, tcp });
      } catch (err) {
        if (udp) try { udp.close(); } catch (_e) { /* zu */ }
        if (err.code === 'EADDRINUSE') this.busy.add(addr);
        else this.failed.set(addr, err.code || 'error');
      }
    }
    return this.status();
  }

  status() {
    const listen = [...this.bound.keys()];
    let state = 'running';
    if (this.busy.size) state = 'port_busy';
    else if (!listen.length) state = this.failed.size ? 'error' : 'no_address';
    return { state, listen, busy: [...this.busy], failed: Object.fromEntries(this.failed), port: this.port };
  }

  _close({ udp, tcp }) {
    try { udp.close(); } catch (_e) { /* zu */ }
    try { tcp.close(); } catch (_e) { /* zu */ }
  }

  close() {
    for (const socks of this.bound.values()) this._close(socks);
    this.bound.clear();
    this.busy.clear();
    this.failed.clear();
  }
}

module.exports = { DnsListener, MAX_UDP_INFLIGHT, MAX_TCP_CONN };
