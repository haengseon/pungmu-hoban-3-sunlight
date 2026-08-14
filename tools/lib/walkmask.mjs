// 보행 마스크를 읽어 쓸 수 있는 상태로 만들어 준다.
//
// 마스크는 사람이 브러시로 고치는 파일이라, 붓이 동 모서리를 살짝 덮는 일이 늘 생긴다.
// 그대로 두면 길찾기가 건물을 몇 픽셀 뚫고 지나간다. 그걸 사람이 찾아 지우게 하는 대신
// **읽을 때마다 건물 폴리곤만큼 깎아 낸다** - 건물 자리는 어차피 걸을 수 없고, 그 판단의
// 근거(폴리곤)는 이미 우리가 갖고 있다.
//
// 좌표 변환과 건물 읽기도 여기 모았다. check_walk 와 make_routes 가 같은 격자를 봐야
// 한쪽만 통과하는 일이 없다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const EARTH_C = 20037508.342789244

/** 벽에 딱 붙은 픽셀도 걸을 수 없다. 어깨 폭 + 트레이싱 오차만큼 넉넉히 뺀다. */
export const BUILDING_PAD_M = 1.5

export function loadWalk(root) {
  const meta = JSON.parse(readFileSync(join(root, 'web/src/data/walk.json'), 'utf8'))
  const png = PNG.sync.read(readFileSync(join(root, 'web/public/walk_mask.png')))
  const W = png.width, H = png.height
  if (W !== meta.width || H !== meta.height) {
    throw new Error(`마스크 ${W}x${H} 와 walk.json ${meta.width}x${meta.height} 가 다르다`)
  }
  const walk = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) walk[i] = png.data[i << 2] >= 128 ? 1 : 0

  // 캡처 affine 이 회전 없는 메르카토르 정렬이라 네 모서리만 있으면 선형이다
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
  return { meta, W, H, MPP: meta.metresPerPixel, walk, toPx, toLonLat }
}

/** 세 데이터 파일의 모든 동. 계단형이라 한 동이 볼륨 여럿일 수 있다. */
export function loadBuildings(root, toPx) {
  const out = []
  for (const f of ['buildings', 'context', 'offices']) {
    const doc = JSON.parse(readFileSync(join(root, `web/src/data/${f}.json`), 'utf8'))
    for (const c of doc.complexes) {
      for (const b of c.buildings) {
        const ring = b.poly.map(toPx)
        let xs = 0, ys = 0
        for (const [x, y] of ring) { xs += x; ys += y }
        out.push({
          id: `${c.id}|${b.dong}`, complex: c.id, dong: b.dong,
          ring, cx: xs / ring.length, cy: ys / ring.length,
        })
      }
    }
  }
  return out
}

const inside = (ring, x, y) => {
  let on = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) on = !on
  }
  return on
}

/** 건물이 선 자리를 마스크에서 깎아 낸다. 깎인 픽셀 수를 돌려준다. */
export function carveBuildings(walk, buildings, W, H, MPP) {
  const pad = BUILDING_PAD_M / MPP
  let cut = 0
  for (const b of buildings) {
    let x0 = W, y0 = H, x1 = 0, y1 = 0
    for (const [x, y] of b.ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x)
      y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    for (let y = Math.max(0, Math.floor(y0 - pad)); y < Math.min(H, Math.ceil(y1 + pad)); y++) {
      for (let x = Math.max(0, Math.floor(x0 - pad)); x < Math.min(W, Math.ceil(x1 + pad)); x++) {
        const i = y * W + x
        if (!walk[i]) continue
        // 여유만큼 부풀린 판정 - 폴리곤 안이거나 변에서 pad 안쪽이면 뺀다
        if (inside(b.ring, x + 0.5, y + 0.5) || nearEdge(b.ring, x + 0.5, y + 0.5, pad)) {
          walk[i] = 0
          cut++
        }
      }
    }
  }
  return cut
}

function nearEdge(ring, x, y, pad) {
  const p2 = pad * pad
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    let t = ((x - ax) * dx + (y - ay) * dy) / len2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x - (ax + dx * t), ey = y - (ay + dy * t)
    if (ex * ex + ey * ey <= p2) return true
  }
  return false
}

/** 걸을 수 있는 면을 성분으로 나눈다. 가장 큰 것이 주 보행망이다. */
export function components(walk, W, H) {
  const comp = new Int32Array(W * H).fill(-1)
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
  return { comp, sizes, main: sizes.indexOf(Math.max(...sizes)) }
}
