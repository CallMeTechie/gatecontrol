# Lizenz: sanfter Rückfall, Produkt-Ende (EOL), Hauptversion

Status: umgesetzt (Branch `feat/license-soft-fallback-eol`). Verbindliche
Schnittstelle zwischen Server (`services/license.js`, `licenseV2.js`,
`licenseEol.js`), Lizenzserver/Website (Signatur der EOL-Datei, Claim `maj`)
und Oberfläche (Einstellungen → Lizenz, Dashboard). Wer abweicht, ändert
zuerst dieses Dokument.

## 1. Offline-Toleranz und Rückfall (7/14 Tage)

| Wert | Bedeutung |
|------|-----------|
| 7 Tage | `exp` jedes Tokens (App und Plugin), das der Lizenzserver ausstellt |
| 14 Tage | Kulanz ab der **letzten erfolgreichen** Prüfung, solange der Lizenzserver nicht erreichbar ist (`GRACE_MS`) |
| täglich | Prüfung; nach einem Netzfehler neue Versuche nach 5 min, 15 min, 1 h, dann stündlich |

Das letzte signierte Token gilt bis zu seinem `exp` oder bis 14 Tage nach der
letzten erfolgreichen Prüfung, je nachdem, was später kommt. Danach gilt der
Community-Plan. Diese 14 Tage gelten auch für Lifetime-Lizenzen (Entscheidung
43a), solange keine EOL-Datei vorliegt (§ 2).

**Vorwarnung.** Während der Kulanz zeigt das Dashboard den Eintrag
`license_offline` („Lizenzserver nicht erreichbar – Rückfall auf Community in
N Tagen“, ab 3 Tagen Rest als Fehler), die Lizenzseite das Datum des Rückfalls.
`GET /api/v1/license` liefert dazu
`offline: { last_ok_at, fallback_at, days_left }`.

**Rückfall ohne Schaden.** Fällt ein Lizenzschlüssel auf Community zurück –
Lizenzserver länger als die Kulanz nicht erreichbar, 403 (widerrufen,
abgelaufen), Lizenz entfernt oder Token für eine ältere Hauptversion (§ 3) –,
gilt für Peers, HTTP-/L4-Routen und Gateway-Pools über dem Limit:

- nur **ausschalten**, nie löschen; die Konfiguration bleibt vollständig,
- die **neuesten zuerst** (`created_at DESC`), die ältesten bleiben an,
- markiert mit `license_disabled = 1` (Migration 162),
- sobald wieder eine gültige Lizenz gilt (Start, Aktivierung, tägliche
  Prüfung, EOL), gehen die markierten **von selbst wieder an** – die ältesten
  zuerst, bis zum Limit der Lizenz.

Wer einen markierten Eintrag selbst einschaltet, löscht die Markierung
(SQL-Trigger); schaltet er ihn später wieder aus, bleibt er aus. Das Dashboard
zeigt `license_fallback` (Grund `offline` / `revoked` und die Zahl der
wartenden Einträge), die Lizenzseite dasselbe als Kasten. Aktivitätsprotokoll:
`peer_license_disabled`, `route_license_disabled`, `pool_disabled_by_license_enforcement`
beim Ausschalten, `peer_license_restored`, `route_license_restored`,
`pool_license_restored` beim Wiedereinschalten.

Ausgeschaltete Peers werden aus der laufenden WireGuard-Schnittstelle genommen
und die Konfiguration neu geschrieben (vorher wurde nur die alte Datei neu
geladen, der Peer blieb verbunden).

## 2. Produkt-Ende: signierte Datei `eol.json`

Stellt der Anbieter GateControl ein, veröffentlicht er **eine** signierte
Datei für alle Installationen. Sie enthält keinen Schlüssel, keinen
Fingerabdruck und nichts über eine Installation.

### Format

Datei `eol.json` (UTF-8, höchstens 32 KiB), Hülle:

```json
{ "v": 1, "product": "gatecontrol", "token": "<JWS>" }
```

Es zählt **nur** `token`; die übrigen Felder der Hülle sind Information. Die
bloße JWS (ohne Hülle) wird ebenso angenommen.

`token` ist eine kompakte JWS, genau wie die Lizenz-Tokens v2:

- Header: `{ "alg": "EdDSA", "kid": "<kid aus dem JWKS>", "typ": "JWT" }`
- Signatur: Ed25519 über `base64url(header) + "." + base64url(payload)`, mit
  dem privaten Schlüssel zu einem `kid` aus dem JWKS des Lizenzservers
  (`GET /api/licenses/keys`) – derselbe Schlüssel, der die App-Tokens signiert.
- Payload:

| Claim | Pflicht | Wert |
|-------|---------|------|
| `iss` | ja | `"callmetechie.de"` |
| `kind` | ja | `"eol"` |
| `v` | ja | `1` |
| `product` | ja | `"gatecontrol"` |
| `scope` | ja | `"lifetime"` oder `"all"` (s. u.) |
| `iat` | ja | Ausstellungszeit, Unix-Sekunden (Ganzzahl); höchstens 1 Tag in der Zukunft |
| `message` | nein | Text an die Kunden: String oder `{ "de": "…", "en": "…" }`, je höchstens 1000 Zeichen |

