/**
 * Mock 支付适配器（开发/预生产沙箱）
 *
 * 用途：在真实渠道资质就绪前完成端到端联调（下单→回调→结算→对账→退款）。
 * 安全语义与真实渠道一致：
 * - 回调带 HMAC-SHA256 签名（MOCK_PAYMENT_KEY），验签失败拒绝
 * - 金额/币种/订单号由服务端在结算时二次匹配
 * 生产环境禁止启用（config.PAYMENT_PROVIDER 生产校验见 config.ts）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../lib/config';
import { PaymentError, ErrorCode } from '../../lib/errors';
import type {
  CreatePaymentParams,
  CreatePaymentResult,
  CreateRefundParams,
  PaymentAdapter,
  PaymentNotifyInput,
  QueriedOrder,
  VerifiedNotify,
} from './types';

const KEY = () => config.JWT_SECRET + ':mock-payment';

function sign(payload: string): string {
  return createHmac('sha256', KEY()).update(payload).digest('hex');
}

/** 构造 mock 回调报文（测试端点用；生产不可达） */
export function buildMockNotify(params: {
  orderNo: string;
  amountCents: number;
  currency: string;
  status: 'PAID' | 'REFUNDED' | 'CLOSED' | 'FAILED';
  channelTradeNo?: string;
  eventId?: string;
}): { headers: Record<string, string>; rawBody: string } {
  const body = JSON.stringify({
    provider: 'mock',
    eventId: params.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    outTradeNo: params.orderNo,
    channelTradeNo: params.channelTradeNo ?? `MOCK${Date.now()}`,
    amountCents: params.amountCents,
    currency: params.currency,
    status: params.status,
    paidAt: params.status === 'PAID' ? new Date().toISOString() : undefined,
    refundId: params.status === 'REFUNDED' ? `RF${Date.now()}` : undefined,
  });
  return {
    headers: { 'content-type': 'application/json', 'x-mock-signature': sign(body) },
    rawBody: body,
  };
}

function doVerify(input: PaymentNotifyInput): VerifiedNotify {
  const signature = input.headers['x-mock-signature'];
  const expected = sign(input.rawBody);
  if (
    typeof signature !== 'string' ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调验签失败');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调报文解析失败');
  }

  const status = String(payload.status ?? '');
  if (!['PAID', 'REFUNDED', 'CLOSED', 'FAILED'].includes(status)) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调状态未知');
  }

  return {
    provider: 'mock' as const,
    eventId: String(payload.eventId ?? ''),
    channelTradeNo: String(payload.channelTradeNo ?? ''),
    orderNo: String(payload.outTradeNo ?? ''),
    amountCents: Number(payload.amountCents ?? 0),
    currency: String(payload.currency ?? 'CNY'),
    status: status as VerifiedNotify['status'],
    paidAt: payload.paidAt ? new Date(String(payload.paidAt)) : undefined,
    refundId: payload.refundId ? String(payload.refundId) : undefined,
  };
}

export const mockAdapter: PaymentAdapter = {
  provider: 'mock',

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    // 模拟渠道下单：返回二维码内容（桌面端扫码 / Web 端展示）
    return {
      params: {
        qrContent: `mockpay://pay?order=${params.orderNo}&amount=${params.amountCents}&currency=${params.currency}`,
        expireMinutes: 30,
      },
      channelTradeNo: `MOCK${Date.now()}`,
    };
  },

  verifyNotify(input) {
    return Promise.resolve(doVerify(input));
  },

  verifyRefundNotify(input) {
    return Promise.resolve(doVerify(input));
  },

  async queryOrder(orderNo: string): Promise<QueriedOrder> {
    // Mock 渠道无真实状态存储；查单结果由本地订单推断（真实渠道实现渠道 API）
    void orderNo;
    return { status: 'PENDING' };
  },

  async createRefund(params: CreateRefundParams): Promise<{ refundId: string }> {
    return { refundId: `RF${Date.now()}_${params.orderNo}` };
  },

  ackSuccess(): string {
    return JSON.stringify({ code: 'SUCCESS' });
  },

  ackFail(): string {
    return JSON.stringify({ code: 'FAIL', message: 'processing' });
  },
};
