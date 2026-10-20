/**
 * E2E 测试公共 harness（真实 PostgreSQL）
 *
 * 与单元测试（vitest + mock）的分工：
 * - 单元测试：纯函数、边界、错误码映射，快且无副作用
 * - E2E（tests-e2e/）：真实库 + 真实 bcrypt/JWT/TOTP，验证跨服务不变量
 *
 * 隔离策略：所有测试数据使用固定前缀 `e2e_`，run 结束后级联清理。
 * 严禁对非测试数据执行写操作——cleanup 只按前缀/固定 id 命中。
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import prisma from '../src/lib/prisma';
import { adminUserService } from '../src/services/admin-user.service';
import { adminAuthService } from '../src/services/admin-auth.service';
import {
  totp as genTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../src/lib/totp';
import { encryptField } from '../src/lib/field-cipher';
import { resetRateLimit } from '../src/lib/rate-limit';
import { invalidateFlagCache } from '../src/services/feature-flag.service';
import type { AdminRole, AdminUser } from '@prisma/client';

/** 所有 E2E 管理员用户名前缀（清理依据） */
export const E2E_PREFIX = 'e2e_';

/** 断言计数器（供各套件汇报） */
export class Check {
  private passed = 0;
  private failures: Array<{ label: string; error: string }> = [];

  ok(label: string, condition: unknown, detail?: unknown): void {
    if (condition) {
      this.passed += 1;
      console.log(`  ✓ ${label}`);
    } else {
      this.failures.push({ label, error: detail ? JSON.stringify(detail) : 'condition=false' });
      console.log(`  ✗ ${label}${detail ? ` → ${JSON.stringify(detail)}` : ''}`);
    }
  }

  eq(label: string, actual: unknown, expected: unknown): void {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    this.ok(label, pass, pass ? undefined : { actual, expected });
  }

  /** 断言被调用 f 抛出指定错误码 */
  async throwsCode(label: string, code: string, f: () => Promise<unknown>): Promise<void> {
    try {
      await f();
      this.ok(label, false, 'expected throw but resolved');
    } catch (err) {
      const actual = (err as { code?: string }).code;
      this.ok(label, actual === code, { actual, expected: code });
    }
  }

  summary(title: string): { passed: number; failed: number } {
    const total = this.passed + this.failures.length;
    console.log(`\n[${title}] ${this.passed}/${total} 通过`);
    if (this.failures.length > 0) {
      console.log('失败项：');
      for (const f of this.failures) console.log(`  - ${f.label}: ${f.error}`);
    }
    return { passed: this.passed, failed: this.failures.length };
  }

  get failureList(): Array<{ label: string; error: string }> {
    return this.failures;
  }
}

/** E2E 统一口令（满足 12 位 + 大小写 + 数字，且不含用户名） */
export const E2E_PASSWORD = 'E2ePassw0rdTest';

export function e2eName(tag: string): string {
  return `${E2E_PREFIX}${tag}`;
}

/** 创建测试管理员（默认未绑定 TOTP，由用例自行绑定或直连 DB 置位） */
export async function createTestAdmin(
  tag: string,
  role: AdminRole = 'SUPER_ADMIN'
): Promise<AdminUser> {
  const username = e2eName(tag);
  const view = await adminUserService.createAdmin(
    { username, name: `E2E-${tag}`, password: E2E_PASSWORD, role },
    'system-e2e'
  );
  const admin = await prisma.adminUser.findUnique({ where: { id: view.id } });
  if (!admin) throw new Error('创建测试管理员后查不到');
  return admin;
}

/**
 * 直接在 DB 层启用 TOTP（返回明文 secret 供生成验证码）。
 * 用于跳过绑定流程、专注测试登录第二步。
 */
export async function enableTotpDirectly(adminId: string, secret: string): Promise<string> {
  await prisma.adminUser.update({
    where: { id: adminId },
    data: {
      totpSecret: encryptField(secret),
      totpEnabled: true,
      mustBindTotp: false,
      recoveryCodes: generateRecoveryCodes().map(hashRecoveryCode),
    },
  });
  return secret;
}

/** 生成当前时刻的 6 位 TOTP 码 */
export function currentTotp(secretBase32: string): string {
  return genTotp(secretBase32);
}

