# dsh-youtube-scroll — 設計與接口契約（實作前先讀）

> Adapted from the architecture of [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT, c1overzz); see [NOTICE.md](../NOTICE.md).


「刷 YouTube」版刷B站：**訂閱頻道 RSS +（可選）關鍵詞搜索 → 定時／手動跑一輪 → 讀字幕篩選 → 寫繁體日報**。
MVP 不做自動評論（YouTube 評論要 OAuth），工具全部只讀。

## 1. 套件

```
yt-scroll/
  package.json            # name: dsh-youtube-scroll, dsh.bundle.patch, dsh.client
  cordis.patch.yml        # insert 一行 id: youtube-scroll, name: dsh-youtube-scroll
  index.js                # 宿主半端：設定、HTTP 接口、定時器、起一輪（spawn headless）
  client.js               # 瀏覽器半端：設定頁（設置 → YouTube 刷）
  mcp/server.mjs          # stdio MCP server：YouTube 資料層（純 Node，零 npm 依賴）
  prompts/duty.md         # 一輪要做的事（值班章程）
  locale/zh.json, en.json # meta.title / meta.description
  icon.svg
  test/mcp.test.mjs       # 離線＋線上工具測試
  README.md
```

狀態目錄：`$DSH_HOME/yt-duty/`（未設 `DSH_HOME` 時 `~/.dsh/yt-duty/`）
- `config.json`、`duty.log`、`headless-overlay.yml`、`out/<YYYY-MM-DD>.md`、`seen.json`（已看過的 videoId）

## 2. 設定（config.json）

```jsonc
{
  "perDay": 5,              // 每天最多挑幾條（0 = 不自動跑，仍可手動）
  "peakValley": false,      // 峰谷時段自動刷總開關
  "noon": true,             // 中午谷時 12:00–14:00
  "night": true,            // 夜間谷時 18:00–09:00
  "keywords": [],           // 搜索關鍵詞（留空 = 只用頻道）
  "channels": [],           // 頻道：@handle / UCxxxxxxxx / 頻道 URL 皆可
  "apiKey": "",             // YouTube Data API key（可選；留空走免 key 搜索頁）
  "reportLevel": "full",    // full | brief | off
  "workspace": "",          // 你平時的工作區（讀 AGENTS.md 當人設；留空 = 中性）
  "headlessProfile": "headless",
  "overlayMcp": true,
  "lastRun": null,          // ISO 時間
  "lastError": "",
  "_set": []
}
```

## 3. HTTP 接口（宿主註冊在 `/api/yt-duty`）

| 方法 | 路徑 | 說明 | 回應 |
|---|---|---|---|
| GET | `/api/yt-duty/status` | 今天狀態＋窗口＋設定摘要 | `{ok, today, ranToday, pickedToday, perDay, windows:{noon:{label,start,end,switchOn,opening}, night:{...}}, peakValley, report, lastRun, lastError, config}` |
| GET | `/api/yt-duty/config` | 完整設定 | `{ok, config}` |
| POST | `/api/yt-duty/config` | body `{patch:{...}}`，只認白名單欄位 | `{ok, config}` |
| POST | `/api/yt-duty/run` | 手動跑一輪（body 可空） | `{ok, started, why, log}` |
| GET | `/api/yt-duty/report?date=YYYY-MM-DD` | 日報原文（默認今天） | `{ok, text, path}` |
| POST | `/api/yt-duty/open` | body `{what:"out"\|"home"}`，用系統檔案總管打開 | `{ok}` |

錯誤一律 `{ok:false, error:"..."}`，HTTP 狀態碼 400/500。

## 4. MCP 工具（serverName `yt-duty`，stdio，`mcp/server.mjs`）

全部回傳 **JSON 字串**（MCP `content: [{type:"text", text}]`），失敗回 `{"error":"..."}`。
環境變數：`YT_API_KEY`（可空）、`YT_DUTY_HOME`（狀態目錄，供 seen/快取）。

| 工具 | 參數 | 回傳 |
|---|---|---|
| `yt_search` | `{query: string, days?: number = 7, limit?: number = 15}` | `{source:"api"\|"scrape", items:[{videoId,title,channel,channelId?,published,views?,durationText?}], relaxed?, note?}` |
| `yt_channel` | `{channel: string, days?: number = 7, limit?: number = 15}` | 同上，另帶 `via:"rss"`（channel 接受 @handle / UC id / URL；RSS 免 key） |
| `yt_video` | `{videoId: string}` | `{videoId,title,channel,channelId,description,views,durationSeconds,published,hasCaptions,langs:[],isLive}` |
| `yt_transcript` | `{videoId: string, lang?: string}` | `{videoId,lang,isAuto,segments:[{start,dur,text}],text}`（語言優先序：指定 → zh-Hant → zh-Hans → zh → en；無字幕回 `{error:"no_captions"}`） |
| `yt_asr` | `{videoId: string, model?: string}` | 本機 Whisper 轉寫（給沒字幕的影片）：`{videoId,model,lang,source:"whisper",seconds,text}`；環境未裝回 `asr_not_installed` |
| `yt_frames` | `{videoId: string, count?: number}` | MCP **image content**（封面＋25/50/75% 縮圖，1–4 張，預設 2）＋一份 JSON meta；**已實測 headless 那一輪模型看得到圖** |

