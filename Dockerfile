# --- Build stage -----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

# --- Runtime stage -----------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app

# libvips runtime deps for sharp (image rasterization)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system kika && adduser --system --ingroup kika kika

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./

RUN mkdir -p /data/receipts && chown -R kika:kika /data/receipts /app

USER kika

ENV NODE_ENV=production \
    PORT=8080 \
    RECEIPT_STORAGE_DIR=/data/receipts

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
