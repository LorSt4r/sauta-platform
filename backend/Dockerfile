# ---- Fase 1: Build ----
FROM node:22-alpine AS builder

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copia i package files del monorepo
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

# Installa dipendenze (incluse dev per build e prisma generate)
RUN npm ci --workspace=backend --workspace=shared --workspace=frontend --include-workspace-root

# Copia il codice sorgente
COPY backend/ ./backend/
COPY shared/ ./shared/
COPY frontend/ ./frontend/

# Build shared, genera il Prisma Client, build backend e frontend
RUN npm run build -w shared
RUN cd backend && npx prisma generate
RUN npm run build -w backend
RUN npm run build -w frontend

# ---- Fase 2: Runtime ----
FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copia solo i file necessari per l'avvio
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

# Installa solo le dipendenze di produzione (senza tsx a runtime)
RUN npm ci --workspace=backend --workspace=shared --include-workspace-root --omit=dev

# Copia il JavaScript compilato e gli artefatti necessari
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/prisma ./backend/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/frontend/dist ./frontend/dist

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Avvia il backend con node eseguendo il JavaScript compilato
CMD ["node", "backend/dist/index.js"]
