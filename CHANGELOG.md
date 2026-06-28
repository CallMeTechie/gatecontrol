# Changelog

## [1.103.9] — 2026-06-28

### Änderungen
- Klimaanlage im Portal — Portal-Widget (Sub-B)

---

## [1.103.8] — 2026-06-28

### Änderungen
- /midea-Redesign Papercut-Fixes (Status-Autoload, Modus-Icons, Add-Formular-Layout, Cloud-Key)

---

## [1.103.7] — 2026-06-28

### Änderungen
- Doku-Batch /midea-Redesign (feature-midea-page-redesign.md)

---

## [1.103.6] — 2026-06-28

### Änderungen
- /midea-Seite im Aurora-Stil neu gestaltet (Karten-Grid, Besitzer-Dialog, Add-Dialog; 3 Themes)

---

## [1.103.5] — 2026-06-28

### Änderungen
- AC-Besitzer-Zuordnung (midea_device_owners n:m)

---

## [Unreleased]

### Features
- Klimaanlage-Seite (/midea) im Aurora-Stil neu gestaltet: Geräte als Karten-Grid mit
  Temperatur-Ring und Steuerung, intuitive Besitzer-Zuweisung per Dialog (suchbare Nutzerliste),
  konsolidiertes „Gerät hinzufügen" mit Segment-Umschalter. Konsistent in allen 3 Themes. Reines
  Frontend-Redesign (keine API-/DB-Änderung).
- Klimaanlage-Besitzer-Zuordnung (Sub-A): Admin kann pro Midea-Klimagerät mehrere Besitzer (Nutzerkonten)
  zuweisen (n:m, Migration V62). Fundament für die kommende Portal-Steuerung „nur eigene Geräte" (Sub-B).
  Transaktionaler Cleanup bei User-/Geräte-Löschung. Lizenz-gegated `midea_integration`, admin-only.
- Klimaanlage im Portal (Sub-B): eingeloggte Portal-Nutzer sehen und steuern im VPN-Landing-Portal
  nur ihre eigenen Midea-Klimageräte (Ein/Aus, Zieltemperatur, Modus). Anzeige owner-gescopt
  (Session oder Geräte-Trust), Steuerung login-pflichtig mit isOwner-Guard; visibility-gebundener
  Auto-Poll. Neues, abschaltbares Portal-Widget. Lizenz-gegated `midea_integration`.

---

## [1.103.4] — 2026-06-27

### Änderungen
- Portal-Login-Fix (returnTo aufs Portal + Header-Login-Zustand)

---

## [1.103.3] — 2026-06-27

### Änderungen
- Midea-Cloud-Steuerung (TP-C) — dritter Transport (Cloud transparent-send)

---

## [1.103.2] — 2026-06-26

