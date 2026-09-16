# Tests lokal fahren — so, wie die CI sie fährt

Zwei Releases sind an Tests gescheitert, die lokal grün waren. Beide Male lag
es nicht am Test, sondern an der Umgebung: lokal als `root` mit beschreibbarem
`/data` und ohne `NODE_ENV`, in der CI unprivilegiert mit `NODE_ENV=test`.
Diese Seite beschreibt die Umgebung, die beides angleicht.

## Kurzfassung

```bash
npm ci                    # braucht GH_PACKAGES_TOKEN (siehe unten)
npm test                  # volle Suite
npm run test:file tests/zones_api.test.js tests/dns.test.js   # einzelne Dateien
node --test tests/dns.test.js                                  # auch das geht
```

Ohne Zugriff auf die private Registry:

```bash
npm run test:config-hash-stub   # legt den Test-Stub in node_modules ab
npm test
```

## Was `npm test` einstellt

`package.json` lädt `tests/helpers/test-env.js` über `--require` vor. Das
Modul ist der EINE Ort, an dem die Testumgebung steht, und wird auch von
`tests/helpers/setup.js` benutzt — eine Testdatei ist damit im Suite-Lauf und
im Einzellauf identisch eingestellt.

Es setzt:

* `NODE_ENV=test`. Ohne das wirft `config/default.js` beim Laden
  „GC_SECRET is not set“ — jede Datei, die `helpers/setup.js` nicht benutzt,
  scheitert. Ausserdem schalten `caddyAdminClient` und `caddyConfig` ihre
  Netzaufrufe nur mit `NODE_ENV=test` ab; ein Testlauf ohne sie kann die
  Caddy-Admin-API der Produktion überschreiben.
* Jeden Datenpfad in ein eigenes Temp-Verzeichnis:
  `GC_DATA_DIR`, `GC_DATA_PATH`, `GC_CADDY_DATA_DIR`, `GC_BACKUP_DIR`,
  `GC_DNS_HOSTS_FILE`, `GC_WG_ENDPOINTS_FILE`, `GC_WG_CONFIG_PATH`,
  `GC_DNSMASQ_CONF`, `GC_GATEWAY_LATEST_CACHE`, `GC_DB_PATH`.
  Bis Welle 2 lenkte `helpers/setup.js` nur `GC_DATA_DIR` um; alles andere
  zeigte auf `/data`. Als root fiel das nicht auf.
* Feste, wertlose Testschlüssel (`GC_SECRET`, `GC_ENCRYPTION_KEY`), hohe
  Rate-Limits, `GC_LOG_LEVEL=silent`.

Alles nach dem Muster „nur setzen, wenn nicht gesetzt“: eine Testdatei, die
vor dem `require` ihren eigenen Pfad wählt (z. B. `dashboard_problems`,
`secopt_api`), behält ihn.

`tests/test_env_paths.test.js` prüft die Eigenschaft, nicht die Liste: jeder
aus `config/default.js` aufgelöste Datenpfad muss unter `os.tmpdir()` liegen,
und keine Testdatei darf Dateien im Repo-Baum anlegen. Ein neuer `/data`-Pfad
in `src/` fällt damit auf, ohne dass jemand diese Seite pflegt.

## Unprivilegiert laufen lassen

Die CI checkt als normaler Benutzer aus. Ein Test, der nach `/data` oder
neben die Testdateien schreibt, ist lokal als root unsichtbar. Der lokale
Lauf sollte deshalb ebenfalls unprivilegiert sein — im Container:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp \
  -v "$PWD":/app:ro -v "$PWD/node_modules":/app/node_modules:ro \
  -w /app node:20-alpine \
  node --require ./tests/helpers/test-env.js --test --test-force-exit tests/zones_api.test.js
```

`/app` read-only ist absichtlich strenger als die CI: dort ist die
Arbeitskopie beschreibbar, aber eine Testdatei, die ins Repo schreibt, ist
trotzdem falsch (sie kollidiert mit parallelen Läufen und hinterlässt
Dateien). Sechs Dateien haben genau das getan und legen ihre SQLite-Datei
jetzt unter `os.tmpdir()` an.

Im Arbeitsumfeld des Maintainers macht `/root/gc-wt/nt.sh <worktree>
[dateien…]` genau das; `NT_ROOT=1` davor stellt den alten Lauf als root mit
beschreibbarem `/app` wieder her (nur zum Nachstellen, nie um einen roten Test
grün zu bekommen).

## Das private Paket `@callmetechie/gatecontrol-config-hash`

`src/services/gateways.js` berechnet den Konfigurations-Hash für die Home
Gateways mit `@callmetechie/gatecontrol-config-hash`. Das Paket liegt in der
privaten GitHub-Registry; ohne Token bricht `npm ci` mit **E401** ab — und
zwar komplett, nicht nur für dieses eine Paket.

### Mit Zugriff (Maintainer, CI)

`.npmrc`:

```
@callmetechie:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

Ein GitHub-Token mit `read:packages` genügt. Die CI benutzt dafür das Secret
`GH_PACKAGES_TOKEN`.

### Ohne Zugriff

```bash
npm run test:config-hash-stub
```

`scripts/install-config-hash-stub.js` kopiert `tests/stubs/config-hash/` nach
`node_modules/@callmetechie/gatecontrol-config-hash/`. Der Stub bildet den in
der README des Pakets beschriebenen Algorithmus nach (RFC 8785 JCS mit den
dort genannten Erweiterungen) und liefert für die Konfigurationen dieses
Repos dieselben Hashes wie das echte Paket.

Er ist trotzdem ausdrücklich **kein Ersatz für das echte Paket**:

* `require` wirft ausserhalb von `NODE_ENV=test`.
* Der Installer bricht bei `NODE_ENV=production` ab und überschreibt ein
  bereits installiertes echtes Paket nicht (nur mit `--force`).
* `tests/config_hash_stub_guard.test.js` schlägt fehl, wenn in der CI
  (`CI=true`) der Stub geladen ist — ein Release wird also nie mit dem Stub
  freigegeben.
* `validateWgConfig` wirft; die Funktion wird im Server-Repo nicht benutzt
  und soll auffallen, statt ein falsches „ok“ zu liefern.
* **`src/` bekommt keinen Fallback.** Produktionscode kennt den Stub nicht;
  der Guard-Test prüft auch das.

Wer Hashes gegen ein echtes Gateway vergleicht, braucht das echte Paket.

## Browser-Tests

`tests/e2e/` enthält den Satz, der in der CI läuft (Anmeldung inkl. zweitem
Faktor, Zonen-Seite, Sicherheitsseite) — siehe `tests/e2e/README.md`. Lokal:

```bash
node tests/e2e/serve.js &           # App mit Test-DB auf :3000
npx playwright@1.63 --version       # oder der Container, siehe README
node tests/e2e/run.js all
```

Die grösseren Szenarien des Maintainers (Zonen mit echten Daten, TLS, WAF,
`pages`-Screenshots) laufen weiterhin ausserhalb des Repos gegen eine Kopie
der Produktionsdatenbank; sie können in der CI nicht laufen.

## Restliche bekannte Umgebungsfehler

`docs/testing-baseline.md` führt die Testdateien, die aus Umgebungsgründen
lokal noch fehlschlagen, mit Begründung.
