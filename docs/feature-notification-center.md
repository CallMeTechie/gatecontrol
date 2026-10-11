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
  Warteschlange; reine WireGuard-Peers sind „unsupported“.
* Zeitstempel sind ISO-8601 UTC mit Millisekunden; an die Geräte gehen
  `created_at`/`expires_at` ohne Millisekunden.

**Aufräumen:** Ein Job läuft stündlich.

* Nicht zugestellte Nachrichten verfallen nach 72 h (Standard; je Priorität einstellbar).
* Der Verlauf wird nach 30 Tagen gelöscht.
* Pro Gerät bleiben höchstens 200 Nachrichten in der Warteschlange; die ältesten Info-Meldungen fallen zuerst.

## Server: Schnittstellen

**Gerät** (Token-Auth, Scope `client`, Maschinenbindung wie bei den anderen `/client`-Routen):

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/v1/client/push` | SSE-Stream. Ereignisse `hello` (Server-Zeit, Keepalive, Themenliste), `notification`, `read` (Gelesen-Abgleich), `revoke` (zurückgezogen), `policy` / `support_bundle` (Phase 5). Wiederaufnahme über `Last-Event-ID`. |
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
  platform, client_type, app_version, state: connected|restricted|offline|unsupported,
  via, connected_since, last_seen, queued, last_ack_at, buffer_until}]}`.
  `restricted` = verbunden, aber Akkuoptimierung aktiv; `buffer_until` = wann
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
* **Prioritäten für Plugins:** höchstens `high`. `critical` bleibt dem System vorbehalten.
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
  priority: 'normal',             // info|normal|high
  users: [12],                    // optional: nur diese Personen (sonst Abonnenten)
  collapseKey: 'charge:VIN123',   // optional
  ttl: 6 * 3600,                  // optional, Sekunden
  data: { route: 'plg-skoda' }    // optional: Deep-Link in den Plugin-Tab
});
```

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
  * Freie URLs nur auf die eigene Server-Domain.
* Manuelle Nachrichten und Regeländerungen landen im Aktivitätsprotokoll.

## Phasen, Releases und Umfang

| Phase | Inhalt | Repos | Umfang | Release |
|---|---|---|---|---|
| 1 | Datenmodell (v93), Hub und Regeln, SSE-Stream, ACK, Warteschlange und Aufräumen, Admin-API und Admin-Seite, Übernahme der E-Mail-Einstellungen, Test senden | gatecontrol | **groß**, 3 PRs (Kern, Admin-Seite, Übernahme und Doku) | GC-Minor |
| 2 | Push-Client, `PushService`, Kanäle, Berechtigungen, Akkuoptimierung, Posteingang, Einstellungen | Android | **mittel bis groß**, 2 PRs (Kern und Dienst, Oberfläche) | Android-Minor |
| 3 | `push-client` und `notification-center` im Core; Oberfläche und Tray in Pro und Community | client-core, Pro, Community | **mittel**, 3 PRs (Core, Pro, Community) | Core, dann Pro und Community |
| 4 | Portal (Abos, Ruhezeiten, Posteingang); Plugin-API v2 mit `notifyTopics`; Fahrzeuge-, Smart-Home- und Klima-Plugin melden passende Ereignisse | gatecontrol, gatecontrol-plugins | **mittel**, 2 bis 3 PRs | GC-Minor, Plugin-Patches |
| 5 | Polling ersetzen: Richtlinie geändert, Support-Bundle angefordert, Gerät gesperrt kommen per Push (Heartbeat bleibt als Rückfall); Gelesen-Abgleich und Bündeln verfeinern | alle | **klein bis mittel** | Patches |

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
  * `403 {"error":"direct_not_allowed"}`: Der Admin erlaubt Push nur durch den
    Tunnel. Neuer Versuch, sobald das VPN steht (bzw. stündlich).
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

Ereignisse:

```
event: hello
data: {"server_time":"2026-10-10T21:42:03.120Z","keepalive_s":25,"retention_h":72,
       "via":"direct","unread":3,
       "quiet":{"from":"22:00","to":"07:00","tz":"Europe/Berlin","critical_bypass":true},
       "topics":[{"id":"security","label":"Sicherheit"},{"id":"devices","label":"Geräte & Gateways"},
                 {"id":"services","label":"Dienste"},{"id":"admin_notice","label":"Hinweise vom Admin"},
                 {"id":"plugin:skoda:charging","label":"Fahrzeug · Laden abgeschlossen"}]}

id: 123
event: notification
data: {"seq":123,"id":45,"event_id":"gateway_state","topic":"devices","priority":"critical",
       "title":"Gateway „Zuhause“ ist offline","body":"Seit 2 Minuten kein Lebenszeichen …",
       "created_at":"2026-10-10T21:42:03Z","expires_at":"2026-10-13T21:42:03Z",
       "collapse_key":"gateway:3","silent":false,
       "data":{"route":"gateways","actions":[{"id":"details","label":"Details","type":"open_app_route","target":"gateways"},
                                             {"id":"mute_1h","label":"1 h stumm","type":"mute_1h"}],
               "facts":[{"label":"Zuletzt gesehen","value":"10.10.26, 21:40"},{"label":"Betroffene Routen","value":"3"}]}}

event: read
data: {"ids":[45]}            # auf einem anderen Gerät derselben Person gelesen → hier ausblenden

event: revoke
data: {"ids":[45]}            # zurückgezogen (z. B. Entwarnung ersetzt Meldung) → ausblenden

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

### `POST /api/v1/client/push/ack`

* Body: `{"seqs":[123,124],"state":"delivered"|"read"|"dismissed","action":"details"}`
  (`action` optional; höchstens 200 `seqs`).
* Antwort: `{"ok":true}`.
* `read` und `dismissed` werden an die anderen Geräte derselben Person als
  `event: read` weitergegeben.

### `GET /api/v1/client/push/inbox?limit=100&before=<seq>`

* Antwort: `{"items":[<notification wie oben> + "state":"delivered"|"read"|"dismissed"],"unread":3}`.
* Sortiert neueste zuerst; abgelaufene und zurückgezogene Nachrichten sind
  nicht enthalten. Noch nicht bestätigte Einträge erscheinen als `delivered`.

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
* Erzeugt eine `info`-Nachricht „Testnachricht“ nur an dieses Gerät, ohne
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
