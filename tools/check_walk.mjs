// 보행 마스크가 실제로 길찾기에 쓸 만한지 본다.
//
//   node tools/check_walk.mjs
//
// 마스크는 눈으로 보면 늘 그럴듯하다. 끊긴 한 픽셀은 안 보이는데 길찾기는 거기서
// 실패하거나 한참 돌아간다. 그래서 사람 눈이 아니라 이 스크립트가 합격을 정한다.
//
// 건물 사이를 실제로 A* 로 이어 보고 세 가지를 본다.
//   1) 길이 있는가
//   2) 직선거리 대비 얼마나 도는가 (크게 돌면 마스크가 끊긴 것이다)
//   3) 건물 안을 지나지 않는가
//
// 결과 경로는 tools/out/walk_route.png 로 그려 눈으로도 확인한다.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EARTH_C = 20037508.342789244
// 직선거리의 이 배를 넘게 돌면 마스크가 끊긴 것으로 본다. 다만 가까운 두 동은 건물을
// 돌아 나오는 것만으로도 비율이 크게 뛰므로(60 m 거리에 100 m 를 걷는 건 정상이다)
// 절대 여유도 함께 준다.
const DETOUR_MAX = 1.8
const DETOUR_SLACK_M = 90

const meta = JSON.parse(readFileSync(join(ROOT, 'web/src/data/walk.json'), 'utf8'))
const png = PNG.sync.read(readFileSync(join(ROOT, 'web/public/walk_mask.png')))
const { width: W, height: H } = png
if (W !== meta.width || H !== meta.height) {
  console.error(`마스크 ${W}x${H} 와 walk.json ${meta.width}x${meta.height} 가 다르다`)
  process.exit(1)
}
const MPP = meta.metresPerPixel

/** 걸을 수 있으면 1 */
const walk = new Uint8Array(W * H)
for (let i = 0; i < W * H; i++) walk[i] = png.data[i << 2] >= 128 ? 1 : 0

// 마스크 픽셀 <-> 위경도. 캡처 affine 이 회전 없는 메르카토르 정렬이라 네 모서리를
// 메르카토르로 바꿔 놓으면 선형이다.
const merc = ([lon, lat]) => [
  lon * EARTH_C / 180,
  Math.log(Math.tan((90 + lat) * Math.PI / 360)) * EARTH_C / Math.PI,
]
const [tl, tr, , bl] = meta.coordinates.map(merc)
const toPx = ([lon, lat]) => {
  const [mx, my] = merc([lon, lat])
  return [(mx - tl[0]) / (tr[0] - tl[0]) * W, (my - tl[1]) / (bl[1] - tl[1]) * H]
}

// --- 건물 ------------------------------------------------------------------
const complexes = []
for (const f of ['buildings', 'context', 'offices']) {
  const doc = JSON.parse(readFileSync(join(ROOT, `web/src/data/${f}.json`), 'utf8'))
  complexes.push(...doc.complexes)
}
/** @returns {{ring:number[][], cx:number, cy:number}[]} 픽셀 좌표의 건물들 */
const buildings = []
for (const c of complexes) {
  for (const b of c.buildings) {
    const ring = b.poly.map(toPx)
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length
    buildings.push({ id: `${c.id}|${b.dong}`, ring, cx, cy })
  }
}

const inside = (ring, x, y) => {
  let on = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) on = !on
  }
  return on
}
const built = new Uint8Array(W * H)
for (const b of buildings) {
  let x0 = W, y0 = H, x1 = 0, y1 = 0
  for (const [x, y] of b.ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      if (inside(b.ring, x + 0.5, y + 0.5)) built[y * W + x] = 1
    }
  }
}

// 걸을 수 있는 면을 성분으로 나눠 가장 큰 것을 골라 둔다. 출입점을 그냥 '가장 가까운
// 걸을 수 있는 픽셀' 로 잡으면 라벨 테두리 같은 고립된 조각에 붙어, 멀쩡한 마스크에도
// 길이 없다고 나온다.
const comp = new Int32Array(W * H).fill(-1)
let mainComp = -1
{
  const sizes = []
  for (let s = 0; s < W * H; s++) {
    if (!walk[s] || comp[s] >= 0) continue
    const id = sizes.length
    const q = [s]
    comp[s] = id
    for (let head = 0; head < q.length; head++) {
      const i = q[head]
      const x = i % W, y = (i - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const j = ny * W + nx
          if (walk[j] && comp[j] < 0) { comp[j] = id; q.push(j) }
        }
      }
    }
    sizes.push(q.length)
  }
  mainComp = sizes.indexOf(Math.max(...sizes))
  console.log(`걸을 수 있는 면 ${(walk.reduce((a, b) => a + b, 0) * MPP ** 2 / 1e4).toFixed(1)} ha, `
    + `성분 ${sizes.length}개, 가장 큰 것 ${(Math.max(...sizes) * MPP ** 2 / 1e4).toFixed(1)} ha`)
}

/** 그 동에서 걸어 나오는 지점 - 무게중심에서 가장 가까운, 주 보행망 위의 픽셀 */
function entrance(b) {
  const seen = new Uint8Array(W * H)
  const q = [Math.round(b.cy) * W + Math.round(b.cx)]
  seen[q[0]] = 1
  for (let head = 0; head < q.length; head++) {
    const i = q[head]
    if (walk[i] && comp[i] === mainComp) return i
    const x = i % W, y = (i - x) / W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (!seen[j]) { seen[j] = 1; q.push(j) }
    }
    if (q.length > 4e6) break
  }
  return -1
}

