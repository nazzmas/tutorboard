/**
 * ShapeRenderer — Renders individual shapes as SVG elements.
 *
 * Supports: path (freehand pen/highlighter), rect, ellipse, line, text
 */

import type { CanvasShapeClient } from 'deepspace'

interface ShapeRendererProps {
  shape: CanvasShapeClient
  isSelected: boolean
  /** Shapes only take pointer input when the select tool is active. */
  interactive: boolean
  onPointerDown: (e: React.PointerEvent, shapeId: string) => void
  onDoubleClick: (shapeId: string) => void
}

const SELECTION_PADDING = 4

export function ShapeRenderer({ shape, isSelected, interactive, onPointerDown, onDoubleClick }: ShapeRendererProps) {
  const fill = (shape.props.fill as string) ?? 'transparent'
  const stroke = (shape.props.stroke as string) ?? '#6366f1'
  const strokeWidth = (shape.props.strokeWidth as number) ?? 2

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!interactive) return
    e.stopPropagation()
    onPointerDown(e, shape.id)
  }

  // Lines store a signed width/height, so normalize the selection box.
  const box = {
    x: Math.min(shape.x, shape.x + shape.width),
    y: Math.min(shape.y, shape.y + shape.height),
    w: Math.abs(shape.width),
    h: Math.abs(shape.height),
  }

  return (
    <g
      data-testid={`shape-${shape.id}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onDoubleClick(shape.id)}
      style={{ cursor: interactive ? 'move' : undefined }}
      pointerEvents={interactive ? undefined : 'none'}
    >
      {isSelected && (
        <rect
          x={box.x - SELECTION_PADDING}
          y={box.y - SELECTION_PADDING}
          width={box.w + SELECTION_PADDING * 2}
          height={box.h + SELECTION_PADDING * 2}
          fill="none"
          style={{ stroke: 'var(--color-primary)' }}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          rx={2}
          pointerEvents="none"
        />
      )}

      {shape.type === 'path' && (
        <g transform={`translate(${shape.x}, ${shape.y})`}>
          {/* Wide invisible stroke makes thin lines easy to grab. */}
          <polyline
            points={String(shape.props.points ?? '')}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(strokeWidth, 12)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points={String(shape.props.points ?? '')}
            fill="none"
            stroke={stroke}
            strokeOpacity={(shape.props.opacity as number) ?? 1}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {shape.type === 'rect' && (
        <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} fill={fill} stroke={stroke} strokeWidth={strokeWidth} rx={4} />
      )}

      {shape.type === 'ellipse' && (
        <ellipse
          cx={shape.x + shape.width / 2}
          cy={shape.y + shape.height / 2}
          rx={shape.width / 2}
          ry={shape.height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )}

      {shape.type === 'line' && (
        <>
          <line
            x1={shape.x}
            y1={shape.y}
            x2={shape.x + shape.width}
            y2={shape.y + shape.height}
            stroke="transparent"
            strokeWidth={Math.max(strokeWidth, 12)}
          />
          <line
            x1={shape.x}
            y1={shape.y}
            x2={shape.x + shape.width}
            y2={shape.y + shape.height}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        </>
      )}

      {shape.type === 'text' && (
        <>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            fill={fill === 'transparent' ? 'transparent' : fill}
            stroke={isSelected ? stroke : 'transparent'}
            strokeWidth={isSelected ? 1 : 0}
            rx={2}
          />
          <text
            x={shape.x + 8}
            y={shape.y + shape.height / 2}
            dominantBaseline="central"
            fill={stroke}
            fontSize={(shape.props.fontSize as number) ?? 14}
            fontFamily="system-ui, sans-serif"
            pointerEvents="none"
          >
            {(shape.props.text as string) ?? 'Text'}
          </text>
        </>
      )}
    </g>
  )
}
