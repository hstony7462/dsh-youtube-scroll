/**
 * 端到端驗收：真的跑一輪（會 spawn headless DSH、真的連 YouTube、燒一點 token）。
 *
 * 用法（在插件目錄）：
 *   DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" test/integration.mjs
 *
 * 做法：用假 ctx 載入宿主半端（跟 host.test 一樣），設定一個很小的任務，
 * 走宿主自己的 runRound（含 overlay、dsh 定位、spawn、MCP 掛載），然後等日報出現。
 */
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// 用真的家目錄（報告要落在插件家）；除非外面指定了 DSH_HOME
process.env.DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')

const mod = await import(join(ROOT, 'index.js'))

let route = null
const fakeCtx = {
  effect(fn) { return fn() },
  webServer: { register(cfg) { route = cfg; return { dispose() {} } } },
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
    return undefined
  },
}
mod.apply(fakeCtx, {})

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
  try { return { code: res.code, json: JSON.parse(res.body) } } catch (err) { return { code: res.code, json: null, raw: res.body } }
}

const stateDir = join(process.env.DSH_HOME, 'yt-duty')
const logFile = join(stateDir, 'duty.log')
const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const reportFile = join(stateDir, 'out', `${today}.md`)

console.log('1) 設定一個小任務（3 條、1 個頻道、1 個關鍵詞、薄版）')
const saved = await call('POST', '/api/yt-duty/config', { patch: {
  perDay: 3,
  peakValley: false,
  channels: ['@GoogleDevelopers'],
  keywords: ['deepseek harness'],
  reportLevel: 'brief',
  apiKey: '',
} })
console.log('   config ok =', saved.json?.ok, '| perDay =', saved.json?.config?.perDay, '| channels =', JSON.stringify(saved.json?.config?.channels))

console.log('2) 觸發「現在跑一輪」')
const run = await call('POST', '/api/yt-duty/run')
console.log('   run =', JSON.stringify(run.json))

if (!run.json?.started) {
  console.log('!! 沒起來，日誌尾部：')
  console.log(readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'))
  process.exit(1)
}

console.log('\n3) 等日報（最多 8 分鐘；每 20 秒印一次日誌尾部）')
const t0 = Date.now()
let printed = 0
const timer = setInterval(() => {
  try {
    const lines = readFileSync(logFile, 'utf8').split('\n')
    for (const line of lines.slice(printed)) {
      if (line.trim()) console.log('   log |', line.slice(0, 220))
    }
    printed = lines.length
  } catch (err) { /* 日誌還沒建好 */ }
}, 20_000)

const done = new Promise((resolve) => {
  const check = setInterval(() => {
    if (existsSync(reportFile)) {
      const text = readFileSync(reportFile, 'utf8')
      if (/^###\s+[A-Za-z0-9_-]{11}\s*$/m.test(text)) { clearInterval(check); resolve(true) }
    }
    const st = JSON.parse((() => { try { return readFileSync(join(stateDir, 'state.json'), 'utf8') } catch (e) { return '{}' } })())
    if (st.lastCode !== undefined && st.lastCode !== null && Date.now() - t0 > 15_000) {
      clearInterval(check); resolve(existsSync(reportFile))
    }
  }, 3000)
  setTimeout(() => { clearInterval(check); resolve(false) }, 480_000)
})

const ok = await done
clearInterval(timer)

const stamp = Math.round((Date.now() - t0) / 1000)
const status = await call('GET', '/api/yt-duty/status')
console.log('\n4) 結果')
console.log('   耗時 =', stamp, 's | 報告存在 =', existsSync(reportFile), '| pickedToday =', status.json?.pickedToday)
console.log('   lastError =', JSON.stringify(status.json?.lastError))
if (existsSync(reportFile)) {
  const text = readFileSync(reportFile, 'utf8')
  console.log('   報告標題行 =', (text.match(/^###\s+([A-Za-z0-9_-]{11})\s*$/gm) || []).length)
  console.log('   ---- 報告前 1200 字 ----')
  console.log(text.slice(0, 1200))
}
console.log('\n5) 日誌尾部')
try {
  console.log(readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n'))
} catch (err) { console.log('   （沒有日誌）') }

process.exit(ok ? 0 : 1)
