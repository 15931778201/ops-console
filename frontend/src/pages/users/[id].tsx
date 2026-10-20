/**
 * 用户详情（/users/:id）
 * 权限：user:read；禁用/恢复 user:disable；强制下线 session:revoke。
 */

import { App, Button, Card, Col, Descriptions, Row, Space, Statistic, Table } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, OrderStatusTag, PageStack, Section, errText, fmtTime, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { api } from '@/lib/api-client'
import { useAuthStore } from '@/stores/authStore'

import type { AdminUserDetail } from './index'

import { UserStatusTag } from '@/components/page'

export default function UserDetailPage() {
  const { id } = useParams()
  const { message } = App.useApp()
  const has = useAuthStore(s => s.has)
  const [suspending, setSuspending] = useState(false)
  const { data, loading, error, reload } = useRequest(() => api.get<AdminUserDetail>(`/users/${id}`), [id], '加载用户详情失败')

  if (loading && !data) return <Loading />
  if (!data) return <div className="m-2"><ErrorAlert error={error ?? '用户不存在'} /></div>

  const u = data.user
  const label = u.email ?? u.phone ?? u.id

  const act = async (fn: () => Promise<string>, fail: string): Promise<void> => {
    try {
      message.success(await fn())
      await reload()
    }
    catch (e) {
      message.error(errText(e, fail))
    }
  }

  return (
    <PageStack>
      <Section
        title={`用户详情 · ${label}`}
        extra={(
          <Space>
            <Link to="/users"><Button>返回列表</Button></Link>
            {has('session:revoke') && u.status !== 'DELETED' && (
              <Button onClick={() => void act(async () => `已强制下线，吊销 ${(await api.post<{ revokedSessions: number }>(`/users/${u.id}/sessions/revoke`)).revokedSessions} 个会话`, '强制下线失败')}>强制下线</Button>
            )}
            {has('user:disable') && u.status === 'ACTIVE' && <Button danger onClick={() => setSuspending(true)}>禁用</Button>}
            {has('user:disable') && u.status === 'SUSPENDED' && (
              <Button onClick={() => void act(async () => { await api.post(`/users/${u.id}/status`, { status: 'ACTIVE', reason: '运营后台恢复账号' }); return '已恢复该用户（用户需重新登录）' }, '恢复失败')}>恢复</Button>
            )}
          </Space>
        )}
      >
        <Row gutter={[12, 12]} className="!mb-4">
          {[['积分余额', data.creditAccount?.balance], ['奖励积分', data.creditAccount?.bonusBalance], ['周期额度', data.creditAccount?.monthlyQuota], ['活跃会话', data.activeSessions]].map(([t, v]) => (
            <Col key={t as string} xs={12} md={6}><Card size="small"><Statistic title={t as string} value={(v as number | undefined) ?? 0} /></Card></Col>
          ))}
        </Row>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="姓名">{u.name ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="邮箱 / 手机">{u.email ?? u.phone ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="套餐">{u.planId}</Descriptions.Item>
          <Descriptions.Item label="套餐到期">{fmtTime(u.planExpiresAt)}</Descriptions.Item>
          <Descriptions.Item label="状态"><UserStatusTag status={u.status} /></Descriptions.Item>
          <Descriptions.Item label="注册时间">{fmtTime(u.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="最近登录">{u.lastLoginAt ? fmtTime(u.lastLoginAt) : '从未'}</Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="最近订单">
        <Table
          rowKey="orderNo"
          size="small"
          pagination={false}
          dataSource={data.recentOrders}
          locale={{ emptyText: '暂无订单' }}
          columns={[
            { title: '订单号', dataIndex: 'orderNo', render: v => <Link to={`/orders/${v}`} className="font-mono">{v}</Link> },
            { title: '金额', dataIndex: 'amountCents', render: yuan },
            { title: '状态', dataIndex: 'status', render: s => <OrderStatusTag status={s} /> },
            { title: '时间', dataIndex: 'createdAt', render: fmtTime },
          ]}
        />
      </Section>

      <ConfirmModal
        open={suspending}
        danger
        title="禁用用户"
        okText="确认禁用"
        content={<p>即将禁用 <b>{label}</b>。禁用后该用户所有设备立即掉线（会话被吊销），数据保留可恢复。</p>}
        reasonLabel="禁用原因（必填，会写入审计日志）"
        reasonPlaceholder="例如：疑似盗刷/违规内容/用户申诉核实"
        onCancel={() => setSuspending(false)}
        onOk={async (reason) => {
          setSuspending(false)
          await act(async () => `已禁用 ${label}，吊销 ${(await api.post<{ revokedSessions: number }>(`/users/${u.id}/status`, { status: 'SUSPENDED', reason })).revokedSessions} 个会话`, '禁用失败')
        }}
      />
    </PageStack>
  )
}
