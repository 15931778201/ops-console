/**
 * 权限矩阵与路由守卫单测
 * 关键不变量：前端矩阵必须与后端 `付费后端/src/lib/admin-permissions.ts` 一致——
 * 前端只做菜单/按钮过滤，但一旦不一致会出现"看不到入口却能调接口"的困惑，
 * 或"看得到入口点下去 403"的体验问题，故逐项断言。
 */

import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CODES,
  ROLE_LABELS,
  hasPermission,
  permissionsForRole,
  type Permission,
} from '../lib/permissions';
import { safeRedirect } from './safe-redirect';

describe('权限码清单', () => {
  it('共 28 个权限码（A6.8 新增 flag:read，T6.5 新增 alert:read/alert:manage）', () => {
    expect(PERMISSION_CODES.length).toBe(28);
  });

  it('权限码为 2-3 段小写（资源:动作 或 资源:子资源:动作）', () => {
    for (const code of PERMISSION_CODES) {
      expect(code).toMatch(/^[a-z]+(:[a-z]+){1,2}$/);
    }
  });

  it('权限码无重复', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });
});

describe('角色矩阵', () => {
  it('SUPER_ADMIN 拥有全部 28 项', () => {
    expect(permissionsForRole('SUPER_ADMIN').length).toBe(28);
  });

  it('SUPPORT 零写权限（无任何 :disable/:sync/:handle/:write/:manage/flag:write）', () => {
    const perms = permissionsForRole('SUPPORT');
    // 注意：flag:read 是读权限（A6.8），不能被 'flag' 前缀误伤
    const writes = perms.filter((p) =>
      /(disable|sync|close|handle|write|manage|execute)/.test(p) || p === 'flag:write'
    );
    expect(writes).toEqual([]);
    expect(perms).toContain('flag:read');
  });

  it('T6.5 告警：所有非超管都能看，只有 OPERATOR 能演练/确认', () => {
    for (const role of ['OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR'] as const) {
      expect(permissionsForRole(role)).toContain('alert:read');
    }
    expect(hasPermission(permissionsForRole('OPERATOR'), 'alert:manage')).toBe(true);
    // 值班处置权不能扩散给客服/财务/审计：他们看得见但不能改告警状态
    for (const role of ['SUPPORT', 'FINANCE', 'AUDITOR'] as const) {
      expect(hasPermission(permissionsForRole(role), 'alert:manage')).toBe(false);
    }
  });

  it('告警页无"改阈值"入口：前端也不定义任何改阈值的权限码', () => {
    // 阈值属配置，必须走发布流程；一旦出现 alert:threshold 之类权限码说明有人加了暗门
    expect(PERMISSION_CODES.filter((p) => p.startsWith('alert:'))).toEqual([
      'alert:read',
      'alert:manage',
    ]);
  });

  it('AUDITOR 零写权限且只读+导出', () => {
    const perms = permissionsForRole('AUDITOR');
    expect(perms).toContain('audit:read');
    expect(perms).toContain('audit:export');
    expect(perms).not.toContain('reconcile:handle');
    expect(perms).not.toContain('credit:adjust:apply');
  });

  it('FINANCE 只能读，不能改（无 user:disable / order:sync / reconcile:handle）', () => {
    const perms = permissionsForRole('FINANCE');
    expect(perms).not.toContain('user:disable');
    expect(perms).not.toContain('order:sync');
    expect(perms).not.toContain('reconcile:handle');
    expect(perms).toContain('credit:read');
    expect(perms).toContain('audit:export');
  });

  it('OPERATOR 可处理对账但不能审批调账执行', () => {
    const perms = permissionsForRole('OPERATOR');
    expect(perms).toContain('reconcile:handle');
    expect(perms).toContain('order:sync');
    // 申请与执行分离：OPERATOR 可申请，不可执行
    expect(perms).toContain('credit:adjust:apply');
    expect(perms).not.toContain('credit:adjust:execute');
  });

  it('只有 SUPER_ADMIN 持有 admin:manage', () => {
    for (const role of ['OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR'] as const) {
      expect(hasPermission(permissionsForRole(role), 'admin:manage')).toBe(false);
    }
    expect(hasPermission(permissionsForRole('SUPER_ADMIN'), 'admin:manage')).toBe(true);
  });

  it('所有角色的权限码都是合法权限码', () => {
    const valid = new Set<string>(PERMISSION_CODES);
    for (const role of ['SUPER_ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR'] as const) {
      for (const p of permissionsForRole(role)) {
        expect(valid.has(p)).toBe(true);
      }
    }
  });

  it('hasPermission 对未知角色权限返回 false', () => {
    expect(hasPermission(['user:read'], 'not:a:permission' as Permission)).toBe(false);
  });
});

describe('角色标签', () => {
  it('五个角色都有中文标签', () => {
    for (const role of ['SUPER_ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR'] as const) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
  });
});

describe('safeRedirect（防开放重定向）', () => {
  it('站内相对路径原样返回', () => {
    expect(safeRedirect('/users')).toBe('/users');
    expect(safeRedirect('/orders/abc?x=1')).toBe('/orders/abc?x=1');
  });

  it('空值回落到 /', () => {
    expect(safeRedirect(null)).toBe('/');
    expect(safeRedirect('')).toBe('/');
  });

  it('站外绝对地址被拒绝', () => {
    expect(safeRedirect('https://evil.example.com')).toBe('/');
    expect(safeRedirect('http://evil.example.com')).toBe('/');
  });

  it('协议相对地址（//evil.com）被拒绝', () => {
    expect(safeRedirect('//evil.example.com')).toBe('/');
  });

  it('非 / 开头的相对路径被拒绝', () => {
    expect(safeRedirect('users')).toBe('/');
    expect(safeRedirect('javascript:alert(1)')).toBe('/');
  });
});