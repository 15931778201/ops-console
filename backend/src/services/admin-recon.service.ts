/**
 * 运营后台·对账工作台服务（A6.4）
 * 数据源：ReconciliationRecord（迁移 M5），由对账任务与后台人工查单写入。
 * 差异类型（设计文档 M3）：
 *   PAID_LOCAL_PENDING  渠道已付本地未结（可自动补结算）
 *   PAID_LOCAL_UNKNOWN  本地已结渠道无记录（需人工核实）
 *   AMOUNT_MISMATCH     金额不一致（禁止自动改金额，交财务）
 *   DUPLICATE_NOTIFY    重复回调（已幂等拦截，仅留痕）
 * 人工处理动作：AUTO_SETTLED（系统）/ MANUAL_DONE / ESCALATED / IGNORED。
 * 约束：人工处理只改 ReconciliationRecord；补结算统一走 settlementService（幂等，不重复发权益）。
 */

import type { Prisma, ReconAction, PaymentChannel } from '@prisma/client';
import prisma from '../lib/prisma';
import { settlementService } from './payment/settlement.service';
import { getPaymentAdapter } from './payment';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';

export const DIFF_TYPES = {
  PAID_LOCAL_PENDING: 'PAID_LOCAL_PENDING',
  PAID_LOCAL_UNKNOWN: 'PAID_LOCAL_UNKNOWN',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DUPLICATE_NOTIFY: 'DUPLICATE_NOTIFY',
} as const;

export type DiffType = (typeof DIFF_TYPES)[keyof typeof DIFF_TYPES];

export const DIFF_TYPE_LABELS: Record<DiffType, string> = {
  PAID_LOCAL_PENDING: '渠道已付本地未结',
  PAID_LOCAL_UNKNOWN: '本地已结渠道无记录',
  AMOUNT_MISMATCH: '金额不一致',
  DUPLICATE_NOTIFY: '重复回调',
};

export interface ReconListQuery {
  page: number;
  pageSize: number;
  diffType?: DiffType;
  action?: ReconAction;
  channel?: PaymentChannel;
  orderNo?: string;
  /** true 只看待处理（action 为空） */
  pendingOnly?: boolean;
}

function buildWhere(query: ReconListQuery): Prisma.ReconciliationRecordWhereInput {
  const where: Prisma.ReconciliationRecordWhereInput = {};
  if (query.diffType) where.diffType = query.diffType;
  if (query.action) where.action = query.action;
  if (query.channel) where.channel = query.channel;
  if (query.orderNo) where.orderNo = { contains: query.orderNo };
  if (query.pendingOnly) where.action = null;
  return where;
}

export const adminReconService = {
  /** 差异列表 + 按类型分组统计（工作台首页用） */
  async listReconciliations(query: ReconListQuery): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
    groupCounts: Record<string, number>;
  }> {
    const where = buildWhere(query);
    const [items, total, grouped] = await Promise.all([
      prisma.reconciliationRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.reconciliationRecord.count({ where }),
      prisma.reconciliationRecord.groupBy({
        by: ['diffType'],
        _count: true,
      }),
    ]);

    const groupCounts: Record<string, number> = {};
    for (const g of grouped) {
      groupCounts[g.diffType] = g._count;
    }
    return { items: items as unknown as Array<Record<string, unknown>>, total, groupCounts };
  },

  /** 单条差异详情（详情页用） */
  async getReconciliation(id: string): Promise<Record<string, unknown>> {
    const record = await prisma.reconciliationRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundError('对账记录不存在');
    return record as unknown as Record<string, unknown>;
  },

  /**
   * 人工处理差异：标记动作 + 处理人 + 备注（只改工单状态，不改资金）。
   * AUTO_SETTLED 由系统写入，人工不可选（避免"手工宣称已结算"）。
   */
  async handleReconciliation(
    id: string,
    action: Exclude<ReconAction, 'AUTO_SETTLED'>,
    note: string,
    actorId: string,
    requestId?: string
  ): Promise<{ id: string; action: ReconAction; handledAt: Date }> {
    const record = await prisma.reconciliationRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundError('对账记录不存在');
    if (record.action === 'AUTO_SETTLED') {
      throw new ValidationError('该记录已由系统自动处理，无需人工标记');
    }

    const updated = await prisma.reconciliationRecord.update({
      where: { id },
      data: { action, note, handledBy: actorId, handledAt: new Date() },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.reconciliation_handled',
      targetType: 'ReconciliationRecord',
      targetId: id,
      reason: note,
      metadata: { diffType: record.diffType, orderNo: record.orderNo, action },
      requestId,
    });
    return { id: updated.id, action: updated.action!, handledAt: updated.handledAt! };
  },

  /**
   * 重试补结算（仅 PAID_LOCAL_PENDING）：
   * 再次向渠道查单，若渠道已付且本地仍 PENDING → 补结算（settleOrder 幂等，绝不重复发权益）。
   */
  async retrySettlement(
    id: string,
    actorId: string,
    requestId?: string
  ): Promise<{ orderNo: string; settled: boolean; localStatus: string; note: string }> {
    const record = await prisma.reconciliationRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundError('对账记录不存在');
    if (record.diffType !== DIFF_TYPES.PAID_LOCAL_PENDING) {
      throw new ValidationError('仅"渠道已付本地未结"支持重试补结算');
    }

    const order = await prisma.order.findUnique({ where: { orderNo: record.orderNo } });
    if (!order) throw new NotFoundError('关联订单不存在');
    if (order.status !== 'PENDING') {
      const note = `订单已是 ${order.status}，无需补结算`;
      return { orderNo: record.orderNo, settled: false, localStatus: order.status, note };
    }

    // 复用查单补偿：settleFromQuery 内部经 settleOrder 状态机守卫（仅 PENDING 可结算）
    const adapter = getPaymentAdapter();
    const queried = await adapter.queryOrder(record.orderNo);
    if (queried.status !== 'PAID') {
      const note = `渠道状态为 ${queried.status}，暂不补结算`;
      return { orderNo: record.orderNo, settled: false, localStatus: order.status, note };
    }

    await settlementService.settleFromQuery(order, queried);
    const after = await prisma.order.findUnique({
      where: { orderNo: record.orderNo },
      select: { status: true },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.reconciliation_resettled',
      targetType: 'ReconciliationRecord',
      targetId: id,
      metadata: { orderNo: record.orderNo, localStatus: after?.status },
      requestId,
    });
    logger.info({ actorId, orderNo: record.orderNo }, 'admin_reconciliation_resettled');
    return {
      orderNo: record.orderNo,
      settled: true,
      localStatus: after?.status ?? 'PAID',
      note: '补结算完成',
    };
  },
};

export default adminReconService;
