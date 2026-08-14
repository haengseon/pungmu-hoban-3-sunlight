// Real-3D building + shadow layer, drawn into MapLibre's own GL context.
//
// The scene lives in a local ENU frame (x east, y north, z up, all in metres)
// centred on the dataset origin. A single model matrix lifts that frame into
// MapLibre's mercator world, so nothing here has to know how the map projects -
// MercatorCoordinate.meterInMercatorCoordinateUnits() is the whole conversion.
//
// Shadows are a depth map from a directional light aimed along the sun vector.
// That replaces the old affine sweep: walls, roofs and the ground all receive
// from the same pass, and a building now shadows itself.
import * as THREE from 'three'
import { MercatorCoordinate } from 'maplibre-gl'
import { sunVector } from './sun.js'

const FLOOR_H = 2.9
const D2R = Math.PI / 180

const WALL = 0xe9ecf1
const ROOF = 0xf4f5f7
const EDGE = 0x7f8894 // 동 실루엣 - 이게 없으면 이웃한 동이 한 덩어리로 보인다
const FLOOR_LINE = 0xa9b0bc
const NIGHT = 0xccd2da

const SEL_WALL = 0xffba98
const SEL_ROOF = 0xffd9c9
const SEL_EDGE = 0xd9451d
const SEL_FLOOR_LINE = 0xd9a58e

const BAND = 0xffffff
// 미개발 용지에 세운 예상 매스. 실측 건물과 반드시 구분돼야 하므로 색도 다르고
// 반투명이다 - 계획을 읽은 추정이지 측량이 아니다.
// 실측 동은 흰 콘크리트라 회색조로 나온다. 예상 매스가 같은 계열이면 구분이 안 되므로
// 아예 다른 색상환(청록)을 쓴다.
const PLANNED = 0x5fbfae

// 향에 따른 명암과 그림자의 깊이는 같은 한 개의 빛이 낸다.
// three 의 Lambert 는 출력 = albedo x (ambient + sun x NdotL) / PI 이므로 합이 PI 면
// 정면으로 받는 면이 재질 색 그대로 나오고, AMBIENT 만 남은 면은 그 0.72 배가 된다
// - 예전 렌더러의 CAST alpha 0.30 과 같은 깊이다. (측정: tools 의 오프스크린 리그)
const AMBIENT = 1.5
const SUN_I = Math.PI - AMBIENT
const GROUND_SHADOW = 0.34
// 그림자는 멀어질수록, 그리고 해가 낮을수록 흐려진다.
//
// 계산은 h/tan(고도) 라 고도가 0 에 가까우면 발산한다 - 겨울 8시(고도 1.9°)면 110 m
// 짜리가 3.3 km 를 드리운다. 계산 자체는 맞지만 현실은 다르다: 평평한 무한 지면이
// 아니고(사이의 건물·지형이 끊는다), 그 각도에서는 직사광이 대기를 길게 통과해
// 산란광이 지배하므로 뚜렷한 그늘이 생기지 않는다. 건축법 일조권도 동지 09~15시를
// 본다 - 8시 이전은 애초에 판단 구간이 아니다.
//
// 그래서 물리는 그대로 두고 **보이는 진하기만** 줄인다.
const FADE_NEAR = 0.35   // 그림자 길이의 이 지점까지는 그대로
const FADE_FAR = 1.0     // 끝에서 이만큼 남는다
const FADE_MIN = 0.12
// 해 뜨고 지는 앞뒤 30분쯤은 그림자를 그리지 않는다. 그 각도(4~5°)에서 계산대로면
// 110 m 짜리가 1.3 km 를 드리우는데, 실제로는 사이의 건물·지형이 끊고 직사광도
// 산란광에 묻혀 그런 그늘이 지지 않는다. 건축법이 보는 동지 09~15시는 11.4° 이상이라
// 판단 구간은 그대로 남는다.
const SHADOW_CUT_DEG = 4.5   // 30분치
const SHADOW_FADE_DEG = 6.5  // 여기까지 짧게 페이드해 툭 끊기지 않게

// 외곽선을 낼 때 이 각도 미만으로 꺾인 모서리는 무시한다. 트레이싱한 외곽선의
// 1도짜리 계단이 세로선 다발로 보이지 않게 한다.
const EDGE_ANGLE = 9

const SHADOW_SIZE = 4096
const SUN_DIST = 2000 // m; orthographic 이라 거리는 절두체 위치만 정한다

