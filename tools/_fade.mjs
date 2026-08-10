import { chromium } from 'playwright'
const D = 'C:/Users/hsc81/AppData/Local/Temp/claude/D--workspace-hoban2/c96f7d9f-242d-4b20-8ee5-43bbc8732464/'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('ERR', e.message))
await page.addInitScript(() => localStorage.setItem('hoban3.help.seen', '1'))
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2500)
await page.click('.seasons button:nth-child(4)')
for (const [t, name] of [[8*60,'w08'],[9*60,'w09'],[15*60,'w15']]) {
  await page.$eval('.time input', (el, v) => {
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    s.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true }))
  }, t)
  await page.evaluate(() => window.__map.jumpTo({ center: [126.7340, 37.6150], zoom: 14.6, pitch: 40, bearing: 0 }))
  await page.waitForTimeout(1800)
  console.log(name, JSON.stringify(await page.evaluate(() => {
    const L = window.__layer, u = L.ground.material.userData.u
    return { alt: +L.sun.altitude.toFixed(2), near: Math.round(u.uNear.value),
      far: Math.round(u.uFar.value), low: +u.uLow.value.toFixed(2) }
  })))
  await page.screenshot({ path: D + name + '.png' })
}
await b.close()
