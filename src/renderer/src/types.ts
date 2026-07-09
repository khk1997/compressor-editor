export type SourceType = 'sequence' | 'video' | 'batch'

/** Upstream source info synced into Crop/Trim nodes so they can show a preview. */
export interface UpstreamSrc {
  /** How to fetch a preview frame; null when no input is connected. */
  srcKind?: 'video' | 'sequence' | null
  /** A video file path, or a sequence folder path. */
  srcPath?: string | null
  srcWidth?: number | null
  srcHeight?: number | null
  /** Total source frame count (sequence: file count; video: duration × fps). null = unknown. */
  srcFrames?: number | null
  /** Source frame rate, used to convert frame drops to seconds for audio. */
  srcFps?: number | null
  /** Source carries a transparency channel (drives the "will drop alpha" hint). */
  srcHasAlpha?: boolean | null
}
/** Output container. The actual video codec is chosen separately (see VideoCodec). */
export type OutputFormat = 'webp' | 'mp4' | 'mov' | 'webm' | 'pngseq' | 'apng'
/** Video codec. Which ones are valid depends on the container (see FORMAT_CODECS). */
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'prores'

export interface TrimNodeData extends UpstreamSrc {
  /** Start time in seconds. */
  startSec: number
  /** End time in seconds; null = to the end. */
  endSec: number | null
  /** Frames to drop from the start (frame-accurate, on top of startSec). */
  dropFirst?: number
  /** Frames to drop from the end (e.g. 1 to remove a duplicate loop frame). */
  dropLast?: number
  [key: string]: unknown
}

export interface CropNodeData extends UpstreamSrc {
  x: number
  y: number
  /** Crop width/height in px; 0 = inactive. */
  width: number
  height: number
  [key: string]: unknown
}

/** ProRes profiles (MOV). 4444 keeps an alpha channel. */
export const PRORES_PROFILES: { value: number; label: string }[] = [
  { value: 0, label: 'Proxy' },
  { value: 1, label: 'LT' },
  { value: 2, label: 'Standard' },
  { value: 3, label: 'HQ' },
  { value: 4, label: '4444 (alpha)' }
]

export const CODEC_LABEL: Record<VideoCodec, string> = {
  h264: 'H.264',
  h265: 'H.265',
  av1: 'AV1',
  prores: 'ProRes'
}

/**
 * Codecs selectable within each container; the first entry is the default.
 * An empty list means the container has a single fixed codec (no choice shown).
 */
export const FORMAT_CODECS: Record<OutputFormat, VideoCodec[]> = {
  webp: [],
  mp4: ['h264', 'h265', 'av1'],
  mov: ['prores', 'h264', 'h265'],
  webm: [],
  pngseq: [],
  apng: []
}

export type JobState = 'idle' | 'running' | 'done' | 'error'
export type SizeMode = 'quality' | 'target'
export type Interpolation = 'sampling' | 'blend' | 'optical'
/** How the animation loops. 'boomerang' appends the reversed middle (webp / pngseq only). */
export type LoopMode = 'normal' | 'boomerang'
/** PNG output shape: a numbered frame sequence, or a single chosen frame. */
export type PngMode = 'sequence' | 'single'
/** Boomerang (back-and-forth) can be baked into every output format. */
export function supportsBoomerang(_format: OutputFormat): boolean {
  return true
}

/** Target-file-size (2-pass) is only meaningful for H.264/H.265 in an MP4. */
export function supportsTarget(format: OutputFormat, codec: VideoCodec): boolean {
  return format === 'mp4' && (codec === 'h264' || codec === 'h265')
}
/** VideoToolbox hardware encode applies to H.264/H.265 in an MP4 or MOV. */
export function supportsHardware(format: OutputFormat, codec: VideoCodec): boolean {
  return (format === 'mp4' || format === 'mov') && (codec === 'h264' || codec === 'h265')
}
/** MOV + H.265 can carry alpha via Apple's "HEVC with Alpha" (VideoToolbox). */
export function supportsHevcAlpha(format: OutputFormat, codec: VideoCodec): boolean {
  return format === 'mov' && codec === 'h265'
}
/** Whether the chosen output actually keeps an alpha (transparency) channel. */
export function supportsAlpha(
  format: OutputFormat,
  codec: VideoCodec,
  proresProfile: number,
  hevcAlpha: boolean
): boolean {
  if (format === 'webp' || format === 'webm' || format === 'pngseq' || format === 'apng') return true
  if (format === 'mov' && codec === 'prores' && proresProfile === 4) return true
  if (supportsHevcAlpha(format, codec) && hevcAlpha) return true
  return false
}

