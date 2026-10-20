/**
 * 积分账本 · 异常账户（/ledger/anomalies）：投影 vs 流水重算的差额。只检测不修复。
 */

import { Alert, App, Button, Select, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageStack, Section, errText, fmtNum, fmtTime } from '@/components/page'
import { usePagedList } from '@/hooks/usePagedList'
import { ledgerApi, type AnomalousAccount, type DiscrepancyReason, type LedgerMeta } from '@/lib/ledger-api'

import { LedgerTabs, numClass } from './components/shared'

const REASON_COLOR: Record<DiscrepancyReason, string> = {
  NEGATIVE_BALANCE: 'error',
  NO_TRANSACTION_BALANCE: 'error',
  BOTH_MISMATCH: 'error',
  BALANCE_MISMATCH: 'warning',
  BONUS_MISMATCH: 'warning',
}

export default function LedgerAnomaliesPage() {
  const { message } = App.useApp()
  const [meta, setMeta] = useState<LedgerMeta | null>(null)
  const [scanResult, setScanResult] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const list = usePagedList<AnomalousAccount, { reason?: DiscrepancyReason | '' }>(q => ledgerApi.anomalies({ page: q.page, pageSize: q.pageSize, reason: q.reason }), {})

  useEffect(() => {
    ledgerApi.meta().then(setMeta).catch(() => undefined)
  }, [])

  const runScan = async (): Promise<void> => {
    setScanning(true)
    setScanError('')
    try {
      const r = await ledgerApi.scan()
      setScanResult(r.anomalies === 0 ? `扫描完成：未发现不平账户（耗时 ${r.durationMs}ms）` : `扫描完成：发现 ${r.anomalies} 个异常账户，其中 ${r.negative} 个余额为负（耗时 ${r.durationMs}ms）`)
      message.success('扫描完成')
      await list.reload()
    }
    catch (e) {
      setScanError(errText(e, '扫描失败'))
    }
    finally {
      setScanning(false)
    }
  }

  const label = (r: DiscrepancyReason): string => meta?.discrepancyReasons.find(x => x.value === r)?.label ?? r

  return (
    <PageStack>
      <Section title="账本一致性扫描" extra={<LedgerTabs />}>
        <Alert type="info" showIcon className="!mb-3" message={<>检测到不平后，<b>后台不会自动改余额</b>。请先查看该用户的流水找出原因，确认后到<Link to="/approvals">审批中心</Link>提交一笔反向调账（追加式闭环）。</>} />
        <ErrorAlert error={scanError || list.error} />
        <Space>
          <Button type="primary" loading={scanning} onClick={() => void runScan()}>立即扫描</Button>
          <Select allowClear placeholder="全部原因" className="!w-52" onChange={v => list.setFilters({ reason: v })} options={meta?.discrepancyReasons.map(r => ({ value: r.value, label: r.label }))} />
        </Space>
        {scanResult && <Alert className="!mt-3" type={scanResult.includes('未发现') ? 'success' : 'warning'} showIcon message={scanResult} />}
      </Section>

      <Section title="异常账户">
        <Table<AnomalousAccount>
          rowKey="userId"
          loading={list.loading}
          dataSource={list.items}
          pagination={list.pagination}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '账本一致，未发现异常账户' }}
          columns={[
            { title: '用户', render: (_, a) => (<div>{a.userEmail ?? '(已删除)'}<div className="text-xs opacity-60">{a.userName ?? '-'}</div></div>) },
            { title: '原因', dataIndex: 'reason', render: r => <Tag color={REASON_COLOR[r as DiscrepancyReason]}>{label(r)}</Tag> },
            { title: '投影（订阅/奖励）', render: (_, a) => `${fmtNum(a.balance)} / ${fmtNum(a.bonusBalance)}` },
            { title: '流水重算（订阅/奖励）', render: (_, a) => `${fmtNum(a.expectedBalance)} / ${fmtNum(a.expectedBonus)}` },
            { title: '差额', render: (_, a) => (<><span className={numClass(-a.diffBalance)}>{fmtNum(a.diffBalance)}</span> / <span className={numClass(-a.diffBonus)}>{fmtNum(a.diffBonus)}</span></>) },
            { title: '流水条数', dataIndex: 'txnCount', render: fmtNum },
            { title: '最近流水', dataIndex: 'lastTxnAt', render: fmtTime },
            { title: '操作', fixed: 'right', render: (_, a) => <Link to={`/ledger/accounts/${a.userId}`}><Button size="small">查看</Button></Link> },
          ]}
        />
      </Section>
    </PageStack>
  )
}
