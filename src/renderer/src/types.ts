export type SourceType = 'sequence' | 'video'
export type OutputFormat = 'webp' | 'mp4' | 'mov' | 'webm' | 'h265' | 'av1'

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

/** Formats that support the target-file-size (bitrate) workflow. */
export const SUPPORTS_TARGET: OutputFormat[] = ['mp4', 'h265']
/** Formats that can use the macOS VideoToolbox hardware encoder. */
export const SUPPORTS_HARDWARE: OutputFormat[] = ['mp4', 'h265']

/** ProRes profiles (MOV). 4444 keeps an alpha channel. */
export const PRORES_PROFILES: { value: number; label: string }[] = [
  { value: 0, label: 'Proxy' },
  { value: 1, label: 'LT' },
  { value: 2, label: 'Standard' },
  { value: 3, label: 'HQ' },
  { value: 4, label: '4444 (alpha)' }
]
export type JobState = 'idle' | 'running' | 'done' | 'error'
export type SizeMode = 'quality' | 'target'
export type Interpolation = 'sampling' | 'blend' | 'optical'

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

export interface OutputNodeData {
  format: OutputFormat
  quality: number
  sizeMode: SizeMode
  /** Desired output size in MB when sizeMode === 'target' (MP4 only). */
  targetMB: number | null
  /** Use macOS VideoToolbox hardware encoder (MP4 / H.265). */
  hardware: boolean
  /** ProRes profile (MOV): 0 Proxy … 3 HQ … 4 4444(alpha). */
  proresProfile: number
  width: number | null
  outputPath: string | null
  status: JobState
  percent: number
  message?: string
  [key: string]: unknown
}

/** Whether a given output format can carry an alpha (transparency) channel. */
export const FORMAT_SUPPORTS_ALPHA: Record<OutputFormat, boolean> = {
  webp: true,
  mov: true, // only with the ProRes 4444 profile
  webm: true, // VP9 yuva420p + auto-alt-ref 0 (alpha_mode=1, browser-decodable)
  mp4: false,
  h265: false,
  av1: false
}

export const FORMAT_EXT: Record<OutputFormat, string> = {
  webp: 'webp',
  mp4: 'mp4',
  mov: 'mov',
  webm: 'webm',
  h265: 'mp4',
  av1: 'mp4'
}
