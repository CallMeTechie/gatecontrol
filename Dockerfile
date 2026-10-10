# Stage 1: Caddy with L4 + ratelimit + mirror + WAF plugins
#
# WAF (docs/feature-waf.md): coraza-caddy registers http.handlers.waf and pulls
# the OWASP CRS in as the embedded Go module corazawaf/coraza-coreruleset/v4
# (no rule downloads at runtime). Pinned; CRS updates arrive with new
# coraza-caddy / coraza-coreruleset versions. v2.6.1 needs Caddy v2.11.4 and
# Go 1.26 — both given by caddy:2-builder.
#
# No OpenTelemetry --replace pin anymore: Caddy v2.11.4 requires otel
# v1.43.0 itself (CVE-2026-29181 fixed since v1.41.0), so MVS already
# guarantees the fix. The old hard pin to v1.43.0 blocked newer otel that
# grpc >= v1.83 needs (semconv/v1.41.0 missing → build failure).
# Security minimums for transitive Go deps live in caddy-plugins/mirror/go.mod.
# Exception: coraza/v3 is not in the mirror plugin's module graph (`go mod
# tidy` there would drop it), so its minimum is pinned via --with below.
# coraza-caddy v2.6.1 (latest) still requires v3.7.0 — CVE-2026-41510
# (ArgumentLimit silently drops args → ARGS rule bypass) is fixed in v3.8.1.
FROM caddy:2-builder AS caddy-builder
COPY caddy-plugins/mirror /tmp/caddy-mirror
RUN cd /tmp/caddy-mirror && go mod tidy && cd / && \
    xcaddy build \
    --output /usr/bin/caddy \
    --with pkg.jsn.cam/caddy-defender \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/greenpau/caddy-trace \
    --with github.com/corazawaf/coraza-caddy/v2@v2.6.1 \
    --with github.com/corazawaf/coraza/v3@v3.8.1 \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror

# Stage 2: Node dependencies
#
# Node 24 LTS (Node 20 is EOL since 2026-04). better-sqlite3 (>= 13) and
# argon2 both use N-API prebuilds (musl included) and are ABI-independent.
# better-sqlite3 ships them inside the package (prebuilds/linuxmusl-x64.node)
# and picks one at require time: it has no install step anymore and is NOT
# rebuilt here — `npm rebuild better-sqlite3` would force node-gyp (its
# binding.gyp), which needs Python and a compiler the alpine image lacks.
# argon2's install step (node-gyp-build) only selects its musl prebuild. The
# last line loads both bindings, so a missing or broken prebuild fails the
# build here instead of shipping a broken image.
FROM node:24-alpine AS builder
WORKDIR /app
ARG NODE_AUTH_TOKEN
COPY package*.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild argon2 && \
    rm -f .npmrc && \
    node -e "new (require('better-sqlite3'))(':memory:').close(); require('argon2')"

# Stage 3: Runtime — same Node major as the builder (native ABI must match).
#
# npm/npx are removed from the runtime image: supervisord starts the app
# with plain `node`, and npm's own bundled dependencies (undici,
# brace-expansion, picomatch, ...) only ever tripped the image scan.
# Dependencies are installed in the builder stage above.
#
# Runs as root on purpose: src/services/wireguard.js calls wg-quick up/down,
# wg syncconf/set (netlink, CAP_NET_ADMIN, writes /etc/wireguard), and
# dns.js / caddyAdminClient.js signal the root-owned dnsmasq/caddy via
# pkill. The container is confined by cap_add: [NET_ADMIN] in compose.
FROM node:24-alpine

# openssh-client-default (sftp/ssh/ssh-keygen) and samba-client (smbclient):
# transports for off-site backups (docs/feature-release-b.md §7) — SFTP with
# GateControl's own ed25519 key, SMB shares on a NAS. S3/WebDAV need nothing.
RUN apk upgrade --no-cache && \
    apk add --no-cache \
    wireguard-tools \
    iptables ip6tables \
    supervisor curl procps openssl \
    dnsmasq \
    openssh-client-default samba-client && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN addgroup -S gatecontrol && adduser -S -G gatecontrol gatecontrol && \
    mkdir -p /data/caddy /data/wireguard /data/backups /etc/wireguard /app/config && \
    chmod 700 /data/wireguard /data/backups /etc/wireguard && \
    chmod +x /app/scripts/wg-wrapper.sh /app/scripts/caddy-start.sh && \
    chown -R gatecontrol:gatecontrol /app /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
