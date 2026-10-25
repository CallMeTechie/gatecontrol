# Groups (Gruppenverwaltung)

Groups are teams, departments, projects, sites and the family — kept once,
centrally, in GateControl. Access rules, plugins and chats all use the same
groups instead of every plugin keeping its own member lists. Groups are part
of every edition; no licence is needed.

**Admin rights never come from a group.** Whether an account is an
administrator is decided only by its role in **Benutzer**.

The admin page is **Benutzer › Gruppen** (`/groups`).

## Kinds and nesting

| Kind | German | Typical use |
|---|---|---|
| `department` | Abteilung | Verwaltung, IT |
| `team` | Team | Buchhaltung, Support |
| `project` | Projekt | Umzug 2027 — may have an end date |
| `site` | Standort | Büro Köln |
| `family` | Familie | the household (maintained by the Familie plugin) |

- Groups nest **at most 3 levels** (e.g. Verwaltung › Buchhaltung › Kreditoren).
  A group cannot be moved below itself or one of its subgroups.
- A name is unique **per parent** (case-insensitive): two departments may
  both have a team "Support".
- Family groups stay at the top level and have no subgroups.

## Members and roles

| Role | German | Meaning |
|---|---|---|
| `member` | Mitglied | belongs to the group |
| `lead` | Leitung | approves (e.g. leave requests), sees team reports, manages team resources in plugins |
| `deputy` | Vertretung | like the lead when a plugin reports the lead as absent |
| `admin` | Gruppen-Admin | maintains members and invitation links; no leadership rights in plugins |

Family groups use `parent` (Eltern) and `child` (Kind) instead; in a family
the parents lead.

- **Inherited membership:** whoever is in a subgroup also counts as a member
  of every group above it (role there: member). The group page lists these
  people under "… Personen aus Untergruppen".
- **Leadership walks up:** if a group has no lead or deputy, the lead/deputy
  of the nearest group above leads it. Nobody is their own leader.
- **Disabled accounts** keep their memberships, but they rest: no access and
  no leadership through groups until the account is enabled again. **Deleted
  accounts** lose all memberships.

## Projects with an end date

A project may carry an end date. The day after, GateControl archives it
(hourly check): access through the group and its subgroups ends, members and
data stay. **Archivieren** does the same by hand; **Wiederherstellen** brings
an archived group back (an end date that has already passed is cleared, so
the group is not archived again at once). Archived groups are hidden in the
tree unless "Archivierte zeigen" is on.

## Sources: local, directory, plugin

Every group has a source:

- **local** — created in GateControl (by hand or with the CSV import).
- **directory** — comes from Active Directory, Entra ID or LDAP (directory
  sync). Name, structure and the members from the directory are read-only
  here and are changed in the directory. You can still give **GateControl
  roles** (lead, deputy, group admin) and add **extra local members** (e.g. an
  external tax office); these are marked "GateControl" and the directory
  never removes them.
- **plugin** — belongs to a plugin (e.g. the family of the Familie plugin).
  Only the plugin changes it; the admin page can only change its colour.

## The group page

- **Tree** (left): colour of the kind, a badge for directory/plugin groups or
  the end date of a project, and the number of people including subgroups.
  Search by group name.
- **Detail** (right): path, kind and source; the members with role (role
  select and remove where allowed); open invitation links; **Wird genutzt
  von** — the routes and RDP entries released for the group plus what plugins
  report (Drive folders, chats, …).
- **Gruppe anlegen**: parent, kind, name and, for projects, the end date.
- **Löschen** lists everything that depends on the group, asks for the name
  to be typed and offers **Stattdessen archivieren**. A group with subgroups
  cannot be deleted (delete or move them first); the accounts themselves
  always stay. An RDP entry that was released only for this group (and for no
  person) stays hidden rather than becoming visible for everyone.

## Invitation links

