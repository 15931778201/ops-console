/**
 * 配置模块
 * 集中读取并校验全部环境变量；生产环境缺失关键配置直接拒启（fail-fast）。
 * 禁止业务代码直接读取 process.env，一律经此模块。
 * .env 由本模块统一加载（dotenv）：dev/tsx 直接运行与 prisma CLI 行为一致；
 * 生产环境无 .env 文件时 dotenv 自动跳过，环境变量由部署平台注入。
 */

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // 数据层
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  REDIS_URL: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 字符'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // 运营后台 JWT（与用户 token 隔离：独立 secret、独立 payload）
  // 缺省由 JWT_SECRET 派生（域分离），生产环境必须显式配置独立值
  ADMIN_JWT_SECRET: z.string().optional(),
  ADMIN_ACCESS_EXPIRES_IN: z.string().default('15m'),
  ADMIN_REFRESH_EXPIRES_IN: z.string().default('30d'),
  /** MFA 中间令牌时效（两步登录的密码→TOTP 间隙） */
  ADMIN_MFA_TOKEN_EXPIRES_IN: z.string().default('5m'),
  /** TOTP 发行者（显示在 authenticator App 中） */
  ADMIN_TOTP_ISSUER: z.string().default('合羽PDF运营后台'),
  /** 管理员密码最小长度（策略：≥12 位且含大小写与数字） */
  ADMIN_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),

  // CORS（精确白名单，逗号分隔；本地运营后台 1430 与桌面端需显式包含）
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:1430,http://127.0.0.1:1430,http://[::1]:1430,tauri://localhost'),

  // 支付：mock | wechat | alipay（首发仅开放已验收渠道）
  PAYMENT_PROVIDER: z.enum(['mock', 'wechat', 'alipay']).default('mock'),
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_MCH_ID: z.string().optional(),
  WECHAT_API_KEY: z.string().optional(),
  WECHAT_NOTIFY_URL: z.string().optional(),
  WECHAT_CERT_SERIAL_NO: z.string().optional(),
  WECHAT_PRIVATE_KEY_PATH: z.string().optional(),
  WECHAT_PLATFORM_CERT_PATH: z.string().optional(),
  ALIPAY_APP_ID: z.string().optional(),
  ALIPAY_PRIVATE_KEY: z.string().optional(),
  ALIPAY_PUBLIC_KEY: z.string().optional(),
  ALIPAY_NOTIFY_URL: z.string().optional(),

  // 验证码渠道：console | sms | email（首发仅启用一种）
  VERIFICATION_CHANNEL: z.enum(['console', 'sms', 'email']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMS_API_URL: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SIGN_NAME: z.string().optional(),
  SMS_TEMPLATE_ID: z.string().optional(),

  // 邀请奖励（首发不做自动发放，仅作归因/人工活动码参数）
  INVITER_REWARD_CREDITS: z.coerce.number().int().nonnegative().default(500),
  INVITEE_REWARD_CREDITS: z.coerce.number().int().nonnegative().default(200),

  // 免费档积分（种子数据使用）
  FREE_MONTHLY_CREDITS: z.coerce.number().int().nonnegative().default(100),

  // 管理员（运营后台，逗号分隔 user id）
  ADMIN_USER_IDS: z.string().default(''),

  // 监控告警（T6.5）
  /** 未配置任何通道时告警只落库+日志（不外发），不影响服务启动 */
  ALERT_WEBHOOK_URL: z.string().optional(),
  ALERT_WEBHOOK_TOKEN: z.string().optional(),
  /** 告警评估周期（毫秒） */
  ALERT_EVAL_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  /** 同一规则重复告警的静默窗口（毫秒），防抖动刷屏 */
  ALERT_SILENCE_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  /** 连续多少轮命中才真正外发（1 = 不防抖；建议 2，滤掉瞬时毛刺） */
  ALERT_CONSECUTIVE_THRESHOLD: z.coerce.number().int().min(1).max(5).default(2),
  /** 外发失败重试次数（指数退避）；失败落库不丢 */
  ALERT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** 告警规则可覆盖的阈值（逗号分隔的 key=value，留空用内置默认） */
  ALERT_THRESHOLD_OVERRIDES: z.string().default(''),

  // 计费扫描：PENDING 交易超过该分钟数自动回滚
  BILLING_TXN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // 配置错误不属于运行时错误，直接退出，避免带病启动
    // eslint-disable-next-line no-console
    console.error(`[config] 环境变量校验失败:\n${issues}`);
    process.exit(1);
  }

  const cfg = parsed.data;

  if (cfg.NODE_ENV === 'production') {
    const prodIssues: string[] = [];
    if (!cfg.REDIS_URL) prodIssues.push('  - REDIS_URL: 生产环境必须配置（限流/幂等共享存储）');
    if (cfg.JWT_SECRET.includes('change') || cfg.JWT_SECRET.length < 32) {
      prodIssues.push('  - JWT_SECRET: 不允许使用示例值');
    }
    if (!cfg.ADMIN_JWT_SECRET) {
      prodIssues.push('  - ADMIN_JWT_SECRET: 运营后台必须配置独立于用户体系的密钥');
    }
    if (cfg.PAYMENT_PROVIDER !== 'mock' && cfg.PAYMENT_PROVIDER === 'wechat') {
      for (const key of ['WECHAT_APP_ID', 'WECHAT_MCH_ID', 'WECHAT_API_KEY', 'WECHAT_NOTIFY_URL'] as const) {
        if (!cfg[key]) prodIssues.push(`  - ${key}: 微信支付生产配置缺失`);
      }
    }
    if (prodIssues.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[config] 生产环境配置不完整:\n${prodIssues.join('\n')}`);
      process.exit(1);
    }
  }

  return cfg;
}

export const config = loadConfig();

export const isProduction = () => config.NODE_ENV === 'production';

/** CORS 白名单（精确匹配） */
export const allowedOrigins = (): string[] =>
  config.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** 管理员 ID 集合 */
export const adminUserIds = (): Set<string> =>
  new Set(config.ADMIN_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));

/**
 * 运营后台 JWT 密钥
 * 未配置（缺项或空串）时由 JWT_SECRET 域分离派生（开发/测试可用）；
 * 生产环境 config 校验强制要求 ADMIN_JWT_SECRET 独立配置。
 */
export function adminJwtSecret(): string {
  const configured = config.ADMIN_JWT_SECRET?.trim();
  return configured && configured.length > 0 ? configured : `${config.JWT_SECRET}:admin-console`;
}
