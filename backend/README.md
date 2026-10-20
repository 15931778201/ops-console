# 合羽PDF付费后端

基于 Express + Prisma + PostgreSQL + Redis 的付费后端服务。
开发计划与任务清单见 `../plans/commercialization-development-plan.md`；API 契约见 `../docs/api-contract-auth.md`。

## 功能状态（2026-10-16）

| 模块 | 状态 | 说明 |
|---|---|---|
| 生产基座（配置校验/日志脱敏/请求 ID/CORS 白名单/分级限流/健康检查/优雅关闭） | ✅ | `src/lib/*`、`src/index.ts` |
| 版本化迁移 + 种子（套餐/97 个工具计费规则） | ✅ | `prisma/migrations/`、`prisma/seed.ts` |
| 认证（注册验证码/登录防枚举/Refresh 轮换/重放检测/会话吊销/登出所有设备） | ✅ | `src/routes/auth.ts`、`src/services/{auth,session,verification}.service.ts` |
| 积分账本（不可变流水/分账快照/重算对账/追加式调账） | ✅ | `src/services/ledger.service.ts` |
| 计费状态机（预扣/确认/回滚/超时过期，幂等 + 行级锁） | ✅ | `src/services/billing.service.ts` |
| 订单（服务端定价/价格快照/幂等/超时关闭） | ✅ | `src/services/order.service.ts` |
| 支付适配器（Mock 全流程 / 微信 V3 / 支付宝） | 🟡 | Mock 可用于端到端联调；微信/支付宝需沙箱验收（T5.2） |
| 回调验签/事务结算/权益发放/退款冲正/每日对账 | ✅ | `src/services/payment/settlement.service.ts` |
| 定时任务（计费扫描/订单清理/账本对账/渠道对账/周期重置） | ✅ | `src/jobs/` |
| 运营后台旧通道（用户/订单查询、审计日志） | 🟡 | `src/routes/admin.ts`；`ADMIN_USER_IDS` 白名单仅作 break-glass；**单人调账入口永久关闭**（503，A6.5 后调账唯一入口为审批流） |
| 运营后台新体系（独立认证/RBAC/MFA + 用户管理） | 🟡 | `/api/admin/v1`：两步登录 + TOTP + 5 角色权限矩阵 + 管理员账号管理 + 用户管理（列表/详情/禁用/下线/重算）；设计见 `../plans/运营后台管理系统设计.md` |
| 运营后台·订单与对账工作台（A6.4） | 🟡 | `/api/admin/v1/orders`（多维筛选/详情/渠道查单补结算）、`/api/admin/v1/reconciliations`（四类差异 + 人工处理 + 重试补结算）；`reconcileWithChannel()` 落 `ReconciliationRecord` |
| 运营后台·审批流（A6.5） | 🟡 | `/api/admin/v1/approvals`（提交/批准即执行/拒绝/撤回/FAILED 重试/待办角标/类型字典）+ `approvalGuard`；双人复核、单笔上限 10万、24h 频控 3 笔、流水按 `approval:{id}` 可反查 |
| admin-console 前端（A6.2） | ✅ | `../admin-console/`：登录两步流/TOTP 绑定/恢复码、用户管理、订单与对账工作台、审批中心、积分账本（全局流水 + 异常账户）、套餐与规则、仪表盘、系统开关、监控告警、审计日志、管理员账号管理、安全设置；53 个单测，产物 111KB gzip |
| 邀请系统 | 🟡 | 首发仅归因/人工活动码，**不自动发奖**（《就绪计划》首发范围） |
| 单元测试 | 🟢 | 97 个用例（拆分/验签/envelope/脱敏/TOTP 向量/字段加密/权限矩阵/会话轮换重放/路由挂载回归） |
| 运营后台·积分账本（A6.6） | 🟡 | `/api/admin/v1/ledger`：全局流水查询（7 类筛选 + 汇总）+ 不平/负值账户检测（单条 SQL 对比投影与流水）+ 账户详情与重算校验 + 手动扫描；**全部只读，无任何改余额入口** |
| 运营后台·套餐/规则/邀请 + 仪表盘（A6.7） | 🟡 | `/api/admin/v1/catalog`（套餐改价/上下架 + 影响预览、规则版本递增 + 近 7 日用量、邀请码与归因统计；改价不追溯旧订单、规则不追溯旧交易、幂等操作不写审计）、`/api/admin/v1/dashboard`（快照只读 + 手动刷新，6 项异常数字可跳转） |
| 运营后台·系统开关与审计（A6.8） | 🟡 | `/api/admin/v1/flags`（停收/注册/Mock 通道；停收只挡下单与注册，查询与退款不受影响；默认值内置不依赖 seed；毫秒级生效）、`/api/admin/v1/audit-logs`（多维筛选 + 按动作计数 + CSV/JSON 导出，限频 10 分钟 3 次、硬上限 1万行、导出本身入审计、CSV 公式注入防护）；`GET /api/payment/flags` 免登录供用户端隐藏 CTA |
| 运营后台·监控告警（T6.5） | 🟡 | `alert.service.ts`（12 条内置规则 + `ALERT_THRESHOLD_OVERRIDES` 覆盖 + 连续命中 2 轮防抖 + 30 分钟静默 + 恢复回填，状态持久化于 `alert_rule_states`）+ `alert-channels.ts`（webhook 外发，5 秒超时 / 指数退避重试 / 凭据只进请求头 / **未配置通道降级 `suppressed` 但事件仍落库** / 外发失败不抛）+ `/api/admin/v1/alerts`（事件列表 / 规则清单含 firing / 统计复盘 / **手动评估=演练入口** / 确认 / 重置状态；**无改阈值入口**）；`job.failure` 规则以 `audit_log` 为数据源，任务失败已落审计故"备份任务失败能告警"；配套 `../docs/监控清单.md` |
| E2E（真实 PostgreSQL） | 🟢 | `npm run test:e2e` → 589 项：认证 47 + 订单对账 57 + 审批流 73 + 积分账本 58 + 目录与仪表盘 82 + 开关与审计 73 + 监控告警 94 + HTTP 契约与 RBAC 105 |

