# Home Gateway Companion — Design Spec

**Datum:** 2026-04-18
**Status:** Design approved, ready for implementation plan
**Supersedes:** `docs/superpowers/plans/home-gateway-companion.md` (2025-03-13)
**Server-Baseline:** GateControl v1.39.1

---

## 1. Überblick

### Ziel
Ein neues Companion-Produkt **Home Gateway** (Node.js, eigenes Repo) dient als Always-On-Proxy-Box im Heimnetz. Ein einziger WireGuard-Tunnel erschließt ein ganzes LAN — ohne WireGuard auf den Endgeräten.

### Scope (MVP)
- **HTTP-Reverse-Proxy** für L7-Routen (NAS-UI, Plex, Home-Assistant, etc.)
- **TCP-Port-Forwarding** für L4-Routen (RDP, SSH, DB-Ports)
- **Wake-on-LAN** mit automatischer Trigger bei Backend-Down
- **Hybrid Config-Sync** (Pull + Push-Notification)
- **Config-Datei-Pairing** (Admin lädt `gateway.env` herunter)

### Out-of-Scope (V2+)
- Device Discovery (ARP-Scan)
- Multi-Gateway pro GateControl-Instanz
- Bandwidth-Monitoring pro LAN-Target
- IPv6-Support
- mDNS/Bonjour-Integration
- Load-Tests / Chaos-Tests

### Positionierung vs. docker-wireguard-go
- `docker-wireguard-go` bleibt unverändert (Synology-NAS-Wrapper, keine Breaking Changes)
- `gatecontrol-gateway` ist ein **neues, eigenständiges Produkt** mit eigenem Image

---

## 2. Architektur

```
Internet ─→ GateControl (VPS + Caddy)
              │
              │ WireGuard-Tunnel (10.8.0.x)
              │
              ▼
         Home Gateway (Raspberry Pi / Mini-PC)
              │
              ├─ HTTP-Reverse-Proxy (Tunnel-IP:8080)
              ├─ TCP-Port-Forwarder (dynamische Ports)
              ├─ WoL-Endpoint (POST /api/wol)
              ├─ Management-API (/api/status, /api/health)
              └─ Push-Receiver (POST /api/config-changed)
              │
              │ LAN (192.168.x.x)
              ▼
         NAS / Desktop / Drucker / IoT
```

### Rollentrennung
- **GateControl** ist Single Source of Truth für Routing-Config + Monitoring
- **Gateway** ist stateless (Config kommt immer vom Server, kein lokales DB)
- Kommunikation ausschließlich über den Tunnel (Gateway-API bindet NICHT auf `0.0.0.0`)

---

## 3. GateControl-Server-Änderungen

### 3.1 DB-Migration `026_gateway_support.sql`

```sql
-- Peers: neuer Typ
ALTER TABLE peers ADD COLUMN peer_type TEXT NOT NULL DEFAULT 'regular';
-- Werte: 'regular' | 'gateway'

-- Routes: Target-Discrimination
ALTER TABLE routes ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'peer';
-- Werte: 'peer' | 'gateway'
ALTER TABLE routes ADD COLUMN target_peer_id INTEGER REFERENCES peers(id) ON DELETE SET NULL;
ALTER TABLE routes ADD COLUMN target_lan_host TEXT;
ALTER TABLE routes ADD COLUMN target_lan_port INTEGER;

-- WoL pro Route
ALTER TABLE routes ADD COLUMN wol_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN wol_mac TEXT;

-- Gateway-Metadaten (1:1 zu Peer)
CREATE TABLE gateway_meta (
  peer_id INTEGER PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
  api_port INTEGER NOT NULL DEFAULT 9876,
  api_token_hash TEXT NOT NULL,           -- SHA-256 des Gateway→Server API-Tokens (Server validiert Hash)
  push_token_encrypted TEXT NOT NULL,     -- AES-256-GCM-verschlüsselter Plaintext des Server→Gateway Push-Tokens
                                          -- (Server muss Plaintext kennen, um ihn im X-Gateway-Token-Header zu senden)
  last_seen_at INTEGER,
  last_config_hash TEXT,
  created_at INTEGER NOT NULL
);

-- Constraint: wenn target_kind='gateway', müssen target_peer_id + target_lan_host + target_lan_port gesetzt sein
-- (wird auf Service-Layer in routes.js validiert, nicht als SQL CHECK wegen Kompatibilität mit bestehenden Routes)
```

