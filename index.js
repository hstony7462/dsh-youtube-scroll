/**
 * dsh-youtube-scroll —— 宿主半端（「刷 YouTube」版刷B站）
 * ============================================================================
 * 這一半負責四件事，模型與瀏覽器都不碰：
 *   1. **設定**：`$DSH_HOME/yt-duty/config.json`（設置頁改、這裡存）
 *   2. **一輪**：到點或手動時，spawn 一個 headless DSH 會話，把 `prompts/duty.md`
 *      （值班章程）+ 當天設定交給它；那一輪的工作目錄 = 插件家（被沙箱關着，只寫得了這裡）
 *   3. **工具**：headless 那一輪透過一次性 overlay 掛上 `mcp/server.mjs`（stdio MCP，
 *      純 Node、零依賴）—— 只給四隻**只讀**工具（搜尋 / 頻道 / 詳情 / 字幕），
 *      發評論、上傳、OAuth 那些**根本不註冊**
 *   4. **HTTP**：設置頁走 `/api/yt-duty/*` 讀寫狀態
 *
 * 家目錄（`$DSH_HOME/yt-duty/`）：config.json / duty.log / headless-overlay.yml / out/<日期>.md
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callMcp } from './lib/mcp-call.mjs'

export const inject = ['webServer']

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE = join(DSH_HOME, 'yt-duty')
const OUT_DIR = join(STATE, 'out')
const LOG_FILE = join(STATE, 'duty.log')
const CFG_FILE = join(STATE, 'config.json')
const STATE_FILE = join(STATE, 'state.json')
const OVERLAY_FILE = join(STATE, 'headless-overlay.yml')
const DUTY_SHIPPED = join(PKG_ROOT, 'prompts', 'duty.md')
const DUTY_HOME = join(STATE, 'duty.md')
const MCP_SERVER = join(PKG_ROOT, 'mcp', 'server.mjs')
const NOTES_DIR = join(STATE, 'notes')
const SEEN_FILE = join(STATE, 'seen.json')
const SINGLE_SHIPPED = join(PKG_ROOT, 'prompts', 'single.md')

const WINDOWS = Object.freeze({
  noon: { label: '中午谷時', start: '12:00', end: '14:00' },
  night: { label: '夜間谷時', start: '18:00', end: '09:00' },
})

const DEFAULTS = Object.freeze({
  perDay: 5,
  peakValley: false,
  noon: true,
  night: true,
  keywords: [],
  channels: [],
  apiKey: '',
  reportLevel: 'full',      // full | brief | off
  transcribe: false,        // 沒字幕的影片 → 本機 Whisper 轉寫
  frames: false,            // 讓模型看縮圖畫面（輔助判斷，燒附件 token）
  dedupeDays: 30,           // 跨日去重：最近 N 天挑過的不要再挑
  maxSearchesPerDay: 80,    // API 搜索配額保護（每次約 100 units，免費每天 10000）
  roundTimeoutSec: 900,     // 一輪最多跑幾秒（超時直接殺掉）
  notify: true,             // 跑完/失敗發系統通知
  asrModel: 'base',         // tiny | base | small | medium
  workspace: '',
  dshBin: '',
  headlessProfile: 'headless',
  overlayMcp: true,
  lastRun: null,
  lastError: '',
})

const CFG_KEYS = Object.keys(DEFAULTS)
const MAX_KEYWORDS = 30
const MAX_CHANNELS = 60

/* ------------------------------------------------------------------ 小工具 */
const ensureDirs = () => {
  try { mkdirSync(OUT_DIR, { recursive: true }) } catch (err) { /* 建不了就讓後面自己報錯 */ }
}

/** 寫日誌：任何情況下都不許把宿主帶走。 */
function log(line) {
  const text = `[${new Date().toISOString()}] ${String(line).replace(/\s+$/, '')}\n`
  try { appendFileSync(LOG_FILE, text, 'utf8') } catch (err) { /* EBUSY / 無權限：丟掉，絕不拋 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return fallback }
}

function writeJson(file, obj) {
  try {
    ensureDirs()
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
    return true
  } catch (err) {
    log(`寫 ${file} 失敗：${err?.message ?? err}`)
    return false
  }
}

/** 設定：白名單 + 範圍鉗制，壞值一律回預設。 */
function sanitize(patch, base) {
  const out = { ...base }
  for (const k of CFG_KEYS) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (k === 'perDay') out[k] = Math.max(0, Math.min(50, Number(v) || 0))
    else if (['peakValley', 'noon', 'night', 'overlayMcp', 'transcribe', 'frames', 'notify'].includes(k)) out[k] = !!v
    else if (k === 'dedupeDays') out[k] = Math.max(0, Math.min(365, Number(v) || 0))
    else if (k === 'maxSearchesPerDay') out[k] = Math.max(0, Math.min(1000, Number(v) || 0))
    else if (k === 'roundTimeoutSec') out[k] = Math.max(60, Math.min(7200, Number(v) || 900))
    else if (k === 'asrModel') out[k] = ['tiny', 'base', 'small', 'medium'].includes(String(v)) ? String(v) : 'base'
    else if (k === 'reportLevel') out[k] = ['full', 'brief', 'off'].includes(String(v)) ? String(v) : 'full'
    else if (k === 'keywords') {
      out[k] = (Array.isArray(v) ? v : String(v ?? '').split('\n'))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
    } else if (k === 'channels') {
      out[k] = (Array.isArray(v) ? v : String(v ?? '').split('\n'))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_CHANNELS)
    } else if (['apiKey', 'workspace', 'dshBin', 'headlessProfile'].includes(k)) out[k] = String(v ?? '').trim()
    else out[k] = v
  }
  return out
}

