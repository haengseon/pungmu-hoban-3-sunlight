// Capture the Kakao basemap's own building footprints for the four complexes.
//
// Kakao renders real 건축물 polygons for every one of them, so tracing those and
// re-projecting to WGS84 gives footprints that sit exactly under the 3D masses
// the app draws - no georeferencing chain to drift.
//
// Writes tools/out/kakao_trace.png + kakao_trace.json (the px -> mercator affine).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tools', 'out')
const URL = process.env.APP_URL || 'http://localhost:5173/'
// Level 1 (~4 px/m) rather than 2: Kakao's 동 번호/면적 labels are a fixed pixel
// size, so zooming in halves the share of each building they cover up - which is
// what breaks the trace into fragments.
const LEVEL = Number(process.env.LEVEL || 1)
// tall enough to hold all four lots at that scale (~750 x 1050 m)
const W = Number(process.env.W || 3120)
const H = Number(process.env.H || 4320)
const CENTRE = { lat: 37.61565, lng: 126.73345 }

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
})
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__map && window.__layer, null, { timeout: 30000 })

// let the map fill the whole viewport and hide our own drawing
const centre = await page.evaluate(
  ([level, lat, lng]) => {
    const wrap = document.querySelector('.wrap')
    wrap.style.maxWidth = 'none'
    wrap.style.padding = '0'
    document.querySelector('.time').style.display = 'none'
    document.querySelector('.seasons').style.display = 'none'
    document.querySelector('header').style.display = 'none'
    const box = document.querySelector('.mapbox')
    box.style.borderRadius = '0'
    window.__layer.canvas.style.display = 'none'
    window.__map.relayout()
    window.__map.setLevel(level)
    window.__map.setCenter(new window.kakao.maps.LatLng(lat, lng))
    const c = window.__map.getCenter()
    return { lat: c.getLat(), lng: c.getLng() }
  },
  [LEVEL, CENTRE.lat, CENTRE.lng],
)
await page.waitForTimeout(9000)

const meta = await page.evaluate(() => {
  const L = window.__layer
  const t = L.transform()
  const r = L.host.getBoundingClientRect()
  return {
    ox: t.ox, oy: t.oy, sx: t.sx, sy: t.sy,
    pxPerMetre: t.pxPerMetre,
    mA: L.mA,
    host: { left: r.left, top: r.top, width: r.width, height: r.height },
    level: window.__map.getLevel(),
  }
})
console.log('centre', centre, 'ppm', meta.pxPerMetre.toFixed(3), 'level', meta.level)

await page.screenshot({
  path: join(OUT, 'kakao_trace.png'),
  clip: {
    x: Math.round(meta.host.left),
    y: Math.round(meta.host.top),
    width: Math.round(meta.host.width),
    height: Math.round(meta.host.height),
  },
})
// the clip origin becomes the image origin, so fold it into the affine
meta.ox -= Math.round(meta.host.left)
meta.oy -= Math.round(meta.host.top)
writeFileSync(join(OUT, 'kakao_trace.json'), JSON.stringify(meta, null, 1))
console.log('wrote', join(OUT, 'kakao_trace.png'))
await browser.close()