**Migration ist additiv** — bestehende Routen bekommen `target_kind='peer'` als Default, keine Daten-Wanderung.

### 3.2 Neue Services

**`src/services/gateways.js`** (neu):
- `createGateway(name, apiPort)` → generiert Peer + Gateway-Meta + beide Tokens, liefert `gateway.env`-Content
- `getGatewayConfig(peerId)` → baut JSON-Config aller Routen mit `target_peer_id=peerId`
- `computeConfigHash(config)` → stabile SHA-256 über kanonisierte JSON-Repräsentation
- `notifyConfigChanged(peerId)` → Best-effort POST an Gateway-Push-Endpoint
- `notifyWol(routeId)` → POST an Gateway `/api/wol` mit MAC + LAN-Host + Timeout
- `handleHeartbeat(peerId, stats)` → updated `last_seen_at`
- License-Enforcement: `gateway_peers`, `gateway_http_targets`, `gateway_tcp_routing`, `gateway_wol`

**Erweiterung `src/services/monitor.js`:**
- Down→Up-Transition-Hook triggert `gateways.notifyWol(routeId)` wenn `wol_enabled=1`
- Gateway selbst als spezielles Monitoring-Target (Heartbeat-basiert)

### 3.3 Wiederverwendung
- `src/services/wol.js` **unverändert** — Aufruf nur umstrukturiert, Code identisch
- `src/services/peers.js` — minimale Erweiterung (`createGatewayPeer()` wrapper)

### 3.4 Neue API-Endpoints

`src/routes/api/gateway.js` (neu), Scope: `gateway`
Auth: `Authorization: Bearer <gateway_api_token>` (Token in `api_token_hash` als SHA-256 gespeichert; Server hasht eingehenden Token und vergleicht timing-safe)

| Endpoint | Zweck |
|---|---|
| `GET  /api/v1/gateway/config` | Gateway pollt, bekommt Routes + WoL-Einträge + Config-Hash |
| `GET  /api/v1/gateway/config/check?hash=X` | 304 bei unverändert, 200 bei Change |
| `POST /api/v1/gateway/heartbeat` | Gateway meldet Status, `last_seen_at` Update |
| `POST /api/v1/gateway/status` | rx/tx/active-connections für Dashboard |

### 3.5 Push-Notification (Server → Gateway)

Bei Config-Änderung (Route-Add/Edit/Delete, WoL-Toggle, Gateway-Enable):
```
POST http://<gw-tunnel-ip>:9876/api/config-changed
Headers: X-Gateway-Token: <push_token_plaintext>   # Server entschlüsselt push_token_encrypted aus DB
Body: (leer — ist nur Trigger)
Timeout: 2s, 1 Retry, dann ignore
```

Wenn Push fehlschlägt → nächster Gateway-Poll (max 5 min) zieht Änderung automatisch.

**Token-Trennung:**
- `api_token` (Gateway→Server): vom Gateway gehalten, als SHA-256 in Server-DB → Server validiert Hash
- `push_token` (Server→Gateway): vom Gateway gehalten, verschlüsselt in Server-DB → Server entschlüsselt zum Senden, Gateway validiert eingehenden Token timing-safe
- Beide Tokens werden einmalig bei `createGateway()` generiert und in `gateway.env` geschrieben

### 3.6 Caddy-Config-Builder-Anpassung (`src/services/caddyConfig.js`)