## 技术栈

- **框架**: Express.js
- **数据库**: PostgreSQL (Prisma ORM，唯一事实来源)
- **缓存**: Redis (限流/幂等加速；不保存资金真相)
- **认证**: JWT（Access 15m）+ 随机 Refresh Token（30d 轮换）
- **验证**: Zod

## 项目结构

```
付费后端/
├── prisma/
│   ├── schema.prisma            # 数据模型（账本/交易状态机/会话/验证码/审计）
│   ├── migrations/              # 版本化迁移（生产禁止 db push）
│   ├── seed.ts                  # 套餐 + 工具计费规则种子
│   └── tool-billing-rules.json  # 默认计费规则（预生产测试值，待商务规则表确认）
├── src/
│   ├── index.ts                 # 入口（中间件链/优雅关闭/定时任务）
│   ├── lib/                     # config/logger/request-id/response/errors/async-handler/rate-limit/jwt/redis/audit/verification-channel
│   │                             # + admin-jwt/field-cipher/totp/admin-permissions/admin-password（运营后台安全基座）
│   ├── middleware/
│   │   ├── auth.ts              # 用户端认证/可选认证/管理员（旧）中间件
│   │   ├── admin-auth.ts        # 运营后台认证（独立 JWT + 会话 + 账号状态）
│   │   └── rbac.ts              # 运营后台权限码校验
│   ├── routes/                  # auth/account/billing/payment/payment-notify/invite/admin/health
│   │   └── admin-v1/            # 运营后台新体系：auth（两步登录）/ admins（账号管理）/ users（用户管理）
│   │                           # / orders（订单管理）/ reconciliations（对账工作台）
│   ├── services/
│   │   ├── auth.service.ts# 注册事务/登录/刷新/改密/找回
│   │   ├── session.service.ts   # 会话与 Refresh 轮换/重放检测
│   │   ├── admin-auth.service.ts    # 后台两步登录/TOTP 绑定/恢复码
│   │   ├── admin-session.service.ts # 后台会话轮换/重放检测
│   │   ├── admin-user.service.ts    # 管理员账号管理（末位超管保护）
│   │   ├── admin-user-mgmt.service.ts # 后台用户管理（禁用/下线/重算）
│   │   ├── admin-order.service.ts   # 后台订单管理（列表/详情/渠道查单补结算）
│   │   ├── admin-recon.service.ts   # 对账工作台（四类差异/人工处理/重试补结算）
│   │   ├── approval.service.ts      # 审批流（提交/批准即执行/频控/上限/防重复入账）
│   │   ├── admin-ledger.service.ts  # 积分账本（全局流水/不平检测/重算校验，只读）
│   │   ├── verification.service.ts
│   │   ├── ledger.service.ts    # 不可变账本
│   │   ├── billing.service.ts   # 计费状态机
│   │   ├── order.service.ts     # 订单
│   │   └── payment/             # 适配器（mock/wechat/alipay）+ 结算服务
│   └── jobs/                    # 定时任务
├── tests-e2e/                   # 真实库 E2E（npm run test:e2e）
│   ├── harness.ts               # 断言器/测试数据工厂/级联清理
│   ├── auth.e2e.ts              # 认证·管理员管理（47 项）
│   ├── orders.e2e.ts            # 订单·对账·结算幂等（57 项）
│   ├── approvals.e2e.ts         # 审批流（73 项）
│   ├── ledger.e2e.ts            # 积分账本（51 项）
│   ├── catalog.e2e.ts           # 套餐·规则·邀请 + 仪表盘（82 项）
│   ├── flags.e2e.ts             # 系统开关 + 审计查询导出（73 项）
│   └── http.e2e.ts              # HTTP 契约·RBAC 矩阵（105 项）
├── scripts/
│   ├── gen-tool-billing-rules.mjs
│   ├── probe-a67-contract.ts    # A6.7 目录/仪表盘 HTTP 契约联调（53 项）
│   ├── probe-a68-contract.ts    # A6.8 开关/审计 HTTP 契约联调（70 项）
│   └── admin-bootstrap.ts       # 创建首个 SUPER_ADMIN（npm run admin:bootstrap）
├── Dockerfile
├── docker-compose.staging.yml
└── vitest.config.ts
```

