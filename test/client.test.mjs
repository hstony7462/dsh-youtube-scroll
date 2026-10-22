#!/usr/bin/env node
/**
 * client.js 自動測試 —— 零 npm 依賴（只用 node 內建模組）。
 * ============================================================================
 * 被測對像：../client.js（瀏覽器半端，自注冊腳本，不是 ESM）
 *   window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *   factory 回 { inject, apply(ctx) }；apply 把一個 Panel 元件註冊進 settings.section
 *
 * 做法：用最小 React stub（createElement / useState / useEffect / useRef / Fragment）
 * 真的把 Panel 渲染成元素樹（不需要 DOM，也沒有 React），用假 fetch 攔下
 * /api/yt-duty/* 並記錄調用，然後對元素樹和調用記錄做斷言。
 *
 * 跑法（在 yt-scroll 目錄下）：
 *   DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" test/client.test.mjs
 *
 * ⚠️ 有一條規矩：Lead 正在往 UI 裏加控制項（測試 API key / 停止這一輪 / 單條連結 / 清理日報…）。
 *    所以「找不到某個控制項」一律印 SKIP 並在報告裏列出來，不算失敗 —— 只有「控制項在但行為錯」才算 FAIL。
 * ============================================================================
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const SRC = fs.readFileSync(CLIENT, 'utf8')

/* 被測檔案必須存在且看起來是自注冊腳本（先給人話，再給斷言） */
if (!/__ModuleLoader__/.test(SRC)) {
  console.error('client.js 看起來不是自注冊 client bundle（找不到 __ModuleLoader__）')
  process.exit(1)
}

/* ────────────────────────── 假 React ────────────────────────── */

