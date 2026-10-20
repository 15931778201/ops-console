/**
 * 错误码与错误类型
 * 前后端共用错误码表见 docs/api-contract-auth.md；HTTP 状态与错误码一一对应。
 */

/** 业务错误码（契约的一部分，新增需同步前端与文档） */
export const ErrorCode = {
  // 认证
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REUSED: 'TOKEN_REUSED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  PHONE_TAKEN: 'PHONE_TAKEN',
  VERIFICATION_CODE_INVALID: 'VERIFICATION_CODE_INVALID',
  VERIFICATION_CODE_EXPIRED: 'VERIFICATION_CODE_EXPIRED',
  VERIFICATION_TOO_FREQUENT: 'VERIFICATION_TOO_FREQUENT',
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',
  // 运营后台（admin，契约见 plans/运营后台管理系统设计.md 6.1）
  ADMIN_INVALID_CREDENTIALS: 'ADMIN_INVALID_CREDENTIALS',
  ADMIN_MFA_REQUIRED: 'ADMIN_MFA_REQUIRED',
  ADMIN_ACCOUNT_DISABLED: 'ADMIN_ACCOUNT_DISABLED',
  ADMIN_PERMISSION_DENIED: 'ADMIN_PERMISSION_DENIED',
  ADMIN_APPROVAL_REQUIRED: 'ADMIN_APPROVAL_REQUIRED',
  ADMIN_APPROVAL_CONFLICT: 'ADMIN_APPROVAL_CONFLICT',
  ADMIN_TOKEN_REUSED: 'ADMIN_TOKEN_REUSED',
  // 限流
  RATE_LIMITED: 'RATE_LIMITED',
  // 计费
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  PLAN_ACCESS_DENIED: 'PLAN_ACCESS_DENIED',
  PLAN_UNAVAILABLE: 'PLAN_UNAVAILABLE',
  FILE_LIMIT_EXCEEDED: 'FILE_LIMIT_EXCEEDED',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  TRANSACTION_ALREADY_SETTLED: 'TRANSACTION_ALREADY_SETTLED',
  BILLING_RULE_NOT_FOUND: 'BILLING_RULE_NOT_FOUND',
  // 订单/支付
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  ORDER_AMOUNT_MISMATCH: 'ORDER_AMOUNT_MISMATCH',
  PAYMENT_SIGNATURE_INVALID: 'PAYMENT_SIGNATURE_INVALID',
  PAYMENT_DUPLICATE_NOTIFY: 'PAYMENT_DUPLICATE_NOTIFY',
  PAYMENT_CHANNEL_DISABLED: 'PAYMENT_CHANNEL_DISABLED',
  REFUND_NOT_ALLOWED: 'REFUND_NOT_ALLOWED',
  // 系统
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 应用层错误：可安全地面向客户端暴露 */
export class AppError extends Error {
  readonly isOperational = true;

  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCodeValue | string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = '参数验证失败', details?: unknown) {
    super(400, ErrorCode.VALIDATION_FAILED, message, details);
  }
}

export class AuthError extends AppError {
  constructor(code: ErrorCodeValue, message: string) {
    // 认证类统一 401（账号枚举防护：不区分用户不存在/密码错误）
    super(401, code, message);
  }
}

/** 运营后台错误：状态码由调用方按语义显式指定（401 凭据 / 403 禁用越权 / 409 审批冲突） */
export class AdminError extends AppError {
  constructor(
    code: ErrorCodeValue,
    message: string,
    statusCode: 401 | 403 | 409 = 401,
    details?: unknown
  ) {
    super(statusCode, code, message, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = '请求过于频繁，请稍后重试') {
    super(429, ErrorCode.RATE_LIMITED, message);
  }
}

export class BillingError extends AppError {
  constructor(code: ErrorCodeValue, message: string, details?: unknown) {
    // 计费类统一 402，具体语义由 code 表达
    super(402, code, message, details);
  }
}

export class OrderError extends AppError {
  constructor(code: ErrorCodeValue, message: string, statusCode = 400) {
    super(statusCode, code, message);
  }
}

export class PaymentError extends AppError {
  constructor(code: ErrorCodeValue, message: string, statusCode = 400) {
    super(statusCode, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '没有权限访问') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(404, 'NOT_FOUND', message);
  }
}

/** 503：功能被运营开关临时关闭（如停收、暂停注册） */
export class ServiceUnavailableError extends AppError {
  constructor(message = '服务暂时不可用，请稍后再试') {
    super(503, 'FEATURE_DISABLED', message);
  }
}

/** 判断是否为可预期错误 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
