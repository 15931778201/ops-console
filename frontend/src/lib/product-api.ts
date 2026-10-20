/**
 * 产品中心 API 客户端（产品管理/上线配置/版本/数据分析/套餐/多语言/评价）
 *
 * 后端 `/api/admin/v1/products/**` 尚未落地，因此默认走**内存 mock**（刷新页面即重置），
 * 让页面与交互先可用；后端就绪后在 .env 设 `VITE_PRODUCT_MOCK=false` 即切到真实接口。
 * 接口契约即下方 realApi 的路径与载荷，后端按此实现即可。
 *
 * 权限沿用现有码（不新增，避免与后端权限矩阵失配）：读 plan:read，写 plan:write。
 */

import { api } from './api-client';

export const USE_MOCK = (import.meta.env?.VITE_PRODUCT_MOCK as string | undefined) !== 'false';

// ---------- 类型 ----------

export type ProductStatus = 'DRAFT' | 'ONLINE' | 'OFFLINE';
export type Platform = 'windows' | 'macos' | 'linux' | 'web';
export type Channel = 'stable' | 'beta';

export interface Product {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseConfig {
  productId: string;
  status: ProductStatus;
  onlineAt: string | null;
  /** 公告（富文本 HTML，已净化）；非空时用户端展示 */
  maintenanceNotice: string;
  /** 产品说明（富文本 HTML，已净化）；与公告相互独立 */
  productIntro: string;
  /** 客服 */
  service: { email: string; phone: string; wechat: string; hours: string; helpUrl: string };
  /** 官网 */
  website: { homepage: string; downloadPage: string; privacyUrl: string; termsUrl: string };
  /** 试用 */
  trial: { enabled: boolean; days: number; credits: number; oncePerUser: boolean };
  /** 特殊参数（运行时下发给客户端的键值，如 maxUploadMb） */
  params: Array<{ key: string; value: string; remark: string }>;
}

export interface ProductVersion {
  id: string;
  productId: string;
  version: string;
  platform: Platform;
  channel: Channel;
  /** 更新内容（富文本 HTML，已净化） */
  changelog: string;
  downloadUrl: string;
  forceUpdate: boolean;
  minSupported: string;
  status: 'PUBLISHED' | 'WITHDRAWN';
  publishedAt: string;
}

export interface ProductAnalytics {
  days: number;
  totals: { visits: number; downloads: number; activeUsers: number; paidUsers: number; revenueCents: number; avgRating: number };
  series: Array<{ date: string; visits: number; downloads: number; activeUsers: number; revenueCents: number }>;
  /** 转化漏斗：访问 → 下载 → 注册 → 开始试用 → 付费 */
  funnel: Array<{ stage: string; count: number }>;
  /** 定价：各套餐的价格、订单与收入 */
  pricing: Array<{
    planName: string;
    priceCents: number;
    periodMonths: number;
    orders: number;
    revenueCents: number;
    /** 套餐页访问 → 下单转化率（0-1） */
    conversionRate: number;
    refundRate: number;
  }>;
  /** 平台流量 */
  platforms: Array<{ platform: string; visits: number; downloads: number; paid: number }>;
  platformSeries: Array<{ date: string; windows: number; macos: number; linux: number; web: number }>;
  /** 流量来源 */
  channels: Array<{ channel: string; visits: number }>;
}

export interface ProductPlan {
  id: string;
  productId: string;
  name: string;
  periodMonths: number;
  priceCents: number;
  monthlyCredits: number;
  features: string[];
  active: boolean;
}

export type Locale = 'zh-CN' | 'en-US' | 'ja-JP';
export const LOCALES: Array<{ code: Locale; label: string }> = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
];

export interface ProductI18n {
  locale: Locale;
  name: string;
  tagline: string;
  description: string;
}

export interface ProductReview {
  id: string;
  productId: string;
  userEmail: string;
  rating: number;
  content: string;
  version: string;
  status: 'VISIBLE' | 'HIDDEN';
  reply: string;
  createdAt: string;
}

// ---------- 接口形状 ----------

export interface ProductApi {
  list(): Promise<Product[]>;
  create(body: Pick<Product, 'code' | 'name' | 'category' | 'description'>): Promise<Product>;
  update(id: string, body: Partial<Pick<Product, 'name' | 'category' | 'description'>>): Promise<Product>;
  remove(id: string): Promise<void>;