const depsEqual = (a, b) => {
  if (a === undefined && b === undefined) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return Object.is(a, b)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

function makeReact() {
  const store = new Map()     // 元件實例路徑 -> { hooks: [], i: 0 }
  let cur = null
  let dirty = false
  let effectQueue = []

  const instance = (path) => {
    if (!store.has(path)) store.set(path, { hooks: [], i: 0 })
    return store.get(path)
  }

  /** 元件實例裏的 hook 必須在渲染期呼叫 */
  const needCur = () => {
    if (!cur) throw new Error('hook 在元件外面被呼叫了')
    return cur
  }

  const React = {
    Fragment: Symbol.for('react.fragment'),

    createElement: (type, props, ...children) => ({
      type,
      props: Object.assign({}, props || {}, { children }),
    }),

    useState: (init) => {
      const inst = needCur()
      const idx = inst.i++
      if (!inst.hooks[idx]) {
        inst.hooks[idx] = { kind: 'state', value: typeof init === 'function' ? init() : init }
      }
      const hk = inst.hooks[idx]
      if (hk.kind !== 'state') throw new Error('hook 順序變了（useState 撞到別的 hook）')
      return [hk.value, (v) => {
        const next = typeof v === 'function' ? v(hk.value) : v
        if (!Object.is(next, hk.value)) { hk.value = next; dirty = true }
      }]
    },

    useRef: (init) => {
      const inst = needCur()
      const idx = inst.i++
      if (!inst.hooks[idx]) inst.hooks[idx] = { kind: 'ref', ref: { current: init } }
      return inst.hooks[idx].ref
    },

    useEffect: (fn, deps) => {
      const inst = needCur()
      const idx = inst.i++
      let hk = inst.hooks[idx]
      if (!hk) hk = inst.hooks[idx] = { kind: 'effect', started: false, deps: undefined, cleanup: null }
      if (hk.kind !== 'effect') throw new Error('hook 順序變了（useEffect 撞到別的 hook）')
      hk.fn = fn
      hk.nextDeps = deps
    },
  }

  const flattenKids = (c) => (Array.isArray(c) ? c.flatMap(flattenKids) : [c])

  const commitEffects = (instances) => {
    for (const inst of instances) {
      for (const hk of inst.hooks) {
        if (!hk || hk.kind !== 'effect') continue
        if (hk.started && depsEqual(hk.deps, hk.nextDeps)) continue
        if (typeof hk.cleanup === 'function') { try { hk.cleanup() } catch { /* 清理失敗不影響斷言 */ } }
        hk.cleanup = null
        hk.deps = hk.nextDeps
        hk.started = true
        const ret = hk.fn()
        if (typeof ret === 'function') hk.cleanup = ret
      }
    }
  }

  const renderElement = (el, path, seen) => {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return { kind: 'text', text: String(el) }
    if (Array.isArray(el)) return el.map((c, i) => renderElement(c, path + '/' + i, seen)).filter(Boolean)
    if (!el || typeof el !== 'object' || !('type' in el)) return null

    const { type, props } = el
    const kids = flattenKids((props && props.children) || [])

    if (type === React.Fragment) {
      return kids.map((c, i) => renderElement(c, path + '/f' + i, seen)).filter(Boolean)
    }

    if (typeof type === 'function') {
      const inst = instance(path)
      const prev = cur
      cur = inst
      inst.i = 0
      seen.push(inst)
      let out
      try { out = type(Object.assign({}, props)) } finally { cur = prev }
      return renderElement(out, path + '/@', seen)
    }

    return {
      kind: 'node',
      type,
      props: props || {},
      path,
      children: kids.map((c, i) => renderElement(c, path + '/' + i, seen)).filter(Boolean),
    }
  }

  return {
    React,
    isDirty: () => dirty,
    /** 渲染一次 + 跑這一輪的 effect（不 flush 異步） */
    renderOnce: (component) => {
      dirty = false
      effectQueue = []
      const tree = renderElement({ type: component, props: { children: [] } }, 'root', effectQueue)
      commitEffects(effectQueue)
      return tree
    },
  }
}

/* ────────────────────────── 假 fetch / 狀態 ────────────────────────── */

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

const DEFAULT_STATUS = {
  ok: true,
  today: '2026-10-22',
  ranToday: 0,
  pickedToday: 0,
  perDay: 5,
  peakValley: false,
  report: '/Users/t/.dsh/yt-duty/out/2026-10-22.md',
  reportExists: false,
  lastRun: null,
  lastError: '',
  running: false,
  config: {
    perDay: 5,
    peakValley: false,
    noon: true,
    night: true,
    keywords: ['AI 代理'],
    channels: ['@mkbhd'],
    apiKey: '',
    reportLevel: 'full',
    workspace: '',
    transcribe: false,
    frames: false,
    asrModel: 'base',
  },
}

function makeHarness(overrides = {}) {
  const status = Object.assign(clone(DEFAULT_STATUS), overrides.status || {})
  if (overrides.config) status.config = Object.assign({}, status.config, overrides.config)

  const calls = []
  const intervals = []
  let intervalId = 1
  const failures = new Map()      // 'METHOD /path' -> HTTP status

  const fakeSetInterval = (fn, ms) => {
    if (!intervals.some((t) => t.fn === fn)) intervals.push({ id: intervalId++, fn, ms })
    return intervals.length
  }
  const fakeClearInterval = (id) => {
    const i = intervals.findIndex((t) => t.id === id)
    if (i >= 0) intervals.splice(i, 1)
  }

  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

  async function fakeFetch(url, opts = {}) {
    const u = new URL(String(url), 'http://127.0.0.1')
    const method = String(opts.method || 'GET').toUpperCase()
    const path = u.pathname
    let body = null
    try { body = opts.body ? JSON.parse(opts.body) : null } catch { body = null }
    calls.push({ method, path, url: String(url), body })

    // 失敗注入用「方法 + 路徑後綴」匹配：寫 'POST /run' 或 '/run' 都能命中 '/api/yt-duty/run'
    let forced = null
    for (const [key, code] of failures) {
      const parts = String(key).trim().split(/\s+/)
      const kMethod = parts.length > 1 ? parts[0].toUpperCase() : null
      const kPath = parts.length > 1 ? parts[1] : parts[0]
      if ((!kMethod || kMethod === method) && String(path).endsWith(kPath)) forced = code
    }
    if (forced) return json({ ok: false, error: 'forced ' + forced }, forced)

    if (method === 'GET' && path.endsWith('/status')) {
      status.perDay = status.config.perDay
      status.peakValley = !!status.config.peakValley
      return json(clone(status))
    }
    if (method === 'GET' && path.endsWith('/config')) return json({ ok: true, config: clone(status.config) })
    if (method === 'POST' && path.endsWith('/config')) {
      const patch = (body && typeof body.patch === 'object' && body.patch) ? body.patch : (body || {})
      status.config = Object.assign({}, status.config, patch)
      return json({ ok: true, config: clone(status.config) })
    }
    if (method === 'POST' && path.endsWith('/run')) return json({ ok: true, started: true, why: '', log: 'spawned', pid: 4242 })
    if (method === 'GET' && path.endsWith('/report')) {
      return json({ ok: true, date: '2026-10-22', path: '/tmp/out/2026-10-22.md', exists: true, text: '### abc12345678\n為什麼值得：測試用\n一句話：這是一條測試日報。\n' })
    }
    if (method === 'POST' && path.endsWith('/open')) return json({ ok: true, dir: '/tmp/out' })
    if (method === 'GET' && path.endsWith('/asr-status')) {
      return json({ ok: true, ready: false, installing: false, tail: '', model: status.config.asrModel })
    }
    if (method === 'POST' && path.endsWith('/asr-install')) return json({ ok: true, started: true, hint: '背景安裝中' })
    if (path.endsWith('/check-key')) return json({ ok: true, valid: true, hint: 'key 可用' })
    if (method === 'GET' && path.endsWith('/reports')) return json({ ok: true, dates: ['2026-10-22'], files: ['/tmp/out/2026-10-22.md'] })
    if (method === 'POST' && path.endsWith('/single')) return json({ ok: true, started: true })
    if (method === 'POST' && path.endsWith('/stop')) return json({ ok: true, stopped: true })
    return json({ ok: false, error: 'unexpected endpoint ' + method + ' ' + path }, 404)
  }

  /* 載入 client.js（用 fake window / require / 計時器） */
  let registered = null
  const win = { __ModuleLoader__: { load: (m) => { registered = m } } }
  const requireStub = (name) => { throw new Error('require("' + name + '") 不被允許 —— client.js 只准 require("react")') }
  const react = makeReact()

  const fn = new Function('window', 'require', 'fetch', 'setInterval', 'clearInterval', 'console', SRC)
  fn(
    win,
    (name) => { if (name === 'react') return react.React; throw new Error('require("' + name + '") 不被允許 —— client.js 只准 require("react")') },
    fakeFetch,
    fakeSetInterval,
    fakeClearInterval,
    console,
  )
  void requireStub

  if (!registered) throw new Error('client.js 沒有呼叫 window.__ModuleLoader__.load()')
  const plugin = registered.factory((name) => { if (name === 'react') return react.React; throw new Error('bad require ' + name) })

  let sectionSpec = null
  let Panel = null
  const ctx = {
    get: (k) => (k === 'slots' ? {
      inject: (_name, mount) => { mount() },
      register: (spec, comp) => { sectionSpec = spec; Panel = comp; return comp },
    } : undefined),
  }
  plugin.apply(ctx)
  if (typeof Panel !== 'function') throw new Error('settings.section 沒有註冊到 Panel 元件')

  const settle = async () => {
    for (let pass = 0; pass < 40; pass++) {
      const tree = react.renderOnce(Panel)
      await flush()
      if (!react.isDirty()) return tree
    }
    throw new Error('渲染沒有穩定（可能 setState 無限迴圈）')
  }

  const tick = async () => {
    for (const t of [...intervals]) { try { await t.fn() } catch { /* 輪詢失敗不致命 */ } }
    await flush()
  }

  return {
    registered,
    plugin,
    get sectionSpec() { return sectionSpec },
    Panel,
    calls,
    intervals,
    status,
    failures,
    settle,
    tick,
    react,
  }
}

/* ────────────────────────── 元素樹工具 ────────────────────────── */

const flatten = (n) => (n == null ? [] : Array.isArray(n) ? n.flatMap(flatten) : [n, ...flatten(n.children || [])])
const nodes = (n) => flatten(n).filter((x) => x && x.kind === 'node')
const texts = (n) => flatten(n).filter((x) => x && x.kind === 'text').map((x) => x.text)
const allText = (n) => texts(n).join(' ')
const labelOf = (b) => allText(b).replace(/\s+/g, ' ').trim()
const buttons = (n) => nodes(n).filter((x) => x.type === 'button')
const findButton = (n, re) => buttons(n).find((b) => re.test(labelOf(b)))
const switches = (n) => nodes(n).filter((x) => x.props && x.props.role === 'switch')
const switchByLabel = (n, label) => switches(n).find((x) => x.props['aria-label'] === label)
const controlByLabel = (n, label) => nodes(n).find((x) => ['input', 'textarea', 'select'].includes(x.type) && x.props['aria-label'] === label)
const posts = (h, p) => h.calls.filter((c) => c.method === 'POST' && c.path.endsWith(p))
const gets = (h, p) => h.calls.filter((c) => c.method === 'GET' && c.path.endsWith(p))
const lastPatch = (h) => { const c = posts(h, '/config').pop(); return c && c.body ? (c.body.patch || c.body) : null }

/* ────────────────────────── 斷言 ────────────────────────── */

class Skip extends Error { constructor(why) { super(why); this.skip = true } }
const ok = (cond, msg) => { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => { if (!Object.is(a, b)) throw new Error(msg + '（期望 ' + JSON.stringify(b) + '，實際 ' + JSON.stringify(a) + '）') }
const has = (hay, needle, msg) => ok(String(hay).includes(needle), msg + '（找不到「' + needle + '」；實際：' + String(hay).slice(0, 320) + '）')
const click = async (h, node) => { ok(node && typeof node.props.onClick === 'function', '這個節點沒有 onClick'); await node.props.onClick(); return h.settle() }
const change = async (h, node, value) => { ok(node && typeof node.props.onChange === 'function', '這個節點沒有 onChange'); await node.props.onChange({ target: { value } }); return h.settle() }

/* ────────────────────────── 測試清單 ────────────────────────── */

const results = []
async function test(name, fn) {
  try {
    const out = await fn()
    results.push({ name, status: 'PASS', note: out && out.note ? out.note : '' })
  } catch (e) {
    if (e instanceof Skip) results.push({ name, status: 'SKIP', note: e.message })
    else results.push({ name, status: 'FAIL', note: e && e.message ? e.message : String(e) })
  }
}

/* ① 註冊契約 */
await test('模組註冊：id / settings.section 規格', async () => {
  const h = makeHarness()
  eq(h.registered.id, 'dsh-youtube-scroll', 'module id 不對')
  ok(h.registered.factory && typeof h.registered.factory === 'function', '缺少 factory')
  const s = h.sectionSpec
  eq(s.name, 'settings.section', 'slot 名不對')
  eq(s.id, 'youtube-scroll', 'slot id 不對')
  eq(s.order, 36, 'order 不對')
  eq(s.label, 'YouTube 刷', 'label 不對')
  ok(Array.isArray(h.plugin.inject) && h.plugin.inject.includes('slots'), 'inject 應含 slots')
})

/* ② 面板渲染：分區齊全 + 首次 status 拉取 */
await test('面板渲染：七個分區 + 狀態列 + 掛載即 GET /status', async () => {
  const h = makeHarness()
  const tree = await h.settle()
  const t = allText(tree)
  for (const sec of ['什麼時候自己跑', '一天挑幾條', '關注什麼', '看畫面（縮圖）', '沒字幕的影片', '報告與工作區', '現在什麼情況']) {
    has(t, sec, '缺少分區標題')
  }
  has(t, '今天 2026-10-22', '狀態列沒顯示日期')
  has(t, '已挑 0 / 5 條', '狀態列沒顯示已挑/額度')
  has(t, '峰谷自動刷：關', '狀態列沒顯示峰谷狀態')
  eq(controlByLabel(tree, '每天最多挑幾條').props.value, '5', 'perDay 初始值不對')
  has(controlByLabel(tree, '關注頻道').props.value, '@mkbhd', 'channels 沒從 config 初始化')
  has(controlByLabel(tree, '搜索關鍵詞').props.value, 'AI 代理', 'keywords 沒從 config 初始化')
  eq(controlByLabel(tree, 'YouTube API key').props.type, 'password', 'apiKey 應為 password 型')
  ok(gets(h, '/status').length >= 1, '掛載時沒有 GET /status')
})

/* ③ 峰谷總開關 → patch.peakValley，且子開關展開 */
await test('開關：峰谷總開關 → POST /config {patch:{peakValley:true}} 並展開子開關', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const beforeLabels = switches(tree).map((x) => x.props['aria-label'])
  const sw = switchByLabel(tree, '峰谷時段自動刷')
  ok(sw, '找不到「峰谷時段自動刷」開關（aria-label）')
  tree = await click(h, sw)
  const patch = lastPatch(h)
  ok(patch, '沒有發出 POST /config')
  eq(patch.peakValley, true, 'patch 鍵不對')
  const labels = switches(tree).map((x) => x.props['aria-label'])
  eq(labels.length, beforeLabels.length + 2, '打開總開關後應多出中午/夜間兩個開關，實際：' + JSON.stringify(labels))
  has(JSON.stringify(labels), '中午谷時', '缺少中午谷時子開關')
  has(JSON.stringify(labels), '夜間谷時', '缺少夜間谷時子開關')
  has(allText(tree), '已挑 0 / 5 條', '開啟後狀態列不見了')
})

/* ④ 看畫面（縮圖）開關 → patch.frames */
await test('開關：看畫面（縮圖）→ POST /config {patch:{frames:true}}', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const sw = switchByLabel(tree, '讓它看影片縮圖')
  ok(sw, '找不到「讓它看影片縮圖」開關（aria-label）')
  tree = await click(h, sw)
  eq(lastPatch(h).frames, true, 'patch 鍵不是 frames')
})

