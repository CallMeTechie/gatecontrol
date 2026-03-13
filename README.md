# GateControl

🇬🇧 **English** | 🇩🇪 [Deutsch](README.de.md)

**Unified WireGuard VPN + Caddy Reverse Proxy Management**

GateControl is a self-hosted, containerized management platform that combines WireGuard VPN peer management with Caddy reverse proxy routing in a single, security-focused web interface. It is designed for self-hosters and small teams who want full control over their VPN infrastructure and reverse proxy configuration without juggling multiple tools or editing config files manually.

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Security](#security)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Companion Projects](#companion-projects)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [License](#license)

---

## Features

### VPN Peer Management
- Create, edit, enable/disable, and delete WireGuard peers through a clean web UI
- Automatic key generation (private key, public key, preshared key) — no manual key handling
- Automatic IP allocation from a configurable subnet (default `10.8.0.0/24`)
- Downloadable peer configuration files and scannable QR codes for mobile clients
- Real-time peer status monitoring (online/offline detection via WireGuard handshake)
- Peer tagging for organization
- Hot-reload configuration changes via `wg syncconf` — no VPN restart needed

### Reverse Proxy Routing
- Domain-based reverse proxy routes powered by Caddy
- Automatic HTTPS with Let's Encrypt certificates — zero-configuration TLS
- Optional Basic Authentication per route
- Backend HTTPS support for targets with self-signed certificates (e.g., Synology DSM on port 5001)
- Link routes directly to VPN peers — the route automatically targets the peer's WireGuard IP
- Atomic configuration sync to Caddy with automatic rollback on failure

### Monitoring & Logging
- Real-time traffic monitoring with upload/download statistics per peer
- Dashboard with system metrics: connected peers, active routes, CPU, RAM, uptime
- Traffic charts with 1-hour, 24-hour, and 7-day views
- Full activity log with severity levels and filtering (peer created, route modified, login events, etc.)
- Caddy access log with automatic rotation (10 MB, keep 3 files)

### Backup & Restore
- Full system backup as portable JSON (peers, routes, settings, webhooks)
- Encrypted keys are decrypted for export portability — restore on any instance
- Atomic transaction-based restore with automatic WireGuard and Caddy resync
- Backup versioning for forward compatibility

### Webhooks
- Event-driven notifications to external services
- Subscribe to specific events or use wildcard (`*`) for all events
- URL validation blocks private/internal IP ranges to prevent SSRF
- JSON payloads with event type, message, details, and timestamp

### Internationalization
- Full English and German language support (200+ translation keys)
- Covers all UI elements: navigation, forms, status messages, error messages, dialogs

---

## How It Works

GateControl runs as a single Docker container that orchestrates three services via Supervisord:

<p align="center">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 520" font-family="Segoe UI, system-ui, sans-serif">
  <rect x="10" y="14" width="960" height="496" rx="12" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="8,4"/>
  <rect x="34" y="2" width="180" height="26" rx="6" fill="#2563eb"/>
  <text x="124" y="20" text-anchor="middle" fill="#fff" font-size="12" font-weight="700" letter-spacing="0.5">DOCKER CONTAINER</text>
  <rect x="30" y="44" width="280" height="210" rx="10" fill="#f0fdf4" stroke="#22c55e" stroke-width="1.5"/>
  <rect x="137" y="56" width="40" height="40" rx="9" fill="#dcfce7"/>
  <polygon points="157,63 145,70 145,84 157,91 169,84 169,70" fill="none" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="157" y1="91" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="145" y1="70" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <line x1="169" y1="70" x2="157" y2="77" stroke="#16a34a" stroke-width="1.3"/>
  <text x="157" y="116" text-anchor="middle" fill="#16a34a" font-size="16" font-weight="700">Caddy</text>
  <text x="157" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:80 / :443</text>
  <text x="70" y="164" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>HTTPS</text>
  <text x="70" y="186" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Reverse Proxy</text>
  <text x="70" y="208" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Let's Encrypt</text>
  <text x="70" y="230" fill="#374151" font-size="13"><tspan fill="#16a34a" font-weight="700">› </tspan>Auto Certificates</text>
  <rect x="350" y="44" width="280" height="210" rx="10" fill="#faf5ff" stroke="#a855f7" stroke-width="1.5"/>
  <rect x="462" y="56" width="40" height="40" rx="9" fill="#f3e8ff"/>
  <circle cx="482" cy="76" r="12" fill="none" stroke="#9333ea" stroke-width="1.3"/>
  <polyline points="476,76 480,80 488,70" fill="none" stroke="#9333ea" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="482" y="116" text-anchor="middle" fill="#9333ea" font-size="16" font-weight="700">WireGuard</text>
  <text x="482" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:51820 (UDP)</text>
  <text x="390" y="164" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>VPN Tunnel</text>
  <text x="390" y="186" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Peer Management</text>
  <text x="390" y="208" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Key Exchange</text>
  <text x="390" y="230" fill="#374151" font-size="13"><tspan fill="#9333ea" font-weight="700">› </tspan>Hot Reload</text>
  <rect x="670" y="44" width="280" height="210" rx="10" fill="#eff6ff" stroke="#3b82f6" stroke-width="1.5"/>
  <rect x="782" y="56" width="40" height="40" rx="9" fill="#dbeafe"/>
  <rect x="790" y="64" width="24" height="24" rx="4" fill="none" stroke="#2563eb" stroke-width="1.3"/>
  <line x1="796" y1="76" x2="808" y2="76" stroke="#2563eb" stroke-width="1.3" stroke-linecap="round"/>
  <line x1="802" y1="70" x2="802" y2="82" stroke="#2563eb" stroke-width="1.3" stroke-linecap="round"/>
  <text x="802" y="116" text-anchor="middle" fill="#2563eb" font-size="16" font-weight="700">Node.js</text>
  <text x="802" y="134" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">:3000 (Express)</text>
  <text x="710" y="164" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Web UI</text>
  <text x="710" y="186" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>REST API</text>
  <text x="710" y="208" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Background Tasks</text>
  <text x="710" y="230" fill="#374151" font-size="13"><tspan fill="#2563eb" font-weight="700">› </tspan>Auth &amp; Security</text>
  <line x1="310" y1="149" x2="345" y2="149" stroke="#9ca3af" stroke-width="2"/>
  <polygon points="315,145 307,149 315,153" fill="#9ca3af"/>
  <line x1="630" y1="149" x2="665" y2="149" stroke="#9ca3af" stroke-width="2"/>
  <polygon points="635,145 627,149 635,153" fill="#9ca3af"/>
  <line x1="802" y1="254" x2="802" y2="286" stroke="#9ca3af" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="798,284 802,294 806,284" fill="#d97706"/>
  <rect x="690" y="296" width="240" height="68" rx="10" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.5"/>
  <rect x="714" y="308" width="36" height="36" rx="8" fill="#fef3c7"/>
  <ellipse cx="732" cy="318" rx="10" ry="4" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <path d="M722,318 v14 c0,2.2 4.5,4 10,4 s10,-1.8 10,-4 v-14" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <path d="M722,326 c0,2.2 4.5,4 10,4 s10,-1.8 10,-4" fill="none" stroke="#d97706" stroke-width="1.2"/>
  <text x="810" y="326" text-anchor="middle" fill="#d97706" font-size="16" font-weight="700">SQLite</text>
  <text x="810" y="346" text-anchor="middle" fill="#6b7280" font-size="11" font-family="monospace">(WAL Mode)</text>
  <rect x="30" y="390" width="930" height="108" rx="9" fill="#f9fafb" stroke="#d1d5db" stroke-width="1" stroke-dasharray="5,3"/>
  <path d="M48,408 h8 l2,-3 h10 a2,2 0 0 1 2,2 v12 a2,2 0 0 1 -2,2 h-20 a2,2 0 0 1 -2,-2 v-9 a2,2 0 0 1 2,-2z" fill="none" stroke="#6b7280" stroke-width="1.2"/>
  <text x="76" y="419" fill="#6b7280" font-size="12" font-weight="700" letter-spacing="0.5">VOLUME: /data</text>
  <text x="50" y="448" fill="#d97706" font-size="13" font-family="monospace">gatecontrol.db</text>
  <text x="195" y="448" fill="#6b7280" font-size="12">── database</text>
  <text x="50" y="472" fill="#d97706" font-size="13" font-family="monospace">wireguard/</text>
  <text x="195" y="472" fill="#6b7280" font-size="12">── WireGuard configs &amp; keys</text>
  <text x="500" y="448" fill="#d97706" font-size="13" font-family="monospace">caddy/</text>
  <text x="645" y="448" fill="#6b7280" font-size="12">── certificates &amp; cache</text>
  <text x="500" y="472" fill="#d97706" font-size="13" font-family="monospace">.encryption_key</text>
  <text x="645" y="472" fill="#6b7280" font-size="12">── AES-256 key</text>
</svg>
</p>

### Startup Sequence

1. **Entrypoint** validates required environment variables and enables IP forwarding
2. **WireGuard keypair** is generated on first run and persisted to `/data/wireguard/`
3. **AES-256 encryption key** is generated (or loaded from previous run) and stored at `/data/.encryption_key`
4. **Supervisord** starts three processes in order:
   - **Caddy** (priority 10) — reverse proxy with automatic HTTPS
   - **WireGuard** (priority 20) — VPN interface via `wg-quick up`
   - **Node.js** (priority 30) — web application with background tasks
5. **Background tasks** begin: traffic collection (every 60s), peer status polling (every 30s), data cleanup (every 6h)
6. **Existing routes** are synced to Caddy after a 5-second startup delay

### Traffic Flow

**VPN Client → Internet:**
```
Client Device → WireGuard Tunnel (encrypted) → GateControl Container → iptables NAT → Internet
```

**External Request → Internal Service (via reverse proxy):**
```
Browser → Caddy (HTTPS/Let's Encrypt) → WireGuard Peer IP:Port → Internal Service
```

This means you can expose internal services (behind your VPN) to the internet with automatic HTTPS — without opening ports on your internal network. Caddy routes traffic through the WireGuard tunnel to reach services running on peer devices.

---

## Architecture

```
src/
├── server.js              # Application entry point, background tasks, graceful shutdown
├── app.js                 # Express setup, security middleware, template engine
├── db/
│   ├── connection.js      # SQLite with WAL mode and performance pragmas
│   ├── migrations.js      # Schema definition (8 tables)
│   └── seed.js            # Admin user initialization on first run
├── services/              # Business logic layer
│   ├── peers.js           # Peer CRUD, key generation, IP allocation, WG sync
│   ├── wireguard.js       # WireGuard CLI wrapper (wg, wg-quick, wg syncconf)
│   ├── routes.js          # Route CRUD, Caddy JSON config builder, admin API sync
│   ├── traffic.js         # Periodic traffic snapshots, chart data aggregation
│   ├── peerStatus.js      # Background peer online/offline polling
│   ├── activity.js        # Activity event logging with severity levels
│   ├── accessLog.js       # HTTP access log processing
│   ├── settings.js        # Key-value settings persistence
│   ├── backup.js          # Full backup/restore with atomic transactions
│   ├── webhook.js         # Event-driven webhook delivery
│   ├── qrcode.js          # QR code generation for peer configs
│   └── system.js          # System info (CPU, RAM, uptime, disk)
├── routes/
│   ├── index.js           # Page routes (dashboard, peers, routes, logs, settings)
│   ├── auth.js            # Login/logout handlers
│   └── api/               # RESTful API endpoints
│       ├── peers.js       # /api/peers — CRUD, toggle, sync, config export
│       ├── routes.js      # /api/routes — CRUD, toggle
│       ├── dashboard.js   # /api/dashboard — stats, traffic, charts
│       ├── settings.js    # /api/settings — get/set
│       ├── logs.js        # /api/logs — activity + access logs with filtering
│       ├── wireguard.js   # /api/wg — status, restart
│       ├── caddy.js       # /api/caddy — status, reload
│       ├── webhooks.js    # /api/webhooks — CRUD
│       └── system.js      # /api/system — system info
├── middleware/
│   ├── auth.js            # Session-based authentication guards
│   ├── csrf.js            # CSRF token protection (csrf-sync)
│   ├── i18n.js            # Language detection and translation injection
│   ├── rateLimit.js       # Rate limiting (login + API)
│   ├── sessionStore.js    # SQLite-backed session storage
│   └── locals.js          # Template variable injection
├── utils/
│   ├── crypto.js          # AES-256-GCM encryption, WireGuard key generation
│   ├── ip.js              # IP allocation from WireGuard subnet
│   ├── logger.js          # Structured logging via Pino
│   └── validate.js        # Input validation (domains, IPs, names)
└── i18n/
    ├── en.json            # English translations
    └── de.json            # German translations
```

---

## Security

GateControl is built with a security-first approach across every layer.

### End-to-End Encryption

All VPN traffic between clients and the GateControl server is encrypted end-to-end through WireGuard's modern cryptography:

- **Noise Protocol Framework** for key exchange
- **Curve25519** for Elliptic-curve Diffie-Hellman (ECDH)
- **ChaCha20-Poly1305** for authenticated encryption (AEAD)
- **BLAKE2s** for hashing
- **SipHash24** for hashtable keys

Each peer connection uses a unique keypair plus an optional preshared key (generated by default) for post-quantum resistance.

### Data Encryption at Rest

Sensitive data stored in the database (private keys, preshared keys) is encrypted using **AES-256-GCM**:

- 256-bit key (auto-generated on first run, persisted to `/data/.encryption_key` with `chmod 600`)
- 96-bit random IV per encryption operation
- 128-bit authentication tag for integrity verification
- Ciphertext format: `iv:tag:encrypted` (hex-encoded)

### HTTPS & Let's Encrypt

Caddy automatically provisions and renews TLS certificates via **Let's Encrypt** for all configured routes:

- Zero-configuration HTTPS — just add a domain and Caddy handles the rest
- HTTP to HTTPS auto-redirect on all routes
- Custom ACME CA support (e.g., for internal PKI via `GC_CADDY_ACME_CA`)
- Certificate data persisted in `/data/caddy/` across container restarts

### Web Application Security

| Layer | Implementation |
|-------|---------------|
| **Authentication** | Session-based with Argon2 password hashing |
| **CSRF Protection** | Synchronizer token pattern via csrf-sync on all state-changing requests |
| **Rate Limiting** | 5 login attempts / 15 min, 100 API requests / 15 min per IP (configurable) |
| **Security Headers** | Helmet.js with strict Content Security Policy, HSTS, X-Frame-Options |
| **CSP Nonces** | Per-request `crypto.randomBytes(16)` nonce for inline scripts |
| **Session Cookies** | `HttpOnly`, `Secure`, `SameSite=Strict`, configurable max age |
| **Input Validation** | Server-side validation for domains, IPs, names, descriptions |
| **Webhook SSRF Protection** | Blocks requests to localhost, private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x) |
| **Error Sanitization** | Detailed errors in development only; generic messages in production |

