# Namen im VPN

Jedes VPN-Gerät kann einen Namen haben. Unter diesem Namen erreichen sich die
Geräte gegenseitig, statt nur unter einer Adresse wie `10.8.0.14`. Die Funktion
hieß früher „Interner DNS“ und hatte eine eigene Seite. Die Seite und ihr
Menüpunkt gibt es nicht mehr: Der Name steht beim Gerät, die Einstellung und
die Diagnose stehen unter „Einstellungen“ → „VPN & Netzwerk“. Die alte Adresse
`/dns` leitet dorthin weiter.

Alle Domains und Gerätenamen in diesem Dokument sind Beispiele.

## Zwei Zonen

| Zone | Beispiel | Woher |
|---|---|---|
| primär | `vpn.example.com` | Einstellung „Namen im VPN“: eine Domain aus „Domains / Routen“ und ein Unterbereich (Vorschlag `vpn`) |
| alt | `gc.internal` | `GC_DNS_DOMAIN` (Standard `gc.internal`) |

Ohne eigene Wahl gibt es nur die alte Zone, alles ist wie zuvor. Mit eigener
Wahl ist ein Gerät unter beiden Schreibweisen erreichbar:
`laptop-buero.vpn.example.com` und `laptop-buero.gc.internal`. Die alte Zone
bleibt dauerhaft: Das Portal (`home.gc.internal`), interne Routen und der
Gateway-Assistent hängen daran, und gespeicherte Adressen brechen nie. Wer
`GC_DNS_DOMAIN` gesetzt hat, behält diesen Wert als alte Zone und als Standard.

Warum ein Unterbereich und nicht die Domain selbst:

- Gerätenamen kommen teils von den Geräten. Ein Gerät, das sich „mail“ nennt,
  würde sonst im VPN `mail.example.com` überdecken.
- Der Server beantwortet die Zone allein. Ein Name, den es dort nicht gibt,
  bekommt sofort „gibt es nicht“; nichts wird ins Internet weitergefragt. Unter
  der Domain selbst wären damit alle Adressen unerreichbar, die GateControl
  nicht kennt.

Die Namen gelten nur im VPN. Beim Anbieter der Domain wird nichts eingetragen,
von außen sind sie nicht auflösbar, und es wird kein Zertifikat dafür
angefordert. Nur A-Einträge (kein AAAA).

## Einstellung (Einstellungen → VPN & Netzwerk → „Namen im VPN“)

Gespeichert in `settings`: `dns.names.base_domain` (leer = alte Zone) und
`dns.names.sub`. Vier Zustände der Karte:

| Zustand | Was man sieht |
|---|---|
| eigene Domain | Domain, Unterbereich, Vorschau mit Kopieren-Knopf, Hinweis auf die alte Schreibweise, Marke „aktiv“ |
| Standard | „gc.internal (Standard)“, Unterbereich „nicht nötig“ |
| Kollision | Meldung am Unterbereich mit einem freien Vorschlag; Speichern erst mit einem freien Unterbereich |
| Domain entfernt | Hinweis, dass die Domain nicht mehr eingetragen ist und die Namen weiter funktionieren; „Zurück zu gc.internal“ |

Gespeichert wird über die Speicherleiste der Einstellungen. Die Umstellung wirkt
sofort und ohne Neustart des Containers: Nur der DNS-Dienst startet neu
(wie beim Ein- und Ausschalten des DNS-Schutzes).

Wird die gewählte Domain unter „Einstellungen“ → „Domains & Zertifikate“
entfernt, weist der Dialog „Domain entfernen“ darauf hin. Die Namen laufen
weiter, weil sie nur im VPN gelten.

### Prüfungen des Unterbereichs (`vpnNames.check`)

Der Unterbereich ist ein einzelnes Label (Kleinbuchstaben, Ziffern,
Bindestriche). Er wird abgelehnt, wenn unter `<sub>.<domain>` schon etwas liegt:

| Code | Was kollidiert |
|---|---|
| `collision_host` | ein Host der Zone, dessen Subdomain gleich dem Unterbereich ist oder auf `.<sub>` endet |
| `collision_route` | die Domain einer Route |
| `collision_management` | die Adresse von GateControl (`GC_BASE_URL`) |
| `collision_portal` | die Adresse des Portals |
| `collision_domain` | eine andere unter „Domains / Routen“ eingetragene Domain |

Umgekehrt lassen sich unter `<sub>.<domain>` keine Routen und Hosts anlegen
(`routeDomainPolicy`: `device_zone`; in der Host-API Code `DEVICE_ZONE`). Eine
Route, deren Adresse in der alten Zone dem Namen eines Geräts gleicht, wird
ebenfalls abgelehnt (`device_name` / `DEVICE_NAME`).

## Gerätenamen

Regeln: ein Label, Kleinbuchstaben, Ziffern und Bindestriche, höchstens
63 Zeichen. Reserviert sind unter anderem `gateway`, `server`, `gc-server`,
`home` (Portal), `localhost`, `admin`, `dns`, `vpn`, `mail`.

Herkunft (`peers.hostname_source`):