export class Buildings3D {
  /**
   * @param {import('maplibre-gl').Map} map
   * @param {{buildings: Array, lat0:number, lon0:number}} data
   */
  constructor(map, data) {
    this.map = map
    this.sun = { altitude: 45, azimuth: 180 }
    this.sel = null // {dong, complexId, floor}
    this.hidden = new Set() // "complexId|dong"

    // local ENU metres -> mercator.
    // x·y 만 메르카토르로 바꾼다. z 는 미터 그대로 둔다 - maplibre 의 MVP 는 높이를
    // 미터로 받는다 (행렬이 이미 픽셀/미터를 물고 있다). 여기서 z 까지 메르카토르로
    // 바꾸고 render 에서 월드픽셀 배율을 또 곱하면 높이에만 배율이 한 번 더 붙어,
    // 확대할수록 건물이 치솟고 축소하면 납작해진다.
    const o = MercatorCoordinate.fromLngLat([data.lon0, data.lat0], 0)
    const s = o.meterInMercatorCoordinateUnits()
    this.model = new THREE.Matrix4()
      .makeTranslation(o.x, o.y, o.z)
      .scale(new THREE.Vector3(s, -s, 1)) // mercator y grows south, z 는 미터
    const toLocal = ([lon, lat]) => {
      const m = MercatorCoordinate.fromLngLat([lon, lat], 0)
      return new THREE.Vector2((m.x - o.x) / s, -(m.y - o.y) / s)
    }

    this.scene = new THREE.Scene()
    this.camera = new THREE.Camera()
    this.camera.matrixAutoUpdate = false
    this.mvp = new THREE.Matrix4() // reused every frame
    this.zoomScale = new THREE.Matrix4()

    this.ambient = new THREE.AmbientLight(0xffffff, AMBIENT)
    this.scene.add(this.ambient)
    this.light = new THREE.DirectionalLight(0xffffff, SUN_I)
    this.light.castShadow = true
    this.light.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE)
    this.light.shadow.bias = -0.0004
    this.light.shadow.normalBias = 0.05
    this.scene.add(this.light)
    this.scene.add(this.light.target)

