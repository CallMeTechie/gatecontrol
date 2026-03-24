# IP Access Control (IP-Filter)

Kontrolliert den Zugriff auf eine Route anhand der Client-IP-Adresse — per Whitelist oder Blacklist mit Unterstützung für einzelne IPs, CIDR-Bereiche und Ländercodes.

---

## Was macht es?

IP Access Control filtert Anfragen basierend auf der IP-Adresse des Clients, bevor sie das Backend erreichen. Im Gegensatz zur Peer ACL (die nur VPN-Peer-IPs filtert) arbeitet der IP-Filter mit **jeder** IP-Adresse — aus dem Internet, VPN oder lokalen Netzwerk.

**Whitelist-Modus (nur diese IPs erlauben):**
```
203.0.113.50 (Büro-IP)     →  Caddy  →  Backend  ✓  (in Whitelist)
198.51.100.10 (Home-IP)    →  Caddy  →  BLOCKIERT ✕  (nicht in Whitelist)
45.33.32.1 (Bot)           →  Caddy  →  BLOCKIERT ✕  (nicht in Whitelist)
```

**Blacklist-Modus (diese IPs blockieren):**
```
203.0.113.50 (Büro-IP)     →  Caddy  →  Backend  ✓  (nicht in Blacklist)
198.51.100.10 (Angreifer)  →  Caddy  →  BLOCKIERT ✕  (in Blacklist)
45.33.32.1 (CN-Bot)        →  Caddy  →  BLOCKIERT ✕  (Land CN in Blacklist)
```

## Wie funktioniert es technisch?

Die IP-Filterung erfolgt über eine Forward-Auth-Subrequest an GateControl (Node.js), die **vor** dem Reverse Proxy ausgeführt wird.

**Drei Regeltypen:**

| Typ | Beispiel | Prüfung |
|---|---|---|
| **Einzelne IP** | `203.0.113.50` | Exakter Vergleich |
| **CIDR-Bereich** | `10.0.0.0/8` | Bitmaske: `(clientIP & mask) === (rangeIP & mask)` |
| **Ländercode** | `DE`, `US`, `CN` | GeoIP-Lookup via ip2location.io API |

**Ablauf bei jeder Anfrage:**
1. Caddy leitet Anfrage an GateControl Forward-Auth weiter
2. GateControl extrahiert die Client-IP (strippt `::ffff:` IPv6-Prefix)
3. Prüft jede Regel sequentiell (IP → CIDR → Country)
4. Country-Lookup: API-Call zu ip2location.io mit 24h Cache (max 10.000 Einträge)
5. Whitelist: Match → erlaubt, kein Match → blockiert
6. Blacklist: Match → blockiert, kein Match → erlaubt

**Regeln werden als JSON in der Datenbank gespeichert:**
```json
[
  { "type": "ip", "value": "203.0.113.50" },
  { "type": "cidr", "value": "10.0.0.0/8" },
  { "type": "country", "value": "CN" }
]
```

## Use Cases

### Nur Büro-Netzwerk erlauben

Route `internal.example.com` → Interne App. Whitelist mit CIDR `185.10.20.0/24` (Büro-IP-Range). Nur Mitarbeiter im Büro (oder über Büro-VPN) können zugreifen.

### Bot-Traffic aus bestimmten Ländern blockieren

Route `shop.example.com` → Webshop. Blacklist mit Ländercodes `CN`, `RU`, `KP`. Reduziert automatisierten Spam und Brute-Force-Versuche erheblich.

### Bekannte Angreifer-IPs blockieren

Route `api.example.com` → API. Blacklist mit einzelnen IPs die in Logs als Angreifer aufgefallen sind. Schnelle Reaktion ohne Firewall-Zugang.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **IP-Filter + Peer ACL** | Doppelte Filterung: ACL für VPN-Peers, IP-Filter für zusätzliche Internet-IPs |
| **IP-Filter + Rate Limiting** | Erlaubte IPs werden zusätzlich rate-limited |
| **IP-Filter + Route Auth** | IP-Prüfung vor Login — blockierte IPs sehen nicht mal die Login-Seite |
| **IP-Filter + Basic Auth** | IP-Filter wird über Forward Auth geprüft (funktioniert nicht mit Basic Auth) |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **IP Access Control** Toggle aktivieren
3. Modus wählen: **Whitelist** oder **Blacklist**
4. Regeln hinzufügen:
   - Typ auswählen (IP, CIDR, Country)
   - Wert eingeben (z.B. `203.0.113.50`, `10.0.0.0/8`, `DE`)
5. Speichern

Für Country-basierte Filterung: **Settings → Advanced → ip2location.io API Key** eintragen.

### Über die API

```bash
# IP-Filter aktivieren mit Whitelist
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "ip_filter_enabled": true,
    "ip_filter_mode": "whitelist",
    "ip_filter_rules": [
      { "type": "cidr", "value": "185.10.20.0/24" },
      { "type": "ip", "value": "203.0.113.50" }
    ]
  }'

# IP-Filter mit Country-Blacklist
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "ip_filter_enabled": true,
    "ip_filter_mode": "blacklist",
    "ip_filter_rules": [
      { "type": "country", "value": "CN" },
      { "type": "country", "value": "RU" }
    ]
  }'
```

## Wichtige Hinweise

- **Unterschied zu Peer ACL:** ACL filtert nur WireGuard-Peer-IPs (10.8.0.x). IP Access Control filtert jede beliebige IP-Adresse.
- Country-Lookup erfordert einen **ip2location.io API Key**. Ohne Key werden Country-Regeln ignoriert.
- Der GeoIP-Cache speichert bis zu 10.000 Einträge für 24 Stunden. Bei Cache-Miss wird ein API-Call ausgeführt (max 5 Sekunden Timeout).
- IPv6-mapped IPv4-Adressen (`::ffff:192.168.1.1`) werden automatisch auf IPv4 reduziert.
- IP Access Control funktioniert nur mit **Route Auth** oder als eigenständiger Forward-Auth-Check. Bei **Basic Auth** ist der IP-Filter nicht verfügbar.
- Eine leere Whitelist erlaubt **niemanden**. Eine leere Blacklist blockiert **niemanden**.
- IP-Filter ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
