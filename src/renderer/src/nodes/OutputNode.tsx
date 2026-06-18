import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import {
  CODEC_LABEL,
  FORMAT_CODECS,
  FORMAT_EXT,
  PRORES_PROFILES,
  supportsAlpha,
  supportsHardware,
  supportsHevcAlpha,
  supportsTarget,
  type OutputFormat,
  type OutputNodeData,
  type VideoCodec
} from '../types'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

export function OutputNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as OutputNodeData
  // Graphs saved before the codec field existed default to the container's first codec.
  const codec: VideoCodec = d.codec ?? FORMAT_CODECS[d.format][0] ?? 'h264'

  const pickOutput = async (): Promise<void> => {
    const path = await window.api.saveFile(`output.${FORMAT_EXT[d.format]}`)
    if (path) updateNodeData(id, { outputPath: path })
  }

  const onFormat = (format: OutputFormat): void => {
    // Keep the chosen output filename's extension in sync with the format.
    let outputPath = d.outputPath
    if (outputPath) outputPath = outputPath.replace(/\.[^.]+$/, `.${FORMAT_EXT[format]}`)
    // Reset the codec to the new container's default if the current one isn't valid.
    const codecs = FORMAT_CODECS[format]
    const nextCodec = codecs.includes(codec) ? codec : (codecs[0] ?? codec)
    // Target-size / hardware only apply to some format+codec combos; revert otherwise.
    const sizeMode = supportsTarget(format, nextCodec) ? d.sizeMode : 'quality'
    const hardware = supportsHardware(format, nextCodec) ? d.hardware : false
    updateNodeData(id, { format, codec: nextCodec, outputPath, sizeMode, hardware })
  }

  const onCodec = (next: VideoCodec): void => {
    const sizeMode = supportsTarget(d.format, next) ? d.sizeMode : 'quality'
    const hardware = supportsHardware(d.format, next) ? d.hardware : false
    updateNodeData(id, { codec: next, sizeMode, hardware })
  }

  const codecChoices = FORMAT_CODECS[d.format]
  const isProres = d.format === 'mov' && codec === 'prores'
  const proresAlpha = isProres && d.proresProfile === 4
  const hevcAlphaAvail = supportsHevcAlpha(d.format, codec)
  const hevcAlpha = hevcAlphaAvail && !!d.hevcAlpha
  const targetMode = supportsTarget(d.format, codec) && d.sizeMode === 'target'
  const showHardware = supportsHardware(d.format, codec)
  const keepsAlpha = supportsAlpha(d.format, codec, d.proresProfile, hevcAlpha)

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
            <option value="mp4">MP4</option>
            <option value="mov">MOV</option>
            <option value="webm">WebM (VP9)</option>
          </select>
        </label>

        {codecChoices.length > 0 && (
          <label className="field">
            <span>Codec</span>
            <select
              className="nodrag"
              value={codec}
              onChange={(e) => onCodec(e.target.value as VideoCodec)}
            >
              {codecChoices.map((c) => (
                <option key={c} value={c}>
                  {CODEC_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
        )}

        {supportsTarget(d.format, codec) && (
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

        {showHardware && (
          <label className="field-row">
            <input
              className="nodrag"
              type="checkbox"
              checked={hevcAlpha || d.hardware}
              disabled={hevcAlpha}
              onChange={(e) => updateNodeData(id, { hardware: e.target.checked })}
            />
            <span>
              Hardware encode (VideoToolbox)
              {hevcAlpha && ' — required by HEVC alpha'}
            </span>
          </label>
        )}

        {hevcAlphaAvail && (
          <label className="field-row">
            <input
              className="nodrag"
              type="checkbox"
              checked={hevcAlpha}
              onChange={(e) => updateNodeData(id, { hevcAlpha: e.target.checked })}
            />
            <span>Keep alpha (HEVC, VideoToolbox)</span>
          </label>
        )}

        {!keepsAlpha && !isProres && !hevcAlphaAvail && (
          <div className="hint hint-warn">
            ⚠ {CODEC_LABEL[codec]} cannot keep transparency. Use WebP / WebM / ProRes 4444 for
            alpha.
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
