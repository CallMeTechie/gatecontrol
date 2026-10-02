# Client-Richtlinien vom Server

Der Administrator legt fest, was die GateControl-Clients (Windows Pro,
Windows Community, Android) lokal erzwingen. Gesperrte Einstellungen zeigt der
Client deaktiviert mit dem Hinweis **„Vom Administrator festgelegt“**.

## Felder

| Feld (Admin-API)      | Client-API          | Werte                                    | Bedeutung |
|-----------------------|---------------------|------------------------------------------|-----------|
| `kill_switch`         | `killSwitch`        | `user` · `required`                      | `required`: Kill-Switch immer an, Schalter gesperrt |
| `auto_connect`        | `autoConnect`       | `user` · `required` · `always_on`        | `required`: beim Start automatisch verbinden, Schalter gesperrt. `always_on`: zusätzlich kann der Benutzer nicht manuell trennen |
| `autostart`           | `autostart`         | `user` · `required` · `forbidden`        | Start mit dem System erzwingen bzw. verbieten |
| `split_tunnel_modes`  | `splitTunnelModes`  | nicht-leere Teilmenge von `off`, `exclude`, `include` | Erlaubte Split-Tunnel-Modi (`off` = gesamter Verkehr) |
| `lock_settings`       | `lockSettings`      | `true` · `false`                         | Benutzer kann keine Client-Einstellungen ändern (Sprache/Design bleiben frei) |
| `lock_server`         | `lockServer`        | `true` · `false`                         | Serverwechsel / Neueinrichtung ausgeblendet |
| –                     | `splitTunnelLocked` | `true` · `false`                         | abgeleitet: ein gesperrtes Split-Tunnel-Preset gilt |

Ohne jede Konfiguration liefert der Server die Standardwerte (`user`, alle
Modi, keine Sperren) — also keine Einschränkung.

## Ebenen

`Standard ← global ← Peer-Gruppe ← Peer`, je Feld. Gruppe und Peer speichern
nur die Felder, die sie überschreiben (`null`/fehlend = erben).

* global: Einstellungen → **Client-Richtlinien** (linke Karte), Setting
  `client_policy`.
* Gruppe: Einstellungen → Client-Richtlinien (rechte Karte),
  Spalte `peer_groups.client_policy`.
* Peer: Peer bearbeiten → **Client-Richtlinie**, Spalte `peers.client_policy`.

Benutzer (Owner eines Peers) sind keine eigene Ebene: ein Benutzer kann
mehrere Geräte mit unterschiedlichen Anforderungen haben; Gruppen decken das
Bündeln ab.

### Split-Tunnel-Preset

Das bestehende Preset (Einstellungen → Split-Tunnel bzw. Token-Override,
`GET /api/v1/client/split-tunnel`) bleibt die Quelle für Modus und Netze. Ist
es **gesperrt** (`locked`), hat es Vorrang: `splitTunnelModes` ist dann nur
der Preset-Modus und `splitTunnelLocked = true`. Ein ungesperrtes Preset mit
einem nicht erlaubten Modus meldet die Admin-Oberfläche als Konflikt; die
Clients fallen auf einen erlaubten Modus zurück. Windows kennt nur
„Gesamter Verkehr“ (`off`) und „Nur ausgewählte Ziele“ (`include`).

## API

* `GET /api/v1/client/policy` (Token-Scope `client`) →
  `{ ok, version, managed, policy, sources }`. `ETag: "<version>"`,
  `If-None-Match` → `304`. Ein Token ohne Peer erhält die globale Richtlinie.
* `policyVersion` zusätzlich in `POST /api/v1/client/heartbeat` und
  `GET /api/v1/client/permissions` — weicht sie von der gespeicherten ab,
  lädt der Client die Richtlinie neu.
* Admin (nur Admin-Session, API-Tokens erhalten 403):
  `GET/PUT /api/v1/settings/client-policy`,
  `PUT /api/v1/settings/client-policy/groups/:id`,
  `PUT /api/v1/peers/:id` mit Feld `client_policy`,
  `GET /api/v1/peers/:id/client-policy` (Override, geerbt, effektiv).
  Jede Änderung landet im Aktivitätsprotokoll (`client_policy_updated`,
  `client_policy_group_updated`, `peer_client_policy_changed`).
* Migration **84** (`client_policies`).

## Verhalten der Clients

* Die zuletzt geladene Richtlinie wird lokal gespeichert und gilt auch
  offline. Ist der Server nicht erreichbar, bleibt die letzte bekannte
  Richtlinie aktiv. Eine **nie geladene** Richtlinie bedeutet: keine
  Einschränkung.
* Windows: Kill-Switch erzwungen und Schalter deaktiviert, Auto-Connect /
  Autostart erzwungen bzw. verboten, Split-Tunnel-Modi eingeschränkt,
  Einstellungen gesperrt, Serverwechsel ausgeblendet.
* Android: siehe Einschränkungen unten.

### Android-Einschränkungen

Eine App kann das System-**Always-on-VPN** und **„Verbindungen ohne VPN
blockieren“** nicht selbst einschalten — beides setzt nur der Benutzer (oder
ein MDM/Device-Owner) in den Android-Einstellungen. Fordert die Richtlinie
Kill-Switch oder Always-on, zeigt der Client einen deutlichen Hinweis mit
einer Schaltfläche zu den VPN-Systemeinstellungen. Erzwungen werden:
automatisches Verbinden beim Start/Neustart, Split-Tunnel-Sperre,
Einstellungs-Sperre, ausgeblendeter Serverwechsel und gesperrtes manuelles
Trennen in der App (bei `always_on`).

## Sicherheitsmodell

Die Richtlinie wird **vom Client** angewendet. Sie verhindert versehentliche
Änderungen und vereinheitlicht verwaltete Geräte, ist aber **keine
Sicherheitsgrenze** gegen einen Benutzer mit lokalen Administratorrechten
(der kann den Client beenden, seinen Speicher bearbeiten oder WireGuard von
Hand starten). Wer das verhindern muss, braucht zusätzlich
Betriebssystem-Mittel (Gruppenrichtlinien, MDM).
