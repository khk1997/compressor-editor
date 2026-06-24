import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { InputNode } from './nodes/InputNode'
import { OutputNode } from './nodes/OutputNode'
import { RetimeNode } from './nodes/RetimeNode'
import { TrimNode } from './nodes/TrimNode'
import { CropNode } from './nodes/CropNode'
import { LocationNode } from './nodes/LocationNode'
import { InfoPanel } from './InfoPanel'
import {
  FORMAT_CODECS,
  FORMAT_EXT,
  supportsTarget,
  type CropNodeData,
  type InputNodeData,
  type JobState,
  type LocationNodeData,
  type OutputFormat,
  type OutputNodeData,
  type RetimeNodeData,
  type TrimNodeData
} from './types'

const basename = (p: string): string => p.split(/[/\\]/).pop() || p
const dirname = (p: string): string => {
  const parts = p.split(/[/\\]/)
  parts.pop()
  return parts.join('/')
}
/** Filename without its extension. */
const stem = (p: string): string => basename(p).replace(/\.[^.]+$/, '')

let idSeq = 1
const nextId = (): string => `n${idSeq++}`

/**
 * Migrate an output node saved before MP4 codecs were merged into one container.
 * Old graphs used separate `h265`/`av1` formats and a `movCodec` field; map both
 * onto the unified `format` (container) + `codec` model.
 */
function migrateOutputNode(n: Node): Node {
  const data = { ...(n.data as Record<string, unknown>) }
  const oldFormat = data.format as string
  if (oldFormat === 'h265') {
    data.format = 'mp4'
    data.codec = data.codec ?? 'h265'
  } else if (oldFormat === 'av1') {
    data.format = 'mp4'
    data.codec = data.codec ?? 'av1'
  }
  // Adopt the legacy MOV codec field, then drop it.
  if (data.codec == null) {
    data.codec = data.movCodec ?? FORMAT_CODECS[data.format as OutputFormat]?.[0] ?? 'h264'
  }
  delete data.movCodec
  if (data.hevcAlpha == null) data.hevcAlpha = false
  return { ...n, data }
}

type Pt = { x: number; y: number }
const ccw = (a: Pt, b: Pt, c: Pt): boolean =>
  (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x)
/** Do segments p1p2 and p3p4 cross? */
const segCross = (p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean =>
  ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4)

type Rect = { x: number; y: number; w: number; h: number }
/** Does segment a→b touch the rectangle (endpoint inside or any side crossed)? */
const segIntersectsRect = (a: Pt, b: Pt, r: Rect): boolean => {
  const inside = (p: Pt): boolean =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  if (inside(a) || inside(b)) return true
  const tl = { x: r.x, y: r.y }
  const tr = { x: r.x + r.w, y: r.y }
  const br = { x: r.x + r.w, y: r.y + r.h }
  const bl = { x: r.x, y: r.y + r.h }
  return (
    segCross(a, b, tl, tr) ||
    segCross(a, b, tr, br) ||
    segCross(a, b, br, bl) ||
    segCross(a, b, bl, tl)
  )
}

/**
 * Blender-style knife: hold Ctrl/⌘ and drag across links to sever them.
 * Renders the cut stroke as an overlay and removes any edge it crosses.
 */
