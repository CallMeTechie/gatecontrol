// scripts/deconz-spike.js
// Einmal-Spike: beweist, ob der zentrale (oeffentliche) GC-Server die deCONZ-REST-API
// durch den WireGuard-Gateway real erreicht. Bestimmt den Transport-Pfad (A/B/C) fuer
// resolveBaseUrl (Plan Task 4 / Spec 2 + 15).
//
// Aufruf:
//   node scripts/deconz-spike.js            # ohne Key: holt einen API-Key (POST /api), waehrend
//                                           #   das Phoscon-Link-Fenster offen ist
//   node scripts/deconz-spike.js <apiKey>   # mit Key: liest /lights (Transport-Bestaetigung)
//
// Optionale Tuning-Knoepfe fuer die Fallback-Pfade (echte Netzadressen, kein Datei-Edit noetig):
//   SPIKE_TUNNEL_BASE=http://10.8.0.8:80      WG-Tunnel-IP des Gateway-Peers (Pfad B)
//   SPIKE_LOOPBACK_PORT=80                     lokaler Listen-Port der Route (Pfad C)
//
// Voraussetzung: interne Route phoscon.marcbackes.net -> 192.168.2.30:80 existiert,
// <apiKey> vorher in Phoscon geholt ("Einstellungen -> Gateway -> App authentifizieren").
'use strict';

const API_KEY = process.argv[2]; // optional: ohne Key -> Acquire-Modus

const ROUTE_DOMAIN = 'phoscon.marcbackes.net';
const TUNNEL_BASE = process.env.SPIKE_TUNNEL_BASE || 'http://10.8.0.8:80'; // WG-IP ggf. via env korrigieren
const LOOPBACK_PORT = process.env.SPIKE_LOOPBACK_PORT || '80';

const CANDIDATES = [
  { name: 'A route-domain', base: `http://${ROUTE_DOMAIN}` },
  { name: 'B tunnel-ip',    base: TUNNEL_BASE },
  { name: 'C loopback',     base: `http://127.0.0.1:${LOOPBACK_PORT}`, host: ROUTE_DOMAIN },
];

(async () => {
  if (!API_KEY) {
    console.log('Acquire-Modus (kein Key uebergeben) — Phoscon-Link-Fenster muss offen sein:');
    for (const c of CANDIDATES) {
      const url = `${c.base}/api`;
      const headers = { 'Content-Type': 'application/json', ...(c.host ? { Host: c.host } : {}) };
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ devicetype: 'GateControl' }) });
        const text = await res.text();
        console.log(`[${c.name}] ${res.status} POST ${url} -> ${text.slice(0, 160)}`);
      } catch (err) {
        console.log(`[${c.name}] ERROR POST ${url} -> ${err.message}`);
      }
    }
    console.log('\nEin {"success":{"username":"..."}} = dein API-Key + dieser Pfad funktioniert.');
    return;
  }
  for (const c of CANDIDATES) {
    const url = `${c.base}/api/${API_KEY}/lights`;
    const headers = c.host ? { Host: c.host } : {};
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      console.log(`[${c.name}] ${res.status} ${url} -> ${text.slice(0, 120)}`);
    } catch (err) {
      console.log(`[${c.name}] ERROR ${url} -> ${err.message}`);
    }
  }
})();
