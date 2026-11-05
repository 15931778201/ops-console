/**
 * UserSDK 服务层 —— 面向桌面客户端 SDK（usersdk-core）的登录/用户/套餐/支付能力。
 *
 * 复用既有基座：
 * - 验证码：verificationService（新增 LOGIN 类型，Prisma 迁移 202611050001_usersdk）
 * - 会话：sessionService.createSession（JWT access + 轮换 refresh，与 /api/auth 同一套）
 * - 订单与结算：orderService.createOrder + settlementService（mock 渠道自动结算仅限非生产）
 * - 套餐：Plan 表新增 product 字段（common = 通用目录）
 *
 * 对外契约见 ../docs/api-contract-usersdk.md 与 usersdk/docs/02-api-protocol.md：
 * 响应包裹沿用本服务 { success, data } envelope，由 Rust core 适配层转换。
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import prisma from '../lib/prisma';
import { config, isProduction } from '../lib/config';
import { AuthError, ErrorCode, NotFoundError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { audit } from '../lib/audit';
import { verificationService } from './verification.service';
import { sessionService } from './session.service';
import { orderService } from './order.service';
import { settlementService } from './payment/settlement.service';
import { buildMockNotify } from './payment/mock';

/** 中国大陆手机号 */
const CN_MOBILE = /^1[3-9]\d{9}$/;

export type PaymentChannelName = 'WECHAT' | 'ALIPAY';

