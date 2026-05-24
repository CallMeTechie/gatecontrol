# RDP-über-Gateway für Pro- und Android-Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RDP-Routen mit `access_mode='gateway'` werden im GateControl-Server klar konfigurierbar und sind über den Windows-Pro-Client **und** den Android-Client sichtbar **und** verbindbar — ohne dass der Ziel-Rechner einen WireGuard-Peer/Client besitzt.

**Architecture:** Der **Server** löst zentral einen effektiven Verbindungs-Endpunkt auf (`connect_address`/`connect_port`) und liefert ihn in der Routen-Liste **und** im `/connect`-Payload. Beide Clients lesen nur noch dieses Feldpaar als Verbindungsziel, statt jeweils selbst `access_mode` zu interpretieren. Internal/External-Verhalten bleibt unverändert (rein additiv). Zusätzlich: Server-Reachability-Check und Client-VPN-Gates werden für Gateway-Routen angepasst.

**Tech Stack:** Server = Node.js/Express + node:test. Windows = Electron/JS + node:test. Android = Kotlin + JUnit5 + MockK.

---

## Hintergrund (verifizierte Root-Cause)

Drei voneinander unabhängige Lücken verhindern heute Gateway-RDP:

1. **UI (Server)** — `templates/{default,pro}/pages/rdp.njk` + `public/js/rdp.js`: Im Gateway-Modus ist die Ziel-LAN-IP nur das generische „Host"-Feld; dessen Peer-Autocomplete (`/api/v1/peers`) suggeriert fälschlich, das Ziel müsse ein Peer sein. Der Home-Gateway-Abschnitt enthält kein erkennbares LAN-IP-Feld.
2. **Connect-Endpunkt (Server → Clients)** — `src/routes/api/client/rdp.js`: `/connect` und `/rdp` liefern für Gateway-Routen `host`=LAN-IP, aber nie den öffentlich erreichbaren `<server>:<listen_port>`. Beide Clients fallen dadurch auf die unerreichbare LAN-IP zurück (`rdp-config-builder.js:35-40`, `RdpConnectionParams.kt:52`).
3. **Reachability/VPN-Gates** — Server-Monitor prüft `host:port` (LAN-IP, vom Server nicht erreichbar; `rdpMonitor.js:35-37`); beide Clients erzwingen VPN (`rdp-manager.js:181-187`, `RdpManager.kt:58`) und prüfen Erreichbarkeit gegen die LAN-IP.

Das Backend-Forwarding selbst ist korrekt: `src/services/rdp.js:378-379` legt die L4-Route mit `target_lan_host=host` an, die Gateway-Companion leitet rohes TCP an eine **beliebige** LAN-IP weiter (`gatecontrol-gateway/src/proxy/tcp.js:87`).

## Projekt-Constraints (aus Nutzer-Memory — verbindlich)

- **Keine** `Co-Authored-By`-Zeile in Commits.
- **i18n Pflicht**: jeder neue user-facing Text in **`src/i18n/en.json` UND `src/i18n/de.json`**.
- **Kein** manueller Version-Bump (CI `release.yml` bumpt automatisch).
- **CHANGELOG.md** bei der Änderung mitpflegen.
- Tests laufen über **GitHub Actions/CI**, nicht lokal — Verifikation erfolgt in CI. Lokale Einzeldatei-Runs sind optional zur schnellen Kontrolle.
- Nach jeder Phase **Markdown-Doku in `docs/`** aktualisieren/ergänzen.
- **Kein** neues Lizenz-Feature-Flag nötig: Gateway-RDP nutzt das **bestehende** `rdp_via_gateway`-Flag (bereits in `COMMUNITY_FALLBACK` + API-Guards). Nicht neu anlegen.
- Nach jeder abgeschlossenen Task: **committen und pushen** (auf einem Feature-Branch, nicht direkt auf `master`).

## File Structure

**Repo `gatecontrol` (Server) — Phase A**
- Modify: `src/services/rdp.js` — neue, pure, exportierte Funktion `resolveConnectEndpoint(route, { baseUrl, publicHost })`.
- Modify: `src/routes/api/client/rdp.js` — `connect_address`/`connect_port` an Liste (`/rdp`) und `/connect` anhängen.
- Modify: `src/services/rdpMonitor.js` — Gateway-Routen gegen `127.0.0.1:<listen_port>` prüfen.
- Modify: `templates/default/pages/rdp.njk`, `templates/pro/pages/rdp.njk` — LAN-IP-Hilfetext + Gateway-Hinweis.
- Modify: `public/js/rdp.js` — access-mode-abhängiger Host-Hilfetext, Peer-Autocomplete im Gateway-Modus unterdrücken.
- Modify: `src/i18n/en.json`, `src/i18n/de.json` — neue Hint-Keys.
- Create: `tests/rdp_connect_endpoint.test.js`, `tests/rdpMonitor_gateway.test.js`.
- Modify: `CHANGELOG.md`; Create: `docs/feature-rdp-via-gateway-clients.md`.

