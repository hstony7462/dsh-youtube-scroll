# Contributing

Thanks for helping improve **dsh-youtube-scroll**! This is a DSH (DeepSeek Harness) plugin, so a few project rules matter more than usual.

## Read first

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — package layout, config keys, HTTP API and the original design contracts.
- [README.en.md](README.en.md) / [README.md](README.md) — features, settings and known limits.

## Invariants (please do not break these)

1. **Read-only by design.** The round may only get read-only tools. Do not add tools for commenting, uploading, liking, subscribing, OAuth, or anything that mutates a YouTube account or remote state.
2. **Zero npm dependencies at runtime.** `mcp/server.mjs`, `lib/mcp-call.mjs` and the host half must work with Node builtins + global `fetch` only. This keeps the link-installed bundle self-contained. Dev-only scripts in `test/` also use builtins only.
3. **No new writes outside `$DSH_HOME/yt-duty/`.** The round's working directory is the plugin home; reports go to `out/`, notes to `notes/`.
4. **DSH JSON-Schema subset for MCP tool schemas.** Only `type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const` and annotations (`description`/`title`/`default`/`examples`) are accepted. Numeric bounds live in descriptions and are clamped in `toInt()`.
5. **No secrets in the repo.** API keys live in `$DSH_HOME/yt-duty/config.json` at runtime; `.env` is git-ignored.

## Layout

```
index.js             host half: config, /api/yt-duty routes, timer, spawning rounds
client.js            browser half: the settings panel (self-registering module)
lib/mcp-call.mjs     tiny stdio MCP client used by the host (SRT export)
mcp/server.mjs       stdio MCP server (pure Node, JSON-RPC 2.0, newline-delimited)
mcp/asr.py           local Whisper transcriber (faster-whisper, run inside a venv)
prompts/duty.md      daily-round charter (user-editable copy lives in the plugin home)
prompts/single.md    single-link deep-analysis charter
locale/*.json        plugin card title/description (zh / en)
test/                host / client / MCP / integration tests + manual round helper
```

## Dev setup

There is nothing to install: the plugin has no npm dependencies.

```sh
cd /path/to/yt-scroll
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
export DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"

for f in index.js client.js mcp/server.mjs lib/mcp-call.mjs; do "$NODE" --check "$f"; done
"$NODE" test/host.test.mjs      # offline
"$NODE" test/client.test.mjs    # offline
"$NODE" test/mcp.test.mjs       # live YouTube network (~1 min)
"$NODE" test/integration.mjs    # real round — spends tokens, use sparingly
```

`npm test` runs the host + MCP suites.

## Pull requests

- Keep `node --check` clean and all four suites green (the MCP suite needs network; the integration suite costs tokens — run it when you touch round spawning/prompting).
- Add or extend tests with your change. `test/host.test.mjs` covers the host API and state; `test/client.test.mjs` renders the panel with a React stub and asserts requests/results; `test/mcp.test.mjs` covers the MCP protocol and live tools.
- User-facing UI text is **Traditional Chinese** (the panel intentionally keeps its existing wording); technical terms stay in English. Only the plugin card strings are localised via `locale/*.json`.
- Style: ESM, small self-contained functions, defensive `try/catch` around anything that runs inside the host process or a round (never let logging/IO take down DSH), and comments in Traditional Chinese where they explain a design decision.
- Note behaviour changes in [CHANGELOG.md](CHANGELOG.md) under a new "Unreleased" section when preparing a release.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