  release(id: string): Promise<ReleaseConfig>;
  saveRelease(id: string, body: Omit<ReleaseConfig, 'productId' | 'onlineAt'>): Promise<ReleaseConfig>;

  versions(id: string): Promise<ProductVersion[]>;
  publishVersion(
    id: string,
    body: Omit<ProductVersion, 'id' | 'productId' | 'status' | 'publishedAt'>
  ): Promise<ProductVersion>;
  withdrawVersion(id: string, versionId: string): Promise<void>;

  analytics(id: string, days: number): Promise<ProductAnalytics>;

  plans(id: string): Promise<ProductPlan[]>;
  savePlan(id: string, body: Omit<ProductPlan, 'id' | 'productId'> & { id?: string }): Promise<ProductPlan>;
  togglePlan(id: string, planId: string, active: boolean): Promise<void>;

  i18n(id: string): Promise<ProductI18n[]>;
  saveI18n(id: string, body: ProductI18n): Promise<ProductI18n>;

  reviews(id: string, params: { status?: string; rating?: number }): Promise<ProductReview[]>;
  setReviewStatus(id: string, reviewId: string, status: ProductReview['status']): Promise<void>;
  replyReview(id: string, reviewId: string, reply: string): Promise<void>;
}

// ---------- 真实接口 ----------

const realApi: ProductApi = {
  list: async () => (await api.get<{ items: Product[] }>('/products')).items,
  create: (b) => api.post('/products', b),
  update: (id, b) => api.patch(`/products/${id}`, b),
  remove: async (id) => {
    await api.del(`/products/${id}`);
  },

  release: (id) => api.get(`/products/${id}/release`),
  saveRelease: (id, b) => api.put(`/products/${id}/release`, b),

  versions: async (id) => (await api.get<{ items: ProductVersion[] }>(`/products/${id}/versions`)).items,
  publishVersion: (id, b) => api.post(`/products/${id}/versions`, b),
  withdrawVersion: async (id, vid) => {
    await api.post(`/products/${id}/versions/${vid}/withdraw`);
  },

  analytics: (id, days) => api.get(`/products/${id}/analytics`, { days }),

  plans: async (id) => (await api.get<{ items: ProductPlan[] }>(`/products/${id}/plans`)).items,
  savePlan: (id, b) => (b.id ? api.patch(`/products/${id}/plans/${b.id}`, b) : api.post(`/products/${id}/plans`, b)),
  togglePlan: async (id, pid, active) => {
    await api.post(`/products/${id}/plans/${pid}/active`, { active });
  },

  i18n: async (id) => (await api.get<{ items: ProductI18n[] }>(`/products/${id}/i18n`)).items,
  saveI18n: (id, b) => api.put(`/products/${id}/i18n/${b.locale}`, b),

  reviews: async (id, p) =>
    (await api.get<{ items: ProductReview[] }>(`/products/${id}/reviews`, { ...p })).items,
  setReviewStatus: async (id, rid, status) => {
    await api.post(`/products/${id}/reviews/${rid}/status`, { status });
  },
  replyReview: async (id, rid, reply) => {
    await api.post(`/products/${id}/reviews/${rid}/reply`, { reply });
  },
};

// ---------- 内存 mock ----------

const now = (): string => new Date().toISOString();
const daysAgo = (n: number): string => new Date(Date.now() - n * 86400000).toISOString();
let seq = 100;
const uid = (p: string): string => `${p}_${++seq}`;

