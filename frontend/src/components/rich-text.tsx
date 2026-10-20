/**
 * 富文本：编辑器基于 Quill（精简工具栏），输出与展示前都经白名单净化，
 * 避免粘贴/手改产生的 <script>、事件属性、javascript: 链接入库后在用户端形成 XSS。
 */

import { useRef } from 'react'

import QuillEditor from '@/components/quill/QuillEditor'

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'CODE', 'PRE', 'A', 'DIV', 'SPAN',
])

/** 白名单净化：未知标签保留文本、丢弃标签；a 仅留 http(s)/mailto 的 href */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove()
      }
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(el.tagName)) {
          el.remove()
          continue
        }
        // Quill 2 的无序列表是 <ol><li data-list="bullet">，去掉属性前先修正为 <ul>
        if (el.tagName === 'OL' && el.querySelector(':scope > li[data-list="bullet"]')) {
          const ul = doc.createElement('ul')
          ul.append(...Array.from(el.childNodes))
          el.replaceWith(ul)
          walk(ul)
          continue
        }
        walk(el)
        if (el.classList.contains('ql-ui')) {
          el.remove()
          continue
        }
        if (!ALLOWED_TAGS.has(el.tagName)) {
          el.replaceWith(...Array.from(el.childNodes))
          continue
        }
        const href = el.tagName === 'A' ? el.getAttribute('href') ?? '' : ''
        for (const a of Array.from(el.attributes)) el.removeAttribute(a.name)
        if (el.tagName === 'A' && /^(?:https?:|mailto:)/i.test(href)) {
          el.setAttribute('href', href)
          el.setAttribute('target', '_blank')
          el.setAttribute('rel', 'noopener noreferrer')
        }
      }
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

/** 富文本 → 纯文本摘要（列表展示用） */
export function htmlToText(html: string): string {
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim()
}

const TOOLBAR = [
  ['bold', 'italic', 'underline'],
  [{ header: 2 }, { header: 3 }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['blockquote', 'link'],
  ['clean'],
]

/** 与 antd Form.Item 兼容的受控富文本编辑器（value/onChange 均为净化后的 HTML） */
export function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value?: string
  onChange?: (html: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const last = useRef(value ?? '')
  return (
    <QuillEditor
      value={value ?? ''}
      readOnly={disabled}
      placeholder={placeholder}
      options={{ modules: { toolbar: disabled ? false : TOOLBAR } }}
      onChange={(html) => {
        const clean = sanitizeHtml(html ?? '')
        // Quill 空内容是 <p><br></p>，归一成空串，便于"留空不展示"的判断
        const out = htmlToText(clean) === '' && !clean.includes('<img') ? '' : clean
        last.current = out
        onChange?.(out)
      }}
    />
  )
}

/** 渲染已净化的富文本（展示前再净化一次，防止库里历史脏数据） */
export function RichTextView({ html }: { html: string }) {
  return <div className="rte-view" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
}
