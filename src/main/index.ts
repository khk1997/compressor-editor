import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'path'
import {
  runJob,
  probeMedia,
  probeSequence,
  thumbnail,
  listVideosInFolder,
  type Job,
  type ThumbnailRequest
} from './ffmpeg'

/** Tracks the in-flight batch so it can be cancelled. */
let activeRun: { kill: () => void; cancelled: boolean } | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1b1f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // --- File / folder pickers ---
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'm4v', 'mkv', 'webm', 'avi'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog({ defaultPath: defaultName })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('media:probe', (_e, file: string) => probeMedia(file))
  ipcMain.handle('media:probeSequence', (_e, folder: string) => probeSequence(folder))
  ipcMain.handle('media:listVideos', (_e, folder: string) => listVideosInFolder(folder))
  ipcMain.handle('media:thumbnail', (_e, req: ThumbnailRequest) => thumbnail(req))

  // Identify a dropped path: folder of videos (batch), PNG sequence, or a video file.
  ipcMain.handle('media:inspectPath', async (_e, p: string) => {
    try {
      if (statSync(p).isDirectory()) {
        const videos = listVideosInFolder(p)
        if (videos.length) return { kind: 'batch' as const, videos }
        return { kind: 'sequence' as const, info: await probeSequence(p) }
      }
    } catch {
      return { kind: 'unknown' as const }
    }
    return { kind: 'video' as const, info: await probeMedia(p) }
  })

  // --- Reveal a finished file in Finder / Explorer ---
  ipcMain.handle('shell:reveal', (_e, p: string) => {
    shell.showItemInFolder(p)
    return { ok: true }
  })

  // --- Which of these output paths already exist? ---
  ipcMain.handle('fs:existing', (_e, paths: string[]) => paths.filter((p) => existsSync(p)))

  // --- Save / load the node graph as JSON ---
  ipcMain.handle('graph:save', async (_e, data: string) => {
    const r = await dialog.showSaveDialog({
      defaultPath: 'graph.compressor.json',
      filters: [{ name: 'Compressor graph', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false }
    await writeFile(r.filePath, data, 'utf8')
    return { ok: true, path: r.filePath }
  })

  ipcMain.handle('graph:load', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Compressor graph', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return readFile(r.filePaths[0], 'utf8')
  })

  // --- Cancel the running batch ---
  ipcMain.handle('ffmpeg:cancel', () => {
    if (activeRun) {
      activeRun.cancelled = true
      activeRun.kill()
    }
    return { ok: true }
  })

  // --- Run a batch of jobs sequentially, streaming progress per job id ---
  ipcMain.handle('ffmpeg:runJobs', async (e, jobs: Job[]) => {
    const send = (channel: string, payload: unknown): void => {
      if (!e.sender.isDestroyed()) e.sender.send(channel, payload)
    }
    const run = { kill: () => {}, cancelled: false }
    activeRun = run

    for (const job of jobs) {
      if (run.cancelled) {
        send('job:status', { id: job.id, status: 'idle', percent: 0 })
        continue
      }
      send('job:status', { id: job.id, status: 'running', percent: 0 })
      try {
        const { promise, kill } = runJob(job, {
          onProgress: (p) => send('job:status', { id: job.id, status: 'running', percent: p }),
          onLog: (line) => send('job:log', { id: job.id, line })
        })
        run.kill = kill
        await promise
        send('job:status', { id: job.id, status: 'done', percent: 1 })
      } catch (err) {
        if (run.cancelled) {
          send('job:status', { id: job.id, status: 'idle', percent: 0 })
        } else {
          send('job:status', {
            id: job.id,
            status: 'error',
            percent: 0,
            message: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }
    activeRun = null
    return { ok: true, cancelled: run.cancelled }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
