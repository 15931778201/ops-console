/**
 * 管理员详情（/admins/:id）：基本信息 + 角色/状态变更。
 * 保护规则（后端强制）：不能操作自己；系统至少保留一名在职 SUPER_ADMIN。变更需输入用户名二次确认。
 */

import { App, Button, Descriptions, Form, Select, Space, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, PageStack, RoleTag, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { api, type AdminRole, type AdminView } from '@/lib/api-client'
import { ROLE_LABELS } from '@/lib/permissions'

import { ROLE_OPTIONS } from './new'

type Change = Partial<{ role: AdminRole, status: 'ACTIVE' | 'DISABLED' }>

export default function AdminDetailPage() {
  const { id } = useParams()
  const { message } = App.useApp()
  const [form] = Form.useForm<{ role: AdminRole, status: 'ACTIVE' | 'DISABLED' }>()
  const [confirm, setConfirm] = useState<Change | null>(null)
  const { data: admin, loading, error, reload } = useRequest(async () => {
    const a = await api.get<AdminView>(`/admins/${id}`)
    form.setFieldsValue({ role: a.role, status: a.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' })
    return a
  }, [id], '加载失败')

  if (loading && !admin) return <Loading />
  if (!admin) return <div className="m-2"><ErrorAlert error={error ?? '管理员不存在'} /></div>

  const current = admin.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED'

  return (
    <PageStack>
      <Section title={`管理员详情 · ${admin.username}`} extra={<Link to="/admins"><Button>返回列表</Button></Link>}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="用户名"><span className="font-mono">{admin.username}</span></Descriptions.Item>
          <Descriptions.Item label="姓名">{admin.name}</Descriptions.Item>
          <Descriptions.Item label="角色"><RoleTag role={admin.role} /></Descriptions.Item>
          <Descriptions.Item label="状态">{admin.status === 'ACTIVE' ? <Tag color="success">在职</Tag> : <Tag color="error">已禁用</Tag>}</Descriptions.Item>
          <Descriptions.Item label="动态验证码">{admin.totpEnabled ? <Tag color="success">已绑定</Tag> : <Tag color="warning">未绑定</Tag>}</Descriptions.Item>
          <Descriptions.Item label="最近登录">{admin.lastLoginAt ? fmtTime(admin.lastLoginAt) : '从未'}{admin.lastLoginIp ? ` · ${admin.lastLoginIp}` : ''}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{fmtTime(admin.createdAt)}</Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="变更角色 / 状态">
        <div className="mb-3 text-xs opacity-60">保存后该账号的全部会话会被立即吊销。</div>
        <Form form={form} layout="vertical" className="max-w-md" onFinish={(v) => {
          const change: Change = {}
          if (v.role !== admin.role) change.role = v.role
          if (v.status !== current) change.status = v.status
          if (Object.keys(change).length > 0) setConfirm(change)
        }}>
          <Form.Item name="role" label="角色"><Select options={ROLE_OPTIONS} /></Form.Item>
          <Form.Item name="status" label="状态"><Select options={[{ value: 'ACTIVE', label: '在职' }, { value: 'DISABLED', label: '禁用' }]} /></Form.Item>
          <Space><Button type="primary" htmlType="submit">保存并吊销其会话</Button></Space>
        </Form>
      </Section>

      <ConfirmModal
        open={!!confirm}
        danger={confirm?.status === 'DISABLED'}
        title={confirm?.status === 'DISABLED' ? '禁用管理员' : '确认变更'}
        verifyText={admin.username}
        content={(
          <ul className="m-0 pl-5">
            {confirm?.role && <li>角色：{ROLE_LABELS[admin.role]} → {ROLE_LABELS[confirm.role]}</li>}
            {confirm?.status && <li>状态：{confirm.status === 'DISABLED' ? '禁用（立即吊销全部会话）' : '在职'}</li>}
          </ul>
        )}
        onCancel={() => setConfirm(null)}
        onOk={async () => {
          try {
            await api.put<AdminView>(`/admins/${admin.id}`, confirm)
            message.success(`已更新 ${admin.username}，其全部会话已被吊销`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '更新失败'))
          }
          setConfirm(null)
        }}
      />
    </PageStack>
  )
}
