# Home Gateway Companion — Rollout-Plan (2026-04-19)

> **Zweck:** Koordinierter Deploy nach Abschluss von Plan 1-3. Deckt Server-Update (neue Migration + Gateway-Features), Gateway-Image-Release und Community-Rollout ab.

**Revisions:**
- v1.1 (2026-04-19): Devils-Advocate-Review eingearbeitet — Backup ohne sqlite3-CLI (WAL-Checkpoint + cp), Rollback-Sequenz stop→restore→up, Pilot-Gateway-Pre-Rollback-Koordination, Partial-Migration-Recovery, dynamische OLD_VERSION-Ermittlung, Disk-Space-Pre-Flight, Phase-C-WoL-Kriterien verschärft
- v1.2 (2026-04-19): Zweite Devils-Advocate-Runde — CI/CD-Merge-Freeze + exakte-Version-Pin (kein `:latest`), `df` aus Container-Perspektive (nicht Host), `docker-compose.override.yml`-Schutz via separater `docker-compose.rollback.yml`, Planned- vs Emergency-Rollback-Pfade, `DELETE FROM gateway_meta` entfernt (nur enabled=0 reicht), git-basierter OLD_VERSION-Fallback wenn gh fehlt, Manuelle-Monitoring-Scripts für Setups ohne Prometheus/Grafana, Backup-lexikografisch sortiert, Missing-Backup-Guard

**Baseline vor Rollout:**
- Plan 1: `@callmetechie/gatecontrol-config-hash@1.0.0` publiziert ✅
- Plan 2: Server-Repo `gatecontrol` mit Gateway-Peer, APIs, UI, Monitoring
- Plan 3: Neues Repo `gatecontrol-gateway` mit Multi-Arch-Image auf GHCR

**Deploy-Repo:** `/root/gatecontrol-deploy/` — bestehendes Setup, GHCR-Pull + docker-compose

---

## Prerequisites (Pre-Flight)

Bevor Phase A startet, alle Checks müssen grün sein:

| Check | Befehl | Erwartet |
|---|---|---|
| config-hash Package verfügbar | `gh api /users/CallMeTechie/packages/npm/gatecontrol-config-hash -q .name` | `gatecontrol-config-hash` |
| Server-CI grün auf letztem main | `gh run list -R CallMeTechie/gatecontrol --branch main --limit 1 --json conclusion -q '.[0].conclusion'` | `success` |
| Gateway-Image auf GHCR | `gh api /users/CallMeTechie/packages/container/gatecontrol-gateway -q .name` | `gatecontrol-gateway` |
| Gateway-Multi-Arch verfügbar | `docker manifest inspect ghcr.io/callmetechie/gatecontrol-gateway:latest \| grep -E 'amd64\|arm64\|arm/v7' \| wc -l` | `3` |
| DB-Schema-Version korrekt | `docker exec gatecontrol node -e "const db=require('better-sqlite3')('/data/gatecontrol.db'); console.log(db.pragma('user_version', {simple:true}))"` | `35` (Pre-Rollout-Baseline) |
| License-Snapshot gespeichert | `cat /data/license.json` | gültiger Content |
| **Disk-Space für Backup** | `df /data --output=avail \| tail -1` (Bytes) | `>= 3× aktuelle DB-Größe` |
| **`/data/backups/` schreibbar** | `docker exec gatecontrol touch /data/backups/.rw-test && docker exec gatecontrol rm /data/backups/.rw-test` | kein Error |

**Konkreter Disk-Space-Check (MUSS aus Container-Perspektive laufen, nicht Host!):**
```bash
# /data im Container ist der Docker-Volume — NICHT identisch mit /data auf Host
AVAIL_KB=$(docker exec gatecontrol df /data --output=avail | tail -1)
DB_SIZE_BYTES=$(docker exec gatecontrol stat -c%s /data/gatecontrol.db)
DB_SIZE_KB=$((DB_SIZE_BYTES / 1024))
if [ "$AVAIL_KB" -lt "$((DB_SIZE_KB * 3))" ]; then
  echo "FAIL: need 3× DB size (${DB_SIZE_KB}KB × 3) free, have ${AVAIL_KB}KB"
  exit 1
fi
echo "OK: DB=${DB_SIZE_KB}KB, free=${AVAIL_KB}KB"
```

**Wenn ein Check failed:** Stop. Root-Cause beheben, Check erneut laufen.

