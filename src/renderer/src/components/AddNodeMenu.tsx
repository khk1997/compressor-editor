import { useEffect, useMemo, useRef, useState } from 'react'

/** Node types offered by the Blender-style "Add" menu (Shift+A / right-click). */
export const ADD_NODE_ITEMS: { type: string; label: string; hint: string }[] = [
  { type: 'input-node', label: 'Input', hint: '來源影片 / 序列' },
  { type: 'retime-node', label: 'Retime', hint: '變速 / 反轉' },
  { type: 'trim-node', label: 'Trim', hint: '裁切時間' },
  { type: 'crop-node', label: 'Crop', hint: '裁切畫面' },
  { type: 'output-node', label: 'Output', hint: '輸出設定' },
  { type: 'location-node', label: 'Location', hint: '輸出位置' }
]

/**
 * Blender-style "Add" (Shift+A) menu: a floating list at the cursor with a
 * search box, keyboard navigation (↑/↓/Enter/Esc) and click-to-add. Picking an
 * item spawns the corresponding node at the cursor position.
 */
export function AddNodeMenu({
  x,
  y,
  canGroup = false,
  canUngroup = false,
  onGroup,
  onUngroup,
  onPick,
  onClose
}: {
  x: number
  y: number
  canGroup?: boolean
  canUngroup?: boolean
  onGroup?: () => void
  onUngroup?: () => void
  onPick: (type: string) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ADD_NODE_ITEMS
    return ADD_NODE_ITEMS.filter(
      (it) => it.label.toLowerCase().includes(q) || it.hint.includes(q)
    )
  }, [query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the highlighted index in range as the filtered list shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[active]
      if (it) onPick(it.type)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <>
      <div className="addmenu-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div className="addmenu" style={{ left: x, top: y }}>
        {(canGroup || canUngroup) && (
          <>
            <div className="addmenu-head">Selection</div>
            {canGroup && (
              <button className="addmenu-item" onClick={() => onGroup?.()}>
                <span className="addmenu-item-label">Group</span>
                <span className="addmenu-item-hint">Shift+P</span>
              </button>
            )}
            {canUngroup && (
              <button className="addmenu-item" onClick={() => onUngroup?.()}>
                <span className="addmenu-item-label">Ungroup</span>
                <span className="addmenu-item-hint">Alt+P</span>
              </button>
            )}
            <div className="addmenu-divider" />
          </>
        )}
        <div className="addmenu-head">Add</div>
        <input
          ref={inputRef}
          className="addmenu-search"
          placeholder="搜尋節點…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="addmenu-list">
          {filtered.length === 0 ? (
            <div className="addmenu-empty">找不到節點</div>
          ) : (
            filtered.map((it, i) => (
              <button
                key={it.type}
                className={`addmenu-item${i === active ? ' addmenu-item-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(it.type)}
              >
                <span className="addmenu-item-label">{it.label}</span>
                <span className="addmenu-item-hint">{it.hint}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  )
}
