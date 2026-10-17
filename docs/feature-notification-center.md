# Benachrichtigungszentrale: Push an die eigenen Apps ohne Fremddienste

Status: **Plan, zur Freigabe durch den Maintainer.** Noch nicht verbindlich.
Mockups: Arbeitsfläche „GateControl Benachrichtigungszentrale – Mockups“
(Admin-Übersicht, Regeln, Geräte, Verlauf, Portal, Android ×4, Windows ×3).

## Ziel

GateControl benachrichtigt die eigenen Apps (Android, Windows Pro, Windows
Community) direkt vom eigenen Server, **ohne Google FCM, Apple APNs, ntfy oder
andere Dienste**. Die Apps erreichen den Server auch **ohne VPN-Verbindung**:
Sie halten selbst eine ausgehende HTTPS-Verbindung zum öffentlich erreichbaren
Server. Im Router muss nichts geöffnet werden, ein Gateway wird dafür nicht
gebraucht.

Wer schickt Nachrichten?

* **Kernfunktionen:** alles, was heute schon `activity.log()` schreibt, also
  Sicherheit, Geräte und Gateways, Routen, Zertifikate und System.
* **Plugins:** über `gc.notify()`, zum Beispiel „Laden abgeschlossen“ oder
  „Morgen: Gelber Sack“.
* **Admins:** von Hand über „Nachricht senden“.

Wer bekommt sie? Personen bzw. ihre Geräte, gesteuert über Regeln (Admin) und
Abos (jede Person für sich).

Nicht Ziel: iOS/macOS (bräuchte APNs), SMS und Messenger-Bots. E-Mail und
Webhooks bleiben unverändert, sie werden lediglich zu „Kanälen“ derselben
Regeln.

## Was es schon gibt (Ausgangslage, Stand 1.153.2)

| Baustein | Ort | Nutzen für dieses Projekt |
|---|---|---|
| Ereignis-Bus | `src/services/eventBus.js` | In-Process-Pub/Sub, bisher nur für die Admin-Oberfläche |
| SSE-Stream | `src/routes/api/events.js` (`/api/v1/events`) | Vorlage für Keepalive (25 s), Backpressure und Mount vor dem `apiLimiter` |
| Zentraler Haken | `activity.log()` in `src/services/activity.js` | Ruft schon E-Mail (`notifications.genericMailFor`) und Webhooks auf. **Hier wird Push angehängt.** |
| Ereigniskatalog | `CATALOGUE` in `src/services/notifications.js` | Gruppen security/peers/routes/system; daraus werden die Regeln |
| E-Mail-Einstellungen | `notifications.email`, `alerts.email_events` | werden in die Regeln übernommen |
| Geräte-Anmeldung | API-Token `gc_…` (`X-API-Token`), Scope `client`, `api_tokens.user_id/peer_id`, `device_users` | Authentifiziert den Push-Kanal pro Gerät |
| Plugin-API | `gc.notify(message, {severity})` mit `permissions.notify` (max. 30/h) | wird erweitert, bleibt abwärtskompatibel |
| Android | Heartbeat alle 60 s nur bei aktivem Tunnel; einziger Vordergrunddienst ist RDP (`specialUse`) | Push ersetzt später das Polling |
| Windows | Tray-App läuft ab der Anmeldung; Kill-Switch erlaubt nur TCP 443 zum Endpunkt | Push nutzt genau diesen Weg |

Lücken, die das Projekt mit schließt:

* Android fragt `POST_NOTIFICATIONS` (Pflicht seit Android 13) nirgends ab.
* Android zeigt keine eigene VPN-Benachrichtigung.
* Android hat keine Behandlung der Akkuoptimierung.

## Architektur

```
Ereignis (activity.log / gc.notify / Admin)
   └─► notify.hub.emit()
         ├─ Regel nachschlagen (Priorität, Empfänger, Kanäle, Verzögerung, Bündeln)
         ├─ Empfänger auflösen → Personen → Geräte (api_tokens mit App)
         ├─ filtern: Abos, Geräte-Einstellungen, Ruhezeiten (Kritisch geht durch)
         ├─ speichern: notifications + notification_deliveries (Warteschlange)
         └─ zustellen:
              ├─ verbundene Geräte sofort über SSE  (GET /api/v1/client/push)
              ├─ getrennte Geräte beim nächsten Verbinden (Last-Event-ID)
              ├─ E-Mail sofort oder als Rückfall, wenn nach N Minuten kein Gerät bestätigt hat
              └─ Webhooks wie bisher
Gerät ──► POST /api/v1/client/push/ack  (zugestellt / gelesen / Aktion)
       ◄── Gelesen-Abgleich an die anderen Geräte derselben Person
```

**Warum SSE und nicht WebSocket:**

* SSE läuft schon heute durch Caddy (h1/h2). Die Vorlage `events.js` existiert.
* Es braucht keine neue Abhängigkeit (`ws` ist nur transitiv über guacamole-lite vorhanden).
* Die Richtung Server → Gerät reicht. Bestätigungen gehen per REST zurück.
* Wiederaufnahme ist mit `Last-Event-ID` eingebaut. Das ist wichtig, weil ein
  Caddy-Reload lange Verbindungen nach `stream_close_delay` (1 h) beendet.

**Zuverlässigkeit:** Jede Nachricht liegt pro Gerät in der Datenbank, bis das
Gerät sie bestätigt oder sie abläuft.

* Verbindungsabbrüche verlieren nichts.
* Pro Gerät gibt es höchstens eine Verbindung; eine neue ersetzt die alte.

## Datenmodell (Migration v93 `notification_center`)

```sql
-- Regel pro Ereignistyp (Startwerte aus CATALOGUE und alerts.email_events)
CREATE TABLE IF NOT EXISTS notify_rules (
  event_id        TEXT PRIMARY KEY,          -- CATALOGUE-Zeile, z. B. 'gateway_state', oder 'plugin:<id>:<topic>'
  priority        TEXT NOT NULL DEFAULT 'normal',  -- info|normal|high|critical
  recipients      TEXT NOT NULL DEFAULT '{"admins":true}', -- JSON: admins, owner, subscribers, users[], groups[]
  ch_app          INTEGER NOT NULL DEFAULT 1,
  ch_email        INTEGER NOT NULL DEFAULT 0,
  ch_webhook      INTEGER NOT NULL DEFAULT 1,
  email_fallback_s INTEGER,                  -- NULL = E-Mail sofort (wenn ch_email), sonst nur ohne Bestätigung
  delay_s         INTEGER NOT NULL DEFAULT 0, -- erst melden, wenn Zustand so lange anhält
  bundle_s        INTEGER NOT NULL DEFAULT 0, -- gleiche Meldung zusammenfassen
  recovery        TEXT NOT NULL DEFAULT 'silent', -- off|silent|normal (Entwarnung)
  enabled         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL,
  event_type   TEXT,                          -- Rohtyp aus activity.log
  source       TEXT NOT NULL,                 -- system | plugin:<id> | manual:<userId>
  priority     TEXT NOT NULL,
  title        TEXT NOT NULL,                 -- ≤ 120 Zeichen
  body         TEXT,                          -- ≤ 1000 Zeichen
  data         TEXT,                          -- JSON ≤ 4 KB: Deep-Link, Aktionen, Kontext
  collapse_key TEXT,                          -- Bündeln/Entwarnung (z. B. gateway:<id>)
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- = SSE id, monoton pro Server
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  token_id        INTEGER NOT NULL,           -- Gerät (api_tokens.id)
  user_id         INTEGER,
  state           TEXT NOT NULL DEFAULT 'queued', -- queued|sent|delivered|read|dismissed|expired|suppressed
  via             TEXT,                       -- direct|tunnel
  action          TEXT,
  queued_at TEXT, sent_at TEXT, delivered_at TEXT, read_at TEXT,
  UNIQUE (notification_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_nd_token_state ON notification_deliveries(token_id, state);

CREATE TABLE IF NOT EXISTS notify_subscriptions (  -- Abos pro Person (Portal)
  user_id INTEGER NOT NULL, topic TEXT NOT NULL, enabled INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic)
);

CREATE TABLE IF NOT EXISTS notify_user_prefs (
  user_id INTEGER PRIMARY KEY, quiet_from TEXT, quiet_to TEXT, tz TEXT,
  critical_bypass INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notify_device_prefs (   -- vom Gerät gemeldet
  token_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT,                 -- always|vpn_only
  topics TEXT,               -- JSON, abgewählte Themen auf diesem Gerät
  platform TEXT, app_version TEXT,
  restricted INTEGER NOT NULL DEFAULT 0,  -- Akkuoptimierung aktiv (Android)
  updated_at TEXT
);
```