| Wert | Anzeige | Bedeutung |
|---|---|---|
| `admin` | „von dir festgelegt“ | bleibt, bis du ihn änderst; das Gerät überschreibt ihn nicht |
| `agent` | „vom Gerät gemeldet“ | die App oder das Gateway hat den Namen gemeldet |
| `stale` | „vom Gerät gemeldet“ + „veraltet“ | aus einer zurückgespielten Sicherung, seitdem nicht bestätigt |

Vergeben ist ein Name, wenn ein anderes Gerät ihn hat oder wenn unter
`<name>.<zone>` in einer der beiden Zonen schon eine Route oder das Portal
antwortet.

- **Vom Admin vergeben:** Ein vergebener Name wird mit einer Meldung und einem
  freien Vorschlag abgelehnt (`PATCH /api/v1/peers/:id/hostname` → 409,
  `code: taken | route`, `suggestion`). Nie mehr ein stilles `-2`.
- **Vom Gerät gemeldet:** Wie bisher hängt der Server `-2`, `-3` … an.

Wo der Name steht: auf der Gerätekarte und in der Listenzeile unter „Peers /
Clients“ (voller Name mit Kopieren-Knopf, Herkunft; ein Gerät ohne Namen
bietet „Namen vergeben“ an), in den Dialogen „Peer hinzufügen“ und
„Bearbeiten“ (Feld „Name im VPN“ mit fester Endung), bei Gateways auf der
Karte, in der Kopfzeile und unter „Mehr“ → „Name und Gruppe ändern …“.

Lizenz: Gerätenamen und die eigene Domain gehören zum Merkmal `internal_dns`.
Ohne das Merkmal ist die Karte sichtbar gesperrt; die festen Namen des Servers
und die Adressen der Routen lösen weiter auf.

## Diagnose (Einstellungen → VPN & Netzwerk → „Zustand der Namen“)

`GET /api/v1/settings/vpn-names/status`:

- **Dienst:** Der Server fragt den DNS-Dienst nach `gateway.<primäre Zone>`.
  „läuft“ = die Antwort ist die Gateway-Adresse; „läuft mit altem Stand“ = der
  Dienst antwortet, kennt die Zone aber nicht (er läuft noch mit einer älteren
  Konfiguration); „antwortet nicht“; „ausgeschaltet“ (`GC_DNS_ENABLED=false`).
- **Zuletzt neu geschrieben:** Änderungszeit der Hosts-Datei.
- **Einträge:** Geräte mit Namen, Routen, Portal.
- **Veraltet:** Namen aus einer Sicherung; „Ansehen“ öffnet
  `/peers#hints=oldname`.
- **Feste Namen des Servers:** `gateway`, `server`, `gc-server` in jeder Zone.

## Technik

- `src/services/vpnNames.js` – Zonen, Prüfungen, Speichern, Block in
  `dnsmasq.conf`.
- `src/services/dns.js` – Hosts-Datei. Eine Zeile je Gerät:
  `<ip> <name>.<primär> <name>.<alt> <name>`; Routen und Portal wie zuvor.
- `entrypoint.sh` schreibt `dnsmasq.conf` bei jedem Start des Containers mit
  der alten Zone. Danach ergänzt der Server-Prozess die gewählte Zone in einem
  eigenen Block (`local=/<zone>/` und `host-record=` für die festen Namen) und
  startet dnsmasq neu – nur, wenn die Datei das nicht schon enthält. Ein
  `SIGHUP` reicht dafür nicht: dnsmasq liest `local=` und `host-record=` nur
  beim Start. Neue Gerätenamen brauchen keinen Neustart (Hosts-Datei + `SIGHUP`).
- Der Block trägt eine eigene Markierung
  (`# --- gatecontrol vpn names: begin ---`). Die DNS-Kette
  (`dnsChainConf.js`) verwaltet weiter allein die `server=`-Zeilen und lässt
  den Block stehen; beide schreiben im selben Prozess.
- Nach dem Zurückspielen einer Sicherung wird die Zone der Sicherung angewendet.

## Apps und Gateway

`GET /api/v1/client/config` und `/config/check`:

```json
"internalDns": { "domain": "gc.internal", "server": "10.8.0.1", "domains": ["vpn.example.com", "gc.internal"], "primary": "vpn.example.com" }
```

`domain` bleibt die alte Zone: Windows-Apps, die nur dieses Feld kennen, legen
daraus genau eine Namensregel an. `domains` (alle Zonen, primäre zuerst) und
`primary` sind neu. `config/check` nennt `internalDns` jetzt auch, wenn sich
die Konfiguration nicht geändert hat. Remote Desktop: `peer_fqdn` bleibt in der
alten Zone, `peer_fqdn_primary` nennt denselben Rechner in der primären Zone.
Die Antwort auf `POST /api/v1/client/peer/hostname` nennt zusätzlich `fqdn` und
`fqdns`.

Noch offen (spätere Stufen): Die Windows-Apps brauchen ein Update, das je Zone
eine Regel anlegt; bis dahin lösen sie die neue Schreibweise nicht verlässlich
auf, die alte funktioniert unverändert. Gateways mit DNS-Filter fürs Heimnetz
kennen die neue Zone noch nicht.
