# RDP Gateway True-Health Probe

Gateway-mode RDP routes now report the **real** reachability of the host behind the gateway,
instead of a false "online" produced by the server's own loopback L4 listener.

Implementation plan: `docs/superpowers/plans/2026-06-16-rdp-gateway-true-health.md`.

## Symptom

Gateway-mode RDP routes showed `online: true` permanently, even when the actual Windows/RDP host
behind the gateway was powered off. Both affected production routes — `win.marcbackes.net`
(`192.168.2.144`) and `coding.domaincaster.com` (`192.168.2.114`), each linked to the live
gateway peer 79 — stayed green regardless of the host state.

## Root cause

For a gateway-mode route, `rdpMonitor._probe` checked reachability with
`checkTcp('127.0.0.1', gateway_listen_port)`. That target is the server's **own** Caddy
layer-4 listener, which accepts the loopback TCP connection in ~1 ms — independent of whether the
gateway forwards it anywhere or whether the real host is up.

The only existing gate, `isGatewayLive`, catches a **dead gateway** (stale heartbeat → the L4
listener has no live peer to forward to). It does **not** catch a **dead host behind a live
gateway**: the gateway heartbeats fine, the loopback listener accepts, and the route reads
"online" even though nothing answers on the LAN host.

## Solution

The server asks the gateway — which physically sits in the target LAN — to TCP-probe the **real**
host:port:

1. **Companion** (`gatecontrol-gateway`): `POST /api/probe` is extended to accept an explicit
   `{host, port}`. It TCP-probes that target and echoes a `probed_target` field in the response.
   The probe is **LAN-scoped**: a target IPv4 literal outside the gateway's own physical-LAN
   subnets is rejected (`probe_result: false`, `rejected: 'out_of_lan_scope'`, `probed_target`
   still set). Hostnames (non-IP literals) pass through and are resolved by the gateway's own
   resolver. Without a target, the endpoint keeps its legacy self-check behaviour and omits
   `probed_target`.

2. **Server** (`gatecontrol`): `gateways.probeGatewayTarget(peerId, host, port)` POSTs
   `{host, port}` to the gateway's `/api/probe` (X-Gateway-Token auth, **5 s timeout**) and returns
   the parsed response or `null` on any failure.

3. **Server** (`rdpMonitor._probe`): for direct single-peer gateway routes
   (`access_mode === 'gateway' && gateway_peer_id`):
   - gate on `isGatewayLive` **first** (dead gateway → fast offline, no probe call);
   - if the route has no `host`/`port` → offline (a misconfigured gateway route, **not** a loopback
     fallback — otherwise the false-positive would re-enter through the back door);
   - call `probeGatewayTarget`; if the response carries `probed_target`, trust
     `probe_result`; otherwise fall back to the legacy loopback probe.

   Internal routes and **pool-backed** gateway routes (`gateway_peer_id` null) keep the legacy
   loopback path unchanged — caddyConfig already removes the L4 listener on pool outage, so their
   loopback probe is already accurate.

`checkAll` was also changed from serial to **parallel** (`Promise.allSettled`) with a module-level
**re-entry guard** (`_checkAllInFlight`, reset in `finally`): a slow gateway probe (up to the
per-probe timeout) must not stall the other routes, and overlapping monitor cycles are skipped
rather than stacked.

## Fallback & deploy-order safety

The server trusts the gateway's verdict **only** when the response contains `probed_target`. Only
the new companion sets that field. If it is absent (older companion) or the call fails entirely, the
server falls back to today's loopback probe. This makes the deploy order **Server ↔ Companion
irrelevant** and a mixed-version fleet safe:

| Server | Companion | Behaviour |
|---|---|---|
| new | new | True host health via `/api/probe` (the fix). |
| new | old | `probed_target` absent → loopback fallback (today's behaviour). |
| old | new | Server never sends `{host,port}` → companion self-check (today's behaviour). |
| old | old | Today's behaviour. |

## Affected repos / versions

- **`gatecontrol-gateway`** (companion): `/api/probe` targeted+LAN-scoped probe, branch
  `fix/rdp-gateway-true-health` (based on v1.13.2). CI assigns the released version on merge.
- **`gatecontrol`** (server): `probeGatewayTarget` + `rdpMonitor` true-health, branch
  `fix/rdp-gateway-true-health` (based on v1.80.2). CI assigns the released version on merge.
