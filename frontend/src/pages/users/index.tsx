/**
 * 用户列表（/users）；详情见 /users/:id。
 * 权限：user:read；禁用/恢复 user:disable；强制下线 session:revoke。
 */

import { App, Button, Form, Input, Select, Space, Table } from 'antd'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, PageCard, UserStatusTag, errText, fmtTime } from '@/components/page'
import { usePagedList } from '@/hooks/usePagedList'
import { api, type Page } from '@/lib/api-client'
import { useAuthStore } from '@/stores/authStore'

export interface AdminUserItem {
  id: string
  email: string | null
  phone: string | null
  name: string | null
  planId: string
  planExpiresAt: string | null
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED'
  balance: number
  bonusBalance: number
  createdAt: string
  lastLoginAt: string | null
}

export interface AdminUserDetail {
  user: AdminUserItem & { updatedAt?: string }
  creditAccount: { balance: number, bonusBalance: number, monthlyQuota: number } | null
  activeSessions: number
  recentOrders: Array<{ orderNo: string, amountCents: number, status: string, createdAt: string }>
}

interface Filters { search?: string, status?: string, planId?: string }

export default function UsersPage() {
  const { message } = App.useApp()
  const has = useAuthStore(s => s.has)
  const [sp] = useSearchParams()
  const [form] = Form.useForm<Filters>()
  const [suspending, setSuspending] = useState<AdminUserItem | null>(null)

  const list = usePagedList<AdminUserItem, Filters>(
    q => api.get<Page<AdminUserItem>>('/users', { page: q.page, pageSize: q.pageSize, search: q.search?.trim() || undefined, status: q.status || undefined, planId: q.planId?.trim() || undefined }),
    { status: sp.get('status') ?? undefined, search: sp.get('search') ?? undefined },
  )

  const act = async (fn: () => Promise<string>, fail: string): Promise<void> => {
    try {
      message.success(await fn())
      await list.reload()
    }
    catch (e) {
      message.error(errText(e, fail))
    }
  }

  return (
    <PageCard title="用户管理">
      <ErrorAlert error={list.error} />
      <Form form={form} layout="inline" className="!mb-4" initialValues={list.filters} onFinish={v => list.setFilters(v)}>
        <Form.Item name="search" label="搜索"><Input allowClear placeholder="邮箱 / 手机 / 姓名" /></Form.Item>
        <Form.Item name="status" label="状态">
          <Select allowClear placeholder="全部" className="!w-28" options={[{ value: 'ACTIVE', label: '正常' }, { value: 'SUSPENDED', label: '已禁用' }, { value: 'DELETED', label: '已删除' }]} />
        </Form.Item>
        <Form.Item name="planId" label="套餐"><Input allowClear placeholder="free / pro…" className="!w-32" /></Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">查询</Button>
          <Button onClick={() => { form.resetFields(); list.setFilters({}) }}>重置</Button>
        </Space>
      </Form>

      <Table<AdminUserItem>
        rowKey="id"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '用户', render: (_, u) => (<div><div>{u.name ?? '—'}</div><div className="font-mono text-xs opacity-60">{u.email ?? u.phone ?? u.id}</div></div>) },
          { title: '套餐', dataIndex: 'planId' },
          { title: '状态', dataIndex: 'status', render: s => <UserStatusTag status={s} /> },
          { title: '积分', render: (_, u) => (<>{u.balance}{u.bonusBalance > 0 && <span className="opacity-60">{` (+${u.bonusBalance} 奖励)`}</span>}</>) },
          { title: '注册时间', dataIndex: 'createdAt', render: v => new Date(v).toLocaleDateString() },
          { title: '最近登录', dataIndex: 'lastLoginAt', render: v => (v ? fmtTime(v) : '从未') },
          {
            title: '操作',
            fixed: 'right',
            render: (_, u) => (
              <Space size="small">
                <Link to={`/users/${u.id}`}><Button size="small">详情</Button></Link>
                {has('session:revoke') && u.status !== 'DELETED' && (
                  <Button size="small" onClick={() => void act(async () => `已强制下线，吊销 ${(await api.post<{ revokedSessions: number }>(`/users/${u.id}/sessions/revoke`)).revokedSessions} 个会话`, '强制下线失败')}>强制下线</Button>
                )}
                {has('user:disable') && u.status === 'ACTIVE' && <Button size="small" danger onClick={() => setSuspending(u)}>禁用</Button>}
                {has('user:disable') && u.status === 'SUSPENDED' && (
                  <Button size="small" onClick={() => void act(async () => { await api.post(`/users/${u.id}/status`, { status: 'ACTIVE', reason: '运营后台恢复账号' }); return '已恢复该用户（会话不会自动恢复，用户需重新登录）' }, '恢复失败')}>恢复</Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <ConfirmModal
        open={!!suspending}
        danger
        title="禁用用户"
        okText="确认禁用"
        content={<p>即将禁用 <b>{suspending?.email ?? suspending?.phone ?? suspending?.id}</b>。禁用后该用户所有设备立即掉线（会话被吊销），数据保留可恢复。</p>}
        reasonLabel="禁用原因（必填，会写入审计日志）"
        reasonPlaceholder="例如：疑似盗刷/违规内容/用户申诉核实"
        onCancel={() => setSuspending(null)}
        onOk={async (reason) => {
          const u = suspending!
          setSuspending(null)
          await act(async () => `已禁用 ${u.email ?? u.phone ?? u.id}，吊销 ${(await api.post<{ revokedSessions: number }>(`/users/${u.id}/status`, { status: 'SUSPENDED', reason })).revokedSessions} 个会话`, '禁用失败')
        }}
      />
    </PageCard>
  )
}
