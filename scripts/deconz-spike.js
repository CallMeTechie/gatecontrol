// scripts/deconz-spike.js
// Einmal-Spike: beweist, ob der zentrale (oeffentliche) GC-Server die deCONZ-REST-API
// real erreicht, und ueber welchen Pfad. Bestimmt resolveBaseUrl (Plan Task 4 / Spec 2 + 15).
//
// Zwei Proben pro Kandidat:
//   1) GET  <base>/api/config   -> unauthentifizierte deCONZ-Probe. JSON mit "apiversion"/
//      "swversion" = dieser Pfad erreicht deCONZ. Braucht KEIN offenes Link-Fenster.
//   2) POST <base>/api          -> Key-Acquire (nur sinnvoll mit offenem Phoscon-Link-Fenster):
//      {"success":{"username":"..."}} = Key; {"error":{"type":101}} = Pfad ok, Fenster zu.
//
// Aufruf:
//   node scripts/deconz-spike.js            # Probe + Acquire-Versuch ueber alle Pfade
//   node scripts/deconz-spike.js <apiKey>   # zusaetzlich GET /lights mit Key (Lese-Bestaetigung)
//
// Tuning-Knoepfe (echte Netzadressen, kein Datei-Edit noetig):
//   SPIKE_LAN_HOST=192.168.2.30   LAN-IP des deCONZ/Phoscon-Geraets (Pfad D/E)
//   SPIKE_TUNNEL_BASE=...         alternative Basis (Pfad B)
'use strict';

const API_KEY = process.argv[2]; // optional

const ROUTE_DOMAIN = 'phoscon.marcbackes.net';
const LAN_HOST = process.env.SPIKE_LAN_HOST || '192.168.2.30';
const TUNNEL_BASE = process.env.SPIKE_TUNNEL_BASE || 'http://10.8.0.8:80';

const CANDIDATES = [
  { name: 'A route-domain', base: `http://${ROUTE_DOMAIN}` },
  { name: 'D direct-lan-80',   base: `http://${LAN_HOST}:80` },
  { name: 'E direct-lan-8080', base: `http://${LAN_HOST}:8080` },
  { name: 'B tunnel-peer',  base: TUNNEL_BASE },
];

async function probe(label, url, opts) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`[${label}] ${res.status} ${opts && opts.method || 'GET'} ${url} -> ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`[${label}] ERROR ${url} -> ${err.message}`);
  }
}

(async () => {
  console.log('== Reachability-Probe: GET /api/config (unauth, kein Link-Fenster noetig) ==');
  for (const c of CANDIDATES) {
    await probe(c.name, `${c.base}/api/config`, { headers: c.host ? { Host: c.host } : {} });
  }

  if (API_KEY) {
    console.log('\n== Lese-Bestaetigung: GET /lights mit Key ==');
    for (const c of CANDIDATES) {
      await probe(c.name, `${c.base}/api/${API_KEY}/lights`, { headers: c.host ? { Host: c.host } : {} });
    }
    return;
  }

  console.log('\n== Key-Acquire: POST /api (Phoscon-Link-Fenster muss offen sein) ==');
  for (const c of CANDIDATES) {
    await probe(c.name, `${c.base}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.host ? { Host: c.host } : {}) },
      body: JSON.stringify({ devicetype: 'GateControl' }),
    });
  }
  console.log('\nJSON mit "apiversion"/"swversion" (Probe) ODER {"error":{"type":101}} (Acquire) = dieser Pfad erreicht deCONZ.');
})();
