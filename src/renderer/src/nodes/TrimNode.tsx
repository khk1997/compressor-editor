import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import { useThumbnail, type ThumbReq } from './useThumbnail'
import type { TrimNodeData } from '../types'

/** Preview frame at the start point (video) or first frame (sequence). */
function thumbReqFor(d: TrimNodeData): ThumbReq | null {
  if (d.srcKind === 'video' && d.srcPath)
    return { kind: 'video', path: d.srcPath, timeSec: d.startSec || 0, maxWidth: 392 }
  if (d.srcKind === 'sequence' && d.srcPath) return { kind: 'sequence', path: d.srcPath, maxWidth: 392 }
  return null
}

export function TrimNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as TrimNodeData
  const { url: thumb } = useThumbnail(thumbReqFor(d))

  const num = (v: string): number => Math.max(0, Math.floor(Number(v) || 0))
  const dropFirst = d.dropFirst ?? 0
  const dropLast = d.dropLast ?? 0
  const total = d.srcFrames ?? null
  const fps = d.srcFps ?? null

  // Frame drops apply *after* the seconds trim, so count against that window.
  let windowFrames = total
  if (total != null && fps && fps > 0 && (d.startSec > 0 || d.endSec != null)) {
    const dur = total / fps
    const end = d.endSec != null ? Math.min(d.endSec, dur) : dur
    windowFrames = Math.max(0, Math.round((end - d.startSec) * fps))
  }
  const outFrames = windowFrames != null ? windowFrames - dropFirst - dropLast : null
  const tooMany = outFrames != null && outFrames < 1

  return (
    <div className="node node-trim">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-trim" /> Trim
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        {thumb && (
          <>
            <img className="node-thumb" src={thumb} draggable={false} alt="" />
            <div className="hint hint-muted">Frame at start ({(d.startSec || 0).toFixed(1)}s)</div>
          </>
        )}
        <label className="field">
          <span>Start (sec)</span>
          <input
            className="nodrag"
            type="number"
            min={0}
            step={0.1}
            placeholder="0"
            value={d.startSec || ''}
            onChange={(e) => updateNodeData(id, { startSec: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="field">
          <span>End (sec, blank = end)</span>
          <input
            className="nodrag"
            type="number"
            min={0}
            step={0.1}
            placeholder="end"
            value={d.endSec ?? ''}
            onChange={(e) =>
              updateNodeData(id, { endSec: e.target.value ? Number(e.target.value) : null })
            }
          />
        </label>

        <div className="hint hint-muted">Frame trim (e.g. drop the duplicate loop frame)</div>
        <div className="field-grid">
          <label className="field">
            <span>Drop first (frames)</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              step={1}
              placeholder="0"
              value={dropFirst || ''}
              onChange={(e) => updateNodeData(id, { dropFirst: num(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Drop last (frames)</span>
            <input
              className="nodrag"
              type="number"
              min={0}
              step={1}
              placeholder="0"
              value={dropLast || ''}
              onChange={(e) => updateNodeData(id, { dropLast: num(e.target.value) })}
            />
          </label>
        </div>
        {windowFrames != null && (dropFirst > 0 || dropLast > 0) && (
          <div className={`hint ${tooMany ? 'hint-warn' : 'hint-muted'}`}>
            {tooMany
              ? `⚠ Dropping ${dropFirst + dropLast} of ${windowFrames} frames leaves nothing.`
              : `Outputs ${outFrames} of ${windowFrames} frames`}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
