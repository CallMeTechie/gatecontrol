# Gateway Scan-Egress (LAN→Tunnel-Ausgang)

Ermöglicht es einem WG-losen LAN-Gerät (Drucker, Scanner), Scans auf
ein **entferntes Netzlaufwerk** abzulegen, das hinter einem anderen
Gateway liegt — also in die umgekehrte Richtung des normalen
Tunnel→LAN-Proxy. Das Near-Gateway fungiert dabei als Egress-Punkt:
es nimmt eine SMB-Verbindung aus dem eigenen LAN an und leitet sie
über den WireGuard-Tunnel zum Server-Hub weiter, von wo sie über eine
bestehende intern-only L4-Gateway-Route zum fernen NAS gelangt.

Der Egress ist konzeptionell ein weiterer interner Client dieser
L4-Route — er erbt damit das Far-Failover und das Pool-Routing aus
dem Bestand, ohne eigene neue Routing-Logik zu benötigen.

## Datenfluss

```
Drucker/Scanner (WG-los, z. B. 192.168.1.50)
    │
    │  SMB  \\<VIP>\share   (z. B. \\192.168.1.200\scans)
    ▼
iptables REDIRECT-Regel am Near-Gateway
    │  :445  →  High-Port  (z. B. 44500, im Container)
    ▼
EgressProxyManager (Near-Gateway, lauscht auf High-Port)
    │
    │  TCP über WireGuard-Tunnel  →  Server-Hub 10.8.0.1
    ▼
GC-Server (10.8.0.1, Caddy L4-Listener)
    │  →  gabelnde intern-only L4-Gateway-Route (target_kind=gateway)
    ▼
Pool-Routing / gatewayHealth-Pivot
    │
    ▼
Fernes Gateway (WireGuard-Peer)
    │
    ▼
Ziel-NAS  :445  (echtes SMB-Ziel, Credentials erforderlich)
```

Der Drucker sieht nur die VIP-Adresse und einen gewöhnlichen
SMB-Share — er braucht weder WireGuard noch eine Konfigurationsänderung
außer dem Scan-Ziel `\\<VIP>\<share>`.

## Voraussetzungen

### Gateway-seitig (bereits ausgeliefert — v1.16.1)

- **Phase 1a** (`EgressProxyManager`): der Gateway-Container kann
  vom Server eine Egress-Konfiguration empfangen und einen High-Port-
  Listener starten, der den Traffic in den Tunnel weiterleitet.
- **Phase 1b** (`NearManager` + keepalived-VIP): der Container enthält
  `iptables-legacy` und bringt keepalived-Support mit. Container-
  Capabilities `NET_ADMIN` und `NET_RAW` müssen gesetzt sein (für
  das VRRP-Multicast und die REDIRECT-Regel). keepalived verwaltet die
  VIP-Übernahme zwischen Pool-Mitgliedern.
- Die Capability `scan_egress: true` muss in der Gateway-Telemetrie
  gemeldet werden (wird vom 1b-fähigen Image automatisch gesetzt) —
  das ist das Gate vor allen Server-seitigen UI-Elementen und API-
  Endpoints.

### Server-seitig

- **Pro-Lizenz** mit dem Feature-Flag `gateway_scan_egress`.
- Eine **intern-only L4-Gateway-Route** (`external_enabled = 0`,
  `target_kind = gateway`) muss auf das Ziel-NAS zeigen und einen
  `l4_listen_port` haben. Diese Route wird als `target_route_id`
  referenziert — der Egress-Route-Datensatz fügt keine eigene
  Caddy-Config hinzu, er *nutzt* die bestehende Route.

## Datenmodell

