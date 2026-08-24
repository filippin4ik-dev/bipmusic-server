# Сборка внутри Docker (Termius: docker compose up -d --build)
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --no-audit --no-fund \
    && npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc \
    && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/data/tracks /app/data/covers /app/data/tmp

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
