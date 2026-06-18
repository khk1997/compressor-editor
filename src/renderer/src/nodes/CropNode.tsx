import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import type { CropNodeData } from '../types'

export function CropNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as CropNodeData
  const num = (v: string): number => Number(v) || 0

  return (
    <div className="node node-crop">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-crop" /> Crop
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
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
        {(!d.width || !d.height) && (
          <div className="hint">Set width &amp; height to enable crop.</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
