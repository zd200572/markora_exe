import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { Fragment } from '@tiptap/pm/model'
import type { Node as PMNode } from '@tiptap/pm/model'

export type MarkRange = { from: number; to: number }

type SourceEdit = { from: number; to: number }

type MarkerState = {
  decorations: DecorationSet
  sourceEdit: SourceEdit | null
}

type SourceHandle = {
  from: number
  to: number
  value: string
  done: boolean
  textarea: HTMLTextAreaElement | null
  wrapper: HTMLElement | null
}

type MarkerSpec = {
  kind: 'bold'
  edge: 'start' | 'end'
  from: number
  to: number
}

const pluginKey = new PluginKey<MarkerState>('markdownMarkers')
const handles = new WeakMap<Editor, SourceHandle>()

let menu: HTMLElement | null = null
let menuCleanup: (() => void) | null = null

const BOLD = 'bold'
const CODE = 'code'

function nextFrame(callback: () => void) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback)
    return
  }
  setTimeout(callback, 0)
}

function boldRuns(state: EditorState): MarkRange[] {
  const { from, to, empty } = state.selection
  const $from = state.doc.resolve(from)
  const $to = state.doc.resolve(to)
  if (!$from.sameParent($to)) return []
  const block = $from.parent
  if (!block.isTextblock || block.type.spec.code) return []

  const start = $from.start()
  const runs: MarkRange[] = []
  let current: MarkRange | null = null

  block.forEach((child, offset) => {
    const childFrom = start + offset
    const bold = child.isText
      && child.marks.some((mark) => mark.type.name === BOLD)
      && !child.marks.some((mark) => mark.type.name === CODE)
    if (!bold) {
      current = null
      return
    }
    if (current && current.to === childFrom) {
      current.to = childFrom + child.nodeSize
      return
    }
    current = { from: childFrom, to: childFrom + child.nodeSize }
    runs.push(current)
  })

  return runs.filter((run) => (empty
    ? from >= run.from && from <= run.to
    : run.from < to && run.to > from))
}

function blockAt(state: EditorState, pos: number) {
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size))
  const $pos = state.doc.resolve(clamped)
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter
    if (node?.isTextblock) return { node, from: clamped, to: clamped + node.nodeSize }
    return null
  }
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (!node.isTextblock) continue
    const from = $pos.before(depth)
    return { node, from, to: from + node.nodeSize }
  }
  return null
}

function blockMarkdown(editor: Editor, node: PMNode): string {
  if (!editor.markdown) return node.textContent
  const serialized = editor.markdown.serialize({ type: 'doc', content: [node.toJSON()] })
  return serialized.replace(/\n+$/, '')
}

function closeMenu() {
  menuCleanup?.()
  menuCleanup = null
  menu?.remove()
  menu = null
}

function openMenu(editor: Editor, run: MarkRange, anchor: HTMLElement) {
  closeMenu()
  if (typeof document === 'undefined') return

  const el = document.createElement('div')
  el.className = 'md-mark-menu'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '取消加粗'
  remove.addEventListener('mousedown', (event) => event.preventDefault())
  remove.addEventListener('click', () => {
    closeMenu()
    removeBoldRange(editor, run)
  })

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.textContent = '编辑格式范围'
  edit.addEventListener('mousedown', (event) => event.preventDefault())
  edit.addEventListener('click', () => {
    closeMenu()
    beginMarkdownSourceEdit(editor, run.from)
  })

  el.append(remove, edit)
  document.body.appendChild(el)

  const rect = anchor.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))
  el.style.left = left + 'px'
  el.style.top = rect.bottom + 6 + 'px'
  menu = el

  const onOutside = (event: MouseEvent) => {
    if (menu && !menu.contains(event.target as Node)) closeMenu()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeMenu()
  }
  const timer = window.setTimeout(() => {
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
  }, 0)
  menuCleanup = () => {
    window.clearTimeout(timer)
    document.removeEventListener('mousedown', onOutside)
    document.removeEventListener('keydown', onKey)
  }
}

function createMarker(editor: Editor, run: MarkRange, edge: 'start' | 'end') {
  const el = document.createElement('span')
  el.className = 'md-mark md-mark-bold'
  el.textContent = '**'
  el.setAttribute('contenteditable', 'false')
  el.setAttribute('role', 'button')
  el.title = '加粗格式：点击可取消或调整范围'
  el.dataset.edge = edge
  el.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  el.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openMenu(editor, run, el)
  })
  return el
}

