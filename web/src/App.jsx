import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import doc from './data/buildings.json'
import { Buildings3D } from './lib/kakao3d.js'
import { solarPosition } from './lib/sun.js'

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
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  let subject = null
  for (const c of doc.complexes) {
    const dongs = new Map()
    const own = { west: 180, east: -180, south: 90, north: -90 }
    for (const b of c.buildings) {
      buildings.push({
        ring: b.poly, height: b.height, floors: b.floors,
        dong: b.dong, complexId: c.id,
        cells: (b.cells || []).map((u) => ({
          ring: u.poly, color: doc.unitTypes[u.type],
        })),
      })
      if (b.dong) {
        const cur = dongs.get(b.dong)
        dongs.set(b.dong, cur ? Math.max(cur, b.floors) : b.floors)
      }
      for (const [lon, lat] of b.poly) {
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
        if (lon < own.west) own.west = lon
        if (lon > own.east) own.east = lon
        if (lat < own.south) own.south = lat
        if (lat > own.north) own.north = lat
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
  return {
    buildings, complexes,
    bounds: { west, east, south, north },
    subject: subject ?? { west, east, south, north },
    ...doc.origin,
  }
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
  const [season, setSeason] = useState('summer')
  const [minutes, setMinutes] = useState(12 * 60)
  const [sel, setSel] = useState(null) // {complexId, dong, floor}
  const [hidden, setHidden] = useState(() => new Set()) // "complexId|dong"
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(null)

  const date = useMemo(() => {
    const s = SEASONS.find((x) => x.id === season)
    return { y: YEAR, m: s.m, d: s.d }
  }, [season])

  const sun = useMemo(
    () => solarPosition(date, minutes, doc.origin.lat, doc.origin.lon),
    [date, minutes],
  )

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
    const kakao = window.kakao
    if (!kakao?.maps) {
      setErr('카카오 지도를 불러오지 못했습니다. .env 의 VITE_KAKAO_JS_KEY 와 '
        + 'Kakao Developers 에 등록한 도메인(포트 포함)을 확인하세요.')
      return
    }
    let layer
    kakao.maps.load(() => {
      // open on the subject complex; panning and zooming from there is free
      const { west, east, south, north } = geom.subject
      const map = new kakao.maps.Map(hostRef.current, {
        center: new kakao.maps.LatLng(geom.lat, geom.lon),
        level: 4,
      })
      map.setBounds(
        new kakao.maps.LatLngBounds(
          new kakao.maps.LatLng(south, west),
          new kakao.maps.LatLng(north, east),
        ),
        24, 24,
      )
      mapRef.current = map
      layer = new Buildings3D(map, hostRef.current, {
        buildings: geom.buildings, lat0: geom.lat, lon0: geom.lon,
      })
      layerRef.current = layer
      window.__map = map
      window.__layer = layer

      // tap a building to select it; a drag must not count as a tap
      let down = null
      const el = hostRef.current
      el.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY }
      })
      el.addEventListener('pointerup', (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return
        const r = el.getBoundingClientRect()
        const hit = layer.pickAt(e.clientX - r.left, e.clientY - r.top)
        if (hit?.dong) select(hit.complexId, hit.dong)
        else setSel(null)
      })
      setReady(true)
    })
    return () => layer?.destroy()
  }, [select])

  // kakao levels count down as you zoom in
  const zoom = useCallback((d) => {
    const map = mapRef.current
    if (map) map.setLevel(Math.min(6, Math.max(1, map.getLevel() + d)))
  }, [])

  useEffect(() => {
    if (ready) layerRef.current?.setSun(sun)
  }, [ready, sun])

  useEffect(() => {
    if (ready) layerRef.current?.setSelection(sel)
  }, [ready, sel])

  useEffect(() => {
    if (ready) layerRef.current?.setHidden(hidden)
  }, [ready, hidden])

  return (
    <div className="wrap">
      <header>
        <h1>아파트 일조량</h1>
      </header>

      <div className="mapbox">
        <div className="map" ref={hostRef} />
        {ready && (
          <div className="zoom">
            <button onClick={() => zoom(-1)} aria-label="확대">+</button>
            <button onClick={() => zoom(1)} aria-label="축소">−</button>
          </div>
        )}
        <ul className="types">
          {Object.entries(doc.unitTypes).map(([t, color]) => (
            <li key={t}><i style={{ background: color }} />{t}</li>
          ))}
        </ul>
        {err && <p className="err">{err}</p>}
        <div className="panel">
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

      <div className="time">
        <div className="big">
          {fmt(minutes)}
          {sun.altitude <= 0 && <em>해 뜨기 전</em>}
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
    </div>
  )
}
