/**
 * 种子数据：初始化三档套餐 + 工具计费规则
 * 幂等：重复执行结果一致（upsert）。
 * 商业参数以 docs/商务规则表.md 为准；此处默认值为预生产测试值。
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLANS = [
  {
    id: 'free',
    name: '免费版',
    monthlyCredits: 100,
    priceCents: 0,
    periodMonths: 1,
    maxFiles: 5,
    costTierAccess: ['free', 'light'],
    features: { description: '适合个人体验', support: 'community' },
  },
  {
    id: 'pro',
    name: 'Pro 版',
    monthlyCredits: 2000,
    priceCents: 2900,
    periodMonths: 1,
    maxFiles: 50,
    costTierAccess: ['free', 'light', 'heavy'],
    features: { description: '适合个人高频用户', support: 'priority' },
  },
  {
    id: 'vip',
    name: 'VIP 版',
    monthlyCredits: 50000,
    priceCents: 9900,
    periodMonths: 1,
    maxFiles: 200,
    costTierAccess: ['free', 'light', 'heavy', 'premium'],
    features: { description: '适合团队/重度用户', support: 'dedicated' },
  },
] as const;

async function seedToolBillingRules(): Promise<void> {
  const raw = readFileSync(path.join(__dirname, 'tool-billing-rules.json'), 'utf8');
  const rules = JSON.parse(raw) as Array<{
    toolSlug: string;
    creditCost: number;
    minPlan: string;
    maxFilesPerTask: number;
    ruleVersion: string;
    active: boolean;
  }>;

  for (const rule of rules) {
    await prisma.toolBillingRule.upsert({
      where: { toolSlug: rule.toolSlug },
      create: {
        toolSlug: rule.toolSlug,
        creditCost: rule.creditCost,
        minPlan: rule.minPlan,
        maxFilesPerTask: rule.maxFilesPerTask,
        ruleVersion: rule.ruleVersion,
        active: rule.active,
      },
      update: {
        creditCost: rule.creditCost,
        minPlan: rule.minPlan,
        maxFilesPerTask: rule.maxFilesPerTask,
        ruleVersion: rule.ruleVersion,
        active: rule.active,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] tool billing rules upserted: ${rules.length}`);
}

async function main(): Promise<void> {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      create: { ...plan },
      update: {
        name: plan.name,
        monthlyCredits: plan.monthlyCredits,
        priceCents: plan.priceCents,
        periodMonths: plan.periodMonths,
        maxFiles: plan.maxFiles,
        costTierAccess: [...plan.costTierAccess],
        features: plan.features,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[seed] plan upserted: ${plan.id}`);
  }
  await seedToolBillingRules();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed', err);
    await prisma.$disconnect();
    process.exit(1);
  });
