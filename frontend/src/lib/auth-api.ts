/**
 * 后台认证 API（两步登录 + TOTP 绑定 + 会话管理）
 * 契约见 `付费后端/src/routes/admin-v1/auth.ts` 与设计文档 6.2。
 */

import { api, setTokens, type AdminSessionView, type AdminTokens, type AdminView } from './api-client';

export interface Step1Result {
  mfaRequired: true;
  mfaToken: string;
  mustBindTotp: boolean;
}

export interface Step2Result {
  tokens: AdminTokens;
  admin: AdminView;
}

export interface BindResult {
  secret: string;
  otpauthUrl: string;
}

export interface ConfirmResult extends Step2Result {
  recoveryCodes: string[];
}

export interface MeResult {
  admin: AdminView;
  permissions: string[];
}

export interface SessionsResult {
  items: AdminSessionView[];
  currentSessionId: string;
}

export const adminAuthApi = {
  /** 第一步：用户名 + 密码 → mfaToken（5 分钟一次性） */
  async loginPassword(username: string, password: string): Promise<Step1Result> {
    return api.post<Step1Result>('/auth/login', { step: 'password', username, password });
  },

  /** 第二步：TOTP 或恢复码 → 令牌对 */
  async loginTotp(mfaToken: string, code: string, username?: string): Promise<Step2Result> {
    const result = await api.post<Step2Result>('/auth/login', {
      step: 'totp',
      mfaToken,
      code,
      username,
    });
    setTokens(result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  },

  /** 绑定第一步：生成 pending secret（totpEnabled 仍为 false） */
  async bindTotp(mfaToken: string): Promise<BindResult> {
    return api.post<BindResult>('/auth/totp/bind', { mfaToken });
  },

  /** 绑定确认：验证扫码码 → 启用 TOTP + 发放恢复码 + 令牌对 */
  async confirmTotp(mfaToken: string, code: string): Promise<ConfirmResult> {
    const result = await api.post<ConfirmResult>('/auth/totp/confirm', { mfaToken, code });
    setTokens(result.tokens.accessToken, result.tokens.refreshToken);
    return result;
  },

  /** 当前管理员 + 权限码（刷新页面后用refresh token 静默恢复会话） */
  async me(): Promise<MeResult> {
    return api.get<MeResult>('/auth/me');
  },

  logout(): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>('/auth/logout');
  },

  sessions(): Promise<SessionsResult> {
    return api.get<SessionsResult>('/auth/sessions');
  },

  revokeSession(id: string): Promise<{ ok: boolean }> {
    return api.del<{ ok: boolean }>(`/auth/sessions/${id}`);
  },

  revokeAllSessions(): Promise<{ revoked: number }> {
    return api.post<{ revoked: number }>('/auth/sessions/revoke-all');
  },

  /** 修改密码（成功后全部会话失效，需重新登录） */
  changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>('/auth/password', { oldPassword, newPassword });
  },

  /** 发起 TOTP 重绑（密码复核）→ 返回新的 totp-bind mfaToken */
  async rebind(password: string): Promise<Step1Result> {
    return api.post<Step1Result>('/auth/totp/rebind', { password });
  },
};