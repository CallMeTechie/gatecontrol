# Route External-Exposure

_Implementiert: 2026-06-16 · Branch `feature/route-external-exposure`_

## Problem

Routen waren bisher immer aus dem offenen Internet erreichbar, sobald die öffentliche
Subdomain auf den Hub zeigt — auch wenn ausschließlich VPN-interner Zugriff gewünscht war.
Es gab keinen Schalter, um eine Route auf „nur intern" zu beschränken, ohne die DNS-Delegation
zu ändern oder den Caddy-Config manuell anzufassen.

## Lösung

Die Lösung besteht aus zwei orthogonalen Teilen, die unabhängig voneinander wirken.

### Teil 1 — Innen-immer (DNS)

`src/services/dns.js` `renderHostsContent()` schreibt für **jede aktivierte Route mit
Domain** einen exakten A-Record

```
<domain> → 10.8.0.1   (WireGuard-Gateway, config.wireguard.gatewayIp)
```

in die dnsmasq addn-hosts-Datei (`/data/dns/peers.hosts`). Dies gilt für **alle** Routen
(HTTP und L4), unabhängig vom Außen-Schalter. Exakte Namen, kein Wildcard-Eintrag — dadurch
bleiben Peer-FQDNs wie `server.marcbackes.net` unangetastet.

Route-Mutationen (create / update / remove / toggle / batch + service-bundle create) lösen
`dns.rebuildNow()` aus — best-effort, ein Rebuild pro Bulk.

### Teil 2 — Außen-Schalter (Caddy)

- **Migration 51**: neue Spalte `routes.external_enabled` (INTEGER, NOT NULL DEFAULT 0).
- Bei `external_enabled=0` setzt `src/services/caddyConfig.js` einen `remote_ip`-Matcher auf
  das VPN-Subnetz (`INTERNAL_ONLY_RANGES` = `config.wireguard.subnet` = `10.8.0.0/24`).
  Externe Quell-IPs werden abgewiesen, VPN-Peers werden weiter bedient.
- **Fail-closed**: das Gate hängt am effektiven Matcher (`!routeConfig.match`), nicht am
  `acl_enabled`-Flag.
- Nutzt `remote_ip` (Verbindungs-IP), **niemals** `client_ip` (X-Forwarded-For ist
  spoofbar — siehe Phase-0-Ergebnis unten).
- Gilt nur für **HTTP-Routen** (L4 ist strukturell anders — Folgephase).

**Latenter Bug mitgefixt:** Der Caddy-Grouping-Schritt verwarf für einfache
(nicht-Forward-Auth) Single-Domain-Routen den inneren `remote_ip`-Matcher — das hätte
sowohl das neue Gate als auch vorhandene Peer-ACLs stillschweigend entfernt. Gefixt: Host-
und `remote_ip`-Matcher werden in ein einziges Match-Objekt gefaltet (= Caddy-AND-Semantik).

## Default-Verhalten

| Situation | `external_enabled` | Ergebnis |
|---|---|---|
| Neue Route | 0 | nur intern — kein externer Zugriff bis manuell aktiviert |
| Bestandsrouten (Migration 51 Backfill) | 1 | bleiben extern erreichbar — **kein Deploy-Ausfall** |

Der Backfill ist bewusst so gewählt: das Feature ändert beim ersten Deploy **nichts** am
bestehenden Verhalten. Erst wenn der Betreiber einzelne Routen aktiv umstellt, greift der
Schutz (→ Rollout-Review).

## Bedienung

- **Create-Wizard**: Toggle „Von extern erreichbar" (Default = aus).
- **Edit-Wizard**: derselbe Toggle, jederzeit umschaltbar.
- **Routen-Liste**: Badge „Nur intern" für HTTP-Routen mit `external_enabled=0`.

## Phase-0 Verifikationsergebnisse (2026-06-16, Live-Instanz)

Alle drei Gates wurden gegen die laufende Instanz empirisch geprüft:

### ACME-Koexistenz — Critical-Gate: BESTANDEN

Eine Test-Route mit `remote_ip`-Restriktion auf `10.8.0.0/24` erhielt dennoch ein gültiges
Let's-Encrypt-Zertifikat. Caddy (v2.11.4, Default-ACME, TLS-Config leer) bedient die
ACME-HTTP-01-Challenge out-of-band an die externen LE-Validatoren, **vor/unabhängig** vom
User-Route-`remote_ip`-Matcher.