## 快速开始

```bash
cd 付费后端
npm install
cp .env.example .env   # 填写 DATABASE_URL / JWT_SECRET（至少 32 字符）/ ADMIN_JWT_SECRET（生产必须）等

npx prisma generate
npx prisma migrate deploy        # 应用全部迁移（本地开发库需先 CREATE DATABASE heyu_pdf）
npm run db:seed                 # 套餐 + 计费规则种子
npm run admin:bootstrap         # 创建首个 SUPER_ADMIN（交互式；仅允许空 admin 表执行）

npm run dev                     # 开发（tsx watch）
npm run typecheck && npm test   # 类型检查 + 单元测试（97 项）
npm run test:e2e                # 真实库 E2E（589 项；自动建数据并清理）
npm run test:e2e:approvals      # 仅审批流套件（73 项）
npm run test:e2e:ledger         # 仅积分账本套件（58 项）
npm run test:e2e:alerts         # 仅监控告警套件（94 项）
npm run test:all                # typecheck + 单测 + E2E
```

> 本地环境（2026-10-16 已验证）：PostgreSQL 18（`postgres/123456@localhost:5432/heyu_pdf`），
> Redis 未安装——限流/幂等自动降级为进程内存模式（开发可用，生产必须配置 REDIS_URL）。
> E2E 套件见 `tests-e2e/`（`npm run test:e2e`），测试数据统一 `e2e_`/`E2E` 前缀并在结束时级联清理。
> **沙箱注意**：vitest 并行模式偶发丢弃测试文件，本项目 `npm test` 已固定 `--no-file-parallelism`。

生产部署：`npx prisma migrate deploy && npm run build && npm start`；
或 `docker build -f Dockerfile -t heyu-pdf-backend . && docker compose -f docker-compose.staging.yml up -d`。

## 关键安全语义

