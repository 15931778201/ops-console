/**
 * 监控告警规则引擎（T6.5）
 *
 * 设计要点：
 *  - **规则即代码**：阈值内置于 `ALERT_RULES`，可用 `ALERT_THRESHOLD_OVERRIDES`
 *    覆盖（逗号分隔 key=value），无需改代码即可调阈值。
 *  - **连续命中才外发**（默认 2 轮）：单轮毛刺不该半夜叫人起来。
 *    hitStreak 记在 `alert_rule_states` 表，跨进程重启不丢。
 *  - **静默窗口**（默认 30 分钟）：同规则持续命中期间不重复外发，
 *    只更新 hitStreak —— 否则一个持续故障会刷爆值班群。
 *  - **恢复即闭环**：不再命中时把未resolved 的事件回填 resolvedAt，
 *    这样"当前还有哪些告警未解决"可以直接查库得到。
 *  - **无通道不外发但不丢**：未配置 webhook 时 status=suppressed，
 *    事件仍落库 —— 运维可事后补看，也便于本地演练。
 *  - **绝不因告警失败影响主流程**：`evaluate()` 内部全部 try/catch，
 *    采集指标失败只记日志，不抛。
 *
 * 严重级别沿用既有 `AlertEvent.severity` 的 P0/P1/P2 约定。
 */

import prisma from '../lib/prisma';
import { config } from '../lib/config';
import { logger } from '../lib/logger';
import { sendAlert } from './alert-channels';
import { adminLedgerService } from './admin-ledger.service';

// ==================== 规则定义 ====================

export type Severity = 'P0' | 'P1' | 'P2';

export interface AlertRule {
  key: string;
  name: string;
  severity: Severity;
  /** 指标名（写入事件，便于图表化） */
  metric: string;
  /** 比较方向 */
  compare: 'gt' | 'lt' | 'gte';
  /** 默认阈值 */
  threshold: number;
  /** 采集窗口（毫秒），用于文案与判定口径 */
  windowMs: number;
  /** 采集当前值 */
  collect: () => Promise<{ value: number; context?: Record<string, unknown> }>;
  /** 人类可读描述 */
  describe: (value: number, threshold: number) => string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function hit(value: number, threshold: number, compare: AlertRule['compare']): boolean {
  switch (compare) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
  }
}

/** 应用阈值覆盖（ALERT_THRESHOLD_OVERRIDES="key=value,key2=value2"） */
function withOverrides<T extends { key: string; threshold: number }>(rules: T[]): T[] {
  const raw = config.ALERT_THRESHOLD_OVERRIDES?.trim();
  if (!raw) return rules;
  const map = new Map<string, number>();
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((x) => x?.trim());
    const n = Number(v);
    if (k && Number.isFinite(n)) map.set(k, n);
  }
  if (map.size === 0) return rules;
  return rules.map((r) => (map.has(r.key) ? { ...r, threshold: map.get(r.key)! } : r));
}

// ==================== 规则集 ====================