const db = {
  products: [
    {
      id: 'prod_pdf',
      code: 'heyu-pdf',
      name: '合羽 PDF',
      category: '桌面应用',
      description: 'PDF 编辑、转换、压缩、OCR 一站式工具',
      status: 'ONLINE',
      createdAt: daysAgo(300),
      updatedAt: daysAgo(2),
    },
    {
      id: 'prod_scan',
      code: 'heyu-scan',
      name: '合羽扫描',
      category: '移动应用',
      description: '手机扫描与文档矫正',
      status: 'DRAFT',
      createdAt: daysAgo(40),
      updatedAt: daysAgo(10),
    },
  ] as Product[],
  releases: {
    prod_pdf: {
      productId: 'prod_pdf',
      status: 'ONLINE',
      onlineAt: daysAgo(280),
      maintenanceNotice: '<p>每周日 02:00-04:00 例行维护。</p>',
      productIntro: '<p><b>合羽 PDF</b>：PDF 编辑、转换、压缩、OCR 一站式工具。</p>',
      service: { email: 'support@heyu.example.com', phone: '400-000-0000', wechat: 'heyu_support', hours: '工作日 9:00-18:00', helpUrl: 'https://help.heyu.example.com' },
      website: { homepage: 'https://www.heyu.example.com', downloadPage: 'https://www.heyu.example.com/download', privacyUrl: 'https://www.heyu.example.com/privacy', termsUrl: 'https://www.heyu.example.com/terms' },
      trial: { enabled: true, days: 7, credits: 100, oncePerUser: true },
      params: [{ key: 'maxUploadMb', value: '200', remark: '单文件上传上限' }],
    },
    prod_scan: {
      productId: 'prod_scan',
      status: 'DRAFT',
      onlineAt: null,
      maintenanceNotice: '',
      productIntro: '',
      service: { email: '', phone: '', wechat: '', hours: '', helpUrl: '' },
      website: { homepage: '', downloadPage: '', privacyUrl: '', termsUrl: '' },
      trial: { enabled: false, days: 0, credits: 0, oncePerUser: true },
      params: [],
    },
  } as Record<string, ReleaseConfig>,
  versions: [
    {
      id: 'ver_1',
      productId: 'prod_pdf',
      version: '2.3.0',
      platform: 'windows',
      channel: 'stable',
      changelog: '<h3>新增</h3><ul><li>批量 OCR</li></ul><h3>修复</h3><ul><li>大文件压缩崩溃</li></ul>',
      downloadUrl: 'https://download.example.com/heyu-pdf-2.3.0.exe',
      forceUpdate: false,
      minSupported: '2.0.0',
      status: 'PUBLISHED',
      publishedAt: daysAgo(12),
    },
    {
      id: 'ver_2',
      productId: 'prod_pdf',
      version: '2.2.1',
      platform: 'macos',
      channel: 'stable',
      changelog: '<p>修复 Apple Silicon 启动慢</p>',
      downloadUrl: 'https://download.example.com/heyu-pdf-2.2.1.dmg',
      forceUpdate: false,
      minSupported: '2.0.0',
      status: 'PUBLISHED',
      publishedAt: daysAgo(40),
    },
  ] as ProductVersion[],
  plans: [
    {
      id: 'pp_1',
      productId: 'prod_pdf',
      name: '专业版·月付',
      periodMonths: 1,
      priceCents: 1990,
      monthlyCredits: 500,
      features: ['无限转换', '批量 OCR'],
      active: true,
    },
    {
      id: 'pp_2',
      productId: 'prod_pdf',
      name: '专业版·年付',
      periodMonths: 12,
      priceCents: 15900,
      monthlyCredits: 600,
      features: ['无限转换', '批量 OCR', '优先客服'],
      active: true,
    },
  ] as ProductPlan[],
  i18n: [
    {
      productId: 'prod_pdf',
      locale: 'zh-CN',
      name: '合羽 PDF',
      tagline: '更轻快的 PDF 工具箱',
      description: 'PDF 编辑、转换、压缩、OCR 一站式工具',
    },
    {
      productId: 'prod_pdf',
      locale: 'en-US',
      name: 'Heyu PDF',
      tagline: 'A lighter PDF toolbox',
      description: 'Edit, convert, compress and OCR PDFs in one place.',
    },
  ] as Array<ProductI18n & { productId: string }>,
  reviews: [
    {
      id: 'rv_1',
      productId: 'prod_pdf',
      userEmail: 'a***@qq.com',
      rating: 5,
      content: 'OCR 很准，批量处理省了很多时间。',
      version: '2.3.0',
      status: 'VISIBLE',
      reply: '',
      createdAt: daysAgo(3),
    },
    {
      id: 'rv_2',
      productId: 'prod_pdf',
      userEmail: 'b***@gmail.com',
      rating: 2,
      content: '压缩大文件偶尔卡住。',
      version: '2.2.1',
      status: 'VISIBLE',
      reply: '感谢反馈，2.3.0 已修复。',
      createdAt: daysAgo(15),
    },
    {
      id: 'rv_3',
      productId: 'prod_pdf',
      userEmail: 'c***@163.com',
      rating: 1,
      content: '垃圾广告 加微信xxx',
      version: '2.3.0',
      status: 'HIDDEN',
      reply: '',
      createdAt: daysAgo(6),
    },
  ] as ProductReview[],
};

