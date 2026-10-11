# Vertrauenswürdige Netzwerke: „Im Heimnetz des Servers“

Die Android-App trennt das VPN automatisch in einem vertrauenswürdigen WLAN und
verbindet sich anderswo wieder. Eine Erkennungsart braucht **keine
Standortberechtigung** (also keine SSID): „das Gerät ist im eigenen LAN des
Servers“. Der Server beantwortet diese Frage; ein falsches „ja“ würde das VPN in
einem fremden Netz abschalten, deshalb entscheidet er im Zweifel immer „nein“.

## Vertrag Gerät ↔ Server

### `GET /api/v1/client/home-network`

Token mit Scope `client` (oder `full-access`), Maschinenbindung wie bei den
anderen Client-Routen. Die App ruft den Endpunkt über den **normalen Weg**
(öffentlicher Hostname) auf, mit VPN an oder aus.

```json
{ "ok": true, "lan": ["192.168.1.10"], "same_lan": true, "via": "direct" }
```

| Feld       | Bedeutung |
|------------|-----------|
| `lan`      | Private IPv4-Adressen des Servers (nur RFC 1918: 10/8, 172.16/12, 192.168/16) auf aktiven, nicht-internen Schnittstellen; ohne die WireGuard-Schnittstelle, ohne Adressen im WireGuard-Subnetz, ohne Container-/virtuelle Brücken (`docker*`, `br-*`, `veth*`, `virbr*`, `cni*`, `flannel*`, `cali*`, `vxlan*`, `lxc*`, `lxd*`, `podman*`, `tailscale*`, `zt*`, `tun*`, `tap*`, `wg*`). Dedupliziert, höchstens 8, stabile Reihenfolge (Schnittstellenname, dann Adresse). |
| `same_lan` | `true` nur in den beiden Fällen unten, sonst immer `false`. |
| `via`      | `tunnel` (Anfrage aus dem WireGuard-Subnetz) oder `direct` – nur informativ, die App entscheidet nie danach. |

`same_lan` ist `true`, wenn

* **(a) direkt (VPN aus):** die Absenderadresse (`req.ip`, IPv4-mapped IPv6
  normalisiert) eine IPv4 aus dem Subnetz (Adresse + Netzmaske) einer der
  `lan`-Schnittstellen ist – auch bei Hairpin-NAT (Absender ist dann die
  LAN-Adresse des Telefons oder des Routers);
* **(b) durch den Tunnel (VPN an):** die Absenderadresse im WireGuard-Subnetz
  liegt und eine Tunnel-Adresse (`allowed_ips`) des Peers des Tokens ist, der
  Peer aktiviert ist, einen frischen Handshake hat (`isOnline`) und sein
  aktueller WireGuard-Endpunkt (`wg show <iface> dump`) eine IPv4 aus einem
  dieser Subnetze ist.

Immer ausgeschlossen: Adressen im WireGuard-Subnetz (als LAN-Absender bzw.
Endpunkt), die eigenen Adressen des Servers, Subnetze ausgeschlossener
Schnittstellen, Subnetze breiter als /8. Jeder Fehler (Schnittstellen-Scan,
`wg show`) ergibt `false`.

Antworten: `200` wie oben, immer mit `Cache-Control: no-store`.
`401` ohne Token, `403` für eine Browser-Sitzung (`token_required`), ohne
`client`-Scope oder bei falscher Maschinenbindung, `429 { error: 'rate_limited' }`
ab 30 Anfragen pro Minute und Gerät.

## Server

* `src/services/homeNetwork.js`: Schnittstellen-Scan (`os.networkInterfaces()`,
  Testnaht `_setInterfacesForTest`), Ausschlussliste
  `EXCLUDED_IFACE_PREFIXES`, Entscheidung `check(ip, peerId)`.
* `src/services/notify/vpnPresence.js` `currentEndpoint(peerId)`: aktueller
  Endpunkt eines Peers (auch vom Push-Kanal genutzt).
* Der Server läuft mit `network_mode: host`, sieht also die echten
  Schnittstellen des Hosts; libuv listet nur Schnittstellen, die UP und RUNNING
  sind.

## Grenzen

* Ein Router, der weitergeleitete Verbindungen aus dem Internet auf seine
  eigene LAN-Adresse umschreibt (SNAT/Masquerading bei Portweiterleitung),
  lässt fremde Geräte wie Hairpin-NAT aussehen. Solche Router sind selten;
  wer einen hat, nutzt für vertrauenswürdige Netze die SSID-Erkennung.
