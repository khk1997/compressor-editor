export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

const ccw = (a: Pt, b: Pt, c: Pt): boolean =>
  (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x)

export const segCross = (p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean =>
  ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4)

/** Does segment a→b touch the rectangle (endpoint inside or any side crossed)? */
export const segIntersectsRect = (a: Pt, b: Pt, r: Rect): boolean => {
  const inside = (p: Pt): boolean =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  if (inside(a) || inside(b)) return true
  const tl = { x: r.x, y: r.y }
  const tr = { x: r.x + r.w, y: r.y }
  const br = { x: r.x + r.w, y: r.y + r.h }
  const bl = { x: r.x, y: r.y + r.h }
  return (
    segCross(a, b, tl, tr) ||
    segCross(a, b, tr, br) ||
    segCross(a, b, br, bl) ||
    segCross(a, b, bl, tl)
  )
}