Bei `route.target_kind === 'gateway'`:
- Upstream = Gateway-Peer-IP + Proxy-Port (8080 für L7)
- Injected Headers:
  - `X-Gateway-Target: <lan_host>:<lan_port>`
  - `X-Gateway-Target-Domain: <route.domain>`
- Für L4-Routes: Caddy-L4-Proxy zeigt auf Gateway-Port, Gateway hat eigenen Listener

Bei Gateway-Peer offline: Caddy-Handle liefert Maintenance-Page-Template (`templates/gateway-offline.njk`) statt 502.

### 3.7 API-Token-Scopes

Neuer Scope `gateway` in `VALID_SCOPES` (src/services/tokens.js):
- Darf nur `/api/v1/gateway/*` aufrufen
- Wird in Pairing-Datei (`gateway.env`) ausgeliefert

### 3.8 License-Features

Neue Keys in `COMMUNITY_FALLBACK` (src/services/license.js):
```javascript
gateway_peers: 1,              // Community: 1 Gateway
gateway_http_targets: 3,        // Community: 3 HTTP-Routes hinter Gateway
gateway_tcp_routing: false,     // nur Pro+
gateway_wol: false,             // nur Pro+
```

### 3.9 Monitoring-Integration
- Gateway als spezielles Target mit Health-Check via Heartbeat-Absenz
- Down-Event (3 Fails = 3 min) triggert:
  - Activity-Log: `gateway_offline` mit `peer_name`
  - Email-Alert (`alert_group: system`)
  - Webhook-Event `gateway.offline`
  - Alle abhängigen Routes werden als `degraded` markiert → Caddy liefert Maintenance-Page
- Recovery triggert Alert `gateway_recovered` + Caddy-Config-Regenerierung

### 3.10 UI-Anpassungen (minimal im MVP)
- **Peer-Create-Dialog:** Checkbox „Home Gateway" schaltet API-Port-Feld + Token-Generierung frei
- **Peer-Liste:** Badge `GATEWAY` bei Gateway-Peers
- **Peer-Detail:** Button „Gateway-Config herunterladen" → liefert `gateway.env`
- **Route-Formular:** Wenn Target-Peer ein Gateway → zusätzliche Felder „LAN-Host" + „LAN-Port" + „Wake-on-LAN + MAC"

### 3.11 `gateway.env`-Schema

```bash
# GateControl Home Gateway — Pairing Config
# Generated: 2026-04-18T14:32:00Z
# Peer: homelab-gw (ID: 3)

GC_SERVER_URL=https://gatecontrol.example.com
GC_API_TOKEN=gc_gw_<64-hex>           # Scope: gateway, für Poll/Heartbeat
GC_GATEWAY_TOKEN=<64-hex>              # Erwartet in X-Gateway-Token für Push-Notifications
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
GC_HEARTBEAT_INTERVAL_S=30
GC_POLL_INTERVAL_S=300

# WireGuard-Config inline
WG_PRIVATE_KEY=...
WG_PUBLIC_KEY=...
WG_ENDPOINT=gatecontrol.example.com:51820
WG_SERVER_PUBLIC_KEY=...
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1
```

---

## 4. Gateway-Repository (`gatecontrol-gateway`)

### 4.1 Struktur

