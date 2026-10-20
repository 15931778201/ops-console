import { describe, expect, it } from 'vitest';
import { computeSplit, PLAN_HIERARCHY } from './billing.service';

describe('computeSplit（先订阅后奖励）', () => {
  it('订阅余额充足时全部扣订阅', () => {
    expect(computeSplit(100, 50, 30)).toEqual({ fromBalance: 30, fromBonus: 0 });
  });

  it('订阅不足时差额扣奖励', () => {
    expect(computeSplit(20, 50, 30)).toEqual({ fromBalance: 20, fromBonus: 10 });
  });

  it('两者之和恰好够时全部扣完', () => {
    expect(computeSplit(20, 10, 30)).toEqual({ fromBalance: 20, fromBonus: 10 });
  });

  it('订阅为 0 时全部扣奖励', () => {
    expect(computeSplit(0, 100, 30)).toEqual({ fromBalance: 0, fromBonus: 30 });
  });

  it('amount 为 0 时不扣减', () => {
    expect(computeSplit(10, 10, 0)).toEqual({ fromBalance: 0, fromBonus: 0 });
  });

  it('负余额按 0 处理', () => {
    expect(computeSplit(-5, 100, 30)).toEqual({ fromBalance: 0, fromBonus: 30 });
  });

  it('负金额抛错', () => {
    expect(() => computeSplit(10, 10, -1)).toThrow();
  });
});

describe('PLAN_HIERARCHY', () => {
  it('等级顺序 free < pro < vip', () => {
    expect(PLAN_HIERARCHY).toEqual(['free', 'pro', 'vip']);
  });
});
