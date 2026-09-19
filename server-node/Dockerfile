# Pinned multi-architecture Node 22 / Alpine image.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

LABEL org.opencontainers.image.title="CA Connection Gateway" \
      org.opencontainers.image.version="0.6.0"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONFIG_PATH=/run/secrets/gateway_config \
    DATABASE_PATH=/var/lib/gateway/gateway.db

RUN addgroup -g 10001 -S gateway \
    && adduser -u 10001 -S gateway -G gateway \
    && mkdir -p /var/lib/gateway/backups \
    && chown -R gateway:gateway /var/lib/gateway

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --from=builder /app/dist ./dist

USER gateway
EXPOSE 8787
VOLUME ["/var/lib/gateway"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
