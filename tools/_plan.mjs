import { chromium } from 'playwright'
const D = 'C:/Users/hsc81/AppData/Local/Temp/claude/D--workspace-hoban2/c96f7d9f-242d-4b20-8ee5-43bbc8732464/'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 1200, height: 950 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('ERR', e.message))
await page.addInitScript(() => localStorage.setItem('hoban3.help.seen', '1'))
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2500)
await page.click('.plan-toggle')
await page.evaluate(() => window.__map.jumpTo({ center: [126.7305, 37.6165], zoom: 14.5, pitch: 35, bearing: 0 }))
await page.waitForTimeout(2500)
console.log(JSON.stringify(await page.evaluate(() => ({
  tags: document.querySelectorAll('.lot-tag').length,
  fills: window.__map.queryRenderedFeatures({ layers: ['landuse-fill'] }).length,
  district: window.__map.queryRenderedFeatures({ layers: ['district-line'] }).length,
}))))
await page.screenshot({ path: D + 'plan_on.png' })
await b.close()
