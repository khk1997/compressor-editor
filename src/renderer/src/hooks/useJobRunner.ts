import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { type JobState } from '../types'

type UpdateNodeData = ReturnType<typeof useReactFlow>['updateNodeData']

/** Subscribes to IPC job status/log events and aggregates batch progress. */
export function useJobRunner(updateNodeData: UpdateNodeData): {
  logs: string[]
  setLogs: React.Dispatch<React.SetStateAction<string[]>>
  running: boolean
  setRunning: React.Dispatch<React.SetStateAction<boolean>>
  batchTotals: React.MutableRefObject<Map<string, number>>
  batchParts: React.MutableRefObject<Map<string, { percent: number; status: string; message?: string }[]>>
} {
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const batchTotals = useRef<Map<string, number>>(new Map())
  const batchParts = useRef<Map<string, { percent: number; status: string; message?: string }[]>>(
    new Map()
  )

  useEffect(() => {
    const offStatus = window.api.onJobStatus((s) => {
      const sep = s.id.indexOf('::')
      if (sep < 0) {
        updateNodeData(s.id, { status: s.status, percent: s.percent, message: s.message })
        if (s.status === 'error' && s.message) {
          setLogs((l) => [...l, `[${s.id}] ERROR: ${s.message}`])
        }
        return
      }
      const base = s.id.slice(0, sep)
      const idx = Number(s.id.slice(sep + 2))
      const parts = batchParts.current.get(base) ?? []
      parts[idx] = { percent: s.percent, status: s.status, message: s.message }
      batchParts.current.set(base, parts)
      const total = batchTotals.current.get(base) ?? parts.filter(Boolean).length
      const present = parts.filter(Boolean)
      const done = present.filter((p) => p.status === 'done').length
      const errs = present.filter((p) => p.status === 'error')
      const anyRunning = present.some((p) => p.status === 'running')
      const percent =
        present.reduce(
          (a, p) => a + (p.status === 'done' ? 1 : p.status === 'running' ? p.percent : 0),
          0
        ) / Math.max(total, 1)
      let status: JobState = 'running'
      let message: string | undefined = `${done}/${total} done`
      if (present.length >= total && !anyRunning) {
        if (errs.length) {
          status = 'error'
          message = `${errs.length}/${total} failed. First: ${errs[0].message ?? 'error'}`
        } else if (done >= total) {
          status = 'done'
        } else {
          status = 'idle'
        }
      }
      updateNodeData(base, { status, percent, message })
      if (s.status === 'error' && s.message) {
        setLogs((l) => [...l, `[${s.id}] ERROR: ${s.message}`])
      }
    })

    const offLog = window.api.onJobLog((l) => {
      setLogs((prev) => [...prev.slice(-400), `[${l.id}] ${l.line}`])
    })

    return () => {
      offStatus()
      offLog()
    }
  }, [updateNodeData])

  return { logs, setLogs, running, setRunning, batchTotals, batchParts }
}
