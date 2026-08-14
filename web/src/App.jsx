import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapLibre, Marker, NavigationControl } from 'maplibre-gl'
import doc from './data/buildings.json'
import context from './data/context.json'
import offices from './data/offices.json'
import walkRoutes from './data/routes.json'
import ground from './data/ground.json'
import groundWide from './data/ground_wide.json'
import { Buildings3D } from './lib/buildings3d.js'
import { orbitGestures } from './lib/gestures.js'
import Help, { helpSeen } from './Help.jsx'
import { solarPosition } from './lib/sun.js'

const VWORLD_KEY = import.meta.env.VITE_VWORLD_KEY

// 토지이용계획도에서 뜬 용지별 색. 3D 건물이 주인공이라 채도를 낮추고 옅게 깐다 -
// 지도가 아니라 '어떤 자리인지'만 읽히면 된다.
const USE_COLOR = {
  공원: '#3f9e5a', 어린이공원: '#4faa62', 녹지: '#8fc06a', 상업용지: '#e2564a',
  복합용지: '#e08a72', 업무용지: '#5b8fd6', 준주거용지: '#e0b641',
  단독주택용지: '#d6c98a', '블록형 단독주택용지': '#d6c98a',
  공동주택용지: '#e09a3c', 학교: '#4bb8c4',
  중학교: '#4bb8c4', 초등학교: '#4bb8c4', 유치원: '#4bb8c4',
  '병원 및 대학': '#4bb8c4', 수변공원: '#3f9e5a', 소공원: '#4faa62',
  광장: '#3f9c98', 주차장: '#9aa3ad',
  공공공지: '#9c8a5e', 공공청사: '#4a7fd6', 유수지: '#4aa8d6',
  사우동성당: '#b070c8', 노유자시설: '#7a7ad6',
}
// 라벨을 달 만한 크기와, 이미 3D로 서 있어 굳이 안 적어도 되는 용지.
// 광장·어린이공원은 원래 작게 잡히는 용지라 같은 잣대로 자르면 통째로 사라진다.
const LABEL_MIN_M2 = 3000
const LABEL_MIN_SMALL = new Set([
  '광장', '어린이공원', '소공원', '유치원', '공공공지', '공공청사', '사우동성당',
])
const LABEL_MIN_M2_SMALL = 800
const LABEL_SKIP = new Set(['도시개발구역', '공동주택용지', '녹지'])
// 지도 위에서는 '~용지' 를 떼고 부른다. 좁은 화면에서 이름표가 길면 서로 겹쳐
// 정작 어느 땅인지 안 읽힌다. 색과 자리로 이미 용지인 걸 알 수 있다.
const LABEL_ALIAS = { '블록형 단독주택용지': '블록형단독' }
const labelOf = (use) => LABEL_ALIAS[use] || use.replace(/용지$/, '')
// 노을에서 밤까지. 고도가 DUSK_FROM 아래로 내려가면 어두워지기 시작해 DUSK_TO 에서
// 가장 어둡다 (겨울 18시가 -8.3°).
const DUSK_FROM = 6
const DUSK_TO = -8
const EMPTY = { type: 'FeatureCollection', features: [] }

// 걷는 수고는 거리에서만 뽑는다. 이 지구는 표고 7~9 m 라 사실상 평지여서 경사가
// 끼어들 자리가 없다. 숫자만 보여주면 감이 안 오므로 등급으로도 말해 준다.
const EFFORT = [[5, '가깝다'], [10, '걸을 만하다'], [15, '조금 멀다'], [Infinity, '멀다']]
const effortOf = (min) => EFFORT.find(([m]) => min <= m)[1]

const WALKER_MS = 3600  // 진행 점이 경로를 한 번 완주하는 시간
const COMET_SPAN = 0.18 // 흐르는 빛이 경로에서 차지하는 길이

const PITCH = 45 // 열자마자 3D 인 게 보일 만큼은 눕히되, 그림자 바닥은 계속 읽히게
// 위쪽은 넉넉하게: 기울인 화면에서 29층 타워는 자기 푸트프린트보다 한참 위까지 솟는다
const PAD = { top: 80, bottom: 24, left: 24, right: 24 }
// 기울이면 앞쪽 타워가 원근으로 커져서 평면 기준 줌이 그대로는 너무 붙는다.
// 그 확대율은 화면 어디에 있는지에 따라 달라 계산으로 못 잡으니 눈으로 맞춘 값이다.
const BACKOFF = 0.5
// 세로가 짧고 가로만 넓은 창(데스크톱)에서는 평면 맞춤 자체가 과하게 당긴다.
const MAX_OPEN_ZOOM = 16.3

