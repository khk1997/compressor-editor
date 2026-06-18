import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import {
  FORMAT_EXT,
  FORMAT_SUPPORTS_ALPHA,
  PRORES_PROFILES,
  SUPPORTS_HARDWARE,
  SUPPORTS_TARGET,
  type OutputFormat,
  type OutputNodeData
} from '../types'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

export function OutputNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as OutputNodeData

  const pickOutput = async (): Promise<void> => {
    const path = await window.api.saveFile(`output.${FORMAT_EXT[d.format]}`)
    if (path) updateNodeData(id, { outputPath: path })
  }

  const onFormat = (format: OutputFormat): void => {
    // Keep the chosen output filename's extension in sync with the format.
    let outputPath = d.outputPath
    if (outputPath) outputPath = outputPath.replace(/\.[^.]+$/, `.${FORMAT_EXT[format]}`)
    // Target-size / hardware only apply to some formats; revert otherwise.
    const sizeMode = SUPPORTS_TARGET.includes(format) ? d.sizeMode : 'quality'
    const hardware = SUPPORTS_HARDWARE.includes(format) ? d.hardware : false
    updateNodeData(id, { format, outputPath, sizeMode, hardware })
  }

  const targetMode = SUPPORTS_TARGET.includes(d.format) && d.sizeMode === 'target'
  const isProres = d.format === 'mov'
  const proresAlpha = isProres && d.proresProfile === 4

  return (
    <div className={`node node-output status-${d.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">
        <span className="dot dot-out" /> Output
        {d.status === 'running' && <span className="badge">{Math.round(d.percent * 100)}%</span>}
        {d.status === 'done' && <span className="badge badge-ok">done</span>}
        {d.status === 'error' && <span className="badge badge-err">error</span>}
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        <label className="field">
          <span>Format</span>
          <select
            className="nodrag"
            value={d.format}
            onChange={(e) => onFormat(e.target.value as OutputFormat)}
          >
            <option value="webp">WebP (animated)</option>
            <option value="mp4">MP4 (H.264)</option>
            <option value="h265">MP4 (H.265)</option>
            <option value="mov">MOV (ProRes)</option>
            <option value="webm">WebM (VP9)</option>
            <option value="av1">MP4 (AV1)</option>
          </select>
        </label>

        {SUPPORTS_TARGET.includes(d.format) && (
          <label className="field">
            <span>Size by</span>
            <select
              className="nodrag"
              value={d.sizeMode}
              onChange={(e) => updateNodeData(id, { sizeMode: e.target.value })}
            >
              <option value="quality">Quality (CRF)</option>
              <option value="target">Target file size (2-pass)</option>
            </select>
          </label>
        )}

        {targetMode ? (
          <label className="field">
            <span>Target size (MB)</span>
            <input
              className="nodrag"
              type="number"
              min={1}
              placeholder="e.g. 20"
              value={d.targetMB ?? ''}
              onChange={(e) =>
                updateNodeData(id, { targetMB: e.target.value ? Number(e.target.value) : null })
              }
            />
          </label>
        ) : isProres ? (
          <label className="field">
            <span>ProRes profile</span>
            <select
              className="nodrag"
              value={d.proresProfile}
              onChange={(e) => updateNodeData(id, { proresProfile: Number(e.target.value) })}
            >
              {PRORES_PROFILES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span>Quality {d.quality}</span>
            <input
              className="nodrag"
              type="range"
              min={0}
              max={100}
              value={d.quality}
              onChange={(e) => updateNodeData(id, { quality: Number(e.target.value) })}
            />
          </label>
        )}

        <label className="field">
          <span>Width (px)</span>
          <input
            className="nodrag"
            type="number"
            min={0}
            placeholder="original"
            value={d.width ?? ''}
            onChange={(e) =>
              updateNodeData(id, { width: e.target.value ? Number(e.target.value) : null })
            }
          />
        </label>

        {SUPPORTS_HARDWARE.includes(d.format) && (
          <label className="field-row">
            <input
              className="nodrag"
              type="checkbox"
              checked={d.hardware}
              onChange={(e) => updateNodeData(id, { hardware: e.target.checked })}
            />
            <span>Hardware encode (VideoToolbox)</span>
          </label>
        )}

        {!FORMAT_SUPPORTS_ALPHA[d.format] && (
          <div className="hint hint-warn">
            ⚠ {d.format === 'h265' ? 'H.265' : d.format.toUpperCase()} cannot keep transparency.
            Use WebP / WebM / ProRes 4444 for alpha.
          </div>
        )}
        {isProres && !proresAlpha && (
          <div className="hint hint-warn">⚠ Only the 4444 profile keeps transparency (alpha).</div>
        )}

        <button className="btn btn-pick nodrag" onClick={pickOutput}>
          {d.outputPath ? basename(d.outputPath) : 'Save as…'}
        </button>

        {d.status === 'done' && d.outputPath && (
          <button
            className="btn btn-pick nodrag"
            onClick={() => d.outputPath && window.api.reveal(d.outputPath)}
          >
            📂 Reveal in Finder
          </button>
        )}

        {d.status === 'error' && d.message && <div className="hint hint-err">{d.message}</div>}
      </div>
    </div>
  )
}
