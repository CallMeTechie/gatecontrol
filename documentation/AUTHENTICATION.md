# Authentication

Drei Authentifizierungsmethoden für HTTP-Routen: Keine Authentifizierung (öffentlich), Basic Auth (Browser-Dialog) und Route Auth (eigene Login-Seite mit 2FA-Unterstützung).

---

## Was macht es?

Authentication kontrolliert wer auf eine Route zugreifen darf. GateControl bietet drei Stufen:

**Keine Authentifizierung:**
```
Client  →  Caddy  →  Backend  ✓  (jeder hat Zugriff)
```

**Basic Auth:**
```
Client  →  Caddy  →  "Username/Passwort?" (Browser-Dialog)  →  Backend  ✓
```

**Route Auth:**
```
Client  →  Caddy  →  Login-Seite (Email + Passwort + 2FA)  →  Session-Cookie  →  Backend  ✓
```

## Keine Authentifizierung

Die Route ist öffentlich erreichbar. Jeder mit der URL kann zugreifen.

**Wann sinnvoll:**
- Öffentliche Websites und APIs
- In Kombination mit Peer ACL (nur VPN-Zugang, kein Login nötig)
- Dienste die eigene Authentifizierung mitbringen (z.B. Nextcloud, Gitea)

**Achtung:** Ohne Auth und ohne ACL ist die Route für das gesamte Internet sichtbar. Das Backend sollte dann selbst eine Login-Funktion haben.

## Basic Auth

HTTP Basic Authentication — der Browser zeigt einen nativen Anmelde-Dialog.

### Wie funktioniert es technisch?

Caddy fügt einen `authentication` Handler **vor** allen anderen Handlern ein:

```json
{
  "handler": "authentication",
  "providers": {
    "http_basic": {
      "accounts": [{
        "username": "admin",
        "password": "$2a$14$..."
      }]
    }
  }
}
```

**Ablauf:**
1. Client öffnet die Route
2. Caddy antwortet mit `401 Unauthorized` und `WWW-Authenticate: Basic`
3. Browser zeigt nativen Login-Dialog
4. Client sendet `Authorization: Basic <base64(user:pass)>` Header
5. Caddy prüft Username gegen gespeicherten Wert und Passwort gegen bcrypt-Hash
6. Bei Erfolg: Anfrage wird an Backend weitergeleitet
7. Der `Authorization` Header wird bei **jeder** Anfrage mitgesendet (kein Session-Management)

### Eigenschaften

| Eigenschaft | Wert |
|---|---|
| Passwort-Speicherung | bcrypt Hash |
| Session-Management | Keines — Credentials bei jeder Anfrage |
| Logout | Nicht möglich (Browser cacht Credentials) |
| 2FA | Nicht möglich |
| Browser-Kompatibilität | Alle Browser |
| API-Kompatibilität | Alle HTTP-Clients (`curl -u user:pass`) |
| Accounts pro Route | 1 |

### Use Cases

**Entwickler-Tools schützen:** Route `phpmyadmin.example.com` → phpMyAdmin. Basic Auth mit einem starken Passwort. Einfach, kein Setup, funktioniert mit jedem Browser und Tool.

**API-Zugang absichern:** `curl -u admin:secret https://api.example.com/data` — Basic Auth ist für APIs ideal, da kein Cookie/Session-Management nötig ist.

## Route Auth

Eigene Login-Seite mit mehreren Authentifizierungsmethoden und optionaler Zwei-Faktor-Authentifizierung.

### Wie funktioniert es technisch?

Route Auth nutzt Caddys `forward_auth` Mechanismus:

1. Caddy leitet `/route-auth/*` Pfade direkt an GateControl (Port 3000) weiter (Login-Seite, Assets)
2. Für alle anderen Pfade: Forward-Auth Subrequest an `GET /route-auth/verify`
3. GateControl prüft den Session-Cookie
4. Bei gültiger Session (2xx): Anfrage wird ans Backend weitergeleitet
5. Bei ungültiger Session: `302 Redirect` zur Login-Seite

```json
{
  "handler": "reverse_proxy",
  "upstreams": [{ "dial": "127.0.0.1:3000" }],
  "rewrite": { "method": "GET", "uri": "/route-auth/verify" },
  "headers": {
    "request": {
      "set": {
        "X-Route-Domain": ["app.example.com"],
        "X-Forwarded-Method": ["{http.request.method}"],
        "X-Forwarded-Uri": ["{http.request.uri}"]
      }
    }
  }
}
```

### Drei Login-Methoden

#### Email & Password

Klassischer Login mit Email-Adresse und Passwort.

- Passwort wird als bcrypt-Hash gespeichert
- Kein externer Dienst nötig
- Einfachste Methode

#### Email & Code

6-stelliger Einmalcode wird per Email gesendet.

- Erfordert konfiguriertes SMTP (Settings → Email)
- Code ist zeitlich begrenzt
- Kein Passwort nötig — nur Zugang zur Email
- Ideal für Benutzer die sich keine Passwörter merken wollen

#### TOTP (Time-based One-Time Password)

Authenticator-App generiert 6-stellige Codes.

- Kompatibel mit: Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.
- Kein Passwort, kein Email-Zugang nötig
- Erfordert einmalige QR-Code-Einrichtung

### Zwei-Faktor-Authentifizierung (2FA)