    this.mats = materials()
    this.volumes = []
    this.pickable = []
    const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, h: 0 }

    for (const b of data.buildings) {
      const ring = b.ring.map(toLocal)
      const shape = new THREE.Shape(ring)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false })

      for (const p of ring) {
        bbox.x0 = Math.min(bbox.x0, p.x)
        bbox.x1 = Math.max(bbox.x1, p.x)
        bbox.y0 = Math.min(bbox.y0, p.y)
        bbox.y1 = Math.max(bbox.y1, p.y)
      }
      bbox.h = Math.max(bbox.h, b.height)

      // ExtrudeGeometry groups: 0 = caps (roof + underside), 1 = side walls
      const mesh = new THREE.Mesh(
        geo,
        b.planned ? this.mats.planned : [this.mats.roof, this.mats.wall],
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData = { dong: b.dong, complexId: b.complexId, floors: b.floors }
      this.scene.add(mesh)

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, EDGE_ANGLE),
        b.planned ? this.mats.plannedEdge : this.mats.edge,
      )
      this.scene.add(outline)

      // 주택형 cells painted on the roof, straight off the 동·호 배치도. Unlit so
      // the colours stay exactly the legend's swatches.
      const cells = []
      for (const c of b.cells || []) {
        const cm = new THREE.Mesh(
          new THREE.ShapeGeometry(new THREE.Shape(c.ring.map(toLocal))),
          new THREE.MeshBasicMaterial({ color: c.color, transparent: true }),
        )
        cm.position.z = b.height + 0.05
        this.scene.add(cm)
        cells.push(cm)
      }

      const v = {
        mesh, outline, cells, shape, band: null,
        h: b.height, floors: b.floors, planned: b.planned,
        key: b.dong ? `${b.complexId}|${b.dong}` : null,
        dong: b.dong, complexId: b.complexId,
      }
      this.volumes.push(v)
      if (b.dong) this.pickable.push(mesh)
    }

    // the map itself is the ground; a ShadowMaterial plane lets the tiles show
    // through and only paints what the sun cannot reach. It is scaled per sun
    // position to exactly the area the shadow frustum covers - a receiver that
    // reaches outside the frustum samples the clamped edge of the depth map and
    // goes solid dark.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      groundShadowMaterial(),
    )
    this.ground.position.set((bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2, 0)
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
    this.bbox = bbox

    this.ray = new THREE.Raycaster()
    this.applySun()
    this.apply()

    this.layer = {
      id: 'buildings-3d',
      type: 'custom',
      renderingMode: '3d',
      onAdd: (m, gl) => this.onAdd(m, gl),
      render: (gl, args) => this.render(gl, args),
    }
    map.addLayer(this.layer)
  }

  onAdd(map, gl) {
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl })
    this.vw = 0 // three 에 마지막으로 알려 준 드로잉 버퍼 크기 (render 참고)
    this.vh = 0
    this.renderer.autoClear = false
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // the shadow map only depends on the sun and on which 동 are drawn, so it is
    // recomputed on those changes - never on a pan, zoom, rotate or tilt
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
  }

  render(gl, { modelViewProjectionMatrix }) {
    // three 는 생성 시점의 캔버스 크기를 붙들고 있고, 그림자 맵을 다시 굽는 프레임마다
    // 렌더타깃을 되돌리면서 그 크기로 뷰포트를 복원한다. 지도 영역 높이가 한 번이라도
    // 바뀌면(공지 닫기, 창 크기, 기기 회전) 그 프레임만 3D 가 어긋난 크기로 그려져
    // 화면이 깜빡인다 - 시각 슬라이더는 매 스텝 그림자를 다시 구우므로 끄는 내내 그렇다.
    // setSize 는 쓰면 안 된다. 캔버스 크기와 style 을 직접 건드려 MapLibre 의 리사이즈와
    // 서로 밀어낸다. setViewport 는 three 내부 값만 바꾼다.
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (w !== this.vw || h !== this.vh) {
      this.vw = w
      this.vh = h
      this.renderer.setViewport(0, 0, w, h)
    }

    // maplibre's MVP takes world pixels - mercator scaled by the world size at
    // the current zoom - so the metre -> mercator model matrix picks up that
    // factor here. Folding it in this way also keeps the combined matrix
    // centred near the origin, which is what saves the float32 precision.
    const ws = 512 * 2 ** this.map.getZoom()
    const cam = this.camera
    cam.projectionMatrix
      .fromArray(modelViewProjectionMatrix)
      .multiply(this.zoomScale.makeScale(ws, ws, 1))
      .multiply(this.model)
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert()
    this.renderer.resetState()
    this.renderer.clearDepth()
    this.renderer.render(this.scene, cam)
    this.renderer.resetState()
  }

  setSun(sun) {
    this.sun = sun
    this.applySun()
    this.invalidate(true)
  }

  /** @param {{dong:string, complexId:string, floor:number}|null} sel */
  setSelection(sel) {
    this.sel = sel
    this.apply()
    this.invalidate(false)
  }

  /**
   * 동 to leave undrawn, as "complexId|dong". They keep casting shadows - the
   * point is to look at what a 동 does to its neighbours without it in the way.
   * @param {Iterable<string>} keys
   */
  setHidden(keys) {
    this.hidden = new Set(keys)
    this.apply()
    this.invalidate(true)
  }

  /** topmost volume under a canvas-space point, or null */
  pickAt(x, y) {
    const canvas = this.map.getCanvas()
    const nx = (x / canvas.clientWidth) * 2 - 1
    const ny = 1 - (y / canvas.clientHeight) * 2
    const near = new THREE.Vector3(nx, ny, -1).applyMatrix4(this.camera.projectionMatrixInverse)
    const far = new THREE.Vector3(nx, ny, 1).applyMatrix4(this.camera.projectionMatrixInverse)
    this.ray.set(near, far.sub(near).normalize())
    for (const hit of this.ray.intersectObjects(this.pickable, false)) {
      const d = hit.object.userData
      if (!this.hidden.has(`${d.complexId}|${d.dong}`)) return d
    }
    return null
  }

  destroy() {
    if (this.map.getLayer('buildings-3d')) this.map.removeLayer('buildings-3d')
    this.scene.traverse((o) => {
      o.geometry?.dispose()
      for (const m of [o.material].flat()) m?.dispose?.()
    })
  }

  // ---- internals --------------------------------------------------------

  invalidate(shadow) {
    if (shadow && this.renderer) this.renderer.shadowMap.needsUpdate = true
    this.map.triggerRepaint()
  }

  /** aim the light along the sun vector and fit its frustum to the site */
  applySun() {
    const { altitude, azimuth } = this.sun
    const day = altitude > 0.5
    const v = sunVector(altitude, azimuth) // {x east, y up, z south}
    const dir = new THREE.Vector3(v.x, -v.z, v.y) // -> {x east, y north, z up}

    const { h } = this.bbox
    // how far the tallest building can throw. The cap is the old renderer's:
    // past ~14 building-heights the shadow is academic and the depth map would
    // be spread too thin to resolve anything.
    const reach = day ? Math.min(h / Math.tan(altitude * D2R), 14 * h) : 0
    const x0 = this.bbox.x0 - reach
    const x1 = this.bbox.x1 + reach
    const y0 = this.bbox.y0 - reach
    const y1 = this.bbox.y1 + reach
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    this.ground.scale.set(x1 - x0, y1 - y0, 1)
    this.ground.position.set(cx, cy, 0)
    // 감쇠는 그림자 길이에 맞춰 늘어난다. 해가 낮을수록 전체도 옅어진다.
    const u = this.ground.material.userData.u
    if (u) {
      const site = Math.max(this.bbox.x1 - this.bbox.x0, this.bbox.y1 - this.bbox.y0) / 2
      u.uCentre.value.set((this.bbox.x0 + this.bbox.x1) / 2, (this.bbox.y0 + this.bbox.y1) / 2)
      u.uNear.value = site + reach * FADE_NEAR
      u.uFar.value = site + reach * FADE_FAR
      u.uLow.value = day
        ? Math.max(0, Math.min(1, (altitude - SHADOW_CUT_DEG)
          / (SHADOW_FADE_DEG - SHADOW_CUT_DEG)))
        : 0
    }
    this.light.target.position.set(cx, cy, 0)
    this.light.target.updateMatrixWorld()
    this.light.position.set(cx, cy, 0).addScaledVector(dir, SUN_DIST)
    this.light.intensity = day ? SUN_I : 0
    // 지면 그림자를 안 그릴 만큼 낮으면 벽면·옥상 그림자도 같이 끈다
    this.light.castShadow = day && altitude > SHADOW_CUT_DEG
    // 해가 지면 방향광이 없으니 ambient 하나로 전체를 채운다 (합이 PI 여야 색이 재질
    // 색 그대로 나온다). 색만 NIGHT 로 바꿔 밤의 푸른 회색을 낸다.
    this.ambient.color.setHex(day ? 0xffffff : NIGHT)
    this.ambient.intensity = day ? AMBIENT : Math.PI

    // fit the orthographic shadow frustum to the eight corners of the site box,
    // measured in the light's own space - at a low sun that box is far wider
    // across the shadow bearing than the site is on the ground.
    // The light object itself carries no rotation; only its shadow camera is
    // aimed at the target, so the light-space frame has to come from there.
    const c = this.light.shadow.camera
    c.position.copy(this.light.position)
    c.lookAt(this.light.target.position)
    c.updateMatrixWorld()
    const p = new THREE.Vector3()
    const seen = new THREE.Box3()
    for (const x of [x0, x1]) {
      for (const y of [y0, y1]) {
        for (const z of [0, h]) {
          seen.expandByPoint(p.set(x, y, z).applyMatrix4(c.matrixWorldInverse))
        }
      }
    }
    c.left = seen.min.x - 5
    c.right = seen.max.x + 5
    c.bottom = seen.min.y - 5
    c.top = seen.max.y + 5
    c.near = Math.max(-seen.max.z - 5, 1) // camera space looks down -z
    c.far = -seen.min.z + 5
    c.updateProjectionMatrix()
  }

  /**
   * One place decides every volume's look from (selection, hidden). Hidden 동
   * draw nothing but keep their meshes in the shadow pass.
   */
  apply() {
    const sel = this.sel
    for (const v of this.volumes) {
      const on = !!sel && sel.dong === v.dong && sel.complexId === v.complexId
      const off = v.key ? this.hidden.has(v.key) : false
      // 예상 매스는 여기서도 실측 동 색으로 덮이면 안 된다 - 추정이라는 표시가
      // 선택 한 번에 사라져 버린다.
      v.mesh.material = off
        ? this.mats.ghost
        : on
          ? [this.mats.selRoof, this.mats.selWall]
          : v.planned
            ? this.mats.planned
            : [this.mats.roof, this.mats.wall]
      v.outline.material = on
        ? this.mats.selEdge
        : v.planned ? this.mats.plannedEdge : this.mats.edge
      v.outline.visible = !off
      for (const c of v.cells) {
        c.visible = !off
        c.material.opacity = on ? 0.7 : 1
      }
      this.setBand(v, !off && on && sel.floor ? sel.floor : 0)
    }
  }

  /** highlight one storey of a volume, clamped to what it actually has */
  setBand(v, floor) {
    if (v.band) {
      this.scene.remove(v.band)
      v.band.geometry.dispose()
      v.band = null
    }
    if (!floor || floor > v.floors) return
    const z0 = Math.min((floor - 1) * FLOOR_H, v.h)
    const z1 = Math.min(floor * FLOOR_H, v.h)
    if (z1 - z0 < 0.01) return
    const geo = new THREE.ExtrudeGeometry(v.shape, { depth: z1 - z0, bevelEnabled: false })
    v.band = new THREE.Mesh(geo, this.mats.band)
    v.band.position.z = z0
    this.scene.add(v.band)
  }
}

