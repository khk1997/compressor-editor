import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import type { TrimNodeData } from '../types'

export function TrimNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as TrimNodeData

  return (
    <div className="node node-trim">
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-trim" /> Trim
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
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
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