function loadCfg() {
  const raw = readJson(CFG_FILE, null)
  return sanitize(raw && typeof raw === 'object' ? raw : {}, { ...DEFAULTS })
}

let cfg = loadCfg()

function refreshCfg() {
  cfg = loadCfg()
  return cfg
}

function saveCfg(patch) {
  cfg = sanitize(patch, cfg)
  writeJson(CFG_FILE, cfg)
  return cfg
}

/* -------------------------------------------------------------- 日期與時段 */
const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function inWindow(now, win) {
  const start = minutesOf(win.start)
  const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

/* -------------------------------------------------------------- 日報與計數 */
/** 接受 Date / 'YYYY-MM-DD' / undefined，一律歸一成日期鍵。 */
const normDate = (date) => {
  if (date instanceof Date) return dayKey(date)
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dayKey()
}
const reportPath = (date) => join(OUT_DIR, `${normDate(date)}.md`)

function reportText(date) {
  try { return readFileSync(reportPath(date), 'utf8') } catch (err) { return '' }
}

/** 今天挑了幾條：日報裡 `### <videoId>` 的行數就是事實來源。 */
function countPicked(date) {
  const text = reportText(date)
  if (!text) return 0
  const m = text.match(/^###\s+([A-Za-z0-9_-]{11})\s*$/gm)
  return m ? m.length : 0
}

/* -------------------------------------------------------------- dsh 定位 */
/** 找 dsh CLI 的 bin.js —— 桌面版（Electron）裡 PATH 上沒有它。 */
function findDshCli() {
  const explicit = String(cfg.dshBin || '').trim()
  if (explicit && existsSync(explicit)) return explicit

  const candidates = []
  const exe = process.execPath || ''
  // macOS: /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
  const macContents = /Contents[\\/]MacOS[\\/][^\\/]+$/.test(exe)
    ? exe.replace(/[\\/]MacOS[\\/][^\\/]+$/, '')
    : ''
  if (macContents) {
    candidates.push(join(macContents, 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    candidates.push(join(macContents, 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
  }
  // 從本插件位置往上翻（profile/node_modules/dsh-youtube-scroll → …）
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(join(dirname(process.env.DSH_PROFILE_DIR), '..', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const c of candidates) {
    try {
      if (c.endsWith('.js') && existsSync(c)) return c
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch (err) { /* 忽略壞路徑 */ }
  }
  return ''
}

function resolveDsh() {
  const cli = findDshCli()
  if (cli) {
    if (String(cli).endsWith('.js')) {
      // bin.js：用 node 跑（桌面版必須帶 ELECTRON_RUN_AS_NODE）
      return { command: process.execPath, args: [cli], shell: false, kind: 'bin.js' }
    }
    // 發行版的 CLI 包裝腳本（shell wrapper）：直接執行，並把 node 路徑告訴它
    return { command: cli, args: [], shell: false, kind: 'wrapper' }
  }
  return { missing: true, hint: '找不到 dsh CLI。可在設定裡把 dsh 路徑填成 <應用目錄>/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' }
}

/* ------------------------------------------------------- 一次性 overlay（掛 MCP） */
function yamlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function ensureOverlay(ctx) {
  const lines = []
  // headless profile 自帶 patch 把這三個服務關了 ⇒ 那一輪用不了賬號模型、讀不到憑證
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    lines.push(`- id: ${id}`, '  disabled: false', '')
  }
  // 鏡像當前選中的模型（headless 的默認模型是 API-key 路線，桌面版沒有 key）
  try {
    const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
    const provider = sel?.provider ?? sel?.providerId
    const model = sel?.model ?? sel?.modelId
    if (provider && model) {
      lines.push('- id: agent-default-model', '  config:', `    provider: ${yamlQuote(provider)}`, `    model: ${yamlQuote(model)}`)
      if (sel.reasoningEffort) lines.push(`    reasoningEffort: ${yamlQuote(sel.reasoningEffort)}`)
      lines.push('')
    }
  } catch (err) { /* 老版本沒有這個服務：不寫，退回原行為 */ }

  if (cfg.overlayMcp) {
    lines.push(
      '- insert:',
      '    - id: mcp-yt-duty',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: yt-duty',
      '        transport: stdio',
      `        command: ${yamlQuote(process.execPath)}`,
      '        args:',
      `          - ${yamlQuote(MCP_SERVER)}`,
      '        env:',
      `          ELECTRON_RUN_AS_NODE: '1'`,
      `          YT_API_KEY: ${yamlQuote(cfg.apiKey || '')}
          YT_ASR_MODEL: ${yamlQuote(cfg.asrModel || 'base')}`,
      `          YT_DUTY_HOME: ${yamlQuote(STATE)}`,
      '        failOnStartupError: false',
      '',
    )
  }

  try {
    ensureDirs()
    writeFileSync(OVERLAY_FILE, lines.join('\n'), 'utf8')
    return OVERLAY_FILE
  } catch (err) {
    log(`寫 overlay 失敗：${err?.message ?? err}`)
    return ''
  }
}

/* ------------------------------------------------------- 本機轉寫（Whisper） */
const ASR_VENV = join(STATE, 'asr-venv')
const ASR_PY = join(ASR_VENV, 'bin', 'python')
const ASR_LOG = join(STATE, 'asr-install.log')

function findUv() {
  const cands = [
    String(process.env.UV || ''),
    join(DSH_HOME, 'bili-duty', 'bin', 'uv'),
    join(STATE, 'bin', 'uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ].filter(Boolean)
  for (const c of cands) { try { if (existsSync(c)) return c } catch (err) { /* ignore */ } }
  return ''
}

let asrInstalling = false
function asrReady() {
  if (!existsSync(ASR_PY) || !existsSync(join(PKG_ROOT, 'mcp', 'asr.py'))) return false
  try {
    const r = spawnSync(ASR_PY, [join(PKG_ROOT, 'mcp', 'asr.py'), '--check'], { timeout: 15000, encoding: 'utf8' })
    return r.status === 0
  } catch (err) {
    return false
  }
}

/** 背景安裝轉寫依賴：uv 建 venv + 裝 faster-whisper（幾分鐘，日誌寫 asr-install.log）。 */
function installAsr() {
  if (asrInstalling) return { ok: true, started: false, note: '安裝進行中' }
  const uv = findUv()
  if (!uv) return { ok: false, error: '找不到 uv；請先安裝 uv（或把 uv 放到 ' + join(STATE, 'bin', 'uv') + '）' }
  asrInstalling = true
  try { appendFileSync(ASR_LOG, `\n=== ${new Date().toISOString()} 開始安裝轉寫依賴 ===\n`, 'utf8') } catch (err) { /* ignore */ }
  const write = (buf) => { try { appendFileSync(ASR_LOG, String(buf), 'utf8') } catch (err) { /* ignore */ } }
  const steps = [
    [uv, ['venv', '--python', '3.12', ASR_VENV]],
    // ⚠️ 必須釘 av==18.1.0：PyAV 19 移除了 av.open(metadata_errors=...)，faster-whisper 1.2.1 還在用 ⇒ 每次轉寫 TypeError
    [uv, ['pip', 'install', '--python', ASR_PY, 'faster-whisper', 'av==18.1.0', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']],
  ]
  const runStep = (i) => {
    if (i >= steps.length) {
      asrInstalling = false
      write(`\n=== ${new Date().toISOString()} 安裝結束（asrReady=${asrReady()}）===\n`)
      return
    }
    const [cmd, args] = steps[i]
    write(`\n$ ${cmd} ${args.join(' ')}\n`)
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    child.stdout?.on('data', write)
    child.stderr?.on('data', write)
    child.on('error', (e) => { write(`\n啟動失敗：${e?.message ?? e}\n`); asrInstalling = false })
    child.on('exit', (code) => {
      write(`\n--- exit ${code} ---\n`)
      if (code === 0) runStep(i + 1)
      else asrInstalling = false
    })
  }
  runStep(0)
  return { ok: true, started: true, log: ASR_LOG }
}

/* -------------------------------------------------------------- 值班章程 */
function dutyTemplate() {
  try {
    if (existsSync(DUTY_HOME)) return readFileSync(DUTY_HOME, 'utf8')
  } catch (err) { /* 讀不到就用插件裡那份 */ }
  try { return readFileSync(DUTY_SHIPPED, 'utf8') } catch (err) { return '' }
}

function workspacePersona() {
  const ws = String(cfg.workspace || '').trim()
  if (!ws) return ''
  const file = join(ws, 'AGENTS.md')
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8').slice(0, 6000)
  } catch (err) { return '' }
}

function promptFor() {
  const charter = dutyTemplate().split('<家目錄>').join(STATE)
  const allKws = (cfg.keywords || []).filter(Boolean)
  const chans = (cfg.channels || []).filter(Boolean)
  const persona = workspacePersona()
  const level = String(cfg.reportLevel || 'full')
  const limit = Math.max(0, Number(cfg.perDay || 0) - countPicked())

  // 配額：每次 API 搜索約 100 units，免費每天 10000 ⇒ 用 maxSearchesPerDay 兜住
  const used = apiUsageToday()
  const perDay = Number(cfg.maxSearchesPerDay || 0)
  const allowApi = !!(cfg.apiKey && perDay > 0)
  const remaining = allowApi ? Math.max(0, perDay - used) : allKws.length
  const kws = allKws.slice(0, remaining)
  const trimmed = allKws.length - kws.length
  const seen = seenRecentIds(cfg.dedupeDays)

  const lines = []
  lines.push(`今天是 ${dayKey()}。這一輪的設定（以這裡為準，不要自己猜）：`)
  lines.push(`- 這一輪最多挑 ${limit} 條${limit === 0 ? '（今天額度已滿 —— 只做候選清單，不要新增 ### 條目）' : ''}（今天上限 ${Number(cfg.perDay) || 0} 條，已挑 ${countPicked()} 條）`)
  lines.push(`- 關注頻道（${chans.length} 個）：${chans.length ? chans.map((c) => '`' + c + '`').join('、') : '（沒有填）'}`)
  lines.push(`- 搜索關鍵詞（${kws.length} 個）：${kws.length ? kws.map((c) => '`' + c + '`').join('、') : '（這輪不搜索）'}`)
  if (trimmed > 0) lines.push(`  - ⚠️ 有 ${trimmed} 個關鍵詞因今日 API 搜索配額（已用 ${used}/${perDay} 次）沒有排進這一輪；不要自己補搜。`)
  lines.push(`- 日報詳細度：${level === 'brief' ? '薄版（每條一兩行）' : level === 'off' ? '不在日報裡展開（仍要寫檔案，只寫標題行）' : '完整（每條含「為什麼值得」＋「一句話」）'}`)
  lines.push(`- 看畫面（縮圖）：${cfg.frames ? '**開**（可用 yt_frames 取 1–2 張輔助判斷；以字幕為主，細字看不清）' : '**關**'}`)
  lines.push(`- 本機 Whisper 轉寫（沒字幕的影片）：${cfg.transcribe ? '**開**，模型 ' + String(cfg.asrModel || 'base') + '（可用 yt_asr；每條最多試一次）' : '**關**（沒字幕就跳過並計數）'}`)
  if (seen.length) lines.push(`- 最近 ${Number(cfg.dedupeDays)} 天已經挑過（**不要重複挑**）：${seen.map((id) => '`' + id + '`').join('、')}`)
  else lines.push('- 最近沒有挑過的紀錄（第一次跑或去重關閉）。')
  lines.push(`- 報告路徑：${reportPath()}`)
  lines.push(`- 家目錄：${STATE}`)
  if (cfg.apiKey) lines.push('- YouTube Data API key 已配置：`yt_search` 會走官方 API；失敗會自動退回免 key 搜索頁。')
  else lines.push('- 沒有 API key：`yt_search` 走免 key 搜索頁（可能被限流，失敗就少搜幾個詞，別反覆重試）。')
  if (persona) {
    lines.push('', '## 使用這個插件的人（來自工作區的 AGENTS.md，按這個人設說話）', '```markdown', persona, '```')
  }
  lines.push('', '---', '', charter)
  return { text: lines.join('\n'), apiSearches: allowApi ? kws.length : 0 }
}

/* ----------------------------------------- 跨日去重 / 配額 / 通知 / 檔案工具 */
function loadSeen() {
  const raw = readJson(SEEN_FILE, null)
  return raw && typeof raw === 'object' ? raw : {}
}
function saveSeen(map) { writeJson(SEEN_FILE, map) }

/** 把今天報告裡挑中的 videoId 記進 seen（只留 180 天）。 */
function markSeenFromReport(date) {
  const text = reportText(date)
  const ids = new Set((text.match(/^###\s+([A-Za-z0-9_-]{11})\s*$/gm) || []).map((line) => line.replace(/^###\s+/, '').trim()))
  if (!ids.size) return 0
  const map = loadSeen()
  const now = new Date().toISOString()
  for (const id of ids) map[id] = { at: map[id]?.at || now, picked: now }
  const cutoff = Date.now() - 180 * 86400000
  for (const [id, v] of Object.entries(map)) {
    if (Date.parse(v?.picked || v?.at || 0) < cutoff) delete map[id]
  }
  saveSeen(map)
  return ids.size
}

function seenRecentIds(days) {
  if (!(Number(days) > 0)) return []
  const cutoff = Date.now() - Number(days) * 86400000
  const map = loadSeen()
  return Object.entries(map)
    .filter(([, v]) => Date.parse(v?.picked || v?.at || 0) >= cutoff)
    .map(([id]) => id)
    .slice(-100)
}

function apiUsageToday() {
  const st = readJson(STATE_FILE, {})
  const u = st.apiUsage
  return u && u.date === dayKey() ? Number(u.count) || 0 : 0
}

function bumpApiUsage(n) {
  const add = Math.max(0, Number(n) || 0)
  if (!add) return apiUsageToday()
  const st = readJson(STATE_FILE, {})
  const prev = st.apiUsage && st.apiUsage.date === dayKey() ? Number(st.apiUsage.count) || 0 : 0
  bumpState({ apiUsage: { date: dayKey(), count: prev + add } })
  return prev + add
}

function listReports() {
  try {
    return readdirSync(OUT_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => {
        const full = join(OUT_DIR, f)
        const st = statSync(full)
        return { date: f.replace('.md', ''), bytes: st.size, mtime: st.mtime.toISOString(), picks: countPicked(f.replace('.md', '')) }
      })
  } catch (err) { return [] }
}

function listNotes() {
  try {
    return readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .map((f) => {
        const st = statSync(join(NOTES_DIR, f))
        return { videoId: f.replace('.md', ''), bytes: st.size, mtime: st.mtime.toISOString() }
      })
  } catch (err) { return [] }
}

function pruneOld(keepDays) {
  const days = Math.max(1, Number(keepDays) || 90)
  const cutoff = Date.now() - days * 86400000
  let removed = 0
  try {
    for (const f of readdirSync(OUT_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue
      const full = join(OUT_DIR, f)
      if (statSync(full).mtimeMs < cutoff) { rmSync(full, { force: true }); removed += 1 }
    }
  } catch (err) { /* 目錄不存在就算了 */ }
  const map = loadSeen()
  for (const [id, v] of Object.entries(map)) {
    if (Date.parse(v?.picked || v?.at || 0) < cutoff) delete map[id]
  }
  saveSeen(map)
  return removed
}

function notifyDone(title, body) {
  if (!cfg.notify) return
  try {
    const text = String(body || '').slice(0, 180)
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (err) { /* 通知失敗不影響任何事 */ }
}

async function checkApiKey() {
  const key = String(cfg.apiKey || '').trim()
  if (!key) return { ok: false, error: '尚未填 API key' }
  try {
    const q = new URLSearchParams({ part: 'id', id: 'dQw4w9WgXcQ', key })
    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?' + q.toString(), { signal: AbortSignal.timeout(15000) })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || data.error) {
      return { ok: false, status: res.status, error: (data && data.error && data.error.message) || ('http_' + res.status) }
    }
    return { ok: true, items: (data.items || []).length, note: '這次測試用掉 1 unit 配額' }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 用 MCP server 取字幕 → 組成 SRT 文字。 */
async function srtFor(videoId) {
  const id = String(videoId || '').trim()
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('invalid_video_id')
  const res = await callMcp(MCP_SERVER, 'yt_transcript', { videoId: id }, { env: { YT_DUTY_HOME: STATE, YT_API_KEY: cfg.apiKey || '' }, timeoutMs: 90_000 })
  const segs = Array.isArray(res?.segments) ? res.segments : []
  if (!segs.length) throw new Error('no_captions')
  const ts = (sec) => {
    const v = Math.max(0, Number(sec) || 0)
    const h = Math.floor(v / 3600)
    const m = Math.floor((v % 3600) / 60)
    const whole = Math.floor(v % 60)
    const ms = Math.round((v - Math.floor(v)) * 1000)
    const p = (n, w = 2) => String(n).padStart(w, '0')
    return `${p(h)}:${p(m)}:${p(whole)}.${p(ms, 3)}`
  }
  return segs.map((seg, i) => {
    const start = Number(seg.start) || 0
    const dur = Number(seg.dur) || 2
    return `${i + 1}\n${ts(start)} --> ${ts(start + dur)}\n${String(seg.text || '').trim()}\n`
  }).join('\n')
}

function parseVideoId(input) {
  const raw = String(input || '').trim()
  const m = raw.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || raw.match(/^([A-Za-z0-9_-]{11})$/)
  return m ? m[1] : ''
}

/* -------------------------------------------------------------- 一輪 */
function bumpState(patch) {
  const st = readJson(STATE_FILE, {})
  const next = { ...st, ...patch }
  writeJson(STATE_FILE, next)
  return next
}

function stubReportIfMissing(code) {
  try {
    if (existsSync(reportPath())) return
    ensureDirs()
    const tail = readTail(LOG_FILE, 40)
    writeFileSync(reportPath(), [
      `# YouTube 日報 · ${dayKey()}`,
      '',
      `> ⚠️ 這一輪結束了但沒有生成報告（退出碼 ${code}）。`,
      '> 常見原因：找不到 dsh、MCP 沒掛上、或模型在工具上卡住。完整日誌看家目錄的 `duty.log`。',
      '',
      '```',
      String(tail).trim(),
      '```',
      '',
    ].join('\n'), 'utf8')
    log('這一輪沒寫報告 ⇒ 宿主補了一份佔位報告')
  } catch (err) { log(`補佔位報告失敗：${err?.message ?? err}`) }
}

function readTail(file, lines = 40) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').slice(-lines).join('\n')
  } catch (err) { return '' }
}

let running = false
let runningChild = null
let runningSince = null
let runningMode = ''

function finishState(code, timedOut, single, startedAt) {
  const durationSec = Math.round((Date.now() - startedAt) / 1000)
  const picked = countPicked()
  bumpState({
    lastRoundAt: new Date().toISOString(),
    lastCode: code,
    lastPicked: picked,
    lastDurationSec: durationSec,
    lastMode: single ? 'single' : 'round',
    lastTimedOut: !!timedOut,
  })
  saveCfg({ lastRun: new Date().toISOString(), lastError: code === 0 && !timedOut ? '' : (timedOut ? '這一輪超時被停止' : `一輪退出碼 ${code}`) })
  return { durationSec, picked }
}

/** spawn 一個 headless DSH 會話（headless 那一輪的建立都在這裡）。 */
function spawnHeadless({ why, prompt, single = false, ctx = null }) {
  refreshCfg()
  if (running) return { started: false, why, error: '上一輪還沒結束（先按停止或等它結束）' }
  const dsh = resolveDsh()
  if (dsh.missing) {
    log(`這一輪沒跑：${dsh.hint}`)
    saveCfg({ lastError: dsh.hint })
    return { started: false, why, error: dsh.hint }
  }
  const overlay = ensureOverlay(ctx)
  const profile = String(cfg.headlessProfile || 'headless')
  const args = [...dsh.args, '--profile', profile]
  if (overlay) args.push('--patch', overlay)
  args.push(prompt)

  const timeoutSec = Math.max(60, Number(cfg.roundTimeoutSec) || 900)
  const startedAt = Date.now()
  let timedOut = false

  log(`${single ? '單條解讀' : '刷 YouTube'}開跑（${why}，上限 ${timeoutSec}s）：${dsh.command} ${args.slice(0, 4).join(' ')} … cwd=${STATE}`)
  const child = spawn(dsh.command, args, {
    cwd: STATE,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YT_DUTY_HOME: STATE,
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  })

  running = true
  runningChild = child
  runningSince = new Date(startedAt).toISOString()
  runningMode = single ? 'single' : why

  const pick = (buf) => { try { appendFileSync(LOG_FILE, String(buf), 'utf8') } catch (err) { /* 絕不拋 */ } }
  child.stdout?.on('data', pick)
  child.stderr?.on('data', pick)

  const watchdog = setTimeout(() => {
    timedOut = true
    log(`⏱ 超時 ${timeoutSec}s ⇒ 終止這一輪（可在設定裡調 roundTimeoutSec）`)
    try { child.kill('SIGKILL') } catch (err) { /* already gone */ }
  }, timeoutSec * 1000)
  watchdog.unref?.()

  child.on('error', (err) => {
    clearTimeout(watchdog)
    running = false
    runningChild = null
    runningMode = ''
    log(`${single ? '單條解讀' : '刷 YouTube'}起不來：${err?.message ?? err}`)
    saveCfg({ lastError: String(err?.message ?? err) })
  })

  child.on('exit', (code) => {
    clearTimeout(watchdog)
    running = false
    runningChild = null
    runningMode = ''
    log(`${single ? '單條解讀' : '刷 YouTube'}結束（${why}，code=${code}${timedOut ? '，超時' : ''}）`)
    if (single) {
      const watched = parseVideoId(args[args.length - 1]) || ''
      // 單條那一輪的 videoId 在提示詞裡；用最近改動的筆記判斷有沒有產出
      const notes = listNotes()
      if (notes.length) log(`筆記檔：${notes.length} 份（最新 ${notes[0].videoId}）`)
    } else {
      if (code !== 0 || timedOut) stubReportIfMissing(code)
      const marked = markSeenFromReport()
      log(`去重名單更新 ${marked} 條（今天累計 ${countPicked()} 條）`)
    }
    const { durationSec, picked } = finishState(code, timedOut, single, startedAt)
    notifyDone(single ? '單條解讀完成' : '刷 YouTube 完成',
      single ? `用時 ${durationSec}s（筆記在 notes/）` : `挑到 ${picked} 條，用時 ${durationSec}s`)
  })

  bumpState({ lastStartAt: new Date().toISOString(), lastWhy: why })
  saveCfg({ lastRun: new Date().toISOString(), lastError: '' })
  return { started: true, why, profile, cwd: STATE, log: LOG_FILE, timeoutSec, single }
}

function runRound(why = 'manual', ctx = null) {
  try {
    refreshCfg()
    if (running) return { started: false, why, error: '上一輪還沒結束' }
    const { text, apiSearches } = promptFor()
    if (apiSearches > 0) bumpApiUsage(apiSearches)
    return spawnHeadless({ why, prompt: text, ctx })
  } catch (err) {
    log(`刷 YouTube 開跑失敗（${why}）：${err?.stack ?? err}`)
    saveCfg({ lastError: String(err?.message ?? err) })
    return { started: false, why, error: String(err?.message ?? err) }
  }
}

/** 單條連結：完整解讀 → notes/<videoId>.md */
function runSingle(input, ctx = null) {
  try {
    refreshCfg()
    if (running) return { started: false, error: '已經有一輪在跑，先等它結束或按停止' }
    const id = parseVideoId(input)
    if (!id) return { started: false, error: '無法辨識 videoId —— 貼完整 YouTube 連結或 11 位 id' }
    let charter = ''
    try { charter = readFileSync(SINGLE_SHIPPED, 'utf8') } catch (err) { charter = '' }
    ensureDirs()
    try { mkdirSync(NOTES_DIR, { recursive: true }) } catch (err) { /* 已存在 */ }
    const notePath = join(NOTES_DIR, `${id}.md`)
    const prompt = [
      `今天是 ${dayKey()}。使用者要你完整解讀這一條影片：`,
      `- 連結：https://www.youtube.com/watch?v=${id}`,
      `- videoId：${id}`,
      `- 筆記路徑：${notePath}（寫到這裡；資料夾已建好）`,
      `- 家目錄：${STATE}`,
      '',
      charter,
    ].join('\n')
    return spawnHeadless({ why: 'single', prompt, single: true, ctx })
  } catch (err) {
    log(`單條解讀開跑失敗：${err?.stack ?? err}`)
    return { started: false, error: String(err?.message ?? err) }
  }
}

/** 手動停止目前那一輪。 */
function stopRound() {
  if (!runningChild) return { ok: false, error: '現在沒有在跑的一輪' }
  const child = runningChild
  log('收到停止請求 ⇒ 終止這一輪')
  try { child.kill('SIGTERM') } catch (err) { /* already gone */ }
  setTimeout(() => { try { child.kill('SIGKILL') } catch (err) { /* already gone */ } }, 3000).unref?.()
  return { ok: true, stopped: true }
}

/* -------------------------------------------------------------- 狀態 */
function status() {
  const now = new Date()
  const st = readJson(STATE_FILE, {})
  const picked = countPicked()
  const windows = {}
  for (const [k, w] of Object.entries(WINDOWS)) {
    windows[k] = {
      label: w.label,
      start: w.start,
      end: w.end,
      switchOn: !!cfg[k],
      opening: inWindow(now, w),
    }
  }
  return {
    ok: true,
    today: dayKey(now),
    ranToday: Number(st.lastRoundAt || '').toString().startsWith(dayKey(now)) ? 1 : 0,
    pickedToday: picked,
    perDay: Number(cfg.perDay) || 0,
    peakValley: !!cfg.peakValley,
    windows,
    report: reportPath(now),
    reportExists: existsSync(reportPath(now)),
    lastRun: cfg.lastRun || st.lastRoundAt || null,
    lastError: cfg.lastError || '',
    lastDurationSec: Number(st.lastDurationSec) || 0,
    running,
    runningSince,
    runningMode,
    singleRunning: runningMode === 'single',
    seenCount: Object.keys(loadSeen()).length,
    apiSearchesToday: apiUsageToday(),
    apiSearchesLimit: Number(cfg.maxSearchesPerDay) || 0,
    reports: listReports().length,
    notes: listNotes(),
    home: STATE,
    log: LOG_FILE,
    config: cfg,
  }
}

/* -------------------------------------------------------------- 定時器 */
function tick(ctx) {
  try {
    refreshCfg()
    if (!cfg.peakValley) return
    if (running) return
    const now = new Date()
    const limit = Number(cfg.perDay || 0)
    if (limit > 0 && countPicked(now) >= limit) return
    const st = readJson(STATE_FILE, {})
    for (const k of ['noon', 'night']) {
      if (!cfg[k]) continue
      if (!inWindow(now, WINDOWS[k])) continue
      const key = `${dayKey(now)}:${k}`
      if (st.windows?.[key]) continue
      bumpState({ windows: { ...(st.windows || {}), [key]: true } })
      log(`到點（${WINDOWS[k].label}）⇒ 開跑一輪`)
      runRound(`window:${k}`, ctx)
      return
    }
  } catch (err) {
    log(`定時器這一跳出錯（已兜住）：${err?.stack ?? err}`)
  }
}

/* -------------------------------------------------------------- 宿主入口 */
export function apply(ctx, config) {
  ensureDirs()
  try { mkdirSync(NOTES_DIR, { recursive: true }) } catch (err) { /* ignore */ }

  // 章程：首次從插件裡鋪一份到家目錄（用戶改了就以家目錄為準）
  try {
    if (!existsSync(DUTY_HOME) && existsSync(DUTY_SHIPPED)) {
      writeFileSync(DUTY_HOME, readFileSync(DUTY_SHIPPED, 'utf8'), 'utf8')
      log('已鋪好值班章程')
    }
  } catch (err) { log(`鋪章程失敗：${err?.message ?? err}`) }

  // 首次寫一份預設設定，讓設置頁有東西可讀
  if (!existsSync(CFG_FILE)) writeJson(CFG_FILE, cfg)

  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch (err) { /* 連線已斷：忽略 */ }
  }
  const readBody = (req) => new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += String(c); if (buf.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (err) { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  async function handle(req, res, url) {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/yt-duty/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/yt-duty/config') return sendJson(res, 200, { ok: true, config: cfg, home: STATE })
    if (req.method === 'POST' && path === '/api/yt-duty/config') {
      const body = await readBody(req)
      const saved = saveCfg(body && typeof body.patch === 'object' && body.patch ? body.patch : body)
      return sendJson(res, 200, { ok: true, config: saved })
    }
    if (req.method === 'POST' && path === '/api/yt-duty/run') {
      const r = runRound('manual', ctx)
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (req.method === 'POST' && path === '/api/yt-duty/stop') {
      return sendJson(res, 200, stopRound())
    }
    if (req.method === 'POST' && path === '/api/yt-duty/single') {
      const body = await readBody(req)
      const r = runSingle(String(body?.url || body?.videoId || ''), ctx)
      return sendJson(res, 200, { ok: true, ...r })
    }
    if (req.method === 'GET' && path === '/api/yt-duty/check-key') {
      return sendJson(res, 200, await checkApiKey())
    }
    if (req.method === 'GET' && path === '/api/yt-duty/reports') {
      return sendJson(res, 200, { ok: true, reports: listReports(), notes: listNotes() })
    }
    if (req.method === 'POST' && path === '/api/yt-duty/prune') {
      const body = await readBody(req)
      const days = Math.max(1, Math.min(3650, Number(body?.keepDays) || 90))
      const removed = pruneOld(days)
      return sendJson(res, 200, { ok: true, removed, keepDays: days })
    }
    if (req.method === 'GET' && path === '/api/yt-duty/srt') {
      const id = String(url.searchParams.get('videoId') || '')
      try {
        const text = await srtFor(id)
        return sendJson(res, 200, { ok: true, videoId: id, text })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: String(err?.message ?? err) })
      }
    }
    if (req.method === 'GET' && path === '/api/yt-duty/note') {
      const id = String(url.searchParams.get('videoId') || '')
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad videoId' })
      const file = join(NOTES_DIR, id + '.md')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch (err) { /* 還沒生成 */ }
      return sendJson(res, 200, { ok: true, videoId: id, exists: !!text, path: file, text })
    }
    if (req.method === 'GET' && path === '/api/yt-duty/report') {
      const date = String(url.searchParams.get('date') || dayKey())
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'bad date' })
      const file = reportPath(date)
      return sendJson(res, 200, { ok: true, date, path: file, exists: existsSync(file), text: reportText(date) })
    }
    if (req.method === 'GET' && path === '/api/yt-duty/asr-status') {
      let tail = ''
      try { tail = readFileSync(ASR_LOG, 'utf8').split('\n').slice(-6).join('\n') } catch (err) { /* 尚未安裝過 */ }
      return sendJson(res, 200, { ok: true, ready: asrReady(), installing: asrInstalling, venv: ASR_VENV, model: cfg.asrModel || 'base', log: ASR_LOG, tail })
    }
    if (req.method === 'POST' && path === '/api/yt-duty/asr-install') {
      return sendJson(res, 200, installAsr())
    }
    if (req.method === 'POST' && path === '/api/yt-duty/open') {
      const body = await readBody(req)
      const what = String(body?.what || 'out')
      const dir = what === 'home' ? STATE : OUT_DIR
      try {
        ensureDirs()
        if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
        return sendJson(res, 200, { ok: true, dir })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: String(err?.message ?? err), dir })
      }
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/yt-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }), 'youtube-scroll: /api/yt-duty 路由')
  } catch (err) { log(`HTTP 路由沒掛上：${err?.message ?? err}`) }

  try {
    const timer = setInterval(() => tick(ctx), 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'youtube-scroll: 定時器')
  } catch (err) { log(`定時器沒起來：${err?.message ?? err}`) }

  if (!existsSync(MCP_SERVER)) log(`⚠️ 找不到 MCP server：${MCP_SERVER}（這一輪不會有工具）`)
  log(`已掛載（家=${STATE}，峰谷=${cfg.peakValley ? '開' : '關'}，每輪上限=${cfg.perDay}）`)
}
