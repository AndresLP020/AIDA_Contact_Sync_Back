import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvisioningRunner } from './provisioning.runner';

/**
 * Procesador de configuración respaldado por PostgreSQL (sin Redis ni servicios adicionales).
 *  - Reclamo atómico con FOR UPDATE SKIP LOCKED: varias réplicas pueden convivir sin tomar el mismo trabajo.
 *  - Lease con vencimiento (lockedUntil) + leaseToken como token de cercado.
 *  - Recuperación tras reinicio: una ejecución "running" cuyo lease venció se vuelve a reclamar.
 */
@Injectable()
export class ProvisioningWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ProvisioningWorker');
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly runner: ProvisioningRunner,
  ) {}

  onApplicationBootstrap() {
    if (this.config.ghl.mode !== 'real' || !this.config.provisioning.workerEnabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.provisioning.pollIntervalMs);
    this.timer.unref();
    this.logger.log({ msg: 'provisioning_worker_started', workerId: this.workerId, pollIntervalMs: this.config.provisioning.pollIntervalMs });
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.drain(10);
    } catch (e) {
      this.logger.error({ msg: 'provisioning_tick_failed', error: e instanceof Error ? e.name : 'unknown' });
    } finally {
      this.busy = false;
    }
  }

  /** Reclama atómicamente la siguiente ejecución vencida (pendiente, o en curso con lease vencido). */
  async claimNext(): Promise<{ id: string; leaseToken: number } | null> {
    const now = new Date();
    const until = new Date(now.getTime() + this.config.provisioning.leaseMs);
    const rows = await this.prisma.$queryRaw<{ id: string; leaseToken: number }[]>`
      UPDATE "ProvisioningExecution" e
         SET "status" = 'running', "lockedBy" = ${this.workerId}, "lockedUntil" = ${until},
             "leaseToken" = e."leaseToken" + 1, "attempts" = e."attempts" + 1,
             "startedAt" = COALESCE(e."startedAt", ${now}), "updatedAt" = ${now}
       WHERE e."id" = (
         SELECT "id" FROM "ProvisioningExecution"
          WHERE ("status" = 'pending' AND "nextAttemptAt" <= ${now})
             OR ("status" = 'running' AND "lockedUntil" < ${now})
          ORDER BY "nextAttemptAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING e."id"::text AS "id", e."leaseToken" AS "leaseToken"`;
    return rows[0] ?? null;
  }

  /** Procesa una ejecución. Devuelve su id o null si no había trabajo. */
  async processNext(): Promise<string | null> {
    const claimed = await this.claimNext();
    if (!claimed) return null;
    await this.runner.run(claimed.id, claimed.leaseToken);
    return claimed.id;
  }

  /** Procesa ejecuciones vencidas hasta vaciar la cola (o alcanzar el máximo). */
  async drain(max = 50) {
    let n = 0;
    while (n < max && (await this.processNext())) n++;
    return n;
  }
}
