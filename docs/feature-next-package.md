# Paket nach 1.127.1: L4-Schutz, Betrieb, Dashboard, Etiketten

Status: in Umsetzung (Integrations-Branch `feat/next`, ab master 1.127.1). Verbindlich.
Auftrag des Maintainers vom 2026-09-16: Punkte 1, 2, 4, 5, 6, 7, 8, 9, 10 der
Vorschlagsliste. **Welle 1** (dieses Dokument, drei parallele Stränge): 1, 2, 4, 5, 6, 7.
**Welle 2** danach: 8 (Restliche englische Texte, Browser-Dialoge, Fehlercodes),
9 (ein Stylesheet), 10 (Tests näher an der CI). Punkt 3 (Gateway-Teil der
TLS-Fingerabdruck-Prüfung) wurde ausdrücklich zurückgestellt.

Grundlagen wie gehabt: Aurora ist das einzige Theme, Oberfläche mit `el()` (kein
innerHTML), Stile neuer Funktionen in einer eigenen Datei unter `public/css/`,
i18n-Blöcke **nicht** ans Dateiende (der `waf.*`-Block ist der Schluss), keine neuen
npm-Abhängigkeiten, keine neuen Lizenzschlüssel.

Migrationen: **v78** (Strang S1), **v79** (Strang S3). S2 kommt ohne Migration aus.

## S1 — Punkt 1: Schutz für TCP-/UDP-Routen (L4)

Anlass: `ssh918` (TCP 2023 → SSH der DS918+) ist öffentlich und wird von Scannern
angefragt; WAF und Scanner-Sperre greifen dort heute nicht.

1. **Sperrliste gilt auch für L4.** Die vorhandenen `waf_bans` (Release B) wirken
   zusätzlich auf jede L4-Route. Der mitgelieferte Caddy hat `layer4.matchers.remote_ip`
   und `layer4.handlers.close` — erst prüfen und dann eine Route je L4-Listener bauen:
   gesperrte IPs zuerst, `close`, danach die bestehenden Routen. Eigene IPs
   (`waf.trusted_ips`) nie sperren.
2. **IP-Filter pro L4-Eintrag.** Die vorhandenen Felder `ip_filter_enabled`,
   `ip_filter_mode` (`allow`/`deny`), `ip_filter_rules` gelten künftig auch für
   L4-Routen (Generator + API-Validierung + Editor zeigt den Block für L4).
   Bei `allow` gilt: nur die Liste kommt durch, alles andere `close`.
3. **Verbindungsrate pro IP** (neu, Migration v78: `routes.l4_conn_limit INTEGER`,
   `routes.l4_conn_window_s INTEGER`): Mehr als N Verbindungen in M Sekunden von
   derselben IP → automatische Sperre über die vorhandene Ban-Infrastruktur
   (Grund `l4_rate`), Standard aus. Umsetzung: Caddy-L4 kann das nicht selbst;
   die Verbindungen sind aber im Zugriffsprotokoll bzw. über die Caddy-Logs
   sichtbar — **zuerst prüfen**, ob caddy-l4 Verbindungen protokolliert (Logger
   `layer4`) und ob GateControl sie wie das WAF-Audit-Log auswerten kann.
   Wenn nicht sauber möglich: Punkt 3 dieses Strangs weglassen, im Bericht
   begründen und stattdessen in der Oberfläche auf IP-Filter und „Nur intern“
   hinweisen. Nichts erfinden, was der mitgelieferte Caddy nicht kann.
4. Oberfläche: Im Eintrags-Editor für L4-Einträge ein Block „Schutz“ mit IP-Filter,
   der Verbindungsrate (falls umgesetzt) und einem Hinweis, dass WAF nur für HTTP
   gilt. Auf der Sicherheitsseite zählen L4-Einträge ohne Schutz als
   „öffentlich ohne Schutz“ (der bestehende Check prüft heute nur HTTP).

## S2 — Punkte 2, 4, 6: Betrieb

1. **Punkt 2 – Wiederherstellung testen.** `POST /api/v1/settings/backup/targets/:id/verify`
   holt das neueste Archiv vom Ziel, entschlüsselt es mit der Passphrase und prüft
   es, ohne irgendetwas zu verändern. Antwort:
   `{ ok, file, size, created_at, gc_version, include_key, counts: { routes, peers, users, settings } , warnings: [] }`;
   Fehler mit Code (`NO_REMOTE_BACKUP`, `PASSPHRASE_NOT_SET`, `DECRYPT_FAILED`,
   `CORRUPT`, `TRANSPORT_FAILED`). Oberfläche: Knopf „Wiederherstellung testen“ je
   Ziel mit Ergebnisanzeige (Datum, Größe, Inhalt in Zahlen, Warnungen), Lizenz wie
   die übrigen Ziel-Aktionen. Das Ergebnis geht außerdem in den Sicherheits-Check:
   `backup_offsite` meldet „seit über 30 Tagen nicht geprüft“ als Hinweis
   (Zeitstempel in `backup_targets.last_verify_at`/`last_verify_status`; Spalten via
   S1-Migration v78 **nicht** anlegen — dieser Strang nutzt Einstellungen
   (`settings`-Schlüssel je Ziel-ID) oder bekommt eine eigene Migration v80).
