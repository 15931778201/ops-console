/*
  Warnings:

  - Added the required column `updatedAt` to the `alert_events` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "alert_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hitStreak" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "metric" TEXT,
ADD COLUMN     "ruleKey" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "threshold" DOUBLE PRECISION,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "value" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "alert_rule_states" (
    "ruleKey" TEXT NOT NULL,
    "firing" BOOLEAN NOT NULL DEFAULT false,
    "hitStreak" INTEGER NOT NULL DEFAULT 0,
    "lastEventId" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "lastResolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rule_states_pkey" PRIMARY KEY ("ruleKey")
);

-- CreateIndex
CREATE INDEX "alert_events_ruleKey_createdAt_idx" ON "alert_events"("ruleKey", "createdAt");

-- CreateIndex
CREATE INDEX "alert_events_status_createdAt_idx" ON "alert_events"("status", "createdAt");