**Kein DNS-01 nötig.** Neue intern-only Routen erhalten ihr Public-Zertifikat automatisch.

### Reale VPN-Quell-IP — High-Gate: BESTANDEN

Ein VPN-Peer (10.8.0.2) kommt bei Caddy mit `remote_ip=10.8.0.2` (∈ 10.8.0.0/24) an — kein
MASQUERADE auf die Hub-Public-IP. Das Subnetz-Gate ist korrekt. Die
`GC_HUB_PUBLIC_IP`-Kontingenz ist aktuell **nicht nötig**.

### XFF-Spoof — High-Gate: BESTANDEN

Ein externer Request mit gefälschtem `X-Forwarded-For: 10.8.0.5` ließ `remote_ip`/`client_ip`
unverändert auf der echten Public-IP — der Request wurde weiterhin abgewiesen. Das Gate ist
**nicht über Header umgehbar**.

## Dokumentierte Eigenschaften & Annahmen

**Monitoring umgeht das Gate nicht:** `monitor.js` probt das Backend-`targetIp` direkt, nicht
die Caddy-Front. Keine Loopback-Ausnahme nötig.

**Annahme: kein Reverse-Proxy/CDN vor Caddy.** Caddy terminiert direkt (Route-A-Records
zeigen auf die Hub-Public-IP 54.36.233.20). Käme je ein CDN oder Proxy davor, würde
`remote_ip` zur Proxy-IP — das Gate bräche. Vor einer solchen Topologie-Änderung ist eine
Neubewertung erforderlich.

**`GC_HUB_PUBLIC_IP`-Kontingenz:** aktuell nicht gesetzt und nicht nötig (Quell-IP ist
10.8.0.x). Nur falls ein Full-Tunnel-Client Caddy über die Hub-Public-IP (MASQUERADE) statt
10.8.0.x erreicht, diese IP als `/32` über die Env-Variable ergänzen. Sicher, weil nur
Hub-genatteter (= VPN-)Verkehr diese Quelle trägt.

**Geblockte Externe erhalten ein leeres Fall-Through-200** (kein 403), kein Backend-Inhalt.
Das Schutzziel ist erfüllt: der Upstream ist für externe Anfragen nicht erreichbar.

**Auth-vor-IP-Deny (bekannte, harmlose Eigenschaft):** Bei einer intern-only Route mit
Route-Auth oder Forward-Auth sitzt der `remote_ip`-Matcher am inneren Content-Route innerhalb
der Subroute. Der `/route-auth/*`-Proxy bzw. die Auth-Seite kann für externe Scanner sichtbar
sein, bevor der Content per `remote_ip` abgewiesen wird. Der geschützte Backend-Inhalt wird
**nicht** ausgeliefert — lediglich Existenz-Preisgabe, dass die Domain reagiert (was DNS
ohnehin verrät).

**Fehlerzustände** (Access-Window-403, Circuit-Breaker-503, Pool-Outage-Seite) werden allen
Clients einschließlich externer gezeigt — restriktiver als das Gate, kein Backend-Inhalt,
minimale Existenz-Preisgabe akzeptiert.

## Rollout-Review (beim Deploy aktiv vorlegen)

Der Backfill setzt alle Bestandsrouten auf `external_enabled=1`. Das Feature ändert beim
Update faktisch nichts am Schutz, bis der Betreiber bewusst Routen umstellt. Empfohlene
Vorgehensweise nach dem Deploy:

1. Bestandsrouten auflisten:

```sql
-- Alle aktuell extern erreichbaren HTTP-Routen (Review-Kandidaten):
SELECT id, domain, external_enabled FROM routes
WHERE route_type = 'http' AND external_enabled = 1
ORDER BY domain;
```

2. Liste durchgehen: jede Route, die **nicht** aus dem Internet erreichbar sein muss, im
   Edit-Wizard auf „nur intern" stellen.

> Auf der Live-Instanz: da kein `sqlite3`-CLI verfügbar ist, via
> `docker exec gatecontrol node -e '…better-sqlite3 auf /data/gatecontrol.db…'` ausführen.

## Bekannte Grenzen / Folgephase (L4)

L4-Routen sind vom Außen-Schalter noch ausgenommen — Einschränkung und Bedarf werden in
einer separaten Folgephase bewertet.
