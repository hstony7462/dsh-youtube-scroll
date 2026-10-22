/**
 * 立刻跑一輪（用家目錄現在的 config，不覆蓋設定）。
 * node test/run-now.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
process.env.DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')

const mod = await import(join(ROOT, 'index.js'))
let route = null
mod.apply({
  effect: (fn) => fn(),
  webServer: { register(cfg) { route = cfg; return { dispose() {} } } },
  get: (n) => (n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } : undefined),
}, {})

const call = async (method, path, body) => {
  const raw = body === undefined ? null : JSON.stringify(body)
  const req = { method, url: path, destroy() {} }
  req.on = (ev, fn) => {
    if (ev === 'data') setTimeout(() => fn(raw), 0)
    if (ev === 'end') setTimeout(() => fn(), 1)
  }
  if (raw === null) req.on = (ev, fn) => { if (ev === 'end') setTimeout(() => fn(), 0) }
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await route.handler(req, res)
  try { return JSON.parse(res.body) } catch (err) { return null }
}

const STATE = join(process.env.DSH_HOME, 'yt-duty')
const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const report = join(STATE, 'out', `${today}.md`)
const before = existsSync(report) ? statSync(report).size : 0

const cfg = await call('GET', '/api/yt-duty/config')
console.log('目前設定：perDay=' + cfg.config.perDay, '| 頻道=' + JSON.stringify(cfg.config.channels), '| 關鍵詞=' + JSON.stringify(cfg.config.keywords))
console.log('今天已挑 ' + (await call('GET', '/api/yt-duty/status')).pickedToday + ' 條；報告現有 ' + before + ' bytes')
console.log('開跑…')
const run = await call('POST', '/api/yt-duty/run')
console.log('run =', JSON.stringify(run))
if (!run?.started) process.exit(1)

const t0 = Date.now()
let lastSize = before
await new Promise((resolve) => {
  const timer = setInterval(() => {
    const st = JSON.parse((() => { try { return readFileSync(join(STATE, 'state.json'), 'utf8') } catch (e) { return '{}' } })())
    if (existsSync(report) && statSync(report).size !== lastSize) lastSize = statSync(report).size
    if (st.lastRoundAt && Date.now() - t0 > 8000 && st.lastCode !== null && st.lastCode !== undefined) { clearInterval(timer); resolve() }
  }, 2000)
  setTimeout(() => { clearInterval(timer); resolve() }, 300_000)
})

const status = await call('GET', '/api/yt-duty/status')
console.log('\n完成，用時 ' + Math.round((Date.now() - t0) / 1000) + 's | pickedToday=' + status.pickedToday + ' | lastError=' + JSON.stringify(status.lastError))
const text = existsSync(report) ? readFileSync(report, 'utf8') : ''
console.log('報告大小 ' + text.length + ' bytes，### 行數 ' + (text.match(/^###\s+[A-Za-z0-9_-]{11}\s*$/gm) || []).length)
console.log('---- 報告開頭 ----')
console.log(text.slice(0, 900))
console.log('---- duty.log 尾部 ----')
try { console.log(readFileSync(join(STATE, 'duty.log'), 'utf8').split('\n').slice(-12).join('\n')) } catch (e) {}
process.exit(0)
