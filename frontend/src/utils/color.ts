// 将hex颜色转成rgba
export function hexToRgba(
  hex: string,
  opacity: number,
): { red: number, green: number, blue: number, rgba: string } {
  // 移除可能存在的 # 前缀并转换为大写
  hex = hex.replace(/^#/, '').toUpperCase()

  // 如果是缩写形式（如 FFF），转换为完整形式
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map(char => char.repeat(2))
      .join('')
  }

  // 验证 hex 格式
  if (!/^[0-9A-F]{6}$/.test(hex)) {
    throw new Error('Invalid hex color format')
  }

  // 解析 RGB 值
  const [red, green, blue] = hex.match(/\w\w/g)!.map(x => Number.parseInt(x, 16))

  // 确保 opacity 在有效范围内
  opacity = Math.max(0, Math.min(1, opacity))

  // 构建 RGBA 字符串
  const rgba = `rgba(${red}, ${green}, ${blue}, ${opacity.toFixed(2)})`

  return { red, green, blue, rgba }
}
