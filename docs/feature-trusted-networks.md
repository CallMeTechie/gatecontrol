# Vertrauenswürdige Netzwerke: „Im Heimnetz des Servers“

Die Android-App trennt das VPN automatisch in einem vertrauenswürdigen WLAN und
verbindet sich anderswo wieder. Eine Erkennungsart braucht **keine
Standortberechtigung** (also keine SSID): „das Gerät ist im eigenen LAN des
Servers“. Der Server beantwortet diese Frage; ein falsches „ja“ würde das VPN in
einem fremden Netz abschalten, deshalb entscheidet er im Zweifel immer „nein“.

## Vertrag Gerät ↔ Server

### `GET /api/v1/client/home-network`

Token mit Scope `client` (oder `full-access`), Maschinenbindung wie bei den
anderen Client-Routen. Die App fragt über den **normalen Weg** (öffentlicher
Hostname) und **nur bei aktivem VPN**; ohne Tunnel lautet die Antwort immer
`same_lan: false`.

```json
{ "ok": true, "lan": ["192.168.1.10"], "same_lan": true, "via": "tunnel" }
```

| Feld       | Bedeutung |
|------------|-----------|
| `lan`      | Private IPv4-Adressen des Servers (nur RFC 1918: 10/8, 172.16/12, 192.168/16) auf aktiven, nicht-internen Schnittstellen; ohne die WireGuard-Schnittstelle, ohne Adressen im WireGuard-Subnetz, ohne Container-/virtuelle Brücken (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`, `flannel*`, `cali*`, `vxlan*`, `lxc*`, `lxd*`, `podman*`, `tailscale*`, `zt*`, `tun*`, `tap*`, `wg*`). Dedupliziert, höchstens 8, stabile Reihenfolge (Schnittstellenname, dann Adresse). |
| `same_lan` | `true` nur für eine Anfrage durch den Tunnel unter den Bedingungen unten, sonst immer `false`. |
| `via`      | `tunnel` (Anfrage aus dem WireGuard-Subnetz) oder `direct` – nur informativ, die App entscheidet nie danach. |

`same_lan` ist **nur** dann `true`, wenn die Anfrage **durch den Tunnel**
kommt und alles Folgende gilt:

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

Alles andere ergibt `false`, insbesondere:

* **Direkte Anfragen (ohne Tunnel) zählen nie**, auch nicht aus einem
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
  (Testnaht `_setRouteTableForTest`), Entscheidung `check(ip, peerId)`.
* `src/services/notify/vpnPresence.js` `currentEndpoint(peerId)`: aktueller
  Endpunkt eines Peers (auch vom Push-Kanal genutzt).
* Der Server läuft mit `network_mode: host`, sieht also die echten
  Schnittstellen und die echte Routing-Tabelle des Hosts; libuv listet nur
  Schnittstellen, die UP und RUNNING sind.

## Grenzen

Erkannt wird das Heimnetz nur, wenn der Server den Tunnel des Telefons mit
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