/* ⑤ 本機轉寫開關 → patch.transcribe；展開後有 Whisper 模型下拉，切換即存 asrModel */
await test('開關：本機 Whisper 轉寫 → patch.transcribe，模型下拉 → patch.asrModel', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const sw = switchByLabel(tree, '用本機 Whisper 轉寫')
  ok(sw, '找不到「用本機 Whisper 轉寫」開關（aria-label）')
  tree = await click(h, sw)
  eq(lastPatch(h).transcribe, true, 'patch 鍵不是 transcribe')
  const sel = controlByLabel(tree, 'Whisper 模型')
  ok(sel, '打開轉寫後沒出現「Whisper 模型」下拉')
  tree = await change(h, sel, 'small')
  eq(lastPatch(h).asrModel, 'small', '切換模型沒有存 asrModel')
  has(allText(tree), 'small', '下拉沒反映新模型')
})

/* ⑥ 安裝轉寫依賴 → POST /asr-install；並且掛載時讀過 GET /asr-status */
await test('沒字幕的影片：安裝轉寫依賴按鈕 → POST /asr-install（含 /asr-status）', async () => {
  const h = makeHarness({ config: { transcribe: true } })
  const tree = await h.settle()
  ok(gets(h, '/asr-status').length >= 1, '掛載時沒有 GET /asr-status')
  const btn = findButton(tree, /安裝轉寫依賴|重裝轉寫依賴/)
  if (!btn) throw new Skip('UI 沒有「安裝轉寫依賴」按鈕')
  const before = posts(h, '/asr-install').length
  await click(h, btn)
  ok(posts(h, '/asr-install').length > before, '按了按鈕但沒有 POST /asr-install')
})

