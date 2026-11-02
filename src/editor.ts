import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Highlight } from '@tiptap/extension-highlight'
import { Subscript } from '@tiptap/extension-subscript'
import { Superscript } from '@tiptap/extension-superscript'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import Image from '@tiptap/extension-image'
import Mathematics, { migrateMathStrings } from '@tiptap/extension-mathematics'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Extension, markInputRule } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import type { OutlineItem } from './model'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { authorizeNativeImage } from './native'
import { MarkdownMarkers } from './mark-annotations'

export {
  beginMarkdownSourceEdit,
  cancelMarkdownSourceEdit,
  commitMarkdownSourceEdit,
  getMarkDecorations,
  getMarkdownSourceEdit,
  getVisibleMarkers,
  removeBoldRange,
  setMarkdownSourceEditValue,
} from './mark-annotations'

export function resolveLocalImagePath(documentPath: string | undefined, source: string) {
  if (!documentPath || !source) return null
  if (/^file:/i.test(source)) {
    try {
      return decodeURIComponent(new URL(source).pathname).replace(/^\/(?:([a-zA-Z]:))/, '$1')
    } catch {
      return null
    }
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return null
  let decoded: string
  try {
    decoded = decodeURI(source.split(/[?#]/, 1)[0])
  } catch {
    return null
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith('/')) return decoded

  const separator = documentPath.includes('\\') ? '\\' : '/'
  const base = documentPath.slice(0, Math.max(documentPath.lastIndexOf('/'), documentPath.lastIndexOf('\\')))
  const prefix = base.startsWith('/') ? '/' : /^[a-zA-Z]:/.exec(base)?.[0] ?? ''
  const parts = `${base}${separator}${decoded}`.split(/[\\/]/)
  const normalized: string[] = []
  for (const part of parts) {
    if (!part || part === '.' || part === prefix) continue
    if (part === '..') normalized.pop()
    else normalized.push(part)
  }
  return prefix === '/' ? `/${normalized.join('/')}` : `${prefix}${prefix ? separator : ''}${normalized.join(separator)}`
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }

const AutoPair = Extension.create({
  name: 'autoPair',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput(view, from, to, text) {
            const { state, dispatch } = view
            const closing = PAIRS[text]
            if (!closing || view.composing) return false
            const $from = state.doc.resolve(from)
            const $to = state.doc.resolve(to)
            if (!$from.sameParent($to)) return false
            const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset)
            if (before === '\\' || ((text === "'" || text === '"') && /[\p{L}\p{N}]/u.test(before))) return false
            if (from !== to) {
              const tr = state.tr.insertText(closing, to).insertText(text, from)
              tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
              dispatch(tr)
              return true
            }
            const tr = state.tr.insertText(text + closing, from)
            tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1))
            dispatch(tr)
            return true
          },
          handleKeyDown(view, event) {
            const { state, dispatch } = view
            const closing = event.key
            const openFor: Record<string, string> = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'" }
            const open = openFor[closing]
            if (open && !event.metaKey && !event.ctrlKey) {
              const { from } = state.selection
              if (from === state.selection.to) {
                const $from = state.selection.$from
                const after = $from.parent.textBetween($from.parentOffset, Math.min($from.parent.content.size, $from.parentOffset + 1))
                if (after === closing) {
                  const tr = state.tr.setSelection(TextSelection.create(state.doc, from + 1))
                  dispatch(tr)
                  return true
                }
              }
            }
            if (event.key === 'Backspace') {
              const { from } = state.selection
              const $from = state.selection.$from
              if (from === state.selection.to && $from.parentOffset > 0 && $from.parentOffset < $from.parent.content.size) {
                const before = state.doc.textBetween(from - 1, from, '\n')
                const after = state.doc.textBetween(from, from + 1, '\n')
                if (PAIRS[before] === after && before) {
                  const tr = state.tr.delete(from - 1, from + 1)
                  dispatch(tr)
                  return true
                }
              }
            }
            return false
          },
        },
      }),
    ]
  },
})

const MarkdownEditing = Extension.create({
  name: 'markdownEditing',
  priority: 1100,
  addInputRules() {
    const tokens: Record<string, string> = { bold: 'strong', italic: 'em', strike: 'del', code: 'codespan', highlight: 'highlight' }
    return Object.entries(tokens).map(([name, tokenType]) => markInputRule({
      type: this.editor.schema.marks[name],
      find: (text) => {
        if (!/[*_~`=]$/.test(text)) return null
        const manager = this.editor.markdown!
        const token = new manager.instance.Lexer(manager.instance.defaults).inlineTokens(text).at(-1)
        if (!token || token.type !== tokenType || !('text' in token) || !token.text || !token.raw.includes(token.text)) return null
        const index = text.length - token.raw.length
        if (text[index - 1] === token.raw[0]) return null
        return { index, text: token.raw, replaceWith: token.text }
      },
    }))
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        clipboardTextParser: (text, $context, plainText) => {
          if (plainText) {
            const content = text.split(/\r\n?|\n/).map((line) => this.editor.schema.nodes.paragraph.create(
              null, line ? this.editor.schema.text(line, $context.marks()) : null,
            ))
            return Slice.maxOpen(Fragment.fromArray(content))
          }
          const doc = this.editor.schema.nodeFromJSON(this.editor.markdown!.parse(text))
          return Slice.maxOpen(doc.content)
        },
      },
    })]
  },
})

function localImage(documentPath?: string) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const image = document.createElement('img')
        let requestedSource = ''
        const render = (attrs: Record<string, unknown>) => {
          const source = String(attrs.src ?? '')
          requestedSource = source
          const localPath = resolveLocalImagePath(documentPath, source)
          image.alt = String(attrs.alt ?? '')
          image.title = String(attrs.title ?? '')
          if (localPath && isTauri()) {
            image.removeAttribute('src')
            void authorizeNativeImage(documentPath!, source).then((authorizedPath) => {
              if (requestedSource === source) image.src = convertFileSrc(authorizedPath)
            }).catch(() => image.removeAttribute('src'))
          } else {
            image.src = source
          }
        }
        render(node.attrs)
        return {
          dom: image,
          update: (updated) => {
            if (updated.type.name !== 'image') return false
            render(updated.attrs)
            return true
          },
        }
      }
    },
  })
}

let cachedLowlight: ReturnType<typeof createLowlight> | null = null

export function createEditorExtensions(documentPath?: string) {
  if (!cachedLowlight) {
    cachedLowlight = createLowlight(common)
  }
  return [
    StarterKit.configure({
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({ lowlight: cachedLowlight }),
    localImage(documentPath),
    Mathematics.configure({
      katexOptions: { throwOnError: false },
    }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    Highlight,
    Subscript,
    Superscript,
    AutoPair,
    MarkdownEditing,
    MarkdownMarkers,
  ]
}

export function isEditorUsable(editor: Editor | null | undefined): editor is Editor {
  return Boolean(editor && !editor.isDestroyed)
}

export function getEditorOutline(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'heading') return
    items.push({
      level: Number(node.attrs.level) || 1,
      text: node.textContent,
      index: items.length,
    })
  })
  return items
}
