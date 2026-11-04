# Gateway-Assistent „Gateway hinzufügen“

Gateways werden auf der Seite **Gateways** angelegt, nicht mehr über den Haken „Gateway“ im
Peer-Dialog. Der Assistent führt in vier Schritten durch Anlage, Einrichtung und ersten Start.

## Ablauf

1. **Name, Standort, Plattform:** Raspberry Pi · Synology NAS · Proxmox · anderer Linux-Rechner.
   Der Standort ist eine Peer-Gruppe (optional).
2. **Nur Raspberry Pi:** Modell (Hinweis zur Leistung; Zero 2 W nur WLAN), LAN oder WLAN
   (SSID, Passwort, verstecktes Netz; WPA2 bzw. WPA2/WPA3-Mischbetrieb), Zigbee automatisch/aus,
   erweitert: Gerätename, Zeitzone, WLAN-Land, SSH-Public-Key.
3. **„Gateway anlegen“** ruft den bestehenden Endpunkt `POST /api/v1/peers` mit
   `{ is_gateway: true, platform, group_id }` auf — gleiche Rechte, CSRF- und Lizenzprüfungen
   (`gateway_peers` → 403 mit `feature`). Danach steht `#setup/<id>` in der Adresse, ein
   Neuladen setzt die Einrichtung fort statt ein zweites Gateway anzulegen.
4. **Schritt 3 je Plattform**
   - *Raspberry Pi:* Link auf das Image des neuesten Releases (Asset-Name/Größe aus
     `services/gatewayRelease.js`, sonst Release-Seite), **`gatecontrol-setup.zip` wird im
     Browser gebaut** (`gatecontrol/gateway.env` + `gatecontrol/settings.txt`, ZIP ohne
     Kompression aus `public/js/gateway-kit.js`). WLAN-Passwort und SSH-Schlüssel verlassen den
     Browser nicht; die Eingaben werden dort geprüft (SSID ≤ 32 Byte, PSK 8–63 oder 64 Hex,
     Hostname RFC 1123, OpenSSH-Schlüssel ed25519/ecdsa/rsa ≥ 3072). Imager-Repository-URL
     eingeklappt zum Kopieren.
   - *Synology:* `gatecontrol-gateway-nas.zip` vom Server (`POST /api/v1/gateways/:id/setup-bundle`):
     `docker-compose.yml` (Onboarding-Vorlage, Synology-Variante, `./gateway-state:/state`),
     `config/gateway.env`, `gateway-state/`, `update.sh` (vendored Vorlage). Feste Dateinamen.
     Aufgabenplaner-Befehl mit `GATEWAY_STATE_DIR` und `GC_GW_COMPOSE_DIR` passend zum Ordner.
   - *Proxmox:* Einzeiler mit Kopplungscode (`/gateway-pairing-code`, 10 Minuten, neu erzeugbar).
   - *Linux:* Compose (Host/Bridge), `gateway.env`, `update.sh`, Cron-Zeile.
5. **Live-Status** (`GET /api/v1/gateways/:id/setup-status`, Abfrage mit Back-off 3 s → 15 s,
   sofort bei `gc:gateway`-Ereignissen): angelegt → erster Kontakt (`gateway_meta.first_seen_at`,
   WireGuard-Handshake) → Hardware (Telemetrie `hardware` ab Gateway 1.17.0, ältere: übersprungen)
   → Zigbee/deCONZ (wenn `hardware.radios` ein Funkmodul meldet; „läuft“ aus der
   `route_reachability` der deCONZ-Route). Hilfe-Box nach 10 Minuten ohne Kontakt.

## gateway.env

Die Tokens liegen nur gehasht bzw. verschlüsselt auf dem Server. Direkt nach der Anlage hält der
Browser die `gateway.env` aus der Antwort im Speicher. Beim Fortsetzen (und für das NAS-Paket)
erzeugt der Server neue Tokens (`gateway-env/rotate`); war das Gateway schon verbunden, fragt der
Assistent vorher nach.

## „Im Smart Home einbinden“

`POST /api/v1/gateways/:id/smarthome` (nur Admin-Sitzung, CSRF, idempotent): legt — falls noch
keine da ist — eine **interne** HTTP-Route über dieses Gateway auf `127.0.0.1:8090` an
(Vorschlag `phoscon-<name>.<GC_DNS_DOMAIN>`, Lizenzgrenzen wie beim Anlegen einer Route) und weist
sie dem Zugriffsziel `gateway` des Plugins `gatecontrol-smarthome` zu (Aktivitätslog
`plugin_target_changed`). Den deCONZ-API-Schlüssel holt danach das Plugin („Gateway verbinden“,
in Phoscon „Gateway entsperren“). „Phoscon öffnen“ erscheint nur, wenn diese Route existiert,
sonst der Hinweis `http://<hostname>:8090` im Heimnetz.

## Gateway-Seite und Peers

- Knopf „Gateway hinzufügen“ (`#add`), Karten „wartet auf ersten Start“ mit „Einrichtung
  fortsetzen“ (`#setup/<id>`, Schritt 3 der gespeicherten Plattform; ohne Plattform erst die
  Wahl in Schritt 1).
- Peers: Hinweis mit Link statt Gateway-Haken; im Bearbeiten-Dialog eines Gateways
  „Einrichtung erneut anzeigen“. Der bisherige Token-Dialog bleibt erreichbar.

## Daten

Migration 126 `gateway_meta_platform`: `platform` (`rpi`|`synology`|`proxmox`|`linux`|NULL),
`first_seen_at` (erster Heartbeat; bestehende Gateways: letzter Heartbeat).