**Einladungslink** creates a link for a role (valid 1–30 days, 1–500 uses).
Whoever opens it **while signed in** — web login or the portal (the apps open
the portal signed in) — joins the group with that role after one click on
"Beitreten". Somebody who is not signed in is sent to the login page and comes
back afterwards. The link is shown only once (only its hash is stored); open
links are listed on the group page and can be revoked. Existing members are
not changed and no use is counted for them. Links point to the portal host
when the portal is on, otherwise to the web UI (`/portal/groups/join/<token>`).
Plugin groups have no invitation links.

## CSV import

**CSV importieren** takes one line per person, separated by semicolons:

```
pfad;email;rolle
Verwaltung › Buchhaltung;s.wolf@firma.de;leitung
Verwaltung/Einkauf;j.keller@firma.de;mitglied
Projekt Umzug 2027;t.berg@firma.de;mitglied;projekt
```

- Path parts are separated by `›` or `/`. Missing groups are created as
  local groups: the top level as department, below as team. An optional
  fourth column sets the kind of a newly created group (abteilung, team,
  projekt, standort).
- The person is found by e-mail address (or user name). Roles: mitglied,
  leitung, vertretung, gruppen-admin (English names work too); empty = member.
- A header line and lines starting with `#` are skipped. Lines that cannot be
  imported (unknown account, unknown role, more than 3 levels, a directory or
  plugin group) are reported with their line number; the rest is imported.

## User profile

The overview of a user (**Benutzer** → the user) shows the person's groups
with role; groups the person only belongs to through a subgroup are marked
"über Untergruppe".

## Zugriff per Gruppe

