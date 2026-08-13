import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// JS·CSS 주석은 최소화가 알아서 떨군다. index.html 은 손대지 않으므로 여기만 따로 턴다 -
// 소스에는 왜 그렇게 했는지가 남아 있어야 하고, 배포본에는 남을 이유가 없다.
const stripHtmlComments = () => ({
  name: 'strip-html-comments',
  apply: 'build',
  transformIndexHtml: (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\n/gm, ''),
})

export default defineConfig({
  plugins: [react(), stripHtmlComments()],
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
  // maplibre 워커는 ES 모듈이라(형제 파일을 import 한다) 기본값 iife 로 묶으면 깨진다
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 }, // maplibre-gl + three
  // maplibre 워커를 사전번들이 건드리지 않게 둔다. 워커 주소 자체는 src/main.jsx 가
  // setWorkerUrl 로 직접 지정한다 - 그게 없으면 워커가 404 로 떨어지고, 래스터는
  // 멀쩡한 채 geojson 소스만 조용히 멈춘다 (에러도 안 난다).
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