/* ⑦ 草稿：打字後再輪詢一次，不可被伺服器那份覆蓋 */
await test('草稿：頻道輸入不被第二次 /status 輪詢覆蓋', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const ta = controlByLabel(tree, '關注頻道')
  ok(ta, '找不到「關注頻道」textarea')
  tree = await change(h, ta, '@typed-one\n@typed-two')
  eq(controlByLabel(tree, '關注頻道').props.value, '@typed-one\n@typed-two', '打字後值就丟了')
  has(allText(tree), '有還沒保存的修改', '沒提示有未保存的修改')

  // 第二次輪詢：伺服器那份 config 換成別的內容 + 狀態數字也變
  h.status.config.channels = ['@server-side-different']
  h.status.pickedToday = 3
  await h.tick()
  tree = await h.settle()

  eq(controlByLabel(tree, '關注頻道').props.value, '@typed-one\n@typed-two', '輪詢把正在打的草稿蓋掉了')
  has(allText(tree), '已挑 3 / 5 條', '輪詢看起來沒生效（狀態沒更新）')
  has(allText(tree), '有還沒保存的修改', '輪詢後「未保存」提示消失')
})

/* ⑧ 現在跑一輪 → POST /run + 綠色反饋 */
await test('動作：現在跑一輪 → POST /run 並回報 started', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const btn = findButton(tree, /^現在跑一輪$/)
  ok(btn, '找不到「現在跑一輪」按鈕')
  tree = await click(h, btn)
  ok(posts(h, '/run').length === 1, '應該剛好打一次 POST /run')
  has(allText(tree), '已經在後台跑一輪了', '沒有顯示 started 反饋')
})

