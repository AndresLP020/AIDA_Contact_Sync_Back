#!/bin/sh
# Migraciones controladas al arrancar y seed de datos FICTICIOS sólo fuera de producción y si se solicita.
set -e
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
if [ "$SEED_DEMO_DATA" = "true" ] && [ "$NODE_ENV" != "production" ]; then
  npx tsx prisma/seed.ts
fi
exec node dist/main.js
