FROM node:20-alpine

RUN apk add --no-cache \
    wireguard-tools \
    iptables \
    ip6tables \
    caddy \
    supervisor \
    curl \
    procps \
    openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production --ignore-scripts && \
    npm rebuild argon2 better-sqlite3

COPY . .

RUN mkdir -p /data/caddy /data/wireguard /etc/wireguard && \
    chmod 700 /data/wireguard /etc/wireguard

VOLUME ["/data"]

EXPOSE 80 443 51820/udp

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
