/**
 * 定时任务注册（进程内 setInterval，单实例部署假设）
 * 生产多实例部署时应改为仅 leader 执行或外部调度（如 k8s CronJob 调用 HTTP 端点）。
 */

import { logger } from '../lib/logger';
import { audit } from '../lib/audit';
import { NotFoundError } from '../lib/errors';
import { billingService } from '../services/billing.service';
import { orderService } from '../services/order.service';
import { settlementService } from '../services/payment/settlement.service';
import { periodResetService } from './period-reset';
import { adminLedgerService } from '../services/admin-ledger.service';
import { dashboardService } from '../services/dashboard.service';
import alertService from '../services/alert.service';

interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

const jobs: Job[] = [
  {
    name: 'billing_sweeper',
    intervalMs: 5 * 60 * 1000,
    run: async () => {
      const expired = await billingService.expireOverdue(100);
      return { expired };
    },
  },
  {
    name: 'order_sweeper',
    intervalMs: 5 * 60 * 1000,
    run: async () => {
      const closed = await orderService.closeExpired(100);
      return { closed };
    },
  },
  {
    name: 'ledger_reconcile',
    intervalMs: 60 * 60 * 1000,
    run: async () => {
      // 全量扫描投影 vs 流水的不平账户（A6.6）：结果落不进DB，
      // 由后台"积分账本 → 异常账户"页按需查询；此处只做告警与日志。
      const result = await adminLedgerService.scanAnomalies();
      return result;
    },
  },
  {
    name: 'payment_reconcile',
    intervalMs: 24 * 60 * 60 * 1000,
    run: async () => {
      const result = await settlementService.reconcileWithChannel();
      return result;
    },
  },
  {
    // A6.7：每 5 分钟聚合指标写入 dashboard_snapshots，
    // 避免仪表盘页面实时 COUNT 大表（设计文档 M1 的核心约束）
    name: 'dashboard_snapshot',
    intervalMs: 5 * 60 * 1000,
    run: async () => dashboardService.refreshAll(),
  },
  {
    name: 'period_reset',
    intervalMs: 60 * 60 * 1000,
    run: async () => {
      const reset = await periodResetService.runOnce();
      return { reset };
    },
  },
  {
    // T6.5：周期性评估告警规则。
    // 间隔取配置（默认 5 分钟）；规则内部有"连续命中 N 轮才外发"与静默窗口，
    // 所以评估频繁一点无妨——真正的降噪靠规则状态，不靠拉长周期。
    name: 'alert_evaluate',
    intervalMs: 5 * 60 * 1000,
    run: async () => alertService.evaluate(),
  },
];

export function startJobs(): void {
  for (const job of jobs) {
    const run = async () => {
      try {
        const result = await job.run();
        logger.info({ job: job.name, result }, 'job_completed');
      } catch (err) {
        logger.error({ err, job: job.name }, 'job_failed');
        // 失败必须落审计：T6.5 的 job.failure 规则以audit_log 为数据源，
        // 只写日志的话"定时任务停了"这件事永远不会被告警发现。
        await audit.record({
          action: 'job.failed',
          targetType: 'Job',
          targetId: job.name,
          reason: err instanceof Error ? err.message : String(err),
          metadata: { intervalMs: job.intervalMs },
        }).catch(() => undefined);
      }
    };
    // 首次延迟一个周期再执行，避免启动风暴
    const timer = setInterval(run, job.intervalMs);
    timer.unref();
    logger.info({ job: job.name, intervalMs: job.intervalMs }, 'job_scheduled');
  }
}

/** 供测试/外部调度手动执行单个任务（不启动定时器） */
export async function runJobOnce(name: string): Promise<unknown> {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new NotFoundError(`未知任务：${name}`);
  return job.run();
}

export const JOB_NAMES = jobs.map((j) => j.name);
