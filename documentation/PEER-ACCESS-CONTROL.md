# Peer Access Control (ACL)

Beschränkt den Zugriff auf eine Route (Domain) auf ausgewählte WireGuard-Peers. Nur Geräte die über einen erlaubten Peer mit dem VPN verbunden sind können die Route erreichen — alle anderen Anfragen werden blockiert.

---

## Was macht ACL?

Jede Route in GateControl ist standardmäßig über ihre Domain öffentlich erreichbar. Jeder im Internet kann `nas.example.com` aufrufen. ACL ändert das:

**Ohne ACL:**
```
Internet (jede IP)  →  Caddy  →  nas.example.com  →  Backend  ✓
VPN-Peer 10.8.0.3  →  Caddy  →  nas.example.com  →  Backend  ✓
VPN-Peer 10.8.0.5  →  Caddy  →  nas.example.com  →  Backend  ✓
```

**Mit ACL (nur Peer "Laptop" erlaubt):**
```
Internet (jede IP)  →  Caddy  →  nas.example.com  →  BLOCKIERT ✕
VPN-Peer 10.8.0.3  →  Caddy  →  nas.example.com  →  Backend  ✓  (Laptop)
VPN-Peer 10.8.0.5  →  Caddy  →  nas.example.com  →  BLOCKIERT ✕  (iPhone)
```

ACL macht die Route effektiv **nur über VPN erreichbar** und zusätzlich **nur für ausgewählte Peers**.

## Wie funktioniert es technisch?

Caddy prüft bei jeder Anfrage die IP-Adresse des Clients mit dem `remote_ip` Matcher:

- Anfragen über das VPN haben eine WireGuard-IP (z.B. `10.8.0.3`)
- Anfragen aus dem Internet haben eine öffentliche IP (z.B. `203.0.113.50`)
- Die ACL-Liste enthält nur die WireGuard-IPs der erlaubten Peers
- Öffentliche IPs sind nie in der Liste → werden immer blockiert

Die ACL-Konfiguration wird automatisch in die Caddy JSON-Config geschrieben. Es gibt keine manuelle Konfiguration.

## Use Case: Admin-Panel nur für den Laptop

**Ausgangssituation:**

Du betreibst ein Synology NAS Zuhause. GateControl erstellt die Route `nas.example.com` die auf Port 5001 (DSM Web UI) zeigt. Ohne weitere Einschränkung kann jeder im Internet die Login-Seite deines NAS sehen.

**Ziel:**

Nur dein Arbeits-Laptop soll auf `nas.example.com` zugreifen können. Nicht dein Smartphone, nicht das Internet.

**Einrichtung:**

1. Öffne die Route `nas.example.com` im Edit-Modal
2. Aktiviere **Peer-Zugriffskontrolle**
3. In der Peer-Checkliste: Nur **"Laptop Büro"** (10.8.0.3) auswählen
4. Speichern

**Ergebnis:**

| Quelle | IP bei Caddy | Zugriff |
|---|---|---|
| Laptop Büro (VPN aktiv) | 10.8.0.3 | Erlaubt |
| iPhone (VPN aktiv) | 10.8.0.5 | Blockiert |
| Beliebiger Internet-User | 203.0.113.x | Blockiert |
| Hacker / Bot | 45.33.x.x | Blockiert |

Dein NAS Admin-Panel ist jetzt nur erreichbar wenn du am Laptop sitzt und der VPN-Tunnel aktiv ist.

## Weitere Use Cases

### Entwicklungsserver nur für das Dev-Team

Route `staging.example.com` → Dev-Server auf Port 3000

ACL: Nur Peers "Dev-Laptop-1", "Dev-Laptop-2", "Dev-Laptop-3" erlaubt. QA-Team und Management können die Staging-Umgebung nicht sehen.

### Monitoring-Dashboard nur vom Office

Route `grafana.example.com` → Grafana auf Port 3000

ACL: Nur Peer "Office-Server" erlaubt. Mitarbeiter im Home-Office haben keinen Zugriff auf das Monitoring.

### Verschiedene Dienste für verschiedene Gruppen

| Route | Erlaubte Peers | Zweck |
|---|---|---|
| `nas.example.com` | Laptop, Smartphone | Dateizugriff für den Admin |
| `admin.example.com` | Nur Laptop | Sensibles Admin-Panel |
| `public-api.example.com` | Keine ACL | Öffentliche API ohne Einschränkung |

## Kombination mit anderen Features

ACL lässt sich mit anderen Sicherheits-Features kombinieren:

| Kombination | Wirkung |
|---|---|
| **ACL + Route Auth** | Erst VPN-IP prüfen, dann Login mit Passwort/2FA |
| **ACL + Rate Limiting** | VPN-only Zugang mit Anfragen-Begrenzung |
| **ACL + IP Access Control** | ACL für VPN-Peers + IP-Filter für zusätzliche Einschränkung |
| **ACL allein** | Einfachste Variante: nur ausgewählte VPN-Geräte kommen durch |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Peer-Zugriffskontrolle** Toggle aktivieren
3. Peers aus der Checkliste auswählen (Mehrfachauswahl möglich)
4. Speichern

### Über die API

```bash
# ACL aktivieren mit ausgewählten Peers (IDs: 1 und 3)
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "acl_enabled": true,
    "acl_peers": [1, 3]
  }'
```

### Deaktivieren

ACL Toggle ausschalten → die Route ist wieder für alle erreichbar.

## Wichtige Hinweise

- ACL blockiert nur den Zugriff über Caddy (HTTP/HTTPS Routen). Der direkte VPN-Zugang zwischen Peers wird nicht eingeschränkt.
- Wenn ein Peer deaktiviert oder gelöscht wird, wird er automatisch aus der ACL entfernt.
- ACL funktioniert nur für HTTP-Routen, nicht für L4 (TCP/UDP) Routen.
- Die ACL-Prüfung ist die erste Prüfung die Caddy durchführt — noch vor Auth, Rate Limiting oder anderen Handlern.
