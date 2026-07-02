import { useEffect, useState } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { DeleteButton } from './DeleteButton'
import { useThumbnail, type ThumbReq } from './useThumbnail'
import {
  CODEC_LABEL,
  FORMAT_CODECS,
  FORMAT_EXT,
  PRORES_PROFILES,
  supportsAlpha,
  supportsBoomerang,
  supportsHardware,
  supportsHevcAlpha,
  supportsTarget,
  type LoopMode,
  type OutputFormat,
  type OutputNodeData,
  type PngMode,
  type VideoCodec
} from '../types'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p
}

// Decimal (SI) units to match macOS Finder (1 MB = 1,000,000 bytes).
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


export function OutputNode({ id, data }: NodeProps): JSX.Element {
  const { updateNodeData } = useReactFlow()
  const d = data as OutputNodeData
  // Graphs saved before the codec field existed default to the container's first codec.
  const codec: VideoCodec = d.codec ?? FORMAT_CODECS[d.format][0] ?? 'h264'

  const pickOutput = async (): Promise<void> => {
    // Pre-fill the dialog with the current filename so re-picking edits it,
    // instead of resetting to "output.<ext>".
    const path = await window.api.saveFile(d.outputPath ?? `output.${FORMAT_EXT[d.format]}`)
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

  const onLoop = (loopMode: LoopMode): void => {
    // Boomerang doubles the length, so it can't hit an exact target size — force
    // Quality so the (now-hidden) target field can't leave a stale 'target' mode.
    if (loopMode === 'boomerang' && d.sizeMode === 'target') {
      updateNodeData(id, { loopMode, sizeMode: 'quality' })
    } else {
      updateNodeData(id, { loopMode })
    }
  }

  const codecChoices = FORMAT_CODECS[d.format]
  const isPngSeq = d.format === 'pngseq'
  const pngMode: PngMode = d.pngMode ?? 'sequence'
  const pngSingle = isPngSeq && pngMode === 'single'

  // ── Single-PNG frame preview (scrubber) ──
  const srcKind = d.srcKind ?? null
  const srcPath = d.srcPath ?? null
  const srcFps = d.srcFps ?? null
  const srcFrames = d.srcFrames ?? null
  const pngFrameVal = Math.max(0, d.pngFrame ?? 0)
  const frameMax = srcFrames && srcFrames > 0 ? srcFrames - 1 : null
  // Debounce the frame fed to the preview so scrubbing doesn't spawn ffmpeg per tick.
  const [previewFrame, setPreviewFrame] = useState(pngFrameVal)
  useEffect(() => {
    const t = setTimeout(() => setPreviewFrame(pngFrameVal), 150)
    return () => clearTimeout(t)
  }, [pngFrameVal])
  const srcCrop = d.srcCrop ?? undefined
  const previewReq: ThumbReq | null =
    pngSingle && srcKind && srcPath
      ? srcKind === 'video'
        ? {
            kind: 'video',
            path: srcPath,
            timeSec: srcFps && srcFps > 0 ? previewFrame / srcFps : 0,
            crop: srcCrop,
            maxWidth: 240
          }
        : { kind: 'sequence', path: srcPath, frame: previewFrame, crop: srcCrop, maxWidth: 240 }
      : null
  const { url: framePreview, loading: framePreviewLoading } = useThumbnail(previewReq)
  // Keep the last decoded frame on screen while the next one loads, so scrubbing
  // doesn't blank the image (which would make the node height jump / flicker).
  const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null)
  useEffect(() => {
    if (framePreview) setLastFrameUrl(framePreview)
  }, [framePreview])
  useEffect(() => {
    setLastFrameUrl(null) // a new source → drop the retained frame
  }, [srcPath])
  const shownFrame = framePreview ?? lastFrameUrl

  // ── Result preview: a frame of the finished output (bust re-fetches on re-encode) ──
  const resultFull =
    d.status === 'done'
      ? d.locationConnected && d.outputPath
        ? `${d.locationDir}/${basename(d.outputPath)}`
        : d.outputPath
      : null
  // Preview strategy: WebP plays its real file directly (animates in <img>). Every
  // other animated output (APNG can't animate in <img>; MP4/MOV/WebM aren't <img>
  // media; PNG sequence is many files) gets a small animated-WebP preview via
  // previewAnim. A single-frame PNG has nothing to animate → static thumbnail.
  const staticOnly = pngSingle
  const resultReq: ThumbReq | null =
    resultFull && staticOnly
      ? { kind: 'video', path: resultFull, bust: d.outSize ?? 0, maxWidth: 240 }
      : null
  const { url: resultThumb } = useThumbnail(resultReq)
  const [animUrl, setAnimUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!resultFull || staticOnly) {
      setAnimUrl(null)
      return
    }
    let cancelled = false
    const p =
      d.format === 'webp'
        ? window.api.readDataUrl(resultFull)
        : window.api.previewAnim(
            isPngSeq
              ? { kind: 'sequence', path: resultFull.replace(/\.[^.]+$/, ''), maxWidth: 240 }
              : { kind: 'video', path: resultFull, maxWidth: 240 }
          )
    p.then((u) => {
      if (!cancelled) setAnimUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [resultFull, d.format, isPngSeq, staticOnly, d.outSize])
  const resultPreview = animUrl ?? resultThumb

  const isProres = d.format === 'mov' && codec === 'prores'
  const proresAlpha = isProres && d.proresProfile === 4
  const hevcAlphaAvail = supportsHevcAlpha(d.format, codec)
  const hevcAlpha = hevcAlphaAvail && !!d.hevcAlpha
  const boomerang = d.loopMode === 'boomerang'
  // Boomerang can't do exact target size, so target mode is unavailable with it.
  const targetMode = supportsTarget(d.format, codec) && d.sizeMode === 'target' && !boomerang
  const showHardware = supportsHardware(d.format, codec)
  const keepsAlpha = supportsAlpha(d.format, codec, d.proresProfile, hevcAlpha)

  // hasLocation is true the moment a location node is wired up, even before a folder is picked.
  const hasLocation = !!d.locationConnected
  const ext = FORMAT_EXT[d.format]
  // In location mode the user types only the stem; the extension is shown/managed separately.
  const displayStem = d.outputPath ? basename(d.outputPath).replace(/\.[^.]+$/, '') : ''

  const onFilenameStem = (stem: string): void => {
    // Store the full filename (stem + current extension) so format changes & builds stay in sync.
    updateNodeData(id, { outputPath: stem ? `${stem}.${ext}` : null })
  }

  // ── Output size (Photoshop-style: click-to-edit W×H with an aspect-lock chain) ──
  const linked = d.linkDims ?? true
  const srcW = d.srcWidth ?? null
  const srcH = d.srcHeight ?? null
  const aspect = srcW && srcH ? srcW / srcH : null
  // Show the derived dimension when locked so both boxes read like real numbers.
  const wShown =
    d.width != null ? d.width : linked && d.height != null && aspect ? Math.round(d.height * aspect) : ''
  const hShown =
    d.height != null ? d.height : linked && d.width != null && aspect ? Math.round(d.width / aspect) : ''
  const setW = (v: string): void => {
    const width = v ? Math.max(0, Math.round(Number(v))) : null
    // Locked: width is the sole driver (height auto-derives during encode).
    updateNodeData(id, linked ? { width, height: null } : { width })
  }
  const setH = (v: string): void => {
    const height = v ? Math.max(0, Math.round(Number(v))) : null
    updateNodeData(id, linked ? { height, width: null } : { height })
  }
  const toggleLink = (): void => {
    // Re-locking keeps a single driver (prefer width) so the aspect stays defined.
    if (linked) updateNodeData(id, { linkDims: false })
    else updateNodeData(id, d.width != null ? { linkDims: true, height: null } : { linkDims: true })
  }

  return (
    <div className={`node node-output status-${d.status}`}>
      <Handle type="target" position={Position.Left} style={{ top: '30%' }} />
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
            <option value="apng">APNG (animated)</option>
            <option value="pngseq">PNG</option>
          </select>
        </label>

        {d.format === 'apng' && (
          <div className="hint hint-muted">
            無損動畫 PNG(保留透明、無音訊)。相容性廣,但檔案通常比 WebP 大很多。
          </div>
        )}

        {isPngSeq && (
          <label className="field">
            <span>PNG</span>
            <select
              className="nodrag"
              value={pngMode}
              onChange={(e) => updateNodeData(id, { pngMode: e.target.value as PngMode })}
            >
              <option value="sequence">序列(所有影格)</option>
              <option value="single">單張(單一影格)</option>
            </select>
          </label>
        )}

        {pngSingle && (
          <div className="field">
            <span>影格 {pngFrameVal}{frameMax != null ? ` / ${frameMax}` : ''}</span>
            <div className="png-frame-preview">
              {shownFrame ? (
                <img className="png-frame-img" src={shownFrame} alt="" />
              ) : (
                <div className="png-frame-img png-frame-loading">
                  {framePreviewLoading ? 'decoding…' : srcPath ? 'no preview' : '接上 Input 才有預覽'}
                </div>
              )}
            </div>
            {frameMax != null && frameMax > 0 && (
              <input
                className="nodrag"
                type="range"
                min={0}
                max={frameMax}
                value={Math.min(pngFrameVal, frameMax)}
                onChange={(e) => updateNodeData(id, { pngFrame: Number(e.target.value) })}
              />
            )}
            <input
              className="nodrag"
              type="number"
              min={0}
              max={frameMax ?? undefined}
              value={pngFrameVal}
              onChange={(e) =>
                updateNodeData(id, { pngFrame: Math.max(0, Math.round(Number(e.target.value) || 0)) })
              }
              title="要輸出第幾格(0 起算);來源只有一張就填 0"
            />
          </div>
        )}

        {supportsBoomerang(d.format) && !pngSingle && (
          <label className="field">
            <span>Loop</span>
            <select
              className="nodrag"
              value={d.loopMode ?? 'normal'}
              onChange={(e) => onLoop(e.target.value as LoopMode)}
            >
              <option value="normal">Normal</option>
              <option value="boomerang">Boomerang (往返)</option>
            </select>
          </label>
        )}

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

        {supportsTarget(d.format, codec) && !boomerang && (
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

        {isPngSeq ? (
          <div className="hint hint-muted">
            {pngSingle
              ? '無損輸出單一影格 PNG(可保留透明)，無音訊。'
              : '無損逐格輸出 PNG 序列(可保留透明)，無音訊。畫質固定(不壓縮損失)。'}
          </div>
        ) : targetMode ? (
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

        <div className="field">
          <span>Size (px)</span>
          <div className="dim-row">
            <input
              className="nodrag dim-input"
              type="number"
              min={0}
              placeholder={srcW ? String(srcW) : 'W'}
              value={wShown}
              onChange={(e) => setW(e.target.value)}
              title="寬度(px);留空 = 原始尺寸"
            />
            <span className="dim-x">×</span>
            <input
              className="nodrag dim-input"
              type="number"
              min={0}
              placeholder={srcH ? String(srcH) : 'H'}
              value={hShown}
              onChange={(e) => setH(e.target.value)}
              title="高度(px);留空 = 原始尺寸"
            />
            <button
              type="button"
              className={`dim-link nodrag${linked ? ' dim-link-on' : ''}`}
              onClick={toggleLink}
              title={linked ? '長寬已鎖定(等比例)— 點擊解除' : '長寬各自獨立 — 點擊鎖定等比例'}
            >
              {linked ? '🔗' : '🔓'}
            </button>
          </div>
          {srcW && srcH && (d.width == null && d.height == null) && (
            <span className="dim-hint">原始 {srcW}×{srcH}</span>
          )}
        </div>

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

        <div className="output-dest">
          {/* location handle lives here so it stays centered on the destination row.
              left:-12 cancels node-body's padding so it sits on the node's left edge. */}
          <Handle
            type="target"
            id="location"
            position={Position.Left}
            style={{ left: -12, top: '50%' }}
          />
          {hasLocation ? (
            <div className="location-field">
              <div className="hint hint-loc-dir">
                📁 {d.locationDir ?? 'waiting for folder…'}
              </div>
              <div className="filename-row">
                <input
                  className="nodrag location-filename-input"
                  type="text"
                  placeholder="output"
                  value={displayStem}
                  onChange={(e) => onFilenameStem(e.target.value)}
                />
                <span className="filename-ext">.{ext}</span>
              </div>
            </div>
          ) : (
            <button className="btn btn-pick nodrag" onClick={pickOutput}>
              {d.outputPath ? basename(d.outputPath) : 'Save as…'}
            </button>
          )}
        </div>

        {isPngSeq && !pngSingle && d.outputPath && (
          <div className="hint hint-muted">
            影格輸出到子資料夾 📁 {basename(d.outputPath).replace(/\.[^.]+$/, '')}/
          </div>
        )}

        {/* Pre-run blocker for this Output (why Run would skip it). */}
        {d.status === 'idle' && d.problem && (
          <div className="hint hint-warn">⚠ {d.problem}</div>
        )}

        {d.status === 'done' && (d.outputPath || hasLocation) && (
          <>
            {resultPreview && (
              <div className="png-frame-preview">
                <img className="png-frame-img" src={resultPreview} alt="" />
              </div>
            )}
            <div className="hint hint-ok">
              ✓ 完成
              {d.outSize != null && ` · ${formatBytes(d.outSize)}`}
              {targetMode && d.targetMB ? ` / 目標 ${d.targetMB} MB` : ''}
            </div>
            <button
              className="btn btn-pick nodrag"
              onClick={() => {
                const fullPath = hasLocation && d.outputPath
                  ? `${d.locationDir}/${basename(d.outputPath)}`
                  : d.outputPath
                // PNG *sequence* frames live in a subfolder named after the file;
                // a single PNG is revealed as the file itself.
                const target =
                  isPngSeq && !pngSingle && fullPath ? fullPath.replace(/\.[^.]+$/, '') : fullPath
                if (target) window.api.reveal(target)
              }}
            >
              📂 Reveal in Finder
            </button>
          </>
        )}

        {d.status === 'error' && d.message && <div className="hint hint-err">{d.message}</div>}
      </div>
    </div>
  )
}
