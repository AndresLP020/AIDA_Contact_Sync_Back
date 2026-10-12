# syntax=docker/dockerfile:1
# Contexto de build: raíz del monorepo (ver docker-compose.yml). Usa package-lock.json para builds reproducibles.

FROM node:24-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY packages/contracts/package.json packages/contracts/

FROM base AS build
RUN npm ci --workspace backend --include-workspace-root=false --no-audit --no-fund
COPY backend backend
RUN cd backend && npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
RUN npm ci --workspace backend --include-workspace-root=false --omit=dev --no-audit --no-fund && npm cache clean --force
COPY backend/prisma backend/prisma
COPY backend/src backend/src
COPY backend/tsconfig.json backend/docker-entrypoint.sh backend/
COPY --from=build /app/backend/dist backend/dist
RUN cd backend && npx prisma generate && chmod +x docker-entrypoint.sh
WORKDIR /app/backend
USER node
EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