### Merge-Freeze während Rollout (kritisch wg. Auto-Deploy-CI)

Das Projekt hat CI/CD mit Auto-Deploy-Semantik (`feedback_cicd_deploy_flow.md`): jeder Merge auf `main` baut neues Image, pusht `:latest` nach GHCR. **Wenn während des Rollouts jemand merged, wird `:latest` zu einem anderen Image als geplant**.

**Pre-Rollout — Merge-Freeze:**
```bash
# 1. Team-Kommunikation (Matrix/Slack/Email): "Merge-Freeze bis <END_TIME>"

# 2. Branch-Protection temporär erhöhen (optional, maschinenlesbar)
gh api -X PUT repos/CallMeTechie/gatecontrol/branches/main/protection \
  -f 'required_pull_request_reviews[required_approving_review_count]=99' \
  -f 'enforce_admins=true' 2>/dev/null || echo "Manueller Freeze — Branch-Protection nicht ändertbar"
```

**Exakten Image-Tag pinnen statt `:latest`:**
```bash
# Letzte stabile Version mit Gateway-Features ermitteln
TARGET_VERSION=$(gh release list -R CallMeTechie/gatecontrol --limit 1 --json tagName -q '.[0].tagName')
echo "Rolling out: ghcr.io/callmetechie/gatecontrol:${TARGET_VERSION}"

# In docker-compose.yml temporär pinnen (oder via override, siehe Fix C3)
```

**Post-Rollout — Freeze aufheben:**
```bash
gh api -X PUT repos/CallMeTechie/gatecontrol/branches/main/protection \
  -f 'required_pull_request_reviews[required_approving_review_count]=1' \
  -f 'enforce_admins=false'
# + Team-Kommunikation: "Freeze aufgehoben"
```

### Monitoring-Stack verifizieren (sonst sind Post-Deploy-Alerts Wunschdenken)

```bash
# Prüfe ob /metrics-Endpoint existiert und antwortet (für Prometheus-Scraper)
curl -sf https://gatecontrol.example.com/metrics | head -5 || echo "WARN: /metrics not reachable"

# Falls Grafana/Prometheus nicht existiert: Plan-Sektion "Post-Deploy Monitoring" funktioniert nicht
# Dann: Manual-Check-Scripts vorbereiten (siehe Sektion "Post-Deploy Monitoring")
```

---

## Phase A — Server-Deploy (neue Migration + Gateway-Features)

**Zeitfenster:** außerhalb der Business-Hours, da `ALTER TABLE peers ADD COLUMN` bei großer Peers-Tabelle (>10k Zeilen) ~30s blockierend sein kann.

**Schritt 1 — Backup (ohne sqlite3-CLI-Abhängigkeit):**

Das Server-Alpine-Image enthält `sqlite3` NICHT als CLI — daher Backup via `better-sqlite3` WAL-Checkpoint + `cp`:

```bash
ssh production
cd /opt/gatecontrol-deploy

TS=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="/data/backups/pre-rollout-${TS}.db"

# 1. WAL-Checkpoint (flush alle pending writes aus -wal in Main-DB)
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db');
  db.pragma('wal_checkpoint(FULL)');
  console.log('Checkpoint done, DB size:', require('fs').statSync('/data/gatecontrol.db').size);
"

# 2. Backup via cp (consistent nach Checkpoint)
docker exec gatecontrol cp /data/gatecontrol.db "${BACKUP_FILE}"

# 3. Backup-Validation (Dateigröße > 10KB, nicht 0)
BACKUP_SIZE=$(docker exec gatecontrol stat -c%s "${BACKUP_FILE}")
if [ "$BACKUP_SIZE" -lt 10240 ]; then
  echo "FAIL: Backup too small (${BACKUP_SIZE} bytes) — ABORT ROLLOUT"
  exit 1
fi
echo "Backup OK: ${BACKUP_FILE} (${BACKUP_SIZE} bytes)"

# 4. Integrität prüfen (DB öffenbar, Tabellen lesbar)
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('${BACKUP_FILE}', { readonly: true });
  const rowCount = db.prepare('SELECT COUNT(*) AS n FROM peers').get().n;
  const migVer = db.pragma('user_version', { simple: true });
  console.log('Backup verified — peers:', rowCount, 'schema-version:', migVer);
  if (migVer !== 35) { console.error('Unexpected schema version'); process.exit(1); }
"
```

