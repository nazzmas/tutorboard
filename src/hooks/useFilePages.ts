/**
 * Turn an uploaded file into page images the whiteboard can draw on.
 *
 * Images become a single page. PDFs are rendered page by page in the browser
 * with PDF.js (loaded only when a PDF is opened). Other file types return
 * `unsupported` so the UI can fall back to a download link.
 */

import { useEffect, useState } from 'react'
import type { BackgroundPage } from '@/components/canvas/CanvasView'

const MAX_PDF_PAGES = 30
const PDF_RENDER_SCALE = 1.5

export type FilePagesState =
  | { status: 'loading' }
  | { status: 'ready'; pages: BackgroundPage[] }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

function loadImage(src: string): Promise<BackgroundPage> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ src, width: img.naturalWidth || 800, height: img.naturalHeight || 600 })
    img.onerror = () => reject(new Error('Could not load the image'))
    img.src = src
  })
}

async function renderPdf(url: string): Promise<BackgroundPage[]> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const data = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not download the PDF (${r.status})`)
    return r.arrayBuffer()
  })
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: BackgroundPage[] = []
  const count = Math.min(doc.numPages, MAX_PDF_PAGES)
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available in this browser')
    await page.render({ canvasContext: context, viewport }).promise
    pages.push({
      src: canvas.toDataURL('image/jpeg', 0.85),
      width: viewport.width / PDF_RENDER_SCALE,
      height: viewport.height / PDF_RENDER_SCALE,
    })
  }
  return pages
}

export function isViewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf'
}

export function useFilePages(url: string | null, mimeType: string): FilePagesState {
  const [state, setState] = useState<FilePagesState>({ status: 'loading' })

  useEffect(() => {
    if (!url) return
    if (!isViewable(mimeType)) {
      setState({ status: 'unsupported' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    const work = mimeType === 'application/pdf' ? renderPdf(url) : loadImage(url).then((p) => [p])
    work
      .then((pages) => !cancelled && setState({ status: 'ready', pages }))
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not open the file' })
      })
    return () => {
      cancelled = true
    }
  }, [url, mimeType])

  return state
}

/** Read a file from its URL as base64 (for sending to the AI assistant). */
export async function fileUrlToBase64(url: string): Promise<string> {
  const blob = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not read the file (${r.status})`)
    return r.blob()
  })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.readAsDataURL(blob)
  })
}
