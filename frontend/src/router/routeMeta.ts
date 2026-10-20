/**
 * 路由元数据：标题（面包屑）、所属菜单项、权限。
 * 路径使用与文件路由一致的 `:param` 写法；匹配时静态路径优先于动态路径。
 * 前端权限仅用于入口与路由拦截，真正的拦截在后端 RBAC。
 */

import type { Permission } from '@/lib/permissions'

export interface RouteMeta {
  path: string
  title: string
  /** 父级页面路径（用于面包屑），如详情页的列表页 */
  parent?: string
  /** 侧边栏选中项（默认等于 path 或其 parent 的 menu） */
  menu?: string
  /** 任一权限命中即可访问 */
  anyOf?: Permission[]
  public?: boolean
  layout?: 'blank'
}

const PLAN: Permission[] = ['plan:read', 'plan:write']
const RULE_OR_PLAN: Permission[] = ['plan:read', 'rule:read', 'plan:write', 'rule:write']
const ALERT: Permission[] = ['alert:read', 'alert:manage']

export const ROUTE_META: RouteMeta[] = [
  { path: '/login', title: '登录', public: true, layout: 'blank' },
  { path: '/exception/403', title: '403', layout: 'blank' },
  { path: '/exception/404', title: '404', layout: 'blank' },
  { path: '/exception/500', title: '500', layout: 'blank' },

  { path: '/', title: '仪表盘', anyOf: ['dashboard:read'] },
  { path: '/settings/security', title: '我的安全设置' },

  { path: '/users', title: '用户管理', anyOf: ['user:read'] },
  { path: '/users/:id', title: '用户详情', parent: '/users', anyOf: ['user:read'] },
  { path: '/orders', title: '订单管理', anyOf: ['order:read'] },
  { path: '/orders/:orderNo', title: '订单详情', parent: '/orders', anyOf: ['order:read'] },
  { path: '/reconcile', title: '对账工作台', anyOf: ['reconcile:read'] },
  { path: '/reconcile/:id', title: '差异详情', parent: '/reconcile', anyOf: ['reconcile:read'] },
  { path: '/ledger', title: '积分账本', anyOf: ['credit:read'] },
  { path: '/ledger/anomalies', title: '异常账户', parent: '/ledger', anyOf: ['credit:read'] },
  { path: '/ledger/accounts/:userId', title: '账户详情', parent: '/ledger/anomalies', menu: '/ledger', anyOf: ['credit:read'] },
  { path: '/approvals', title: '审批中心', anyOf: ['approval:read'] },
  { path: '/approvals/new', title: '提交调账申请', parent: '/approvals', anyOf: ['credit:adjust:apply'] },
  { path: '/approvals/:id', title: '审批详情', parent: '/approvals', anyOf: ['approval:read'] },

  { path: '/products', title: '产品管理', anyOf: PLAN },
  { path: '/products/new', title: '新建产品', parent: '/products', anyOf: ['plan:write'] },
  { path: '/products/:id', title: '产品详情', parent: '/products', anyOf: PLAN },
  { path: '/products/:id/edit', title: '编辑产品', parent: '/products/:id', menu: '/products', anyOf: ['plan:write'] },
  { path: '/products/release', title: '上线配置', anyOf: PLAN },
  { path: '/products/versions', title: '版本管理', anyOf: PLAN },
  { path: '/products/versions/new', title: '发布版本', parent: '/products/versions', anyOf: ['plan:write'] },
  { path: '/products/versions/:pid/:vid', title: '版本详情', parent: '/products/versions', anyOf: PLAN },
  { path: '/products/analytics', title: '数据分析', anyOf: PLAN },
  { path: '/products/plans', title: '产品套餐', anyOf: PLAN },
  { path: '/products/plans/new', title: '新增套餐', parent: '/products/plans', anyOf: ['plan:write'] },
  { path: '/products/plans/:pid/:planId', title: '编辑套餐', parent: '/products/plans', anyOf: ['plan:write'] },
  { path: '/products/i18n', title: '多语言配置', anyOf: PLAN },
  { path: '/products/reviews', title: '评价列表', anyOf: PLAN },
  { path: '/products/reviews/:pid/:rid', title: '评价详情', parent: '/products/reviews', anyOf: PLAN },

  { path: '/catalog/plans', title: '套餐与规则', anyOf: RULE_OR_PLAN },
  { path: '/catalog/plans/:id', title: '套餐详情', parent: '/catalog/plans', anyOf: RULE_OR_PLAN },
  { path: '/catalog/rules', title: '计费规则', parent: '/catalog/plans', menu: '/catalog/plans', anyOf: RULE_OR_PLAN },
  { path: '/catalog/rules/:toolSlug', title: '规则详情', parent: '/catalog/rules', menu: '/catalog/plans', anyOf: RULE_OR_PLAN },
  { path: '/flags', title: '系统开关', anyOf: ['flag:read', 'flag:write'] },

  { path: '/alerts', title: '监控告警', anyOf: ALERT },
  { path: '/alerts/events/:id', title: '告警详情', parent: '/alerts', anyOf: ALERT },
  { path: '/alerts/rules', title: '规则清单', parent: '/alerts', menu: '/alerts', anyOf: ALERT },
  { path: '/alerts/rules/:key', title: '规则详情', parent: '/alerts/rules', menu: '/alerts', anyOf: ALERT },
  { path: '/alerts/stats', title: '统计复盘', parent: '/alerts', menu: '/alerts', anyOf: ALERT },
  { path: '/audit', title: '审计日志', anyOf: ['audit:read'] },
  { path: '/audit/:id', title: '审计详情', parent: '/audit', anyOf: ['audit:read'] },
  { path: '/admins', title: '管理员账号', anyOf: ['admin:manage'] },
  { path: '/admins/new', title: '新建管理员', parent: '/admins', anyOf: ['admin:manage'] },
  { path: '/admins/:id', title: '管理员详情', parent: '/admins', anyOf: ['admin:manage'] },
]

interface Compiled {
  meta: RouteMeta
  re: RegExp
  dynamic: number
}

const compiled: Compiled[] = ROUTE_META.map((meta) => {
  const segs = meta.path.split('/').filter(Boolean)
  const dynamic = segs.filter(s => s.startsWith(':')).length
  const body = segs.map(s => (s.startsWith(':') ? '[^/]+' : s)).join('/')
  return { meta, re: new RegExp(`^/${body}/?$`), dynamic }
}).sort((a, b) => a.dynamic - b.dynamic)

export function getRouteMeta(pathname: string): RouteMeta | null {
  return compiled.find(c => c.re.test(pathname))?.meta ?? null
}

export function findByPattern(path: string): RouteMeta | undefined {
  return ROUTE_META.find(m => m.path === path)
}

/** 侧边栏选中的菜单路径 */
export function getMenuPath(meta: RouteMeta | null): string | null {
  let cur: RouteMeta | undefined | null = meta
  while (cur) {
    if (cur.menu) return cur.menu
    if (!cur.parent) return cur.path
    cur = findByPattern(cur.parent)
  }
  return null
}

/** 面包屑链（从根到当前） */
export function getBreadcrumb(meta: RouteMeta | null): RouteMeta[] {
  const chain: RouteMeta[] = []
  let cur: RouteMeta | undefined | null = meta
  while (cur) {
    chain.unshift(cur)
    cur = cur.parent ? findByPattern(cur.parent) : null
  }
  return chain
}
