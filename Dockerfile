# ── Etapa 1: Build ─────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar manifiestos e instalar TODAS las dependencias (incluye typescript)
# --ignore-scripts evita que postinstall ejecute tsc antes de copiar tsconfig.json
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copiar código fuente y compilar TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Etapa 2: Producción ───────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copiar manifiestos e instalar SOLO dependencias de producción
# --ignore-scripts evita que postinstall intente ejecutar tsc (que no existe aquí)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copiar el código ya compilado desde la etapa builder
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
