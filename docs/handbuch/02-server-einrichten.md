# 2. Server einrichten

[← Überblick](01-ueberblick.md) · [Inhaltsverzeichnis](README.md) · [Weiter: Gateway einrichten →](03-gateway-einrichten.md)

Der einfachste Weg ist das Installationsskript `setup.sh`. Es installiert
Docker, wenn es fehlt, fragt dich nach den wichtigsten Werten (auch nach der
Zeitzone), erzeugt sichere Schlüssel, legt die Einstellungsdatei `.env` und den
Datenordner `data` an und holt das Update-Skript `update.sh`.

Alle Befehle in diesem Kapitel laufen **auf dem Server als root**.

## 2.1 Domain auf den Server zeigen lassen

1. Melde dich bei deinem Domain-Anbieter an.
2. Lege einen **A-Record** an, der auf die öffentliche IPv4-Adresse deines Servers zeigt:

   ```
   gate.example.com.   IN  A   198.51.100.42
   ```

3. Warte, bis der Eintrag weltweit bekannt ist (meist wenige Minuten, selten bis zu 30 Minuten).

**Prüfen:** `dig +short gate.example.com` (oder `nslookup gate.example.com`) zeigt die IP deines Servers.

## 2.2 Ports öffnen

Öffne in der Firewall deines Server-Anbieters (und in `ufw`/`iptables`, falls du sie nutzt):

| Port | Protokoll | Wofür |
|---|---|---|
| 80 | TCP | HTTP und die automatische Zertifikatsprüfung von Let's Encrypt |
| 443 | TCP | HTTPS für die Weboberfläche und alle Routen |
| 443 | UDP | HTTP/3 (optional) |
| 51820 | UDP | WireGuard-VPN (Gateways und Geräte) |

**Prüfen:** Die vier Regeln stehen in der Firewall-Übersicht deines Anbieters.

## 2.3 Dateien herunterladen

1. Melde dich per SSH am Server an und werde root:

   ```bash
   sudo -i
   ```

2. Lege den Ordner an und lade die Dateien herunter:

   ```bash
   mkdir -p /opt/gatecontrol && cd /opt/gatecontrol
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
   ```

Alle Daten des Servers (Datenbank, Schlüssel, Zertifikate) landen später im
Ordner `/opt/gatecontrol/data` neben der Compose-Datei.