HTTP routes and RDP entries can be released for groups, persons and — HTTP
routes only — devices. In the route editor (section **Zugriff**) and in the
RDP dialog (step **Zugriff**) one field **Wer darf zugreifen?** takes chips
for *Gruppe*, *Person* and *Gerät* (devices only with the peer ACL licence;
RDP has no devices). Below it, **Darf zugreifen · N Personen** lists the
people who get access with the reason ("Buchhaltung (Leitung)", "Verwaltung
über Verwaltung › Buchhaltung", "einzeln freigegeben", "Gerät · Laptop Mia");
disabled accounts appear as a hint ("… ist im Verzeichnis gesperrt und wird
nicht mehr durchgelassen"), archived groups as well.

Rules (`src/services/groupAccess.js`, the same for every entry point):

- **Nobody listed** (no person, no group) → no person restriction, as before.
- Otherwise only the **listed persons ∪ the effective members of the listed
  groups**: members of subgroups count for the group above, archived groups
  and disabled accounts do not count. Checked on every request — leaving a
  group, being disabled or a project ending takes effect at once.
- A **stale entry never opens access**: the id of a deleted account, an
  archived group or a deleted group keeps the entry closed. When the only
  group of an HTTP route is deleted, the route keeps the marker `[0]`
  ("Gelöschter Eintrag (niemand)") in `user_ids` and stays closed until the
  admin changes the selection. RDP entries keep the stale group id.
- New group ids must exist and must not be archived; a group the entry already
  carries may stay after it was archived.

Where it applies:

| Entry point | Check |
|---|---|
| App service list, `POST /client/services/:id/open` | `routes.getForUser` |
| RDP list and every `/client/rdp/:id/*`, browser sessions | `rdp.canAccessRoute` (pure `rdpAcl.canAccessRoute` with the person's groups) |
| Portal tiles (`/api/portal/services`) | same rules; an HTTP route with the device ACL only when the portal device may reach it |
| Route login from the apps | at redeem and on **every** `/route-auth/verify` of an `app:user:<id>` session |
| "Was sieht <Name>?" / `/me/services` | reason `group` with the group path |

**Device ACL (Caddy).** With **Geräte-Zugriffskontrolle (ACL)** on, Caddy
lets through the source IPs of the listed devices **plus the devices of the
listed persons and of the effective group members** (peers the person owns
and peers bound to their app tokens; gateways never). When something is listed
but no address results (empty group, everybody disabled), the route fails
closed (`0.0.0.0/32`); with nothing listed it behaves as before. Membership
changes (`groups.events`), device and account changes (activity events
`peer_*`, `token_*`, `client_registered`, `client_enrollment_redeemed`,
`device_usage_changed`, `user_toggled`, `user_updated`, `user_deleted`)
rebuild the Caddy config — throttled to at most one reload per 5 seconds and
only when a route with the ACL depends on persons or groups. Note: persons
listed on a route with the ACL on now bring their devices, too.

Storage: HTTP routes `routes.user_ids` (persons, JSON), `route_group_acl`
(groups), `route_peer_acl` (devices); RDP `rdp_routes.user_ids` and
`rdp_routes.group_ids` (JSON). **Wird genutzt von** on the group page lists
both.

**Backup.** The server backup carries `groups` (ids kept, nesting,
archived state), `group_members` (by username), `group_invites` (SHA-256
hashes only — the links keep working) and per route `group_refs`. Users are
restored with their original ids (`user_ref`), so `user_ids` lists, group
members and plugin data still name the same person; an id the backup does not
know becomes `0` (nobody). A backup without the groups section leaves the
groups as they are.

## Admin API

Admin session only (like `/api/v1/users`); API tokens get 403.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/groups?tree=1&kind=&archived=1` | list, flat or as a tree |
| POST | `/api/v1/groups` | `{ parentId, kind, name, description, color, endsAt }` (always local) |
| GET | `/api/v1/groups/:id` | group, members (incl. inherited), invitation links, roles |
| PATCH | `/api/v1/groups/:id` | `name, description, color, kind, endsAt, parentId` |
| DELETE | `/api/v1/groups/:id?confirm=<name>` | delete |
| POST | `/api/v1/groups/:id/archive`, `/unarchive` | archive / restore |
| GET | `/api/v1/groups/:id/usage` | "Wird genutzt von" |
| PUT | `/api/v1/groups/:id/members/:userId` | `{ role }` — add or change role |
| DELETE | `/api/v1/groups/:id/members/:userId` | remove |
| GET / POST | `/api/v1/groups/:id/invites` | list / create `{ role, expiresInDays, maxUses }` |
| DELETE | `/api/v1/groups/:id/invites/:inviteId` | revoke |
| POST | `/api/v1/groups/import` | CSV as `text/plain` or `{ csv }` |
| GET | `/api/v1/access/principals` | groups, persons and devices for "Wer darf zugreifen?" |
| POST | `/api/v1/access/preview` | `{ userIds, groupIds, peerIds }` → `{ count, people: [{ userId, name, disabled, disabledReason, reasons }], devices, groups, unknownUserIds }` |

Routes take `user_ids` and `group_ids` on `POST/PUT /api/v1/routes` (absent =
keep, `null`/`[]` = clear; errors `GROUP_NOT_FOUND`, `GROUP_ARCHIVED`), RDP
entries `user_ids` and `group_ids` on `POST/PATCH /api/v1/rdp`; `GET
/api/v1/routes/:id` returns `group_ids`.

Errors carry a `code`: `NOT_FOUND`, `NAME_TAKEN`, `DEPTH_EXCEEDED`, `CYCLE`,
`READ_ONLY`, `HAS_CHILDREN`, `CONFIRM_MISMATCH`, `INVALID_ROLE`, … 

## For developers

`src/services/groups.js` is the single source of truth; its header documents
every function (`list`, `get`, `members`, `groupsOfUser`, `isMember`,
`leadersOf`, `effectiveUserIds`, invitations, `importCsv`, `usage` /
`registerUsageProvider`) and the change events (`events` emits `'change'`
with a batch of `{ type, groupId, userId?, role? }` at most once per second).
Activity entries use the event types `group_*` (and `route_groups_changed`).

`src/services/groupAccess.js` holds the access rules (`allows`,
`canSeeRoute`, `userGroupSet`, `effectiveUsers`, `devicesOfUsers`,
`aclPeers` / `aclRanges`, `preview`, `validateGroupIds`) and the throttled
Caddy reload (`createReloader`, `startCaddySync` from `server.js`).
`rdpAcl.canAccessRoute(route, tokenId, userId, { userGroups | groupsOf })`
stays free of DB access; `rdp.canAccessRoute` passes the resolver.
