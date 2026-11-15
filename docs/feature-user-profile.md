# User profile

One profile per person, kept by the person herself — in the portal ("Mein Profil", behind the own picture at the top
right) and in the apps. The account keeps what it had (display name, user name, e-mail address, language, picture,
favourite colour); new are first and last name, a short "about" (≤ 140 characters), the birthday (year can be hidden),
up to three further e-mail addresses, the time zone, up to five **phone numbers** — and per field who sees it.

Code: `src/services/profile.js` (service), `src/routes/api/profileApi.js` (the person's endpoints),
`src/routes/api/users.js` (administrators), migration 151 `user_profile`, portal `templates/portal/portal.njk` /
`public/js/portal.js` ("Mein Profil"), user page `public/js/users.js` (card "Profil"). Tests: `tests/user_profile.test.js`.

## Fields and who sees them

Three levels for fields: **Nur ich** (`self`), **Familie** (`family` — a GateControl group of the kind *Familie* both
belong to; without a family the level is not offered), **Alle auf diesem Server** (`all`). Phone numbers per number:
**Niemand** (`none`, the default), `family`, `all`.

| Field | Default | Note |
|---|---|---|
| Display name | everybody, fixed | locked ("Aus dem Verzeichnis") for a member of an enabled AD / Entra directory — the sync overwrites it |
| First and last name | all | one visibility for both |
| About | all | a fixed sentence; the status with a duration stays in the messenger |
| Phone numbers | none | kind mobile / work / home / other; "Zum Erkennen nutzen" per number |
| E-mail addresses | only me | the main address as before (locked for directory members); further ones are confirmed by a code when the server can send mail (SMTP) |
| Birthday | family | `YYYY-MM-DD` or `--MM-DD`; "Jahr verbergen" — nobody else sees the year |
| Language, time zone | only me | the time zone is the same value as the quiet hours (`notify_user_prefs.tz`) |
| Address | — | not part of the profile |

Administrators see what they need to manage an account — name, user name, e-mail, language (changed in "Bearbeiten"
as before) — and otherwise only what is visible to everybody ("verborgen, die Person gibt es nicht frei"). Of the
phone numbers they see count, state and whether the recognition is on, and when a number also stands in another
account ("doppelt") — never a digit. They can confirm ("Vom Admin bestätigt") or remove a number without seeing it.

Server settings (Benutzer → Einstellungen): **Telefonnummern im Profil erlauben** (on; off hides the section everywhere
and nobody is recognised by numbers) and **Zum Erkennen nur bestätigte Nummern nutzen** (off).

## Phone numbers at rest

A number is stored encrypted with the server's key (`GC_ENCRYPTION_KEY`, AES-256-GCM, `user_phones.number_enc`) and,
to compare, as a keyed hash of its E.164 form (HMAC-SHA-256 with a key derived from the server's key,
`number_hash`). Neither leaves the service except the number to its owner (own view, "Meine Daten") and to plugins
with `permissions.profile` `phones` for numbers the person shares with that viewer. The activity log names the kind
("Telefonnummer hinzugefügt (Mobil)"), never a digit. The backup carries the numbers encrypted as they are.

States: `unconfirmed`, `whatsapp` ("Bestätigt über dein WhatsApp" — the person's own linked WhatsApp has this number;
the server learns it from every `whoami` of the bridge and keeps only the keyed hash in `user_bridge_selves`; the state
goes back when the link ends), `admin`, `directory` (reserved for a number from AD / Entra). There is no SMS code.

## Recognition

Two consents under "Erkennung", both off: **an meinem verknüpften WhatsApp** and **an meinen Telefonnummern**. The
portal and the apps ask once — when WhatsApp is linked and when the first number is saved.

`gc.bridges.matchAccounts(userId, network)` (version 8) asks "which of my contacts at the bridge are accounts here?".
The server compares the numbers of the contact list the bridge keeps (no question to WhatsApp) with the keyed hashes:

| Hint | Strength | Needs |
|---|---|---|
| the account's own linked WhatsApp has the number | strong (`own_whatsapp`) | consent "WhatsApp" |
| a confirmed number in the profile | strong (`profile_phone`) | consent "Telefonnummern", "Zum Erkennen nutzen" |
| an unconfirmed number in the profile | medium (`profile_phone`) | the same, and the administrator did not switch on "nur bestätigte" |

Never: the asking person herself, a disabled account, a number that stands in two accounts (profile or own login), a
contact whose numbers would name two accounts. The plugin gets `{ contactId, userId, strength, via }` only; merging a
chat is the plugin's question to the person.

## Endpoints of the person

The same on three mounts — `/api/v1/me` (web session), `/api/v1/portal/me` (portal session, also members without
"Mein Bereich"; never a kiosk device), `/api/v1/client/me` (apps, device token):

| Method and path | Body → answer |
|---|---|
| `GET …/profile` | `{ ok, user, palette, profile }` (`user` / `palette`: picture and colour as before) |
| `PATCH …/profile` | `{ displayName?, firstName?, lastName?, about?, birthday?: { date, yearHidden } \| null, email?, language?, timezone?, visibility?: { firstName, lastName, about, birthday, email, language, timezone }, recognition?: { byWhatsapp?, byPhone? } }` → `{ ok, profile }` |
| `POST …/profile/phones` | `{ kind, number, visibility?, useForRecognition? }` → `201 { ok, phone, profile }` |
| `PATCH …/profile/phones/:id` | the same fields, each optional (a new number starts unconfirmed) → `{ ok, phone, profile }` |
| `DELETE …/profile/phones/:id` | → `{ ok, profile }` |
| `POST …/profile/emails` | `{ address }` → `201 { ok, email, codeSent, profile }` |
| `POST …/profile/emails/:id/confirm` | `{ code }` → `{ ok, email, profile }` (5 tries, 30 minutes) |
| `POST …/profile/emails/:id/resend` | → `{ ok, email, codeSent, profile }` (once a minute) |
| `DELETE …/profile/emails/:id` | → `{ ok, profile }` |
| `GET …/profile/export` | "Meine Daten" as a JSON file |

Errors `{ ok: false, code, error, field? }`: `400 INVALID`, `400 WRONG_CODE`, `403 PHONES_OFF`, `404 NOT_FOUND`,
`409 LIMIT | DUPLICATE | LOCKED | NO_MAIL`, `410 CODE_EXPIRED`, `429 RATE_LIMITED` (120 changes per 15 minutes in a
browser, per hour in an app).

Administrators: `GET /api/v1/users/:id/profile`, `POST /api/v1/users/:id/profile/phones/:pid/confirm`,
`DELETE /api/v1/users/:id/profile/phones/:pid`, `GET|PUT /api/v1/users/settings/profile`
(`{ phonesEnabled, confirmedOnly }`).

## "Meine Daten"

`GET …/profile/export`: the account, every profile field, the numbers in plain text (only ever for the person
herself), further addresses, consents with their time, groups, devices (names and times) — no password hash, key,
token or code — and what plugins add through the hook `myData` (Familie, Messenger without chat contents: later).

## Deleting

Every field can be emptied, every number and address removed. When the account is deleted, profile, numbers,
addresses and the hashes of the own logins go with it (`ON DELETE CASCADE`). Both are logged without values.
