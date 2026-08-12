import React from 'react'
import { createRoot } from 'react-dom/client'
import { setWorkerUrl } from 'maplibre-gl'
// maplibre 는 워커를 '자기 번들 옆의 형제 파일' 에서 찾는다 (import.meta.url 기준
// ./maplibre-gl-worker.mjs). 번들러가 그 파일을 같이 내놓지 않으면 요청이 404 로
// 떨어지는데, 래스터 타일은 메인 스레드라 멀쩡하고 워커가 파싱하는 geojson 만
// 조용히 멈춘다 - 에러도 안 난다. 그래서 토지이용계획 음영이 통째로 사라졌었다.
// vite 에게 워커를 번들해 달라고 하고(?worker&url), 그 주소를 직접 알려 준다.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import App from './App.jsx'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'

setWorkerUrl(workerUrl)

createRoot(document.getElementById('root')).render(<App />)
