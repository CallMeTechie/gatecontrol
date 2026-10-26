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
  sync, see "Verzeichnis-Abgleich und Anmeldung"). Name, structure and the members from the directory are read-only
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
- **Löschen** lists everything that depends on the group — for each route
  and RDP entry what happens: "Route bleibt gesperrt (niemand mehr
  freigegeben)" when the group was its only restriction (no other group, no
  person, no device with the peer ACL), otherwise "Freigabe über diese Gruppe
  entfällt" — and what plugins report. **Wer übernimmt?** chooses who takes
  over what plugins keep for the group (team folders, …): preselected is the
  group's lead, else its deputy (walking up to the groups above); any other
  enabled person or **Niemand** can be chosen, and the plugins' texts in the
  list follow the choice. It asks for the name to be typed and offers
  **Stattdessen archivieren**. A group with subgroups
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

## Notifications

In **Benachrichtigungen › Regeln** a rule can name groups as recipients
("Gruppen (Personen)" in the recipient picker, next to people and the device
groups, which are now called "Gerätegruppen"). The recipients are the
group's effective members including subgroups — disabled accounts and
archived groups do not count — resolved when the notification goes out, with
all their app devices. Like single persons this needs the `email_alerts`
licence. Stored as `recipients.person_groups` (docs/feature-notification-center.md).

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
only when a route with the ACL depends on persons or groups.

**Geräte der Personen und Gruppen durchlassen** (`routes.acl_people`). A
switch under the ACL toggle decides whether persons and groups count for
Caddy at all:

- **On** (default for new routes): as described above — listed devices ∪
  the devices of the persons and group members; fail closed when nothing
  results.
