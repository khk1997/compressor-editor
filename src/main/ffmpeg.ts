import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync, rmSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
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

const SYSTEM_FF_PATHS =
  process.platform === 'win32'
    ? ['C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']

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
  // Prefer the copy bundled into the app's Resources (with its dylibs), so
  // transparent animated WebP works on machines without a Homebrew libwebp.
  const bundledName = process.platform === 'win32' ? 'img2webp.exe' : 'img2webp'
  const bundled = path.join(process.resourcesPath, 'img2webp', bundledName)
  if (existsSync(bundled)) return bundled
  const paths =
    process.platform === 'win32'
      ? ['C:\\ProgramData\\chocolatey\\bin\\img2webp.exe', 'C:\\libwebp\\bin\\img2webp.exe']
      : ['/opt/homebrew/bin/img2webp', '/usr/local/bin/img2webp']
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return 'img2webp'
}

/** Cache of "does <binary> list <encoder>?" — probing spawns a process. */
const encoderCache = new Map<string, boolean>()
function hasEncoder(bin: string, encoder: string): boolean {
  const key = `${bin}::SEP::${encoder}`
  const cached = encoderCache.get(key)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const r = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 4000 })
    ok = new RegExp(`^\\s*\\S+\\s+${encoder}\\b`, 'm').test(r.stdout || '')
  } catch {
    ok = false
  }
  encoderCache.set(key, ok)
  return ok
}

/** Path to the bundled ffmpeg-static binary (unpacked from the asar in prod). */
function bundledFfmpegPath(): string | null {
  const p = ffmpegStatic ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : null
  return p && existsSync(p) ? p : null
}

/**
 * Resolve an ffmpeg binary that can encode WebP. Homebrew's ffmpeg is often built
 * without libwebp, so prefer whichever binary actually lists the encoder: the
 * default choice if it has libwebp, otherwise the bundled ffmpeg-static (which
 * always ships with it). Falls back to the default so the error stays clear.
 */
let _webpFfmpeg: string | undefined
export function resolveWebpFfmpegPath(): string {
  if (_webpFfmpeg) return _webpFfmpeg
  const def = resolveFfmpegPath()
  if (hasEncoder(def, 'libwebp')) return (_webpFfmpeg = def)
  const bundled = bundledFfmpegPath()
  if (bundled && hasEncoder(bundled, 'libwebp')) return (_webpFfmpeg = bundled)
  return (_webpFfmpeg = def)
}

/** Naturally-sorted absolute paths of the PNG frames in a sequence folder. */
function listSequencePngs(folder: string): string[] {
  return readdirSync(folder)
    .filter((f) => /\.png$/i.test(f))
    // Numeric-aware sort so frame2 < frame10 even without zero-padding.
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(folder, f))
}

/**
 * Boomerang (ping-pong) an ordered frame list: play forward, then the middle
 * back again so the loop turns around seamlessly. Both endpoints are excluded
 * from the return leg so neither turnaround shows a duplicated (stuttered) frame.
 * [f0,f1,f2,f3] → [f0,f1,f2,f3,f2,f1]
 */
function boomerangFrames(frames: string[]): string[] {
  if (frames.length <= 2) return frames
  return frames.concat(frames.slice(1, -1).reverse())
}

/**
 * Turn an already-written PNG sequence into a boomerang in place: copy the
 * middle frames back out under continued numbering (matching the `_NNNNN.png`
 * pattern) so a plain image sequence also plays forward-then-back.
 */
