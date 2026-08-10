// Load the app in a headless browser, report what it actually drew and shoot it.
//   node tools/smoke.mjs            -> tools/out/smoke.png
//   SEASON=winter T=540 node ...    -> pick the season / minutes past midnight
//   ZOOM=17 PITCH=60 BEARING=30 CENTER=37.615,126.734 node ...  -> frame it
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tools', 'out')
const URL = process.env.APP_URL || 'http://127.0.0.1:5173/'
const SEASON = process.env.SEASON || 'winter'
const T = Number(process.env.T || 14 * 60)
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: Number(process.env.W || 430), height: Number(process.env.H || 932) },
})
// 첫 방문 조작법 시트가 떠 있으면 UI 를 못 누른다. 본 것으로 표시하고 연다
// (그 시트 자체는 tools/_help 계열 검증에서 따로 본다).
await page.addInitScript(() => localStorage.setItem('hoban3.help.seen', '1'))

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2500)

// drive the UI the way a user would
const label = { spring: '봄', summer: '여름', autumn: '가을', winter: '겨울' }[SEASON]
if (label) await page.getByRole('button', { name: label, exact: true }).click()
await page.evaluate((t) => {
  const el = document.querySelector('.time input[type=range]')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(el, String(t))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, T)
const view = {}
for (const k of ['ZOOM', 'PITCH', 'BEARING']) {
  if (process.env[k]) view[k.toLowerCase()] = Number(process.env[k])
}
if (process.env.CENTER) view.center = process.env.CENTER.split(',').map(Number).reverse()
if (Object.keys(view).length) await page.evaluate((v) => window.__map.jumpTo(v), view)
await page.waitForTimeout(1200)

const stat = await page.evaluate(() => {
  const L = window.__layer
  const m = window.__map
  // time the main pass only; the shadow map is a separate, sun-driven cost
  L.renderer.shadowMap.needsUpdate = false
  const t0 = performance.now()
  L.renderer.render(L.scene, L.camera)
  const ms = performance.now() - t0
  L.renderer.resetState()
  // 이 렌더는 maplibre 의 프레임 밖이라 지도 타일 위를 덮어쓴다. 스크린샷 전에
  // 정상 프레임을 한 번 더 그리게 한다.
  m.triggerRepaint()
  return {
    volumes: L.volumes.length,
    calls: L.renderer.info.render.calls,
    tris: L.renderer.info.render.triangles,
    drawMs: Math.round(ms),
    view: `z${m.getZoom().toFixed(1)} p${Math.round(m.getPitch())}° b${Math.round(m.getBearing())}°`,
    time: document.querySelector('.big')?.textContent,
    seasons: [...document.querySelectorAll('.seasons button')].map(
      (b) => b.textContent + (b.className.includes('on') ? '*' : ''),
    ).join(' '),
    compass: !!document.querySelector('.maplibregl-ctrl-compass'),
  }
})

console.log(
  `볼륨 ${stat.volumes} · 드로우콜 ${stat.calls} · 삼각형 ${stat.tris} · ` +
  `그리기 ${stat.drawMs}ms · ${stat.view} · ${stat.time} · ` +
  `${stat.seasons} · 나침반 ${stat.compass ? 'O' : 'X'} · ` +
  (errors.length ? `에러 ${errors.length}: ${errors[0]}` : '에러없음'),
)
await page.screenshot({ path: join(OUT, 'smoke.png'), animations: 'disabled', timeout: 120000 })
console.log('wrote', join(OUT, 'smoke.png'))
await browser.close()
