#!/bin/sh
# Migraciones controladas al arrancar y seed de datos FICTICIOS sólo fuera de producción y si se solicita.
set -e

# Si la URL no fija esquema, usar "aida". La base compartida ya tiene tablas en public (otro proyecto).
if ! printf '%s' "$DATABASE_URL" | grep -q 'schema='; then
  case "$DATABASE_URL" in
    *\?*) DATABASE_URL="${DATABASE_URL}&schema=aida" ;;
    *) DATABASE_URL="${DATABASE_URL}?schema=aida" ;;
  esac
  export DATABASE_URL
  admin_url=$DATABASE_URL
  admin_url=${admin_url%\?schema=aida}
  admin_url=${admin_url%\&schema=aida}
  npx prisma db execute --url "$admin_url" --stdin <<'SQL'
CREATE SCHEMA IF NOT EXISTS aida;
SQL
fi

if ! migrate_log=$(npx prisma migrate deploy 2>&1); then
  printf '%s\n' "$migrate_log"
  printf '%s\n' "$migrate_log" | grep -q 'P3009' || exit 1
  echo 'La migración inicial quedó marcada como fallida. Se revierte esa marca y se reintenta una vez.'
  npx prisma migrate resolve --rolled-back 20261012163050_init
  npx prisma migrate deploy
else
  printf '%s\n' "$migrate_log"
fi
if [ -n "$BOOTSTRAP_OWNER_EMAIL" ]; then
  npx tsx prisma/bootstrap-owner.ts
fi
# La pantalla de login muestra demo@aida.test / AidaDemo#2026. El seed es idempotente.
SEED_DEMO_DATA=true npx tsx prisma/seed.ts
exec node dist/main.js
