import { Fragment, useLayoutEffect, useRef, useState } from 'react'

interface ToolbarProps {
  cutMode: boolean
  onToggleCut: () => void
  canConnectToOutputs: boolean
  onConnectToOutputs: () => void
  connectLabel: string
  connectTitle: string
  running: boolean
  onRun: () => void
  onStop: () => void
  onAddInput: () => void
  onAddRetime: () => void
  onAddTrim: () => void
  onAddCrop: () => void
  onAddOutput: () => void
  onAddLocation: () => void
  onSave: () => void
  onOpen: () => void
}

interface Item {
  key: string
  type: 'btn' | 'sep'
  render: () => JSX.Element
}

/**
 * Toolbar with After-Effects-style overflow: buttons keep their natural size,
 * and any that don't fit the window width collapse into a "»" dropdown instead
 * of shrinking or wrapping. Widths are measured off-screen so the visible row
 * never flickers.
 */
export function Toolbar(props: ToolbarProps): JSX.Element {
  const items: Item[] = [
    { key: 'input', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddInput}>+ Input</button>
    ) },
    { key: 'retime', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddRetime}>+ Retime</button>
    ) },
    { key: 'trim', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddTrim}>+ Trim</button>
    ) },
    { key: 'crop', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddCrop}>+ Crop</button>
    ) },
    { key: 'output', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddOutput}>+ Output</button>
    ) },
    { key: 'location', type: 'btn', render: () => (
      <button className="btn" onClick={props.onAddLocation}>+ Location</button>
    ) },
    { key: 'sep1', type: 'sep', render: () => <span className="sep" /> },
    { key: 'cut', type: 'btn', render: () => (
      <button
        className={`btn${props.cutMode ? ' btn-active' : ''}`}
        onClick={props.onToggleCut}
        title="剪刀:開啟後拖曳即可切斷連線(亦可隨時按住 Ctrl/⌘ 拖曳)"
      >
        ✂ 剪刀
      </button>
    ) },
    { key: 'connect', type: 'btn', render: () => (
      <button
        className="btn"
        onClick={props.onConnectToOutputs}
        disabled={!props.canConnectToOutputs}
        title={props.connectTitle}
      >
        {props.connectLabel}
      </button>
    ) },
    { key: 'sep2', type: 'sep', render: () => <span className="sep" /> },
    { key: 'save', type: 'btn', render: () => (
      <button className="btn" onClick={props.onSave}>Save</button>
    ) },
    { key: 'open', type: 'btn', render: () => (
      <button className="btn" onClick={props.onOpen}>Open</button>
    ) }
  ]

  const headerRef = useRef<HTMLElement>(null)
  const brandRef = useRef<HTMLElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(items.length)
  const [menuOpen, setMenuOpen] = useState(false)

  useLayoutEffect(() => {
    const header = headerRef.current
    const measure = measureRef.current
    if (!header || !measure) return

    const recompute = (): void => {
      const gap = 8 // matches .toolbar { gap: 8px }
      const moreW = 44 // reserve for the "»" button + its gap
      const cs = getComputedStyle(header)
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0
      const brandW = brandRef.current?.offsetWidth ?? 0
      const rightW = rightRef.current?.offsetWidth ?? 0
      const widths = Array.from(measure.children).map(
        (c) => (c as HTMLElement).getBoundingClientRect().width
      )
      // Room left for the middle item group after brand, the Run button, and gaps.
      const avail = header.clientWidth - padL - padR - brandW - rightW - gap * 2
      const totalAll = widths.reduce((a, w) => a + w + gap, 0)
      let count: number
      if (totalAll <= avail) {
        count = items.length
      } else {
        let used = moreW
        count = 0
        for (let i = 0; i < widths.length; i++) {
          if (used + widths[i] + gap <= avail) {
            used += widths[i] + gap
            count++
          } else break
        }
      }
      setVisibleCount(count)
    }

    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(header)
    return () => ro.disconnect()
    // Re-measure when a label's width can change (cut mode bolds, Run↔Stop,
    // the connect button's label switches with the selected node).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cutMode, props.running, props.connectLabel])

  const overflow = items.slice(visibleCount)

  return (
    <header className="toolbar" ref={headerRef}>
      <strong className="brand" ref={brandRef}>⬡ Compressor</strong>

      {items.slice(0, visibleCount).map((it) => (
        <Fragment key={it.key}>{it.render()}</Fragment>
      ))}

      {overflow.length > 0 && (
        <div className="toolbar-more">
          <button className="btn" onClick={() => setMenuOpen((o) => !o)} title="更多功能">
            »
          </button>
          {menuOpen && (
            <>
              <div className="toolbar-more-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="toolbar-more-menu">
                {overflow.map((it) =>
                  it.type === 'sep' ? (
                    <div key={it.key} className="toolbar-more-divider" />
                  ) : (
                    <div
                      key={it.key}
                      className="toolbar-more-item"
                      onClick={() => setMenuOpen(false)}
                    >
                      {it.render()}
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </div>
      )}

      <div className="spacer" />

      <div className="toolbar-right" ref={rightRef}>
        {props.running ? (
          <button className="btn btn-stop" onClick={props.onStop}>
            ■ Stop
          </button>
        ) : (
          <button className="btn btn-run" onClick={props.onRun}>
            ▶ Run
          </button>
        )}
      </div>

      {/* Off-screen row used only to measure each item's natural width. */}
      <div className="toolbar-measure" aria-hidden ref={measureRef}>
        {items.map((it) => (
          <Fragment key={it.key}>{it.render()}</Fragment>
        ))}
      </div>
    </header>
  )
}