export const ALERT_RULES: AlertRule[] = withOverrides([
  // ---------- P0：资金与数据正确性 ----------
  {
    key: 'ledger.mismatch',
    name: '积分账本不平',
    severity: 'P0',
    metric: 'mismatchedAccounts',
    compare: 'gt',
    threshold: 0,
    windowMs: HOUR,
    collect: async () => {
      const scan = await adminLedgerService.scanAnomalies();
      return { value: scan.anomalies, context: { negative: scan.negative, sample: scan.sample ?? [] } };
    },
    describe: (v) => `账本投影与流水不一致的账户 ${v} 个（余额真值被污染，必须人工核对）`,
  },
  {
    key: 'ledger.negativeBalance',
    name: '账户余额为负',
    severity: 'P0',
    metric: 'negativeAccounts',
    compare: 'gt',
    threshold: 0,
    windowMs: HOUR,
    collect: async () => {
      const scan = await adminLedgerService.scanAnomalies();
      return { value: scan.negative, context: { sample: scan.sample ?? [] } };
    },
    describe: (v) => `余额为负的账户 ${v} 个（负值防护理论上不该出现，出现即为事故）`,
  },
  {
    key: 'payment.signatureInvalid',
    name: '支付回调验签失败',
    severity: 'P0',
    metric: 'invalidSignatureEvents',
    compare: 'gt',
    threshold: 0,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.paymentEvent.count({
        where: { signatureValid: false, createdAt: { gte: new Date(Date.now() - HOUR) } },
      });
      return { value: n, context: { window: '1h' } };
    },
    describe: (v) => `近 1 小时支付回调验签失败 ${v} 次（可能有人在伪造支付成功）`,
  },
  {
    key: 'db.unavailable',
    name: '数据库不可用',
    severity: 'P0',
    metric: 'dbOk',
    compare: 'lt',
    threshold: 1,
    windowMs: 5 * MIN,
    collect: async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { value: 1 };
      } catch {
        return { value: 0 };
      }
    },
    describe: () => '数据库探测失败，服务不可用',
  },

  // ---------- P1：资金链路与安全 ----------
  {
    key: 'payment.createFailureRate',
    name: '下单失败率过高',
    severity: 'P1',
    metric: 'orderFailureRate',
    compare: 'gt',
    threshold: 0.3,
    windowMs: HOUR,
    collect: async () => {
      const since = new Date(Date.now() - HOUR);
      // 用 CLOSED + failureReason 近似"下单后未成功"的失败单
      const failed = await prisma.order.count({
        where: { status: 'CLOSED', createdAt: { gte: since } },
      });
      const total = await prisma.order.count({ where: { createdAt: { gte: since } } });
      const rate = total === 0 ? 0 : failed / total;
      return { value: Number(rate.toFixed(4)), context: { failed, total, window: '1h' } };
    },
    describe: (v) => `近1 小时下单关闭率 ${(v * 100).toFixed(1)}%（渠道可能故障）`,
  },
  {
    key: 'order.stalePending',
    name: '待支付超时订单堆积',
    severity: 'P1',
    metric: 'stalePendingOrders',
    compare: 'gt',
    threshold: 20,
    windowMs: 10 * MIN,
    collect: async () => {
      const n = await prisma.order.count({
        where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 30 * MIN) } },
      });
      return { value: n };
    },
    describe: (v) => `超过 30 分钟仍未支付的订单 ${v} 笔（渠道回调可能失败）`,
  },
  {
    key: 'auth.loginFailureSpike',
    name: '登录失败激增',
    severity: 'P1',
    metric: 'loginFailures',
    compare: 'gt',
    threshold: 50,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.auditLog.count({
        where: {
          action: 'user.login_failed',
          createdAt: { gte: new Date(Date.now() - HOUR) },
        },
      });
      return { value: n, context: { window: '1h' } };
    },
    describe: (v) => `近 1 小时登录失败 ${v} 次（撞库或暴力破解嫌疑）`,
  },
  {
    key: 'admin.loginFailureSpike',
    name: '后台登录失败激增',
    severity: 'P1',
    metric: 'adminLoginFailures',
    compare: 'gt',
    threshold: 10,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.auditLog.count({
        where: {
          action: { in: ['admin.login.failed', 'admin.login.mfa_failed'] },
          createdAt: { gte: new Date(Date.now() - HOUR) },
        },
      });
      return { value: n, context: { window: '1h', severityHint: '含 TOTP 失败，可能是针对超管账号' } };
    },
    describe: (v) => `近 1 小时后台登录失败 ${v} 次（含 TOTP 失败，优先排查超管账号）`,
  },
  {
    key: 'admin.tokenReuse',
    name: '后台令牌重放',
    severity: 'P1',
    metric: 'tokenReuse',
    compare: 'gt',
    threshold: 0,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.auditLog.count({
        where: { action: 'admin.token.reused', createdAt: { gte: new Date(Date.now() - HOUR) } },
      });
      return { value: n, context: { severityHint: '旧 refresh 二次使用 = 会话劫持信号' } };
    },
    describe: (v) => `近 1 小时检测到 ${v} 次令牌重放（会话可能已被劫持）`,
  },

  // ---------- P2：容量与体验 ----------
  {
    key: 'payment.successRate',
    name: '支付成功率异常',
    severity: 'P2',
    metric: 'successRate',
    compare: 'lt',
    threshold: 0.5,
    windowMs: HOUR,
    collect: async () => {
      const since = new Date(Date.now() - HOUR);
      const total = await prisma.order.count({ where: { createdAt: { gte: since } } });
      const paid = await prisma.order.count({ where: { status: 'PAID', createdAt: { gte: since } } });
      // 分母为 0 时返回 1（视为正常），否则会误报
      const rate = total === 0 ? 1 : paid / total;
      return { value: Number(rate.toFixed(4)), context: { paid, total, window: '1h' } };
    },
    describe: (v) => `近 1 小时支付成功率 ${(v * 100).toFixed(1)}%（低于 50%，需核对渠道）`,
  },
  {
    key: 'recon.openDiff',
    name: '对账差异未处理',
    severity: 'P2',
    metric: 'openReconciliations',
    compare: 'gt',
    threshold: 5,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.reconciliationRecord.count({ where: { handledAt: null } });
      return { value: n };
    },
    describe: (v) => `未处理的对账差异 ${v} 条（金额可能对不上，需人工介入）`,
  },
  {
    key: 'job.failure',
    name: '定时任务连续失败',
    severity: 'P1',
    metric: 'jobFailures',
    compare: 'gt',
    threshold: 2,
    windowMs: HOUR,
    collect: async () => {
      const n = await prisma.auditLog.count({
        where: { action: 'job.failed', createdAt: { gte: new Date(Date.now() - HOUR) } },
      });
      return { value: n, context: { window: '1h' } };
    },
    describe: (v) => `近 1 小时定时任务失败 ${v} 次（对账、账本扫描等可能已停摆）`,
  },
]);

