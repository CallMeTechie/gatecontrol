# Split-Tunneling v2 — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Admin-managed split-tunnel presets (global + per-token override) with a client API endpoint.

**Architecture:** Settings-based global preset stored as JSON in the settings table. Per-token override as a nullable JSON column on api_tokens. New GET /api/v1/client/split-tunnel endpoint resolves token-override then global then empty. Admin UI as new section in the Settings page.

**Tech Stack:** Node.js, Express, SQLite (better-sqlite3), Nunjucks templates, vanilla JS frontend

**Spec:** See android-client/docs/specs/2026-04-12-split-tunnel-v2-design.md

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| src/db/migrations.js | Modify | Add split_tunnel_override column to api_tokens |
| src/routes/api/settings.js | Modify | GET/PUT /api/v1/settings/split-tunnel |
| src/routes/api/client.js | Modify | GET /api/v1/client/split-tunnel |
| src/routes/api/users.js | Modify | Accept split_tunnel_override in token creation |
| src/services/tokens.js | Modify | Add splitTunnelOverride to create() |
| templates/default/pages/settings.njk | Modify | New Split-Tunnel tab panel |
| public/js/settings.js | Modify | Split-tunnel form load/save logic |
| src/i18n/en.json | Modify | English strings |
| src/i18n/de.json | Modify | German strings |

---

## Tasks

### Task 1: Database Migration

Add split_tunnel_override TEXT column to api_tokens table. Find the migrations array in src/db/migrations.js and append a new migration with the next version number.

### Task 2: Settings API (GET/PUT /api/v1/settings/split-tunnel)

Add two endpoints to src/routes/api/settings.js:
- GET: reads split_tunnel_preset from settings service, parses JSON, returns {mode, networks, locked}
- PUT: validates mode (off/exclude/include), validates networks array, stores as JSON via settings.set()

### Task 3: Client Endpoint (GET /api/v1/client/split-tunnel)

Add endpoint to src/routes/api/client.js. Resolution: check token.split_tunnel_override first (via tokens.getById), fall back to global preset (via settings.get), fall back to {mode:off, source:none}. Return {mode, networks, locked, source}.

### Task 4: Token API Extension

In src/routes/api/users.js POST /:id/tokens handler, accept split_tunnel_override from req.body. In src/services/tokens.js create(), add splitTunnelOverride parameter and include in INSERT statement.

### Task 5: Admin UI — Settings Template + JS

Add Split-Tunnel tab to settings.njk (tab button + panel with mode select, network presets checkboxes, custom network list, lock checkbox, save button). Add form logic to settings.js (load from GET, save to PUT, render custom network list, add/remove networks).

### Task 6: i18n Strings

Add all split-tunnel related strings to en.json and de.json.

### Task 7: Push + CI + Deploy

Push, watch CI, fix failures, pull image, deploy, verify endpoints.
