# Client Integration Guide

## Validierungsflow

```
App-Start
    ├── Token-Datei vorhanden?
    │       ├── JA → Token abgelaufen (exp)?
    │       │           ├── NEIN → Lizenz abgelaufen (lat > 0 && lat < now)?
    │       │           │           ├── NEIN → App startet ✓ (Hintergrund: Online-Refresh)
    │       │           │           └── JA → "Lizenz abgelaufen" ✗
    │       │           └── JA → Online-Validierung...
    │       └── NEIN → Online-Validierung...
    └── Online-Validierung
            ├── Erfolg → Token speichern, App startet ✓
            └── Fehlschlag (kein Netz / ungültig)
                    ├── Alter Token + nicht abgelaufen → App startet ✓
                    └── Kein gültiger Token → "Lizenz ungültig" ✗
```

## Hardware Fingerprint generieren

Der Fingerprint muss pro Maschine eindeutig und stabil sein (überlebt Neustarts).

### Node.js

```javascript
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

function getHardwareFingerprint() {
    let raw;
    try {
        if (process.platform === 'linux') {
            raw = fs.readFileSync('/etc/machine-id', 'utf8').trim();
        } else if (process.platform === 'darwin') {
            raw = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
                .toString().trim();
        } else {
            raw = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
                .toString().trim();
        }
    } catch {
        raw = os.hostname() + JSON.stringify(os.cpus().map(c => c.model));
    }
    return createHash('sha256').update(raw).digest('hex');
}
```

### PHP

```php
function getHardwareFingerprint(): string
{
    $raw = '';
    if (PHP_OS_FAMILY === 'Linux' && file_exists('/etc/machine-id')) {
        $raw = trim(file_get_contents('/etc/machine-id'));
    } elseif (PHP_OS_FAMILY === 'Darwin') {
        $raw = trim(shell_exec('ioreg -rd1 -c IOPlatformExpertDevice') ?? '');
    }
    if (empty($raw)) {
        $raw = gethostname() . php_uname('m');
    }
    return hash('sha256', $raw);
}
```

### Python

```python
import hashlib
import platform
import subprocess

def get_hardware_fingerprint() -> str:
    raw = ""
    system = platform.system()
    try:
        if system == "Linux":
            with open("/etc/machine-id") as f:
                raw = f.read().strip()
        elif system == "Darwin":
            raw = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True
            ).stdout.strip()
    except Exception:
        raw = platform.node() + platform.machine()
    return hashlib.sha256(raw.encode()).hexdigest()
```

### Go

```go
package license

import (
    "crypto/sha256"
    "encoding/hex"
    "os"
    "runtime"
    "strings"
)

func GetHardwareFingerprint() string {
    var raw string
    switch runtime.GOOS {
    case "linux":
        data, err := os.ReadFile("/etc/machine-id")
        if err == nil {
            raw = strings.TrimSpace(string(data))
        }
    }
    if raw == "" {
        hostname, _ := os.Hostname()
        raw = hostname + runtime.GOARCH
    }
    hash := sha256.Sum256([]byte(raw))
    return hex.EncodeToString(hash[:])
}
```

## Vollständiges Integrationsbeispiel (Node.js)

```javascript
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken'); // npm install jsonwebtoken

const LICENSE_SERVER = 'https://callmetechie.de/api/licenses/validate';
const TOKEN_PATH = path.join(__dirname, '.license-token');
const SIGNING_KEY = process.env.LICENSE_SIGNING_KEY; // Aus Admin Settings

async function validateLicense(licenseKey) {
    const fingerprint = getHardwareFingerprint();

    // 1. Prüfe lokalen Token
    const cached = loadCachedToken(fingerprint);
    if (cached) {
        refreshTokenInBackground(licenseKey, fingerprint);
        return cached;
    }

    // 2. Online-Validierung
    try {
        const res = await fetch(LICENSE_SERVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                license_key: licenseKey,
                hardware_fingerprint: fingerprint,
                device_name: require('os').hostname(),
                product_slug: 'gatecontrol',
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Validation failed');
        }

        const data = await res.json();
        fs.writeFileSync(TOKEN_PATH, data.token);
        return data.license;
    } catch (err) {
        // 3. Fallback auf alten Token
        const fallback = loadCachedToken(fingerprint, true);
        if (fallback) return fallback;
        throw new Error('License validation failed: ' + err.message);
    }
}

function loadCachedToken(fingerprint, allowExpired = false) {
    try {
        const token = fs.readFileSync(TOKEN_PATH, 'utf8');
        const payload = jwt.verify(token, SIGNING_KEY, {
            algorithms: ['HS256'],
            ...(allowExpired ? { ignoreExpiration: true } : {}),
        });

        if (payload.fp !== fingerprint) return null;

        // lat = 0 bedeutet Lifetime (kein Ablauf)
        if (payload.lat > 0 && payload.lat < Math.floor(Date.now() / 1000)) {
            return null;
        }

        return {
            product: payload.pid,
            plan: payload.plan,
            features: payload.features,
        };
    } catch {
        return null;
    }
}

async function refreshTokenInBackground(licenseKey, fingerprint) {
    try {
        const res = await fetch(LICENSE_SERVER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                license_key: licenseKey,
                hardware_fingerprint: fingerprint,
                product_slug: 'gatecontrol',
            }),
        });
        if (res.ok) {
            const data = await res.json();
            fs.writeFileSync(TOKEN_PATH, data.token);
        }
    } catch {
        // Stiller Fehler — nächster Versuch beim nächsten Start
    }
}

module.exports = { validateLicense };
```

### Verwendung

```javascript
const { validateLicense } = require('./license');

async function main() {
    try {
        const license = await validateLicense(process.env.LICENSE_KEY);
        console.log(`Lizenz gültig: ${license.plan}`);

        if (license.features.includes('vpn-peers-unlimited')) {
            // Unbegrenzte Peers aktivieren
        }
    } catch (err) {
        console.error('Lizenzfehler:', err.message);
        process.exit(1);
    }
}
```

## Error Handling Best Practices

1. **Netzwerkfehler sind kein Lizenzfehler** — wenn der Server nicht erreichbar ist, nutze den gecachten Token
2. **Token vor Ablauf erneuern** — Hintergrund-Refresh wenn Token >50% der Gültigkeit verbraucht hat
3. **Nutzer informieren, nicht blockieren** — Hinweis bei Problemen, App erst blockieren wenn kein gültiger Token vorhanden
4. **Signing Key sicher speichern** — als Umgebungsvariable, nie im Code

## Error Codes Referenz

Siehe [License Validation API](./license-validation-api.md) für alle Error Codes und Response-Formate.