Erwartet: Ausgabe wie `Backup OK: /data/backups/pre-rollout-20260419-143000.db (1234567 bytes)` und `Backup verified — peers: N, schema-version: 35`.

**Schritt 2 — Image pullen:**
```bash
docker pull ghcr.io/callmetechie/gatecontrol:latest
docker image inspect ghcr.io/callmetechie/gatecontrol:latest --format '{{.Config.Labels}}' | grep version
```

Erwartet: Neue Version (höher als bisherige live-Version).

**Schritt 3 — Deploy:**
```bash
cd /opt/gatecontrol-deploy
docker compose down
docker compose up -d
docker compose logs -f gatecontrol | head -100
```

Erwartet in den Logs: `Running migration 36: add_gateway_support` + `Running migration 37: gateway_meta_last_health` + kein ERROR.

**Schritt 3b — Migration-Integrity-Check (gegen Partial-Failure):**
```bash
# user_version MUSS 37 sein (alle Migrationen angewendet)
SCHEMA_VER=$(docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db', { readonly: true });
  console.log(db.pragma('user_version', { simple: true }));
")
if [ "$SCHEMA_VER" != "37" ]; then
  echo "FAIL: Schema version is $SCHEMA_VER, expected 37 — MIGRATION PARTIAL/FAILED"
  echo "Container logs:"
  docker compose logs --tail 50 gatecontrol
  echo "=> Do NOT proceed to Schritt 4. Go to Rollback-Prozedur 'Partial Migration'."
  exit 1
fi

# Neue Spalten wirklich vorhanden (paranoia-check)
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db', { readonly: true });
  const peerCols = db.prepare(\"PRAGMA table_info(peers)\").all().map(c => c.name);
  const metaCols = db.prepare(\"PRAGMA table_info(gateway_meta)\").all().map(c => c.name);
  if (!peerCols.includes('peer_type')) throw new Error('peers.peer_type missing');
  if (!metaCols.includes('last_health')) throw new Error('gateway_meta.last_health missing — migration 37 failed');
  console.log('Schema verified OK (peer_type + last_health exist)');
"
```

**Falls Migration partial failed** (user_version = 36 stecken geblieben):
→ **Rollback sofort** über die spezielle Prozedur „Partial-Migration-Rollback" (siehe unten). Nicht weitermachen.

**Schritt 4 — Smoke-Tests post-deploy:**
```bash
curl -s https://gatecontrol.example.com/health | jq .
```
Erwartet: `{"ok": true, "db": "ok", "wg": "ok"}`.

```bash
# Existing routes must still work (backwards compat check)
curl -s -o /dev/null -w "%{http_code}\n" https://nas.example.com
```
Erwartet: `200` (oder gewohnter Status) — unverändert zu vor Deploy.

```bash
# Gateway API reachable (even without gateway peers)
curl -s -H "Authorization: Bearer invalid" https://gatecontrol.example.com/api/v1/gateway/config
```
Erwartet: `403` (Invalid token) — nicht `404` (Route nicht gemounted) oder `500`.

**Schritt 5 — Admin-UI Smoke:**
- Login in Web-UI
- Peers-Liste öffnet → bestehende Peers sichtbar
- Routes-Liste öffnet → alle mit `target_kind=peer` (Legacy)
- Dashboard → keine Fehler, keine `needs_repair_gateways`-Banner

**Success-Kriterien Phase A (ALLE müssen erfüllt sein):**
- [ ] Migration 36+37 fehlerfrei gelaufen (Logs)
- [ ] `/health` gibt 200 zurück
- [ ] Mindestens 3 existierende Routes antworten mit unverändertem Status
- [ ] Web-UI rendert ohne Fehler
- [ ] Keine neuen ERROR-Logs in letzten 5 Minuten

---

## Phase B — Gateway-Image sichtbar machen

**Schritt 1 — GHCR-Paket-Sichtbarkeit:**
```bash
gh api /users/CallMeTechie/packages/container/gatecontrol-gateway --jq '.visibility'
```
Falls `private`: entscheiden ob `public` gewünscht (hängt von Open-Source-Strategie ab). Memory `project_open_source.md` sagt: alle Projekte Open Source → sollte `public` sein.

```bash
gh api -X PATCH /user/packages/container/gatecontrol-gateway -f visibility=public
```