```
gatecontrol-gateway/
├── src/
│   ├── index.js                 # Bootstrap + graceful shutdown
│   ├── config.js                # gateway.env-Parser + Validation
│   ├── wireguard.js             # wg-quick up/down, Status via wg show
│   ├── sync/
│   │   ├── poller.js            # Hybrid: Periodic 5min + Push-Trigger
│   │   └── configStore.js       # In-Memory State + Hash + Diff
│   ├── proxy/
│   │   ├── http.js              # Reverse-Proxy auf Tunnel-IP:8080
│   │   ├── tcp.js               # L4-Forwarder, dynamische Listener
│   │   └── router.js            # Domain/Port → LAN-Target Map
│   ├── wol.js                   # sendMagicPacket (identisch Server-wol.js)
│   ├── api/
│   │   ├── server.js            # Express, bindet auf Tunnel-IP
│   │   ├── middleware/auth.js   # X-Gateway-Token (timing-safe)
│   │   └── routes/
│   │       ├── wol.js           # POST /api/wol (Server-getriggert)
│   │       ├── status.js        # GET /api/status
│   │       ├── health.js        # GET /api/health
│   │       └── configChanged.js # POST /api/config-changed (Push-Receiver)
│   └── logger.js                # Pino
├── Dockerfile                   # Multi-stage, Alpine + Node 20
├── docker-compose.example.yml
├── package.json
├── tests/
├── .github/workflows/
└── README.md
```

### 4.2 Dependencies

| Package | Zweck |
|---|---|
| `express` | API-Framework |
| `http-proxy` | HTTP-Reverse-Proxy |
| `axios` | Polling zu GateControl |
| `pino` | Structured Logging |
| `dotenv` | gateway.env laden |

**Bewusst NICHT enthalten:**
- `better-sqlite3` (Gateway ist stateless)
- `helmet`, `csrf` (interne API, nur Token-Auth)

### 4.3 Runtime-Flow

1. **Startup:**
   - Liest `gateway.env`, validiert (Tunnel-IP, RFC1918-Ranges, Required-Keys)
   - Startet `wireguard-go` + `wg-quick up`, wartet auf Handshake
   - Pollt initialen Config von `GET /api/v1/gateway/config`
   - Startet HTTP-Proxy auf `GC_TUNNEL_IP:GC_PROXY_PORT`
   - Startet TCP-Listener dynamisch (pro L4-Route)
   - Startet Management-API auf `GC_TUNNEL_IP:GC_API_PORT`
   - Startet Heartbeat-Ticker (`GC_HEARTBEAT_INTERVAL_S`)

2. **HTTP-Request-Handling:**
   - Request mit Header `X-Gateway-Target: 192.168.1.10:5001`
   - Proxy liest Header, stripped `X-Gateway-*` Header vor LAN-Forward
   - Leitet an LAN-Target
   - Bei ECONNREFUSED + `wol_enabled` → WoL-Trigger + Retry mit Poll

3. **TCP-Request-Handling:**
   - Ein Listener pro L4-Route auf dediziertem Port
   - `net.Socket`-Pipe bidirektional
   - Close-Propagation auf beiden Seiten

4. **Config-Sync (Hybrid):**
   - Periodic Poll alle 5 min mit `GET /config/check?hash=X` (304 bei unverändert)
   - Push-Trigger auf `/api/config-changed` → 500ms Debounce → sofort Full-Poll
   - Config-Reload: Router-Map atomar getauscht, TCP-Listener-Diff (nur geänderte Ports restart)

5. **WoL-Flow (Server-getriggert):**
   - Server `POST /api/wol` mit `{mac, lan_host, timeout_ms}`
   - Gateway validiert MAC gegen Whitelist aus aktueller Route-Config
   - Sendet Magic-Packet auf allen Non-WG-Interfaces (UDP/9)
   - Pollt TCP-Reachability bis Timeout
   - Response: `{success, elapsed_ms}`

### 4.4 Sicherheit

- Management-API bindet **ausschließlich** auf `GC_TUNNEL_IP`, niemals `0.0.0.0` (Startup-Validation)
- LAN-Target-Validation: nur RFC1918 (`10/8`, `172.16/12`, `192.168/16`) + `169.254/16` (link-local)
- Token-Auth: timing-safe Compare via `crypto.timingSafeEqual`
- WoL-MAC-Whitelist: nur MACs die in aktueller Route-Config existieren
- Rate-Limits: `/api/wol` 10/min, `/api/config-changed` 30/min
- Logs enthalten keine Request-Bodies, keine Tokens
- LAN-Target darf nicht identisch mit Tunnel-IP sein (Loop-Schutz)

