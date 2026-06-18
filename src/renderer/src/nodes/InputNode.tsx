import { useState } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import type { InputNodeData, SourceType } from '../types'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

// Decimal (SI) units to match macOS Finder, which counts 1 MB = 1,000,000 bytes.
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1000
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

export function InputNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as InputNodeData
  const [probing, setProbing] = useState(false)

  const pick = async (): Promise<void> => {
    if (d.sourceType === 'sequence') {
      const path = await window.api.openFolder()
      if (!path) return
      updateNodeData(id, {
        path,
        detectedFrames: null,
        detectedWidth: null,
        detectedHeight: null,
        detectedSize: null
      })
      setProbing(true)
      try {
        const info = await window.api.probeSequence(path)
        updateNodeData(id, {
          detectedFrames: info.frameCount,
          detectedWidth: info.width,
          detectedHeight: info.height,
          detectedSize: info.totalBytes
        })
      } catch {
        updateNodeData(id, { detectedFrames: null })
      } finally {
        setProbing(false)
      }
      return
    }
    const path = await window.api.openFile()
    if (!path) return
    // Reset override + show probing, then fill in the detected source info.
    updateNodeData(id, {
      path,
      fps: null,
      detectedFps: null,
      detectedWidth: null,
      detectedHeight: null,
      detectedSize: null,
      detectedDuration: null,
      detectedHasAudio: false,
      detectedFrames: null
    })
    setProbing(true)
    try {
      const info = await window.api.probeMedia(path)
      updateNodeData(id, {
        detectedFps: info.fps,
        detectedWidth: info.width,
        detectedHeight: info.height,
        detectedSize: info.sizeBytes,
        detectedDuration: info.durationSec,
        detectedHasAudio: info.hasAudio
      })
    } catch {
      updateNodeData(id, { detectedFps: null })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="node node-input">
      <div className="node-title">
        <span className="dot dot-in" /> Input
        <DeleteButton id={id} />
      </div>
      <div className="node-body">
        <label className="field">
          <span>Source</span>
          <select
            className="nodrag"
            value={d.sourceType}
            onChange={(e) =>
              updateNodeData(id, {
                sourceType: e.target.value as SourceType,
                path: null,
                fps: null,
                detectedFps: null,
                detectedWidth: null,
                detectedHeight: null,
                detectedSize: null,
                detectedDuration: null,
                detectedHasAudio: false,
                detectedFrames: null
              })
            }
          >
            <option value="sequence">PNG Sequence (folder)</option>
            <option value="video">Video file (MOV / MP4)</option>
          </select>
        </label>

        <button className="btn btn-pick nodrag" onClick={pick}>
          {d.path ? basename(d.path) : d.sourceType === 'sequence' ? 'Choose folder…' : 'Choose file…'}
        </button>

        {d.sourceType === 'sequence' && (
          <>
            <label className="field">
              <span>Frame rate</span>
              <input
                className="nodrag"
                type="number"
                min={1}
                max={120}
                placeholder="30"
                value={d.fps ?? ''}
                onChange={(e) =>
                  updateNodeData(id, { fps: e.target.value ? Number(e.target.value) : null })
                }
              />
            </label>
            {d.path && (
              <div className="hint">
                {probing ? (
                  'Scanning frames…'
                ) : (
                  <>
                    <div>Frames: {d.detectedFrames != null ? d.detectedFrames : 'unknown'}</div>
                    <div>
                      Size:{' '}
                      {d.detectedWidth && d.detectedHeight
                        ? `${d.detectedWidth} × ${d.detectedHeight}`
                        : 'unknown'}
                    </div>
                    <div>
                      Total: {d.detectedSize != null ? formatBytes(d.detectedSize) : 'unknown'}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {d.sourceType === 'video' && d.path && (
          <>
            <div className="hint">
              {probing ? (
                'Detecting…'
              ) : (
                <>
                  <div>Frame rate: {d.detectedFps ? `${d.detectedFps} fps` : 'unknown'}</div>
                  <div>
                    Size:{' '}
                    {d.detectedWidth && d.detectedHeight
                      ? `${d.detectedWidth} × ${d.detectedHeight}`
                      : 'unknown'}
                  </div>
                  <div>
                    Duration:{' '}
                    {d.detectedDuration != null ? `${d.detectedDuration.toFixed(1)}s` : 'unknown'}
                  </div>
                  <div>
                    File: {d.detectedSize != null ? formatBytes(d.detectedSize) : 'unknown'}
                  </div>
                </>
              )}
            </div>
            <label className="field">
              <span>Output fps (blank = keep source)</span>
              <input
                className="nodrag"
                type="number"
                min={1}
                max={120}
                placeholder={d.detectedFps ? String(d.detectedFps) : 'source'}
                value={d.fps ?? ''}
                onChange={(e) =>
                  updateNodeData(id, { fps: e.target.value ? Number(e.target.value) : null })
                }
              />
            </label>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