**Schritt 2 — README-Hinweis auf Hauptrepo:**
Im `gatecontrol`-Repo README ergänzen:
```markdown
## Home Gateway Companion

For LAN-to-VPN bridging without WireGuard on every device, see the
[Home Gateway companion](https://github.com/CallMeTechie/gatecontrol-gateway)
— a Docker container that routes HTTP/TCP + Wake-on-LAN via a single
WireGuard tunnel.
```

Commit mit `docs: add Home Gateway companion reference`.

**Success-Kriterien Phase B:**
- [ ] GHCR-Paket public (bei Open-Source-Ziel)
- [ ] README verlinkt Gateway-Repo
- [ ] Gateway-Repo README erklärt Quick-Start

---

## Phase C — Pilot-Installation (1-2 User)

**Ziel:** Gateway in realem Heimnetz validieren bevor Community-Announcement.

**Setup beim Piloten:**
1. Admin-UI → Peers → „Home Gateway" → Erstellen
2. `gateway.env` herunterladen
3. Pilot lädt Image + legt Compose an:
   ```bash
   mkdir -p /opt/gatecontrol-gateway/config
   cp ~/Downloads/gateway-<id>.env /opt/gatecontrol-gateway/config/gateway.env
   curl -L https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml \
     -o /opt/gatecontrol-gateway/docker-compose.yml
   cd /opt/gatecontrol-gateway && docker compose up -d
   ```
4. Admin legt 2-3 Gateway-Routes an (z.B. NAS-UI, Plex, RDP)
5. Test-Requests:
   - HTTP: `curl -sI https://nas.<pilot-domain>/` → erwartet 200 (oder NAS-eigener Status)
   - RDP: RDP-Client → `<pilot-domain>:<mapped-port>` → Login-Screen
   - WoL: NAS schlafen legen, Request → Device wakes + serviert

**Beobachtung über 48h:**
- Pilot meldet Gateway-Offline-Events? (Flap-Count in Gateway-Meta-Tabelle)
- Server-Logs zeigen ungewöhnliche Heartbeat-Fails?
- Gateway-Container-Logs zeigen OOMs, Crashes, Restarts?
- Irgendwelche CPU/Memory-Peaks auf Pilot-Host?

**Success-Kriterien Phase C (VERSCHÄRFT — Gateway ist nur bei funktionierendem WoL ein Produkt-Upgrade gegenüber normalem Peer):**

- [ ] **Uptime:** 48h Pilot-Betrieb ohne ungeplanten Gateway-Container-Restart (verifiziert via `docker inspect --format '{{.RestartCount}}' gateway`)
- [ ] **Flap-Rate:** `gateway_status_flap_count_1h` durchgehend ≤ 1 (maximal 1 Status-Transition/Stunde)
- [ ] **HTTP-Proxy:** ≥ 30 erfolgreiche HTTP-Request-Zyklen durch Gateway über 48h (Logs via Caddy access-log filtern auf Gateway-Domain)
- [ ] **TCP-Proxy:** Mindestens 1 TCP-Session (z. B. RDP, SSH) läuft über 10+ Minuten ohne Abbruch
- [ ] **WoL (critical):** Mindestens **5 erfolgreiche WoL-Zyklen** über mindestens **2 verschiedene Target-Devices**. Pro Zyklus:
  - Target vor Test explizit in Sleep-Mode versetzt (via Energiesparmodus / `shutdown /h`)
  - Request triggert WoL → Device wacht → HTTP/TCP-Response kommt durch
  - Dokumentierte Messpunkte: `elapsed_ms` aus Gateway-Response je Test (< 60s akzeptabel, > 120s blockiert Phase D)
- [ ] **Config-Sync:** Admin ändert Route-Config 3× während Pilot läuft → jede Änderung innerhalb von 10 Minuten (Hybrid-Pull) beim Gateway angekommen + angewendet (Logs prüfen)
- [ ] **Hash-Mismatch:** Server-Logs `grep "Hash mismatch"` findet **0 Events** während 48h (sonst → Critical, stoppt Phase C)
- [ ] Keine Critical-Issues im GitHub-Issue-Tracker des Gateway-Repos
- [ ] Pilot-User-Feedback explizit dokumentiert (Was funktionierte out-of-the-box? Was brauchte Recherche? Pain-Points?)

---

## Phase D — Community-Rollout