**Repo `windows-client-pro` — Phase B**
- Modify: `src/services/rdp/rdp-config-builder.js` — `connect_address`/`connect_port` bevorzugen.
- Modify: `src/services/rdp/rdp-manager.js` — VPN-Gate + lokaler TCP-Check für Gateway-Routen.
- Modify: `test/rdp-config-builder.test.js`; Modify: `CHANGELOG.md`.

**Repo `android-client` — Phase C**
- Modify: `core/network/src/main/java/com/gatecontrol/android/network/ApiModels.kt` — `connectAddress`/`connectPort` an `RdpRoute`.
- Modify: `core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpConnectionParams.kt` — Endpunkt aus `connectAddress`/`connectPort`.
- Modify: `core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpManager.kt` — VPN-Gate für Gateway-Routen lockern.
- Modify: `core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpConnectionParamsTest.kt`; Modify: `CHANGELOG.md`.

**Verbindungs-Endpunkt-Regel (in allen drei Repos identisch):**
- `gateway` → `GC_RDP_PUBLIC_HOST` (falls gesetzt) **sonst** `<hostname(baseUrl)>` : `gateway_listen_port || port`
- `external` / `both` (mit `external_hostname`) → `external_hostname` : `external_port || port`
- sonst (`internal`) → `host` : `port`

---

# Phase A — Server (`gatecontrol`)

> Fundament. Muss zuerst gemerged sein, sonst haben die Clients kein `connect_address`.
> Branch: `feat/rdp-gateway-clients`.

### Task A1: `resolveConnectEndpoint`-Helper

**Files:**
- Modify: `src/services/rdp.js` (Funktion + Export)
- Modify: `config/default.js` (`app.rdpPublicHost`), `.env.example`
- Test: `tests/rdp_connect_endpoint.test.js`

> **Adressiert Devil's-Advocate-Concern #3 (High/Blocking):** `connect_address` darf
> NICHT blind aus `baseUrl` abgeleitet werden — hinter Cloudflare/NAT/L7-Proxy zeigt
> der `baseUrl`-Host nicht auf den rohen L4-RDP-Port. Daher optionaler Override
> `GC_RDP_PUBLIC_HOST`, der dem `baseUrl`-Host **vorgeht**.

- [ ] **Step 1: Failing-Test schreiben**

`tests/rdp_connect_endpoint.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveConnectEndpoint } = require('../src/services/rdp');

const OPTS = { baseUrl: 'https://gc.example.com' };

test('internal → host:port', () => {
  const r = { access_mode: 'internal', host: '10.8.0.5', port: 3389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: '10.8.0.5', connect_port: 3389 });
});

test('external mit external_hostname → external endpoint', () => {
  const r = { access_mode: 'external', host: '10.8.0.5', port: 3389, external_hostname: 'rdp.example.com', external_port: 13389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'rdp.example.com', connect_port: 13389 });
});

test('gateway → baseUrl-host : listen_port', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'gc.example.com', connect_port: 13389 });
});

test('gateway ohne listen_port → fällt auf port zurück', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: null };
  assert.deepStrictEqual(resolveConnectEndpoint(r, OPTS), { connect_address: 'gc.example.com', connect_port: 3389 });
});

test('gateway mit publicHost-Override → schlägt baseUrl', () => {
  const r = { access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 };
  const opts = { baseUrl: 'https://gc.example.com', publicHost: 'rdp.direct.example.com' };
  assert.deepStrictEqual(resolveConnectEndpoint(r, opts), { connect_address: 'rdp.direct.example.com', connect_port: 13389 });
});

test('publicHost gilt NUR für gateway, nicht external', () => {
  const r = { access_mode: 'external', host: '10.8.0.5', port: 3389, external_hostname: 'rdp.example.com', external_port: 13389 };
  const opts = { baseUrl: 'https://gc.example.com', publicHost: 'should.be.ignored' };
  assert.deepStrictEqual(resolveConnectEndpoint(r, opts), { connect_address: 'rdp.example.com', connect_port: 13389 });
});
```

- [ ] **Step 2: Implementierung in `src/services/rdp.js`**

Vor `module.exports` einfügen:

