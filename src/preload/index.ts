import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface MediaInfo {
  fps: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  durationSec: number | null
  hasAudio: boolean
}

export interface ThumbnailRequest {
  kind: 'video' | 'sequence'
  path: string
  timeSec?: number
  /** Sequence only: 0-based index of the PNG to preview (default 0). */
  frame?: number
  /** Optional crop rect (source px), applied before downscaling. */
  crop?: { x: number; y: number; width: number; height: number }
  maxWidth?: number
}

/** Result of inspecting a dropped path (folder of videos / PNG sequence / file). */
export type InspectResult =
  | { kind: 'batch'; videos: string[] }
  | { kind: 'sequence'; info: SequenceInfo }
  | { kind: 'video'; info: MediaInfo }
  | { kind: 'unknown' }

export interface SequenceInfo {
  frameCount: number
  width: number | null
  height: number | null
  totalBytes: number
}

export interface JobStatus {
  id: string
  status: 'running' | 'done' | 'error'
  percent: number
  message?: string
  /** Output file size in bytes, sent with the final 'done' status. */
  sizeBytes?: number | null
}

export interface JobLog {
  id: string
  line: string
}

const api = {
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  openFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultName),
  probeMedia: (file: string): Promise<MediaInfo> => ipcRenderer.invoke('media:probe', file),
  probeSequence: (folder: string): Promise<SequenceInfo> =>
    ipcRenderer.invoke('media:probeSequence', folder),
  listVideos: (folder: string): Promise<string[]> =>
    ipcRenderer.invoke('media:listVideos', folder),
  thumbnail: (req: ThumbnailRequest): Promise<string | null> =>
    ipcRenderer.invoke('media:thumbnail', req),
  /** Read a small file (e.g. a WebP result) as a data URL for direct <img> display. */
  readDataUrl: (p: string): Promise<string | null> => ipcRenderer.invoke('media:dataUrl', p),
  inspectPath: (p: string): Promise<InspectResult> => ipcRenderer.invoke('media:inspectPath', p),
  /** Resolve a dropped File to its absolute filesystem path (sandbox-safe). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  reveal: (p: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('shell:reveal', p),
  existing: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('fs:existing', paths),
  saveGraph: (data: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke('graph:save', data),
  loadGraph: (): Promise<string | null> => ipcRenderer.invoke('graph:load'),
  runJobs: (jobs: unknown[]): Promise<{ ok: boolean; cancelled?: boolean }> =>
    ipcRenderer.invoke('ffmpeg:runJobs', jobs),
  cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('ffmpeg:cancel'),

  onJobStatus: (cb: (s: JobStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: JobStatus): void => cb(s)
    ipcRenderer.on('job:status', listener)
    return () => ipcRenderer.removeListener('job:status', listener)
  },
  onJobLog: (cb: (l: JobLog) => void): (() => void) => {
    const listener = (_e: unknown, l: JobLog): void => cb(l)
    ipcRenderer.on('job:log', listener)
    return () => ipcRenderer.removeListener('job:log', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