Erst nach erfolgreicher Phase C.

**Announcement-Template:**
```markdown
# Home Gateway Companion jetzt verfügbar

Ein neuer Weg, ganze Heimnetze über einen einzigen WireGuard-Tunnel
zu erschließen — ohne WireGuard auf Endgeräten.

- **Multi-Arch-Image:** amd64, arm64, armv7 (Raspberry Pi!)
- **Features:** HTTP/TCP Reverse-Proxy, Wake-on-LAN, auto-sync mit GateControl
- **Security:** non-root, cap_drop ALL, read-only FS
- **Deployment:** Pi / VM / Synology DSM 7.2+ / Unraid / QNAP

Setup in 5 Minuten: https://github.com/CallMeTechie/gatecontrol-gateway#quick-start
Migration von docker-wireguard-go: https://github.com/.../migration-from-dwg.md
```

Ausspielen über:
- GitHub Release-Description von `gatecontrol-gateway@v1.0.0`
- Server-CHANGELOG des nächsten Server-Release
- Falls existent: Discord/Matrix/Mailing-List

---

## Post-Deploy Monitoring (alle Phasen)

**Zwei Modi je nach Infrastruktur:**

### Modus A — Automatisches Monitoring (wenn Prometheus/Grafana existiert)

Verifizieren via `curl -sf https://gatecontrol.example.com/metrics` (siehe Pre-Flight).

| Metrik | Alarm-Schwelle | Quelle |
|---|---|---|
| `gateway_online_count` | < `gateway_total_count` über 10 min | Server `/metrics` |
| `gateway_flap_count_1h` | > 4 pro Gateway | Server Activity-Log |
| `gateway_heartbeat_age_p99_seconds` | > 120s | Server Prometheus |
| Server HTTP 5xx rate | > 1% | Caddy Access-Log |
| DB size wachstum | > 10%/Tag | `du -sh /data/` |
| Config-Hash-Mismatch-Count | > 0 (sollte NIE passieren) | Server Logs grep |

### Modus B — Manuelle Post-Deploy-Checks (wenn kein Prometheus/Grafana)

Nutze diese Scripts 1× pro Stunde in den ersten 24h, dann 1× pro Tag in den nächsten 7 Tagen:

**Gateway-Online-Status:**
```bash
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db', { readonly: true });
  const now = Date.now();
  const rows = db.prepare(\"SELECT p.name, gm.last_seen_at FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id\").all();
  for (const r of rows) {
    const ageS = Math.round((now - r.last_seen_at) / 1000);
    const status = ageS < 180 ? 'ONLINE' : 'OFFLINE';
    console.log(\`\${status}: \${r.name} (last_seen: \${ageS}s ago)\`);
  }
"
```

**Hash-Mismatch-Scan (kritisch):**
```bash
docker compose logs --since 1h gatecontrol 2>&1 | grep -c "Hash mismatch" || echo "0"
# Erwartet: 0. Jeder Treffer ist Critical.
```

**Server HTTP-Error-Rate:**
```bash
docker exec gatecontrol sh -c "tail -10000 /var/log/caddy/access.log 2>/dev/null | awk -F'\"status\":' 'NR>1 {split(\$2, a, \",\"); s=a[1]; total++; if (s>=500) err++} END {printf \"5xx: %d/%d = %.2f%%\n\", err+0, total, (err+0)/total*100}'"
# Erwartet: < 1%
```

**DB-Size-Tracking:**
```bash
docker exec gatecontrol stat -c'%n %s' /data/gatecontrol.db | awk '{printf "%s: %.2f MB\n", $1, $2/1048576}'
# Vorher/nachher täglich vergleichen — >10% Zuwachs ist auffällig
```

**Wöchentliche Checks (manuell):**
- Gateway-Container-Image-CVEs (Trivy): sind High/Critical in letzten 7 Tagen aufgetaucht?
- Server CHANGELOG im Konsumenten-Community-Thread: Feedback?
- Migration-Pfad von dwg: hat jemand Feedback gegeben?

---

## Rollback-Prozeduren

### Rollback Phase A (Server)

**Symptome die Rollback auslösen:**
- Migration 36+37 schlägt fehl (Server startet nicht)
- Migration nur teilweise durchgelaufen (`user_version` ≠ 37, siehe Schritt 3b)
- `/health` antwortet 500 für mehr als 2 Minuten
- Bestehende Routes antworten plötzlich 502
- CI-Pipeline zeigt regression-Errors im Release-Commit

