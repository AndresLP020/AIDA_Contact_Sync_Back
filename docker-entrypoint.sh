#!/bin/sh
# Migraciones controladas al arrancar y seed de datos FICTICIOS sólo fuera de producción y si se solicita.
set -e
npx prisma migrate deploy
if [ -n "$BOOTSTRAP_OWNER_EMAIL" ]; then
  npx tsx prisma/bootstrap-owner.ts
fi
if [ "$SEED_DEMO_DATA" = "true" ] && [ "$NODE_ENV" != "production" ]; then
  npx tsx prisma/seed.ts
fi
exec node dist/main.js
