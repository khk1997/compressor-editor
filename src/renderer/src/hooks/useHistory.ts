import { useCallback, useRef } from 'react'
import { type Edge, type Node } from '@xyflow/react'

const MAX_HISTORY = 50

interface Snapshot {
  nodes: Node[]
  edges: Edge[]
}

/**
 * Undo/redo for a ReactFlow graph.
 *
 * Usage:
 *   const { pushHistory, undo, redo } = useHistory(nodesRef, edgesRef, setNodes, setEdges)
 *
 * Call pushHistory() BEFORE any structural mutation (add node, connect, splice, delete).
 * Keyboard wiring (Cmd+Z / Cmd+Shift+Z) is handled by the caller.
 */
export function useHistory(
  nodesRef: React.MutableRefObject<Node[]>,
  edgesRef: React.MutableRefObject<Edge[]>,
  setNodes: (ns: Node[]) => void,
  setEdges: (es: Edge[]) => void
): {
  pushHistory: () => void
  undo: () => void
  redo: () => void
} {
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])

  const pushHistory = useCallback(() => {
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), { nodes: nodesRef.current, edges: edgesRef.current }]
    future.current = []
  }, [nodesRef, edgesRef])

  const undo = useCallback(() => {
    if (!past.current.length) return
    const prev = past.current[past.current.length - 1]
    past.current = past.current.slice(0, -1)
    future.current = [{ nodes: nodesRef.current, edges: edgesRef.current }, ...future.current.slice(0, MAX_HISTORY - 1)]
    setNodes(prev.nodes)
    setEdges(prev.edges)
  }, [nodesRef, edgesRef, setNodes, setEdges])

  const redo = useCallback(() => {
    if (!future.current.length) return
    const next = future.current[0]
    future.current = future.current.slice(1)
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), { nodes: nodesRef.current, edges: edgesRef.current }]
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [nodesRef, edgesRef, setNodes, setEdges])

  return { pushHistory, undo, redo }
}
