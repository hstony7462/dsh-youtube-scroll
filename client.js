/**
 * dsh-youtube-scroll —— 瀏覽器半端（設定頁：「設置 → YouTube 刷」）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注冊腳本（沿用 dsh-bili-scroll 已驗證的約定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-youtube-scroll',            // 必須等於 package.json 的 name
 *       factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *     })
 *
 *   只 require('react')；不引 @deepseek-ai/* 任何包。
 *
 * ⭐ 怎麼進「設置」：
 *
 *     const slots = ctx.get('slots') || ctx.slots
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'youtube-scroll', order: 36, label: 'YouTube 刷' },
 *       () => h(Panel),
 *     ))
 *
 *   別自己糊標題欄按鈕 + 全屏 overlay（第一版刷B站就是這麼幹的，一眼看出「跟別的插件不一樣」）。
 *
 * ⭐ 契約：DESIGN.md §3（HTTP）＋ §6（UI）
 *     GET  /api/yt-duty/status              → {ok, today, ranToday, pickedToday, perDay, windows:{noon,night}, peakValley, report, lastRun, lastError, config}
 *     GET  /api/yt-duty/config              → {ok, config}
 *     POST /api/yt-duty/config  {patch:{}}  → {ok, config}      ⚠️ body 外面要多包一層 patch
 *     POST /api/yt-duty/run                 → {ok, started, why, log}
 *     GET  /api/yt-duty/report?date=        → {ok, text, path}
 *     POST /api/yt-duty/open    {what:"out"}→ {ok}
 *     出錯一律 {ok:false, error:"..."}，HTTP 400/500。
 *
 * ⭐ 刷B站踩過的兩個坑，這版一開頭就避掉：
 *   1) 每 5 秒輪詢 /status ⇒ 輸入框若直接綁 config，伺服器那份會在打字打到一半時把它蓋掉。
 *      ⇒ 文字類（頻道 / 關鍵詞 / API key / 工作區 / 每天幾條）一律先放「本地草稿」，只初始化一次。
 *   2) 不看 res.ok ⇒ HTTP 500 的 {ok:false,error} 會被當成「已保存」，綠色提示把故障蓋掉。
 *      ⇒ asJson 一律檢查 res.ok。
 *
 * ⭐ 樣式：只用 --dsw-alias-* 主題 token 的 inline style（token 名都在本機 app.asar 裏核對過），
 *    不插 <style>、不改寫別人的 DOM、不引外部 CSS/JS；因此也不做 CSS 偽類的 hover，
 *    按鈕 hover 用 onMouseEnter/Leave 的局部 state 完成。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-youtube-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/yt-duty'

    /* ────────────── HTTP（一律檢查 res.ok） ────────────── */

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（沒權限）' : res.status === 403 ? '（被宿主欄了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const msgOf = (e) => String((e && e.message) || e || '未知錯誤')

    /* ────────────── 主題 token（名子取自本機 app.asar，fallback 保證不會空白） ────────────── */

    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #c9ccd1)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
      borderL1: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      bgOverlay: 'var(--dsw-alias-bg-overlay, rgba(128,128,128,.14))',
      brandPrimary: 'var(--dsw-alias-brand-primary, #3b82f6)',
      brandHover: 'var(--dsw-alias-button-primary-hover, #2563eb)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.24))',
      stateError: 'var(--dsw-alias-state-error-primary, #f87171)',
      stateWarn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      stateSuccess: 'var(--dsw-alias-state-success-primary, #4ade80)',
      switchThumb: 'var(--dsw-alias-switch-thumb, #fff)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 2px 8px', maxWidth: 640 },
      sec: { display: 'flex', flexDirection: 'column', gap: 8 },
      h: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.labelPrimary, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      grow: { flex: '1 1 auto', minWidth: 0 },
      label: { fontSize: 13, lineHeight: '18px', color: T.labelPrimary },
      hint: { fontSize: 12, lineHeight: '17px', color: T.labelTertiary },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
        fontSize: 12, lineHeight: '16px', fontFamily: 'inherit', color: 'inherit',
        border: '1px solid ' + T.borderL2, background: T.bgLayer1,
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
        fontSize: 12, lineHeight: '18px', fontFamily: 'inherit', color: 'inherit',
        border: '1px solid ' + T.borderL2, background: T.bgLayer1, resize: 'vertical',
      },
      num: { width: 88, textAlign: 'center' },
      btn: {
        padding: '7px 12px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
        cursor: 'pointer', border: '1px solid ' + T.borderL2, background: T.bgOverlay, color: 'inherit',
      },
      btnPrimary: {
        padding: '7px 12px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
        cursor: 'pointer', border: '1px solid ' + T.brandPrimary,
        background: T.brandPrimary, color: 'var(--dsw-alias-label-primary-inverted, #fff)',
      },
      badge: {
        fontSize: 12, lineHeight: '17px', padding: '2px 8px', borderRadius: 6,
        background: T.bgOverlay, color: T.labelSecondary, whiteSpace: 'nowrap',
      },
      kv: { fontSize: 12, lineHeight: '18px', color: T.labelSecondary, wordBreak: 'break-all' },
      msg: {
        fontSize: 12, lineHeight: '17px', padding: '7px 9px', borderRadius: 8,
        wordBreak: 'break-word', background: T.bgLayer1, color: T.labelSecondary,
      },
      pre: {
        margin: '6px 0 0', padding: '8px 9px', borderRadius: 8, maxHeight: 240, overflow: 'auto',
        fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        background: T.bgLayer1, border: '1px solid ' + T.borderL1, color: T.labelSecondary,
      },
      sub: {
        marginLeft: 14, paddingLeft: 12, borderLeft: '2px solid ' + T.borderL2,
        display: 'flex', flexDirection: 'column', gap: 10,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
    }

    // 與宿主 lib/state.mjs 的 WINDOWS 對齊（官方口徑：工作日 9–12、14–18 是高峰，其餘都是谷時）
    const FALLBACK_WINDOWS = {
      noon: { label: '中午谷時', start: '12:00', end: '14:00' },
      night: { label: '夜間谷時', start: '18:00', end: '09:00' },
    }

    /* ────────────── 小工具 ────────────── */

    const lines = (s) => String(s == null ? '' : s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)

    // config 裏該是陣列的欄位：容錯（萬一是字串或 undefined，別讓 .join 在渲染時炸掉整個設定頁）
    const listOf = (v) => (Array.isArray(v) ? v : (typeof v === 'string' ? lines(v) : []))

    const clampInt = (v, lo, hi, dft) => {
      const n = Number(v)
      if (!isFinite(n)) return dft
      return Math.max(lo, Math.min(hi, Math.round(n)))
    }

    const fmtTime = (v) => {
      if (!v) return '—'
      try {
        const d = new Date(v)
        if (isNaN(d.getTime())) return String(v)
        return d.toLocaleString('zh-TW', { hour12: false })
      } catch { return String(v) }
    }

    /* ────────────── 小組件 ────────────── */

    function Switch({ on, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label || undefined,
        disabled: Boolean(disabled),
        onClick: () => { if (!disabled) onChange(!on) },
        style: {
          flex: 'none', width: 38, height: 22, borderRadius: 11, border: 0, padding: 0,
          position: 'relative', background: on ? T.brandPrimary : T.bgOverlay,
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
          transition: 'background .15s',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 3, left: on ? 19 : 3, width: 16, height: 16,
          borderRadius: '50%', background: T.switchThumb, display: 'block',
          transition: 'left .15s',
        },
      }))
    }

    function ToggleRow({ label, hint, on, onChange, disabled }) {
      return h('div', { style: S.row },
        h('div', { style: S.grow },
          h('div', { style: S.label }, label),
          hint ? h('div', { style: S.hint }, hint) : null),
        h(Switch, { on: Boolean(on), onChange, disabled, label }))
    }

    function Btn({ children, onClick, primary, disabled, title }) {
      const [over, setOver] = React.useState(false)
      const base = primary ? S.btnPrimary : S.btn
      const hot = primary ? { background: T.brandHover } : { background: T.hover }
      return h('button', {
        type: 'button',
        title: title || undefined,
        disabled: Boolean(disabled),
        onClick: onClick || undefined,
        onMouseEnter: () => setOver(true),
        onMouseLeave: () => setOver(false),
        style: Object.assign({}, base,
          over && !disabled ? hot : null,
          disabled ? { opacity: 0.5, cursor: 'default' } : null),
      }, children)
    }

    function Field({ label, hint, children }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: S.label }, label),
        children,
        hint ? h('div', { style: S.hint }, hint) : null)
    }

    /* 每 5 秒輪詢一次 /status；失敗次數交給界面把話說清楚（別只顯示「讀取中…」） */
    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (!alive) return
            if (d && d.ok) { setSt(d); setFails(0) } else setFails((n) => n + 1)
          } catch { if (alive) setFails((n) => n + 1) }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt, fails]
    }

    /* ────────────── 設定頁正文 ────────────── */

    function Panel() {
      const [st, setSt, fails] = useStatus(5000)
      const [busy, setBusy] = React.useState('')     // '' | 'save' | 'run' | 'report' | 'open'
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')     // '' | 'good' | 'warn' | 'err'
      const [report, setReport] = React.useState(null)   // 非 null = 報告已展開

      /* ⚠️ 草稿：頁面每 5 秒輪詢，config 會一直回來；直接綁它 = 打字被打斷。
         null 代表「還沒初始化」，只初始化一次（之後伺服器再怎麼回都不覆蓋）。 */
      const [perDay, setPerDay] = React.useState(null)
      const [channelsText, setChannelsText] = React.useState(null)
      const [keywordsText, setKeywordsText] = React.useState(null)
      const [apiKey, setApiKey] = React.useState(null)
      const [workspace, setWorkspace] = React.useState(null)
      const [transcribe, setTranscribe] = React.useState(null)
      const [framesOn, setFramesOn] = React.useState(null)
      const [asrModel, setAsrModel] = React.useState(null)
      const [asrInfo, setAsrInfo] = React.useState(null)
      const [asrBusy, setAsrBusy] = React.useState(false)
      const [singleUrl, setSingleUrl] = React.useState('')
      const [singleMsg, setSingleMsg] = React.useState('')
      const [keyMsg, setKeyMsg] = React.useState('')
      const [notesList, setNotesList] = React.useState([])

      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const cfg = (st && st.config) || null

      React.useEffect(() => {
        if (!cfg) return
        setPerDay((v) => (v === null ? String(cfg.perDay == null ? 5 : cfg.perDay) : v))
        setChannelsText((v) => (v === null ? listOf(cfg.channels).join('\n') : v))
        setKeywordsText((v) => (v === null ? listOf(cfg.keywords).join('\n') : v))
        setApiKey((v) => (v === null ? String(cfg.apiKey || '') : v))
        setWorkspace((v) => (v === null ? String(cfg.workspace || '') : v))
        setTranscribe((v) => (v === null ? !!cfg.transcribe : v))
        setFramesOn((v) => (v === null ? !!cfg.frames : v))
        setAsrModel((v) => (v === null ? String(cfg.asrModel || 'base') : v))
      }, [cfg])

      const say = (text, t) => { setMsg(text || ''); setTone(t || '') }

      const patch = async (p, what, key) => {
        setBusy(key || 'patch')
        try {
          // ⚠️ 契約：body 是 {patch:{...}}，不是直接的鍵值
          const r = await jpost('/config', { patch: p })
          if (r && r.config && alive.current) setSt((old) => (old ? Object.assign({}, old, { config: r.config }) : old))
          if (r && r.ok === false) say((what ? what + '：' : '') + (r.error || '沒保存上'), 'err')
          else say(what ? what + '：已保存' : '已保存', 'good')
        } catch (e) {
          say((what ? what + '：' : '') + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      /* 文字類一次存：頻道 / 關鍵詞 / API key / 工作區（+ 每天幾條，數字留在草稿裏） */
      const onSave = async () => {
        const patchObj = {
          perDay: clampInt(perDay, 0, 50, 5),
          channels: lines(channelsText),
          keywords: lines(keywordsText),
          apiKey: String(apiKey || '').trim(),
          workspace: String(workspace || '').trim(),
        }
        setPerDay(String(patchObj.perDay))
        await patch(patchObj, '設定', 'save')
      }

      const loadAsr = async () => {
        try {
          const r = await jget('/asr-status')
          if (alive.current && r) setAsrInfo(r)
        } catch (e) { /* 舊版沒有這個接口時安靜跳過 */ }
      }

      const loadReports = async () => {
        try {
          const r = await jget('/reports')
          if (alive.current && r) setNotesList(Array.isArray(r.notes) ? r.notes : [])
        } catch (e) { /* 舊版沒有這個接口時安靜跳過 */ }
      }
      React.useEffect(() => { loadAsr(); loadReports() }, [])
      React.useEffect(() => {
        if (!asrInfo || !asrInfo.installing) return undefined
        const t = setInterval(loadAsr, 3000)
        return () => clearInterval(t)
      }, [asrInfo && asrInfo.installing])

      const onInstallAsr = async () => {
        setAsrBusy(true)
        try {
          const r = await jpost('/asr-install', {})
          if (r && r.ok === false) say('安裝沒起來：' + (r.error || '未知原因'), 'err')
          else say('已開始安裝轉寫依賴（幾分鐘；進度會顯示在下面）', 'good')
          await loadAsr()
        } catch (e) {
          say('安裝沒起來：' + msgOf(e), 'err')
        } finally {
          setAsrBusy(false)
        }
      }

      const onCheckKey = async () => {
        setBusy('key')
        try {
          const r = await jget('/check-key')
          if (r && r.ok) setKeyMsg('API key 正常 ✓' + (r.note ? '（' + r.note + '）' : ''))
          else setKeyMsg('API key 有問題：' + ((r && r.error) || '未知原因'))
        } catch (e) {
          setKeyMsg('測試失敗：' + msgOf(e))
        } finally {
          setBusy('')
        }
      }

      const onSingle = async () => {
        if (!String(singleUrl || '').trim()) { setSingleMsg('先貼一條 YouTube 連結'); return }
        setBusy('single')
        setSingleMsg('')
        try {
          const r = await jpost('/single', { url: String(singleUrl).trim() })
          if (r && r.started) setSingleMsg('已開始解讀 —— 幾分鐘後筆記會出現在 notes/，狀態每 5 秒更新。')
          else setSingleMsg('沒起來：' + ((r && (r.error || r.why)) || '未知原因'))
        } catch (e) {
          setSingleMsg('沒起來：' + msgOf(e))
        } finally {
          setBusy('')
          loadReports()
        }
      }

      const onStop = async () => {
        setBusy('stop')
        try {
          const r = await jpost('/stop', {})
          if (r && r.ok) say('已送出停止請求（幾秒內結束）', 'good')
          else say('停止失敗：' + ((r && r.error) || '未知原因'), 'err')
        } catch (e) {
          say('停止失敗：' + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      const onPrune = async () => {
        setBusy('prune')
        try {
          const r = await jpost('/prune', { keepDays: 90 })
          if (r && r.ok) say('已清理 ' + (r.removed || 0) + ' 份 90 天前的日報', 'good')
          else say('清理失敗：' + ((r && r.error) || '未知原因'), 'err')
          await loadReports()
        } catch (e) {
          say('清理失敗：' + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      const onSrt = async () => {
        try {
          const m = String(singleUrl || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)?([A-Za-z0-9_-]{11})/)
          if (!m) { setSingleMsg('先在上面貼一條連結（或 11 位 videoId）'); return }
          const id = m[1]
          const r = await jget('/srt?videoId=' + encodeURIComponent(id))
          if (!r || !r.ok) { setSingleMsg('SRT 失敗：' + ((r && r.error) || '未知原因')); return }
          const blob = new Blob([String(r.text || '')], { type: 'text/plain;charset=utf-8' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = id + '.srt'
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 2000)
          setSingleMsg('已下載 SRT（' + id + '.srt）')
        } catch (e) {
          setSingleMsg('SRT 失敗：' + msgOf(e))
        }
      }

      const onRun = async () => {
        setBusy('run')
        say('')
        try {
          const r = await jpost('/run', {})
          if (r && r.started) say('已經在後台跑一輪了 —— 跑完報告會寫進 out/；上面這行狀態每 5 秒自己更新。', 'good')
          else say('沒起來：' + ((r && (r.why || r.log || r.error)) || '未知原因（看 duty.log）'), 'warn')
        } catch (e) {
          say('跑不起來：' + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      const onShowReport = async () => {
        if (report !== null) { setReport(null); return }   // 再點一次收起
        setBusy('report')
        try {
          const r = await jget('/report')
          if (!r || r.ok === false) { say('讀不到報告：' + ((r && r.error) || '未知原因'), 'err'); return }
          const text = typeof r.text === 'string' ? r.text : ''
          setReport(text || '今天還沒有報告 —— 先按「現在跑一輪」。')
        } catch (e) {
          say('讀不到報告：' + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      const onOpenOut = async () => {
        setBusy('open')
        try {
          const r = await jpost('/open', { what: 'out' })
          if (r && r.ok) say('已請系統打開報告資料夾。', 'good')
          else say('打不開（' + ((r && r.error) || '未知原因') + '）—— 報告路徑是：' + ((st && st.report) || '（還沒生成）'), 'warn')
        } catch (e) {
          say('打不開：' + msgOf(e), 'err')
        } finally {
          setBusy('')
        }
      }

      /* 還沒拿到 config：把原因說清楚，別讓使用者以為開關壞了 */
      if (!cfg) {
        return h('div', { style: S.page },
          h('div', { style: S.hint }, fails >= 3
            ? '讀不到插件設定（已經試了 ' + fails + ' 次）。常見原因：插件剛裝完還沒重啟 dsh；profile 沒有 reload；或者宿主半端（index.js）加載失敗。'
            : '讀取設定中…'))
      }

      const win = {
        noon: Object.assign({}, FALLBACK_WINDOWS.noon, (st && st.windows && st.windows.noon) || {}),
        night: Object.assign({}, FALLBACK_WINDOWS.night, (st && st.windows && st.windows.night) || {}),
      }
      // 子開關狀態：以 config 為準（那是我們要改的那份），沒有才退回 status 的 switchOn
      const noonOn = cfg.noon == null ? Boolean(win.noon.switchOn) : Boolean(cfg.noon)
      const nightOn = cfg.night == null ? Boolean(win.night.switchOn) : Boolean(cfg.night)
      const peakOn = Boolean(cfg.peakValley)
      const level = cfg.reportLevel || 'full'

      const winHint = (k) => {
        const w = win[k]
        const span = String(w.start || '') + ' – ' + String(w.end || '')
        return w.opening ? span + '（此刻是谷時）' : span
      }

      const picked = Number((st && st.pickedToday) || 0)
      const cap = cfg.perDay == null ? Number((st && st.perDay) || 0) : Number(cfg.perDay)
      const ranLabel = typeof (st && st.ranToday) === 'number'
        ? (st.ranToday > 0 ? '今天已跑 ' + st.ranToday + ' 輪' : '今天還沒跑')
        : ((st && st.ranToday) ? '今天已跑' : '今天還沒跑')

      // 有沒有還沒存的文字草稿（純推導，不用額外 state）
      const draftDirty = Boolean(
        lines(channelsText).join('\n') !== listOf(cfg.channels).join('\n') ||
        lines(keywordsText).join('\n') !== listOf(cfg.keywords).join('\n') ||
        String(apiKey || '').trim() !== String(cfg.apiKey || '') ||
        String(workspace || '').trim() !== String(cfg.workspace || '') ||
        clampInt(perDay, 0, 50, 5) !== clampInt(cfg.perDay, 0, 50, 5),
      )

      const toneStyle = tone === 'err' ? { color: T.stateError }
        : tone === 'warn' ? { color: T.stateWarn }
          : tone === 'good' ? { color: T.stateSuccess }
            : null

      return h('div', { style: S.page },

        /* ── 什麼時候自己跑 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '什麼時候自己跑'),
          h(ToggleRow, {
            label: '峰谷時段自動刷',
            hint: '只在谷時跑（工作日 12:00–14:00 與 18:00 之後；週末也算谷時）。關了就只能手動按「現在跑一輪」。',
            on: peakOn,
            onChange: (v) => patch({ peakValley: v }, '峰谷時段自動刷'),
          }),
          peakOn ? h('div', { style: S.sub },
            h(ToggleRow, {
              label: win.noon.label,
              hint: winHint('noon'),
              on: noonOn,
              onChange: (v) => patch({ noon: v }, win.noon.label),
            }),
            h(ToggleRow, {
              label: win.night.label,
              hint: winHint('night'),
              on: nightOn,
              onChange: (v) => patch({ night: v }, win.night.label),
            })) : null),

        /* ── 一天挑幾條 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '一天挑幾條'),
          h('div', { style: S.row },
            h('div', { style: S.grow },
              h('div', { style: S.label }, '每天最多挑幾條'),
              h('div', { style: S.hint }, '填 0 = 不自動跑（還是能手動跑）；最多 50')),
            h('input', {
              type: 'number', min: 0, max: 50, step: 1, inputMode: 'numeric',
              'aria-label': '每天最多挑幾條',
              value: perDay == null ? '' : perDay,
              onChange: (e) => setPerDay(e.target.value),
              onBlur: () => {
                const n = clampInt(perDay, 0, 50, 5)
                setPerDay(String(n))
                if (n !== clampInt(cfg.perDay, 0, 50, 5)) patch({ perDay: n }, '每天挑幾條')
              },
              style: Object.assign({}, S.input, S.num),
            }))),

        /* ── 關注什麼 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '關注什麼'),
          h(Field, {
            label: '關注頻道（一行一個）',
            hint: '填 @handle、UC 開頭的頻道 id、或整個頻道網址都行；走 RSS，不需要 API key。',
          }, h('textarea', {
            rows: 4,
            'aria-label': '關注頻道',
            placeholder: '@handle\nUCxxxxxxxxxxxxxxxxxxxxxx\nhttps://www.youtube.com/@handle',
            value: channelsText == null ? '' : channelsText,
            onChange: (e) => setChannelsText(e.target.value),
            style: S.textarea,
          })),
          h(Field, {
            label: '搜索關鍵詞（一行一個）',
            hint: '留空 = 只看上面那些頻道（不搜索）。',
          }, h('textarea', {
            rows: 3,
            'aria-label': '搜索關鍵詞',
            placeholder: '一行一個關鍵詞',
            value: keywordsText == null ? '' : keywordsText,
            onChange: (e) => setKeywordsText(e.target.value),
            style: S.textarea,
          })),
          h(Field, {
            label: 'YouTube API key（可選）',
            hint: '留空則用免 key 的搜索頁 —— 能跑，但比較慢、也可能被限流；填了就走官方 Data API（配在 config 的 apiKey，只留在本機）。',
          }, h('div', { style: S.row },
            h('div', { style: S.grow }, h('input', {
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              'aria-label': 'YouTube API key',
              placeholder: '留空 = 免 key 搜索',
              value: apiKey == null ? '' : apiKey,
              onChange: (e) => setApiKey(e.target.value),
              style: S.input,
            })),
            h(Btn, { disabled: Boolean(busy), onClick: onCheckKey }, busy === 'key' ? '測試中…' : '測試 API key'),
            keyMsg ? h('span', { style: { fontSize: 12, color: keyMsg.indexOf('正常') >= 0 ? T.stateSuccess : T.stateError } }, keyMsg) : null))),

        /* ── 看畫面 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '看畫面（縮圖）'),
          h(ToggleRow, {
            label: '讓它看影片縮圖',
            hint: '開著時，模型可以取封面 + 25/50/75% 的縮圖輔助判斷（每條最多 1–2 張）。字幕仍是主要依據；縮圖細字／代碼看不清，而且很燒 token。',
            on: !!framesOn,
            onChange: (v) => { setFramesOn(v); patch({ frames: !!v }, '看畫面') },
          })),

        /* ── 沒字幕的影片 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '沒字幕的影片'),
          h(ToggleRow, {
            label: '用本機 Whisper 轉寫',
            hint: 'YouTube 沒字幕時，下載音訊用本機 Whisper 轉成文字再判斷（不用 API key；第一次要裝依賴、下模型）。關著 = 沒字幕就跳過。',
            on: !!transcribe,
            onChange: (v) => { setTranscribe(v); patch({ transcribe: !!v }, '本機轉寫') },
          }),
          transcribe ? h('div', { style: S.sub },
            h('div', { style: S.row },
              h('div', { style: S.grow },
                h('div', { style: S.label }, 'Whisper 模型'),
                h('div', { style: S.hint }, 'base 最快（約 145MB）；small 更準但慢一倍（約 460MB）')),
              h('select', {
                value: asrModel || 'base',
                'aria-label': 'Whisper 模型',
                onChange: (e) => { setAsrModel(e.target.value); patch({ asrModel: e.target.value }, 'Whisper 模型') },
                style: S.input,
              },
                h('option', { value: 'tiny' }, 'tiny（最快）'),
                h('option', { value: 'base' }, 'base（推薦）'),
                h('option', { value: 'small' }, 'small（更準）'),
                h('option', { value: 'medium' }, 'medium（最準、很慢）'))),
            h('div', { style: S.row },
              h('button', {
                type: 'button',
                onClick: onInstallAsr,
                disabled: asrBusy || !!(asrInfo && asrInfo.installing),
                style: asrBusy || (asrInfo && asrInfo.installing) ? Object.assign({}, S.btn, { opacity: 0.6 }) : S.btnPrimary,
              }, (asrInfo && asrInfo.ready) ? '重裝轉寫依賴' : '安裝轉寫依賴'),
              h('span', { style: S.hint },
                !asrInfo ? '檢查中…'
                  : asrInfo.ready ? '已就緒 ✓'
                    : (asrInfo.installing ? '安裝中…（可關掉這頁，裝完再回來看）' : '尚未安裝'))),
            (asrInfo && asrInfo.installing && asrInfo.tail) ? h('pre', { style: S.pre }, asrInfo.tail) : null,
          ) : null),

        /* ── 單條連結深入分析 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '單條連結深入分析'),
          h('div', { style: S.hint }, '貼一條 YouTube 連結 → 抓字幕（沒有就本機轉寫）→ 寫一份完整解讀到 notes/<videoId>.md：時間軸、核心概念、關鍵數字、實務意涵、局限。'),
          h('div', { style: S.row },
            h('div', { style: S.grow }, h('input', {
              type: 'text',
              spellCheck: false,
              'aria-label': '單條影片連結',
              placeholder: 'https://www.youtube.com/watch?v=… 或 11 位 videoId',
              value: singleUrl || '',
              onChange: (e) => setSingleUrl(e.target.value),
              style: Object.assign({}, S.input, { fontFamily: S.mono.fontFamily }),
            })),
            h(Btn, { primary: true, disabled: Boolean(busy) || Boolean(st && st.running), onClick: onSingle },
              busy === 'single' ? '送出中…' : '單條解讀')),
          h('div', { style: S.row },
            h(Btn, { disabled: Boolean(busy), onClick: onSrt }, '下載 SRT'),
            h('span', { style: S.hint },
              notesList.length ? ('最近筆記：' + notesList.slice(0, 3).map((n) => n.videoId).join('、')) : '還沒有筆記')),
          singleMsg ? h('div', { style: S.msg }, singleMsg) : null),

        /* ── 報告與工作區 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '報告與工作區'),
          h(Field, {
            label: '日報詳細度',
            hint: level === 'off' ? '選「不寫」= 只挑片、不生成日報檔案。' : '日報一律寫繁體中文，標題行是 videoId。',
          }, h('select', {
            'aria-label': '日報詳細度',
            value: level,
            onChange: (e) => patch({ reportLevel: e.target.value }, '日報詳細度'),
            style: S.input,
          },
            h('option', { value: 'full' }, '完整 —— 每條：標題 / 頻道 / 為什麼值得 / 一句話'),
            h('option', { value: 'brief' }, '薄版 —— 每條一兩行，只留值不值得 + 連結'),
            h('option', { value: 'off' }, '不寫 —— 只挑片，不產生檔案'))),
          h(Field, {
            label: '工作區路徑',
            hint: '它會讀這個目錄下的 AGENTS.md 當人設；留空 = 不讀人設、按中性說話。',
          }, h('input', {
            type: 'text',
            spellCheck: false,
            'aria-label': '工作區路徑',
            placeholder: '/Users/you/work （留空 = 中性）',
            value: workspace == null ? '' : workspace,
            onChange: (e) => setWorkspace(e.target.value),
            style: Object.assign({}, S.input, { fontFamily: S.mono.fontFamily }),
          }))),

        /* ── 狀態 ── */
        h('div', { style: S.sec },
          h('div', { style: S.h }, '現在什麼情況'),
          h('div', { style: S.row },
            h('span', { style: S.badge }, '今天 ' + ((st && st.today) || '—')),
            h('span', { style: S.badge }, ranLabel),
            h('span', { style: S.badge }, '已挑 ' + picked + ' / ' + cap + ' 條'),
            h('span', { style: S.badge }, peakOn ? '峰谷自動刷：開' : '峰谷自動刷：關'),
            h('span', { style: S.badge }, '去重名單 ' + ((st && st.seenCount) || 0) + ' 條'),
            h('span', { style: S.badge }, 'API 搜索 ' + ((st && st.apiSearchesToday) || 0) + ' / ' + ((st && st.apiSearchesLimit) || 0)),
            (st && st.running)
              ? h('span', { style: Object.assign({}, S.badge, { color: T.stateWarn }) },
                  '正在跑：' + (st.runningMode === 'single' ? '單條解讀' : (st.runningMode || '一輪')))
              : null),
          h('div', { style: S.kv }, '上次跑：' + fmtTime(st && st.lastRun)),
          (st && st.lastError)
            ? h('div', { style: { fontSize: 12, lineHeight: '18px', wordBreak: 'break-word', color: T.stateError } },
                '上次錯誤：' + String(st.lastError))
            : null,
          h('div', { style: S.kv },
            '報告路徑：',
            h('span', { style: S.mono }, (st && st.report) || '（今天還沒生成）'))),

        /* ── 動作 ── */
        h('div', { style: S.sec },
          h('div', { style: S.row },
            h(Btn, { primary: true, disabled: Boolean(busy), onClick: onRun }, busy === 'run' ? '起跑中…' : '現在跑一輪'),
            h(Btn, { disabled: Boolean(busy), onClick: onShowReport }, report !== null ? '收起報告' : '看今天的報告'),
            h(Btn, { disabled: Boolean(busy), onClick: onOpenOut }, '打開報告資料夾'),
            h(Btn, { disabled: Boolean(busy) || !(st && st.running), onClick: onStop }, '停止這一輪'),
            h(Btn, { disabled: Boolean(busy), onClick: onPrune }, '清理 90 天前日報'),
            h('span', { style: S.hint }, '日報 ' + ((st && st.reports) || 0) + ' 份 · 筆記 ' + notesList.length + ' 份')),
          msg ? h('div', { style: Object.assign({}, S.msg, toneStyle) }, msg) : null,
          report !== null ? h('pre', { style: S.pre }, report) : null),

        /* ── 存檔 ── */
        h('div', { style: S.sec },
          h('div', { style: S.row },
            h(Btn, { primary: true, disabled: Boolean(busy), onClick: onSave }, busy === 'save' ? '保存中…' : '保存'),
            h('span', { style: S.hint }, draftDirty ? '有還沒保存的修改（在上面）' : '上面的文字設定都跟已保存的一致')),
          h('div', { style: S.hint },
            '保存會一次寫入：頻道 / 關鍵詞 / API key / 工作區 / 每天幾條。開關和下拉選單是改了立刻存。')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // ⭐ 進「設置」：label 就是左側導航那一項（抄 dsh-bili-scroll / dsh-meme 的寫法）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'youtube-scroll', order: 36, label: 'YouTube 刷' },
          () => h(Panel),
        ))
      },
    }
  },
})