```js
// Resolve the single endpoint a client should connect to, by access mode.
// gateway → publicHost (GC_RDP_PUBLIC_HOST) || <baseUrl host> : <listen_port|port>;
//   the publicHost override exists for setups where the admin UI sits behind
//   Cloudflare/NAT/L7-proxy that does NOT pass the raw L4 RDP port.
// external/both → external_hostname:external_port; else → host:port.
// Pure (opts injected) so it is unit-testable without config.
function resolveConnectEndpoint(route, { baseUrl, publicHost } = {}) {
  const mode = route.access_mode || 'internal';
  if (mode === 'gateway') {
    let host = publicHost || null;
    if (!host) {
      try { host = new URL(baseUrl).hostname; } catch { host = null; }
    }
    return {
      connect_address: host,
      connect_port: route.gateway_listen_port || route.port || 3389,
    };
  }
  if ((mode === 'external' || mode === 'both') && route.external_hostname) {
    return {
      connect_address: route.external_hostname,
      connect_port: route.external_port || route.port || 3389,
    };
  }
  return { connect_address: route.host, connect_port: route.port || 3389 };
}
```

Im `module.exports`-Block ergänzen: `resolveConnectEndpoint,`

- [ ] **Step 3: `GC_RDP_PUBLIC_HOST` als optionalen Override einführen**

In `config/default.js`, im `app`-Block direkt neben `baseUrl` ergänzen:

```js
    rdpPublicHost: env('GC_RDP_PUBLIC_HOST', ''),
```

In `.env.example` dokumentieren:

```bash
# Öffentlicher Host für Gateway-RDP-Routen (roher L4-Listen-Port). Nur nötig, wenn
# die Admin-UI hinter Cloudflare/NAT/Reverse-Proxy läuft und der baseUrl-Host den
# RDP-Listen-Port NICHT direkt durchreicht. Leer = baseUrl-Host wird verwendet.
GC_RDP_PUBLIC_HOST=
```

- [ ] **Step 4: Commit + Push**

```bash
git add src/services/rdp.js config/default.js .env.example tests/rdp_connect_endpoint.test.js
git commit -m "feat(rdp): access-mode-aware connect endpoint with GC_RDP_PUBLIC_HOST override"
git push -u origin feat/rdp-gateway-clients
```

CI (`node --test tests/`) verifiziert. Optional lokal: `node --test tests/rdp_connect_endpoint.test.js`.

---

### Task A2: `connect_address`/`connect_port` an Client-Endpunkte anhängen

**Files:**
- Modify: `src/routes/api/client/rdp.js` (Liste ~49-54, `/connect` ~162-201)

- [ ] **Step 1: Liste (`GET /rdp`) ergänzen**

In `src/routes/api/client/rdp.js`, die `enriched`-Map (aktuell ~49-52) ersetzen durch:

```js
    const config = require('../../../../config/default');
    const connOpts = { baseUrl: config.app.baseUrl, publicHost: config.rdp.publicHost };
    const enriched = visibleRoutes.map(r => ({
      ...r,
      ...rdpService.resolveConnectEndpoint(r, connOpts),
      status: statuses[r.id] || { online: false, lastCheck: null },
    }));
```

- [ ] **Step 2: `/connect`-Payload ergänzen**

Im `connection`-Objekt-Literal (beginnt bei `const connection = {`), direkt nach `port: route.port,` einfügen:

```js
      ...(() => {
        const cfg = require('../../../../config/default');
        return rdpService.resolveConnectEndpoint(route, { baseUrl: cfg.app.baseUrl, publicHost: cfg.rdp.publicHost });
      })(),
```

(So enthält `connection` zusätzlich `connect_address` + `connect_port`. `host`/`port` bleiben für Abwärtskompatibilität erhalten.)

- [ ] **Step 3: Failing-Test schreiben** — `tests/rdp_connect_endpoint.test.js` ergänzen um einen Endpoint-Smoke-Test, der die Form prüft (kein HTTP nötig, wir testen die Service-Funktion bereits in A1). Zusätzlich in bestehender `tests/client_api_smoke.test.js` (falls vorhanden) einen Assert ergänzen, dass `connect_address` im `/connect`-Response vorhanden ist. Falls die Smoke-Test-Infrastruktur fehlt, diesen Schritt überspringen und auf A1 + manuellen curl-Check verweisen:

```bash
# manuell gegen laufende Instanz:
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/client/rdp/<id>/connect | jq '.connection | {host, connect_address, connect_port, access_mode}'
```

- [ ] **Step 4: Commit + Push**

```bash
git add src/routes/api/client/rdp.js tests/
git commit -m "feat(rdp): expose connect_address/connect_port on client rdp list + connect"
git push
```

---

