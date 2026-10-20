/**
 * 验证码渠道适配
 * 首发仅启用一种渠道（config.VERIFICATION_CHANNEL）：
 * - console：开发/测试，输出到控制台（不落结构化日志）
 * - email：SMTP 邮件（nodemailer）
 * - sms：短信平台 HTTP API
 */

import nodemailer from 'nodemailer';
import { config } from '../lib/config';
import { logger } from '../lib/logger';

export interface VerificationChannelAdapter {
  send(target: string, code: string): Promise<void>;
}

const consoleAdapter: VerificationChannelAdapter = {
  async send(target, code) {
    // 验证码本体不进结构化日志（脱敏清单），仅开发控制台可见
    if (config.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(`[verification] code for ${target}: ${code}`);
    }
  },
};

let mailerTransport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (!mailerTransport) {
    mailerTransport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth:
        config.SMTP_USER && config.SMTP_PASS
          ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
          : undefined,
    });
  }
  return mailerTransport;
}

const emailAdapter: VerificationChannelAdapter = {
  async send(target, code) {
    const from = config.SMTP_FROM ?? config.SMTP_USER;
    if (!config.SMTP_HOST || !from) {
      throw new Error('SMTP 配置不完整');
    }
    await getTransport().sendMail({
      from,
      to: target,
      subject: '合羽PDF 验证码',
      text: `您的验证码是 ${code}，5 分钟内有效。如非本人操作请忽略本邮件。`,
    });
  },
};

const smsAdapter: VerificationChannelAdapter = {
  async send(target, code) {
    const url = config.SMS_API_URL;
    if (!url || !config.SMS_API_KEY) {
      throw new Error('短信配置不完整');
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.SMS_API_KEY}`,
      },
      body: JSON.stringify({
        phone: target,
        sign: config.SMS_SIGN_NAME,
        templateId: config.SMS_TEMPLATE_ID,
        params: { code },
      }),
    });
    if (!resp.ok) {
      throw new Error(`短信发送失败: HTTP ${resp.status}`);
    }
  },
};

export function getVerificationAdapter(): VerificationChannelAdapter {
  switch (config.VERIFICATION_CHANNEL) {
    case 'email':
      return emailAdapter;
    case 'sms':
      return smsAdapter;
    default:
      logger.debug('verification channel: console（仅开发/测试）');
      return consoleAdapter;
  }
}