function boomerangPngSeq(dir: string): void {
  const files = listSequencePngs(dir) // absolute paths, numeric-sorted
  if (files.length <= 2) return
  let next = files.length // continue numbering right after the last forward frame
  for (const src of files.slice(1, -1).reverse()) {
    const m = path.basename(src).match(/^(.*?)(\d+)(\.png)$/i)
    if (!m) continue
    const name = `${m[1]}${String(next).padStart(m[2].length, '0')}${m[3]}`
    copyFileSync(src, path.join(dir, name))
    next++
  }
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
export type OutputFormat = 'webp' | 'mp4' | 'mov' | 'webm' | 'pngseq' | 'apng'

/**
 * Map a chosen `.png` destination to a PNG-sequence output: frames go into a
 * sibling subfolder named after the file, as `<stem>/<stem>_%05d.png`. Keeps the
 * frames grouped instead of littering the chosen folder, and lets the rest of the
 * app keep treating the destination as a single path.
 */
export function pngSeqOutput(outputPath: string): { dir: string; pattern: string } {
  const ext = path.extname(outputPath)
  const stem = path.basename(outputPath, ext)
  const dir = path.join(path.dirname(outputPath), stem)
  return { dir, pattern: path.join(dir, `${stem}_%05d.png`) }
}

/** True when PNG output is a single chosen frame (a plain file), not a sequence. */
function isPngSingle(output: OutputSpec): boolean {
  return output.format === 'pngseq' && output.pngMode === 'single'
}

/** Size in bytes of a finished job's output (sum of frames for a PNG sequence). */
export function outputSize(job: Job): number | null {
  try {
    const o = job.output
    if (o.format === 'pngseq' && !isPngSingle(o)) {
      const dir = pngSeqOutput(o.outputPath).dir
      return listSequencePngs(dir).reduce((a, f) => a + statSync(f).size, 0)
    }
    return statSync(o.outputPath).size
  } catch {
    return null
  }
}

/** Video containers whose boomerang is baked in ffmpeg (not via a PNG frame list). */
function isVideoContainer(format: OutputFormat): boolean {
  return format === 'mp4' || format === 'mov' || format === 'webm'
}

/** True when a ffmpeg-encoded output should be boomeranged via filter_complex
 *  (video containers + APNG; WebP/PNG-seq repack their frame list instead). */
function videoBoomerang(output: OutputSpec): boolean {
  return (
    output.loopMode === 'boomerang' &&
    (isVideoContainer(output.format) || output.format === 'apng')
  )
}

/**
 * filter_complex graph that plays the (already-filtered) video forward then in
 * reverse, dropping the shared endpoints so neither turnaround stutters. Audio is
 * intentionally not part of the graph (boomerang video is muted). NOTE: ffmpeg's
 * `reverse` buffers the whole stream in RAM, so long clips are memory-heavy.
 */
function boomerangVideoGraph(filters: string[]): string {
  const pre = filters.length ? `${filters.join(',')},` : ''
  return `[0:v]${pre}split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]`
}

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
  /** Sequence only: 0-based index of the PNG to preview (default 0). */
  frame?: number
  /** Optional crop rect (source px), applied before downscaling. */
  crop?: { x: number; y: number; width: number; height: number }
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
  // Optional crop first (source px), then only downscale (min with iw) so small
  // sources aren't blown up. Crop makes the preview match a cropped output.
  const c = req.crop
  const cropF = c && c.width > 0 && c.height > 0 ? `crop=${c.width}:${c.height}:${c.x}:${c.y},` : ''
  const vf = `${cropF}scale='min(${maxWidth},iw)':-1:flags=bilinear`
  let args: string[]
  if (req.kind === 'sequence') {
    const pngs = listSequencePngs(req.path)
    const idx = Math.min(Math.max(0, req.frame ?? 0), pngs.length - 1)
    const first = pngs[idx]
    if (!first) return null
    args = ['-y', '-i', first, '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
  } else {
    // -ss before -i = fast (keyframe) seek; accurate enough for a preview.
    const seek = req.timeSec && req.timeSec > 0 ? ['-ss', String(req.timeSec)] : []
    // Force libvpx for alpha WebM/MKV so the preview matches the transparent output.
    const dec = webmDecoderArgs(req.path)
    args = ['-y', ...dec, ...seek, '-i', req.path, '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
  }
  const buf = await runFfmpegCapture(args)
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null
}

export interface PreviewAnimRequest {
  kind: 'video' | 'sequence'
  path: string
  /** Sequence input rate; also caps the video preview's frame rate. */
  fps?: number
  /** Longest edge of the returned preview. */
  maxWidth?: number
}

/** Spawn a process and resolve true on a clean (code 0) exit; false otherwise. */
function spawnOk(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args)
    child.stderr.on('data', () => {})
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/**
 * A small looping animated preview (WebP data URL) of a source, for hover-to-play
 * in the Input node and the APNG result preview. Downscaled + low fps + short so it
 * stays tiny. Uses WebP (packed by img2webp for correct alpha) because APNG does not
 * animate in an <img> here. Returns null on failure — never throws.
 */
export async function previewAnim(req: PreviewAnimRequest): Promise<string | null> {
  const w = req.maxWidth ?? 240
  const fps = Math.min(req.fps && req.fps > 0 ? req.fps : 12, 12)
  const durationMs = Math.max(Math.round(1000 / fps), 1)
  const scale = `scale='min(${w},iw)':-1:flags=bilinear`
  let tmpDir: string | null = null
  try {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'anim-'))
    // 1) Render capped, downscaled rgba frames (libvpx decoder for alpha WebM/MKV).
    const out = path.join(tmpDir, 'f_%04d.png')
    const renderArgs =
      req.kind === 'sequence'
        ? ['-y', '-framerate', String(fps), '-pattern_type', 'glob', '-i', path.join(req.path, '*.png'),
            '-frames:v', '48', '-vf', scale, '-pix_fmt', 'rgba', '-start_number', '0', out]
        : ['-y', ...webmDecoderArgs(req.path), '-t', '3', '-i', req.path, '-vf', `${scale},fps=${fps}`,
            '-pix_fmt', 'rgba', '-start_number', '0', out]
    if (!(await spawnOk(resolveFfmpegPath(), renderArgs))) return null
    const frames = listSequencePngs(tmpDir)
    if (!frames.length) return null
    // 2) Pack into an animated WebP (img2webp keeps per-frame alpha correctly).
    const webp = path.join(tmpDir, 'preview.webp')
    const webpArgs = ['-loop', '0', '-d', String(durationMs), '-lossy', '-q', '60', '-m', '4', ...frames, '-o', webp]
    if (!(await spawnOk(resolveImg2webp(), webpArgs))) return null
    return `data:image/webp;base64,${readFileSync(webp).toString('base64')}`
  } catch {
    return null
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  }
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
  /** Frames to drop from the start (frame-accurate). */
  dropFirst: number
  /** Frames to drop from the end (frame-accurate). */
  dropLast: number
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
  /** Target width in px; null = auto (derive from height, or keep original). */
  width: number | null
  /** Target height in px; null = auto (derive from width, or keep original). */
  height?: number | null
  /** Use the macOS VideoToolbox hardware encoder (MP4 / H.265). */
  hardware: boolean
  /** ProRes profile (MOV): 0 Proxy … 3 HQ … 4 4444(alpha). */
  proresProfile: number
  /** Video codec within the container. */
  codec: VideoCodec
  /** MOV + H.265 only: emit Apple "HEVC with Alpha" (forces VideoToolbox). */
  hevcAlpha: boolean
  /** Audio bitrate in kbps (default 192). */
  audioBitrate?: number
  /** Loop packaging (webp / pngseq): 'boomerang' appends the reversed middle. */
  loopMode?: 'normal' | 'boomerang'
  /** PNG format only: 'sequence' (numbered frames) or 'single' (one frame). */
  pngMode?: 'sequence' | 'single'
  /** PNG 'single' mode: 0-based index of the processed frame to export. */
  pngFrame?: number
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
  return !!t && (t.startSec > 0 || t.endSec != null || t.dropFirst > 0 || t.dropLast > 0)
}

