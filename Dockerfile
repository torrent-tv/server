# syntax=docker/dockerfile:1.7

# Production dependencies are installed with the official image's npm.
FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The runtime is Alpine with node copied from that image — what the official
# image itself is, without npm, yarn and corepack, which nothing here runs.
FROM alpine:3
RUN apk add --no-cache libstdc++ \
 && addgroup -S app && adduser -S -G app app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
# .dockerignore names what is copied: the server, its routes and services,
# public/, the entrypoint and the licence.
COPY --chown=app:app . .

# Create the volume mount point owned by app so the entrypoint can write to it.
RUN mkdir -p /app/public-volume /app/cache && chown app:app /app/public-volume /app/cache

USER app

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]

EXPOSE 8080

# Orchestrator-friendly health endpoint check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/healthz`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "./server.js"]
