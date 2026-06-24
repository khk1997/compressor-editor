export type SourceType = 'sequence' | 'video'
/** Output container. The actual video codec is chosen separately (see VideoCodec). */
export type OutputFormat = 'webp' | 'mp4' | 'mov' | 'webm'
/** Video codec. Which ones are valid depends on the container (see FORMAT_CODECS). */
export type VideoCodec = 'h264' | 'h265' | 'av1' | 'prores'

export interface TrimNodeData {
  /** Start time in seconds. */
  startSec: number
  /** End time in seconds; null = to the end. */
  endSec: number | null
  [key: string]: unknown
}

export interface CropNodeData {
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
  webm: []
}

export type JobState = 'idle' | 'running' | 'done' | 'error'
export type SizeMode = 'quality' | 'target'
export type Interpolation = 'sampling' | 'blend' | 'optical'

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
  if (format === 'webp' || format === 'webm') return true
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
  /** Sequence: chosen frame rate. Video: optional fps override (null = keep source). */
  fps: number | null
  /** Probed source info for a video, shown to the user (null = unknown / probing). */
  detectedFps: number | null
  detectedWidth: number | null
  detectedHeight: number | null
  detectedSize: number | null
  detectedDuration: number | null
  detectedHasAudio: boolean
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
  outputPath: string | null
  /** Directory override from a connected Location node; null = use outputPath as a full path. */
  locationDir?: string | null
  /** True when a Location node is wired to the location handle (even before a folder is picked). */
  locationConnected?: boolean
  status: JobState
  percent: number
  message?: string
  [key: string]: unknown
}

export const FORMAT_EXT: Record<OutputFormat, string> = {
  webp: 'webp',
  mp4: 'mp4',
  mov: 'mov',
  webm: 'webm'
}
