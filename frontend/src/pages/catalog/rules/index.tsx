/**
 * 计费规则列表（/catalog/rules）；详情与编辑 /catalog/rules/:toolSlug。规则变更不追溯旧交易。
 */

import { Button, Table, Tag } from 'antd'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageStack, Section } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { catalogApi, type BillingRule } from '@/lib/catalog-api'

import { CatalogTabs } from '../components/shared'

export default function CatalogRulesPage() {
  const { data, loading, error } = useRequest(() => catalogApi.rules(), [], '加载计费规则失败')

  return (
    <PageStack>
      <Section title="套餐与计费规则" extra={<CatalogTabs />}>
        <div className="mb-3 text-sm opacity-70">规则变更不追溯旧交易：历史流水已固化分账快照。</div>
        <ErrorAlert error={error} />
        <Table<BillingRule>
          rowKey="toolSlug"
          loading={loading}
          dataSource={data?.items ?? []}
          pagination={false}
          locale={{ emptyText: '暂无计费规则' }}
          columns={[
            { title: '工具', dataIndex: 'toolSlug' },
            { title: '积分消耗', dataIndex: 'creditCost' },
            { title: '最低套餐', dataIndex: 'minPlan' },
            { title: '单任务文件上限', dataIndex: 'maxFilesPerTask' },
            { title: '版本', dataIndex: 'ruleVersion', render: v => <Tag color="processing">{v}</Tag> },
            { title: '近 7 日用量', render: (_, r) => `${r.recentUsage.calls} 次 / ${Math.abs(r.recentUsage.credits)} 分` },
            { title: '状态', dataIndex: 'active', render: v => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
            { title: '操作', render: (_, r) => <Link to={`/catalog/rules/${encodeURIComponent(r.toolSlug)}`}><Button size="small">详情</Button></Link> },
          ]}
        />
      </Section>
    </PageStack>
  )
}
