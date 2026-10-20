/**
 * 新建管理员（/admins/new）。创建后首次登录强制绑定动态验证码。
 */

import { Button, Form, Input, Select, Space } from 'antd'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { ErrorAlert, PageCard, errText } from '@/components/page'
import { ApiError, api, type AdminRole, type AdminView } from '@/lib/api-client'
import { ROLE_LABELS } from '@/lib/permissions'

export const ADMIN_ROLES: AdminRole[] = ['SUPER_ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR']
export const ROLE_OPTIONS = ADMIN_ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] }))

export default function AdminCreatePage() {
  const navigate = useNavigate()
  const [form] = Form.useForm<{ username: string, name: string, password: string, role: AdminRole }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (v: { username: string, name: string, password: string, role: AdminRole }): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const created = await api.post<AdminView>('/admins', v)
      navigate(`/admins/${created.id}`, { replace: true })
    }
    catch (e) {
      if (e instanceof ApiError) {
        const fe = e.fieldErrors()
        form.setFields(Object.entries(fe).filter(([k]) => ['username', 'name', 'password', 'role'].includes(k)).map(([name, msg]) => ({ name: name as 'username', errors: [msg] })))
      }
      setError(errText(e, '创建失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <PageCard title="新建管理员" extra={<Link to="/admins"><Button>返回列表</Button></Link>}>
      <ErrorAlert error={error} />
      <Form form={form} layout="vertical" className="max-w-xl" initialValues={{ role: 'OPERATOR' }} onFinish={v => void submit(v)}>
        <Form.Item name="username" label="用户名" extra="3-32 位字母、数字、. 或 _" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item>
        <Form.Item name="name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="password" label="初始密码" extra="至少 12 位，含大小写字母与数字，且不得包含用户名" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="role" label="角色"><Select options={ROLE_OPTIONS} /></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={busy}>创建</Button></Space>
      </Form>
    </PageCard>
  )
}
