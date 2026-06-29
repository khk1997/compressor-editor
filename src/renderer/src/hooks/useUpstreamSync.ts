import { useEffect } from 'react'
import { type Edge, type Node, useReactFlow } from '@xyflow/react'
import {
  type CropNodeData,
  type InputNodeData,
  type LocationNodeData,
  type OutputNodeData,
  type TrimNodeData
} from '../types'
import { resolveInputNode } from '../utils/jobBuilder'

type UpdateNodeData = ReturnType<typeof useReactFlow>['updateNodeData']

/** Keeps Location → Output and Input → Crop/Trim upstream data in sync. */
export function useUpstreamSync(
  nodes: Node[],
  edges: Edge[],
  updateNodeData: UpdateNodeData
): void {
  // Sync locationDir + locationConnected from connected Location nodes into each Output node.
  useEffect(() => {
    type LocInfo = { connected: boolean; dir: string | null }
    const locationByOutput = new Map<string, LocInfo>()
    for (const edge of edges) {
      if (edge.targetHandle !== 'location') continue
      const src = nodes.find((n) => n.id === edge.source)
      if (src?.type === 'location-node') {
        locationByOutput.set(edge.target, {
          connected: true,
          dir: (src.data as LocationNodeData).dir
        })
      }
    }
    for (const node of nodes.filter((n) => n.type === 'output-node')) {
      const loc = locationByOutput.get(node.id)
      const newConnected = loc?.connected ?? false
      const newDir = loc?.dir ?? null
      const data = node.data as OutputNodeData
      if (data.locationConnected !== newConnected || data.locationDir !== newDir) {
        updateNodeData(node.id, { locationConnected: newConnected, locationDir: newDir })
      }
    }
  }, [edges, nodes, updateNodeData])

  // Sync upstream source info (kind/path/dimensions) into Crop & Trim nodes for previews.
  useEffect(() => {
    for (const node of nodes) {
      if (node.type !== 'crop-node' && node.type !== 'trim-node') continue
      const input = resolveInputNode(node.id, nodes, edges)
      const inData = input?.data as InputNodeData | undefined
      let srcKind: 'video' | 'sequence' | null = null
      let srcPath: string | null = null
      if (inData) {
        if (inData.sourceType === 'sequence') {
          srcKind = 'sequence'
          srcPath = inData.path
        } else if (inData.sourceType === 'video') {
          srcKind = 'video'
          srcPath = inData.path
        } else if (inData.sourceType === 'batch') {
          srcKind = 'video'
          srcPath = inData.batchFiles?.[0] ?? null
        }
      }
      const srcWidth = inData?.detectedWidth ?? null
      const srcHeight = inData?.detectedHeight ?? null
      let srcFrames: number | null = null
      let srcFps: number | null = null
      if (inData) {
        if (inData.sourceType === 'sequence') {
          srcFps = inData.fps ?? 30
          srcFrames = inData.detectedFrames ?? null
        } else {
          srcFps = inData.detectedFps ?? null
          srcFrames =
            inData.detectedDuration && inData.detectedFps
              ? Math.round(inData.detectedDuration * inData.detectedFps)
              : null
        }
      }
      const d = node.data as CropNodeData & TrimNodeData
      if (
        d.srcKind !== srcKind ||
        d.srcPath !== srcPath ||
        d.srcWidth !== srcWidth ||
        d.srcHeight !== srcHeight ||
        d.srcFrames !== srcFrames ||
        d.srcFps !== srcFps
      ) {
        updateNodeData(node.id, { srcKind, srcPath, srcWidth, srcHeight, srcFrames, srcFps })
      }
    }
  }, [nodes, edges, updateNodeData])
}
