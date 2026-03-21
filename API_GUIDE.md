# GateControl API Guide

Practical guide with real-world examples for integrating GateControl into your automation workflows.

For the complete endpoint reference, see [API.md](API.md).

---

## Table of Contents

- [Getting Started](#getting-started)
- [Use Cases](#use-cases)
  - [Home Assistant](#home-assistant)
  - [Bash Scripts & Cron Jobs](#bash-scripts--cron-jobs)
  - [iOS Shortcuts / Android Tasker](#ios-shortcuts--android-tasker)
  - [Node.js / JavaScript](#nodejs--javascript)
  - [Python](#python)
  - [Monitoring & Alerting](#monitoring--alerting)
  - [CI/CD Pipelines](#cicd-pipelines)
  - [Telegram / Discord Bots](#telegram--discord-bots)

---

## Getting Started

### 1. Create an API Token

Open GateControl **Settings > API Tokens** and create a new token:

- **Name**: A descriptive name (e.g., "Home Assistant", "Backup Script")
- **Scopes**: Select only the permissions you need (principle of least privilege)
- **Expiry**: Set an expiration date for security, or "Never" for long-running automations

After clicking **Create**, the token (`gc_...`) is shown **once**. Copy it immediately and store it securely.

### 2. Test Your Token

```bash
curl -s -H "Authorization: Bearer gc_your_token_here" \
  https://gate.example.com/api/v1/dashboard/stats | jq .
```

Expected response:
```json
{
  "ok": true,
  "stats": {
    "peers_total": 5,
    "peers_online": 3,
    "routes_total": 8,
    "routes_active": 7
  }
}
```

### 3. Understand Scopes

Create tokens with **minimal scopes**. A backup script doesn't need peer access:

| Use Case | Recommended Scopes |
|----------|-------------------|
| Home Assistant (peer control) | `peers` |
| Backup script | `backup` |
| Monitoring dashboard | `read-only` |
| CI/CD (deploy routes) | `routes` |
| Full admin automation | `full-access` |
| Log collection | `logs` |
| Webhook management | `webhooks` |

---

## Use Cases

---

### Home Assistant

#### Switches for VPN Peers

Control VPN peers as switches in Home Assistant. Each peer becomes a toggleable entity.

**`configuration.yaml`:**

```yaml
rest_command:
  gatecontrol_toggle_peer:
    url: "https://gate.example.com/api/v1/peers/{{ peer_id }}/toggle"
    method: PUT
    headers:
      Authorization: "Bearer gc_your_token_here"
    content_type: "application/json"

  gatecontrol_create_peer:
    url: "https://gate.example.com/api/v1/peers"
    method: POST
    headers:
      Authorization: "Bearer gc_your_token_here"
    content_type: "application/json"
    payload: '{"name": "{{ name }}", "description": "{{ description }}"}'

sensor:
  # Dashboard stats
  - platform: rest
    name: "GateControl Stats"
    resource: "https://gate.example.com/api/v1/dashboard/stats"
    headers:
      Authorization: "Bearer gc_your_token_here"
    value_template: "{{ value_json.stats.peers_online }}/{{ value_json.stats.peers_total }}"
    json_attributes_path: "$.stats"
    json_attributes:
      - peers_total
      - peers_online
      - routes_total
      - routes_active
    scan_interval: 30

  # Individual peer status
  - platform: rest
    name: "GateControl Peers"
    resource: "https://gate.example.com/api/v1/peers"
    headers:
      Authorization: "Bearer gc_your_token_here"
    value_template: "{{ value_json.peers | length }}"
    json_attributes_path: "$"
    json_attributes:
      - peers
    scan_interval: 30

  # System resources
  - platform: rest
    name: "GateControl System"
    resource: "https://gate.example.com/api/v1/system/resources"
    headers:
      Authorization: "Bearer gc_your_token_here"
    value_template: "{{ value_json.cpu }}%"
    json_attributes_path: "$"
    json_attributes:
      - cpu
      - ram
      - uptime
    scan_interval: 60

binary_sensor:
  # Health check
  - platform: rest
    name: "GateControl Health"
    resource: "https://gate.example.com/health"
    value_template: "{{ value_json.status == 'healthy' }}"
    scan_interval: 60
```

#### Template Switches for Individual Peers

Create a switch for each peer by ID:

```yaml
switch:
  - platform: template
    switches:
      vpn_laptop:
        friendly_name: "VPN Laptop"
        value_template: >
          {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
          {% if peers %}
            {{ peers | selectattr('id', 'eq', 1) | map(attribute='enabled') | first | default(false) }}
          {% else %}
            false
          {% endif %}
        turn_on:
          - condition: template
            value_template: >
              {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
              {{ not (peers | selectattr('id', 'eq', 1) | map(attribute='enabled') | first | default(false)) }}
          - service: rest_command.gatecontrol_toggle_peer
            data:
              peer_id: 1
        turn_off:
          - condition: template
            value_template: >
              {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
              {{ peers | selectattr('id', 'eq', 1) | map(attribute='enabled') | first | default(false) }}
          - service: rest_command.gatecontrol_toggle_peer
            data:
              peer_id: 1

      vpn_nas:
        friendly_name: "VPN NAS"
        value_template: >
          {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
          {% if peers %}
            {{ peers | selectattr('id', 'eq', 2) | map(attribute='enabled') | first | default(false) }}
          {% else %}
            false
          {% endif %}
        turn_on:
          - condition: template
            value_template: >
              {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
              {{ not (peers | selectattr('id', 'eq', 2) | map(attribute='enabled') | first | default(false)) }}
          - service: rest_command.gatecontrol_toggle_peer
            data:
              peer_id: 2
        turn_off:
          - condition: template
            value_template: >
              {% set peers = state_attr('sensor.gatecontrol_peers', 'peers') %}
              {{ peers | selectattr('id', 'eq', 2) | map(attribute='enabled') | first | default(false) }}
          - service: rest_command.gatecontrol_toggle_peer
            data:
              peer_id: 2
```

#### Automations

```yaml
automation:
  # Disable guest VPN at midnight
  - alias: "Disable Guest VPN at Night"
    trigger:
      - platform: time
        at: "00:00:00"
    action:
      - service: rest_command.gatecontrol_toggle_peer
        data:
          peer_id: 3   # Guest peer ID

  # Enable VPN when arriving home
  - alias: "Enable VPN When Home"
    trigger:
      - platform: zone
        entity_id: person.user
        zone: zone.home
        event: enter
    action:
      - service: rest_command.gatecontrol_toggle_peer
        data:
          peer_id: 1

  # Alert when GateControl is unhealthy
  - alias: "GateControl Health Alert"
    trigger:
      - platform: state
        entity_id: binary_sensor.gatecontrol_health
        to: "off"
        for:
          minutes: 2
    action:
      - service: notify.mobile_app
        data:
          title: "GateControl Alert"
          message: "GateControl health check failed!"
```

#### Lovelace Dashboard Card

```yaml
type: entities
title: GateControl VPN
entities:
  - entity: switch.vpn_laptop
    name: Laptop VPN
    icon: mdi:laptop
  - entity: switch.vpn_nas
    name: NAS VPN
    icon: mdi:nas
  - entity: binary_sensor.gatecontrol_health
    name: Status
    icon: mdi:heart-pulse
  - type: attribute
    entity: sensor.gatecontrol_stats
    attribute: peers_online
    name: Peers Online
    icon: mdi:account-network
    suffix: " online"
  - type: attribute
    entity: sensor.gatecontrol_system
    attribute: cpu
    name: CPU
    icon: mdi:cpu-64-bit
    suffix: "%"
  - type: attribute
    entity: sensor.gatecontrol_system
    attribute: ram
    name: RAM
    icon: mdi:memory
    suffix: "%"
```

---

### Bash Scripts & Cron Jobs

#### Automated Daily Backup

```bash
#!/bin/bash
# /usr/local/bin/gatecontrol-backup.sh
# Cron: 0 3 * * * /usr/local/bin/gatecontrol-backup.sh

TOKEN="gc_your_token_here"
URL="https://gate.example.com"
BACKUP_DIR="/opt/backups/gatecontrol"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

# Download backup
FILENAME="gatecontrol-$(date +%Y%m%d-%H%M%S).json"
HTTP_CODE=$(curl -s -o "$BACKUP_DIR/$FILENAME" -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$URL/api/v1/settings/backup")

if [ "$HTTP_CODE" = "200" ]; then
  echo "[$(date)] Backup saved: $FILENAME ($(stat -f%z "$BACKUP_DIR/$FILENAME" 2>/dev/null || stat -c%s "$BACKUP_DIR/$FILENAME") bytes)"

  # Remove old backups
  find "$BACKUP_DIR" -name "gatecontrol-*.json" -mtime +$RETENTION_DAYS -delete
  echo "[$(date)] Cleaned up backups older than $RETENTION_DAYS days"
else
  echo "[$(date)] ERROR: Backup failed with HTTP $HTTP_CODE" >&2
  exit 1
fi
```

#### Peer On/Off Schedule (Business Hours)

```bash
#!/bin/bash
# /usr/local/bin/gatecontrol-schedule.sh
# Enable peers at 8 AM, disable at 6 PM
# Cron:
#   0 8  * * 1-5 /usr/local/bin/gatecontrol-schedule.sh enable
#   0 18 * * 1-5 /usr/local/bin/gatecontrol-schedule.sh disable

TOKEN="gc_your_token_here"
URL="https://gate.example.com"
PEER_IDS=(2 3 4)  # Office peers

ACTION=$1

for ID in "${PEER_IDS[@]}"; do
  # Get current state
  ENABLED=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$URL/api/v1/peers/$ID" | jq -r '.peer.enabled')

  if [ "$ACTION" = "enable" ] && [ "$ENABLED" = "false" ]; then
    curl -s -X PUT -H "Authorization: Bearer $TOKEN" "$URL/api/v1/peers/$ID/toggle"
    echo "Enabled peer $ID"
  elif [ "$ACTION" = "disable" ] && [ "$ENABLED" = "true" ]; then
    curl -s -X PUT -H "Authorization: Bearer $TOKEN" "$URL/api/v1/peers/$ID/toggle"
    echo "Disabled peer $ID"
  fi
done
```

#### Bulk Peer Creation

```bash
#!/bin/bash
# Create multiple peers at once

TOKEN="gc_your_token_here"
URL="https://gate.example.com"

PEERS=(
  "alice-laptop:Alice Laptop:dev"
  "bob-phone:Bob Phone:dev"
  "guest-wifi:Guest WiFi:guest"
  "server-01:Production Server:infra"
)

for ENTRY in "${PEERS[@]}"; do
  IFS=':' read -r NAME DESC TAGS <<< "$ENTRY"

  RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NAME\", \"description\": \"$DESC\", \"tags\": \"$TAGS\"}" \
    "$URL/api/v1/peers")

  IP=$(echo "$RESULT" | jq -r '.peer.ip // "error"')
  echo "Created: $NAME → $IP"
done
```

#### Export Peer Configs for Distribution

```bash
#!/bin/bash
# Export all peer configs to individual .conf files

TOKEN="gc_your_token_here"
URL="https://gate.example.com"
OUTPUT_DIR="./wireguard-configs"

mkdir -p "$OUTPUT_DIR"

# Get all peers
PEERS=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/v1/peers")
IDS=$(echo "$PEERS" | jq -r '.peers[].id')

for ID in $IDS; do
  NAME=$(echo "$PEERS" | jq -r ".peers[] | select(.id == $ID) | .name")
  curl -s -H "Authorization: Bearer $TOKEN" \
    "$URL/api/v1/peers/$ID/config?download=1" \
    -o "$OUTPUT_DIR/${NAME}.conf"
  echo "Exported: ${NAME}.conf"
done
```

---

### iOS Shortcuts / Android Tasker

#### iOS Shortcut: Toggle VPN Peer

Create a new Shortcut with these actions:

1. **Get Contents of URL**
   - URL: `https://gate.example.com/api/v1/peers/1/toggle`
   - Method: `PUT`
   - Headers: `Authorization` → `Bearer gc_your_token_here`

2. **Show Notification**
   - Title: `VPN`
   - Body: `Peer toggled`

Add it to your Home Screen as a widget for one-tap VPN control.

#### iOS Shortcut: Check VPN Status

1. **Get Contents of URL**
   - URL: `https://gate.example.com/api/v1/dashboard/stats`
   - Method: `GET`
   - Headers: `Authorization` → `Bearer gc_your_token_here`

2. **Get Dictionary Value** (key: `stats.peers_online`)

3. **Show Alert**
   - Title: `GateControl`
   - Body: `[peers_online] peers online`

#### Android Tasker: Auto-Toggle on WiFi

```
Profile: "Home WiFi Connected"
  Trigger: WiFi Connected (SSID: YourHomeWiFi)
  Task:
    1. HTTP Request
       Method: PUT
       URL: https://gate.example.com/api/v1/peers/1/toggle
       Headers: Authorization: Bearer gc_your_token_here
    2. Flash: "VPN enabled"

Profile: "Home WiFi Disconnected"
  Trigger: WiFi Disconnected
  Task:
    1. HTTP Request
       Method: PUT
       URL: https://gate.example.com/api/v1/peers/1/toggle
       Headers: Authorization: Bearer gc_your_token_here
    2. Flash: "VPN disabled"
```

---

### Node.js / JavaScript

#### GateControl API Client

```javascript
class GateControl {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  async request(method, path, body = null) {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : null,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Peers
  async listPeers() { return this.request('GET', '/peers'); }
  async getPeer(id) { return this.request('GET', `/peers/${id}`); }
  async createPeer(name, description, tags) {
    return this.request('POST', '/peers', { name, description, tags });
  }
  async togglePeer(id) { return this.request('PUT', `/peers/${id}/toggle`); }
  async deletePeer(id) { return this.request('DELETE', `/peers/${id}`); }

  // Routes
  async listRoutes() { return this.request('GET', '/routes'); }
  async createRoute(data) { return this.request('POST', '/routes', data); }
  async toggleRoute(id) { return this.request('PUT', `/routes/${id}/toggle`); }

  // System
  async getStats() { return this.request('GET', '/dashboard/stats'); }
  async getResources() { return this.request('GET', '/system/resources'); }
  async getHealth() {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  // Backup
  async downloadBackup() {
    const res = await fetch(`${this.baseUrl}/api/v1/settings/backup`, {
      headers: this.headers,
    });
    return res.json();
  }
}

// Usage
const gc = new GateControl('https://gate.example.com', 'gc_your_token_here');

// List all peers
const { peers } = await gc.listPeers();
console.log(`${peers.length} peers, ${peers.filter(p => p.status === 'online').length} online`);

// Create a new peer
const { peer } = await gc.createPeer('test-peer', 'API-created peer', 'auto');
console.log(`Created peer: ${peer.name} (${peer.ip})`);

// Toggle peer
await gc.togglePeer(peer.id);
```

---

### Python

#### GateControl API Client

```python
import requests
from datetime import datetime

class GateControl:
    def __init__(self, base_url, token):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        })

    def _request(self, method, path, **kwargs):
        url = f'{self.base_url}/api/v1{path}'
        r = self.session.request(method, url, **kwargs)
        r.raise_for_status()
        data = r.json()
        if not data.get('ok', True):
            raise Exception(data.get('error', 'Unknown error'))
        return data

    # Peers
    def list_peers(self):
        return self._request('GET', '/peers')['peers']

    def get_peer(self, peer_id):
        return self._request('GET', f'/peers/{peer_id}')['peer']

    def create_peer(self, name, description='', tags=''):
        return self._request('POST', '/peers',
            json={'name': name, 'description': description, 'tags': tags})['peer']

    def toggle_peer(self, peer_id):
        return self._request('PUT', f'/peers/{peer_id}/toggle')

    def delete_peer(self, peer_id):
        return self._request('DELETE', f'/peers/{peer_id}')

    def get_peer_config(self, peer_id):
        url = f'{self.base_url}/api/v1/peers/{peer_id}/config'
        r = self.session.get(url)
        r.raise_for_status()
        return r.text

    # Routes
    def list_routes(self):
        return self._request('GET', '/routes')['routes']

    def create_route(self, domain, target_ip, target_port, **kwargs):
        data = {'domain': domain, 'target_ip': target_ip,
                'target_port': target_port, **kwargs}
        return self._request('POST', '/routes', json=data)['route']

    def toggle_route(self, route_id):
        return self._request('PUT', f'/routes/{route_id}/toggle')

    # System
    def get_stats(self):
        return self._request('GET', '/dashboard/stats')['stats']

    def get_resources(self):
        return self._request('GET', '/system/resources')

    def health(self):
        r = self.session.get(f'{self.base_url}/health')
        return r.json()

    # Backup
    def download_backup(self, filepath=None):
        r = self.session.get(f'{self.base_url}/api/v1/settings/backup')
        r.raise_for_status()
        if filepath:
            with open(filepath, 'w') as f:
                f.write(r.text)
        return r.json()

    # Logs
    def get_activity_log(self, page=1, limit=50):
        return self._request('GET', f'/logs/activity?page={page}&limit={limit}')


# Usage
gc = GateControl('https://gate.example.com', 'gc_your_token_here')

# List peers with status
for peer in gc.list_peers():
    status = 'online' if peer['status'] == 'online' else 'offline'
    print(f"  {peer['name']:20s} {peer['ip']:15s} [{status}]")

# Create peer and save config
peer = gc.create_peer('auto-peer', 'Created by Python script')
config = gc.get_peer_config(peer['id'])
with open(f"{peer['name']}.conf", 'w') as f:
    f.write(config)

# Automated backup
gc.download_backup(f"backup-{datetime.now():%Y%m%d}.json")
```

#### Flask Dashboard Example

```python
from flask import Flask, render_template_string
app = Flask(__name__)

gc = GateControl('https://gate.example.com', 'gc_your_token_here')

@app.route('/')
def dashboard():
    stats = gc.get_stats()
    peers = gc.list_peers()
    resources = gc.get_resources()

    return render_template_string('''
        <h1>VPN Dashboard</h1>
        <p>Peers: {{ stats.peers_online }}/{{ stats.peers_total }} online</p>
        <p>CPU: {{ resources.cpu }}% | RAM: {{ resources.ram }}%</p>
        <table>
            <tr><th>Name</th><th>IP</th><th>Status</th></tr>
            {% for p in peers %}
            <tr>
                <td>{{ p.name }}</td>
                <td>{{ p.ip }}</td>
                <td>{{ '🟢' if p.status == 'online' else '🔴' }}</td>
            </tr>
            {% endfor %}
        </table>
    ''', stats=stats, peers=peers, resources=resources)
```

---

### Monitoring & Alerting

#### Prometheus (Custom Exporter)

```python
#!/usr/bin/env python3
# gatecontrol_exporter.py — Prometheus exporter for GateControl
# Run: python3 gatecontrol_exporter.py
# Scrape: http://localhost:9120/metrics

from prometheus_client import start_http_server, Gauge, Info
import time

gc = GateControl('https://gate.example.com', 'gc_your_token_here')

# Gauges
peers_total = Gauge('gatecontrol_peers_total', 'Total number of peers')
peers_online = Gauge('gatecontrol_peers_online', 'Number of online peers')
routes_total = Gauge('gatecontrol_routes_total', 'Total number of routes')
routes_active = Gauge('gatecontrol_routes_active', 'Number of active routes')
cpu_usage = Gauge('gatecontrol_cpu_usage_percent', 'CPU usage')
ram_usage = Gauge('gatecontrol_ram_usage_percent', 'RAM usage')
peer_status = Gauge('gatecontrol_peer_status', 'Peer status (1=online)', ['name', 'ip'])
peer_transfer_rx = Gauge('gatecontrol_peer_rx_bytes', 'Peer received bytes', ['name'])
peer_transfer_tx = Gauge('gatecontrol_peer_tx_bytes', 'Peer transmitted bytes', ['name'])

def collect():
    stats = gc.get_stats()
    peers_total.set(stats['peers_total'])
    peers_online.set(stats['peers_online'])
    routes_total.set(stats['routes_total'])
    routes_active.set(stats['routes_active'])

    resources = gc.get_resources()
    cpu_usage.set(resources['cpu'])
    ram_usage.set(resources['ram'])

    for peer in gc.list_peers():
        peer_status.labels(name=peer['name'], ip=peer['ip']).set(
            1 if peer['status'] == 'online' else 0)
        peer_transfer_rx.labels(name=peer['name']).set(peer.get('total_rx', 0))
        peer_transfer_tx.labels(name=peer['name']).set(peer.get('total_tx', 0))

if __name__ == '__main__':
    start_http_server(9120)
    print("GateControl exporter running on :9120/metrics")
    while True:
        try:
            collect()
        except Exception as e:
            print(f"Error: {e}")
        time.sleep(30)
```

#### Uptime Kuma

Add a new monitor in Uptime Kuma:

| Setting | Value |
|---------|-------|
| Monitor Type | HTTP(s) - JSON Query |
| URL | `https://gate.example.com/health` |
| Method | GET |
| Expected Value | `healthy` |
| JSON Query | `$.status` |
| Interval | 60s |

For authenticated monitoring:

| Setting | Value |
|---------|-------|
| URL | `https://gate.example.com/api/v1/dashboard/stats` |
| Headers | `{"Authorization": "Bearer gc_your_token_here"}` |
| JSON Query | `$.ok` |
| Expected Value | `true` |

#### Grafana (JSON Data Source)

Use the Infinity data source plugin to query GateControl directly:

1. Install **Grafana Infinity** data source plugin
2. Add data source → Infinity → URL: `https://gate.example.com`
3. Authentication: Custom Headers → `Authorization: Bearer gc_your_token_here`
4. Create dashboard panels:

**Panel: Peers Online (Stat)**
```
Type: JSON
URL: /api/v1/dashboard/stats
JSONPath: $.stats.peers_online
```

**Panel: CPU/RAM (Gauge)**
```
Type: JSON
URL: /api/v1/system/resources
JSONPath: $.cpu  (and $.ram for second query)
```

**Panel: Peer Status (Table)**
```
Type: JSON
URL: /api/v1/peers
JSONPath: $.peers[*]
Columns: name, ip, status, total_rx, total_tx
```

---

### CI/CD Pipelines

#### GitHub Actions: Deploy Route After Release

```yaml
name: Deploy Route
on:
  release:
    types: [published]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Enable staging route
        run: |
          curl -sf -X PUT \
            -H "Authorization: Bearer ${{ secrets.GATECONTROL_TOKEN }}" \
            "${{ secrets.GATECONTROL_URL }}/api/v1/routes/5/toggle"

      - name: Verify route is up
        run: |
          sleep 10
          STATUS=$(curl -sf \
            -H "Authorization: Bearer ${{ secrets.GATECONTROL_TOKEN }}" \
            "${{ secrets.GATECONTROL_URL }}/api/v1/dashboard/stats" \
            | jq -r '.ok')
          if [ "$STATUS" != "true" ]; then
            echo "GateControl health check failed"
            exit 1
          fi
```

#### GitLab CI: Create Peer for Review Environment

```yaml
create_vpn_peer:
  stage: deploy
  script:
    - |
      PEER=$(curl -sf -X POST \
        -H "Authorization: Bearer $GATECONTROL_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"review-${CI_MERGE_REQUEST_IID}\", \"description\": \"Review env MR !${CI_MERGE_REQUEST_IID}\", \"tags\": \"ci,review\"}" \
        "$GATECONTROL_URL/api/v1/peers")
      echo "Peer IP: $(echo $PEER | jq -r '.peer.ip')"
  environment:
    name: review/$CI_MERGE_REQUEST_IID
    on_stop: destroy_vpn_peer

destroy_vpn_peer:
  stage: cleanup
  when: manual
  script:
    - |
      # Find peer by name
      PEERS=$(curl -sf -H "Authorization: Bearer $GATECONTROL_TOKEN" \
        "$GATECONTROL_URL/api/v1/peers")
      PEER_ID=$(echo $PEERS | jq -r ".peers[] | select(.name == \"review-${CI_MERGE_REQUEST_IID}\") | .id")
      if [ -n "$PEER_ID" ]; then
        curl -sf -X DELETE \
          -H "Authorization: Bearer $GATECONTROL_TOKEN" \
          "$GATECONTROL_URL/api/v1/peers/$PEER_ID"
      fi
  environment:
    name: review/$CI_MERGE_REQUEST_IID
    action: stop
```

---

### Telegram / Discord Bots

#### Telegram Bot (Python)

```python
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

gc = GateControl('https://gate.example.com', 'gc_your_token_here')
ALLOWED_USERS = [123456789]  # Your Telegram user ID

def auth(func):
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.effective_user.id not in ALLOWED_USERS:
            await update.message.reply_text("Unauthorized")
            return
        return await func(update, context)
    return wrapper

@auth
async def status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    stats = gc.get_stats()
    peers = gc.list_peers()
    online = [p['name'] for p in peers if p['status'] == 'online']

    text = f"*GateControl Status*\n"
    text += f"Peers: {stats['peers_online']}/{stats['peers_total']} online\n"
    text += f"Routes: {stats['routes_active']}/{stats['routes_total']} active\n\n"
    if online:
        text += f"Online: {', '.join(online)}"

    await update.message.reply_text(text, parse_mode='Markdown')

@auth
async def toggle(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /toggle <peer_id>")
        return

    peer_id = int(context.args[0])
    gc.toggle_peer(peer_id)
    peer = gc.get_peer(peer_id)
    state = "enabled" if peer['enabled'] else "disabled"
    await update.message.reply_text(f"{peer['name']} is now *{state}*", parse_mode='Markdown')

@auth
async def peers(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lines = []
    for p in gc.list_peers():
        icon = "🟢" if p['status'] == 'online' else "🔴"
        state = "✅" if p['enabled'] else "❌"
        lines.append(f"{icon} {state} `{p['id']}` {p['name']} ({p['ip']})")
    await update.message.reply_text("\n".join(lines), parse_mode='Markdown')

app = Application.builder().token("YOUR_TELEGRAM_BOT_TOKEN").build()
app.add_handler(CommandHandler("status", status))
app.add_handler(CommandHandler("toggle", toggle))
app.add_handler(CommandHandler("peers", peers))
app.run_polling()
```

**Commands:**
- `/status` — Show dashboard stats
- `/peers` — List all peers with status
- `/toggle 1` — Toggle peer by ID

#### Discord Bot (Node.js)

```javascript
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const gc = new GateControl('https://gate.example.com', 'gc_your_token_here');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'vpn-status') {
    const { stats } = await gc.getStats();
    const { peers } = await gc.listPeers();
    const online = peers.filter(p => p.status === 'online').map(p => p.name);

    await interaction.reply(
      `**GateControl** — ${stats.peers_online}/${stats.peers_total} peers online\n` +
      `Routes: ${stats.routes_active}/${stats.routes_total}\n` +
      (online.length ? `Online: ${online.join(', ')}` : 'No peers online')
    );
  }

  if (interaction.commandName === 'vpn-toggle') {
    const id = interaction.options.getInteger('peer');
    await gc.togglePeer(id);
    const { peer } = await gc.getPeer(id);
    await interaction.reply(`**${peer.name}** is now ${peer.enabled ? 'enabled ✅' : 'disabled ❌'}`);
  }
});

client.login('YOUR_DISCORD_BOT_TOKEN');
```

---

## Tips & Best Practices

### Security

- **Never hardcode tokens** in source code. Use environment variables or secrets managers.
- **Use minimal scopes**. A monitoring script only needs `read-only`.
- **Set token expiry** for temporary integrations (CI/CD review environments).
- **One token per integration**. Don't share tokens between different systems. If one is compromised, you can revoke it without affecting others.
- **Use HTTPS only**. Never send tokens over unencrypted HTTP.

### Error Handling

Always check the `ok` field in responses:

```bash
RESULT=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/v1/peers")
if [ "$(echo $RESULT | jq -r '.ok')" != "true" ]; then
  echo "Error: $(echo $RESULT | jq -r '.error')"
  exit 1
fi
```

### Rate Limiting

The API allows **100 requests per 15 minutes** per token. If you hit the limit:
- `429 Too Many Requests` is returned
- Check the `Retry-After` header for when to try again
- Batch your requests instead of polling frequently
- Use webhooks for event-driven workflows instead of polling
