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
import { Knife } from './components/Knife'
import { Toolbar } from './components/Toolbar'
import { useJobRunner } from './hooks/useJobRunner'
import { useUpstreamSync } from './hooks/useUpstreamSync'
import { useHistory } from './hooks/useHistory'
import { buildJobs } from './utils/jobBuilder'
import { segIntersectsRect } from './utils/geometry'
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
  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(/[/\\]/)
  parts.pop()
  return parts.join(sep)
}
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
  if (data.codec == null) {
    data.codec = data.movCodec ?? FORMAT_CODECS[data.format as OutputFormat]?.[0] ?? 'h264'
  }
  delete data.movCodec
  if (data.hevcAlpha == null) data.hevcAlpha = false
  return { ...n, data }
}

const PROCESSING = ['retime-node', 'trim-node', 'crop-node']
const AUTOSAVE_KEY = 'compressor-autosave'

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cutMode, setCutMode] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  // Keep live refs so useHistory can snapshot without stale closures.
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])

  const { logs, setLogs, running, setRunning, batchTotals, batchParts } =
    useJobRunner(updateNodeData)

  const { pushHistory, undo, redo } = useHistory(nodesRef, edgesRef, setNodes, setEdges)

  useUpstreamSync(nodes, edges, updateNodeData)

  // ── Auto-save / restore ───────────────────────────────────────────────────
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY)
      if (!saved) return
      const g = JSON.parse(saved) as { nodes: Node[]; edges: Edge[] }
      setNodes(g.nodes.map((n) => (n.type === 'output-node' ? migrateOutputNode(n) : n)))
      setEdges(g.edges)
      const maxId = Math.max(0, ...g.nodes.map((n) => Number(n.id.match(/\d+/)?.[0] ?? 0)))
      idSeq = maxId + 1
      setLogs((l) => [...l, '⏱ 已還原上次工作階段'])
    } catch {
      /* ignore corrupt autosave */
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (running) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const clean = nodes.map((n) =>
        n.type === 'output-node'
          ? { ...n, data: { ...n.data, status: 'idle', percent: 0, message: undefined } }
          : n
      )
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ nodes: clean, edges }))
      } catch {
        /* quota exceeded — silently skip */
      }
    }, 2000)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [nodes, edges, running])

  // ── Undo / Redo keyboard ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo])

  // ── Log auto-scroll ───────────────────────────────────────────────────────
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

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
    (c: Connection) => {
      pushHistory()
      setEdges((eds) => addEdge(c, eds))
    },
    [setEdges, pushHistory]
  )

  // Blender-style: drop a processing node onto a link to splice it in.
  const onNodeDragStop = useCallback(
    (_e: unknown, dragged: Node) => {
      if (!PROCESSING.includes(dragged.type ?? '')) return
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
          pushHistory()
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
    [edges, getNodes, setEdges, pushHistory]
  )

  // Intercept node/edge removals (deleteKeyCode) to push undo history first.
  const onNodesChangeWithHistory = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      if (changes.some((c) => c.type === 'remove')) pushHistory()
      onNodesChange(changes)
    },
    [onNodesChange, pushHistory]
  )
  const onEdgesChangeWithHistory = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      if (changes.some((c) => c.type === 'remove')) pushHistory()
      onEdgesChange(changes)
    },
    [onEdgesChange, pushHistory]
  )

  // ── Node creation ─────────────────────────────────────────────────────────
  const addInput = (): void => {
    pushHistory()
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
  }

  const addRetime = (): void => {
    pushHistory()
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'retime-node',
        position: screenToFlowPosition({ x: 400, y: 220 }),
        data: { speed: 100, reverse: false, interpolation: 'sampling' } satisfies RetimeNodeData
      }
    ])
  }

  const addTrim = (): void => {
    pushHistory()
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'trim-node',
        position: screenToFlowPosition({ x: 400, y: 320 }),
        data: { startSec: 0, endSec: null, dropFirst: 0, dropLast: 0 } satisfies TrimNodeData
      }
    ])
  }

  const addCrop = (): void => {
    pushHistory()
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'crop-node',
        position: screenToFlowPosition({ x: 400, y: 420 }),
        data: { x: 0, y: 0, width: 0, height: 0 } satisfies CropNodeData
      }
    ])
  }

  const addOutput = (): void => {
    pushHistory()
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
  }

  const addLocation = (): void => {
    pushHistory()
    setNodes((n) => [
      ...n,
      {
        id: nextId(),
        type: 'location-node',
        position: screenToFlowPosition({ x: 600, y: 420 }),
        data: { dir: null } satisfies LocationNodeData
      }
    ])
  }

  // One-click wire the selected node to every Output on the canvas, skipping
  // links that already exist. A Location node feeds each Output's "save as"
  // (location handle); any other node feeds each Output's normal input.
  const connectSelectedToOutputs = (): void => {
    const src = nodes.find((n) => n.id === selectedId)
    if (!src || src.type === 'output-node') return
    const outputs = nodes.filter((n) => n.type === 'output-node')

    if (src.type === 'location-node') {
      // An Output's location handle holds one connection — skip Outputs that
      // already have any Location wired in to avoid double-binding the handle.
      const taken = new Set(edges.filter((e) => e.targetHandle === 'location').map((e) => e.target))
      const added = outputs
        .filter((o) => !taken.has(o.id))
        .map((o) => ({
          id: `e-${src.id}-${o.id}-loc`,
          source: src.id,
          target: o.id,
          targetHandle: 'location'
        }))
      if (!added.length) {
        setLogs((l) => [...l, '⚠ 沒有可連接的 Output(可能都已設定 Save as 位置)。'])
        return
      }
      pushHistory()
      setEdges((eds) => [...eds, ...added])
      setLogs((l) => [...l, `📁 已把 Location 連到 ${added.length} 個 Output 的 Save as。`])
      return
    }

    const existing = new Set(
      edges.filter((e) => e.source === src.id && e.targetHandle == null).map((e) => e.target)
    )
    const added = outputs
      .filter((o) => !existing.has(o.id))
      .map((o) => ({ id: `e-${src.id}-${o.id}`, source: src.id, target: o.id }))
    if (!added.length) {
      setLogs((l) => [...l, '⚠ 沒有可連接的 Output(可能都已連上或畫布上沒有 Output)。'])
      return
    }
    pushHistory()
    setEdges((eds) => [...eds, ...added])
    setLogs((l) => [...l, `🔗 已連到 ${added.length} 個 Output。`])
  }

  // ── Run / stop ────────────────────────────────────────────────────────────
  const run = async (): Promise<void> => {
    const { jobs, problems } = buildJobs(nodes, edges)
    if (problems.length) setLogs((l) => [...l, ...problems.map((p) => `⚠ ${p}`)])
    if (!jobs.length) {
      setLogs((l) => [...l, 'Nothing to run — connect an Input to an Output and set paths.'])
      return
    }
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
    batchTotals.current.clear()
    batchParts.current.clear()
    for (const j of jobs) {
      const sep = j.id.indexOf('::')
      if (sep >= 0) {
        const base = j.id.slice(0, sep)
        batchTotals.current.set(base, (batchTotals.current.get(base) ?? 0) + 1)
      }
    }
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

  // ── Graph persistence ─────────────────────────────────────────────────────
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
      pushHistory()
      setNodes(g.nodes.map((n) => (n.type === 'output-node' ? migrateOutputNode(n) : n)))
      setEdges(g.edges)
      const maxId = Math.max(0, ...g.nodes.map((n) => Number(n.id.match(/\d+/)?.[0] ?? 0)))
      idSeq = maxId + 1
      setLogs((l) => [...l, '📂 Loaded graph.'])
    } catch {
      setLogs((l) => [...l, '⚠ Could not parse that graph file.'])
    }
  }

  // ── Drag-drop files onto canvas ───────────────────────────────────────────
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
        pushHistory()
        setNodes((n) => [...n, { id: nextId(), type: 'input-node', position, data: nodeData }])
      }
    },
    [screenToFlowPosition, setNodes, pushHistory]
  )

  // ── Render ────────────────────────────────────────────────────────────────
  const selectedNode = nodes.find((n) => n.id === selectedId)
  const canConnectToOutputs = !!selectedNode && selectedNode.type !== 'output-node'
  const isLocationSelected = selectedNode?.type === 'location-node'
  const connectLabel = isLocationSelected ? '⤳ 連到所有 Save as' : '⤳ 連到所有 Output'
  const connectTitle = isLocationSelected
    ? '把這個 Location 連到所有 Output 的 Save as(輸出位置)'
    : '把選取的節點連到畫布上所有 Output'

  return (
    <div className="app">
      <Toolbar
        cutMode={cutMode}
        onToggleCut={() => setCutMode((v) => !v)}
        canConnectToOutputs={canConnectToOutputs}
        onConnectToOutputs={connectSelectedToOutputs}
        connectLabel={connectLabel}
        connectTitle={connectTitle}
        running={running}
        onRun={run}
        onStop={stop}
        onAddInput={addInput}
        onAddRetime={addRetime}
        onAddTrim={addTrim}
        onAddCrop={addCrop}
        onAddOutput={addOutput}
        onAddLocation={addLocation}
        onSave={saveGraph}
        onOpen={loadGraph}
      />

      <div
        className={`canvas${cutMode ? ' canvas-cut' : ''}`}
        ref={canvasRef}
        onDrop={onDropFiles}
        onDragOver={onDragOverCanvas}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWithHistory}
          onEdgesChange={onEdgesChangeWithHistory}
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
        <Knife wrapperRef={canvasRef} active={cutMode} onBeforeCut={pushHistory} />
        <InfoPanel node={selectedNode} />

        {helpOpen ? (
          <div className="shortcuts shortcuts-open">
            <div className="shortcuts-head">
              <span>快捷鍵</span>
              <button className="shortcuts-toggle" onClick={() => setHelpOpen(false)} title="收合">
                ×
              </button>
            </div>
            <ul className="shortcuts-list">
              <li>
                <b>切斷連線</b>:按住 Ctrl/⌘ 拖曳劃過連線,或開啟工具列「✂ 剪刀」後直接拖曳
              </li>
              <li>
                <b>刪除節點/連線</b>:選取後按 Delete / Backspace / X
              </li>
              <li>
                <b>復原 / 重做</b>:⌘Z / ⇧⌘Z
              </li>
              <li>
                <b>插入處理節點</b>:把 Retime/Trim/Crop 拖到一條連線上即自動串接
              </li>
              <li>
                <b>加入來源</b>:把影片/序列資料夾拖進畫布
              </li>
              <li>
                <b>連到所有 Output</b>:選取節點後按工具列按鈕一鍵串接;選 Location 節點時則連到所有 Output 的 Save as
              </li>
            </ul>
          </div>
        ) : (
          <button
            className="shortcuts shortcuts-closed"
            onClick={() => setHelpOpen(true)}
            title="快捷鍵說明"
          >
            ?
          </button>
        )}
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
