/**
 * 认证路由（契约见 docs/api-contract-auth.md）
 * 统一 envelope：成功 {success,data}；失败 {success,error:{code,message}}
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { verificationService } from '../services/verification.service';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess } from '../lib/response';
import { clientIp, rateLimiter, RATE_RULES } from '../lib/rate-limit';
import { AuthError, ErrorCode, ValidationError, ServiceUnavailableError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isEnabled } from '../services/feature-flag.service';

const router = Router();

// ---------- 请求 schema ----------

const registerSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
  password: z.string().min(8).max(32),
  name: z.string().min(2).max(20).optional(),
  verificationCode: z.string().length(6),
  inviteCode: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
  password: z.string().min(1).max(32),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

const sendCodeSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
  type: z.enum(['register', 'forgot-password']),
});

const verifyCodeSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
  code: z.string().length(6),
  type: z.enum(['register', 'forgot-password']),
});

const forgotSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
});

const resetSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().regex(/^1[3-9]\d{9}$/).optional(),
  verificationCode: z.string().length(6),
  newPassword: z.string().min(8).max(32),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(32),
  newPassword: z.string().min(8).max(32),
});

/** zod 枚举值 → Prisma VerificationType */
function toVerificationType(value: 'register' | 'forgot-password'): 'REGISTER' | 'FORGOT_PASSWORD' {
  return value === 'register' ? 'REGISTER' : 'FORGOT_PASSWORD';
}

function requestContext(req: Request) {
  return {
    requestId: req.requestId,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  };
}

function requireTarget(
  data: { email?: string; phone?: string },
  message = '邮箱或手机号至少填写一项'
): { target: string; channel: 'EMAIL' | 'SMS' } {
  if (data.email) return { target: data.email, channel: 'EMAIL' };
  if (data.phone) return { target: data.phone, channel: 'SMS' };
  throw new ValidationError(message);
}

// ---------- 路由 ----------

/** POST /api/auth/register */
router.post(
  '/register',
  rateLimiter('register', RATE_RULES.register, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    // 注册开关（A6.8）：关闭后禁止新注册；已存在用户的登录与使用不受影响。
    // 503 而非 400：这是运营主动关闭而非用户参数错误。
    if (!(await isEnabled('registrationOpen'))) {
      throw new ServiceUnavailableError('当前暂停新用户注册');
    }
    const data = registerSchema.parse(req.body);
    const result = await authService.register(data, requestContext(req));
    sendSuccess(res, result, 201);
  })
);

/** POST /api/auth/login */
router.post(
  '/login',
  rateLimiter('login', RATE_RULES.login, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    const data = loginSchema.parse(req.body);
    const result = await authService.login(data, requestContext(req));
    sendSuccess(res, result);
  })
);

/** POST /api/auth/refresh —— 轮换刷新；检测到重放时吊销全部会话 */
router.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    try {
      const tokens = await authService.refresh(refreshToken, { requestId: req.requestId });
      sendSuccess(res, tokens);
    } catch (err) {
      // TOKEN_REUSED：按会话服务内的 userId 吊销全部（此处 userId 未知时仅告警）
      if (err instanceof AuthError && err.code === ErrorCode.TOKEN_REUSED) {
        logger.warn({ requestId: req.requestId }, 'refresh_replay_rejected');
      }
      throw err;
    }
  })
);

/** POST /api/auth/logout —— 登出当前会话 */
router.post(
  '/logout',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await authService.logout(req.user!.sessionId, req.user!.id, req.requestId);
    sendSuccess(res, { loggedOut: true });
  })
);

/** POST /api/auth/logout-all —— 登出所有设备 */
router.post(
  '/logout-all',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await authService.logoutAll(req.user!.id, req.requestId);
    sendSuccess(res, { loggedOutAll: true });
  })
);

/** GET /api/auth/me */
router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await authService.me(req.user!.id);
    sendSuccess(res, result);
  })
);

/** POST /api/auth/send-verification-code */
router.post(
  '/send-verification-code',
  rateLimiter('verificationSend', RATE_RULES.verificationSend, (req) => {
    const body = req.body as { email?: string; phone?: string };
    return body?.email ?? body?.phone ?? clientIp(req);
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const data = sendCodeSchema.parse(req.body);
    const { target, channel } = requireTarget(data);
    await verificationService.send(target, toVerificationType(data.type), channel, req.requestId);
    // 统一成功响应，不暴露账号是否存在（防枚举）
    sendSuccess(res, { sent: true });
  })
);

/** POST /api/auth/verify-code */
router.post('/verify-code', asyncHandler(async (req: Request, res: Response) => {
  const data = verifyCodeSchema.parse(req.body);
  const { target } = requireTarget(data);
  await verificationService.verify(target, data.code, toVerificationType(data.type));
  sendSuccess(res, { valid: true });
}));

/** POST /api/auth/forgot-password */
router.post(
  '/forgot-password',
  rateLimiter('passwordReset', RATE_RULES.passwordReset, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    const data = forgotSchema.parse(req.body);
    const { target, channel } = requireTarget(data);
    await verificationService.send(target, 'FORGOT_PASSWORD', channel, req.requestId);
    sendSuccess(res, { sent: true });
  })
);

/** POST /api/auth/reset-password */
router.post('/reset-password', asyncHandler(async (req: Request, res: Response) => {
  const data = resetSchema.parse(req.body);
  const { target } = requireTarget(data);
  await authService.resetPassword(target, data.verificationCode, data.newPassword, req.requestId);
  sendSuccess(res, { reset: true });
}));

/** POST /api/auth/change-password —— 修改密码并吊销全部会话 */
router.post(
  '/change-password',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = changePasswordSchema.parse(req.body);
    await authService.changePassword(
      req.user!.id,
      data.oldPassword,
      data.newPassword,
      req.requestId
    );
    sendSuccess(res, { changed: true });
  })
);

export default router;