Tabelle `egress_routes` (Migration #54):

| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | Anzeigename, z. B. „Drucker 1. OG → NAS Archiv" |
| `device_id` | INTEGER FK | zugehöriges Gerät (Gateway-Peer) |
| `near_peer_id` | INTEGER FK (nullable) | einzelner Near-Gateway-Peer |
| `near_pool_id` | INTEGER FK (nullable) | Pool als Near-Gateway (exklusiv zu `near_peer_id`) |
| `vip_ip` | TEXT NOT NULL | feste VIP außerhalb des DHCP-Bereichs, z. B. `192.168.1.200` |
| `vip_prefix` | INTEGER NOT NULL | Präfix-Länge, z. B. `24` |
| `lan_listen_port` | INTEGER NOT NULL | High-Port im Container (≥ 1024, **nicht** 445) |
| `target_route_id` | INTEGER FK | intern-only L4-Gateway-Route zum Ziel-NAS |
| `allowed_source_ips` | TEXT (JSON) | CIDR-Array, z. B. `["192.168.1.50/32"]` |
| `enabled` | INTEGER (0/1) | Egress-Regel aktiv/inaktiv |

`near_peer_id` und `near_pool_id` sind gegenseitig exklusiv; genau
eines muss gesetzt sein.

## Resolve-Regeln (Server → Gateway-Konfiguration)

Wenn der Server die Gateway-Konfiguration für den Near-Peer aufbaut
(`getGatewayConfig`), wird jeder aktivierte `egress_routes`-Eintrag
aufgelöst:

| Feld im Config-Payload | Quelle |
|---|---|
| `tunnel_target_host` | Hub-IP `10.8.0.1` (fest) |
| `tunnel_target_port` | `l4_listen_port` der referenzierten NAS-Route |
| `near_peers` | LAN-IPs der anderen Pool-Mitglieder (VRRP-Unicast-Liste für keepalived) |
| `vip_ip` / `vip_prefix` | direkt aus `egress_routes` |
| `lan_listen_port` | direkt aus `egress_routes` (High-Port) |
| `allowed_source_ips` | direkt aus `egress_routes` (JSON-Array) |

Die Konfiguration ist durch den Config-Hash (Version 2,
`CONFIG_HASH_VERSION=2`) abgedeckt. Server und Gateway müssen auf
derselben Hash-Version laufen (`config-hash`-Lib v1.2.0+); ohne
passende Version propagiert der Egress nicht.

## Einrichtung im Admin-UI

Die Egress-Konfiguration ist capability-gated: die UI erscheint im
Gateway-Detail nur, wenn das Gateway `scan_egress: true` in seiner
Telemetrie meldet **und** die Lizenz `gateway_scan_egress` aktiv ist.

1. **Ziel-NAS-Route anlegen** (falls noch nicht vorhanden):
   Routes → Neue Route → L4 → Gateway-Ziel → NAS-IP:445 →
   `external_enabled = false` (intern-only). `l4_listen_port` notieren.

2. **Egress-Route anlegen**:
   Gateways → Near-Gateway → Reiter *Scan-Ziele / Egress* →
   *Neue Egress-Route*.
   - **Name**: sprechende Bezeichnung
   - **VIP**: freie feste IP im LAN-Subnetz, **außerhalb** des
     DHCP-Bereichs (z. B. `192.168.1.200`)
   - **Ziel-NAS-Route**: die intern-only L4-Route aus Schritt 1
   - **Source-Lock** (`allowed_source_ips`): IP/CIDR des Druckers
     (optionaler Schutzfilter, siehe Sicherheit)
   - **Aktivieren**

3. **Drucker konfigurieren**: Scan-Ziel auf `\\192.168.1.200\<share>`
   (oder den konfigurierten VIP) setzen. Credentials des SMB-Shares
   eingeben (Gast/anonym ist verboten — siehe Sicherheit).

Nach dem Speichern wird der Near-Gateway per Config-Push benachrichtigt
(`/api/config-changed`). Der `EgressProxyManager` startet den
High-Port-Listener, und keepalived aktiviert die VIP auf der
primären Netzwerkschnittstelle.

## Sicherheit

**Die echte Vertrauensgrenze liegt am Ziel-NAS.**

Der Scan-Egress ist ein dummer TCP-Proxy. Alles was durch den Tunnel
läuft, wird byteweise weitergereicht — inklusive SMB-Signing und
SMB-Encryption, die Ende-zu-Ende durchgehen. Das bedeutet:

- **SMB-Credentials sind Pflicht.** Gast-Freigaben oder anonyme
  SMB-Shares sind verboten. Ein Angreifer, der die VIP erreicht,
  bekommt ohne gültige Credentials keinen Datei-Zugriff.
- **Der Source-Lock (`allowed_source_ips`) ist Defense-in-Depth,
  keine Sicherheitsgrenze.** Eine LAN-IP ist spoofbar. Der Filter
  reduziert die Angriffsfläche, ersetzt aber nicht die
  Authentifizierung am Ziel.
- **Das ferne Ende bleibt intern-only** (`external_enabled = 0`).
  Der Tunnel zu Port 445 verlässt den GC-Perimeter nicht nach außen.
- **NET_ADMIN / NET_RAW** sind auf den Container beschränkt und
  werden ausschließlich für die VRRP-Multicast-Kommunikation
  (keepalived) und die iptables-REDIRECT-Regel benötigt. Kein
  anderer Container-Dienst nutzt diese Capabilities.

## Failover-Semantik

### Near-Seite (VIP-Failover)

keepalived überwacht die Tunnel-Gesundheit des aktiven Gateways. Fällt
der primäre Near-Gateway aus, floatet die VIP innerhalb weniger
Sekunden auf das Backup-Mitglied des Pools. Der Drucker sendet
weiterhin an dieselbe VIP — die VIP-Adresse bleibt konstant, es ist keine Neukonfiguration nötig.

**Eine im Augenblick des Failovers laufende Übertragung bricht ab**
und muss vom Drucker oder Benutzer neu gestartet werden. Der nächste
Scan-Auftrag läuft ohne Re-Konfiguration durch.

### Far-Seite (NAS-Route / Pool-Routing)

Der `gatewayHealth`-Mechanismus der referenzierten intern-only L4-Route
pivotiert bei Gateway-Ausfall auf den nächsten lebenden Pool-Sibling
(typisch 60–90 s Reaktionszeit). Auch hier: eine unterbrochene
laufende Übertragung bricht und wird wiederholt; der Folge-Scan trifft
das neue Ziel-Gateway automatisch.

**Kein mid-transfer-nahtloser Failover.** Das ist ein TCP-Proxy auf
Verbindungsebene — ein Verbindungsabbruch ist ein Verbindungsabbruch.
Drucker-Firmware wiederholt den Scan-Auftrag in der Regel automatisch.

## Lizenz

- Feature-Flag: `gateway_scan_egress`
- Tier: **Pro**
- `COMMUNITY_FALLBACK`: `false`
- Alle API-Endpoints sind mit `requireFeature('gateway_scan_egress')`
  geschützt.
- Zusätzliches Capability-Gate: `scan_egress: true` in der Gateway-
  Telemetrie (Phase 1b); ohne das Flag erscheint die UI nicht, auch
  wenn die Lizenz aktiv ist.

## Relevante Dateien

### Server

- `src/db/migrationList.js` — Migration #54 (`egress_routes`-Tabelle)
- `src/services/egressRoutes.js` — CRUD, Validierung (L4+gateway+
  `external_enabled=0`; VIP im LAN-Subnetz; gültige CIDRs; High-Port)
- `src/services/gateways.js` — `getGatewayConfig()` befüllt
  `egress_routes[]` mit aufgelösten `tunnel_target_host/port` +
  `near_peers`
- `src/routes/api/gateways.js` — CRUD-Endpoints für Egress-Routen
  (`requireFeature` + Capability-Gate)
- `src/lib/configHash.js` — CONFIG_HASH_VERSION=2, Schema enthält
  `egress_routes`-Felder

### Gateway (v1.16.1, bereits ausgeliefert)

- `src/egress/EgressProxyManager.js` — High-Port-Listener,
  Tunnel-Forwarding
- `src/egress/NearManager.js` — keepalived-Integration, VIP-Bindung,
  iptables-REDIRECT (`<VIP>:445 → High-Port`)
- Telemetrie: `scan_egress: true` im Heartbeat-Payload

### Tests (Server)

- `tests/egressRoutes.test.js` — Validierungs- und CRUD-Tests
- `tests/gateways_getConfig.test.js` — Egress-Resolve-Payload
- `tests/configHash.test.js` — CONFIG_HASH_VERSION=2 + Egress-Schema

_Design + Pläne: `docs/superpowers/` (local-only, gitignored)._