// --- A* --------------------------------------------------------------------
const D8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]

function route(from, to) {
  const g = new Float32Array(W * H).fill(Infinity)
  const prev = new Int32Array(W * H).fill(-1)
  // 낡은 항목은 f 비교가 아니라 닫힘 표시로 거른다. g 가 Float32 라 저장하면서 값이
  // 0.0002 쯤 어긋나는데, 그걸 f(배정밀도)와 비교하면 멀쩡한 노드까지 전부 낡은
  // 것으로 걸러져 탐색이 시작하자마자 끝난다.
  const closed = new Uint8Array(W * H)
  const tx = to % W, ty = (to - tx) / W
  // 이진 힙. 격자가 2000만 칸이라 배열 정렬로는 못 버틴다.
  const heap = [{ i: from, f: 0 }]
  const push = (n) => {
    heap.push(n)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heap[p].f <= heap[c].f) break
      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = p * 2 + 1, r = l + 1
        let m = p
        if (l < heap.length && heap[l].f < heap[m].f) m = l
        if (r < heap.length && heap[r].f < heap[m].f) m = r
        if (m === p) break
        ;[heap[p], heap[m]] = [heap[m], heap[p]]
        p = m
      }
    }
    return top
  }
  g[from] = 0
  while (heap.length) {
    const { i } = pop()
    if (closed[i]) continue
    closed[i] = 1
    if (i === to) break
    const x = i % W, y = (i - x) / W
    for (const [dx, dy, w] of D8) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (!walk[j]) continue
      const ng = g[i] + w
      if (ng < g[j]) {
        g[j] = ng
        prev[j] = i
        push({ i: j, f: ng + Math.hypot(tx - nx, ty - ny) })
      }
    }
  }
  if (!isFinite(g[to])) return null
  const path = []
  for (let i = to; i !== -1; i = prev[i]) path.push(i)
  return { path: path.reverse(), metres: g[to] * MPP }
}

// --- 검사 ------------------------------------------------------------------
const find = (id) => {
  const hit = buildings.filter((b) => b.id === id)
  if (!hit.length) throw new Error(`${id} 를 못 찾았다`)
  // 계단형이라 한 동이 여러 볼륨이다. 가장 큰 것 하나면 된다
  return hit[0]
}
const PAIRS = [
  ['같은 단지 안', 'hoban3|401', 'hoban3|408'],
  ['단지 사이', 'hoban3|401', 'prugio|301'],
  ['지구 건너', 'hoban3|401', 'grascent1|201'],
]

const routes = []
let bad = 0
let warn = 0
for (const [label, a, b] of PAIRS) {
  const A = find(a), B = find(b)
  const ea = entrance(A), eb = entrance(B)
  if (ea < 0 || eb < 0) {
    console.log(`${label} ${a} -> ${b}: 출입점을 못 찾았다`)
    bad++
    continue
  }
  const r = route(ea, eb)
  if (!r) {
    console.log(`${label} ${a} -> ${b}: 길이 없다 (마스크가 끊겼다)`)
    bad++
    continue
  }
  // 기준은 무게중심이 아니라 출입점 사이 직선거리다 - 걷기는 거기서 시작한다
  const ax = ea % W, ay = (ea - ax) / W
  const bx = eb % W, by = (eb - bx) / W
  const straight = Math.hypot(ax - bx, ay - by) * MPP
  const detour = r.metres / straight
  const through = r.path.filter((i) => built[i]).length
  // 길이 아예 없거나 건물을 뚫는 것은 실패다. 많이 도는 것은 경고다 - 마스크에 아직
  // 안 이어진 데가 있다는 뜻이고, 그건 편집기에서 손으로 이어 주라는 신호다.
  const far = r.metres > Math.max(straight * DETOUR_MAX, straight + DETOUR_SLACK_M)
  const ok = through === 0
  console.log(`${label} ${a} -> ${b}: ${r.metres.toFixed(0)} m `
    + `(직선 ${straight.toFixed(0)} m, ${detour.toFixed(2)}배)`
    + `${through ? ` 건물 관통 ${through} px` : ''} `
    + `${!ok ? '실패' : far ? '경고: 많이 돈다 - 마스크가 끊겼는지 보라' : 'OK'}`)
  if (!ok) bad++
  else if (far) warn++
  routes.push(r.path)
}

// --- 그림 ------------------------------------------------------------------
const cap = PNG.sync.read(readFileSync(join(ROOT, 'tools/out/kakao_wide.png')))
for (let i = 0; i < W * H; i++) {
  if (!walk[i]) continue
  const o = i << 2
  cap.data[o] = cap.data[o] * 0.6
  cap.data[o + 1] = cap.data[o + 1] * 0.6 + 100
  cap.data[o + 2] = cap.data[o + 2] * 0.6 + 40
}
for (const path of routes) {
  for (const i of path) {
    const x = i % W, y = (i - x) / W
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const o = (ny * W + nx) << 2
        cap.data[o] = 230; cap.data[o + 1] = 30; cap.data[o + 2] = 30
      }
    }
  }
}
const out = join(ROOT, 'tools/out/walk_route.png')
writeFileSync(out, PNG.sync.write(cap))
console.log(`tools/out/walk_route.png 에 경로를 그렸다`)
console.log(bad
  ? `보행 마스크 검증 실패 (${bad}건)`
  : warn
    ? `보행 마스크 검증 통과 - 다만 ${warn}건은 많이 돈다`
    : '보행 마스크 검증 통과')
if (bad) process.exit(1)
