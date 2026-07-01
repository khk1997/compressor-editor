import { type Edge, type Node } from '@xyflow/react'
import {
  FORMAT_CODECS,
  FORMAT_EXT,
  supportsTarget,
  type CropNodeData,
  type InputNodeData,
  type JobSpec,
  type OutputFormat,
  type OutputNodeData,
  type RetimeNodeData,
  type TrimNodeData
} from '../types'

const basename = (p: string): string => p.split(/[/\\]/).pop() || p
const stem = (p: string): string => basename(p).replace(/\.[^.]+$/, '')
const dirname = (p: string): string => {
  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(/[/\\]/)
  parts.pop()
  return parts.join(sep)
}

/** Walk edges backward (ignoring location edges) to the feeding Input node. */
export function resolveInputNode(startId: string, nodes: Node[], edges: Edge[]): Node | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = (nodeId: string): Node | undefined => {
    const e = edges.find((ed) => ed.target === nodeId && ed.targetHandle !== 'location')
    return e ? byId.get(e.source) : undefined
  }
  let cur = incoming(startId)
  let guard = 0
  while (cur && cur.type !== 'input-node' && guard++ < 50) cur = incoming(cur.id)
  return cur?.type === 'input-node' ? cur : undefined
}

/** Walk edges backward to find an active Crop node feeding `startId` (else null). */
export function resolveUpstreamCrop(
  startId: string,
  nodes: Node[],
  edges: Edge[]
): CropNodeData | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = (nodeId: string): Node | undefined => {
    const e = edges.find((ed) => ed.target === nodeId && ed.targetHandle !== 'location')
    return e ? byId.get(e.source) : undefined
  }
  let cur = incoming(startId)
  let guard = 0
  while (cur && cur.type !== 'input-node' && guard++ < 50) {
    if (cur.type === 'crop-node') {
      const c = cur.data as CropNodeData
      if (c.width > 0 && c.height > 0) return c
    }
    cur = incoming(cur.id)
  }
  return null
}

export function buildJobs(
  nodes: Node[],
  edges: Edge[]
): { jobs: JobSpec[]; problems: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incomingOf = (nodeId: string): Node | undefined => {
    const edge = edges.find((e) => e.target === nodeId && e.targetHandle !== 'location')
    return edge ? byId.get(edge.source) : undefined
  }

  const jobs: JobSpec[] = []
  const problems: string[] = []

  for (const out of nodes.filter((n) => n.type === 'output-node')) {
    let src = incomingOf(out.id)
    if (!src) continue

    let retime: RetimeNodeData | null = null
    let trim: TrimNodeData | null = null
    let crop: CropNodeData | null = null
    let guard = 0
    while (src && src.type !== 'input-node' && guard++ < 50) {
      if (src.type === 'retime-node') retime = src.data as RetimeNodeData
      else if (src.type === 'trim-node') trim = src.data as TrimNodeData
      else if (src.type === 'crop-node') crop = src.data as CropNodeData
      else break
      src = incomingOf(src.id)
    }
    if (src?.type !== 'input-node') {
      problems.push(`${out.id}: chain does not start at an Input`)
      continue
    }

    const inData = src.data as InputNodeData
    const outData = out.data as OutputNodeData
    const isBatch = inData.sourceType === 'batch'

    if (!inData.path) {
      problems.push(`${out.id}: input has no source selected`)
      continue
    }

    const locationDir = outData.locationDir ?? null
    let resolvedOutputPath: string | null = outData.outputPath
    if (locationDir) {
      const filename = outData.outputPath ? basename(outData.outputPath) : null
      if (!isBatch && !filename) {
        problems.push(`${out.id}: location connected but no filename set`)
        continue
      }
      if (filename) resolvedOutputPath = `${locationDir}/${filename}`
    } else if (!isBatch && !outData.outputPath) {
      problems.push(`${out.id}: no output file chosen`)
      continue
    }

    const codec = outData.codec ?? FORMAT_CODECS[outData.format as OutputFormat]?.[0] ?? 'h264'
    // Boomerang doubles the length, so it can't hit an exact target size — it always
    // falls back to Quality (the UI hides target mode when boomerang is on).
    const isTarget =
      supportsTarget(outData.format, codec) &&
      outData.sizeMode === 'target' &&
      outData.loopMode !== 'boomerang'
    if (isTarget) {
      if (isBatch) {
        problems.push(`${out.id}: target file size isn't supported for Batch — use Quality`)
        continue
      }
      if (!outData.targetMB || outData.targetMB <= 0) {
        problems.push(`${out.id}: target size (MB) not set`)
        continue
      }
      if (inData.sourceType === 'video' && !inData.detectedDuration) {
        problems.push(`${out.id}: source duration unknown — cannot hit a target size`)
        continue
      }
    }

    const baseOutput = {
      format: outData.format,
      codec,
      quality: outData.quality,
      sizeMode: outData.sizeMode,
      targetMB: outData.targetMB,
      hardware: outData.hardware,
      proresProfile: outData.proresProfile,
      hevcAlpha: outData.hevcAlpha,
      width: outData.width,
      height: outData.height ?? null,
      audioBitrate: outData.audioBitrate,
      loopMode: outData.loopMode ?? 'normal',
      pngMode: outData.pngMode ?? 'sequence',
      pngFrame: outData.pngFrame ?? 0
    }
    const retimeSpec = retime
      ? { speed: retime.speed, reverse: retime.reverse, interpolation: retime.interpolation }
      : null
    const dropFirst = trim?.dropFirst ?? 0
    const dropLast = trim?.dropLast ?? 0
    const trimSpec = trim
      ? { startSec: trim.startSec, endSec: trim.endSec, dropFirst, dropLast }
      : null

    if (dropLast > 0) {
      if (isBatch) {
        problems.push(`${out.id}: "Drop last frames" isn't supported for Batch`)
        continue
      }
      if (inData.sourceType === 'video' && !inData.detectedDuration) {
        problems.push(`${out.id}: source duration unknown — can't drop frames from the end`)
        continue
      }
    }
    const cropSpec = crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null

    if (isBatch) {
      const files = inData.batchFiles ?? []
      if (!files.length) {
        problems.push(`${out.id}: batch folder has no video files`)
        continue
      }
      const dir = locationDir ?? (outData.outputPath ? dirname(outData.outputPath) : null)
      if (!dir) {
        problems.push(`${out.id}: batch needs a Location node or a chosen output folder`)
        continue
      }
      const ext = FORMAT_EXT[outData.format]
      files.forEach((file, i) => {
        jobs.push({
          id: `${out.id}::${i}`,
          input: {
            type: 'video',
            path: file,
            fps: inData.fps,
            sourceFps: inData.detectedFps,
            durationSec: null,
            hasAudio: inData.detectedHasAudio
          },
          output: { ...baseOutput, outputPath: `${dir}/${stem(file)}.${ext}` },
          retime: retimeSpec,
          trim: trimSpec,
          crop: cropSpec
        })
      })
      continue
    }

    const seqFps = inData.fps ?? 30
    jobs.push({
      id: out.id,
      input: {
        type: inData.sourceType,
        path: inData.path,
        fps: inData.sourceType === 'sequence' ? seqFps : inData.fps,
        sourceFps: inData.sourceType === 'sequence' ? seqFps : inData.detectedFps,
        durationSec: inData.detectedDuration,
        hasAudio: inData.detectedHasAudio
      },
      output: { ...baseOutput, outputPath: resolvedOutputPath as string },
      retime: retimeSpec,
      trim: trimSpec,
      crop: cropSpec
    })
  }
  return { jobs, problems }
}
