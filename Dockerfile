# --- Build stage -----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY assets ./assets

# --- Runtime stage -----------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app

# libvips runtime deps for sharp (image rasterization), plus fontconfig
# itself — without it, FONTCONFIG_FILE/FONTCONFIG_PATH (set by
# receiptService.js) have nothing to talk to and every <text> element in
# a receipt SVG silently renders as nothing: you get a blank white card
# with only the vector-drawn dashed lines, since those don't need a font
# at all. This bit everyone the first time: it's an easy one to miss
# because the render *succeeds* (no error, no crash) — it just has no
# glyphs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system kika && adduser --system --ingroup kika kika

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
# The bundled Fira Code / DejaVu Sans / Kika wordmark receipts depend on
# — see src/services/receiptService.js's font-loading comment at the top
# of the file. Forgetting this COPY is the #1 way receipts end up blank.
COPY --from=build /app/assets ./assets
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
