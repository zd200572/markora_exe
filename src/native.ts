import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface OpenedDocument {
  path: string
  title: string
  contents: string
}

export interface WorkspaceFile {
  path: string
  relativePath: string
  title: string
}

export interface Workspace {
  root: string
  name: string
  files: WorkspaceFile[]
}

export function isDesktop(): boolean {
  if (isTauri()) return true
  if (typeof window !== 'undefined') {
    if ((window as any).pywebview !== undefined) return true
    if (window.location.search.includes('mode=desktop')) return true
  }
  return false
}

export function isPyWebView(): boolean {
  return typeof window !== 'undefined' && (window as any).pywebview !== undefined
}

export async function startWindowDrag() {
  if (!isTauri()) return
  try {
    await getCurrentWindow().startDragging()
  } catch (error) {
    console.error('Markora could not start window dragging', error)
  }
}

export async function quitNativeApp() {
  if (!isTauri()) return
  await getCurrentWindow().destroy()
}

export async function openNativeDocument(): Promise<OpenedDocument | null> {
  const pywebview = (window as any).pywebview
  if (pywebview?.api?.open_markdown) {
    return await pywebview.api.open_markdown()
  }
  if (isTauri()) {
    return invoke<OpenedDocument | null>('open_markdown')
  }
  return null
}

export async function saveNativeDocument(
  path: string | undefined,
  suggestedName: string,
  contents: string,
  expectedContents?: string,
  force = false,
): Promise<string | null> {
  const pywebview = (window as any).pywebview
  if (pywebview?.api?.save_markdown) {
    return await pywebview.api.save_markdown(path ?? null, suggestedName, contents)
  }
  if (isTauri()) {
    return invoke<string | null>('save_markdown', {
      path: path ?? null,
      suggestedName,
      contents,
      expectedContents: expectedContents ?? null,
      force,
    })
  }
  return null
}

export async function revealNativeDocument(path: string) {
  if (!isTauri()) return
  return invoke<void>('reveal_in_folder', { path })
}

export async function exportHtmlFile(suggestedName: string, contents: string): Promise<string | null> {
  const pywebview = (window as any).pywebview
  if (pywebview?.api?.export_html_file) {
    return await pywebview.api.export_html_file(suggestedName, contents)
  }
  if (isTauri()) {
    return invoke<string | null>('export_html_file', { suggestedName, contents })
  }
  const blob = new Blob([contents], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (suggestedName.replace(/[\\/:*?"<>|]/g, '-')) + '.html'
  a.click()
  URL.revokeObjectURL(url)
  return suggestedName + '.html'
}

export async function openExportInBrowser(title: string, contents: string): Promise<void> {
  const pywebview = (window as any).pywebview
  if (pywebview?.api?.open_export_in_browser) {
    await pywebview.api.open_export_in_browser(title, contents)
    return
  }
  if (isTauri()) {
    return invoke<void>('open_export_in_browser', { title, contents })
  }
  const blob = new Blob([contents], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.click()
  }
}

function whenPyWebViewReady(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const w = window as any
      return Boolean(w.pywebview?.api?.take_startup_document)
    }
    if (check()) {
      resolve(true)
      return
    }
    const timer = window.setTimeout(() => {
      window.clearInterval(interval)
      resolve(check())
    }, timeoutMs)

    const interval = window.setInterval(() => {
      if (check()) {
        window.clearInterval(interval)
        window.clearTimeout(timer)
        resolve(true)
      }
    }, 30)

    window.addEventListener('pywebviewready', () => {
      if (check()) {
        window.clearInterval(interval)
        window.clearTimeout(timer)
        resolve(true)
      }
    }, { once: true })
  })
}

// Memoized so a remount (e.g. React StrictMode double-mount) shares one call:
// the Python-side startup document is consumed on first read.
let startupDocumentsPromise: Promise<OpenedDocument[]> | null = null

export async function takeStartupDocuments(): Promise<OpenedDocument[]> {
  if (isTauri()) {
    return invoke<OpenedDocument[]>('take_pending_documents')
  }
  if (isDesktop()) {
    startupDocumentsPromise ??= (async () => {
      await whenPyWebViewReady()
      const w = window as any
      const doc = await w.pywebview?.api?.take_startup_document?.()
      return doc ? [doc] : []
    })()
    return startupDocumentsPromise
  }
  return []
}

export async function onNativeDocumentOpened(handler: (document: OpenedDocument) => void): Promise<UnlistenFn> {
  if (isDesktop() && !isTauri()) {
    const fn = (doc: OpenedDocument) => {
      if (doc && doc.path) handler(doc)
    }
    ;(window as any).__markoraOpenFile = fn
    return () => {
      if ((window as any).__markoraOpenFile === fn) {
        delete (window as any).__markoraOpenFile
      }
    }
  }
  if (!isTauri()) return () => {}
  return listen<OpenedDocument>('open-document', (event) => handler(event.payload))
}

export async function onNativeCloseRequested(shouldAllowClose: () => boolean): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault()
    if (shouldAllowClose()) await quitNativeApp()
  })
}

export async function authorizeNativeImage(documentPath: string, source: string) {
  if (!isTauri()) return source
  return invoke<string>('authorize_local_image', { documentPath, source })
}

export async function openNativeWorkspace(): Promise<Workspace | null> {
  if (!isTauri()) return null
  return invoke<Workspace | null>('open_workspace')
}

export async function refreshNativeWorkspace(root: string): Promise<Workspace> {
  if (!isTauri()) return { root, name: '', files: [] }
  return invoke<Workspace>('refresh_workspace', { root })
}

export async function readNativeWorkspaceDocument(path: string): Promise<OpenedDocument> {
  if (!isTauri()) throw new Error('Not in desktop environment')
  return invoke<OpenedDocument>('read_workspace_document', { path })
}

export async function readExternalDocument(path: string): Promise<string> {
  const pywebview = (window as any).pywebview
  if (pywebview?.api?.read_markdown_file) {
    const contents = await pywebview.api.read_markdown_file(path)
    if (typeof contents !== 'string') throw new Error(`Cannot read ${path}`)
    return contents
  }
  if (isTauri()) return invoke<string>('read_external_document', { path })
  throw new Error('Not in desktop environment')
}

export async function onMenuAction(handler: (id: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return listen<string>('menu', (event) => handler(event.payload))
}

export async function onToast(handler: (message: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return listen<string>('toast', (event) => handler(event.payload))
}

export async function syncThemeMenu(theme: string): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('sync_theme_menu', { theme })
}
