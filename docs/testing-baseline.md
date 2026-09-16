# Baseline: Testdateien, die aus Umgebungsgründen lokal scheitern

Diese Seite hält fest, welche Testdateien lokal **nicht** wegen eines Fehlers
im Code rot sind, sondern wegen der Umgebung — und warum. Sie gehört gepflegt,
wenn eine dazukommt oder eine verschwindet; sonst wächst wieder eine
Erwartungshaltung („die sind halt rot“), unter der ein echter Fehler
unbemerkt bleibt.

Stand: Welle 2, Strang W3 (nach 1.128.0).

## Vorher: 30 Dateien

Die Liste in `baseline-failing-tests.txt` führte 18 Dateien, die als Ganzes
abbrachen, und 90 Einzeltests aus 12 weiteren Dateien — zusammen 30 Dateien:

```
accessLog activity crypto gatewayHealth ip license_discovery parse_schedule
pihole_license pihole_scope pihole_sync pihole_sync_v5_degrade pihole_sync_v6
pihole_top_clients_blocked pihole_topclients_count_sync rdpMaintenance
route_auth_redirect routesSync webhook
access_windows_license backup bind_host_and_marker_tls caddy_sync_coalesce
caddy_test_isolation configValidate dns l4 migration_discovery
share_links_license share_links_ratelimit traffic
```

## Die Ursache war eine einzige

**`NODE_ENV` war im lokalen Lauf nicht gesetzt.** `config/default.js` erzeugt
das Sitzungsgeheimnis nur mit `NODE_ENV=test` selbst und wirft sonst beim
Laden:

```
Error: GC_SECRET is not set. The entrypoint must generate and export a session secret.
```

Jede Datei, die `src/` lädt, ohne über `tests/helpers/setup.js` zu gehen,
scheiterte daran — und zwar sofort beim `require`, weshalb in den 12
„gemischten“ Dateien auch alle Untertests als *cancelled* mitgerissen wurden.
Die CI setzt `NODE_ENV: test` im Job und hat das nie gesehen.

Behoben in `tests/helpers/test-env.js`: der Vorlader setzt `NODE_ENV=test`
(und die übrigen Grundwerte) für jeden Testprozess, auch für den Einzellauf
einer Datei. Siehe `docs/testing-local.md`.

Zwei weitere Fehlerquellen sind dabei mit aufgeräumt worden, weil der lokale
Lauf jetzt unprivilegiert und mit read-only gemountetem Repo läuft:

* Sechs Dateien legten ihre SQLite-Datei neben den Testdateien an
  (`tests/test-activity-<ts>.db` …), `accessLog` sein Logverzeichnis.
  Jetzt unter `os.tmpdir()`. Nebenwirkung: parallele Läufe kollidieren nicht
  mehr über `tests/test-backup.db`.
* `setup.js` lenkte nur `GC_DATA_DIR` um; `GC_CADDY_DATA_DIR`,
  `GC_BACKUP_DIR`, `GC_DNS_HOSTS_FILE` und die übrigen zeigten weiter auf
  `/data`. Als root fiel das nicht auf, unprivilegiert schon.

`tests/test_env_paths.test.js` hält beides fest.

## Nachher: keine

Alle 30 Dateien laufen unprivilegiert durch:

```
docker run --rm --user 1000:1000 -e HOME=/tmp -v <worktree>:/app:ro \
  -v <node_modules>:/app/node_modules:ro -w /app node:20-alpine \
  node --require ./tests/helpers/test-env.js --test --test-force-exit <dateien…>
```

→ 30 Dateien, 275 Tests, 0 Fehlschläge, 0 abgebrochene.

## Was weiterhin Zugriffe braucht

Kein Test fällt mehr aus Umgebungsgründen aus, aber zwei Dinge muss man haben:

| Braucht | Betrifft | Ohne das |
| --- | --- | --- |
| Zugriff auf die private Registry (`@callmetechie/gatecontrol-config-hash`) | `config_hash_smoke`, `gateways_hash`, `gateways_getConfig`, `gateway_api_config`, `backend_fingerprint`, `config_hash_stub_guard` — und über `npm ci` faktisch alles | `npm run test:config-hash-stub` legt den Test-Stub ab, danach laufen auch diese Dateien (siehe `docs/testing-local.md`) |
| Node ≥ 20 mit passenden `better-sqlite3`/`argon2`-Binaries | die gesamte Suite | `npm ci` mit derselben Node-Hauptversion wie die CI (20) |

Netz braucht die Suite nicht: DNS-Abfragen werden über
`domains._setResolverForTest` gestellt, Caddy- und WAF-Aufrufe sind unter
`NODE_ENV=test` abgeschaltet.

## Pflege

Wenn eine Datei wieder aus Umgebungsgründen rot wird: hier eintragen, mit der
Ursache und mit dem, was sie bräuchte — nicht in eine Liste ohne Begründung.
Und zuerst prüfen, ob `tests/helpers/test-env.js` der richtige Ort für die
Behebung ist; dann profitieren auch der Einzellauf und alle künftigen Dateien
davon.
