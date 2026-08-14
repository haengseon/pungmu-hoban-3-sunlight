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
import { carveBuildings, components, loadBuildings, loadWalk } from './lib/walkmask.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EARTH_C = 20037508.342789244
// 직선거리의 이 배를 넘게 돌면 마스크가 끊긴 것으로 본다. 다만 가까운 두 동은 건물을
// 돌아 나오는 것만으로도 비율이 크게 뛰므로(60 m 거리에 100 m 를 걷는 건 정상이다)
// 절대 여유도 함께 준다.
const DETOUR_MAX = 1.8
const DETOUR_SLACK_M = 90
// 출입점이 이보다 멀면 그 동은 주 보행망에 닿아 있지 않은 것이다. 이 가드가 없으면
// 망이 조각났을 때 출입점이 한참 떨어진 조각에 붙어 검사가 거짓 통과한다.
const MAX_ENTRANCE_M = 60

const { W, H, MPP, walk, toPx } = loadWalk(ROOT)
const buildings = loadBuildings(ROOT, toPx)
// 사람이 붓으로 고친 마스크라 동 모서리를 덮는 일이 생긴다. 건물 자리는 걸을 수 없으니
// make_routes 와 똑같이 읽을 때 깎아 낸다 - 한쪽만 통과하는 일이 없어야 한다.
const cut = carveBuildings(walk, buildings, W, H, MPP)
const { comp, sizes, main: mainComp } = components(walk, W, H)
console.log(`건물 자리 ${(cut * MPP ** 2).toFixed(0)} m2 깎음 · `
  + `걸을 수 있는 면 ${(walk.reduce((a2, b2) => a2 + b2, 0) * MPP ** 2 / 1e4).toFixed(1)} ha, `
  + `성분 ${sizes.length}개, 가장 큰 것 ${(Math.max(...sizes) * MPP ** 2 / 1e4).toFixed(1)} ha`)

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
  ['지구 건너', 'hoban3|401', 'hoban2|1501'],
]

const routes = []
let bad = 0
let warn = 0
for (const [label, a, b] of PAIRS) {
  const A = find(a), B = find(b)
  const ea = entrance(A), eb = entrance(B)
  const away = (e, b) => e < 0 ? Infinity
    : Math.hypot(e % W - b.cx, (e - e % W) / W - b.cy) * MPP
  const da = away(ea, A), db = away(eb, B)
  if (da > MAX_ENTRANCE_M || db > MAX_ENTRANCE_M) {
    console.log(`${label} ${a} -> ${b}: 주 보행망에 닿지 않는다 `
      + `(출입점까지 ${da.toFixed(0)} m / ${db.toFixed(0)} m)`)
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
  // 건물 관통은 이제 검사하지 않는다 - 마스크를 읽을 때 건물 자리를 깎아 내므로
  // 구조적으로 일어날 수 없다. 남은 판정은 '길이 있는가' 와 '얼마나 도는가' 다.
  const far = r.metres > Math.max(straight * DETOUR_MAX, straight + DETOUR_SLACK_M)
  console.log(`${label} ${a} -> ${b}: ${r.metres.toFixed(0)} m `
    + `(직선 ${straight.toFixed(0)} m, ${detour.toFixed(2)}배)`
    + `${far ? ' 경고: 많이 돈다 - 마스크가 끊겼는지 보라' : 'OK'}`)
  if (far) warn++
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
