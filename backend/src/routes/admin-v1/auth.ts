/**
 * 运营后台认证路由（/api/admin/v1/auth）
 * 两步登录契约：
 *   1. POST /login {step:'password', username, password}
 *      → {mfaRequired:true, mfaToken, mustBindTotp}
 *   2a. POST /login {step:'totp', mfaToken, code, username?}
 *      → {tokens, admin}（username 仅用于登录成功后的限流计数重置）
 *   2b. 未绑定 TOTP（mustBindTotp:true）：POST /totp/bind {mfaToken}
 *      → {secret, otpauthUrl}，再 POST /totp/confirm {mfaToken, code}
 *      → {tokens, admin, recoveryCodes}
 * 契约：统一 envelope；错误码见 plans/运营后台管理系统设计.md 6.1。
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { adminAuthService } from '../../services/admin-auth.service';
import { adminAuthMiddleware, type AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess } from '../../lib/response';
import { clientIp, rateLimiter, resetRateLimit, RATE_RULES } from '../../lib/rate-limit';
import { ValidationError } from '../../lib/errors';

const router = Router();

const usernameKey = (req: Request): string => {
  const body = req.body as { username?: unknown };
  return typeof body.username === 'string' ? body.username.trim().toLowerCase() : 'anonymous';
};

function requestContext(req: Request) {
  return {
    requestId: req.requestId,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'],
  };
}

const loginSchema = z
  .object({
    step: z.enum(['password', 'totp']),
    username: z.string().min(1).max(64).optional(),
    password: z.string().min(1).max(128).optional(),
    mfaToken: z.string().min(20).optional(),
    code: z.string().min(6).max(10).optional(),
  })
  .refine(
    (data) =>
      data.step === 'password'
        ? Boolean(data.username && data.password)
        : Boolean(data.mfaToken && data.code),
    { message: '登录参数不完整' }
  );

/** POST /auth/login —— 两步登录入口 */
router.post(
  '/login',
  rateLimiter('admin-login-ip', RATE_RULES.adminLoginIp, clientIp),
  rateLimiter('admin-login', RATE_RULES.adminLogin, usernameKey),
  asyncHandler(async (req: Request, res: Response) => {
    const data = loginSchema.parse(req.body);
    const context = requestContext(req);

    if (data.step === 'password') {
      const result = await adminAuthService.loginStep1(
        data.username!,
        data.password!,
        context
      );
      sendSuccess(res, result);
      return;
    }

    const result = await adminAuthService.loginStep2(data.mfaToken!, data.code!, context);
    // 登录成功重置用户名维度计数（前端在 totp 步回传 username；IP 维度由窗口自然滑过）
    await resetRateLimit('admin-login', (data.username ?? 'anonymous').trim().toLowerCase());
    sendSuccess(res, result);
  })
);

const bindSchema = z.object({ mfaToken: z.string().min(20) });
const confirmSchema = z.object({ mfaToken: z.string().min(20), code: z.string().length(6) });

/** POST /auth/totp/bind —— 生成 pending secret + otpauth URL（需 totp-bind mfaToken） */
router.post(
  '/totp/bind',
  rateLimiter('admin-totp', RATE_RULES.adminTotp, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    const data = bindSchema.parse(req.body);
    const result = await adminAuthService.bindTotp(data.mfaToken, requestContext(req));
    sendSuccess(res, result);
  })
);

/** POST /auth/totp/confirm —— 验证扫码码 → 启用 TOTP + 恢复码 + 令牌对 */
router.post(
  '/totp/confirm',
  rateLimiter('admin-totp', RATE_RULES.adminTotp, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    const data = confirmSchema.parse(req.body);
    const result = await adminAuthService.confirmTotp(data.mfaToken, data.code, requestContext(req));
    sendSuccess(res, result);
  })
);

/** POST /auth/refresh —— 轮换刷新（重放检测） */
router.post(
  '/refresh',
  rateLimiter('admin-refresh', RATE_RULES.adminRefresh, clientIp),
  asyncHandler(async (req: Request, res: Response) => {
    const data = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const tokens = await adminAuthService.refresh(data.refreshToken, requestContext(req));
    sendSuccess(res, tokens);
  })
);

// ---------- 以下需已登录 ----------

router.use(adminAuthMiddleware);

/** POST /auth/logout */
router.post(
  '/logout',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    await adminAuthService.logout(req.admin!.sessionId, req.admin!.id, req.requestId);
    sendSuccess(res, { ok: true });
  })
);

/** GET /auth/me —— 当前管理员 + 权限码列表 */
router.get(
  '/me',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    const result = await adminAuthService.me(req.admin!.id);
    sendSuccess(res, result);
  })
);

/** GET /auth/sessions —— 会话列表 */
router.get(
  '/sessions',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    const sessions = await adminAuthService.listSessions(req.admin!.id);
    sendSuccess(res, { items: sessions, currentSessionId: req.admin!.sessionId });
  })
);

/** DELETE /auth/sessions/:id —— 吊销指定会话 */
router.delete(
  '/sessions/:id',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    await adminAuthService.revokeSession(req.params.id!, req.admin!.id, req.requestId);
    sendSuccess(res, { ok: true });
  })
);

/** POST /auth/sessions/revoke-all —— 吊销全部会话（含当前） */
router.post(
  '/sessions/revoke-all',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    const count = await adminAuthService.revokeAllSessions(req.admin!.id, req.requestId);
    sendSuccess(res, { revoked: count });
  })
);

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

/** POST /auth/password —— 修改密码（成功后全部会话失效） */
router.post(
  '/password',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    const data = changePasswordSchema.parse(req.body);
    await adminAuthService.changePassword(
      req.admin!.id,
      data.oldPassword,
      data.newPassword,
      req.requestId
    );
    sendSuccess(res, { ok: true });
  })
);

const rebindSchema = z.object({ password: z.string().min(1).max(128) });

/** POST /auth/totp/rebind —— 发起 TOTP 重绑（密码复核后复用 bind/confirm） */
router.post(
  '/totp/rebind',
  asyncHandler(async (req: AdminAuthRequest, res: Response) => {
    const data = rebindSchema.parse(req.body);
    const result = await adminAuthService.initiateTotpRebind(
      req.admin!.id,
      data.password,
      requestContext(req)
    );
    sendSuccess(res, result);
  })
);

export default router;
