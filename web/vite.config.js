import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  plugins: [react()],
  // 키는 저장소 루트의 .env 한 곳에서만 관리한다. tools/ 파이프라인도 같은 파일을
  // 읽으므로 web/ 와 tools/ 가 서로 다른 값을 보는 일이 없다.
  envDir: ROOT,
  server: {
    port: 5173,
    host: '127.0.0.1',
    // cloudflared 터널로 폰에서 열 때. vite 는 Host 헤더가 모르는 값이면 막는데
    // trycloudflare 주소는 매번 무작위라 도메인 단위로 열어 둔다. 서버는 여전히
    // 127.0.0.1 에만 바인딩되므로 LAN 에 그대로 노출되지는 않는다.
    allowedHosts: ['.trycloudflare.com'],
  },
  build: { chunkSizeWarningLimit: 2000 }, // maplibre-gl + three
  // maplibre 는 워커를 별도 파일로 띄우는데, vite 의 의존성 사전번들이 그 파일을
  // 내놓지 않아 개발 서버에서 404 가 난다. 래스터는 메인 스레드라 멀쩡하고
  // geojson 소스만 조용히 로드가 멈춘다 (에러도 안 난다). 사전번들에서 뺀다.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
