# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [1.0.5] - 2026-10-22

Attribution. No code changes.

### Added

- [`NOTICE.md`](NOTICE.md): reproduces the MIT license of **dsh-bili-scroll**
  ([c1overzz](https://github.com/c1overzz)), the MIT-licensed Bilibili plugin this project is
  modelled on (settings-page structure, daily headless round, config/state layout, prompt style).
- README.md / README.en.md: a "Credits / 致謝" section pointing at the upstream project.
- docs/ARCHITECTURE.md: notes that the design is adapted from dsh-bili-scroll.
- `NOTICE.md` is now part of the npm tarball and the GitHub repository.

## [1.0.4] - 2026-10-22

Portability fix: the plugin now works on non-Desktop (npm-installed) DSH profiles.

### Fixed

- `findDshCli()` no longer only looks inside the macOS Desktop app bundle. It now also
  resolves the `dsh` CLI from `PATH`, from `<profile>/node_modules/@deepseek-ai/dsh/lib/bin.js`,
  and from a global Node.js installation. Before this fix, a user who installed DSH with
  npm (no Electron app bundle) would get "cannot find dsh" and no round could start.

## [1.0.3] - 2026-10-22

Publishing moved to npm **Trusted Publishing** (GitHub Actions OIDC). No code changes.

### Changed

- Pushing a `v*` tag now publishes the package automatically from
  [`.github/workflows/publish.yml`](.github/workflows/publish.yml) using OIDC and
  provenance; no long-lived npm tokens are used or stored.
- The npm package page has this workflow configured as a trusted publisher
  (`publish.yml` ↔ `hstony7462/dsh-youtube-scroll`, direct publish + stage publish).

## [1.0.2] - 2026-10-22

First npm release — **published as `dsh-youtube-scroll@1.0.2` on npm** (`dsh plugin add dsh-youtube-scroll`). No code changes.

### Added

- `.npmignore` and a trimmed `files` list: the published tarball no longer ships `test/`, `.github/`, `__pycache__` or runtime data (the first dry-run showed `mcp/__pycache__/asr.cpython-312.pyc`).
- npm publish metadata: `repository`, `homepage`, `bugs`, MIT license and the `dsh` bundle/client fields are present in the published package.

## [1.0.1] - 2026-10-22

Maintenance release: CI, badges, docs layout. No behaviour changes.

### Added

- **GitHub Actions CI** (`.github/workflows/test.yml`): every push/PR runs the offline suites — host half (34 tests) and browser half (16 tests). A manually dispatched run also executes the live YouTube MCP suite (non-blocking, because it depends on network and YouTube rate limits).
- **README badges** for test status, latest release and license (both README.md and README.en.md).
- `package.json` scripts: `test` (offline: host + client), `test:live` (live MCP suite), `check` (syntax checks).

### Changed

- `DESIGN.md` moved to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); references updated in both READMEs, CONTRIBUTING, `client.js` and `mcp/server.mjs`.
- Test docs in README now describe the offline / live split and the CI workflow.

## [1.0.0] - 2026-10-22

Initial public release.

### Added

- **Daily YouTube scroll** — one headless DSH round collects recent candidates from channel RSS feeds (keyless) and optional keyword searches (YouTube Data API when a key is set, otherwise keyless search-page scraping), reads transcripts before judging, and writes a Traditional Chinese daily report to `$DSH_HOME/yt-duty/out/<YYYY-MM-DD>.md` with one `### <11-char videoId>` heading per pick (used to count picks).
- **Six read-only MCP tools** over stdio (newline-delimited JSON-RPC 2.0, pure Node, zero npm dependencies): `yt_search`, `yt_channel`, `yt_video`, `yt_transcript`, `yt_asr`, `yt_frames`. No comment/upload/like/subscribe/OAuth tools are registered.
- **Local Whisper transcription** (`mcp/asr.py`, faster-whisper on CPU) as a fallback for captionless videos, with a one-click dependency installer (`uv` venv, `av==18.1.0` pinned) and `tiny`/`base`/`small`/`medium` models.
- **Optional thumbnail vision** — `yt_frames` returns real MCP image content (cover + 25/50/75% thumbnails) so the model can judge the visual side.
- **Off-peak auto-run** — optional noon (`12:00–14:00`) and night (`18:00–09:00`) windows, at most one automatic round per window per day, gated by the daily pick cap.
- **Cross-day dedupe** — picks are recorded in `seen.json` (kept 180 days) and the next round's prompt lists ids picked within `dedupeDays` (default 30) so they are not picked again.
- **Single-link deep analysis** — paste a URL in the settings page to run `prompts/single.md`; writes a full note (one-liner, chapter timeline, key ideas, numbers, glossary, practical implications, limits, quotable lines) to `notes/<videoId>.md`.
- **SRT export** — `GET /api/yt-duty/srt?videoId=…` converts transcript segments to SRT.
- **Stop and timeout** — a Stop button (SIGTERM, then SIGKILL after 3 s) plus a per-round watchdog (`roundTimeoutSec`, default 900 s).
- **API-search quota guard** — keyword searches are budgeted at ~100 Data-API units each against `maxSearchesPerDay` (default 80); surplus keywords are trimmed from the round with a note in the prompt.
- **Completion notifications** — macOS system notification when a round or single-link analysis finishes or fails (`notify`, default on).
- **Report index and prune** — list daily reports and notes; prune reports older than 90 days (also prunes `seen.json`).
- **API-key test** — one `videos.list` request (~1 unit) to validate the configured YouTube Data API key.
- **Settings page** (Traditional Chinese) with off-peak switches, daily cap, channels, keywords, API key + test, thumbnail vision, Whisper options + installer, single-link analysis + SRT download, report detail level, workspace persona, and status badges (picks, running mode, dedupe ledger size, API searches used, report/note counts) plus run/view report/open folder/stop/prune/save actions.
- **Duty charter** (`prompts/duty.md`, editable copy at `$DSH_HOME/yt-duty/duty.md`) with no-fabrication, prompt-injection-resistance and write-scope rules.
- **Test suites** — 34 offline host checks, 16 offline browser-half checks (React/fetch stubs), 15 live-network MCP cases, and an end-to-end round runner (`test/integration.mjs`), plus a manual round helper (`test/run-now.mjs`).

### Notes

- Requires DSH 0.2.1-rc.2+ and Node.js 20+ (MCP server targets Node 22+). Installed as a local link-style bundle, so the plugin directory must stay in place.
- Read-only by design; reports and notes are written only under `$DSH_HOME/yt-duty/`.
- YouTube may block some audio streams (403/SABR): such videos are skipped and logged as `audio_download_failed_403`; silent videos return `silent: true`.
