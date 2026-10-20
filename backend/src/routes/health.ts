/**
 * 健康检查
 * GET /health —— 存活探针（进程在即 200）
 * GET /ready  —— 就绪探针（DB/Redis 可用才 200，否则 503）
 */

import { Router, type RequestHandler } from 'express';
import prisma from '../lib/prisma';
import { isRedisReady } from '../lib/redis';

const router = Router();

const healthHandler: RequestHandler = (_req, res) => {
  res.status(200).json({
    success: true,
    data: { status: 'ok', timestamp: new Date().toISOString() },
  });
};

const readyHandler: RequestHandler = async (_req, res) => {
  const checks: { database: boolean; redis: boolean } = { database: false, redis: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }
  checks.redis = isRedisReady();

  const ready = checks.database; // Redis 仅辅助，不阻塞就绪（幂等以 DB 为准）
  res.status(ready ? 200 : 503).json({
    success: ready,
    data: { status: ready ? 'ready' : 'degraded', checks },
  });
};

router.get('/health', healthHandler);
router.get('/ready', readyHandler);

export default router;