### Task A3: Server-Reachability für Gateway-Routen

**Files:**
- Modify: `src/services/rdpMonitor.js`
- Test: `tests/rdpMonitor_gateway.test.js`

> **Adressiert Concern #1 (High/Blocking):** Ein reiner Loopback-Probe meldet „online",
> auch wenn der Gateway-Peer tot ist — Einzel-Peer-L4-Routen werden NIE aus der Caddy-Config
> entfernt (verifiziert `caddyConfig.js:568-612`; Outage-Skip gilt nur für Pools). Daher gilt
> eine Gateway-Route nur als online, wenn der lokale L4-Listener offen ist **UND** der
> verknüpfte Gateway-Peer frisch heartbeatet. `last_seen_at` ist Epoch-ms; Threshold =
> Setting `gateway_down_threshold_s` (Default 90s), identisch zu `gatewayHealth.js:77-90`.

- [ ] **Step 1: Failing-Tests schreiben**

`tests/rdpMonitor_gateway.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveCheckTarget, isGatewayStale } = require('../src/services/rdpMonitor');

test('gateway route checked against loopback listen port', () => {
  const t = resolveCheckTarget({ access_mode: 'gateway', host: '192.168.2.100', port: 3389, gateway_listen_port: 13389 });
  assert.deepStrictEqual(t, { host: '127.0.0.1', port: 13389 });
});

test('internal route checked against host:port', () => {
  const t = resolveCheckTarget({ access_mode: 'internal', host: '10.8.0.5', port: 3389 });
  assert.deepStrictEqual(t, { host: '10.8.0.5', port: 3389 });
});

test('gateway peer stale when last_seen older than threshold (epoch ms)', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(isGatewayStale(now - 200_000, 90_000, now), true);  // 200s alt > 90s
  assert.strictEqual(isGatewayStale(now - 10_000, 90_000, now), false);  // 10s alt
  assert.strictEqual(isGatewayStale(null, 90_000, now), true);           // nie gesehen
});
```

- [ ] **Step 2: Implementierung in `src/services/rdpMonitor.js`**

Helper nahe `checkTcp` einfügen:

```js
// Gateway routes are reachable via the server's own public L4 listener,
// not via the LAN host (which the server cannot reach). Probe loopback.
function resolveCheckTarget(route) {
  if ((route.access_mode || 'internal') === 'gateway') {
    return { host: '127.0.0.1', port: route.gateway_listen_port || route.port || 3389 };
  }
  return { host: route.host, port: route.port };
}

// Mirrors gatewayHealth's staleness definition (last_seen_at stored as epoch ms).
function isGatewayStale(lastSeenAt, thresholdMs, now = Date.now()) {
  if (lastSeenAt == null) return true;
  return (now - lastSeenAt) > thresholdMs;
}

// A gateway route is only reachable if its linked gateway peer still heartbeats —
// otherwise the local L4 listener accepts the connection but the dead gateway
// never forwards it (false-positive "online").
function isGatewayLive(route, db) {
  if ((route.access_mode || 'internal') !== 'gateway' || !route.gateway_peer_id) return true;
  const meta = db.prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id = ?').get(route.gateway_peer_id);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'gateway_down_threshold_s'").get();
  const thresholdMs = (parseInt(row?.value ?? '90', 10) || 90) * 1000;
  return !isGatewayStale(meta?.last_seen_at ?? null, thresholdMs);
}

// Single probe path shared by checkRouteById + checkAll.
async function _probe(route, db) {
  if (!isGatewayLive(route, db)) return { online: false, responseTime: null };
  const tgt = resolveCheckTarget(route);
  return checkTcp(tgt.host, tgt.port);
}
```

`checkRouteById` — SELECT erweitern, `_probe` nutzen (statt `checkTcp(route.host, route.port)`):

```js
  const route = db.prepare('SELECT id, name, host, port, access_mode, gateway_peer_id, gateway_listen_port, health_check_enabled FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');
  const result = await _probe(route, db);
```

`checkAll` — SELECT erweitern, `_probe` nutzen:

```js
  const routes = db.prepare('SELECT id, name, host, port, access_mode, gateway_peer_id, gateway_listen_port FROM rdp_routes WHERE enabled = 1 AND health_check_enabled = 1').all();
  // in der Schleife statt checkTcp(route.host, route.port):
  const result = await _probe(route, db);
```

Export ergänzen: `resolveCheckTarget, isGatewayStale` zum `module.exports` hinzufügen.

- [ ] **Step 3: Commit + Push**

```bash
git add src/services/rdpMonitor.js tests/rdpMonitor_gateway.test.js
git commit -m "fix(rdp): gateway route health requires live gateway peer + loopback listener"
git push
```

