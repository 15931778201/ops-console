# 后端生产镜像（多阶段构建）
# 构建：docker build -f 付费后端/Dockerfile -t heyu-pdf-backend ./付费后端
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 仅运行时依赖 + 构建产物 + 迁移/种子
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
# 非 root 用户运行
USER node
EXPOSE 3001
# 启动前执行迁移（部署手册说明：生产用 migrate deploy）
CMD ["node", "dist/index.js"]
