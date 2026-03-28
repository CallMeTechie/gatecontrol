# Stage 1: Caddy with L4 + ratelimit + mirror plugins
FROM caddy:2-builder AS caddy-builder
COPY caddy-plugins/mirror /tmp/caddy-mirror
RUN cd /tmp/caddy-mirror && go mod tidy && cd / && \
    xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/JasonLovesDoggo/caddy-defender \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/greenpau/caddy-trace \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror

# Stage 2: Node dependencies
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --ignore-scripts && \
    npm rebuild argon2 better-sqlite3

# Stage 3: Runtime
FROM node:20-alpine

RUN apk add --no-cache \
    wireguard-tools \
    iptables ip6tables \
    supervisor curl procps openssl

COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN addgroup -S gatecontrol && adduser -S -G gatecontrol gatecontrol && \
    mkdir -p /data/caddy /data/wireguard /data/backups /etc/wireguard /app/config && \
    chmod 700 /data/wireguard /etc/wireguard && \
    chmod +x /app/scripts/wg-wrapper.sh && \
    chown -R gatecontrol:gatecontrol /app /data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