### 4.5 Container-Image
- Multi-stage Alpine + Node 20
- Finale Image ~80 MB
- `cap_add: [NET_ADMIN]`, `network_mode: host`
- Multi-arch: `linux/amd64`, `linux/arm64`, `linux/arm/v7`

---

## 5. Datenfluss-Beispiele

### 5.1 HTTP-Request auf NAS-UI
```
User → https://nas.example.com
  → Caddy (TLS) → Route{target_kind:gateway, peer_id:3, lan_host:192.168.1.10, lan_port:5001}
  → http://10.8.0.5:8080 mit X-Gateway-Target: 192.168.1.10:5001
  → Gateway liest Header, stripped Gateway-Headers, forwarded an 192.168.1.10:5001
  → NAS response → Gateway → Caddy → User
```

### 5.2 HTTP-Request mit schlafendem Target + WoL
```
1-3. Wie 5.1, bis Gateway-Proxy
4. Gateway: Connect zu 192.168.1.10:5001 → ECONNREFUSED
5. Gateway: wol_enabled=true, wol_mac='AA:BB:CC:DD:EE:FF'
6. Magic-Packet an FF:FF:FF:FF:FF:FF auf LAN-Interface (UDP/9)
7. Poll 192.168.1.10:5001 alle 2s (max 60s)
8. NAS wacht auf → Connect → Request forwarded
→ Bei Timeout: 504 + Maintenance-Page „Gerät startet noch"
```

### 5.3 TCP-Route (RDP auf 13389)
```
User RDP → vps.example.com:13389
  → Caddy L4 → proxy 10.8.0.5:13389
  → Gateway TCP-Listener:13389 → net.Socket zu 192.168.1.30:3389
  → bidirektionaler Stream-Pipe
```

### 5.4 Config-Änderung (Hybrid Pull + Push)
```
1. Admin ändert Route-Target im UI → Server-DB Update
2. Server: gateways.notifyConfigChanged(peerId=3)
   → POST http://10.8.0.5:9876/api/config-changed mit X-Gateway-Token
3. Gateway: Token-Validation → 200 OK → 500ms Debounce → GET /api/v1/gateway/config
4. Server antwortet mit neuer Config + Hash
5. Gateway: Hash-Diff → atomarer Router-Map-Swap, TCP-Listener-Diff
→ Push fehlschlägt: nächster Poll (max 5min) zieht Änderung
```

### 5.5 Gateway geht offline
```
1. Gateway-Host crasht
2. Server-Monitor: 3 Heartbeat-Fails (3min) → Status 'offline'
3. Server: Activity-Log + Email-Alert + Webhook gateway.offline
4. Caddy-Config-Rebuild: Routes mit peer_id=3 → Maintenance-Page
5. User → nas.example.com → „Home Gateway offline seit 14:32"
6. Gateway recovery → Heartbeat wieder da → Status 'online' → Caddy regenerated
```

---

## 6. Error-Handling & Invarianten

### 6.1 Gateway-seitige Fehler

| Szenario | Handling |
|---|---|
| LAN-Target ECONNREFUSED | WoL wenn aktiviert, sonst 502 JSON-Error |
| LAN-Target HTTP-Timeout (>30s) | 504 |
| WoL-Timeout (>60s) | 504 + Maintenance-Page |
| Config-Poll fehlschlägt | Letzte Config weiterverwenden, Exponential-Backoff (5s→5min) |
| Tunnel-Down (kein Handshake) | `wg-quick down/up`, während down: 503 |
| Push mit ungültigem Token | 403 + Rate-Limit-Increment |
| LAN-Host nicht RFC1918 | Config-Validation blockt beim Load |
| TCP-Port-Konflikt | Listener startet nicht, Status-API zeigt `listener_failed` |
| IPv6 in Config | Rejected (MVP ist IPv4-only) |
| Config-Reload mit laufenden Requests | Router-Map atomar getauscht, laufende Requests auf alter Map beenden |

