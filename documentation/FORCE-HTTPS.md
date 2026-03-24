# Force HTTPS

Aktiviert automatische TLS-Verschlüsselung mit Let's Encrypt Zertifikaten — HTTP-Anfragen werden per 301 auf HTTPS umgeleitet, Zertifikate werden automatisch erneuert.

---

## Was macht es?

Force HTTPS sorgt dafür, dass die gesamte Kommunikation zwischen Client und Caddy verschlüsselt ist. Caddy holt automatisch ein TLS-Zertifikat von Let's Encrypt und erneuert es vor Ablauf.

**Ohne Force HTTPS:**
```
Client  →  http://app.example.com:80   →  Caddy  →  Backend
             ↑ unverschlüsselt, Daten im Klartext
```

**Mit Force HTTPS:**
```
Client  →  http://app.example.com:80   →  301 Redirect → https://...
Client  →  https://app.example.com:443 →  Caddy (TLS)  →  Backend
             ↑ verschlüsselt mit Let's Encrypt Zertifikat
```

## Wie funktioniert es technisch?

Wenn `https_enabled` aktiv ist, konfiguriert GateControl Caddy so:

1. **Listener:** Caddy lauscht auf Port `:443` statt `:80`
2. **TLS-Zertifikat:** Caddy nutzt die ACME HTTP-01 Challenge:
   - Caddy erstellt ein temporäres Token unter `/.well-known/acme-challenge/`
   - Let's Encrypt ruft dieses Token über Port 80 ab
   - Bei Erfolg: Zertifikat wird ausgestellt und gespeichert
3. **HTTP → HTTPS Redirect:** Caddy leitet alle HTTP-Anfragen automatisch per 301 auf HTTPS um
4. **Auto-Renewal:** Caddy erneuert Zertifikate automatisch bevor sie ablaufen (Standard: 30 Tage vor Ablauf)

**TLS-Konfiguration (falls Email gesetzt):**
```json
{
  "apps": {
    "tls": {
      "automation": {
        "policies": [{
          "issuers": [{
            "module": "acme",
            "email": "admin@example.com"
          }]
        }]
      }
    }
  }
}
```

**Custom ACME CA:** Über die Umgebungsvariable `GC_CADDY_ACME_CA` kann eine alternative ACME CA konfiguriert werden (z.B. für interne PKI oder Let's Encrypt Staging).

## Use Cases

### Jede Produktions-Route

Alle Routen die über das Internet erreichbar sind, sollten HTTPS verwenden. Force HTTPS ist die Standard-Einstellung für neue HTTP-Routen in GateControl (Toggle ist beim Erstellen bereits aktiviert).

### SEO und Browser-Sicherheit

Google bevorzugt HTTPS-Seiten im Ranking. Moderne Browser zeigen bei HTTP-Seiten eine "Nicht sicher" Warnung. Mit Force HTTPS vermeidest du beides.

### API-Verschlüsselung

REST APIs die Authentifizierungsdaten (Tokens, Passwörter) übertragen, müssen verschlüsselt sein. Ohne HTTPS werden Bearer Tokens im Klartext übertragen.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **HTTPS + Backend HTTPS** | Client → Caddy (Let's Encrypt) → Backend (Self-Signed) — durchgehend verschlüsselt |
| **HTTPS + Basic Auth** | Credentials werden verschlüsselt übertragen (ohne HTTPS: Base64 im Klartext!) |
| **HTTPS + Route Auth** | Login-Seite und Session-Cookie sind verschlüsselt |
| **HTTPS + Compression** | TLS-Handshake + komprimierte Daten — minimal mehr CPU, viel weniger Bandbreite |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Force HTTPS** Toggle aktivieren (ist standardmäßig an)
3. Speichern

Es gibt keine weitere Konfiguration — Caddy erledigt alles automatisch.

### Über die API

```bash
# HTTPS aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "https_enabled": true
  }'
```

### ACME Email konfigurieren

Die ACME Email wird global in den GateControl-Einstellungen oder per Umgebungsvariable gesetzt:

```bash
# In docker-compose.yml oder .env
GC_CADDY_EMAIL=admin@example.com

# Optionale alternative ACME CA (z.B. Staging)
GC_CADDY_ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
```

## Wichtige Hinweise

- **DNS muss korrekt zeigen.** Die Domain muss per A/AAAA-Record auf die öffentliche IP des GateControl-Servers zeigen. Ohne korrekte DNS-Auflösung schlägt die ACME Challenge fehl.
- **Ports 80 und 443 müssen offen sein.** Let's Encrypt nutzt Port 80 für die HTTP-01 Challenge. Port 443 wird für HTTPS benötigt. Beide Ports müssen von außen erreichbar sein.
- **Kein Cloudflare Proxy.** Wenn die Domain hinter Cloudflare Proxy (orangene Wolke) steht, schlägt die HTTP-01 Challenge fehl. Verwende **DNS Only** (graue Wolke) oder wechsle zu DNS-01 Challenge (nicht von GateControl unterstützt).
- **Rate Limits beachten.** Let's Encrypt hat Rate Limits: max 50 Zertifikate pro registrierter Domain pro Woche. Bei vielen Subdomains kann das relevant werden.
- Zertifikate werden in Caddys Datenspeicher abgelegt (`/data/caddy/`) und überleben Container-Neustarts.
- Wenn Force HTTPS deaktiviert wird, lauscht Caddy nur noch auf Port 80. Bestehende Zertifikate bleiben gespeichert, werden aber nicht mehr verwendet.

### Troubleshooting

| Problem | Ursache | Lösung |
|---|---|---|
| Zertifikat wird nicht ausgestellt | DNS zeigt nicht auf Server | A-Record prüfen, `dig` oder `nslookup` verwenden |
| ACME Challenge fehlgeschlagen | Port 80 blockiert | Firewall / Router prüfen, Port 80 freigeben |
| Too many certificates | Let's Encrypt Rate Limit | 1 Stunde warten, dann erneut versuchen |
| Zertifikat abgelaufen | Caddy konnte nicht erneuern | Caddy Logs prüfen, DNS und Port 80 prüfen |
