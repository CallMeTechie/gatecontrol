# DNS protection for VPN devices — filter service and `gc.vpnDns`

GateControl filters the DNS of the VPN devices on the server itself (ads,
malicious sites, profiles for groups, people and devices). The technique lives
in the server; the plugin "DNS-Schutz" brings the pages, the licence and the
app views through the plugin API `gc.vpnDns` (docs/plugins.md "DNS
protection"). **Without a plugin that holds `permissions.vpnDns` and may run,
nothing of this is active** — no process, no chain entry, no timer; a server
with Pi-hole behaves exactly as before.

```
VPN device ──► dnsmasq (10.8.0.1:53)
                 │  internal names (peers, routes, portal, API host): answered here
                 │  everything else, with the device's address (add-subnet=32,128)
                 ▼
               filter service  127.0.0.1#5354  UDP + TCP      (its own process)
                 │  profile of the device → blocked / SafeSearch / forward
                 ▼
               DoH (Quad9, Cloudflare, own) ── falls back to ──► GC_DNSMASQ_UPSTREAMS
```

## Parts

| Part | Where | What |
|---|---|---|
| Engine | `src/services/vpnDnsFilter/dnsfilter-core/` | The DNS filter engine of the gateways — a **mirrored copy** of `gatecontrol-gateway` `src/dnsfilter-core/` at the tag in `src/services/vpnDnsFilter/VENDORED.md`. Never edited here; the CI compares every file (`scripts/check-vendored-dnsfilter.js`) |
| Filter service | `src/services/vpnDnsFilter/service.js` | Listener on `127.0.0.1#<port>`, decision per device, answer cache, list downloads, counters, control socket |
| Wrapper | `scripts/dnsfilter-wrapper.sh`, `supervisord.conf` `[program:dnsfilter]` | Starts the service while `<dir>/enabled` exists, restarts it when it exits; sleeps otherwise |
| Server side | `src/services/vpnDns.js` | Settings, who gets which profile, suspensions, the service's config file, the DNS chain, counters, events |
| Chain | `src/services/dnsChain.js` (provider `vpnfilter`) | Makes the filter dnsmasq's only upstream once it answers; back to the default upstreams when it stops |
| Plugin API | `vpnDnsCall` in `src/services/plugins/hostApi.js`, `makeVpnDns` in `child/bootstrap.js` | `gc.vpnDns.*`, the hook `vpnDns` |

`<dir>` is `GC_VPNDNS_DIR` (default `<GC_DATA_PATH>/vpn-dns`, i.e. `/data/vpn-dns`):
`config.json` (written atomically by the server), `enabled`, `control.sock`,
`service.pid`, `dns-lists/` (the last good version of every list). The port is
`GC_VPNDNS_PORT` (default 5354).

## Why a process of its own

The server's event loop must never wait for a list to be parsed, and a server
restart must not take the filter down. The server only writes one small file,
asks the service for its status every few seconds and writes counters to
SQLite. Measured (tests/vpn_dns_filter_service.test.js, lists of 273 000
entries): the service answers within 25 ms while it loads the lists, the
asking process's event loop is never held for more than a few milliseconds.

The service is not the server's child: supervisord starts the wrapper, the
wrapper starts the service. After a server restart the chain is claimed again
at once (`vpnDns.start()` runs before Pi-hole's start), without putting dnsmasq
on another upstream in between.

## What the service guarantees

1. **UDP and TCP on 127.0.0.1 only.** The asking device comes as EDNS Client
   Subnet `/32` from dnsmasq and is only believed from a loopback sender. It is
   never passed on to the upstream.
2. **The chain's probe** (`. NS` from loopback without ECS) is answered by the
   service itself — it asks "does the filter live", not "does the internet".
3. **Its own answer cache** (with `add-subnet` dnsmasq caches nothing).
4. **TC rule.** dnsmasq 2.91 merges identical UDP queries that are under way
   at the same time and hands one answer to all askers. Whenever the answer
   depends on who asks — the asker is allowed, but another profile with
   devices (or an unfiltered device) would get something else, including
   SafeSearch — the UDP answer is only "truncated" (TC=1); every device
   repeats over TCP, which dnsmasq forwards one by one. A blocked answer goes
   out over UDP as it is. Names that are treated alike for everybody (the
   normal case) never see TC.
5. **Internal names** (everything in `peers.hosts`, the API host) are never
   blocked — dnsmasq answers their A records itself, but AAAA/HTTPS/MX reach
   the filter.
6. **No ECS, a loopback address, a gateway, an unknown address** → never
   filtered.
7. **Fail-open.** An error inside (decision, a profile the engine cannot
   read, a damaged config file) ends in "forwarded unfiltered", never in
   silence. When the process dies or hangs, the chain falls back: probe every
   2 s, timeout 1 s, second try after 0.5 s — at most 4.5 s, measured 1.8 s
   for a killed process (tests/vpn_dns_filter_dnsmasq.test.js).
8. **Limits.** Lists: 64 MB per file, 1.5 million entries per list, 3 million
   in total (8 bytes each); answer cache 10 000 entries / 8 MB; 512 UDP
   queries and 128 TCP connections at a time; query-log queue 5 000 entries
   until the server fetches it; heap limit 192 MB (the wrapper).

Settings change without a restart: the server writes `config.json` and tells
the service (`reload`); the service also checks the file every 2 s.

## Suspending, counters, query log

A suspension ("Unterbrechen": all devices, one device, all devices of a
person; until a time or until switched on again) makes the devices
**unfiltered** — the service treats them like devices without a profile and
lets a timed suspension end by itself. Counters per day and the top blocked
domains are always kept (`vpn_dns_stats_day`). Per device and per query only
while the query log is on (`vpn_dns_peer_day`, `vpn_dns_log`; off by default,
retention 7 days by default, deleted when switched off).

## Outage

`dnsChain` reports `fallback` / back to `vpnfilter` → activity entries
`vpn_dns_fallback` (warning) / `vpn_dns_restored`, the hook `vpnDns` of the
plugin, the event `vpn_dns` for the admin UI. The dashboard shows a red notice
("DNS-Schutz ausgefallen – Geräte laufen ungefiltert") or an amber one while
the protection is suspended for all devices (`GET
/api/v1/system/dns/protection`, `POST …/resume`). The Pi-hole page shows
"Verdrängt durch DNS-Schutz" while the filter owns the chain (`displacedBy`).

## Pi-hole

Exactly one provider owns the chain; the filter outranks Pi-hole. Switching
the protection on takes the chain over in one dnsmasq restart once the filter
answers (Pi-hole stays active until then); `gc.vpnDns.releasePihole()` then
switches Pi-hole's "manage the DNS chain" off, so that switching the
protection off later does not silently bring Pi-hole back.

The Pi-hole integration is **deprecated** (not removed): the Pi-hole page
carries a notice with the button "Zum DNS-Schutz umziehen" →
`/settings/plugins/manage/<plugin>?tab=settings` (the plugin's settings page,
where its dialog moves over) when a plugin with `permissions.vpnDns` is
installed, "DNS-Schutz öffnen" once the protection is switched on, else a link
to the plugin catalogue (`piholeDeprecation()` in `src/routes/index.js`).
`status().pihole.targets` names where the devices reach Pi-hole and the
gateway behind it, for the first step of that dialog.

## Raising the engine

1. Change and release the engine in `gatecontrol-gateway`.
2. Set the new tag in `src/services/vpnDnsFilter/VENDORED.md`.
3. `GC_GATEWAY_REPO=<gateway checkout> node scripts/check-vendored-dnsfilter.js --update`
4. Run `tests/vpn_dns*.test.js`.

## Tests

- `tests/vpn_dns_filter_service.test.js` — the service alone: config, TC rule,
  fail-open, limits; as its own process with 273 000 entries (memory, loading).
- `tests/vpn_dns_filter_dnsmasq.test.js` — behind a **real dnsmasq** with the
  chain's conf writer and watch: two devices with different profiles, queries
  at the same time, internal names, suspension, fallback and recovery. Needs
  dnsmasq and the local addresses 198.18.53.2 / .3 (`sudo ip addr add
  198.18.53.2/32 dev lo`); skipped without them unless
  `GC_TEST_DNSMASQ=required` (CI).
- `tests/vpn_dns.test.js` — the server side and `gc.vpnDns` in a real plugin
  process.
