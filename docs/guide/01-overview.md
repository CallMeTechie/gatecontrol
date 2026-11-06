# 1. Overview

[← Contents](README.md) · [Next: Setting up the server →](02-server-setup.md)

## What is the GateControl server?

The server is the heart of GateControl. It runs as a Docker container on a
machine with a public address on the internet, for example a rented virtual
server. The server brings:

- a **web interface** for managing everything (in the browser under your domain),
- a **VPN** (WireGuard) for your devices and gateways,
- a **reverse proxy** (Caddy) that makes your services reachable under your
  own domains with HTTPS. It fetches the certificates by itself.

## What is a gateway?

A gateway is a small program in your home network. It runs on a Raspberry Pi,
a Synology NAS, under Proxmox or on another Linux machine with Docker.

The gateway builds an encrypted tunnel to the server by itself. That is why you
need **no port forwarding in your router**. Through this tunnel the server
reaches the devices in your home network – for example a NAS, a camera or Phoscon.

The gateway has to be in the **same network** as the devices it should reach.

A gateway can also do jobs in the home network: find devices, measure the
internet quality, filter ads (DNS filter), keep files close (home cache) and
run parts of plugins (edge plugins). [Chapter 4](04-edge-and-smart-home.md)
and [chapter 5](05-features.md) explain this.

## How does it all fit together?

A picture in words:

```
  Phone on the road                      Internet
        │
        │  https://nas.example.com
        ▼
  ┌───────────────────────────┐
  │ GateControl server        │   public address, e.g. gate.example.com
  │ web interface · VPN ·     │   ports 80, 443 (TCP) and 51820 (UDP)
  │ reverse proxy             │
  └─────────────▲─────────────┘
                │  encrypted WireGuard tunnel
                │  (built by the gateway – no port forwarding at home)
  ┌─────────────┴─────────────┐
  │ Gateway (Pi, NAS, Linux)  │   in your home network
  └──┬──────────┬──────────┬──┘
     ▼          ▼          ▼
    NAS      camera    smart home devices
```

1. On the road you open `https://nas.example.com`.
2. The server takes the request and sends it through the tunnel to the gateway.
3. The gateway passes it on to the NAS in your home network.
4. The answer takes the same way back.

## What do you need?

### For the server

| What | What for |
|---|---|
| A Linux server with root access (e.g. Debian 12/13 or Ubuntu 22.04+) | GateControl runs on it. At least 1 CPU and 1 GB RAM, better 2 CPUs and 2 GB RAM, 20 GB disk. |
| A **public IPv4 address** | So that gateways and devices reach the server. |
| A **domain** with a DNS record (A record) pointing to this address | For the web interface and the HTTPS certificate, e.g. `gate.example.com`. |
| Open ports in your provider's firewall | 80/TCP and 443/TCP (web and certificates), 51820/UDP (VPN). 443/UDP is optional (HTTP/3). |
| Docker with Docker Compose | The installation script sets Docker up itself if it is missing. |

### For every gateway

| What | What for |
|---|---|
| A device in the home network: Raspberry Pi (3 B+, 4, 5, Zero 2 W), Synology NAS with DSM 7.2+, Proxmox VE 8+ or a Linux machine with Docker | The gateway runs on it. |
| Outgoing internet access | The gateway connects to the server by itself. Nothing incoming is needed. |
| It is in the same network as your devices | Otherwise it cannot reach them. |

## Important terms

| Term | Meaning |
|---|---|
| Peer | A device in the VPN (laptop, phone, gateway). |
| Route | A domain the server forwards to a target (e.g. `nas.example.com` → NAS behind a gateway). |
| `.env` | The settings file of the server. Contains passwords and keys. |
| `gateway.env` | The access file of a gateway. Contains its key for the tunnel. |
| Compose file | `docker-compose.yml`: describes which containers run. |
| Edge | An isolated extra container on the gateway for plugin parts in the home network. |

**Check:** You have a server with a public IP, a domain and a device for the
gateway in your home network. Then continue with [chapter 2](02-server-setup.md).
