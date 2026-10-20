/**
 * 微信支付 V3 适配器
 *
 * 实现要点（官方 API V3 协议）：
 * - 请求签名：RSA-SHA256，构造串 = 方法\nURL\ntimestamp\nnonce\nbody\n
 * - 回调验签：Wechatpay-Signature 头 + 平台证书（serial_no 匹配），验签通过后 AES-256-GCM 解密 resource
 * - 金额单位：分；商户订单号即 out_trade_no
 *
 * 上线前必须：配置 WECHAT_APP_ID/WECHAT_MCH_ID/WECHAT_API_KEY/WECHAT_SERIAL_NO/
 * WECHAT_PRIVATE_KEY_PATH/WECHAT_PLATFORM_CERT_PATH 并在沙箱完成验收（T5.2）。
 * 平台证书自动下载与刷新未内置，需运维流程保障（见 docs/部署与恢复手册.md）。
 */

import { createSign, createVerify, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../../lib/config';
import { PaymentError, ErrorCode } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type {
  CreatePaymentParams,
  CreatePaymentResult,
  CreateRefundParams,
  PaymentAdapter,
  PaymentNotifyInput,
  QueriedOrder,
  VerifiedNotify,
} from './types';

const API_BASE = 'https://api.mch.weixin.qq.com';

function loadPrivateKey(): string {
  const path = config.WECHAT_PRIVATE_KEY_PATH;
  if (!path) throw new PaymentError(ErrorCode.INTERNAL_ERROR, '微信商户私钥未配置');
  return readFileSync(path, 'utf8');
}

function loadPlatformCert(): string {
  const path = config.WECHAT_PLATFORM_CERT_PATH;
  if (!path) throw new PaymentError(ErrorCode.INTERNAL_ERROR, '微信平台证书未配置');
  return readFileSync(path, 'utf8');
}

function buildAuthorization(
  method: string,
  urlPath: string,
  body: string
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = createSign('RSA-SHA256')
    .update(message)
    .sign(loadPrivateKey(), 'base64');

  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.WECHAT_MCH_ID}",` +
    `nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${config.WECHAT_CERT_SERIAL_NO}"`
  );
}

async function callApi(
  method: 'GET' | 'POST',
  urlPath: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const bodyStr = body ? JSON.stringify(body) : '';
  const resp = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'heyu-pdf-backend/1.0',
      Authorization: buildAuthorization(method, urlPath, bodyStr),
    },
    body: method === 'POST' ? bodyStr : undefined,
  });
  const json = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    logger.error({ status: resp.status, code: json.code }, 'wechat_api_error');
    throw new PaymentError(ErrorCode.INTERNAL_ERROR, `微信支付接口错误: ${String(json.code ?? resp.status)}`);
  }
  return json;
}

/** 解密回调 resource（AEAD_AES_256_GCM） */
function decryptResource(resource: {
  ciphertext: string;
  nonce: string;
  associated_data: string;
}): Record<string, unknown> {
  const key = config.WECHAT_API_KEY;
  if (!key) throw new PaymentError(ErrorCode.INTERNAL_ERROR, '微信 APIv3 Key 未配置');

  const buf = Buffer.from(resource.ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'utf8'),
    Buffer.from(resource.nonce, 'utf8')
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
}

function parseNotifyInput(input: PaymentNotifyInput): Record<string, unknown> {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调报文解析失败');
  }

  const signature = input.headers['wechatpay-signature'];
  const serial = input.headers['wechatpay-serial'];
  const timestamp = input.headers['wechatpay-timestamp'];
  const nonce = input.headers['wechatpay-nonce'];

  if (
    typeof signature !== 'string' ||
    typeof serial !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof nonce !== 'string'
  ) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调缺少验签头');
  }

  // 平台证书序列号匹配（多证书轮换时按 serial 选择）
  if (serial !== config.WECHAT_CERT_SERIAL_NO) {
    logger.warn({ serial }, 'wechat_notify_unknown_serial');
    // 未内置证书自动下载：无法验证的序列号直接拒绝
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调验签失败');
  }

  const message = `${timestamp}\n${nonce}\n${input.rawBody}\n`;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(message);
  const ok = verifier.verify(loadPlatformCert(), signature, 'base64');
  if (!ok) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调验签失败');
  }

  const resource = envelope.resource as
    | { ciphertext: string; nonce: string; associated_data: string }
    | undefined;
  if (!resource) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调缺少 resource');
  }
  return decryptResource(resource);
}