function Knife({ wrapperRef }: { wrapperRef: React.RefObject<HTMLDivElement> }): JSX.Element {
  const rf = useReactFlow()
  const [stroke, setStroke] = useState<Pt[]>([])
  const ptsRef = useRef<Pt[]>([])
  const cutting = useRef(false)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    const rel = (e: PointerEvent): Pt => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const cutEdges = (pts: Pt[]): void => {
      if (pts.length < 2) return
      const r = el.getBoundingClientRect()
      const byId = new Map(rf.getNodes().map((n) => [n.id, n]))
      const remove = new Set<string>()
      for (const edge of rf.getEdges()) {
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const sw = s.measured?.width ?? 220
        const sh = s.measured?.height ?? 120
        const th = t.measured?.height ?? 120
        const a = rf.flowToScreenPosition({ x: s.position.x + sw, y: s.position.y + sh / 2 })
        const b = rf.flowToScreenPosition({ x: t.position.x, y: t.position.y + th / 2 })
        const A = { x: a.x - r.left, y: a.y - r.top }
        const B = { x: b.x - r.left, y: b.y - r.top }
        for (let i = 1; i < pts.length; i++) {
          if (segCross(pts[i - 1], pts[i], A, B)) {
            remove.add(edge.id)
            break
          }
        }
      }
      if (remove.size) rf.setEdges((es) => es.filter((e) => !remove.has(e.id)))
    }

    const down = (e: PointerEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      cutting.current = true
      ptsRef.current = [rel(e)]
      setStroke([...ptsRef.current])
    }
    const move = (e: PointerEvent): void => {
      if (!cutting.current) return
      ptsRef.current.push(rel(e))
      setStroke([...ptsRef.current])
    }
    const up = (): void => {
      if (!cutting.current) return
      cutting.current = false
      cutEdges(ptsRef.current)
      ptsRef.current = []
      setStroke([])
    }

    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [rf, wrapperRef])

  if (stroke.length < 2) return <></>
  return (
    <svg className="knife-overlay">
      <polyline points={stroke.map((p) => `${p.x},${p.y}`).join(' ')} />
    </svg>
  )
}

const initialNodes: Node[] = [
  {
    id: 'in1',
    type: 'input-node',
    position: { x: 80, y: 200 },
    data: {
      sourceType: 'sequence',
      path: null,
      fps: 30,
      detectedFps: null,
      detectedWidth: null,
      detectedHeight: null,
      detectedSize: null,
      detectedDuration: null,
      detectedHasAudio: false,
      detectedFrames: null
    } satisfies InputNodeData
  },
  {
    id: 'out1',
    type: 'output-node',
    position: { x: 520, y: 160 },
    data: {
      format: 'webp',
      codec: 'h264',
      quality: 80,
      sizeMode: 'quality',
      targetMB: null,
      hardware: false,
      proresProfile: 3,
      hevcAlpha: false,
      width: null,
      outputPath: null,
      status: 'idle',
      percent: 0
    } satisfies OutputNodeData
  }
]

const initialEdges: Edge[] = [{ id: 'e1', source: 'in1', target: 'out1' }]

