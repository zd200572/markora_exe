import { Editor, getExtensionField, type InputRule } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions, getEditorOutline, isEditorUsable, resolveLocalImagePath } from './editor'

let editor: Editor | undefined

afterEach(() => editor?.destroy())

describe('Markdown editor model', () => {
  it.each([
    ['**X**', 'bold'],
    ['正文**X**', 'bold'],
    ['text**X**', 'bold'],
    ['__X__', 'bold'],
    ['正文*X*', 'italic'],
    ['正文~~X~~', 'strike'],
    ['正文' + String.fromCharCode(96) + 'X' + String.fromCharCode(96), 'code'],
    ['正文==X==', 'highlight'],
  ])('recognizes completed inline Markdown in %s', (text, mark) => {
    editor = new Editor({ extensions: createEditorExtensions(), content: 'placeholder', contentType: 'markdown' })
    const extension = editor.extensionManager.extensions.find((item) => item.name === 'markdownEditing')!
    const rules = getExtensionField<() => InputRule[]>(extension, 'addInputRules', { editor })()
    const matches = rules.map((rule) => typeof rule.find === 'function' ? rule.find(text) : null).filter(Boolean)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.replaceWith).toBe('X')
    expect(editor.markdown!.parse(matches[0]!.text).content?.[0].content?.[0].marks).toContainEqual({ type: mark })
  })

  it.each(['**X*', '__X_', '\\**X**', '\\*X*', 'snake_case_value'])('does not format incomplete or escaped input %s', (text) => {
    editor = new Editor({ extensions: createEditorExtensions(), content: 'placeholder', contentType: 'markdown' })
    const extension = editor.extensionManager.extensions.find((item) => item.name === 'markdownEditing')!
    const rules = getExtensionField<() => InputRule[]>(extension, 'addInputRules', { editor })()
    expect(rules.some((rule) => typeof rule.find === 'function' && rule.find(text))).toBe(false)
  })

  it('uses the document Markdown parser for pasted headings, adjacent Chinese marks and lists', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: 'placeholder', contentType: 'markdown' })
    const extension = editor.extensionManager.extensions.find((item) => item.name === 'markdownEditing')!
    const [plugin] = getExtensionField(extension, 'addProseMirrorPlugins', { editor })()
    const slice = plugin.props.clipboardTextParser('# Heading\n\n正文**X**\n\n- first\n- second', editor.state.doc.resolve(1), false)
    const content = slice.content.toJSON()
    expect(content.map((node: { type: string }) => node.type)).toEqual(['heading', 'paragraph', 'bulletList'])
    expect(content[1].content[1].marks).toEqual([{ type: 'bold' }])
  })

  it('preserves explicit literal formatting characters, Windows paths and code when pasting', () => {
    const literal = '**literal**'.replaceAll('*', String.fromCharCode(92) + '*')
    const tick = String.fromCharCode(96)
    const markdown = literal + '\n\n' + tick + 'C:\\notes\\x **code**' + tick
    editor = new Editor({ extensions: createEditorExtensions(), content: 'placeholder', contentType: 'markdown' })
    const extension = editor.extensionManager.extensions.find((item) => item.name === 'markdownEditing')!
    const [plugin] = getExtensionField(extension, 'addProseMirrorPlugins', { editor })()
    const slice = plugin.props.clipboardTextParser(markdown, editor.state.doc.resolve(1), false)
    const content = slice.content.toJSON()
    expect(content[0].content).toEqual([{ type: 'text', text: '**literal**' }])
    expect(content[1].content).toEqual([{ type: 'text', text: 'C:\\notes\\x **code**', marks: [{ type: 'code' }] }])
  })

  it('keeps explicit paste-as-plain-text literal', () => {
    editor = new Editor({ extensions: createEditorExtensions(), content: 'placeholder', contentType: 'markdown' })
    const extension = editor.extensionManager.extensions.find((item) => item.name === 'markdownEditing')!
    const [plugin] = getExtensionField(extension, 'addProseMirrorPlugins', { editor })()
    const slice = plugin.props.clipboardTextParser('**literal**', editor.state.doc.resolve(1), true)
    expect(slice.content.toJSON()[0].content).toEqual([{ type: 'text', text: '**literal**' }])
  })

  it('rejects an editor instance after Tiptap has destroyed it during document switching', () => {
    expect(isEditorUsable({ isDestroyed: false } as Editor)).toBe(true)
    editor = new Editor({ extensions: createEditorExtensions(), content: 'old document', contentType: 'markdown' })

    editor.destroy()

    expect(isEditorUsable(editor)).toBe(false)
  })

  it('round-trips the core structures used by a Typora-style document', () => {
    const markdown = `# Heading

Text with **bold**, *italic*, ~~strike~~ and [a link](https://example.com).

> A quote

- first
- second

\`inline code\`

\`\`\`ts
const ready = true
\`\`\``

    editor = new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
    })

    const output = editor.getMarkdown()
    expect(output).toContain('# Heading')
    expect(output).toContain('**bold**')
    expect(output).toContain('~~strike~~')
    expect(output).toContain('[a link](https://example.com)')
    expect(output).toContain('> A quote')
    expect(output).toContain('- first')
    expect(output).toContain('```ts')
    expect(getEditorOutline(editor)).toEqual([{ level: 1, text: 'Heading', index: 0 }])
  })

  it('preserves GFM tables, tasks, and images', () => {
    const markdown = `| Name | Ready |
| --- | --- |
| Markora | yes |

- [x] native files
- [ ] export

![logo](./logo.png)`

    editor = new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
      contentType: 'markdown',
    })

    const output = editor.getMarkdown()
    expect(output).toContain('| Name')
    expect(output).toContain('- [x] native files')
    expect(output).toContain('![logo](./logo.png)')
  })
})

describe('relative image paths', () => {
  it('resolves beside a Unix or Windows Markdown document', () => {
    expect(resolveLocalImagePath('/notes/guide/doc.md', '../images/logo.png')).toBe('/notes/images/logo.png')
    expect(resolveLocalImagePath('C:\\notes\\guide\\doc.md', '..\\images\\logo.png')).toBe('C:\\notes\\images\\logo.png')
    expect(resolveLocalImagePath('/notes/doc.md', 'file:///tmp/logo.png')).toBe('/tmp/logo.png')
  })

  it('leaves web and data sources to the webview', () => {
    expect(resolveLocalImagePath('/notes/doc.md', 'https://example.com/logo.png')).toBeNull()
    expect(resolveLocalImagePath('/notes/doc.md', 'data:image/png;base64,abc')).toBeNull()
  })
})
