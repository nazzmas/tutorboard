/**
 * CanvasView — shared SVG whiteboard: freehand pen and highlighter, shapes,
 * typed text, scroll/zoom, and live cursors.
 *
 * Optionally draws `background` pages (an uploaded image, or the rendered
 * pages of a PDF) underneath the shapes, so tutor and student can mark up a
 * file together in real time.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useCanvas } from 'deepspace'
import { CanvasToolbar, type CanvasTool } from './CanvasToolbar'
import { ShapeRenderer } from './ShapeRenderer'
import { Badge } from '@/components/ui'

export interface BackgroundPage {
  src: string
  width: number
  height: number
}

interface CanvasViewProps {
  docId: string
  className?: string
  background?: BackgroundPage[]
}

interface DragState {
  type: 'create' | 'move'
  startX: number
  startY: number
  shapeId?: string
  originalX?: number
  originalY?: number
}

type Point = { x: number; y: number }

// User colors for multi-user cursors
const CURSOR_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6']
const PAGE_GAP = 24
const MAX_STROKE_POINTS = 600

/** Drop points closer than `minDist` and cap the total so one stroke stays small. */
export function simplifyStroke(points: Point[], minDist = 1.5): Point[] {
  if (points.length <= 2) return points
  const out: Point[] = [points[0]]
  for (const p of points.slice(1)) {
    const last = out[out.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) out.push(p)
  }
  if (out.length > MAX_STROKE_POINTS) {
    const step = out.length / MAX_STROKE_POINTS
    return Array.from({ length: MAX_STROKE_POINTS }, (_, i) => out[Math.floor(i * step)])
  }
  return out
}

/** Bounding box plus points relative to its corner, as an SVG points string. */
export function strokeToShape(points: Point[]) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(Math.max(...xs) - x, 1)
  const height = Math.max(Math.max(...ys) - y, 1)
  const rel = points.map((p) => `${Math.round((p.x - x) * 10) / 10},${Math.round((p.y - y) * 10) / 10}`).join(' ')
  return { x, y, width, height, points: rel }
}

