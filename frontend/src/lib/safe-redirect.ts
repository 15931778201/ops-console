/** 仅站内相对路径可作为 redirect（防开放重定向） */
export function safeRedirect(target: string | null): string {
  if (!target) return '/'
  if (!target.startsWith('/')) return '/'
  if (target.startsWith('//')) return '/'
  return target
}