Läuft dein Server schon länger und seine Daten liegen noch in einem
Docker-Volume, ersetze die Compose-Datei **nicht** einfach durch die neue –
sonst startet er mit leerer Datenbank. Den Umzug beschreibt die FAQ:
[Server-Daten von einem Docker-Volume nach ./data umziehen](07-faq.md#server-daten-von-einem-docker-volume-nach-data-umziehen).

**Prüfen:** `ls -a /opt/gatecontrol` zeigt `setup.sh`, `docker-compose.yml` und
`.env.example`.

## 2.4 Das Installationsskript ausführen

1. Starte das Skript:

   ```bash
   cd /opt/gatecontrol
   bash setup.sh
   ```

2. Beantworte die Fragen:

   | Frage des Skripts | Was du eingibst |
   |---|---|
   | `Domain fuer das Web-Interface` | deine Domain, z. B. `gate.example.com` |
   | `HTTPS verwenden? (J/n)` | Enter (= Ja) |
   | `Oeffentliche IP oder Domain fuer WireGuard` | Enter (= dieselbe Domain) |
   | `Admin-Benutzername [admin]` | Enter oder ein eigener Name |
   | `Admin-Passwort` / `Passwort wiederholen` | ein starkes Passwort (wird nicht angezeigt) |
   | `Sprache (de/en) [de]` | Enter |
   | `E-Mail fuer Let's Encrypt Zertifikate (optional)` | deine E-Mail-Adresse (empfohlen) |
   | `Zeitzone [...]` | Enter, wenn der Vorschlag stimmt (sonst z. B. `Europe/Vienna`) |
   | `Netzwerk-Interface [...]` | Enter (das Skript erkennt es selbst) |
   | `Container jetzt starten? (J/n)` | Enter (= Ja) |
   | `Auto-Update-Zeitplan einrichten …? (J/n)` | Enter (= Ja), siehe [2.9](#29-updates-einrichten) |

   Meldet das Skript `Port … ist bereits belegt`, läuft auf dem Server schon ein
   Webserver oder VPN. Brich dann ab und beende diesen Dienst zuerst.

**Prüfen:** Das Skript zeigt die „Zusammenfassung“ und es gibt die Datei
`/opt/gatecontrol/.env`, den Ordner `/opt/gatecontrol/data` und das Skript
`/opt/gatecontrol/update.sh`.

## 2.5 Die Werte in der `.env`, die du wirklich brauchst

`setup.sh` hat diese Werte für dich gesetzt. Du musst sie nur kennen:

| Wert | Bedeutung |
|---|---|
| `GC_BASE_URL` | Adresse der Weboberfläche, z. B. `https://gate.example.com`. Für diese Domain holt der Server automatisch das HTTPS-Zertifikat. |
| `GC_WG_HOST` | Adresse, unter der Gateways und Geräte das VPN erreichen. |
| `GC_ADMIN_USER` / `GC_ADMIN_PASSWORD` | Erster Login. Das Passwort gilt nur beim allerersten Start; danach änderst du es in der Oberfläche. |
| `GC_CADDY_EMAIL` | Kontakt für Let's Encrypt (Warnungen zu Zertifikaten). |
| `GC_SECRET`, `GC_ENCRYPTION_KEY` | Geheime Schlüssel, vom Skript erzeugt. **Nie ändern, nie weitergeben.** Ohne den Encryption-Key ist ein Backup der Datenbank wertlos. |
| `TZ` | Zeitzone, z. B. `Europe/Berlin`. Die Gateways übernehmen sie vom Server. Sie gilt für den nächtlichen Portscan, den Plan der Geschwindigkeitsmessung und die Zeiten des DNS-Filters. Ohne `TZ` läuft der Server in UTC, und die Gateways rechnen dann auch in UTC. |

`setup.sh` schützt die Datei so, dass nur root sie lesen kann (`chmod 600`).

**Sicherheitshinweis:** Die `.env` enthält dein Admin-Passwort und die
geheimen Schlüssel. Gib sie nie weiter, schick sie nie per Chat oder E-Mail und
füge sie nie in ein Ticket ein.

Eine Regel für später: Nach **jeder** Änderung an der `.env` startest du mit

```bash
cd /opt/gatecontrol
docker compose up -d
```

– **nicht** mit `docker restart gatecontrol`. Nur `docker compose up -d` erstellt
den Container mit den neuen Werten neu. `docker restart` startet ihn mit den
alten Werten.

**Prüfen:** `grep -c '^TZ=' /opt/gatecontrol/.env` zeigt `1`. Zeigt es `0`
(ältere Installation), trage die Zeile nach – siehe FAQ
[„Der Server läuft in UTC“](07-faq.md#der-server-läuft-in-utc).

## 2.6 Server starten

1. Hast du in `setup.sh` „Container jetzt starten“ bejaht, läuft GateControl
   schon. Sonst starte es:

   ```bash
   cd /opt/gatecontrol
   docker compose up -d
   ```

2. Sieh beim ersten Start zu:

   ```bash
   docker compose logs -f gatecontrol
   ```

   Nach 10–30 Sekunden erscheint `certificate obtained successfully`. Dann hat
   der Server sein HTTPS-Zertifikat. Beende die Anzeige mit `Strg+C` – der
   Server läuft weiter.

**Prüfen:**

- `docker compose ps` zeigt `gatecontrol` mit `(healthy)`.
- `curl -s https://gate.example.com/health` antwortet `{"ok":true}`.
- `docker exec gatecontrol printenv TZ` zeigt `Europe/Berlin`.

## 2.7 Erster Login

1. Öffne im Browser deine Adresse, z. B. `https://gate.example.com`.
2. Melde dich mit dem Benutzernamen (Standard `admin`) und dem Passwort aus `setup.sh` an.
3. Ändere das Passwort: oben rechts das Benutzermenü → „Profil“ → „Passwort ändern“.

Eine Route für die Weboberfläche selbst musst du nicht anlegen. Das macht
GateControl automatisch.

**Prüfen:** Du siehst das Dashboard. Im Browser steht ein Schloss-Symbol (gültiges Zertifikat).

## 2.8 Domain und HTTPS

Für die Weboberfläche ist HTTPS jetzt fertig. Für jede weitere Domain, die du
als Route einrichtest (z. B. `nas.example.com`), gilt dasselbe:

1. Beim Domain-Anbieter einen A-Record auf die IP des Servers anlegen.
2. In GateControl die Route anlegen („Dienste“ → „Domains / Routen“).

Das Zertifikat holt der Server von selbst.

**Prüfen:** `https://nas.example.com` öffnet sich ohne Zertifikatswarnung.

## 2.9 Updates einrichten

GateControl aktualisiert sich mit `update.sh`. Das Skript muss alle 5 Minuten laufen.

1. Den Zeitplan legt `setup.sh` an, wenn du die Frage
   „Auto-Update-Zeitplan einrichten“ bejaht hast. Prüfe es:

   ```bash
   cat /etc/cron.d/gatecontrol-update
   ```

   Fehlt die Datei, lege sie selbst an:

   ```bash
   echo '*/5 * * * * root /opt/gatecontrol/update.sh' > /etc/cron.d/gatecontrol-update
   ```

   Fehlt der Ordner `/etc/cron.d`, installiere zuerst cron (Debian/Ubuntu: `apt install cron`).

2. Wähle in GateControl „Einstellungen“ → „Updates“ den Modus:
   - **Automatisch:** Neue Versionen kommen von selbst, auf Wunsch nur in einem Wartungsfenster.
   - **Manuell:** Der Server aktualisiert erst, wenn du „Jetzt aktualisieren“ klickst.

Von Hand aktualisieren geht jederzeit:

```bash
cd /opt/gatecontrol
./update.sh
```

Klappt ein Update nicht, stellt `update.sh` die vorige Version automatisch wieder her.

Ob es Updates gibt, zeigt das Dashboard in der Karte „Updates“ direkt unter den
Kacheln. Sie hat vier Felder: Server, Plugins, Gateways und Apps. Ist alles
aktuell, steht dort nur die Zeile „Alles aktuell“. Gibt es Updates, klappt die
Karte auf: Jedes Feld sagt, was neu ist, und führt zur passenden Seite. Im Feld
„Server“ steht auch im Modus „Manuell“ die neue Versionsnummer. Im Feld „Apps“
zählt die Karte die Geräte, deren App älter ist als die neueste Version. Geräte,
die noch keine Version gemeldet haben, zählen nicht als veraltet, sie stehen als
„ohne Angabe“ da. GateControl fragt dafür höchstens einmal pro Stunde bei GitHub
nach. Antwortet GitHub oder der Plugin-Katalog nicht, zeigt das Feld „Konnte
nicht geprüft werden“ und den letzten bekannten Stand. Mit dem Pfeil-Knopf
rechts in der Karte prüfst du sofort noch einmal.

**Prüfen:** Nach spätestens 5 Minuten zeigt „Einstellungen“ → „Updates“ einen
Status (nicht mehr „Auto-Update nicht eingerichtet“). Das Protokoll steht in
`/var/log/gatecontrol-update.log`. Bleibt es bei „nicht eingerichtet“, hilft die
FAQ [„Auto-Update nicht eingerichtet“, obwohl der Zeitplan läuft](07-faq.md#auto-update-nicht-eingerichtet-obwohl-der-zeitplan-läuft).

## 2.10 Backup

Am einfachsten sicherst du den ganzen Ordner (er enthält Geheimnisse, also gut schützen):

```bash
tar czf /root/gatecontrol-$(date +%F).tar.gz -C /opt gatecontrol
chmod 600 /root/gatecontrol-*.tar.gz
```

Mehr dazu (auch Backups in der Oberfläche unter „Einstellungen“ → „Backups“):
[INSTALL.de.md §10](../../INSTALL.de.md#10-backup-und-restore).

**Plugin-Daten im Backup:** Jedes Backup nimmt bis zu 512 MB Plugin-Daten auf
(Datenbanken und Dateien aller Plugins zusammen). Passt ein Teil nicht mehr
hinein, fehlt er – und das steht dann unter „Lokale Backup-Dateien“, beim
Ziel außer Haus und im Dashboard unter „Probleme“, z. B.
„⚠ Nicht vollständig: Mail (Datenbank zu groß für das Backup)“, dazu eine
Mitteilung wie bei einem fehlgeschlagenen Backup. Was drin ist und was
nicht: [FAQ: Was ist im Backup?](07-faq.md#was-ist-im-backup). Plane auf der
Platte Platz für ein Backup mehr ein, als du aufbewahrst: Das älteste wird
erst gelöscht, wenn das neue fertig ist. Reicht der Platz nicht, legt
GateControl kein Backup an und sagt es.

**Backups außer Haus** (Einstellungen → Backups, Lizenz „geplante Backups“)
lädt nach jedem automatischen Backup eine verschlüsselte Kopie per SFTP, SMB,
S3 oder WebDAV hoch. Steht die NAS zu Hause hinter einem Gateway, wähle bei
„Verbindung“ „Über ein VPN-Gerät“ oder „Über eine Weiterleitung“ – genau wie
beim Speicherziel für Drive; „Speicherziel von Drive/Plugins übernehmen“
trägt dessen Einstellungen ein. Siehe
[FAQ: Offsite-Backup auf eine NAS hinter dem VPN](07-faq.md#offsite-backup-auf-eine-nas-hinter-dem-vpn).
Die verschlüsselte Kopie liegt während des Hochladens kurz auf der Platte
des Servers neben den Backups (nie als Ganzes im Arbeitsspeicher, ein kleiner
VPS reicht also) – plane Platz für etwa ein Backup mehr ein. Fehlt er, lädt
GateControl nichts hoch und sagt es beim Ziel.

Die Verbindung ist immer verschlüsselt, ohne dass du eine Zertifikatsdatei
brauchst:

- **WebDAV und S3:** Weist sich die NAS mit einem eigenen Zertifikat aus (bei
  NAS-Geräten im Heimnetz üblich), zeigt „Testen“ das Gerät und bis wann das
  Zertifikat gilt, dazu den Knopf **„Diesem Gerät vertrauen“**. Läuft die
  Verbindung über ein VPN-Gerät oder eine Weiterleitung, merkt sich
  GateControl das Zertifikat schon beim ersten Kontakt („Zertifikat der NAS
  gemerkt“). Bei „Direkt zur Adresse“ entscheidest immer du per Klick.
- **Neues Zertifikat:** Erneuert die NAS ihr Zertifikat, stoppt GateControl
  und fragt: „Das Zertifikat der NAS hat sich geändert (z. B. nach einer
  Erneuerung). Ist das in Ordnung?“ – mit dem Knopf **„Neues Zertifikat
  vertrauen“**. Ein geändertes Zertifikat wird nie still übernommen.
- **SMB:** „Verbindung verschlüsseln (SMB3)“ ist bei neuen Zielen an. Kann
  die Freigabe das nicht, sagt „Testen“, wo du es an der NAS einschaltest
  (Synology: Systemsteuerung › Dateidienste › SMB › Erweitert →
  SMB3-Verschlüsselung).

Das Feld für eine PEM-Datei gibt es weiter, eingeklappt unter „Erweitert“ –
nur für Fachleute mit eigener CA.

**Prüfen:** `tar tzf /root/gatecontrol-*.tar.gz | grep -c data/` zeigt eine Zahl größer als 0.

Weiter mit [Kapitel 3: Gateway einrichten](03-gateway-einrichten.md).

## 2.11 Namen im VPN

Jedes VPN-Gerät kann einen Namen bekommen. Dann erreichst du zum Beispiel
deinen Rechner im Büro unter `laptop-buero.gc.internal` statt unter einer
Adresse wie `10.8.0.14`. Die Namen gelten nur im VPN.

Wenn du eine eigene Domain unter „Dienste“ → „Domains / Routen“ eingetragen
hast, können die Namen an ihr hängen:

1. Öffne „Einstellungen“ → „VPN & Netzwerk“ → „Namen im VPN“.
2. Wähle bei „Domain“ deine Domain.
3. Lass bei „Unterbereich“ den Vorschlag `vpn` stehen oder trag einen anderen
   ein. Darunter siehst du sofort, wie ein Gerät heißen wird, zum Beispiel
   `laptop-buero.vpn.example.com`.
4. Klick unten auf „Speichern“.

Der bisherige Name mit `gc.internal` funktioniert weiter. Bei deinem
Domain-Anbieter musst du nichts eintragen, und von außen kann niemand diese
Namen auflösen. Meldet die Seite, dass der Unterbereich schon ein Host oder
eine Route ist, nimm den vorgeschlagenen freien Unterbereich.

Den Namen eines Geräts siehst und änderst du unter „Geräte“ → „Peers /
Clients“: Er steht auf der Karte des Geräts, mit einem Knopf zum Kopieren.
Ein Gerät ohne Namen bietet „Namen vergeben“ an. Bei einem Gateway steht der
Name in der Kopfzeile; ändern kannst du ihn dort unter „Mehr“ → „Name und Gruppe ändern …“.

**Namen von Gateways:** Auch ein Gateway hat einen Namen, und er löst auf
jedem VPN-Gerät auf. Erreichen kann ihn aber nur der Server: Der Tunnel eines
Gateways lässt mit Absicht kein anderes VPN-Gerät hinein. Darauf weist die
Oberfläche unter dem Namen hin; im Dialog „Name und Gruppe ändern …“ heißt
es deshalb „Name des Gateways im VPN: …“ statt „Erreichbar als …“. `nas.vpn.example.com:5000` antwortet also
nicht, auch wenn das Gateway auf dem NAS läuft. Für Dienste im Heimnetz hinter
dem Gateway – die Oberfläche des NAS, einen Drucker, eine Kamera – legst du
unter „Dienste“ → „Domains / Routen“ eine Route an: Als Ziel wählst du das
Gateway oder seinen Pool und trägst die Adresse des Geräts im Heimnetz und den
Port ein (zum Beispiel `192.168.1.20` und `5000`). Der Host der Route darf
nicht unter dem Bereich der Gerätenamen liegen: `nas.example.com` geht,
`nas.vpn.example.com` nicht. Ausnahme: Mit gültigem „Zertifikat für die
Namen“ gehen interne Routen mit eigenem Namen unter der Zone, etwa
`nas-web.vpn.example.com` (siehe [2.12](#212-gültiges-zertifikat-für-die-namen-im-vpn)).

Namen unter der eigenen Domain gibt es ab Server **1.271.0**. Die Windows-Apps
lösen sie ab GateControl Pro **1.85.0** und Community **1.49.0** auf – sie
legen dafür je Zone eine DNS-Regel an. Ältere Apps lösen nur die Schreibweise
mit `gc.internal` zuverlässig auf; nimm dort bis zum Update diesen Namen. Die
Android-App braucht kein Update.

**Prüfen:** Unter „Einstellungen“ → „VPN & Netzwerk“ → „Zustand der Namen“
steht bei „Dienst“ das Wort „läuft“. Auf einem Gerät im VPN antwortet
`ping laptop-buero.vpn.example.com` (mit dem Namen eines deiner Geräte).

## 2.12 Gültiges Zertifikat für die Namen im VPN

Die Namen unter deiner VPN-Zone können ein Zertifikat bekommen, dem jeder
Browser vertraut – ohne Warnung und ohne dass du auf jedem Gerät etwas
bestätigst. Die Namen bleiben dabei im VPN: Bei deinem Domain-Anbieter
erscheint nur für einen Moment ein Prüfeintrag, sonst nichts. In den
öffentlichen Zertifikats-Listen steht nur `*.vpn.example.com`, kein Geräte-
oder Dienstname.

**Voraussetzung:** Unter „Namen im VPN“ ist eine eigene Domain gewählt (siehe
[2.11](#211-namen-im-vpn)), und dein Domain-Anbieter bietet eine
DNS-Schnittstelle an. Wenn nicht, nimm den Weg „Weiterleitung über deSEC“
weiter unten. Die Funktion gehört zum Lizenz-Merkmal „Internes DNS“.

1. Öffne „Einstellungen“ → „VPN & Netzwerk“ → „Zertifikat für die Namen“ und
   klick auf „Einrichten“.
2. Wähle bei „DNS-Anbieter“ deinen Anbieter. Steht dort schon ein Vorschlag
   („Erkannt über die Nameserver …“), passt er meistens.
3. Leg beim Anbieter einen Zugang für die Schnittstelle an (Tabelle unten) und
   trag ihn ein. Gib dem Zugang so wenig Rechte wie möglich.
4. Klick auf „Testen“. Alle fünf Punkte sollten einen Haken bekommen. Der Test
   schreibt einen Prüfeintrag mit einem eindeutigen Testwert unter
   `_acme-challenge.vpn.example.com` (bei einer Weiterleitung unter deren
   Ziel), wartet, bis ihn die zuständigen DNS-Server ausliefern, und löscht ihn
   wieder. Let's Encrypt wird dabei nicht gefragt. Unter „Öffentlich sichtbar“
   schlägt er eine Wartezeit vor; „Übernehmen“ trägt sie unter „Erweitert“ ein.
5. Klick unten auf „Speichern“. Nach ein bis drei Minuten steht in der Karte
   „gültig“.

Sobald das Zertifikat gültig ist, stellt der Server von selbst um:

- **Portal:** Es läuft dann unter `home.vpn.example.com` mit dem gültigen
  Zertifikat. Diese Adresse bekommen die Apps, die die Zone auflösen: die
  Android-App, GateControl Pro ab **1.85.0** und Community ab **1.49.0**.
  Ältere Windows-Apps, Einladungs- und Kiosk-Links und der Link im Menü
  nutzen weiter `home.gc.internal` – diese Adresse funktioniert dauerhaft.
  Mit dem Schalter „Links auf die neue Adresse“ (siehe unten) zeigen auch
  die Links auf `home.vpn.example.com`.
  Ist unter „Portal“ eine öffentliche Portal-Domain eingetragen, bleibt das
  Portal dort.
- **Verwaltung:** Im VPN erreichst du die Verwaltung zusätzlich unter
  `https://server.vpn.example.com` und `https://gc-server.vpn.example.com`.
  Die Hauptadresse (`GC_BASE_URL`) bleibt. Unter den neuen Namen meldest du
  dich eigens an (die Anmeldung gilt je Adresse); Passkeys und die Anmeldung
  über einen Verzeichnisdienst (OIDC) gibt es nur unter der Hauptadresse.
  Außerhalb des VPN antworten die Namen nicht.

Hält der Server das Zertifikat an oder läuft es ab, gehen Portal und
Verwaltung zurück auf ihre bisherigen Adressen.

Das Zertifikat erneuert sich 30 Tage vor Ablauf von selbst. Klappt das
mehrmals nicht, hält der Server weitere Versuche an, damit Let's Encrypt die
Domain nicht sperrt, und die Karte sagt, was der Anbieter gemeldet hat. Läuft
das Zertifikat in weniger als 14 Tagen ab, erscheint es auf dem Dashboard
unter den Problemen und unter „Domains & Zertifikate“.

**Weiterleitung über deSEC (sicherster Weg):** Leg bei deSEC kostenlos eine
Zone an, zum Beispiel `vpn-example.dedyn.io`, und dort ein Token, das nur
TXT-Einträge unter `_acme-challenge` ändern darf. Trag bei deinem
Domain-Anbieter einmal von Hand ein:

```
_acme-challenge.vpn.example.com.  CNAME  _acme-challenge.vpn-example.dedyn.io.
```

In GateControl wählst du „Weiterleitung über deSEC“, trägst das Ziel und das
Token ein und klickst auf „Testen“. Der Zugang zu deiner eigentlichen Domain
bleibt so ganz aus GateControl heraus. Mit einem anderen Anbieter für die
Zielzone geht das genauso: Schalte unter „Erweitert“ „Weiterleitung nutzen
(CNAME)“ ein.

### Wo du den Zugang bekommst und welche Rechte reichen

| Anbieter | Was du einträgst | Wo | Rechte begrenzen |
|---|---|---|---|
| Hetzner | API-Token | Hetzner Console › Projekt › Sicherheit › API-Tokens („Lesen & Schreiben“) | ganzes Projekt – Zone in ein eigenes Projekt legen; Zonen aus der alten DNS-Konsole erst umziehen |
| IONOS | API-Schlüssel (`Präfix.Geheimnis`) | IONOS Developer-Portal › API-Schlüssel | alle Zonen – besser Weiterleitung |
| netcup | Kundennummer, API-Key, API-Passwort | Kundencontrolpanel › Stammdaten › API | alle Domains – besser Weiterleitung |
| INWX | Benutzername, Passwort, ggf. 2FA-Geheimnis | INWX-Konto; wenn möglich eigener Benutzer nur für DNS | Konto/Benutzer – besser Weiterleitung |
| All-Inkl.com | KAS-Login, KAS-Passwort | KAS | ganzes Konto – dringend Weiterleitung |
| OVHcloud | Endpunkt, Application Key/Secret, Consumer Key | OVH-API: Token mit Regeln nur für `/domain/zone/example.com/*` | eine Zone |
| Cloudflare | API-Token | Profil › API-Tokens › „Zone · DNS · Bearbeiten“, nur diese Zone | eine Zone |
| deSEC | Token | deSEC › Token mit Richtlinie: Domain, Unterbereich `_acme-challenge.vpn`, Typ TXT | nur TXT |
| RFC 2136 | Server, Schlüsselname, Algorithmus, Schlüssel | eigener DNS-Server (BIND: `update-policy { grant … name _acme-challenge.vpn.example.com TXT; };`) | nur TXT |
| acme-dns | Server-URL, Benutzer, Passwort, Unterbereich, Ziel des CNAME | eigener acme-dns-Dienst + einmal CNAME beim Anbieter | nur TXT |

Strato und andere Anbieter ohne DNS-Schnittstelle: nimm die Weiterleitung über
deSEC.

Die Zugangsdaten liegen verschlüsselt in der Datenbank und in Sicherungen. Die
Oberfläche zeigt sie nie wieder an, nur „gespeichert am …“; beim „Ändern“
bleibt ein leeres Feld beim gespeicherten Wert. „Ausschalten“ löscht sie.
Stellst du unter „Namen im VPN“ eine andere Zone ein, fragt die Karte nach
einer neuen Einrichtung.

**Was das Zertifikat nicht abdeckt:** Dienste, die direkt auf einem Gerät
laufen, zum Beispiel die Oberfläche eines NAS unter
`nas.vpn.example.com:5001`: Ihr TLS endet auf dem Gerät. Und ein Zertifikat
deckt eine Ebene ab: `nas-web.vpn.example.com` ja, `a.b.vpn.example.com`
nicht. Welche Namen der Server damit beantwortet, steht in der Karte unter
„Genutzt von“.

**Interne Routen unter der Zone:** Für einen Dienst auf einem Gerät oder hinter
einem Gateway legst du unter „Dienste“ → „Domains / Routen“ einen Host mit
eigenem Namen unter der Zone an, zum Beispiel `nas-web` unter `example.com`
(also `nas-web.vpn.example.com`), Ziel das NAS. Das geht, solange das
Zertifikat gültig ist, und nur eine Ebene tief. Solche Routen sind **immer nur
im VPN** erreichbar – der Dialog zeigt das an, und der Schalter „Von extern
erreichbar“ bleibt aus. Ein Name, den schon ein VPN-Gerät hat, und die festen
Namen des Servers (`home`, `server`, `gateway` …) gehen nicht. Die Route
bekommt das Wildcard-Zertifikat; endet es, bekommt sie ein internes Zertifikat
des Servers.

**Prüfen:** In der Karte „Zertifikat für die Namen“ steht „gültig“ mit dem
Ablaufdatum, unter „Genutzt von“ stehen `home.vpn.example.com` (Portal) und
`server.vpn.example.com` (Verwaltung), und unter „Domains & Zertifikate“
erscheint `*.vpn.example.com` mit Let's Encrypt als Aussteller. Auf einem
Gerät im VPN öffnet `https://home.vpn.example.com` das Portal ohne Warnung.

### Links auf die neue Adresse

Einladungs-Links (Gruppen), Kiosk-Kopplung, der Portal-Link im Menü und der
Rücksprung ins Portal nach dem Verbinden eines Cloud-Kontos zeigen
standardmäßig auf `home.gc.internal`, weil jedes Gerät im VPN diesen Namen
auflöst. Schaltest du in der Karte „Zertifikat für die Namen“ **„Links auf
die neue Adresse“** ein (Standard aus, nur Admins), zeigen sie auf
`home.vpn.example.com` – mit gültigem Zertifikat, ohne Warnung im Browser.

- Ältere Windows-Apps (Pro unter **1.85.0**, Community unter **1.49.0**) und
  Geräte ohne die Namen im VPN öffnen solche Links nicht. Schalte ihn erst
  ein, wenn alle Geräte so weit sind.
- Hält der Server das Zertifikat an oder läuft es ab, zeigen die Links von
  selbst wieder auf `home.gc.internal`. Schaltest du das Zertifikat aus,
  geht auch der Schalter aus.
- Bei Google und Microsoft änderst du nichts: Dort ist nur die
  Rückruf-Adresse `<GC_BASE_URL>/oauth/cloud/callback` hinterlegt, und die
  bleibt. Erst danach leitet der Server ins Portal weiter.
- Die Anmeldung am Portal gilt je Adresse: Wer das Portal bisher unter
  `home.gc.internal` offen hatte, meldet sich unter der neuen Adresse einmal
  neu an.
- Ist unter „Portal“ eine öffentliche Portal-Domain eingetragen, zeigen die
  Links auf sie; der Schalter wirkt dann nicht.
- Der Schalter ist Teil der Sicherung und kommt bei einer Wiederherstellung
  zurück.

### Zertifikat an Geräte weitergeben

Läuft ein Dienst direkt auf einem Gerät oder Gateway und soll selbst mit einem
gültigen Zertifikat antworten (statt über eine Route des Servers), kann der
Server ein Zertifikat **und seinen privaten Schlüssel** an ausgewählte Geräte
geben. Das ist **standardmäßig aus** und nur für Admins einstellbar.

**Weitergegeben wird nie `*.vpn.example.com`.** Das Zertifikat von Portal,
Verwaltung und Routen bleibt auf dem Server. Für die Geräte holt der Server ein
zweites Zertifikat für einen eigenen **Geräte-Bereich**, Standardname
`geraete`: `*.geraete.vpn.example.com`. Ein Gerät antwortet damit unter seinem
Namen in diesem Bereich – das NAS `nas` zum Beispiel unter
`https://nas.geraete.vpn.example.com`. Der Server beantwortet diese Namen im
VPN mit der Tunnel-Adresse des Geräts. `mqtt`, `www` und `ca` bleiben im
Bereich frei.

> **Risiko:** Der Schlüssel gilt für jeden Namen unter
> `geraete.vpn.example.com`. Wer ihn hat, kann sich im VPN als jedes Gerät in
> diesem Bereich ausgeben. Portal, Verwaltung und Routen sind nicht betroffen.
> Gib ihn nur an Geräte, denen du voll vertraust. Einmal abgeholt, lässt er
> sich nicht zurückholen – nur durch einen neuen Schlüssel ersetzen.

1. In der Karte „Zertifikat für die Namen“ (Zertifikat gültig) schaltest du
   „Zertifikat und Schlüssel an Geräte weitergeben“ ein.
2. Unter „Geräte-Bereich“ lässt du `geraete` stehen oder wählst einen anderen
   Namen (ein Wort aus Kleinbuchstaben, Ziffern und Bindestrich; kein
   Gerätename, kein fester Name wie `home` oder `server`, keine Route). Ändern
   lässt er sich nur, solange die Weitergabe aus ist.
3. Unter „Darf abholen“ hakst du die Geräte und Gateways an, die es bekommen
   sollen.
4. Beim Speichern bestätigst du den Risikohinweis. Der Server holt das
   Zertifikat des Geräte-Bereichs mit demselben DNS-Anbieter (meist 1–3
   Minuten); die Zeile „Geräte-Zertifikat“ zeigt, wann es da ist.

**Mit Weiterleitung (CNAME):** Der Geräte-Bereich hat eine eigene
Challenge. Trag bei deinem Domain-Anbieter einmal zusätzlich ein – auf
**dasselbe Ziel** wie den ersten Eintrag:

```
_acme-challenge.geraete.vpn.example.com.  CNAME  _acme-challenge.vpn-example.dedyn.io.
```

Die Karte zeigt den genauen Eintrag. „Testen“ prüft ihn mit, solange die
Weitergabe an ist (Schritt „Geräte-Bereich“). Ohne Weiterleitung ist nichts
weiter einzutragen.

Abholen darf nur ein angehaktes Gerät, angemeldet (Gateway mit seinem Token,
App mit einem an das Gerät gebundenen Token) und nur über seine eigene
VPN-Adresse. Jeder Abruf steht im Protokoll mit Gerät und Fingerabdruck – nie
mit dem Schlüssel. Der Fingerabdruck (SHA-256 des Zertifikats) steht in der
Karte; erneuert sich das Zertifikat, ändert er sich, und die Geräte holen das
neue.

**Hat das Gateway es abgeholt?** Bei jedem angehakten Gateway steht unter
„Darf abholen“ ein Kürzel, und auf der Gateway-Seite (Übersicht, Karte „Gerät &
Software“) die Zeile „Zertifikat für die Namen“:

| Anzeige | Bedeutung |
|---|---|
| **abgeholt** | Das Gateway hat das Zertifikat, das der Server gerade ausgibt (Fingerabdruck gekürzt, gültig bis …). |
| **veraltet** | Das Gateway hat noch ein älteres (anderer Fingerabdruck). Meist holt es das neue binnen Minuten. |
| **noch nicht abgeholt** | Angehakt, aber das Gateway meldet noch keins – z. B. direkt nach dem Einschalten oder solange es offline ist. |
| **Gateway zu alt** | Das Gateway kann es noch nicht abholen: ab Gateway 1.43.0 (ältere Gateways kennen den Geräte-Bereich nicht). |

Die Angabe kommt aus dem Lebenszeichen des Gateways (etwa jede Minute). Bleibt
ein Gateway **länger als 24 Stunden** auf „veraltet“, erscheint es im
Dashboard unter „Probleme“ – eine kurze Verzögerung nach der Erneuerung ist
kein Problem. Dann prüfen, ob das Gateway online ist und den Server über den
Tunnel erreicht. Bei ausgeschalteter Weitergabe und bei nicht angehakten
Gateways wird nichts angezeigt.

**Neuer Schlüssel:** Wurde der Schlüssel einmal abgeholt und soll ein Gerät
ihn nicht mehr haben, nimmst du das Gerät heraus (oder schaltest die
Weitergabe aus) und klickst auf „Neuen Schlüssel holen“. Der Server löscht das
Zertifikat des Geräte-Bereichs und holt ein neues mit neuem Schlüssel; die
noch erlaubten Geräte holen es von selbst. Portal, Verwaltung und Routen sind
davon nicht betroffen. Schaltest du das Zertifikat ganz aus, endet auch die
Weitergabe.

**Nach dem Update auf den Geräte-Bereich:** Hatte ein Gerät früher das
Zertifikat der Zone abgeholt, erneuert der Server einmal von selbst dessen
Schlüssel – alte Kopien passen dann zu nichts mehr, was der Server ausliefert.
Das steht im Protokoll und als Hinweis in der Karte. Für 1–3 Minuten gehen
Portal und Verwaltung dabei auf ihre bisherigen Adressen.