- **账本不可变**：`credit_transactions` 只追加；余额是投影，任意账户可由流水重算复核。
- **回滚按原始分账恢复**：客户端不能指定金额；终态唯一（SETTLED/ROLLED_BACK/EXPIRED）。
- **支付以服务端验签为准**：伪造签名/金额不符/币种不符/订单错配/重复回调均不重复或错发权益。
- **隐私红线**：日志脱敏（密码/令牌/验证码/文件名/路径禁止落盘）；后端只接收计费摘要，**PDF 内容永不上传**。
- **运营后台独立认证**：admin token 与用户 token 密钥隔离（`ADMIN_JWT_SECRET`），payload `{sub,sid,role}`；TOTP secret AES-256-GCM 加密、恢复码 hash 用后即焚。
- **账本只读（A6.6）**：`/api/admin/v1/ledger` 全部为读操作，**不提供任何改余额入口**。不平账户检测只告警不自动修复（定时任务 + 手动扫描），修复须人工核对流水后走审批流发反向调账。重算口径排除 `ROLLED_BACK`；负值账户单列一类（负值防护被绕过的信号）；**零流水却有余额**单列一类（凭空造数据，`LEFT JOIN` 才能检出——`INNER JOIN` 会把这类账户整行排除，形成检测盲区）。
- **告警只读且阈值不可改（T6.5）**：`/api/admin/v1/alerts` 12 条内置规则，每 5 分钟评估；**连续命中 2 轮才外发**（防单轮毛刺）、**静默 30 分钟**（防刷爆值班群）、不再命中自动回填恢复时间形成闭环。**不提供"改阈值"接口或页面入口**——阈值属配置（`ALERT_THRESHOLD_OVERRIDES` / 代码默认值），必须走发布流程，否则等于给了"悄悄把告警关掉"的能力。未配置 `ALERT_WEBHOOK_URL` 时事件**仍完整落库**、状态 `suppressed`，管理端顶部显式提示"仅落库不外发"；通道不可用时外发失败只标记状态，**绝不抛异常影响主链路**。值班入口：`/alerts` 页面「立即检测」（演练）、确认、重置规则状态。详见 `docs/监控清单.md`。
- **调账双人复核（A6.5）**：申请（`credit:adjust:apply`，OPERATOR）与审批（`credit:adjust:execute`，SUPER_ADMIN）权限分离；申请人 ≠ 审批人（自批自发 409）；**批准即由服务端同事务入账**，执行幂等（`EXECUTED` 不可重复），失败置 `FAILED` 可重试且重试不重复入账；单笔 `|delta| ≤ 100000`、同一用户 24h ≤ 3 笔（撤回不计入）；流水 `referenceId = approval:{id}` 可反查审批记录。
- **补结算幂等**：`settleOrder` 状态机守卫只允许 PENDING→PAID，重复回调/重试/人工重试都不会重复发权益；金额不一致禁止自动改状态。
- **对账不自动改钱**：`AMOUNT_MISMATCH`/`PAID_LOCAL_UNKNOWN` 仅落工单交人工，`AUTO_SETTLED` 记录拒绝人工标记（防止"手工宣称已结算"）。
- **改价不追溯（A6.7）**：订单创建时 `priceSnapshot` 已固化套餐名/价格/周期/权益，服务端定价只影响**新订单与后续续费**，已创建订单（含未支付的）一律按快照成交价结算。计费规则同理：`CreditTransaction` 已固化分账快照，调价不改变历史流水。改价把**变更前价格**写入 `Plan.features.priceHistory`（上限 20 条），规则历史落 `AuditLog.metadata`。
- **影响预览只读**：`previewPlanImpact` / `previewRuleImpact` 只做估算，不写任何数据；`holderCount` 按 `users.planId` 统计（下架后仍保留存量用户数），收入影响 = 价格差 × 持有数。
- **幂等操作不写审计（A6.7）**：上下架、保存同价、无实质变更的规则修改都直接返回，不写库也不写审计——避免审计日志被空转噪声淹没而淹没真正的变更。
- **仪表盘读快照不压库（A6.7）**：定时任务每 5 分钟聚合并`upsert` `dashboard_snapshots`（唯一键 `(metricDate, scope)`，天然幂等），读取接口**只读快照不做实时 COUNT 大表**；当天超 15 分钟未刷新标记 `stale`。⚠️ `metricDate` 是 `@db.Date`，Prisma 按 **UTC 日期部分**读写，所有比较必须经 `localDayAsUtc()` 归一化，否则非 UTC 时区下 `isToday` 恒为 false（仪表盘永远显示"指标计算中"）。
- **套餐下架与不存在分离（A6.7）**：下架返回 `PLAN_UNAVAILABLE`（409，引导换套餐），不存在返回 `ORDER_NOT_FOUND`（404，客户端传错 ID）；前端可据此给出不同提示。
- **停收只挡写入口（A6.8）**：`payment.acceptingOrders=false` 时 `POST /api/payment/create-order` 返回 **503 `FEATURE_DISABLED`**，但**订单查询、套餐目录、退款全部不受影响**——已付款用户必须能查能退。开关**默认值内置于代码**（不依赖 seed），进程内缓存 + 变更即失效，**毫秒级全进程生效**（实测 3~4ms，远优于 60 秒要求）；缓存故障降级为默认值而非抛错。`flag:write` 仅 SUPER_ADMIN。
- **幂等操作无痕（A6.8）**：开关值未变化时既不写库也不写审计；审计日志只记录真实变更，避免噪声淹没关键操作。
- **导出即敏感操作（A6.8）**：审计导出三条约束——限频**按管理员**计数（10 分钟 3 次，超限 429 + `Retry-After`）、硬上限 10000 行（超出在 `x-export-truncated` 标注）、**导出行为本身写 `audit.exported` 审计**（谁在何时导出了什么必须可追溯）。CSV 对 `=`/`+`/`-`/`@` 开头的值加单引号前缀，防 Excel 公式注入。

## 待办（按开发计划）

- T5.2 微信/支付宝沙箱验收；T0.1/T0.2/T0.3 商业决策（价格/渠道/验证方式）
- 阶段 6：A6.1–A6.8 与 T6.5 已完成；下一步 T6.3 客服 SOP、T6.6 数据治理与密钥轮换、T6.7 合规一致性审核
- 上线前必须配置 `ALERT_WEBHOOK_URL`（否则告警只落库不外发，等于没有电话），并按 `../docs/监控清单.md` 完成一次告警演练
- 阶段 7：异常演练、灰度发布

> 前端工程见 `../admin-console/`（`npm run dev` 起在 1430，`/api` 自动代理到后端 3000）。

## 许可证

MIT
