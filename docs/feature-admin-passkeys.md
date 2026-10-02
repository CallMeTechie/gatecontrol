# Passkeys (WebAuthn) für die Management-Oberfläche

Status: umgesetzt (Branch `feat/passkeys`). Ergänzt die Zwei-Faktor-Anmeldung
(`docs/feature-admin-2fa.md`), ersetzt sie nicht. Server-Seite:
`@simplewebauthn/server`; Browser-Seite: eigener kleiner Kleber
`public/js/webauthn.js` (kein CDN, keine Abhängigkeit).

## Modell (Migration v84 `admin_passkeys`)

- `users.webauthn_user_id TEXT UNIQUE` — zufälliges 32-Byte-User-Handle
  (base64url), das Authenticatoren als `user.id` bekommen. Nie die DB-ID.
  Wird beim ersten Passkey erzeugt.
- `admin_passkeys(id, user_id → users ON DELETE CASCADE, credential_id UNIQUE,
  public_key BLOB, sign_count, transports JSON, name, aaguid, device_type,
  backed_up, created_at, last_used_at)`.

## Relying Party

RP-ID und Origin kommen **nur** aus `GC_BASE_URL` (`config.app.baseUrl`), nie
aus Host-/Origin-Headern. Passkeys sind abgeschaltet (Button unsichtbar, API
503 `UNAVAILABLE`), wenn die URL kein Hostname mit https ist (Ausnahme:
`http://localhost`). IP-Adressen sind als RP-ID von WebAuthn nicht erlaubt.
Wer die Oberfläche unter einer anderen Adresse öffnet, bekommt den Hinweis
„Passkeys funktionieren nur unter …“.

## Anmeldung (`/login`)

1. „Mit Passkey anmelden“ → `POST /login/passkey/options` (CSRF, eigenes
   Rate-Limit pro IP) → Optionen ohne `allowCredentials` (discoverable
   credentials, kein Benutzername nötig, keine Konten-Enumeration).
   Challenge in `req.session.passkeyLogin = { challenge, at }`.
2. `POST /login/passkey { response, returnTo }` → Challenge wird sofort
   verbraucht (auch bei Fehlschlag), TTL 3 min. Geprüft: Challenge, Origin,
   RP-ID, Typ, Signatur, UP **und UV**, User-Handle passt zum Konto des
   Credentials, Konto aktiv, Zähler.
3. Erfolg: gleicher Abschluss wie Passwort/TOTP (`establishSession`:
   Session-Regenerierung, `last_login_at`, Aktivität `passkey_login`),
   zusätzlich `session.authMethod = 'passkey'`, `session.authAt`.
   Antwort JSON `{ ok, redirect }`.
4. Fehler: immer dieselbe Meldung (unbekannt, Signatur, Zähler, deaktiviert),
   Aktivität `passkey_login_failed` mit Code, kein Schlüsselmaterial im Log.

Ein Passkey-Login gilt als vollständige Mehrfaktor-Anmeldung: TOTP wird nicht
zusätzlich verlangt, und `security.require_2fa` lässt Passkey-Sessions durch.
Eine reine Passwort-Session eines Admins ohne TOTP bleibt unter der Richtlinie
weiterhin auf das Profil beschränkt (dort sind auch die Passkeys verwaltbar).

**Passwort (+ TOTP) bleibt immer verfügbar.** Den letzten Passkey zu löschen
ist erlaubt; man kann sich nicht aussperren.

## Entscheidungen

- `userVerification: 'required'` (Registrierung und Anmeldung): der Passkey
  ersetzt Passwort **und** zweiten Faktor; ohne UV wäre er nur Besitz, also
  ein Faktor. Plattform-Authenticatoren und Passwort-Manager verifizieren
  ohnehin; Sicherheitsschlüssel brauchen eine PIN (der Browser fordert zur
  Einrichtung auf).
- `residentKey: 'required'` für die benutzernamenlose Anmeldung.
- `attestation: 'none'`, Algorithmen fest EdDSA/ES256/RS256.
- Zähler: Rückschritt oder Stillstand (> 0) wird abgelehnt; das Hochsetzen
  ist ein Compare-and-Set-UPDATE, zwei parallele Assertions mit gleichem
  Zähler gewinnen nicht beide. Authenticatoren ohne Zähler (immer 0) gehen.
- Passwort-Lockout gilt nicht für Passkeys (nicht ratbar; sonst könnte ein
  Angreifer per falscher Passwörter auch die Passkey-Anmeldung sperren).
  Schutz über Rate-Limit.

## Profil (`/profile`, Karte „Passkeys“)

Alle unter `/api/v1/profile/passkeys`, nur Browser-Session, CSRF,
Rate-Limit pro Benutzer:

- `GET /` → `{ available, origin, reauth_required, max, passkeys[] }`
  (Name, angelegt, zuletzt benutzt, synchronisiert; kein Schlüssel, keine ID).
- `POST /register/options { password? }` → Erstellungsoptionen
  (`excludeCredentials` = vorhandene). Challenge in der Session (3 min,
  einmalig, an den Benutzer gebunden).
- `POST /register { name, response }` → speichert; Aktivität `passkey_added`.
- `POST /:id/delete { password? }` → nur eigene; Aktivität `passkey_removed`.

Re-Auth für Hinzufügen/Entfernen: Anmeldung jünger als 5 min **oder**
aktuelles Passwort im Request (frischt das Fenster auf). Sonst 403
`REAUTH_REQUIRED`, die Karte blendet dann das Passwortfeld ein.
Höchstens 20 Passkeys pro Konto.

## Tests

- `tests/admin_passkeys.test.js`, `tests/admin_passkeys_service.test.js` —
  echte Attestation/Assertion aus einem Software-Authenticator
  (`tests/helpers/softWebauthn.js`, ES256, CBOR), geprüft von der
  unveränderten Bibliothek.
- `tests/e2e/scenarios/04-passkey.js` — Chromium mit virtuellem
  Authenticator (CDP `WebAuthn`): Registrieren, benutzernamenlos anmelden,
  entfernen, Passwort-Login danach. Läuft gegen den Hostnamen aus
  `GC_BASE_URL` (CI: `http://localhost:3000`).