### 6.2 Server-seitige Fehler

| Szenario | Handling |
|---|---|
| Push an Gateway fehlschlägt | 2s Timeout, 1 Retry, dann ignore |
| Gateway-Peer gelöscht | Cascade: `gateway_meta` weg, Routes auf `target_kind='peer'` + disabled, Admin-Warning |
| API-Token regeneriert | Alter invalidiert, Admin muss neue `gateway.env` laden |
| Route mit Gateway-Target aber Non-Gateway-Peer | Validation-Error in Create/Update |
| Monitor: Gateway down | 3min Threshold → Alert + Degradation, Recovery → `gateway_recovered` |
| Caddy-Build fehlschlägt | Rollback auf letzte gültige Config (bestehender Mechanismus) |
| License-Downgrade entfernt `gateway_tcp_routing` | L4-Gateway-Routes disabled (nicht gelöscht), UI-Hinweis |

### 6.3 Kritische Invarianten

1. Gateway-API bindet niemals auf `0.0.0.0`, immer auf Tunnel-IP
2. LAN-Targets sind ausschließlich RFC1918/link-local
3. WoL-MAC muss in aktueller Route-Config existieren
4. Config-Hash-Mismatch → Full-Reload, kein Partial-Merge
5. Push ist best-effort, Gateway-Zustand darf nie davon abhängen
6. TCP-Listener: alter muss `close()`-complete sein bevor neuer auf gleichem Port bindet

### 6.4 Security-Defense-Depth
- Gateway-API-Token und Push-Token als SHA-256 in DB (separate Secrets)
- Rate-Limits: `/api/wol` 10/min, `/api/config-changed` 30/min
- Gateway-Logs ohne Request-Bodies
- LAN-Target ≠ Tunnel-IP (Loop-Schutz)

---

## 7. Testing-Strategie

### 7.1 Unit-Tests (Gateway-Repo, Jest)

| Datei | Abdeckung |
|---|---|
| `tests/config.test.js` | Env-Parsing, RFC1918-Validation, Tunnel-IP-Check, fehlende Keys |
| `tests/proxy/router.test.js` | Domain/Port-Mapping, Konflikt-Priority, atomic Hot-Reload |
| `tests/proxy/http.test.js` | Header-Stripping, Upstream-Forward, 502/504-Mapping, XFF-Pass-Through |
| `tests/proxy/tcp.test.js` | Listener-Lifecycle, Socket-Pipe, Close-Propagation |
| `tests/wol.test.js` | Magic-Packet-Bytes, Broadcast-Target, Interface-Selection (excl wg0) |
| `tests/sync/poller.test.js` | Hash-Check 304, Reload, Debounce, Exponential-Backoff |
| `tests/sync/configStore.test.js` | Diff-Logic, atomic Map-Swap |
| `tests/api/auth.test.js` | Timing-safe Compare, 403, Rate-Limit |
| `tests/api/wol.test.js` | MAC-Whitelist, Regex, 429 bei Flood |

### 7.2 Integration-Tests (Gateway gegen Mock-GateControl)

- Full Bootstrap (env → WG mock → Poll → Proxy-Start)
- Hot-Reload via Push ohne laufende Requests zu brechen
- WoL-Flow End-to-End (Mock sleeping target)
- Graceful Shutdown (SIGTERM in < 5s)
- Push-Auth-Fail + Rate-Limit-Counter
- Poll-Fallback wenn Push fehlschlägt

### 7.3 Server-Tests (Erweiterung von `gatecontrol`)

