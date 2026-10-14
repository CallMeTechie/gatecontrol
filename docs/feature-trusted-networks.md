# Vertrauenswürdige Netzwerke: „Im Heimnetz“

Die Android-App trennt das VPN automatisch in einem vertrauenswürdigen WLAN und
verbindet sich anderswo wieder. Eine Erkennungsart braucht **keine
Standortberechtigung** (also keine SSID): „das Gerät ist zu Hause“. Der Server
beantwortet diese Frage; ein falsches „ja“ würde das VPN in einem fremden Netz
abschalten, deshalb entscheidet er im Zweifel immer „nein“. Dieselbe Abfrage
dient der Anwesenheit von Familie.

„Zu Hause“ heißt eines von beiden:

* **Server-Regel** – das Gerät ist im eigenen LAN des Servers (Server steht zu
  Hause), oder
* **Gateway-Regel** (ab 1.167.0) – das Gerät ist am Standort eines
  GateControl-Gateways (Server z. B. auf einem VPS, das Heimnetz hängt über
  einen Gateway-Peer wie eine Synology am Server).

## Vertrag Gerät ↔ Server

### `GET /api/v1/client/home-network`

Token mit Scope `client` (oder `full-access`), Maschinenbindung wie bei den
anderen Client-Routen. Die App fragt über den **normalen Weg** (öffentlicher
Hostname), mit oder ohne VPN. Die Server-Regel greift nur durch den Tunnel,
die Gateway-Regel auch ohne.

Optionaler Query-Parameter `local=<ipv4>[,<ipv4>…]`: die eigenen privaten
IPv4-Adressen des Geräts auf seinen WLAN-/Ethernet-Schnittstellen. Nur ein
einzelner Parameter zählt (mehrfach angegeben → ignoriert), höchstens die
ersten 4 Einträge werden betrachtet, jeder muss eine strikte
RFC-1918-Adresse in Punktschreibweise außerhalb des WireGuard-Subnetzes sein
– alles andere wird stillschweigend verworfen. Ohne gültiges `local` greift
die Gateway-Regel nie.

```json
{ "ok": true, "lan": [], "same_lan": true, "via": "direct",
  "site": { "type": "gateway", "gatewayId": 12, "name": "DS218+" } }
```

