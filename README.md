# 运营后台（ops-console）

基于原 `pdf-main/admin-console` + `pdf-main/付费后端` 重建；前端基于 [pure-admin-react](https://github.com/sunhaoxiang/pure-admin-react) 脚手架（Ant Design + 文件路由）。

```
ops-console/
├── frontend/   Vite + React 19 + Ant Design 5 + TS（端口 1430，默认纯前端 Mock，/api 代理到后端 3001）
└── backend/    Express + Prisma + Redis（/api/admin/v1，原付费后端原样复用）
```

## 页面结构：列表与详情分开路由

| 模块 | 列表 | 详情 / 表单 |
|---|---|---|
| 用户 | `/users` | `/users/:id` |
| 订单 | `/orders` | `/orders/:orderNo` |
| 对账 | `/reconcile` | `/reconcile/:id`（处理 / 重试补结算） |
| 管理员 | `/admins` | `/admins/new`、`/admins/:id` |
| 产品 | `/products` | `/products/new`、`/products/:id`、`/products/:id/edit` |
| 产品·上线配置 / 数据分析 / 多语言 | — | `/products/:id/release`、`/analytics`、`/i18n` |
| 产品·版本 | `/products/:id/versions` | `/versions/new`、`/versions/:vid` |
| 产品·套餐 | `/products/:id/plans` | `/plans/new`、`/plans/:planId` |
| 产品·评价 | `/products/:id/reviews` | `/reviews/:rid` |
| 审批中心 | `/approvals` | `/approvals/new`、`/approvals/:id`（批准/拒绝/撤回/重试） |
| 积分账本 | `/ledger`（流水）、`/ledger/anomalies` | `/ledger/accounts/:userId` |
| 套餐 | `/catalog/plans` | `/catalog/plans/:id`（价格历史 + 编辑） |
| 计费规则 | `/catalog/rules` | `/catalog/rules/:toolSlug` |
| 审计日志 | `/audit` | `/audit/:id` |
| 监控告警 | `/alerts`（事件）、`/alerts/rules`、`/alerts/stats` | `/alerts/events/:id`、`/alerts/rules/:key` |
| 系统开关 | `/flags`（开关面板，无详情） | — |

另有 `/login`（两步登录）、`/`（仪表盘）、`/settings/security`（我的安全设置）。

## 启动

```bash
# 后端（需要 PostgreSQL + Redis，见 backend/.env.example、backend/README.md）
cd backend && npm install && npx prisma migrate deploy && npm run admin:bootstrap && npm run dev

# 前端
cd frontend && npm install && npm run dev      # http://127.0.0.1:1430
```

## 说明

- 本次新增后端接口（详情页需要）：`GET /admins/:id`、`GET /reconciliations/:id`、`GET /audit-logs/:id`、`GET /alerts/events/:id`。
- 产品中心后端 `/products/**` 接口尚未实现，前端默认走内存 mock（`VITE_PRODUCT_MOCK=false` 切真实接口）。
- 原后台全部模块已迁入。前端默认走内存 Mock（`VITE_API_MOCK=false` 切真实后端），登录任意用户名/密码 + 验证码 `123456`。
- 迁移修复：原 `alert_monitoring` 迁移排在建表迁移之前，全新库执行会失败，已改名为 `202610170002_alert_monitoring`（已有库需自行核对 `_prisma_migrations`）。
- 前端修复：仪表盘读取接口原先请求 `/api/admin/v1/`（404），已改为 `/dashboard`。
