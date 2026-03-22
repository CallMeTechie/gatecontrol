# License Validation API

## Endpoint

```
POST https://callmetechie.de/api/licenses/validate
```

Rate Limit: 60 Requests / Minute

## Request

```json
{
    "license_key": "GATE-A1B2-C3D4-E5F6",
    "hardware_fingerprint": "sha256-of-machine-id",
    "device_name": "homelab-server-01",
    "product_slug": "gatecontrol"
}
```

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `license_key` | string | Ja | Der Lizenzschlüssel |
| `hardware_fingerprint` | string | Ja | SHA-256 Hash einer eindeutigen Maschinen-ID |
| `device_name` | string | Nein | Anzeigename des Geräts |
| `product_slug` | string | Nein | Produkt-Slug zur Cross-Validierung (empfohlen) |

## Response (Erfolg, 200)

```json
{
    "valid": true,
    "type": "pro",
    "license": {
        "product": "gatecontrol",
        "plan": "pro",
        "plan_type": "subscription",
        "max_activations": 3,
        "active_activations": 1,
        "features": ["vpn-peers-unlimited", "l4-proxy", "monitoring"],
        "expires_at": "2027-03-21T00:00:00Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "token_expires_at": "2026-03-28T00:00:00Z"
}
```

## Error Responses

| Status | Error | Beschreibung |
|--------|-------|-------------|
| 404 | `License not found` | Lizenzschlüssel existiert nicht |
| 403 | `License revoked` | Lizenz wurde widerrufen |
| 403 | `License suspended` | Lizenz wurde gesperrt |
| 403 | `License expired` | Lizenz ist abgelaufen |
| 403 | `Activation limit reached` | Maximale Geräteanzahl erreicht |
| 403 | `License does not belong to this product` | product_slug stimmt nicht |
| 422 | Validation Error | Pflichtfelder fehlen |
| 429 | Rate Limited | Zu viele Anfragen |

```json
{
    "valid": false,
    "error": "License expired"
}
```

## Offline Token (JWT)

Der `token` in der Response ist ein HMAC-SHA256 signierter JWT. Damit kann die Anwendung offline arbeiten, ohne den Server zu kontaktieren.

### Token Payload

```json
{
    "lid": 42,
    "pid": "gatecontrol",
    "plan": "pro",
    "features": ["vpn-peers-unlimited", "l4-proxy"],
    "fp": "sha256-of-machine-id",
    "exp": 1743120000,
    "lat": 1742515200
}
```

| Feld | Beschreibung |
|------|-------------|
| `lid` | License ID |
| `pid` | Product Slug |
| `plan` | Plan Slug |
| `features` | Feature-Liste des Plans |
| `fp` | Hardware-Fingerprint (Token ist an dieses Gerät gebunden) |
| `exp` | Token-Ablauf (Unix Timestamp) |
| `lat` | Lizenz-Ablauf (Unix Timestamp). `0` = Lifetime (kein Ablauf) |

### Token Verifizierung

Der Token wird mit dem `LICENSE_SIGNING_KEY` signiert (verfügbar in Admin Settings > Licensing). Verwende diesen Key in deiner Anwendung um den Token lokal zu verifizieren.

**Wichtig:** Der Signing Key ist ein Shared Secret (HMAC). Er darf nicht öffentlich zugänglich sein — nur in der Server-Konfiguration deiner Anwendung.