### Container Security

- Runs on Alpine Linux (minimal attack surface)
- WireGuard configuration files secured with `chmod 600`
- Encryption key file secured with `chmod 600`
- Only required capabilities: `NET_ADMIN` (network interface management) and `SYS_MODULE` (kernel module loading)
- Health check endpoint on internal port only (`127.0.0.1:3000`)

---

## Quick Start

```bash
# Clone and start
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol
cp .env.example .env

# Edit .env — set at minimum:
#   GC_ADMIN_PASSWORD  (your admin password)
#   GC_WG_HOST         (your public IP or domain)
#   GC_BASE_URL        (https://your-domain.com)

docker compose up -d
```

GateControl will be available at your configured `GC_BASE_URL`.

---

## Installation

### Option 1: Online (recommended)

Download the setup files and run the interactive installer:

```bash
mkdir gatecontrol && cd gatecontrol

# Download setup files from the latest release
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example

# Run interactive setup (installs Docker if needed, pulls image from GHCR)
sudo bash setup.sh
```

The setup script will:
1. Detect your OS (Ubuntu, Debian, Fedora, CentOS, RHEL, Rocky, Alma, Alpine)
2. Install Docker and Docker Compose if not present
3. Pull the latest image from `ghcr.io/callmetechie/gatecontrol`
4. Walk you through configuration (domain, admin credentials, language, etc.)
5. Generate secure secrets automatically
6. Start the container