2. **Punkt 4 – `update.sh` aktualisiert sich selbst.** Nach einem erfolgreichen
   Update vergleicht update.sh sich mit `/app/update.sh` aus dem **neuen** Image
   (`docker run --rm --entrypoint sh <image> -c 'cat /app/update.sh'`), prüft die
   Datei mit `sh -n`/`bash -n` und ersetzt sich atomar (temporäre Datei + `mv`),
   Modus 755, Sicherung der alten Fassung als `update.sh.bak`. Nur wenn sich der
   Inhalt unterscheidet; Abschaltbar über `GC_UPDATE_SH_SELFUPDATE=0`; ausführlich
   protokolliert; niemals im selben Lauf erneut ausführen (kein Re-exec, der neue
   Stand gilt ab dem nächsten Cron-Lauf). Tests in `tests/update_sh.test.sh`
   (Fake-`docker`-Shim): identisch → nichts tun; neuer Inhalt → ersetzt und
   gesichert; kaputte Datei (Syntaxfehler) → nicht ersetzen und Warnung;
   abgeschaltet → nichts tun. Dazu in der Oberfläche der vorhandenen
   Update-Karte ein Hinweis, wenn die Host-Fassung von der Image-Fassung abweicht
   (Vergleich über eine Versionszeile in update.sh, z. B. `# gc-update-sh: <n>`,
   die beide Seiten lesen; API `GET /api/v1/system/auto-update` um
   `update_sh: { host_version, image_version, matches }` erweitern).
3. **Punkt 6 – Lizenz bei neuen Funktionen.** Fehlt ein Boolean-Feature komplett im
   Token (`locked` = `not_in_token`, siehe Release B), gilt es bei bezahlten Plänen
   (alles außer `community`) als **freigeschaltet**; Community bleibt beim
   `COMMUNITY_FALLBACK`. Sichtbar machen: `GET /api/v1/license` liefert je Feature
   `source: 'token' | 'plan_default' | 'community'`, die Oberfläche zeigt bei
   `plan_default` einen kleinen Hinweis „aus deinem Plan abgeleitet“. Dazu ein
   Abschnitt in `docs/` (Release-Checkliste): neue Feature-Schlüssel gehören auf
   den Lizenzserver, die Ableitung ist nur die Brücke. Grenzwerte (Zahlen wie
   `vpn_peers`) bleiben unverändert — nur Boolean-Features.

## S3 — Punkte 5, 7: Dashboard-Probleme und Etiketten

1. **Punkt 5 – Probleme-Anzeige.** Neuer Abschnitt auf dem Dashboard (und API
   `GET /api/v1/dashboard/problems`), der aus vorhandenen Daten zusammenträgt:
   - Gateway offline (`gateway_meta.alive`), unterschieden von „Gateway erreichbar,
     Dienst im LAN antwortet nicht“ — die Gateway-Antwort nennt den Grund
     (`ECONNREFUSED` → Dienst läuft nicht, `EHOSTUNREACH` → Rechner aus/schläft);
     Quelle: Zugriffsprotokoll (`/data/caddy/access.log`, letzte N MB, wie im
     WAF-Assistenten) und/oder die vorhandene Überwachung.
   - Zertifikate mit Problemen (tls_status), pausierte Hosts.
   - Zurückgerolltes oder fehlgeschlagenes Update, fehlgeschlagene Backups,
     WAF-Modul fehlt.
   Jede Zeile mit Link zur passenden Stelle. Live-Aktualisierung über die
   vorhandenen SSE-Typen.
2. **„Nur bei Bedarf“** (Migration v79: `routes.on_demand INTEGER NOT NULL DEFAULT 0`):
   Solche Einträge erscheinen **nicht** als Problem, sondern mit dem Vermerk
   „nur bei Bedarf“. Im Editor ein Schalter mit Erklärung. Hat der Eintrag ein
   Gateway-Ziel und die Lizenz `gateway_wol`, weist die Oberfläche bei
   `EHOSTUNREACH` auf Wake-on-LAN hin (vorhandene Felder `wol_enabled`, `wol_mac`).
3. **Punkt 7 – Etiketten für L4-Einträge** (Migration v79: `routes.label TEXT`):
   Ein sichtbarer Name je Eintrag (Beispiel „SSH DS918+“), angezeigt in der
   Zonen-Ansicht, im Domain-Dialog, in der Problem-Anzeige und in der
   Schnellsuche (`command-palette.js` sucht künftig auch in Etiketten). Die
   Migration übernimmt für L4-Routen den alten `routes.domain`-Wert als Etikett,
   wenn er nicht dem FQDN des Hosts entspricht (Beispiel `ssh918.domaincaster.com`
   → Etikett „ssh918“). Im Editor ein Feld „Name“; leer = wie bisher Port/Ziel.
   `GET /api/v1/zones` liefert `entry.label`.

## Tests (alle Stränge)

Unit- und API-Tests wie gehabt; Caddy-Validierung mit dem Caddy aus dem Image für
jede neue Generator-Ausgabe (L4-Sperrroute, IP-Filter, `close`-Handler) und ein
echter Laufzeittest in einem Wegwerf-Container (keine Host-Ports, `--memory 2g`);
Browser-Szenarien in eigenen Dateien unter `/root/gc-wt/e2e/pw/scenarios/`;
Konfigurationsvergleich auf einer Kopie der Prod-Datenbank: **ohne** neue
Einstellungen muss die Caddy-Konfiguration byte-gleich bleiben.
