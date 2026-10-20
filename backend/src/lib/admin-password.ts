/**
 * 管理员密码策略（设计见运营后台 M0）
 * - ≥12 位，含大小写与数字
 * - 禁止与用户名相似（包含用户名即拒绝，防"用户名+123"类弱口令）
 */

import { config } from './config';

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

export function validateAdminPassword(password: string, username?: string): PasswordCheck {
  const problems: string[] = [];
  if (password.length < config.ADMIN_PASSWORD_MIN_LENGTH) {
    problems.push(`长度至少 ${config.ADMIN_PASSWORD_MIN_LENGTH} 位`);
  }
  if (!/[a-z]/.test(password)) problems.push('需包含小写字母');
  if (!/[A-Z]/.test(password)) problems.push('需包含大写字母');
  if (!/\d/.test(password)) problems.push('需包含数字');
  if (username) {
    const lowerPwd = password.toLowerCase();
    const lowerName = username.trim().toLowerCase();
    if (lowerName.length >= 3 && lowerPwd.includes(lowerName)) {
      problems.push('不能包含用户名');
    }
  }
  return { ok: problems.length === 0, problems };
}