---

### Task A4: UI — LAN-IP im Gateway-Modus auffindbar machen (Ebene 1)

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/de.json`
- Modify: `templates/default/pages/rdp.njk`, `templates/pro/pages/rdp.njk`
- Modify: `public/js/rdp.js`

- [ ] **Step 1: i18n-Keys hinzufügen (BEIDE Dateien)**

`src/i18n/de.json` (zu den `rdp.*`-Keys):

```json
  "rdp.host_hint.default": "VPN-IP oder Peer-Name des Ziel-Rechners.",
  "rdp.host_hint.gateway": "LAN-IP des Ziel-Rechners im Heimnetz (z.B. 192.168.2.100) — kein WireGuard-Peer und kein Client am Ziel nötig.",
  "rdp.gateway_lan_target_note": "Die Ziel-LAN-IP trägst du oben im Feld „Host" ein.",
  "rdp.gateway_nla_note": "Hinweis: Da das Ziel über die öffentliche Adresse erreicht wird, kann bei striktem NLA eine Zertifikatswarnung erscheinen. Bei Problemen NLA am Ziel-Server prüfen.",
```

`src/i18n/en.json` (gleiche Keys):

```json
  "rdp.host_hint.default": "VPN IP or peer name of the target machine.",
  "rdp.host_hint.gateway": "LAN IP of the target machine in the home network (e.g. 192.168.2.100) — no WireGuard peer or client needed on the target.",
  "rdp.gateway_lan_target_note": "Enter the target LAN IP in the \"Host\" field above.",
  "rdp.gateway_nla_note": "Note: because the target is reached via the public address, strict NLA may show a certificate warning. If it fails, check NLA on the target server.",
```

- [ ] **Step 2: Host-Hilfetext + Gateway-Hinweis ins Template (default + pro)**

In **beiden** Templates: direkt nach dem Host-`<input id="rdp-host" …>`-Wrapper (in `default` nach Zeile ~151, im `pro`-Wizard an der entsprechenden Stelle) ein Hilfetext-Element ergänzen:

```html
<div id="rdp-host-hint" style="font-size:10px;color:var(--text-3);margin-top:3px">{{ t('rdp.host_hint.default') }}</div>
```

Im `rdp-homegw-fields`-Block (default ~185-187, pro analog), in den Hinweis-Kasten zwei Zeilen ergänzen (LAN-Ziel-Verweis + NLA-Hinweis aus Concern #4):

```html
<div style="font-size:11px;color:var(--text-2);margin-top:4px;font-weight:600">{{ t('rdp.gateway_lan_target_note') }}</div>
<div style="font-size:10px;color:var(--text-3);margin-top:4px">{{ t('rdp.gateway_nla_note') }}</div>
```

- [ ] **Step 3: JS — Hilfetext umschalten + Peer-Autocomplete im Gateway-Modus unterdrücken**

In `public/js/rdp.js`, Funktion `updateAccessModeFields` (um Zeile 556) am Ende ergänzen:

```js
    var hostHint = document.getElementById('rdp-host-hint');
    if (hostHint && window.GC && GC.t) {
      hostHint.textContent = (mode === 'gateway')
        ? (GC.t['rdp.host_hint.gateway'] || hostHint.textContent)
        : (GC.t['rdp.host_hint.default'] || hostHint.textContent);
    }
```

Im `hostInput`-`input`-Handler (um Zeile 662) den Gateway-Fall ausnehmen, damit die irreführenden Peer-Vorschläge wegfallen:

```js
    hostInput.addEventListener('input', async function () {
      var am = document.getElementById('rdp-access-mode');
      if (am && am.value === 'gateway') { suggestions.style.display = 'none'; return; }
      var peers = await fetchPeers();
      var filtered = filterPeers(peers, this.value);
      showSuggestions(filtered);
    });
```

(Analog im `focus`-Handler die Gateway-Bedingung voranstellen.)

- [ ] **Step 4: Manuelle Sichtprüfung** (kein Auto-Test für Templates)

GC-Server starten, `/rdp` → Neue Route → Access-Mode „Über Home-Gateway". Erwartung: Host-Hilfetext wechselt auf den Gateway-Text, im Gateway-Kasten erscheint der „Host"-Verweis, keine Peer-Autocomplete mehr.

- [ ] **Step 5: Commit + Push**

```bash
git add src/i18n/en.json src/i18n/de.json templates/default/pages/rdp.njk templates/pro/pages/rdp.njk public/js/rdp.js
git commit -m "feat(rdp-ui): clarify LAN target host in gateway access mode"
git push
```

---

### Task A5: CHANGELOG + Doku (Server)

**Files:** Modify `CHANGELOG.md`; Create `docs/feature-rdp-via-gateway-clients.md`

- [ ] **Step 1:** `CHANGELOG.md` unter „Unreleased" ergänzen:

```markdown
### Added
- RDP routes with access_mode `gateway` now expose a resolved `connect_address`/`connect_port`
  on the client RDP list and `/connect` endpoints, so Pro/Android clients connect to the public
  `<server>:<listen_port>` endpoint instead of the unreachable LAN host.