- **Off**: only the ticked devices pass ("Aus: Nur die angehakten Geräte
  kommen durch, Personen und Gruppen steuern nur die Sichtbarkeit.") —
  exactly the behaviour before groups existed, including "ACL on, no device
  ticked = no peer matcher". Persons and groups then only decide who sees and
  opens the route (app, portal tiles, route login, "Was sieht <Name>?"); that
  part never depends on the switch. Membership changes do not rebuild Caddy
  for such routes.

The preview **Darf zugreifen** follows the switch: with it on a person shows
"N eigene Geräte kommen durch", with it off a person without a ticked device
shows "sieht die Route, Geräte nicht durchgelassen"; the device note counts
the devices that pass (`POST /api/v1/access/preview` takes `aclPeople` and
answers `personDevices`, `ownDevices`, `visibleOnly`).

*Update from a version without groups:* migration 111 sets the switch **off**
for every existing route with the ACL on **and** at least one person in
`user_ids` (parsed like `parseIdList`: `NULL`, `''`, `[]` and malformed JSON
hold no person) — before, `user_ids` only controlled visibility, so the
update must not silently let those persons' devices through. Every other
route gets **on** (switching the ACL on later is a new, deliberate decision).
The routes API takes `acl_people` (boolean; absent = default on create, keep
on update; turning it on needs the `peer_acl` licence like `acl_enabled`) and
returns it; changes are logged as `route_acl_people_changed`.

Storage: HTTP routes `routes.user_ids` (persons, JSON), `route_group_acl`
(groups), `route_peer_acl` (devices), `routes.acl_people` (0/1, see
above); RDP `rdp_routes.user_ids` and
`rdp_routes.group_ids` (JSON). **Wird genutzt von** on the group page lists
both.

**Backup.** The server backup carries `groups` (ids kept, nesting,
archived state), `group_members` (by username), `group_invites` (SHA-256
hashes only — the links keep working) and per route `group_refs`. Users are
restored with their original ids (`user_ref`), so `user_ids` lists, group
members and plugin data still name the same person; an id the backup does not
know becomes `0` (nobody). A backup without the groups section leaves the
groups as they are. Routes carry `acl_people`; a backup without it gets the
rule of migration 111 (ACL on + persons → off), so restoring an old backup
never widens access. It also carries the directory connections (see
"Verzeichnis-Abgleich und Anmeldung" › Secrets) with their links and
conflicts.

## Verzeichnis-Abgleich und Anmeldung

GateControl takes accounts and groups from the company directory —
**Active Directory**, **Microsoft Entra ID** or a generic **LDAP** server
(OpenLDAP, Synology Directory Server, FreeIPA) — and lets those people sign in
with their company account. The admin page is **Benutzer › Verzeichnis**
(`/directory`, a sub-item next to Gruppen). Google Workspace is not supported
yet.

**Admin rights never come from the directory.** The sync only creates member
accounts (role `user`), never disables, enables or merges an administrator, and
local administrators always sign in with their local password — also when the
directory is down.

### What the sync does

- **Selected groups only.** On the page you search the directory's groups and
  tick the ones that come to GateControl. Every selected group becomes one
  GateControl group (kind *Team*, source `directory:<id>`, `external_id` =
  objectGUID / Entra object id / entryUUID). Nested directory groups are
  **resolved transitively** (AD: `LDAP_MATCHING_RULE_IN_CHAIN`; Entra:
  `transitiveMembers`; LDAP: DN members that are groups are followed, ≤ 10
  levels): members of a nested group count as members of the selected group.
  The GateControl tree stays **flat** below an optional *übergeordnete Gruppe*
  (a local group) — directory nesting is often deep and would collide with the
  3-level limit, so it is not mirrored. A name that is already taken at that
  level gets the suffix ` (<directory name>)`. A group renamed in the directory
  is renamed here; a group taken out of the selection (or deleted in the
  directory) is **archived** and comes back when it is selected again.
- **Accounts.** Whoever is an enabled member of at least one selected group
  gets an account with role `user` when **Konten automatisch anlegen** is on
  (user name from sAMAccountName / uid / the UPN's local part, `-2`, `-3` …
  when taken). With company-account sign-in on, "Mein Bereich" is switched on
  and no invitation is needed; otherwise an invitation to "Mein Bereich" is
  mailed (when SMTP is set up and the person has an address). Name and e-mail
  follow the directory.
- **Matching.** The stable id is kept in `directory_links`. The first time a
  person is seen, GateControl looks for an account with the same **e-mail
  address**: if one exists, it never links silently but records a
  **conflict** — *Zusammenführen* links the existing account (members only;
  administrators always stay local), *Getrennt lassen* leaves it alone and the
  directory person gets an own account at the next run.
- **Disabling.** With **Im Verzeichnis deaktiviert = in GateControl gesperrt**
  on, a linked account is disabled (`users.disabled_reason = 'directory'`)
  when the person is disabled or deleted in the directory or is in none of the
  selected groups any more. At once: all web and portal sessions end, the
  person's app/API tokens are revoked, and the person's **VPN peers** (peers
  they own and peers bound to their app tokens, never gateways) are disabled
  and removed from WireGuard. When the person is active again, the account and
  exactly the peers the sync disabled are enabled again — the revoked tokens
  are not (the apps register again). An account an admin disabled by hand is
  never enabled by the sync. Group memberships of disabled accounts rest as
  everywhere.
- **Group members.** Members that come from the directory are read-only in
  GateControl (source `directory:<id>`). GateControl roles (lead, deputy,
  group admin) and extra local members can still be given; the directory
  never removes them.
- **Mass-change guard.** If a run would disable **more than 10 % of the
  linked accounts (at least 3)** or every selected group comes back empty,
  nothing is changed: the run stops as *angehalten* and the page shows who
  would be disabled. **Bestätigen und ausführen** runs the sync again and
  applies exactly that — if more people would be affected by then, it stops
  again. **Verwerfen** drops it. While a run waits, the schedule pauses
  ("Jetzt abgleichen" still works).
- **Directory unreachable** (network, TLS, credentials): the run fails and
  **nothing changes**.
- **Schedule.** Every 15 minutes by default (5–1440) and with **Jetzt
  abgleichen**. Most runs only fetch the **changes** (see *Delta sync*
  below); a **full sync** reads everything at least every 24 hours
  (*Vollständiger Abgleich*, 1–168 hours) and with **Vollständig
  abgleichen**.
- **Logs.** Every run is kept with its kind (*Änderungen* or
  *Vollständig*, and why a run was full) and its result (new accounts, disabled,
  enabled, group changes, conflicts, warnings, errors; the last 50 per
  directory) and shown under *Letzte Abgleiche*. The activity log gets an
  entry for every created account (`user_created`), every disable/enable
  (`user_toggled`, details `reason: 'directory'`), merge
  (`directory_user_linked`), conflict (`directory_conflict`), stopped run
  (`directory_sync_pending`) and failure (`directory_sync_failed`).
- **The user profile** shows the account source (local or the directory with
  the sign-in name) and why an account is disabled.
- Deleting a directory account in GateControl does not remove the person from
  the directory: while they are in a selected group, the next run creates the
  account again. Take them out of the group in the directory instead (or
  switch "Konten automatisch anlegen" off).
- Removing a directory (**Trennen**, name typed) archives its groups and turns
  them into local groups; the accounts stay as local accounts without a
  password, disabled ones stay disabled.

### Delta sync

Between two full syncs a run only asks the directory what changed and
applies that to the state of the last applied run (`directory_sync_state`,
migration 112: the directory's delta position and a snapshot of the groups
with their members and the member profiles). **Plan, guard and apply always
work on the complete result**, exactly like a full run: the mass-change guard
counts against all linked accounts of the directory (≥ 3 and > 10 %), a
person disabled in the directory is disabled at once (sessions, tokens, VPN
peers — the same code path), administrators are never touched. The page shows
per directory whether the last run was *Änderungen* or *Vollständig* and when
the next full sync is due; the run history shows the kind per run.

| Directory | Changes from | Full sync instead when |
|---|---|---|
| Entra ID | Graph delta queries `/users/delta` and `/groups/delta` (with `members`); the deltaLinks are taken at the start of every full sync with `$deltatoken=latest` (no enumeration of the tenant) | Graph answers 410 Gone or a resync / sync-state error |
| Active Directory | `uSNChanged` greater than the `highestCommittedUSN` the RootDSE of the same domain controller reported at the start of the last run | another domain controller answers (`dnsHostName` / `dsServiceName` differ — e.g. a DNS name with several DCs) or its USN went back (restored DC) |
| LDAP (OpenLDAP, Synology, 389 DS / FreeIPA) | `modifyTimestamp >=` a watermark (the newest timestamp seen, at most the start of the last read minus 10 minutes) | the server keeps no `modifyTimestamp` or refuses the filter: then **every** run is full |

What a delta run sees:

- **Entra ID:** changed properties of known members (Graph sends partial
  objects; only what is present is taken over — `accountEnabled: false`
  disables), deleted users (`@removed`, soft and hard deletion), deleted
  selected groups (*not found*, like a full sync), renamed groups, added and
  removed members of a flat selected group (`members@delta`; a new person's
  profile is read with `/users/<id>`). A change inside a nested group, or a
  group added as member, makes GateControl read that selected group's
  transitive members again (the nested groups of every selected group are
  remembered at every full sync). Paging follows `@odata.nextLink` up to the
  new `@odata.deltaLink`.
- **Active Directory:** per selected group the member accounts with a newer
  `uSNChanged` (name, mail, UPN, `userAccountControl` — a disabled account is
  seen here) and accounts moved out of or into the account base. Members are
  added and removed on the **group**, not on the account: when the selected
  group or one of its nested groups changed, its complete member list is read
  again. **Deleted accounts are not visible** to `uSNChanged` searches (they
  move to *Deleted Objects*, which needs a special control); a deleted
  account usually also drops out of its groups, but only the full sync is
  sure to catch it. That is the reason for the periodic full sync.
- **LDAP:** changed member accounts (name, mail, the disabled attribute) and
  changed groups: a changed selected or nested group, a member whose DN or
  login name changed, or a new account matching a `memberUid` that could not
  be resolved before → that selected group is resolved again (known accounts
  from the snapshot, others are looked up one by one). Deleted accounts are
  only seen by the full sync. The server's clock should be roughly right
  (the 10-minute margin covers small differences and replicas).

A run is **full** when it is forced (*Vollständig abgleichen*), on the first
run, after the settings or the group selection changed, when the full-sync
interval has passed, when the directory cannot do delta, or when the delta
asks for it (table above — then the same run reads everything). Confirming a
stopped full run runs a full one again. The delta position is stored only
after a run was **applied**: a run stopped by the guard or a failed run keeps
the old position, so the next run sees the same changes again. The position
is not in the backup; after a restore the first run of every directory is
full.

### Sign-in with the company account

- **Active Directory / LDAP:** with **Anmeldung mit dem Windows-Passwort**
  (LDAP: *Verzeichnis-Passwort*) on, the normal login form accepts for
  directory accounts the user name, the Windows sign-in name, `DOMAIN\name`,
  the UPN or the e-mail address. GateControl looks the person up with the
  service account by the stable id and checks the password with an **LDAP
  bind** as that person; the password is only passed through and never
  stored. An **empty password is refused before the directory is contacted**
  (an empty bind counts as anonymous and "successful" on some servers), login
  names are only accepted in a fixed format and every value in an LDAP filter
  is escaped (RFC 4515). The existing lockout (per account and per address)
  and rate limits apply; GateControl's own 2FA and passkeys are still required
  when the person set them up. A directory that cannot be reached gives a
  clear message and is not counted as a wrong password.
- **Entra ID:** with **„Mit Microsoft anmelden“** on, the login page shows the
  button. It runs the OpenID Connect **authorization code flow with PKCE**,
  `state` and `nonce` (`/auth/oidc/<id>/start` → Microsoft →
  `/auth/oidc/<id>/callback`). The ID token is verified (RS256 with the
  tenant's JWKS, issuer, audience = client id, expiry, not-before, nonce, the
  configured **tenant id**) and mapped to the account by its **object id
  (`oid`) only, never by e-mail**. Only accounts the sync created or linked
  can sign in; MFA is Microsoft's job (GateControl's own TOTP still follows
  when the person switched it on). Entra accounts cannot use the password
  form. The login transaction lives 10 minutes, is single use and is bound to
  the browser by the cookie `gc.oidc` (HttpOnly, SameSite=Lax — the session
  cookie is SameSite=Strict, so the callback continues with a short same-site
  page).
