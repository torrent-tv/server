# syntax=docker/dockerfile:1.7

# Both stages take node from Alpine's own package; npm is installed only in
# the stage that installs the production dependencies.
FROM alpine:3 AS dependencies
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM alpine:3
RUN apk add --no-cache nodejs \
 && addgroup -S app && adduser -S -G app app

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
