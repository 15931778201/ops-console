/**
 * 套餐列表（/catalog/plans）；详情与编辑 /catalog/plans/:id。
 * 权限：plan:read 读，plan:write 写。改价不追溯旧订单：已创建订单按成交时的价格快照结算。
 */

import { Button, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { App } from 'antd'
import { Link } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, PageStack, Section, errText, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { catalogApi, type PlanListItem } from '@/lib/catalog-api'
import { useAuthStore } from '@/stores/authStore'

import { CatalogTabs } from '../components/shared'

export default function CatalogPlansPage() {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [toggling, setToggling] = useState<PlanListItem | null>(null)
  const { data, loading, error, reload } = useRequest(() => catalogApi.plans(), [], '加载套餐失败')

  return (
    <PageStack>
      <Section title="套餐与计费规则" extra={<CatalogTabs />}>
        <div className="mb-3 text-sm opacity-70">改价不追溯旧订单：已创建订单按成交时的价格快照结算。</div>
        <ErrorAlert error={error} />
        <Table<PlanListItem>
          rowKey="id"
          loading={loading}
          dataSource={data?.items ?? []}
          pagination={false}
          locale={{ emptyText: '暂无套餐' }}
          columns={[
            { title: '套餐', render: (_, p) => (<div>{p.name}<div className="text-xs opacity-60">{p.id}</div></div>) },
            { title: '价格', dataIndex: 'priceCents', render: yuan },
            { title: '月积分', dataIndex: 'monthlyCredits', render: v => v.toLocaleString() },
            { title: '文件数上限', dataIndex: 'maxFiles' },
            { title: '档位权限', dataIndex: 'costTierAccess', render: (v: string[]) => v.join(' / ') },
            { title: '持有用户', dataIndex: 'holderCount' },
            { title: '状态', dataIndex: 'active', render: v => (v ? <Tag color="success">在售</Tag> : <Tag>已下架</Tag>) },
            {
              title: '操作',
              render: (_, p) => (
                <Space size="small">
                  <Link to={`/catalog/plans/${p.id}`}><Button size="small">详情</Button></Link>
                  {canWrite && <Button size="small" danger={p.active} onClick={() => setToggling(p)}>{p.active ? '下架' : '上架'}</Button>}
                </Space>
              ),
            },
          ]}
        />
      </Section>

      <ConfirmModal
        open={!!toggling}
        danger={toggling?.active}
        title={`${toggling?.active ? '下架' : '上架'}套餐 · ${toggling?.name}`}
        content={<p>{toggling?.active ? `下架后用户端不再展示该套餐，且服务端会拒绝创建新订单（已有 ${toggling.holderCount} 名存量用户不受影响）。` : '上架后用户端恢复展示，且可创建新订单。'}</p>}
        reasonLabel="操作原因（写入审计日志）"
        onCancel={() => setToggling(null)}
        onOk={async (reason) => {
          const p = toggling!
          try {
            const r = await catalogApi.setPlanActive(p.id, !p.active, reason)
            message.success(`${p.name} 已${r.active ? '上架' : '下架'}（影响 ${r.holderCount} 名存量用户）`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '操作失败'))
          }
          setToggling(null)
        }}
      />
    </PageStack>
  )
}