**PRE-ROLLBACK (wenn Pilot-Gateways existieren):**

Falls Phase C schon aktiv ist — Pilot-Gateways müssen kontrolliert terminiert werden, sonst Hash-Mismatch-Reload-Loop. Zwei Pfade je nach Dringlichkeit:

#### Entscheidungshilfe: Planned vs Emergency Rollback

| Situation | Pfad |
|---|---|
| Prod antwortet noch, Issue nicht User-sichtbar, Admin hat Zeit | **Planned** (30 min Vorlauf) |
| Prod-Downtime läuft, User-Complaints, jeder Minute zählt | **Emergency** (sofort) |
| Weniger als 3 Pilots, direkter Kontakt möglich | **Planned** OK |
| > 3 Pilots oder nicht erreichbar | **Emergency** + Post-Mortem-Mail |

#### Pfad A — Planned Rollback (30 min Vorlauf)

```bash
# 1. Alle Pilot-Gateways identifizieren
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db', { readonly: true });
  const gws = db.prepare(\"SELECT p.id, p.name FROM peers p JOIN gateway_meta gm ON gm.peer_id=p.id\").all();
  console.log(JSON.stringify(gws, null, 2));
"

# 2. Pilot-User benachrichtigen (MANUELL — 30 min vor Rollback per Email/Matrix):
#    'Wir rollen Server auf alte Version zurück. Bitte Dein Gateway vorerst stoppen:
#     cd /opt/gatecontrol-gateway && docker compose down'

# 3. Gateway-Peers serverseitig DEAKTIVIEREN (nicht löschen — Tokens bleiben für Re-Enable)
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db');
  const res = db.prepare(\"UPDATE peers SET enabled=0 WHERE peer_type='gateway'\").run();
  console.log('Disabled', res.changes, 'gateway peers (tokens preserved)');
"
# HINWEIS: Kein DELETE FROM gateway_meta — das Backup-Restore überschreibt ohnehin alle
# diese Daten. Wenn später doch roll-forward gewollt: UPDATE peers SET enabled=1 reicht.
```

#### Pfad B — Emergency Rollback (sofort, keine Wartezeit)

```bash
# 1. Sofort deaktivieren (kein User-Kontakt vorher)
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db');
  db.prepare(\"UPDATE peers SET enabled=0 WHERE peer_type='gateway'\").run();
"

# 2. Post-Rollback: Benachrichtigung an alle Pilots (Subject: 'Unplanned Rollback')
# Template:
# ------
# Wir mussten Gateway-Features unplanned zurückrollen wegen <Issue-Beschreibung>.
# Bitte führe jetzt aus:
#   cd /opt/gatecontrol-gateway && docker compose down
# Wir melden uns, sobald Gateway-Features wieder verfügbar sind.
# ------

# 3. Sofort mit Rollback-Sequenz fortfahren (siehe unten)
```

**Rollback-Sequenz (richtige Reihenfolge: STOP → RESTORE → START):**