- Applies to web sessions of members ("Mein Bereich") and the portal.
  Administrators are never directory accounts and keep signing in locally.
- **Apps:** the apps are set up with setup codes and open the portal with
  their login link; there is no username/password flow in the apps today.
  A directory member signs in on the web with the company account and — when
  an admin allowed *eigene Geräte einrichten* — creates the setup code there.
  A native "Mit Firmenkonto anmelden" button in the Android / Windows setup
  (browser sign-in that hands the token to the app) and the kiosk pairing are
  a follow-up.

### Setting up

**Reachability.** GateControl must reach the domain controller / LDAP server
as `host:port`: directly, through a peer's VPN address, or through an L4 route
of a gateway in the home network (like other home targets). When the
certificate names another host than the address you enter, put that name into
*Name im Zertifikat*. Only **LDAPS** (636) or **StartTLS** (389) is accepted;
the certificate is always verified — upload your own CA (PEM) for an internal
CA such as AD Certificate Services.

**Active Directory**

1. Create a service account with read rights (a normal domain user is
   enough), e.g. `CN=svc-gatecontrol,OU=Dienste,DC=corp,DC=local`.
2. *Verzeichnis verbinden* → Active Directory: server, encryption, port,
   service account and password, base DN (optionally separate bases for
   accounts and groups), CA certificate if needed. *Verbindung testen*.
