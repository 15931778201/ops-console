import { describe, expect, it } from 'vitest';
import { buildMockNotify, mockAdapter } from './mock';
import { PaymentError, ErrorCode } from '../../lib/errors';

const baseParams = {
  orderNo: 'ORD123456',
  amountCents: 2900,
  currency: 'CNY',
};

async function captureError(fn: () => Promise<unknown>): Promise<PaymentError> {
  try {
    await fn();
  } catch (err) {
    return err as PaymentError;
  }
  throw new Error('expected rejection');
}

describe('mock 支付适配器', () => {
  it('下单返回二维码参数', async () => {
    const result = await mockAdapter.createPayment({
      ...baseParams,
      description: 'Pro 套餐',
      notifyUrl: 'https://api.example.com/api/payment/notify/mock',
      clientType: 'desktop',
    });
    expect(result.params.qrContent).toContain('ORD123456');
    expect(result.params.qrContent).toContain('2900');
  });

  it('合法签名回调验签通过', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'PAID' });
    const verified = await mockAdapter.verifyNotify(notify);
    expect(verified.orderNo).toBe('ORD123456');
    expect(verified.amountCents).toBe(2900);
    expect(verified.status).toBe('PAID');
    expect(verified.provider).toBe('mock');
  });

  it('伪造签名被拒绝（PAYMENT_SIGNATURE_INVALID）', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'PAID' });
    const err = await captureError(() =>
      mockAdapter.verifyNotify({
        headers: { ...notify.headers, 'x-mock-signature': 'deadbeef'.repeat(8) },
        rawBody: notify.rawBody,
      })
    );
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe(ErrorCode.PAYMENT_SIGNATURE_INVALID);
  });

  it('篡改金额（签名不匹配）被拒绝', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'PAID' });
    const tampered = notify.rawBody.replace('2900', '1');
    const err = await captureError(() =>
      mockAdapter.verifyNotify({ headers: notify.headers, rawBody: tampered })
    );
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe(ErrorCode.PAYMENT_SIGNATURE_INVALID);
  });

  it('缺少签名头被拒绝', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'PAID' });
    const err = await captureError(() =>
      mockAdapter.verifyNotify({ headers: {}, rawBody: notify.rawBody })
    );
    expect(err).toBeInstanceOf(PaymentError);
    expect(err.code).toBe(ErrorCode.PAYMENT_SIGNATURE_INVALID);
  });

  it('退款回调验签通过', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'REFUNDED' });
    const verified = await mockAdapter.verifyRefundNotify(notify);
    expect(verified.status).toBe('REFUNDED');
    expect(verified.refundId).toBeTruthy();
  });

  it('报文被篡改导致状态未知时同样拒绝', async () => {
    const notify = buildMockNotify({ ...baseParams, status: 'PAID' });
    const weird = notify.rawBody.replace('"PAID"', '"UNKNOWN"');
    const err = await captureError(() =>
      mockAdapter.verifyNotify({ headers: notify.headers, rawBody: weird })
    );
    expect(err).toBeInstanceOf(PaymentError);
  });
});
