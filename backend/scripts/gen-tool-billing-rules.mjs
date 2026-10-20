/**
 * 一次性脚本：从工具注册表生成默认计费规则 JSON（预生产测试值）
 * 规则需经产品在 docs/商务规则表.md 中确认后由运营调整。
 * 运行：node scripts/gen-tool-billing-rules.mjs（在仓库根目录）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, '../src/config/tools.ts'), 'utf8');

const entries = [];
const re = /slug:\s*'([^']+)'[\s\S]*?category:\s*'([^']+)'/g;
let m;
while ((m = re.exec(src)) !== null) entries.push({ slug: m[1], category: m[2] });

const aliasRe = /slug:\s*'([^']+)'[\s\S]*?aliasOf:\s*'([^']+)'/g;
const aliases = new Set();
while ((m = aliasRe.exec(src)) !== null) aliases.add(m[1]);

// 默认分档：分类 → 积分成本/最低套餐/批量上限（预生产测试值）
const TIER = {
  'edit-annotate': { creditCost: 1, minPlan: 'free', maxFiles: 20, tier: 'light' },
  'convert-to-pdf': { creditCost: 2, minPlan: 'free', maxFiles: 20, tier: 'light' },
  'convert-from-pdf': { creditCost: 5, minPlan: 'free', maxFiles: 10, tier: 'heavy' },
  'organize-manage': { creditCost: 1, minPlan: 'free', maxFiles: 50, tier: 'light' },
  'optimize-repair': { creditCost: 5, minPlan: 'free', maxFiles: 10, tier: 'heavy' },
  'secure-pdf': { creditCost: 1, minPlan: 'free', maxFiles: 20, tier: 'light' },
};

// 重工具/高级工具上调（Office/CAD 转换、OCR 等）
const HEAVY_SLUGS = ['pdf-to-word','pdf-to-excel','pdf-to-ppt','word-to-pdf','excel-to-pdf','ppt-to-pdf','pdf-to-cad','cad-to-pdf','dwg-to-pdf','pdf-to-dwg','pdf-to-ofd','ofd-to-pdf','pdf-to-html','pdf-to-txt','pdf-to-markdown','pdf-to-epub'];
const PREMIUM_SLUGS = ['ocr-pdf','pdf-ocr','scan-to-text'];

const rules = [];
for (const e of entries) {
  if (aliases.has(e.slug)) continue;
  const base = TIER[e.category] ?? { creditCost: 1, minPlan: 'free', maxFiles: 10, tier: 'light' };
  let creditCost = base.creditCost;
  let minPlan = base.minPlan;
  let maxFiles = base.maxFiles;
  let tier = base.tier;
  if (HEAVY_SLUGS.some((h) => e.slug.includes(h))) {
    creditCost = Math.max(creditCost, 5);
    tier = 'heavy';
  }
  if (PREMIUM_SLUGS.some((h) => e.slug.includes(h))) {
    creditCost = 10;
    minPlan = 'pro';
    tier = 'premium';
  }
  rules.push({ toolSlug: e.slug, creditCost, minPlan, maxFilesPerTask: maxFiles, ruleVersion: 'v1', active: true, tier });
}

const seen = new Set();
const dedup = rules.filter((r) => !seen.has(r.toolSlug) && seen.add(r.toolSlug));
writeFileSync(
  path.join(root, 'prisma/tool-billing-rules.json'),
  JSON.stringify(dedup, null, 2) + '\n'
);
console.log('tools:', dedup.length, 'aliases skipped:', aliases.size);