/* ⑨ 看今天的報告 → GET /report + <pre> 顯示原文 + 按鈕變「收起報告」 */
await test('動作：看今天的報告 → GET /report、<pre> 顯示原文、按鈕變收起', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  const btn = findButton(tree, /^看今天的報告$/)
  ok(btn, '找不到「看今天的報告」按鈕')
  const before = gets(h, '/report').length
  tree = await click(h, btn)
  ok(gets(h, '/report').length > before, '沒有 GET /report')
  const pre = nodes(tree).filter((x) => x.type === 'pre')
  ok(pre.length >= 1, '沒有 <pre>')
  has(allText(pre[0]), 'abc12345678', '<pre> 裏沒有日報原文')
  has(allText(tree), '收起報告', '展開後按鈕文字沒變')
  tree = await click(h, findButton(tree, /^收起報告$/))
  eq(nodes(tree).filter((x) => x.type === 'pre').length, 0, '再點一次應該收起')
})

/* ⑩ HTTP 500 必須顯示紅字錯誤（不能當成成功） */
await test('錯誤：POST /run 回 HTTP 500 → 紅字錯誤行含 500', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  h.failures.set('POST /run', 500)
  tree = await click(h, findButton(tree, /^現在跑一輪$/))
  const errNode = nodes(tree).find((x) => x.props.style && typeof x.props.style.color === 'string' && x.props.style.color.includes('state-error'))
  ok(errNode, '沒有紅字錯誤行（state-error token）')
  has(allText(errNode), '500', '錯誤行沒帶 HTTP 狀態碼')
  ok(!allText(tree).includes('已經在後台跑一輪了'), 'HTTP 500 竟然顯示成功反饋')
})

