/**
 * 运营后台 TOTP 恢复：清除指定管理员的动态验证码绑定，强制下次登录重新绑定。
 *
 * 用法：
 *   npm run admin:reset-totp -- --username=admin --confirm
 *
 * 该操作会：
 * - 删除加密保存的 TOTP 密钥；
 * - 清空旧恢复码；
 * - 将账号标记为必须重新绑定；
 * - 吊销该管理员的全部后台会话；
 * - 写入一条 SYSTEM 审计日志。
 *
 * 仅在管理员丢失身份验证器/恢复码，或初始化状态需要纠正时使用。
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

interface Args {
  username?: string;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false };
  for (const arg of argv) {
    if (arg === '--confirm') {
      args.confirm = true;
      continue;
    }
    const match = arg.match(/^--username=(.+)$/);
    if (match) args.username = match[1];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username?.trim();

  if (!username || !args.confirm) {
    throw new Error(
      '这是高风险恢复操作。请明确指定账号并追加确认参数：\n' +
        'npm run admin:reset-totp -- --username=admin --confirm'
    );
  }

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        name: true,
        totpEnabled: true,
        mustBindTotp: true,
        recoveryCodes: true,
      },
    });

    if (!admin) throw new Error(`管理员不存在：${username}`);

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          totpSecret: null,
          totpEnabled: false,
          recoveryCodes: [],
          mustBindTotp: true,
        },
      });

      const revoked = await tx.adminSession.updateMany({
        where: { adminUserId: admin.id, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'admin.totp_reset',
          targetType: 'AdminUser',
          targetId: admin.id,
          reason: 'manual_recovery_cli',
          metadata: {
            username: admin.username,
            previousTotpEnabled: admin.totpEnabled,
            previousMustBindTotp: admin.mustBindTotp,
            previousRecoveryCodeCount: admin.recoveryCodes.length,
            revokedSessionCount: revoked.count,
          },
        },
      });

      return { updated, revokedSessionCount: revoked.count };
    });

    // eslint-disable-next-line no-console
    console.log(
      `[admin:reset-totp] 已重置 ${result.updated.username}（${result.updated.name}）。` +
        `已吊销 ${result.revokedSessionCount} 个会话；下次登录将显示身份验证器绑定信息。`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[admin:reset-totp] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
