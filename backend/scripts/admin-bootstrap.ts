/**
 * 运营后台 bootstrap：创建首个 SUPER_ADMIN
 * 用法：
 *   npm run admin:bootstrap                                   # 交互式
 *   npm run admin:bootstrap -- --username=admin --name=llx --password=***
 *   npm run admin:bootstrap -- --username=admin --name=llx --password=*** --bind-totp
 *     （--bind-totp 立即生成并绑定 TOTP，打印 secret / otpauth URL / 10 个恢复码，仅显示一次）
 * 约束：
 * - 仅当系统没有任何管理员时允许执行（防止误建重复超管；后续账号走后台账号管理）
 * - 强制满足密码策略（≥12 位、含大小写与数字、不含用户名）
 * - 默认 mustBindTotp=true：首次登录必须绑定 TOTP 才能使用
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline';
import { config } from '../src/lib/config';
import { validateAdminPassword } from '../src/lib/admin-password';
import { generateTotpSecret, buildOtpauthUrl, generateRecoveryCodes, hashRecoveryCode } from '../src/lib/totp';
import { encryptField } from '../src/lib/field-cipher';

const prisma = new PrismaClient();

interface Args {
  username?: string;
  name?: string;
  password?: string;
  bindTotp: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bindTotp: false };
  for (const arg of argv) {
    if (arg === '--bind-totp') {
      args.bindTotp = true;
      continue;
    }
    const m = arg.match(/^--([a-zA-Z-]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!;
    if (key === 'username') args.username = value;
    else if (key === 'name') args.name = value;
    else if (key === 'password') args.password = value;
  }
  return args;
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nonInteractive = Boolean(args.username && args.password);

  const existing = await prisma.adminUser.count();
  if (existing > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[bootstrap] 已存在 ${existing} 名管理员，拒绝重复初始化。\n` +
        '新增账号请登录运营后台「管理员账号」页创建（admin:manage）。'
    );
    process.exit(1);
  }

  let username = args.username ?? '';
  let name = args.name ?? '';
  let password = args.password ?? '';

  if (!nonInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      username = (await ask(rl, '用户名（3-32 位字母/数字/-/_）: ')).trim();
      name = (await ask(rl, '姓名: ')).trim();
      password = await ask(rl, `密码（≥${config.ADMIN_PASSWORD_MIN_LENGTH} 位，含大小写与数字）: `);
      const confirm = await ask(rl, '再次输入密码: ');
      if (password !== confirm) throw new Error('两次输入的密码不一致');
    } finally {
      rl.close();
    }
  }

  username = username.trim();
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    throw new Error('用户名格式不合法（3-32 位字母、数字、- 或 _）');
  }
  if (!name.trim()) throw new Error('姓名不能为空');

  const check = validateAdminPassword(password, username);
  if (!check.ok) {
    throw new Error(`密码策略不满足：${check.problems.join('；')}`);
  }

  const admin = await prisma.adminUser.create({
    data: {
      username,
      name: name.trim(),
      role: 'SUPER_ADMIN',
      passwordHash: await bcrypt.hash(password, 12),
      mustBindTotp: !args.bindTotp,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`\n[bootstrap] 已创建首个 SUPER_ADMIN：${admin.username}（${admin.name}）`);

  if (args.bindTotp) {
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        totpSecret: encryptField(secret),
        totpEnabled: true,
        mustBindTotp: false,
        recoveryCodes: recoveryCodes.map(hashRecoveryCode),
      },
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '──────────── TOTP 凭据（仅显示这一次，请立即保存） ────────────',
        `密钥(手动输入)：${secret}`,
        `扫码 URL：${buildOtpauthUrl(secret, admin.username, config.ADMIN_TOTP_ISSUER)}`,
        '',
        '恢复码（每个仅可使用一次）：',
        ...recoveryCodes.map((code, i) => `  ${String(i + 1).padStart(2, ' ')}. ${code}`),
        '─────────────────────────────────────────────────────────',
        '',
      ].join('\n')
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('[bootstrap] 首次登录将强制绑定 TOTP（authenticator App 扫码 + 下载恢复码）。');
  }

  // eslint-disable-next-line no-console
  console.log('[bootstrap] 请登录运营后台创建其他角色的管理员账号。');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[bootstrap] 失败: ${(err as Error).message}`);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