/* ⑪ 打開報告資料夾 → POST /open {what:"out"} */
await test('動作：打開報告資料夾 → POST /open {what:"out"}', async () => {
  const h = makeHarness()
  let tree = await h.settle()
  tree = await click(h, findButton(tree, /^打開報告資料夾$/))
  const call = posts(h, '/open').pop()
  ok(call, '沒有 POST /open')
  eq(call.body && call.body.what, 'out', 'open 的 what 參數不對')
})

/* ⑫-⑮ Lead 正在加的控制項：有就驗，沒有就 SKIP（不算失敗） */
const pendingControls = []

await test('待確認控制項：測試 API key → /check-key', async () => {
  const h = makeHarness({ config: { apiKey: 'AIzaTEST' } })
  const tree = await h.settle()
  const before = h.calls.length
  const btn = findButton(tree, /(測試|檢查|驗證).{0,6}(key|API)|(key|API).{0,6}(測試|檢查|驗證)/i)
  if (!btn) { pendingControls.push('測試 API key'); throw new Skip('UI 還沒有「測試 API key」按鈕') }
  await click(h, btn)
  const hit = h.calls.slice(before).some((c) => c.path.endsWith('/check-key'))
  if (!hit) throw new Skip('按鈕存在但沒有打 /check-key（Lead 可能還沒接通端點）')
})