/** UserInfo —— UserSDK 客户端消费的用户信息（docs/02-api-protocol.md §3.1） */
export interface UsersdkUserInfo {
  id: string;
  nickname: string;
  /** 打码后的手机号，如 138****8000 */
  username: string;
  avatar?: string;
  vip_list: Array<{
    vip_id: number;
    vip_type: string;
    /** yyyy-MM-dd HH:mm:ss；永久为 9999-12-31 23:59:59 */
    enddate: string;
  }>;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

function fmtDate(d: Date | null): string {
  if (!d) return '';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 按当前时间计算某用户的 VIP 状态（不依赖缓存） */
function computeVip(user: User & { planExpiresAt: Date | null }): { isVip: boolean; permanent: boolean; enddate: string } {
  if (user.planId === 'free') return { isVip: false, permanent: false, enddate: '' };
  // 无到期时间视为永久（运营侧手工授予）
  if (!user.planExpiresAt) return { isVip: true, permanent: true, enddate: '9999-12-31 23:59:59' };
  const isVip = user.planExpiresAt.getTime() > Date.now();
  return { isVip, permanent: false, enddate: fmtDate(user.planExpiresAt) };
}

export const usersdkService = {
  /** 发送登录验证码（60s 冷却 + 每小时 5 条由 verificationService 把关） */
  async sendLoginCode(phone: string, requestId?: string): Promise<void> {
    if (!CN_MOBILE.test(phone)) throw new ValidationError('请输入正确的手机号');
    await verificationService.send(phone, 'LOGIN', 'SMS', requestId);
  },

  /**
   * 手机号 + 验证码登录（无密码）：已注册 → 建会话；未注册 → 自动创建账号。
   * 返回与 /api/auth 同构的 TokenPair（accessToken 15 分钟，refresh 30 天轮换）。
   */
  async loginByMobile(input: {
    phone: string;
    captcha: string;
    deviceInfo?: Record<string, unknown>;
    requestId?: string;
    ip?: string;
  }): Promise<{ user: UsersdkUserInfo; token: string; refresh_token: string; expires_in: number }> {
    const { phone, captcha } = input;
    if (!CN_MOBILE.test(phone)) throw new ValidationError('请输入正确的手机号');
    await verificationService.verify(phone, captcha, 'LOGIN');

    let user = await prisma.user.findUnique({ where: { phone } });
    let isNew = false;

    if (!user) {
      if (isProduction()) {
        // 生产环境如未开放自助注册，可在此收敛为仅允许已注册手机号登录
        logger.info({ phone: maskPhone(phone) }, 'usersdk_auto_register');
      }
      // 自动注册：不写初始 GRANT 流水（与邮箱注册路径不同，SDK 用户权益由购买结算发放），
      // creditAccount 行仍要建，保证计费/账本模块的账户始终存在。
      const password = crypto.randomBytes(24).toString('base64url');
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone,
            phoneVerified: true,
            passwordHash: await bcrypt.hash(password, 12),
            name: maskPhone(phone),
            planId: 'free',
          },
        });
        await tx.creditAccount.create({ data: { userId: created.id } });
        return created;
      });
      isNew = true;
      await audit.record({
        action: isNew ? 'usersdk.register' : 'usersdk.login',
        actorType: 'USER',
        actorId: user.id,
        targetType: 'user',
        targetId: user.id,
        requestId: input.requestId,
        metadata: { channel: 'sms', phone: maskPhone(phone) },
      });
    }

    const tokens = await sessionService.createSession(user.id, user.planId, {
      ...input.deviceInfo,
      channel: 'usersdk',
    });
    return {
      user: await this.userInfo(user.id, 'common'),
      token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
    };
  },

  /** 用户信息（含产品维度 VIP）。product 为客户端产品标识（如 ffconvert）。 */
  async userInfo(userId: string, product: string): Promise<UsersdkUserInfo> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, avatar: true, planId: true, planExpiresAt: true, status: true },
    });
    if (!user || user.status === 'DELETED') throw new NotFoundError('用户不存在');
    if (user.status === 'SUSPENDED') throw new AuthError(ErrorCode.UNAUTHORIZED, '账号已被停用');

    const vip = computeVip(user as User & { planExpiresAt: Date | null });
    return {
      id: user.id,
      nickname: user.name ?? (user.phone ? maskPhone(user.phone) : '用户'),
      username: user.phone ? maskPhone(user.phone) : '',
      avatar: user.avatar ?? undefined,
      vip_list: [
        {
          vip_id: vip.permanent ? 3 : vip.isVip ? 1 : 0,
          vip_type: product,
          enddate: vip.enddate,
        },
      ],
    };
  },

  /** 产品配置（套餐分组 + 运营位）。套餐来自 Plan 表（product 匹配 + active）。 */
  async productConfig(product: string): Promise<Record<string, unknown>> {
    const plans = await prisma.plan.findMany({
      where: { product, active: true },
      orderBy: { priceCents: 'asc' },
    });
    if (plans.length === 0) {
      // 回退到通用目录，避免客户端拿到空套餐
      const common = await prisma.plan.findMany({ where: { product: 'common', active: true }, orderBy: { priceCents: 'asc' } });
      plans.push(...common);
    }

    type PlanFeature = {
      durationLabel?: string;
      originPriceCents?: number;
      gift?: string;
      ribbon?: string;
      recommended?: boolean;
      footerLabel?: string;
    };

    const list = plans.map((p) => {
      const f = (p.features ?? {}) as PlanFeature;
      return {
        id: p.id,
        title: p.name,
        price: p.priceCents,
        origin_price: f.originPriceCents,
        duration_label: f.durationLabel ?? `${p.periodMonths} 个月`,
        gift: f.gift,
        ribbon: f.ribbon,
        recommended: f.recommended ?? false,
        footer_label: f.footerLabel,
      };
    });

    return {
      header: {
        title: '省心远程服务',
        subtitle: '电脑疑难杂症，专家远程解决，安全无忧，不解决不收费',
        chips: ['专业团队', '20年技术沉淀', '安全保障', '一对一服务'],
        ctaText: '联系专家客服',
        servedCount: 258210,
      },
      benefits: [
        { icon: 'robot', text: '驱动异常' },
        { icon: 'monitor', text: '重装电脑' },
        { icon: 'plus', text: '疑难杂症' },
        { icon: 'cloud', text: 'OpenClaw服务' },
        { icon: 'shield', text: '安全远程' },
        { icon: 'users', text: '专家团队' },
      ],
      qa: [
        { q: '这个省心服务有什么优势？', a: '专业技术团队，一对一贴心服务，技术好、有耐心，告别传统线下维修，更高效率更省心！' },
        { q: '远程维修安全吗？', a: '整个过程没有繁琐流程，一键远程，全程可视化可管控，未解决问题全额退款。' },
      ],
      plan_groups: [{ key: 'vip', title: '会员套餐', plans: list }],
      plan_notes: ['开通即代表同意退款规则：未解决问题全额退款！'],
      promo: {
        title: '限时特惠 · 永久会员立减',
        badge: '超值优惠',
        save_label: '已省80元',
        save_fen: 8000,
        end_time: Date.now() + 6 * 3600 * 1000,
      },
      guarantees: [
        { icon: 'shield', text: '支持七天无理由退款' },
        { icon: 'info', text: '专家服务' },
        { icon: 'invoice', text: '可开发票' },
      ],
      review_summary: ['用户评价 (50万+)', '近30天好评率99%', '售后服务保障', '98%的用户愿意推荐好友'],
      badges: ['驱动库最全 (98,532)', '修复见效快 (95,231)', '功能全面 (72,156)', '操作简单 (68,321)'],
      ticker_messages: [
        '159****6661 15秒前购买了终身会员，修复了驱动异常',
        '137****2210 42秒前购买了年卡，修复了软件报错',
        '188****0934 2分钟前购买了终身会员，重装了系统',
      ],
      agreement_url: '#agreement',
      help_url: '#help',
      kefu_url: '#kefu',
      invoice_url: '#invoice',
    };
  },

  /** 创建支付订单并返回收款二维码内容（mock 渠道为 mockpay:// 链接） */
  async createPayOrder(input: {
    userId: string;
    planId: string;
    channel: PaymentChannelName;
    idempotencyKey: string;
    clientType?: 'desktop' | 'web';
  }): Promise<{ out_trade_no: string; qr_content: string; expire_seconds: number }> {
    const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) throw new NotFoundError('套餐不存在');
    if (!plan.active) throw new ValidationError('该套餐已下架，请选择其他套餐');

    const { order, paymentParams } = await orderService.createOrder({
      userId: input.userId,
      planId: input.planId,
      periodMonths: plan.periodMonths,
      channel: input.channel,
      idempotencyKey: input.idempotencyKey,
      clientType: input.clientType ?? 'desktop',
      // 套餐卡为固定总价（终身卡等），以 Plan.priceCents 为准，不再按月价乘周期
      amountOverrideCents: plan.priceCents,
    });

    const qrContent = (paymentParams as { qrContent?: string }).qrContent ?? '';
    return {
      out_trade_no: order.orderNo,
      qr_content: qrContent,
      expire_seconds: 30 * 60,
    };
  },

  /**
   * 轮询支付结果。
   * - 真实渠道：先走 syncWithChannel 补偿查询，再读订单状态；
   * - mock 渠道（非生产）：轮询本身即视为"用户已扫码付款"，触发完整 mock 结算链路，
   *   便于端到端联调（生产与真实渠道不受影响）。
   */
  async pollPay(userId: string, orderNo: string, product: string): Promise<{
    status: 'waiting' | 'success';
    user_info?: UsersdkUserInfo;
  }> {
    let order = await prisma.order.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单不存在');

    if (order.status === 'PENDING') {
      if (config.PAYMENT_PROVIDER === 'mock' && !isProduction()) {
        const notify = buildMockNotify({ orderNo, amountCents: order.amountCents, currency: order.currency, status: 'PAID' });
        await settlementService.handlePaymentNotify({ provider: 'mock', rawBody: notify.rawBody, headers: notify.headers });
      } else {
        await orderService.syncWithChannel(orderNo).catch((e) => {
          logger.warn({ orderNo, err: (e as Error).message }, 'usersdk_sync_channel_failed');
        });
      }
      order = await prisma.order.findFirst({ where: { orderNo, userId } });
    }

    if (order && order.status === 'PAID') {
      return { status: 'success', user_info: await this.userInfo(userId, product) };
    }
    return { status: 'waiting' };
  },
};
