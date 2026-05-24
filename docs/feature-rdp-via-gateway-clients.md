# RDP-Gateway-Routen: Client-Connect-Endpunkt (Server-Phase A)

Verwandtes Dokument: [RDP-Route mit Access-Mode „Über Home-Gateway"](feature-rdp-via-gateway.md)

## Was es löst

Vor dieser Änderung lieferte die Client-API (`GET /api/v1/client/rdp`) bei einer Gateway-RDP-Route
nur die LAN-IP des Zielgeräts als Verbindungsziel — eine Adresse, die von außen nicht erreichbar ist.
Clients mussten selbst wissen, welchen öffentlichen Endpunkt (Server-IP + Listen-Port) sie stattdessen
ansprechen müssen.

Ab dieser Server-Phase berechnet der Server pro RDP-Route einen effektiven Verbindungsendpunkt und
gibt ihn als `connect_address` + `connect_port` in der API zurück. Clients müssen nur noch diesen
Endpunkt öffnen — keine Sonderbehandlung nach Access-Mode mehr nötig.

## `connect_address` / `connect_port` — Auflösung nach Access-Mode

| Access-Mode | `connect_address` | `connect_port` |
|---|---|---|
| `gateway` | `GC_RDP_PUBLIC_HOST` (falls gesetzt) — sonst Host aus `GC_BASE_URL` | `gateway_listen_port` (oder `port` als Fallback) |
| `external` / `both` | `external_hostname` | `external_port` |
| `internal` | `host` | `port` |

Die Felder erscheinen auf zwei Endpunkten:

- `GET /api/v1/client/rdp` — Liste aller RDP-Routen des aufrufenden Nutzers
- `GET /api/v1/client/rdp/:id/connect` — Verbindungsdetails für eine einzelne Route

### Optionale Umgebungsvariable `GC_RDP_PUBLIC_HOST`

Wenn GateControl hinter Cloudflare, einem NAT-Gateway oder einem Reverse-Proxy läuft, dessen
öffentlicher Hostname nicht direkt den rohen L4-RDP-Port (`gateway_listen_port`) durchreicht,
kann der korrekte Hostname explizit gesetzt werden:

```
GC_RDP_PUBLIC_HOST=rdp.example.com
```

Ohne diese Variable wird der Host aus `GC_BASE_URL` verwendet (z.B. `mein-server.example.com`).
In einfachen Setups ohne CDN ist das der richtige Wert und die Variable muss nicht gesetzt werden.

Konfigurationspfad in `config.js`: `rdp.publicHost`.

## Reachability-Verhalten für Gateway-Routen

Der RDP-Health-Monitor (`rdpMonitor.js`) behandelt Gateway-Routen besonders:

1. **Loopback-Listener statt LAN-IP prüfen** — Der Monitor verbindet sich auf `127.0.0.1:gateway_listen_port`
   (den lokalen L4-TCP-Listener), nicht auf die im Feld „Host" eingetragene LAN-IP. Die LAN-IP ist vom
   Server aus nicht erreichbar; der Loopback-Port ist vorhanden, solange Caddy die Route aktiv hat.

2. **Gateway-Peer-Heartbeat als Gate** — Selbst wenn der Loopback-Port antwortet, wird die Route nur
   als „online" gemeldet, wenn der verknüpfte Gateway-Peer zuletzt innerhalb des Heartbeat-Fensters
   gemeldet hat. Ist der Heimgateway tot (kein Heartbeat), meldet der Monitor die Route sofort als
   offline — verhindert falsch-positive „online"-Status während der Gateway-Container ausfällt.

## Manuelle End-to-End-Checkliste

Da der Gateway-Companion im CI nicht verfügbar ist, gibt es keinen automatisierten E2E-Test für diese
Funktion. Vor einem Release bitte folgende Punkte manuell prüfen:

- [ ] **Gateway-Peer online**: Im Admin-UI ist der Gateway-Peer als „online" / heartbeating eingetragen.
      `wg show wg0 | grep handshake` auf dem Server sollte eine aktuelle Verbindungszeit zeigen.
- [ ] **RDP-Route anlegen**: RDP-Route mit `access_mode = gateway`, einer LAN-IP als „Host", dem
      richtigen Gateway-Peer und einem `gateway_listen_port` (z.B. 13389) anlegen.
- [ ] **Auto-L4-Route vorhanden**: In der Routes-Tabelle (Admin → Routen) erscheint eine Route mit
      `route_type = l4`, `target_kind = gateway` und einer Description der Form
      `auto-created for RDP route …`.
- [ ] **Connect-Endpunkt prüfen**:
      ```bash
      curl -s -H "Authorization: Bearer <token>" \
        https://<server>/api/v1/client/rdp/<id>/connect | jq '{connect_address, connect_port}'
      ```
      Erwartetes Ergebnis: `connect_address` = öffentlicher Hostname (oder `GC_RDP_PUBLIC_HOST`),
      `connect_port` = `gateway_listen_port`.
- [ ] **Client verbindet**: Ein Pro- oder Android-Client (mit Gateway-connect-address-Unterstützung,
      Phase B/C) öffnet die Route — der Client verwendet `connect_address:connect_port` und landet
      über den Gateway-Tunnel auf dem Ziel-Windows-Rechner.
- [ ] **Gateway offline → Route offline**: Gateway-Container stoppen oder WG-Tunnel trennen.
      Nach Ablauf des Heartbeat-Fensters (Standard: 3 min) zeigt die RDP-Route im Client als „offline".
- [ ] **`GC_RDP_PUBLIC_HOST` (optional)**: Variable auf einen abweichenden Hostnamen setzen, Server
      neu starten, `/connect`-Endpunkt aufrufen — `connect_address` muss den neuen Wert zeigen.

## Kompatibilitätshinweis

Die Server-API-Änderungen sind **rückwärtskompatibel** — neue Felder werden zusätzlich geliefert,
keine bestehenden Felder werden entfernt oder umbenannt.

**Pro-Client (Windows) und Android-Client** müssen jedoch die Version mit Gateway-connect-address-
Unterstützung haben, um Gateway-RDP-Routen korrekt aufzubauen:

- **Phase B** — Pro-Client (Windows): liest `connect_address`/`connect_port` aus dem API-Response
  und öffnet die RDP-Session gegen den öffentlichen Endpunkt statt gegen die LAN-IP.
- **Phase C** — Android-Client: analog.

Ältere Client-Versionen ignorieren `connect_address`/`connect_port` und versuchen weiterhin, direkt
zur LAN-IP zu verbinden — was bei Gateway-Routen fehlschlägt. Für Nutzer mit älteren Clients ändert
sich nichts am bestehenden Verhalten.

## Relevante Dateien (Server)

- `src/services/rdpMonitor.js` — Gateway-aware Health-Monitor (Loopback-Probe + Heartbeat-Gate)
- `src/routes/api/client.js` — `resolveConnectEndpoint()` + Felder in `/client/rdp` und `/client/rdp/:id/connect`
- `src/config.js` — `rdp.publicHost` aus `GC_RDP_PUBLIC_HOST`
- `public/js/rdp.js` — Wizard-UI: Host-Hint, NLA-Note, Peer-Autocomplete-Unterdrückung im Gateway-Mode