| Datei | Neue Tests |
|---|---|
| `tests/services/gateways.test.js` | CRUD, Hash-Stabilität, `notifyConfigChanged`, License-Limits |
| `tests/services/routes.test.js` | `target_kind='gateway'` Validation, LAN-Felder, License-Gate |
| `tests/services/caddyConfig.test.js` | Gateway-Upstream, Headers, Offline-Fallback-Page |
| `tests/services/monitor.test.js` | WoL-Trigger, Gateway-Offline → Alert-Chain |
| `tests/api/gateway.test.js` | Alle Endpoints: Auth, Scope, 304-Hash, Heartbeat |
| `tests/services/peers.test.js` | `peer_type='gateway'` erstellt `gateway_meta`, Cascade-Delete |
| `tests/db/migrations.test.js` | `026` idempotent, Default-Werte korrekt |

### 7.4 Mutation Testing (Stryker) — kritische Services

**Scope (6 Files):**
- `src/wol.js` — Magic-Packet-Bytes
- `src/sync/configStore.js` — Hash + Diff-Logic
- `src/sync/poller.js` — Backoff, Debounce
- `src/api/middleware/auth.js` — timing-safe Compare
- `src/config.js` — RFC1918, Tunnel-IP-Check
- `src/proxy/router.js` — Routing-Matching

**Config (`stryker.conf.js`):**
```javascript
{
  mutate: [...],
  testRunner: 'jest',
  thresholds: { high: 90, low: 80, break: 75 },
  timeoutMS: 10000,
  concurrency: 4
}
```

**CI-Gate:** Mutation-Score ≥ 75% (break-threshold). Job läuft nur bei Changes an kritischen Files oder auf main-Push.

### 7.5 GitHub Actions

**`.github/workflows/test.yml`** (PR + Push):

```yaml
jobs:
  syntax:             # 5s   — node --check, prettier-check, shellcheck
  lint:               # 45s  — eslint (+security, +sonarjs) + hadolint + KICS + madge (circular)
  simplification:     # 20s  — jscpd + knip (Warning)
  secrets:            # 15s  — gitleaks (volle History)
  dependency:         # 10s  — npm audit + GitHub dependency-review
  sast:               # async — CodeQL + njsscan
  unit:               # 45s  — Jest Matrix (Node 20, 22) + Coverage ≥85%
  integration:        # 60s  — Mock-Server-basiert
  axios-security:     # 10s  — SSRF-Tests (nur Server-URL erlaubt)
  mutation:           # 3-5min conditional — Stryker auf 6 kritischen Files
```

**`.github/workflows/release.yml`** (main, nach Tests grün):

```yaml
jobs:
  version-bump:       # feat:→minor, fix:→patch (wie Android/Windows-Clients)
  changelog-update
  multiarch-build:    # linux/amd64 + linux/arm64 + linux/arm/v7
  trivy:              # Container-CVE-Scan, Critical = Block
  sbom-syft:          # CycloneDX als Release-Asset
  smoke-multiarch:    # Docker-Boot + curl auf allen 3 Archs + Security-Assertions
                      #   - 0.0.0.0-Binding MUST fail
                      #   - Non-RFC1918-Target MUST reject
  push-ghcr:          # nur wenn trivy grün
  github-release
```

**`.github/workflows/scorecard.yml`** (Weekly):
- OpenSSF Scorecard → README-Badge (kein Gate)

### 7.6 On-Demand (Claude-Code-Skills, nicht CI)

- `/code-review` vor jedem Merge auf main
- `/security-review` vor jedem Release-Tag
- `/simplify` nach größeren Features
- `devils-advocate` vor Release-Tag

### 7.7 Release-Block-Gates (Summary)

| Gate | Blockt Release wenn |
|---|---|
| Unit-Coverage | < 85% |
| Mutation-Score | < 75% auf kritischen Files |
| npm audit | High/Critical CVE |
| CodeQL | High-severity Finding |
| njsscan | High-severity Finding |
| Trivy Container | Critical CVE im Image |
| KICS | High-severity Misconfig |
| Hadolint | Error-Level Finding |
| Gitleaks | Secret gefunden |
| Smoke-Multiarch | Eine Arch schlägt fehl |

---

