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

## Portal: "Meine Gruppen"

The portal has a tab **Gruppen** ("Meine Gruppen") for signed-in people who
belong to at least one group — a portal or web session; never a kiosk
device, never the read-only device recognition.

- **Everybody** sees their groups as chips (direct and through a subgroup),
  the chosen one with path, own role, source ("eigene GateControl-Gruppe",
  "aus dem Verzeichnis", "von einem Plugin gepflegt"), end date, and who leads
  it (lead and deputy, walking up like everywhere).
- A **lead** or **group admin** (family: a parent) — a direct role in exactly
  that group; a lead of a group above does not manage the subgroups — also
  sees the members (with e-mail address, members from subgroups marked) and
  maintains the group:
  - **Person hinzufügen** by the exact user name or e-mail address of an
    existing, enabled account (there is no directory of people for
    non-admins; unknown and disabled accounts get the same answer);
  - roles **Mitglied**, **Vertretung**, **Gruppen-Admin** (family: Kind);
    the lead (family: parent) is given and changed only by a server admin,
    and nobody changes their own membership here;
  - remove members;
  - **Einladungslinks** like on the admin page (1–30 days, 1–500 uses, role
    member/deputy/group admin), shown once, open ones listed and revocable.
- **Directory groups**: only the extra local members can be added, changed
  and removed; **plugin groups** are read-only for everybody.
- The deputy card explains that the deputy steps in when a plugin reports
  the lead as absent; a manager sets it by giving a member the role
  "Vertretung".

Every change is written to the activity log as the person's own (source
`user`, `actorId`).

Portal API (`/api/v1/portal/groups`, CSRF token of the session for writes):

| Method | Path | |
|---|---|---|
| GET | `/api/v1/portal/groups` | own groups: role, direct, path, source, `manage`, leaders |
| GET | `/api/v1/portal/groups/:id` | a group of the viewer; for managers also `members` (with `canEditRole`, `canRemove`), `invites`, `roles` |
| POST | `/api/v1/portal/groups/:id/members` | `{ login, role }` — user name or e-mail address |
| PUT | `/api/v1/portal/groups/:id/members/:userId` | `{ role }` |
| DELETE | `/api/v1/portal/groups/:id/members/:userId` | remove a member |
| GET / POST | `/api/v1/portal/groups/:id/invites` | list / create `{ role, expiresInDays, maxUses }` |
| DELETE | `/api/v1/portal/groups/:id/invites/:inviteId` | revoke |
| GET | `/api/v1/portal/groups/principals` | what `GC.pickPrincipals` offers in portal frames: groups by name, the viewer |

Errors carry a `code`: `LOGIN_REQUIRED` (401), `NOT_MEMBER`, `NOT_MANAGER`,
`PROTECTED` (lead / parent), `SELF`, `READ_ONLY` (403), `USER_NOT_FOUND`,
`MEMBER_NOT_FOUND`, `INVITE_NOT_FOUND`, `NOT_FOUND` (404), `ALREADY_MEMBER`
(409), `INVALID`, `INVALID_ROLE` (400).

## Plugins

Plugins with `permissions.groups` read the groups (`gc.groups.list`, `get`,
`members`, `isMember`, `leadersOf`), hear of changes (`groupsChanged`), report
what they keep for a group (`groupUsage` → "Wird genutzt von" and the delete
dialog), clean up before a group is deleted (`groupDeleting`, 30 s in total),
send notifications to groups (`gc.notify({ groups })`) and open GateControl's
picker for groups and people in their pages (`GC.pickPrincipals`). With
`"manage"` they keep groups of their own (`gc.groups.ensure` / `remove`,
source `plugin:<id>`) — e.g. the family of the Familie plugin. See
[plugins.md](plugins.md) "Groups".

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

## Admin API

Admin session only (like `/api/v1/users`); API tokens get 403.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/groups?tree=1&kind=&archived=1` | list, flat or as a tree |
| POST | `/api/v1/groups` | `{ parentId, kind, name, description, color, endsAt }` (always local) |
| GET | `/api/v1/groups/:id` | group, members (incl. inherited), invitation links, roles |
| PATCH | `/api/v1/groups/:id` | `name, description, color, kind, endsAt, parentId` |
| DELETE | `/api/v1/groups/:id?confirm=<name>[&successor=<userId>]` | delete — plugins' `groupDeleting` runs first (≤ 30 s); `successor` defaults to the group's lead |
| GET | `/api/v1/principals` | groups and enabled people for `GC.pickPrincipals` on admin pages |
| POST | `/api/v1/groups/:id/archive`, `/unarchive` | archive / restore |
| GET | `/api/v1/groups/:id/usage` | "Wird genutzt von" |
| PUT | `/api/v1/groups/:id/members/:userId` | `{ role }` — add or change role |
| DELETE | `/api/v1/groups/:id/members/:userId` | remove |
| GET / POST | `/api/v1/groups/:id/invites` | list / create `{ role, expiresInDays, maxUses }` |
| DELETE | `/api/v1/groups/:id/invites/:inviteId` | revoke |
| POST | `/api/v1/groups/import` | CSV as `text/plain` or `{ csv }` |

Errors carry a `code`: `NOT_FOUND`, `NAME_TAKEN`, `DEPTH_EXCEEDED`, `CYCLE`,
`READ_ONLY`, `HAS_CHILDREN`, `CONFIRM_MISMATCH`, `INVALID_ROLE`, … 

## For developers

`src/services/groups.js` is the single source of truth; its header documents
every function (`list`, `get`, `members`, `groupsOfUser`, `isMember`,
`leadersOf`, `effectiveUserIds`, invitations, `importCsv`, `usage` /
`registerUsageProvider`, `removeWithHooks` / `registerRemoveHook`) and the change events (`events` emits `'change'`
with a batch of `{ type, groupId, userId?, role? }` at most once per second).
Activity entries use the event types `group_*`.
