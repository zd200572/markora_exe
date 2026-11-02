// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginMarkdownSourceEdit,
  cancelMarkdownSourceEdit,
  commitMarkdownSourceEdit,
  createEditorExtensions,
  getMarkdownSourceEdit,
  getVisibleMarkers,
  removeBoldRange,
  setMarkdownSourceEditValue,
} from './editor'

let editor: Editor | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
})

function open(markdown: string) {
  editor?.destroy()
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({ element: host, extensions: createEditorExtensions(), content: markdown, contentType: 'markdown' })
  return editor
}

function textPosition(instance: Editor, needle: string, offset = 0) {
  let found = -1
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText || !node.text) return
    const index = node.text.indexOf(needle)
    if (index >= 0) found = pos + index + offset
  })
  if (found < 0) throw new Error('missing text: ' + needle)
  return found
}

function placeCursor(instance: Editor, pos: number) {
  instance.view.dispatch(instance.state.tr.setSelection(TextSelection.create(instance.state.doc, pos)))
}

function boldRun(instance: Editor, needle: string) {
  const from = textPosition(instance, needle)
  return { from, to: from + needle.length }
}

function markers() {
  return Array.from(host!.querySelectorAll<HTMLElement>('.md-mark'))
}

describe('inline Markdown markers', () => {
  it('shows bold markers inside the range and at both boundaries only', () => {
    const instance = open('前面 **加粗文字** 后面')
    const run = boldRun(instance, '加粗文字')

    placeCursor(instance, run.from + 2)
    expect(getVisibleMarkers(instance).map((marker) => marker.edge).sort()).toEqual(['end', 'start'])
    expect(getVisibleMarkers(instance).map((marker) => marker.pos).sort((a, b) => a - b)).toEqual([run.from, run.to])
    expect(markers().map((marker) => marker.textContent)).toEqual(['**', '**'])

    placeCursor(instance, run.from)
    expect(getVisibleMarkers(instance)).toHaveLength(2)

    placeCursor(instance, run.to)
    expect(getVisibleMarkers(instance)).toHaveLength(2)

    placeCursor(instance, run.from - 1)
    expect(getVisibleMarkers(instance)).toHaveLength(0)
    expect(markers()).toHaveLength(0)

    placeCursor(instance, run.to + 1)
    expect(getVisibleMarkers(instance)).toHaveLength(0)
  })

  it('shows markers for a bold selection that overlaps the range', () => {
    const instance = open('前面 **加粗文字** 后面')
    const run = boldRun(instance, '加粗文字')
    instance.view.dispatch(instance.state.tr.setSelection(TextSelection.create(instance.state.doc, run.from + 1, run.to + 1)))
    expect(getVisibleMarkers(instance)).toHaveLength(2)
  })

  it('never shows markers for escaped literal asterisks', () => {
    const literal = '**literal**'.replaceAll('*', String.fromCharCode(92) + '*')
    const instance = open(literal)
    expect(instance.state.doc.textContent).toContain('**literal**')
    placeCursor(instance, textPosition(instance, 'literal') + 2)
    expect(getVisibleMarkers(instance)).toHaveLength(0)
    expect(markers()).toHaveLength(0)
  })

  it('never shows markers inside inline code or code blocks', () => {
    const tick = String.fromCharCode(96)
    const inline = open('前面 ' + tick + '**code**' + tick + ' 后面')
    placeCursor(inline, textPosition(inline, '**code**') + 3)
    expect(getVisibleMarkers(inline)).toHaveLength(0)

    const block = open(tick + tick + tick + '\n**code**\n' + tick + tick + tick)
    placeCursor(block, textPosition(block, '**code**') + 3)
    expect(getVisibleMarkers(block)).toHaveLength(0)
  })

  it('keeps overlapping italic and link marks when bold is removed', () => {
    const instance = open('**加粗和*斜体*一起**')
    const run = boldRun(instance, '加粗和')
    expect(removeBoldRange(instance, run)).toBe(true)
    const markdown = instance.getMarkdown()
    expect(markdown).toContain('*斜体*')
    expect(markdown).not.toContain('**加粗和')

    const linked = open('**[链接](https://example.com)**')
    const linkRun = boldRun(linked, '链接')
    removeBoldRange(linked, linkRun)
    expect(linked.getMarkdown()).toContain('[链接](https://example.com)')
    expect(linked.getMarkdown()).not.toContain('**')
  })

  it('renders markers as non-bold interface decorations outside the mark', () => {
    const instance = open('前面 **加粗文字** 后面')
    placeCursor(instance, textPosition(instance, '加粗文字') + 1)
    for (const marker of markers()) {
      expect(marker.closest('strong')).toBeNull()
      expect(marker.getAttribute('contenteditable')).toBe('false')
    }
    expect(instance.getMarkdown()).toBe('前面 **加粗文字** 后面')
  })

  it('freezes marker updates while the mouse is dragging and refreshes on release', async () => {
    const instance = open('前面 **加粗文字** 后面')
    const run = boldRun(instance, '加粗文字')
    placeCursor(instance, run.from + 1)
    expect(getVisibleMarkers(instance)).toHaveLength(2)

    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
    instance.view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    placeCursor(instance, run.from - 1)
    expect(getVisibleMarkers(instance)).toHaveLength(2)

    window.dispatchEvent(new MouseEvent('mouseup'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getVisibleMarkers(instance)).toHaveLength(0)
  })

  it('opens the marker menu and removes bold from the whole range', () => {
    const instance = open('前面 **加粗文字** 后面')
    placeCursor(instance, textPosition(instance, '加粗文字') + 1)
    const [marker] = markers()
    marker.click()

    const menu = document.querySelector<HTMLElement>('.md-mark-menu')
    expect(menu).not.toBeNull()
    const buttons = Array.from(menu!.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['取消加粗', '编辑格式范围'])

    buttons[0].click()
    expect(instance.state.doc.textContent).toContain('加粗文字')
    expect(instance.getMarkdown()).not.toContain('**加粗文字**')
    expect(document.querySelector('.md-mark-menu')).toBeNull()
  })

  it('opens the local source editor from the marker menu', () => {
    const instance = open('前面 **加粗文字** 后面')
    placeCursor(instance, textPosition(instance, '加粗文字') + 1)
    markers()[0].click()

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.md-mark-menu button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['取消加粗', '编辑格式范围'])
    buttons[1].click()

    const input = host!.querySelector<HTMLTextAreaElement>('.md-source-input')
    expect(input).not.toBeNull()
    expect(input!.value).toBe('前面 **加粗文字** 后面')
    expect(document.querySelector('.md-mark-menu')).toBeNull()
    expect(instance.state.doc.textContent).toContain('加粗文字')
  })
})

