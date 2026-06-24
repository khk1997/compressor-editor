import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'

/**
 * Probe the major version number of an ffmpeg binary (returns 0 on failure).
 * We use this to prefer a newer system binary over the bundled one when available,
 * because ffmpeg 6.x (ffmpeg-static) cannot decode Apple HEVC-with-Alpha video
 * inputs — the alpha auxiliary layer was added in ffmpeg 7+.
 */
function ffmpegMajorVersion(bin: string): number {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 3000 })
    const m = (r.stdout || '').match(/ffmpeg version (\d+)/)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

const SYSTEM_FF_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']

/**
 * Resolve the ffmpeg binary.
 * Prefer the system ffmpeg if it is version 7 or newer — that threshold is when
 * Apple HEVC-with-Alpha decoding became reliable. Fall back to the bundled
 * ffmpeg-static (v6) when no suitable system binary is found, so the app still
 * works on machines without a Homebrew install.
 */
export function resolveFfmpegPath(): string {
  for (const p of SYSTEM_FF_PATHS) {
    if (existsSync(p) && ffmpegMajorVersion(p) >= 7) return p
  }
  // Try PATH as well (covers custom installs).
  if (ffmpegMajorVersion('ffmpeg') >= 7) return 'ffmpeg'
  // Fall back to bundled binary.
  const fromStatic = ffmpegStatic ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : null
  if (fromStatic && existsSync(fromStatic)) return fromStatic
  return 'ffmpeg'
}

/**
 * Resolve the `img2webp` binary (from libwebp). ffmpeg's libwebp encoder cannot
 * set per-frame disposal, so transparent animated WebP "stacks" frames; img2webp
 * disposes each frame correctly. NOTE: a packaged build must bundle this binary.
 */
export function resolveImg2webp(): string {
  for (const p of ['/opt/homebrew/bin/img2webp', '/usr/local/bin/img2webp']) {
    if (existsSync(p)) return p
  }
  return 'img2webp'
}

/** Naturally-sorted absolute paths of the PNG frames in a sequence folder. */
function listSequencePngs(folder: string): string[] {
  return readdirSync(folder)
    .filter((f) => /\.png$/i.test(f))
    // Numeric-aware sort so frame2 < frame10 even without zero-padding.
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(folder, f))
}

export interface SequenceInfo {
  frameCount: number
  width: number | null
  height: number | null
  totalBytes: number
}

/** Inspect a PNG-sequence folder: frame count, resolution, total size. */
export function probeSequence(folder: string): Promise<SequenceInfo> {
  const frames = listSequencePngs(folder)
  let totalBytes = 0
  for (const f of frames) {
    try {
      totalBytes += statSync(f).size
    } catch {
      /* ignore */
    }
  }
  const first = frames[0]
  if (!first) {
    return Promise.resolve({ frameCount: 0, width: null, height: null, totalBytes: 0 })
  }
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegPath(), ['-i', first])
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    const done = (): void => {
      const m = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/)
      resolve({
        frameCount: frames.length,
        width: m ? Number(m[1]) : null,
        height: m ? Number(m[2]) : null,
        totalBytes
      })
    }
    child.on('error', done)
    child.on('close', done)
  })
}

export type SourceType = 'sequence' | 'video' | 'batch'
export type OutputFormat = 'webp' | 'mp4' | 'mov' | 'webm'

/** Video file extensions we accept as inputs (drag-drop, batch folders). */
const VIDEO_EXT = /\.(mov|mp4|m4v|mkv|webm|avi)$/i

/** Naturally-sorted absolute paths of the video files in a folder (batch input). */
export function listVideosInFolder(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((f) => VIDEO_EXT.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => path.join(folder, f))
  } catch {
    return []
  }
}

/** Spawn ffmpeg and resolve its full stdout as a Buffer (null on failure). */
function runFfmpegCapture(args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const child = spawn(resolveFfmpegPath(), args)
    child.stdout.on('data', (b: Buffer) => chunks.push(b))
    child.stderr.on('data', () => {
      /* ignore: ffmpeg prints stream info to stderr */
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null))
  })
}