**Themen (Topics)** sind die Brücke zwischen Ereignissen und Abos:

* System-Themen: `security`, `devices`, `services`, `system`, `admin_notice`.
  `security` und `system` (Neustart, Backups, Updates, Ressourcen) sind nur für
  Admins; `admin_notice` (manuelle Nachrichten, Tests) ist immer an.
  Zuordnung der `CATALOGUE`-Gruppen: security → `security`, peers → `devices`,
  routes → `services`, system → `system`.
* Plugin-Themen: `plugin:<id>:<topic>`, deklariert in der `plugin.json` des
  Plugins (siehe unten).

**Umgesetzt (Phase 1a), Ergänzungen zum Entwurf oben:**

* `notifications` hat zusätzlich `topic`, `count` (Bündeln), `silent`
  (stille Entwarnung), `target` (JSON der Empfänger, für die Anzeige),
  `release_at` (zurückgehalten durch `delay_s`), `revoked_at`,
  `email_state`/`email_due_at`/`email_sent_at` (E-Mail-Rückfall), `meta`
  (nur Server: die zurückgehaltene E-Mail) und `updated_at`.
* `notification_deliveries.silent`: in der Ruhezeit zugestellt.
* `notify_device_prefs` zusätzlich `client_type`, `via`, `last_seen_at`. Eine
  Zeile heißt: Auf diesem Token läuft eine App mit Push (Stream einmal
  geöffnet oder `prefs`/`test` gerufen). Nur solche Geräte bekommen eine
  Warteschlange. Ohne Zeile: „push_off“, wenn der Peer eine GateControl-App
  meldet (`peers.client_version`, Push in der App nie eingeschaltet), sonst
  „unsupported“ (reine WireGuard-Peers).
* Zeitstempel sind ISO-8601 UTC mit Millisekunden; an die Geräte gehen
  `created_at`/`expires_at` ohne Millisekunden.

**Aufräumen:** Ein Job läuft stündlich.

* Nicht zugestellte Nachrichten verfallen nach 72 h (Standard; je Priorität einstellbar).
* Der Verlauf wird nach 30 Tagen gelöscht.
* Pro Gerät bleiben höchstens 200 Nachrichten in der Warteschlange; die ältesten Info-Meldungen fallen zuerst.
* Abgelaufene Bilder von Plugin-Pushes (`notify_media`, siehe unten) werden gelöscht.

**Bilder (Migration v102 `notify_media`, 1.169.0):** Ein Plugin kann einem
Push ein Bild mitgeben (`gc.notify({ …, image })`, docs/plugins.md
„Pictures“). Es liegt in `notify_media` (`id` zufällig, 24 URL-sichere
Zeichen, `mime`, `data`, `created_at`, `expires_at`) und lebt so lange wie
die `ttl` des Pushs, ohne `ttl` 24 h, höchstens 7 Tage. `notifications`
bekommt `image_url` (relativer Pfad `/notify-media/<id>.<ext>`) und
`image_expires_at`; die Apps sehen den Pfad als `imageUrl`, solange das Bild
lebt.

## Server: Schnittstellen

