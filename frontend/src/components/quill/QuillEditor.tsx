import type { RefObject } from 'react'

import Quill from 'quill'
import 'quill/dist/quill.core.css'
import 'quill/dist/quill.snow.css'
import { useEffect, useImperativeHandle, useRef } from 'react'

export interface ChangeEvent {
  html: string
  text: string
  quill: Quill
}

interface QuillEditorProps {
  value?: string | null
  onChange?: (value: string | null) => void
  options?: Record<string, any>
  placeholder?: string
  readOnly?: boolean
  onBlur?: (quill: Quill) => void
  onFocus?: (quill: Quill) => void
  onReady?: (quill: Quill) => void
  onTextChange?: (event: ChangeEvent) => void
}

interface QuillEditorHandle {
  getQuill: () => Quill | null
}

export default function QuillEditor({
  ref,
  value = null,
  onChange,
  options = {},
  placeholder = '',
  readOnly = false,
  onBlur,
  onFocus,
  onReady,
  onTextChange,
}: QuillEditorProps & { ref?: RefObject<QuillEditorHandle | null> }) {
  const editorElement = useRef<HTMLDivElement | null>(null)
  const quillInstance = useRef<Quill | null>(null)
  const isInternalChangeRef = useRef<boolean>(false)

  // 存储事件处理程序在 ref 中以保持身份一致性
  const onBlurRef = useRef(onBlur)
  const onFocusRef = useRef(onFocus)
  const onReadyRef = useRef(onReady)
  const onChangeRef = useRef(onChange)
  const onTextChangeRef = useRef(onTextChange)

  // 当 props 变化时更新引用
  useEffect(() => {
    onBlurRef.current = onBlur
    onFocusRef.current = onFocus
    onReadyRef.current = onReady
    onChangeRef.current = onChange
    onTextChangeRef.current = onTextChange
  }, [onBlur, onFocus, onReady, onChange, onTextChange])

  // 暴露 getQuill 方法
  useImperativeHandle(ref, () => ({
    getQuill: () => quillInstance.current,
  }), [])

  // 初始化 Quill
  useEffect(() => {
    let quill: Quill | null = null
    let blurHandler: (() => void) | null = null
    let focusHandler: (() => void) | null = null
    let cleanupTextChange: (() => void) | null = null

    const initQuill = () => {
      if (!editorElement.current)
        return

      const defaultOptions = {
        theme: 'snow',
        placeholder,
        readOnly,
        modules: {
          toolbar: [
            ['bold', 'italic', 'underline', 'strike'], // 格式按钮
            ['blockquote', 'code-block'], // 块级元素
            [{ header: 1 }, { header: 2 }], // 自定义按钮值
            [{ list: 'ordered' }, { list: 'bullet' }], // 列表
            [{ script: 'sub' }, { script: 'super' }], // 上标/下标
            [{ indent: '-1' }, { indent: '+1' }], // 缩进
            [{ size: ['small', false, 'large', 'huge'] }], // 字号
            [{ header: [1, 2, 3, 4, 5, 6, false] }], // 标题
            [{ color: [] }, { background: [] }], // 颜色
            [{ font: [] }], // 字体
            [{ align: [] }], // 对齐
            ['clean'], // 清除格式
            ['link', 'image', 'video'], // 链接、图片、视频
          ],
        },
      }

      const allOptions = {
        ...defaultOptions,
        ...options,
      }

      // 初始化 Quill
      quill = new Quill(editorElement.current, allOptions)
      quillInstance.current = quill

      // 如果提供了初始内容则设置
      if (value) {
        isInternalChangeRef.current = true
        quill.root.innerHTML = value
        isInternalChangeRef.current = false
      }

      // 设置文本变化处理器
      const textChangeHandler = () => {
        if (!isInternalChangeRef.current && quill) {
          const html = quill.root.innerHTML
          onChangeRef.current?.(html)
          onTextChangeRef.current?.({
            html,
            text: quill.getText(),
            quill,
          })
        }
      }

      quill.on('text-change', textChangeHandler)
      cleanupTextChange = () => {
        quill?.off('text-change', textChangeHandler)
      }

      // 设置失焦和聚焦处理器
      blurHandler = () => {
        if (quill)
          onBlurRef.current?.(quill)
      }

      focusHandler = () => {
        if (quill)
          onFocusRef.current?.(quill)
      }

      quill.root.addEventListener('blur', blurHandler)
      quill.root.addEventListener('focus', focusHandler)

      // 就绪事件
      onReadyRef.current?.(quill)
    }

    const timer = setTimeout(initQuill, 0)

    return () => {
      // 组件卸载时的清理函数
      clearTimeout(timer)

      if (quill) {
        if (blurHandler)
          quill.root.removeEventListener('blur', blurHandler)
        if (focusHandler)
          quill.root.removeEventListener('focus', focusHandler)
        if (cleanupTextChange)
          cleanupTextChange()
      }

      quillInstance.current = null
    }
  }, []) // 空依赖数组确保只在挂载时运行一次

  // 监听值变化
  useEffect(() => {
    if (quillInstance.current && value !== quillInstance.current.root.innerHTML) {
      isInternalChangeRef.current = true
      quillInstance.current.root.innerHTML = value || ''
      isInternalChangeRef.current = false
    }
  }, [value])

  // 监听只读状态变化
  useEffect(() => {
    if (quillInstance.current) {
      quillInstance.current.enable(!readOnly)
    }
  }, [readOnly])

  return (
    <div className="mb-5 w-full">
      <div ref={editorElement} className="[&_.ql-editor]:min-h-[200px]" />
    </div>
  )
}
