# dsh-youtube-scroll

A DSH (DeepSeek Harness) plugin that **scrolls YouTube for you once a day**: it collects recent videos from the channels and keywords you follow, *reads each transcript before judging*, and writes a Traditional Chinese daily report of what is actually worth watching.

Chinese documentation: [README.md](README.md). Design notes: [DESIGN.md](DESIGN.md).

> Status: v1.0.0. Read-only by design — the plugin registers **no** tools for commenting, uploading, liking, subscribing, or OAuth.

## What it does

- **Daily round.** On demand, or automatically inside two optional off-peak windows, the host spawns one headless DSH round. The round collects candidates from your channels (YouTube RSS, no API key needed) and your keywords (YouTube Data API when a key is configured, otherwise keyless search-page scraping).
- **Transcript first.** The agent reads `yt_transcript` for each remaining candidate and judges the actual content, not the title. Captionless videos are either skipped (and counted at the end of the report) or transcribed locally with Whisper. Optionally it may look at 1–2 thumbnails per video to judge the visual side.
- **Traditional Chinese report.** Written to `$DSH_HOME/yt-duty/out/<YYYY-MM-DD>.md`. Every pick starts with a `### <11-char videoId>` heading — that line is how the host counts "picked today".
- **Off-peak scheduling.** Two windows, each firing at most once per day: noon `12:00–14:00` and night `18:00–09:00` (local time). Both are gated by the master switch, the daily pick quota, and a "not already running" check.
- **v1.0 extras.** Single-link deep analysis (`notes/<videoId>.md`), SRT export, cross-day dedupe, daily Data-API search-quota guard, manual stop + per-round timeout, macOS completion notifications, report index/prune, and an API-key test button.

## Features