function toVerifiedNotify(
  payload: Record<string, unknown>,
  kind: 'pay' | 'refund'
): VerifiedNotify {
  const orderNo = String(payload.out_trade_no ?? '');
  if (!orderNo) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付回调缺少商户订单号');
  }
  const amount = (payload.amount ?? {}) as { total?: number; payer_total?: number };
  const status = kind === 'pay' ? 'PAID' : 'REFUNDED';
  return {
    provider: 'wechat',
    eventId: String(payload.transaction_id ?? `wt_${Date.now()}`),
    channelTradeNo: String(payload.transaction_id ?? ''),
    orderNo,
    amountCents: Number(amount.total ?? amount.payer_total ?? 0),
    currency: 'CNY',
    status,
    paidAt: payload.success_time ? new Date(String(payload.success_time)) : undefined,
    refundId: kind === 'refund' ? String(payload.refund_id ?? '') : undefined,
  };
}

export const wechatAdapter: PaymentAdapter = {
  provider: 'wechat',

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const result = await callApi('POST', '/v3/pay/transactions/native', {
      appid: config.WECHAT_APP_ID,
      mchid: config.WECHAT_MCH_ID,
      description: params.description,
      out_trade_no: params.orderNo,
      notify_url: params.notifyUrl,
      amount: { total: params.amountCents, currency: params.currency },
    });
    return {
      params: { qrContent: result.code_url as string },
      channelTradeNo: undefined,
    };
  },

  async verifyNotify(input: PaymentNotifyInput): Promise<VerifiedNotify> {
    const payload = parseNotifyInput(input);
    // 交易状态必须是 SUCCESS/REFUND 成功态
    const tradeState = String(payload.trade_state ?? '');
    if (tradeState && tradeState !== 'SUCCESS') {
      throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, `交易状态异常: ${tradeState}`);
    }
    return toVerifiedNotify(payload, 'pay');
  },

  async verifyRefundNotify(input: PaymentNotifyInput): Promise<VerifiedNotify> {
    const payload = parseNotifyInput(input);
    const refundStatus = String(payload.refund_status ?? '');
    if (refundStatus && refundStatus !== 'SUCCESS') {
      throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, `退款状态异常: ${refundStatus}`);
    }
    return toVerifiedNotify(payload, 'refund');
  },

  async queryOrder(orderNo: string): Promise<QueriedOrder> {
    const result = await callApi(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${config.WECHAT_MCH_ID}`
    );
    const state = String(result.trade_state ?? '');
    const status: QueriedOrder['status'] =
      state === 'SUCCESS'
        ? 'PAID'
        : state === 'REFUND'
          ? 'REFUNDED'
          : state === 'CLOSED'
            ? 'CLOSED'
            : state === 'NOTPAY' || state === 'USERPAYING'
              ? 'PENDING'
              : 'FAILED';
    return {
      status,
      channelTradeNo: result.transaction_id ? String(result.transaction_id) : undefined,
      amountCents: result.amount ? Number((result.amount as { total?: number }).total) : undefined,
      paidAt: result.success_time ? new Date(String(result.success_time)) : undefined,
    };
  },

  async createRefund(params: CreateRefundParams): Promise<{ refundId: string }> {
    const result = await callApi('POST', '/v3/refund/domestic/refunds', {
      transaction_id: params.channelTradeNo,
      out_refund_no: params.refundNo,
      reason: params.reason,
      notify_url: params.notifyUrl,
      amount: { refund: params.amountCents, total: params.amountCents, currency: 'CNY' },
    });
    return { refundId: String(result.refund_id ?? params.refundNo) };
  },

  ackSuccess(): string {
    return JSON.stringify({ code: 'SUCCESS', message: '成功' });
  },

  ackFail(): string {
    return JSON.stringify({ code: 'FAIL', message: '处理失败，稍后重试' });
  },
};
