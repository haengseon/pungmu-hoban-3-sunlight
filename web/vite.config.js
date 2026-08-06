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
  server: { port: 5173, host: '127.0.0.1' },
  build: { chunkSizeWarningLimit: 1600 },
})
