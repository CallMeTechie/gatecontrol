# Stage 1: Caddy with L4 plugin
FROM caddy:2-builder AS caddy-builder
RUN xcaddy build \
    --with github.com/mholt/caddy-l4

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

RUN mkdir -p /data/caddy /data/wireguard /etc/wireguard && \
    chmod 700 /data/wireguard /etc/wireguard

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/login || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