export interface ThumbnailRequest {
  /** 'video' → seek into a file; 'sequence' → first PNG of a folder. */
  kind: 'video' | 'sequence'
  /** A video file path, or a sequence folder path. */
  path: string
  /** Seek time in seconds (video only). */
  timeSec?: number
  /** Longest edge of the returned image; the frame is scaled down to fit. */
  maxWidth?: number
}

/**
 * Extract a single frame as a base64 PNG data URL, scaled down to maxWidth.
 * Used for in-node previews (Input / Crop / Trim). Returns null if extraction
 * fails so callers can fall back to a placeholder — never throws.
 */
export async function thumbnail(req: ThumbnailRequest): Promise<string | null> {
  const maxWidth = req.maxWidth ?? 320
  // Only downscale (min with iw) so small sources aren't blown up.
  const scale = `scale='min(${maxWidth},iw)':-1:flags=bilinear`
  let args: string[]
  if (req.kind === 'sequence') {
    const first = listSequencePngs(req.path)[0]
    if (!first) return null
    args = ['-y', '-i', first, '-vf', scale, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
  } else {
    // -ss before -i = fast (keyframe) seek; accurate enough for a preview.
    const seek = req.timeSec && req.timeSec > 0 ? ['-ss', String(req.timeSec)] : []
    args = ['-y', ...seek, '-i', req.path, '-vf', scale, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
  }
  const buf = await runFfmpegCapture(args)
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null
}
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'prores'

/** Software / hardware H.26x encoders per codec. */
const SW_CODEC: Record<string, string> = { h264: 'libx264', h265: 'libx265' }
const HW_CODEC: Record<string, string> = { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' }
/** Extra muxer args (H.265 needs the hvc1 tag for QuickTime/Safari). */
const codecExtra = (codec: string): string[] => (codec === 'h265' ? ['-tag:v', 'hvc1'] : [])

/**
 * Push H.264 / H.265 encoder args (used by MP4 and MOV outputs).
 * `kind` selects the codec family; `quality` is the 0–100 slider value.
 */
function pushH26xArgs(
  args: string[],
  kind: 'h264' | 'h265',
  hardware: boolean,
  quality: number
): void {
  if (hardware) {
    // VideoToolbox constant quality: -q:v 0–100, higher = better (matches slider).
    args.push('-c:v', HW_CODEC[kind], '-q:v', String(quality), ...codecExtra(kind))
  } else {
    // CRF: invert the slider. x264 18→51, x265 22→51.
    const span = kind === 'h265' ? 29 : 33
    const crf = Math.round(51 - (quality / 100) * span)
    args.push('-c:v', SW_CODEC[kind], '-crf', String(crf), '-preset', 'medium', ...codecExtra(kind))
  }
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart')
}

/** Push encoder args for any H.264/H.265/AV1 video codec (MP4 container). */
function pushVideoCodecArgs(
  args: string[],
  codec: VideoCodec,
  hardware: boolean,
  quality: number
): void {
  if (codec === 'av1') {
    // SVT-AV1: CRF-style quality (-crf 0–63, lower = better). 100 → 18, 0 → 58.
    const crf = Math.round(58 - (quality / 100) * 40)
    args.push('-c:v', 'libsvtav1', '-crf', String(crf), '-preset', '7', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
  } else {
    pushH26xArgs(args, codec as 'h264' | 'h265', hardware, quality)
  }
}
export type SizeMode = 'quality' | 'target'
export type Interpolation = 'sampling' | 'blend' | 'optical'

export interface InputSpec {
  type: SourceType
  /** Folder for an image sequence, or a file path for a video. */
  path: string
  /**
   * Sequence: input frame rate (defaults to 30 if null).
   * Video: optional output fps override; null = keep the source frame rate.
   */
  fps: number | null
  /** Source frame rate (sequence rate, or a video's detected fps) for interpolation. */
  sourceFps: number | null
  /** Source duration in seconds (video). Sequences are derived from frame count. */
  durationSec: number | null
  /** Whether the source carries an audio track. */
  hasAudio: boolean
}

export interface RetimeSpec {
  /** Playback speed in percent (100 = normal). */
  speed: number
  reverse: boolean
  interpolation: Interpolation
}

export interface TrimSpec {
  startSec: number
  endSec: number | null
}

export interface CropSpec {
  x: number
  y: number
  width: number
  height: number
}

export interface OutputSpec {
  format: OutputFormat
  /** Quality mode: 0–100, higher = better quality / larger file. */
  quality: number
  /** Sizing strategy. 'target' (2-pass, MP4 only) reverse-engineers a bitrate. */
  sizeMode: SizeMode
  /** Desired output size in MB when sizeMode === 'target'. */
  targetMB: number | null
  /** Target width in px; height is auto to keep aspect ratio. null = keep original. */
  width: number | null
  /** Use the macOS VideoToolbox hardware encoder (MP4 / H.265). */
  hardware: boolean
  /** ProRes profile (MOV): 0 Proxy … 3 HQ … 4 4444(alpha). */
  proresProfile: number
  /** Video codec within the container. */
  codec: VideoCodec
  /** MOV + H.265 only: emit Apple "HEVC with Alpha" (forces VideoToolbox). */
  hevcAlpha: boolean
  outputPath: string
}

export interface Job {
  id: string
  input: InputSpec
  output: OutputSpec
  /** Optional retime stage (speed / reverse / interpolation). */
  retime: RetimeSpec | null
  /** Optional trim (in/out points). */
  trim: TrimSpec | null
  /** Optional crop region. */
  crop: CropSpec | null
}

/** True when a retime stage actually changes anything. */
function retimeActive(r: RetimeSpec | null): r is RetimeSpec {
  return !!r && (r.speed !== 100 || r.reverse || r.interpolation !== 'sampling')
}

function trimActive(t: TrimSpec | null): t is TrimSpec {
  return !!t && (t.startSec > 0 || t.endSec != null)
}

function cropActive(c: CropSpec | null): c is CropSpec {
  return !!c && c.width > 0 && c.height > 0
}

/** Output duration after trim + speed change (reverse does not change length). */
function effectiveDuration(
  durationSec: number | null,
  retime: RetimeSpec | null,
  trim: TrimSpec | null
): number | null {
  let d = durationSec
  if (d && trimActive(trim)) {
    const end = trim.endSec != null ? Math.min(trim.endSec, d) : d
    d = Math.max(0, end - trim.startSec)
  }
  if (d && retime && retime.speed !== 100) d = d * (100 / retime.speed)
  return d
}

/** Count numbered PNG frames in a folder so we can report progress / duration. */
function countSequenceFrames(folder: string): number {
  try {
    return readdirSync(folder).filter((f) => /\.png$/i.test(f)).length
  } catch {
    return 0
  }
}

/** Resolve a usable duration in seconds, deriving it for sequences. */
function resolveDuration(input: InputSpec): number | null {
  if (input.durationSec && input.durationSec > 0) return input.durationSec
  if (input.type === 'sequence') {
    const frames = countSequenceFrames(input.path)
    return frames > 0 ? frames / (input.fps ?? 30) : null
  }
  return null
}

function buildInputArgs(input: InputSpec): string[] {
  if (input.type === 'sequence') {
    return [
      '-framerate',
      String(input.fps ?? 30),
      '-pattern_type',
      'glob',
      '-i',
      path.join(input.path, '*.png')
    ]
  }
  return ['-i', input.path]
}

/** Trim + crop + retime + scale + fps video filter chain. */
function buildFilters(
  input: InputSpec,
  output: OutputSpec,
  retime: RetimeSpec | null,
  trim: TrimSpec | null,
  crop: CropSpec | null
): string[] {
  const filters: string[] = []

  // Trim first (resets the timeline to start at 0).
  if (trimActive(trim)) {
    const end = trim.endSec != null ? `:end=${trim.endSec}` : ''
    filters.push(`trim=start=${trim.startSec}${end}`, 'setpts=PTS-STARTPTS')
  }
  if (cropActive(crop)) {
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }

  const active = retimeActive(retime)
  // Reverse / speed / interpolation.
  if (active && retime.reverse) filters.push('reverse')
  if (active && retime.speed !== 100) {
    // setpts factor = 1 / speed-fraction (50% → 2.0 = twice as long).
    filters.push(`setpts=${(100 / retime.speed).toFixed(6)}*PTS`)
  }

  // Resize (after crop/retime; -2 keeps the dimension even for yuv420p).
  if (output.width && output.width > 0) {
    filters.push(`scale=${output.width}:-2:flags=lanczos`)
  }

  // Frame interpolation regenerates intermediate frames for smooth retiming.
  const fpsTarget = input.fps && input.fps > 0 ? input.fps : input.sourceFps && input.sourceFps > 0 ? input.sourceFps : 30
  if (active && retime.interpolation !== 'sampling') {
    const mode = retime.interpolation === 'optical' ? 'mci:me_mode=bidir' : 'blend'
    filters.push(`minterpolate=fps=${fpsTarget}:mi_mode=${mode}`)
  } else if (input.type === 'video' && input.fps && input.fps > 0) {
    // Plain fps override (e.g. 60 → 30) when not interpolating.
    filters.push(`fps=${input.fps}`)
  }
  return filters
}

/** atempo only accepts 0.5–2.0; decompose an arbitrary tempo into a chain. */
function atempoChain(tempo: number): string[] {
  const parts: string[] = []
  let t = tempo
  while (t > 2.0) {
    parts.push('atempo=2.0')
    t /= 2.0
  }
  while (t < 0.5) {
    parts.push('atempo=0.5')
    t *= 2.0
  }
  parts.push(`atempo=${t.toFixed(6)}`)
  return parts
}

/** Audio filter string for trim + retime, or null if no audio change needed. */
function buildAudioFilter(retime: RetimeSpec | null, trim: TrimSpec | null): string | null {
  const parts: string[] = []
  if (trimActive(trim)) {
    const end = trim.endSec != null ? `:end=${trim.endSec}` : ''
    parts.push(`atrim=start=${trim.startSec}${end}`, 'asetpts=PTS-STARTPTS')
  }
  if (retimeActive(retime)) {
    if (retime.reverse) parts.push('areverse')
    if (retime.speed !== 100) parts.push(...atempoChain(retime.speed / 100))
  }
  return parts.length ? parts.join(',') : null
}

/** Video bitrate (bps) needed to hit a target size, reserving room for audio. */
function computeVideoBitrate(targetMB: number, durationSec: number, hasAudio: boolean): number {
  const totalBits = targetMB * 1_000_000 * 8 // decimal MB, matches Finder
  const audioBps = hasAudio ? 128_000 : 0
  return Math.max(Math.floor(totalBits / durationSec) - audioBps, 50_000)
}

/**
 * Build a single-pass ffmpeg argument list (quality mode, all formats).
 */
export function buildArgs(job: Job): string[] {
  const { input, output, retime, trim, crop } = job
  const args: string[] = ['-y', ...buildInputArgs(input)]
  const filters = buildFilters(input, output, retime, trim, crop)

  switch (output.format) {
    case 'webp': {
      // libwebp encodes an animated WebP when fed multiple frames.
      args.push('-c:v', 'libwebp', '-loop', '0', '-q:v', String(output.quality), '-preset', 'picture', '-an')
      break
    }
    case 'mp4': {
      // Container for H.264 / H.265 / AV1, all quality-driven.
      pushVideoCodecArgs(args, output.codec, output.hardware, output.quality)
      break
    }
    case 'mov': {
      if (output.codec === 'h265' && output.hevcAlpha) {
        // Apple "HEVC with Alpha". VideoToolbox-only — libx265 can't emit a
        // QuickTime-playable alpha layer. bgra feeds the encoder an alpha plane.
        const aq = (output.quality / 100).toFixed(2)
        args.push('-c:v', 'hevc_videotoolbox', '-q:v', String(output.quality), '-alpha_quality', aq, '-tag:v', 'hvc1', '-pix_fmt', 'bgra', '-movflags', '+faststart')
      } else if (output.codec === 'h264' || output.codec === 'h265') {
        // H.264 / H.265 inside a MOV container; quality-driven like MP4.
        pushH26xArgs(args, output.codec, output.hardware, output.quality)
      } else {
        // Explicit ProRes profile; 4444 carries alpha (yuva444p10le).
        const profile = output.proresProfile
        const pix = profile === 4 ? 'yuva444p10le' : 'yuv422p10le'
        args.push('-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', pix)
      }
      break
    }
    case 'webm': {
      // VP9 constant-quality (CRF + -b:v 0). 100 → crf 15, 0 → crf 45.
      // yuva420p + `-auto-alt-ref 0` preserves the alpha channel (stored as a
      // WebM alpha_mode=1 BlockAdditional stream that browsers decode). alt-ref
      // frames must be disabled or they corrupt the alpha plane.
      const crf = Math.round(45 - (output.quality / 100) * 30)
      args.push(
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(crf),
        '-b:v',
        '0',
        '-pix_fmt',
        'yuva420p',
        '-auto-alt-ref',
        '0',
        '-row-mt',
        '1',
        '-deadline',
        'good',
        '-cpu-used',
        '4'
      )
      break
    }
  }

  if (filters.length) args.push('-vf', filters.join(','))

  // Trim/retime audio (mp4/mov/webm/av1) so it stays in sync; webp has no audio.
  if (output.format !== 'webp' && input.hasAudio) {
    const af = buildAudioFilter(retime, trim)
    if (af) {
      // WebM uses Opus; other containers use AAC.
      const acodec = output.format === 'webm' ? 'libopus' : 'aac'
      args.push('-af', af, '-c:a', acodec, '-b:a', '192k')
    }
  }

  args.push(output.outputPath)
  return args
}

export interface RunCallbacks {
  onProgress: (percent: number) => void
  onLog: (line: string) => void
}

/** Parse an ffmpeg `Duration: HH:MM:SS.xx` line into microseconds. */
function parseDurationUs(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
  if (!m) return null
  const [, h, mn, s] = m
  return (Number(h) * 3600 + Number(mn) * 60 + Number(s)) * 1_000_000
}

/**
 * Run a single ffmpeg invocation, mapping its progress into [base, base+span].
 * Returns the child so the caller can keep a handle for cancellation.
 */
function runFfmpeg(
  args: string[],
  totalUs: number | null,
  base: number,
  span: number,
  cb: RunCallbacks,
  onChild: (c: ChildProcessWithoutNullStreams) => void
): Promise<void> {
  cb.onLog(`$ ffmpeg ${args.join(' ')}`)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ['-progress', 'pipe:1', '-nostats', ...args])
    onChild(child)
    let stderrTail = ''
    let localTotal = totalUs

    child.stdout.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const [key, value] = line.split('=')
        if (key === 'out_time_us' && localTotal) {
          const cur = Number(value)
          if (!Number.isNaN(cur)) {
            cb.onProgress(Math.min(base + (cur / localTotal) * span, base + span - 0.001))
          }
        }
      }
    })

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      if (!localTotal) {
        const d = parseDurationUs(stderrTail)
        if (d) localTotal = d
      }
      cb.onLog(text.trimEnd())
    })

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail.slice(-1000)}`))
    })
  })
}

/** Run an arbitrary process (e.g. img2webp), streaming output to the log. */
function runProcess(
  bin: string,
  args: string[],
  cb: RunCallbacks,
  onChild: (c: ChildProcessWithoutNullStreams) => void
): Promise<void> {
  cb.onLog(`$ ${path.basename(bin)} ${args.join(' ')}`)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args)
    onChild(child)
    let tail = ''
    const onData = (b: Buffer): void => {
      const t = b.toString()
      tail = (tail + t).slice(-4000)
      cb.onLog(t.trimEnd())
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(bin)} exited with code ${code}\n${tail.slice(-800)}`))
    })
  })
}

