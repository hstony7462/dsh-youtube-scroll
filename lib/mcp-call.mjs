/**
 * 極小的 MCP stdio 客戶端 —— 給宿主半端用（轉寫/SRT/一次性查詢）。
 * 只支援 newline-delimited JSON-RPC 2.0，夠用就好；真正的 agent 那一輪走 @deepseek-ai/dsh-mcp-client。
 */
import { spawn } from 'node:child_process'

/**
 * 呼叫一個 MCP server 的單一工具，回傳它解析後的 JSON（text content）。
 * @param {string} serverPath  server.mjs 的絕對路徑
 * @param {string} tool        工具名
 * @param {object} args        參數
 * @param {{env?: object, timeoutMs?: number}} [opts]
 */
export function callMcp(serverPath, tool, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120_000
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(opts.env || {}) }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(process.execPath, [serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new Error('spawn_failed: ' + (err?.message ?? err)))
      return
    }

    let buffer = ''
    let stderr = ''
    let settled = false
    const pending = new Map()
    let nextId = 0

    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      if (err) reject(err)
      else resolve(value)
    }

    const timer = setTimeout(() => finish(new Error(`timeout_after_${timeoutMs}ms`)), timeoutMs)

    const send = (method, params) => new Promise((res) => {
      const id = ++nextId
      pending.set(id, res)
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        pending.delete(id)
        res(null)
      }
    })

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const res = pending.get(msg.id)
          pending.delete(msg.id)
          res(msg)
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', (err) => finish(new Error('child_error: ' + (err?.message ?? err))))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`server_exit_${code}: ${stderr.slice(-300)}`))
    })

    ;(async () => {
      const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'yt-dsh-host', version: '1.0.0' } })
      if (!init || init.error) return finish(new Error('initialize_failed'))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const res = await send('tools/call', { name: tool, arguments: args })
      if (!res) return finish(new Error('no_response'))
      if (res.error) return finish(new Error(res.error.message || 'rpc_error'))
      const content = res.result?.content || []
      const textPart = content.find((c) => c && c.type === 'text')
      let parsed = null
      if (textPart) { try { parsed = JSON.parse(textPart.text) } catch { parsed = textPart.text } }
      if (res.result?.isError) {
        const detail = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : String(parsed || 'tool_error')
        return finish(new Error(detail))
      }
      finish(null, parsed)
    })().catch((err) => finish(err))
  })
}
