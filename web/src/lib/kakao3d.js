// Pseudo-3D building + shadow layer drawn on a canvas locked to a Kakao map.
//
// Footprints stay exactly on the map (they are traced from the basemap's own
// 건축물 polygons), and each one is lifted along a fixed oblique screen vector, so
// what rises out of the map is the true plan shape at true height.
//
// Because the lift is a *fixed screen vector*, the whole world -> screen map is
// affine, which is what makes the shadows cheap: the shadow a prism throws on any
// plane is the plane-projection of its footprint swept by one constant screen
// offset. The same routine therefore draws the shadow on the ground, on a
// neighbour's roof and up a neighbour's wall - the only thing that changes is
// which plane is being projected onto.

const EARTH_C = 20037508.342789244
const D2R = Math.PI / 180

const mercX = (lon) => (lon * EARTH_C) / 180
const mercY = (lat) => (Math.log(Math.tan((90 + lat) * D2R * 0.5)) * EARTH_C) / Math.PI

// oblique lift: mostly straight up with a slight lean
const LEAN = 0.14
const VSCALE = 0.92 // vertical exaggeration; 1.0 == true metric height
const FLOOR_H = 2.9

// consecutive footprint edges within this angle are one flat wall, so a traced
// outline does not turn into a row of creases
const FACE_TOL = Math.cos(9 * D2R)
const SHADOW_TOL_M = 1.5 // footprint detail below this is dropped when casting
const LOW_M = 12 // 근린생활시설(2층) 과 주동을 가르는 높이

const ROOF = '#f4f5f7'
const EDGE = '#7f8894' // 동 실루엣 - 이게 없으면 이웃한 동이 한 덩어리로 보인다
const CELL_EDGE = 'rgba(70,78,90,0.55)'
const FLOOR_LINE = 'rgba(108,118,134,0.26)'
const SEL_FLOOR_LINE = 'rgba(150,52,20,0.36)'
// 향에 따른 명암은 얕게. 벽이 어두워서가 아니라 그림자가 덮어서 어두운 것이
// 읽혀야 한다.
const LIT = [234, 237, 241]
const SHADE = [199, 206, 215]
const NIGHT = '#ccd2da'
const CAST = 'rgba(46,58,78,0.30)'

// selected 동
const SEL_ROOF = '#ffd9c9'
const SEL_EDGE = '#d9451d'
const SEL_LIT = [255, 186, 152]
const SEL_SHADE = [242, 148, 112]
// selected 층 band
const BAND = 'rgba(255,255,255,0.92)'
const BAND_EDGE = '#d9451d'

