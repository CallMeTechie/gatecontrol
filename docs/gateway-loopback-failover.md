# Gateway Loopback Failover

## Overview

When a gateway route targets a service running on the gateway host itself (using `127.0.0.1` as `target_lan_host`), that target is relative to the gateway's local network namespace. During failover—when the home gateway becomes unavailable and a sibling gateway begins serving the route—the loopback address becomes invalid: sibling gateways cannot reach the home gateway's localhost.

This feature ensures such routes remain accessible during failover by automatically rewriting the loopback target to the home gateway's actual LAN IP.

## The Loopback Problem

When a route is created with:
- Home gateway: `gateway-1` (LAN IP `10.8.0.1`)
- Service target: `127.0.0.1:8080` (a service running on gateway-1's host)

If gateway-1 becomes unavailable and gateway-2 (a sibling) takes over the route, gateway-2 cannot reach `127.0.0.1` because that refers to gateway-2's localhost, not the service on gateway-1.

## Automatic Failover Resolution

### Pin and Pivot

When a route with loopback target is created on a home gateway, the system sets `original_peer_id` to track the home gateway's identity. This pin remains until explicitly restored or relocated.

### Dynamic Target Rewrite

While the route is served by a non-home sibling gateway:
- The system rewrites the target from `127.0.0.1` to the home gateway's `gateway_meta.lan_ip` (reported via heartbeat).
- **HTTP routes**: The rewrite is communicated via the `X-Gateway-Target` header in caddyConfig (see `src/services/caddyConfig.js`).
- **L4/TCP routes** (SSH, RDP): The rewrite is applied in `getGatewayConfig` (see `src/services/gateways.js`).

### Fail-Closed Design

If the home gateway's LAN IP is unknown (no heartbeat received yet, or gateway offline):
- **HTTP routes**: Return HTTP 502 (maintenance page).
- **L4 routes**: The listener is omitted (no service exposure), preventing misrouting.

### Automatic Failback

When the home gateway recovers and the route is restored to it, the system nulls `original_peer_id`. The target reverts to `127.0.0.1` automatically.

## Permanent Relocation (Route Migration Modal)

Routes with loopback targets can be permanently moved to a different gateway via a new modal mode:
- **Mode**: "Permanently move to gateway"
- **Input**: A LAN target field that accepts live host search results from LAN discovery or free-form IP entry.
- **Bulk-apply**: Move multiple routes at once.
- **Result**: The route is re-pinned to the new gateway with the specified LAN target. `original_peer_id` is updated and `target_lan_host` is set to the new target.

## Delete Guard

A gateway that is the failover home (`original_peer_id`) of pivoted loopback routes cannot be deleted. The API returns HTTP 409 (Conflict) until all such routes are restored or relocated.

## Cross-LAN Caveat

The automatic rewrite only works if the serving sibling gateway can reach the home gateway's LAN IP on the same LAN segment. If the home gateway's host is completely offline (not just the gateway container), the service is unavailable regardless of target rewriting. This is a fundamental network limitation, not a design flaw.

## Implementation Files

- `src/services/caddyConfig.js` — HTTP route rewrite via `X-Gateway-Target` header.
- `src/services/gateways.js` — L4/TCP route rewrite in `getGatewayConfig`; `original_peer_id` logic.
- Database schema — `routes.original_peer_id` field tracks the home gateway pin.
