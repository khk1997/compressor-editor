import { useEffect, useState } from 'react'

export interface ThumbReq {
  kind: 'video' | 'sequence'
  path: string
  timeSec?: number
  /** Sequence only: 0-based index of the PNG to preview (default 0). */
  frame?: number
  /** Optional crop rect (source px), applied before downscaling. */
  crop?: { x: number; y: number; width: number; height: number }
  /** Cache-buster: change it (e.g. to the output size) to re-fetch after a file is rewritten. */
  bust?: string | number
  maxWidth?: number
}

export interface ThumbState {
  /** The data URL once decoded, else null. */
  url: string | null
  /** True while a request is in flight (distinguishes "loading" from "failed/none"). */
  loading: boolean
}

// Module-level cache so re-selecting a node or re-rendering doesn't re-decode.
// Stores the resolved url, or null when extraction failed (so we don't retry forever).
const cache = new Map<string, string | null>()
const keyOf = (r: ThumbReq): string => {
  const c = r.crop ? `${r.crop.x},${r.crop.y},${r.crop.width},${r.crop.height}` : ''
  return `${r.kind}|${r.path}|${r.timeSec ?? 0}|${r.frame ?? 0}|${c}|${r.bust ?? ''}|${r.maxWidth ?? 0}`
}

/**
 * Fetch a preview frame (base64 PNG data URL) for a source, cached by request.
 * Returns { url, loading }: url is null while loading or if extraction failed;
 * loading distinguishes the two so the UI never hangs on a "decoding…" state.
 * Pass null to clear.
 */
export function useThumbnail(req: ThumbReq | null): ThumbState {
  const key = req ? keyOf(req) : null
  const [state, setState] = useState<ThumbState>(() =>
    key && cache.has(key)
      ? { url: cache.get(key) ?? null, loading: false }
      : { url: null, loading: !!key }
  )

  useEffect(() => {
    if (!req || !key) {
      setState({ url: null, loading: false })
      return
    }
    if (cache.has(key)) {
      setState({ url: cache.get(key) ?? null, loading: false })
      return
    }
    let cancelled = false
    setState({ url: null, loading: true })
    window.api
      .thumbnail(req)
      .then((data) => {
        cache.set(key, data)
        if (!cancelled) setState({ url: data, loading: false })
      })
      .catch(() => {
        // e.g. IPC handler missing (stale main process) or ffmpeg failure.
        cache.set(key, null)
        if (!cancelled) setState({ url: null, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return state
}
