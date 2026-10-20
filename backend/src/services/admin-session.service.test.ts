import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AdminSession } from '@prisma/client';

/** mock prisma（adminSession + audit 依赖的 auditLog）；vi.hoisted 避免提升初始化问题 */
const prismaMock = vi.hoisted(() => ({
  adminSession: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
  },
}));

vi.mock('../lib/prisma', () => ({ default: prismaMock }));

import { adminSessionService } from './admin-session.service';
import { verifyAdminAccessToken } from '../lib/admin-jwt';

function futureSession(overrides: Partial<AdminSession> = {}): AdminSession & {
  admin: { id: string; role: string; status: string };
} {
  const now = new Date();
  return {
    id: 'sess-1',
    adminUserId: 'admin-1',
    refreshHash: 'hash-old',
    replacedByHash: null,
    revokedAt: null,
    ip: '1.2.3.4',
    userAgent: 'vitest',
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 30 * 86400000),
    admin: { id: 'admin-1', role: 'OPERATOR', status: 'ACTIVE' },
    ...overrides,
  } as AdminSession & { admin: { id: string; role: string; status: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSession', () => {
  it('创建会话并签发带 role 的 access token', async () => {
    prismaMock.adminSession.create.mockResolvedValue({ id: 'sess-new' });

    const tokens = await adminSessionService.createSession('admin-1', 'OPERATOR', {
      ip: '1.2.3.4',
      userAgent: 'ua',
    });

    expect(prismaMock.adminSession.create).toHaveBeenCalledOnce();
    const payload = verifyAdminAccessToken(tokens.accessToken);
    expect(payload?.sub).toBe('admin-1');
    expect(payload?.sid).toBe('sess-new');
    expect(payload?.role).toBe('OPERATOR');
    expect(tokens.expiresIn).toBe(900);
    expect(tokens.refreshToken.length).toBeGreaterThan(20);
  });
});

describe('rotate（轮换 + 重放检测）', () => {
  it('有效令牌轮换成功，refreshHash 更新', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue(futureSession());
    prismaMock.adminSession.update.mockResolvedValue({ id: 'sess-1' });

    const result = await adminSessionService.rotate('old-refresh-token');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adminUserId).toBe('admin-1');
    // 新 refresh 与旧不同；access token 可验
    expect(result.tokens.refreshToken).not.toBe('old-refresh-token');
    expect(verifyAdminAccessToken(result.tokens.accessToken)?.sub).toBe('admin-1');
    // 旧会话被标记 replacedByHash
    expect(prismaMock.adminSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ replacedByHash: expect.any(String) }),
      })
    );
  });

  it('令牌不存在 → INVALID', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue(null);
    const result = await adminSessionService.rotate('unknown');
    expect(result).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('已轮换的旧令牌再用 → REUSED（重放攻击，带回 adminUserId 供吊销）', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue(
      futureSession({ replacedByHash: 'hash-new' })
    );
    const result = await adminSessionService.rotate('old');
    expect(result).toEqual({ ok: false, reason: 'REUSED', adminUserId: 'admin-1' });
  });

  it('已吊销会话 → REUSED', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue(
      futureSession({ revokedAt: new Date() })
    );
    const result = await adminSessionService.rotate('old');
    expect(result).toEqual({ ok: false, reason: 'REUSED', adminUserId: 'admin-1' });
  });

  it('已过期会话 → REUSED', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue(
      futureSession({ expiresAt: new Date(Date.now() - 1000) })
    );
    const result = await adminSessionService.rotate('old');
    expect(result).toEqual({ ok: false, reason: 'REUSED', adminUserId: 'admin-1' });
  });

  it('关联管理员被禁用 → INVALID', async () => {
    prismaMock.adminSession.findUnique.mockResolvedValue({
      ...futureSession(),
      admin: { id: 'admin-1', role: 'OPERATOR', status: 'DISABLED' },
    });
    const result = await adminSessionService.rotate('old');
    expect(result).toEqual({ ok: false, reason: 'INVALID' });
  });
});

describe('吊销与查询', () => {
  it('revokeAll 吊销全部未吊销会话', async () => {
    prismaMock.adminSession.updateMany.mockResolvedValue({ count: 3 });
    const count = await adminSessionService.revokeAll('admin-1', 'test');
    expect(count).toBe(3);
    expect(prismaMock.adminSession.updateMany).toHaveBeenCalledWith({
      where: { adminUserId: 'admin-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokeById 仅吊销指定会话', async () => {
    prismaMock.adminSession.updateMany.mockResolvedValue({ count: 1 });
    await adminSessionService.revokeById('sess-1', 'admin-1');
    expect(prismaMock.adminSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', adminUserId: 'admin-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('isSessionActive 有效/失效判定', async () => {
    prismaMock.adminSession.findFirst.mockResolvedValue({ id: 'sess-1' });
    expect(await adminSessionService.isSessionActive('sess-1', 'admin-1')).toBe(true);

    prismaMock.adminSession.findFirst.mockResolvedValue(null);
    expect(await adminSessionService.isSessionActive('sess-1', 'admin-1')).toBe(false);
  });

  it('listForAdmin 按最近使用倒序返回脱敏字段', async () => {
    const now = new Date();
    prismaMock.adminSession.findMany.mockResolvedValue([
      { id: 's1', ip: '1.1.1.1', userAgent: 'ua', createdAt: now, lastUsedAt: now, expiresAt: now },
    ]);
    const list = await adminSessionService.listForAdmin('admin-1');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('refreshHash');
    expect(prismaMock.adminSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminUserId: 'admin-1', revokedAt: null } })
    );
  });
});

describe('handleReuse（重放响应）', () => {
  it('记录审计并吊销该管理员全部会话', async () => {
    prismaMock.adminSession.updateMany.mockResolvedValue({ count: 2 });
    await adminSessionService.handleReuse('admin-1', 'req-1');
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'ADMIN',
          action: 'admin.session.reuse_detected',
        }),
      })
    );
    expect(prismaMock.adminSession.updateMany).toHaveBeenCalledWith({
      where: { adminUserId: 'admin-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
