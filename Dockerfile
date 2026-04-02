FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# HTTPS support: custom server wrapper and ssl utility
COPY --from=builder /app/server-https.js ./server-https.js

RUN mkdir -p /var/lib/9router

# Fix permissions at runtime (handles mounted volumes)
RUN printf '#!/bin/sh\nset -e\nDATA_DIR="${DATA_DIR:-/var/lib/9router}"\nmkdir -p "$DATA_DIR"\nchown -R node:node "$DATA_DIR" 2>/dev/null || true\nexec su-exec node "$@"\n' > /entrypoint.sh && chmod +x /entrypoint.sh
RUN apk add --no-cache su-exec

EXPOSE 20128
EXPOSE 20129

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server-https.js"]
