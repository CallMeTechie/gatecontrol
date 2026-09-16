# Browser-Tests (tests/e2e)

Der Satz, der in der CI läuft: Anmeldung inklusive zweitem Faktor, Zonen-Seite,
Sicherheitsseite. Gegen eine echte App mit einer frisch aufgebauten
Test-Datenbank, ohne Caddy und ohne WireGuard.

```
seed.js                 Migrationen + Fixtures (Zone mit 3 Hosts, 2 Gateways,
                        Admin mit und ohne zweiten Faktor) → e2e-fixtures.json
run.js                  Playwright-Treiber: meldet an, fährt die Szenarien,
                        schreibt Screenshots, druckt einen JSON-Bericht
scenarios/01-login.js   Anmeldung, falsches Passwort, TOTP-Zweitfaktor
scenarios/02-zones.js   /routes: Zonenliste, Suche, Domain-Dialog, 400 px
scenarios/03-security.js /security: Prüfungen gegen die API, hell/dunkel, 400 px
```

## Ablauf

```bash
export NODE_ENV=test
export GC_DATA_DIR=/tmp/gc-e2e GC_DB_PATH=/tmp/gc-e2e/gatecontrol.db
export GC_CADDY_DATA_DIR=$GC_DATA_DIR/caddy GC_BACKUP_DIR=$GC_DATA_DIR/backups
export GC_DNS_HOSTS_FILE=$GC_DATA_DIR/dns/peers.hosts
export GC_ADMIN_USER=e2e_admin GC_ADMIN_PASSWORD='E2eTest!Pass123'
# EIN Schlüsselpaar für Seed UND App: das TOTP-Geheimnis des Fixture-Benutzers
# wird mit GC_ENCRYPTION_KEY verschlüsselt abgelegt. Zwei verschiedene
# Schlüssel und der zweite Faktor schlägt fehl, ohne dass es danach aussieht.
export GC_SECRET=$(openssl rand -hex 32) GC_ENCRYPTION_KEY=$(openssl rand -hex 32)

node tests/e2e/seed.js
node src/server.js &
node tests/e2e/run.js all          # oder: login zones security
```

`run.js` braucht `playwright` im Modulpfad. Das Projekt hängt **nicht** davon
ab (package.json/package-lock bleiben unverändert); in der CI kommt es aus dem
Job-Container `mcr.microsoft.com/playwright:v1.63.0-noble` plus
`npm install --no-save --no-package-lock playwright@1.63.0`. Lokal geht auch:

```bash
docker run --rm --network container:<app-container> \
  -v "$PWD":/app:ro -v "$PWD/node_modules":/app/node_modules:ro -v /tmp/gc-e2e:/data \
  -e BASE=http://127.0.0.1:3000 -e GC_DATA_DIR=/data -w /app \
  mcr.microsoft.com/playwright:v1.63.0-noble node tests/e2e/run.js all
```

Ein Szenario ist eine Datei in `scenarios/`, die `(ctx) => ({ name: async
(page) => … })` exportiert. `ctx` bringt `BASE`, `FIXTURES`, `step`, `login`,
`api`, `visible`, `waitIdle`, `shot`, `allow`. Der Lauf endet mit Exit 1,
sobald ein Schritt fehlschlägt oder die Seite einen Konsolenfehler, einen
Skriptfehler oder eine Antwort ≥ 400 erzeugt hat; erwartete Antworten trägt
das Szenario mit `allow(...)` wieder aus.

## Was hier absichtlich nicht geprüft wird

* **Beschriftungen.** Texte ändern sich (Strang W1 der Welle 2 arbeitet
  gerade daran). Die Szenarien prüfen Auswahlpfade, `data-`-Attribute und
  API-Antworten.
* **Stylesheets.** Welche CSS-Dateien eine Seite lädt, ist hier egal (Strang
  W2 führt sie zusammen). Geprüft wird die Darstellung: rendert die Seite,
  läuft sie bei 400 px nicht über.
* **Echte Daten.** Die grösseren Szenarien des Maintainers (Zonen mit der
  Produktionsdatenbank, TLS-Bestand, WAF, `pages`-Screenshots) laufen
  weiterhin ausserhalb des Repos — sie brauchen eine Kopie der
  Produktionsdatenbank und können in der CI nicht laufen.

## Lizenz

Die App startet in der CI ohne Lizenz, also mit der Community-Ausstattung.
Alles, was zum Anlegen eine Pro-Funktion braucht, macht `seed.js` — dort wirkt
`license._overrideForTest`, weil es derselbe Prozess ist. Die Szenarien lesen
danach und kommen ohne aus. Ein neues Szenario, das schreibt, muss das
berücksichtigen (oder das Seed erweitern).
