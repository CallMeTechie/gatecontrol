# Pi-hole v6 API Fixtures

Verbatim raw API responses captured from a real Pi-hole v6. **Verbatim, kein Handediting** — these
files are the exact bytes returned by the Pi-hole v6 REST API. Do not hand-write or hand-edit them.

## Versions (identical for both `populated/` and `empty/`)

From `version.json` (`version.core.local.version`):

| Component | Version |
|---|---|
| Core | v6.4.2 |
| Web  | v6.5 |
| FTL  | v6.6.2 |
| Docker image | `pihole/pihole:2026.05.0` |

## Sources

- **`populated/`** — captured from the live 918+ Pi-hole instance (`10.8.0.2:8081`), reached from
  inside the local `gatecontrol` container.
- **`empty/`** — captured from a fresh throwaway `pihole/pihole:2026.05.0` container with zero queries
  (same v6 version as the live instance).

## Endpoints captured

| File | API path |
|---|---|
| `padd.json` | `GET /api/padd` |
| `dns_blocking.json` | `GET /api/dns/blocking` |
| `top_domains.json` | `GET /api/stats/top_domains?blocked=true` |
| `top_clients.json` | `GET /api/stats/top_clients` |
| `query_types.json` | `GET /api/stats/query_types` |
| `history.json` | `GET /api/history` |
| `version.json` | `GET /api/info/version` |

## Capture commands

### populated (live 918+ instance via the gatecontrol container)

```bash
docker exec gatecontrol sh -c '
B=http://10.8.0.2:8081/api; OUT=/tmp/phfix; mkdir -p $OUT
SID=$(curl -s -X POST $B/auth -H "Content-Type: application/json" -d "{\"password\":\"<password>\"}" | grep -oE "\"sid\":\"[^\"]+\"" | sed "s/\"sid\":\"//;s/\"//")
for p in "padd:/padd" "dns_blocking:/dns/blocking" "top_domains:/stats/top_domains?blocked=true" "top_clients:/stats/top_clients" "query_types:/stats/query_types" "history:/history" "version:/info/version"; do
  name=${p%%:*}; path=${p#*:}; curl -s "$B$path" -H "X-FTL-SID: $SID" > $OUT/$name.json
done
curl -s -X DELETE "$B/auth" -H "X-FTL-SID: $SID" -o /dev/null
'
mkdir -p tests/fixtures/pihole/populated
docker cp gatecontrol:/tmp/phfix/. tests/fixtures/pihole/populated/
```

On `429 api_seats_exceeded` (FTL `max_sessions=16`): restart the Pi-hole and retry. Always free
diagnostic sessions with `DELETE /api/auth`.

### empty (fresh throwaway container)

```bash
docker run -d --name ph-fix-empty -p 5399:53/udp -p 5399:53/tcp -p 8099:80 \
  -e FTLCONF_webserver_api_password=fix123 -e FTLCONF_dns_listeningMode=ALL \
  pihole/pihole:2026.05.0
# wait until healthy, then:
docker exec ph-fix-empty sh -c '
B=http://localhost/api
SID=$(curl -s -X POST $B/auth -H "Content-Type: application/json" -d "{\"password\":\"fix123\"}" | grep -oE "\"sid\":\"[^\"]+\"" | sed "s/\"sid\":\"//;s/\"//")
mkdir -p /tmp/e
for p in "padd:/padd" "dns_blocking:/dns/blocking" "top_domains:/stats/top_domains?blocked=true" "top_clients:/stats/top_clients" "query_types:/stats/query_types" "history:/history" "version:/info/version"; do
  name=${p%%:*}; path=${p#*:}; curl -s "$B$path" -H "X-FTL-SID: $SID" > /tmp/e/$name.json
done
curl -s -X DELETE "$B/auth" -H "X-FTL-SID: $SID" -o /dev/null
'
mkdir -p tests/fixtures/pihole/empty
docker cp ph-fix-empty:/tmp/e/. tests/fixtures/pihole/empty/
docker rm -f ph-fix-empty
```