3. Search and tick the groups, choose the options, *Jetzt abgleichen*.

Attributes used: `objectGUID` (id), `sAMAccountName` and `userPrincipalName`
(sign-in), `mail`, `displayName` (or `givenName sn`), `userAccountControl`
(bit 2 = disabled), groups `objectClass=group` with `cn`.

**Microsoft Entra ID**

1. Entra admin center → *App registrations* → *New registration* (single
   tenant). Note the **Application (client) ID** and the **Directory
   (tenant) ID**.
2. *Certificates & secrets* → new **client secret**; copy the value.
3. *API permissions* → Microsoft Graph → **Application permissions**
   **`User.Read.All`** and **`GroupMember.Read.All`** → *Grant admin
   consent*.
4. For "Mit Microsoft anmelden": *Authentication* → *Add a platform* → **Web**,
   redirect URI `https://<GC_BASE_URL host>/auth/oidc/<id>/callback` (shown on
   the directory page after saving; the delegated permissions `openid`,
   `profile`, `email` are standard).
5. In GateControl: tenant id, client id, client secret; test; pick groups.

**LDAP (OpenLDAP, Synology Directory Server, FreeIPA)**

Server, encryption, service account (e.g. `uid=root,cn=users,dc=nas,dc=local`
on Synology) and base DN as above. The attribute mapping (*Attribut-
Zuordnung*) defaults to OpenLDAP / Synology:

| Field | Default | Notes |
|---|---|---|
| Stable id (account) | `entryUUID` | FreeIPA: `ipaUniqueID`; `objectGUID` (Samba) works too |
| Sign-in name | `uid` | |
| E-mail | `mail` | |
| Display name | `displayName` | falls back to `cn` |
| Stable id (group) | `entryUUID` | |
| Group name | `cn` | |
| Member attribute | `member` | `member` / `uniqueMember` (DNs) or `memberUid` (posixGroup, sign-in names; Synology) |
| Disabled attribute | — | e.g. `nsAccountLock` (FreeIPA, 389 DS) or `pwdAccountLockedTime` (OpenLDAP ppolicy) |
| Account filter | `(\|(objectClass=inetOrgPerson)(objectClass=posixAccount))` | |
| Group filter | `(\|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))` | |

**Secrets.** The bind password and the Entra client secret are stored
encrypted with the server key (`GC_ENCRYPTION_KEY`, like licence keys) and are
never returned by the API or shown in the UI (only a mask); leaving the field
empty keeps the stored value.

**Backup.** The server backup carries `directories` (ids kept, so the groups'
source `directory:<id>` still matches; the secret exactly as stored, i.e.
encrypted; the intervals including `full_sync_hours`), `directory_links` (by `user_ref` — users keep their ids — else
by username; the peers the sync disabled by name) and `directory_conflicts`;
the run log (`directory_runs`) and the delta position
(`directory_sync_state`) are not saved — the first run after a restore is
full — and a run that waited for confirmation is dropped. Restored on a server with a **different
`GC_ENCRYPTION_KEY`**, the secret cannot be read: the connection, its groups
and links are restored anyway, the secret is left empty and the directory
page asks for it again ("Das Passwort des Dienstkontos fehlt …", API field
`needsSecret: true`); until it is entered, the schedule skips the directory
(the restore result lists it in `directories_secret_reentry`). A backup
without the directory section leaves the connections as they are.

### Directory API

Admin session only (like `/api/v1/groups`); API tokens get 403. Writes need
the session's CSRF token.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/directories` | list with state, counts, last run, waiting run |
| POST | `/api/v1/directories` | `{ kind: 'ad'\|'entra'\|'ldap', name, config, secret, enabled, loginEnabled, provision, deprovision, intervalMin, fullSyncHours, parentGroupId, selectedGroups }` |
| POST | `/api/v1/directories/test` | test unsaved settings `{ kind, config, secret[, id] }` (stored secret used when `id` is given and `secret` is empty) |
| GET / PATCH / DELETE | `/api/v1/directories/:id` | read / change (`secret` empty or absent = keep) / remove (`?confirm=<name>`) |
| POST | `/api/v1/directories/:id/test` | connection test with the stored settings → `{ ok, result }` or `{ ok: false, code, error, detail }` |
| GET | `/api/v1/directories/:id/groups?q=` | search groups in the directory (`selected` marks the chosen ones) |
| POST | `/api/v1/directories/:id/sync` | run now (202, in the background); `{ full: true }` = *Vollständig abgleichen* |
| GET | `/api/v1/directories/:id/runs`, `/runs/:runId` | last runs / one run with details |
| POST | `/api/v1/directories/:id/runs/:runId/confirm`, `/discard` | decide a stopped mass change |
| GET | `/api/v1/directories/:id/conflicts[?status=all]` | open (or all) conflicts |
| POST | `/api/v1/directories/:id/conflicts/:conflictId/merge`, `/separate` | decide a conflict |

A directory also carries `fullSyncHours` (1–168, default 24), `lastRunMode`
(`'full'` \| `'delta'` of the last applied run), `deltaReady` (the next
scheduled run can fetch only changes), `deltaUnsupported` (LDAP without
`modifyTimestamp`: every run is full) and `nextFullSyncAt` (null = the next
run is full). Runs carry `mode` and in `summary` `mode`, `fullReason`
(`first`, `forced`, `confirm`, `due`, `settings_changed`, `unsupported`,
`resync`, `dc_changed`, `usn_rollback`, `too_many_changes`) and for delta runs
`changes { users, groups, removed }`.