/**
 * 분석 대상 필지 위주로 지도를 연다.
 *
 * cameraForBounds 는 지도를 평면으로 재기 때문에, 기울인 채로 fitBounds 를 부르면
 * 카메라가 타워 사이 지상까지 내려앉는다. 평면에서 맞춘 뒤 눕히고 조금 물러나되,
 * 마지막으로 필지 네 모서리를 실제로 투영해 화면 밖으로 밀렸으면 더 물러난다 —
 * 좁은 화면에서 3차가 잘려 나가지 않게 하는 안전장치다.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {[[number, number], [number, number]]} bounds [[west, south], [east, north]]
 */
function frameSubject(map, [[w, s], [e, n]]) {
  map.jumpTo({ pitch: 0, bearing: 0 })
  map.fitBounds([[w, s], [e, n]], { padding: PAD, duration: 0 })
  map.setPitch(PITCH)
  map.setZoom(Math.min(map.getZoom() - BACKOFF, MAX_OPEN_ZOOM))
  const corners = [[w, s], [e, s], [e, n], [w, n]]
  const box = map.getContainer().getBoundingClientRect()
  for (let i = 0; i < 24; i++) {
    const fits = corners.map((c) => map.project(c)).every((p) =>
      p.x >= PAD.left && p.x <= box.width - PAD.right
      && p.y >= PAD.top && p.y <= box.height - PAD.bottom)
    if (fits) return
    map.setZoom(map.getZoom() - 0.1)
  }
}
const BASEMAP = {
  version: 8,
  sources: {
    vworld: {
      type: 'raster',
      tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Base/{z}/{y}/{x}.png`],
      tileSize: 256,
      maxzoom: 19,
      // 지도 출처 표기. 브이월드는 오픈API 이용약관, 카카오는 운영정책(캡처 사용 시
      // 출처 기입)이 각각 요구한다. 지면 텍스처가 카카오 렌더라 둘 다 적는다.
      attribution:
        '<a href="https://www.vworld.kr" target="_blank">VWorld</a> · '
        + '지도 <a href="https://map.kakao.com" target="_blank">© Kakao</a>',
    },
    // 브이월드 기본지도는 이 신축 단지를 아직 그리지 않는다 - 필지 경계만 있고 동이
    // 없으며, 항공영상은 개발 이전 밭이다. 그래서 부지 위에만 카카오 렌더 캡처를 덮는다
    // (tools/make_ground.py). 바깥은 계속 브이월드가 채운다.
    // 두 겹이다. 넓은 쪽(1 px/m)은 주변 단지가 선 자리를 덮고, 그 위에 부지만
    // 4 px/m 로 한 번 더 깐다. 정작 들여다보는 곳만 선명하면 된다.
    groundWide: {
      type: 'image',
      url: `${import.meta.env.BASE_URL}ground_wide.webp`,
      coordinates: groundWide.coordinates,
    },
    ground: {
      type: 'image',
      url: `${import.meta.env.BASE_URL}ground.webp`,
      coordinates: ground.coordinates,
    },
  },
  layers: [
    { id: 'vworld', type: 'raster', source: 'vworld' },
    { id: 'groundWide', type: 'raster', source: 'groundWide', paint: { 'raster-fade-duration': 0 } },
    { id: 'ground', type: 'raster', source: 'ground', paint: { 'raster-fade-duration': 0 } },
  ],
}

const SEASONS = [
  { id: 'spring', label: '봄', m: 3, d: 20 },
  { id: 'summer', label: '여름', m: 6, d: 21 },
  { id: 'autumn', label: '가을', m: 9, d: 22 },
  { id: 'winter', label: '겨울', m: 12, d: 21 },
]
const YEAR = new Date().getFullYear()
const MIN_T = 6 * 60
const MAX_T = 18 * 60
const STEP = 10

/** flatten the dataset into what the renderer and the pickers need */
const geom = (() => {
  /** @type {Array<{ring:number[][],height:number,floors:number,dong:string|null,complexId:string}>} */
  const buildings = []
  const complexes = []
  let subject = null // 지도를 열 때 맞출 곳 - 분석 대상 단지의 필지
  // 그라센트 1·2차는 카카오 렌더에서 동 단위로 뽑아 층수까지 동마다 넣었다
  // (tools/add_context.py). 주 단지와 똑같이 그린다 - 다만 분석 대상이 아니라서
  // 동·호수로 고를 수는 없다 (DONG_INDEX 가 3차만 담는다).
  // 업무시설 D1~D4 는 아직 안 지어진 땅이라 계획에서 역산한 예상 매스다
  // (tools/make_offices.py). kind 가 planned 라 반투명 연푸른색으로 구분해 그린다.
  for (const c of [...doc.complexes, ...context.complexes, ...offices.complexes]) {
    const dongs = new Map()
    const own = [[180, 90], [-180, -90]] // [[west, south], [east, north]]
    for (const b of c.buildings) {
      buildings.push({
        ring: b.poly, height: b.height, floors: b.floors,
        dong: b.dong, complexId: c.id, planned: b.kind === 'planned',
        cells: (b.cells || []).map((u) => ({
          ring: u.poly, color: doc.unitTypes[u.type],
        })),
      })
      if (b.dong) dongs.set(b.dong, Math.max(dongs.get(b.dong) ?? 0, b.floors))
      for (const [lon, lat] of b.poly) {
        own[0][0] = Math.min(own[0][0], lon)
        own[0][1] = Math.min(own[0][1], lat)
        own[1][0] = Math.max(own[1][0], lon)
        own[1][1] = Math.max(own[1][1], lat)
      }
    }
    if (c.subject) subject = own
    complexes.push({
      id: c.id, name: c.name, short: c.short, subject: c.subject,
      dongs: [...dongs.entries()]
        .map(([dong, floors]) => ({ dong, floors }))
        .sort((a, b) => a.dong.localeCompare(b.dong)),
    })
  }
  return { buildings, complexes, subject, ...doc.origin }
})()

// 분석 대상은 호반써밋 풍무 Ⅲ 하나뿐이다. 주변 단지는 그림자를 드리우는 역할만
// 하므로 동·호수로 고를 수 없다.
const SUBJECT = geom.complexes.find((c) => c.subject)

const DONG_INDEX = new Map(
  SUBJECT.dongs.map((d) => [`${SUBJECT.id}|${d.dong}`, { c: SUBJECT, d }]),
)

const fmt = (t) => {
  const h = Math.floor(t / 60)
  const m = t % 60
  return m === 0 ? `${h}시` : `${h}시 ${m}분`
}

export default function App() {
  const hostRef = useRef(null)
  const layerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const planRef = useRef(true)
  const tagsRef = useRef(true)
  const [season, setSeason] = useState('summer')
  const [minutes, setMinutes] = useState(12 * 60)
  const [sel, setSel] = useState(null) // {complexId, dong, floor}
  const [hidden, setHidden] = useState(() => new Set()) // "complexId|dong"
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(null)
  const [help, setHelp] = useState(() => !helpSeen())
  const [plan, setPlan] = useState(true) // 토지이용계획 겹쳐보기
  // 지도 크게보기. 아래 메뉴를 접어 세로를 지도에 넘긴다 - 다만 시각 슬라이더는
  // 남긴다. 그림자를 움직여 보는 게 이 화면의 본체라 접으면 볼 게 없어진다.
  const [wide, setWide] = useState(false)
  // 이름표는 계획을 읽을 때만 필요하다. 3D 를 들여다볼 때는 가리기만 하므로 따로 끈다.
  const [tags, setTags] = useState(true)
  const routeRef = useRef({ raf: 0, marker: null })
  const [noteOff, setNoteOff] = useState(false)

  const date = useMemo(() => {
    const s = SEASONS.find((x) => x.id === season)
    return { y: YEAR, m: s.m, d: s.d }
  }, [season])

  const sun = useMemo(
    () => solarPosition(date, minutes, doc.origin.lat, doc.origin.lon),
    [date, minutes],
  )

  // 해가 낮아지면 화면 전체가 같이 어두워진다. 3D 만 어둡게 하면 지도 바닥은 대낮인
  // 채로 남아 오히려 어색해서, 지도까지 덮는 한 겹으로 처리한다.
  const dusk = Math.max(0, Math.min(1, (DUSK_FROM - sun.altitude) / (DUSK_FROM - DUSK_TO)))

  const selInfo = sel ? DONG_INDEX.get(`${sel.complexId}|${sel.dong}`) : null
  const maxFloor = selInfo?.d.floors ?? 1
  const selKey = sel ? `${sel.complexId}|${sel.dong}` : null

  const toggleHidden = useCallback((key) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const select = useCallback((complexId, dong) => {
    if (!dong) return setSel(null)
    const info = DONG_INDEX.get(`${complexId}|${dong}`)
    if (!info) return setSel(null)
    setSel((prev) =>
      prev && prev.complexId === complexId && prev.dong === dong
        ? prev
        : { complexId, dong, floor: Math.ceil(info.d.floors / 2) },
    )
  }, [])

  useEffect(() => {
    if (!VWORLD_KEY) {
      setErr('지도를 불러오지 못했습니다. .env 의 VITE_VWORLD_KEY 와 '
        + 'VWorld 에 등록한 도메인(포트 포함)을 확인하세요.')
      return
    }
    // open on the subject complex; panning, zooming and tilting from there is free
    const map = new MapLibre({
      container: hostRef.current,
      style: BASEMAP,
      center: [geom.lon, geom.lat],
      zoom: 16,
      pitch: 0,
      minZoom: 13,
      maxZoom: 20,
      maxPitch: 75,
      // 브이월드 이용약관상 출처 표시는 빼면 안 된다. compact 를 끄면 ⓘ 토글
      // 없이 글자만 남아서, 지도 구석의 작은 각주로 가라앉는다 (styles.css).
      attributionControl: { compact: false },
    })
    frameSubject(map, geom.subject)
    // 나침반이 곧 회전·기울기 손잡이다. 끌면 방위가 돌고 위아래로 끌면 기울며,
    // 누르면 정북·수평으로 돌아온다. 이게 없으면 3D 인 줄도 모르고 지나간다.
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
    const stopGestures = orbitGestures(map)
    mapRef.current = map
    window.__map = map
    window.__geom = geom // 검증 스크립트가 데이터를 그대로 들여다볼 수 있게

    let layer
    map.on('load', () => {
      // 토지이용계획도(S=1/3,000)를 벡터로 뜬 것 (tools/make_landuse.py). 초기 스타일에
      // 인라인으로 넣으면 geojson 소스가 로드를 끝내지 못해 map 'load' 자체가 안 온다.
      // 스타일이 선 뒤에 붙인다.
      map.addSource('landuse', { type: 'geojson', data: `${import.meta.env.BASE_URL}landuse.json` })
      map.addLayer({
        id: 'landuse-fill',
        type: 'fill',
        source: 'landuse',
        filter: ['!=', ['get', 'use'], '도시개발구역'],
        // match 로 못 박는다. coalesce + 동적 get 은 색 타입 추론에 걸린다.
        paint: {
          'fill-color': ['match', ['get', 'use'], ...Object.entries(USE_COLOR).flat(), '#9aa3ad'],
          'fill-opacity': 0.22,
        },
      })
      map.addLayer({
        id: 'landuse-line',
        type: 'line',
        source: 'landuse',
        filter: ['!=', ['get', 'use'], '도시개발구역'],
        paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': 0.7 },
      })
      map.addLayer({
        id: 'district-line',
        type: 'line',
        source: 'landuse',
        filter: ['==', ['get', 'use'], '도시개발구역'],
        paint: { 'line-color': '#d9451d', 'line-width': 2.5, 'line-dasharray': [3, 2] },
      })

      // 도보 경로. 세 겹으로 그린다 - 바깥 발광, 본선, 그 위를 흐르는 점선.
      // Buildings3D 보다 **먼저** 얹어 건물에 가려지게 한다. 지면을 걷는 길이니까.
      map.addSource('route', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 16, 'line-opacity': 0.45,
          'line-blur': 6 },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1f6feb', 'line-width': 5.5 },
      })
      // 흐르는 빛은 **소스 데이터**로 움직인다. 대시 배열을 매 프레임 바꾸면 그때마다
      // MapLibre 가 대시 텍스처를 새로 굽고, 그 GL 상태가 three.js 와 부딪혀 3D 가
      // 깜빡인다. 짧은 토막 하나를 경로 위로 미끄러뜨리면 스타일은 건드릴 일이 없다.
      map.addSource('routeComet', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'route-comet',
        type: 'line',
        source: 'routeComet',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffd54a', 'line-width': 7, 'line-blur': 1.5 },
      })

      layer = new Buildings3D(map, {
        buildings: geom.buildings, lat0: geom.lat, lon0: geom.lon,
      })
      layerRef.current = layer
      window.__layer = layer
      setReady(true)
    })
    // ground.webp 는 저장소에 없을 수 있다(카카오 렌더 캡처라 커밋하지 않는다).
    // 없으면 브이월드만 깔린 채로 그대로 쓰면 되므로 오류 화면을 띄우지 않는다.
    map.on('error', (e) => {
      if (e.sourceId === 'ground' || e.sourceId === 'groundWide') return
      setErr(`지도 오류: ${e.error?.message || e.type}`)
    })

    // 용지 이름은 symbol 레이어 대신 HTML 마커다. 스타일에 글리프 서버가 없어도
    // 한글이 또렷하고, CSS 로 시인성을 조절할 수 있다. 폴리곤과 같은 파일을 읽는다.
    fetch(`${import.meta.env.BASE_URL}landuse.json`)
      .then((r) => r.json())
      .then((fc) => {
        const lots = fc.features
          .filter((f) => {
            const { at, area, use } = f.properties
            if (!at || LABEL_SKIP.has(use)) return false
            return area >= (LABEL_MIN_SMALL.has(use) ? LABEL_MIN_M2_SMALL : LABEL_MIN_M2)
          })
          .map((f) => {
            const el = document.createElement('div')
            el.className = 'lot-tag'
            el.textContent = labelOf(f.properties.use)
            el.style.setProperty('--tag', USE_COLOR[f.properties.use] || '#5b6472')
            return new Marker({ element: el, anchor: 'center' }).setLngLat(f.properties.at)
          })
        // 블록 코드는 단지 위에 얹는다. 필지끼리 붙어 버려 폴리곤 하나에 코드 하나로
        // 달 수가 없어 도면에서 읽은 자리에 점으로 따로 둔 것들이다.
        const blocks = fc.features
          .filter((f) => f.properties.block)
          .map((f) => {
            const el = document.createElement('div')
            // 업무시설은 3D 매스가 청록이라 이름표도 같은 색으로 묶는다
            el.className = f.properties.name === '업무시설' ? 'block-tag office' : 'block-tag'
            el.innerHTML = `<b>${f.properties.block}</b><span>${f.properties.name}</span>`
            return new Marker({ element: el, anchor: 'center' })
              .setLngLat(f.geometry.coordinates)
          })
        markersRef.current = [...lots, ...blocks]
        if (planRef.current && tagsRef.current) {
          for (const mk of markersRef.current) mk.addTo(map)
        }
      })
      .catch(() => { /* 계획도가 없으면 라벨만 없다 */ })

    // tap a building to select it. maplibre already suppresses click after a drag
    map.on('click', (e) => {
      const hit = layer?.pickAt(e.point.x, e.point.y)
      if (hit?.dong) select(hit.complexId, hit.dong)
      else setSel(null)
    })
    return () => {
      for (const mk of markersRef.current) mk.remove()
      markersRef.current = []
      stopGestures()
      layer?.destroy()
      map.remove()
    }
  }, [select])

  // 토지이용계획 겹쳐보기. 지구 전체가 아직 나대지라, 어느 자리에 뭐가 들어서는지가
  // 이 지역에서는 그림자만큼이나 궁금한 정보다. 켜둔 채로 연다.
  useEffect(() => {
    planRef.current = plan
    tagsRef.current = tags
    const map = mapRef.current
    if (!ready || !map) return
    for (const id of ['landuse-fill', 'landuse-line', 'district-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', plan ? 'visible' : 'none')
    }
    for (const mk of markersRef.current) {
      if (plan && tags) mk.addTo(map)
      else mk.remove()
    }
  }, [ready, plan, tags])

  useEffect(() => {
    if (ready) layerRef.current?.setSun(sun)
  }, [ready, sun])

  useEffect(() => {
    if (ready) layerRef.current?.setSelection(sel)
  }, [ready, sel])

  useEffect(() => {
    if (ready) layerRef.current?.setHidden(hidden)
  }, [ready, hidden])

  // 고른 동에서 풍무역 2번 출구까지. 경로는 tools/make_routes.mjs 가 미리 구워 둔 것을
  // 그리기만 한다 - 동은 서른몇 개고 목적지는 하나라 런타임에 길찾기를 할 이유가 없다.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !map.getSource('route')) return undefined
    const r = selKey ? walkRoutes.routes[selKey] : null
    const st = routeRef.current
    cancelAnimationFrame(st.raf)
    st.marker?.remove()
    st.marker = null
    if (!r) {
      map.getSource('route').setData(EMPTY)
      map.getSource('routeComet').setData(EMPTY)
      return undefined
    }
    map.getSource('route').setData({
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: r.line },
    })

    const el = document.createElement('div')
    el.className = 'walker'
    st.marker = new Marker({ element: el, anchor: 'center' })
      .setLngLat(r.line[0]).addTo(map)

    const slow = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (slow) {
      map.getSource('routeComet').setData(EMPTY)
      return () => { st.marker?.remove(); st.marker = null }
    }

    // 점을 따라 움직이려면 각 마디 길이가 필요하다 (위경도라 위도 보정만 넣는다)
    const k = Math.cos(r.line[0][1] * Math.PI / 180)
    const seg = []
    let total = 0
    for (let i = 1; i < r.line.length; i++) {
      const dx = (r.line[i][0] - r.line[i - 1][0]) * k
      const dy = r.line[i][1] - r.line[i - 1][1]
      total += Math.hypot(dx, dy)
      seg.push(total)
    }
    /** 경로 위 거리 u 에서의 좌표 */
    const at = (u) => {
      let i = seg.findIndex((v) => v >= u)
      if (i < 0) i = seg.length - 1
      const prev = i ? seg[i - 1] : 0
      const f = (u - prev) / Math.max(seg[i] - prev, 1e-9)
      const a = r.line[i], b = r.line[i + 1] || a
      return { i, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] }
    }
    const comet = map.getSource('routeComet')
    const span = total * COMET_SPAN
    const t0 = performance.now()
    const tick = (t) => {
      const u = ((t - t0) % WALKER_MS) / WALKER_MS * total
      const head = at(u)
      const tail = at(Math.max(0, u - span))
      // 꼬리와 머리 사이의 원래 점들을 그대로 끼워 넣어야 곡선을 탄다
      const mid = r.line.slice(tail.i + 1, head.i + 1)
      comet.setData({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [tail.p, ...mid, head.p] },
      })
      st.marker.setLngLat(head.p)
      st.raf = requestAnimationFrame(tick)
    }
    st.raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(st.raf)
      st.marker?.remove()
      st.marker = null
      map.getSource('routeComet')?.setData(EMPTY)
    }
  }, [ready, selKey])

  return (
    <div className={`wrap${wide ? ' wide' : ''}`}>
      <header>
        <h1>풍무역세권 일조 시뮬레이터</h1>
        <button className="ask" onClick={() => setHelp(true)} aria-label="조작법">?</button>
      </header>

      {!noteOff && (
        <p className="warn" role="note">
          <span>
            <b>참고용입니다.</b> 모든 3D 건물은 층고와 거리를 추정값으로 계산한 가상의
            건물이므로 <b>실제 일조량</b>과 다를 수 있습니다.
          </span>
          <button onClick={() => setNoteOff(true)} aria-label="안내 닫기">×</button>
        </p>
      )}

      {/* 지도가 뜬 뒤에 띄운다 - 3D 가 뒤에 보이는 채로 읽어야 무슨 말인지 안다 */}
      <Help open={help && ready} onClose={() => setHelp(false)} />

      <div className="mapbox">
        <div className="map" ref={hostRef} />
        <div className="dusk" style={{ opacity: dusk }} aria-hidden="true" />
        {err && <p className="err">{err}</p>}
        <div className="panel">
          <button
            className={`plan-toggle${plan ? ' on' : ''}`}
            onClick={() => setPlan((v) => !v)}
            role="switch"
            aria-checked={plan}
          >
            토지이용계획
            <i aria-hidden="true"><span /></i>
          </button>
          {plan && (
            <button
              className={`plan-toggle${tags ? ' on' : ''}`}
              onClick={() => setTags((v) => !v)}
              role="switch"
              aria-checked={tags}
            >
              이름표
              <i aria-hidden="true"><span /></i>
            </button>
          )}
          {selInfo && (
            <div className="badge">
              <b>{sel.dong}동</b>
              <span>최고 {selInfo.d.floors}층</span>
              <button className="link" onClick={() => toggleHidden(selKey)}>
                {hidden.has(selKey) ? '보이기' : '숨기기'}
              </button>
              <button onClick={() => setSel(null)} aria-label="선택 해제">×</button>
            </div>
          )}
          {selKey && walkRoutes.routes[selKey] && (
            <div className="walk">
              <b>{walkRoutes.to.name}</b>
              <span>{walkRoutes.routes[selKey].metres.toLocaleString()} m</span>
              <span>도보 {Math.max(1, Math.round(walkRoutes.routes[selKey].seconds / 60))}분</span>
              <em>{effortOf(walkRoutes.routes[selKey].seconds / 60)}</em>
            </div>
          )}
          {hidden.size > 0 && (
            <div className="off">
              {[...hidden].sort().map((k) => (
                <button key={k} onClick={() => toggleHidden(k)}>
                  {k.split('|')[1]}동 <b>×</b>
                </button>
              ))}
              <button className="link" onClick={() => setHidden(new Set())}>모두 보기</button>
            </div>
          )}
        </div>
      </div>

      <button
        className="fold"
        onClick={() => setWide((v) => !v)}
        aria-expanded={!wide}
      >
        <i aria-hidden="true" />
        {wide ? '메뉴 보기' : '지도 크게보기'}
      </button>

      <div className="time">
        <div className="big">
          {fmt(minutes)}
          {sun.altitude <= 0 && <em>{minutes < 12 * 60 ? '해 뜨기 전' : '해 진 뒤'}</em>}
        </div>
        <input
          type="range"
          min={MIN_T}
          max={MAX_T}
          step={STEP}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          style={{ '--pct': `${((minutes - MIN_T) / (MAX_T - MIN_T)) * 100}%` }}
        />
        <div className="ticks">
          <span>6시</span>
          <span>오후 12시</span>
          <span>18시</span>
        </div>
      </div>

      <div className="sheet" aria-hidden={wide} inert={wide ? '' : undefined}>
        <div>
          <div className="seasons">
            {SEASONS.map((s) => (
              <button
                key={s.id}
                className={s.id === season ? 'on' : ''}
                onClick={() => setSeason(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 주변 단지는 그림자를 드리우는 역할만 한다. 드롭다운에 3차 동만 있는
              이유를 모르면 "왜 저 단지는 안 나오지" 로 읽히므로 미리 말해 준다. */}
          <p className="pick-note">동·호수 선택은 <b>{SUBJECT.name}</b> 만 가능합니다. 주변 단지는 그림자만 계산합니다.</p>

          <div className="pick">
            <select
              value={sel ? `${sel.complexId}|${sel.dong}` : ''}
              onChange={(e) => {
                const v = e.target.value
                if (!v) return setSel(null)
                const [cid, dong] = v.split('|')
                select(cid, dong)
              }}
            >
              <option value="">동 선택</option>
              <optgroup label={SUBJECT.name}>
                {SUBJECT.dongs.map((d) => (
                  <option key={d.dong} value={`${SUBJECT.id}|${d.dong}`}>
                    {d.dong}동 ({d.floors}층)
                  </option>
                ))}
              </optgroup>
            </select>
            <select
              value={sel?.floor ?? ''}
              disabled={!sel}
              onChange={(e) => setSel((p) => ({ ...p, floor: Number(e.target.value) }))}
            >
              {!sel && <option value="">호수</option>}
              {sel &&
                Array.from({ length: maxFloor }, (_, i) => maxFloor - i).map((f) => (
                  <option key={f} value={f}>{f}층</option>
                ))}
            </select>
          </div>
        </div>
      </div>

      <p className="credit">만든이 : 호반써밋3 어흥</p>
    </div>
  )
}
