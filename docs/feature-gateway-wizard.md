# Gateway-Assistent „Gateway hinzufügen“

Gateways werden auf der Seite **Gateways** angelegt, nicht mehr über den Haken „Gateway“ im
Peer-Dialog. Der Assistent führt in vier Schritten durch Anlage, Einrichtung und ersten Start.

## Ablauf

1. **Name, Standort, Plattform:** Raspberry Pi · Synology NAS · Proxmox · anderer Linux-Rechner.
   Der Standort ist ein Gateway-Standort (optional, [feature-gateway-locations.md](feature-gateway-locations.md)):
   ein vorhandener oder „Neuer Standort …“, der direkt vor dem Gateway angelegt wird.
   Eine Peer-Gruppe setzt der Assistent nicht mehr.
2. **Nur Raspberry Pi:** Modell (Hinweis zur Leistung; Zero 2 W nur WLAN), LAN oder WLAN
   (SSID, Passwort, verstecktes Netz; WPA2 bzw. WPA2/WPA3-Mischbetrieb), Zigbee automatisch/aus,
   erweitert: Gerätename, Zeitzone, WLAN-Land, SSH-Public-Key.
3. **„Gateway anlegen“** ruft den bestehenden Endpunkt `POST /api/v1/peers` mit
   `{ is_gateway: true, platform, location_id }` auf — gleiche Rechte, CSRF- und Lizenzprüfungen
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
   - *Synology und Linux:* **Einrichtungsseite des Gateways** (gatecontrol-gateway
     `docs/setup-page.md`). (1) Compose-Datei ohne Zugangsdaten zum Kopieren/Herunterladen
     (`gateway-kit.js` `buildCompose`, dieselbe Quelle wie das NAS-Paket und „Nur
     docker-compose.yml herunterladen“; Linux: Host/Bridge), für die Synology zusätzlich
     `gatecontrol-gateway-nas.zip` **ohne** `gateway.env` (`POST /api/v1/gateways/:id/setup-package`:
     Compose, `update.sh`, leere Ordner `config/`, `gateway-state/`, `gateway-cache/`; nichts wird
     rotiert). (2) `http://<Adresse>:8642` öffnen. (3) **Serveradresse** und **Einrichtungscode**
     getrennt, je mit „Kopieren“, Countdown, „Neuen Code erzeugen“
     (`POST /api/v1/peers/:id/gateway-pairing-code` → `{ code, server, token, expiresAt }`).
     Darunter die Warte-Anzeige: `setup-status.pairing.consumed_at` zeigt, dass das Gateway den Code
     eingelöst hat – der Assistent geht von selbst zu Schritt 4. Automatische Updates eingeklappt.
   - *Bisheriger Weg (Link „Lieber die Datei gateway.env herunterladen“):* Synology
     `gatecontrol-gateway-nas.zip` mit `config/gateway.env` (`POST …/setup-bundle`, rotiert),
     Aufgabenplaner-Befehl; Linux Compose (Host/Bridge), `gateway.env`, `update.sh`, Cron-Zeile.
   - *Proxmox:* Einzeiler mit Kopplungscode `CODE@host` (`/gateway-pairing-code`, 10 Minuten, neu
     erzeugbar) – unverändert.
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

## „Zugang erneuern“

Gateway › „Mehr“ › **Zugang erneuern …** (`public/js/gateway-manage.js`): fragt immer nach, dann
`POST /api/v1/gateways/:id/renew-access` (nur Sitzung, CSRF). Der Server rotiert die Tokens
(die neuen werden verworfen) und stellt einen Einrichtungscode aus; die Antwort enthält nur
`{ code, server, expiresAt }`. Das laufende Gateway bekommt `403 invalid_token`, öffnet auf seiner
Einrichtungsseite die Code-Eingabe (Serveradresse dort fest) und holt sich mit dem Code eine neue
`gateway.env`. Ein deaktiviertes Gateway bekommt stattdessen `403 gateway_disabled` – dort öffnet
sich nichts. Gateways ohne die Capability `setup-page` (älter oder nie verbunden) gehen wie bisher
über den Assistenten bei Schritt 3 mit der Datei; der Link dorthin steht auch im Dialog.

## „Statusseite im Heimnetz“

Schalter pro Gateway im Reiter „Funktionen“ › „System“ (`gatewayFeatures` `setupPage.status`,
Standard an) → Config-Pull `features.setup_page.status`. Ohne Capability `setup-page` ausgegraut
mit Hinweis.

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
