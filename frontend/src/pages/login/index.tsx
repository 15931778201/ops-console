/**
 * 两步登录（/login）：
 *   1. 用户名 + 密码 → mfaToken（5 分钟一次性，仅存本页 state）
 *   2a. 已绑定 → 输入 TOTP 码或恢复码
 *   2b. 未绑定（首次登录）→ 展示 secret 与 otpauth URL → 输入 App 码 → 启用 TOTP → 展示恢复码（仅一次）
 * mfaToken 不进 URL、不进存储。Mock 模式：任意账号密码，验证码 123456。
 */

import { LockOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, Typography } from 'antd'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { Icon } from '@/components/icon'
import { Wave } from '@/components/login'
import { ThemeToggle } from '@/components/common'
import { API_MOCK, ApiError } from '@/lib/api-client'
import { adminAuthApi } from '@/lib/auth-api'
import { safeRedirect } from '@/lib/safe-redirect'
import { useAuthStore } from '@/stores/authStore'

type Step = 'password' | 'totp' | 'bind' | 'recovery'

export default function Login() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const redirect = safeRedirect(params.get('redirect')).startsWith('/login') ? '/' : safeRedirect(params.get('redirect'))
  const loadMe = useAuthStore(s => s.loadMe)

  const [step, setStep] = useState<Step>('password')
  const [username, setUsername] = useState('')
  const [mfaToken, setMfaToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [bind, setBind] = useState({ secret: '', url: '' })
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])

  const fail = (err: unknown): void => setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '网络异常，请稍后重试')

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    }
    catch (e) {
      fail(e)
    }
    finally {
      setBusy(false)
    }
  }

  const onPassword = (v: { username: string, password: string }): Promise<void> =>
    run(async () => {
      const name = v.username.trim()
      const r = await adminAuthApi.loginPassword(name, v.password)
      setUsername(name)
      setMfaToken(r.mfaToken)
      if (r.mustBindTotp) {
        const b = await adminAuthApi.bindTotp(r.mfaToken)
        setBind({ secret: b.secret, url: b.otpauthUrl })
        setStep('bind')
      }
      else {
        setStep('totp')
      }
    })

  const onTotp = (v: { code: string }): Promise<void> =>
    run(async () => {
      await adminAuthApi.loginTotp(mfaToken, v.code.trim(), username)
      await loadMe()
      navigate(redirect, { replace: true })
    })

  const onBind = (v: { code: string }): Promise<void> =>
    run(async () => {
      const r = await adminAuthApi.confirmTotp(mfaToken, v.code.trim())
      setRecoveryCodes(r.recoveryCodes)
      setStep('recovery')
    })

  const finish = (): Promise<void> =>
    run(async () => {
      await loadMe()
      navigate(redirect, { replace: true })
    })

  const subtitle = {
    password: '请使用管理员账号登录（需动态验证码）',
    totp: `请输入身份验证器为 ${username} 显示的动态码`,
    bind: '首次登录：请先绑定身份验证器',
    recovery: '请妥善保存恢复码（仅显示这一次）',
  }[step]

  return (
    <div className="relative bg-login dark:bg-login-dark">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <div className="min-h-[80vh] w-screen flex flex-col items-center justify-center py-10">
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-4 text-center text-white/88 dark:text-black/85">
            <Icon icon="icon-local:logo" className="block text-5xl" />
            <div className="text-3xl font-bold">{import.meta.env.VITE_APP_TITLE}</div>
          </div>
          <div className="w-96 border rounded-xl bg-white/80 p-5 shadow transition-all dark:bg-black/80 hover:shadow-2xl">
            <Typography.Paragraph type="secondary" className="!mb-4 text-center">{subtitle}</Typography.Paragraph>
            {error && <Alert type="error" showIcon message={error} className="!mb-3" />}
            {API_MOCK && step === 'password' && (
              <Alert type="info" showIcon className="!mb-3" message="Mock 模式：任意账号密码，验证码填 123456（账号 ops 为超级管理员）" />
            )}

            {step === 'password' && (
              <Form size="large" onFinish={onPassword} initialValues={{ username: API_MOCK ? 'ops' : '', password: API_MOCK ? 'mock-pass' : '' }}>
                <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                  <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" disabled={busy} allowClear />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                  <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" disabled={busy} />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={busy}>下一步</Button>
              </Form>
            )}

            {step === 'totp' && (
              <Form size="large" onFinish={onTotp}>
                <Form.Item name="code" rules={[{ required: true, message: '请输入动态验证码或恢复码' }]} extra="也可输入恢复码替代（每个恢复码仅可使用一次）">
                  <Input prefix={<SafetyOutlined />} placeholder="6 位动态码 / 恢复码" autoComplete="one-time-code" maxLength={12} autoFocus />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={busy}>登录</Button>
                <Button block className="!mt-2" onClick={() => { setStep('password'); setError('') }}>返回</Button>
              </Form>
            )}

            {step === 'bind' && (
              <Form size="large" onFinish={onBind}>
                <Typography.Paragraph>用验证器 App 扫码或手动输入密钥：</Typography.Paragraph>
                <Typography.Paragraph code copyable>{bind.secret}</Typography.Paragraph>
                <Typography.Paragraph type="secondary" className="break-all text-xs">{bind.url}</Typography.Paragraph>
                <Form.Item name="code" rules={[{ required: true, message: '请输入 App 显示的 6 位码' }]}>
                  <Input prefix={<SafetyOutlined />} placeholder="App 显示的 6 位码" maxLength={6} autoFocus />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={busy}>确认绑定</Button>
              </Form>
            )}

            {step === 'recovery' && (
              <div>
                <Alert type="warning" showIcon className="!mb-3" message="恢复码用后即焚，请离线保存；丢失验证器时只能靠它登录。" />
                <div className="grid grid-cols-2 gap-2 font-mono">
                  {recoveryCodes.map(c => <div key={c} className="rounded bg-black/5 px-2 py-1 text-center dark:bg-white/10">{c}</div>)}
                </div>
                <Button type="primary" block className="!mt-4" loading={busy} onClick={() => void finish()}>我已保存，进入后台</Button>
              </div>
            )}
          </div>
        </div>
      </div>
      <Wave />
    </div>
  )
}
