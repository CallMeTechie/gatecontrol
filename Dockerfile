# Stage 1: Caddy with L4 + ratelimit + mirror plugins
#
# OpenTelemetry pin: Caddy v2.11.2 (latest tagged release, March 2026)
# transitively pulls go.opentelemetry.io/otel v1.40.0 — vulnerable to
# CVE-2026-29181 (multi-value baggage header → remote DoS amplification,
# fixed upstream in v1.41.0). Caddy master has already bumped its otel
# stack to v1.43.0 (commit fb32433, 2026-05-07) but no tagged release
# yet. We --replace the entire otel module set with v1.43.0 / matching
# satellite versions so the built binary contains the fix without
# waiting on a Caddy point release. Drop the --replace flags once
# caddy:2-builder ships a release that pulls otel >= v1.41.0.
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
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror \
    --replace go.opentelemetry.io/otel=go.opentelemetry.io/otel@v1.43.0 \
    --replace go.opentelemetry.io/otel/sdk=go.opentelemetry.io/otel/sdk@v1.43.0

# Stage 2: Node dependencies
FROM node:20-alpine AS builder
WORKDIR /app
ARG NODE_AUTH_TOKEN
COPY package*.json .npmrc ./
RUN npm ci --production --ignore-scripts && \
    npm rebuild argon2 better-sqlite3 && \
    rm -f .npmrc

# Stage 3: Runtime
FROM node:20-alpine

RUN apk upgrade --no-cache && \
    apk add --no-cache \
    wireguard-tools \
    iptables ip6tables \
    supervisor curl procps openssl \
    dnsmasq && \
    npm install -g npm@11

COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN addgroup -S gatecontrol && adduser -S -G gatecontrol gatecontrol && \
    mkdir -p /data/caddy /data/wireguard /data/backups /etc/wireguard /app/config && \
    chmod 700 /data/wireguard /etc/wireguard && \
    chmod +x /app/scripts/wg-wrapper.sh /app/scripts/caddy-start.sh && \
    chown -R gatecontrol:gatecontrol /app /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
