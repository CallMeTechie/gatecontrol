# syntax=docker/dockerfile:1
# Stage 1: Caddy with L4 + ratelimit + mirror + WAF + DNS provider plugins
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
#
# DNS providers (dns.providers.*) for the ACME DNS-01 challenge of the
# wildcard certificate of the VPN zone (Einstellungen › VPN & Netzwerk ›
# Zertifikat für die Namen): Hetzner (Cloud-DNS-API), IONOS, netcup, INWX,
# All-Inkl, OVHcloud, deSEC, Cloudflare, RFC 2136 and acme-dns, each pinned to
# a release tag. They only act when GateControl puts a DNS challenge into the
# TLS automation; without a provider configured they are inert. The mirror
# plugin adds `caddy gc-dnstest`, which writes, checks and deletes a TXT
# record with the same modules (button "Testen", no ACME request).
# Not included: route53 (pulls the AWS SDK, +6 MB) and digitalocean (no
# release tag).
#
# Up to three attempts: a transient error of the module proxy or the checksum
# database (sum.golang.org "stream error … INTERNAL_ERROR") failed the 1.167.0
# release after its version bump. The module cache stays between attempts, so
# a retry only fetches what is still missing; checksums are verified as usual.
FROM caddy:2-builder AS caddy-builder
COPY caddy-plugins/mirror /tmp/caddy-mirror
RUN for attempt in 1 2 3; do \
      if (cd /tmp/caddy-mirror && go mod tidy) && \
         xcaddy build \
         --output /usr/bin/caddy \
         --with pkg.jsn.cam/caddy-defender \
         --with github.com/mholt/caddy-l4 \
         --with github.com/mholt/caddy-ratelimit \
         --with github.com/ueffel/caddy-brotli \
         --with github.com/greenpau/caddy-trace \
         --with github.com/corazawaf/coraza-caddy/v2@v2.6.1 \
         --with github.com/corazawaf/coraza/v3@v3.8.1 \
         --with github.com/caddy-dns/hetzner/v2@v2.0.1 \
         --with github.com/caddy-dns/ionos@v1.3.0 \
         --with github.com/caddy-dns/netcup@v1.0.0 \
         --with github.com/caddy-dns/inwx@v0.4.1 \
         --with github.com/caddy-dns/all-inkl@v0.2.5 \
         --with github.com/caddy-dns/ovh@v1.1.0 \
         --with github.com/caddy-dns/desec@v1.1.0 \
         --with github.com/caddy-dns/cloudflare@v0.2.4 \
         --with github.com/caddy-dns/rfc2136@v1.0.0 \
         --with github.com/caddy-dns/acmedns@v0.7.0 \
         --with github.com/custom/caddy-mirror=/tmp/caddy-mirror; then \
        exit 0; \
      fi; \
      echo "caddy build attempt $attempt failed, retrying" >&2; \
      sleep $((attempt * 15)); \
    done; \
    exit 1
# Go tests of the mirror plugin (IP block, mirror, gc-dnstest with a fake DNS
# provider and a local DNS server on 127.0.0.1 — no network, no credentials).
# The module cache of the build above already holds every dependency.
RUN cd /tmp/caddy-mirror && go vet ./... && go test -count=1 ./...

# Stage 2: Node dependencies
#
# Node 24 LTS (Node 20 is EOL since 2026-04). better-sqlite3 (>= 13) and
# argon2 both use N-API prebuilds (musl included) and are ABI-independent.
# better-sqlite3 ships them inside the package (prebuilds/linuxmusl-x64.node)
# and picks one at require time: it has no install step anymore and is NOT
# rebuilt here — `npm rebuild better-sqlite3` would force node-gyp (its
# binding.gyp), which needs Python and a compiler the alpine image lacks.
# argon2's install step (node-gyp-build) only selects its musl prebuild.
# sharp (plugin media previews, src/services/plugins/mediaPreviews.js) has no
# install step either: npm puts its prebuilt libvips for this platform
# (@img/sharp-linuxmusl-x64 / -arm64, optional dependencies) in place; the
# glibc builds npm adds as well (the lockfile records no libc) are removed.
# The last line loads all three bindings — sharp makes a tiny JPEG — so a
# missing or broken prebuild fails the build here instead of shipping a
# broken image. It also loads the pure-JavaScript mail libraries of gc.mail
# (imapflow, mailparser, sanitize-html, postcss, saxes; no install step).
#
# The GitHub Packages token for @callmetechie/gatecontrol-config-hash (.npmrc
# reads ${NODE_AUTH_TOKEN}) comes in as a BuildKit secret, never as ARG/ENV:
# it is only set for this one RUN and ends up in no layer, no image history
# and no build metadata. Build with
#   docker build --secret id=npm_token,env=NODE_AUTH_TOKEN .
# (`env=` on a secret mount needs the dockerfile frontend >= 1.10, hence the
# syntax line at the top.)
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json .npmrc ./
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN,required=true \
    npm ci --omit=dev --ignore-scripts && \
    npm rebuild argon2 && \
    rm -f .npmrc && \
    rm -rf node_modules/@img/sharp-linux-* node_modules/@img/sharp-libvips-linux-* && \
    node -e "new (require('better-sqlite3'))(':memory:').close(); require('argon2'); ['imapflow', 'mailparser', 'sanitize-html', 'postcss', 'saxes'].forEach((m) => require(m)); require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer().then((b) => { if (b[0] !== 0xff) process.exit(1); }, (e) => { console.error(e); process.exit(1); })"

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
    chmod +x /app/scripts/wg-wrapper.sh /app/scripts/dnsfilter-wrapper.sh /app/scripts/caddy-start.sh && \
    chown -R gatecontrol:gatecontrol /app /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
