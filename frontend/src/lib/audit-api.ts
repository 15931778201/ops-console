/**
 * 审计查询与导出 API（A6.8）
 *
 * 导出走 blob 下载（后端返回文件流而非 JSON），因此单独实现：
 * 仍复用 apiClient 的 401 单飞刷新与错误归一化逻辑。
 */

import { api } from './api-client';

export interface AuditItem {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: unknown;
  requestId: string | null;
  createdAt: string;
}

export interface AuditListResponse {
  items: AuditItem[];
  pagination: { total: number; page: number; pageSize: number };
  byAction: Array<{ action: string; actionLabel: string; count: number }>;
}

export interface AuditFilters {
  actorId?: string;
  actorType?: string;
  actionPrefix?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  reason?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditActionGroup {
  key: string;
  label: string;
  actions: string[];
}

export const auditApi = {
  /** 审计列表（多维筛选 + 分页 + 按动作计数） */
  list: (filters: AuditFilters) =>
    api.get<AuditListResponse>('/audit-logs', {
      actorId: filters.actorId,
      actorType: filters.actorType,
      action: filters.action,
      actionPrefix: filters.actionPrefix,
      targetType: filters.targetType,
      targetId: filters.targetId,
      requestId: filters.requestId,
      reason: filters.reason,
      since: filters.since,
      until: filters.until,
      page: filters.page,
      pageSize: filters.pageSize,
    }),

  /** 单条详情 */
  get: (id: string) => api.get<AuditItem>(`/audit-logs/${encodeURIComponent(id)}`),

  /** 动作字典 */
  meta: () => api.get<{ groups: AuditActionGroup[]; exportMaxRows: number }>('/audit-logs/meta'),

  /**
   * 导出审计日志。
   *
   * 后端返回文件流（CSV/JSON），故走 api.raw（复用鉴权与 401 单飞刷新），
   * 自行解析 Content-Disposition 取文件名并触发下载。
   * 限频由后端控制（10 分钟 3 次），超限返回错误并带 Retry-After。
   */
  export: async (filters: AuditFilters, format: 'csv' | 'json'): Promise<void> => {
    const resp = await api.raw('/audit-logs/export', { ...filters, format });

    if (!resp.ok) {
      let message = `导出失败（${resp.status}）`;
      try {
        const body = (await resp.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        /* 保留默认消息 */
      }
      throw new Error(message);
    }

    const rowCount = resp.headers.get('x-export-row-count');
    const truncated = resp.headers.get('x-export-truncated') === 'true';
    const blob = await resp.blob();

    const disposition = resp.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? `audit-logs.${format}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 导出结果告知（含是否被上限截断）
    window.alert(
      `已导出 ${rowCount ?? blob.size} 行${truncated ? '（达到上限，结果已截断，请缩小时间区间）' : ''}`
    );
  },
};