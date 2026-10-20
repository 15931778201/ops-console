/**
 * 页面通用组件：PageCard / ErrorAlert / 状态标签 / 二次确认弹窗 / 分页辅助。
 */

import type { ReactNode } from 'react'

import { Alert, Card, Empty, Input, Modal, Spin, Tag, Typography } from 'antd'
import { useState } from 'react'

import { ApiError } from '@/lib/api-client'
import { ROLE_LABELS, type AdminRole } from '@/lib/permissions'

// ---------- 容器 ----------

export function PageCard({ title, extra, children, className }: { title?: ReactNode, extra?: ReactNode, children?: ReactNode, className?: string }) {
  return (
    <div className={`m-2 ${className ?? ''}`}>
      <Card title={title} extra={extra} variant="borderless">
        {children}
      </Card>
    </div>
  )
}

/** 纵向堆叠多个卡片的页面 */
export function PageStack({ children }: { children: ReactNode }) {
  return <div className="m-2 flex flex-col gap-2">{children}</div>
}

export function Section({ title, extra, children }: { title?: ReactNode, extra?: ReactNode, children?: ReactNode }) {
  return (
    <Card title={title} extra={extra} variant="borderless">
      {children}
    </Card>
  )
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="py-10 text-center">
      <Spin tip={text}>
        <div className="h-10" />
      </Spin>
    </div>
  )
}

export function EmptyState({ text = '暂无数据' }: { text?: string }) {
  return <Empty description={text} />
}

export function ErrorAlert({ error }: { error?: string | null }) {
  return error ? <Alert type="error" showIcon message={error} className="!mb-3" /> : null
}

export function SuccessAlert({ text }: { text?: string | null }) {
  return text ? <Alert type="success" showIcon message={text} className="!mb-3" closable /> : null
}

/** 把任意异常转成可展示文本 */
export function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ---------- 状态标签 ----------

type TagColor = 'default' | 'success' | 'warning' | 'error' | 'processing'

const ORDER_STATUS: Record<string, [string, TagColor]> = {
  PENDING: ['待支付', 'warning'],
  PAID: ['已支付', 'success'],
  FAILED: ['失败', 'error'],
  REFUNDING: ['退款中', 'warning'],
  REFUNDED: ['已退款', 'default'],
  CLOSED: ['已关闭', 'default'],
}
const USER_STATUS: Record<string, [string, TagColor]> = {
  ACTIVE: ['正常', 'success'],
  SUSPENDED: ['已禁用', 'error'],
  DELETED: ['已删除', 'default'],
}
const RECON_ACTION: Record<string, [string, TagColor]> = {
  AUTO_SETTLED: ['系统自动补结算', 'success'],
  MANUAL_DONE: ['人工已处理', 'processing'],
  ESCALATED: ['已升级', 'warning'],
  IGNORED: ['已忽略', 'default'],
}

function mapTag(map: Record<string, [string, TagColor]>, key: string) {
  const [label, color] = map[key] ?? [key, 'default' as TagColor]
  return <Tag color={color}>{label}</Tag>
}

export const OrderStatusTag = ({ status }: { status: string }) => mapTag(ORDER_STATUS, status)
export const UserStatusTag = ({ status }: { status: string }) => mapTag(USER_STATUS, status)
export const ReconActionTag = ({ action }: { action: string | null }) =>
  action ? mapTag(RECON_ACTION, action) : <Tag color="warning">待处理</Tag>

export function RoleTag({ role }: { role: AdminRole }) {
  const color = role === 'SUPER_ADMIN' ? 'red' : role === 'FINANCE' || role === 'AUDITOR' ? 'blue' : 'default'
  return <Tag color={color}>{ROLE_LABELS[role]}</Tag>
}

// ---------- 二次确认 ----------

/**
 * 二次确认弹窗：可选「确认词」与「原因」输入。
 * 原因至少 2 个字符（写入审计）；确认词需完全匹配。onOk 抛错时保持打开并由调用方提示。
 */
export function ConfirmModal({
  open,
  title,
  content,
  danger,
  okText = '确认',
  verifyText,
  reasonLabel,
  reasonPlaceholder,
  onOk,
  onCancel,
}: {
  open: boolean
  title: ReactNode
  content?: ReactNode
  danger?: boolean
  okText?: string
  /** 需输入并完全匹配的文本（如用户名、工单号） */
  verifyText?: string
  /** 非空时显示必填原因输入框 */
  reasonLabel?: string
  reasonPlaceholder?: string
  onOk: (reason: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [verify, setVerify] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const ready = (!verifyText || verify.trim() === verifyText) && (!reasonLabel || reason.trim().length >= 2)

  const reset = (): void => {
    setVerify('')
    setReason('')
  }

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText="取消"
      okButtonProps={{ danger, disabled: !ready, loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      destroyOnHidden
      onCancel={() => {
        reset()
        onCancel()
      }}
      afterClose={reset}
      onOk={async () => {
        setBusy(true)
        try {
          await onOk(reason.trim())
          reset()
        }
        finally {
          setBusy(false)
        }
      }}
    >
      <div className="flex flex-col gap-3">
        {content}
        {verifyText && (
          <div>
            <Typography.Text type="secondary">
              请输入
              {' '}
              <Typography.Text code>{verifyText}</Typography.Text>
              {' '}
              以确认
            </Typography.Text>
            <Input className="mt-1" value={verify} onChange={e => setVerify(e.target.value)} autoFocus />
          </div>
        )}
        {reasonLabel && (
          <div>
            <Typography.Text type="secondary">{reasonLabel}</Typography.Text>
            <Input.TextArea className="mt-1" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder={reasonPlaceholder} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------- 数值/时间格式 ----------

export const yuan = (cents: number | null | undefined): string => (cents === null || cents === undefined ? '-' : `¥${(cents / 100).toFixed(2)}`)
export const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-')
export const fmtNum = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : n.toLocaleString('zh-CN'))