const delay = <T>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 80));
const fail = (msg: string): never => {
  throw new Error(msg);
};

const mockApi: ProductApi = {
  list: () => delay(db.products),
  create: (b) => {
    if (db.products.some((p) => p.code === b.code)) fail('产品编码已存在');
    const p: Product = { ...b, id: uid('prod'), status: 'DRAFT', createdAt: now(), updatedAt: now() };
    db.products.unshift(p);
    db.releases[p.id] = {
      productId: p.id,
      status: 'DRAFT',
      onlineAt: null,
      maintenanceNotice: '',
      productIntro: '',
      service: { email: '', phone: '', wechat: '', hours: '', helpUrl: '' },
      website: { homepage: '', downloadPage: '', privacyUrl: '', termsUrl: '' },
      trial: { enabled: false, days: 0, credits: 0, oncePerUser: true },
      params: [],
    };
    return delay(p);
  },
  update: (id, b) => {
    const p = db.products.find((x) => x.id === id) ?? fail('产品不存在');
    Object.assign(p, b, { updatedAt: now() });
    return delay(p);
  },
  remove: (id) => {
    const p = db.products.find((x) => x.id === id) ?? fail('产品不存在');
    if (p.status === 'ONLINE') fail('在线产品不能删除，请先下线');
    db.products = db.products.filter((x) => x.id !== id);
    return delay(undefined);
  },

  release: (id) => delay(db.releases[id] ?? fail('产品不存在')),
  saveRelease: (id, b) => {
    const r = db.releases[id] ?? fail('产品不存在');
    if (b.status === 'ONLINE' && !db.versions.some((v) => v.productId === id && v.status === 'PUBLISHED'))
      fail('上线前至少需要发布一个版本');
    const wasOnline = r.status === 'ONLINE';
    if (b.trial.enabled && (b.trial.days < 1 || b.trial.days > 90)) fail('试用天数需在 1-90 之间');
    const keys = b.params.map((x) => x.key.trim());
    if (keys.some((k) => !/^[A-Za-z][A-Za-z0-9_.]{0,39}$/.test(k))) fail('参数键需以字母开头，仅含字母/数字/下划线/点');
    if (new Set(keys).size !== keys.length) fail('参数键重复');
    Object.assign(r, b);
    if (b.status === 'ONLINE' && !wasOnline) r.onlineAt = now();
    const p = db.products.find((x) => x.id === id);
    if (p) {
      p.status = b.status;
      p.updatedAt = now();
    }
    return delay(r);
  },

  versions: (id) => delay(db.versions.filter((v) => v.productId === id)),
  publishVersion: (id, b) => {
    if (!/^\d+\.\d+\.\d+$/.test(b.version)) fail('版本号需为 x.y.z');
    if (db.versions.some((v) => v.productId === id && v.version === b.version && v.platform === b.platform))
      fail('该平台已存在相同版本号');
    const v: ProductVersion = { ...b, id: uid('ver'), productId: id, status: 'PUBLISHED', publishedAt: now() };
    db.versions.unshift(v);
    return delay(v);
  },
  withdrawVersion: (_id, vid) => {
    const v = db.versions.find((x) => x.id === vid) ?? fail('版本不存在');
    v.status = 'WITHDRAWN';
    return delay(undefined);
  },

  analytics: (_id, days) => {
    const series = Array.from({ length: days }, (_, i) => {
      const k = days - 1 - i;
      const base = 120 + ((i * 37) % 60);
      return {
        date: daysAgo(k).slice(0, 10),
        visits: base * 9 + ((i * 71) % 300),
        downloads: base,
        activeUsers: base * 6 + ((i * 53) % 200),
        revenueCents: (base % 40) * 1990,
      };
    });
    const sum = (f: (s: (typeof series)[number]) => number): number => series.reduce((a, s) => a + f(s), 0);
    const visits = sum((s) => s.visits);
    const downloads = sum((s) => s.downloads);
    const registered = Math.round(downloads * 0.62);
    const trial = Math.round(registered * 0.45);
    const paid = Math.round(trial * 0.28);
    const orders = [0.55, 0.3, 0.15].map((r) => Math.round(paid * r));
    const planDefs = [
      ['专业版·月付', 1990, 1, 0.031, 0.04],
      ['专业版·年付', 15900, 12, 0.019, 0.02],
      ['旗舰版·年付', 29900, 12, 0.008, 0.015],
    ] as const;
    const wp = { windows: 0.68, macos: 0.24, linux: 0.05, web: 0.03 };
    return delay({
      days,
      totals: {
        visits,
        downloads,
        activeUsers: Math.max(...series.map((s) => s.activeUsers)),
        paidUsers: paid,
        revenueCents: sum((s) => s.revenueCents),
        avgRating: 4.3,
      },
      series,
      funnel: [
        { stage: '访问', count: visits },
        { stage: '下载', count: downloads },
        { stage: '注册', count: registered },
        { stage: '开始试用', count: trial },
        { stage: '付费', count: paid },
      ],
      pricing: planDefs.map(([planName, priceCents, periodMonths, conversionRate, refundRate], i) => ({
        planName,
        priceCents,
        periodMonths,
        orders: orders[i]!,
        revenueCents: orders[i]! * priceCents,
        conversionRate,
        refundRate,
      })),
      platforms: (Object.keys(wp) as Array<keyof typeof wp>).map((k) => ({
        platform: k,
        visits: Math.round(visits * wp[k]),
        downloads: Math.round(downloads * wp[k]),
        paid: Math.round(paid * wp[k] * (k === 'macos' ? 1.3 : k === 'windows' ? 0.9 : 1)),
      })),
      platformSeries: series.map((x, i) => ({
        date: x.date,
        windows: Math.round(x.visits * wp.windows),
        macos: Math.round(x.visits * wp.macos * (1 + (i % 5) / 20)),
        linux: Math.round(x.visits * wp.linux),
        web: Math.round(x.visits * wp.web),
      })),
      channels: [
        { channel: '官网直达', visits: Math.round(visits * 0.34) },
        { channel: '搜索引擎', visits: Math.round(visits * 0.31) },
        { channel: '应用商店', visits: Math.round(visits * 0.17) },
        { channel: '用户推荐', visits: Math.round(visits * 0.12) },
        { channel: '广告投放', visits: Math.round(visits * 0.06) },
      ],
    });
  },

  plans: (id) => delay(db.plans.filter((p) => p.productId === id)),
  savePlan: (id, b) => {
    if (b.priceCents < 0 || b.periodMonths < 1) fail('价格或周期不合法');
    if (b.id) {
      const p = db.plans.find((x) => x.id === b.id) ?? fail('套餐不存在');
      Object.assign(p, b);
      return delay(p);
    }
    const p: ProductPlan = { ...b, id: uid('pp'), productId: id };
    db.plans.push(p);
    return delay(p);
  },
  togglePlan: (_id, pid, active) => {
    const p = db.plans.find((x) => x.id === pid) ?? fail('套餐不存在');
    p.active = active;
    return delay(undefined);
  },

  i18n: (id) => delay(db.i18n.filter((x) => x.productId === id).map(({ productId: _p, ...r }) => r)),
  saveI18n: (id, b) => {
    const cur = db.i18n.find((x) => x.productId === id && x.locale === b.locale);
    if (cur) Object.assign(cur, b);
    else db.i18n.push({ ...b, productId: id });
    return delay(b);
  },

  reviews: (id, p) =>
    delay(
      db.reviews.filter(
        (r) =>
          r.productId === id && (!p.status || r.status === p.status) && (!p.rating || r.rating === p.rating)
      )
    ),
  setReviewStatus: (_id, rid, status) => {
    (db.reviews.find((x) => x.id === rid) ?? fail('评价不存在')).status = status;
    return delay(undefined);
  },
  replyReview: (_id, rid, reply) => {
    (db.reviews.find((x) => x.id === rid) ?? fail('评价不存在')).reply = reply;
    return delay(undefined);
  },
};

export const productApi: ProductApi = USE_MOCK ? mockApi : realApi;

/** 统一错误文案（mock 抛 Error，真实接口抛 ApiError，二者都有 message） */
export function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