export class Buildings3D {
  /**
   * @param {kakao.maps.Map} map
   * @param {HTMLElement} host  the element the map is rendered into
   * @param {{buildings: Array, lat0:number, lon0:number}} data
   */
  constructor(map, host, data) {
    this.map = map
    this.host = host
    this.sun = { altitude: 45, azimuth: 180 }
    this.sel = null // {dong, complexId, floor}
    this.hidden = new Set() // "complexId|dong" - not drawn, but still casts

    // pre-project every vertex into Web Mercator once; per frame we only need
    // the (affine) mercator -> container transform, which costs two lookups
    // 1 mercator unit is cos(lat) ground metres, so a metric tolerance for the
    // shadow silhouette is a fixed number of mercator units here
    const perM = 1 / Math.cos(data.lat0 * D2R)
    this.items = data.buildings.map((b, i) => {
      const mx = []
      const my = []
      for (const [lon, lat] of b.ring) {
        mx.push(mercX(lon))
        my.push(mercY(lat))
      }
      // Shadows are cast from a coarser outline than the one that is drawn: a
      // 1 m notch in a footprint is invisible in its shadow but doubles the
      // work, and casting is the only quadratic part of a frame.
      const keep = simplify(mx, my, SHADOW_TOL_M * perM)
      // 주택형 cells painted on the roof, straight off the 동·호 배치도
      const cells = (b.cells || []).map((c) => ({
        color: c.color,
        mx: c.ring.map(([lon]) => mercX(lon)),
        my: c.ring.map(([, lat]) => mercY(lat)),
      }))
      return {
        id: i, mx, my, n: mx.length, keep, kn: keep.length, cells,
        h: b.height, floors: b.floors, dong: b.dong, complexId: b.complexId,
      }
    })
    this.lat0 = data.lat0

    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3',
    })
    host.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')
    this.shadow = document.createElement('canvas')
    this.sctx = this.shadow.getContext('2d')

    this.refA = new kakao.maps.LatLng(data.lat0, data.lon0)
    this.refB = new kakao.maps.LatLng(data.lat0 + 0.01, data.lon0 + 0.01)
    this.mA = { x: mercX(data.lon0), y: mercY(data.lat0) }
    this.mB = { x: mercX(data.lon0 + 0.01), y: mercY(data.lat0 + 0.01) }
    // true ground separation of the two reference points, straight from the SDK,
    // so heights and shadow lengths never depend on assuming a map projection
    this.refGroundM = new kakao.maps.Polyline({ path: [this.refA, this.refB] }).getLength()

    // the projection constants, so tooling can reproduce the screen mapping
    this.LEAN = LEAN
    this.VSCALE = VSCALE
    this.FLOOR_H = FLOOR_H

    this.hit = [] // per-volume screen silhouette, rebuilt every draw, for picking
    this.flat = false
    this.dirty = true
    this.prev = ''
    this.tick = this.tick.bind(this)
    this.raf = requestAnimationFrame(this.tick)
  }

  setSun(sun) {
    this.sun = sun
    this.dirty = true
  }

  /** @param {{dong:string, complexId:string, floor:number}|null} sel */
  setSelection(sel) {
    this.sel = sel
    this.dirty = true
  }

  /**
   * 동 to leave undrawn, as "complexId|dong". They keep casting shadows - the
   * point is to look at what a 동 does to its neighbours without it in the way.
   * @param {Iterable<string>} keys
   */
  setHidden(keys) {
    this.hidden = new Set(keys)
    this.dirty = true
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.canvas.remove()
  }

  /** mercator -> container px, derived from two projected reference points */
  transform() {
    const proj = this.map.getProjection()
    const pa = proj.containerPointFromCoords(this.refA)
    const pb = proj.containerPointFromCoords(this.refB)
    return {
      ox: pa.x, oy: pa.y,
      sx: (pb.x - pa.x) / (this.mB.x - this.mA.x),
      sy: (pb.y - pa.y) / (this.mB.y - this.mA.y),
      pxPerMetre: Math.hypot(pb.x - pa.x, pb.y - pa.y) / this.refGroundM,
    }
  }

  /** topmost volume under a container-space point, or null */
  pickAt(x, y) {
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const h = this.hit[i]
      for (const poly of h.polys) {
        if (pointInPoly(poly, x, y)) {
          return { dong: h.dong, complexId: h.complexId, floors: h.floors }
        }
      }
    }
    return null
  }

  resize() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    const dpr = Math.min(devicePixelRatio || 1, 2)
    if (this.cw === w && this.ch === h && this.dpr === dpr) return false
    this.cw = w
    this.ch = h
    this.dpr = dpr
    for (const c of [this.canvas, this.shadow]) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    return true
  }

  tick() {
    this.raf = requestAnimationFrame(this.tick)
    if (!this.host.clientWidth) return
    const changed = this.resize()
    const t = this.transform()
    const key = `${t.ox.toFixed(2)},${t.oy.toFixed(2)},${t.sx.toExponential(6)}`
    if (!changed && !this.dirty && key === this.prev) return
    this.prev = key
    this.dirty = false
    this.draw(t)
  }

  draw(t) {
    const { ctx, sctx, dpr, cw, ch } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    sctx.clearRect(0, 0, cw, ch)
    this.hit = []

    const ppm = t.pxPerMetre
    const { altitude, azimuth } = this.sun
    const daytime = altitude > 0.5
    const sel = this.sel

    // flat = footprints only, used to check bases against the basemap outlines
    const lift = this.flat ? 0 : VSCALE * ppm
    const lx = LEAN * lift
    const ly = -lift

    // ground displacement per metre of height, along the sun's shadow bearing
    let shx = 0
    let shy = 0
    if (daytime) {
      const reach = Math.min(1 / Math.tan(altitude * D2R), 14) * ppm
      const b = (azimuth + 180) * D2R
      shx = Math.sin(b) * reach
      shy = -Math.cos(b) * reach
    }
    const casting = daytime && Math.hypot(shx, shy) > 0.3

    const vis = []
    for (const it of this.items) {
      const gx = new Float64Array(it.n)
      const gy = new Float64Array(it.n)
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (let i = 0; i < it.n; i++) {
        const x = t.ox + (it.mx[i] - this.mA.x) * t.sx
        const y = t.oy + (it.my[i] - this.mA.y) * t.sy
        gx[i] = x
        gy[i] = y
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      const pad = it.h * lift + 60
      if (x1 < -pad || x0 > cw + pad || y1 < -pad || y0 > ch + pad) continue
      // screen winding decides the sign of the outward normal; deriving it per
      // building keeps the wall culling correct whatever the source ordering is.
      // With a positive shoelace area the interior lies to the left of travel, so
      // "outward" is to the right of it - (ey, -ex), i.e. -(-ey, ex).
      let a = 0
      for (let i = 0; i < it.n; i++) {
        const j = (i + 1) % it.n
        a += gx[i] * gy[j] - gx[j] * gy[i]
      }
      const sgn = a >= 0 ? -1 : 1
      const dx = shx * it.h
      const dy = shy * it.h
      const kx = new Float64Array(it.kn)
      const ky = new Float64Array(it.kn)
      for (let i = 0; i < it.kn; i++) {
        kx[i] = gx[it.keep[i]]
        ky[i] = gy[it.keep[i]]
      }
      vis.push({
        it, gx, gy, sgn, kx, ky,
        off: it.dong ? this.hidden.has(`${it.complexId}|${it.dong}`) : false,
        box: [x0, y0, x1, y1],
        // where anything this building casts can possibly land
        cast: [Math.min(x0, x0 + dx), Math.min(y0, y0 + dy),
          Math.max(x1, x1 + dx), Math.max(y1, y1 + dy)],
        faces: buildFaces(gx, gy, it.n, sgn),
      })
    }

    // ---- ground shadow: its own layer so overlaps don't compound -----------
    if (casting) {
      sctx.fillStyle = '#000'
      const p = new Path2D()
      for (const { it, kx, ky } of vis) sweep(p, kx, ky, it.kn, shx * it.h, shy * it.h)
      sctx.fill(p, 'nonzero')
      ctx.save()
      ctx.globalAlpha = 0.34
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(this.shadow, 0, 0)
      ctx.restore()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // ---- buildings, far to near -------------------------------------------
    // Low blocks go down first, whatever their depth key says. A 2층 상가 is only
    // ~9 m of screen height, so putting it behind a tower costs at most a thin
    // band - whereas a long L-shaped 상가 reaches far enough south to sort last
    // and then paint over the tower standing behind its northern arm.
    vis.sort((a, b) => (a.it.h > LOW_M) - (b.it.h > LOW_M) || baseY(a) - baseY(b))
    const eps = 0.5 * ppm // a face never shadows itself
    for (const v of vis) {
      if (v.off) continue // hidden: already counted in the shadow passes above
      const { it, gx, gy, faces } = v
      const on = !!sel && sel.dong === it.dong && sel.complexId === it.complexId
      const hx = it.h * lx
      const hy = it.h * ly
      const tall = it.h * lift > 14
      const polys = []

      // who can reach this building at all
      const occ = casting
        ? vis.filter((o) => o !== v && overlaps(o.cast, v.box))
        : []

      // band for the selected floor, clamped to what this volume actually has.
      // One storey is barely a pixel when zoomed out, so keep a floor readable
      // at any scale while staying true to height once zoomed in.
      let band = null
      if (on && sel.floor && sel.floor <= it.floors) {
        const z0 = Math.min((sel.floor - 1) * this.FLOOR_H, it.h) * lift
        const z1 = Math.min(sel.floor * this.FLOOR_H, it.h) * lift
        const mid = (z0 + z1) / 2
        const half = Math.max((z1 - z0) / 2, 1.8)
        band = [mid - half, mid + half]
      }

      // floor lines: only as dense as the zoom can actually show
      const pitch = this.FLOOR_H * lift
      const every = pitch >= 2.6 ? 1 : pitch >= 1.0 ? Math.ceil(2.6 / pitch) : 0

      // in an oblique lift only the faces turned towards the viewer show
      const shown = faces.map((f) => f.nx * lx + f.ny * ly <= 0)
      for (let fi = 0; fi < faces.length; fi++) {
        const f = faces[fi]
        if (!shown[fi]) continue
        const chain = f.chain
        const m = chain.length
        const wall = []
        let fx0 = Infinity
        let fx1 = -Infinity
        let fy0 = Infinity
        let fy1 = -Infinity
        for (let i = 0; i < m; i++) {
          const x = gx[chain[i]]
          const y = gy[chain[i]]
          wall.push([x, y])
          if (x < fx0) fx0 = x
          if (x > fx1) fx1 = x
          if (y < fy0) fy0 = y
          if (y > fy1) fy1 = y
        }
        for (let i = m - 1; i >= 0; i--) wall.push([gx[chain[i]] + hx, gy[chain[i]] + hy])
        polys.push(wall)

        path(ctx, wall)
        ctx.fillStyle = wallTone(f.nx, f.ny, azimuth, daytime, on)
        ctx.fill()

        // ---- what other buildings throw onto this wall --------------------
        const denom = f.nx * shx + f.ny * shy
        if (occ.length && denom < -1e-6) {
          const ax = (gx[chain[0]] + gx[chain[m - 1]]) / 2
          const ay = (gy[chain[0]] + gy[chain[m - 1]]) / 2
          const fbox = [fx0, fy0, fx1, fy1]
          const p = new Path2D()
          let any = false
          for (const o of occ) {
            if (!overlaps(o.cast, fbox)) continue
            any = castOnPlane(p, o, ax, ay, f.nx, f.ny, denom, shx, shy, lx, ly, eps) || any
          }
          if (any) {
            ctx.save()
            path(ctx, wall)
            ctx.clip()
            ctx.fillStyle = CAST
            ctx.fill(p, 'nonzero')
            ctx.restore()
          }
        }

        // ---- storey lines instead of the old wall outlines ----------------
        if (every && tall) {
          ctx.strokeStyle = on ? SEL_FLOOR_LINE : FLOOR_LINE
          ctx.lineWidth = 0.7
          ctx.beginPath()
          for (let k = every; k * this.FLOOR_H < it.h; k += every) {
            const z = k * this.FLOOR_H
            ctx.moveTo(gx[chain[0]] + z * lx, gy[chain[0]] + z * ly)
            for (let i = 1; i < m; i++) {
              ctx.lineTo(gx[chain[i]] + z * lx, gy[chain[i]] + z * ly)
            }
          }
          ctx.stroke()
        }

        if (band) {
          const [b0, b1] = band
          const q = []
          for (let i = 0; i < m; i++) q.push([gx[chain[i]] + LEAN * b0, gy[chain[i]] - b0])
          for (let i = m - 1; i >= 0; i--) {
            q.push([gx[chain[i]] + LEAN * b1, gy[chain[i]] - b1])
          }
          path(ctx, q)
          ctx.fillStyle = BAND
          ctx.fill()
          ctx.strokeStyle = BAND_EDGE
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }

      // ---- silhouette: where the mass meets the ground and where it folds ---
      // Neighbouring 동 are the same tone, so without an outline 407 and 408 read
      // as one grey block. The outline is the base chain of the walls that face
      // the viewer plus a vertical wherever that chain breaks off.
      ctx.strokeStyle = on ? SEL_EDGE : EDGE
      ctx.lineWidth = on ? 1.4 : 1
      ctx.beginPath()
      const nf = faces.length
      for (let s = 0; s < nf; s++) {
        if (!shown[s] || shown[(s - 1 + nf) % nf]) continue // not a chain start
        const chain = []
        for (let k = s; shown[k]; k = (k + 1) % nf) {
          for (const v of faces[k].chain) {
            if (chain[chain.length - 1] !== v) chain.push(v)
          }
          if ((k + 1) % nf === s) break
        }
        ctx.moveTo(gx[chain[0]], gy[chain[0]])
        for (let i = 1; i < chain.length; i++) ctx.lineTo(gx[chain[i]], gy[chain[i]])
        for (const v of [chain[0], chain[chain.length - 1]]) {
          ctx.moveTo(gx[v], gy[v])
          ctx.lineTo(gx[v] + hx, gy[v] + hy)
        }
      }
      ctx.stroke()

      const roof = []
      for (let i = 0; i < it.n; i++) roof.push([gx[i] + hx, gy[i] + hy])
      polys.push(roof)
      path(ctx, roof)
      ctx.fillStyle = on ? SEL_ROOF : ROOF
      ctx.fill()

      // 주택형별 색과 라인을 옥상에 그대로 얹는다 (동·호 배치도와 같은 범례)
      for (const c of it.cells) {
        const q = []
        for (let i = 0; i < c.mx.length; i++) {
          q.push([t.ox + (c.mx[i] - this.mA.x) * t.sx + hx,
            t.oy + (c.my[i] - this.mA.y) * t.sy + hy])
        }
        path(ctx, q)
        ctx.fillStyle = c.color
        ctx.globalAlpha = on ? 0.7 : 1
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = CELL_EDGE
        ctx.lineWidth = 0.7
        ctx.stroke()
      }

      path(ctx, roof)
      ctx.strokeStyle = on ? SEL_EDGE : EDGE
      ctx.lineWidth = on ? 1.4 : 1
      ctx.stroke()

      // ---- and what lands on the roof -------------------------------------
      if (occ.length) {
        const p = new Path2D()
        let any = false
        for (const o of occ) {
          if (o.it.h <= it.h + 0.1) continue
          const d = o.it.h - it.h
          sweep(p, o.kx, o.ky, o.it.kn, shx * d, shy * d, hx, hy)
          any = true
        }
        if (any) {
          ctx.save()
          path(ctx, roof)
          ctx.clip()
          ctx.fillStyle = CAST
          ctx.fill(p, 'nonzero')
          ctx.restore()
        }
      }

      this.hit.push({ dong: it.dong, complexId: it.complexId, floors: it.floors, polys })
    }
  }
}

/** consecutive edges that point the same way are one wall */
function buildFaces(gx, gy, n, sgn) {
  const nx = new Float64Array(n)
  const ny = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ex = gx[j] - gx[i]
    const ey = gy[j] - gy[i]
    const L = Math.hypot(ex, ey) || 1
    nx[i] = (-ey / L) * sgn
    ny[i] = (ex / L) * sgn
  }
  // start at a real corner so a face is never split across the ring's seam
  let start = 0
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n
    if (nx[i] * nx[p] + ny[i] * ny[p] < FACE_TOL) {
      start = i
      break
    }
  }
  const faces = []
  let cur = null
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (cur && nx[i] * cur.nx + ny[i] * cur.ny >= FACE_TOL) {
      cur.chain.push((i + 1) % n)
      cur.sx += nx[i]
      cur.sy += ny[i]
      const L = Math.hypot(cur.sx, cur.sy) || 1
      cur.nx = cur.sx / L
      cur.ny = cur.sy / L
    } else {
      cur = { chain: [i, (i + 1) % n], nx: nx[i], ny: ny[i], sx: nx[i], sy: ny[i] }
      faces.push(cur)
    }
  }
  return faces
}

