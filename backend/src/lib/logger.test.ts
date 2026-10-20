import { describe, expect, it } from 'vitest';
import { logger } from './logger';

/** 捕获 stdout/stderr 的日志行 */
function captureLogs(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('结构化日志脱敏（隐私红线）', () => {
  it('敏感字段被替换为 [REDACTED]', () => {
    const records = captureLogs(() => {
      logger.info('test', {
        password: 'p@ss',
        refreshToken: 'tok_123',
        verificationCode: '123456',
        filename: 'secret.pdf',
        filePath: 'C:/docs/secret.pdf',
        nested: { apiKey: 'key', ok: 'visible' },
      });
    });
    const record = records[0]!;
    expect(record.password).toBe('[REDACTED]');
    expect(record.refreshToken).toBe('[REDACTED]');
    expect(record.verificationCode).toBe('[REDACTED]');
    expect(record.filename).toBe('[REDACTED]');
    expect(record.filePath).toBe('[REDACTED]');
    expect(record.nested).toEqual({ apiKey: '[REDACTED]', ok: 'visible' });
  });

  it('普通字段原样输出', () => {
    const records = captureLogs(() => {
      logger.info('test', { userId: 'u1', toolSlug: 'merge' });
    });
    expect(records[0]!.userId).toBe('u1');
    expect(records[0]!.toolSlug).toBe('merge');
    expect(records[0]!.level).toBe('info');
    expect(typeof records[0]!.time).toBe('string');
  });

  it('Error 对象输出 message 与 stack，而不是空对象', () => {
    const records = captureLogs(() => {
      logger.error('test_error', { err: new Error('boom') });
    });
    expect(records[0]!.err).toMatchObject({ message: 'boom' });
    expect(typeof (records[0]!.err as { stack?: unknown }).stack).toBe('string');
  });
});
