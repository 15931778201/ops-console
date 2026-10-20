/**
 * 支付宝适配器（电脑网站支付 / 预创建扫码）
 * RSA2 签名；回调为表单或 JSON，验签后按 out_trade_no 关联本地订单。
 * 上线前需沙箱验收（T5.2）。
 */

import { createSign, createVerify } from 'node:crypto';
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

const GATEWAY = 'https://openapi.alipay.com';
const SIGN_TYPE = 'RSA2';

function signParams(params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createSign('RSA-SHA256')
    .update(sorted)
    .sign(config.ALIPAY_PRIVATE_KEY ?? '', 'base64');
}

function verifySign(params: Record<string, string>, sign: string): boolean {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${decodeURIComponent(params[k]!)}`)
    .join('&');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(sorted);
  try {
    return verifier.verify(config.ALIPAY_PUBLIC_KEY ?? '', sign, 'base64');
  } catch {
    return false;
  }
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    }
  }
  return out;
}

function parseJsonBusiness(rawBody: string): Record<string, unknown> {
  // 支付宝回调可能为表单或 JSON（含 sign 字段在顶层）
  if (rawBody.trim().startsWith('{')) {
    const envelope = JSON.parse(rawBody) as Record<string, unknown>;
    const biz = (envelope.alipay_trade_precreate_response ??
      envelope.alipay_trade_query_response ??
      envelope.alipay_trade_refund_response ??
      {}) as Record<string, unknown>;
    const sign = String(envelope.sign ?? '');
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(biz)) flat[k] = String(v);
    if (!verifySign(flat, sign)) {
      throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付宝回调验签失败');
    }
    return biz;
  }
  const form = parseForm(rawBody);
  if (!verifySign(form, form.sign ?? '')) {
    throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, '支付宝回调验签失败');
  }
  return form as unknown as Record<string, unknown>;
}

export const alipayAdapter: PaymentAdapter = {
  provider: 'alipay',

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const biz: Record<string, string> = {
      app_id: config.ALIPAY_APP_ID ?? '',
      method: 'alipay.trade.precreate',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: SIGN_TYPE,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      notify_url: params.notifyUrl,
      biz_content: JSON.stringify({
        out_trade_no: params.orderNo,
        total_amount: (params.amountCents / 100).toFixed(2),
        subject: params.description,
      }),
    };
    const sign = signParams(biz);
    const resp = await fetch(`${GATEWAY}/gateway.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...biz, sign }).toString(),
    });
    const json = (await resp.json()) as Record<string, string>;
    const precreate = json.alipay_trade_precreate_response;
    if (!precreate) {
      throw new PaymentError(ErrorCode.INTERNAL_ERROR, '支付宝下单失败');
    }
    const qr = (JSON.parse(precreate) as { qr_code?: string }).qr_code ?? '';
    return { params: { qrContent: qr } };
  },

  async verifyNotify(input: PaymentNotifyInput): Promise<VerifiedNotify> {
    const biz = parseJsonBusiness(input.rawBody);
    const status = String(biz.trade_status ?? '');
    if (status && !['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(status)) {
      throw new PaymentError(ErrorCode.PAYMENT_SIGNATURE_INVALID, `交易状态异常: ${status}`);
    }
    return {
      provider: 'alipay',
      eventId: String(biz.trade_no ?? `ali_${Date.now()}`),
      channelTradeNo: String(biz.trade_no ?? ''),
      orderNo: String(biz.out_trade_no ?? ''),
      amountCents: Math.round(Number(biz.total_amount ?? biz.receipt_amount ?? 0) * 100),
      currency: 'CNY',
      status: 'PAID',
      paidAt: biz.gmt_payment ? new Date(String(biz.gmt_payment)) : undefined,
    };
  },

  async verifyRefundNotify(input: PaymentNotifyInput): Promise<VerifiedNotify> {
    const biz = parseJsonBusiness(input.rawBody);
    return {
      provider: 'alipay',
      eventId: String(biz.trade_no ?? `alirf_${Date.now()}`),
      channelTradeNo: String(biz.trade_no ?? ''),
      orderNo: String(biz.out_trade_no ?? biz.out_biz_no ?? ''),
      amountCents: Math.round(Number(biz.refund_fee ?? 0) * 100),
      currency: 'CNY',
      status: 'REFUNDED',
      refundId: biz.batch_no ? String(biz.batch_no) : undefined,
    };
  },

  async queryOrder(orderNo: string): Promise<QueriedOrder> {
    const biz: Record<string, string> = {
      app_id: config.ALIPAY_APP_ID ?? '',
      method: 'alipay.trade.query',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: SIGN_TYPE,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      biz_content: JSON.stringify({ out_trade_no: orderNo }),
    };
    const sign = signParams(biz);
    const resp = await fetch(`${GATEWAY}/gateway.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...biz, sign }).toString(),
    });
    const json = (await resp.json()) as Record<string, string>;
    const query = json.alipay_trade_query_response;
    if (!query) return { status: 'PENDING' };
    const parsed = JSON.parse(query) as Record<string, string>;
    const status: QueriedOrder['status'] =
      parsed.trade_status === 'TRADE_SUCCESS' || parsed.trade_status === 'TRADE_FINISHED'
        ? 'PAID'
        : parsed.trade_status === 'TRADE_CLOSED'
          ? 'CLOSED'
          : 'PENDING';
    return { status, channelTradeNo: parsed.trade_no, amountCents: Math.round(Number(parsed.total_amount ?? 0) * 100) };
  },

  async createRefund(params: CreateRefundParams): Promise<{ refundId: string }> {
    const biz: Record<string, string> = {
      app_id: config.ALIPAY_APP_ID ?? '',
      method: 'alipay.trade.refund',
      charset: 'utf-8',
      format: 'JSON',
      sign_type: SIGN_TYPE,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      version: '1.0',
      biz_content: JSON.stringify({
        out_trade_no: params.orderNo,
        trade_no: params.channelTradeNo,
        refund_amount: (params.amountCents / 100).toFixed(2),
        refund_reason: params.reason,
        out_request_no: params.refundNo,
      }),
    };
    const sign = signParams(biz);
    const resp = await fetch(`${GATEWAY}/gateway.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...biz, sign }).toString(),
    });
    const json = (await resp.json()) as Record<string, string>;
    const refund = json.alipay_trade_refund_response;
    if (!refund) throw new PaymentError(ErrorCode.INTERNAL_ERROR, '支付宝退款失败');
    return { refundId: params.refundNo };
  },

  ackSuccess(): string {
    return 'success';
  },

  ackFail(): string {
    return 'fail';
  },
};