/**
 * Add the shadow `o` throws on one vertical plane to `p`.
 *
 * The plane holds the receiving wall: it passes through (ax, ay) with horizontal
 * outward normal (nx, ny). Every occluder vertex slides down the sun ray until it
 * meets that plane; because raising a point by h is a constant screen offset, the
 * prism's whole shadow is that projected footprint swept by h.
 */
function castOnPlane(p, o, ax, ay, nx, ny, denom, shx, shy, lx, ly, eps) {
  const gx = o.kx
  const gy = o.ky
  const n = o.it.kn
  // only the part of the occluder on the sunny side of the plane can cast; the
  // eps margin drops the receiving wall's own footprint, which would otherwise
  // project onto itself and paint the whole wall black
  const cx = []
  const cy = []
  let px = gx[n - 1]
  let py = gy[n - 1]
  let pd = nx * (px - ax) + ny * (py - ay) - eps
  for (let i = 0; i < n; i++) {
    const qx = gx[i]
    const qy = gy[i]
    const qd = nx * (qx - ax) + ny * (qy - ay) - eps
    if (qd >= 0) {
      if (pd < 0) {
        const u = pd / (pd - qd)
        cx.push(px + u * (qx - px))
        cy.push(py + u * (qy - py))
      }
      cx.push(qx)
      cy.push(qy)
    } else if (pd >= 0) {
      const u = pd / (pd - qd)
      cx.push(px + u * (qx - px))
      cy.push(py + u * (qy - py))
    }
    px = qx
    py = qy
    pd = qd
  }
  const m = cx.length
  if (m < 3) return false
  const bx = new Float64Array(m)
  const by = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    const s = -(nx * (cx[i] - ax) + ny * (cy[i] - ay)) / denom
    bx[i] = cx[i] + s * shx - s * lx
    by[i] = cy[i] + s * shy - s * ly
  }
  sweep(p, bx, by, m, o.it.h * lx, o.it.h * ly)
  return true
}