**Gerät** (Token-Auth, Scope `client`, Maschinenbindung wie bei den anderen `/client`-Routen):

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/v1/client/push` | SSE-Stream. Ereignisse `hello` (Server-Zeit, Keepalive, Themenliste), `notification`, `read` (Gelesen-Abgleich), `revoke` (zurückgezogen), `control` (Steuerereignisse ohne `id`: Richtlinie, Support-Bundle, Peer an/aus, WireGuard-Konfiguration; Phase 5). Wiederaufnahme über `Last-Event-ID`. |
| POST | `/api/v1/client/push/ack` | `{seqs:[…], state:'delivered'│'read'│'dismissed', action?}` |
| GET | `/api/v1/client/push/inbox` | Posteingang (letzte 100), für den App-Bildschirm „Mitteilungen“ |
| GET | `/api/v1/client/push/prefs` | gespeicherte Geräte-Einstellungen plus Ruhezeiten der Person |
| PUT | `/api/v1/client/push/prefs` | Geräte-Einstellungen: an/aus, Modus, abgewählte Themen, Akku-Status |
| POST | `/api/v1/client/push/test` | Testnachricht an dieses Gerät |

Für den Stream gelten diese Regeln:

* Er wird wie `/api/v1/events` **vor** dem `apiLimiter` eingehängt, mit einem eigenen Limiter pro Token (Verbindungsaufbau).
* Es gibt eine globale Obergrenze offener Streams (Standard 500).
* Antwort-Header wie in `events.js` (`X-Accel-Buffering: no`, `flushHeaders`).
* Gerät und Person werden geprüft, wie bei `requirePeerOwnership`/`verifyMachineBinding`.

**Admin** (Session, Rolle admin):

* `GET/PUT /api/v1/notify/rules`
* `GET /api/v1/notify/devices`: Live-Präsenz, Warteschlange, letzte Bestätigung
* `GET /api/v1/notify/history` und `/history/:id`: Zustellprotokoll
* `POST /api/v1/notify/send` (manuell) und `POST /api/v1/notify/test`
* `GET/PUT /api/v1/notify/settings`: an/aus, Aufbewahrung, Obergrenzen, Zustellung ohne VPN erlauben, Standard für den E-Mail-Rückfall

Die Präsenz kommt zusätzlich als Ereignis `push_presence` über den
vorhandenen Bus in die Admin-Oberfläche.

**Portal** (Benutzer):

* `GET/PUT /api/v1/me/notify/prefs`: Abos, Ruhezeiten, Zeitzone
* `GET /api/v1/me/notify/inbox`, `POST /api/v1/me/notify/read`
* `POST /api/v1/me/notify/test`
* Umsetzung: Die Routen hängen im „me“-Router, also auch unter
  `/api/v1/portal/me/notify/*` (Portal-Sitzung). Formen:
  `GET/PUT prefs` → `{topics:[{id,label,enabled,locked}], quiet_from, quiet_to,
  tz, critical_bypass, devices:[{token_id,name,state,queued}]}` (PUT
  `{topics:[{id,enabled}], quiet_from:"HH:MM"|null, quiet_to, tz, critical_bypass}`),
  `GET inbox?limit&before=<id>` → `{items, unread}`, `POST read`
  `{ids:[…]}`|`{all:true}` → `{ok, updated}`, `POST test` `{token_id?}` →
  `{ok, devices}` (`token_id`: nur eines der eigenen App-Geräte, sonst 404;
  ohne: alle eigenen Geräte).

**Admin-API, Antwortformen (Phase 1a, für die Admin-Seite verbindlich).**
Alle Antworten tragen zusätzlich `"ok": true`.

* `GET /api/v1/notify/overview` → `{kpis:{devices_connected, devices_total,
  direct, tunnel, delivered_24h, read_24h, queued, queued_devices, failed_7d,
  median_latency_ms}, recent:[{id, title, event_id, topic, priority, source,
  created_at, recipients_label, delivered, total, read, silent}] (8),
  hub:{enabled, endpoint, keepalive_s, retention_h, max_queue, allow_direct},
  sources:[{id: security|devices|services|system|plugins, count}] (7 Tage)}`
* `GET /api/v1/notify/rules` → `{rules:[{event_id, group, label, priority,
  recipients:{admins, owner, subscribers, users[], groups[]}, ch_app, ch_email,
  ch_webhook, email_fallback_s, delay_s, bundle_s, recovery, enabled,
  plugin_id}], users:[{id,name}], groups:[{id,name}], webhooks_count, pro}`;
  `PUT /api/v1/notify/rules/:eventId` (teilweise) → `{ok, rule}`, Fehler 400
  `{fields:{feld: code}}`.
* `GET /api/v1/notify/devices` → `{devices:[{token_id, name, user:{id,name,role},
  platform, client_type, app_version, state: connected|restricted|offline|push_off|unsupported,
  via, connected_since, last_seen, queued, last_ack_at, buffer_until}]}`.
  `restricted` = verbunden, aber Akkuoptimierung aktiv; `push_off` = App
  vorhanden (`peers.client_version`), Push in der App aus; `buffer_until` = wann
  die älteste wartende Nachricht verfällt.
* `POST /api/v1/notify/send` `{target:{type: all|users|groups|devices, ids},
  title, body, priority, ttl_s}` → `{ok, notification_id, devices_now, devices_later}`
* `POST /api/v1/notify/test` `{token_id?}` → `{ok, devices}`. Ohne
  `token_id` an die eigenen Geräte des Admins, mit `token_id` an genau dieses
  App-Gerät (beliebige Person; kein App-Gerät → 404, ungültig → 400). Frei,
  ohne Lizenz; Limit wie bisher (10 je Minute und Konto).
* `GET /api/v1/notify/history?filter=all|important|undelivered|plugins|manual&days=7&before=<id>&limit=50`
  → `{items:[{id, title, body, event_id, source, priority, created_at,
  delivered, total, read, recipients_label, silent, status: ok|partial|waiting}], next_before}`
* `GET /api/v1/notify/history/:id` → `{notification, timeline:[{at, kind, text}],
  deliveries:[{token_id, device_name, user_name, state, via, queued_at, sent_at,
  delivered_at, read_at, latency_ms, action}], email:{sent, at}}`;
  `POST …/history/:id/resend` → `{ok}`
* `GET/PUT /api/v1/notify/settings` → `{enabled, retention_h, history_days,
  max_queue, keepalive_s, allow_direct, email_fallback_s, max_streams}`
  (Schlüssel `notify.*` in der Settings-Tabelle).
* Ereignisbus (`/api/v1/events`): `push_presence` `{token_id, state, via}` und
  `notify` `{id}`.

**Gruppen als Empfänger** sind die vorhandenen Peer-Gruppen (`peer_groups`).
Gemeint sind die **Geräte in der Gruppe** (Tokens, deren Peer in der Gruppe
ist), nicht alle Geräte der Personen, denen dort ein Gerät gehört.

## Server: Regeln, Ruhezeiten, Bündeln

* **Startwerte:** Alle Zeilen aus `CATALOGUE`, Empfänger „Alle Admins“, App an.
  * Zeilen (`CATALOGUE` in `src/services/notifications.js`): Sicherheit
    (`login_failed`, `account_locked`, `password_changed`, `waf_ip_banned`),
    Geräte & Gateways (`peer_connection` — App aus, `peer_lifecycle`,
    `peer_expired`, `gateway_state`), Routen (`route_state`,
    `route_lifecycle`), System (`system_restart`, `backup_restored`,
    `backup_problem`, `update`, `resources`, `support_bundle`).
  * `support_bundle` („Support-Paket empfangen“, `support_bundle_uploaded`):
    Titel „Support-Paket von <Gerät>“, Fakten Client, Anlass, Größe; Thema
    `system` (nur Admins). Details: `docs/feature-support-bundle.md`.
  * E-Mail an genau dort, wo `alerts.email_events` es heute vorsieht. Das
    bisherige Verhalten bleibt also gleich.
  * Die Einstellungsseite „Benachrichtigungen“ (Matrix E-Mail/Webhooks) wird
    durch einen Verweis auf die neue Seite ersetzt.
  * `notifications.email` (Empfänger) bleibt der E-Mail-Empfänger.
* **Empfänger:**
  * `admins`: alle Benutzer mit Rolle admin.
  * `owner`: Eigentümer des betroffenen Geräts, aufgelöst über `peers.user_id` bzw. `portalDevices.usageForPeer`.
  * `subscribers`: wer das Thema abonniert hat.
  * Dazu einzelne Personen und Gruppen.
  * Sicherheits-Themen sind nur für Admins abonnierbar.
* **Ruhezeiten:** pro Person, gelten für alle ihre Geräte.
  * In der Ruhezeit wird still zugestellt: kein Ton, die Nachricht steht im Posteingang.
  * `critical` geht immer durch, außer die Person schaltet das ab.
* **Verzögerung:** `delay_s` hält die Meldung zurück. Kommt in der Zeit die
  Entwarnung mit demselben `collapse_key`, entfällt beides.
* **Bündeln:** Innerhalb von `bundle_s` werden gleiche Ereignisse zu einer
  Nachricht zusammengefasst („4 IPs durch WAF gesperrt“). Die Geräte bekommen
  die vorhandene Benachrichtigung aktualisiert statt einer neuen.
* **Prioritäten für Plugins:** höchstens `high`. `critical` bleibt dem System
  vorbehalten — außer bei einem Thema, das in `notifyTopics[]` mit
  `"allowCritical": true` erklärt ist (z. B. SOS eines Familien-Plugins): dort
  bleibt `critical` erhalten und überspringt die Ruhezeit wie die kritischen
  Kernereignisse. Der Installationsdialog nennt das. Budget pro Plugin:
  `permissions.notify: true` = 30 pro Stunde, `{ "perHour": n }` = n (1–120);
  siehe docs/plugins.md „Notifications“.
* **Umsetzung (Phase 1a):**
  * Abos: ein Schalter pro Person und Thema. Ohne Eintrag gilt der Standard
    (System-Themen an, Plugin-Themen laut `notifyTopics[].default`). „Aus“
    nimmt die Person aus jedem Empfängerweg dieses Themas, außer bei
    `critical` und bei `admin_notice`.
  * E-Mail: `alerts.email_events` bleibt die Quelle für `ch_email` der
    Kernzeilen; eine Regeländerung schreibt dorthin zurück.
    `email_fallback_s` NULL: E-Mail sofort wie bisher. Gesetzt (Standard 600 s
    für `critical`/`high`): Die Mail wartet, bis kein Gerät `delivered`
    bestätigt hat; gibt es kein App-Gerät, geht sie sofort. Das gilt auch für
    die eigenen Mails von `route_state` und `update`. Eine Entwarnungs-Mail
    folgt nur, wenn die Alarm-Mail tatsächlich verschickt wurde.
  * Entwarnung (`gateway_alive`/`gateway_recovered`, `route_up`,
    `resource_recovered`): Alle offenen Alarme desselben `collapse_key`
    werden zurückgezogen (`revoke`). Danach je nach `recovery`: `silent`
    (stille Meldung, Priorität info), `normal` oder `off`. Ohne offenen Alarm
    passiert nichts.
  * Bündeln aktualisiert die vorhandene Nachricht (Titel „3× …“) und stellt
    sie unter neuen `seq` erneut zu. Start: `login_failed` und
    `waf_ip_banned` mit 300 s.
  * `delay_s`: Die Nachricht liegt mit `release_at` ohne Zustellungen in der
    Datenbank (übersteht Neustarts); ein Ticker (15 s) gibt sie frei.

## Plugin-API (abwärtskompatibel)

```js
// alt, funktioniert weiter (wird zu priority 'info', Thema 'plugin:<id>:default')
gc.notify('Laden abgeschlossen', { severity: 'info' });

// neu
gc.notify({
  topic: 'charging',              // muss in plugin.json deklariert sein
  title: 'Laden abgeschlossen',
  body: 'Enyaq · 80 % · ca. 390 km',
  priority: 'normal',             // info|normal|high (critical nur mit allowCritical)
  users: [12],                    // optional: nur diese Personen (sonst Abonnenten)
  collapseKey: 'charge:VIN123',   // optional
  ttl: 6 * 3600,                  // optional, Sekunden
  data: { route: 'plg-skoda' },   // optional: Deep-Link in den Plugin-Tab
  image: { data: '<base64>', mime: 'image/jpeg' }  // optional (ab 1.169.0): Bild, siehe unten
});
```

Ab 1.169.0 (Einzelheiten in docs/plugins.md „Notifications“):

* **Bild** (`image`): PNG, JPEG oder WebP als Base64, höchstens 300 KB,
  jede Seite 32…2560 px, beliebiges Seitenverhältnis, keine Animation; der
  MIME-Typ muss zum Bild passen. Nur der Kopf wird geprüft (wie bei den
  Profilbildern). Die Apps bekommen `imageUrl` (relativer Pfad
  `/notify-media/<id>.<ext>`, ohne Anmeldung abrufbar wie `/avatars/`, auf
  jedem Host des Servers, mit Ratenbegrenzung; 404, sobald abgelaufen). Das
  Aktivitätsprotokoll enthält das Bild nie.
* **Schnellaktion als Knopf** (`data.actions[]` mit `type: 'quick_action'`):
  `{ type: 'quick_action', label (≤ 24), plugin, id, confirm?: boolean,
  auth?: 'device' }`. `plugin` muss die eigene Plugin-ID sein, sonst
  `ERR_INVALID`; `id` ist eine Schnellaktions-ID des Plugins (nur das Format
  wird geprüft). Die App führt sie über `POST /api/v1/client/actions/<plugin>/<id>`
  mit `{ "source": "notification" }` aus — der normale Weg mit allen
  Prüfungen; das Plugin bekommt `via: 'notification'`. `auth: 'device'` heißt:
  Die App verlangt vorher die Geräteentsperrung bzw. Biometrie.

In der `plugin.json` kommt ein neuer, optionaler Block hinzu:
`"notifyTopics": [{ "id": "charging", "label": { "de": "Laden abgeschlossen", "en": "Charging complete" }, "default": true }]`.

* Die Themen erscheinen im Portal und in den Apps als eigene Kanäle.
* Die Berechtigung `permissions.notify` bleibt nötig.
* Das Limit bleibt 30 pro Stunde und Plugin.
* Termine wie „Vorabend 18:00“ plant das Plugin selbst.

## Android-App

1. **Modul `core/notify`:**
   * SSE-Client auf OkHttp (`okhttp-sse` aus derselben OkHttp-Familie). Er
     nutzt einen eigenen Client per `newBuilder()` mit `readTimeout(0)` und
     dieselben Interceptoren (Token, Maschinenbindung).
   * Er übernimmt `vpnSafeDns`.
   * Wiederverbindung mit Backoff und Jitter.
   * `Last-Event-ID` liegt im DataStore.
   * `NetworkCallback` stößt eine Wiederverbindung an, wenn das VPN startet
     oder stoppt oder das Netz wechselt.
   * Bestätigungen gehen per Retrofit an den Server.
2. **`PushService`:**
   * Vordergrunddienst vom Typ `specialUse` mit Subtype-Property (wird von
     `ManifestSecurityTest` geprüft). Begründung: „dauerhafte Verbindung zum
     eigenen GateControl-Server für Benachrichtigungen ohne Google-Dienste“.
   * **Eine** dauerhafte, stille Benachrichtigung im Kanal „Verbindung“
     (Wichtigkeit MIN) zeigt VPN- und Push-Status zusammen.
   * Start durch App-Start, `BootReceiver` und Einstellungswechsel.
   * Modus „Nur bei aktivem VPN“: kein eigener Dienst. Der Client läuft im
     Scope des `TunnelSupervisor`, solange der Tunnel steht.
3. **Berechtigungen:**
   * `POST_NOTIFICATIONS`: Abfrage beim Einschalten und in den Einstellungen.
   * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: Hinweiskarte mit „GateControl
     ausnehmen“. Der Status wird an den Server gemeldet (Admin sieht
     „Eingeschränkt“).
4. **Kanäle:**
   * Kritisch (hoch, Ton), Sicherheit, Geräte, Dienste, Hinweise vom Admin.
   * Plugin-Themen werden dynamisch aus `hello` angelegt.
   * Ton und Vibration verwaltet Android pro Kanal.
5. **Oberfläche:**
   * Glocke mit Zähler auf „Start“.
   * Bildschirm „Mitteilungen“ (Filter, ungelesen) und Detailansicht mit Aktionen.
   * Neue Einstellungsgruppe „Benachrichtigungen“ nach „Sicherheit“.
   * Aktionen in der Benachrichtigung („Details“, „Gesehen“, „1 h stumm“,
     „Erledigt“) laufen über einen `BroadcastReceiver` mit Bestätigung an
     den Server.
   * „Im Portal öffnen“ nutzt den vorhandenen Portal-Link mit Auto-Login.
6. **Speicher:**
   * Keine neue Datenbank. Der Server ist die Quelle der Wahrheit.
   * Die App hält einen kleinen JSON-Cache der letzten 100 Nachrichten für die Offline-Anzeige.
7. **Tests:**
   * SSE-Parsing und Wiederaufnahme mit MockWebServer.
   * Backoff, Kanalzuordnung.
   * `ManifestSecurityTest`.
   * ViewModel-Tests für Einstellungen und Posteingang.

## Windows-Apps (client-core, Pro, Community)

1. **client-core:**
   * `src/services/push-client.js`: SSE über Node-`https`, ohne neue Abhängigkeit.
     * Gleiche Header wie `api-client.js`.
     * Wiederaufnahme mit `Last-Event-ID`, Backoff.
     * Muster wie `client-policy.js`: `{apiClient, store, log}` und `start()`/`stop()`.
   * `src/services/notification-center.js`: gemeinsamer Wrapper um Electron
     `Notification`. Unter Windows kommen Aktionsknöpfe per `toastXml`.
   * Lokaler Posteingang-Cache.
   * IPC-Kanäle `notify:list`, `notify:read`, `notify:prefs`, `notify:test`
     und das Ereignis `notify:new` an den Renderer.
2. **Kill-Switch:** Der Push-Kanal nutzt dieselbe Ausnahme (TCP 443 zur
   Endpunkt-IP).
   * Zeigt die Server-URL auf einen anderen Host als den WireGuard-Endpunkt,
     warnt die Einstellungsseite.
   * Bei aktivem Kill-Switch läuft Push in diesem Fall nur durch den Tunnel.
3. **Pro und Community:**
   * Den Dienst neben `ClientPolicyService` starten, bei `server:setup` neu
     anlegen und in `performCleanShutdown` stoppen.
   * Neuer Navigationspunkt „Mitteilungen“ und Einstellungsreiter
     „Benachrichtigungen“.
   * Tray-Symbol mit Punkt, Tray-Menü mit „Mitteilungen“ und „Nicht stören 1 h“.
   * Store-Schema `notifications{…}` in **beiden** Schemas (Pro hat ein eigenes).
     Die Schlüssel kommen in `CONFIG_WRITABLE_KEYS`.
   * Pro: die verstreuten `new Notification(...)` auf den Wrapper umstellen.
4. **Tests:** SSE-Parser, Backoff und Wiederaufnahme, IPC-Handler, Store-Schema.

## Portal und Admin-Oberfläche

* **Admin:** neue Seite unter System › „Benachrichtigungen“ mit fünf Reitern,
  so wie in den Mockups.
  * Übersicht (Kennzahlen, Letzte, Push-Dienst, Quellen)
  * Regeln (Tabelle und Editor)
  * Geräte (Präsenz und „Nachricht senden“ mit Vorschau)
  * Verlauf (Filter und Zustellprotokoll)
  * Einstellungen
  * Umsetzung: `el()`, kein innerHTML; i18n DE/EN.
  * Der Zähler „Benachrichtigungen“ in der Seitenleiste (wartende
    Nachrichten) kommt mit jeder Admin-Seite (gezählt beim Seitenaufbau,
    15 s zwischengespeichert).
* **Portal:**
  * Glocke mit Zähler im Kopf.
  * Seite „Meine Benachrichtigungen“: Themen, „Empfangen auf“, Ruhezeiten, Zuletzt.
  * Umsetzung (Phase 4a): nur für eine angemeldete Person (Portal- oder
    Web-Sitzung) und nur, solange Push am Server an ist. Zwei Seiten ohne
    eigenen Reiter, per URL erreichbar wie die Reiter:
    * `#mitteilungen` (Glocke): Posteingang, neueste zuerst, Punkt für
      ungelesen, „Gelesen“ je Eintrag und „Alle als gelesen“, Fakten
      (`data.facts`), „Ältere laden“ (`before`), Leerzustand.
    * `#benachrichtigungen` (Verweis in „Meine Geräte“ und im Posteingang):
      Themen als Schalter (gesperrte grau mit Grund, Plugin-Themen mit ihrem
      Label), „Empfangen auf“ mit Zustand, wartenden Nachrichten und „Test“
      je Gerät (`token_id`), Ruhezeiten (an/aus, von/bis, Zeitzone aus dem
      Browser, „Kritisches trotzdem melden“), „Zuletzt“ (5 Einträge).
    * Jede Änderung speichert sofort (`PUT prefs` mit nur dem geänderten Feld).
    * Live: Die Glocke fragt `GET inbox` alle 60 s ab, solange die Seite
      sichtbar ist, und sofort beim Zurückkehren; kein Stream aus dem Portal.
    * Die Apps springen mit dem Portal-Link (`next`, siehe Vertrag) direkt
      auf `#mitteilungen` oder `#benachrichtigungen`.
* **Dokumentation:**
  * `docs/plugins.md` (neue `gc.notify`-Form, `notifyTopics`).
  * Dieses Dokument wird zur Feature-Doku.

## Sicherheit und Datenschutz

* Inhalte bleiben auf dem eigenen Server. Es gibt keinen Fremddienst und kein Tracking.
* Jedes Gerät sieht nur seine eigenen Zustellungen. Der Token-Scope `client`
  und die Maschinenbindung gelten wie bei allen Geräte-Routen.
* Ein gesperrtes oder gelöschtes Gerät (Token widerrufen) verliert den Stream sofort.
* Begrenzung: Titel 120, Text 1000 Zeichen, `data` höchstens 4 KB.
  Steuerzeichen werden entfernt. Die Apps zeigen nur Text an, kein HTML.
* `data.facts` (optional): höchstens 6 Paare `{label, value}`, je eine
  Zeile, `label` ≤ 60, `value` ≤ 120 Zeichen; Zahlen werden zu Text, leere
  oder falsch geformte Einträge fallen weg.
* Aktionen nur aus einer festen Liste:
  * `open_app_route`
  * `open_portal` (eigene Domain)
  * `mute_1h`, `ack`, `done`
  * `quick_action` (ab 1.169.0): nur in Pushes eines Plugins und nur für
    dessen eigene Schnellaktionen; ausgeführt über den normalen
    Schnellaktions-Weg des Servers (Rechte prüft das Plugin bei jedem Lauf).
  * Freie URLs nur auf die eigene Server-Domain.
* Bilder von Plugin-Pushes: höchstens 300 KB, nur PNG/JPEG/WebP (Kopf
  geprüft), zufällige Capability-URL, verfallen mit der `ttl` (höchstens
  7 Tage), nie im Aktivitätsprotokoll.
* Manuelle Nachrichten und Regeländerungen landen im Aktivitätsprotokoll.

## Phasen, Releases und Umfang

| Phase | Inhalt | Repos | Umfang | Release |
|---|---|---|---|---|
| 1 | Datenmodell (v93), Hub und Regeln, SSE-Stream, ACK, Warteschlange und Aufräumen, Admin-API und Admin-Seite, Übernahme der E-Mail-Einstellungen, Test senden | gatecontrol | **groß**, 3 PRs (Kern, Admin-Seite, Übernahme und Doku) | GC-Minor |
| 2 | Push-Client, `PushService`, Kanäle, Berechtigungen, Akkuoptimierung, Posteingang, Einstellungen | Android | **mittel bis groß**, 2 PRs (Kern und Dienst, Oberfläche) | Android-Minor |
| 3 | `push-client` und `notification-center` im Core; Oberfläche und Tray in Pro und Community | client-core, Pro, Community | **mittel**, 3 PRs (Core, Pro, Community) | Core, dann Pro und Community |
| 4 | Portal (Abos, Ruhezeiten, Posteingang); Plugin-API v2 mit `notifyTopics`; Fahrzeuge-, Smart-Home- und Klima-Plugin melden passende Ereignisse | gatecontrol, gatecontrol-plugins | **mittel**, 2 bis 3 PRs | GC-Minor, Plugin-Patches |
| 5 | Polling ersetzen: Richtlinie geändert, Support-Bundle angefordert, Gerät gesperrt kommen per Push (Heartbeat bleibt als Rückfall); Gelesen-Abgleich und Bündeln verfeinern | alle | **klein bis mittel** | Patches |

**Stand Phase 5:** Server umgesetzt: `event: control` (`policy_changed`,
`support_bundle_requested`, `peer_state`, `config_changed`) und
`hello.state`, siehe Vertrag. Offen: Android und Windows werten die
Ereignisse aus und senken ihr Polling (Heartbeat, `config/check`) auf einen
langsamen Rückfall.

**Reihenfolge:** Phase 1 muss zuerst live sein. Danach können 2 und 3
parallel laufen. Phase 4 setzt Phase 1 voraus. Das Müllabfuhr-Plugin
(eigene Aufgabe) baut auf Phase 4 auf.

Jede Phase wird erst gemergt, wenn:

* die CI grün ist,
* es Tests für neue Logik gibt,
* bei Android und Windows ein Gerätetest durch den Maintainer stattgefunden hat
  (Push ohne VPN, mit VPN, nach Neustart, im Ruhezustand über Nacht).

## Risiken

* **Android-Hersteller mit aggressivem Energiesparen** (Xiaomi, Huawei, teils
  Samsung) können den Dienst trotzdem beenden.
  * Gegenmaßnahmen: Hinweis in der App mit Anleitung, Anzeige „Eingeschränkt“
    beim Admin, E-Mail-Rückfall für wichtige Meldungen.
* **Google-Play-Richtlinien** für `specialUse` und Akku-Ausnahme: Für die
  Verteilung über GitHub sind sie unkritisch. Bei einer späteren
  Play-Veröffentlichung muss die Begründung eingereicht werden.
* **Caddy-Reload** beendet Streams nach höchstens 1 h. Das ist durch
  Wiederaufnahme und Warteschlange abgedeckt.
* **Serverlast:** eine offene Verbindung pro Gerät, für Node und SQLite unkritisch.
  Die Obergrenze ist einstellbar.
* **Zeitzonen der Ruhezeiten:** werden pro Person gespeichert (vom Portal
  übernommen), Standard ist die Server-Zeitzone.

## Offene Entscheidungen (Maintainer)

1. **Lizenz:** Empfehlung:
   * frei: Push für System- und Geräteereignisse plus Testnachricht;
   * ab Pro: eigene Regeln, Gruppen, „Nachricht senden“, Plugin-Themen;
   * Lifetime: alles.
2. **Android-Standardmodus:** Empfehlung: Beim ersten Einschalten wird „Immer,
   auch ohne VPN“ vorgeschlagen, inklusive Akku-Ausnahme; „Nur bei VPN“ bleibt wählbar.
3. **E-Mail-Rückfall:** Empfehlung: Für Kritisch und Hoch ist er standardmäßig
   an, nach 10 Minuten ohne Bestätigung.
4. **Aufbewahrung:** Empfehlung: 72 h Warteschlange, 30 Tage Verlauf.
5. **Alte Einstellungsseite:** Empfehlung: Die Matrix wird durch einen Verweis
   auf die neue Seite ersetzt; die Werte werden übernommen.

## Entscheidungen (Maintainer, 2026-10-10)

Freigegeben: Phase 1, danach direkt Phase 2 und 3; mergen, sobald die CI grün ist.
Die fünf offenen Punkte gelten wie empfohlen:

1. **Lizenz:** Push für System- und Geräteereignisse, Posteingang, Abos und
   Testnachricht ist frei. Eigene Empfänger in Regeln (Personen, Gruppen),
   „Nachricht senden“ und Plugin-Themen hängen am vorhandenen Lizenz-Feature
   `email_alerts` („Benachrichtigungen Pro“). Es gibt keine neuen Lizenzschlüssel.
2. **Android:** Beim Einschalten wird „Immer, auch ohne VPN“ vorgeschlagen.
3. **E-Mail-Rückfall:** Für `critical` und `high` ist er an, nach 600 s ohne Bestätigung.
4. **Aufbewahrung:** 72 h Warteschlange, 30 Tage Verlauf.
5. **Alte Matrix:** Sie wird durch einen Verweis ersetzt, die Werte werden übernommen.

## Vertrag Gerät ↔ Server (verbindlich für Server, Android und Windows)

Alle Geräte-Routen verwenden Token-Auth wie die übrigen `/api/v1/client/*`:

* Header `X-API-Token`, `X-Client-Version`, `X-Client-Platform` (`android` | `windows`),
  bei Windows `X-Client-Type` (`pro` | `community`).
* `X-Machine-Fingerprint`, wenn das Token gebunden ist.
* Scope `client`.

### `GET /api/v1/client/push`: SSE-Stream

* Anfrage: optional Header `Last-Event-ID: <seq>` oder `?since=<seq>`.
  Ohne beides werden alle Nachrichten im Zustand `queued` und `sent` geliefert.
* Antwort `200 text/event-stream`, Header wie in `events.js`.
* Fehlerantworten:
  * `404`: Server zu alt. Der Client probiert es stündlich wieder.
  * `503 {"error":"push_disabled"}`: Push ist am Server aus. Der Client probiert es stündlich wieder.
  * `503 {"error":"too_many_streams"}`: globale Obergrenze erreicht. Neuer Versuch mit Backoff.
  * `403 {"error":"direct_not_allowed"}`: Der Admin erlaubt Push nur bei
    aktivem VPN. Neuer Versuch, sobald das VPN steht (bzw. stündlich).
    Zugelassen ist ein Stream aus dem WireGuard-Netz oder (Split-Tunnel, die
    Server-Adresse läuft nicht durch den Tunnel) von der öffentlichen Adresse,
    von der der Peer des Tokens gerade mit frischem Handshake verbunden ist.
    `hello.via` bleibt dann `direct`. Geht dieser Peer offline oder wird er
    deaktiviert, beendet der Server den Stream; der nächste Aufbau bekommt
    wieder `403`.
  * `429 {"error":"rate_limited"}`: zu viele Verbindungsaufbauten (120 je 15 min und Token; der Limiter läuft nach der Token-Prüfung).
  * `401`/`403`: wie bei den anderen Client-Routen behandeln (`token_required`,
    `scope_required`, Maschinenbindung).
* Alle JSON-Antworten der REST-Routen tragen zusätzlich `"ok": true|false`.
* `hello.topics` enthält für Admins zusätzlich `system`; Plugin-Themen nur mit
  der Lizenz `email_alerts`.
* `hello.quiet`: die Ruhezeiten der Person, wie bei
  `GET /api/v1/client/push/prefs`, oder `null`. Zusätzliches Feld; ältere
  Clients ignorieren es.
* Pro Token gibt es genau einen Stream; ein neuer beendet den alten.
* `hello.state` (Phase 5): der Stand, den das Gerät sonst per Polling holt,
  damit es nach einem Neuaufbau nachholt, was es offline verpasst hat (siehe
  „Steuerereignisse“). Zusätzliches Feld; ältere Clients ignorieren es.

Ereignisse:

```
event: hello
data: {"server_time":"2026-10-10T21:42:03.120Z","keepalive_s":25,"retention_h":72,
       "via":"direct","unread":3,
       "state":{"policy_version":"3f9a0c1d22b4e7a8","peer_enabled":true,
                "support_bundle_requested":false,"support_bundle_requested_at":null,
                "config_hash":"9c1e…(sha256, hex)"},
       "quiet":{"from":"22:00","to":"07:00","tz":"Europe/Berlin","critical_bypass":true},
       "topics":[{"id":"security","label":"Sicherheit"},{"id":"devices","label":"Geräte & Gateways"},
                 {"id":"services","label":"Dienste"},{"id":"admin_notice","label":"Hinweise vom Admin"},
                 {"id":"plugin:skoda:charging","label":"Fahrzeug · Laden abgeschlossen"}]}

id: 123
event: notification
data: {"seq":123,"id":45,"event_id":"gateway_state","topic":"devices","priority":"critical",
       "title":"Gateway „Zuhause“ ist offline","body":"Seit 2 Minuten kein Lebenszeichen …",
       "created_at":"2026-10-10T21:42:03Z","expires_at":"2026-10-13T21:42:03Z",
       "collapse_key":"gateway:3","silent":false,"imageUrl":null,
       "data":{"route":"gateways","actions":[{"id":"details","label":"Details","type":"open_app_route","target":"gateways"},
                                             {"id":"mute_1h","label":"1 h stumm","type":"mute_1h"}],
               "facts":[{"label":"Zuletzt gesehen","value":"10.10.26, 21:40"},{"label":"Betroffene Routen","value":"3"}]}}

event: read
data: {"ids":[45]}            # auf einem anderen Gerät derselben Person gelesen → hier ausblenden

event: revoke
data: {"ids":[45]}            # zurückgezogen (z. B. Entwarnung ersetzt Meldung) → ausblenden

event: control                # Steuerereignis, ohne id (siehe unten)
data: {"type":"policy_changed","policy_version":"3f9a0c1d22b4e7a8"}

: ping                        # alle keepalive_s Sekunden
```

Dazu gelten diese Regeln:

* `seq` ist pro Server streng monoton und dient als SSE-`id`.
* Der Client speichert das zuletzt verarbeitete `seq` und bestätigt jede
  Nachricht mit `delivered`.
* `silent:true` bedeutet: in den Posteingang, aber ohne Ton und ohne Banner
  (Ruhezeit oder Entwarnung).
* Gleicher `collapse_key` heißt: Die vorhandene Benachrichtigung wird
  ersetzt bzw. aktualisiert.
* `priority`: `info` | `normal` | `high` | `critical`.
* `imageUrl` (ab 1.169.0): relativer Pfad `/notify-media/<id>.<ext>` eines
  Bildes zur Nachricht (nur Plugin-Pushes) oder `null`. Die App lädt es vom
  eigenen Server (ohne Token; die URL ist das Geheimnis) und zeigt es groß
  an. Nach Ablauf (`ttl`, höchstens 7 Tage) antwortet der Server 404 und
  liefert `imageUrl: null`. Windows-Apps dürfen es ignorieren.
* `data.facts` (optional): `[{label, value}]`, höchstens 6, Text in der
  Server-Sprache. Die Apps zeigen sie als Liste unter dem Text. Der Server
  füllt sie für Kernereignisse, wenn er Kontext hat:

  | Ereignis | Fakten |
  |---|---|
  | `gateway_down`, `gateway_offline` | Zuletzt gesehen, Betroffene Routen (Anzahl) |
  | `waf_ip_banned` | IP-Adresse, Treffer, Route (Host), Port (Layer 4), Sperrdauer |
  | `route_down` | Domain, Antwortzeit |
  | Zertifikat läuft ab (sobald es ein Kernereignis dafür gibt) | Domain, Tage übrig |

  Beim Bündeln folgt `data` dem neuesten Ereignis. Plugins dürfen eigene
  `facts` mitgeben (gleiche Grenzen).
* Aktionstypen (feste Liste):

  | Typ | Wirkung |
  |---|---|
  | `open_app_route` | `target` ist eine App-Route: `vpn`, `services`, `gateways`, `inbox`, `plg-<id>` |
  | `open_portal` | `target` ist ein Pfad im Portal; der Client öffnet ihn über den vorhandenen Portal-Link mit Auto-Login (`next`, siehe unten) |
  | `mute_1h` | lokale Stummschaltung des Themas für 1 h, zusätzlich `ack` mit `action` |
  | `done` | `ack` mit `action:"done"` |
  | `ack` | `ack` mit `action` |
  | `quick_action` | `{ id, label, type, plugin, confirm, auth? }` (ab 1.169.0, nur Plugin-Pushes): `POST /api/v1/client/actions/<plugin>/<id>` mit `{"source":"notification"}`; `confirm:true` → vorher fragen; `auth:"device"` → vorher Geräteentsperrung/Biometrie (Android: `setAuthenticationRequired(true)`). Ergebnis als Hinweis bzw. aktualisierte Benachrichtigung |

#### Steuerereignisse (`event: control`, Phase 5)

Server-seitige Änderungen, die die Apps bisher per Polling (Heartbeat alle
60 s, `config/check`) bemerkt haben, kommen sofort über den Stream. Das
Polling bleibt als **langsamer Rückfall** (z. B. alle 15 min) bestehen.

```
event: control
data: {"type":"policy_changed","policy_version":"3f9a0c1d22b4e7a8"}

event: control
data: {"type":"support_bundle_requested","requested_at":"2026-10-11 08:15:02"}

event: control
data: {"type":"peer_state","enabled":false}

event: control
data: {"type":"config_changed"}
```

* **Ohne `id:`-Zeile:** Steuerereignisse werden nicht gespeichert, nicht
  bestätigt (kein `ack`) und nicht wiederholt. Was ein Gerät offline verpasst,
  holt es beim Neuaufbau aus `hello.state` nach. Unbekannte `type`-Werte
  ignorieren die Apps (künftige Erweiterungen).
* `policy_changed`: Die Client-Richtlinie dieses Geräts hat sich (vielleicht)
  geändert. `policy_version` ist der Wert, den auch der Heartbeat
  (`policyVersion`) und `GET /api/v1/client/policy` (`version`, ETag) liefern:
  ein **undurchsichtiger String** (16 Hex-Zeichen, Inhalts-Hash), keine Zahl.
  Weicht er vom gespeicherten Stand ab, lädt die App `GET /client/policy`.
  Ziel: globale Richtlinie und globale Split-Tunnel-Vorgabe → alle offenen
  Streams; Gruppen-Richtlinie → Geräte der Gruppe; Peer-Richtlinie, Peer in
  andere Gruppe verschoben → dieses Gerät; Gruppe gelöscht → ihre bisherigen
  Mitglieder; Split-Tunnel-Vorgabe eines Tokens → dieses Token. Jedes Gerät
  bekommt seine eigene wirksame Version; sie kann gleich bleiben (dann tut die
  App nichts).
* `support_bundle_requested`: Ein Admin hat von diesem Gerät ein
  Support-Bundle angefordert. `requested_at` ist derselbe Wert wie
  `supportBundleRequestedAt` im Heartbeat und in `peer-info`, also das
  SQLite-Format `YYYY-MM-DD HH:MM:SS` (UTC), kein ISO-8601 mit `T`/`Z`. Die
  App fragt ihre Person wie bisher, bevor sie etwas sendet.
* `peer_state`: Der Peer dieses Geräts wurde ein- oder ausgeschaltet
  (Schalter, Bearbeiten, Mehrfachauswahl, Ablaufdatum). Beim Ausschalten geht
  das Ereignis raus, **bevor** der Server den Peer aus WireGuard entfernt; ein
  Stream durch den Tunnel erhält es also noch. Danach bricht der Stream durch
  den Tunnel ab, ein direkter Stream bleibt offen.
* `config_changed`: Die WireGuard-Konfiguration dieses Geräts (das, was
  `GET /api/v1/client/config` bzw. `config/check` liefert) oder seine
  Split-Tunnel-Vorgabe (`GET /api/v1/client/split-tunnel`) hat sich geändert.
  Die App holt `config/check` mit ihrem Hash (bzw. `split-tunnel`) und wendet
  die neue Konfiguration an. Ziel: Peer bearbeitet (DNS, Keepalive, Schlüssel,
  Adresse) → dieses Gerät; Server-DNS, globale Split-Tunnel-Vorgabe,
  Backup-Wiederherstellung → alle offenen Streams; Split-Tunnel-Vorgabe eines
  Tokens → dieses Token. Gruppen und Routen fließen nicht in die
  Client-Konfiguration ein und lösen daher kein `config_changed` aus. Lieber
  ein Ereignis zu viel: Die App prüft per Hash, ob sich wirklich etwas
  geändert hat.
* Nur der Stream des betroffenen Geräts (bzw. der betroffenen Geräte) erhält
  das Ereignis; andere Geräte derselben Person nicht. Steuerereignisse gehen
  unabhängig von `enabled`, `muted_topics` und Ruhezeiten raus.
* Ein Fehler beim Senden lässt die Admin-Aktion nie scheitern. Staut der
  Socket (Backpressure), wartet je Typ das neueste Ereignis bis zum `drain`.

`hello.state` hat dieselben Werte wie die Polling-Routen für dieses Gerät:

| Feld | Typ | Quelle (gleicher Wert) |
|---|---|---|
| `policy_version` | String (16 Hex) oder `null` | Heartbeat `policyVersion`, `GET /client/policy` `version`/ETag |
| `peer_enabled` | Boolean | Heartbeat `peerEnabled`, `peer-info` `peer.enabled` |
| `support_bundle_requested` | Boolean | Heartbeat/`peer-info` `supportBundleRequested` |
| `support_bundle_requested_at` | String (`YYYY-MM-DD HH:MM:SS`, UTC) oder `null` | Heartbeat/`peer-info` `supportBundleRequestedAt` |
| `config_hash` | String (SHA-256, hex) oder `null` | `GET /client/config` bzw. `config/check` `hash`; direkt als `?hash=` für `config/check` verwendbar |

Ein Token, das noch an keinen Peer gebunden ist, bekommt die Version der
globalen Richtlinie, `peer_enabled:false`, keine Anforderung und
`config_hash:null`. `config_hash` ist auch `null`, wenn der Server die
Konfiguration gerade nicht erzeugen kann. Ändert sich die Konfiguration,
während der Stream aufgebaut wird, folgt direkt nach `hello` ein
`config_changed`.

Abgleich in der App nach jedem `hello`: `policy_version` ≠ gespeichert →
Richtlinie laden; `peer_enabled` anzeigen bzw. Tunnel-Status anpassen;
`support_bundle_requested` → wie beim Heartbeat nachfragen (nur, wenn
`support_bundle_requested_at` neu ist); `config_hash` ≠ eigener Hash →
`config/check`.

#### Plugin-Ereignisse (`event: plugin`, ab 1.177.0)

Plugins mit `permissions.events` senden flüchtige Echtzeit-Ereignisse an
bestimmte Personen (`gc.events.emit`, docs/plugins.md „Realtime events“) —
z. B. der Messenger: neue Nachricht, „schreibt …“, gelesen. Jeder offene
Stream einer genannten Person erhält:

```
event: plugin
data: {"plugin":"gatecontrol-messenger","type":"message.new","data":{"conversationId":"12","messageId":4711}}
```

* **Ohne `id:`-Zeile**, nicht gespeichert, nicht bestätigt, nicht wiederholt
  (wie `control`): Ein Gerät, das offline war oder neu verbindet, holt den
  Stand über die Client-API des Plugins nach
  (`/api/v1/client/plugins/<plugin>/api/…`). Unter Backpressure verwirft der
  Server das Ereignis.
* `plugin`: Plugin-ID; `type`: `[a-z][a-z0-9._-]{0,63}`, vom Plugin
  festgelegt; `data`: beliebiges JSON (≤ 4 KB) oder `null`. Die Apps leiten
  das Ereignis an die Ansicht des Plugins weiter (Android: `PushStreamClient`
  → z. B. `ChatRepository`) und ignorieren Plugins/Typen, die sie nicht
  kennen.
* Unabhängig von `enabled`, `muted_topics`, Themen-Abos und Ruhezeiten — es
  ist keine Benachrichtigung, die Apps zeigen dafür nie selbst etwas an.

#### Chat-Benachrichtigungen (`kind: "message"`, ab 1.177.0)

Ein Plugin-Thema mit `notifyTopics[].chat: true` (docs/plugins.md „Chat
notifications“) liefert Nachrichten zwischen Personen. Sie kommen als ganz
normales `event: notification` (gleiche `seq`, gleiches `ack`), mit diesen
Unterschieden:

```
id: 130
event: notification
data: {"seq":130,"id":52,"event_id":"plugin:gatecontrol-messenger:message","topic":"plugin:gatecontrol-messenger:message",
       "priority":"normal","title":"Anna","body":"Bist du schon unterwegs?","kind":"message",
       "created_at":"2026-10-17T18:02:11Z","expires_at":"2026-10-20T18:02:11Z",
       "collapse_key":"plugin:gatecontrol-messenger:chat:12","silent":false,"imageUrl":null,
       "data":{"route":"plg-gatecontrol-messenger","messageId":4711,
               "conversation":{"id":"12","title":"Familie","isGroup":true},
               "sender":{"id":7,"name":"Anna","avatarUrl":"/avatars/Xk3….webp"},
               "actions":[{"id":"reply","label":"Antworten","type":"reply","path":"conversations/12/messages"},
                          {"id":"mark_read","label":"Gelesen","type":"mark_read","path":"conversations/12/read","body":{"upTo":4711}}]}}
```

* `kind: "message"` gibt es nur bei Chat-Benachrichtigungen; bei allen
  anderen fehlt das Feld (Vertrag unverändert). Ältere Apps zeigen sie wie
  jede Benachrichtigung an.
* `data.conversation` `{ id (String), title (String|null), isGroup }` und
  `data.sender` `{ id (Zahl oder String), name, avatarUrl (relativer Pfad
  `/avatars/…` oder `/plugin-media/…` des eigenen Servers, oder null) }` sind
  vom Server geprüft. `title` ist der Anzeigename des Absenders (bzw. bei
  ausgeschalteter Vorschau „Neue Nachricht von Anna“), `body` der Text (bei
  ausgeschalteter Vorschau leer) — das entscheidet das Plugin.
* `collapse_key` ist pro Unterhaltung gleich (`plugin:<id>:chat:<conversation.id>`,
  sofern das Plugin keinen eigenen setzt). Chat-Benachrichtigungen werden am
  Server **nie gebündelt** und nie zurückgehalten; jede Nachricht kommt
  einzeln (neue `seq`, neue `id`). Ruhezeiten machen sie wie üblich `silent`.
* Nicht im Posteingang: `GET /api/v1/client/push/inbox` (und das Postfach im
  Portal) liefern keine `kind:"message"`-Einträge, `unread` (auch in
  `hello`) zählt sie nicht. Sie gehören in den Chat des Plugins.

**Darstellung Android** (verbindlich):

* Eigener Kanal „Chats“ (Wichtigkeit hoch), getrennt von den übrigen
  Kanälen. Eine Benachrichtigung **pro Unterhaltung** (`conversation.id`,
  Notification-Tag = `collapse_key`), Stil `NotificationCompat.MessagingStyle`:
  `Person` „Ich“ als Nutzer; jede eingehende Chat-Benachrichtigung fügt eine
  `MessagingStyle.Message(body, created_at, Person(sender.name, Icon aus
  sender.avatarUrl, key = sender.id))` an die vorhandene Benachrichtigung der
  Unterhaltung an (die App hält die letzten Nachrichten je Unterhaltung, z. B.
  bis zu 7). `conversation.isGroup` → `setGroupConversation(true)` und
  `setConversationTitle(conversation.title)`. Bilder: `imageUrl` als
  `setData("image/…", uri)` der Nachricht, wenn vorhanden.
* Gruppierung: alle Chat-Benachrichtigungen in einer Gruppe
  (`setGroup("chats")`) mit Zusammenfassung; optional Shortcuts/Bubbles je
  Unterhaltung (`setShortcutId`, `LocusId` = `conversation.id`).
* Aktion `reply`: Aktion mit `RemoteInput` (Label = `label`). Die App sendet
  `POST /api/v1/client/plugins/<plugin>/api/<path>` mit dem JSON
  `{ ...body, "clientId": "<UUID>", "kind": "text", "text": "<Eingabe>",
  "source": "notification" }` (Token wie jede Client-Route; `clientId` für
  idempotentes Wiederholen). Bei Erfolg die eigene Antwort als Nachricht von
  „Ich“ an den `MessagingStyle` anhängen (`setSilent`), bei Fehler die
  Benachrichtigung mit Fehlerhinweis aktualisieren. Danach wie `mark_read`
  verfahren (die eigene Antwort heißt: gelesen).
* Aktion `mark_read`: `POST /api/v1/client/plugins/<plugin>/api/<path>` mit
  `body` (oder `{}`), dann `POST /api/v1/client/push/ack` mit `state:"read"`
  und `action:"mark_read"` für **alle** `seq` dieser Unterhaltung, die die App
  gerade anzeigt, und die Benachrichtigung entfernen.
* Antippen: öffnet den Chat-Tab des Plugins in dieser Unterhaltung
  (`data.route` + `conversation.id`), `ack` `read` wie oben.
* Öffnet die Person eine Unterhaltung in der App, bestätigt die App die
  angezeigten `seq` dieser Unterhaltung mit `read` und entfernt die
  Benachrichtigung.
* `event: read` / `event: revoke` mit einer `id` einer Chat-Benachrichtigung:
  diese Nachricht aus dem `MessagingStyle` entfernen; ist keine mehr übrig,
  die Benachrichtigung der Unterhaltung entfernen. Zusätzlich darf die App
  Plugin-Ereignisse (`event: plugin`, z. B. Messenger-Typ `read` einer
  Unterhaltung) nutzen, um Benachrichtigungen dieser Unterhaltung zu entfernen.

**Darstellung Windows** (client-core, Pro, Community):

* Ein Toast pro Nachricht mit `Tag` = `collapse_key` und `Group` = `chats`
  (ersetzt den vorherigen Toast derselben Unterhaltung), Kopfzeile
  `conversation.title` (Gruppe) bzw. `sender.name`, Text `body`, Bild
  `sender.avatarUrl` als App-Logo (rund).
* `reply` → Toast-`input` (Textfeld) mit Schaltfläche `label`; senden wie bei
  Android (`POST …/api/<path>` mit `{ ...body, clientId, kind: "text", text,
  source: "notification" }`). `mark_read` → Schaltfläche, Ablauf wie bei
  Android. Ohne Unterstützung für Eingaben (ältere Systeme) nur die
  Schaltfläche „Öffnen“.
* `read`/`revoke` → Toast entfernen (`ToastNotificationHistory.Remove(tag, group)`).

#### Plugin-Medien in den Apps (ab 1.177.0)

Plugins mit `media` in der plugin.json (docs/plugins.md „Media“) nehmen
Dateien über GateControl entgegen — Upload und Download sind Kern-Routen mit
derselben Token-Prüfung wie die Client-API der Plugins:

```
PUT /api/v1/client/plugins/<plugin>/media
  Content-Type: <ein Typ aus media.types des Plugins>   (z. B. image/webp, audio/ogg)
  Content-Length: <Bytes, ≤ media.maxBytes>             (Pflicht, kein chunked)
  Body: die Datei selbst (roh, kein JSON, kein multipart)
  200 {"ok":true,"mediaId":"<32 hex>","mime":"image/webp","bytes":183422}
  404 not_found (Plugin unbekannt, nicht nutzbar, ohne media) · 403 no_user
  411 length_required · 413 too_large · 415 unsupported_type · 507 quota_exceeded
  400 aborted | length_mismatch

GET /api/v1/client/plugins/<plugin>/media/<mediaId>     (auch HEAD)
  Range: bytes=<a>-<b> (optional, eine Range; für Sprachnachrichten/Seeking)
  200 / 206 (Content-Range) mit Content-Type, Accept-Ranges: bytes, ETag,
  Cache-Control: private, max-age=86400, immutable · 416 bei unerfüllbarer Range
  404 not_found, wenn das Plugin (Hook mediaAccess) dieser Person die Datei
  nicht zeigt — oder ohne Hook: nur der hochladenden Person
```

* Die Medien-ID bindet erst das Plugin (`gc.media.claim`) — die App schickt
  sie nach dem Upload an die Plugin-API (z. B. mit der Nachricht); nicht
  gebundene Uploads löscht der Server nach 24 h.
* Bilder verkleinert die App vor dem Upload (lange Kante 2048 px, WebP/JPEG),
  ein Vorschaubild (≤ 64 KB) lädt sie als eigene Datei hoch. Der Server
  rechnet nichts um.
* Bilder, Audio und Video kommen `inline`, alle anderen Typen mit
  `Content-Disposition: attachment`.

### `POST /api/v1/client/push/ack`

* Body: `{"seqs":[123,124],"state":"delivered"|"read"|"dismissed","action":"details"}`
  (`action` optional, `[A-Za-z0-9_.:-]{1,64}` — auch die `id` einer
  `quick_action`; höchstens 200 `seqs`).
* Antwort: `{"ok":true}`.
* `read` und `dismissed` werden an die anderen Geräte derselben Person als
  `event: read` weitergegeben.

### `GET /api/v1/client/push/inbox?limit=100&before=<seq>`

* Antwort: `{"items":[<notification wie oben> + "state":"delivered"|"read"|"dismissed"],"unread":3}`.
* Sortiert neueste zuerst; abgelaufene und zurückgezogene Nachrichten sind
  nicht enthalten. Noch nicht bestätigte Einträge erscheinen als `delivered`.
* Chat-Benachrichtigungen (`kind:"message"`, ab 1.177.0) sind nicht enthalten
  und zählen nicht zu `unread`.

### `GET /api/v1/client/push/prefs`

* Antwort: `{"ok":true,"enabled":true,"mode":"always"|"vpn_only"|null,"muted_topics":["services"],"restricted":false,
  "quiet":{"from":"22:00","to":"07:00","tz":"Europe/Berlin","critical_bypass":true}}`.
* `enabled`, `mode`, `muted_topics`, `restricted`: was das Gerät zuletzt mit
  `PUT` gemeldet hat (ohne Eintrag: `true`, `null`, `[]`, `false`).
* `quiet`: Ruhezeiten der Person des Tokens (im Portal eingestellt) oder
  `null`, wenn keine gesetzt sind (oder `from` = `to`). `from`/`to` sind
  `HH:MM` in der Zeitzone `tz` (IANA; ohne eigene Angabe die des Servers).
  `critical_bypass:true` heißt: Kritisches kommt trotzdem mit Ton. Die
  Ruhezeit wendet der Server an (`silent:true`); die Apps zeigen sie nur an.
* Liest nur, schreibt nichts (kein Eintrag als Push-Gerät).

### `PUT /api/v1/client/push/prefs`

* Body: `{"enabled":true,"mode":"always"|"vpn_only","muted_topics":["plugin:skoda:charging"],"restricted":false}`.
* Antwort: `{"ok":true}`.
* `restricted` meldet Android, wenn die Akkuoptimierung aktiv ist.

### `POST /api/v1/client/push/test`

* Antwort: `{"ok":true,"seq":130}`.
* Erzeugt eine `normal`-Nachricht (mit Ton, auch auf dem Sperrbildschirm) „Testnachricht“ nur an dieses Gerät, ohne
  Ruhezeit-Filter und ohne Rate-Limit über 5 pro Minute.

### `POST /api/v1/client/portal-link` mit Ziel (`next`)

Der vorhandene Portal-Link mit Auto-Login (Einmal-URL `/auto?t=…`, 60 s,
einmal verwendbar) nimmt ein optionales Ziel im Portal an, damit die Apps
direkt in einen Portal-Reiter springen und trotzdem angemeldet werden:

* Anfrage: Body (oder Query) `{"next":"/portal#mitteilungen"}`; `path` ist
  ein gleichwertiger Alias.
* Antwort wie bisher, die URL trägt das geprüfte Ziel:
  `{"ok":true,"url":"https://home.example/auto?t=<ticket>&next=%2Fportal%23mitteilungen","expiresIn":60}`.
  Die Apps dürfen `next` auch selbst an eine vorhandene `/auto`-URL hängen
  (URL-kodiert); der Server prüft es beim Aufruf erneut.
* Erlaubt sind nur Portal-Reiter: `/portal`, `/portal#<reiter>` oder
  `/#<reiter>` (wird zu `/portal#<reiter>`), höchstens 100 Zeichen.
  `<reiter>`: `start`, `dienste`, `zuhause`, `fahrzeug`, `netzwerk`,
  `geraete`, `mitteilungen` (Posteingang), `benachrichtigungen` (Meine
  Benachrichtigungen) oder ein Plugin-Reiter `plg-<id>`.
* Alles andere (andere Pfade, `//`, Schema, `\`, Query, unbekannter Reiter,
  zu lang) wird **ignoriert**, nie ein Fehler: Es gilt dann `/portal`.
* Ungültiges oder verbrauchtes Ticket: anonymes Portal mit Hinweis, das Ziel
  entfällt. Gemeinsames Gerät: erst „Wer bist du?“, nach der PIN folgt das Ziel.
* Für `open_portal`-Aktionen geben die Apps `target` als `next` weiter.
