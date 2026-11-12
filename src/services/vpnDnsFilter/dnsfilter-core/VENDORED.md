# dnsfilter-core – DNS-Filter-Engine (wird gespiegelt)

Dieses Verzeichnis ist die Filter-Engine des Gateways: Listen laden und
kompakt speichern, Matching, Profile, Zeiten/Pausen, sichere Suche,
DNS-Wire-Format, Weiterleitung (DoH, Rückfall), Zwischenspeicher, Listener,
Zähler.

**Quelle ist dieses Repository** (`CallMeTechie/gatecontrol-gateway`,
`src/dnsfilter-core/`). Der GateControl-Server führt eine **Kopie** davon für
den DNS-Schutz der VPN-Geräte; seine CI vergleicht die Kopie Datei für Datei
mit einem Gateway-Tag. Änderungen gehören deshalb immer hierher, nie in die
Kopie – und sie erreichen den Server erst mit dem nächsten Gateway-Release,
auf das er seine Kopie anhebt.

## Regeln

- **Keine Abhängigkeiten nach außen.** Erlaubt sind nur `node:`-Module und
  Dateien in diesem Verzeichnis – kein `../logger`, keine Gateway-Konfiguration,
  keine npm-Pakete. Logger, State-Verzeichnis, Lausch-Adressen, Uhr und die
  Zuordnung „Adresse → Client“ werden übergeben. `tests/dnsfilter_core.test.js`
  prüft das.
- Nur `.js`-Dateien und diese Notiz (der Vergleich im Server läuft über das
  ganze Verzeichnis).
- Nichts Gateway-Spezifisches: LAN-Adressen, MAC-Ermittlung (`ip neigh`),
  `features.dns`-Prüfung und der Bericht an den Server liegen in `src/dns/`.
- Verhalten nur erweitern, nicht still ändern: Neues ist aus, bis der Aufrufer
  es einschaltet (Beispiel `ecsClient`). Was sich für den Aufrufer ändert,
  steht im CHANGELOG des Gateways.
- Node ≥ 20, CommonJS.

## Einstieg

`require('./dnsfilter-core')` (`index.js`) exportiert alles, was ein
Filter-Dienst braucht: `ListManager`, `Policy`, `Resolver`, `ResponseCache`,
`Upstream`/`DohClient`, `DnsListener`, `DnsStats`, `wire` sowie die Helfer aus
`domainSet`/`listParser`/`safeSearch`.

| Datei | Inhalt |
|---|---|
| `wire.js` | DNS-Nachrichten lesen/bauen, EDNS inkl. Client Subnet (lesen) |
| `domainSet.js` | Domains prüfen, 53-Bit-Hashes, kompakte Listen, Muster |
| `listParser.js` | Listenformate `domains`/`hosts`/`adblock`, gestreamt |
| `lists.js`, `stateFile.js` | Listen laden (HTTPS, ETag), letzte gute Fassung auf Platte |
| `policy.js`, `safeSearch.js` | Entscheidung je Anfrage |
| `resolver.js`, `responseCache.js` | Ablauf einer Anfrage, Zwischenspeicher, Protokoll-Ringpuffer |
| `upstream.js` | DoH mit Rückfall auf einen Klartext-Resolver |
| `listener.js` | UDP-/TCP-Listener auf übergebenen Adressen |
| `stats.js` | Zähler für den Bericht |