export const RULE_KEYS = ALERT_RULES.map((r) => r.key);

// ==================== 规则评估 ====================

export interface EvaluateResult {
  evaluated: number;
  triggered: string[];
  recovered: string[];
  /** 采集失败的规则（不阻断其余规则） */
  collectFailed: string[];
}

/**
 * 评估全部规则。**永不抛异常**——采集或落库失败只记日志。
 * 供定时任务调用，也可由后台「立即检测」手动触发（告警演练）。
 */
export async function evaluate(): Promise<EvaluateResult> {
  const result: EvaluateResult = { evaluated: 0, triggered: [], recovered: [], collectFailed: [] };

  for (const rule of ALERT_RULES) {
    try {
      await evaluateRule(rule, result);
      result.evaluated += 1;
    } catch (err) {
      result.collectFailed.push(rule.key);
      logger.error({ err, rule: rule.key }, 'alert_rule_eval_failed');
    }
  }

  if (result.triggered.length > 0 || result.recovered.length > 0) {
    logger.info(
      { triggered: result.triggered, recovered: result.recovered },
      'alert_evaluation_completed'
    );
  }
  return result;
}

async function evaluateRule(rule: AlertRule, result: EvaluateResult): Promise<void> {
  const state = await prisma.alertRuleState.findUnique({ where: { ruleKey: rule.key } });

  // ---- 采集（失败视为"数据未知"，不触发也不恢复，保持原状态）----
  let value: number;
  let context: Record<string, unknown> | undefined;
  try {
    const collected = await rule.collect();
    value = collected.value;
    context = collected.context;
  } catch (err) {
    logger.error({ err, rule: rule.key }, 'alert_metric_collect_failed');
    return;
  }

  const isHit = hit(value, rule.threshold, rule.compare);

  // ---- 未命中：若之前在告警中则闭环恢复 ----
  if (!isHit) {
    if (state?.firing) {
      const open = await prisma.alertEvent.findFirst({
        where: { ruleKey: rule.key, resolvedAt: null, source: 'monitor' },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        await prisma.alertEvent.update({
          where: { id: open.id },
          data: { resolvedAt: new Date(), updatedAt: new Date() },
        });
      }
      await prisma.alertRuleState.update({
        where: { ruleKey: rule.key },
        data: { firing: false, hitStreak: 0, lastResolvedAt: new Date() },
      });
      result.recovered.push(rule.key);
      logger.info({ rule: rule.key }, 'alert_resolved');
    }
    return;
  }

  // ---- 命中 ----
  const hitStreak = (state?.hitStreak ?? 0) + 1;
  const reachedThreshold = hitStreak >= config.ALERT_CONSECUTIVE_THRESHOLD;

  // 静默窗口内只更新 streak，不重复建事件/外发
  const withinSilence =
    !!state?.lastFiredAt &&
    Date.now() - state.lastFiredAt.getTime() < config.ALERT_SILENCE_MS;

  if (withinSilence) {
    await prisma.alertRuleState.update({
      where: { ruleKey: rule.key },
      data: { firing: true, hitStreak },
    });
    return;
  }

  // 首轮命中或达到连续阈值才建事件
  if (!reachedThreshold) {
    await prisma.alertRuleState.upsert({
      where: { ruleKey: rule.key },
      create: { ruleKey: rule.key, firing: true, hitStreak },
      update: { firing: true, hitStreak },
    });
    logger.info({ rule: rule.key, hitStreak, threshold: config.ALERT_CONSECUTIVE_THRESHOLD }, 'alert_pending_confirmation');
    return;
  }

  // 建事件（追加式）
  const message = rule.describe(value, rule.threshold);
  const event = await prisma.alertEvent.create({
    data: {
      source: 'monitor',
      severity: rule.severity,
      title: `[${rule.severity}] ${rule.name}`,
      ruleKey: rule.key,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      hitStreak,
      status: 'pending',
      detail: {
        message,
        windowMs: rule.windowMs,
        context: context ?? {},
      } as object,
    },
  });

  // 外发（失败只标记，不影响其他规则）
  const delivery = await sendAlert({
    severity: rule.severity,
    title: rule.name,
    message,
    ruleKey: rule.key,
    metric: rule.metric,
    value,
    threshold: rule.threshold,
    hitStreak,
    context,
  });

  await prisma.alertEvent.update({
    where: { id: event.id },
    data: {
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.error,
      sentAt: delivery.sentAt,
      updatedAt: new Date(),
    },
  });

  await prisma.alertRuleState.upsert({
    where: { ruleKey: rule.key },
    create: {
      ruleKey: rule.key,
      firing: true,
      hitStreak,
      lastEventId: event.id,
      lastFiredAt: new Date(),
    },
    update: { firing: true, hitStreak, lastEventId: event.id, lastFiredAt: new Date() },
  });

  result.triggered.push(rule.key);
}

/** 重置规则状态（演练或阈值调整后用，避免旧 streak 干扰新判定） */
export async function resetRuleState(ruleKey?: string): Promise<number> {
  const r = await prisma.alertRuleState.deleteMany({
    where: ruleKey ? { ruleKey } : undefined,
  });
  return r.count;
}

/** 手动标记规则为"已确认"（等同把 firing 归零，用于值班确认后不再刷） */
export async function acknowledge(ruleKey: string): Promise<void> {
  await prisma.alertRuleState.upsert({
    where: { ruleKey },
    create: { ruleKey, firing: false, hitStreak: 0, lastResolvedAt: new Date() },
    update: { firing: false, hitStreak: 0, lastResolvedAt: new Date() },
  });
}

export default { evaluate, resetRuleState, acknowledge, ALERT_RULES, RULE_KEYS };