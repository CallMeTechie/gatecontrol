# Welle 2 nach 1.128.0: Texte, ein Stylesheet, Tests näher an der CI

Status: in Umsetzung (Integrations-Branch `feat/wave2`, ab master 1.128.0). Verbindlich.
Auftrag des Maintainers: Punkte 8, 9, 10 der Vorschlagsliste. Drei parallele Stränge,
die sich strikt aus dem Weg gehen. Aurora ist das einzige Theme; Oberfläche mit `el()`
(kein innerHTML); keine neuen npm-Abhängigkeiten (`npm install` ist lokal wegen des
privaten Pakets nicht möglich, und eine Änderung an `package-lock.json` ohne Netz ist
nicht zu prüfen); keine neuen Lizenzschlüssel; keine Migration nötig.

## W1 — Punkt 8: Texte, Dialoge, Fehlercodes

Ziel: keine englischen Reste und keine nackten Browser-Dialoge mehr in der Oberfläche.

1. **Fehlende Übersetzungen finden und schließen.** Bekannt sind die
   `autobackup.*`-Meldungen in `public/js/settings.js` (z. B. „No backup files yet“),
   die nicht in der `window.GC.t`-Whitelist stehen. Systematisch suchen: englische
   Zeichenketten in `public/js/*.js`, die als Text in die Oberfläche gehen, und
   Schlüssel, die im JS benutzt, aber nicht in der Whitelist stehen. Jeder neue
   Schlüssel kommt als zusammenhängender Block in `de.json` **und** `en.json`
   (Reihenfolge der Blöcke ist frei, siehe Test „contiguous“).
2. **`confirm()`/`alert()` ersetzen.** Die Wiederherstellung (Restore) nutzt noch
   Browser-Dialoge; es gibt bereits einen eigenen Dialog-Baustein (Zonen-Seite:
   `.modal-overlay.zn-dialog`, `confirmDialog` in den E2E-Helfern). Alle verbliebenen
   `confirm(`/`alert(`/`prompt(` in `public/js/**` auf den vorhandenen Baustein
   umstellen; gefährliche Aktionen mit rotem Knopf.
3. **Fehlercodes statt übersetzter Servertexte.** Der WAF-Assistent übersetzt heute
   englische Begründungen des Servers per regulärem Ausdruck im Browser
   (`public/js/waf-assistant.js`). Stattdessen liefert `GET /api/v1/waf/assistant`
   je Regel `reason_code` (+ optional `reason_params`), die Oberfläche übersetzt über
   i18n; `reason` bleibt als Klartext für API-Nutzer erhalten. Gleiches Muster für
   andere Stellen, an denen Servertexte im Browser übersetzt werden (suchen!).
4. Tests: statische Prüfung, dass in `public/js/**` kein `confirm(`/`alert(`/`prompt(`
   mehr vorkommt; dass jeder im JS benutzte `t('…')`-Schlüssel in beiden Sprachdateien
   existiert und (soweit clientseitig) in der Whitelist steht; Browser-Szenario für
   den ersetzten Restore-Dialog und für die Assistenten-Begründungen.

## W2 — Punkt 9: Ein Stylesheet

Ziel: aus `pro.css` (Basis aus der Pro-Zeit), `aurora.css` und den Funktionsdateien
`security.css`, `nav.css`, `ops.css`, `l4-protect.css`, `problems.css` wird **eine**
Datei `public/css/app.css`, ohne sichtbare Änderung.

1. Zusammenführen in sinnvoller Reihenfolge (Tokens/Basis zuerst, dann Komponenten,
   dann Funktionsabschnitte), Abschnittsüberschriften als Kommentare erhalten.
2. **Toten Code entfernen**, aber nur belegbar: Regeln, deren Selektoren in keinem
   Template, keinem JS und keiner Datei des Repos mehr vorkommen (Klassen der
   entfernten Default-/Pro-Themes, `route-auth.css`-Reste usw.). Jede Entfernung muss
   durch eine Suche belegt sein; im Zweifel behalten.