- RDP route wizard now clarifies that the target LAN IP belongs in the "Host" field for gateway mode
  and suppresses the misleading peer autocomplete there.

### Fixed
- RDP health monitor now probes gateway routes via the loopback listen port instead of the LAN host.
```

- [ ] **Step 2:** `docs/feature-rdp-via-gateway-clients.md` anlegen (kurze Beschreibung der `connect_address`-Auflösung, der drei Modi und des Reachability-Verhaltens; auf `feature-rdp-via-gateway.md` verlinken).

- [ ] **Step 3: Commit + Push**

```bash
git add CHANGELOG.md docs/feature-rdp-via-gateway-clients.md
git commit -m "docs(rdp): document connect endpoint resolution for gateway routes"
git push
```

> **Checkpoint:** Phase A in CI grün → mergen, damit die Clients `connect_address` erhalten.

---

# Phase B — Windows-Pro-Client (`windows-client-pro`)

> Branch: `feat/rdp-gateway-connect`. Setzt gemergte Phase A voraus.

### Task B1: Config-Builder nutzt `connect_address`/`connect_port`

**Files:**
- Modify: `src/services/rdp/rdp-config-builder.js` (Connection-Block ~35-52)
- Test: `test/rdp-config-builder.test.js`

- [ ] **Step 1: Failing-Test schreiben** — in `test/rdp-config-builder.test.js` ergänzen:

```js
test('gateway route uses connect_address:connect_port as full address', async () => {
  const builder = new RdpConfigBuilder(fakeLog);
  const file = await builder.build({
    name: 'gw', access_mode: 'gateway',
    host: '192.168.2.100', port: 3389,
    connect_address: 'gc.example.com', connect_port: 13389,
  });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /full address:s:gc\.example\.com:13389/);
});
```

(Imports `RdpConfigBuilder`, `fs`, `assert`, `fakeLog` analog zu den bestehenden Tests in der Datei wiederverwenden.)

- [ ] **Step 2: Implementierung** — den Connection-Block in `build(route)` (ab `const ipHost = …`) so anpassen, dass `connect_address` Vorrang hat:

```js
    // Prefer the server-resolved connect endpoint (set for gateway / external
    // routes). Falls back to legacy host/port resolution for older servers.
    const ipHost = route.connect_address
      || (route.external_hostname && route.access_mode !== 'internal'
        ? route.external_hostname
        : route.host);
    const port = route.connect_port
      || (route.external_port && route.access_mode !== 'internal'
        ? route.external_port
        : (route.port || 3389));
```

(Der Rest des Blocks — `useFqdn`, `primaryHost`, `full address` — bleibt unverändert. Für Gateway-Routen ist `peer_fqdn` null → `primaryHost` = `connect_address`.)

- [ ] **Step 3: Commit + Push**

```bash
git add src/services/rdp/rdp-config-builder.js test/rdp-config-builder.test.js
git commit -m "feat(rdp): prefer server-resolved connect_address for gateway routes"
git push -u origin feat/rdp-gateway-connect
```

CI verifiziert (`node --test 'test/**/*.test.js'`).

---

### Task B2: VPN-Gate + lokaler TCP-Check für Gateway-Routen

**Files:**
- Modify: `src/services/rdp/rdp-manager.js` (VPN-Gate ~181-187, TCP-Check ~237)

- [ ] **Step 1: VPN-Gate lockern** — den Block (~181-187) anpassen:

```js
      // 1a. VPN tunnel must be active — EXCEPT gateway routes, whose
      // endpoint is the public server:listen_port (reachable without VPN).
      const isGateway = (route.access_mode === 'gateway');
      const tunnelState = this.getTunnelState();
      if (!isGateway && (!tunnelState || !tunnelState.connected)) {
        return { success: false, error: 'VPN-Tunnel ist nicht aktiv. Bitte zuerst verbinden.' };
      }
      this._emitProgress(routeId, 'vpn-check', 'done');
