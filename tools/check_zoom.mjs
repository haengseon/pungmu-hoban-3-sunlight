// 건물 높이가 줌과 무관하게 맞는지, MapLibre 자신의 fill-extrusion 과 대조한다.
//
//   node tools/check_zoom.mjs      # 개발 서버가 떠 있어야 한다
//
// maplibre 의 커스텀 레이어 MVP 는 x·y 를 월드픽셀로 받지만 z 는 미터로 받는다
// (행렬이 이미 픽셀/미터를 물고 있다). 셋 다 월드픽셀로 넘기면 높이에만 배율이 한 번
// 더 붙어 확대할수록 건물이 치솟고 축소하면 납작해진다 - 그런데 z16 근처에서는
// 1/미터당_메르카토르(5.0e7)와 월드픽셀(3.4e7)이 비슷해서 우연히 맞아 보인다.
// 그래서 한 배율에서만 보면 절대 못 잡는다. 여러 줌에서 재야 한다.
//
// 빈 땅에 100 m 짜리 상자를 세우고, 그 꼭대기 모서리의 화면 y 를 두 방식으로 구해
// 맞춰 본다: maplibre 가 실제로 칠한 픽셀 vs 우리 카메라 행렬이 투영한 점.
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const URL = process.env.APP_URL || 'http://127.0.0.1:5173/'
const TOL_PX = 6
const ZOOMS = [14, 15, 16]

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
await page.addInitScript(() => localStorage.setItem('hoban3.help.seen', '1'))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2000)

// 단지에서 떨어진 빈 땅. 우리 3D 가 가리면 꼭대기 픽셀을 못 찾는다.
await page.evaluate(() => {
  const map = window.__map
  const { lon, lat } = window.__geom
  const k = Math.cos(lat * Math.PI / 180)
  window.__probe = { x: -900, y: 700, half: 20, h: 100 }
  const cx = lon + window.__probe.x / (111320 * k)
  const cy = lat + window.__probe.y / 110540
  const d = window.__probe.half / (111320 * k)
  const dy = window.__probe.half / 110540
  map.addSource('probe', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[cx - d, cy - dy], [cx + d, cy - dy],
          [cx + d, cy + dy], [cx - d, cy + dy], [cx - d, cy - dy]]],
      },
    },
  })
  map.addLayer({
    id: 'probe',
    type: 'fill-extrusion',
    source: 'probe',
    paint: {
      'fill-extrusion-color': '#ff00ff',
      'fill-extrusion-height': window.__probe.h,
      'fill-extrusion-opacity': 1,
    },
  })
})

let worst = 0
for (const zoom of ZOOMS) {
  const ours = await page.evaluate(async (z) => {
    const map = window.__map
    const P = window.__probe
    const k = Math.cos(window.__geom.lat * Math.PI / 180)
    map.jumpTo({
      center: [window.__geom.lon + P.x / (111320 * k),
        window.__geom.lat + P.y / 110540],
      zoom: z,
      pitch: 45,
      bearing: 0,
    })
    map.triggerRepaint()
    await new Promise((res) => map.once('idle', res))
    // 상자에서 화면상 가장 위에 오는 점은 '먼 쪽 위 모서리' 다
    const e = window.__layer.camera.projectionMatrix.elements
    const [x, y, h] = [P.x, P.y + P.half, P.h]
    const w = e[3] * x + e[7] * y + e[11] * h + e[15]
    const ndcY = (e[1] * x + e[5] * y + e[9] * h + e[13]) / w
    const box = map.getCanvas().getBoundingClientRect()
    return { y: (1 - ndcY) / 2 * box.height, h: box.height }
  }, zoom)

  const shot = PNG.sync.read(await page.locator('.map').screenshot())
  let top = null
  for (let y = 0; y < shot.height && top === null; y++) {
    for (let x = 0; x < shot.width; x++) {
      const i = (shot.width * y + x) << 2
      if (shot.data[i] > 200 && shot.data[i + 1] < 90 && shot.data[i + 2] > 200) {
        top = y
        break
      }
    }
  }
  if (top === null) {
    console.log(`z${zoom}: 상자를 화면에서 못 찾았다`)
    process.exitCode = 1
    continue
  }
  const mine = ours.y * (shot.height / ours.h)
  const gap = Math.abs(mine - top)
  worst = Math.max(worst, gap)
  console.log(`z${zoom}  우리 ${mine.toFixed(0)} px / maplibre ${top} px  `
    + `차이 ${gap.toFixed(1)} px ${gap <= TOL_PX ? 'OK' : '실패'}`)
}

await browser.close()
console.log(worst <= TOL_PX
  ? `줌 검증 통과 (최대 어긋남 ${worst.toFixed(1)} px)`
  : `줌에 따라 건물 높이가 어긋난다 (최대 ${worst.toFixed(1)} px)`)
if (worst > TOL_PX) process.exit(1)
