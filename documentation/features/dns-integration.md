# DNS-Integration (Pi-Hole / AdGuard)

## Übersicht

Die DNS-Integration ermöglicht es, einen eigenen DNS-Server (z.B. Pi-Hole, AdGuard Home) für alle WireGuard-VPN-Peers zu konfigurieren. Statt der Standard-DNS-Server (Cloudflare/Google) wird der DNS-Traffic der VPN-Peers über den konfigurierten DNS-Server geleitet — automatisch, ohne manuelle Konfiguration auf den Endgeräten.

**Lizenz-Feature-Key:** `custom_dns`

## Funktionsweise

Der DNS-Server wird in die WireGuard-Client-Konfiguration geschrieben (`DNS = ...` im `[Interface]`-Block). Wenn ein Peer sich per WireGuard verbindet, nutzt er automatisch den konfigurierten DNS-Server.

### DNS-Priorität (Fallback-Kette)

```
1. Per-Peer DNS Override     (höchste Priorität)
2. Globaler Custom DNS       (Settings)
3. GC_WG_DNS Environment     (Fallback, Default: 1.1.1.1,8.8.8.8)
```

Beispiel:
- Global DNS auf `10.8.0.50` (Pi-Hole) gesetzt
- Peer "Laptop" hat keinen Override → nutzt `10.8.0.50`
- Peer "IoT-Sensor" hat Override `1.1.1.1` → nutzt `1.1.1.1` (Standard-DNS)

## Einrichtung

### Voraussetzung: DNS-Server im VPN

Der DNS-Server (Pi-Hole/AdGuard) muss über das WireGuard-VPN erreichbar sein:

1. Pi-Hole/AdGuard als WireGuard-Peer in GateControl anlegen
2. Der Peer bekommt eine VPN-IP (z.B. `10.8.0.50`)
3. Pi-Hole/AdGuard so konfigurieren, dass es auf der VPN-IP lauscht

### Globalen DNS konfigurieren

1. **Einstellungen** → **Allgemein** → **DNS Server**
2. IP-Adresse des DNS-Servers eintragen (z.B. `10.8.0.50`)
3. **Speichern** klicken

Mehrere DNS-Server können komma-getrennt eingetragen werden (z.B. `10.8.0.50,1.1.1.1`).

### Per-Peer DNS Override

Einzelne Peers können einen abweichenden DNS-Server nutzen:

1. **Peers** → Peer bearbeiten (Edit-Icon)
2. **DNS Server (Override)** — IP-Adresse eintragen
3. **Speichern**

Leer lassen = globaler DNS wird verwendet.

### Bestehende Peers aktualisieren

**Wichtig:** Bestehende Peers müssen nach einer DNS-Änderung ihre WireGuard-Konfiguration neu herunterladen. GateControl kann DNS-Einstellungen nicht live an verbundene Peers pushen — das ist eine WireGuard-Limitation.

So geht's:
1. Peer-Seite öffnen → QR-Code oder Config-Download
2. Auf dem Endgerät: alte WireGuard-Config löschen, neue importieren
3. Verbindung neu aufbauen

Neue Peers erhalten die aktuelle DNS-Konfiguration automatisch.

## Anwendungsbeispiele

### Ad-Blocking für alle VPN-Clients

1. Pi-Hole als Peer verbinden → `10.8.0.50`
2. Settings → DNS Server → `10.8.0.50`
3. Alle Peers sind werbefrei

### Gemischte Konfiguration

- **Smartphones/Laptops** → Pi-Hole DNS (global, `10.8.0.50`)
- **IoT-Geräte** → Standard-DNS (Per-Peer Override: `1.1.1.1`) — weil Pi-Hole manche IoT-Domains blockt
- **Kinder-Tablet** → AdGuard mit Familienfilter (Per-Peer Override: `10.8.0.51`)

### Interner DNS-Server

Firmen-DNS-Server als Custom DNS eintragen. VPN-Peers können interne Hostnamen auflösen (z.B. `intranet.firma.local`).

## API

### Globalen DNS lesen

```
GET /api/v1/settings/dns
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "dns": "10.8.0.50",
    "is_custom": true,
    "default_dns": "1.1.1.1,8.8.8.8"
  }
}
```

### Globalen DNS setzen

```bash
curl -X PUT /api/v1/settings/dns \
  -H "Content-Type: application/json" \
  -d '{"dns": "10.8.0.50"}'
```

Leerer String setzt auf den Default zurück:
```bash
curl -X PUT /api/v1/settings/dns \
  -H "Content-Type: application/json" \
  -d '{"dns": ""}'
```

### Per-Peer DNS setzen

```bash
# Beim Erstellen
curl -X POST /api/v1/peers \
  -H "Content-Type: application/json" \
  -d '{"name": "Laptop", "dns": "10.8.0.50"}'

# Beim Bearbeiten
curl -X PUT /api/v1/peers/:id \
  -H "Content-Type: application/json" \
  -d '{"dns": "1.1.1.1"}'

# Override entfernen (zurück zu global)
curl -X PUT /api/v1/peers/:id \
  -H "Content-Type: application/json" \
  -d '{"dns": ""}'
```

## Validierung

- DNS-Adressen müssen gültige IPv4-Adressen sein
- Mehrere Adressen werden komma-getrennt akzeptiert (z.B. `10.8.0.50,1.1.1.1`)
- Format-Validierung: `/^(\d{1,3}\.){3}\d{1,3}$/` pro Eintrag

## Einschränkungen

- **Kein automatisches Update bestehender Peers** — Peers müssen Config neu herunterladen (WireGuard-Limitation)
- **Nur IPv4** — IPv6-DNS-Server werden nicht validiert
- **Kein DNS-over-HTTPS/TLS** — Standard-DNS über UDP/TCP
- **Client-seitig** — DNS wird nur in der Client-Config gesetzt, nicht serverseitig

## Technische Details

### Betroffene Dateien

| Datei | Funktion |
|-------|----------|
| `src/services/license.js` | Feature-Key `custom_dns` in COMMUNITY_FALLBACK |
| `src/services/peers.js` | DNS-Fallback-Kette in `getClientConfig()` |
| `src/routes/api/settings.js` | GET/PUT `/settings/dns` Endpoint |
| `src/routes/api/peers.js` | `dns` Feld in POST (Create) |
| `src/middleware/locals.js` | `wgDns` an Template-Context |
| `templates/default/pages/settings.njk` | DNS-Card im General-Tab |
| `templates/default/partials/modals/peer-add.njk` | DNS-Override-Feld |
| `templates/default/partials/modals/peer-edit.njk` | DNS-Override-Feld |
| `public/js/settings.js` | DNS Save-Handler |
| `public/js/peers.js` | DNS in Create/Edit Payload |

### Datenbank

**Globaler DNS:** Settings-Tabelle, Key `custom_dns`

**Per-Peer DNS:** Spalte `peers.dns` (TEXT) — existierte bereits seit der initialen Migration. Wird bei Backup/Restore automatisch mitgesichert.

### WireGuard-Client-Config

```ini
[Interface]
PrivateKey = ...
Address = 10.8.0.3/32
DNS = 10.8.0.50          ← Custom DNS aus Fallback-Kette

[Peer]
PublicKey = ...
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

Die `DNS`-Zeile ist ein wg-quick(8) Direktive — sie wird vom WireGuard-Client ausgewertet, nicht vom Server. Der Server-seitige `wg syncconf` ignoriert DNS korrekt.
