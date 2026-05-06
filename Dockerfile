FROM node:22-alpine AS builder
WORKDIR /app

RUN apk update && apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk update && apk --no-cache upgrade && apk --no-cache add su-exec

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

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

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\n[ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "/app/data" ] && mkdir -p "$DATA_DIR" && chown -R node:node "$DATA_DIR" 2>/dev/null || true\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128
EXPOSE 20129

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server-https.js"]
