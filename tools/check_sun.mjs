// Sanity-check the solar maths the viewer drives its shadows with.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daylight, fmtTime, solarPosition, sunVector } from '../web/src/lib/sun.js'

const here = dirname(fileURLToPath(import.meta.url))
const doc = JSON.parse(readFileSync(join(here, '../web/src/data/buildings.json'), 'utf8'))
const { lat, lon } = doc.origin
console.log(`site  ${lat.toFixed(5)}N ${lon.toFixed(5)}E\n`)

let bad = 0
const fail = (msg) => {
  bad++
  console.log('  FAIL: ' + msg)
}

// --- solar noon altitude vs the closed-form 90 - lat + declination ----------
const CASES = [
  ['봄 03/20', { y: 2026, m: 3, d: 20 }, 90 - lat - 0.3],
  ['여름 06/21', { y: 2026, m: 6, d: 21 }, 90 - lat + 23.44],
  ['가을 09/22', { y: 2026, m: 9, d: 22 }, 90 - lat + 0.9],
  ['겨울 12/21', { y: 2026, m: 12, d: 21 }, 90 - lat - 23.44],
]
for (const [name, d, expect] of CASES) {
  const dl = daylight(d, lat, lon)
  const noon = solarPosition(d, dl.noon, lat, lon)
  const err = Math.abs(noon.altitude - expect)
  console.log(
    `${name}  일출 ${fmtTime(dl.sunrise)}  정오 ${fmtTime(dl.noon)}  일몰 ${fmtTime(dl.sunset)}` +
      `  낮 ${((dl.sunset - dl.sunrise) / 60).toFixed(2)}h  정오고도 ${noon.altitude.toFixed(2)}°` +
      `  (이론 ${expect.toFixed(2)}°, 오차 ${err.toFixed(2)}°)`,
  )
  if (err > 1.2) fail(`${name} 정오 고도 오차 ${err.toFixed(2)}°`)
  if (Math.abs(noon.azimuth - 180) > 0.5) fail(`${name} 정오 방위각 ${noon.azimuth.toFixed(2)}°`)
}

// --- shadow bearing: morning sun in the east -> shadow to the west ----------
console.log('')
for (const [label, mins, wantEastOfSouth] of [
  ['09시', 540, true],
  ['15시', 900, false],
]) {
  const d = { y: 2026, m: 12, d: 21 }
  const sp = solarPosition(d, mins, lat, lon)
  const east = sp.azimuth < 180
  console.log(`겨울 ${label}  고도 ${sp.altitude.toFixed(1)}°  방위 ${sp.azimuth.toFixed(1)}°` +
    `  그림자 방위 ${((sp.azimuth + 180) % 360).toFixed(1)}°`)
  if (east !== wantEastOfSouth) fail(`${label} 태양이 반대쪽에 있음`)
}

// --- sun vector orientation (scene axes: +x east, +y up, +z south) ---------
const s = sunVector(30, 180)
if (Math.abs(s.x) > 1e-9 || s.z <= 0) fail('정남 태양 벡터가 남쪽(+z)을 향하지 않음')
const e = sunVector(0, 90)
if (e.x <= 0.99 || Math.abs(e.z) > 1e-9) fail('정동 태양 벡터가 동쪽(+x)을 향하지 않음')

// --- shadow length grows as the sun drops ----------------------------------
const d = { y: 2026, m: 12, d: 21 }
const len = (m) => {
  const a = solarPosition(d, m, lat, lon).altitude
  return a > 0 ? 87.6 / Math.tan((a * Math.PI) / 180) : Infinity
}
const l10 = len(600)
const l12 = len(750)
console.log(`\n29층(87.6m) 그림자: 10시 ${l10.toFixed(0)}m, 정오 ${l12.toFixed(0)}m`)
if (!(l10 > l12)) fail('낮은 태양에서 그림자가 더 짧게 계산됨')

// --- dataset shape ---------------------------------------------------------
let vols = 0
const dongs = new Set()
for (const c of doc.complexes) {
  for (const b of c.buildings) {
    vols++
    if (b.dong) dongs.add(`${c.id}:${b.dong}`)
    if (!(b.height > 0) || b.poly.length < 3) fail(`${c.id} ${b.dong}: 잘못된 볼륨`)
    if (b.kind === 'amenity' && b.floors !== 2) fail(`${c.id}: 상가 층수 ${b.floors}`)
  }
}
console.log(`데이터: ${doc.complexes.length}개 단지, ${dongs.size}개 동, ${vols}개 볼륨`)
if (dongs.size < 35) fail(`동 수 부족 (${dongs.size})`)

// --- 3차 주택형 셀: 옥상을 빈틈없이 덮고, 타입 순서가 동호수배치도 그대로인가 ----
const TYPES3 = {
  401: ['84C', '84A', '84B', '84D'], 402: ['84A', '84B', '84D'],
  403: ['84C', '84A', '84A', '84B', '84A'], 404: ['84C', '84A', '84A', '84B', '84D'],
  405: ['84C', '84A', '59A', '59B', '59A'], 406: ['59B', '59A', '59B', '59A'],
  407: ['59B', '59A', '59B', '59A'], 408: ['59B', '59A', '59B', '59A'],
}
const ring = (p) => {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[(i + 1) % p.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}
const h3 = doc.complexes.find((c) => c.id === 'hoban3')
for (const [dong, want] of Object.entries(TYPES3)) {
  const vs = h3.buildings.filter((b) => b.dong === dong)
  const got = vs.flatMap((b) => (b.cells || []).map((u) => u.type))
  if (got.join() !== want.join()) fail(`${dong}동 주택형 배열 ${got} != ${want}`)
  for (const b of vs) {
    const cover = (b.cells || []).reduce((s, u) => s + ring(u.poly), 0) / ring(b.poly)
    if (!(cover > 0.95 && cover < 1.05)) {
      fail(`${dong}동 ${b.floors}층 볼륨: 셀이 옥상의 ${(cover * 100).toFixed(0)}%만 덮음`)
    }
  }
}
console.log(`3차 주택형 셀: 8개 동 ${Object.values(TYPES3).flat().length}개 라인 일치`)

console.log(bad ? `\n${bad} FAILURE(S)` : '\n모든 검증 통과')
process.exit(bad ? 1 : 0)
