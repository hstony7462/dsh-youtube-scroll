/**
 * 宿主半端離線測試（不裝插件、不起真的 headless 會話）。
 * 用臨時 DSH_HOME 跑，檢查：設定白名單、HTTP 路由、日報計數、章程鋪設、overlay 內容。
 *
 * node test/host.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// index.js 在 import 時就讀 DSH_HOME，必須先設好
const HOME = mkdtempSync(join(tmpdir(), 'yt-scroll-test-'))
process.env.DSH_HOME = HOME

const mod = await import(join(ROOT, 'index.js'))

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, detail === undefined ? '' : '→ ' + detail) }
}

// ---- 假 ctx ----
let route = null
const fakeCtx = {
  effect(fn) { const d = fn(); return d },
  webServer: { register(cfg) { route = cfg; return { dispose() {} } } },
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }) }
    return undefined
  },
}

mod.apply(fakeCtx, {})

const stateDir = join(HOME, 'yt-duty')
const outDir = join(stateDir, 'out')
const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

console.log('1) 目錄與預設檔案')
check('state dir', existsSync(stateDir))
check('out dir', existsSync(outDir))
check('config.json', existsSync(join(stateDir, 'config.json')))
check('duty.md 已鋪', existsSync(join(stateDir, 'duty.md')))
check('route 已註冊', route && route.path === '/api/yt-duty')

// ---- HTTP 請求工具 ----
const call = async (method, path, body) => {
  const req = { method, url: path, on(ev, fn) { if (ev === 'end') setTimeout(() => fn(), 0) }, destroy() {} }
  const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = b } }
  const raw = body === undefined ? null : JSON.stringify(body)
  if (raw !== null) {
    // 讓 readBody 拿到資料
    req.on = (ev, fn) => {
      if (ev === 'data') setTimeout(() => fn(raw), 0)
      if (ev === 'end') setTimeout(() => fn(), 1)
    }
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch (err) { /* 非 JSON */ }
  return { code: res.code, json, raw: res.body }
}

console.log('2) GET /status 形狀')
const st = await call('GET', '/api/yt-duty/status')
check('status 200', st.code === 200)
check('status ok', st.json?.ok === true)
check('perDay 預設 5', st.json?.perDay === 5, String(st.json?.perDay))
check('pickedToday 0', st.json?.pickedToday === 0, String(st.json?.pickedToday))
check('windows 兩個', !!st.json?.windows?.noon && !!st.json?.windows?.night)
check('report 路徑', String(st.json?.report || '').endsWith(`${today}.md`), st.json?.report)
check('config 不回 apiKey 洩漏?（允許有值，這裡只檢查欄位在）', 'apiKey' in (st.json?.config || {}))

console.log('3) POST /config 白名單與鉗制')
const saved = await call('POST', '/api/yt-duty/config', { patch: {
  perDay: 999, peakValley: 'yes', noon: 1, night: 0,
  keywords: ['AI', '  ', 'deepseek'], channels: '@GoogleDevelopers\n\nUC_x5XG1OV2P6uZZ5FSM9Ttw',
  reportLevel: 'bogus', apiKey: 'key-123', evil: 'should-not-persist',
} })
check('config 200', saved.code === 200 && saved.json?.ok === true)
check('perDay 鉗到 50', saved.json?.config?.perDay === 50, String(saved.json?.config?.perDay))
check('peakValley 轉 boolean', saved.json?.config?.peakValley === true)
check('noon bool', saved.json?.config?.noon === true && saved.json?.config?.night === false)
check('keywords 去空白', JSON.stringify(saved.json?.config?.keywords) === JSON.stringify(['AI', 'deepseek']), JSON.stringify(saved.json?.config?.keywords))
check('channels 兩條', (saved.json?.config?.channels || []).length === 2, JSON.stringify(saved.json?.config?.channels))
check('reportLevel 回預設', saved.json?.config?.reportLevel === 'full', saved.json?.config?.reportLevel)
check('未知欄位不落盤', !('evil' in (saved.json?.config || {})))

console.log('4) 日報計數（### videoId）')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `${today}.md`), [
  '# YouTube 日報 · ' + today, '',
  '### dQw4w9WgXcQ', '- 標題：A', '',
  '### Zzm0p53c7Wk', '- 標題：B', '',
  '### 太短', '### abc', '',
].join('\n'), 'utf8')
const st2 = await call('GET', '/api/yt-duty/status')
check('pickedToday 2', st2.json?.pickedToday === 2, String(st2.json?.pickedToday))
check('reportExists true', st2.json?.reportExists === true)

console.log('5) GET /report 與錯誤處理')
const rep = await call('GET', '/api/yt-duty/report')
check('report 200 有原文', rep.code === 200 && String(rep.json?.text || '').includes('dQw4w9WgXcQ'))
const bad = await call('GET', '/api/yt-duty/report?date=../../etc/passwd')
check('非法日期 400', bad.code === 400)
const nf = await call('GET', '/api/yt-duty/nope')
check('未知路由 404', nf.code === 404)

console.log('6) 值班章程與提示詞（透過 run 的副作用不便測，直接驗檔案）')
const duty = readFileSync(join(stateDir, 'duty.md'), 'utf8')
check('章程含 videoId 規則', duty.includes('### <11 位 videoId>') || duty.includes('### ` + 或「### '))
check('章程含紅線', duty.includes('紅線'))


console.log('7) 新接口（停止 / 金鑰 / 報告索引 / 清理 / SRT / 單條）')
const stop0 = await call('POST', '/api/yt-duty/stop')
check('沒在跑時 stop 回 ok:false', stop0.json?.ok === false)
const key0 = await call('GET', '/api/yt-duty/check-key')
check('沒 key 時 check-key 回 ok:false', key0.json?.ok === false)
const rep0 = await call('GET', '/api/yt-duty/reports')
check('reports 回陣列', Array.isArray(rep0.json?.reports))
const prune0 = await call('POST', '/api/yt-duty/prune', { keepDays: 90 })
check('prune 回 removed 數字', prune0.code === 200 && typeof prune0.json?.removed === 'number')
const srt0 = await call('GET', '/api/yt-duty/srt?videoId=short')
check('SRT 壞 id 回 ok:false', srt0.json?.ok === false)
const note0 = await call('GET', '/api/yt-duty/note?videoId=short')
check('note 壞 id 回 400', note0.code === 400)
const single0 = await call('POST', '/api/yt-duty/single', { url: 'not-a-url' })
check('single 壞輸入回 started:false', single0.json?.started === false)

console.log(`\n結果：PASS ${pass} / FAIL ${fail}  (temp home: ${HOME})`)
process.exit(fail ? 1 : 0)