| Feld       | Bedeutung |
|------------|-----------|
| `lan`      | Private IPv4-Adressen des Servers (nur RFC 1918: 10/8, 172.16/12, 192.168/16) auf aktiven, nicht-internen Schnittstellen; ohne die WireGuard-Schnittstelle, ohne Adressen im WireGuard-Subnetz, ohne Container-/virtuelle Brücken (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`, `flannel*`, `cali*`, `vxlan*`, `lxc*`, `lxd*`, `podman*`, `tailscale*`, `zt*`, `tun*`, `tap*`, `wg*`). Dedupliziert, höchstens 8, stabile Reihenfolge (Schnittstellenname, dann Adresse). |
| `same_lan` | `true`, wenn die Server-Regel oder die Gateway-Regel greift (dann ist `site` gesetzt), sonst `false`. Ältere Apps werten nur dieses Feld aus. |
| `via`      | `tunnel` (Anfrage aus dem WireGuard-Subnetz) oder `direct` – nur informativ, die App entscheidet nie danach. |
| `site`     | `null`, `{ "type": "server" }` (Server-Regel) oder `{ "type": "gateway", "gatewayId": <Peer-ID>, "name": "<Peer-Name>" }` (Gateway-Regel). Greifen beide, gewinnt `server`. |

### Server-Regel

Sie greift **nur** dann, wenn die Anfrage **durch den Tunnel** kommt und alles
Folgende gilt:

* die Absenderadresse (`req.ip`) liegt im WireGuard-Subnetz und ist eine
  Tunnel-Adresse (`allowed_ips`) des Peers des Tokens;
* dieser Peer ist aktiviert und hat einen frischen Handshake (`isOnline`);
* sein aktueller WireGuard-Endpunkt (`wg show <iface> dump`) ist eine
  RFC-1918-IPv4 aus dem Subnetz (Adresse + Netzmaske, höchstens /8) einer der
  `lan`-Schnittstellen – also die LAN-Adresse des Telefons, weil sein Tunnel
  aus dem Heimnetz heraus zum Server aufgebaut ist;
* dieser Endpunkt ist weder im WireGuard-Subnetz noch eine eigene Adresse des
  Servers noch ein **Default-Gateway** des Hosts (IPv4-Routen mit Ziel
  `0.0.0.0` aus `/proc/net/route`).

Alles andere ergibt für diese Regel `false`, insbesondere:

* **Direkte Anfragen (ohne Tunnel) zählen für die Server-Regel nie**, auch nicht aus einem
  LAN-Subnetz. Steht ein Reverse-Proxy im LAN vor GateControl (Synology, Nginx
  Proxy Manager …) oder schreibt der Router weitergeleitete Verbindungen auf
  seine eigene LAN-Adresse um (SNAT), sieht jeder Client aus dem Internet wie
  ein LAN-Absender aus.
* **Endpunkt = Default-Gateway:** Ein Router, der eingehende
  UDP-Weiterleitungen per SNAT umschreibt, lässt den Endpunkt *jedes*
  entfernten WireGuard-Peers wie seine eigene LAN-Adresse aussehen. Deshalb
  zählt die Gateway-Adresse nie.
* **Routing-Tabelle nicht lesbar oder nicht auswertbar:** `false`
  (fail closed).
* Jeder andere Fehler (Schnittstellen-Scan, `wg show`).

### Gateway-Regel

Das Gerät ist am Standort des Gateways G, wenn **alles** gilt:

1. G ist ein aktivierter Gateway-Peer (`peer_type = 'gateway'`,
   `enabled = 1`) mit einem frischen Handshake (`isOnline` **und** höchstens
   3 Minuten alt) und einem bekannten aktuellen Endpunkt aus
   `wg show <iface> dump`.
2. Die öffentliche Adresse des Geräts ist die Endpunkt-Adresse von G:
   * **durch den Tunnel**: Absenderadresse ist eine Tunnel-Adresse
     (`allowed_ips`) des Peers des Tokens; dessen aktueller WireGuard-Endpunkt
     ist die öffentliche Adresse des Geräts (Peer aktiviert, Handshake frisch
     wie oben);
   * **direkt** (VPN aus): `req.ip` – wie überall mit `trust proxy
     'loopback'`, also nur der von Caddy angehängte Eintrag in
     `X-Forwarded-For`, nie ein vom Client mitgeschickter.

   IPv4: exakt gleich; IPv6: gleiches /64; IPv4 gegen IPv6: nie. Beide
   Adressen müssen **global routbar** sein (ipaddr-Bereich `unicast`):
   private Adressen, CGNAT (100.64/10), Loopback, Link-Local, ULA,
   Dokumentations-/reservierte Bereiche, 6to4/Teredo/NAT64 zählen nie – eine
   private „öffentliche“ Adresse bedeutet einen Reverse-Proxy oder einen
   SNAT-Router dazwischen, hinter dem alle entfernten Clients gleich
   aussehen. Eine eigene Adresse des Servers zählt ebenfalls nie.
3. Mindestens eine `local`-Adresse liegt in einem LAN-Subnetz, das G meldet
   (`gateway_meta.last_health` → `telemetry.lan_subnets[].cidr`, aus dem
   letzten Heartbeat des Gateways; höchstens 16 je Gateway). Verwendet werden
   nur IPv4-Subnetze, die vollständig in einem RFC-1918-Block liegen (z. B.
   `0.0.0.0/0`, `10.0.0.0/7`, `172.0.0.0/8` werden verworfen) und das
   WireGuard-Subnetz nicht überlappen.

Passen mehrere Gateways, antwortet das mit der kleinsten Peer-ID. Fehler
(`wg show`, Datenbank, kaputte Telemetrie) ergeben `false`.

**Warum `local` Pflicht ist:** Hinter Carrier-Grade-NAT (oder DS-Lite) teilen
sich viele Haushalte eine öffentliche IPv4-Adresse. Die öffentliche Adresse
allein würde das Nachbar-Telefon „zu Hause“ melden; erst das private Subnetz
unterscheidet die Haushalte. **Restrisiko:** Zwei Haushalte hinter derselben
Carrier-Adresse **und** mit demselben privaten Subnetz (z. B. beide
FritzBox-Standard `192.168.178.0/24`) sind von außen nicht zu unterscheiden.
Wer das ausschließen will, gibt dem Heimnetz ein unübliches Subnetz oder nutzt
die SSID-Erkennung der App. Über IPv6 tritt das nicht auf (das /64 gehört
einem Anschluss).

Protokolliert wird nur auf Debug-Ebene, die Adressen des Geräts nie auf
Info-Ebene.

`via` ist `tunnel`, wenn die Absenderadresse im WireGuard-Subnetz liegt, sonst
`direct` – nur informativ.

Antworten: `200` wie oben, immer mit `Cache-Control: no-store`.
`401` ohne Token, `403` für eine Browser-Sitzung (`token_required`), ohne
`client`-Scope oder bei falscher Maschinenbindung, `429 { error: 'rate_limited' }`
ab 30 Anfragen pro Minute und Gerät.

## Server

* `src/services/homeNetwork.js`: Schnittstellen-Scan (`os.networkInterfaces()`,
  Testnaht `_setInterfacesForTest`), Ausschlussliste
  `EXCLUDED_IFACE_PREFIXES`, Default-Gateways aus `/proc/net/route`
  (Testnaht `_setRouteTableForTest`), Entscheidung
  `check(ip, peerId, { local })`, Gateway-Regel `gatewaySite()`,
  `parseLocal()`.
* `src/services/notify/vpnPresence.js` `currentEndpoint(peerId)`: aktueller
  Endpunkt eines Peers (auch vom Push-Kanal genutzt).
* Der Server läuft mit `network_mode: host`, sieht also die echten
  Schnittstellen und die echte Routing-Tabelle des Hosts; libuv listet nur
  Schnittstellen, die UP und RUNNING sind.

## Grenzen

Server-Regel: erkannt wird das Heimnetz nur, wenn der Server den Tunnel des Telefons mit
dessen **eigener LAN-Adresse** als Endpunkt sieht:

* das Telefon löst den Server-Hostnamen im Heimnetz auf die LAN-Adresse des
  Servers auf (lokaler DNS-Eintrag), oder
* der Router macht Hairpin-NAT und behält dabei die Absenderadresse des
  Telefons bei.

Schreibt der Router beim Hairpin-NAT die Absenderadresse auf seine eigene
LAN-Adresse um, ist der Endpunkt das Default-Gateway und die Antwort `false`.
Das ist Absicht: Von außen ist diese Lage nicht von einem Router zu
unterscheiden, der eingehende Weiterleitungen per SNAT umschreibt. Das VPN
bleibt dann an; für solche Netze gibt es die SSID-Erkennung der App.

Gateway-Regel: erkannt wird der Standort nur, wenn das Gateway gerade einen
frischen Handshake hat, Gerät und Gateway über dieselbe Adressfamilie
herauskommen (beide IPv4 oder beide IPv6) und die App ihre `local`-Adressen
mitschickt (Android ab 1.31.0). Meldet das Gateway seine LAN-Subnetze (noch)
nicht, greift die Regel nicht.
