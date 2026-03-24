# Backend HTTPS

Verbindet Caddy per HTTPS mit dem Backend — für Dienste die selbst-signierte Zertifikate verwenden und HTTPS erzwingen (z.B. Synology DSM, Proxmox, UniFi Controller).

---

## Was macht es?

Manche Dienste akzeptieren nur HTTPS-Verbindungen und verwenden dabei selbst-signierte Zertifikate. Backend HTTPS sorgt dafür, dass Caddy sich per HTTPS zum Backend verbindet, ohne das Zertifikat zu validieren.

**Ohne Backend HTTPS (Backend erzwingt HTTPS):**
```
Client  →  Caddy  →  http://10.8.0.3:5001  →  Backend lehnt HTTP ab  ✕
```

**Mit Backend HTTPS:**
```
Client  →  Caddy (Let's Encrypt)  →  https://10.8.0.3:5001  →  Backend (Self-Signed)  ✓
           ↑ gültiges Zertifikat      ↑ insecure_skip_verify: true
```

Die Verbindung ist durchgehend verschlüsselt: Client → Caddy mit Let's Encrypt, Caddy → Backend mit dem selbst-signierten Zertifikat des Backends.

## Wie funktioniert es technisch?

Wenn `backend_https` aktiviert ist, fügt GateControl dem Reverse-Proxy-Handler ein TLS-Transport mit `insecure_skip_verify` hinzu:

**Caddy JSON-Konfiguration:**
```json
{
  "handler": "reverse_proxy",
  "upstreams": [{ "dial": "10.8.0.3:5001" }],
  "transport": {
    "protocol": "http",
    "tls": {
      "insecure_skip_verify": true
    }
  }
}
```

**Was passiert:**
1. Caddy verbindet sich per TLS zum Backend
2. Das Backend-Zertifikat wird **nicht validiert** — egal ob selbst-signiert, abgelaufen oder für eine andere Domain ausgestellt
3. Die Verbindung ist trotzdem verschlüsselt (TLS Handshake findet statt)
4. GateControl loggt eine Warnung: `Route uses backend_https with insecure_skip_verify`

**Beim Monitoring:** Der Health-Check verwendet ebenfalls HTTPS mit `rejectUnauthorized: false`, damit die Erreichbarkeitsprüfung auch mit selbst-signierten Zertifikaten funktioniert.

## Use Cases

### Synology DSM (Port 5001)

Synology NAS leitet Port 5000 (HTTP) automatisch auf Port 5001 (HTTPS) um. Das DSM-Zertifikat ist standardmäßig selbst-signiert. Route: `nas.example.com` → Peer "NAS" auf Port 5001 mit Backend HTTPS aktiviert.

### Proxmox Web UI (Port 8006)

Proxmox VE erzwingt HTTPS auf Port 8006 mit einem selbst-signierten Zertifikat. Route: `proxmox.example.com` → Peer "Hypervisor" auf Port 8006 mit Backend HTTPS.

### UniFi Controller (Port 8443)

Der UniFi Network Controller läuft auf Port 8443 mit HTTPS. Route: `unifi.example.com` → Peer "Controller" auf Port 8443 mit Backend HTTPS.

### Portainer (Port 9443)

Portainer bietet HTTPS auf Port 9443 an. Route: `portainer.example.com` → Peer "Docker-Host" auf Port 9443 mit Backend HTTPS.

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Backend HTTPS + Force HTTPS** | Empfohlen: Client → Caddy (LE) → Backend (Self-Signed) — durchgehend verschlüsselt |
| **Backend HTTPS + Monitoring** | Monitoring prüft per HTTPS mit `rejectUnauthorized: false` |
| **Backend HTTPS + Load Balancing** | Alle Backends müssen HTTPS akzeptieren |
| **Backend HTTPS + ACL** | Kein Konflikt — ACL prüft Client-IP, Backend HTTPS betrifft nur die Upstream-Verbindung |

## Einrichtung

### Über die UI

1. Route erstellen oder bearbeiten
2. **Backend HTTPS** Toggle aktivieren
3. **Target Port** auf den HTTPS-Port des Backends setzen (z.B. 5001, 8006, 8443)
4. Speichern

### Über die API

```bash
# Backend HTTPS aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "backend_https": true,
    "target_port": 5001
  }'
```

## Wichtige Hinweise

- **Nur aktivieren wenn das Backend HTTPS erzwingt.** Wenn das Backend auch HTTP akzeptiert, ist Backend HTTPS unnötig und verschwendet CPU für den zusätzlichen TLS-Handshake.
- `insecure_skip_verify` bedeutet: Caddy vertraut **jedem** Zertifikat — auch gefälschten. Im VPN-Kontext (Caddy → WireGuard Peer) ist das akzeptabel, da der Transportweg bereits verschlüsselt ist.
- Backend HTTPS betrifft nur die Verbindung Caddy → Backend. Die Verbindung Client → Caddy wird separat durch Force HTTPS konfiguriert.
- Wenn Backend HTTPS aktiviert ist aber das Backend nur HTTP akzeptiert, schlägt die Verbindung fehl (TLS Handshake Error).
- Backend HTTPS ist nur für HTTP-Routen verfügbar. Für L4-Routen gibt es den TLS-Modus (passthrough/terminate).
- Bei Load Balancing mit Backend HTTPS: **alle** Backends der Route müssen HTTPS unterstützen — es gibt keine individuelle Konfiguration pro Backend.
