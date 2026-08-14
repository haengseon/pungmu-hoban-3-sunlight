// 동마다 풍무역 1번 출구까지 걸어가는 길을 미리 구워 둔다.
//
//   node tools/make_routes.mjs      -> web/src/data/routes.json
//
// 런타임에 길찾기를 돌릴 이유가 없다. 동은 서른몇 개고 목적지는 하나다. 게다가
// **목적지에서 한 번만** 다익스트라를 돌리면 격자의 모든 칸까지의 거리와 되짚을
// 경로가 한꺼번에 나온다 - 동마다 A* 를 돌릴 필요가 없다.
//
// 시간과 힘듦은 거리에서만 뽑는다. 이 지구는 표고 7~9 m 라 사실상 평지여서 경사가
// 걷는 수고에 끼치는 영향이 없다.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EARTH_C = 20037508.342789244

// tools/trace_kakao.mjs 로 찍은 카카오 캡처에서 읽은 자리다 (level 1, 0.25 m/px)
const TARGET = { name: '풍무역 1번 출구', at: [126.7322535, 37.6128162] }

// 성인 평균 보행 속도. 신호 설계 기준(1.0)보다 빠르고 분양 광고 관행(80 m/분,
// 1.33)보다 느리다. 광고와 숫자가 다른 이유가 여기 있다.
const SPEED_MPS = 1.2
// 횡단보도 대기. 기댓값은 주기의 절반이라 30초로 잡는다.
const CROSS_WAIT_S = 30
const SIMPLIFY_M = 3      // 폴리라인 단순화 - 격자 그대로면 점이 수천 개다
const MAX_ENTRANCE_M = 60 // 출입점이 이보다 멀면 그 동은 보행망에 안 닿은 것이다

// 두 번째 길. 최단 경로 둘레에 불이익을 주고 다시 찾으면 '의미 있게 다른' 길이 나온다.
// 단지를 가로지르는 지름길과 큰길을 도는 길처럼, 실제로 사람이 저울질하는 두 갈래다.
const ALT_PENALTY = 4      // 최단 경로 둘레를 지날 때의 비용 배수
const ALT_NEAR_M = 22      // 그 둘레의 폭
const ALT_MIN_DIFF = 0.12  // 최단보다 이만큼도 안 다르면 같은 길로 본다
const ALT_MAX_RATIO = 1.9  // 최단의 이 배를 넘으면 대안이라 할 수 없다

const meta = JSON.parse(readFileSync(join(ROOT, 'web/src/data/walk.json'), 'utf8'))
const png = PNG.sync.read(readFileSync(join(ROOT, 'web/public/walk_mask.png')))
const W = png.width, H = png.height
const MPP = meta.metresPerPixel
const walk = new Uint8Array(W * H)
for (let i = 0; i < W * H; i++) walk[i] = png.data[i << 2] >= 128 ? 1 : 0

const merc = ([lon, lat]) => [
  lon * EARTH_C / 180,
  Math.log(Math.tan((90 + lat) * Math.PI / 360)) * EARTH_C / Math.PI,
]
const [tl, tr, , bl] = meta.coordinates.map(merc)
const toPx = ([lon, lat]) => {
  const [mx, my] = merc([lon, lat])
  return [(mx - tl[0]) / (tr[0] - tl[0]) * W, (my - tl[1]) / (bl[1] - tl[1]) * H]
}
const toLonLat = (x, y) => {
  const mx = tl[0] + (x / W) * (tr[0] - tl[0])
  const my = tl[1] + (y / H) * (bl[1] - tl[1])
  return [
    +(mx * 180 / EARTH_C).toFixed(7),
    +(Math.atan(Math.exp(my * Math.PI / EARTH_C)) * 360 / Math.PI - 90).toFixed(7),
  ]
}

// 걸을 수 있는 면을 성분으로 나눠 가장 큰 것을 골라 둔다. 그냥 '가장 가까운 걸을 수
// 있는 칸' 에 붙이면 라벨 테두리 같은 고립된 조각에 걸려, 목적지가 거기 붙는 순간
// 모든 동이 도달 불가로 나온다.
const comp = new Int32Array(W * H).fill(-1)
let mainComp = -1
{
  const sizes = []
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!walk[s0] || comp[s0] >= 0) continue
    const id = sizes.length
    const q = [s0]
    comp[s0] = id
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
  console.log(`보행망 ${sizes.length}개 성분, 주 망 `
    + `${(Math.max(...sizes) * MPP ** 2 / 1e4).toFixed(1)} ha`)
}

