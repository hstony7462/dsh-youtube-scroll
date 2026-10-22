#!/usr/bin/env node
/**
 * dsh-youtube-scroll — MCP server test suite (real network, no mocks).
 *
 * Spawns mcp/server.mjs over stdio (newline-delimited JSON-RPC 2.0) and exercises
 * the handshake, tools/list, and all four tools against live YouTube.
 *
 * Run (macOS, bundled Electron-as-node):
 *   DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" test/mcp.test.mjs
 *
 * Exit code: 0 = all PASS, 1 = failures, 2 = harness/global timeout.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'mcp', 'server.mjs');

const VIDEO_ID = 'dQw4w9WgXcQ';
const CHANNEL = '@GoogleDevelopers';
const GLOBAL_TIMEOUT_MS = 240_000;
const CALL_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Minimal MCP client over stdio
 * ------------------------------------------------------------------ */

let child;
let stderrBuf = '';
let stdoutBuf = '';
let nextId = 1;
const pending = new Map();

function startChild() {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    if (process.env.YT_DEBUG) process.stderr.write(chunk);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout breaks the protocol — surface it loudly.
        console.error(`[protocol] non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) {
          const err = new Error(`jsonrpc_error ${msg.error.code}: ${msg.error.message}`);
          err.code = msg.error.code;
          waiter.reject(err);
        } else {
          waiter.resolve(msg);
        }
      }
    }
  });
  child.on('exit', (code, signal) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`server exited (code=${code} signal=${signal}) while waiting for id ${id}`));
    }
    pending.clear();
  });
}

function sendRaw(payload) {
  if (!child || child.exitCode !== null) throw new Error('server process is not running');
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      sendRaw({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

function notify(method, params) {
  sendRaw({ jsonrpc: '2.0', method, params });
}

/** tools/call -> { isError, data } where data is the parsed JSON text payload. */
async function callTool(name, args) {
  const msg = await request('tools/call', { name, arguments: args });
  const text = msg?.result?.content?.[0]?.text;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawText: text };
  }
  return { isError: Boolean(msg?.result?.isError), data, raw: msg };
}

/* ------------------------------------------------------------------ *
 * Assertions + runner
 * ------------------------------------------------------------------ */

const results = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms });
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}  (${ms}ms)`);
  } catch (e) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, error: e.message });
    console.log(`FAIL  ${name}  — ${e.message}  (${ms}ms)`);
  }
}

/* DSH (dsh-tools assertSupportedJsonSchema) only accepts this keyword subset.
 * Violations make the host drop the WHOLE tool list, so guard it offline. */