/**
 * Union of a ring, the same ring offset by (dx, dy), and the quads between them -
 * i.e. the ring swept along that offset. Every sub-polygon is wound the same way
 * so a single nonzero fill unions them instead of punching holes.
 */
function sweep(p, gx, gy, n, dx, dy, ox = 0, oy = 0) {
  let a = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += gx[i] * gy[j] - gx[j] * gy[i]
  }
  const step = a >= 0 ? 1 : -1
  const at = (k) => (step > 0 ? k % n : (n - (k % n)) % n)
  for (const [sx, sy] of [[ox, oy], [ox + dx, oy + dy]]) {
    p.moveTo(gx[at(0)] + sx, gy[at(0)] + sy)
    for (let k = 1; k < n; k++) p.lineTo(gx[at(k)] + sx, gy[at(k)] + sy)
    p.closePath()
  }
  if (dx === 0 && dy === 0) return
  for (let k = 0; k < n; k++) {
    const i = at(k)
    const j = at(k + 1)
    const ex = gx[j] - gx[i]
    const ey = gy[j] - gy[i]
    const q = ex * dy - ey * dx >= 0
      ? [[gx[i], gy[i]], [gx[j], gy[j]], [gx[j] + dx, gy[j] + dy], [gx[i] + dx, gy[i] + dy]]
      : [[gx[i], gy[i]], [gx[i] + dx, gy[i] + dy], [gx[j] + dx, gy[j] + dy], [gx[j], gy[j]]]
    p.moveTo(q[0][0] + ox, q[0][1] + oy)
    for (let z = 1; z < 4; z++) p.lineTo(q[z][0] + ox, q[z][1] + oy)
    p.closePath()
  }
}

