/**
 * 后台权限码与角色矩阵（前端镜像）
 *
 * 与后端 `付费后端/src/lib/admin-permissions.ts` 一一对应。
 * 前端这份只用于**菜单过滤与按钮显隐**，真正的拦截在后端 RBAC 中间件；
 * 两边不一致时以后端为准（前端漏给权限只是少看到一个入口，不会造成越权）。
 */

export const PERMISSION_CODES = [
  'dashboard:read',
  'user:read',
  'user:disable',
  'session:revoke',
  'order:read',
  'order:sync',
  'order:close',
  'refund:apply',
  'credit:read',
  'credit:adjust:apply',
  'credit:adjust:execute',
  'plan:read',
  'plan:write',
  'rule:read',
  'rule:write',
  'invite:read',
  'invite:reward',
  'flag:read',
  'flag:write',
  'reconcile:read',
  'reconcile:handle',
  'approval:read',
  'audit:read',
  'audit:export',
  'export:data',
  'admin:manage',
  'alert:read',
  'alert:manage',
] as const;

export type Permission = (typeof PERMISSION_CODES)[number];

export type AdminRole = 'SUPER_ADMIN' | 'OPERATOR' | 'SUPPORT' | 'FINANCE' | 'AUDITOR';

export const ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营专员',
  SUPPORT: '客服专员',
  FINANCE: '财务',
  AUDITOR: '审计员',
};

export const ROLE_PERMISSIONS: Record<Exclude<AdminRole, 'SUPER_ADMIN'>, readonly Permission[]> = {
  SUPPORT: [
    'dashboard:read',
    'user:read',
    'order:read',
    'refund:apply',
    'credit:read',
    'invite:read',
    'invite:reward',
    'reconcile:read',
    'approval:read',
    'plan:read',
    'rule:read',
    'flag:read',
    'alert:read',
  ],
  OPERATOR: [
    'dashboard:read',
    'user:read',
    'user:disable',
    'session:revoke',
    'order:read',
    'order:sync',
    'order:close',
    'refund:apply',
    'credit:read',
    'credit:adjust:apply',
    'plan:write',
    'rule:write',
    'invite:read',
    'invite:reward',
    'reconcile:read',
    'reconcile:handle',
    'approval:read',
    'audit:read',
    'flag:read',
    'alert:read',
    'alert:manage',
  ],
  FINANCE: [
    'dashboard:read',
    'user:read',
    'order:read',
    'credit:read',
    'reconcile:read',
    'approval:read',
    'plan:read',
    'rule:read',
    'audit:read',
    'audit:export',
    'export:data',
    'flag:read',
    'alert:read',
  ],
  AUDITOR: [
    'dashboard:read',
    'user:read',
    'order:read',
    'credit:read',
    'invite:read',
    'reconcile:read',
    'approval:read',
    'plan:read',
    'rule:read',
    'audit:read',
    'audit:export',
    'export:data',
    'flag:read',
    'alert:read',
  ],
};

export function permissionsForRole(role: AdminRole): Permission[] {
  if (role === 'SUPER_ADMIN') return [...PERMISSION_CODES];
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(perms: readonly string[], code: Permission): boolean {
  return perms.includes(code);
}