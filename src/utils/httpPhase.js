'use strict';

// Where an outgoing HTTPS request got stuck: "no answer", "socket hang up"
// and "timeout" alone do not say whether the name did not resolve (the
// server's DNS goes through the Pi-hole chain), the connection did not come
// up (a broken IPv6 route), TLS did not finish or the server did not answer.
//
//   const phase = trackPhases(req);   // right after https.get / request
//   … on an error or timeout: phase() → { phase, address, family, ms }
//
// phase: 'dns' (no address yet) | 'connect' (address, no TCP connection) |
// 'tls' (connected, handshake not done) | 'first byte' (request sent, no
// answer yet) | 'body' (answer started). address/family: what the name
// resolved to (IPv4 / IPv6), ms: time since the request started.

const { performance } = require('node:perf_hooks');

function trackPhases(req) {
  const t0 = performance.now();
  const st = { phase: 'dns', address: null, family: null };
  const at = (p) => { st.phase = p; };
  req.once('socket', (sock) => {
    // a reused keep-alive socket is connected already
    if (sock.remoteAddress) {
      st.address = sock.remoteAddress;
      st.family = sock.remoteFamily || null;
      at(sock.encrypted && !sock.connecting ? 'first byte' : 'tls');
    }
    sock.once('lookup', (err, address, family) => {
      if (err) return;
      st.address = address;
      st.family = family === 6 || family === 'IPv6' ? 'IPv6' : 'IPv4';
      at('connect');
    });
    sock.once('connect', () => {
      if (sock.remoteAddress) { st.address = sock.remoteAddress; st.family = sock.remoteFamily || st.family; }
      at('tls');
    });
    sock.once('secureConnect', () => at('first byte'));
  });
  req.once('response', (res) => { at('body'); res.once('end', () => at('done')); });
  return () => ({ phase: st.phase, address: st.address, family: st.family, ms: Math.round(performance.now() - t0) });
}

/** "phase tls, 140.82.121.4 (IPv4), 4001 ms" for an error message. */
function describe(p) {
  if (!p) return '';
  return `phase ${p.phase}${p.address ? `, ${p.address}${p.family ? ` (${p.family})` : ''}` : ''}, ${p.ms} ms`;
}

module.exports = { trackPhases, describe };