/** Douglas-Peucker on a closed ring; returns the indices worth keeping */
function simplify(xs, ys, tol) {
  const n = xs.length
  if (n < 5) return [...xs.keys()]
  // split at the two most distant vertices so the ring becomes two open chains
  let a = 0
  let b = 0
  let far = -1
  for (let i = 1; i < n; i++) {
    const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2
    if (d > far) {
      far = d
      b = i
    }
  }
  const keep = new Set([a, b])
  const chain = (i0, i1) => {
    const stack = [[i0, i1]]
    while (stack.length) {
      const [s, e] = stack.pop()
      if (e - s < 2) continue
      const x0 = xs[s % n]
      const y0 = ys[s % n]
      const dx = xs[e % n] - x0
      const dy = ys[e % n] - y0
      const L = Math.hypot(dx, dy) || 1
      let worst = -1
      let at = -1
      for (let i = s + 1; i < e; i++) {
        const d = Math.abs((xs[i % n] - x0) * dy - (ys[i % n] - y0) * dx) / L
        if (d > worst) {
          worst = d
          at = i
        }
      }
      if (worst > tol) {
        keep.add(at % n)
        stack.push([s, at], [at, e])
      }
    }
  }
  chain(a, b)
  chain(b, a + n)
  return [...keep].sort((p, q) => p - q)
}

function overlaps(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

function path(c, pts) {
  c.beginPath()
  c.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1])
  c.closePath()
}

function pointInPoly(pts, x, y) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function baseY({ gy, it }) {
  let m = -Infinity
  for (let i = 0; i < it.n; i++) if (gy[i] > m) m = gy[i]
  return m
}

/** wall brightness from how squarely the face meets the sun */
function wallTone(nx, ny, azimuth, daytime, selected) {
  const lit = selected ? SEL_LIT : LIT
  const shade = selected ? SEL_SHADE : SHADE
  if (!daytime) return selected ? `rgb(${shade.join(',')})` : NIGHT
  // screen: +x east, -y north; the sun sits at its azimuth bearing
  const b = azimuth * D2R
  const d = nx * Math.sin(b) + ny * -Math.cos(b) // 1 == square-on to the sun
  const k = Math.max(0, d) ** 0.6 // ambient floor, then a soft falloff
  return `rgb(${Math.round(shade[0] + (lit[0] - shade[0]) * k)},${
    Math.round(shade[1] + (lit[1] - shade[1]) * k)},${
    Math.round(shade[2] + (lit[2] - shade[2]) * k)})`
}
