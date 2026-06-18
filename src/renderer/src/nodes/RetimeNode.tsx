import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import type { Interpolation, RetimeNodeData } from '../types'

export function RetimeNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as RetimeNodeData
  const ratio = d.speed > 0 ? 100 / d.speed : 1

  return (
    <div className="node node-retime">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-retime" /> Retime
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        <label className="field">
          <span>Speed (%)</span>
          <input
            className="nodrag"
            type="number"
            min={1}
            max={1000}
            placeholder="100"
            value={d.speed}
            onChange={(e) => updateNodeData(id, { speed: Number(e.target.value) || 100 })}
          />
        </label>

        <label className="field-row">
          <input
            className="nodrag"
            type="checkbox"
            checked={d.reverse}
            onChange={(e) => updateNodeData(id, { reverse: e.target.checked })}
          />
          <span>Reverse</span>
        </label>

        <label className="field">
          <span>Time interpolation</span>
          <select
            className="nodrag"
            value={d.interpolation}
            onChange={(e) => updateNodeData(id, { interpolation: e.target.value as Interpolation })}
          >
            <option value="sampling">Frame sampling</option>
            <option value="blend">Frame blending</option>
            <option value="optical">Optical flow (slow)</option>
          </select>
        </label>

        <div className="hint">Output length × {ratio.toFixed(2)}</div>
        {d.reverse && <div className="hint hint-warn">⚠ Reverse buffers the whole clip in memory.</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
