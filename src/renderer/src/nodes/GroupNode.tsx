import { useReactFlow, type NodeProps } from '@xyflow/react'

/**
 * Lightweight group frame (Blender-style): a translucent, resizable-by-regroup
 * box that visually contains its member nodes. Members carry `parentId` so they
 * drag together and so scope-aware actions (connect-to-all-outputs, location)
 * can limit themselves to the group. Renaming is inline via the header input.
 */
export function GroupNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as { label?: string }
  return (
    <div className="node-group">
      <input
        className="node-group-title nodrag"
        value={d.label ?? 'Group'}
        spellCheck={false}
        onChange={(e) => updateNodeData(id, { label: e.target.value })}
      />
    </div>
  )
}