Route Auth unterstützt optionale 2FA. Dabei wird Email & Password als erster Faktor kombiniert mit:

- **Email Code** als zweiter Faktor: Nach dem Passwort wird ein 6-stelliger Code per Email gesendet
- **TOTP** als zweiter Faktor: Nach dem Passwort wird ein TOTP-Code aus der Authenticator-App verlangt

### Session-Management

| Eigenschaft | Wert |
|---|---|
| Session-Dauer | Konfigurierbar: 1h, 12h, 24h, 7d, 30d |
| Session-Speicherung | Cookie |
| Logout | Ja (zerstört Session) |
| Mehrere Geräte | Ja (separate Sessions) |

### Custom Branding

Jede Route kann eine eigene Login-Seite haben:

- Logo (Upload oder URL)
- Titel und Beschreibungstext
- Farben (Primary, Background)
- Hintergrundbild

### TOTP-Einrichtung (Schritt für Schritt)

1. Route erstellen/bearbeiten → Auth Type: **Route Auth**
2. Method: **TOTP** auswählen (oder als 2FA zweiter Faktor)
3. Route speichern
4. Route erneut im Edit-Modal öffnen
5. Im TOTP-Abschnitt erscheint ein **QR-Code**
6. QR-Code mit Authenticator-App scannen
7. 6-stelligen Bestätigungscode eingeben
8. TOTP ist aktiv

**Wichtig:** Der QR-Code wird nur angezeigt wenn die Route bereits gespeichert wurde. Beim Erstellen einer neuen Route muss nach dem ersten Speichern das Edit-Modal erneut geöffnet werden.

## Vergleichstabelle

| Eigenschaft | Keine Auth | Basic Auth | Route Auth |
|---|---|---|---|
| Sicherheitsstufe | Keine | Mittel | Hoch |
| Login-UI | Keine | Browser-Dialog | Eigene Login-Seite |
| Passwort-Speicherung | — | bcrypt | bcrypt |
| 2FA möglich | Nein | Nein | Ja |
| Session/Logout | — | Nein/Nein | Ja/Ja |
| API-kompatibel | Ja | Ja (`curl -u`) | Nein (Cookie-basiert) |
| Custom Branding | — | Nein | Ja |
| Accounts pro Route | — | 1 | 1 |
| Email nötig | Nein | Nein | Ja (für Email-Methoden) |
| SMTP nötig | Nein | Nein | Nur für Email Code |
| Funktioniert mit L4 | — | Nein | Nein |

## Kombination mit anderen Features

| Kombination | Wirkung |
|---|---|
| **Auth + ACL** | Erst VPN-IP Prüfung, dann Login |
| **Auth + Force HTTPS** | Pflicht bei Basic Auth (sonst Credentials im Klartext!) |
| **Auth + Rate Limiting** | Basic Auth: Rate Limit vor Auth. Route Auth: Rate Limit nach Auth |
| **Auth + IP-Filter** | Route Auth + IP-Filter: IP wird im Forward-Auth geprüft. Basic Auth + IP-Filter: nicht kombinierbar |

## Einrichtung

### Basic Auth über die UI

1. Route erstellen oder bearbeiten
2. Auth Type: **Basic Auth** auswählen
3. Username und Passwort eingeben
4. Speichern

### Route Auth über die UI

1. Route erstellen oder bearbeiten
2. Auth Type: **Route Auth** auswählen
3. Methode wählen (Email & Password, Email & Code, TOTP)
4. Optional: 2FA aktivieren und zweiten Faktor wählen
5. Email und ggf. Passwort eingeben
6. Speichern
7. Für TOTP: Route erneut öffnen und QR-Code scannen

### Über die API

```bash
# Basic Auth aktivieren
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "basic_auth_enabled": true,
    "basic_auth_user": "admin",
    "basic_auth_password": "my-secure-password"
  }'

# Route Auth aktivieren (Email & Password)
curl -X PUT https://gatecontrol.example.com/api/v1/routes/1 \
  -H "Authorization: Bearer gc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "auth_type": "route",
    "route_auth_method": "email_password",
    "route_auth_email": "admin@example.com",
    "route_auth_password": "my-secure-password"
  }'
```

## Wichtige Hinweise

- **Basic Auth und Route Auth sind gegenseitig exklusiv.** Eine Route kann nur eine der beiden Methoden verwenden.
- **Basic Auth ohne HTTPS ist unsicher.** Das Passwort wird Base64-kodiert (nicht verschlüsselt) im `Authorization` Header gesendet. Force HTTPS muss aktiv sein.
- Route Auth ist **nicht API-kompatibel**. Es basiert auf Session-Cookies und einer Login-Seite. Für API-Zugang verwende Basic Auth.
- Authentifizierung ist nur für HTTP-Routen verfügbar, nicht für L4 (TCP/UDP).
- Bei Route Auth: der Forward-Auth Subrequest wird bei **jeder** Anfrage ausgeführt (Session-Cookie Prüfung). Das addiert minimal Latenz (~1-5ms).
- Basic Auth hat keine Brute-Force-Schutz eingebaut. Kombiniere es mit Rate Limiting für zusätzliche Sicherheit.
- TOTP-Secrets werden in der Datenbank gespeichert. Ein Datenbank-Backup sichert auch die TOTP-Konfiguration.