### Option 2: Offline

Download all release assets including the pre-built Docker image:

```bash
# Download all files from a specific release
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/gatecontrol-image.tar.gz
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/download/v1.0.0/.env.example

# Run setup — detects the tar.gz and loads it locally
sudo bash setup.sh
```

### Option 3: Docker Compose (manual)

```bash
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol
cp .env.example .env
# Edit .env with your values
docker compose up -d
```

### Updating

```bash
# Pull latest image
docker pull ghcr.io/callmetechie/gatecontrol:latest

# Restart with new image
docker compose down && docker compose up -d
```

Your data is persisted in the `gatecontrol-data` Docker volume and survives updates.

---

## Configuration

All configuration is done through environment variables in the `.env` file.

### Required Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `GC_ADMIN_PASSWORD` | Admin login password | `MySecureP@ss!` |
| `GC_WG_HOST` | Public IP or domain for WireGuard | `vpn.example.com` |
| `GC_BASE_URL` | Full URL of the web interface | `https://gate.example.com` |

### Application

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_APP_NAME` | `GateControl` | Application name shown in UI |
| `GC_HOST` | `0.0.0.0` | Listen address |
| `GC_PORT` | `3000` | Internal application port |
| `GC_SECRET` | auto-generated | Session secret (auto-generated if empty) |
| `GC_DB_PATH` | `/data/gatecontrol.db` | SQLite database path |
| `GC_LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_ADMIN_USER` | `admin` | Admin username |
| `GC_SESSION_MAX_AGE` | `86400000` | Session lifetime in ms (24h) |
| `GC_RATE_LIMIT_LOGIN` | `5` | Max login attempts per 15 min |
| `GC_RATE_LIMIT_API` | `100` | Max API requests per 15 min |

### WireGuard

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_WG_INTERFACE` | `wg0` | WireGuard interface name |
| `GC_WG_PORT` | `51820` | WireGuard listen port |
| `GC_WG_SUBNET` | `10.8.0.0/24` | VPN subnet for peer IP allocation |
| `GC_WG_GATEWAY_IP` | `10.8.0.1` | Server's VPN IP address |
| `GC_WG_DNS` | `1.1.1.1,8.8.8.8` | DNS servers pushed to clients |
| `GC_WG_ALLOWED_IPS` | `0.0.0.0/0` | Allowed IPs for peers (full tunnel) |
| `GC_WG_PERSISTENT_KEEPALIVE` | `25` | Keepalive interval in seconds |
| `GC_WG_MTU` | (empty) | Custom MTU (leave empty for auto) |

