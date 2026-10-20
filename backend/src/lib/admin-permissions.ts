/**
 * 运营后台 RBAC 权限矩阵
 * 设计见 plans/运营后台管理系统设计.md 2.2；权限码 = `资源:动作`。
 * 标注语义：R=只读，A=申请（进审批流），P=审批，E=执行/直接生效。
 * 核心原则：申请（A）与审批（P）分离——能改的不能批，资金/批量操作必须两人。
 */

import type { AdminRole } from '@prisma/client';

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
  'alert:read',
  'alert:manage',
  'export:data',
  'admin:manage',
] as const;

export type Permission = (typeof PERMISSION_CODES)[number];

/** 角色 → 权限码集合（SUPER_ADMIN 持有全部） */
const ROLE_PERMISSIONS: Record<Exclude<AdminRole, 'SUPER_ADMIN'>, readonly Permission[]> = {
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

/** 审批权限（矩阵中的 P 标注）：哪类审批允许谁批准（SUPER_ADMIN 隐含可批） */
export const APPROVAL_AUTHORITY = {
  CREDIT_ADJUST: ['FINANCE'],
  REFUND: ['FINANCE'],
  ORDER_CLOSE: ['FINANCE'],
  PLAN_CHANGE: ['FINANCE'],
  INVITE_REWARD: ['FINANCE'],
  RULE_CHANGE: [], // 仅 SUPER_ADMIN 可批
} as const;

export function permissionsForRole(role: AdminRole): Permission[] {
  if (role === 'SUPER_ADMIN') return [...PERMISSION_CODES];
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(role: AdminRole, code: Permission): boolean {
  return permissionsForRole(role).includes(code);
}

/** 是否可批准指定类型审批（SUPER_ADMIN 永远可批） */
export function canApprove(role: AdminRole, approvalType: keyof typeof APPROVAL_AUTHORITY): boolean {
  if (role === 'SUPER_ADMIN') return true;
  return (APPROVAL_AUTHORITY[approvalType] as readonly string[]).includes(role);
}

/** 校验权限码合法性（防手滑拼错导致静默放行/误拒） */
export function isPermissionCode(value: string): value is Permission {
  return (PERMISSION_CODES as readonly string[]).includes(value);
}
