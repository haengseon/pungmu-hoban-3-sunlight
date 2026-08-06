// Minimal static server for web/dist - no host-header restrictions, so it can
// sit behind a tunnel without extra configuration.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
const PORT = Number(process.env.PORT || 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

if (!existsSync(ROOT)) {
  console.error(`no build at ${ROOT} - run "npm run build" in web/ first`)
  process.exit(1)
}

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  let file = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(ROOT)) return end(res, 403, 'forbidden')
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html')
  if (!existsSync(file)) return end(res, 404, 'not found')
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
  })
  createReadStream(file).pipe(res)
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`))

const end = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(msg)
}
