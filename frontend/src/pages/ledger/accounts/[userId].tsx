/**
 * 积分账本 · 账户详情（/ledger/accounts/:userId）：投影与流水重算对比 + 最近 20 条流水。
 */

import { Alert, Button, Card, Col, Descriptions, Row, Statistic, Table, Tag } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageStack, Section, fmtNum, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { ledgerApi } from '@/lib/ledger-api'

import { TXN_STATUS_COLOR, TxnTypeTag, numClass } from '../components/shared'

export default function LedgerAccountPage() {
  const { userId } = useParams()
  const { data: d, loading, error } = useRequest(() => ledgerApi.accountDetail(userId!), [userId], '加载账户详情失败')

  if (loading && !d) return <Loading />
  if (!d) return <div className="m-2"><ErrorAlert error={error ?? '账户不存在'} /></div>

  return (
    <PageStack>
      <Section title={`账户详情 · ${d.user.email ?? d.user.id}`} extra={<Link to="/ledger/anomalies"><Button>返回列表</Button></Link>}>
        {d.recompute.matches
          ? <Alert type="success" showIcon className="!mb-3" message={`账本一致：投影余额与流水重算值完全吻合（订阅 ${fmtNum(d.recompute.balance)}、奖励 ${fmtNum(d.recompute.bonusBalance)}）。`} />
          : <Alert type="error" showIcon className="!mb-3" message={`账本不平：投影 订阅 ${fmtNum(d.account?.balance)} / 奖励 ${fmtNum(d.account?.bonusBalance)}，流水重算 订阅 ${fmtNum(d.recompute.balance)} / 奖励 ${fmtNum(d.recompute.bonusBalance)}。请核对下方流水后走审批流发反向调账。`} />}
        <Row gutter={12} className="!mb-4">
          {[['订阅积分（投影）', d.account?.balance], ['奖励积分（投影）', d.account?.bonusBalance], ['周期额度', d.account?.monthlyQuota], ['乐观锁版本', d.account?.version]].map(([t, v]) => (
            <Col key={t as string} xs={12} md={6}><Card size="small"><Statistic title={t as string} value={fmtNum(v as number | undefined)} /></Card></Col>
          ))}
        </Row>
        <Descriptions bordered size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label="计费周期开始">{fmtTime(d.account?.periodStart)}</Descriptions.Item>
          <Descriptions.Item label="计费周期结束">{fmtTime(d.account?.periodEnd)}</Descriptions.Item>
          <Descriptions.Item label="投影更新时间">{fmtTime(d.account?.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="最近 20 条流水">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={d.recentTransactions}
          rowClassName={r => (r.status === 'ROLLED_BACK' ? 'opacity-50' : '')}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: fmtTime },
            { title: '类型', render: (_, r) => <TxnTypeTag type={r.type} label={r.typeLabel} /> },
            { title: '状态', dataIndex: 'status', render: v => <Tag color={TXN_STATUS_COLOR[v as keyof typeof TXN_STATUS_COLOR]}>{v}</Tag> },
            { title: '净变动', dataIndex: 'amount', render: v => <span className={numClass(v)}>{fmtNum(v)}</span> },
            { title: '订阅', dataIndex: 'deltaBalance', render: fmtNum },
            { title: '奖励', dataIndex: 'deltaBonus', render: fmtNum },
            { title: '说明', dataIndex: 'description', render: v => v ?? '-' },
          ]}
        />
      </Section>
    </PageStack>
  )
}
