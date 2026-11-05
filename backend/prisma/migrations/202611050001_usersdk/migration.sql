-- UserSDK：验证码登录类型 + 套餐产品归属

-- 1. VerificationType 增加 LOGIN
ALTER TYPE "VerificationType" ADD VALUE IF NOT EXISTS 'LOGIN';

-- 2. Plan 增加 product（默认 common = 通用目录）
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "product" TEXT NOT NULL DEFAULT 'common';
CREATE INDEX IF NOT EXISTS "plans_product_active_idx" ON "plans"("product", "active");
