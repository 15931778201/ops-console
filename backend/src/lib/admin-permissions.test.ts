import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CODES,
  permissionsForRole,
  hasPermission,
  canApprove,
  isPermissionCode,
  type Permission,
} from './admin-permissions';

describe('权限矩阵（设计文档 2.2 逐项断言）', () => {
  it('共 28 个权限码且无重复（T6.5 新增 alert:read / alert:manage）', () => {
    expect(PERMISSION_CODES).toHaveLength(28);
    expect(new Set(PERMISSION_CODES).size).toBe(28);
  });

  it('SUPER_ADMIN 持有全部权限', () => {
    expect(permissionsForRole('SUPER_ADMIN')).toEqual([...PERMISSION_CODES]);
  });

  it('SUPPORT 零写权限：只有读 + 退款申请', () => {
    const perms = permissionsForRole('SUPPORT');
    const allowed: Permission[] = [
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
    ];
    expect([...perms].sort()).toEqual([...allowed].sort());
    // 明确不持有任何直接生效的写权限（含 flag:write——停收开关只能超管拨）
    for (const code of ['user:disable', 'session:revoke', 'order:sync', 'audit:read', 'export:data', 'admin:manage', 'flag:write', 'alert:manage'] as Permission[]) {
      expect(hasPermission('SUPPORT', code)).toBe(false);
    }
  });

  it('AUDITOR 零写权限：只读 + 审计导出', () => {
    const perms = permissionsForRole('AUDITOR');
    expect(hasPermission('AUDITOR', 'audit:read')).toBe(true);
    expect(hasPermission('AUDITOR', 'audit:export')).toBe(true);
    expect(hasPermission('AUDITOR', 'export:data')).toBe(true);
    for (const code of ['refund:apply', 'invite:reward', 'user:disable', 'reconcile:handle', 'admin:manage'] as Permission[]) {
      expect(hasPermission('AUDITOR', code)).toBe(false);
    }
  });

  it('OPERATOR：可查询与低风险执行，调账只有申请权', () => {
    expect(hasPermission('OPERATOR', 'user:disable')).toBe(true);
    expect(hasPermission('OPERATOR', 'session:revoke')).toBe(true);
    expect(hasPermission('OPERATOR', 'order:sync')).toBe(true);
    expect(hasPermission('OPERATOR', 'credit:adjust:apply')).toBe(true);
    // 申请与审批分离：OPERATOR 不能执行调账、不能审批
    expect(hasPermission('OPERATOR', 'credit:adjust:execute')).toBe(false);
    expect(hasPermission('OPERATOR', 'audit:read')).toBe(true);
    expect(hasPermission('OPERATOR', 'audit:export')).toBe(false);
    expect(hasPermission('OPERATOR', 'flag:write')).toBe(false);
    expect(hasPermission('OPERATOR', 'admin:manage')).toBe(false);
  });

  it('FINANCE：审批与导出，不持有申请类写权限', () => {
    expect(hasPermission('FINANCE', 'audit:export')).toBe(true);
    expect(hasPermission('FINANCE', 'export:data')).toBe(true);
    // 矩阵中 FINANCE 对资金类操作仅 P（审批），不直接 A/E
    expect(hasPermission('FINANCE', 'refund:apply')).toBe(false);
    expect(hasPermission('FINANCE', 'credit:adjust:apply')).toBe(false);
    expect(hasPermission('FINANCE', 'credit:adjust:execute')).toBe(false);
    expect(hasPermission('FINANCE', 'user:disable')).toBe(false);
  });
});

describe('审批权限（P 标注）', () => {
  it('FINANCE 可审批调账/退款/关单/套餐变更/邀请发奖', () => {
    expect(canApprove('FINANCE', 'CREDIT_ADJUST')).toBe(true);
    expect(canApprove('FINANCE', 'REFUND')).toBe(true);
    expect(canApprove('FINANCE', 'ORDER_CLOSE')).toBe(true);
    expect(canApprove('FINANCE', 'PLAN_CHANGE')).toBe(true);
    expect(canApprove('FINANCE', 'INVITE_REWARD')).toBe(true);
  });

  it('规则变更仅 SUPER_ADMIN 可批', () => {
    expect(canApprove('FINANCE', 'RULE_CHANGE')).toBe(false);
    expect(canApprove('OPERATOR', 'RULE_CHANGE')).toBe(false);
    expect(canApprove('SUPER_ADMIN', 'RULE_CHANGE')).toBe(true);
  });

  it('申请人≠审批人：OPERATOR/SUPPORT 无任何审批权', () => {
    for (const type of ['CREDIT_ADJUST', 'REFUND', 'ORDER_CLOSE', 'PLAN_CHANGE', 'INVITE_REWARD', 'RULE_CHANGE'] as const) {
      expect(canApprove('OPERATOR', type)).toBe(false);
      expect(canApprove('SUPPORT', type)).toBe(false);
      expect(canApprove('AUDITOR', type)).toBe(false);
    }
  });

  it('SUPER_ADMIN 可审批全部类型', () => {
    for (const type of ['CREDIT_ADJUST', 'REFUND', 'ORDER_CLOSE', 'PLAN_CHANGE', 'INVITE_REWARD', 'RULE_CHANGE'] as const) {
      expect(canApprove('SUPER_ADMIN', type)).toBe(true);
    }
  });
});

describe('isPermissionCode', () => {
  it('识别合法权限码', () => {
    expect(isPermissionCode('user:disable')).toBe(true);
    expect(isPermissionCode('credit:adjust:apply')).toBe(true);
  });

  it('拒绝拼写错误（防止静默放行）', () => {
    expect(isPermissionCode('user:write')).toBe(false);
    expect(isPermissionCode('USER:DISABLE')).toBe(false);
    expect(isPermissionCode('')).toBe(false);
  });
});