```bash
ssh production
cd /opt/gatecontrol-deploy

# 1. Ermittle letzte Pre-Gateway-Version dynamisch — zwei Pfade je nach Prod-Setup:

# Pfad A: gh CLI verfügbar (preferred, aktuelle Daten)
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  OLD_VERSION=$(gh api repos/CallMeTechie/gatecontrol/releases --paginate --jq '
    .[] | select(.tag_name | startswith("v")) | .tag_name
  ' | while read tag; do
    gh api "repos/CallMeTechie/gatecontrol/contents/src/db/migrations.js?ref=${tag}" \
      -q .content 2>/dev/null | base64 -d 2>/dev/null | grep -q 'version: 36' || echo "${tag#v}"
  done | head -1)
fi

# Pfad B: git-Repo lokal verfügbar (fallback wenn gh fehlt oder nicht auth)
if [ -z "$OLD_VERSION" ] && [ -d /opt/gatecontrol/.git ]; then
  cd /opt/gatecontrol
  OLD_VERSION=$(git log --all --tags --format="%H %D" \
    | grep -oE 'tag: v[0-9]+\.[0-9]+\.[0-9]+' \
    | sed 's/tag: v//' \
    | sort -rV \
    | while read ver; do
      git show "v${ver}:src/db/migrations.js" 2>/dev/null | grep -q 'version: 36' || {
        echo "${ver}"
        break
      }
    done)
  cd /opt/gatecontrol-deploy
fi

# Pfad C: manueller Fallback — in gespeicherter Datei (vom letzten erfolgreichen Rollout geschrieben)
if [ -z "$OLD_VERSION" ] && [ -f /opt/gatecontrol-deploy/.last-pre-gateway-version ]; then
  OLD_VERSION=$(cat /opt/gatecontrol-deploy/.last-pre-gateway-version)
fi

if [ -z "$OLD_VERSION" ]; then
  echo "FAIL: konnte Pre-Gateway-Version nicht ermitteln."
  echo "Manuell: gh release list -R CallMeTechie/gatecontrol (oder https://github.com/CallMeTechie/gatecontrol/releases)"
  echo "Dann: OLD_VERSION=1.x.y (ohne v-Prefix) und script erneut ausführen"
  exit 1
fi
echo "Rolling back to: ghcr.io/callmetechie/gatecontrol:${OLD_VERSION}"

# 2. Container STOPPEN (kein write mehr auf DB)
docker compose stop gatecontrol
# Warte auf sauberen Shutdown
while docker ps --filter name=gatecontrol --format '{{.Status}}' | grep -q Up; do
  sleep 1
done

# 3. Backup-Datei ermitteln (lexikografisch neuestes pre-rollout-*.db — robust gegen mtime-Probleme)
BACKUP_FILE=$(docker run --rm -v gatecontrol_gatecontrol-data:/data alpine \
  sh -c "ls /data/backups/pre-rollout-*.db 2>/dev/null | sort -r | head -1")
if [ -z "$BACKUP_FILE" ]; then
  echo "FAIL: kein pre-rollout-*.db Backup gefunden in /data/backups/"
  echo "Rollback NICHT möglich ohne Backup. Abort."
  docker compose up -d  # Container wieder hochfahren mit neuer Version — Rollback gescheitert
  exit 1
fi
echo "Restoring from: ${BACKUP_FILE}"

# 4. DB-Restore direkt im Volume (Container ist gestoppt, kein Lock)
docker run --rm -v gatecontrol_gatecontrol-data:/data alpine \
  cp "${BACKUP_FILE}" /data/gatecontrol.db

# WAL/SHM-Files entfernen (gehören zur alten Live-DB, nach Restore stale)
docker run --rm -v gatecontrol_gatecontrol-data:/data alpine \
  sh -c "rm -f /data/gatecontrol.db-wal /data/gatecontrol.db-shm"

# 5. Override — SICHERE Handhabung (existierendes docker-compose.override.yml nicht überschreiben!)
if [ -f docker-compose.override.yml ]; then
  cp docker-compose.override.yml "docker-compose.override.yml.pre-rollback-$(date +%s)"
  echo "Existing docker-compose.override.yml backed up."
fi

# Separate Rollback-Override nutzen (statt override.yml zu ersetzen)
cat > docker-compose.rollback.yml <<EOF
services:
  gatecontrol:
    image: ghcr.io/callmetechie/gatecontrol:${OLD_VERSION}
EOF
docker pull "ghcr.io/callmetechie/gatecontrol:${OLD_VERSION}"

# 6. Mit alter Version starten (zusätzliche -f für rollback-override)
docker compose -f docker-compose.yml -f docker-compose.rollback.yml up -d

# 7. Verifikation
sleep 5
curl -s https://gatecontrol.example.com/health | jq .
docker exec gatecontrol node -e "
  const db = require('better-sqlite3')('/data/gatecontrol.db', { readonly: true });
  console.log('Schema version:', db.pragma('user_version', { simple: true }));
"
# Erwartet: schema version <= 35

# 8. Pre-Gateway-Version notieren für zukünftige Rollbacks
echo "${OLD_VERSION}" > /opt/gatecontrol-deploy/.last-pre-gateway-version

# 9. WICHTIG: Merge-Freeze NICHT aufheben solange Rollback-State aktiv — first fix root cause
echo "REMINDER: Merge-Freeze bleibt aktiv bis Ursache analysiert + Fix deployed."
```

**Nach erfolgreichem Rollback:**
- Root-Cause-Analyse → Fix vorbereiten
- Fix deployen (erneute Phase A mit gefixter Version)
- `docker-compose.rollback.yml` löschen, Merge-Freeze aufheben

