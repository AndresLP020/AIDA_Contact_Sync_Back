-- Configuración automática de subcuentas (aprovisionamiento). Migración ADITIVA: no elimina ni reescribe datos.
-- Sólo relaja dos restricciones (Company.name y OAuthCredential.encryptedRefreshToken pasan a admitir NULL).


-- CreateEnum
CREATE TYPE "ConfigurationStatus" AS ENUM ('pending', 'running', 'ready', 'requires_action', 'cancelled');

-- CreateEnum
CREATE TYPE "ProvisioningStepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'requires_action', 'ambiguous', 'cancelled');

-- CreateEnum
CREATE TYPE "ResourceOrigin" AS ENUM ('created', 'adopted');

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "name" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GhlInstallation" ADD COLUMN     "agencyGrantId" UUID,
ADD COLUMN     "configurationStatus" "ConfigurationStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "installSource" TEXT NOT NULL DEFAULT 'app_oauth';

-- AlterTable
ALTER TABLE "OAuthCredential" ALTER COLUMN "encryptedRefreshToken" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GhlWebhookEvent" ADD COLUMN     "ghlCompanyId" TEXT,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'processed',
ADD COLUMN     "webhookId" TEXT;

-- CreateTable
CREATE TABLE "GhlAgencyGrant" (
    "id" UUID NOT NULL,
    "ghlCompanyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "grantedScopes" TEXT[],
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlAgencyGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningExecution" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "installationGeneration" INTEGER NOT NULL,
    "companyId" UUID NOT NULL,
    "ghlLocationId" TEXT NOT NULL,
    "manifestVersion" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "ConfigurationStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "leaseToken" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "missingScopes" TEXT[],
    "correlationId" TEXT NOT NULL,
    "requestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisioningExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningStep" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "status" "ProvisioningStepStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT,
    "errorCode" TEXT,
    "remoteId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisioningStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionedResource" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ghlLocationId" TEXT NOT NULL,
    "resourceKey" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "remoteId" TEXT,
    "remoteKey" TEXT,
    "remoteName" TEXT,
    "manifestVersion" INTEGER NOT NULL,
    "origin" "ResourceOrigin",
    "managementPolicy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "ambiguousCount" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisionedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GhlAgencyGrant_ghlCompanyId_key" ON "GhlAgencyGrant"("ghlCompanyId");

-- CreateIndex
CREATE INDEX "ProvisioningExecution_status_nextAttemptAt_idx" ON "ProvisioningExecution"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ProvisioningExecution_companyId_createdAt_idx" ON "ProvisioningExecution"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ProvisioningExecution_installationId_createdAt_idx" ON "ProvisioningExecution"("installationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningStep_executionId_resourceKey_key" ON "ProvisioningStep"("executionId", "resourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionedResource_ghlLocationId_resourceKey_key" ON "ProvisionedResource"("ghlLocationId", "resourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisionedResource_companyId_resourceKey_key" ON "ProvisionedResource"("companyId", "resourceKey");

-- CreateIndex
CREATE INDEX "GhlInstallation_agencyGrantId_idx" ON "GhlInstallation"("agencyGrantId");

-- CreateIndex
CREATE UNIQUE INDEX "GhlWebhookEvent_webhookId_key" ON "GhlWebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "GhlWebhookEvent_locationId_type_processingStatus_idx" ON "GhlWebhookEvent"("locationId", "type", "processingStatus");

-- AddForeignKey
ALTER TABLE "GhlInstallation" ADD CONSTRAINT "GhlInstallation_agencyGrantId_fkey" FOREIGN KEY ("agencyGrantId") REFERENCES "GhlAgencyGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningExecution" ADD CONSTRAINT "ProvisioningExecution_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GhlInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningExecution" ADD CONSTRAINT "ProvisioningExecution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningStep" ADD CONSTRAINT "ProvisioningStep_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ProvisioningExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionedResource" ADD CONSTRAINT "ProvisionedResource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Una sola ejecución de configuración activa por instalación (evita ejecuciones concurrentes).
CREATE UNIQUE INDEX "ProvisioningExecution_one_active_per_installation" ON "ProvisioningExecution"("installationId") WHERE "status" IN ('pending', 'running');

-- Integridad de contadores.
ALTER TABLE "ProvisioningExecution" ADD CONSTRAINT "ProvisioningExecution_attempts_non_negative" CHECK ("attempts" >= 0 AND "maxAttempts" > 0);
ALTER TABLE "GhlInstallation" ADD CONSTRAINT "GhlInstallation_generation_positive" CHECK ("generation" >= 1);