export function CanvasView({ docId, className, background }: CanvasViewProps) {
  const { shapes, viewports, connected, addShape, moveShape, deleteShape, updateShape, resizeShape, setViewport, undo, redo } =
    useCanvas(docId)

  const [activeTool, setActiveTool] = useState<CanvasTool>('pen')
  const [activeColor, setActiveColor] = useState('#000000')
  const [strokeWidth, setStrokeWidth] = useState(4)
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [draftStroke, setDraftStroke] = useState<Point[] | null>(null)
  const [draftBox, setDraftBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0, panX: 0, panY: 0 })

  const svgRef = useRef<SVGSVGElement>(null)

  // Fit the background width to the view on first load.
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !background?.length) return
    const key = background.map((p) => p.src.slice(-32)).join('|')
    if (fittedFor.current === key) return
    fittedFor.current = key
    const maxW = Math.max(...background.map((p) => p.width))
    const rect = svg.getBoundingClientRect()
    const z = Math.min(Math.max((rect.width - 32) / maxW, 0.1), 2)
    setZoom(z)
    setPan({ x: (rect.width - maxW * z) / 2, y: 16 })
  }, [background])

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current
      if (!svg) return { x: 0, y: 0 }
      const rect = svg.getBoundingClientRect()
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      }
    },
    [pan, zoom],
  )

  // Report viewport on pan/zoom change
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    setViewport({
      x: -pan.x / zoom,
      y: -pan.y / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
      zoom,
    })
  }, [pan, zoom, setViewport])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedShapeId && document.activeElement === document.body) {
          e.preventDefault()
          deleteShape(selectedShapeId)
          setSelectedShapeId(null)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedShapeId, deleteShape, undo, redo])

  // Wheel: scroll by default, zoom with Ctrl/Cmd or a trackpad pinch.
  // Attached natively so preventDefault works (React wheel listeners are passive).
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = svg.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        setZoom((oldZoom) => {
          const newZoom = Math.min(Math.max(oldZoom * Math.exp(-e.deltaY * 0.01), 0.1), 5)
          setPan((p) => ({
            x: mouseX - (mouseX - p.x) * (newZoom / oldZoom),
            y: mouseY - (mouseY - p.y) * (newZoom / oldZoom),
          }))
          return newZoom
        })
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const addText = useCallback(
    (pos: Point) => {
      const text = window.prompt('Type your text')?.trim()
      if (!text) return
      const fontSize = 12 + strokeWidth * 2
      addShape({
        type: 'text',
        x: pos.x,
        y: pos.y,
        width: Math.max(40, text.length * fontSize * 0.6 + 16),
        height: fontSize + 16,
        props: { stroke: activeColor, fill: 'transparent', text, fontSize },
      })
    },
    [addShape, activeColor, strokeWidth],
  )

  const editText = useCallback(
    (shapeId: string) => {
      const shape = shapes.find((s) => s.id === shapeId)
      if (!shape || shape.type !== 'text') return
      const next = window.prompt('Edit text', String(shape.props.text ?? ''))
      if (next === null) return
      const text = next.trim()
      if (!text) {
        deleteShape(shapeId)
        return
      }
      const fontSize = Number(shape.props.fontSize ?? 14)
      updateShape(shapeId, { ...shape.props, text })
      resizeShape(shapeId, Math.max(40, text.length * fontSize * 0.6 + 16), shape.height)
    },
    [shapes, updateShape, resizeShape, deleteShape],
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Middle button, or space-free "hand" drag with the select tool, pans.
      if (e.button === 1) {
        e.preventDefault()
        setIsPanning(true)
        setPanStart({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y })
        return
      }
      if (e.button !== 0) return

      const pos = screenToCanvas(e.clientX, e.clientY)

      if (activeTool === 'select') {
        setSelectedShapeId(null)
        setIsPanning(true)
        setPanStart({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y })
        return
      }
      if (activeTool === 'text') {
        addText(pos)
        return
      }

      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      if (activeTool === 'pen' || activeTool === 'highlighter') {
        setDraftStroke([pos])
        return
      }
      setDragState({ type: 'create', startX: pos.x, startY: pos.y })
      setDraftBox({ x: pos.x, y: pos.y, w: 0, h: 0 })
    },
    [activeTool, screenToCanvas, pan, addText],
  )

  // Pointer down on a shape (select tool only)
  const handleShapePointerDown = useCallback(
    (e: React.PointerEvent, shapeId: string) => {
      if (activeTool !== 'select') return
      const shape = shapes.find((s) => s.id === shapeId)
      if (!shape) return
      setSelectedShapeId(shapeId)
      setDragState({
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        shapeId,
        originalX: shape.x,
        originalY: shape.y,
      })
    },
    [activeTool, shapes],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning) {
        setPan({
          x: panStart.panX + (e.clientX - panStart.x),
          y: panStart.panY + (e.clientY - panStart.y),
        })
        return
      }
      if (draftStroke) {
        const pos = screenToCanvas(e.clientX, e.clientY)
        setDraftStroke((pts) => (pts ? [...pts, pos] : pts))
        return
      }
      if (!dragState) return
      if (dragState.type === 'create') {
        const pos = screenToCanvas(e.clientX, e.clientY)
        setDraftBox({
          x: Math.min(dragState.startX, pos.x),
          y: Math.min(dragState.startY, pos.y),
          w: Math.abs(pos.x - dragState.startX),
          h: Math.abs(pos.y - dragState.startY),
        })
        return
      }
      if (dragState.type === 'move' && dragState.shapeId) {
        const dx = (e.clientX - dragState.startX) / zoom
        const dy = (e.clientY - dragState.startY) / zoom
        moveShape(dragState.shapeId, dragState.originalX! + dx, dragState.originalY! + dy)
      }
    },
    [dragState, draftStroke, isPanning, panStart, zoom, moveShape, screenToCanvas],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning) {
        setIsPanning(false)
        return
      }

      if (draftStroke) {
        const points = simplifyStroke(draftStroke)
        setDraftStroke(null)
        if (points.length < 2) return
        const { x, y, width, height, points: rel } = strokeToShape(points)
        const highlighter = activeTool === 'highlighter'
        addShape({
          type: 'path',
          x,
          y,
          width,
          height,
          props: {
            stroke: activeColor,
            strokeWidth: highlighter ? strokeWidth * 4 : strokeWidth,
            opacity: highlighter ? 0.35 : 1,
            points: rel,
          },
        })
        return
      }

      if (!dragState) return
      if (dragState.type === 'create') {
        const pos = screenToCanvas(e.clientX, e.clientY)
        // Lines keep direction: store the start point and a signed size.
        const isLine = activeTool === 'line'
        const x = isLine ? dragState.startX : Math.min(dragState.startX, pos.x)
        const y = isLine ? dragState.startY : Math.min(dragState.startY, pos.y)
        const width = isLine ? pos.x - dragState.startX : Math.max(Math.abs(pos.x - dragState.startX), 20)
        const height = isLine ? pos.y - dragState.startY : Math.max(Math.abs(pos.y - dragState.startY), 20)
        addShape({
          type: activeTool,
          x,
          y,
          width,
          height,
          props: { stroke: activeColor, strokeWidth, fill: 'transparent' },
        })
        setDraftBox(null)
      }
      setDragState(null)
    },
    [dragState, draftStroke, isPanning, screenToCanvas, activeTool, activeColor, strokeWidth, addShape],
  )

  const handleDelete = useCallback(() => {
    if (selectedShapeId) {
      deleteShape(selectedShapeId)
      setSelectedShapeId(null)
    }
  }, [selectedShapeId, deleteShape])

  // Stack background pages vertically.
  let pageTop = 0
  const pages = (background ?? []).map((p) => {
    const placed = { ...p, top: pageTop }
    pageTop += p.height + PAGE_GAP
    return placed
  })

  const cursor =
    activeTool === 'select'
      ? isPanning
        ? 'grabbing'
        : 'grab'
      : activeTool === 'text'
        ? 'text'
        : 'crosshair'

  return (
    <div data-testid="canvas-view" className={`flex flex-col h-full ${className ?? ''}`}>
      <CanvasToolbar
        activeTool={activeTool}
        activeColor={activeColor}
        strokeWidth={strokeWidth}
        hasSelection={selectedShapeId !== null}
        onToolChange={setActiveTool}
        onColorChange={setActiveColor}
        onStrokeWidthChange={setStrokeWidth}
        onDelete={handleDelete}
        onUndo={undo}
        onRedo={redo}
      />

      <div className="relative flex-1 overflow-hidden bg-background">
        <div className="absolute top-3 right-3 z-10">
          {connected ? (
            <Badge variant="success" className="text-xs">
              <span className="w-1.5 h-1.5 bg-success rounded-full mr-1" />
              Live
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              <span className="w-1.5 h-1.5 bg-warning rounded-full animate-pulse mr-1" />
              Connecting...
            </Badge>
          )}
        </div>

        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">Scroll to move · Ctrl/⌘ + scroll to zoom</span>
          <span className="text-xs text-muted-foreground bg-card/80 px-2 py-1 rounded border border-border">
            {Math.round(zoom * 100)}%
          </span>
        </div>

        <svg
          ref={svgRef}
          data-testid="canvas-svg"
          className="w-full h-full select-none"
          style={{ cursor, touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <defs>
            <pattern
              id={`grid-${docId}`}
              width={20 * zoom}
              height={20 * zoom}
              patternUnits="userSpaceOnUse"
              x={pan.x % (20 * zoom)}
              y={pan.y % (20 * zoom)}
            >
              <circle cx={1} cy={1} r={0.5} fill="currentColor" className="text-border" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#grid-${docId})`} />

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {pages.map((p, i) => (
              <g key={i} pointerEvents="none">
                <rect x={0} y={p.top} width={p.width} height={p.height} fill="#fff" stroke="#e5e7eb" />
                <image href={p.src} x={0} y={p.top} width={p.width} height={p.height} preserveAspectRatio="xMidYMid meet" />
              </g>
            ))}

            {shapes.map((shape) => (
              <ShapeRenderer
                key={shape.id}
                shape={shape}
                isSelected={shape.id === selectedShapeId}
                interactive={activeTool === 'select'}
                onPointerDown={handleShapePointerDown}
                onDoubleClick={editText}
              />
            ))}

            {draftStroke && draftStroke.length > 1 && (
              <polyline
                points={draftStroke.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={activeColor}
                strokeWidth={activeTool === 'highlighter' ? strokeWidth * 4 : strokeWidth}
                strokeOpacity={activeTool === 'highlighter' ? 0.35 : 1}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}

            {draftBox && (
              <rect
                x={draftBox.x}
                y={draftBox.y}
                width={draftBox.w}
                height={draftBox.h}
                fill="transparent"
                stroke={activeColor}
                strokeWidth={1 / zoom}
                strokeDasharray={`${4 / zoom} ${3 / zoom}`}
                pointerEvents="none"
              />
            )}

            {viewports.map((vp, i) => (
              <g key={vp.userId} pointerEvents="none">
                <circle cx={vp.x + vp.width / 2} cy={vp.y + 20} r={4 / zoom} fill={CURSOR_COLORS[i % CURSOR_COLORS.length]} />
                <text
                  x={vp.x + vp.width / 2 + 8 / zoom}
                  y={vp.y + 24 / zoom}
                  fontSize={11 / zoom}
                  fill={CURSOR_COLORS[i % CURSOR_COLORS.length]}
                  fontFamily="system-ui, sans-serif"
                >
                  User {vp.userId.slice(0, 6)}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