/** 가장 가까운, 주 보행망 위의 칸 */
function snap(x, y) {
  const seen = new Uint8Array(W * H)
  const q = [Math.round(y) * W + Math.round(x)]
  seen[q[0]] = 1
  for (let head = 0; head < q.length && head < 4e6; head++) {
    const i = q[head]
    if (walk[i] && comp[i] === mainComp) return i
    const px = i % W, py = (i - px) / W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx, ny = py + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (!seen[j]) { seen[j] = 1; q.push(j) }
    }
  }
  return -1
}

// --- 목적지에서 한 번만 다익스트라 -----------------------------------------
const [sx, sy] = toPx(TARGET.at)
const start = snap(sx, sy)
if (start < 0) {
  console.error('목적지가 보행망에 닿지 않는다')
  process.exit(1)
}
const dist = new Float64Array(W * H).fill(Infinity)
const next = new Int32Array(W * H).fill(-1)   // 목적지 쪽으로 한 칸
const closed = new Uint8Array(W * H)
const D8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]
{
  const heap = [{ i: start, d: 0 }]
  const push = (n) => {
    heap.push(n)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heap[p].d <= heap[c].d) break
      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = p * 2 + 1, r = l + 1
        let m = p
        if (l < heap.length && heap[l].d < heap[m].d) m = l
        if (r < heap.length && heap[r].d < heap[m].d) m = r
        if (m === p) break
        ;[heap[p], heap[m]] = [heap[m], heap[p]]
        p = m
      }
    }
    return top
  }
  dist[start] = 0
  while (heap.length) {
    const { i } = pop()
    if (closed[i]) continue
    closed[i] = 1
    const x = i % W, y = (i - x) / W
    for (const [dx, dy, w] of D8) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (!walk[j] || closed[j]) continue
      const nd = dist[i] + w
      if (nd < dist[j]) { dist[j] = nd; next[j] = i; push({ i: j, d: nd }) }
    }
  }
}

// --- 동마다 경로 -------------------------------------------------------------
const complexes = []
for (const f of ['buildings', 'context', 'offices']) {
  const doc = JSON.parse(readFileSync(join(ROOT, `web/src/data/${f}.json`), 'utf8'))
  for (const c of doc.complexes) complexes.push(c)
}
/** 한 동이 계단형이라 볼륨이 여럿이다. 동 단위로 모아 무게중심을 낸다. */
const dongs = new Map()
for (const c of complexes) {
  for (const b of c.buildings) {
    if (!b.dong) continue
    const key = `${c.id}|${b.dong}`
    const pts = b.poly.map(toPx)
    const e = dongs.get(key) || { key, complex: c.name, dong: b.dong, xs: 0, ys: 0, n: 0 }
    for (const [x, y] of pts) { e.xs += x; e.ys += y; e.n++ }
    dongs.set(key, e)
  }
}

/** 점을 솎는다 (Douglas-Peucker) */
function simplify(pts, tol) {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = pts[a], [bx, by] = pts[b]
    let far = -1, best = tol
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]
      const dx = bx - ax, dy = by - ay
      const len = Math.hypot(dx, dy) || 1
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
      if (d > best) { best = d; far = i }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]) }
  }
  return pts.filter((_, i) => keep[i])
}

// --- 두 번째 길 ------------------------------------------------------------
// 격자가 2000만 칸이라 매번 Infinity 로 다시 채우면 그것만으로 느리다. 세대 번호를
// 찍어 두고 번호가 다르면 '아직 안 본 칸' 으로 친다.
const altG = new Float64Array(W * H)
const altGen = new Int32Array(W * H)
const altPrev = new Int32Array(W * H)
const penal = new Uint8Array(W * H)
const penalGen = new Int32Array(W * H)
let gen = 0