### Änderungen
- make tampered-ciphertext tamper deterministic (fix 1/256 flake) (#199)

---

## [1.103.1] — 2026-06-26

### Fixes
- MSmartHome login numeric types — value is illegal (#198)

---

## [Unreleased]

### Features
- Midea-Cloud-Steuerung (TP-C): Klimageräte über die Midea-Cloud steuern (dritter Transport neben Direkt-LAN), für cloud-verriegelte Geräte ohne LAN-Token. Derselbe `mideaAc`-Befehls-Frame über den Cloud-`transparent-send`-Endpoint (synchrone Antwort). Minimaler Cloud-Fußabdruck: kein 24/7-Dauer-Polling für Cloud-Geräte (Status aus der Befehlsantwort + manueller Aktualisieren-Button + optionales seitengebundenes Polling), 2FA/Re-Auth als sichtbarer Account-Zustand statt stillem Offline. Lizenz-gegated `midea_integration`, admin-only.
- Hinweis Credential-Custody: Cloud-Steuerung nutzt das Midea-Konto des Nutzers. Da die Midea-Cloud (Stand Spike) keinen bewiesenen passwortlosen Token-Refresh bietet, speichert GateControl das Midea-Passwort weiterhin verschlüsselt at-rest (`iv:tag:ct`), damit das automatische Re-Login funktioniert. Bewusste Produkt-Haftungs-Entscheidung; ein passwortloser Token-Refresh-Pfad ist Folgearbeit.

### Fixes
- Midea: MSmartHome-Cloud-Login — Anfrage-Felder `format`/`clientType`/`platform` jetzt als Zahlen (statt Strings) gemäß Referenz; behebt die Cloud-Ablehnung „value is illegal". Fehlermeldungen führen nun den Midea-Fehlercode mit.

---

## [1.103.0] — 2026-06-26

### Features
- subnet-directed discovery + manual add-by-IP (#196)

---

## [1.102.0] — 2026-06-26

### Features
- Midea-Klimasteuerung TP1 — Protokoll-Kern + Admin-Konfig (#195)

---

## [Unreleased]

### Änderungen
- Midea: subnetz-gerichtete Geräteerkennung für Multi-Homed-Hosts — Discovery sendet jetzt je Netzwerk-Interface an dessen Subnetz-Broadcast statt nur global (`255.255.255.255`).
- Midea: „Manuell hinzufügen (per IP)" auf der `/midea`-Seite — Gerät über seine LAN-IP einbinden, wenn die Erkennung es nicht findet (V3-Schlüssel weiterhin aus der Cloud).

---

## [1.101.1] — 2026-06-26

### Änderungen
- Pi-hole-Portal footgun-Review-Befunde (v5-Isolation + Härtung) (#194)

---

## [1.101.0] — 2026-06-26

### Features
- Pi-hole-Portal-Widget pro-Besitzer + Haushalt (TP2b) (#193)

---

## [1.100.0] — 2026-06-26

### Features
- Pi-hole DNS-Schutz-Widget pro-Gerät (TP2a, zero-login) (#192)

---

## [1.99.2] — 2026-06-25

### Fixes
- refuse Caddy /load over a config owned by another instance (#191)

---

## [1.99.1] — 2026-06-25

### Fixes
- Aurora add/edit user (and token) modals never opened (#190)

---

## [1.99.0] — 2026-06-25

### Features
- Geräte-Besitzer-Zuordnung (TP1 — peers.user_id + Admin-UI) (#189)

---

## [1.98.4] — 2026-06-25

### Fixes
- address footgun review findings (async/correctness/perf/security) (#188)

---

## [1.98.3] — 2026-06-25

### Fixes
- inject gateway_down_threshold_s so the slider shows the saved value (#187)

---

## [1.98.2] — 2026-06-25

### Fixes
- skip non-public-TLD bases in boot seeding + prune lingering pending rows (#186)

---

## [1.98.1] — 2026-06-25

### Fixes
- restore radio groups by name on autosave rollback (#184)

---

## [1.98.0] — 2026-06-25

### Features
- Domain-Registry-Bindung — Präfix + verifizierte Basis, Carve-out, Grandfathering, Nudge (#185)

---

## [1.97.3] — 2026-06-25

### Fixes
- identity header was deleted-after-set, so the portal showed no data (#183)

---

## [1.97.2] — 2026-06-25

### Fixes
- resync autosave dirty-snapshot after async load; align valuesById keys to element ids (#182)

---

## [1.97.1] — 2026-06-25

### Fixes
- drop GC_CADDY_EMAIL preflight — ACME issues portal cert without an account email (#181)

---

## [1.97.0] — 2026-06-25

### Features
- configurable portal subdomain with real ACME cert, strictly internal (sub-project C) (#180)

---

## [1.96.0] — 2026-06-25

### Features
- globales Settings-Autosave (kein Speichern-Button) (#179)

---

## [1.95.1] — 2026-06-24

### Änderungen
- patch 11 Dependabot alerts (Caddy 2.11.4 + transitive npm) (#178)

---

## [1.95.0] — 2026-06-24

### Features
- zentrale verifizierte Domain-Registry (Teilprojekt A) (#177)

---

## [1.94.1] — 2026-06-24

### Änderungen
- prune dangling images after a successful auto-update (#176)

---

## [1.94.0] — 2026-06-24

### Features
- VPN Landing Portal (Roadmap #6) — Phase 1 (#175)

---

## [1.93.6] — 2026-06-23

### Fixes
- Aurora RDP 'Add route' modal — load form-logic scripts, style selectors, fix dup (#174)

---

## [1.93.5] — 2026-06-23

### Fixes
- Aurora dashboard — compact KPI row, conditional Availability KPI, header auto-update, no reload (#173)

---

## [1.93.4] — 2026-06-23

### Fixes
- Aurora peers — bar-chart traffic modal + gateway card Name/IP rows (#172)

---

## [1.93.3] — 2026-06-23

### Fixes
- Aurora RDP card — move route name out of title into a Name row (#171)

---

## [1.93.2] — 2026-06-23

### Fixes
- Aurora RDP card — dedicated Host row so long FQDNs show in full (#170)

---

## [1.93.1] — 2026-06-23

### Fixes
- Aurora — card status badges, table headers, gateway card header (#169)

---

## [1.93.0] — 2026-06-23

### Features
- Aurora routes — batch multi-select (parity with pro/default) (#168)

---

## [1.92.2] — 2026-06-23

### Fixes
- Aurora parity — edit-modal tabs, routes buttons, GC contract, rdp-session (#167)

---

## [1.92.1] — 2026-06-23

### Fixes
- Aurora routes — nest grouped sub-routes + fix status toggle knob (#166)

---

## [1.92.0] — 2026-06-23

### Features
- Aurora routes — collapsible route groups (chevron + collapse-all) (#165)

---

## [1.91.5] — 2026-06-23

### Fixes
- Aurora routes list — restore group headers for related routes (#164)

---

## [1.91.4] — 2026-06-22

### Fixes
- Aurora gateway detail grid exactly 3 columns (1/3 each), not auto-fit (#163)

---

## [1.91.3] — 2026-06-22

### Fixes
- Aurora UX fixes — dashboard counts/gauges, page layouts, RDP/peers/settings (#162)

---

## [1.91.2] — 2026-06-22

### Fixes
- scale mouse coords + auto-fit on connect + CSS-pixel resolution (mouse offset / blur / perf / cut-off taskbar) (#159)

---

## [1.91.1] — 2026-06-22

### Fixes
- pass token+size via client.connect(data) so the WS query is well-formed (was corrupting dpi) (#158)

---

## [1.91.0] — 2026-06-21

### Features
- Aurora mockup fidelity — all 13 admin pages (#157)

---

## [1.90.3] — 2026-06-21

### Änderungen
- RDP/VNC browser-session experience settings (apply Edit-RDP-Route display/quality/security to guacd) (#156)

---

## [1.90.2] — 2026-06-21

### Fixes
- send display size (width/height/dpi) to guacd so the browser player renders (#155)

---

## [1.90.1] — 2026-06-21

### Änderungen
- Browser Remote Desktop Phase 3b — Player (in-browser session viewer + admin entry) (#154)

---

## [1.90.0] — 2026-06-21

### Features
- Aurora — drittes wählbares Admin-Theme (Dark/Light) (#153)

---

## [1.89.0] — 2026-06-21

### Features
- Phase A — active scan + live SSE results + inline enable (#152)

---

## [1.88.4] — 2026-06-21

### Änderungen
- tidy phase3a deferred minors (step-dot numbering + live tooltip, dead-code, test hygiene) (#151)

---

## [1.88.3] — 2026-06-21

### Änderungen
- Browser Remote Desktop — Phase 3a (Admin-Config UI) (#150)

---

## [1.88.2] — 2026-06-20

### Fixes
- push-token decrypt failures are non-fatal (no crash on corrupt token) (#149)

---

## [1.88.1] — 2026-06-20

### Fixes
- discovery adopt capability-aware + triggers scan (no more misleading 'no discovery support') (#148)

---

## [1.88.0] — 2026-06-20

### Features
- Drucker-Preset — Wizard + Orchestrator-Endpoint (POST /api/v1/printer-presets) (#146)

---

## [1.87.4] — 2026-06-20

### Änderungen
- Browser Remote Desktop Phase 2b (SSH/telnet + SFTP + Audio) (#147)

---

## [1.87.3] — 2026-06-20

### Fixes
- egress + Add-target form now actually opens (insertBefore NotFoundError) (#145)

---

## [1.87.2] — 2026-06-19

### Fixes
- Scan-/Fortschritts-CSS aus Stylesheets liefern (CSP blockierte injiziertes <style>) (#144)

---

## [1.87.1] — 2026-06-19

### Fixes
- make scan/loading progress bar reliably visible (Pro theme + fast local server) (#143)

---

## [1.87.0] — 2026-06-19

### Features
- add routes to an existing service + scan/loading indicators (#142)

---

## [1.86.2] — 2026-06-19

### Fixes
- retry warm-start latest-version fetch on transient boot failure (#141)

---

## [1.86.1] — 2026-06-19

### Änderungen
- Browser Remote Desktop Phase 2a (Backend-Tunnel) (#139)

---

## [1.86.0] — 2026-06-19

### Features
- persist + warm-start latest-version cache (no cold-start 'version check unavailable') (#140)

---

## [1.85.1] — 2026-06-19

### Änderungen
- bump nodemailer from 8.0.4 to 9.0.1 (#126)

---

## [1.85.0] — 2026-06-18

### Features
- Scan-Egress Phase 2 — server data model, API, config-push, UI (#138)

---

## [1.84.1] — 2026-06-18

### Fixes
- move Gateway-Failover into Monitoring panel (#137)

---

## [1.84.0] — 2026-06-18

### Features
- Browser Remote Desktop Phase 1 — protocol-aware rdp_routes refactor (#136)

---

## [1.83.1] — 2026-06-17

### Fixes
- reflect enforced blocking state in cache immediately (kill read-back race) (#135)

---

## [1.83.0] — 2026-06-17

### Features
- configurable external-access response for internal-only routes (#134)

---

## [1.82.0] — 2026-06-16

### Features
- block external access for internal-only L4 routes (#133)

---

## [1.81.2] — 2026-06-16

### Fixes
- rebuild internal hosts-file on server boot so route domains resolve after restart (#132)

---

## [1.81.1] — 2026-06-16

### Fixes
- true host health for gateway-mode RDP routes (#130)

---

## [1.81.0] — 2026-06-16

### Features
- per-route external-exposure switch (internal-always via DNS, external gate via Caddy) (#131)

---

## [1.80.2] — 2026-06-15

### Fixes
- skip failed requests on API limiter so a 429 storm can't pin the window (#129)

---

## [1.80.1] — 2026-06-15

### Fixes
- apply DNS-chain changes via real dnsmasq restart (SIGHUP can't reload upstreams) (#128)

---

## [1.80.0] — 2026-06-15

### Features
- Phase 2 server-companion — capability flags, token scopes, blocking audit identity (#125)

---

## [1.79.2] — 2026-06-14

### Fixes
- v6 stats-hardening (Phase A) — envelope-unwrap adapter + seat-safety + verbatim fixtures (#124)

---

## [1.79.1] — 2026-06-14

### Fixes
- reuse sync clients across cycles (avoid FTL login rate-limit) + port-correct chain re-apply

---

## [1.79.0] — 2026-06-14

### Features
- dns_port support + connection test validates DNS path

---

## [1.78.0] — 2026-06-13

### Features
- apply persists immediately + per-row test uses stored password (test/:id)

---

## [1.77.0] — 2026-06-13

### Features
- Pi-hole configuration tab in settings (instances CRUD + test + save)

---

## [1.76.6] — 2026-06-13

### Fixes
- dns chain revert is a no-op when nothing GC-managed (avoid boot reload for non-pihole installs)

---

## [1.76.5] — 2026-06-13

### Fixes
- /summary reads nested cache.summary fields (stat cards were blank)

---

## [1.76.4] — 2026-06-12

### Fixes
- wizards no longer close on outside click; DNS check in service wizard (#123)

---

## [1.76.3] — 2026-06-12

### Änderungen
- Service bundles + routes list redesign (#122)

---

## [1.76.2] — 2026-06-12

### Änderungen
- harden registration, sessions, routing, access rules + low-severity items (#121)

---

## [1.76.1] — 2026-06-04

### Fixes
- capture heartbeat lan_ip from telemetry-nested payload (#120)

---

## [1.76.0] — 2026-06-04

### Features
- loopback failover — co-located services survive automatic failover (#119)

---

## [Unreleased]

### Added
- **Service bundles**: one wizard ("Create service") creates an optional HTTP route plus any
  number of L4 port-forwards for the same domain/host in a single step — target chosen once,
  members permanently linked (`service_bundles` table + `routes.bundle_id`, migration 50).
  Lockstep enable/disable/delete, ungroup, and grouping of existing routes
  (`POST /api/v1/service-bundles/group`). Port conflicts answer 409 with a suggested free port
  (same pattern as RDP-via-gateway). Bundles are included in backup/restore.
- **Routes list redesign**: routes sharing a domain (or a service bundle) are grouped into
  collapsible cards with an aggregate status dot; switchable compact table view (persisted),
  filter chips for type/status/target plus sorting, and a badge budget (status + top features,
  rest behind a "+N" expander).
- An HTTP route and L4 routes may now share one domain (the unique-domain rule is scoped to
  HTTP↔HTTP and same-listener SNI collisions) — no more placeholder HTTP routes just to label
  an SSH port-forward.
- Gateway routes targeting services on the gateway host itself (`127.0.0.1`) now survive
  automatic failover — for HTTP, L4/TCP (e.g., SSH), and RDP-over-gateway: as long as the route
  is served by a sibling gateway, `127.0.0.1` is rewritten to the home gateway's LAN IP
  (reported via heartbeat). If unknown, HTTP returns a 502 maintenance page and L4 omits the
  listener (instead of misrouting to the wrong localhost).
- Route migration modal: new mode "permanently move to gateway" with LAN target input,
  live host search, and bulk-apply.

### Fixed
- Route migration modal showed `127.0.0.1` (legacy placeholder `target_ip`) for gateway routes
  instead of the actual backend `target_lan_host`.
- Loopback failover: the heartbeat `lan_ip` was never captured into `gateway_meta.lan_ip` because
  the companion nests it under `telemetry` (`body.telemetry.lan_ip`, a sibling of `lan_subnets`)
  while the server read it top-level (`body.lan_ip`) — so the column stayed NULL and every
  loopback failover hit the safe-degrade path (HTTP 502 / no L4 listener). The heartbeat handler
  now reads `body.telemetry.lan_ip` (with a top-level fallback); the regression test was sending a
  top-level payload the real gateway never emits, masking the bug.

---

## [1.75.3] — 2026-05-30

### Fixes
- surface RDP route validation errors in UI instead of silently closing; trim WoL MAC

---

## [1.75.2] — 2026-05-30

### Fixes
- RDP gateway route port conflict returns 409 with suggested free port instead of 500

---

## [1.75.1] — 2026-05-29

### Fixes
- recover update.sh recreate from host-net/name race (down+up retry)

---

## [1.75.0] — 2026-05-29

### Features
- server auto-update — mode toggle, dashboard status, setup guide (#117)

---

## [1.74.9] — 2026-05-29

### Dokumentation
- document server auto-update setup (matches hardened update.sh)

---

## [1.74.8] — 2026-05-29

### Fixes
- guard update.sh against recreating from the wrong project dir

---

## [1.74.7] — 2026-05-29

### Fixes
- mirror update-toast CSS into pro.css (was invisible on Pro theme)

---

## [1.74.6] — 2026-05-29

### Fixes
- update.sh recreates on running-vs-latest digest mismatch, not pull output

---

## [1.74.5] — 2026-05-29

### Fixes
- gateway update status as a toast, not inline card text

---

## [1.74.4] — 2026-05-28

### Fixes
- route-auth sessions, OTPs & share links never expired by time

---

## [1.74.3] — 2026-05-28

### Fixes
- account lockout never triggered (timestamp format mismatch)

---

## [1.74.2] — 2026-05-28

### Fixes
- log malformed JSON in route custom_headers/mirror_targets

---

## [1.74.1] — 2026-05-28

### Fixes
- SSDP/upnp:rootdevice hint cleanup, dedupe IP in device row, l4 domain precedence, scan-icon spinner, auto-update card → modal with green/orange icon

---

## [1.74.0] — 2026-05-28

### Features
- discovery settings → gear icon modal, richer device rows, scan icon in title

---

## [1.73.1] — 2026-05-28

### Fixes
- discovery cards use .top/.body card frame + surface real API errors

---

## [1.73.0] — 2026-05-28

### Features
- LAN discovery Phase 3 — server backend + admin UI (closes Roadmap #8) (#116)

---

## [1.72.7] — 2026-05-27

### Dokumentation
- #8 discovery — address devil's-advocate round 2 (request_id reconciliation, ingest validation/escaping, capability flag in phase 2, ingest rate-limit, SSDP no-fetch, drop min-version); active-scan default off confirmed

---

## [1.72.6] — 2026-05-27

### Dokumentation
- #8 discovery — address devil's-advocate round 1 (capability detection, multicast binding, active-scan opt-in, request_id, phasing, SSE scoping, cancel, staleness re-probe)

---

## [1.72.5] — 2026-05-27

### Dokumentation
- #8 discovery — service categories (include/exclude) + configurable subnet cap/timeout

---

## [1.72.4] — 2026-05-27

### Dokumentation
- gateway LAN service discovery (#8) design

---

## [1.72.3] — 2026-05-27

### Dokumentation
- add true-ARP-sweep as deferred add-on to #8 LAN discovery

---

## [1.72.2] — 2026-05-27

### Dokumentation
- resolve #5 — geo/country filter already shipped; ASN → backlog

---

## [1.72.1] — 2026-05-27

### Fixes
- access-windows rule builder — day toggles + time pickers + labels + CSS (#115)

---

## [1.72.0] — 2026-05-27

### Features
- access windows in create-route modal (#114)

---

## [1.71.0] — 2026-05-27

### Features
- scheduled access windows (#4) (#113)

---

## [1.70.6] — 2026-05-26

### Fixes
- strip gc.route.sid session cookie from upstream request (Speedport cleared it, killing route-auth sessions) (#112)

---

## [1.70.5] — 2026-05-26

### Änderungen
- rebuild release (transient GHCR 'unknown blob' push failure on 1.70.4)

---

## [1.70.4] — 2026-05-26

### Fixes
- route-auth session cookie SameSite=Lax so share-link sessions survive cross-site arrival (#111)

---

## [1.70.3] — 2026-05-26

### Fixes
- show share-link URL after creation + clipboard copy icon (#110)

---

## [1.70.2] — 2026-05-26

### Änderungen
- trigger release build for #109 (Actions outage recovery)

---

## [1.70.1] — 2026-05-26

### Änderungen
- harden harness temp-dir cleanup to keep /tmp from filling (#108)

---

## [1.70.0] — 2026-05-26

### Features
- ephemeral share links (#3) (#107)

---

## [1.69.3] — 2026-05-25

### Änderungen
- plain update.sh download + guide (drop setup-script/zip) (#106)

---

## [1.69.2] — 2026-05-25

### Fixes
- bake /state volume into generated gateway compose (#103)

---

## [1.69.1] — 2026-05-25

### Fixes
- show step-by-step guide content in setup card (#102)

---

## [1.69.0] — 2026-05-25

### Features
- gateway auto-update setup bundle (detail-view download + guide) (#101)

---

## [1.68.0] — 2026-05-25

### Features
- gateway auto-update trigger (#2b) (#100)

---

## [1.67.0] — 2026-05-25

### Features
- full-page detail view matching mockup (#99)

---

## [1.66.3] — 2026-05-25

### Fixes
- cache-bust all local css/js assets (#98)

---

## [1.66.2] — 2026-05-25

### Fixes
- formatted drilldown detail view (#97)

---

## [1.66.1] — 2026-05-25

### Fixes
- style fleet page (scoped .gw-fleet CSS, both themes) + server-rack nav icon (#96)

---

## [1.66.0] — 2026-05-25

### Features
- real-time event bus (SSE) for live admin UI (#93)

---

## [1.65.0] — 2026-05-25

### Features
- gateway fleet dashboard (roadmap #2a) (#95)

---

## [1.64.0] — 2026-05-25

### Features
- clearer route wizard — contextual domain/SNI field, blocked-port hints, tooltips (#94)

---

## [Unreleased]

### Änderungen
- Route-Wizard & Edit-Modal: kontextabhängiges Domain-/SNI-Feld (bei L4 ohne TLS ausgeblendet), Hinweise + Live-Prüfung auf gesperrte Ports, Tooltips, klarere TLS-Modus-Texte

---

## [1.63.1] — 2026-05-24

### Änderungen
- use npm ci for deterministic, lockfile-faithful installs (#91)

---

## [1.63.0] — 2026-05-24

### Features
- RDP-over-gateway server support — connect endpoint + gateway-aware health + wizard UX

---

## [1.62.3] — 2026-05-08

### Fixes
- replace otel v1.40.0 → v1.43.0 to close CVE-2026-29181

---

## [1.62.2] — 2026-05-08

### Änderungen
- use setup helper so DB-backed settings.get works

---

## [1.62.1] — 2026-05-08

### Fixes
- bug triage 2026-05-08 — reconciler subroute, caddy-stdout, csrf pollution

---

## [1.62.0] — 2026-05-03

### Features
- close LB gaps — L4 multi-upstream, passive health, trusted_proxies

---

## [Unreleased]

### Features
- pool load-balancing for L4 routes (TCP/UDP) — caddy-l4 proxy handler now renders multiple upstreams + selection_policy when a pool is in `load_balancing` mode; previously L4 collapsed to the first alive member regardless of mode
- passive health checks on pool-LB reverse-proxy routes — drops a backend after 3× 5xx for 30 s without needing an active probe, gives free circuit-breaking even when gatewayHealth still thinks the peer is alive
- `srv0` http server now declares `trusted_proxies` (RFC1918 + CGNAT + IPv6 ULA + loopback) and `client_ip_headers: [X-Forwarded-For]` so `ip_hash` LB and other client-IP-aware policies see the real client when GateControl runs behind a private LB or CDN
- RDP `gateway` access-mode routes now resolve a public `connect_address` / `connect_port` and expose them on `GET /api/v1/client/rdp` (list) and `GET /api/v1/client/rdp/:id/connect`. Resolution by mode: `gateway` → `GC_RDP_PUBLIC_HOST` (or GC base-URL host) + `gateway_listen_port`; `external` / `both` → `external_hostname:external_port`; `internal` → `host:port`. New optional env `GC_RDP_PUBLIC_HOST` for deployments behind Cloudflare / NAT / reverse-proxy where the GC base-URL host doesn't pass the raw L4 RDP port.
- RDP route wizard (gateway mode): host field now shows a hint that the LAN IP of the target goes here, adds an NLA note, and suppresses the peer autocomplete to avoid confusion in gateway mode.
- **Compatibility note:** connecting to a gateway RDP route from the Pro / Android client requires the client build with gateway connect-address support (follow-up phases B/C — server-side changes are backward-compatible).

### Fixes
- caddyReconciler: `extractCaddyRouteIds` now recurses into `subroute` handlers, so routes wrapped for forward-auth (route_auth without basic_auth, or ip_filter) are no longer reported as missing every 5 min. Fixes the perpetual `Caddy config diverged from DB missing_in_caddy:["gc_route_<id>"]` WARN and the loop-repair landmine under `GC_CADDY_AUTO_RECONCILE=1`
- caddy-start.sh no longer tees stdout into `/data/caddy/caddy-stdout.log`. The file was an unrotated duplicate of the container's stdout (observed: 678 MB after 4 days). Caddy logs now flow only through Docker's log driver, which has rotation
- csrf middleware no longer pre-generates tokens for fresh anonymous visitors. Bot scans of `/.git/config`, `/.env`, etc. previously created a 24h `sessions` row each (~11.5k anon rows in 24 h) because csrf-sync wrote `req.session.csrfToken` and bypassed `saveUninitialized:false`. Tokens are now minted only when a session has state worth protecting (authenticated user, or an existing token); the login page calls a new `ensureCsrfToken()` helper to keep the unauthenticated form flow working
- injectLocals: the flash-message branch unconditionally wrote `req.session.flash = {}` on every request, which was a *second* source of session pollution independent of CSRF. Now only consumes & clears flash if there's actually something to consume; anon requests no longer mutate the session at all
- RDP health monitor (`rdpMonitor.js`) now probes gateway routes via the loopback L4 listen port instead of the unreachable LAN host, and only reports the route as "online" when the linked gateway peer's heartbeat is still fresh — prevents false-positive "online" when the home gateway is dead.

---

## [1.61.10] — 2026-05-03

### Änderungen
- drop dead target_peer_id branch in resolveRouteUpstreams

---

## [1.61.9] — 2026-05-02

### Fixes
- boot-time failover reconcile

---

## [1.61.8] — 2026-05-02

### Fixes
- export _onTransition so the failover-pivot tests can drive it

---

## [Unreleased]

### Changed
- **gateway-pool failover now uses DB pivot instead of caddy-side resolution.** When a pool member goes offline, `gatewayHealth._onTransition` updates `routes.target_peer_id` to the highest-priority alive sibling and records the original peer in a new `routes.original_peer_id` column. On recovery the route flips back. This replaces the previous implicit-failover path through `caddyConfig.resolveRouteUpstreams` plus the sibling-routes branch in `getGatewayConfig`. Net effect: simpler code, single source of truth (the routes table), and a SQL query trivially shows who serves what right now.

### Fixes
- migration v43: `routes.original_peer_id` (nullable, FK to peers with ON DELETE SET NULL)
- new activity-log events: `pool_failover_activated`, `pool_failover_restored`

---

## [1.61.7] — 2026-05-02

### Fixes
- boot-push retries until handshake + WG symlink survives rewrite

---

## [1.61.6] — 2026-05-02

### Fixes
- companion sees sibling pin-routes for implicit failover

---

## [Unreleased]

### Fixes
- implicit pool failover only worked at the frontend caddy layer — the alive sibling never received the offline peer's pin-routes in its companion config, so failed-over traffic hit a 404 on the sibling's companion-caddy. Companion config queries now include sibling pin-routes for every pool member.
- on container boot, push a config-refresh notification to all alive pool members with retry/backoff so the WG handshake gap (peers configured but no encrypted session yet) doesn't permanently miss the refresh — previously a single attempt at 5 s would always EHOSTUNREACH on a fresh boot
- `fs.renameSync` in `_rewriteWgConfigInner` was clobbering the `/etc/wireguard/wg0.conf` → `/data/wireguard/wg0.conf` symlink, leaving the persistent /data file empty across restarts. Every container start would boot WireGuard with zero peers until Node re-ran the rewrite, creating a multi-second window where pool members were unreachable. Now resolves symlinks first so the rename hits the persistent file and the symlink stays intact.

---

## [1.61.5] — 2026-05-02

### Fixes
- seed snapshot from DB at boot for implicit failover

---

## [1.61.4] — 2026-05-02

### Fixes
- route peer-pinned routes through resolveRouteUpstreams

---

## [1.61.3] — 2026-05-02

### Fixes
- GET /:id/members + working migrate-routes flow

---

## [1.61.2] — 2026-05-02

### Fixes
- make insertGatewayPeer mark peer offline

---

## [Unreleased]

### Fixes
- gateway-pool form save did not persist member changes — members held in the modal DOM were never sent to the server (new `PUT /api/v1/gateway-pools/:id/members` bulk endpoint, form submits members alongside the pool fields)
- gateway-pool edit modal showed empty members because `GET /api/v1/gateway-pools/:id/members` did not exist — frontend was 404-ing and falling back to an empty list
- "Migrate Routes" button on /gateway-pools had no working submit handler — clicking OK only closed the modal
- cache-bust `gatewayPools.js` with `?v={{ appVersion }}` so users get JS updates immediately instead of waiting up to 24 h for the browser cache to expire (same pattern as peers.js)

### Features
- **implicit pool failover for peer-pinned routes** — routes targeting a single gateway now automatically fail over to the highest-priority alive sibling in the same pool when the pinned peer goes offline; recovers back to the pinned peer when it returns. No route migration required, just add the gateway to a pool. Explicit `target_pool_id` routing still works for load-balancing scenarios.
- gateway-pool modal: 2-column layout with members panel on the right, drag-and-drop reordering (top = highest priority), auto-position assignment, and dropdown filters out gateways already in the pool
- migrate-routes: per-route checklist (grouped by source peer) lets the user explicitly bind routes to a pool (useful for load-balancing); loopback routes (127.0.0.1) are flagged and unchecked by default to prevent accidental cross-machine routing

---

## [1.61.1] — 2026-05-01

### Fixes
- read CSRF token from GC.csrfToken (not nonexistent window.csrfToken) (#85)

---

## [1.61.0] — 2026-05-01

### Features
- edit proxy_port on existing gateway peers (#84)

---

## [1.60.0] — 2026-05-01

### Features
- per-peer proxy_port (default 8080) — fixes DSM 8080 conflict (#83)

---

## [1.59.6] — 2026-05-01

### Fixes
- push companion-config-change on toggle (was only on update) (#82)

---

## [1.59.5] — 2026-05-01

### Fixes
- pool modal UX — keep open on outside-click, fix cooldown layout, label priority, guard mode listener (#81)

---

## [1.59.4] — 2026-04-30

### Fixes
- clear cooldown-preset options on re-init to avoid duplicates (#80)

---

## [1.59.3] — 2026-04-30

### Fixes
- use window.GC.t (correct API) for pool i18n + expose pool keys in layouts (#79)

---

## [1.59.2] — 2026-04-30

### Fixes
- add gateway-pools CSS (data-table, modal-box, pool-mode-badges) + missing i18n keys (#78)

---

## [1.59.1] — 2026-04-30

### Fixes
- add gateway-pools sidebar link + page template (#77)

---

## [1.59.0] — 2026-04-30

### Features
- gateway-pool failover & load-balancing (#76)

---

## [Unreleased]

### Added
- Gateway-Pool concept with Failover and Load-Balancing modes (license-gated)
- Per-pool Failback-Cooldown with reboot-time presets (LXC, VM, Proxmox, NAS, Windows)
- Companion-Sync with confirmation before Caddy re-render (no 502 cutover-races)
- Configurable global gateway-down threshold (default 90 s, range 30–600 s)
- Pool-Outage render path separate from User-Maintenance
- Activity-log events: gateway_down, gateway_alive, gateway_recovery_interrupted, pool_outage_started, pool_outage_resolved
- Webhook event: gateway_state_change
- Auto-disable pools on license downgrade

---

## [1.58.30] — 2026-04-30

### Änderungen
- align monitor_gateway health-transition test with new liveness model

---

## [1.58.29] — 2026-04-29

### Änderungen
- split routes/api/settings.js into 6 domain clusters

---

## [1.58.28] — 2026-04-29

### Änderungen
- align license-gated and autobackup expectations with current behavior

---

## [1.58.27] — 2026-04-29

### Änderungen
- extract PATCH-semantics validateIfProvided helper (#75)

---

## [1.58.26] — 2026-04-29

### Änderungen
- extract sync-with-rollback pattern into routesSync.js (#74)

---

## [1.58.25] — 2026-04-29

### Änderungen
- extract auth subroute + handler chain into caddyAuthSubroute.js (#73)

---

## [1.58.24] — 2026-04-29

### Änderungen
- extract TLS automation policies into caddyTlsAutomation.js (#72)

---

## [1.58.23] — 2026-04-29

### Fixes
- explicit timeout + retry/backoff for Caddy admin calls (#71)

---

## [1.58.22] — 2026-04-29

### Fixes
- support overnight time wrap-around in maintenance schedules (#70)

---

## [1.58.21] — 2026-04-29

### Fixes
- applyResponseHeaders merges instead of clobbering reverseProxy.headers (#69)

---

## [1.58.20] — 2026-04-29

### Änderungen
- extract canAccessRoute into rdpAcl.js (#68)

---

## [1.58.19] — 2026-04-29

### Änderungen
- extract maintenance-window logic into rdpMaintenance.js (#67)

---

## [1.58.18] — 2026-04-29

### Änderungen
- extract credential management into rdpCredentials.js (#66)

---

## [1.58.17] — 2026-04-29

### Änderungen
- extract branding + bot-blocker validation into routesValidation.js (#65)

---

## [1.58.16] — 2026-04-29

### Änderungen
- extract sync-rollback helpers into routesRollback.js (#64)

---

## [1.58.15] — 2026-04-29

### Änderungen
- extract backend resolver into caddyBackends.js (#63)

---

## [1.58.14] — 2026-04-29

### Änderungen
- extract custom-headers handler builders into caddyCustomHeaders.js (#62)

---

## [1.58.13] — 2026-04-29

### Änderungen
- extract retry config into caddyRetry.js (#61)

---

## [1.58.12] — 2026-04-29

### Änderungen
- extract mirror handler builder into caddyMirror.js (#60)

---

## [1.58.11] — 2026-04-29

### Änderungen
- extract circuit-breaker open-state handler into caddyCircuitBreaker.js (#59)

---

## [1.58.10] — 2026-04-29

### Fixes
- own dnsmasq lifecycle from wg-wrapper.sh, drop redundant supervisord program (#58)

---

## [1.58.9] — 2026-04-29

### Änderungen
- re-trigger release pipeline after stale v1.58.9 tag cleanup

---

## [1.58.8] — 2026-04-29

### Fixes
- show password field on first open of edit-route auth tab

---

## [1.58.7] — 2026-04-28

### Fixes
- collapsed gateway card no longer stretched to row height

---

## [1.58.6] — 2026-04-28

### Fixes
- key icon really opens the pairing-tokens modal (not downloadGatewayEnv)

---

## [1.58.5] — 2026-04-28

### Änderungen
- key icon mirrors Edit-modal -> ENV button flow exactly

---

## [1.58.4] — 2026-04-28

### Änderungen
- key icon opens pairing-tokens modal without rotating gateway tokens

---

## [1.58.3] — 2026-04-28

### Änderungen
- ENV-Download button -> key icon that opens the pairing-tokens modal directly

---

## [1.58.2] — 2026-04-28

### Änderungen
- convert Gateway-Card 'Bearbeiten' button to pencil icon

---

## [1.58.1] — 2026-04-28

### Fixes
- trash icon belongs on the Gateway-CARD, not the regular peer row

---

## [1.58.0] — 2026-04-28

### Features
- gateway-aware delete with route-impact preview + IP-typing safety

---

## [1.57.0] — 2026-04-28

### Features
- platform-specific intro/instructions + responsive modal

---

## [1.56.0] — 2026-04-28

### Features
- platform picker (Synology vs Linux kernel WG)

---

## [1.55.1] — 2026-04-28

### Fixes
- bind-mount /dev/net/tun in host-mode compose

---

## [1.55.0] — 2026-04-28

### Features
- docker-compose.yml + Synology install in the Docker tab

---

## [1.54.9] — 2026-04-28

### Fixes
- include CSRF token + same-origin creds on pairing-code request

---

## [1.54.8] — 2026-04-28

### Fixes
- cache-bust peers.js with appVersion query param

---

## [1.54.7] — 2026-04-27

### Änderungen
- override license limit so all subtests can create peers

---

## [1.54.6] — 2026-04-27

### Fixes
- null L4-only columns on non-L4 routes (create + update)

---

## [1.54.5] — 2026-04-27

### Fixes
- derive HTTP-route protocol from backend_https, never l4_protocol

---

## [1.54.4] — 2026-04-27

### Fixes
- restore missing helpers/getDb imports in client/traffic + status

---

## [1.54.3] — 2026-04-26

### Fixes
- reject malformed validateOnline responses before mutating state

---

## [1.54.2] — 2026-04-26

### Fixes
- import missing getDb in client/rdp.js connect handler

---

## [1.54.1] — 2026-04-26

### Fixes
- restore release-cache constants in client/update.js

---

## [1.54.0] — 2026-04-24

### Features
- periodic reconciler detects + optionally repairs DB↔Caddy drift (#49)

---

## [1.53.0] — 2026-04-24

### Features
- TCP-probe poller detects silent dead gateways + faster recovery (#48)

---

## [1.52.4] — 2026-04-24

### Fixes
- process-level error handlers + robust idempotent shutdown (#47)

---

## [1.52.3] — 2026-04-24

### Fixes
- derive COMPOSE_DIR from script location; guard on missing compose (#46)

---

## [1.52.2] — 2026-04-24

### Fixes
- restore missing imports in client router sub-modules (PR #41 regression) (#45)

---

## [1.52.1] — 2026-04-24

### Dokumentation
- add INSTALL.md covering DNS, layout, first login, backup, migration (#44)

---

## [1.52.0] — 2026-04-24

### Features
- reveal /health detail to authenticated admin sessions (#43)

---

## [1.51.0] — 2026-04-23

### Features
- extend /health with Caddy liveness check, version and uptime (#42)

---

## [1.50.13] — 2026-04-23

### Änderungen
- split client.js (1267 lines) into focused sub-router modules (#41)

---

## [1.50.12] — 2026-04-23

### Änderungen
- split caddyConfig.js into five focused modules (#40)

---

## [1.50.11] — 2026-04-23

### Änderungen
- split migrations.js (941 lines) into four focused modules (#39)

---

## [1.50.10] — 2026-04-23

### Änderungen
- prevent tests from reconfiguring live Caddy via network_mode:host (#38)

---

## [1.50.9] — 2026-04-23

### Fixes
- clear gateway_* on route target_kind switch + deploy from GHCR (#37)

---

## [1.50.8] — 2026-04-23

### Änderungen
- dedup gateway token hash into single source (#36)

---

## [1.50.7] — 2026-04-23

### Änderungen
- bug-hunt Welle-2 final batch (batch 13)

---

## [1.50.6] — 2026-04-22

### Änderungen
- bug-hunt Welle-2 medium findings (batch 8)

---

## [1.50.5] — 2026-04-22

### Fixes
- close 8 license-gate UX gaps flagged by audit

---

## [1.50.4] — 2026-04-22

### Fixes
- wire retry_match_status + expose circuit-breaker reset

---

## [1.50.3] — 2026-04-22

### Fixes
- strip {{count}} placeholder from batch buttons when empty

---

## [1.50.2] — 2026-04-22

### Änderungen
- drop Gateway-Routen stat card, rename Clients → Peers

---

## [1.50.1] — 2026-04-22

### Fixes
- route_reachability is ground truth, not self-check flags

---

## [1.50.0] — 2026-04-22

### Features
- redesigned page with collapsible Home-Gateway cards

---

## [1.49.0] — 2026-04-22

### Features
- expose gateway telemetry in peer-edit modal

---

## [1.48.0] — 2026-04-22

### Features
- auto-register CSV tokens on peer save + startup backfill

---

## [1.47.4] — 2026-04-22

### Fixes
- drop LIKE ESCAPE + use correct /api/v1 prefix in test

---

## [1.47.3] — 2026-04-22

### Fixes
- HTTP routes always have an Auto-TLS cert

---

## [1.47.2] — 2026-04-22

### Fixes
- list all routes with a domain, not only https_enabled=1

---

## [1.47.1] — 2026-04-22

### Änderungen
- move management card from /peers to /settings

---

## [1.47.0] — 2026-04-22

### Features
- hostname field in add-peer modal (license-gated)

---

## [1.46.0] — 2026-04-21

### Features
- hostname field in pro peer-edit modal (license-gated)

---

## [1.45.0] — 2026-04-21

### Features
- accept hostname in gateway heartbeat for internal DNS

---

## [1.44.5] — 2026-04-21

### Änderungen
- remove redundant Gateway-Host footer card

---

## [1.44.4] — 2026-04-21

### Änderungen
- move Uptime boot-date right-aligned into card header

---

## [1.44.3] — 2026-04-21

### Fixes
- make Verfügbarkeit card functional, drop fake uptime %

---

## [1.44.2] — 2026-04-21

### Fixes
- keep compact toggle-groups at content width

---

## [1.44.1] — 2026-04-21

### Änderungen
- 2-col grid layout, min-height, toast errors

---

## [1.44.0] — 2026-04-21

### Features
- 6-step create-route wizard modal replaces sidebar form

---

## [1.43.4] — 2026-04-21

### Änderungen
- serialise release runs per branch via concurrency group

---

## [1.43.3] — 2026-04-21

### Änderungen
- re-trigger release after race-condition in previous run

---

## [1.43.2] — 2026-04-21

### Fixes
- sync default theme template with pro — wizard + dots

---

## [1.43.1] — 2026-04-21

### Fixes
- restyle step indicator — dots + lines, no text wrapping

---

## [1.43.0] — 2026-04-21

### Features
- route RDP sessions through the Home Gateway (access_mode=gateway)

---

## [1.42.2] — 2026-04-21

### Fixes
- block port 22 by default + coerce listen_port to number in sync

---

## [1.42.1] — 2026-04-21

### Fixes
- L4 gateway routes forward to gateway tunnel-IP, not placeholder

---

## [1.42.0] — 2026-04-21

### Features
- propagate backend_https flag to gateway config sync

---

## [1.41.11] — 2026-04-21

### Fixes
- never TLS-wrap the Caddy → gateway hop

---

## [1.41.10] — 2026-04-21

### Fixes
- isolate login assets under /route-auth/static/*

---

## [1.41.9] — 2026-04-21

### Fixes
- render login template with theme + i18n middleware

---

## [1.41.8] — 2026-04-21

### Fixes
- unbreak edit-save for gateway routes — don't send target_ip=null

---

## [1.41.7] — 2026-04-21

### Fixes
- ship env with /32 Address + AllowedIPs=server-only

---

## [1.41.6] — 2026-04-20

### Fixes
- don't apply SSRF private-IP guard to gateway routes

---

## [1.41.5] — 2026-04-20

### Fixes
- unbreak crash-loop — export after secrets, pkill instead of supervisorctl

---

## [1.41.4] — 2026-04-20

### Fixes
- self-heal after /load leaves Caddy in a broken TLS state

---

## [1.41.3] — 2026-04-20

### Fixes
- gateway routes show LAN target, not '127.0.0.1'

---

## [1.41.2] — 2026-04-20

### Fixes
- boot with pre-generated JSON to eliminate TLS-alert-80 race

---

## [Unreleased]

### Fixes
- Eliminate the TLS-alert-80 race that occurred on every image deploy.
  Caddy previously booted with a minimal Caddyfile and Node replaced the
  whole config via `POST /load` after 5 s — during that transition
  Caddy's TLS listener could be left in a broken state, producing
  `internal error` TLS alerts on every handshake (affected browsers
  hitting the admin UI and the Home-Gateway heartbeat alike). Now
  `entrypoint.sh` exports the final JSON from the DB via
  `src/bin/export-caddy-config.js` and Caddy starts directly with it;
  Node skips the redundant startup sync when `GC_CADDY_CONFIG_PRELOADED`
  is set. Falls back to the static Caddyfile if export or validation
  fails, so the admin UI stays reachable.
- Route-create form: explicit alerts for missing fields and field-error
  mapping per `target_kind` so gateway-route validation errors aren't
  attached to the hidden peer-fields input.

---

## [1.41.1] — 2026-04-20

### Fixes
- add DE translations for new route form error messages

---

## [1.41.0] — 2026-04-20

### Features
- target_kind selector in route create form

---

## [1.40.6] — 2026-04-20

### Fixes
- include WG_PRESHARED_KEY in gateway.env download

---

## [1.40.5] — 2026-04-20

### Fixes
- derive WG_ENDPOINT + WG_SERVER_PUBLIC_KEY for gateway.env

---

## [1.40.4] — 2026-04-19

### Fixes
- token modal with copy + download, CSRF via api.post, license fallback merge

---

## [1.40.3] — 2026-04-19

### Fixes
- pass NODE_AUTH_TOKEN to docker build in Trivy scan step

---

## [1.40.2] — 2026-04-19

### Dokumentation
- Home Gateway rollout plan v1.2 (coordinated deploy)

---

## [1.40.1] — 2026-04-19

### Fixes
- fallback keygen when wg unavailable + NODE_AUTH_TOKEN for ESLint job

---

## [1.40.0] — 2026-04-19

### Features
- migration 36 — gateway peer type, route target discrimination, gateway_meta

---

## [1.39.17] — 2026-04-19

### Fixes
- round-3 — _computeBroadcast tests + no-new-privileges doc consistency

---

## [1.39.16] — 2026-04-19

### Fixes
- round-2 — WoL tests for RFC1918 + lan_host_port + Dockerfile ARG default

---

## [1.39.15] — 2026-04-19

### Fixes
- round-1 review findings (systems + reliability)

---

## [1.39.14] — 2026-04-19

### Fixes
- round-3 — await createGateway in Task 22 peer-create handler

---

## [1.39.13] — 2026-04-19

### Fixes
- round-2 — async/await pervasive + i18n-keys dedicated task

---

## [1.39.12] — 2026-04-19

### Fixes
- round-1 review findings (backend + integration)

---

## [1.39.11] — 2026-04-19

### Fixes
- round-3 — moduleNameMapper excludes dist/ (integration test resolves to built artifact)

---

## [1.39.10] — 2026-04-19

### Fixes
- round-2 review findings (testPathIgnorePatterns, fuzz-swallow, ESM-hash-script, test-counts)

---

## [1.39.9] — 2026-04-19

### Fixes
- address round-1 review findings (crypto + TDD + CI)

---

## [1.39.8] — 2026-04-18

### Dokumentation
- Home Gateway Plan 3/3 — gatecontrol-gateway Node.js repo

---

## [1.39.7] — 2026-04-18

### Dokumentation
- Home Gateway Plan 2/3 — GateControl server changes

---

## [1.39.6] — 2026-04-18

### Dokumentation
- Home Gateway Plan 1/3 — config-hash npm package

---

## [1.39.5] — 2026-04-18

### Dokumentation
- Home Gateway v1.2 — second devils-advocate round

---

## [1.39.4] — 2026-04-18

### Dokumentation
- Home Gateway v1.1 — platform matrix + devils-advocate fixes

---

## [1.39.3] — 2026-04-18

### Dokumentation
- Home Gateway Companion design (2026-04-18)

---

## [1.39.2] — 2026-04-18

### Fixes
- hide self-host routes from client listing

---

## [1.39.1] — 2026-04-17

### Fixes
- missing i18n + opportunistic hostname capture on heartbeat

---

## [1.39.0] — 2026-04-17

### Features
- mirror internal DNS page into pro theme

---

## [1.38.0] — 2026-04-17

### Features
- admin page for internal DNS

---

## [1.37.2] — 2026-04-17

### Änderungen
- drop implicit internal_dns coupling

---

## [1.37.1] — 2026-04-17

### Fixes
- implicit internal_dns when remote_desktop is licensed

---

## [1.37.0] — 2026-04-16

### Features
- include peer_hostname + peer_fqdn in RDP connect response

---

## [1.36.0] — 2026-04-16

### Features
- phase-2 peer hostname in admin UI

---

## [1.35.0] — 2026-04-16

### Features
- phase-1 internal DNS server core

---

## [1.34.0] — 2026-04-16

### Features
- phase-0 internal DNS preflight and hardening

---

## [1.33.0] — 2026-04-16

### Features
- return peerEnabled in heartbeat response

---

## [1.32.9] — 2026-04-15

### Fixes
- IP access control input field too small in route edit modal

---

## [1.32.8] — 2026-04-15

### Fixes
- immediately disconnect peers on disable/delete/expiry

---

## [1.32.7] — 2026-04-15

### Fixes
- add padding-left to search inputs in Pro theme for search icon visibility

---

## [1.32.6] — 2026-04-15

### Fixes
- update current user theme when changing system default theme

---

## [1.32.5] — 2026-04-15

### Fixes
- reload page after theme change to apply server-rendered layout

---

## [1.32.4] — 2026-04-15

### Fixes
- add missing auth.sign_in_subtitle i18n key for Pro login page

---

## [1.32.3] — 2026-04-15

### Fixes
- use active theme from DB for all page renders including login

---

## [1.32.2] — 2026-04-15

### Fixes
- show user display name instead of device name in history

---

## [1.32.1] — 2026-04-15

### Fixes
- rename connection history tab to RDP Connection History

---

## [1.32.0] — 2026-04-15

### Features
- connection history as own tab in logs page

---

## [1.31.0] — 2026-04-15

### Features
- move connection history from RDP to Logs page with sort, filter, pagination

---

## [1.30.0] — 2026-04-15

### Features
- RDP history — pagination, sort, filter, device column

---

## [1.29.6] — 2026-04-15

### Fixes
- RDP history backend — period filter, column aliases, pagination count, peer name join

---

## [1.29.5] — 2026-04-15

### Fixes
- auto-update peer description via middleware on all client requests

---

## [1.29.4] — 2026-04-15

### Fixes
- update peer description on heartbeat with current client version

---

## [1.29.3] — 2026-04-15

### Fixes
- show correct client type label based on platform

---

## [1.29.2] — 2026-04-14

### Änderungen
- extract Caddy config builder from routes.js into caddyConfig.js

---

## [1.29.1] — 2026-04-14

### Fixes
- add dedicated rate limiting for file upload endpoints

---

## [1.29.0] — 2026-04-14

### Features
- add retry with exponential backoff for email delivery

---

## [1.28.8] — 2026-04-14

### Fixes
- add flex gap to page-content for consistent spacing between dashboard sections

---

## [1.28.7] — 2026-04-14

### Fixes
- use original sun/star logo icon in Pro theme (Royal Blue background, white strokes)

---

## [1.28.6] — 2026-04-14

### Fixes
- Settings General — two-col layout (left: Theme+Danger, right: WG+Caddy) in both themes

---

## [1.28.5] — 2026-04-14

### Fixes
- reorder Settings General tab in default theme — Theme → WireGuard → Caddy

---

## [1.28.4] — 2026-04-14

### Fixes
- reorder Settings General tab — Theme → WireGuard → Caddy stacked layout

---

## [1.28.3] — 2026-04-14

### Fixes
- 4 Pro theme issues — scroll, toggles, batch-bar, default theme setting

---

## [1.28.2] — 2026-04-14

### Fixes
- remove overflow:hidden from body and shell, enable scrolling in main-wrap

---

## [1.28.1] — 2026-04-14

### Dokumentation
- document Pro theme and GC_DEFAULT_THEME configuration

---

## [1.28.0] — 2026-04-14

### Features
- add Pro theme pages (settings, certificates, profile)

---

## [1.27.0] — 2026-04-14

### Features
- add Pro theme modal partials (confirm, peer-add/edit/qr/traffic, route-edit)

---

## [1.26.0] — 2026-04-14

### Features
- add Pro theme layout and partials (sidebar, topbar, bottomnav, fab)

---

## [1.25.0] — 2026-04-14

### Features
- add per-user theme switching via profile page

---

## [1.24.1] — 2026-04-13

### Fixes
- remove 10.0.0.0/8 from private nets preset (conflicts with WireGuard VPN subnet)

---

## [1.24.0] — 2026-04-12

### Features
- i18n strings for split-tunnel settings (en + de)

---

## [1.23.4] — 2026-04-11

### Fixes
- restart dnsmasq after wg0 is up to ensure it binds to VPN interface

---

## [1.23.3] — 2026-04-11

### Fixes
- clear tbody loading placeholder when rendering mobile cards

---

## [1.23.2] — 2026-04-11

### Fixes
- render user cards with labels on mobile instead of CSS table hack

---

## [1.23.1] — 2026-04-11

### Fixes
- user action buttons use flex layout + mobile responsive in app.css

---

## [1.23.0] — 2026-04-11

### Features
- 4-step token wizard + responsive mobile layout for /users

---

## [1.22.1] — 2026-04-11

### Fixes
- load RDP credentials in edit modal + disable browser autocomplete

---

## [1.22.0] — 2026-04-11

### Features
- disconnect-all button, delete button, auto stale-session cleanup

---

## [1.21.1] — 2026-04-11

### Fixes
- accept X.509/SPKI-encoded ECDH public keys from Android clients

---

## [1.21.0] — 2026-04-10

### Features
- add disconnect-all endpoint for RDP sessions

---

## [1.20.9] — 2026-04-10

### Fixes
- make update check/download endpoints public (no auth required)

---

## [1.20.8] — 2026-04-09

### Fixes
- wg0 FORWARD accept all tunnel traffic, not just VPN subnet

---

## [1.20.7] — 2026-04-09

### Fixes
- wg0 FORWARD rule must be a catch-all `-i wg0 -j ACCEPT`, not scoped to
  `-d ${GC_WG_SUBNET}`. The narrow scope only permitted peer-to-peer and
  silently dropped every VPN → internet packet (FORWARD policy DROP),
  so the tunnel came up but clients had no external connectivity. The
  reply path stays covered by the existing RELATED,ESTABLISHED rule.

---

## [1.20.6] — 2026-04-09

### Fixes
- dnsmasq waits for wg0 via interface= directive (listen-address race)

---

## [1.20.5] — 2026-04-09

### Fixes
- override stale GC_NET_INTERFACE when configured value does not exist

---

## [1.20.4] — 2026-04-09

### Fixes
- auto-detect egress interface so VPN peer internet actually works

---

## [1.20.3] — 2026-04-09

### Fixes
- use GC_BASE_URL hostname (not GC_WG_HOST) for dnsmasq hijack

---

## [1.20.2] — 2026-04-09

### Fixes
- trivyignore CVE-2026-39883 (otel-go kenv BSD-only, not exploitable on Alpine)

---

## [1.20.1] — 2026-04-09

### Fixes
- split-horizon DNS so VPN peers reach API through tunnel

---

## [1.20.0] — 2026-04-08

### Features
- Server-seitiger TCP-Check-Endpoint für Client RDP

---

## [1.19.15] — 2026-04-08

### Fixes
- Update-Download nutzt direkte GitHub-URL für öffentliche Repos

---

## [1.19.14] — 2026-04-08

### Fixes
- RDP toggle test erwartet jetzt Boolean statt SQLite Integer

---

## [1.19.13] — 2026-04-08

### Fixes
- permissions endpoint prüft jetzt auch Lizenz-Feature für RDP

---

## [1.19.12] — 2026-04-08

### Fixes
- persist circuit breaker state, add Caddy rollback, add task retry

---

## [1.19.11] — 2026-04-08

### Fixes
- pin eslint-plugin-security@1.7.1 for ESLint 8 compatibility

---

## [1.19.10] — 2026-04-08

### Änderungen
- add ESLint Security to PR gate + c8 test coverage

---

## [1.19.9] — 2026-04-08

### Fixes
- use npm@latest for glob/cross-spawn CVEs, ignore picomatch

---

## [1.19.8] — 2026-04-08

### Fixes
- update npm to 10.9.2 to fix cross-spawn CVE-2024-21538

---

## [1.19.7] — 2026-04-08

### Fixes
- remove global npm update that introduced picomatch CVE

---

## [1.19.6] — 2026-04-08

### Fixes
- add npm overrides for transitive CVEs (picomatch, cross-spawn)

---

## [1.19.5] — 2026-04-08

### Fixes
- patch remaining container CVEs (cross-spawn, go-jose/v4)

---

## [1.19.4] — 2026-04-08

### Fixes
- patch container vulnerabilities (zlib, npm, Go deps)

---

## [1.19.3] — 2026-04-08

### Fixes
- update caddy-mirror plugin to Caddy v2.11.2

---

## [1.19.2] — 2026-04-08

### Fixes
- add actions:read permission for CodeQL workflow

---

## [1.19.1] — 2026-04-08

### Fixes
- block releases on critical/high container vulnerabilities

---

## [1.19.0] — 2026-04-07

### Features
- add Android client support to update check endpoint

---

## [1.18.3] — 2026-04-07

### Fixes
- use api.del() instead of api.delete() for token revocation and user deletion

---

## [1.18.2] — 2026-04-05

### Fixes
- add user visibility checkboxes to create route form

---

## [1.18.1] — 2026-04-05

### Fixes
- add migration 33 for user_ids column + filter services/RDP by user

---

## [1.18.0] — 2026-04-04

### Features
- add token assignment UI for unassigned tokens in users page

---

## [1.17.2] — 2026-04-04

### Fixes
- prevent modal backdrop click from closing user/token modals

---

## [1.17.1] — 2026-04-04

### Fixes
- users page CSS — use correct modal/table classes, fix JS field names

---

## [1.17.0] — 2026-04-04

### Features
- add users page with token management, remove settings API tab

---

## [1.16.0] — 2026-04-04

### Features
- add user API routes and token user_id support

---

## [1.15.0] — 2026-04-04

### Features
- add user service with CRUD, role validation, and tests

---

## [1.14.1] — 2026-04-04

### Fixes
- remove WG/Caddy config pages, move service cards to settings

---

## [1.14.0] — 2026-04-04

### Features
- implement ECDH E2EE for RDP credential transmission

---

## [1.13.1] — 2026-04-04

### Fixes
- show RDP route count badge on all pages, not just /routes

---

## [1.13.0] — 2026-04-04

### Features
- maintenance window enforcement — block client connect during scheduled maintenance

---

## [1.12.4] — 2026-04-03

### Fixes
- RDP session disconnect — fallback lookup by routeId when sessionId missing

---

## [1.12.3] — 2026-04-03

### Fixes
- rewrite RDP dashboard to match mockup design exactly

---

## [1.12.2] — 2026-04-03

### Fixes
- DNS-Leak-Test Endpoint gibt VPN-DNS-Config zurück statt req.ip

---

## [1.12.1] — 2026-04-03

### Fixes
- robust client type detection via version range and X-Client-Name

---

## [1.12.0] — 2026-04-03

### Features
- support separate update repos for Community and Pro client

---

## [1.11.3] — 2026-04-03

### Fixes
- update check uses wrong repo, add redirect support and token docs

---

## [1.11.2] — 2026-04-02

### Fixes
- revert to push trigger for releases

---

## [1.11.1] — 2026-04-02

### Fixes
- register client:rdp as valid token scope

---

## [1.11.0] — 2026-04-02

### Features
- add client:rdp token scope for RDP access control

---

## [1.10.0] — 2026-04-02

### Features
- add host autocomplete with peer search, access mode field dependencies

---

## [1.9.3] — 2026-04-02

### Fixes
- use GC_DATA_DIR for keypair path, set in test setup

---

## [1.9.2] — 2026-04-02

### Fixes
- update deprecated actions to latest, fix npm audit vulnerabilities

---

## [1.9.1] — 2026-04-02

### Fixes
- skip CodeQL on dependabot PRs (insufficient token permissions)

---

## [1.9.0] — 2026-04-02

### Features
- add CodeQL, npm audit, ESLint security, Dependabot, and security gate for releases

---

## [1.8.3] — 2026-04-01

### Fixes
- fix script load order, add api.patch(), stats 6-column layout, filter bar under stats

---

## [1.8.2] — 2026-04-01

### Fixes
- rewrite modal to section-based scrollable layout matching mockup

---

## [1.8.1] — 2026-04-01

### Fixes
- fix modal CSS classes, show/hide mechanism, and port hint element IDs

---

## [1.8.0] — 2026-04-01

### Features
- register RDP health check and session cleanup in background tasks

---

## [1.7.0] — 2026-04-01

### Features
- add i18n keys for EN and DE -- RDP dashboard, routes, errors

---

## [1.6.1] — 2026-04-01

### Änderungen
- unified Build & Release workflow with auto-versioning

---

All notable changes to GateControl are documented in this file.

---

## [1.6.0] — 2026-03-29

### Features
- **Client Scope for API Tokens** — New dedicated `client` scope restricts tokens to `/api/v1/client/*` endpoints only. Windows/Desktop clients no longer need the overly broad `peers` scope.
- **Token Permissions UI Restructured** — Scopes are now grouped into three sections: Access Level, Resources, and Integration. Full-access acts as a master toggle that auto-selects and disables all other checkboxes — no more manually checking every option.

### Tests
- **Token Scope Tests** — New `tests/tokens.test.js` with 33 tests covering scope validation, `checkScope` logic (full-access, read-only, client, resource scopes, edge cases), token CRUD API, and token-based auth enforcement.

---

## [1.5.2] — 2026-03-24

### Improvements
- **Multiple Backends — Peer Selection** — Backend targets now use a peer dropdown instead of manual IP input. Peer IPs are resolved at Caddy config build time, so backend configs automatically update when a peer's IP changes. Disabled peers are skipped.
- **Mirror Targets — Peer Selection** — Same improvement for Request Mirroring targets. Peer dropdown instead of IP input, automatic IP resolution, disabled peers skipped.

### UI
- Dashboard stat cards: 5 columns layout, compact padding and font sizes
- Dashboard: Fixed missing green stripe on Monitoring card
- Sidebar: Peer badge now consistently shows total peer count (was showing online count on dashboard, total on other pages)
- Sidebar: Removed peer group count badge (redundant)

### Documentation
- `documentation/USER-GUIDE.md` — Complete user guide covering DNS setup, peer/client configuration, WireGuard clients (including docker-wireguard-go), all route features, authentication methods, 2FA/TOTP setup
- `demo/index.html` — Interactive animated demo with pixel-accurate GateControl UI, 2 walkthrough scenes (Peer creation with QR code, Route creation with all feature toggles), auto-scrolling cursor

---

## [1.5.1] — 2026-03-23

### Security — Critical
- **CSRF-Bypass Prevention** — Defensive reset of `req.tokenAuth` against prototype pollution attacks
- **Route-Auth Forward-Auth** — Returns 401 instead of 200 when `x-route-domain` header is missing
- **Caddy Config Injection** — Header name/value validation, rate_limit_window allowlist, sticky_cookie_name regex
- **DNS-Check SSRF** — Domain validation before DNS lookup, resolved IPs removed from response
- **Key-File Permissions** — Re-secured after recursive chown in entrypoint

### Security — High
- **Route-Auth Lockout** — Changed from IP-based to email-based lockout (prevents IP rotation bypass)
- **OTP Range** — Full 000000–999999 range with `padStart` (was excluding leading-zero codes)
- **OTP Resend** — Requires valid pending 2FA session before allowing code resend
- **CSRF Key Separation** — Route-auth CSRF uses HMAC-derived key instead of shared app secret
- **WireGuard Config Injection** — DNS validated as IP list, keepalive as integer, newlines blocked
- **Email HTML Injection** — All interpolated values in email templates escaped
- **Route Target SSRF** — Private/loopback IPs blocked for direct route targets (peer-linked routes unaffected)
- **Metrics Token Leak** — Removed `?token=` query parameter auth, header-only authentication
- **WG Key in Logs** — wg-quick output filtered to strip private key lines
- **Trust Proxy** — Restricted to loopback only (prevents IP spoofing via X-Forwarded-For)
- **CSP Styles** — Split into `style-src-elem` (nonce-protected) and `style-src-attr` (inline attributes)
- **Dashboard XSS** — API integers coerced with `parseInt` and inserted via `textContent`

### Security — Medium
- **TOTP Replay Prevention** — In-memory tracking of used TOTP codes per route (90s expiry)
- **Session Secure Warning** — Startup warning when production mode without HTTPS
- **Rate-Limiter Bypass** — Elevated limit only for session-authenticated requests
- **Backup Key Validation** — Regex allowlist for settings keys during restore
- **IP Filter Fix** — Uses Express-resolved `req.ip` instead of raw X-Forwarded-For header
- **CSS Injection** — Peer group color validated against hex regex
- **Monitoring XSS** — Response time sanitized with `parseInt` before HTML insertion
- **API Key Masking** — ip2location key no longer exposed in DOM, shows "Key is set" instead
- **Health Endpoint** — Detailed component state only for localhost, external gets `{ok: true/false}`
- **WG Signal Handling** — Guard variable prevents premature `wg-quick down` during startup

### Security — Low/Info
- Rate-limit error strings translated (EN+DE)
- Hardcoded German strings in routes.njk replaced with i18n
- Dead code `generateCsrfToken`/`verifyCsrfToken` removed
- Argon2 parallelism reduced from 4 to 1 (libuv thread pool)
- CSP `frame-ancestors: 'self'` added (clickjacking protection)
- Crypto ciphertext split with explicit length validation
- Branding fields capped at 255 (title) / 2000 (text) characters

### Documentation
- `documentation/SECURITY-HARDENING-v1.5.1.md` — Full security audit report with all 39 findings
- `documentation/SECURITY-CHANGES-v1.5.md` — Detailed migration guide for breaking changes (#13, #14, Prometheus config, Header-Auth)

---

## [1.5.0] — 2026-03-23

### New Features
- **Request Mirroring** — Duplicate HTTP requests asynchronously to up to 5 secondary backends for testing, debugging, or shadow deployments. Implemented as a custom Caddy Go module (`http.handlers.mirror`) with async goroutines, `sync.Pool` body buffering (max 10 MB), and 10s per-target timeout. Mirror targets receive an exact copy (method, URI, headers, body). Client response is never affected. WebSocket upgrades are automatically skipped. Configurable via UI toggle + target editor or API.

### Improvements
- Docker: Custom `caddy-mirror` Go module added to Caddy build via xcaddy
- `.dockerignore` excludes `*.tar.gz` to reduce build context size
- Activity log: `route_mirror_changed` event for mirror configuration audit trail
- Server-side validation for mirror targets (IP, port, max 5, no primary-backend overlap, HTTP-only)

### UI
- Mirror toggle + target editor in route create form and edit modal
- Blue `Mirror: N targets` badge on route cards
- Mobile FAB speed-dial with Peer/Route add options
- Settings tab bar: no vertical scroll, no rounded corners, active tab with bottom border
- Settings tabs collapse to hamburger menu on mobile (≤900px)
- Route badges on mobile: horizontal scroll instead of stacking

### i18n
- 8 new mirror-related translation keys (EN + DE)

---

## [1.4.0] — 2026-03-23

### New Features — Foundation
- **API Tokens** — Stateless token authentication for automation (CI/CD, Home Automation, scripts). Scoped permissions (full-access, read-only, per-resource). SHA-256 hash storage, `gc_` prefix, Bearer and X-API-Token header support
- **Migration History Table** — Versioned database migration system with auto-detection of legacy databases. 25 migrations tracked
- **Mobile Sidebar** — Responsive hamburger menu for phones/tablets (< 1024px) with slide-in animation, overlay, focus trap, ARIA

### New Features — Core Improvements
- **Peer Expiry** — Optional expiration date per peer (1d/7d/30d/90d/custom). Background task auto-disables expired peers every 60s. Visual indicators (expired/expires soon)
- **Peer Access Control (ACL)** — Restrict which WireGuard peers can access a route via Caddy `remote_ip` matcher. Multi-select checklist in route settings
- **Automatic Backups** — Scheduled backups (6h/12h/daily/3d/weekly) with retention limit. Run-now button, file list with download/delete in Settings
- **Log Export** — Download activity and access logs as CSV or JSON with filter support

### New Features — Advanced Routing
- **Gzip/Zstd Compression** — Per-route response compression via Caddy `encode` handler
- **Custom Request/Response Headers** — Key-value editor per route with CORS and Security header presets. New "Headers" tab in route edit modal
- **Per-Route Rate Limiting** — Configurable requests/window via `caddy-ratelimit` plugin (added to Dockerfile)
- **Retry with Backoff** — Automatic retries on backend failure via Caddy `load_balancing.retries`
- **Multiple Backends / Load Balancing** — Weighted round-robin across multiple backend targets per route
- **Sticky Sessions** — Cookie-based session affinity for multi-backend routes

### New Features — Observability & Management
- **Prometheus Metrics Export** — `/metrics` endpoint with 12 gauges (peers, routes, CPU, RAM, uptime, per-peer traffic, per-route monitoring). Token + query-param auth. Toggle in Settings
- **Circuit Breaker** — Per-route circuit breaker (closed/open/half-open). Returns 503 via Caddy when backends fail repeatedly. Auto-recovery via monitoring checks
- **Batch Operations** — Multi-select peers and routes for bulk enable/disable/delete with floating action bar
- **Peer Groups** — Organize peers by team/location with colored badges, filter dropdown, group management card. Backup v3

### Testing
- **API test script** expanded to 231 tests across 31 sections covering all features
- Tests cover: health, auth, dashboard, peers CRUD, routes CRUD, route auth, settings, SMTP, logs, WireGuard, Caddy, system, webhooks, tokens, backup, peer expiry, ACL, auto-backup, log export, compression, custom headers, rate limiting, retry, backends, sticky sessions, Prometheus, circuit breaker, batch operations, peer groups, error handling, security

### Improvements
- Docker: `caddy-ratelimit` plugin added to Caddy build, `/data/backups` directory
- Deploy: `SYS_MODULE` capability in docker-compose.yml, feature summary in setup.sh
- Rate limiting: 1000 req/15min for token-authenticated requests (vs 100 for unauthenticated)
- Backup format upgraded to version 3 (includes peer groups and ACL rules)

### Bug Fixes
- Fix token auth: use `req.originalUrl` to detect API routes
- Fix Caddy `load_balancing.selection_policy` format (object, not array)
- Fix Caddy retry config (inside `load_balancing` object, not top-level)
- Fix all route toggle switches (remove `data-managed`, deduplicate handlers)
- Fix ACL toggle with self-contained click handler
- Fix batch bar visibility in batch mode
- Fix backup test for version 3
- Remove browser confirm dialog on token revoke

---

## [1.3.0] — 2026-03-20

### New Features
- **Custom Branding for Route Auth** — Upload logo, set title, welcome text, accent/background color, and background image per route auth login page
- **IP Access Control / Geo-Blocking** — Per-route IP/CIDR whitelist or blacklist with optional country-based filtering via ip2location.io
- **Uptime Monitoring** — HTTP and TCP health checks per route with dashboard widget, configurable interval, and email alerts on route down/recovery
- **Email Alert System** — Event-based email notifications configurable per event group (Security, Peers, Routes, System) with backup reminders and CPU/RAM threshold alerts
- **Per-Peer Traffic Graphs** — Interactive traffic history charts (24h, 7d, 30d) with persistent upload/download totals per peer
- **Account Lockout** — Configurable lockout after N failed login attempts for admin and route-auth login with manual unlock via Settings
- **Password Complexity Enforcement** — Configurable rules for minimum length, uppercase letters, numbers, and special characters
- **API Versioning** — `/api/v1/` as primary mount with backward-compatible `/api/` alias
- **API Integration Tests** — 30+ tests with Supertest covering Auth, Peers, Routes, Dashboard, Settings, Webhooks, Logs, System, Health, and Backup endpoints
- **Field-Level Validation Errors** — Per-field error messages with red border and focus for peers and routes
- **Configurable Operational Timeouts** — 9 ENV vars for operational timeouts plus Settings UI for data retention and peer timeout
- **Favicon** — SVG + ICO favicon added

### Improvements
- Toggle endpoints changed from POST to PUT for REST correctness
- All frontend API calls migrated to `/api/v1/`
- Route edit modal restructured with tabs and wider layout
- DNS validation warning when creating/editing HTTP routes
- "Subdomains" renamed to "Domains" in navigation, titles, and labels
- Architecture diagram updated with Route Auth, SMTP, and Forward Auth

### Security
- 6 critical code review issues resolved (open redirect, IP allocation race condition, WireGuard iptables leak, showError/hideError fix, session secret validation, CSS class fix)
- 5 important security issues resolved (timing-safe CSRF/OTP comparison, rate limiter IP keying, SSRF DNS rebinding protection, route-auth CSRF domain binding)
- Node reverted to root user — WireGuard CLI requires root privileges; container provides isolation

### Bug Fixes
- 7 business logic issues resolved (backup includes route-auth, encryption key validation on restore, traffic rates with real time interval, traffic snapshots as deltas, Caddy reload uses syncToCaddy, WG config parser fix, atomic OTP verification)
- 4 Docker/Ops issues resolved (Caddy fetch timeout, atomic WG config writes, encryption key startup validation, health check verifies DB + WireGuard, shutdown stops session cleanup)
- 8 Frontend/UX issues resolved (i18n in JS, toggle/delete error visibility, German labels replaced with i18n, JSON parse error handling, label for-attributes, toggle ARIA/keyboard, CSS variables corrected, btn-secondary defined)
- Monitoring HTTP check now accepts self-signed certificates
- Route-auth CSRF tokens use pipe separator instead of dots

---

## [1.2.0] — 2026-03-18

### New Features
- **Route Authentication System** — Custom login page per route with multiple auth methods: Email & Password, Email & Code (OTP via SMTP), TOTP (Authenticator App). Optional Two-Factor Authentication (2FA) with configurable session duration
- **SMTP Configuration** — Built-in SMTP settings for sending email verification codes, configurable via Settings UI with test email functionality
- **Caddy Config Page** — View live Caddy reverse proxy JSON configuration with syntax highlighting and JSON export
- Route auth config integrated into both route create form and edit modal
- Auth method, 2FA, and session duration badges displayed on route list

### Improvements
- Security hardening: 13 issues addressed from security review
- Duplicated code consolidated and simplified across codebase
- Host networking fix for QUIC and L4 port issues

### Bug Fixes
- Forward auth uses Caddy pattern (GET rewrite + vars) to preserve request body
- CSRF protection replaced with HMAC-signed tokens for route auth (no cookie needed)
- Forward auth correctly proxies to backend on 2xx instead of returning 'OK'
- Static assets (CSS, JS) bypass forward auth on route-auth domains
- Caddy config syncs after route auth create/update/delete
- Email input CSS, sticky modal header/footer, 2FA toggle double-click fix

---

## [1.1.0] — 2026-03-16

### New Features
- **Layer 4 TCP/UDP Proxy** — Raw TCP and UDP port forwarding via caddy-l4 plugin. Three TLS modes (None, Passthrough, Terminate), port ranges, TLS-SNI routing, blocked port protection
- **Custom Caddy Build** — Caddy built with caddy-l4 plugin for Layer 4 routing support
- **Host Networking** — `network_mode: host` for dynamic L4 port binding without container restart

### Improvements
- **Multi-Stage Docker Build** — Native dependencies compiled in builder stage (420MB → 402MB)
- **Graceful Shutdown** — HTTP server closed cleanly, running requests finish, 10s timeout
- **Composite Database Indexes** — 4 composite indexes for activity_log, peers, and routes
- **Standardized API Response Format** — `ok` field added to all endpoints
- Caddy config validation in entrypoint with warning on errors
- Copy-to-clipboard button for WireGuard config
- Setup script updated for host networking, auto iptables, port conflict check
- API rate limiter no longer blocks authenticated users

### Bug Fixes
- WireGuard FORWARD rules inserted before Docker rules (`-I` instead of `-A`)
- RELATED/ESTABLISHED FORWARD rule and subnet-scoped MASQUERADE for WireGuard NAT
- Caddy admin API Origin header compatibility (v2.11+ requirement)
- L4 proxy dial format corrected (array of strings)
- HTTP-only badges hidden for L4 routes

---

## [1.0.3] — 2026-03-14

### Improvements
- Profile dropdown with separate profile page and logout button
- Retry-After header added to rate limiting responses
- CSRF token rotation after sensitive actions (password change, restore)
- Button loading states for all async operations
- Duplicate `formatBytes()` removed from logs.js

### Bug Fixes
- Nunjucks template error in topbar dropdown fixed
- Auto-sync package.json version from release tag

---

## [1.0.2] — 2026-03-13

### Improvements
- Modal focus trap and centralized modal handling
- Error responses sanitized with i18n for all API error messages

### Bug Fixes
- Modal no longer closes on overlay click (prevents accidental data loss)
- Release workflow: delete existing assets before upload

---

## [1.0.1] — 2026-03-11

### Initial Release

First public release of GateControl — Unified WireGuard VPN + Caddy Reverse Proxy Management.

#### Core Features
- **WireGuard VPN Peer Management** — Create, edit, enable/disable, delete peers with automatic key generation, IP allocation, QR codes, and hot-reload via `wg syncconf`
- **Caddy Reverse Proxy Routing** — Domain-based routing with automatic HTTPS via Let's Encrypt, optional Basic Auth, backend HTTPS support, peer-linked routes
- **Dashboard** — Connected peers, active routes, traffic charts (1h, 24h, 7d), CPU/RAM/uptime, average latency
- **Backup & Restore** — Full system backup as portable JSON with atomic transaction-based restore
- **Activity & Access Logs** — Full activity log with severity levels and filtering, Caddy access log with rotation
- **Webhooks** — Event-driven notifications with SSRF protection
- **Internationalization** — Full English and German language support (400+ keys)

#### Security
- AES-256-GCM encryption at rest for sensitive data
- Session-based auth with Argon2 password hashing
- CSRF protection, rate limiting, Helmet.js security headers, CSP nonces
- Webhook SSRF protection blocking private/internal IP ranges

#### Infrastructure
- Single Docker container orchestrating Node.js, WireGuard, and Caddy via Supervisord
- Interactive setup script supporting Ubuntu, Debian, Fedora, CentOS, RHEL, Rocky, Alma, Alpine
- Online (GHCR) and offline (tar.gz) installation options
- Docker health check endpoint (`/health`)
- GitHub Actions CI/CD with automatic GHCR publishing
