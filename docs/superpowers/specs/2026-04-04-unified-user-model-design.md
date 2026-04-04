# Unified User Model — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Merge API Tokens and Admin Users into a unified identity model with roles

---

## Problem

GateControl has two disconnected identity systems:
- `users` table: single admin account, session auth, password login
- `api_tokens` table: client identities with scopes, token auth, peer/machine binding

API tokens are effectively "users" — they have identity (name), permissions (scopes), device binding (machine fingerprint), and access control (RDP token_ids). But they're hidden in a Settings tab with no grouping or user context.

## Design

### Data Model

#### `users` table (extended)

Existing columns remain. New columns added via migration:

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Unchanged |
| username | TEXT UNIQUE | Login name / display identifier |
| display_name | TEXT | Optional display name |
| email | TEXT | Optional (primarily for admins) |
| password_hash | TEXT nullable | NULL = no web login (client user), set = admin |
| role | TEXT NOT NULL DEFAULT 'admin' | `admin` or `user` |
| enabled | INTEGER NOT NULL DEFAULT 1 | 0 = disabled, all tokens become invalid |
| created_at | TEXT | Unchanged |
| updated_at | TEXT | Unchanged |

#### `api_tokens` table (extended)

One new column:

| Column | Type | Description |
|--------|------|-------------|
| user_id | INTEGER nullable | FK → users(id) ON DELETE CASCADE. NULL = unassigned (migration state) |

All existing columns unchanged: name, token_hash, scopes, peer_id, machine_fingerprint, machine_binding_enabled, expires_at, last_used_at.

#### Relationships

```
users (1) ──→ (N) api_tokens     via user_id FK (nullable)
api_tokens (1) ──→ (0..1) peers  via peer_id FK (unchanged)
rdp_routes.token_ids             JSON array (unchanged, stays at token level)
```

#### Token-to-Peer binding rules

- If a token has machine binding: 1 token → 1 peer (bound on first registration)
- If unbound: 1 token can be used for multiple peers
- Admin can create multiple tokens per user

### Roles

| Property | admin | user |
|----------|-------|------|
| password_hash | Required | NULL (no web UI) |
| Web UI login | Yes | No |
| Allowed token scopes | All | Only `client`, `client:services`, `client:traffic`, `client:dns`, `client:rdp` |
| Manage peers (UI) | All | — |
| Own peers (via token) | Yes | Yes |

Token scopes can only **restrict** below the role's allowed scopes, never exceed them.

### Migration Strategy

1. Add `role` (default 'admin') and `enabled` (default 1) columns to `users`
2. Existing admin gets `role='admin'`, `enabled=1` automatically
3. Add `user_id` column (nullable) to `api_tokens`
4. Existing tokens: `user_id = NULL` (unassigned)
5. Unassigned tokens continue to function — auth middleware only checks user if `user_id` is set
6. Admin must manually assign tokens to users post-migration

### UI Structure

#### Sidebar

```
── Overview
   Dashboard

── VPN
   Peers

── Routing
   Routes
   RDP
   Certificates

── Access Control        (NEW section)
   Users                 (NEW page: /users)

── System
   Logs
   Settings
```

The Settings "API" tab is removed. Token management moves to user detail view.

#### `/users` — User List

Table columns:
- Name (username + display name)
- Role (badge: Admin / User)
- Tokens (count of assigned tokens)
- Peers (count of bound peers across tokens)
- Status (enabled/disabled)
- Last Access (most recent last_used_at across tokens)
- Actions (edit, disable, delete)

Header button: "Add User"

#### User Detail (Modal/Panel)

Sections:
- User info: username, display name, role, enabled toggle
- Password section: visible only for admin role (set/change password)
- Token list: all tokens of this user with create/revoke/machine-binding controls
- Unassigned tokens: shown separately for admin to assign

### API Endpoints

#### User CRUD (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/users` | List all users |
| POST | `/api/v1/users` | Create user (username, role, password?) |
| GET | `/api/v1/users/:id` | User detail including tokens |
| PATCH | `/api/v1/users/:id` | Update user |
| DELETE | `/api/v1/users/:id` | Delete user (cascades tokens) |
| PUT | `/api/v1/users/:id/toggle` | Enable/disable user |

#### Token endpoints (scoped to user)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/users/:id/tokens` | List tokens of a user |
| POST | `/api/v1/users/:id/tokens` | Create token for user |
| DELETE | `/api/v1/tokens/:id` | Revoke token (unchanged) |
| PUT | `/api/v1/tokens/:id/assign` | Assign unassigned token to user |

Legacy endpoints (`GET /api/v1/tokens`, `POST /api/v1/tokens`) remain as deprecated fallback.

### Auth Middleware Changes

Token auth flow (extended):
1. Validate token hash (unchanged)
2. Load `user_id` from token record
3. If `user_id` is set → load user → check `enabled`
4. Scope validation: token scopes intersected with role's allowed scopes
5. Continue with peer ownership check (unchanged)

Rules:
- Disabled user → all tokens immediately invalid (no extra token disable needed)
- Unassigned tokens (user_id = NULL) → work as before (backward compatible)
- Last admin cannot be deleted or degraded to `user` role
- Admin cannot delete themselves
- Token creation for `user` role rejects server scopes (settings, routes, peers, etc.)

### i18n

All new UI text in both `en.json` and `de.json`:
- Section label: "Access Control" / "Zugriffskontrolle"
- Page: "Users" / "Benutzer"
- Role labels, form fields, validation messages, confirmation dialogs
- Deprecation notice for unassigned tokens

## Out of Scope

- Viewer role (later)
- User self-registration
- Client-facing web portal
- Custom roles / role editor
- User groups
- Token scope inheritance / cascading

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Breaking change for existing tokens | Unassigned tokens keep working (user_id nullable, auth only checks when set) |
| Client API compatibility | Legacy `/api/v1/tokens` endpoints remain as fallback |
| Admin lockout | Self-protection: last admin not deletable/degradable |
