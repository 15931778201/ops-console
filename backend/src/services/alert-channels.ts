/**
 * 告警外发通道（T6.5）
 *
 * 设计要点：
 *  - **通道可插拔**：当前实现 webhook（企业微信/钉钉/飞书/Slack 均可接），
 *    未来加邮件/短信只需在此加一个 channel。
 *  - **无通道不等于无告警**：未配置 `ALERT_WEBHOOK_URL` 时返回
 *    status=suppressed，事件仍落库 —— 本地开发与"先接库后接通道"的渐进落地都成立。
 *  - **重试有上限且不阻塞**：最多 `ALERT_MAX_RETRIES` 次指数退避；
 *    整体套 timeout，**绝不因外发卡住而拖慢告警评估**（更不能拖住主链路）。
 *  - **凭据不外泄**：token 只在请求头出现，不进日志、不进告警正文。
 */

import { config } from '../lib/config';
import { logger } from '../lib/logger';

export type Severity = 'P0' | 'P1' | 'P2';

export interface AlertPayload {
  severity: Severity;
  title: string;
  message: string;
  ruleKey: string;
  metric: string;
  value: number;
  threshold: number;
  hitStreak: number;
  context?: Record<string, unknown>;
}

export interface DeliveryResult {
  status: 'sent' | 'failed' | 'suppressed';
  attempts: number;
  error?: string;
  sentAt?: string;
}

/** 单次 HTTP 超时（毫秒）——外发再慢也不能超过这个数 */
const REQUEST_TIMEOUT_MS = 5_000;

/** 判断是否配置了任一外发通道 */
export function hasChannel(): boolean {
  return !!config.ALERT_WEBHOOK_URL;
}

function buildBody(p: AlertPayload): string {
  const lines = [
    `【${p.severity}】${p.title}`,
    p.message,
    '',
    `规则：${p.ruleKey}`,
    `指标：${p.metric} = ${p.value}（阈值 ${p.threshold}）`,
    `连续命中：${p.hitStreak} 轮`,
    `时间：${new Date().toLocaleString('zh-CN')}`,
  ];
  if (p.context && Object.keys(p.context).length > 0) {
    lines.push(`上下文：${JSON.stringify(p.context)}`);
  }
  return lines.join('\n');
}

/** 带超时的 POST */
async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发送一条告警。
 *
 * 任何异常都被吞掉并转为 DeliveryResult —— 告警通道本身的故障
 * 绝不能向上传播（调用方是评估循环，抛错会导致其余规则不被评估）。
 */
export async function sendAlert(payload: AlertPayload): Promise<DeliveryResult> {
  if (!hasChannel()) {
    // 未配置通道：标记 suppressed，事件已落库，可事后补看
    logger.warn({ ruleKey: payload.ruleKey, severity: payload.severity }, 'alert_channel_not_configured');
    return { status: 'suppressed', attempts: 0 };
  }

  const body = JSON.stringify({
    msgtype: 'text',
    text: { content: buildBody(payload) },
  });
  const headers: Record<string, string> = {};
  if (config.ALERT_WEBHOOK_TOKEN) {
    headers.Authorization = `Bearer ${config.ALERT_WEBHOOK_TOKEN}`;
  }

  const maxAttempts = config.ALERT_MAX_RETRIES + 1;
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await post(config.ALERT_WEBHOOK_URL!, body, headers);
      logger.info({ ruleKey: payload.ruleKey, severity: payload.severity, attempt }, 'alert_sent');
      return { status: 'sent', attempts: attempt, sentAt: new Date().toISOString() };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { ruleKey: payload.ruleKey, attempt, maxAttempts, err: lastError },
        'alert_send_failed'
      );
      // 指数退避：250ms → 500ms（仅重试之间等待，不影响其他规则）
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
    }
  }

  // 重试耗尽：记日志，事件仍留在库里供人工查看
  return { status: 'failed', attempts: maxAttempts, error: lastError };
}

export default { sendAlert, hasChannel };