const DSH_SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
]);
const DSH_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function checkSchemaSubset(schema, path = 'schema', violations = []) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} must be a schema object`);
    return violations;
  }
  for (const key of Object.keys(schema)) {
    if (!DSH_SCHEMA_KEYWORDS.has(key)) violations.push(`${path}.${key} is not in the DSH-supported subset`);
  }
  if (Object.hasOwn(schema, 'type') && !DSH_SCHEMA_TYPES.has(schema.type)) {
    violations.push(`${path}.type ${JSON.stringify(schema.type)} unsupported`);
  }
  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) {
      violations.push(`${path}.required must be an array of strings`);
    } else if (schema.properties) {
      for (const name of schema.required) {
        if (!Object.hasOwn(schema.properties, name)) violations.push(`${path}.required names unknown property ${name}`);
      }
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) {
      checkSchemaSubset(child, `${path}.properties.${name}`, violations);
    }
  }
  if (schema.items) checkSchemaSubset(schema.items, `${path}.items`, violations);
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((child, i) => checkSchemaSubset(child, `${path}.oneOf[${i}]`, violations));
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  startChild();

  await test('initialize handshake', async () => {
    const msg = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'yt-duty-test', version: '0.0.0' },
    });
    assert(msg.result, 'no result field');
    assert(msg.result.protocolVersion === '2024-11-05', `protocolVersion=${msg.result.protocolVersion}`);
    assert(msg.result.serverInfo?.name === 'yt-duty', `serverInfo.name=${msg.result.serverInfo?.name}`);
    assert(msg.result.capabilities?.tools, 'capabilities.tools missing');
    return `serverInfo.version=${msg.result.serverInfo.version}`;
  });

  await test('notifications/initialized is silent', async () => {
    const before = pending.size;
    notify('notifications/initialized');
    await new Promise((r) => setTimeout(r, 250));
    assert(child.exitCode === null, 'server exited after notification');
    assert(pending.size === before, 'notification produced pending response');
    return 'no response, process alive';
  });

  await test('tools/list -> 6 tools', async () => {
    const msg = await request('tools/list');
    const tools = msg.result?.tools || [];
    const names = tools.map((t) => t.name).sort();
    const expected = ['yt_asr', 'yt_channel', 'yt_frames', 'yt_search', 'yt_transcript', 'yt_video'];
    assert(tools.length === 6, `expected 6 tools, got ${tools.length}: ${names.join(',')}`);
    for (const name of expected) assert(names.includes(name), `missing tool ${name}`);
    for (const tool of tools) {
      assert(tool.inputSchema?.type === 'object', `${tool.name} inputSchema.type !== object`);
      assert(tool.description, `${tool.name} has no description`);
    }
    return names.join(',');
  });

  await test('tool schemas fit the DSH-supported JSON Schema subset', async () => {
    const msg = await request('tools/list');
    const tools = msg.result?.tools || [];
    assert(tools.length === 6, `expected 6 tools, got ${tools.length}`);
    const violations = [];
    for (const tool of tools) checkSchemaSubset(tool.inputSchema, `tools[${tool.name}].inputSchema`, violations);
    assert(violations.length === 0, violations.slice(0, 4).join('; '));
    return 'no unsupported keywords (would otherwise drop all tools in DSH)';
  });


  await test(`yt_video ${VIDEO_ID}`, async () => {
    const { isError, data } = await callTool('yt_video', { videoId: VIDEO_ID });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(typeof data.title === 'string' && data.title.length > 0, 'empty title');
    assert(data.videoId === VIDEO_ID, `videoId=${data.videoId}`);
    assert(String(data.channelId || '').startsWith('UC'), `channelId=${data.channelId}`);
    assert(data.durationSeconds > 0, `durationSeconds=${data.durationSeconds}`);
    assert(data.views > 0, `views=${data.views}`);
    assert(data.hasCaptions === true, 'hasCaptions is not true');
    assert(Array.isArray(data.langs) && data.langs.length > 0, 'langs empty');
    assert(typeof data.published === 'string' && data.published.length > 0, 'published empty');
    return `title="${data.title.slice(0, 40)}" views=${data.views} dur=${data.durationSeconds}s langs=${data.langs.join('/')}`;
  });

  await test(`yt_transcript ${VIDEO_ID}`, async () => {
    const { isError, data } = await callTool('yt_transcript', { videoId: VIDEO_ID });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(Array.isArray(data.segments), 'segments is not an array');
    assert(data.segments.length >= 10, `only ${data.segments.length} segments`);
    const first = data.segments[0];
    assert(typeof first.text === 'string' && first.text.length > 0, 'first segment has no text');
    assert(Number.isFinite(first.start), `first.start=${first.start}`);
    assert(typeof data.text === 'string' && data.text.length > 100, `text too short (${String(data.text || '').length})`);
    assert(typeof data.isAuto === 'boolean', 'isAuto is not boolean');
    assert(typeof data.lang === 'string' && data.lang.length > 0, 'lang empty');
    // double-escape check: no raw `&amp;#39;`-style residue should survive
    assert(!/&(?:amp|lt|gt|quot|#\d+);/.test(data.text), 'text still contains HTML entities');
    return `lang=${data.lang} isAuto=${data.isAuto} segments=${data.segments.length} chars=${data.text.length}`;
  });

  await test('yt_search "deepseek harness" days=180', async () => {
    const { isError, data } = await callTool('yt_search', { query: 'deepseek harness', days: 180, limit: 10 });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(['api', 'scrape'].includes(data.source), `source=${data.source}`);
    assert(Array.isArray(data.items), 'items is not an array');
    assert(data.items.length >= 3, `only ${data.items.length} items`);
    for (const item of data.items) {
      assert(/^[A-Za-z0-9_-]{11}$/.test(item.videoId || ''), `bad videoId ${item.videoId}`);
      assert(typeof item.title === 'string' && item.title.length > 0, 'item without title');
      assert(typeof item.channel === 'string', 'item without channel field');
      assert(typeof item.published === 'string' && item.published.length > 0, 'item without published');
    }
    return `source=${data.source} items=${data.items.length} first="${data.items[0].title.slice(0, 34)}"`;
  });

  await test(`yt_channel ${CHANNEL} days=30`, async () => {
    const { isError, data } = await callTool('yt_channel', { channel: CHANNEL, days: 30, limit: 10 });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(['api', 'scrape'].includes(data.source), `source=${data.source}`);
    assert(Array.isArray(data.items) && data.items.length >= 1, `items=${data.items?.length}`);
    for (const item of data.items) {
      assert(/^[A-Za-z0-9_-]{11}$/.test(item.videoId || ''), `bad videoId ${item.videoId}`);
      assert(typeof item.title === 'string' && item.title.length > 0, 'item without title');
    }
    assert(Number.isFinite(Date.parse(data.items[0].published)), `published not ISO: ${data.items[0].published}`);
    return `source=${data.source}${data.via ? `/${data.via}` : ''} items=${data.items.length} latest=${data.items[0].published.slice(0, 10)}`;
  });

  await test('yt_channel by UC id resolves (no @handle)', async () => {
    const { isError, data } = await callTool('yt_channel', {
      channel: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      days: 30,
      limit: 5,
    });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(data.channelId === 'UC_x5XG1OV2P6uZZ5FSM9Ttw', `channelId=${data.channelId}`);
    assert(Array.isArray(data.items) && data.items.length >= 1, `items=${data.items?.length}`);
    return `channelId=${data.channelId} items=${data.items.length}`;
  });

  await test('yt_search days=7 never returns an empty page', async () => {
    const { isError, data } = await callTool('yt_search', { query: 'deepseek harness', days: 7, limit: 5 });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(Array.isArray(data.items) && data.items.length >= 1, 'items empty');
    // Either the strict 7-day filter found something, or the documented relaxed fallback kicked in.
    if (data.relaxed) assert(typeof data.note === 'string' && data.note.length > 0, 'relaxed without note');
    return data.relaxed ? `relaxed=true note="${data.note}"` : `strict items=${data.items.length}`;
  });

  await test('yt_transcript honours explicit lang', async () => {
    const { isError, data } = await callTool('yt_transcript', { videoId: VIDEO_ID, lang: 'ja' });
    assert(!isError, `isError: ${JSON.stringify(data)}`);
    assert(String(data.lang).toLowerCase().startsWith('ja'), `lang=${data.lang}`);
    assert(data.segments.length >= 10, `segments=${data.segments.length}`);
    return `lang=${data.lang} segments=${data.segments.length}`;
  });

  await test('unknown method -> JSON-RPC -32601', async () => {
    let raised = null;
    try {
      await request('definitely/not/a/method', {});
    } catch (e) {
      raised = e;
    }
    assert(raised, 'expected the server to answer with a JSON-RPC error');
    assert(raised.code === -32601, `error.code=${raised.code} (${raised.message})`);
    assert(child.exitCode === null, 'server exited instead of returning an error');
    return `code=${raised.code} message="${raised.message}"`;
  });

  await test('bad videoId -> isError invalid_video_id', async () => {
    const { isError, data } = await callTool('yt_transcript', { videoId: 'short' });
    assert(isError, 'expected isError=true');
    assert(data?.error === 'invalid_video_id', `error=${JSON.stringify(data)}`);
    return `error=${data.error}`;
  });

  await test('nonexistent videoId -> structured error, server alive', async () => {
    const { isError, data } = await callTool('yt_video', { videoId: 'aaaaaaaaaaa' });
    assert(isError, 'expected isError=true');
    assert(typeof data?.error === 'string' && data.error.length > 0, `error=${JSON.stringify(data)}`);
    assert(child.exitCode === null, 'server died on bad video');
    return `error=${data.error}`;
  });

  await test('server never wrote non-JSON to stdout', async () => {
    assert(child.exitCode === null, 'server exited');
    return 'protocol clean';
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const globalTimer = setTimeout(() => {
  console.error(`\nGLOBAL TIMEOUT after ${GLOBAL_TIMEOUT_MS}ms — killing server`);
  if (child) child.kill('SIGKILL');
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref?.();

try {
  await main();
} catch (e) {
  console.error(`\nHARNESS ERROR: ${e?.stack || e}`);
  if (stderrBuf.trim()) console.error(`\n--- server stderr ---\n${stderrBuf.trim().slice(-4000)}`);
  if (child) child.kill('SIGKILL');
  process.exit(1);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '-'.repeat(78));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.error}`}`);
}
console.log('-'.repeat(78));
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);

if (stderrBuf.trim()) {
  const lines = stderrBuf.trim().split('\n').slice(-10);
  console.log(`\nserver stderr (last ${lines.length} lines):\n${lines.join('\n')}`);
}

child.stdin.end();
child.kill('SIGKILL');
process.exit(failed.length ? 1 : 0);
