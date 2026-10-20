# 运营后台前端

基于 [pure-admin-react](https://github.com/sunhaoxiang/pure-admin-react)（MIT，见 `LICENSE`）脚手架重构：
React 19 + Ant Design 5 + TypeScript + Zustand + UnoCSS，**文件路由**（vite-plugin-pages）。

## 开发

```bash
npm install
npm run dev        # http://localhost:1430，默认纯前端 Mock（.env 中 VITE_API_MOCK=true）
npm run typecheck
npm test
npm run build
```

- Mock 登录：任意账号密码，验证码 `123456`（账号 `ops` 为超级管理员，`zhang.yun`/`li.support`/`wang.fin` 为其他角色）。
- 接真实后端：`VITE_API_MOCK=false`，`/api` 代理到 `127.0.0.1:3001`（可用 `VITE_PROXY_TARGET` 覆盖）。
- 产品中心后端接口未实现，`VITE_PRODUCT_MOCK=true` 时走内存 mock。

## 结构

```
src/
├── pages/            文件路由：列表 `xxx/index.tsx`、详情 `xxx/[id].tsx`、表单 `xxx/new.tsx`
├── router/routeMeta.ts   路由元数据：标题（面包屑）/ 所属菜单 / 权限
├── constants/menu.tsx    侧边栏菜单（按权限过滤）
├── stores/authStore.ts   会话与权限（zustand）
├── lib/              API 客户端、各模块 API、权限矩阵
├── mock/             内存 Mock 服务
└── components/       布局、守卫、页面通用组件（PageCard / ConfirmModal / 状态标签…）
```

新增页面：在 `src/pages` 加文件 → 在 `routeMeta.ts` 登记标题与权限 → 需要入口时在 `constants/menu.tsx` 加菜单项。