Kein `exp`, kein `fp`: die Datei gilt unbefristet und für alle.

Beispiel (PHP, libsodium – wie die App-Tokens):

```php
$h = b64url(json_encode(['alg' => 'EdDSA', 'kid' => $kid, 'typ' => 'JWT']));
$p = b64url(json_encode(['iss' => 'callmetechie.de', 'kind' => 'eol', 'v' => 1,
  'product' => 'gatecontrol', 'scope' => 'all', 'iat' => time(),
  'message' => ['de' => '…', 'en' => '…']]));
$sig = b64url(sodium_crypto_sign_detached("$h.$p", $secretKey));
file_put_contents('eol.json', json_encode(['v' => 1, 'product' => 'gatecontrol', 'token' => "$h.$p.$sig"]));
```

### Prüfung im Server

Die Datei wird mit denselben Schlüsseln geprüft wie die Lizenz-Tokens
(`licenseV2.verifyJws`): fest vorgegebene `GC_LICENSE_PUBKEYS`, sonst der in
der Datenbank zwischengespeicherte JWKS, bei unbekanntem `kid` höchstens
stündlich neu geholt. Nur `alg: EdDSA`; HS256 und `none` werden abgelehnt.
Eine selbst gebaute oder veränderte Datei besteht die Prüfung nicht. Auch eine
gespeicherte Datei wird bei jedem Start neu geprüft.

Wichtig für den Ernstfall: Ist der Lizenzserver weg, braucht der Server den
öffentlichen Schlüssel aus seinem JWKS-Zwischenspeicher (jede Installation,
die einmal v2 geprüft hat, hat ihn) oder aus `GC_LICENSE_PUBKEYS`. Der
Signaturschlüssel darf deshalb vor dem EOL **nicht gewechselt** werden, ohne
dass die Installationen den neuen `kid` schon kennen.

### Woher der Server die Datei nimmt

1. Datei unter `GC_LICENSE_EOL_FILE` (Standard `/data/eol.json`), beim Start
   gelesen; in der Oberfläche nicht entfernbar.
2. Hochgeladen in Einstellungen → Lizenz → „Produkt eingestellt (End of
   Life)“ (`POST /api/v1/license/eol` mit `{ "content": "<Dateiinhalt>" }`,
   entfernen mit `DELETE /api/v1/license/eol`).
3. Automatisch abgeholt von `GC_LICENSE_EOL_URL` (Komma-Liste, der Reihe nach):
   - `https://callmetechie.de/api/v2/licenses/eol`
   - `https://github.com/CallMeTechie/gatecontrol/releases/download/eol/eol.json`
     (Release-Asset, falls die Website schon weg ist)

   `GET`, ohne Daten der Installation; `200` mit dem Inhalt von `eol.json`
   (`application/json`), `404`, solange keine veröffentlicht ist. Abgeholt
   wird nur mit Lizenzschlüssel, nur solange die Lizenz gerade nicht online
   bestätigt ist (offline oder Community) und höchstens alle 12 Stunden;
   „Lizenz aktualisieren“ holt sofort.

### Wirkung

| | `scope: "lifetime"` | `scope: "all"` |
|--|--|--|
| Server-Lizenz ohne Ende (`lat = 0`) | gilt ohne Lizenzserver unbefristet | ebenso |
| Plugin-Lizenz ohne Ende (`lat = 0`, z. B. `source: lifetime`) | gilt unbefristet | ebenso |
| Abo (`lat > 0`) | unverändert: 14 Tage Kulanz | gilt ohne Lizenzserver bis `lat` |

Für eine abgedeckte Lizenz fragt der Server den Lizenzserver **nicht mehr**
(auch ein 403 kann sie dann nicht mehr entziehen). `verification` ist `eol`,
die Lizenzseite zeigt „Produkt eingestellt – keine Updates mehr“ und den Text
aus `message`. Ohne gespeichertes Token (nie online aktiviert) hilft die
EOL-Datei nicht.

## 3. Hauptversion (`maj`, vorbereitet)

Das App-Token darf den Claim `maj` (Ganzzahl ≥ 1) tragen: die Hauptversion,
für die die Lizenz gilt. Der Server vergleicht mit seiner eigenen (erste Zahl
der Version in `package.json`):

- `maj` fehlt, ist keine Ganzzahl ≥ 1 → gilt für jede Version (wie bisher),
- `maj` ≥ eigene Hauptversion → gilt,
- `maj` < eigene Hauptversion → „Upgrade nötig“: Dashboard `license_upgrade`,
  Kasten auf der Lizenzseite, `upgrade_required: { licensed, installed }` in
  `GET /api/v1/license`; es gilt der Community-Plan mit dem sanften Rückfall
  aus § 1. Das Token bleibt gespeichert, die Prüfung läuft weiter – eine
  Upgrade-Lizenz (`maj` neu) gilt sofort und schaltet alles wieder ein.

Der Lizenzserver setzt `maj` erst, wenn es eine zweite Hauptversion gibt.