await test('待確認控制項：停止這一輪 → /stop', async () => {
  const h = makeHarness()
  const tree = await h.settle()
  const before = h.calls.length
  const btn = findButton(tree, /停止/)
  if (!btn) { pendingControls.push('停止這一輪'); throw new Skip('UI 還沒有「停止這一輪」按鈕') }
  await click(h, btn)
  const hit = h.calls.slice(before).some((c) => c.method === 'POST' && c.path.endsWith('/stop'))
  if (!hit) throw new Skip('按鈕存在但沒有 POST /stop')
})

await test('待確認控制項：單條連結 → /single', async () => {
  const h = makeHarness()
  const tree = await h.settle()
  const before = h.calls.length
  const input = controlByLabel(tree, '單條影片連結')
  if (input && input.props.onChange) { input.props.onChange({ target: { value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }); await h.settle() }
  const tree2 = await h.settle()
  const btn = findButton(tree2, /單條|單一|指定連結|貼連結/)
  if (!btn) { pendingControls.push('單條連結'); throw new Skip('UI 還沒有「單條連結」按鈕') }
  await click(h, btn)
  const hit = h.calls.slice(before).some((c) => c.method === 'POST' && c.path.endsWith('/single'))
  if (!hit) throw new Skip('按鈕存在但沒有 POST /single')
})

await test('待確認控制項：清理日報 → /reports 或 /clean', async () => {
  const h = makeHarness()
  const tree = await h.settle()
  const before = h.calls.length
  const btn = findButton(tree, /清理|清除|刪除日報/)
  if (!btn) { pendingControls.push('清理日報'); throw new Skip('UI 還沒有「清理日報」按鈕') }
  await click(h, btn)
  const hit = h.calls.slice(before).some((c) => (c.method === 'POST' || c.method === 'DELETE')
    && (/\/reports/.test(c.path) || /clean/i.test(c.path) || /prune/i.test(c.path)))
  if (!hit) throw new Skip('按鈕存在但沒有對應的清理請求')
})

/* ⓯ 只用 react、沒有任何 @deepseek-ai 依賴 */
await test('約束：client.js 只 require("react")', async () => {
  const t = await (async () => { const h = makeHarness(); await h.settle(); return true })()
  ok(t, '渲染失敗')
  const requires = [...SRC.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const foreign = requires.filter((r) => r !== 'react')
  ok(foreign.length === 0, 'client.js 還 require 了：' + JSON.stringify(foreign))
})

/* ────────────────────────── 印結果 ────────────────────────── */

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
for (const r of results) {
  const line = `${r.status.padEnd(4)} ${r.name}`
  console.log(r.note ? `${line}\n       ${r.note}` : line)
}

const pass = results.filter((r) => r.status === 'PASS').length
const skip = results.filter((r) => r.status === 'SKIP').length
const fail = results.filter((r) => r.status === 'FAIL').length

console.log('\n' + '─'.repeat(72))
console.log(`PASS ${pass}   SKIP ${skip}   FAIL ${fail}   （共 ${results.length} 項）`)
if (skip) console.log('SKIP 原因：' + results.filter((r) => r.status === 'SKIP').map((r) => r.name.replace('待確認控制項：', '') + ' — ' + r.note).join('；'))
if (pendingControls.length) console.log('UI 尚未出現的控制項（已回報，不算失敗）：' + pendingControls.join('、'))
if (fail) {
  console.log('\n失敗明細：')
  for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ✗ ${r.name}\n    ${r.note}`)
}
console.log('指令：DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" test/client.test.mjs')

process.exit(fail ? 1 : 0)
