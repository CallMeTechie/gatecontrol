# Aurora als einziges Theme (Release A)

Status: in Umsetzung (Branch `feat/aurora-only`, ab master 1.125.1). Verbindlich.
Auftrag des Maintainers: „alle Themes außer Aurora entfernen, Aurora soll einzig
verbleibendes Theme sein“. Folge-Release B (docs/feature-release-b.md) baut neue
Oberflächen nur noch für Aurora.

## Ausgangslage (geprüft)

- `templates/{default,pro,aurora}/` mit je 43 Dateien, gewählt über
  `res.locals.theme` (src/middleware/locals.js: `user.theme` > Einstellung
  `default_theme` > `GC_DEFAULT_THEME`; route-auth in src/app.js mit eigener Kopie).
- **Aurora ist kein eigenständiges Stylesheet**: `templates/aurora/layout.njk`
  lädt `/css/pro.css` + `/css/aurora.css`; `templates/aurora/pages/login.njk`
  lädt dagegen `/css/app.css` (Default-CSS). `app.css` ist das Default-Theme.
- Fehlerbild beim Maintainer: persönliches Theme `aurora`, globale Einstellung
  `default_theme = pro` → die Login-Seite (ohne Session) zeigt Pro.
- JS mit Theme-Verzweigungen: u. a. app.js, dashboard.js, settings.js, profile.js,
  users.js, zones-page.js, waf.js (grep `aurora|'pro'|theme`).
- 35 Testdateien referenzieren Themes (Render-Schleifen über alle drei Themes,
  Tail-Block-Verträge für CSS in app.css/pro.css/aurora.css).

## Ziel

1. Einziges Theme ist Aurora. `templates/default/` und `templates/pro/` werden
   gelöscht. Die Verzeichnisstruktur `templates/aurora/…` bleibt (keine
   Massenumbenennung, kleinerer Diff); `res.locals.theme` ist konstant `'aurora'`
   (für Admin-Seiten, route-auth und Fehlerseiten).
2. CSS: `pro.css` bleibt als Basis-Stylesheet von Aurora (Umbenennen oder
   Zusammenführen mit aurora.css ist **nicht** Teil dieses Releases). `app.css`
   wird entfernt, sobald keine Aurora-Seite, Portal-, route-auth-, Integrations-
   (midea/skoda/smarthome) oder Fehlerseite es mehr lädt. Alle Aurora-Seiten, die
   heute `app.css` laden (mindestens login, login-2fa, route-auth-login – prüfen),
   laden `pro.css` + `aurora.css` und sehen aus wie der Rest von Aurora
   (Schriften aus layout.njk: Bricolage Grotesque / Hanken Grotesk / JetBrains Mono).
   Stile, die nur in app.css existierten und von Aurora-Seiten gebraucht werden,
   wandern in aurora.css (am Ende, eigener Abschnitt). Blöcke `hs-`, `tg-`, `zn-`,
   `sec-`, `wf-`, `two-fa` usw. nicht verlieren – vorher prüfen, ob Aurora sie aus
   pro.css bekommt.
3. Einstellungen: Theme-Auswahl verschwindet aus der Oberfläche (Einstellungen →
   Darstellung „Standard-Theme“, Profil „Persönliches Theme“, ggf. Benutzerverwaltung).
   `PUT /api/v1/settings/default-theme` antwortet `410 { ok:false, code:'THEME_REMOVED' }`;
   ein `theme`-Feld in Profil-/Benutzer-APIs wird ignoriert (kein Fehler).
   `GET` der Darstellungseinstellungen liefert `defaultTheme: 'aurora'` weiter
   (Abwärtskompatibilität).
4. Migration **v75 `aurora_only`** (nur SQL): `UPDATE settings SET value='aurora'
   WHERE key='default_theme'`; `UPDATE users SET theme='aurora' WHERE theme IS NOT NULL`.
   Spalte `users.theme` bleibt (kein DROP).
5. `GC_DEFAULT_THEME` wird ignoriert (config/default.js: Kommentar; INSTALL/README
   aktualisieren, falls erwähnt). Der Host hat `GC_DEFAULT_THEME=default` in der
   `.env` – das darf nichts mehr bewirken.
6. JS: Theme-Verzweigungen auf den Aurora-Pfad reduzieren, tote Zweige entfernen.
   Keine Verhaltensänderung für Aurora.
7. i18n: Schlüssel, die nur die Theme-Auswahl betreffen, dürfen bleiben oder
   entfallen; **neue** Schlüssel nicht ans Dateiende hängen, wenn Tail-Block-Tests
   das verbieten (siehe tests/*_ui_static, *_i18n).
8. Tests: Render-Schleifen auf Aurora reduzieren, Default-/Pro-spezifische Tests
   löschen, Tail-Block-Verträge auf aurora.css/pro.css anpassen. Neu:
   Test, dass `templates/default` und `templates/pro` nicht mehr existieren; Test,
   dass login/login-2fa/route-auth-login `pro.css` + `aurora.css` laden und kein
   `app.css`; Test, dass die Login-Seite unabhängig von `default_theme` und
   `GC_DEFAULT_THEME` Aurora rendert; Migrationstest v75.
9. E2E (/root/gc-wt/e2e): Harness läuft nur noch mit `aurora`; bestehende
   Szenarien in Aurora grün (zones_r3, hsts_real, tls_real, discovery, fab,
   secopt, waf, waf_real, admin_2fa zuletzt). Screenshots von Login, 2FA-Login,
   Dashboard, Zonen, Einstellungen, route-auth-Login zur Sichtprüfung.

## Nicht Teil

Neue Funktionen (Release B), Umbenennen von pro.css, Zusammenlegen der CSS-Dateien,
Änderungen am Portal-Design (`templates/portal`, eigenes portal.css).
