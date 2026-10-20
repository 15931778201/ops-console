/**
 * 管理员账号列表（/admins）；新建 /admins/new；详情与变更 /admins/:id。权限：admin:manage（仅 SUPER_ADMIN）。
 */

import { Button, Table, Tag } from 'antd'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageCard, RoleTag, fmtTime } from '@/components/page'
import { usePagedList } from '@/hooks/usePagedList'
import { api, type AdminView, type Page } from '@/lib/api-client'

export default function AdminsPage() {
  const list = usePagedList<AdminView, object>(q => api.get<Page<AdminView>>('/admins', { page: q.page, pageSize: q.pageSize }), {})

  return (
    <PageCard title="管理员账号" extra={<Link to="/admins/new"><Button type="primary">新建管理员</Button></Link>}>
      <div className="mb-3 text-sm opacity-70">仅超级管理员可见。角色决定权限矩阵；新建账号首次登录必须绑定动态验证码。</div>
      <ErrorAlert error={list.error} />
      <Table<AdminView>
        rowKey="id"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        columns={[
          { title: '用户名', dataIndex: 'username', render: v => <span className="font-mono">{v}</span> },
          { title: '姓名', dataIndex: 'name' },
          { title: '角色', dataIndex: 'role', render: r => <RoleTag role={r} /> },
          { title: '状态', dataIndex: 'status', render: s => (s === 'ACTIVE' ? <Tag color="success">在职</Tag> : <Tag color="error">已禁用</Tag>) },
          { title: '动态验证码', dataIndex: 'totpEnabled', render: v => (v ? <Tag color="success">已绑定</Tag> : <Tag color="warning">未绑定</Tag>) },
          { title: '最近登录', dataIndex: 'lastLoginAt', render: v => (v ? fmtTime(v) : '从未') },
          { title: '操作', render: (_, a) => <Link to={`/admins/${a.id}`}><Button size="small">详情</Button></Link> },
        ]}
      />
    </PageCard>
  )
}
