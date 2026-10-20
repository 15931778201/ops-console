import { describe, expect, it } from 'vitest';
import { requiresTotpBinding } from './admin-auth.service';

describe('管理员首次登录 TOTP 分流', () => {
  it('首次登录标记为必须绑定时进入绑定流程', () => {
    expect(
      requiresTotpBinding({
        mustBindTotp: true,
        totpEnabled: false,
        totpSecret: null,
      })
    ).toBe(true);
  });

  it('TOTP 开关已开但密钥缺失时仍进入绑定流程', () => {
    expect(
      requiresTotpBinding({
        mustBindTotp: false,
        totpEnabled: true,
        totpSecret: null,
      })
    ).toBe(true);
  });

  it('完整绑定状态才进入动态码登录流程', () => {
    expect(
      requiresTotpBinding({
        mustBindTotp: false,
        totpEnabled: true,
        totpSecret: 'encrypted-secret',
      })
    ).toBe(false);
  });
});