/**
 * Run one job. Resolves on success, rejects with the tail of the log on
 * failure. Progress is reported 0–1. MP4 target-size jobs run as 2-pass.
 */
export function runJob(job: Job, cb: RunCallbacks): { promise: Promise<void>; kill: () => void } {
  const { input, output, retime, trim, crop } = job
  let current: ChildProcessWithoutNullStreams | null = null
  const setChild = (c: ChildProcessWithoutNullStreams): void => {
    current = c
  }

  // Progress / bitrate use the *output* duration, which trim / speed alter.
  const outDurationSec = effectiveDuration(resolveDuration(input), retime, trim)
  const totalUs = outDurationSec ? outDurationSec * 1_000_000 : null

  const useTarget =
    output.format === 'mp4' &&
    (output.codec === 'h264' || output.codec === 'h265') &&
    output.sizeMode === 'target' &&
    !!output.targetMB &&
    output.targetMB > 0 &&
    !!outDurationSec

  // PNG sequence → WebP must go through img2webp for correct frame disposal.
  const useSequenceWebp = input.type === 'sequence' && output.format === 'webp'

  let promise: Promise<void>

  if (useSequenceWebp) {
    promise = (async () => {
      const fps = input.fps ?? 30
      const active = retimeActive(retime)
      const speed = active ? retime.speed : 100
      const interp = active && retime.interpolation !== 'sampling'
      // img2webp can only set per-frame duration + order, so anything that
      // rewrites pixels (interpolation, crop) or selects frames by time (trim)
      // must be rendered through ffmpeg first.
      const needsRender = interp || cropActive(crop) || trimActive(trim)
      let tmpDir: string | null = null
      try {
        let frames: string[]
        let durationMs: number

        if (needsRender) {
          // Render the trimmed/cropped/retimed (and scaled) frames with ffmpeg,
          // then let img2webp pack them.
          tmpDir = mkdtempSync(path.join(tmpdir(), 'seqretime-'))
          const vf = buildFilters(input, output, retime, trim, crop)
          const renderArgs = [
            '-y',
            ...buildInputArgs(input),
            '-vf',
            vf.join(','),
            '-start_number',
            '0',
            path.join(tmpDir, 'f_%06d.png')
          ]
          await runFfmpeg(renderArgs, totalUs, 0, 0.5, cb, setChild)
          frames = listSequencePngs(tmpDir)
          durationMs = Math.max(Math.round(1000 / fps), 1) // timing baked into frames
        } else {
          if (output.width && output.width > 0) {
            // img2webp can't resize, so pre-scale every frame with ffmpeg first.
            tmpDir = mkdtempSync(path.join(tmpdir(), 'seqscale-'))
            const scaleArgs = [
              '-y',
              '-framerate',
              String(fps),
              '-pattern_type',
              'glob',
              '-i',
              path.join(input.path, '*.png'),
              '-vf',
              `scale=${output.width}:-2:flags=lanczos`,
              '-start_number',
              '0',
              path.join(tmpDir, 'f_%06d.png')
            ]
            await runFfmpeg(scaleArgs, totalUs, 0, 0.4, cb, setChild)
            frames = listSequencePngs(tmpDir)
          } else {
            frames = listSequencePngs(input.path)
          }
          // Frame sampling: speed/reverse handled by per-frame duration + order.
          if (active && retime.reverse) frames = [...frames].reverse()
          durationMs = Math.max(Math.round((1000 / fps) * (100 / speed)), 1)
        }
        if (!frames.length) throw new Error('No PNG frames found in the sequence folder')

        const args = [
          '-loop',
          '0',
          '-d',
          String(durationMs),
          '-lossy',
          '-q',
          String(output.quality),
          '-m',
          '6',
          ...frames,
          '-o',
          output.outputPath
        ]
        try {
          await runProcess(resolveImg2webp(), args, cb, setChild)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            cb.onLog('⚠ img2webp not found; falling back to ffmpeg (transparent frames may stack).')
            await runFfmpeg(buildArgs(job), totalUs, 0.4, 0.6, cb, setChild)
          } else {
            throw err
          }
        }
        cb.onProgress(1)
      } finally {
        if (tmpDir) {
          try {
            rmSync(tmpDir, { recursive: true, force: true })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    })()
  } else if (useTarget && output.hardware) {
    // Hardware target size: VideoToolbox has no 2-pass, so do single-pass -b:v.
    promise = (async () => {
      const vbps = computeVideoBitrate(output.targetMB!, outDurationSec!, input.hasAudio)
      const filters = buildFilters(input, output, retime, trim, crop)
      const vf = filters.length ? ['-vf', filters.join(',')] : []
      const af = input.hasAudio ? buildAudioFilter(retime, trim) : null
      const audioArgs = input.hasAudio
        ? [...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', '128k']
        : ['-an']
      const args = [
        '-y',
        ...buildInputArgs(input),
        '-c:v',
        HW_CODEC[output.codec],
        '-b:v',
        String(vbps),
        ...codecExtra(output.codec),
        '-pix_fmt',
        'yuv420p',
        ...vf,
        ...audioArgs,
        '-movflags',
        '+faststart',
        output.outputPath
      ]
      cb.onLog(
        `Target ${output.targetMB} MB over ${outDurationSec!.toFixed(1)}s → ${Math.round(vbps / 1000)} kbps (hardware, 1-pass)`
      )
      await runFfmpeg(args, totalUs, 0, 1, cb, setChild)
      cb.onProgress(1)
    })()
  } else if (useTarget) {
    promise = (async () => {
      const vbps = computeVideoBitrate(output.targetMB!, outDurationSec!, input.hasAudio)
      const filters = buildFilters(input, output, retime, trim, crop)
      const vf = filters.length ? ['-vf', filters.join(',')] : []
      const af = input.hasAudio ? buildAudioFilter(retime, trim) : null
      const logPrefix = path.join(tmpdir(), `ffpass-${job.id}`)
      const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
      const common = [
        ...buildInputArgs(input),
        '-c:v',
        SW_CODEC[output.codec],
        '-b:v',
        String(vbps),
        '-preset',
        'medium',
        ...codecExtra(output.codec),
        '-pix_fmt',
        'yuv420p',
        ...vf
      ]
      const pass1 = ['-y', ...common, '-pass', '1', '-passlogfile', logPrefix, '-an', '-f', 'null', nullDev]
      const audioArgs = input.hasAudio
        ? [...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', '128k']
        : ['-an']
      const pass2 = [
        '-y',
        ...common,
        '-pass',
        '2',
        '-passlogfile',
        logPrefix,
        ...audioArgs,
        '-movflags',
        '+faststart',
        output.outputPath
      ]
      cb.onLog(
        `Target ${output.targetMB} MB over ${outDurationSec!.toFixed(1)}s → video bitrate ${Math.round(vbps / 1000)} kbps (2-pass)`
      )
      try {
        await runFfmpeg(pass1, totalUs, 0, 0.5, cb, setChild)
        await runFfmpeg(pass2, totalUs, 0.5, 0.5, cb, setChild)
        cb.onProgress(1)
      } finally {
        for (const suffix of ['-0.log', '-0.log.mbtree', '-0.log.cutree', '.log', '.log.cutree']) {
          try {
            rmSync(logPrefix + suffix)
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    })()
  } else {
    promise = runFfmpeg(buildArgs(job), totalUs, 0, 1, cb, setChild).then(() => cb.onProgress(1))
  }

  return { promise, kill: () => current?.kill('SIGKILL') }
}

export interface MediaInfo {
  fps: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  durationSec: number | null
  hasAudio: boolean
}

/**
 * Detect a video's fps, resolution, duration, audio and file size by parsing
 * `ffmpeg -i` output. We avoid a separate ffprobe dependency — ffmpeg prints
 * stream info to stderr and exits non-zero (no output), which is expected here.
 */
export function probeMedia(file: string): Promise<MediaInfo> {
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(file).size
  } catch {
    sizeBytes = null
  }

  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegPath(), ['-i', file])
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    const fail = (): void =>
      resolve({ fps: null, width: null, height: null, sizeBytes, durationSec: null, hasAudio: false })
    child.on('error', fail)
    child.on('close', () => {
      // e.g. "Video: h264 ..., yuv420p, 1920x1080 [SAR 1:1 ...], 1234 kb/s, 30 fps, ..."
      const fpsM = stderr.match(/(\d+(?:\.\d+)?)\s*fps/)
      const dimM = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/)
      const durM = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      resolve({
        fps: fpsM ? Number(fpsM[1]) : null,
        width: dimM ? Number(dimM[1]) : null,
        height: dimM ? Number(dimM[2]) : null,
        sizeBytes,
        durationSec: durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : null,
        hasAudio: /\bAudio:/.test(stderr)
      })
    })
  })
}