function buildMarkDecorations(state: EditorState, editor: Editor): DecorationSet {
  const decorations: Decoration[] = []
  for (const run of boldRuns(state)) {
    const spec: MarkerSpec = { kind: 'bold', edge: 'start', from: run.from, to: run.to }
    decorations.push(Decoration.widget(run.from, () => createMarker(editor, run, 'start'), {
      side: -1,
      key: 'bold-start-' + run.from,
      marker: spec,
    }))
    decorations.push(Decoration.widget(run.to, () => createMarker(editor, run, 'end'), {
      side: 1,
      key: 'bold-end-' + run.to,
      marker: { ...spec, edge: 'end' },
    }))
  }
  return DecorationSet.create(state.doc, decorations)
}

function buildSourceDecorations(state: EditorState, edit: SourceEdit, editor: Editor): DecorationSet {
  const wrapper = handles.get(editor)?.wrapper
  if (!wrapper) return DecorationSet.create(state.doc, [])
  return DecorationSet.create(state.doc, [
    Decoration.node(edit.from, edit.to, { class: 'md-source-hidden' }),
    Decoration.widget(edit.from, () => wrapper, { side: -1, key: 'md-source-widget' }),
  ])
}

function createSourceDom(editor: Editor, handle: SourceHandle) {
  if (typeof document === 'undefined') return

  const wrap = document.createElement('div')
  wrap.className = 'md-source-wrap'
  wrap.setAttribute('contenteditable', 'false')

  const hint = document.createElement('div')
  hint.className = 'md-source-hint'
  hint.textContent = 'Markdown 源码编辑 · Ctrl+Enter 完成 · Esc 取消'

  const textarea = document.createElement('textarea')
  textarea.className = 'md-source-input'
  textarea.value = handle.value
  textarea.spellcheck = false
  textarea.setAttribute('aria-label', '编辑当前段落的 Markdown 源码')

  const grow = () => {
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }

  textarea.addEventListener('input', () => {
    handle.value = textarea.value
    grow()
  })
  textarea.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelMarkdownSourceEdit(editor)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      commitMarkdownSourceEdit(editor)
    }
  })
  textarea.addEventListener('blur', () => {
    if (!handle.done) commitMarkdownSourceEdit(editor)
  })

  const actions = document.createElement('div')
  actions.className = 'md-source-actions'

  const commit = document.createElement('button')
  commit.type = 'button'
  commit.className = 'md-source-commit'
  commit.textContent = '完成'
  commit.addEventListener('mousedown', (event) => event.preventDefault())
  commit.addEventListener('click', () => commitMarkdownSourceEdit(editor))

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'md-source-cancel'
  cancel.textContent = '取消'
  cancel.addEventListener('mousedown', (event) => event.preventDefault())
  cancel.addEventListener('click', () => cancelMarkdownSourceEdit(editor))

  actions.append(commit, cancel)
  wrap.append(hint, textarea, actions)

  handle.textarea = textarea
  handle.wrapper = wrap
}

export function beginMarkdownSourceEdit(editor: Editor, pos: number): boolean {
  if (handles.has(editor)) return false
  const block = blockAt(editor.state, pos)
  if (!block || !editor.markdown) return false

  const handle: SourceHandle = {
    from: block.from,
    to: block.to,
    value: blockMarkdown(editor, block.node),
    done: false,
    textarea: null,
    wrapper: null,
  }
  createSourceDom(editor, handle)
  handles.set(editor, handle)

  editor.view.dispatch(editor.state.tr.setMeta(pluginKey, {
    type: 'beginSource',
    from: block.from,
    to: block.to,
  }))

  if (handle.textarea) {
    nextFrame(() => {
      if (handle.done || !handle.textarea) return
      handle.textarea.style.height = 'auto'
      handle.textarea.style.height = handle.textarea.scrollHeight + 'px'
      handle.textarea.focus()
      const end = handle.textarea.value.length
      handle.textarea.setSelectionRange(end, end)
    })
  }
  return true
}

export function getMarkdownSourceEdit(editor: Editor) {
  const handle = handles.get(editor)
  return handle ? { from: handle.from, to: handle.to, value: handle.value } : null
}

export function setMarkdownSourceEditValue(editor: Editor, value: string): boolean {
  const handle = handles.get(editor)
  if (!handle || handle.done) return false
  handle.value = value
  if (handle.textarea) handle.textarea.value = value
  return true
}

