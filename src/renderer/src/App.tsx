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
import { InfoPanel } from './InfoPanel'
import {
  SUPPORTS_TARGET,
  type CropNodeData,
  type InputNodeData,
  type OutputNodeData,
  type RetimeNodeData,
  type TrimNodeData
} from './types'

let idSeq = 1
const nextId = (): string => `n${idSeq++}`

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
      quality: 80,
      sizeMode: 'quality',
      targetMB: null,
      hardware: false,
      proresProfile: 3,
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

  const nodeTypes = useMemo(
    () => ({
      'input-node': InputNode,
      'output-node': OutputNode,
      'retime-node': RetimeNode,
      'trim-node': TrimNode,
      'crop-node': CropNode
    }),
    []
  )

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge(c, eds)),
    [setEdges]
  )

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
      updateNodeData(s.id, { status: s.status, percent: s.percent, message: s.message })
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
          quality: 75,
          sizeMode: 'quality',
          targetMB: null,
          hardware: false,
          proresProfile: 3,
          width: null,
          outputPath: null,
          status: 'idle',
          percent: 0
        } satisfies OutputNodeData
      }
    ])

  /** Walk each Output back through an optional Retime node to its Input. */
  const buildJobs = useCallback(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const incomingOf = (nodeId: string): Node | undefined => {
      const edge = edges.find((e) => e.target === nodeId)
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
        quality: number
        sizeMode: string
        targetMB: number | null
        hardware: boolean
        proresProfile: number
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

      if (!inData.path) {
        problems.push(`${out.id}: input has no source selected`)
        continue
      }
      if (!outData.outputPath) {
        problems.push(`${out.id}: no output file chosen`)
        continue
      }

      // Target-size mode needs a target value and a known duration.
      // (Sequences derive their duration from frame count in the main process.)
      const isTarget = SUPPORTS_TARGET.includes(outData.format) && outData.sizeMode === 'target'
      if (isTarget) {
        if (!outData.targetMB || outData.targetMB <= 0) {
          problems.push(`${out.id}: target size (MB) not set`)
          continue
        }
        if (inData.sourceType === 'video' && !inData.detectedDuration) {
          problems.push(`${out.id}: source duration unknown — cannot hit a target size`)
          continue
        }
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
        output: {
          format: outData.format,
          quality: outData.quality,
          sizeMode: outData.sizeMode,
          targetMB: outData.targetMB,
          hardware: outData.hardware,
          proresProfile: outData.proresProfile,
          width: outData.width,
          outputPath: outData.outputPath
        },
        retime: retime
          ? { speed: retime.speed, reverse: retime.reverse, interpolation: retime.interpolation }
          : null,
        trim: trim ? { startSec: trim.startSec, endSec: trim.endSec } : null,
        crop: crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null
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
    // Reset connected outputs to a running state.
    jobs.forEach((j) => updateNodeData(j.id, { status: 'idle', percent: 0, message: undefined }))
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

  const loadGraph = async (): Promise<void> => {
    const text = await window.api.loadGraph()
    if (!text) return
    try {
      const g = JSON.parse(text) as { nodes: Node[]; edges: Edge[] }
      setNodes(g.nodes)
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

      <div className="canvas" ref={canvasRef}>
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
