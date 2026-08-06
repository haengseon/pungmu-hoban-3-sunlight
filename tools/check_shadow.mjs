// Does a shadow that hits a building actually climb its wall, and does it stop
// at the right height?
//
// Two synthetic boxes go into the live renderer with the sun due south, so the
// shadow runs north onto the receiver's south wall - the one face that is both
// lit and facing the viewer. The wall is then read straight off the canvas: a
// roof at height h, a gap L and a solar altitude a put the shadow's top edge at
// h - L*tan(a), and anything else is a bug in the projection.
//
// The occluder is kept shorter than the gap so its own silhouette cannot reach
// the wall being measured.
import { chromium } from 'playwright'

const URL = process.env.APP_URL || 'http://localhost:5173/'
const CASES = [
  { alt: 30, hA: 35, gap: 40 },
  { alt: 20, hA: 30, gap: 32 },
  { alt: 15, hA: 25, gap: 45 },
  { alt: 35, hA: 40, gap: 45 },
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2000)

const results = await page.evaluate((cases) => {
  const L = window.__layer
  window.__map.setLevel(3)
  const perM = 1 / Math.cos(L.lat0 * Math.PI / 180)
  const box = (x0, x1, y0, y1, h) => ({
    id: 0, n: 4, keep: [0, 1, 2, 3], kn: 4, cells: [], h,
    floors: Math.round(h / 2.9), dong: null, complexId: 't',
    mx: [x0, x1, x1, x0].map((v) => L.mA.x + v * perM),
    my: [y0, y0, y1, y1].map((v) => L.mA.y + v * perM),
  })
  const out = []
  for (const c of cases) {
    // receiver's south face sits on y = 0; the occluder is `gap` further south
    L.items = [
      box(-20, 20, -c.gap - c.hA, -c.gap, c.hA),
      box(-20, 20, 0, 40, 60),
    ]
    L.setSun({ altitude: c.alt, azimuth: 180 })
    L.FLOOR_H = 1e6 // storey lines would show up as false transitions
    const t = L.transform()
    L.draw(t)

    const lift = L.VSCALE * t.pxPerMetre
    const lx = L.LEAN * lift
    const ly = -lift
    const at = (z) => {
      const px = Math.round((t.ox + z * lx) * L.dpr)
      const py = Math.round((t.oy + z * ly) * L.dpr)
      return L.ctx.getImageData(px, py, 1, 1).data[0]
    }
    // read the wall's own two tones rather than hard-coding a threshold, so a
    // change to the palette cannot quietly turn this check into a no-op
    const mid = (at(0.6) + at(c.hA + 12)) / 2
    const lit = (z) => at(z) > mid
    let top = null
    for (let z = 0.5; z < 55; z += 0.1) {
      if (lit(z) && lit(z + 1.5) && lit(z + 3)) {
        top = z
        break
      }
    }
    out.push({ ...c, measured: top, expect: c.hA - c.gap * Math.tan(c.alt * Math.PI / 180) })
  }
  return out
}, CASES)

// ---- and the same thing landing on a lower neighbour's roof ---------------
// The occluder's roof edge is (hA - hB)/tan(a) beyond its own north face on the
// z = hB plane, so the shadow reaches that far minus the gap onto the roof.
const ROOFS = [
  { alt: 30, hA: 60, hB: 20, gap: 20 },
  { alt: 40, hA: 70, hB: 25, gap: 15 },
  { alt: 25, hA: 50, hB: 15, gap: 30 },
]

const roofs = await page.evaluate((cases) => {
  const L = window.__layer
  window.__map.setLevel(3)
  const perM = 1 / Math.cos(L.lat0 * Math.PI / 180)
  const box = (x0, x1, y0, y1, h) => ({
    id: 0, n: 4, keep: [0, 1, 2, 3], kn: 4, cells: [], h,
    floors: Math.round(h / 2.9), dong: null, complexId: 't',
    mx: [x0, x1, x1, x0].map((v) => L.mA.x + v * perM),
    my: [y0, y0, y1, y1].map((v) => L.mA.y + v * perM),
  })
  const out = []
  for (const c of cases) {
    L.items = [
      box(-40, 40, -c.gap - 40, -c.gap, c.hA),
      box(-40, 40, 0, 90, c.hB),
    ]
    L.setSun({ altitude: c.alt, azimuth: 180 })
    const t = L.transform()
    L.draw(t)
    const lift = L.VSCALE * t.pxPerMetre
    const at = (y) => {
      const px = Math.round((t.ox + c.hB * L.LEAN * lift) * L.dpr)
      const py = Math.round((t.oy + y * perM * t.sy - c.hB * lift) * L.dpr)
      return L.ctx.getImageData(px, py, 1, 1).data[0]
    }
    // the occluder's own silhouette hides the near end of the roof; start past it
    const hidden = (c.hA - c.hB) * L.VSCALE - c.gap + 4
    const mid = (at(hidden) + at(86)) / 2
    const lit = (y) => at(y) > mid
    let edge = null
    for (let y = hidden; y < 88; y += 0.2) {
      if (lit(y) && lit(y + 2) && lit(y + 4)) {
        edge = y
        break
      }
    }
    out.push({
      ...c, measured: edge,
      expect: (c.hA - c.hB) / Math.tan(c.alt * Math.PI / 180) - c.gap,
    })
  }
  return out
}, ROOFS)

let bad = 0
for (const r of results) {
  const ok = r.measured !== null && Math.abs(r.measured - r.expect) <= 1.2
  if (!ok) bad++
  console.log(
    `고도 ${String(r.alt).padStart(2)}° · 차폐동 ${r.hA}m · 이격 ${r.gap}m  ` +
    `→ 벽면 그림자 상단 ${r.measured === null ? '없음' : r.measured.toFixed(1) + 'm'} ` +
    `(이론 ${r.expect.toFixed(1)}m) ${ok ? 'OK' : 'FAIL'}`,
  )
}
for (const r of roofs) {
  const ok = r.measured !== null && Math.abs(r.measured - r.expect) <= 1.5
  if (!ok) bad++
  console.log(
    `고도 ${String(r.alt).padStart(2)}° · 차폐동 ${r.hA}m · 저층동 ${r.hB}m · 이격 ${r.gap}m  ` +
    `→ 옥상 그림자 끝 ${r.measured === null ? '없음' : r.measured.toFixed(1) + 'm'} ` +
    `(이론 ${r.expect.toFixed(1)}m) ${ok ? 'OK' : 'FAIL'}`,
  )
}
console.log(bad ? `${bad}건 실패` : '그림자 검증 통과 (벽면·옥상)')
await browser.close()
process.exit(bad ? 1 : 0)
