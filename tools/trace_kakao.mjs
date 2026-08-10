// Capture the Kakao basemap's own building footprints for the four complexes.
//
// Kakao renders real 건축물 polygons for every one of them, so tracing those and
// re-projecting to WGS84 gives footprints that sit exactly under the 3D masses
// the app draws - no georeferencing chain to drift.
//
// Writes tools/out/kakao_trace.png + kakao_trace.json (the px -> mercator affine).
//
// The app itself renders on MapLibre now, so this drives web/trace.html - a bare
// Kakao map served by the same vite dev server.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tools', 'out')
// localhost, not 127.0.0.1: 카카오 JS 키에 등록된 도메인이 그쪽이다
const URL = process.env.TRACE_URL || 'http://localhost:5173/trace.html'
const ORIGIN = { lat: 37.6156246, lon: 126.734508 } // buildings.json 의 origin
// Level 1 (~4 px/m) rather than 2: Kakao's 동 번호/면적 labels are a fixed pixel
// size, so zooming in halves the share of each building they cover up - which is
// what breaks the trace into fragments.
const LEVEL = Number(process.env.LEVEL || 1)
// tall enough to hold all four lots at that scale (~750 x 1050 m)
const W = Number(process.env.W || 3120)
const H = Number(process.env.H || 4320)
const CENTRE = process.env.CENTRE
  ? { lat: Number(process.env.CENTRE.split(',')[0]), lng: Number(process.env.CENTRE.split(',')[1]) }
  : { lat: 37.61565, lng: 126.73345 }
// 산출물 이름. 주변 단지용 광역 캡처처럼 여러 벌을 남겨야 할 때 갈아 끼운다.
const NAME = process.env.NAME || 'kakao_trace'

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
})
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__transform, null, { timeout: 30000 })

const centre = await page.evaluate(
  ([level, lat, lng]) => {
    window.__map.setLevel(level)
    window.__map.setCenter(new window.kakao.maps.LatLng(lat, lng))
    const c = window.__map.getCenter()
    return { lat: c.getLat(), lng: c.getLng() }
  },
  [LEVEL, CENTRE.lat, CENTRE.lng],
)
await page.waitForTimeout(9000)

// the map fills the viewport here, so the screenshot origin is the page origin
// and the affine needs no clip correction
const meta = await page.evaluate(
  ([lat0, lon0]) => ({ ...window.__transform(lat0, lon0), level: window.__map.getLevel() }),
  [ORIGIN.lat, ORIGIN.lon],
)
console.log('centre', centre, 'ppm', meta.pxPerMetre.toFixed(3), 'level', meta.level)

await page.screenshot({ path: join(OUT, `${NAME}.png`) })
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(meta, null, 1))
console.log('wrote', join(OUT, `${NAME}.png`))
await browser.close()
