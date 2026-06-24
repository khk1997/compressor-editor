import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import type { LocationNodeData } from '../types'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

export function LocationNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as LocationNodeData

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.openFolder()
    if (dir) updateNodeData(id, { dir })
  }

  return (
    <div className="node node-location">
      <div className="node-title">
        <span className="dot dot-loc" /> Location
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        <button className="btn btn-pick nodrag" onClick={pickFolder}>
          {d.dir ? basename(d.dir) : 'Pick folder…'}
        </button>
        {d.dir && <div className="hint hint-loc-path">{d.dir}</div>}
        {!d.dir && <div className="hint" style={{ color: 'var(--muted)' }}>Connect to Output nodes to share this folder.</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
