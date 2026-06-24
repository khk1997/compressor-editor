import { useRef } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import { useThumbnail } from './useThumbnail'
import type { CropNodeData } from '../types'

/** Display width of the preview in px; the height follows the source aspect. */
const DISPLAY_W = 196

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '4:3', ratio: 4 / 3 }
]

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Largest rect of the given aspect ratio, centered in (srcW × srcH). */
function fitAspect(srcW: number, srcH: number, ratio: number): Rect {
  let w = srcW
  let h = Math.round(w / ratio)
  if (h > srcH) {
    h = srcH
    w = Math.round(h * ratio)
  }
  return { x: Math.round((srcW - w) / 2), y: Math.round((srcH - h) / 2), width: w, height: h }
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/** Interactive crop overlay drawn on top of a source-frame thumbnail. */
function CropPreview({
  srcW,
  srcH,
  value,
  imgUrl,
  loading,
  onChange
}: {
  srcW: number
  srcH: number
  value: Rect
  imgUrl: string | null
  loading: boolean
  onChange: (r: Rect) => void
}): JSX.Element {
  const scale = srcW / DISPLAY_W // source px per display px
  const displayH = Math.round(DISPLAY_W / (srcW / srcH))
  // An inactive (0×0) crop shows the full frame as the starting selection.
  const active = value.width > 0 && value.height > 0
  const r: Rect = active ? value : { x: 0, y: 0, width: srcW, height: srcH }
  const drag = useRef<{ mode: DragMode; sx: number; sy: number; orig: Rect } | null>(null)

  const begin = (mode: DragMode) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: { ...r } }

    const move = (ev: PointerEvent): void => {
      const g = drag.current
      if (!g) return
      const dx = (ev.clientX - g.sx) * scale
      const dy = (ev.clientY - g.sy) * scale
      let { x, y, width, height } = g.orig
      if (g.mode === 'move') {
        x = clamp(g.orig.x + dx, 0, srcW - width)
        y = clamp(g.orig.y + dy, 0, srcH - height)
      } else {
        // Resize from the dragged corner; keep the opposite corner anchored.
        let x1 = g.orig.x
        let y1 = g.orig.y
        let x2 = g.orig.x + g.orig.width
        let y2 = g.orig.y + g.orig.height
        if (g.mode === 'nw') {
          x1 = clamp(g.orig.x + dx, 0, x2 - 8)
          y1 = clamp(g.orig.y + dy, 0, y2 - 8)
        } else if (g.mode === 'ne') {
          x2 = clamp(x2 + dx, x1 + 8, srcW)
          y1 = clamp(g.orig.y + dy, 0, y2 - 8)
        } else if (g.mode === 'sw') {
          x1 = clamp(g.orig.x + dx, 0, x2 - 8)
          y2 = clamp(y2 + dy, y1 + 8, srcH)
        } else {
          x2 = clamp(x2 + dx, x1 + 8, srcW)
          y2 = clamp(y2 + dy, y1 + 8, srcH)
        }
        x = x1
        y = y1
        width = x2 - x1
        height = y2 - y1
      }
      onChange({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
    const up = (): void => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="crop-preview nodrag"
      style={{ width: DISPLAY_W, height: displayH }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {imgUrl ? (
        <img className="crop-img" src={imgUrl} draggable={false} alt="" />
      ) : (
        <div className="crop-img crop-img-loading">{loading ? 'decoding…' : 'no preview'}</div>
      )}
      <div
        className="crop-rect"
        style={{
          left: r.x / scale,
          top: r.y / scale,
          width: r.width / scale,
          height: r.height / scale
        }}
        onPointerDown={begin('move')}
      >
        {(['nw', 'ne', 'sw', 'se'] as DragMode[]).map((c) => (
          <span key={c} className={`crop-h crop-h-${c}`} onPointerDown={begin(c as DragMode)} />
        ))}
      </div>
    </div>
  )
}

export function CropNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as CropNodeData
  const num = (v: string): number => Number(v) || 0

  const srcW = d.srcWidth ?? null
  const srcH = d.srcHeight ?? null
  const hasPreview = !!(d.srcKind && d.srcPath && srcW && srcH)

  const { url: thumbUrl, loading: thumbLoading } = useThumbnail(
    hasPreview ? { kind: d.srcKind as 'video' | 'sequence', path: d.srcPath as string, maxWidth: DISPLAY_W * 2 } : null
  )

  const setRect = (r: Rect): void =>
    updateNodeData(id, { x: r.x, y: r.y, width: r.width, height: r.height })
  const applyAspect = (ratio: number | null): void => {
    if (!srcW || !srcH) return
    if (ratio == null) return // "Free" leaves the current rect alone
    setRect(fitAspect(srcW, srcH, ratio))
  }
  const center = (): void => {
    if (!srcW || !srcH || !d.width || !d.height) return
    setRect({
      x: Math.round((srcW - d.width) / 2),
      y: Math.round((srcH - d.height) / 2),
      width: d.width,
      height: d.height
    })
  }
  const full = (): void => {
    if (srcW && srcH) setRect({ x: 0, y: 0, width: srcW, height: srcH })
  }
  const reset = (): void => setRect({ x: 0, y: 0, width: 0, height: 0 })

  const outOfBounds =
    !!srcW && !!srcH && d.width > 0 && d.height > 0 && (d.x + d.width > srcW || d.y + d.height > srcH)

  return (
    <div className="node node-crop">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-crop" /> Crop
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        {hasPreview && (
          <>
            <CropPreview
              srcW={srcW as number}
              srcH={srcH as number}
              value={{ x: d.x, y: d.y, width: d.width, height: d.height }}
              imgUrl={thumbUrl}
              loading={thumbLoading}
              onChange={setRect}
            />
            <div className="crop-presets nodrag">
              {ASPECTS.map((a) => (
                <button
                  key={a.label}
                  className="chip"
                  onClick={() => applyAspect(a.ratio)}
                  title={a.ratio == null ? 'Drag freely' : `Set ${a.label} aspect`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <div className="crop-presets nodrag">
              <button className="chip" onClick={center} title="Center the crop">
                Center
              </button>
              <button className="chip" onClick={full} title="Select the whole frame">
                Full
              </button>
              <button className="chip" onClick={reset} title="Disable crop">
                Reset
              </button>
            </div>
            <div className="hint hint-muted">Source: {srcW} × {srcH}</div>
          </>
        )}

        <div className="field-grid">
          <label className="field">
            <span>Width</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              placeholder="0"
              value={d.width || ''}
              onChange={(e) => updateNodeData(id, { width: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Height</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              placeholder="0"
              value={d.height || ''}
              onChange={(e) => updateNodeData(id, { height: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>X</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              placeholder="0"
              value={d.x || ''}
              onChange={(e) => updateNodeData(id, { x: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Y</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              placeholder="0"
              value={d.y || ''}
              onChange={(e) => updateNodeData(id, { y: num(e.target.value) })}
            />
          </label>
        </div>
        {outOfBounds && (
          <div className="hint hint-warn">⚠ Crop extends past the {srcW}×{srcH} source.</div>
        )}
        {(!d.width || !d.height) && (
          <div className="hint">Set width &amp; height to enable crop.</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
