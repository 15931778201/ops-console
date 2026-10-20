/**
 * 支付回调路由（免认证，验签即身份）
 * 注意：必须使用原始报文验签——该路由在 index.ts 中先于 express.json() 挂载，
 * 并使用 express.raw() 获取原文。
 */

import { Router, type Request, type Response } from 'express';
import { settlementService } from '../services/payment/settlement.service';
import { getAdapterByProvider } from '../services/payment';
import { asyncHandler } from '../lib/async-handler';
import { logger } from '../lib/logger';
import type { PaymentProvider } from '../services/payment';

const router = Router();

function rawBodyOf(req: Request): string {
  const body = req.body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body ?? {});
}

function headersOf(req: Request): Record<string, string | string[] | undefined> {
  return req.headers as Record<string, string | string[] | undefined>;
}

function isProvider(value: string): value is PaymentProvider {
  return value === 'wechat' || value === 'alipay' || value === 'mock';
}

/** POST /api/payment/notify/:provider —— 渠道回调入口 */
router.post(
  '/:provider',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider!;
    if (!isProvider(provider)) {
      res.status(404).send('not found');
      return;
    }

    const adapter = getAdapterByProvider(provider);
    try {
      const result = await settlementService.handlePaymentNotify({
        provider,
        rawBody: rawBodyOf(req),
        headers: headersOf(req),
      });
      if (result.duplicate) {
        // 重复回调：ACK 成功（渠道不应继续重推）
        res.status(200).send(adapter.ackSuccess());
        return;
      }
      res.status(200).send(adapter.ackSuccess());
    } catch (err) {
      // 验签失败/金额不符：ACK 失败，渠道将按策略重推；记录待排查
      logger.warn(
        { err: (err as Error).message, provider },
        'payment_notify_rejected'
      );
      res.status(400).send(adapter.ackFail());
    }
  })
);

export default router;