describe('local Markdown source editing', () => {
  it('edits the bold range of one paragraph without touching the rest of the document', () => {
    const instance = open('第一段\n\n前面 **加粗文字** 后面\n\n最后一段')
    const before = instance.getMarkdown()
    const pos = textPosition(instance, '加粗文字')

    expect(beginMarkdownSourceEdit(instance, pos)).toBe(true)
    expect(getMarkdownSourceEdit(instance)?.value).toBe('前面 **加粗文字** 后面')
    expect(host!.querySelector('.md-source-input')).not.toBeNull()
    expect(host!.querySelector('.md-source-hidden')).not.toBeNull()

    expect(setMarkdownSourceEditValue(instance, '前面**加粗文字更多**后面')).toBe(true)
    expect(commitMarkdownSourceEdit(instance)).toBe(true)
    expect(getMarkdownSourceEdit(instance)).toBeNull()
    expect(host!.querySelector('.md-source-input')).toBeNull()

    const markdown = instance.getMarkdown()
    expect(markdown).toContain('第一段')
    expect(markdown).toContain('最后一段')
    expect(markdown).toContain('前面**加粗文字更多**后面')

    instance.commands.undo()
    expect(instance.getMarkdown()).toBe(before)

    instance.commands.redo()
    expect(instance.getMarkdown()).toContain('前面**加粗文字更多**后面')
  })

  it('commits the textarea content through the 完成 button', () => {
    const instance = open('前面 **加粗文字** 后面')
    beginMarkdownSourceEdit(instance, textPosition(instance, '加粗文字'))
    const input = host!.querySelector<HTMLTextAreaElement>('.md-source-input')!
    input.value = '前面 **点击提交** 后面'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    host!.querySelector<HTMLButtonElement>('.md-source-commit')!.click()
    expect(instance.getMarkdown()).toContain('**点击提交**')
    expect(instance.state.doc.textContent).toContain('点击提交')
  })

  it('keeps unclosed markers exactly as typed without auto-closing them', () => {
    const instance = open('前面 **加粗文字** 后面')
    beginMarkdownSourceEdit(instance, textPosition(instance, '加粗文字'))
    setMarkdownSourceEditValue(instance, '前面 **加粗文字 后面')
    commitMarkdownSourceEdit(instance)
    expect(instance.state.doc.textContent).toContain('**加粗文字 后面')
    expect(instance.state.doc.textContent.match(/\*\*/g)).toHaveLength(1)
  })

  it('cancels without changing the document', () => {
    const instance = open('前面 **加粗文字** 后面')
    const before = instance.getMarkdown()
    beginMarkdownSourceEdit(instance, textPosition(instance, '加粗文字'))
    setMarkdownSourceEditValue(instance, '完全不同的内容')
    expect(cancelMarkdownSourceEdit(instance)).toBe(true)
    expect(instance.getMarkdown()).toBe(before)
  })

  it('round-trips the adjusted range through save and reopen', () => {
    const instance = open('前面 **加粗文字** 后面')
    beginMarkdownSourceEdit(instance, textPosition(instance, '加粗文字'))
    setMarkdownSourceEditValue(instance, '前面 **新的加粗范围** 后面')
    commitMarkdownSourceEdit(instance)
    const saved = instance.getMarkdown()

    const reopened = open(saved)
    const run = boldRun(reopened, '新的加粗范围')
    placeCursor(reopened, run.from + 1)
    expect(getVisibleMarkers(reopened)).toHaveLength(2)
    expect(reopened.getMarkdown()).toContain('**新的加粗范围**')
    expect(reopened.getMarkdown()).not.toContain(String.fromCharCode(92) + '*')
  })

  it('commits pending source text before a snapshot reads Markdown', () => {
    const instance = open('前面 **加粗文字** 后面')
    beginMarkdownSourceEdit(instance, textPosition(instance, '加粗文字'))
    setMarkdownSourceEditValue(instance, '前面 **新加粗** 后面')
    expect(commitMarkdownSourceEdit(instance)).toBe(true)
    expect(instance.getMarkdown()).toContain('**新加粗**')
    expect(commitMarkdownSourceEdit(instance)).toBe(false)
  })
})
