# syntax=docker/dockerfile:1.7
FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Create an unprivileged runtime user.
RUN addgroup -S app && adduser -S -G app app

# Install only production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application sources.
COPY --chown=app:app . .

# Create the volume mount point owned by app so the entrypoint can write to it.
RUN mkdir -p /app/public-volume && chown app:app /app/public-volume

USER app

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]

EXPOSE 8080

# Orchestrator-friendly health endpoint check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/healthz`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "./server.js"]
