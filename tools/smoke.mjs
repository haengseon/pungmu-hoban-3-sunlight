// Load the app in a headless browser, report what it actually drew and shoot it.
//   node tools/smoke.mjs            -> tools/out/smoke.png
//   SEASON=winter T=540 node ...    -> pick the season / minutes past midnight
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tools', 'out')
const URL = process.env.APP_URL || 'http://localhost:5173/'
const SEASON = process.env.SEASON || 'winter'
const T = Number(process.env.T || 14 * 60)
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({
  viewport: { width: Number(process.env.W || 430), height: Number(process.env.H || 932) },
})
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
if (process.env.LEVEL) {
  await page.evaluate((l) => window.__map.setLevel(Number(l)), process.env.LEVEL)
}
if (process.env.CENTER) {
  await page.evaluate((c) => {
    const [lat, lng] = c.split(',').map(Number)
    window.__map.setCenter(new window.kakao.maps.LatLng(lat, lng))
  }, process.env.CENTER)
}
await page.waitForTimeout(1200)

const stat = await page.evaluate(() => {
  const L = window.__layer
  const t0 = performance.now()
  L.dirty = true
  L.draw(L.transform())
  const ms = performance.now() - t0
  return {
    volumes: L.items.length,
    onScreen: L.hit.length,
    faces: L.hit.reduce((a, h) => a + h.polys.length, 0),
    drawMs: Math.round(ms),
    level: window.__map.getLevel(),
    time: document.querySelector('.big')?.textContent,
    seasons: [...document.querySelectorAll('.seasons button')].map(
      (b) => b.textContent + (b.className.includes('on') ? '*' : ''),
    ).join(' '),
    zoom: [...document.querySelectorAll('.zoom button')].map((b) => b.textContent).join(''),
  }
})

console.log(
  `볼륨 ${stat.volumes} · 화면 ${stat.onScreen} · 면 ${stat.faces} · ` +
  `그리기 ${stat.drawMs}ms · level ${stat.level} · ${stat.time} · ` +
  `${stat.seasons} · 줌 [${stat.zoom}] · ` +
  (errors.length ? `에러 ${errors.length}: ${errors[0]}` : '에러없음'),
)
await page.screenshot({ path: join(OUT, 'smoke.png'), animations: 'disabled', timeout: 120000 })
console.log('wrote', join(OUT, 'smoke.png'))
await browser.close()
