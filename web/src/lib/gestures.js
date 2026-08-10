// Touch gestures for a 3D scene rather than a flat map.
//
// MapLibre's defaults are built for looking *down* at a map: one finger pans,
// two fingers rotate and tilt. Here the thing on screen is a model you walk
// around, so the two swap.
//
//   한 손가락 끌기  = 회전 (좌우) + 기울이기 (상하)
//   두 손가락 끌기  = 상하좌우 이동 + 벌리면 확대 / 오므리면 축소
//   PC 좌 드래그    = 이동,  우 드래그 = 회전·기울이기 (maplibre 의 dragRotate)
//
// Written against the public Map API only. v6 has no public way to register a
// handler with its manager, and reaching into map._handlers would break on any
// upgrade - so this listens on the canvas container and drives the camera.
//
// The pinch has to be ours too: every jumpTo/panBy calls Camera.stop(), which
// resets maplibre's own handlers, so a leftover touchZoomRotate would have its
// gesture cancelled on every frame our two-finger pan fired.
const ROT_PER_PX = 0.5 // deg of bearing per px dragged sideways
const PITCH_PER_PX = 0.4 // deg of pitch per px dragged up

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const points = (e) => [...e.touches].map((t) => ({ x: t.clientX, y: t.clientY }))
const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
const spread = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)

/**
 * @param {import('maplibre-gl').Map} map
 * @returns {() => void} 창에 붙인 리스너까지 걷어내는 정리 함수
 */
export function orbitGestures(map) {
  map.dragPan.disable()
  map.touchPitch.disable()
  map.touchZoomRotate.disable()

  const el = map.getCanvasContainer()
  const maxPitch = map.getMaxPitch()
  let touch = null
  let origin = { left: 0, top: 0 } // container position, sampled per gesture
  let mouse = null

  const startTouch = (e) => {
    if (e.touches.length > 1) e.preventDefault()
    touch = points(e)
    const r = el.getBoundingClientRect()
    origin = { left: r.left, top: r.top }
  }

  const onTouchMove = (e) => {
    // Non-passive on purpose. touch-action:none stops Android from scrolling or
    // zooming the page, but iOS Safari ignores it for pinch - only an actual
    // preventDefault keeps two fingers on the map from zooming the whole page.
    e.preventDefault()
    const now = points(e)
    const was = touch
    touch = now
    // a finger landing or lifting moves the reference; re-anchor rather than
    // reading the jump as one enormous drag
    if (!was || was.length !== now.length) return

    if (now.length === 1) {
      map.jumpTo({
        bearing: map.getBearing() + (now[0].x - was[0].x) * ROT_PER_PX,
        pitch: clamp(map.getPitch() - (now[0].y - was[0].y) * PITCH_PER_PX, 0, maxPitch),
      })
      return
    }
    const a = mid(was)
    const b = mid(now)
    // zoom about the point between the fingers, then slide by however much that
    // point itself travelled
    const dz = Math.log2(spread(now) / spread(was))
    if (Number.isFinite(dz) && Math.abs(dz) > 1e-5) {
      map.easeTo({
        zoom: map.getZoom() + dz,
        around: map.unproject([a.x - origin.left, a.y - origin.top]),
        duration: 0,
      })
    }
    if (a.x !== b.x || a.y !== b.y) map.panBy([a.x - b.x, a.y - b.y], { duration: 0 })
  }
  const endTouch = () => { touch = null }

  const onMouseMove = (e) => {
    if (!mouse) return
    map.panBy([mouse.x - e.clientX, mouse.y - e.clientY], { duration: 0 })
    mouse = { x: e.clientX, y: e.clientY }
  }
  const onMouseDown = (e) => {
    if (e.button === 0 && !e.ctrlKey) mouse = { x: e.clientX, y: e.clientY }
  }
  const endMouse = () => { mouse = null }

  // iOS Safari's own pinch arrives as gesture* on the document and is not
  // covered by touch-action or by the viewport meta tag. Killing it everywhere
  // is what actually pins the page at 1x - there is nothing on this screen that
  // wants to be pinched except the map.
  const noZoom = (e) => e.preventDefault()

  el.addEventListener('touchstart', startTouch, { passive: false })
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  el.addEventListener('touchend', endTouch)
  el.addEventListener('touchcancel', endTouch)
  el.addEventListener('mousedown', onMouseDown)
  // on window/document, so a drag that leaves the canvas still tracks and ends
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', endMouse)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, noZoom, { passive: false })
  }

  return () => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', endMouse)
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.removeEventListener(t, noZoom)
    }
  }
}