/** 최단 경로를 피해 가는 길. 없으면 null */
function altRoute(from, to, primary) {
  gen++
  const r = Math.round(ALT_NEAR_M / MPP)
  const step = Math.max(1, r >> 1)
  for (let k = 0; k < primary.length; k += step) {
    const [cx, cy] = primary[k]
    for (let dy = -r; dy <= r; dy++) {
      const yy = cy + dy
      if (yy < 0 || yy >= H) continue
      const dx = Math.floor(Math.sqrt(r * r - dy * dy))
      for (let x = Math.max(0, cx - dx); x <= Math.min(W - 1, cx + dx); x++) {
        const i = yy * W + x
        penalGen[i] = gen
        penal[i] = 1
      }
    }
  }
  const tx = to % W, ty = (to - tx) / W
  const heap = [{ i: from, f: 0 }]
  altGen[from] = gen
  altG[from] = 0
  altPrev[from] = -1
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
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = p * 2 + 1, rr = l + 1
        let m = p
        if (l < heap.length && heap[l].f < heap[m].f) m = l
        if (rr < heap.length && heap[rr].f < heap[m].f) m = rr
        if (m === p) break
        ;[heap[p], heap[m]] = [heap[m], heap[p]]
        p = m
      }
    }
    return top
  }
  const shutGen = new Int32Array(W * H)
  while (heap.length) {
    const { i } = pop()
    if (shutGen[i] === gen) continue
    shutGen[i] = gen
    if (i === to) break
    const x = i % W, y = (i - x) / W
    for (const [dx, dy, w] of D8) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (!walk[j] || shutGen[j] === gen) continue
      const cost = w * (penalGen[j] === gen && penal[j] ? ALT_PENALTY : 1)
      const ng = altG[i] + cost
      if (altGen[j] !== gen || ng < altG[j]) {
        altGen[j] = gen
        altG[j] = ng
        altPrev[j] = i
        push({ i: j, f: ng + Math.hypot(tx - nx, ty - ny) })
      }
    }
  }
  if (altGen[to] !== gen) return null
  const px = []
  for (let i = to; i !== -1; i = altPrev[i]) px.push([i % W, (i - i % W) / W])
  // 실제 길이는 불이익을 뺀 값으로 다시 잰다
  let real = 0
  for (let k = 1; k < px.length; k++) {
    real += Math.hypot(px[k][0] - px[k - 1][0], px[k][1] - px[k - 1][1])
  }
  return { px: px.reverse(), metres: real * MPP }
}

const routes = {}
const lens = []
const missing = []
for (const e of [...dongs.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const cx = e.xs / e.n, cy = e.ys / e.n
  const from = snap(cx, cy)
  const away = from < 0 ? Infinity
    : Math.hypot(from % W - cx, (from - from % W) / W - cy) * MPP
  if (away > MAX_ENTRANCE_M || !isFinite(dist[from])) {
    missing.push(`${e.key}${away > MAX_ENTRANCE_M ? ` (출입점 ${away.toFixed(0)} m)` : ''}`)
    continue
  }
  const px = []
  for (let i = from; i !== -1; i = next[i]) px.push([i % W, (i - i % W) / W])
  const metres = dist[from] * MPP
  const line = simplify(px, SIMPLIFY_M / MPP).map(([x, y]) => toLonLat(x + 0.5, y + 0.5))
  const alt = altRoute(from, start, px)
  let altOut = null
  if (alt) {
    const ratio = alt.metres / metres
    // 최단과 거의 같은 길이거나, 터무니없이 돌면 두 번째 길이라 할 수 없다
    if (ratio > 1 + ALT_MIN_DIFF && ratio <= ALT_MAX_RATIO) {
      altOut = {
        metres: Math.round(alt.metres),
        seconds: Math.round(alt.metres / SPEED_MPS),
        line: simplify(alt.px, SIMPLIFY_M / MPP).map(([x, y]) => toLonLat(x + 0.5, y + 0.5)),
      }
    }
  }
  routes[e.key] = {
    dong: e.dong,
    metres: Math.round(metres),
    seconds: Math.round(metres / SPEED_MPS),
    line,
    alt: altOut,
  }
  lens.push(metres)
}

lens.sort((a, b) => a - b)
if (!lens.length) {
  console.error(`목적지(${TARGET.name})에서 갈 수 있는 동이 하나도 없다 - `
    + '보행망이 끊겼는지 보라')
  process.exit(1)
}
console.log(`동 ${lens.length}개 - 거리 최소 ${lens[0].toFixed(0)} m / `
  + `중앙 ${lens[lens.length >> 1].toFixed(0)} m / 최대 ${lens[lens.length - 1].toFixed(0)} m`)
if (missing.length) console.log(`보행망에 안 닿는 동 ${missing.length}개: ${missing.join(', ')}`)

writeFileSync(join(ROOT, 'web/src/data/routes.json'), JSON.stringify({
  to: TARGET,
  speedMps: SPEED_MPS,
  crossingWaitS: CROSS_WAIT_S,
  note: '도보 경로는 카카오 렌더에서 뽑은 보행 마스크 위의 최단 경로다. '
    + '분양 광고의 역세권 도보 시간(직선거리 80 m/분)과 다를 수 있다.',
  routes,
}, null, 1))
console.log(`web/src/data/routes.json  ${Object.keys(routes).length}개 동`)
if (missing.length) process.exit(1)