> 補充：`relaxed:true` 表示「窗口內無結果、回的是更舊的」；`yt_channel` 走 RSS 時 `source:"scrape"` + `via:"rss"`。

實作要點（已實測可行）：
- 字幕：GET watch 頁 → 抽 `INNERTUBE_API_KEY` → POST `youtubei/v1/player?key=` body `{context:{client:{clientName:"ANDROID",clientVersion:"20.10.38"}},videoId}` → `captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`（去掉 `&fmt=srv3`）→ GET XML → `<text start dur>` 解析（要 **un-escape 兩次**，回應裡是 `&amp;#39;`）。
- 搜索（免 key）：`https://www.youtube.com/results?search_query=…` + UA，抽 `ytInitialData`（**平衡括號截取**）→ `videoRenderer`；`publishedTimeText.simpleText`（"3 days ago"）過濾 `days`。
- 頻道 RSS：`https://www.youtube.com/feeds/videos.xml?channel_id=UC…`（先解析 handle：GET `https://www.youtube.com/@handle` 抽 `channelId`）。
- 詳情：watch 頁 `ytInitialPlayerResponse.videoDetails`（title/views/lengthSeconds/isLive）+ `ytInitialData` 取描述/發佈時間。

## 5. 「一輪」怎麼跑（沿用刷B站已驗證的模式）

1. 寫 `headless-overlay.yml`：
   - 三條 `- id: credentials|authorization|deepseek-account` + `disabled: false`
   - `- id: agent-default-model`：鏡像當前選中模型（`ctx.get('agentDefaultModel')?.currentSelection?.()`；拿不到就不寫）
   - `- insert: - id: mcp-yt-duty, name: '@deepseek-ai/dsh-mcp-client'`，config：
     `serverName: yt-duty, transport: stdio, command: <process.execPath>, args: [<mcp/server.mjs>], env: {ELECTRON_RUN_AS_NODE: '1', YT_API_KEY, YT_DUTY_HOME}`
2. `spawn(dsh.command, [...dsh.args, '--profile', 'headless', '--patch', overlay, prompt], { cwd: stateDir, env: {ELECTRON_RUN_AS_NODE:'1', ...} })`
   - dsh 定位：優先用 `process.execPath`（Electron）+ 應用內 `runtime/cli/bin/dsh`；找不到就寫日誌並失敗。
3. 值班章程（prompts/duty.md）要它：先用 `yt_channel`（設定裡的頻道）/`yt_search`（關鍵詞）取近 N 天候選 → 逐條 `yt_transcript` 讀原文再判斷 → 最多挑 `perDay` 條 → 寫 `out/<日期>.md`（**繁體中文**，標題行 `### <videoId>`，每條含「為什麼值得」「一句話」）→ 最後一行寫「因無字幕跳過 N 條」。
4. 宿主記錄 `lastRun`；`pickedToday` = 今天日報裡 `^### [A-Za-z0-9_-]{11}$` 的行數。

## 6. 瀏覽器半端（client.js）

- 註冊 `settings.section`：`{id:'youtube-scroll', order: 36, label: 'YouTube 刷'}`
- 面板（繁體中文，沿用刷B站設定頁的排版口徑）：
  - 總開關（峰谷自動刷）→ 展開中午／夜間子開關
  - 每天最多挑幾條（數字）
  - 關注頻道（多行 textarea，一行一個 @handle / UC… / URL）
  - 搜索關鍵詞（多行）
  - YouTube API key（可選，password 型 input，留空 = 免 key 搜索）
  - 日報詳細度（完整／薄版／不寫）
  - 工作區路徑（文字輸入）
  - 狀態行：今天跑了沒有、挑了幾個、上次錯誤、報告路徑
  - 按鈕：現在跑一輪 / 看今天的報告 / 打開報告資料夾
- 全部經 `/api/yt-duty`；保存即 POST config；掛載時 GET status。
- 樣式：主題 token `--dsw-alias-*`，不要引入外部套件；不要改寫其他插件 DOM。

## 7. 驗收

- `node --check` 全部檔案；`test/mcp.test.mjs` 離線（fixture）＋線上（真搜 3 條、真取 1 條字幕）全過。
- 安裝後：`include:youtube-scroll` active；client `settings.section` 出現 `youtube-scroll`。
- 手動跑一輪：`duty.log` 有正常輸出、`out/<今天>.md` 生成、標題行數與 pickedToday 對得上。
