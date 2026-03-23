# Security Hardening v1.5.1

Umfassende Sicherheitshärtung des gesamten GateControl-Projekts. Basierend auf einem vollständigen Security-Audit mit 39 identifizierten Issues über 4 Bereiche: Authentication, Input Validation, Docker/Infrastructure und Frontend.

---

## Übersicht

| Schwere | Gefunden | Behoben | By Design |
|---|---|---|---|
| CRITICAL | 6 | 6 | — |
| HIGH | 12 | 12 | — |
| MEDIUM | 11 | 11 | — |
| LOW/INFO | 10 | 7 | 3 |
| **Gesamt** | **39** | **36** | **3** |

---

## CRITICAL Fixes

### #1 — Prototype Pollution CSRF-Bypass

`req.tokenAuth`, `req.tokenId` und `req.tokenScopes` werden jetzt am Anfang von `requireAuth()` defensiv auf `false`/`null` zurückgesetzt. Verhindert, dass ein Prototype-Pollution-Angriff CSRF-Schutz umgehen kann.

**Datei:** `src/middleware/auth.js`

### #2 — Route-Auth Forward-Auth ohne Header

Der `/route-auth/verify` Endpoint gibt jetzt `401 Unauthorized` zurück wenn der `x-route-domain` Header fehlt (statt `200 OK`). Verhindert Auth-Bypass bei direktem Zugriff auf den Endpoint.

**Datei:** `src/routes/routeAuth.js`

### #3 — Caddy Config Injection via Custom Headers

- Header-Namen müssen `/^[a-zA-Z0-9\-]+$/` matchen (max 256 Zeichen)
- Header-Werte dürfen keine Caddy-Placeholders `{...}` enthalten (max 4096 Zeichen)
- `rate_limit_window` validiert gegen Allowlist: `1s`, `1m`, `5m`, `1h`
- `sticky_cookie_name` validiert gegen `/^[a-zA-Z0-9_\-]+$/`

**Datei:** `src/services/routes.js`

### #4 — DNS-Check SSRF/Reconnaissance

`validateDomain()` wird jetzt vor `dns.resolve4()` aufgerufen. Die Response enthält keine aufgelösten IP-Adressen mehr — verhindert Enumeration interner Hostnames.

**Datei:** `src/routes/api/routes.js`

### #5 — Node-Prozess als Root

Geprüft und bewusst beibehalten. WireGuard CLI (`wg show`, `wg syncconf`, `wg-quick`) und `/etc/wireguard/*` erfordern root-Rechte. Die Container-Isolation (Docker) ist die Sicherheitsgrenze.

### #6 — Key-File Permissions nach chown -R

Nach dem rekursiven `chown -R gatecontrol:gatecontrol /data` werden `.session_secret` und `.encryption_key` explizit auf `root:root` mit `chmod 600` zurückgesetzt.

**Datei:** `entrypoint.sh`

---

## HIGH Fixes

### #7 — Route-Auth Lockout per Email statt IP

Lockout-Identifier von `IP:routeId` auf `email:routeId` geändert. Verhindert Brute-Force durch IP-Rotation.

**Datei:** `src/routes/routeAuth.js`

### #8 — OTP Range vollständig

`crypto.randomInt(100000, 999999)` → `crypto.randomInt(0, 1000000)).padStart(6, '0')`. Deckt jetzt alle 1.000.000 Codes ab (000000–999999).

**Datei:** `src/services/routeAuth.js`

### #9 — send-code erfordert pending Session

OTP-Code-Resend erfordert jetzt eine gültige pending-2FA Route-Auth Session. Verhindert unauthentifiziertes Email-Spamming.

**Datei:** `src/routes/routeAuth.js`

### #10 — Eigener Route-Auth CSRF-Key

CSRF-Secret für Route-Auth wird jetzt via HMAC aus dem App-Secret abgeleitet: `crypto.createHmac('sha256', secret).update('csrf-route-auth').digest('hex')`. Separate Keys für separate Zwecke.

