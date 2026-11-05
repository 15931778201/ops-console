/**
 * UserSDK 客户端路由（/api/usersdk/v1）——桌面 SDK（usersdk-core）专用。
 * 契约：usersdk/docs/02-api-protocol.md；envelope 沿用本服务 { success, data }。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess } from '../lib/response';
import { rateLimiter, RATE_RULES, clientIp } from '../lib/rate-limit';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { usersdkService } from '../services/usersdk.service';

const router = Router();

const phoneSchema = z.object({ mobile: z.string().regex(/^1[3-9]\d{9}$/, '手机号不正确') });

/** 产品名：小写字母/数字/下划线 1~32 位 */
const productSchema = z
  .string()
  .regex(/^[a-z0-9_]{1,32}$/i, 'product_name 不合法')
  .transform((s) => s.toLowerCase());

/** 发送登录验证码 */
router.post(
  '/v1/sms/send',
  rateLimiter('usersdkSmsSend', RATE_RULES.verificationSend, clientIp),
  asyncHandler(async (req, res) => {
    const { mobile } = phoneSchema.parse(req.body);
    await usersdkService.sendLoginCode(mobile, req.requestId);
    sendSuccess(res, {});
  }),
);

/** 手机号 + 验证码登录（未注册自动创建） */
router.post(
  '/v1/login/mobile',
  rateLimiter('usersdkLogin', RATE_RULES.login, clientIp),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        mobile: z.string().regex(/^1[3-9]\d{9}$/, '手机号不正确'),
        captcha: z.string().min(4).max(6),
        device: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    const data = await usersdkService.loginByMobile({
      phone: body.mobile,
      captcha: body.captcha,
      deviceInfo: body.device,
      requestId: req.requestId,
      ip: req.ip,
    });
    sendSuccess(res, data);
  }),
);

/** 用户信息（登录后） */
router.get(
  '/v1/user/info',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    const product = productSchema.catch('common').parse(req.query.product_name ?? 'common');
    sendSuccess(res, { user_info: await usersdkService.userInfo(req.user!.id, product) });
  }),
);

/** 产品配置（套餐分组 + 运营位；免登录） */
router.get(
  '/v1/product/config',
  asyncHandler(async (req, res) => {
    const product = productSchema.parse(req.query.product_name ?? 'common');
    sendSuccess(res, { config: await usersdkService.productConfig(product) });
  }),
);

/** 创建支付订单并返回收款二维码 */
router.post(
  '/v1/payment/qrcode',
  authMiddleware,
  rateLimiter('usersdkPayCreate', RATE_RULES.paymentCreate, (req: AuthRequest) => req.user?.id ?? 'anon'),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        plan_id: z.string().min(1).max(64),
        channel: z.enum(['WECHAT', 'ALIPAY']).default('WECHAT'),
        idempotency_key: z.string().min(8).max(128),
        client_type: z.enum(['desktop', 'web']).default('desktop'),
      })
      .parse(req.body);
    const data = await usersdkService.createPayOrder({
      userId: req.user!.id,
      planId: body.plan_id,
      channel: body.channel,
      idempotencyKey: body.idempotency_key,
      clientType: body.client_type,
    });
    sendSuccess(res, data);
  }),
);

/** 轮询支付结果（PAID 时返回最新 user_info） */
router.get(
  '/v1/payment/paid',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    const orderNo = z.string().min(6).max(64).parse(String(req.query.out_trade_no ?? ''));
    const product = productSchema.catch('common').parse(req.query.product_name ?? 'common');
    sendSuccess(res, await usersdkService.pollPay(req.user!.id, orderNo, product));
  }),
);

export default router;