export interface RetimeNodeData {
  /** Playback speed in percent (100 = normal, 50 = half speed, 200 = double). */
  speed: number
  reverse: boolean
  interpolation: Interpolation
  [key: string]: unknown
}

export interface InputNodeData {
  sourceType: SourceType
  path: string | null
  /** Batch mode: the video files discovered in the chosen folder. */
  batchFiles?: string[] | null
  /** Sequence: chosen frame rate. Video: optional fps override (null = keep source). */
  fps: number | null
  /** Probed source info for a video, shown to the user (null = unknown / probing). */
  detectedFps: number | null
  detectedWidth: number | null
  detectedHeight: number | null
  detectedSize: number | null
  detectedDuration: number | null
  detectedHasAudio: boolean
  /** Source carries a transparency channel (alpha pixel format / RGBA PNG). */
  detectedHasAlpha?: boolean
  /** PNG-sequence frame count (null = unknown / not a sequence). */
  detectedFrames: number | null
  [key: string]: unknown
}

export interface LocationNodeData {
  dir: string | null
  [key: string]: unknown
}

export interface OutputNodeData {
  format: OutputFormat
  /** Video codec within the container (see FORMAT_CODECS for valid choices). */
  codec: VideoCodec
  quality: number
  sizeMode: SizeMode
  /** Desired output size in MB when sizeMode === 'target' (MP4 H.264/H.265 only). */
  targetMB: number | null
  /** Use macOS VideoToolbox hardware encoder (MP4 / MOV, H.264/H.265). */
  hardware: boolean
  /** ProRes profile (MOV): 0 Proxy … 3 HQ … 4 4444(alpha). */
  proresProfile: number
  /** MOV + H.265 only: emit Apple "HEVC with Alpha" (forces VideoToolbox). */
  hevcAlpha: boolean
  width: number | null
  /** Target height in px. null = auto (derive from width / keep aspect). */
  height?: number | null
  /** When true, width & height stay aspect-locked (Photoshop-style chain). */
  linkDims?: boolean
  /** Source dimensions from the connected Input, synced in for the "original" hint. */
  srcWidth?: number | null
  srcHeight?: number | null
  /** Source info synced from the connected Input, for the single-PNG frame preview. */
  srcKind?: 'video' | 'sequence' | null
  srcPath?: string | null
  srcFrames?: number | null
  srcFps?: number | null
  /** Active upstream Crop rect (source px), so the preview matches the cropped output. */
  srcCrop?: { x: number; y: number; width: number; height: number } | null
  /** Audio bitrate in kbps for formats that carry audio (default 192). */
  audioBitrate?: number
  /** Loop packaging (webp / pngseq); 'boomerang' plays forward then back. Default 'normal'. */
  loopMode?: LoopMode
  /** PNG format only: 'sequence' (all frames) or 'single' (one frame). Default 'sequence'. */
  pngMode?: PngMode
  /** PNG 'single' mode: 0-based index of the processed frame to export. Default 0. */
  pngFrame?: number
  outputPath: string | null
  /** Directory override from a connected Location node; null = use outputPath as a full path. */
  locationDir?: string | null
  /** True when a Location node is wired to the location handle (even before a folder is picked). */
  locationConnected?: boolean
  status: JobState
  percent: number
  message?: string
  /** Output file size in bytes once done (sum of frames for a PNG sequence). */
  outSize?: number | null
  /** Live pre-run validation problem for this Output (null = ready to run). */
  problem?: string | null
  [key: string]: unknown
}

export const FORMAT_EXT: Record<OutputFormat, string> = {
  webp: 'webp',
  mp4: 'mp4',
  mov: 'mov',
  webm: 'webm',
  pngseq: 'png',
  apng: 'png'
}

/** Renderer-side job payload sent over IPC to the main process. */
export interface JobSpec {
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
    height: number | null
    audioBitrate?: number
    loopMode?: string
    pngMode?: string
    pngFrame?: number
    outputPath: string
  }
  retime: { speed: number; reverse: boolean; interpolation: string } | null
  trim: { startSec: number; endSec: number | null; dropFirst: number; dropLast: number } | null
  crop: { x: number; y: number; width: number; height: number } | null
}
