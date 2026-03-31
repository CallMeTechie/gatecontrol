# Machine Binding — Design Spec

Bindet API-Tokens an die Maschine des Clients, sodass gestohlene Tokens nicht von anderen Geräten genutzt werden können.

## Lizenz

- Feature-Key: `machine_binding: false` in `COMMUNITY_FALLBACK`
- Enforcement via `requireFeature('machine_binding')` auf relevanten Endpoints

## Datenmodell

### Migration 30 — `api_tokens` erweitern

```sql
ALTER TABLE api_tokens ADD COLUMN machine_fingerprint TEXT;
ALTER TABLE api_tokens ADD COLUMN machine_binding_enabled INTEGER DEFAULT 0;
```

- `machine_fingerprint`: `SHA256(MachineGuid)` (64 Hex-Zeichen). Gesetzt bei erster Registrierung, `NULL` = ungebunden.
- `machine_binding_enabled`: Nur relevant im `individual`-Modus. `1` = Binding aktiv für diesen Token.

### Settings

- `machine_binding.mode` — `"off"` (Default), `"global"`, `"individual"`
  - `off`: Kein Machine-Binding (Feature deaktiviert oder nicht lizenziert)
  - `global`: Alle Client-Tokens werden automatisch gebunden
  - `individual`: Nur Tokens mit `machine_binding_enabled = 1`

### Logik-Matrix

| Mode         | Token `machine_binding_enabled` | Binding aktiv? |
|--------------|--------------------------------|----------------|
| `off`        | egal                           | Nein           |
| `global`     | egal                           | Ja             |
| `individual` | `0`                            | Nein           |
| `individual` | `1`                            | Ja             |

## Fingerprint

- Quelle: Windows Registry `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
- Transport: `SHA256(MachineGuid)` als Hex-String (Klartext-GUID wird nie übertragen)
- Header: `X-Machine-Fingerprint` bei jedem Request an `/api/v1/client/*`

## API-Flow

### Registrierung (`POST /api/v1/client/register`)

1. Token authentifiziert (bestehend)
2. Prüfe: Ist Machine-Binding aktiv für diesen Token? (Mode + per-Token Flag)
3. Wenn ja:
   a. Token hat noch keinen Fingerprint → speichere `X-Machine-Fingerprint` am Token
   b. Token hat bereits Fingerprint → vergleiche mit Header
      - Match → weiter wie bisher
      - Mismatch → 403 `"Token is bound to a different machine"`
4. Wenn nein: Registrierung wie bisher (Fingerprint wird ignoriert)

### Alle anderen Client-Endpoints (`/config`, `/heartbeat`, `/traffic`, etc.)

1. Token authentifiziert (bestehend)
2. Peer-Ownership geprüft (bestehend, IDOR-Fix)
3. Prüfe: Ist Machine-Binding aktiv für diesen Token?
4. Wenn ja:
   a. Kein Fingerprint am Token → 403 `"Token is not bound. Register first."`
   b. Header fehlt → 403 `"Machine fingerprint required"`
   c. Header != gespeicherter Fingerprint → 403 `"Token is bound to a different machine"`
   d. Match → OK
5. Wenn nein: weiter ohne Prüfung

### Prüflogik

Helper-Funktion `verifyMachineBinding(req, res)` in `client.js`, aufgerufen nach `requirePeerOwnership()`. Liest den Binding-Mode aus Settings und prüft `machine_binding_enabled` am Token.

### Admin: Binding zurücksetzen

```
DELETE /api/v1/tokens/:id/binding
```

- Setzt `machine_fingerprint = NULL` am Token
- Erfordert Session-Auth (Admin-UI)
- Lizenzprüfung: `requireFeature('machine_binding')`
- Activity-Log: `"Machine binding for token X reset"`
- Beim nächsten Client-Request wird der neue Fingerprint automatisch gespeichert

## Windows Client

### Fingerprint generieren

- Windows Registry: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` auslesen
- `SHA256` hashen, als 64-Zeichen-Hex-String
- Einmalig beim App-Start auslesen und cachen

### Header senden

- `X-Machine-Fingerprint` wird an jeden Request angehängt (Axios-Interceptor)
- Keine Client-seitige Logik ob Binding aktiv ist — Server entscheidet
- Keine Konfiguration im Client nötig

## Admin-UI

### Token-Liste (Settings-Seite)

- Badge "Gebunden" + erste 8 Zeichen des Fingerprints wenn `machine_fingerprint` gesetzt
- Badge "Ungebunden" wenn `NULL`
- Button "Binding zurücksetzen" pro Token (nur sichtbar wenn Fingerprint gesetzt)
- Bestätigungsdialog vor Reset

### Token-Erstellung

- Neue Checkbox "An Maschine binden" (`machine_binding_enabled`)
- Nur sichtbar wenn `machine_binding.mode === 'individual'` und Feature lizenziert

### Settings-Seite

- Neuer Abschnitt "Machine Binding" unter Security-Settings
- Dropdown: Modus — "Aus" / "Global" / "Individuell"
- Lizenz-Lock: Ausgegraut mit Upgrade-Hinweis wenn Feature nicht lizenziert
- Kurze Erklärung des Features

## Error Handling & Edge Cases

| Situation | Verhalten | HTTP |
|---|---|---|
| Binding aktiv, Header fehlt | `"Machine fingerprint required"` | 403 |
| Binding aktiv, Header != gespeichert | `"Token is bound to a different machine"` | 403 |
| Binding aktiv, Token ohne Fingerprint, Endpoint != `/register` | `"Token is not bound. Register first."` | 403 |
| Fingerprint ungültiges Format (nicht 64 Hex-Zeichen) | `"Invalid machine fingerprint format"` | 400 |
| Admin wechselt Mode `global` → `off` | Fingerprints bleiben in DB, werden nicht geprüft. Bei Wechsel zurück greifen sie sofort wieder | — |
| Admin wechselt Mode `individual` → `global` | Alle Client-Tokens werden gebunden, auch ohne `machine_binding_enabled` | — |
| Feature nicht mehr lizenziert | Binding wird nicht geprüft. Fingerprints bleiben in DB | — |
| Peer wird gelöscht | `peer_id` wird NULL (ON DELETE SET NULL). Fingerprint bleibt. Client muss sich neu registrieren | — |

## Bewusst nicht gebaut

- Kein Fingerprint-Rotation/Refresh
- Keine Binding-History
- Kein Client-seitiges UI für Binding-Status
- Kein Batch-Reset für alle Tokens

## i18n

Neue Keys für DE + EN:
- Setting-Labels und Beschreibungen
- Fehlermeldungen (403/400 Responses)
- Badge-Texte und Bestätigungsdialoge
- Token-Erstellung Checkbox-Label