export function commitMarkdownSourceEdit(editor: Editor): boolean {
  const handle = handles.get(editor)
  if (!handle || handle.done) return false
  if (handle.textarea) handle.value = handle.textarea.value
  handle.done = true
  handles.delete(editor)

  const { state } = editor
  const from = Math.max(0, Math.min(handle.from, state.doc.content.size))
  const to = Math.max(from, Math.min(handle.to, state.doc.content.size))

  let content: Fragment
  try {
    content = editor.schema.nodeFromJSON(editor.markdown!.parse(handle.value)).content
  } catch {
    content = Fragment.empty
  }
  if (!content.size) {
    content = Fragment.from(editor.schema.nodes.paragraph.create(null, handle.value
      ? editor.schema.text(handle.value)
      : null))
  }

  const tr = state.tr.replaceWith(from, to, content)
  tr.setMeta(pluginKey, { type: 'endSource' })
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))))
  editor.view.dispatch(tr)
  return true
}

export function cancelMarkdownSourceEdit(editor: Editor): boolean {
  const handle = handles.get(editor)
  if (!handle || handle.done) return false
  handle.done = true
  handles.delete(editor)
  editor.view.dispatch(editor.state.tr.setMeta(pluginKey, { type: 'endSource' }))
  return true
}

export function removeBoldRange(editor: Editor, run: MarkRange): boolean {
  const mark = editor.state.schema.marks[BOLD]
  if (!mark) return false
  const tr = editor.state.tr.removeMark(run.from, run.to, mark)
  if (!tr.docChanged) return false
  editor.view.dispatch(tr)
  return true
}

export function getMarkDecorations(editor: Editor): DecorationSet | null {
  return pluginKey.getState(editor.state)?.decorations ?? null
}

export function getVisibleMarkers(editor: Editor): Array<MarkerSpec & { pos: number }> {
  const decorations = getMarkDecorations(editor)
  if (!decorations) return []
  return decorations.find().flatMap((decoration) => {
    const marker = (decoration.spec as { marker?: MarkerSpec }).marker
    return marker ? [{ ...marker, pos: decoration.from }] : []
  })
}

export const MarkdownMarkers = Extension.create({
  name: 'markdownMarkers',

  addProseMirrorPlugins() {
    const editor = this.editor
    let dragging = false

    const refresh = (view: EditorView) => {
      if (view.isDestroyed) return
      try {
        view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'refresh' }))
      } catch {
        // The view can be torn down between a DOM event and the next frame.
      }
    }

    return [new Plugin<MarkerState>({
      key: pluginKey,
      state: {
        init: (_, state) => ({ decorations: buildMarkDecorations(state, editor), sourceEdit: null }),
        apply: (tr, previous, _old, state) => {
          const meta = tr.getMeta(pluginKey) as { type?: string; from?: number; to?: number } | undefined

          if (meta?.type === 'beginSource') {
            const edit = { from: meta.from!, to: meta.to! }
            return { decorations: buildSourceDecorations(state, edit, editor), sourceEdit: edit }
          }
          if (meta?.type === 'endSource') {
            return { decorations: buildMarkDecorations(state, editor), sourceEdit: null }
          }
          if (meta?.type === 'refresh') {
            return previous.sourceEdit
              ? previous
              : { decorations: buildMarkDecorations(state, editor), sourceEdit: null }
          }
          if (previous.sourceEdit) {
            if (!tr.docChanged) return previous
            const from = tr.mapping.map(previous.sourceEdit.from)
            const to = tr.mapping.map(previous.sourceEdit.to)
            const edit = { from, to }
            return { decorations: buildSourceDecorations(state, edit, editor), sourceEdit: edit }
          }
          if (!tr.docChanged && !tr.selectionSet) return previous
          if (dragging) return previous
          if (editor.view.composing) return previous
          return { decorations: buildMarkDecorations(state, editor), sourceEdit: null }
        },
      },
      props: {
        decorations: (state) => pluginKey.getState(state)?.decorations ?? null,
      },
      view: (view) => {
        const onMouseDown = () => {
          dragging = true
        }
        const onMouseUp = () => {
          if (!dragging) return
          dragging = false
          nextFrame(() => refresh(view))
        }
        const onCompositionEnd = () => {
          nextFrame(() => refresh(view))
        }
        view.dom.addEventListener('mousedown', onMouseDown)
        view.dom.addEventListener('compositionend', onCompositionEnd)
        window.addEventListener('mouseup', onMouseUp)
        return {
          destroy: () => {
            view.dom.removeEventListener('mousedown', onMouseDown)
            view.dom.removeEventListener('compositionend', onCompositionEnd)
            window.removeEventListener('mouseup', onMouseUp)
            closeMenu()
          },
        }
      },
    })]
  },
})
