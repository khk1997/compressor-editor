import { useEffect } from 'react'
import { type Edge, type Node, useReactFlow } from '@xyflow/react'
import {
  type CropNodeData,
  type InputNodeData,
  type LocationNodeData,
  type OutputNodeData,
  type TrimNodeData
} from '../types'
import { resolveInputNode, resolveUpstreamCrop } from '../utils/jobBuilder'

type UpdateNodeData = ReturnType<typeof useReactFlow>['updateNodeData']

interface SrcInfo {
  srcKind: 'video' | 'sequence' | null
  srcPath: string | null
  srcWidth: number | null
  srcHeight: number | null
  srcFrames: number | null
  srcFps: number | null
  srcHasAlpha: boolean
}

/** Derive preview/source fields from the feeding Input node (shared by Crop/Trim/Output). */
function deriveSrcInfo(inData: InputNodeData | undefined): SrcInfo {
  let srcKind: 'video' | 'sequence' | null = null
  let srcPath: string | null = null
  let srcFrames: number | null = null
  let srcFps: number | null = null
  if (inData) {
    if (inData.sourceType === 'sequence') {
      srcKind = 'sequence'
      srcPath = inData.path
      srcFps = inData.fps ?? 30
      srcFrames = inData.detectedFrames ?? null
    } else {
      // video or batch (batch previews its first file).
      srcKind = 'video'
      srcPath = inData.sourceType === 'batch' ? (inData.batchFiles?.[0] ?? null) : inData.path
      srcFps = inData.detectedFps ?? null
      srcFrames =
        inData.detectedDuration && inData.detectedFps
          ? Math.round(inData.detectedDuration * inData.detectedFps)
          : null
    }
  }
  return {
    srcKind,
    srcPath,
    srcWidth: inData?.detectedWidth ?? null,
    srcHeight: inData?.detectedHeight ?? null,
    srcFrames,
    srcFps,
    srcHasAlpha: inData?.detectedHasAlpha ?? false
  }
}

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
      // Carry the source's native dimensions (for the "original" size hint) plus the
      // kind/path/frames/fps the single-PNG frame preview needs.
      const input = resolveInputNode(node.id, nodes, edges)
      const s = deriveSrcInfo(input?.data as InputNodeData | undefined)
      // An upstream Crop changes the dimensions that reach Output: use the cropped
      // size for the "original" hint + aspect-lock, and its rect so the frame preview
      // matches the cropped output.
      const crop = resolveUpstreamCrop(node.id, nodes, edges)
      const srcWidth = crop ? crop.width : s.srcWidth
      const srcHeight = crop ? crop.height : s.srcHeight
      const srcCrop = crop
        ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
        : null
      const cropChanged =
        (data.srcCrop?.x ?? null) !== (srcCrop?.x ?? null) ||
        (data.srcCrop?.y ?? null) !== (srcCrop?.y ?? null) ||
        (data.srcCrop?.width ?? null) !== (srcCrop?.width ?? null) ||
        (data.srcCrop?.height ?? null) !== (srcCrop?.height ?? null)
      if (
        data.locationConnected !== newConnected ||
        data.locationDir !== newDir ||
        data.srcWidth !== srcWidth ||
        data.srcHeight !== srcHeight ||
        data.srcKind !== s.srcKind ||
        data.srcPath !== s.srcPath ||
        data.srcFrames !== s.srcFrames ||
        data.srcFps !== s.srcFps ||
        data.srcHasAlpha !== s.srcHasAlpha ||
        cropChanged
      ) {
        updateNodeData(node.id, {
          locationConnected: newConnected,
          locationDir: newDir,
          ...s,
          srcWidth,
          srcHeight,
          srcCrop
        })
      }
    }
  }, [edges, nodes, updateNodeData])

  // Sync upstream source info (kind/path/dimensions) into Crop & Trim nodes for previews.
  useEffect(() => {
    for (const node of nodes) {
      if (node.type !== 'crop-node' && node.type !== 'trim-node') continue
      const input = resolveInputNode(node.id, nodes, edges)
      const s = deriveSrcInfo(input?.data as InputNodeData | undefined)
      const d = node.data as CropNodeData & TrimNodeData
      if (
        d.srcKind !== s.srcKind ||
        d.srcPath !== s.srcPath ||
        d.srcWidth !== s.srcWidth ||
        d.srcHeight !== s.srcHeight ||
        d.srcFrames !== s.srcFrames ||
        d.srcFps !== s.srcFps
      ) {
        updateNodeData(node.id, { ...s })
      }
    }
  }, [nodes, edges, updateNodeData])
}
