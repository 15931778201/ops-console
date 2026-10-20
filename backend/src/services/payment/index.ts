/**
 * 支付适配器注册表
 * 按 config.PAYMENT_PROVIDER 选择首个启用渠道；
 * 未取得资质/未验收的渠道不得进入生产（阶段 0 决策 + 阶段 5 沙箱验收）。
 */

import { config } from '../../lib/config';
import { PaymentError, ErrorCode } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { mockAdapter } from './mock';
import { wechatAdapter } from './wechat';
import { alipayAdapter } from './alipay';
import type { PaymentAdapter, PaymentProvider } from './types';

const adapters: Record<PaymentProvider, PaymentAdapter> = {
  mock: mockAdapter,
  wechat: wechatAdapter,
  alipay: alipayAdapter,
};

/** 当前启用的适配器 */
export function getPaymentAdapter(): PaymentAdapter {
  const provider = config.PAYMENT_PROVIDER;
  if (config.NODE_ENV === 'production' && provider === 'mock') {
    throw new PaymentError(ErrorCode.PAYMENT_CHANNEL_DISABLED, '生产环境禁止使用 Mock 支付');
  }
  logger.debug({ provider }, 'payment_adapter_selected');
  return adapters[provider];
}

/** 按 provider 获取（回调路由按固定路径区分渠道时使用） */
export function getAdapterByProvider(provider: PaymentProvider): PaymentAdapter {
  return adapters[provider];
}

export type {
  PaymentAdapter,
  PaymentProvider,
  VerifiedNotify,
  CreatePaymentParams,
  CreatePaymentResult,
  PaymentNotifyInput,
  QueriedOrder,
  CreateRefundParams,
} from './types';