### Rollback für Partial-Migration (user_version zwischen 35 und 37)

Falls Schritt 3b „Migration partial failed" gemeldet hat:

```bash
# 1. Container stoppen
docker compose stop gatecontrol

# 2. Backup direkt wiederherstellen (alte pre-Migration Schema)
docker run --rm -v gatecontrol_gatecontrol-data:/data alpine \
  sh -c "cp /data/backups/pre-rollout-*.db /data/gatecontrol.db && rm -f /data/gatecontrol.db-wal /data/gatecontrol.db-shm"

# 3. Alte Version-Override setzen (wie oben) + up
# ... [siehe regulären Rollback oben, Schritte 5-7]

# 4. Issue an Server-Repo mit Migration-Log für Root-Cause-Analyse
docker compose logs --tail 200 gatecontrol > /tmp/migration-failure.log
gh issue create -R CallMeTechie/gatecontrol \
  --title "Migration 36/37 partial failure in production rollout" \
  --body "$(cat /tmp/migration-failure.log)"
```

### Rollback Phase B (Gateway-Image public)

**Symptom:** Öffentlichkeit stellt Image private wieder her falls Security-Issue entdeckt.
```bash
gh api -X PATCH /user/packages/container/gatecontrol-gateway -f visibility=private
```

### Rollback Phase C (Pilot)

**Pilot stoppt Gateway, Admin löscht Gateway-Peer:**
```bash
# Pilot-seitig
cd /opt/gatecontrol-gateway && docker compose down

# Admin-seitig (Web-UI oder API)
# Löscht Peer + kaskadiert auf gateway_meta
# Routes mit target_peer_id werden auf enabled=0 + Warning-Banner
# → Kein User-Facing-Breakage für andere Routes
```

### Rollback Phase D (Community)

Nicht rollback-bar — Community-Announcements sind irreversibel. Stattdessen: Hotfix-Release mit Warnhinweis.

---

## Known Failure Modes + Responses

| Failure | Detection | Response |
|---|---|---|
| Migration 36 hängt bei großer peers-Tabelle | Server-Start-Timeout | `SQLITE_BUSY` logging → WAL-Mode-Check. Notfall: manuelle Migration via sqlite3-CLI. |
| `.npmrc`-Token nicht gesetzt in Server-CI | Build-Failure `401 unauthorized` | `GH_PACKAGES_TOKEN` Secret im Repo prüfen |
| Gateway-Push-Notification erreicht Gateway nicht | Keine unmittelbare Config-Updates, aber Poll (5 min) hilft | Normal — Hybrid-Pull-Fallback greift |
| Gateway-Container startet nicht — `no-new-privileges` gesetzt | `wg-quick` failed | docker-compose.yml prüfen: `security_opt` darf NICHT gesetzt sein |
| Hash-Mismatch Server ↔ Gateway | Gateway reloadet konstant | **Critical!** config-hash Package-Version auf beiden Seiten prüfen + Reinstall |
| Pilot-User: WoL funktioniert nicht | Gateway ist auf NAT-netzwerk | User auf L2-Bridge-Setup verweisen (docs/deployment) |
| GHCR Image zu groß (>300 MB) | Dockerfile prüfen | Multi-Stage-Copy prüfen, wireguard-go Size-Check |

---

## Cleanup nach erfolgreichem Rollout

Nach ~2 Wochen stabilen Betriebs:
- [ ] Backup-Retention: alte pre-rollout-Backups archivieren (nicht löschen!) 
- [ ] CHANGELOG.md aktualisieren mit Release-Highlights
- [ ] `project_improvement_backlog.md` in Memory updaten: Home Gateway Phase 1+2 done
- [ ] Phase 3 (Device Discovery, Multi-Gateway, IPv6) für V2-Planung aufnehmen

---

## Sign-off

Rollout gilt als abgeschlossen wenn:
1. ✅ Phase A durch (Server live)
2. ✅ Phase B durch (GHCR public, README-Links)
3. ✅ Phase C durch (min. 1 Pilot 48h stabil)
4. ✅ Phase D durch (Community-Announcement raus)
5. ✅ 7 Tage Post-Deploy ohne Rollback-Auslöser

**Verantwortlich:** Repo-Owner (CallMeTechie) — Signoff per CHANGELOG-Commit mit Tag `v<next>`.