```

- [ ] **Step 2: credTarget + TCP-Check gegen den effektiven Endpunkt** (beide in `connect()`; `route` = `/connect`-Objekt, verifiziert `rdp-manager.js:196` `const route = connectData`)

**(a) credTarget für Gateway-Routen an `connect_address` ausrichten — Concern #2 (High/Blocking).**
Die bestehende Zeile (`rdp-manager.js:205`)

```js
      const credTarget = (route.access_mode !== 'external' && route.peer_fqdn) ? route.peer_fqdn : host;
```

ersetzen durch:

```js
      // Gateway routes connect to connect_address (e.g. gc.example.com:13389), so the
      // cmdkey /generic target MUST match that string — otherwise mstsc stores the
      // credentials under the LAN IP and prompts for a password despite credential_mode=full.
      const credTarget = route.access_mode === 'gateway'
        ? (route.connect_address || host)
        : ((route.access_mode !== 'external' && route.peer_fqdn) ? route.peer_fqdn : host);
```

**(b) TCP-Reachability gegen den öffentlichen Endpunkt** — vor `_tcpCheck` (~237):

```js
      const checkHost = route.connect_address || host;
      const checkPort = route.connect_port || port;
      const reachable = await this._tcpCheck(checkHost, checkPort, 5000);
```

(`host`/`port` bleiben Roh-Werte; die `.rdp`-`full address` nutzt nach B1 ohnehin `connect_address`. Damit zeigen full address, credTarget UND Reachability für Gateway-Routen konsistent auf `connect_address`.)

- [ ] **Step 3: Manueller End-to-End-Test** — Gateway-Route im Server anlegen (LAN-IP + Gateway-Peer + Listen-Port), im Pro-Client ohne aktiven VPN-Tunnel verbinden. Erwartung: kein VPN-Fehler, mstsc öffnet `gc.example.com:13389`, RDP-Session steht.

- [ ] **Step 4: Commit + Push**

```bash
git add src/services/rdp/rdp-manager.js
git commit -m "feat(rdp): allow gateway routes without VPN and check public endpoint reachability"
git push
```

- [ ] **Step 5:** `CHANGELOG.md` (Windows-Repo) unter „Unreleased" ergänzen (Gateway-RDP via public endpoint, kein VPN nötig) und committen/pushen.

---

# Phase C — Android-Client (`android-client`)

> Branch: `feat/rdp-gateway-connect`. Setzt gemergte Phase A voraus.

### Task C1: DTO-Felder ergänzen

**Files:**
- Modify: `core/network/src/main/java/com/gatecontrol/android/network/ApiModels.kt`

- [ ] **Step 1:** In der `data class RdpRoute` zwei Felder ergänzen (nach `externalPort`):

```kotlin
    @SerializedName("connect_address") val connectAddress: String? = null,
    @SerializedName("connect_port") val connectPort: Int? = null,
```

(Defaults `= null` halten Abwärtskompatibilität, falls der Server noch alt ist.)

- [ ] **Step 2: Commit + Push**

```bash
git add core/network/src/main/java/com/gatecontrol/android/network/ApiModels.kt
git commit -m "feat(rdp): add connect_address/connect_port to RdpRoute DTO"
git push -u origin feat/rdp-gateway-connect
```

---

### Task C2: `fromRoute` nutzt den aufgelösten Endpunkt

**Files:**
- Modify: `core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpConnectionParams.kt:52-53`
- Test: `core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpConnectionParamsTest.kt`

- [ ] **Step 1: Failing-Test schreiben** — in `RdpConnectionParamsTest.kt` ergänzen (Felder analog zu den bestehenden Test-Fixtures; `connectAddress`/`connectPort` setzen):

```kotlin
@Test
fun `gateway route uses connect address and port`() {
    val route = baseRoute.copy(
        accessMode = "gateway",
        host = "192.168.2.100", port = 3389,
        connectAddress = "gc.example.com", connectPort = 13389
    )
    val params = RdpConnectionParams.fromRoute(route, null, null, null)
    assertEquals("gc.example.com", params.host)
    assertEquals(13389, params.port)
}
```

(`baseRoute` = vorhandenes Test-Fixture in der Datei; ggf. minimal anlegen, falls keins existiert.)

- [ ] **Step 2: Implementierung** — in `RdpConnectionParams.fromRoute` Zeilen 52-53 ersetzen:

```kotlin
            host = route.connectAddress ?: route.host,
            port = route.connectPort ?: route.port,
```

- [ ] **Step 3: Commit + Push**

```bash
git add core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpConnectionParams.kt \
        core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpConnectionParamsTest.kt