/**
 * 지면 그림자. ShadowMaterial 의 알파에 '중심에서 멀어질수록 옅어지는' 항을 곱한다.
 * uniform 세 개로 조절한다 - 중심, 감쇠 시작/끝 반경, 저각 보정.
 */
function groundShadowMaterial() {
  const m = new THREE.ShadowMaterial({ opacity: GROUND_SHADOW, depthWrite: false })
  m.userData.u = {
    uCentre: { value: new THREE.Vector2() },
    uNear: { value: 200 },
    uFar: { value: 800 },
    uLow: { value: 1 },
  }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, m.userData.u)
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', `varying vec2 vGround;
void main() {`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vGround = (modelMatrix * vec4(position, 1.0)).xy;`)
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', `varying vec2 vGround;
uniform vec2 uCentre;
uniform float uNear;
uniform float uFar;
uniform float uLow;
void main() {`)
      .replace(
        'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
        `float d = distance( vGround, uCentre );
  float f = mix( 1.0, ${FADE_MIN.toFixed(2)}, clamp( ( d - uNear ) / max( uFar - uNear, 1.0 ), 0.0, 1.0 ) );
  gl_FragColor = vec4( color, opacity * uLow * f * ( 1.0 - getShadowMask() ) );`,
      )
  }
  return m
}


function materials() {
  // push every solid a hair away from the camera so the silhouette lines sit on
  // top of it instead of fighting it, which is what made them look dashed
  const back = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }
  const wall = (color, line) =>
    new THREE.MeshLambertMaterial({ color: 0xffffff, map: stripe(color, line), ...back })
  return {
    wall: wall(WALL, FLOOR_LINE),
    roof: new THREE.MeshLambertMaterial({ color: ROOF, ...back }),
    selWall: wall(SEL_WALL, SEL_FLOOR_LINE),
    selRoof: new THREE.MeshLambertMaterial({ color: SEL_ROOF, ...back }),
    // 예상 매스. 실측이 아니라는 걸 재질로 말한다.
    planned: new THREE.MeshLambertMaterial({
      color: PLANNED, transparent: true, opacity: 0.72, ...back,
    }),
    edge: new THREE.LineBasicMaterial({ color: EDGE }),
    selEdge: new THREE.LineBasicMaterial({ color: SEL_EDGE }),
    plannedEdge: new THREE.LineBasicMaterial({ color: 0x2f7d6d }),
    // draws nothing, still casts: the 동 is out of the way but its shadow is not
    ghost: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    band: new THREE.MeshBasicMaterial({
      color: BAND,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  }
}

/**
 * One storey line every FLOOR_H metres, as a texture rather than geometry.
 * ExtrudeGeometry's side UVs are in world units, so v repeats exactly on the
 * storey pitch - and once a storey is thinner than a texel the mipmap chain
 * fades the lines out on its own, which is what the old "skip if under 2.6 px"
 * rule did by hand.
 */
function stripe(base, line) {
  const px = 64
  const c = document.createElement('canvas')
  c.width = 1
  c.height = px
  const g = c.getContext('2d')
  g.fillStyle = `#${base.toString(16).padStart(6, '0')}`
  g.fillRect(0, 0, 1, px)
  g.fillStyle = `#${line.toString(16).padStart(6, '0')}`
  g.fillRect(0, 0, 1, 1)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1, 1 / FLOOR_H)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
