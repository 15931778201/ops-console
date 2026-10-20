import type { ReactNode } from 'react'

import {
  AppstoreOutlined,
  DashboardOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'

import type { Permission } from '@/lib/permissions'

export interface MenuLeaf {
  path: string
  title: string
  /** 任一权限命中即可见；空数组表示登录即可见 */
  perms: Permission[]
}

export interface MenuGroup {
  key: string
  title: string
  icon: ReactNode
  /** 只有一项且无需分组时，直接作为一级菜单 */
  children: MenuLeaf[]
}

const PLAN: Permission[] = ['plan:read', 'plan:write']

export const MENU_GROUPS: MenuGroup[] = [
  {
    key: 'overview',
    title: '概览',
    icon: <DashboardOutlined />,
    children: [{ path: '/', title: '仪表盘', perms: ['dashboard:read'] }],
  },
  {
    key: 'finance',
    title: '用户与资金',
    icon: <TeamOutlined />,
    children: [
      { path: '/users', title: '用户管理', perms: ['user:read'] },
      { path: '/orders', title: '订单管理', perms: ['order:read'] },
      { path: '/reconcile', title: '对账工作台', perms: ['reconcile:read'] },
      { path: '/ledger', title: '积分账本', perms: ['credit:read'] },
      { path: '/approvals', title: '审批中心', perms: ['approval:read'] },
    ],
  },
  {
    key: 'product',
    title: '产品中心',
    icon: <AppstoreOutlined />,
    children: [
      { path: '/products', title: '产品管理', perms: PLAN },
      { path: '/products/release', title: '上线配置', perms: PLAN },
      { path: '/products/versions', title: '版本管理', perms: PLAN },
      { path: '/products/analytics', title: '数据分析', perms: PLAN },
      { path: '/products/plans', title: '产品套餐', perms: PLAN },
      { path: '/products/i18n', title: '多语言配置', perms: PLAN },
      { path: '/products/reviews', title: '评价列表', perms: PLAN },
    ],
  },
  {
    key: 'config',
    title: '运营配置',
    icon: <SettingOutlined />,
    children: [
      { path: '/catalog/plans', title: '套餐与规则', perms: ['plan:read', 'rule:read', 'plan:write', 'rule:write'] },
      { path: '/flags', title: '系统开关', perms: ['flag:read', 'flag:write'] },
    ],
  },
  {
    key: 'system',
    title: '系统',
    icon: <SafetyCertificateOutlined />,
    children: [
      { path: '/alerts', title: '监控告警', perms: ['alert:read', 'alert:manage'] },
      { path: '/audit', title: '审计日志', perms: ['audit:read'] },
      { path: '/admins', title: '管理员账号', perms: ['admin:manage'] },
      { path: '/settings/security', title: '我的安全设置', perms: [] },
    ],
  },
]