function Flow(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { updateNodeData, screenToFlowPosition, getNodes } = useReactFlow()
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  // Batch progress aggregation: base output id → per-file status (index → state).
  const batchTotals = useRef<Map<string, number>>(new Map())
  const batchParts = useRef<Map<string, { percent: number; status: string; message?: string }[]>>(
    new Map()
  )

  const nodeTypes = useMemo(
    () => ({
      'input-node': InputNode,
      'output-node': OutputNode,
      'retime-node': RetimeNode,
      'trim-node': TrimNode,
      'crop-node': CropNode,
      'location-node': LocationNode
    }),
    []
  )

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge(c, eds)),
    [setEdges]
  )

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

  // Walk an edge chain backward (ignoring location edges) to the feeding Input node.
  const resolveInputNode = useCallback(
    (startId: string): Node | undefined => {
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const incoming = (nodeId: string): Node | undefined => {
        const e = edges.find((ed) => ed.target === nodeId && ed.targetHandle !== 'location')
        return e ? byId.get(e.source) : undefined
      }
      let cur = incoming(startId)
      let guard = 0
      while (cur && cur.type !== 'input-node' && guard++ < 50) cur = incoming(cur.id)
      return cur?.type === 'input-node' ? cur : undefined
    },
    [nodes, edges]
  )

  // Sync upstream source info (kind/path/dimensions) into Crop & Trim nodes for previews.
  useEffect(() => {
    for (const node of nodes) {
      if (node.type !== 'crop-node' && node.type !== 'trim-node') continue
      const input = resolveInputNode(node.id)
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
      const d = node.data as CropNodeData & TrimNodeData
      if (
        d.srcKind !== srcKind ||
        d.srcPath !== srcPath ||
        d.srcWidth !== srcWidth ||
        d.srcHeight !== srcHeight
      ) {
        updateNodeData(node.id, { srcKind, srcPath, srcWidth, srcHeight })
      }
    }
  }, [nodes, edges, resolveInputNode, updateNodeData])

  // Blender-style: drop a processing node onto a link to splice it in.
  const PROCESSING = ['retime-node', 'trim-node', 'crop-node']
  const onNodeDragStop = useCallback(
    (_e: unknown, dragged: Node) => {
      if (!PROCESSING.includes(dragged.type ?? '')) return
      // Only splice a node that isn't already wired up.
      if (edges.some((e) => e.source === dragged.id || e.target === dragged.id)) return
      const byId = new Map(getNodes().map((n) => [n.id, n]))
      const dn = byId.get(dragged.id)
      if (!dn) return
      const rect = {
        x: dn.position.x,
        y: dn.position.y,
        w: dn.measured?.width ?? 220,
        h: dn.measured?.height ?? 120
      }
      for (const edge of edges) {
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const a = {
          x: s.position.x + (s.measured?.width ?? 220),
          y: s.position.y + (s.measured?.height ?? 120) / 2
        }
        const b = { x: t.position.x, y: t.position.y + (t.measured?.height ?? 120) / 2 }
        if (segIntersectsRect(a, b, rect)) {
          setEdges((eds) => [
            ...eds.filter((x) => x.id !== edge.id),
            { id: `e-${edge.source}-${dragged.id}`, source: edge.source, target: dragged.id },
            { id: `e-${dragged.id}-${edge.target}`, source: dragged.id, target: edge.target }
          ])
          setLogs((l) => [...l, `🔗 Inserted ${dragged.type?.replace('-node', '')} into the link.`])
          break
        }
      }
    },
    [edges, getNodes, setEdges]
  )

  // Subscribe to job status / log streams from the main process.
  useEffect(() => {
    const offStatus = window.api.onJobStatus((s) => {
      // Batch jobs use ids like `out3::2`; fold their per-file status into the one node.
      const sep = s.id.indexOf('::')
      if (sep < 0) {
        updateNodeData(s.id, { status: s.status, percent: s.percent, message: s.message })
        if (s.status === 'error' && s.message) {
          setLogs((l) => [...l, `[${s.id}] ERROR: ${s.message}`])
        }
        return
      }
      const base = s.id.slice(0, sep)
      const idx = Number(s.id.slice(sep + 2))
      const parts = batchParts.current.get(base) ?? []
      parts[idx] = { percent: s.percent, status: s.status, message: s.message }
      batchParts.current.set(base, parts)
      const total = batchTotals.current.get(base) ?? parts.filter(Boolean).length
      const present = parts.filter(Boolean)
      const done = present.filter((p) => p.status === 'done').length
      const errs = present.filter((p) => p.status === 'error')
      const anyRunning = present.some((p) => p.status === 'running')
      const percent =
        present.reduce((a, p) => a + (p.status === 'done' ? 1 : p.status === 'running' ? p.percent : 0), 0) /
        Math.max(total, 1)
      let status: JobState = 'running'
      let message: string | undefined = `${done}/${total} done`
      if (present.length >= total && !anyRunning) {
        if (errs.length) {
          status = 'error'
          message = `${errs.length}/${total} failed. First: ${errs[0].message ?? 'error'}`
        } else if (done >= total) {
          status = 'done'
        } else {
          status = 'idle' // cancelled mid-batch
        }
      }
      updateNodeData(base, { status, percent, message })
      if (s.status === 'error' && s.message) {
        setLogs((l) => [...l, `[${s.id}] ERROR: ${s.message}`])
      }
    })
    const offLog = window.api.onJobLog((l) => {
      setLogs((prev) => [...prev.slice(-400), `[${l.id}] ${l.line}`])
    })
    return () => {
      offStatus()
      offLog()
    }
  }, [updateNodeData])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const addInput = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'input-node',
        position: screenToFlowPosition({ x: 200, y: 200 }),
        data: {
          sourceType: 'sequence',
          path: null,
          fps: 30,
          detectedFps: null,
          detectedWidth: null,
          detectedHeight: null,
          detectedSize: null,
          detectedDuration: null,
          detectedHasAudio: false,
          detectedFrames: null
        } satisfies InputNodeData
      }
    ])

  const addRetime = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'retime-node',
        position: screenToFlowPosition({ x: 400, y: 220 }),
        data: { speed: 100, reverse: false, interpolation: 'sampling' } satisfies RetimeNodeData
      }
    ])

  const addTrim = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'trim-node',
        position: screenToFlowPosition({ x: 400, y: 320 }),
        data: { startSec: 0, endSec: null } satisfies TrimNodeData
      }
    ])

  const addCrop = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'crop-node',
        position: screenToFlowPosition({ x: 400, y: 420 }),
        data: { x: 0, y: 0, width: 0, height: 0 } satisfies CropNodeData
      }
    ])

  const addOutput = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'output-node',
        position: screenToFlowPosition({ x: 600, y: 220 }),
        data: {
          format: 'mp4',
          codec: 'h264',
          quality: 75,
          sizeMode: 'quality',
          targetMB: null,
          hardware: false,
          proresProfile: 3,
          hevcAlpha: false,
          width: null,
          outputPath: null,
          locationDir: null,
          status: 'idle',
          percent: 0
        } satisfies OutputNodeData
      }
    ])

  const addLocation = (): void =>
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'location-node',
        position: screenToFlowPosition({ x: 600, y: 420 }),
        data: { dir: null } satisfies LocationNodeData
      }
    ])

  /** Walk each Output back through an optional Retime node to its Input. */
  const buildJobs = useCallback(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // Only follow media-chain edges, not location edges.
    const incomingOf = (nodeId: string): Node | undefined => {
      const edge = edges.find((e) => e.target === nodeId && e.targetHandle !== 'location')
      return edge ? byId.get(edge.source) : undefined
    }

    type Job = {
      id: string
      input: {
        type: string
        path: string
        fps: number | null
        sourceFps: number | null
        durationSec: number | null
        hasAudio: boolean
      }
      output: {
        format: string
        codec: string
        quality: number
        sizeMode: string
        targetMB: number | null
        hardware: boolean
        proresProfile: number
        hevcAlpha: boolean
        width: number | null
        outputPath: string
      }
      retime: { speed: number; reverse: boolean; interpolation: string } | null
      trim: { startSec: number; endSec: number | null } | null
      crop: { x: number; y: number; width: number; height: number } | null
    }
    const jobs: Job[] = []
    const problems: string[] = []

    for (const out of nodes.filter((n) => n.type === 'output-node')) {
      let src = incomingOf(out.id)
      if (!src) continue // unconnected output — silently skip

      // Walk back through any chain of processing nodes (retime / trim / crop)
      // until we reach the Input. One of each type is honored.
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

      // Resolve final output path: location node dir + filename, or direct full path.
      // Batch derives a filename per source file, so it only needs a directory.
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

      // Target-size mode needs a target value and a known duration.
      // (Sequences derive their duration from frame count in the main process.)
      const isTarget = supportsTarget(outData.format, outData.codec) && outData.sizeMode === 'target'
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
        codec: outData.codec,
        quality: outData.quality,
        sizeMode: outData.sizeMode,
        targetMB: outData.targetMB,
        hardware: outData.hardware,
        proresProfile: outData.proresProfile,
        hevcAlpha: outData.hevcAlpha,
        width: outData.width
      }
      const retimeSpec = retime
        ? { speed: retime.speed, reverse: retime.reverse, interpolation: retime.interpolation }
        : null
      const trimSpec = trim ? { startSec: trim.startSec, endSec: trim.endSec } : null
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
              fps: inData.fps, // null = keep each source's own rate
              sourceFps: inData.detectedFps, // representative (from sampled first file)
              durationSec: null, // per-file unknown; ffmpeg parses it live for progress
              hasAudio: inData.detectedHasAudio // assumes a uniform batch
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
          // Sequence needs a rate (default 30); video keeps source unless overridden.
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
  }, [nodes, edges])

  const run = async (): Promise<void> => {
    const { jobs, problems } = buildJobs()
    if (problems.length) setLogs((l) => [...l, ...problems.map((p) => `⚠ ${p}`)])
    if (!jobs.length) {
      setLogs((l) => [...l, 'Nothing to run — connect an Input to an Output and set paths.'])
      return
    }
    // Overwrite protection: warn if any output file already exists.
    const existing = await window.api.existing(jobs.map((j) => j.output.outputPath))
    if (existing.length) {
      const ok = window.confirm(
        `These files already exist and will be overwritten:\n\n${existing
          .map((p) => p.split(/[/\\]/).pop())
          .join('\n')}\n\nContinue?`
      )
      if (!ok) {
        setLogs((l) => [...l, '✋ Cancelled — would overwrite existing files.'])
        return
      }
    }
    // Seed batch aggregation (base output id → file count) and clear prior parts.
    batchTotals.current.clear()
    batchParts.current.clear()
    for (const j of jobs) {
      const sep = j.id.indexOf('::')
      if (sep >= 0) {
        const base = j.id.slice(0, sep)
        batchTotals.current.set(base, (batchTotals.current.get(base) ?? 0) + 1)
      }
    }
    // Reset each output node (dedupe batch's per-file ids back to the base id).
    const baseIds = new Set(jobs.map((j) => (j.id.includes('::') ? j.id.split('::')[0] : j.id)))
    baseIds.forEach((bid) => updateNodeData(bid, { status: 'idle', percent: 0, message: undefined }))
    setRunning(true)
    setLogs((l) => [...l, `▶ Running ${jobs.length} job(s)…`])
    const r = await window.api.runJobs(jobs)
    setRunning(false)
    setLogs((l) => [...l, r.cancelled ? '■ Cancelled.' : '■ Batch finished.'])
  }

  const stop = async (): Promise<void> => {
    setLogs((l) => [...l, '… Cancelling — finishing current step.'])
    await window.api.cancel()
  }

  /** Serialize the graph (resetting transient run state) and save to disk. */
  const saveGraph = async (): Promise<void> => {
    const clean = nodes.map((n) =>
      n.type === 'output-node'
        ? { ...n, data: { ...n.data, status: 'idle', percent: 0, message: undefined } }
        : n
    )
    const r = await window.api.saveGraph(JSON.stringify({ nodes: clean, edges }, null, 2))
    if (r.ok) setLogs((l) => [...l, `💾 Saved graph to ${r.path}`])
  }

  // Drag files/folders onto the canvas to spawn pre-filled Input nodes.
  const onDragOverCanvas = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDropFiles = useCallback(
    async (e: React.DragEvent): Promise<void> => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      const drop = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const blank: InputNodeData = {
        sourceType: 'video',
        path: null,
        fps: null,
        detectedFps: null,
        detectedWidth: null,
        detectedHeight: null,
        detectedSize: null,
        detectedDuration: null,
        detectedHasAudio: false,
        detectedFrames: null,
        batchFiles: null
      }
      for (let i = 0; i < files.length; i++) {
        const p = window.api.pathForFile(files[i])
        if (!p) continue
        const res = await window.api.inspectPath(p)
        let data: InputNodeData | null = null
        if (res.kind === 'video') {
          data = {
            ...blank,
            sourceType: 'video',
            path: p,
            detectedFps: res.info.fps,
            detectedWidth: res.info.width,
            detectedHeight: res.info.height,
            detectedSize: res.info.sizeBytes,
            detectedDuration: res.info.durationSec,
            detectedHasAudio: res.info.hasAudio
          }
        } else if (res.kind === 'sequence') {
          data = {
            ...blank,
            sourceType: 'sequence',
            path: p,
            fps: 30,
            detectedFrames: res.info.frameCount,
            detectedWidth: res.info.width,
            detectedHeight: res.info.height,
            detectedSize: res.info.totalBytes
          }
        } else if (res.kind === 'batch') {
          const info = res.videos[0] ? await window.api.probeMedia(res.videos[0]) : null
          data = {
            ...blank,
            sourceType: 'batch',
            path: p,
            batchFiles: res.videos,
            detectedFps: info?.fps ?? null,
            detectedWidth: info?.width ?? null,
            detectedHeight: info?.height ?? null,
            detectedDuration: info?.durationSec ?? null,
            detectedHasAudio: info?.hasAudio ?? false
          }
        } else {
          setLogs((l) => [...l, `⚠ Skipped (unrecognized): ${p}`])
          continue
        }
        const nodeData = data
        const position = { x: drop.x, y: drop.y + i * 48 }
        setNodes((n) => [...n, { id: nextId(), type: 'input-node', position, data: nodeData }])
      }
    },
    [screenToFlowPosition, setNodes]
  )

  const loadGraph = async (): Promise<void> => {
    const text = await window.api.loadGraph()
    if (!text) return
    try {
      const g = JSON.parse(text) as { nodes: Node[]; edges: Edge[] }
      setNodes(g.nodes.map((n) => (n.type === 'output-node' ? migrateOutputNode(n) : n)))
      setEdges(g.edges)
      // Bump the id counter past any loaded numeric id to avoid collisions.
      const maxId = Math.max(0, ...g.nodes.map((n) => Number(n.id.match(/\d+/)?.[0] ?? 0)))
      idSeq = maxId + 1
      setLogs((l) => [...l, '📂 Loaded graph.'])
    } catch {
      setLogs((l) => [...l, '⚠ Could not parse that graph file.'])
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">⬡ Compressor</strong>
        <button className="btn" onClick={addInput}>
          + Input
        </button>
        <button className="btn" onClick={addRetime}>
          + Retime
        </button>
        <button className="btn" onClick={addTrim}>
          + Trim
        </button>
        <button className="btn" onClick={addCrop}>
          + Crop
        </button>
        <button className="btn" onClick={addOutput}>
          + Output
        </button>
        <button className="btn" onClick={addLocation}>
          + Location
        </button>
        <span className="sep" />
        <button className="btn" onClick={saveGraph}>
          Save
        </button>
        <button className="btn" onClick={loadGraph}>
          Open
        </button>
        <div className="spacer" />
        {running ? (
          <button className="btn btn-stop" onClick={stop}>
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-run" onClick={run}>
            ▶ Run
          </button>
        )}
      </header>

      <div className="canvas" ref={canvasRef} onDrop={onDropFiles} onDragOver={onDragOverCanvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_e, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          nodeTypes={nodeTypes}
          deleteKeyCode={['Delete', 'Backspace', 'x', 'X']}
          fitView
          colorMode="dark"
          defaultEdgeOptions={{ animated: true }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
        <Knife wrapperRef={canvasRef} />
        <InfoPanel node={nodes.find((n) => n.id === selectedId)} />
      </div>

      <div className="logpanel" ref={logRef}>
        {logs.length === 0 ? (
          <div className="log-empty">Logs will appear here.</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="log-line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  )
}