### Caddy / HTTPS

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_CADDY_ADMIN_URL` | `http://127.0.0.1:2019` | Caddy admin API URL |
| `GC_CADDY_DATA_DIR` | `/data/caddy` | Caddy data directory (certs, cache) |
| `GC_CADDY_EMAIL` | (empty) | Email for Let's Encrypt registration |
| `GC_CADDY_ACME_CA` | (empty) | Custom ACME CA URL (for internal PKI) |

### Localization

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_DEFAULT_LANGUAGE` | `en` | Default language (`en` or `de`) |
| `GC_DEFAULT_THEME` | `default` | UI theme |

### Network & Encryption

| Variable | Default | Description |
|----------|---------|-------------|
| `GC_NET_INTERFACE` | `eth0` | Host network interface for NAT rules |
| `GC_ENCRYPTION_KEY` | auto-generated | AES-256 key for database encryption |

---

## Usage

### Web Interface

After starting GateControl, navigate to your configured `GC_BASE_URL` and log in with your admin credentials.

**Dashboard** — Overview of connected peers, active routes, traffic charts, and system metrics.

**Peers** — Create and manage WireGuard VPN peers. Each peer gets an auto-allocated IP, generated keys, and a downloadable configuration file with QR code.

**Routes** — Configure reverse proxy routes. Map external domains to internal services through your VPN peers. Caddy handles HTTPS certificates automatically.

**Config** — View the current WireGuard configuration (private key masked).

**Certificates** — View SSL/TLS certificates managed by Caddy.

**Logs** — Browse activity logs and access logs with filtering by event type and severity.

**Settings** — System settings, backup/restore, and webhook configuration.

### API

All management functions are available via REST API at `/api/*`. Requests require an authenticated session.

```bash
# Example: List all peers
curl -b cookies.txt https://gate.example.com/api/peers

# Example: Create a new peer
curl -b cookies.txt -X POST https://gate.example.com/api/peers \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -d '{"name": "my-laptop", "description": "Work laptop"}'
```

### Ports

| Port | Protocol | Service |
|------|----------|---------|
| 80 | TCP | HTTP (auto-redirects to HTTPS) |
| 443 | TCP/UDP | HTTPS (Caddy reverse proxy) |
| 51820 | UDP | WireGuard VPN |

---

## Companion Projects

### docker-wireguard-go

**[docker-wireguard-go](https://github.com/CallMeTechie/docker-wireguard-go)** — WireGuard-Go Docker Client for Synology NAS (userspace, no kernel module required).

If you want to connect a Synology NAS to your GateControl VPN without kernel module support, use docker-wireguard-go as the WireGuard client. Create a peer in GateControl, download the configuration, and use it with docker-wireguard-go on your NAS. Combined with GateControl's reverse proxy routes, you can expose Synology services (DSM, Drive, Photos) to the internet with automatic HTTPS — without opening any ports on your NAS.

```
Internet → GateControl (HTTPS) → WireGuard Tunnel → docker-wireguard-go (NAS) → DSM :5001
```

Enable **Backend HTTPS** on the route for services that use self-signed certificates (like Synology DSM on port 5001).

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js 20 (Alpine Linux) |
| **Framework** | Express.js 4.21 |
| **Database** | SQLite (better-sqlite3, WAL mode) |
| **VPN** | WireGuard (wireguard-tools) |
| **Reverse Proxy** | Caddy (automatic HTTPS) |
| **Template Engine** | Nunjucks |
| **Password Hashing** | Argon2 (admin), bcrypt (route basic auth) |
| **Encryption** | AES-256-GCM (Node.js crypto) |
| **Session Store** | SQLite-backed |
| **Security** | Helmet, csrf-sync, express-rate-limit |
| **Logging** | Pino |
| **Process Manager** | Supervisord |
| **Container** | Docker (Alpine) |
| **CI/CD** | GitHub Actions |
| **Registry** | GitHub Container Registry (GHCR) |

---

## Development

```bash
# Clone the repository
git clone https://github.com/CallMeTechie/gatecontrol.git
cd gatecontrol

# Install dependencies
npm install

# Start in development mode (auto-reload on file changes)
npm run dev

# Run tests
npm test
```

### Requirements

- Node.js >= 20.0.0
- WireGuard tools (for full functionality)
- Caddy (for reverse proxy features)

### Project Structure

- `src/` — Application source code
- `public/` — Static frontend assets (CSS, JS, images)
- `templates/` — Nunjucks page templates
- `config/` — Application configuration
- `tests/` — Unit tests
- `deploy/` — Deployment files (setup script, compose file)

---

## License

See [LICENSE](LICENSE) for details.