git commit -m "feat(rdp): use resolved connect endpoint in RdpConnectionParams"
git push
```

CI verifiziert (`./gradlew :core:rdp:testDebugUnitTest`).

---

### Task C3: VPN-Gate für Gateway-Routen lockern (über testbare `requiresVpn`)

**Files:**
- Modify: `core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpManager.kt` (companion-Funktion + Step-1-Check)
- Test: `core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpManagerVpnGateTest.kt` (neu)

> **Adressiert Concern #5 (Medium):** Die Gate-Entscheidung wird in eine pure Funktion
> extrahiert, statt das schwer mockbare `connect()` (Reachability + Credentials +
> Activity-Launch) end-to-end zu testen.

- [ ] **Step 1: Failing-Test schreiben**

`core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpManagerVpnGateTest.kt`:

```kotlin
package com.gatecontrol.android.rdp

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RdpManagerVpnGateTest {
    @Test
    fun `gateway route does not require VPN`() {
        assertFalse(RdpManager.requiresVpn("gateway"))
    }

    @Test
    fun `non-gateway routes require VPN`() {
        assertTrue(RdpManager.requiresVpn("internal"))
        assertTrue(RdpManager.requiresVpn("external"))
        assertTrue(RdpManager.requiresVpn("both"))
    }
}
```

- [ ] **Step 2: Pure Funktion + Step-1-Check** — `companion object` in `RdpManager` ergänzen (falls noch keins existiert; sonst Funktion einfügen) und den VPN-Check (Zeile 56-60) ersetzen:

```kotlin
    companion object {
        // Gateway routes reach the public server endpoint and need no tunnel.
        fun requiresVpn(accessMode: String?): Boolean = accessMode != "gateway"
    }
```

```kotlin
        // Step 1: VPN check
        onProgress(RdpProgress.VPN_CHECK)
        if (requiresVpn(route.accessMode) && !isVpnConnected) {
            return ConnectResult.VpnRequired("VPN connection required to reach RDP host")
        }
```

(Der Reachability-Check via `apiClient.getRdpRouteStatus` greift dank Server-Task A3 korrekt für Gateway-Routen.)

- [ ] **Step 3: Commit + Push**

```bash
git add core/rdp/src/main/java/com/gatecontrol/android/rdp/RdpManager.kt \
        core/rdp/src/test/java/com/gatecontrol/android/rdp/RdpManagerVpnGateTest.kt
git commit -m "feat(rdp): gate VPN requirement via testable requiresVpn, gateway routes exempt"
git push
```

- [ ] **Step 4:** `CHANGELOG.md` (Android-Repo) ergänzen (Gateway-RDP wird verbindbar; kein VPN nötig) und committen/pushen.

---

## Self-Review-Checkliste (vor Übergabe)

- Spec-Abdeckung: Ebene 1 = Task A4; Ebene 2 = A1/A2 + B1/B2 + C1/C2/C3; Reachability = A3. ✓
- Sichtbarkeit bleibt unverändert (keine access_mode-Filter angefasst). ✓
- Internal/External unverändert (connect_address fällt sonst auf bisherige Logik zurück). ✓
- Namens-Konsistenz: `connect_address`/`connect_port` (Server/Win JSON), `connectAddress`/`connectPort` (Android DTO). ✓
- i18n in en + de. ✓ — kein manueller Version-Bump, CHANGELOG gepflegt, Doku ergänzt. ✓
- Kein neues Lizenz-Flag (bestehendes `rdp_via_gateway`). ✓

### Devil's-Advocate-Concerns — Abdeckung

- **#1 (High)** Falsch-Positiv „online" bei totem Gateway → **Task A3** (Gateway-Liveness-Gate via `last_seen_at`/`gateway_down_threshold_s`). ✓
- **#2 (High)** Pro-Client Credential-Auto-Fill bricht → **Task B2 (a)** (credTarget folgt `connect_address`). ✓
- **#3 (High)** `baseUrl`-Host falsch hinter Cloudflare/NAT → **Task A1** (`GC_RDP_PUBLIC_HOST`-Override + `.env.example`). ✓
- **#4 (Medium)** NLA/Zert-Mismatch → **Task A4** (`rdp.gateway_nla_note` Hinweis im UI). ✓
- **#5 (Medium)** Android-VPN-Gate-Test schwer → **Task C3** (pure `requiresVpn()` + Unit-Test). ✓
- **#6 (Medium, watch)** kein E2E-Test: bewusst offen — manuelle E2E-Checkliste in `docs/feature-rdp-via-gateway-clients.md` (Task A5). 
- **#7 (Medium, watch)** alte Clients gegen neuen Server: CHANGELOG-Hinweis „Gateway-RDP-Verbindung erfordert Client ≥ Version X" (Tasks A5/B/C). 
```