## 8. License-Tiers (MVP)

| Feature | Community | Pro | Lifetime |
|---|---|---|---|
| Gateway-Peers (Anzahl) | 1 | 3 | unbegrenzt |
| LAN HTTP-Routes pro Gateway | 3 | unbegrenzt | unbegrenzt |
| LAN TCP-Routing | ❌ | ✅ | ✅ |
| Wake-on-LAN | ❌ | ✅ | ✅ |
| Device Discovery | — (V2) | — (V2) | — (V2) |
| Multi-Site-Gateways (>3) | — (V2) | — (V2) | — (V2) |

**Enforcement-Location:** Validation in `gateways.createGateway()` (Anzahl) und `routes.createRoute()` (pro-Gateway-HTTP-Limits, TCP-Gate, WoL-Gate). Bei License-Downgrade werden überzählige Items als `disabled` markiert, nicht gelöscht.

License-Downgrade disabled betroffene Routes statt sie zu löschen (User kann Daten behalten).

---

## 9. Dependencies zu anderen Features

- **Internal DNS** (bereits im Server verfügbar, Phase 0-2): Gateway-Peer bekommt einen Hostname (`homelab-gw.gc.internal`). LAN-Targets könnten später per Internal-DNS statt IP referenziert werden (V2).
- **WoL-Service** (`src/services/wol.js`): wiederverwendet, keine Änderung.
- **Monitoring-Service** (`src/services/monitor.js`): Erweiterung um WoL-Trigger-Hook und Gateway-Health-Check.
- **Caddy-L4-Plugin**: bereits im Server-Image enthalten, keine zusätzliche Build-Änderung.
- **License-Service** (`src/services/license.js`): neue Feature-Keys, keine strukturelle Änderung.

---

## 10. Meilensteine

### Phase A — Server-Preparation
- DB-Migration `026_gateway_support.sql`
- Service `gateways.js` (CRUD + Config-Build + Hash)
- API-Endpoints `/api/v1/gateway/*`
- Token-Scope `gateway`
- License-Keys
- Pairing-Datei-Download (`gateway.env`)

### Phase B — Gateway-Repo MVP
- Repo-Scaffold + CI-Setup (alle Workflows)
- `config.js` + `wireguard.js` + Logger
- HTTP-Proxy + TCP-Proxy + Router
- Sync (Poller + ConfigStore)
- Management-API (Auth, WoL-Receiver, Status, Push-Receiver)
- Unit + Integration + Mutation Tests

### Phase C — Integration
- Caddy-Config-Builder für Gateway-Routes
- Monitor-Hook für WoL + Gateway-Offline
- UI: Peer-Dialog, Route-Formular, Download-Button
- Maintenance-Page-Template
- End-to-End-Test gegen realen Gateway-Container

### Phase D — Release
- Dokumentation (README, Deployment-Guide, Troubleshooting)
- Docker-Smoke-Test auf 3 Archs
- SBOM + Trivy-Report als Release-Assets
- Beta-Testing an 1-2 Installationen
- 1.0-Release

---

## 11. Open Questions (für Implementation-Plan)

1. **Config-Reload bei TCP-Port-Konflikt:** Was passiert, wenn User einen Port konfiguriert, den der Gateway-Host lokal bereits nutzt? → Listener-Failure loggen, Route als `listener_failed` im Status-API, nicht retry-loopen.
2. **Mehrere Gateways pro GateControl (V2):** Aktuell `gateway_peers: 1/3/∞` im License-Modell — Schema unterstützt Multi-Gateway schon, UI-Erweiterung V2.
3. **Gateway-Update-Mechanismus:** MVP = manueller `docker pull + restart`. V2: Auto-Update wie Windows-Client (Check-Endpoint im Server).
4. **LAN-Target-Health:** Gateway könnte LAN-Targets pingen und Status an Server melden — MVP verlässt sich auf Server-seitiges Monitoring via Tunnel.
