'use strict';

// A port for a test DNS server (dnsmasq, a stand-in resolver) that is bound
// later, on UDP and TCP.
//
// bind(0) hands out a port from the kernel's ephemeral range — the very range
// it also takes the local ports of outgoing connections from. Between "free
// now" and the later listen() any other test of the parallel run could get
// that port for a connection of its own: EADDRINUSE on 127.0.0.1:48100 on
// CI (tests/pihole_removal_dnsmasq.test.js, master 17.11.). Ports below the
// ephemeral range are only ever taken by a listen() that asks for them.

const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');

function ephemeralStart() {
  try {
    const lo = Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
    if (lo > 2048) return lo;
  } catch { /* not Linux */ }
  return 32768;
}

const tryUdp = (port) => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  s.once('error', () => { s.close(); resolve(false); });
  s.bind(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
const tryTcp = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

const taken = new Set();

/** A port free on UDP and TCP of 127.0.0.1, below the ephemeral range, not handed out before in this process. */
async function dnsPort() {
  const hi = ephemeralStart();
  const lo = Math.max(10000, hi - 12000);
  for (let i = 0; i < 200; i++) {
    const port = lo + Math.floor(Math.random() * (hi - lo));
    if (taken.has(port)) continue;
    if (await tryUdp(port) && await tryTcp(port)) { taken.add(port); return port; }
  }
  throw new Error('no free port below the ephemeral range');
}

module.exports = { dnsPort };
