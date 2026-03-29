# DNS-Integration (Pi-Hole/AdGuard) — Design Spec

**Datum:** 2026-03-29
**Status:** Freigegeben
**Feature-Key:** `custom_dns`

## Ziel

Globaler und per-Peer konfigurierbarer DNS-Server über die UI. Admins können einen alternativen DNS-Server (z.B. Pi-Hole, AdGuard Home) eintragen, der automatisch in die WireGuard-Client-Configs aller Peers geschrieben wird. Einzelne Peers können den globalen DNS überschreiben.

## Nicht im Scope

- Kein automatisches Re-Push an bestehende Peers (WireGuard-Limitation)
- Keine Caddy-Änderungen (DNS ist rein WireGuard-Client-seitig)
- Keine DB-Migration (die `dns`-Spalte in der `peers`-Tabelle existiert bereits)
- Keine Backup-Änderungen (`peer.dns` und Settings werden bereits gesichert)

---

## 1. Bestehende Infrastruktur

Die meiste Infrastruktur existiert bereits:

| Komponente | Status | Details |
|-----------|--------|---------|
| `peers.dns` DB-Spalte | Existiert | `dns TEXT` in peers-Tabelle |
| Peer-Config-Generator | Existiert | `DNS = ${peer.dns \|\| config.wireguard.dns.join(',')}` |
| Peer-Update API | Existiert | PUT `/api/v1/peers/:id` akzeptiert `dns`-Feld |
| DNS-Validierung | Existiert | IPv4-Regex + Komma-Trennung in peers.js |
| QR-Code | Existiert | Kodiert komplette Config inkl. DNS |
| Settings-Service | Existiert | Generischer Key-Value-Store |

**Es fehlt nur:** UI-Felder (Settings + Peer-Modals), Lizenz-Gating, globales Settings-Feld, Anpassung der DNS-Fallback-Kette im Peer-Config-Generator.

---

## 2. Lizenz

### COMMUNITY_FALLBACK

```javascript
custom_dns: false,
```

### Template-Gate

```nunjucks
{% if license.features.custom_dns %}
  <!-- DNS-Feld editierbar -->
{% else %}
  <!-- DNS-Feld mit Lock-Icon, readonly -->
{% endif %}
```

### API-Guard

Settings-Endpoint für DNS: `requireFeature('custom_dns')`
Peer-API für dns-Feld: Keine zusätzliche Guard nötig — das Feld existiert bereits und ist nicht lizenzgated. Die Lizenz-Gate kontrolliert nur die UI-Sichtbarkeit des Eingabefeldes.

---

## 3. Settings — Globaler DNS

### DB-Setting

Key: `custom_dns`
Wert: Komma-getrennte IP-Adressen (z.B. `10.8.0.50` oder `10.8.0.50,1.1.1.1`)

### Settings-UI (General-Tab)

Unter den bestehenden WireGuard-Infos (Host, Port, Subnet) ein neues Feld:

- **Label:** "DNS Server"
- **Eingabefeld** mit aktuellem Wert (aus `settings.get('custom_dns')`, Fallback auf `GC_WG_DNS` Env-Var)
- **Speichern-Button** rechts daneben
- **Hinweistext:** "Gilt für alle neuen Peers. Bestehende Peers müssen ihre Konfiguration neu herunterladen."
- **Lizenzgated:** Bei Community readonly mit Lock-Icon, bei Pro/Lifetime editierbar
- **Validierung:** Komma-getrennte IPv4-Adressen

### Settings-API

Neuer Endpoint oder Erweiterung des bestehenden Settings-Endpoints:

```
POST /api/v1/settings/dns
Body: { "dns": "10.8.0.50,1.1.1.1" }
```

- Validierung: Jede IP muss gültiges IPv4-Format sein
- Guard: `requireFeature('custom_dns')`
- Speichert in: `settings.set('custom_dns', value)`

---

## 4. Peer-Config-Generator — DNS-Fallback-Kette

Aktuelle Logik in `peers.js` Zeile 291:
```javascript
const dns = peer.dns || config.wireguard.dns.join(',');
```

Neue Logik:
```javascript
const settings = require('./settings');
const customDns = settings.get('custom_dns');
const dns = peer.dns || customDns || config.wireguard.dns.join(',');
```

**Priorität:**
1. Per-Peer DNS (aus `peers.dns` Spalte) — höchste Priorität
2. Globaler Custom DNS (aus `settings.custom_dns`) — mittlere Priorität
3. Env-Var `GC_WG_DNS` (aus `config.wireguard.dns`) — Fallback

---

## 5. Peer-Modals — Per-Peer DNS Override

### Peer-Add-Modal

Neues optionales Feld unter den bestehenden Feldern (Name, Description, Group, Tags, Expiry):

- **Label:** "DNS Server (Override)"
- **Placeholder:** Aktueller globaler DNS-Wert
- **Hinweistext:** "Leer lassen für globalen DNS. Überschreibt den globalen DNS nur für diesen Peer."
- **Lizenzgated:** Bei Community nicht sichtbar oder mit Lock-Icon
- **Validierung:** Komma-getrennte IPv4-Adressen (gleiche Validierung wie global)

### Peer-Edit-Modal

Gleiches Feld wie Add-Modal, vorausgefüllt mit dem aktuellen `peer.dns`-Wert (oder leer wenn Default).

### Peer-API

- POST (Create): `dns`-Feld im Destructuring und `peers.create()` Call hinzufügen falls nicht vorhanden
- PUT (Update): Bereits unterstützt — keine Änderung nötig

---

## 6. i18n

### Neue Keys (6 pro Sprache)

| Key | EN | DE |
|-----|----|----|
| `settings.dns` | DNS Server | DNS-Server |
| `settings.dns_desc` | Custom DNS for VPN peers (e.g. Pi-Hole). Existing peers must re-download their config. | Eigener DNS für VPN-Peers (z.B. Pi-Hole). Bestehende Peers müssen ihre Konfiguration neu herunterladen. |
| `settings.dns_saved` | DNS settings saved | DNS-Einstellungen gespeichert |
| `peers.dns_override` | DNS Server (Override) | DNS-Server (Override) |
| `peers.dns_override_hint` | Leave empty for global DNS. Overrides global DNS for this peer only. | Leer lassen für globalen DNS. Überschreibt den globalen DNS nur für diesen Peer. |
| `peers.dns_placeholder` | e.g. 10.8.0.50 | z.B. 10.8.0.50 |

---

## 7. Dateien die geändert werden

| Datei | Änderung |
|-------|----------|
| `src/services/license.js` | `custom_dns: false` in COMMUNITY_FALLBACK |
| `src/services/peers.js` | DNS-Fallback-Kette: peer.dns → settings.custom_dns → GC_WG_DNS |
| `src/routes/api/settings.js` oder `src/routes/api/peers.js` | DNS-Settings-Endpoint mit Validierung + Feature-Guard |
| `templates/default/pages/settings.njk` | DNS-Eingabefeld im General-Tab |
| `templates/default/partials/modals/peer-add.njk` | DNS-Override-Feld |
| `templates/default/partials/modals/peer-edit.njk` | DNS-Override-Feld |
| `public/js/settings.js` | DNS-Speichern-Handler |
| `public/js/peers.js` | DNS-Feld in Create/Edit Payload |
| `src/i18n/en.json` | 6 neue Keys |
| `src/i18n/de.json` | 6 neue Keys |
