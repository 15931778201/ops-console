-- CreateEnum
CREATE TYPE "VerificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('REGISTER', 'FORGOT_PASSWORD');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LedgerEntryStatus" AS ENUM ('PENDING', 'SETTLED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "BillingTxnStatus" AS ENUM ('PENDING', 'SETTLED', 'ROLLED_BACK', 'EXPIRED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDING';

-- DropForeignKey
ALTER TABLE "credit_accounts" DROP CONSTRAINT "credit_accounts_userId_fkey";

-- DropForeignKey
ALTER TABLE "credit_transactions" DROP CONSTRAINT "credit_transactions_userId_fkey";

-- DropForeignKey
ALTER TABLE "payment_events" DROP CONSTRAINT "payment_events_orderNo_fkey";

-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_userId_fkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "credit_transactions" ADD COLUMN     "balanceAfterBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "balanceAfterBonus" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "billingTxnId" TEXT,
ADD COLUMN     "deltaBalance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deltaBonus" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "linkedTxnId" TEXT,
ADD COLUMN     "status" "LedgerEntryStatus" NOT NULL DEFAULT 'SETTLED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "balanceAfter" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "creditsGranted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'CNY',
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "grantTxnId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "priceSnapshot" JSONB,
ADD COLUMN     "refundId" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "eventId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "processError" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "sessions" DROP COLUMN "revoked",
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "replacedByHash" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "verification_codes" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "type" "VerificationType" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolSlug" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 1,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v1',
    "frozenAmount" INTEGER NOT NULL,
    "splitFromBalance" INTEGER NOT NULL DEFAULT 0,
    "splitFromBonus" INTEGER NOT NULL DEFAULT 0,
    "balanceAfterBalance" INTEGER NOT NULL DEFAULT 0,
    "balanceAfterBonus" INTEGER NOT NULL DEFAULT 0,
    "status" "BillingTxnStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,
    "ledgerTxnId" TEXT,

    CONSTRAINT "billing_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_billing_rules" (
    "toolSlug" TEXT NOT NULL,
    "creditCost" INTEGER NOT NULL,
    "minPlan" TEXT NOT NULL DEFAULT 'free',
    "maxFilesPerTask" INTEGER NOT NULL DEFAULT 5,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v1',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_billing_rules_pkey" PRIMARY KEY ("toolSlug")
);

-- CreateIndex
CREATE INDEX "verification_codes_target_type_createdAt_idx" ON "verification_codes"("target", "type", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_transactions_idempotencyKey_key" ON "billing_transactions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "billing_transactions_ledgerTxnId_key" ON "billing_transactions"("ledgerTxnId");

-- CreateIndex
CREATE INDEX "billing_transactions_userId_createdAt_idx" ON "billing_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_transactions_status_expiresAt_idx" ON "billing_transactions"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "credit_transactions_billingTxnId_idx" ON "credit_transactions"("billingTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_eventId_key" ON "payment_events"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_orderNo_fkey" FOREIGN KEY ("orderNo") REFERENCES "orders"("orderNo") ON DELETE CASCADE ON UPDATE CASCADE;