3. `templates/aurora/layout.njk` und die eigenständigen Seiten (Login, 2FA, Fehler,
   route-auth, Portal, Integrationen) laden danach genau eine Datei (Portal behält
   `portal.css`). Alte Dateien löschen.
4. Tests anpassen, die auf einzelne CSS-Dateien und deren Reihenfolge prüfen
   (`*_ui_static`, `aurora_only`, `nav_palette`, `ops_ui_static` …): künftig genügt,
   dass die erwarteten Abschnitte/Klassen in `app.css` stehen und die Klammern
   ausgeglichen sind.
5. **Sichtprüfung ist Pflicht:** Vorher/Nachher-Screenshots aller Admin-Seiten plus
   Login, 2FA, Fehlerseite, route-auth, Portal in Hell und Dunkel und bei 400 px,
   und zwar über das E2E-Szenario `pages` (Label über `PAGES_LABEL`). Abweichungen
   erklären oder beheben.

## W3 — Punkt 10: Tests näher an der CI

1. **Lokale Läufe unprivilegiert.** `/root/gc-wt/nt.sh` läuft als root, die CI nicht —
   dadurch sind zwei Releases an Tests gescheitert, die nach `/data` schreiben.
   `tests/helpers/setup.js` muss **alle** Datenpfade in ein Temp-Verzeichnis lenken
   (heute nur `GC_DATA_DIR`, nicht `GC_CADDY_DATA_DIR`), und `nt.sh` bekommt einen
   Schalter für den unprivilegierten Lauf (bzw. wird standardmäßig unprivilegiert).
2. **Privates Paket ersetzbar.** `@callmetechie/gatecontrol-config-hash` fehlt in
   lokalen Installationen (npm ci bricht mit E401 ab). Ein dokumentierter Weg für
   Entwickler ohne Zugriff: entweder ein klar als solcher gekennzeichneter Stub, den
   ein Skript nur **für Tests** in `node_modules` legt, oder ein Test-Shim. Die
   Produktion darf sich nicht ändern: kein Fallback im `src/`-Code.
3. **Baseline aufräumen.** `/root/gc-wt/baseline-failing-tests.txt` listet 53
   Umgebungsfehler. Ursachen klären und dort beheben, wo die Testumgebung schuld ist
   (fehlende Umgebungsvariablen, Reihenfolgeabhängigkeiten); den Rest dokumentieren.
   Ziel: möglichst kleine Restliste, klar begründet.
4. **Browser-Tests in der CI.** Ein Job, der die vorhandenen Szenarien gegen eine
   App mit Test-Datenbank fährt — ohne neue npm-Abhängigkeiten: Job-Container
   `mcr.microsoft.com/playwright:v1.63.0-noble` (oder `npx playwright@1.63`), App aus
   dem gebauten Image oder per `node src/server.js` mit Test-Umgebung. Wenn der volle
   Satz zu lange dauert: eine kurze Auswahl (Login/2FA, Zonen, Sicherheitsseite) als
   Pflicht, der Rest manuell auslösbar (`workflow_dispatch`). Die Szenarien liegen
   heute außerhalb des Repos unter `/root/gc-wt/e2e/pw/` — der Strang bringt das
   Nötige ins Repo (`tests/e2e/`), ohne die lokale Arbeitsumgebung zu brechen.
5. **Doppelte Sprachschlüssel.** In `en.json` stehen seit Langem drei doppelte
   Schlüssel (`route_auth.method_*`). Prüfung als Test **und** als CI-Schritt, dazu
   die Doppelten entfernen.

## Gemeinsame Regeln

Commits als CallMeTechie mit den beiden Trailer-Zeilen; kein Push; `CHANGELOG.md`
bleibt dem Lead; neue Tests **immer auch unprivilegiert** laufen lassen; nur gezielte
Testdateien, nie die volle Suite; Produktion (`/opt/gatecontrol`, Container
`gatecontrol`/`guacd`) nicht anfassen.
