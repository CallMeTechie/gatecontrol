// scripts/deconz-spike.js
// Einmal-Spike: beweist, ob der zentrale (oeffentliche) GC-Server die deCONZ-REST-API
// real erreicht, und ueber welchen Pfad. Bestimmt resolveBaseUrl (Plan Task 4 / Spec 2 + 15).
//
// Erkenntnis nach Diagnose:
//   - Route-Domain (Pfad A) -> 404 = remote_ip-Gate sperrt die eigene Server-IP (extern).
//   - direkte LAN-IP (D/E)  -> kein Tunnel-Route zum LAN-Subnetz.
//   - Der GC-Server erreicht LAN-Ziele wie Caddy: ueber den Gateway-Companion-HTTP-Proxy
//     auf <Peer>:8080 MIT Header X-Gateway-Target=<lanHost:lanPort> (Pfad F). <- erwartet gruen
//
// Proben pro Kandidat:
//   1) GET  /api/config  -> unauth deCONZ-Probe (kein Link-Fenster noetig). JSON mit
//      "apiversion"/"swversion" = Pfad erreicht deCONZ.
//   2) POST /api         -> Key-Acquire (Phoscon-Link-Fenster offen): {"success":{"username"}}
//      = Key; {"error":{"type":101}} = Pfad ok, Fenster zu.
//
// Aufruf:
//   node scripts/deconz-spike.js            # Probe + Acquire ueber alle Pfade
//   node scripts/deconz-spike.js <apiKey>   # zusaetzlich GET /lights (Lese-Bestaetigung)
//
// Tuning-Knoepfe (kein Datei-Edit noetig):
//   SPIKE_PEER=10.8.0.8        WG-Tunnel-IP des Gateway-Peers vor deCONZ
//   SPIKE_PROXY_PORT=8080      Companion-Proxy-Port des Peers (DSM ggf. abweichend)
//   SPIKE_LAN_TARGET=192.168.2.30:80   LAN-Ziel host:port (deCONZ)
'use strict';

const API_KEY = process.argv[2]; // optional

const ROUTE_DOMAIN = 'phoscon.marcbackes.net';
const PEER = process.env.SPIKE_PEER || '10.8.0.8';
const PROXY_PORT = process.env.SPIKE_PROXY_PORT || '8080';
const LAN_TARGET = process.env.SPIKE_LAN_TARGET || '192.168.2.30:80';
const LAN_HOST = LAN_TARGET.split(':')[0];

const GW_HEADERS = { 'X-Gateway-Target': LAN_TARGET, 'X-Gateway-Target-Domain': ROUTE_DOMAIN };

const CANDIDATES = [
  { name: 'A route-domain',  base: `http://${ROUTE_DOMAIN}` },
  { name: 'F companion-proxy', base: `http://${PEER}:${PROXY_PORT}`, headers: GW_HEADERS },
  { name: 'D direct-lan',    base: `http://${LAN_TARGET}` },
];

async function probe(label, url, opts) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`[${label}] ${res.status} ${(opts && opts.method) || 'GET'} ${url} -> ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`[${label}] ERROR ${url} -> ${err.message}`);
  }
}

(async () => {
  console.log('== Reachability-Probe: GET /api/config (unauth, kein Link-Fenster noetig) ==');
  for (const c of CANDIDATES) {
    await probe(c.name, `${c.base}/api/config`, { headers: { ...(c.headers || {}) } });
  }

  if (API_KEY) {
    console.log('\n== Lese-Bestaetigung: GET /lights mit Key ==');
    for (const c of CANDIDATES) {
      await probe(c.name, `${c.base}/api/${API_KEY}/lights`, { headers: { ...(c.headers || {}) } });
    }
    return;
  }

  console.log('\n== Key-Acquire: POST /api (Phoscon-Link-Fenster muss offen sein) ==');
  for (const c of CANDIDATES) {
    await probe(c.name, `${c.base}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.headers || {}) },
      body: JSON.stringify({ devicetype: 'GateControl' }),
    });
  }
  console.log('\nJSON mit "apiversion"/"swversion" (Probe) ODER {"error":{"type":101}} (Acquire) = dieser Pfad erreicht deCONZ.');
})();