export interface LoggedInAdmin {
  admin: AdminUser;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  totpSecret: string;
}

/**
 * 完成完整登录：建账号 → 启用 TOTP → loginStep1 → loginStep2。
 * 返回令牌对供后续请求使用。
 */
export async function loginAsAdmin(
  tag: string,
  role: AdminRole = 'SUPER_ADMIN',
  secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
): Promise<LoggedInAdmin> {
  const admin = await createTestAdmin(tag, role);
  await enableTotpDirectly(admin.id, secret);
  const username = e2eName(tag);

  const step1 = await adminAuthService.loginStep1(username, E2E_PASSWORD);
  const step2 = await adminAuthService.loginStep2(
    step1.mfaToken,
    currentTotp(secret)
  );

  return {
    admin,
    accessToken: step2.tokens.accessToken,
    refreshToken: step2.tokens.refreshToken,
    sessionId: String(decodeJwtPayload(step2.tokens.accessToken).sid ?? ''),
    totpSecret: secret,
  };
}

/** 解码 admin access token 的 payload（测试用，不验签） */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('不是合法的 JWT');
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
}

/** 清理所有 E2E 测试数据（按前缀 + 关联表级联；仅命中 e2e_* 与 E2E* 前缀） */
export async function cleanupE2eData(): Promise<void> {
  const admins = await prisma.adminUser.findMany({
    where: { username: { startsWith: E2E_PREFIX } },
    select: { id: true },
  });
  const adminIds = admins.map((a) => a.id);
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'e2e' } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const orderNos = await prisma.order.findMany({
    where: { userId: { in: userIds } },
    select: { orderNo: true },
  }).then((rows) => rows.map((r) => r.orderNo));

  // 依赖顺序：先叶子后根（外键约束）
  await prisma.reconciliationRecord.deleteMany({
    where: { OR: [{ orderNo: { in: orderNos } }, { orderNo: { startsWith: 'E2E' } }] },
  });
  await prisma.paymentEvent.deleteMany({
    where: { OR: [{ orderNo: { in: orderNos } }, { orderNo: { startsWith: 'E2E' } }] },
  });
  await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.creditAccount.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  // 邀请数据：relations 引用 invite_codes 与 users，必须先删；codes 又引用 owner，必须再删
  const e2eInviteCodes = await prisma.inviteCode.findMany({
    where: { OR: [{ ownerUserId: { in: userIds } }, { code: { startsWith: 'E2E' } }] },
    select: { code: true },
  }).then((rows) => rows.map((r) => r.code));
  await prisma.inviteRelation.deleteMany({
    where: {
      OR: [
        { inviterUserId: { in: userIds } },
        { inviteeUserId: { in: userIds } },
        { inviteCode: { in: e2eInviteCodes } },
      ],
    },
  });
  await prisma.inviteCode.deleteMany({
    where: { OR: [{ ownerUserId: { in: userIds } }, { code: { in: e2eInviteCodes } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorId: { in: [...adminIds, 'system-e2e'] } },
        { actorId: { startsWith: 'system-e2e' } },
        { targetId: { in: orderNos } },
        { targetId: { startsWith: 'E2E' } },
        { targetId: { startsWith: 'e2e' } },
      ],
    },
  });
  await prisma.adminSession.deleteMany({ where: { adminUserId: { in: adminIds } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });

  // 仪表盘快照是跨用例共享的聚合态，残留会让"快照不存在"类断言失真
  await prisma.dashboardSnapshot.deleteMany();

  // 告警事件与规则状态：E2E 会触发真实告警，残留会污染统计口径
  await prisma.alertEvent.deleteMany({ where: { source: 'monitor' } });
  await prisma.alertRuleState.deleteMany({});

  // 功能开关：E2E 可能拨过停收，残留会让后续所有下单用例全灭。
  // 开关无 seed 依赖（代码内置默认值），清空即恢复默认。
  await prisma.featureFlag.deleteMany();
  invalidateFlagCache();

  await resetRateLimit();
  await prisma.$disconnect();
}

/** 生成稳定但唯一的测试邮箱 */
let emailSeq = 0;
export function testEmail(tag: string): string {
  emailSeq += 1;
  return `e2e_${tag}_${emailSeq}_${createHash('sha1').update(tag).digest('hex').slice(0, 6)}@example.test`;
}