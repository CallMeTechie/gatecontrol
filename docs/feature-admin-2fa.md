# Zwei-Faktor-Anmeldung für die Management-Oberfläche

Status: umgesetzt (Branch `feat/security`, Release 1.123.0). Verbindliche
Schnittstelle. Route-Auth hat bereits TOTP (`otpauth`, QR über
`/js/vendor/qrcode.min.js`); die Bausteine werden wiederverwendet, nicht kopiert.

## Modell

- `users.totp_secret_enc TEXT` (verschlüsselt wie andere Geheimnisse, `GC_ENCRYPTION_KEY`),
  `users.totp_enabled INTEGER NOT NULL DEFAULT 0`, `users.totp_confirmed_at TEXT`,
  `users.recovery_codes TEXT` (JSON-Array von Hashes, argon2 wie Passwörter; 10 Codes,
  je einmal verwendbar).
- Einstellung `security.require_2fa` (`'true'`/`'false'`, Standard `'false'`):
  erzwingt 2FA für alle Admin-Konten; ein Admin ohne 2FA wird nach dem Login zur
  Einrichtung geführt und kann sonst nichts anderes aufrufen.
- Migration v73 `admin_2fa` (nur SQL).

## Ablauf

1. `POST /login` prüft Passwort. Bei `totp_enabled`: **kein** `req.session.userId`,
   stattdessen `req.session.pending2fa = { userId, at }` (gültig 5 Minuten),
   Redirect `/login/2fa`.
2. `GET /login/2fa` rendert die Code-Seite (Themes: gleiche Optik wie `/login`);
   `POST /login/2fa` mit `code` (6 Ziffern, Fenster ±1 Schritt) **oder**
   `recovery_code`. Erfolg: `pending2fa` löschen, Session wie nach normalem Login
   (Regenerieren der Session-ID wie heute beim Login), Redirect auf das
   ursprüngliche Ziel. Fehler: Fehlversuche über den vorhandenen
   `lockout`-Service (`lockout.recordFailedAttempt('admin_2fa:<userId>', ...)`,
   Sperre wie beim Login), Rate-Limit `loginLimiter`.
3. Verwendete TOTP-Codes werden 90 s gemerkt (Replay-Schutz, wie
   `route_auth_totp_used`): Tabelle `admin_totp_used(user_id, code, used_at)`.
4. `requireAuth` bleibt unverändert: ohne `userId` keine API/Seite; die Seite
   `/login/2fa` und `POST /login/2fa` sind die einzigen Ausnahmen (nur mit
   gültigem `pending2fa`).
5. Desktop-Client, Gateway und API-Tokens sind nicht betroffen (eigene Auth).

## Einrichten (Profil)

- `POST /api/v1/profile/2fa/setup` → erzeugt Geheimnis (noch nicht aktiv),
  liefert `{ secret, otpauth_url }`; die Seite zeichnet den QR-Code clientseitig.
- `POST /api/v1/profile/2fa/confirm { code }` → aktiviert, liefert einmalig die
  `recovery_codes` (Klartext, danach nur Hashes).
- `POST /api/v1/profile/2fa/recovery-codes { password }` → neue Codes.
- `POST /api/v1/profile/2fa/disable { password, code }` → deaktiviert
  (verweigert 409 `TWO_FA_REQUIRED`, wenn `security.require_2fa` aktiv ist).
- Alle vier verlangen eine volle Session und CSRF; `setup`/`confirm` sind über
  `loginLimiter`-ähnliches Limit geschützt.
- Benutzerverwaltung: Admins sehen je Benutzer „2FA aktiv“; ein Admin kann bei
  einem anderen Benutzer 2FA **zurücksetzen** (`DELETE /api/v1/users/:id/2fa`,
  Aktivitätslog `user_2fa_reset`), damit sich niemand aussperrt.
- Einstellungen → Sicherheit: Schalter „2FA für alle Admins verlangen“
  (`PUT /api/v1/settings/security { require_2fa }`), Warnung, wenn der
  aktuelle Admin selbst noch kein 2FA hat.

## Oberfläche

- Profilseite: Karte „Zwei-Faktor-Anmeldung“: Status, „Einrichten“ (QR +
  Geheimnis + Code-Eingabe), Recovery-Codes (Anzeige einmalig, Kopieren,
  Download als Text), „Neu erzeugen“, „Deaktivieren“ (Passwort + Code).
- Login-2FA-Seite: Code-Feld (autofocus, `inputmode="numeric"`), Link
  „Wiederherstellungscode verwenden“, Fehlertexte, verbleibende Zeit.
- Sprachschlüssel `two_fa.*` (Block am Ende von `de.json`/`en.json`).

## Tests

Migration; Setup→Confirm→Login mit Code (gültig, ungültig, Replay, Fenster);
Recovery-Code einmalig; Sperre nach Fehlversuchen; `pending2fa` läuft ab; ohne
2FA-Abschluss keine API (`401`); `require_2fa` leitet zur Einrichtung; Reset
durch Admin; Deaktivieren verweigert bei Pflicht. Template-Render der neuen
Seiten in allen Themes; Browser-Szenario (Einrichten, Logout, Login mit Code,
Recovery-Code).