**Datei:** `src/routes/routeAuth.js`

### #11 — WireGuard Config Injection blockiert

- `dns` wird als komma-separierte IP-Adressen-Liste validiert
- `persistentKeepalive` wird als Integer 0–65535 validiert
- Newline-Zeichen in beiden Feldern werden abgelehnt

**Datei:** `src/services/peers.js`

### #12 — Email HTML Injection verhindert

Alle interpolierten Werte in HTML-Email-Templates (`domain`, `code`, Monitoring-Alert-Felder) werden jetzt mit `escapeHtml()` behandelt.

**Datei:** `src/services/email.js`

### #13 — SSRF via Route target_ip blockiert

Private/Loopback IPs (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 0.x) sind als direkte Route-Targets blockiert. Peer-verlinkte Routes sind nicht betroffen — WireGuard-IPs werden weiterhin akzeptiert.

**Datei:** `src/routes/api/routes.js`

### #14 — Token Query-Parameter entfernt

`?token=gc_xxx` für den `/metrics` Endpoint wurde entfernt. Nur noch Header-Authentifizierung (`Authorization: Bearer gc_xxx` oder `X-API-Token: gc_xxx`). Verhindert Token-Leaks in Logs.

**Datei:** `src/routes/index.js`

### #15 — WireGuard Private Key aus Logs gefiltert

`wg-quick up` Output wird durch `grep -vi "privatekey"` geleitet. Verhindert, dass Private Keys in Docker Logs erscheinen.

**Datei:** `scripts/wg-wrapper.sh`

### #16 — Trust Proxy auf Loopback eingeschränkt

`app.set('trust proxy', 1)` → `app.set('trust proxy', 'loopback')`. Nur Requests von 127.0.0.1/::1 werden als geproxied vertraut. Verhindert IP-Spoofing über `X-Forwarded-For` bei direktem Zugriff auf Port 3000.

**Datei:** `src/app.js`

### #17 — CSP Styles mit Nonce

`style-src: 'unsafe-inline'` aufgeteilt in:
- `style-src-elem: 'self' 'nonce-xxx' fonts.googleapis.com` — blockt injizierte `<style>` Tags
- `style-src-attr: 'unsafe-inline'` — erlaubt `style="..."` Attribute

Alle `<style>` Blöcke in Templates haben den `nonce="{{ cspNonce }}"` Attribut.

**Datei:** `src/app.js`, Templates

### #18 — Dashboard innerHTML XSS

API-Integer-Werte (`monitoring.up`, `.total`, `.down`, `traffic.today`) werden jetzt mit `parseInt(..., 10)` coerced und via `textContent` statt `innerHTML` eingefügt.

**Datei:** `public/js/dashboard.js`

---

## MEDIUM Fixes

### #19 — TOTP Replay-Prevention

In-Memory Map trackt benutzte TOTP-Codes pro Route mit 90s Expiry. Verhindert Wiederverwendung desselben Codes innerhalb des Gültigkeitsfensters.

**Datei:** `src/services/routeAuth.js`

### #20 — Session Secure Flag Warnung

Startup-Warnung wenn `NODE_ENV=production` und `GC_BASE_URL` nicht mit `https` beginnt.

**Datei:** `config/validate.js`

### #21 — Rate-Limiter Bypass behoben

10x erhöhtes Rate-Limit nur noch für Session-authentifizierte Requests (nicht mehr für Requests die nur einen `Bearer gc_` Header ohne gültigen Token senden).

**Datei:** `src/middleware/rateLimit.js`

### #22 — Backup Settings-Key Validierung

Regex-Allowlist `/^[a-zA-Z0-9_.\-]+$/` für Settings-Keys beim Backup-Restore. Ungültige Keys werden übersprungen und geloggt.

**Datei:** `src/services/backup.js`

### #23 — X-Forwarded-For durch req.ip ersetzt

