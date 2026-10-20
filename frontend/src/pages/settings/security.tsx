/**
 * 我的安全设置（/settings/security）
 * 能力：会话列表 / 吊销指定会话 / 全部下线 / 修改密码 / 重绑动态验证码。
 * 修改密码成功后全部会话失效（含当前）；重绑 TOTP 需先通过密码复核，确认成功后才替换旧 secret。
 */

import { Alert, App, Button, Descriptions, Form, Input, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, PageStack, RoleTag, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { ApiError, clearTokens, type AdminSessionView } from '@/lib/api-client'
import { adminAuthApi } from '@/lib/auth-api'
import { useAuthStore } from '@/stores/authStore'

export default function SecurityPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const admin = useAuthStore(s => s.admin)
  const loadMe = useAuthStore(s => s.loadMe)
  const [pwdForm] = Form.useForm<{ oldPassword: string, newPassword: string, confirmPassword: string }>()
  const [codeForm] = Form.useForm<{ code: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revokeAll, setRevokeAll] = useState(false)
  const [rebindAsk, setRebindAsk] = useState(false)
  const [rebind, setRebind] = useState<{ token: string, secret: string, url: string } | null>(null)
  const [newCodes, setNewCodes] = useState<string[]>([])

  const sessions = useRequest(() => adminAuthApi.sessions(), [], '加载会话失败')

  const guard = async (fn: () => Promise<void>, fail: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    }
    catch (e) {
      setError(errText(e, fail))
    }
    finally {
      setBusy(false)
    }
  }

  const changePassword = (v: { oldPassword: string, newPassword: string }): Promise<void> =>
    guard(async () => {
      await adminAuthApi.changePassword(v.oldPassword, v.newPassword)
      clearTokens()
      useAuthStore.setState({ admin: null, permissions: [] })
      navigate('/login', { replace: true })
    }, '修改失败')

  return (
    <PageStack>
      <ErrorAlert error={error || sessions.error} />

      <Section title="账号信息">
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="用户名"><span className="font-mono">{admin?.username}</span></Descriptions.Item>
          <Descriptions.Item label="姓名">{admin?.name}</Descriptions.Item>
          <Descriptions.Item label="角色">{admin && <RoleTag role={admin.role} />}</Descriptions.Item>
          <Descriptions.Item label="动态验证码">{admin?.totpEnabled ? <Tag color="success">已绑定</Tag> : <Tag color="warning">未绑定</Tag>}</Descriptions.Item>
          <Descriptions.Item label="最近登录">{fmtTime(admin?.lastLoginAt)}</Descriptions.Item>
          <Descriptions.Item label="最近登录 IP"><span className="font-mono">{admin?.lastLoginIp ?? '—'}</span></Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="登录会话" extra={<Button danger onClick={() => setRevokeAll(true)}>全部下线</Button>}>
        <div className="mb-2 text-xs opacity-60">发现陌生设备请立即全部下线并重绑动态验证码。30 分钟无操作会自动登出。</div>
        <Table<AdminSessionView>
          rowKey="id"
          size="small"
          pagination={false}
          loading={sessions.loading}
          dataSource={sessions.data?.items ?? []}
          locale={{ emptyText: '暂无活跃会话' }}
          columns={[
            { title: '设备 / IP', render: (_, s) => (<div><div className="max-w-xs truncate font-mono">{s.userAgent ?? '未知设备'}</div><div className="font-mono text-xs opacity-60">{s.ip ?? '—'}</div></div>) },
            { title: '创建时间', dataIndex: 'createdAt', render: fmtTime },
            { title: '最近使用', dataIndex: 'lastUsedAt', render: fmtTime },
            { title: '过期时间', dataIndex: 'expiresAt', render: fmtTime },
            {
              title: '操作',
              render: (_, s) => s.id === sessions.data?.currentSessionId
                ? <Tag color="processing">当前会话</Tag>
                : <Button size="small" disabled={busy} onClick={() => void guard(async () => { await adminAuthApi.revokeSession(s.id); message.success('已吊销该会话'); await sessions.reload() }, '吊销失败')}>吊销</Button>,
            },
          ]}
        />
      </Section>

      <Section title="修改密码">
        <div className="mb-3 text-xs opacity-60">修改成功后所有设备需重新登录。密码策略：至少 12 位，含大小写字母与数字，且不得包含用户名。</div>
        <Form form={pwdForm} layout="vertical" className="max-w-md" onFinish={v => void changePassword(v)}>
          <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, v) => (!v || getFieldValue('newPassword') === v ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致'))) })]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>修改密码并全部下线</Button>
        </Form>
      </Section>

      <Section title="重绑动态验证码">
        <div className="mb-3 text-xs opacity-60">换手机或丢失验证器时使用。需先通过密码复核；确认成功后旧码立即失效。</div>
        {newCodes.length > 0
          ? (
              <>
                <Alert type="warning" showIcon className="!mb-3" message="重绑成功。旧的恢复码已全部失效，请保存下方新的恢复码（仅显示这一次）。" />
                <div className="mb-4 grid grid-cols-2 gap-2 font-mono md:grid-cols-5">{newCodes.map(c => <div key={c} className="rounded bg-black/5 px-2 py-1 text-center dark:bg-white/10">{c}</div>)}</div>
                <Button type="primary" onClick={() => setNewCodes([])}>我已保存</Button>
              </>
            )
          : !rebind
              ? <Button onClick={() => setRebindAsk(true)}>发起重绑</Button>
              : (
                  <Form
                    form={codeForm}
                    layout="vertical"
                    className="max-w-md"
                    onFinish={v => void guard(async () => {
                      const r = await adminAuthApi.confirmTotp(rebind.token, v.code.trim())
                      setNewCodes(r.recoveryCodes)
                      setRebind(null)
                      await loadMe()
                    }, '重绑失败，请确认新 App 的码是否正确')}
                  >
                    <Alert type="warning" showIcon className="!mb-3" message="请在身份验证器 App 中删除旧条目并录入下方新密钥，然后输入新 App 显示的 6 位码。" />
                    <div className="mb-2 text-sm opacity-70">新 TOTP 密钥（Base32）</div>
                    <div className="mb-3 break-all rounded bg-black/5 p-2 font-mono dark:bg-white/10">{rebind.secret}</div>
                    <div className="mb-1 text-sm opacity-70">otpauth 链接</div>
                    <div className="mb-3 break-all rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">{rebind.url}</div>
                    <Form.Item name="code" label="新 App 显示的 6 位码" rules={[{ required: true }]}><Input maxLength={6} inputMode="numeric" /></Form.Item>
                    <Space><Button type="primary" htmlType="submit" loading={busy}>完成重绑</Button></Space>
                  </Form>
                )}
      </Section>

      <ConfirmModal
        open={revokeAll}
        danger
        title="全部下线"
        okText="全部下线"
        verifyText="下线全部"
        content={<p>将吊销你名下<b>全部</b>会话（包括当前设备），你需要重新登录。如怀疑账号被盗，请同时重置密码并重绑动态验证码。</p>}
        onCancel={() => setRevokeAll(false)}
        onOk={async () => {
          try {
            const r = await adminAuthApi.revokeAllSessions()
            clearTokens()
            useAuthStore.setState({ admin: null, permissions: [] })
            message.success(`已吊销 ${r.revoked} 个会话，请重新登录`)
            navigate('/login', { replace: true })
          }
          catch (e) {
            setError(errText(e, '操作失败'))
          }
          setRevokeAll(false)
        }}
      />

      <RebindConfirm
        open={rebindAsk}
        onCancel={() => setRebindAsk(false)}
        onVerified={(token, secret, url) => {
          setRebind({ token, secret, url })
          setRebindAsk(false)
          message.info('请在身份验证器 App 中录入新密钥，然后输入 6 位码完成重绑')
        }}
        onError={e => { setError(errText(e, '发起重绑失败（请确认密码）')); setRebindAsk(false) }}
      />
    </PageStack>
  )
}

/** 密码复核后发起重绑 */
function RebindConfirm({ open, onCancel, onVerified, onError }: { open: boolean, onCancel: () => void, onVerified: (token: string, secret: string, url: string) => void, onError: (e: unknown) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <ConfirmModal
      open={open}
      title="重绑动态验证码"
      okText="验证密码"
      content={(
        <>
          <p>请输入当前登录密码进行复核。通过后会生成新的密钥，确认成功前旧验证码仍然有效。</p>
          <Input.Password value={password} onChange={e => setPassword(e.target.value)} placeholder="当前密码" autoComplete="current-password" disabled={busy} />
        </>
      )}
      onCancel={onCancel}
      onOk={async () => {
        setBusy(true)
        try {
          const r = await adminAuthApi.rebind(password)
          const b = await adminAuthApi.bindTotp(r.mfaToken)
          setPassword('')
          onVerified(r.mfaToken, b.secret, b.otpauthUrl)
        }
        catch (e) {
          onError(e instanceof ApiError ? e : e)
        }
        finally {
          setBusy(false)
        }
      }}
    />
  )
}