/** Source frame rate for frame↔seconds math (defaults to 30 when unknown). */
function sourceFpsOf(input: InputSpec): number {
  return (input.sourceFps && input.sourceFps > 0 ? input.sourceFps : input.fps) ?? 30
}

/** Best-effort total source frame count: exact for sequences, duration × fps for video. */
function totalSourceFrames(input: InputSpec): number | null {
  if (input.type === 'sequence') {
    const n = countSequenceFrames(input.path)
    return n > 0 ? n : null
  }
  if (input.durationSec && input.durationSec > 0 && input.sourceFps && input.sourceFps > 0) {
    return Math.round(input.durationSec * input.sourceFps)
  }
  return null
}

/** True when the seconds (start/end) part of a trim is doing anything. */
function secondsTrimActive(trim: TrimSpec): boolean {
  return trim.startSec > 0 || trim.endSec != null
}

/**
 * Frame count entering the frame-drop stage. Frame drops apply *after* the
 * seconds trim, so this is the length of the seconds window (or the whole
 * source when no seconds trim is set). null when it can't be determined.
 */
function framesInWindow(input: InputSpec, trim: TrimSpec): number | null {
  if (!secondsTrimActive(trim)) return totalSourceFrames(input)
  const dur = resolveDuration(input)
  const end = trim.endSec != null ? trim.endSec : dur
  if (end == null) return null
  const fps = sourceFpsOf(input)
  return Math.max(0, Math.round(end * fps) - Math.round(trim.startSec * fps))
}

