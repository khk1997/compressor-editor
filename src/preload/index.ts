import { contextBridge, ipcRenderer } from 'electron'

export interface MediaInfo {
  fps: number | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  durationSec: number | null
  hasAudio: boolean
}

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
