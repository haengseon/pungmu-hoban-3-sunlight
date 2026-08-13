// 지도 영역 크기가 바뀐 뒤에도 3D 가 같은 자리에 같은 크기로 그려지는지 본다.
//
//   node tools/check_resize.mjs      # 개발 서버가 떠 있어야 한다
//
// three 는 렌더러를 만든 시점의 캔버스 크기를 붙들고 있고, 그림자 맵을 다시 굽는
// 프레임마다 렌더타깃을 되돌리면서 그 크기로 뷰포트를 복원한다. 그래서 지도 높이가
// 한 번이라도 바뀌면 그림자를 다시 굽는 프레임만 3D 가 어긋난 크기로 그려진다 -
// 시각 슬라이더는 매 스텝 다시 구우므로 끄는 내내 화면이 깜빡인다.
// buildings3d.js 의 render() 가 드로잉 버퍼 크기를 three 에 다시 알려 주는 것으로
// 막고 있는데, 눈으로는 조작 중에만 보여서 놓치기 쉽다.
//
// 같은 크기·같은 시각이면 그림자를 다시 굽든 말든 픽셀이 같아야 한다.
import { chromium } from 'playwright'
import { PNG } from 'pngjs'

const URL = process.env.APP_URL || 'http://127.0.0.1:5173/'
const TOL = 0.005 // 이 비율을 넘게 다르면 실패

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
await page.addInitScript(() => localStorage.setItem('hoban3.help.seen', '1'))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__layer, null, { timeout: 30000 })
await page.waitForTimeout(2500)

const setT = (t) => page.evaluate((v) => {
  const el = document.querySelector('.time input[type=range]')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(el, String(v))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, t)
const shot = () => page.locator('.mapbox').screenshot()
// 시각을 움직였다 되돌린다 - 장면은 그대로면서 그림자만 다시 굽는다
const rebake = async () => {
  await setT(13 * 60)
  await page.waitForTimeout(500)
  await setT(14 * 60)
  await page.waitForTimeout(1500)
}

await setT(14 * 60)
await page.waitForTimeout(1200)

// 렌더러가 스냅샷해 둔 크기에서 벗어난 채로 비교해야 어긋남이 드러난다.
// 원래 크기로 되돌리면 스냅샷과 다시 맞아 아무 일도 안 생긴다.
await page.setViewportSize({ width: 430, height: 660 })
await page.waitForTimeout(1500)
const A = await shot()
await rebake()
const B = await shot()

// 아래 메뉴를 접는 것도 같은 리사이즈다
await page.getByRole('button', { name: '지도 크게보기' }).click()
await page.waitForTimeout(1500)
const C = await shot()
await rebake()
const D = await shot()

await browser.close()

/** @returns {boolean} 두 스크린샷이 사실상 같은가 */
function same(x, y, label) {
  const a = PNG.sync.read(x)
  const c = PNG.sync.read(y)
  if (a.width !== c.width || a.height !== c.height) {
    console.log(`${label}: 크기부터 다름 ${a.width}x${a.height} / ${c.width}x${c.height}`)
    return false
  }
  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - c.data[i]) > 8
      || Math.abs(a.data[i + 1] - c.data[i + 1]) > 8
      || Math.abs(a.data[i + 2] - c.data[i + 2]) > 8) diff++
  }
  const total = a.width * a.height
  const ok = diff / total <= TOL
  console.log(`${label}: 다른 픽셀 ${diff} / ${total} `
    + `(${(diff / total * 100).toFixed(2)}%) ${ok ? 'OK' : '실패'}`)
  return ok
}

const ok = [same(A, B, '창 높이 변경 뒤 '), same(C, D, '지도 크게보기 뒤')].every(Boolean)
console.log(ok ? '리사이즈 검증 통과' : '리사이즈 뒤 3D 가 어긋난다')
if (!ok) process.exit(1)
