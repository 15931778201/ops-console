import pkg from '../../package.json'

export function projectSign(text: string, project?: string, version?: string) {
  const projectName = project || pkg.name
  const projectVersion = version || pkg.version

  return `${projectName}-${projectVersion}-${text}`
}

/**
 * 判断是否为 HTTP URL
 * @param url 要判断的 URL
 * @returns 如果 URL 以 http:// 或 https:// 开头，则返回 true，否则返回 false
 */
export function isHttpUrl(url: string) {
  return /^https?:\/\//.test(url)
}

// 加密
export function enCode(str: string) {
  const key = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const l = key.length // 获取密钥的长度
  const a = key.split('') // 把密钥字符串转换为字符数组
  let s = ''
  let b
  let b1
  let b2
  let b3 // 定义临时变量
  for (let i = 0; i < str.length; i++) {
    b = str.charCodeAt(i) // 逐个提取每个字符，并获取Unicode编码值
    b1 = b % l // 求Unicode编码值得余数
    b = (b - b1) / l // 求最大倍数
    b2 = b % l // 求最大倍数的于是
    b = (b - b2) / l // 求最大倍数
    b3 = b % l // 求最大倍数的余数
    s += a[b3] + a[b2] + a[b1] // 根据余数值映射到密钥中对应下标位置的字符
  }

  return s
}

// 解密
export function deCode(str: string) {
  const key = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const l = key.length
  let b
  let b1
  let b2
  let b3
  let d = 0
  const s: number[] = Array.from({ length: Math.floor(str.length / 3) }) // 计算加密字符串包含的字符数，并定义数组
  b = s.length // 获取数组的长度
  for (let i = 0; i < b; i++) {
    b1 = key.indexOf(str.charAt(d)) // 截取周期内第一个字符串，计算在密钥中的下标值
    d++
    b2 = key.indexOf(str.charAt(d)) // 截取周期内第二个字符串，计算在密钥中的下标值
    d++
    b3 = key.indexOf(str.charAt(d)) // 截取周期内第三个字符串，计算在密钥中的下标值
    d++
    s[i] = b1 * l * l + b2 * l + b3 // 利用下标值，反推被加密字符的Unicode编码值
  }
  b = String.fromCharCode(...s)

  return b
}

/**
 * 复制文本到剪贴板
 * @param text 要复制的文本
 * @returns Promise<boolean> 是否复制成功
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)

      return true
    }

    // 兼容旧浏览器
    const textarea = document.createElement('textarea')
    textarea.value = text

    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-999999px'
    textarea.style.top = '-999999px'

    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()

    const success = document.execCommand('copy')
    document.body.removeChild(textarea)

    return success
  }
  catch (error) {
    console.error('复制到剪贴板失败:', error)

    return false
  }
}
