import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { segCross, type Pt } from '../utils/geometry'

/**
 * Blender-style knife: hold Ctrl/⌘ and drag across links to sever them.
 * Renders the cut stroke as an overlay and removes any edge it crosses.
 */
export function Knife({ wrapperRef }: { wrapperRef: React.RefObject<HTMLDivElement> }): JSX.Element {
  const rf = useReactFlow()
  const [stroke, setStroke] = useState<Pt[]>([])
  const ptsRef = useRef<Pt[]>([])
  const cutting = useRef(false)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    const rel = (e: PointerEvent): Pt => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    const cutEdges = (pts: Pt[]): void => {
      if (pts.length < 2) return
      const r = el.getBoundingClientRect()
      const byId = new Map(rf.getNodes().map((n) => [n.id, n]))
      const remove = new Set<string>()
      for (const edge of rf.getEdges()) {
        const s = byId.get(edge.source)
        const t = byId.get(edge.target)
        if (!s || !t) continue
        const sw = s.measured?.width ?? 220
        const sh = s.measured?.height ?? 120
        const th = t.measured?.height ?? 120
        const a = rf.flowToScreenPosition({ x: s.position.x + sw, y: s.position.y + sh / 2 })
        const b = rf.flowToScreenPosition({ x: t.position.x, y: t.position.y + th / 2 })
        const A = { x: a.x - r.left, y: a.y - r.top }
        const B = { x: b.x - r.left, y: b.y - r.top }
        for (let i = 1; i < pts.length; i++) {
          if (segCross(pts[i - 1], pts[i], A, B)) {
            remove.add(edge.id)
            break
          }
        }
      }
      if (remove.size) rf.setEdges((es) => es.filter((e) => !remove.has(e.id)))
    }

    const down = (e: PointerEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      cutting.current = true
      ptsRef.current = [rel(e)]
      setStroke([...ptsRef.current])
    }
    const move = (e: PointerEvent): void => {
      if (!cutting.current) return
      ptsRef.current.push(rel(e))
      setStroke([...ptsRef.current])
    }
    const up = (): void => {
      if (!cutting.current) return
      cutting.current = false
      cutEdges(ptsRef.current)
      ptsRef.current = []
      setStroke([])
    }

    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [rf, wrapperRef])

  if (stroke.length < 2) return <></>
  return (
    <svg className="knife-overlay">
      <polyline points={stroke.map((p) => `${p.x},${p.y}`).join(' ')} />
    </svg>
  )
}
