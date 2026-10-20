/**
 * 应用入口
 * 生产基座：安全中间件 → 请求 ID → 日志 → CORS 白名单 → 分级限流 → 路由 → 统一错误出口 → 优雅关闭
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, allowedOrigins } from './lib/config';
import { requestIdMiddleware } from './lib/request-id';
import { logger } from './lib/logger';
import { sendError } from './lib/response';
import { ForbiddenError } from './lib/errors';
import { clientIp, rateLimiter, RATE_RULES } from './lib/rate-limit';
import { redisQuit } from './lib/redis';
import prisma from './lib/prisma';

import authRoutes from './routes/auth';
import accountRoutes from './routes/account';
import billingRoutes from './routes/billing';
import paymentRoutes from './routes/payment';
import paymentNotifyRoutes from './routes/payment-notify';
import inviteRoutes from './routes/invite';
import adminRoutes from './routes/admin';
import adminV1Routes from './routes/admin-v1';
import healthRoutes from './routes/health';
import { startJobs } from './jobs';

const app: Express = createApp();

function createApp(): Express {
  const instance = express();
  instance.disable('x-powered-by');
  instance.set('trust proxy', 1);

  // 安全响应头
  instance.use(
    helmet({
      contentSecurityPolicy: false, // API 服务不渲染页面；CSP 由前端/桌面端负责
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );

  // 支付回调：必须先于 express.json() 挂载，使用原始报文验签
  instance.use(
    '/api/payment/notify',
    express.raw({ type: () => true, limit: '64kb' }),
    paymentNotifyRoutes
  );

  // 请求体大小限制（账号/计费/支付均为小 JSON；PDF 内容永不上传）
  instance.use(express.json({ limit: '256kb' }));
  instance.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // 请求 ID + 日志上下文（需在日志之前）
  instance.use(requestIdMiddleware);

  // 访问日志（脱敏由 logger 保证）
  instance.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('http_request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  // CORS 精确白名单（桌面端 origin 如 tauri://localhost 需显式配置）
  const origins = allowedOrigins();
  instance.use(
    cors({
      origin: (origin, callback) => {
        // 无 Origin 头（如服务端到服务端、 curl）放行；浏览器来源必须命中白名单
        if (!origin || origins.includes(origin)) {
          callback(null, true);
          return;
        }
        // 来源未授权属于客户端访问策略错误，返回 403，而不是被统一出口误报为 500
        callback(new ForbiddenError('请求来源不在允许列表中'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Idempotency-Key'],
      maxAge: 600,
    })
  );

  // 全局限流（每 IP）
  instance.use('/api', rateLimiter('global', RATE_RULES.global, clientIp));

  // 路由
  instance.use('/api/auth', authRoutes);
  instance.use('/api/account', accountRoutes);
  instance.use('/api/billing', billingRoutes);
  instance.use('/api/payment', paymentRoutes);
  instance.use('/api/invite', inviteRoutes);
  // 注意顺序：/api/admin/v1 必须先于 /api/admin 挂载——
  // express.use 的前缀匹配会令 /api/admin 吞掉 /api/admin/v1/* 请求
  instance.use('/api/admin/v1', adminV1Routes); // 运营后台新体系（RBAC/MFA/审批）
  instance.use('/api/admin', adminRoutes); // 旧通道（break-glass 白名单，收敛中）
  instance.use(healthRoutes); // /health /ready 挂在根路径

  // 404
  instance.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    });
  });

  // 统一错误出口
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  instance.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err, `${req.method} ${req.originalUrl}`);
  });

  return instance;
}

/**
 * 直接运行（node dist/index.js / tsx src/index.ts）时启动服务；
 * 被 import（测试）时只构建 app，不监听、不启动定时任务。
 */
if (require.main === module) {
  const server = app.listen(config.PORT, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : config.PORT;
    logger.info('server_started', {
      configuredPort: config.PORT,
      port: actualPort,
      url: `http://127.0.0.1:${actualPort}`,
      allowedOrigins: allowedOrigins(),
      env: config.NODE_ENV,
      paymentProvider: config.PAYMENT_PROVIDER,
    });
    // 定时任务：计费扫描/订单清理/账本对账/渠道对账/周期重置
    startJobs();
  });

  /** 优雅关闭：停止接收新请求 → 等待存量 → 断开数据层 */
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    const forceTimer = setTimeout(() => {
      logger.error('shutdown_forced', { reason: 'graceful timeout' });
      process.exit(1);
    }, 15000);
    forceTimer.unref();

    server.close(async (err) => {
      clearTimeout(forceTimer);
      try {
        await prisma.$disconnect();
        await redisQuit();
      } catch (disconnectErr) {
        logger.error('shutdown_disconnect_failed', { err: disconnectErr });
      }
      if (err) {
        logger.error('shutdown_error', { err });
        process.exit(1);
      }
      logger.info('shutdown_completed', {});
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { err: reason });
});

export default app;
