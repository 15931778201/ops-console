/**
 * 系统开关 API（A6.8）
 *
 * 停收是资金链路的总闸，UI 上必须让操作者清楚三件事：
 *  -当前状态（一眼可见，高危开关用醒目样式）
 *  - 影响范围（哪些能力受影响、哪些**不受影响**）
 *  - 为什么改（必填原因，进审计）
 */

import { api } from './api-client';
import type { Permission } from './permissions';

export interface FlagItem {
  key: string;
  flag: string;
  value: boolean;
  label: string;
  description: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  hasOverride: boolean;
}

export interface FlagMetaItem {
  key: string;
  flag: string;
  label: string;
  description: string;
  defaultValue: boolean;
}

export const flagsApi = {
  /** 开关列表 */
  list: () =>
    api.get<{ items: FlagItem[] }>('/flags').then((r) => r.items ?? []),

  /** 开关字典（标签/说明/默认值） */
  meta: () =>
    api.get<{ items: FlagMetaItem[] }>('/flags/meta').then((r) => r.items ?? []),

  /** 设置开关（幂等；值未变时后端不写审计） */
  set: (key: string, value: boolean, reason: string) =>
    api.patch<{ flag: string; previousValue: boolean; value: boolean; changed: boolean }>(
      `/flags/${key}`,
      { value, reason }
    ),

  /** 恢复代码默认值 */
  reset: (key: string, reason: string) =>
    api.post<{ flag: string; value: boolean }>(`/flags/${key}/reset`, { reason }),
};

/** 开关页需要的权限：读用 flag:read，改用 flag:write */
export const FLAG_PERMS: { read: Permission; write: Permission } = {
  read: 'flag:read',
  write: 'flag:write',
};