`config` per kind — AD: `host, port, security ('ldaps'|'starttls'),
tlsServerName, caCert, baseDn, userBaseDn, groupBaseDn, bindDn`; LDAP: the same
plus `userFilter, groupFilter, attrs { id, login, email, name, groupId,
groupName, member, disabled }`; Entra: `tenantId, clientId` (GUIDs). Errors
carry a `code` (`NOT_FOUND`, `INVALID_*`, `CONFIRM_MISMATCH`, `RUNNING`,
`RUN_NOT_PENDING`, `CONFLICT_RESOLVED`, `ALREADY_LINKED`,
`ADMIN_NOT_MERGEABLE`, `INVALID_FULL_INTERVAL`, …). The user detail (`GET /api/v1/users/:id`) carries
`directory: { id, name, kind, loginName, state, lastSeenAt } | null`.

Sign-in: `GET /auth/oidc/:directoryId/start[?returnTo=/portal…]` and
`GET /auth/oidc/:directoryId/callback`.

For developers: `src/services/directory/` — `store.js` (connections, secrets),
`sync.js` (full or delta → plan → guard → apply, runs, conflicts, scheduler tick
`runDue()` every minute from `server.js`; `mergeDelta` applies a delta to the
snapshot), `adapters.js` (the adapter interface: `test`, `searchGroups`,
`fetch`, optional `fetchDelta`, `authenticate`; tests install fakes), `ad.js` / `ldap.js` (ldapts, `ldapConn.js`, `ldapUtil.js`),
`entra.js` (Graph), `auth.js` (password form), `oidc.js` (code flow, ID-token
verification with Node's `crypto`). Tables: `directories`, `directory_links`,
`directory_conflicts`, `directory_runs` (migration 110), `directory_sync_state`,
`directories.full_sync_hours` and `directory_runs.mode` (migration 112).

## Admin API

Admin session only (like `/api/v1/users`); API tokens get 403.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/groups?tree=1&kind=&archived=1` | list, flat or as a tree |
| POST | `/api/v1/groups` | `{ parentId, kind, name, description, color, endsAt }` (always local) |
| GET | `/api/v1/groups/:id` | group, members (incl. inherited), invitation links, roles |
| PATCH | `/api/v1/groups/:id` | `name, description, color, kind, endsAt, parentId` |
| DELETE | `/api/v1/groups/:id?confirm=<name>[&successor=<userId>\|none]` | delete — plugins' `groupDeleting` runs first (≤ 30 s); `successor` defaults to the group's lead, else deputy (walking up); `none` = nobody; a disabled account is refused (`USER_DISABLED`) |
| GET | `/api/v1/principals` | groups and enabled people for `GC.pickPrincipals` on admin pages |
| POST | `/api/v1/groups/:id/archive`, `/unarchive` | archive / restore |
| GET | `/api/v1/groups/:id/usage[?successor=<userId>\|none]` | "Wird genutzt von": `usage` (core entries with `onDeleteKey` `grp.usage.route_locked` / `route_dropped` / `rdp_locked` / `rdp_dropped` and `onDelete` in the caller's language; plugins hear `successor`) and `defaultSuccessor` `{ userId, name, role, groupId, inherited } \| null` |
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
`registerUsageProvider`, `removeWithHooks` / `registerRemoveHook`,
`defaultSuccessor` / `resolveSuccessor`) and the change events (`events` emits `'change'`
with a batch of `{ type, groupId, userId?, role? }` at most once per second).
Activity entries use the event types `group_*` (and `route_groups_changed`).

`src/services/groupAccess.js` holds the access rules (`allows`,
`canSeeRoute`, `userGroupSet`, `effectiveUsers`, `devicesOfUsers`,
`aclPeers` / `aclRanges`, `preview`, `validateGroupIds`) and the throttled
Caddy reload (`createReloader`, `startCaddySync` from `server.js`).
`rdpAcl.canAccessRoute(route, tokenId, userId, { userGroups | groupsOf })`
stays free of DB access; `rdp.canAccessRoute` passes the resolver.
