import { useReactFlow } from '@xyflow/react'

/** Small ✕ in a node header that removes the node (and its edges). */
export function DeleteButton({ id }: { id: string }): JSX.Element {
  const { deleteElements } = useReactFlow()
  return (
    <button
      className="node-del nodrag"
      title="Delete node"
      onClick={() => deleteElements({ nodes: [{ id }] })}
    >
      ✕
    </button>
  )
}