Forward-Auth IP-Filter nutzt jetzt Express-resolved `req.ip` statt den Raw `X-Forwarded-For` Header (der Komma-separierte Multi-Values enthalten kann).

**Datei:** `src/routes/routeAuth.js`

### #24 — CSS Injection via Peer-Group Color

Peer-Group `color` wird gegen `/^#[0-9a-fA-F]{3,8}$/` validiert. Ungültige Werte fallen auf `#6b7280` zurück.

**Datei:** `public/js/peers.js`

### #25 — Monitoring Response Time Sanitization

`monitoring_response_time` wird mit `parseInt(..., 10) || 0` coerced bevor es in HTML eingefügt wird.

**Datei:** `public/js/routes.js`

### #26 — ip2location API-Key maskiert

Backend gibt nur `has_api_key: true/false` zurück statt den vollständigen Key. Frontend zeigt `•••••••• (Key is set)`.

**Dateien:** `src/routes/api/settings.js`, `public/js/settings.js`

### #27 — /health Info-Leak eingeschränkt

Detaillierte Component-Status (`db`, `wireguard`) nur für localhost-Requests. Externe Caller sehen nur `{ ok: true/false }`.

**Datei:** `src/routes/index.js`

### #28 — WG-Wrapper SIGTERM Race Condition

Guard-Variable `WG_UP` verhindert `wg-quick down` bevor `wg-quick up` abgeschlossen ist. Non-zero Exit bei Startfehler.

**Datei:** `scripts/wg-wrapper.sh`

### #29 — Memory Limits

Geprüft: Container braucht ~1GB im Normalbetrieb (Caddy + WG + Node). Kein Memory-Limit gesetzt — würde OOM-Kill verursachen.

---

## LOW/INFO Fixes

| # | Fix | Datei |
|---|-----|-------|
| #30 | Rate-Limit Error-Strings i18n (EN+DE) | `src/middleware/rateLimit.js` |
| #31 | Hardcoded German Strings durch i18n ersetzt | `templates/default/pages/routes.njk` |
| #32 | Dead Code `generateCsrfToken`/`verifyCsrfToken` entfernt | `src/services/routeAuth.js` |
| #33 | Argon2 `parallelism: 4` → `1` (libuv Thread Pool) | `src/utils/argon2Options.js` |
| #37 | `frameAncestors: ["'self'"]` in CSP ergänzt | `src/app.js` |
| #38 | Crypto Split mit expliziter Längenprüfung (IV=24, Tag=32, Parts=3) | `src/utils/crypto.js` |
| #39 | Branding-Felder: max 255 (title) / 2000 (text) Zeichen | `src/services/routes.js` |

---

## Bewusste Design-Entscheidungen (kein Fix nötig)

| # | Thema | Begründung |
|---|-------|------------|
| #5 | Node als root | WireGuard CLI erfordert root, Container-Isolation ist Sicherheitsgrenze |
| #35 | bcryptjs + argon2 | argon2 für Admin-Login, bcryptjs für Route Basic Auth (Caddy-Kompatibilität) |
| #36 | COEP deaktiviert | Notwendig für QR-Code-Generierung und Google Fonts |

---

## Funktionsbeeinträchtigungen

Detaillierte Beschreibung aller Funktionsänderungen siehe: [SECURITY-CHANGES-v1.5.md](SECURITY-CHANGES-v1.5.md)

| Fix | Auswirkung |
|-----|-----------|
| #7 | Lockout per Email statt IP |
| #10 | Route-Auth CSRF-Tokens nach Update einmalig ungültig |
| #13 | Direkte Route-Targets auf private IPs nur noch via Peer-Link |
| #14 | Prometheus `?token=` entfernt, nur Header-Auth |
| #16 | Nur loopback als Proxy vertraut |
| #26 | ip2location API-Key nicht mehr sichtbar im UI |
| #27 | /health extern nur noch `{ok: true/false}` |
