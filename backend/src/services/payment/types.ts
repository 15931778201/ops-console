/**
 * 支付适配器统一接口
 * 渠道差异（微信/支付宝/Mock）全部隔离在各自适配器内；
 * 结算、幂等、权益发放逻辑与渠道无关（见 settlement.service.ts）。
 */

export type PaymentProvider = 'wechat' | 'alipay' | 'mock';

export type PaymentOrderStatus = 'PENDING' | 'PAID' | 'REFUNDING' | 'REFUNDED' | 'CLOSED' | 'FAILED';

export interface CreatePaymentParams {
  orderNo: string;
  amountCents: number;
  currency: string;
  description: string;
  notifyUrl: string;
  /** 桌面端返回 Native 二维码内容；Web 返回表单/跳转参数 */
  clientType: 'desktop' | 'web';
}

export interface CreatePaymentResult {
  /** 渠道支付参数（二维码内容 / 调起参数 / 表单字段） */
  params: Record<string, unknown>;
  channelTradeNo?: string;
}

export interface PaymentNotifyInput {
  headers: Record<string, string | string[] | undefined>;
  /** 原始报文（验签必须用原文，不能反序列化后重签） */
  rawBody: string;
}

export interface VerifiedNotify {
  provider: PaymentProvider;
  eventId: string;
  channelTradeNo: string;
  orderNo: string;
  amountCents: number;
  currency: string;
  status: Extract<PaymentOrderStatus, 'PAID' | 'REFUNDED' | 'CLOSED' | 'FAILED'>;
  paidAt?: Date;
  refundId?: string;
}

export interface QueriedOrder {
  status: PaymentOrderStatus;
  channelTradeNo?: string;
  amountCents?: number;
  paidAt?: Date;
}

export interface CreateRefundParams {
  orderNo: string;
  channelTradeNo: string;
  refundNo: string;
  amountCents: number;
  reason: string;
  notifyUrl: string;
}

export interface PaymentAdapter {
  readonly provider: PaymentProvider;

  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  /** 验签并规范化回调报文；验签失败必须抛出 PAYMENT_SIGNATURE_INVALID */
  verifyNotify(input: PaymentNotifyInput): Promise<VerifiedNotify>;

  /** 验签并规范化退款回调 */
  verifyRefundNotify(input: PaymentNotifyInput): Promise<VerifiedNotify>;

  /** 渠道查单（支付结果未知时以服务端查证为准） */
  queryOrder(orderNo: string): Promise<QueriedOrder>;

  createRefund(params: CreateRefundParams): Promise<{ refundId: string }>;

  /** 回调 ACK（渠道协议要求的成功响应体） */
  ackSuccess(): string;

  /** 回调 ACK（失败/处理中，渠道将重试） */
  ackFail(): string;
}