/**
 * Trim window in seconds for audio (which can't index video frames). Frame
 * drops are *additive* on top of the seconds window: drop-first pushes the
 * start later, drop-last pulls the end earlier, both by frames ÷ fps.
 */
function trimSeconds(input: InputSpec, trim: TrimSpec): { start: number; end: number | null } {
  const fps = sourceFpsOf(input)
  let start = trim.startSec
  if (trim.dropFirst > 0) start += trim.dropFirst / fps
  let end = trim.endSec
  if (trim.dropLast > 0) {
    const base = trim.endSec != null ? trim.endSec : resolveDuration(input)
    if (base != null) end = base - trim.dropLast / fps
  }
  return { start, end }
}

function cropActive(c: CropSpec | null): c is CropSpec {
  return !!c && c.width > 0 && c.height > 0
}

/** Output duration after trim + speed change (reverse does not change length). */
function effectiveDuration(
  input: InputSpec,
  retime: RetimeSpec | null,
  trim: TrimSpec | null
): number | null {
  let d = resolveDuration(input)
  if (d && trimActive(trim)) {
    const { start, end } = trimSeconds(input, trim)
    const e = end != null ? Math.min(end, d) : d
    d = Math.max(0, e - start)
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

/**
 * VP8/VP9 carry their alpha channel in a side stream that ffmpeg's *native*
 * decoder silently ignores — frames decode fully opaque, so a transparent source
 * turns semi-transparent glows into solid blobs and loses its background. The
 * libvpx decoders keep the alpha, so force them for VP8/VP9 (typically WebM, but
 * MKV can carry VP9 too). ProRes 4444 decodes its alpha fine natively, so only
 * these VP codecs need the override. Returned as input-side `-c:v` args; cached
 * per path to avoid re-probing when input args are built more than once
 * (2-pass encodes, thumbnails). An opaque source probes to [] and stays rgb.
 */
const _webmDecoderCache = new Map<string, string[]>()
function webmDecoderArgs(filePath: string): string[] {
  if (!/\.(webm|mkv)$/i.test(filePath)) return []
  const cached = _webmDecoderCache.get(filePath)
  if (cached) return cached
  const info = spawnSync(resolveFfmpegPath(), ['-i', filePath], { encoding: 'utf8' }).stderr ?? ''
  // Only override when the container actually flags an alpha stream; an opaque
  // VP9/VP8 decodes correctly — and faster — on the native decoder.
  const hasAlpha = /alpha_mode\s*:\s*1/i.test(info)
  const dec =
    hasAlpha && /Video:\s*vp9/i.test(info)
      ? ['-c:v', 'libvpx-vp9']
      : hasAlpha && /Video:\s*vp8/i.test(info)
        ? ['-c:v', 'libvpx']
        : []
  _webmDecoderCache.set(filePath, dec)
  return dec
}
function alphaDecoderArgs(input: InputSpec): string[] {
  return input.type === 'video' ? webmDecoderArgs(input.path) : []
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
  // Force the libvpx decoder for alpha WebM (native VP9/VP8 decoders drop alpha);
  // must come before `-i`. Applies to every output format, not just WebP. An
  // opaque WebM stays rgb (no alpha added), so nothing else regresses.
  return [...alphaDecoderArgs(input), '-i', input.path]
}

/**
 * Build a `scale=` filter from optional width/height. When only one dimension
 * is set, the other is `-2` (auto, kept even for yuv420p). Returns null when
 * neither is set (keep original). When both are set the frame is scaled to
 * those exact dimensions (aspect ratio may change).
 */
function scaleFilter(width: number | null | undefined, height: number | null | undefined): string | null {
  const w = width && width > 0 ? width : null
  const h = height && height > 0 ? height : null
  if (!w && !h) return null
  return `scale=${w ?? -2}:${h ?? -2}:flags=lanczos`
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

  // Trim first (resets the timeline to start at 0). Seconds and frame drops are
  // applied as two *sequential* stages, so they add up instead of fighting:
  // stage 1 cuts the seconds window, stage 2 shaves exact frames off that result.
  if (trimActive(trim)) {
    // Stage 1: seconds window.
    if (secondsTrimActive(trim)) {
      const p: string[] = []
      if (trim.startSec > 0) p.push(`start=${trim.startSec}`)
      if (trim.endSec != null) p.push(`end=${trim.endSec}`)
      filters.push(`trim=${p.join(':')}`, 'setpts=PTS-STARTPTS')
    }
    // Stage 2: frame-accurate drops, relative to the (possibly trimmed) stream.
    if (trim.dropFirst > 0 || trim.dropLast > 0) {
      const framesIn = framesInWindow(input, trim)
      const p: string[] = []
      if (trim.dropFirst > 0) p.push(`start_frame=${trim.dropFirst}`)
      if (trim.dropLast > 0 && framesIn != null) {
        // end_frame is exclusive (first frame to drop); keep at least one frame.
        p.push(`end_frame=${Math.max(trim.dropFirst + 1, framesIn - trim.dropLast)}`)
      }
      if (p.length) filters.push(`trim=${p.join(':')}`, 'setpts=PTS-STARTPTS')
    }
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
  const sf = scaleFilter(output.width, output.height)
  if (sf) filters.push(sf)

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
function buildAudioFilter(
  retime: RetimeSpec | null,
  trim: TrimSpec | null,
  input: InputSpec
): string | null {
  const parts: string[] = []
  if (trimActive(trim)) {
    // Audio can't trim by video-frame index, so fold frame drops into seconds.
    const { start, end } = trimSeconds(input, trim)
    const endStr = end != null ? `:end=${end}` : ''
    parts.push(`atrim=start=${start}${endStr}`, 'asetpts=PTS-STARTPTS')
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
    case 'pngseq': {
      // Lossless PNG; keeps an alpha channel, so don't force a pixel format —
      // let the source's (rgb24 / rgba) pass through. No audio.
      if (isPngSingle(output)) {
        // Single frame: select the chosen processed frame, emit exactly one file.
        const frame = Math.max(0, Math.round(output.pngFrame ?? 0))
        if (frame > 0) filters.push(`select=eq(n\\,${frame})`)
        args.push('-c:v', 'png', '-frames:v', '1', '-an')
      } else {
        // Sequence: numbered frames starting at 0 (mirrors the import side).
        args.push('-c:v', 'png', '-start_number', '0', '-an')
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
    case 'apng': {
      // Animated PNG: lossless, full alpha, single file. ffmpeg's apng encoder
      // handles alpha + per-frame disposal natively (no img2webp needed). rgba
      // keeps transparency; -plays 0 loops forever; -f apng forces the animated
      // muxer (a .png extension would otherwise write a single still frame).
      args.push('-c:v', 'apng', '-plays', '0', '-pix_fmt', 'rgba', '-f', 'apng', '-an')
      break
    }
  }

  if (videoBoomerang(output)) {
    // Forward+reverse via filter_complex; -map [v] keeps only video (audio dropped).
    args.push('-filter_complex', boomerangVideoGraph(filters), '-map', '[v]')
  } else if (filters.length) {
    args.push('-vf', filters.join(','))
  }

  // Audio (mp4/mov/webm/av1); webp has no audio. Re-encode at the chosen bitrate
  // whenever a track is present — not just when trim/retime adds a filter — so the
  // audio bitrate setting always takes effect. The trim/retime filter is layered on
  // top only when needed (to keep audio in sync with the video edits). Boomerang
  // video is muted (we only map [v]), so skip audio entirely there.
  if (
    output.format !== 'webp' &&
    output.format !== 'pngseq' &&
    output.format !== 'apng' &&
    input.hasAudio &&
    !videoBoomerang(output)
  ) {
    const af = buildAudioFilter(retime, trim, input)
    const acodec = output.format === 'webm' ? 'libopus' : 'aac'
    const abr = `${output.audioBitrate ?? 192}k`
    if (af) args.push('-af', af)
    args.push('-c:a', acodec, '-b:a', abr)
  }

  // Sequence PNG goes to a numbered pattern in a subfolder; single PNG (and every
  // other format) writes straight to the chosen path.
  args.push(
    output.format === 'pngseq' && !isPngSingle(output)
      ? pngSeqOutput(output.outputPath).pattern
      : output.outputPath
  )
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
  onChild: (c: ChildProcessWithoutNullStreams) => void,
  bin: string = resolveFfmpegPath()
): Promise<void> {
  cb.onLog(`$ ffmpeg ${args.join(' ')}`)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ['-progress', 'pipe:1', '-nostats', ...args])
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
  const outDurationSec = effectiveDuration(input, retime, trim)
  // Boomerang video plays forward + reverse, so the encoded stream is ~2× as long;
  // double the progress span so the bar tracks the real encode (target-size, which
  // would need the same adjustment for bitrate, is blocked with boomerang upstream).
  const progressSec = outDurationSec && videoBoomerang(output) ? outDurationSec * 2 : outDurationSec
  const totalUs = progressSec ? progressSec * 1_000_000 : null

  // WebP encoding needs the libwebp encoder, which Homebrew's ffmpeg often lacks;
  // pick a binary that actually has it. Other formats use the default resolver.
  const ffBin = output.format === 'webp' ? resolveWebpFfmpegPath() : resolveFfmpegPath()

  const useTarget =
    output.format === 'mp4' &&
    (output.codec === 'h264' || output.codec === 'h265') &&
    output.sizeMode === 'target' &&
    !!output.targetMB &&
    output.targetMB > 0 &&
    !!outDurationSec &&
    // Boomerang can't hit an exact size (length doubles); fall back to quality.
    !videoBoomerang(output)

  // All WebP output goes through img2webp for correct per-frame disposal
  // (transparent animation). ffmpeg's libwebp stacks frames / drops alpha.
  const useWebp = output.format === 'webp'

  // image2 muxer won't create directories — make the per-output frame folder first.
  // (Single-frame PNG writes to the chosen path, whose folder already exists.)
  if (output.format === 'pngseq' && !isPngSingle(output)) {
    mkdirSync(pngSeqOutput(output.outputPath).dir, { recursive: true })
  }

  let promise: Promise<void>

  if (useWebp) {
    promise = (async () => {
      const active = retimeActive(retime)
      let tmpDir: string | null = null
      try {
        let frames: string[]
        let durationMs: number

        if (input.type === 'sequence') {
          const fps = input.fps ?? 30
          const speed = active ? retime.speed : 100
          const interp = active && retime.interpolation !== 'sampling'
          // img2webp can only set per-frame duration + order, so anything that
          // rewrites pixels (interpolation, crop) or selects frames by time (trim)
          // must be rendered through ffmpeg first.
          const needsRender = interp || cropActive(crop) || trimActive(trim)
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
            const seqScale = scaleFilter(output.width, output.height)
            if (seqScale) {
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
                seqScale,
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
        } else {
          // Video → WebP: decode the fully-processed clip to a temp PNG sequence at
          // a fixed rate, then let img2webp pack it with correct per-frame disposal
          // (ffmpeg's libwebp can't, so transparent frames would otherwise stack /
          // go black). -r pins the rate so retime is captured as constant-rate frames.
          const fps =
            input.fps && input.fps > 0
              ? input.fps
              : input.sourceFps && input.sourceFps > 0
                ? input.sourceFps
                : 30
          tmpDir = mkdtempSync(path.join(tmpdir(), 'vidwebp-'))
          const vf = buildFilters(input, output, retime, trim, crop)
          // buildInputArgs forces the libvpx decoder for alpha WebM; the PNG muxer
          // then auto-selects rgba (opaque sources stay rgb), so alpha survives.
          const renderArgs = [
            '-y',
            ...buildInputArgs(input),
            ...(vf.length ? ['-vf', vf.join(',')] : []),
            '-r',
            String(fps),
            '-start_number',
            '0',
            path.join(tmpDir, 'f_%06d.png')
          ]
          await runFfmpeg(renderArgs, totalUs, 0, 0.5, cb, setChild)
          frames = listSequencePngs(tmpDir)
          durationMs = Math.max(Math.round(1000 / fps), 1)
        }
        if (!frames.length) throw new Error('No frames to assemble for the WebP')

        // Boomerang: append the middle in reverse so the animation plays out and back.
        if (output.loopMode === 'boomerang') frames = boomerangFrames(frames)

        const args = [
          '-loop',
          '0',
          '-d',
          String(durationMs),
          '-lossy',
          '-q',
          String(output.quality),
          // Boomerang doubles the frame count; drop img2webp's compression effort
          // from 6 to 4 so the extra frames don't roughly double the packing time.
          '-m',
          output.loopMode === 'boomerang' ? '4' : '6',
          ...frames,
          '-o',
          output.outputPath
        ]
        try {
          await runProcess(resolveImg2webp(), args, cb, setChild)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            cb.onLog('⚠ img2webp not found; falling back to ffmpeg (transparent frames may stack).')
            await runFfmpeg(buildArgs(job), totalUs, 0.4, 0.6, cb, setChild, ffBin)
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
      const af = input.hasAudio ? buildAudioFilter(retime, trim, input) : null
      const abr = `${output.audioBitrate ?? 192}k`
      const audioArgs = input.hasAudio
        ? [...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', abr]
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
      const af = input.hasAudio ? buildAudioFilter(retime, trim, input) : null
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
      const abr2 = `${output.audioBitrate ?? 192}k`
      const audioArgs = input.hasAudio
        ? [...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', abr2]
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
    promise = runFfmpeg(buildArgs(job), totalUs, 0, 1, cb, setChild, ffBin).then(() => {
      // Boomerang for a plain PNG sequence: duplicate the middle frames back out.
      if (output.format === 'pngseq' && output.loopMode === 'boomerang' && !isPngSingle(output)) {
        boomerangPngSeq(pngSeqOutput(output.outputPath).dir)
      }
      cb.onProgress(1)
    })
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