| Feature | Notes |
|---|---|
| Daily / manual rounds | Spawns one headless DSH round with a one-shot MCP overlay; the round runs in the plugin home directory (sandboxed). |
| Six read-only MCP tools | `yt_search`, `yt_channel`, `yt_video`, `yt_transcript`, `yt_asr`, `yt_frames` — see [MCP tools](#mcp-tools). |
| Transcript-first selection | Report picks must be based on transcript text; the charter requires reading before judging. |
| Local Whisper fallback | Captionless videos can be transcribed on-device with faster-whisper (`mcp/asr.py`), no cloud ASR. |
| Thumbnail vision (optional) | `yt_frames` returns real MCP image content (cover + 25/50/75% thumbnails) so the model can *see* the video's visuals. |
| Off-peak auto-run | Noon `12:00–14:00` / night `18:00–09:00` local time, once per window per day. |
| Cross-day dedupe | Picks are recorded in `seen.json`; the next round's prompt lists ids picked in the last `dedupeDays` days (default 30) and says not to repeat them. |
| Single-link deep note | Paste a link in the settings page → a round runs `prompts/single.md` and writes a full note (timeline, key ideas, numbers, glossary, implications, limits) to `notes/<videoId>.md`. |
| SRT export | `GET /api/yt-duty/srt?videoId=…` calls `yt_transcript` and converts its segments to SRT. |
| Stop + timeout | Stop button (SIGTERM, then SIGKILL after 3 s); a watchdog kills a round after `roundTimeoutSec` (default 900 s). |
| API-search quota guard | Keyword searches are budgeted at ~100 Data-API units each against `maxSearchesPerDay` (default 80); surplus keywords are trimmed from the round and the prompt says so. |
| Completion notifications | macOS notification on round completion/failure (`notify`, default on). |
| Reports index + prune | Lists daily reports and notes; one click deletes reports older than 90 days (and prunes `seen.json`). |
| API-key test | One `videos.list` call (~1 unit) validates the configured key. |

## How a round works

1. The host timer (or the **Run now** button) writes a one-shot overlay file, `headless-overlay.yml`.
2. The overlay mounts `mcp/server.mjs` (a pure-Node stdio MCP server, **zero npm dependencies**) into that round with the six read-only tools.
3. The host spawns `dsh --profile headless --patch <overlay> <prompt>`. The prompt is built from: today's settings (pick quota left, channels, keywords, report level, frames/Whisper toggles, ids to dedupe) + the duty charter (`prompts/duty.md`, or your edited copy at `$DSH_HOME/yt-duty/duty.md`) + optionally the workspace `AGENTS.md` persona.
4. The round's working directory is the plugin home (`$DSH_HOME/yt-duty/`, sandboxed) — it can only write there. It writes the daily report.
5. The host counts `### <videoId>` headings in the report to know how many were picked today, records them in `seen.json`, and updates `state.json` / `config.json`.

```
┌──────────────────────────────────┐                ┌───────────────────────────────┐
│ DSH host                         │   HTTP         │ Browser half (client.js)      │
│  index.js                        │◄──────────────►│  settings.section             │
│  · config.json / state.json      │  /api/yt-duty  │  "YouTube 刷" panel           │
│  · off-peak timer                │                │  (Traditional Chinese UI)     │
│  · HTTP API                      │                └───────────────────────────────┘
│  · spawns one headless round     │
└──────────────┬───────────────────┘
               │ dsh --profile headless --patch <overlay> "<prompt>"
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Headless DSH round (cwd = $DSH_HOME/yt-duty)                        │
│                                                                     │
│   ┌──────────────────────────────┐      stdio JSON-RPC 2.0          │
│   │ mcp/server.mjs (pure Node)   │◄───────────────┐                 │
│   │  yt_search / yt_channel      │                │                 │
│   │  yt_video / yt_transcript    │          ┌─────▼─────┐           │
│   │  yt_asr ──► mcp/asr.py       │          │   agent   │           │
│   │  yt_frames (thumbnails)      │          │ (model)   │           │
│   └──────────────────────────────┘          └─────┬─────┘           │
│                                                  │ writes           │
│                        out/<YYYY-MM-DD>.md  ◄────┘  (Traditional)   │
│                        notes/<videoId>.md       (single-link mode)  │
└─────────────────────────────────────────────────────────────────────┘
```

## Requirements

- **DSH 0.2.1-rc.2 or newer** (tested on DSH Desktop 0.2.1-rc.2, macOS Apple Silicon). The host half needs the `webServer` service.
- **macOS** (primary target) or **Linux**. Windows code paths exist but are untested; notifications are macOS-only.
- **Node.js 20+** (the bundled DSH runtime is fine; the MCP server targets Node 22+). No npm install is needed — the plugin has zero runtime dependencies.
- **Optional:** a YouTube Data API v3 key (much more stable keyword search, explicit quota) and **uv** (only if you enable local Whisper transcription; the installer creates a Python 3.12 venv and installs `faster-whisper` with `av==18.1.0` pinned).

## Install

This is a **local-directory (link-style) bundle install** — the plugin is run from this directory, not copied.

1. Open DSH and use the `plugin_manager` tool with `install_bundle`, passing the **absolute path** of this directory as the target.
2. Restart DSH (the host half loads at startup) and reload the page.
3. The profile should show `include:youtube-scroll` as active, and the settings page gains a **YouTube 刷** section (the panel and its section label are Traditional Chinese; `locale/zh.json` and `locale/en.json` only localise the plugin's card title/description).

> ⚠️ Because this is a link install, **do not delete or move this directory**. To update, replace the files in place and restart DSH; to uninstall, remove the bundle from the profile.

## Settings page

The panel is in Traditional Chinese; the table maps each control to its config key.

| Control (as shipped) | Key | Description |
|---|---|---|
| 峰谷時段自動刷 | `peakValley` | Master switch for automatic off-peak rounds. |
| 中午谷時 / 夜間谷時 | `noon` / `night` | Sub-switches: noon `12:00–14:00`, night `18:00–09:00` (local time). At most one automatic round per window per day. |
| 每天最多挑幾條 | `perDay` | 0–50, default 5. `0` disables automatic rounds (manual runs still work). |
| 關注頻道（一行一個） | `channels` | One per line: `@handle`, `UC…` channel id, or channel URL. Feed via RSS — no API key needed (max 60). |
| 搜索關鍵詞（一行一個） | `keywords` | One per line (max 30). Empty = channels only. |
| YouTube API key（可選） | `apiKey` | Stored locally in `config.json`. Empty = keyless search-page mode. |
| 測試 API key | — | Buttons calls `GET /api/yt-duty/check-key` (one `videos.list` request, ~1 unit). |
| 讓它看影片縮圖 | `frames` | Let the round fetch 1–2 thumbnails per video via `yt_frames` (costs attachment tokens). |
| 用本機 Whisper 轉寫 | `transcribe` | Transcribe captionless videos locally instead of skipping them. |
| Whisper 模型 | `asrModel` | `tiny` / `base` (default) / `small` / `medium`. |
| 安裝轉寫依賴 | — | Creates `asr-venv` via uv and installs `faster-whisper` + pinned `av==18.1.0`; shows status/progress. |
| 單條連結深入分析 | — | Paste a YouTube URL or 11-char id, press 單條解讀 → `POST /single` → note in `notes/<videoId>.md`. |
| 下載 SRT | — | `GET /srt` for the pasted video; downloads `.srt` text. |
| 日報詳細度 | `reportLevel` | `full` (default) / `brief` / `off` (pick only, write headings only). |
| 工作區路徑 | `workspace` | Reads `<workspace>/AGENTS.md` as a persona (first 6000 chars). Empty = neutral voice. |
| Buttons | — | 現在跑一輪 (run now) / 看今天的報告 (view report) / 打開報告資料夾 (open `out/`) / 停止這一輪 (stop) / 清理 90 天前日報 (prune) / 保存 (save text fields). |
| Status badges | — | Today, rounds run today, picked X / cap, peak switch, dedupe ledger size, API searches today / limit, currently-running mode, last run, last error, report path, report/note counts. |

### `config.json` fields

All fields below live in `$DSH_HOME/yt-duty/config.json`. Fields marked *(config only)* have no control in the settings panel — edit the file directly.

| Key | Default | Notes |
|---|---|---|
| `perDay` | `5` | Daily pick cap, 0–50 (0 = no automatic rounds). |
| `peakValley` | `false` | Master switch for auto rounds. |
| `noon` / `night` | `true` / `true` | Which windows may auto-run. |
| `channels` | `[]` | Up to 60 channel identifiers. |
| `keywords` | `[]` | Up to 30 search keywords. |
| `apiKey` | `""` | YouTube Data API v3 key (optional). |
| `reportLevel` | `"full"` | `full` \| `brief` \| `off`. |
| `transcribe` | `false` | Enable local Whisper fallback. |
| `frames` | `false` | Enable thumbnail vision. |
| `asrModel` | `"base"` | `tiny` \| `base` \| `small` \| `medium`. |
| `dedupeDays` | `30` | *(config only)* Days of picks listed as "do not repeat"; 0 disables dedupe. |
| `maxSearchesPerDay` | `80` | *(config only)* Daily keyword-search budget (~100 units each). |
| `roundTimeoutSec` | `900` | *(config only)* Hard per-round timeout, 60–7200 s. |
| `notify` | `true` | *(config only)* macOS completion notifications. |
| `workspace` | `""` | Persona source (`AGENTS.md`). |
| `dshBin` | `""` | *(config only)* Explicit `dsh` CLI path if auto-detection fails. |
| `headlessProfile` | `"headless"` | *(config only)* Profile used for the spawned round. |
| `overlayMcp` | `true` | *(config only)* Mount the MCP server into the round. |
| `lastRun` / `lastError` | `null` / `""` | Written by the host after each round. |

## MCP tools

The MCP server (`mcp/server.mjs`, `serverName: yt-duty`) speaks newline-delimited JSON-RPC 2.0 over stdio and returns tool results as `content: [{type: "text", text: <JSON>}]` (images for `yt_frames`). Errors come back as `isError: true` with `{"error": "…"}`.

| Tool | Arguments | Returns |
|---|---|---|
| `yt_search` | `{query, days? = 7, limit? = 15, order?}` | `{source: "api" \| "scrape", items: [{videoId, title, channel, channelId?, published, views?, durationText?}], relaxed?, note?}`. `order` = `date` (default) \| `relevance` \| `viewCount`. With `YT_API_KEY` it uses `search.list` and falls back to scraping on error. When nothing falls inside `days`, it returns newer-but-older-than-window results with `relaxed: true` and a warning. |
| `yt_channel` | `{channel, days? = 7, limit? = 15}` | Same item shape, plus `source`, `via: "rss"`, `channelId`. `channel` accepts `@handle`, `UC…` id, or a channel URL. Keyless RSS; with a key it tries the Data API first. |
| `yt_video` | `{videoId}` | `{videoId, title, channel, channelId, description, views, durationSeconds, published, hasCaptions, langs, isLive}`. |
| `yt_transcript` | `{videoId, lang?}` | `{videoId, lang, isAuto, segments: [{start, dur, text}], text}`. Language priority: explicit `lang` → `zh-Hant` → `zh-Hans` → `zh` → `en` → first track. Returns `no_captions` when unavailable. |
| `yt_asr` | `{videoId, model?}` | Local Whisper transcript: `{videoId, model, lang, source: "whisper", seconds, text, segments?}`. Errors include `asr_not_installed`, `no_audio_stream`, `audio_download_failed_403`, `silent: true`, `asr_timeout`. |
| `yt_frames` | `{videoId, count? = 2}` (1–4) | MCP **image content** for cover + 25/50/75% thumbnails, plus one JSON meta item. Thumbnails only — not video frames. |

Transcripts are obtained from the watch page's `INNERTUBE_API_KEY` → `youtubei/v1/player` (ANDROID client) → `captionTracks[].baseUrl` → caption XML, with HTML entities unescaped twice. Audio for ASR is fetched from the ANDROID InnerTube `streamingData` (yt-dlp does not work from this setup: SABR / PO token).

## Host HTTP API

The host half registers a prefix route at `/api/yt-duty` (JSON in/out).

| Method & path | Purpose |
|---|---|
| `GET /status` | Today's state: picked count, windows, `running`/`runningMode`, `seenCount`, `apiSearchesToday`/`apiSearchesLimit`, report/notes counts, config. |
| `GET /config` · `POST /config` | Read config / save a whitelisted, range-clamped patch (`{patch: {…}}`). |
| `POST /run` | Start a round now. |
| `POST /stop` | Stop the running round (SIGTERM, SIGKILL after 3 s). |
| `POST /single` | `{url}` or `{videoId}`: start a single-link deep-dive round. |
| `GET /check-key` | Validate the configured YouTube API key (one `videos.list` call). |
| `GET /reports` | Index of daily reports and notes. |
| `POST /prune` | `{keepDays}` (default 90): delete older reports and prune `seen.json`. |
| `GET /srt?videoId=` | Transcript segments as SRT text. |
| `GET /note?videoId=` | Read a generated single-link note. |
| `GET /report?date=YYYY-MM-DD` | Raw daily report text. |
| `GET /asr-status` · `POST /asr-install` | Whisper environment status / background install. |
| `POST /open` | `{what: "out" \| "home"}`: open the folder in the OS file manager. |

## State files

Everything lives under `$DSH_HOME/yt-duty/` (default `~/.dsh/yt-duty/`):

```
config.json            settings (the API key is stored here, locally)
state.json             last round/status data + per-window fire keys + apiUsage {date, count}
seen.json              cross-day dedupe ledger: videoId -> {at, picked}, trimmed to 180 days
duty.md                your editable copy of the duty charter (wins over prompts/duty.md)
duty.log               round log (model output; can get long)
headless-overlay.yml   one-shot overlay written before each round
out/<YYYY-MM-DD>.md    daily reports (Traditional Chinese, ### <videoId> headings)
notes/<videoId>.md     single-link deep notes
asr-venv/              optional local Whisper venv (created by "install transcription deps")
asr-install.log        installer log
models/                Whisper model cache (downloaded via hf-mirror)
tmp/                   transient audio/JSON during ASR (deleted afterwards)
```

## Verification

All of the following were run on 2026-10-22 while preparing this release (macOS, Apple Silicon, DSH Desktop 0.2.1-rc.2, runtime Node 24.21.0):

| Suite | Coverage | Result |
|---|---|---|
| `node --check` | `index.js`, `client.js`, `mcp/server.mjs`, `lib/mcp-call.mjs` | passed |
| `test/host.test.mjs` | 34 offline checks: config whitelist/clamps, HTTP routes (status/config/run/stop/single/report/check-key/reports/prune/srt/note/open/asr), report counting, dedupe/quota state, charter seeding, overlay | **34/34 PASS** |
| `test/client.test.mjs` | 16 offline UI checks via a minimal React stub + fetch stub: registration, rendered sections, toggles, draft-not-overwritten-by-polling, run/report/stop/single/SRT/prune flows, error line on HTTP 500 | **16/16 PASS** (0 skipped) |
| `test/mcp.test.mjs` | 15 live-network MCP cases over stdio: handshake, `tools/list` (6 tools), DSH-supported JSON-Schema subset, live `yt_video`/`yt_transcript`/`yt_search`/`yt_channel`, `relaxed` behaviour, error paths, clean stdout | **15/15 PASS** |
| `test/integration.mjs` | Real end-to-end round (spawns a headless DSH round): project record ≈80 s for 4 channels + 2 keywords, 5 picks, empty `lastError` | project record |
| `yt_asr` timings | Author's M2: 39 s Chinese captionless clip → 25 s (`base`, lang `zh`); 213 s English song → 120 s | project record |
| `yt_frames` | Returned 1 JSON meta + 2 image content items; confirmed the model can see them in a headless round | project record |

How to run (use the app's bundled node; `DSH_DESKTOP_NODE_EXECUTABLE` is required by the wrapper):

```sh
cd /path/to/yt-scroll
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
export DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"

"$NODE" test/host.test.mjs      # offline
"$NODE" test/client.test.mjs    # offline
"$NODE" test/mcp.test.mjs       # live network, ~1 min
"$NODE" test/integration.mjs    # real round — spends tokens
```

`npm test` runs the host + MCP suites (no dependencies to install).

## Limits and known issues

- **Keyless search is page scraping.** It can be rate-limited or break when YouTube changes its markup; results can be sparse. A Data API key is recommended: `search.list` costs 100 units, `videos.list` 1 unit, and the free quota is 10,000 units/day.
- **Quota guard is an estimate.** It budgets ~100 units per *keyword* search and trims surplus keywords for the round. Channel lookups made through the Data API (when a key is set) also consume units but are not counted by the guard.
- **Dedupe is prompt-level, not a hard filter.** The host records picks in `seen.json` and tells the model which recent ids not to pick again; candidates are still fetched and judged.
- **Local Whisper is CPU-only and bounded**: audio downloads are capped at 150 MB, transcription has a hard 20-minute timeout, and some audio URLs are blocked with 403 (recorded as `audio_download_failed_403`); silent/music videos return `silent: true` and are skipped.
- **Thumbnails, not frames.** `yt_frames` fetches YouTube thumbnails (cover + 25/50/75%); it cannot read code or small text on screen.
- **A round is killed after `roundTimeoutSec`** (default 900 s); the **Stop** button sends SIGTERM and escalates to SIGKILL after 3 s. On desktop, automatic rounds have been observed to hang — try one manual round first.
- **Notifications are macOS-only** (`osascript`); on other platforms they are a no-op.
- **The headless profile is minimal**: `cc-safety-net` is not active there, but the round only gets the six read-only tools and is sandboxed to the plugin home.
- **Reports are model-written.** The duty charter forbids fabricating data, treats video content as data (not instructions), and forbids writing outside `out/`/`notes/`, but the model can still err — edit the charter at `$DSH_HOME/yt-duty/duty.md` if needed.
- **SRT export only works for videos with captions** (it converts `yt_transcript` segments; it does not fall back to Whisper).

## Privacy and safety

- The API key is stored locally in `config.json` and passed to the round through environment variables; it is only sent to `googleapis.com` for Data API calls.
- No OAuth, no uploads, no comments, no likes, no subscriptions — those tools are never registered.
- The round runs in a headless DSH profile with the plugin home as its working directory, so generated content stays in `out/` and `notes/` (deletable at any time, or pruned from the settings page).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [DESIGN.md](DESIGN.md). Bug reports and PRs are welcome.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 dsh-youtube-scroll contributors.
