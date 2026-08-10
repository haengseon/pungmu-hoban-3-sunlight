// Does a shadow that hits a building climb its wall, and does it stop at the
// right height?
//
// Two synthetic boxes go into the live scene with the sun due south, so the
// shadow runs north onto the receiver's south wall. Then we shoot a ray from
// each sample point on that wall towards the sun: if it meets the occluder the
// point is shadowed, and the height where that stops is the shadow's top edge.
// A roof at height h, a gap L and a solar altitude a put it at h - L*tan(a).
//
// The ray direction is taken from the renderer's own DirectionalLight, so a
// wrong sun vector, a wrong axis convention or wrong scene units all fail here.
//
// The occluder is kept shorter than the gap so its own silhouette cannot reach
// the wall being measured.
import { chromium } from 'playwright'

const URL = process.env.APP_URL || 'http://127.0.0.1:5173/'
const WALLS = [
  { alt: 30, hA: 35, gap: 40 },
  { alt: 20, hA: 30, gap: 32 },
  { alt: 15, hA: 25, gap: 45 },
  { alt: 35, hA: 40, gap: 45 },
]
// The occluder's roof edge is (hA - hB)/tan(a) beyond its own north face on the
// z = hB plane, so the shadow reaches that far minus the gap onto the roof.
const ROOFS = [
  { alt: 30, hA: 60, hB: 20, gap: 20 },
  { alt: 40, hA: 70, hB: 25, gap: 15 },
  { alt: 25, hA: 50, hB: 15, gap: 30 },
]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 800, height: 800 } })
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })

const out = await page.evaluate(async ([walls, roofs]) => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const L = window.__layer
  for (const v of L.volumes) v.mesh.visible = false // measure only our boxes

  // scene axes are local metres: x east, y north, z up
  const box = (x0, x1, y0, y1, h) => {
    const shape = new THREE.Shape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
      .map(([x, y]) => new THREE.Vector2(x, y)))
    const mesh = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }),
    )
    L.scene.add(mesh)
    return mesh
  }
  const ray = new THREE.Raycaster()
  const sunDir = () =>
    L.light.position.clone().sub(L.light.target.position).normalize()
  /** is the point at (x, y, z) shaded by `blockers`? */
  const shaded = (blockers, x, y, z) => {
    ray.set(new THREE.Vector3(x, y, z), sunDir())
    return ray.intersectObjects(blockers, false).length > 0
  }
  /** first value in [lo, hi) where `hit` stops being true, to 0.05 m */
  const edge = (hit, lo, hi) => {
    if (!hit(lo)) return null
    while (hi - lo > 0.05) {
      const mid = (lo + hi) / 2
      if (hit(mid)) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  const wallOut = []
  for (const c of walls) {
    const occ = box(-20, 20, -c.gap - c.hA, -c.gap, c.hA)
    const rec = box(-20, 20, 0, 40, 60)
    L.setSun({ altitude: c.alt, azimuth: 180 })
    // sample just outside the wall so the receiver never blocks its own ray
    wallOut.push({ ...c, measured: edge((z) => shaded([occ], 0, -0.01, z), 0.2, 55) })
    L.scene.remove(occ, rec)
  }

  const roofOut = []
  for (const c of roofs) {
    const occ = box(-40, 40, -c.gap - 40, -c.gap, c.hA)
    const rec = box(-40, 40, 0, 90, c.hB)
    L.setSun({ altitude: c.alt, azimuth: 180 })
    // walk north along the low roof; the shadow ends where the rays clear
    roofOut.push({
      ...c,
      measured: edge((y) => shaded([occ], 0, y, c.hB + 0.01), 0.2, 88),
      expect: (c.hA - c.hB) / Math.tan((c.alt * Math.PI) / 180) - c.gap,
    })
    L.scene.remove(occ, rec)
  }

  for (const v of L.volumes) v.mesh.visible = true
  return { wallOut, roofOut }
}, [WALLS, ROOFS])

let bad = 0
const report = (r, expect, tol, line) => {
  const ok = r.measured !== null && Math.abs(r.measured - expect) <= tol
  if (!ok) bad++
  console.log(`${line} ${r.measured === null ? '없음' : r.measured.toFixed(1) + 'm'} `
    + `(이론 ${expect.toFixed(1)}m) ${ok ? 'OK' : 'FAIL'}`)
}
for (const r of out.wallOut) {
  report(r, r.hA - r.gap * Math.tan((r.alt * Math.PI) / 180), 0.2,
    `고도 ${String(r.alt).padStart(2)}° · 차폐동 ${r.hA}m · 이격 ${r.gap}m  → 벽면 그림자 상단`)
}
for (const r of out.roofOut) {
  report(r, r.expect, 0.2,
    `고도 ${String(r.alt).padStart(2)}° · 차폐동 ${r.hA}m · 저층동 ${r.hB}m · 이격 ${r.gap}m  → 옥상 그림자 끝`)
}
console.log(bad ? `${bad}건 실패` : '그림자 검증 통과 (벽면·옥상)')
await browser.close()
process.exit(bad ? 1 : 0)
