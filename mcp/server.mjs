#!/usr/bin/env node
/**
 * dsh-youtube-scroll — stdio MCP server (serverName: yt-duty)
 *
 * Pure Node >=22 ESM. Zero npm dependencies: node builtins + global fetch only.
 * Transport: newline-delimited JSON-RPC 2.0 (one JSON object per line on stdin/stdout).
 * stdout carries JSON-RPC messages ONLY; diagnostics go to stderr (YT_DEBUG=1 to enable).
 *
 * Tools (see docs/ARCHITECTURE.md §4):
 *   yt_search   {query, days?, limit?}   -> {source, items[]}
 *   yt_channel  {channel, days?, limit?} -> {source, items[]}
 *   yt_video    {videoId}                -> video metadata incl. hasCaptions/langs
 *   yt_transcript {videoId, lang?}       -> {videoId, lang, isAuto, segments[], text}
 *
 * Env: YT_API_KEY (optional; keyless scraping when empty), YT_DUTY_HOME (state dir; unused here —
 *      this server writes no files), YT_DEBUG (verbose stderr logging).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'yt-duty';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const YT = 'https://www.youtube.com';
const TIMEOUT_MS = 15_000;

const UA_WEB =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
const UA_ANDROID = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_HOME = process.env.YT_DUTY_HOME || join(homedir(), '.dsh', 'yt-duty');
const ASR_PYTHON = process.env.YT_ASR_PYTHON || join(STATE_HOME, 'asr-venv', 'bin', 'python');
const ASR_SCRIPT = join(HERE, 'asr.py');
const ASR_MODELS = ['tiny', 'base', 'small', 'medium'];
const ASR_MODEL_DEFAULT = ASR_MODELS.includes(process.env.YT_ASR_MODEL) ? process.env.YT_ASR_MODEL : 'base';
const ASR_TIMEOUT_MS = 20 * 60 * 1000;
const AUDIO_MAX_BYTES = 150 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 5 * 60 * 1000;

const log = (...args) => {
  if (process.env.YT_DEBUG) console.error('[yt-duty]', ...args);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

async function httpText(url, { headers = {}, timeout = TIMEOUT_MS, retries = 1, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          'user-agent': UA_WEB,
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const err = new Error(`http_${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (e && e.status && e.status >= 400 && e.status < 500) break; // no point retrying 4xx
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`network_error: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

async function httpJson(url, opts = {}) {
  const text = await httpText(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('bad_json_response');
  }
}

/* ------------------------------------------------------------------ *
 * Generic parsing helpers
 * ------------------------------------------------------------------ */

/** Slice a balanced {...} or [...] literal that starts at the first bracket after `marker`. */
function sliceBalanced(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  return sliceBalancedFrom(text, at);
}

/** Slice a balanced literal starting at the first bracket at/after `from`. */
function sliceBalancedFrom(text, from) {
  const start = (() => {
    for (let i = from; i < text.length; i += 1) {
      const c = text[i];
      if (c === '{' || c === '[') return { index: i, open: c, close: c === '{' ? '}' : ']' };
    }
    return null;
  })();
  if (!start) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start.index; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === start.open) depth += 1;
    else if (c === start.close) {
      depth -= 1;
      if (depth === 0) return text.slice(start.index, i + 1);
    }
  }
  return null;
}

/**
 * ytInitialData is normally `var ytInitialData = {...}` but a throttled/consent page can
 * carry other occurrences first, so try every occurrence and keep the first parseable object.
 */
function parseYtInitialData(html) {
  for (const marker of ['ytInitialData = ', 'ytInitialData=', 'ytInitialData']) {
    let at = -1;
    let tries = 0;
    while ((at = html.indexOf(marker, at + 1)) >= 0 && tries < 6) {
      tries += 1;
      const slice = sliceBalancedFrom(html, at + marker.length);
      if (!slice) continue;
      try {
        const value = JSON.parse(slice);
        if (value && typeof value === 'object') return value;
      } catch {
        /* try the next occurrence */
      }
    }
  }
  return null;
}

function parseJsonSlice(text, marker) {
  const slice = sliceBalanced(text, marker);
  if (!slice) return null;
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  '#39': "'",
};

function decodeEntitiesOnce(input) {
  return String(input ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    const named = NAMED_ENTITIES[ent.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** YouTube payloads double-escape text (`&amp;#39;`), so un-escape twice (docs/ARCHITECTURE.md §4). */
function decodeEntities(input, times = 2) {
  let out = String(input ?? '');
  for (let i = 0; i < times; i += 1) out = decodeEntitiesOnce(out);
  return out;
}

function walk(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40) return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) walk(value[key], visit, depth + 1);
}

/** "348,367 views" / "收看次數：13,952 次" / "1.2M views" -> number. */
function parseCount(text) {
  if (text === undefined || text === null || text === '') return undefined;
  const s = String(text);
  const grouped = s.match(/\d{1,3}(?:[,. \u00a0]\d{3})+/);
  if (grouped) return Number(grouped[0].replace(/[,. \u00a0]/g, ''));
  const scaled = s.match(/(\d+(?:\.\d+)?)\s*([KMB万亿])/i);
  if (scaled) {
    const mult = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 }[scaled[2].toLowerCase()] || 1;
    return Math.round(parseFloat(scaled[1]) * mult);
  }
  const plain = s.match(/\d+/);
  return plain ? Number(plain[0]) : undefined;
}

const REL_UNITS = [
  ['months', 30], ['month', 30], ['mo', 30],
  ['minutes', 1 / 1440], ['minute', 1 / 1440], ['mins', 1 / 1440], ['min', 1 / 1440],
  ['seconds', 1 / 86400], ['second', 1 / 86400], ['secs', 1 / 86400], ['sec', 1 / 86400], ['s', 1 / 86400],
  ['hours', 1 / 24], ['hour', 1 / 24], ['hrs', 1 / 24], ['hr', 1 / 24], ['h', 1 / 24],
  ['days', 1], ['day', 1], ['d', 1],
  ['weeks', 7], ['week', 7], ['wks', 7], ['wk', 7], ['w', 7],
  ['years', 365], ['year', 365], ['yrs', 365], ['yr', 365], ['y', 365],
];

const ZH_UNITS = {
  秒: 1 / 86400,
  分鐘: 1 / 1440, 分钟: 1 / 1440, 分: 1 / 1440,
  小時: 1 / 24, 小时: 1 / 24, 時: 1 / 24, 时: 1 / 24,
  天: 1, 日: 1,
  週: 7, 周: 7, 星期: 7,
  個月: 30, 个月: 30, 月: 30,
  年: 365,
};

/** "3 days ago" / "2 星期前" / "1mo ago" -> approximate age in days (null when unknown). */
function parseRelativeDays(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/\u00a0/g, ' ');
  const zh = s.match(/(\d+)\s*(秒|分鐘|分钟|分|小時|小时|時|时|天|日|週|周|星期|個月|个月|月|年)\s*前/);
  if (zh) return Number(zh[1]) * (ZH_UNITS[zh[2]] ?? 0);
  const m = s.match(/(\d+)\s*([a-z]+)/);
  if (!m) return null;
  const unit = m[2];
  for (const [key, mult] of REL_UNITS) {
    if (unit === key || unit.startsWith(key)) return Number(m[1]) * mult;
  }
  return null;
}

/** ISO-8601 duration ("PT13M10S") -> "13:10". */
function isoDurationToText(iso) {
  if (!iso) return undefined;
  const m = String(iso).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return undefined;
  const [, d, h, mi, sec] = m;
  const hours = Number(h || 0) + Number(d || 0) * 24;
  const hoursText = hours > 0 ? `${hours}` : '';
  const minutes = String(Number(mi || 0)).padStart(h > 0 || hours > 0 ? 2 : 1, '0');
  const seconds = String(Number(sec || 0)).padStart(2, '0');
  return hours > 0 ? `${hoursText}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

/* ------------------------------------------------------------------ *
 * YouTube: watch page + innertube player (transcript recipe, verified)
 * ------------------------------------------------------------------ */

const WATCH_CACHE = new Map(); // videoId -> { html, at }
const WATCH_CACHE_TTL = 10 * 60 * 1000;
const WATCH_CACHE_MAX = 24;

function assertVideoId(videoId) {
  const id = String(videoId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('invalid_video_id');
  return id;
}

async function getWatchHtml(videoId) {
  const cached = WATCH_CACHE.get(videoId);
  if (cached && Date.now() - cached.at < WATCH_CACHE_TTL) return cached;
  const html = await httpText(`${YT}/watch?v=${encodeURIComponent(videoId)}`, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  const entry = { html, at: Date.now() };
  WATCH_CACHE.set(videoId, entry);
  if (WATCH_CACHE.size > WATCH_CACHE_MAX) {
    const oldest = [...WATCH_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) WATCH_CACHE.delete(oldest[0]);
  }
  return entry;
}

function getInnertubeKey(html) {
  const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function innertubePlayer(videoId) {
  const { html } = await getWatchHtml(videoId);
  const key = getInnertubeKey(html);
  if (!key) throw new Error('innertube_key_missing');
  const text = await httpText(`${YT}/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA_ANDROID,
      'accept-language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
      videoId,
    }),
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('bad_player_response');
  }
}

function captionTracksFromPlayer(player) {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks.filter((t) => t && typeof t.baseUrl === 'string') : [];
}

function captionTracksFromHtml(html) {
  const parsed = parseJsonSlice(html, '"captionTracks"');
  if (Array.isArray(parsed)) return parsed.filter((t) => t && typeof t.baseUrl === 'string');
  return [];
}

/** Tracks + the player response that carried them (ANDROID first, watch page as fallback). */
async function getCaptionTracks(videoId) {
  let androidPlayer = null;
  try {
    androidPlayer = await innertubePlayer(videoId);
    const tracks = captionTracksFromPlayer(androidPlayer);
    if (tracks.length) return { tracks, player: androidPlayer, from: 'android' };
  } catch (e) {
    log('android player failed', videoId, e.message);
  }

  const { html } = await getWatchHtml(videoId);
  const player = parseJsonSlice(html, 'ytInitialPlayerResponse');
  const tracks = captionTracksFromPlayer(player).length
    ? captionTracksFromPlayer(player)
    : captionTracksFromHtml(html);
  return { tracks, player: player || androidPlayer, from: tracks.length ? 'web' : 'none' };
}

const ZH_HANT = ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'];
const ZH_HANS = ['zh-hans', 'zh-cn', 'zh-sg'];

/** explicit lang -> zh-Hant -> zh-Hans -> zh -> en -> first track (prefer manual over ASR). */
function pickTrack(tracks, lang) {
  if (!tracks.length) return null;
  const code = (t) => String(t.languageCode || '').toLowerCase();
  const prefOrder = [];
  if (lang) prefOrder.push(String(lang).toLowerCase());
  prefOrder.push(...ZH_HANT, ...ZH_HANS, 'zh', 'en', 'en-us', 'en-gb');

  const preferenceScore = (track) => {
    const c = code(track);
    for (let i = 0; i < prefOrder.length; i += 1) {
      const pref = prefOrder[i];
      if (c === pref || c.startsWith(pref)) {
        const isAsr = track.kind === 'asr' ? 1 : 0;
        return i * 10 + isAsr; // lower is better
      }
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const ranked = [...tracks].sort((a, b) => preferenceScore(a) - preferenceScore(b));
  return ranked[0] || null;
}

function parseTranscriptXml(xml) {
  const segments = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const startRaw = (attrs.match(/start="([^"]*)"/) || [])[1];
    const durRaw = (attrs.match(/dur="([^"]*)"/) || [])[1];
    const start = Number(startRaw);
    const dur = Number(durRaw);
    const text = decodeEntities(String(m[2] ?? '').replace(/<[^>]*>/g, ''), 2).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    segments.push({
      start: Number.isFinite(start) ? start : 0,
      dur: Number.isFinite(dur) ? dur : 0,
      text,
    });
  }
  return segments;
}

async function ytTranscript(videoId, lang) {
  const id = assertVideoId(videoId);
  const { tracks } = await getCaptionTracks(id);
  if (!tracks.length) throw new Error('no_captions');

  const track = pickTrack(tracks, lang);
  if (!track) throw new Error('no_captions');

  const url = String(track.baseUrl).replace(/&fmt=srv3/g, '');
  const xml = await httpText(url, { headers: { accept: 'text/xml,application/xml' } });
  const segments = parseTranscriptXml(xml);
  if (!segments.length) throw new Error('no_captions');

  return {
    videoId: id,
    lang: track.languageCode || (lang ? String(lang) : 'unknown'),
    isAuto: track.kind === 'asr',
    segments,
    text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

async function ytVideo(videoId) {
  const id = assertVideoId(videoId);
  const { html } = await getWatchHtml(id);
  let player = parseJsonSlice(html, 'ytInitialPlayerResponse');
  let tracks = captionTracksFromPlayer(player);

  if (!player || !player.videoDetails) {
    try {
      player = await innertubePlayer(id);
      tracks = captionTracksFromPlayer(player);
    } catch (e) {
      log('video fallback failed', id, e.message);
    }
  }
  if (!player || !player.videoDetails) {
    const status = String(player?.playabilityStatus?.status || '');
    log('no videoDetails', id, status);
    throw new Error('video_unavailable');
  }

  if (!tracks.length) tracks = captionTracksFromHtml(html);
  if (!tracks.length) {
    try {
      tracks = (await getCaptionTracks(id)).tracks;
    } catch (e) {
      log('caption tracks unavailable for video', id, e.message);
    }
  }

  const details = player.videoDetails;
  const micro = player.microformat?.playerMicroformatRenderer || {};
  const langs = [];
  for (const track of tracks) {
    const code = track.languageCode;
    if (code && !langs.includes(code)) langs.push(code);
  }
  const views = parseCount(details.viewCount) ?? parseCount(micro.viewCount) ?? 0;
  const isLive = Boolean(details.isLive || micro.liveBroadcastDetails?.isLiveNow);

  return {
    videoId: id,
    title: String(details.title || '').trim(),
    channel: String(details.author || micro.ownerChannelName || '').trim(),
    channelId: String(details.channelId || micro.externalChannelId || '').trim(),
    description: String(details.shortDescription || micro.description?.simpleText || '').trim(),
    views,
    durationSeconds: Number(details.lengthSeconds || micro.lengthSeconds || 0) || 0,
    published: String(micro.publishDate || micro.uploadDate || '').trim(),
    hasCaptions: langs.length > 0,
    langs,
    isLive,
  };
}

/* ------------------------------------------------------------------ *
 * Search (keyless scrape; YouTube Data API when YT_API_KEY is set)
 * ------------------------------------------------------------------ */

function videoRendererToItem(renderer) {
  if (!renderer || !renderer.videoId) return null;
  const title =
    (renderer.title?.runs || []).map((r) => r.text).join('') ||
    renderer.title?.simpleText ||
    '';
  const publishedText = renderer.publishedTimeText?.simpleText || '';
  const ageDays = parseRelativeDays(publishedText);
  const views = parseCount(renderer.viewCountText?.simpleText);
  const durationText = renderer.lengthText?.simpleText || undefined;
  const channelId =
    renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
    renderer.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
    undefined;
  const item = {
    videoId: renderer.videoId,
    title: String(title).trim(),
    channel:
      renderer.ownerText?.runs?.[0]?.text ||
      renderer.longBylineText?.runs?.[0]?.text ||
      '',
    published: ageDays === null ? publishedText : new Date(Date.now() - ageDays * 86400000).toISOString(),
  };
  if (channelId) item.channelId = channelId;
  if (views !== undefined) item.views = views;
  if (durationText) item.durationText = durationText;
  return { item, ageDays, publishedText };
}

function collectSearchRecords(data) {
  const records = [];
  walk(data, (node) => {
    if (node.videoRenderer) {
      const rec = videoRendererToItem(node.videoRenderer);
      if (rec) records.push(rec);
    }
  });
  if (!records.length) {
    // Fallback: search pages sometimes return shorts boxes instead of videoRenderers.
    walk(data, (node) => {
      const s = node.shortsLockupViewModel;
      if (!s) return;
      const videoId = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
      if (!videoId) return;
      records.push({
        item: {
          videoId,
          title: String(s.overlayMetadata?.primaryText?.content || '').trim(),
          channel: '',
          published: '',
        },
        ageDays: null,
        publishedText: '',
      });
    });
  }
  return records;
}

async function scrapeSearch(query, days, limit, order = 'date') {
  // YouTube sometimes answers with a throttled/limited page that parses but carries zero
  // results. Retry once per sort variant before failing.
  // sp: CAI%3D = 按日期, CAMSAhAB = 按播放量, 空 = 相關度
  const variants = [];
  if (order === 'viewCount') variants.push('&sp=CAMSAhAB');
  else if (order === 'relevance') variants.push('');
  else if (days > 0) variants.push('&sp=CAI%3D');
  if (!variants.length) variants.push('');
  if (variants[0] !== '') variants.push('');

  let records = [];
  let lastError = null;
  for (const extra of variants) {
    for (let attempt = 0; attempt < 2 && records.length === 0; attempt += 1) {
      try {
        const url = `${YT}/results?search_query=${encodeURIComponent(query)}${extra}&hl=en&gl=US`;
        const html = await httpText(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
        const data = parseYtInitialData(html);
        if (!data) {
          lastError = new Error('search_parse_failed');
          continue;
        }
        records = collectSearchRecords(data);
      } catch (e) {
        lastError = e;
      }
    }
    if (records.length) break;
  }
  if (!records.length) throw new Error(lastError ? `search_failed: ${lastError.message}` : 'search_no_results');

  const within = records.filter((r) => r.ageDays === null || r.ageDays <= days);
  const kept = days > 0 && within.length ? within : records;
  const items = kept.slice(0, limit).map((r) => r.item);
  const out = { source: 'scrape', items };
  if (days > 0 && !within.length) {
    out.note =
      `no results within ${days} days; returning newest available (relaxed). ` +
      'These items are OUTSIDE the requested window — do not present them as fresh.';
    out.relaxed = true;
  }
  return out;
}

async function apiSearch(query, days, limit, channelId, order = 'date') {
  const key = String(process.env.YT_API_KEY || '').trim();
  if (!key) throw new Error('no_api_key');
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: ['date', 'relevance', 'viewCount'].includes(order) ? order : 'date',
    maxResults: String(Math.min(Math.max(limit, 1), 50)),
    key,
  });
  if (query) params.set('q', query);
  if (channelId) params.set('channelId', channelId);
  if (days > 0) params.set('publishedAfter', new Date(Date.now() - days * 86400000).toISOString());
  const data = await httpJson(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, {
    headers: { 'accept-language': 'en-US' },
  });
  if (data.error) throw new Error(`youtube_api_error: ${data.error.message || data.error.status}`);

  const ids = (data.items || []).map((it) => it.id?.videoId).filter(Boolean);
  const items = (data.items || [])
    .filter((it) => it.id?.videoId)
    .map((it) => {
      const item = {
        videoId: it.id.videoId,
        title: decodeEntities(it.snippet?.title || '', 1),
        channel: decodeEntities(it.snippet?.channelTitle || '', 1),
        published: it.snippet?.publishedAt || '',
      };
      if (it.snippet?.channelId) item.channelId = it.snippet.channelId;
      return item;
    });

  if (ids.length) {
    try {
      const vparams = new URLSearchParams({ part: 'contentDetails,statistics', id: ids.join(','), key });
      const vdata = await httpJson(`https://www.googleapis.com/youtube/v3/videos?${vparams.toString()}`, {
        headers: { 'accept-language': 'en-US' },
      });
      if (!vdata.error) {
        const byId = new Map((vdata.items || []).map((v) => [v.id, v]));
        for (const item of items) {
          const v = byId.get(item.videoId);
          if (!v) continue;
          const views = parseCount(v.statistics?.viewCount);
          if (views !== undefined) item.views = views;
          const durationText = isoDurationToText(v.contentDetails?.duration);
          if (durationText) item.durationText = durationText;
        }
      }
    } catch (e) {
      log('videos.list failed, keeping snippets', e.message);
    }
  }
  return { source: 'api', items };
}

async function ytSearch(query, days, limit, order) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('invalid_query');
  const sort = ['date', 'relevance', 'viewCount'].includes(String(order)) ? String(order) : 'date';
  if (String(process.env.YT_API_KEY || '').trim()) {
    try {
      return await apiSearch(q, days, limit, null, sort);
    } catch (e) {
      log('api search failed, falling back to scrape', e.message);
    }
  }
  return scrapeSearch(q, days, limit, sort);
}

/* ------------------------------------------------------------------ *
 * Channel: resolve -> RSS (keyless) or API when a key is available
 * ------------------------------------------------------------------ */

function extractChannelId(text) {
  const patterns = [
    /"channelId"\s*:\s*"(UC[\w-]{22})"/,
    /"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /channel_id=(UC[\w-]{22})/,
    /"browseId"\s*:\s*"(UC[\w-]{22})"/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

async function resolveChannelId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('invalid_channel');
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }

  const direct = s.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/);
  if (direct) return direct[1];
  if (/^UC[\w-]{22}$/.test(s)) return s;

  let handle = null;
  if (s.startsWith('@')) handle = s.slice(1).split(/[/?#]/)[0];
  else if (s.includes('/@')) handle = s.split('/@')[1].split(/[/?#]/)[0];
  else if (s.startsWith('http')) handle = null;
  else handle = s.split(/[/?#]/)[0];

  const candidateUrl = handle
    ? `${YT}/@${encodeURIComponent(handle)}`
    : s.startsWith('http')
      ? s
      : `${YT}/@${encodeURIComponent(s)}`;

  const html = await httpText(candidateUrl, { headers: { accept: 'text/html,application/xhtml+xml' } });
  const id = extractChannelId(html);
  if (!id) throw new Error('channel_not_resolved');
  return id;
}

function parseRssEntries(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const pick = (tag) => {
      const hit = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return hit ? hit[1] : '';
    };
    const videoId = decodeEntities(pick('yt:videoId'), 1).trim();
    if (!videoId) continue;
    const entry = {
      videoId,
      title: decodeEntities(pick('title'), 2).trim(),
      channel: decodeEntities(pick('name'), 1).trim(),
      published: decodeEntities(pick('published'), 1).trim(),
    };
    const viewsAttr = body.match(/<media:statistics[^>]*views="(\d+)"/);
    if (viewsAttr) entry.views = Number(viewsAttr[1]);
    entries.push(entry);
  }
  return entries;
}

async function ytChannel(channel, days, limit) {
  const channelId = await resolveChannelId(channel);

  if (String(process.env.YT_API_KEY || '').trim()) {
    try {
      const res = await apiSearch('', days, limit, channelId);
      res.items = res.items.map((it) => ({ ...it, channelId: it.channelId || channelId }));
      return res;
    } catch (e) {
      log('api channel failed, falling back to RSS', e.message);
    }
  }

  const xml = await httpText(`${YT}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    headers: { accept: 'application/xml,text/xml' },
  });
  if (!xml.includes('<entry')) throw new Error('channel_feed_empty');

  const entries = parseRssEntries(xml);
  if (!entries.length) throw new Error('channel_feed_empty');

  const filtered = entries.filter((e) => {
    if (!(days > 0)) return true;
    const t = Date.parse(e.published);
    if (!Number.isFinite(t)) return true;
    return (Date.now() - t) / 86400000 <= days;
  });
  const out = {
    source: 'scrape',
    via: 'rss',
    channelId,
    items: filtered.slice(0, limit),
  };
  if (days > 0 && !filtered.length && entries.length) {
    out.items = entries.slice(0, limit);
    out.note = `no feed entries within ${days} days; returned newest available (unfiltered)`;
    out.relaxed = true;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * MCP tool definitions
 * ------------------------------------------------------------------ */

// NOTE: DSH validates MCP tool schemas with assertSupportedJsonSchema(), which only
// accepts type/oneOf/properties/required/additionalProperties/items/enum/const plus
// annotations (description/title/default/examples). minimum/maximum are NOT allowed,
// so numeric bounds live in the description and are clamped in toInt().
/* ------------------------------------------------------------------ *
 * Local ASR (Whisper) — only used for videos without captions
 * ------------------------------------------------------------------ */

function runProcess(command, args, { timeout = 120_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error('asr_timeout'));
    }, timeout);
    const collect = (buf) => {
      output += String(buf);
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('asr_spawn_failed: ' + (e && e.message ? e.message : String(e))));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error('asr_failed(' + code + '): ' + output.slice(-500)));
    });
  });
}

function pickAudioFormat(player) {
  const sd = player && player.streamingData ? player.streamingData : {};
  const all = [...(Array.isArray(sd.formats) ? sd.formats : []), ...(Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : [])];
  const audio = all.filter((f) => f && typeof f.url === 'string' && String(f.mimeType || '').startsWith('audio/'));
  audio.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  return audio[0] || null;
}

/** Download the best audio stream, run local Whisper, return the transcript. */
async function ytAsr(videoId, model) {
  const id = assertVideoId(videoId);
  const useModel = ASR_MODELS.includes(String(model)) ? String(model) : ASR_MODEL_DEFAULT;
  if (!existsSync(ASR_PYTHON) || !existsSync(ASR_SCRIPT)) {
    throw new Error(
      'asr_not_installed: 本機轉寫環境未安裝（缺 ' + (existsSync(ASR_SCRIPT) ? ASR_PYTHON : ASR_SCRIPT) + '）—— 到設置頁按「安裝轉寫依賴」',
    );
  }

  const player = await innertubePlayer(id);
  const fmt = pickAudioFormat(player);
  if (!fmt) throw new Error('no_audio_stream');

  const ext = String(fmt.mimeType || '').includes('webm') ? 'webm' : 'm4a';
  const tmpDir = join(STATE_HOME, 'tmp');
  const stamp = `${id}-${Date.now()}`;
  const audioFile = join(tmpDir, `asr-${stamp}.${ext}`);
  const outFile = join(tmpDir, `asr-${stamp}.json`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    const res = await fetch(fmt.url, {
      headers: { 'user-agent': UA_ANDROID, 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('audio_download_failed_' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > AUDIO_MAX_BYTES) throw new Error('audio_too_large');
    writeFileSync(audioFile, buf);

    const started = Date.now();
    await runProcess(ASR_PYTHON, [ASR_SCRIPT, audioFile, '--model', useModel, '--out', outFile], {
      timeout: ASR_TIMEOUT_MS,
      env: { HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
    });
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    if (!parsed || parsed.ok !== true) throw new Error('asr_failed: ' + (parsed && parsed.error ? parsed.error : 'unknown'));
    return {
      videoId: id,
      model: useModel,
      lang: parsed.lang || null,
      isAuto: true,
      source: 'whisper',
      seconds: Math.round((Date.now() - started) / 1000),
      audioBytes: buf.length,
      text: parsed.text || '',
      segments: Array.isArray(parsed.segments) ? parsed.segments : undefined,
    };
  } finally {
    try { rmSync(audioFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  }
}

const DAYS_SCHEMA = {
  type: 'number',
  default: 7,
  description: '只看最近 N 天（0 = 不過濾；預設 7，上限 3650）',
};
const LIMIT_SCHEMA = {
  type: 'number',
  default: 15,
  description: '最多回傳幾條（1–50，預設 15）',
};

const TOOLS = [
  {
    name: 'yt_search',
    description:
      '搜尋 YouTube 影片（免 key 抓搜尋頁；設定 YT_API_KEY 時走 Data API，失敗自動回退）。' +
      '回傳 JSON {source, items:[{videoId,title,channel,channelId?,published,views?,durationText?}]}；' +
      'order 可選 date（預設）| relevance | viewCount —— 做「某主題有哪些好片」時用 relevance；' +
      '抓不到近 N 天結果時會回 relaxed=true + note 並附上最新可用結果。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜尋關鍵詞' },
        days: DAYS_SCHEMA,
        limit: LIMIT_SCHEMA,
        order: { type: 'string', description: '排序：date（最新，預設）| relevance（相關度）| viewCount（播放量）。做主題研究用 relevance' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'yt_channel',
    description:
      '取某個頻道最近的影片（免 key 走 RSS；有 YT_API_KEY 時走 Data API）。' +
      'channel 接受 @handle、UCxxxxxxxxxxxxxxxxxxxxxx、或頻道 URL。' +
      '回傳 JSON {source, items:[{videoId,title,channel,published,views?}]}。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '@handle 或 UC id 或頻道 URL' },
        days: DAYS_SCHEMA,
        limit: LIMIT_SCHEMA,
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'yt_video',
    description:
      '取單一影片後設資料：{videoId,title,channel,channelId,description,views,durationSeconds,' +
      'published,hasCaptions,langs,isLive}。判斷「有沒有字幕」用它，不要靠猜。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '11 字元 YouTube videoId' },
      },
      required: ['videoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'yt_transcript',
    description:
      '取字幕原文（先 ANDROID innertube player，失敗回退 watch 頁）。語言優先序：' +
      '指定 lang → zh-Hant → zh-Hans → zh → en → 第一條。回傳 ' +
      '{videoId,lang,isAuto,segments:[{start,dur,text}],text}；無字幕回 {"error":"no_captions"}。' +
      '判斷內容必須讀 text/segments 原文。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '11 字元 YouTube videoId' },
        lang: { type: 'string', description: '偏好語言代碼，例如 zh-Hant / en' },
      },
      required: ['videoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'yt_asr',
    description:
      '下載音訊並用「本機 Whisper」轉寫 —— 只給沒有字幕的影片用。' +
      '回傳 {videoId,model,lang,source:"whisper",seconds,text,segments?}；' +
      '環境未安裝時回 {"error":"asr_not_installed…"}；失敗就跳過這條，不要重試超過一次。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '11 字元 YouTube videoId' },
        model: { type: 'string', description: 'tiny | base | small | medium（預設 base；越大越準也越慢）' },
      },
      required: ['videoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'yt_frames',
    description:
      '取這條影片的縮圖畫面（封面 + 25/50/75% 各一張，回傳真正的圖片內容，讓你看得見）。' +
      '只作輔助：字幕是主要依據；細字／代碼看不清。建議一次 1–2 張（count 預設 2，最多 4）。',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: '11 字元 YouTube videoId' },
        count: { type: 'number', description: '要幾張圖（1–4，預設 2）' },
      },
      required: ['videoId'],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ *
 * Frames (vision) — thumbnails only, no video download
 * ------------------------------------------------------------------ */

const FRAME_SPECS = [
  { name: 'cover', file: 'maxresdefault.jpg', at: '封面／代表性畫面（1280×720，沒有時退回 hqdefault）' },
  { name: 'p25', file: 'hq1.jpg', at: '約 25% 位置（480×360）' },
  { name: 'p50', file: 'hq2.jpg', at: '約 50% 位置（480×360）' },
  { name: 'p75', file: 'hq3.jpg', at: '約 75% 位置（480×360）' },
];

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA_WEB, 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const mimeType = String(res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mimeType.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
  return { mimeType, data: buf.toString('base64'), bytes: buf.length };
}

/** Return MCP image content for a few thumbnails (1–2 recommended by the caller). */
async function ytFrames(videoId, count) {
  const id = assertVideoId(videoId);
  const n = Math.max(1, Math.min(4, Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 2));
  const images = [];
  const meta = [];
  for (const spec of FRAME_SPECS.slice(0, n)) {
    let file = spec.file;
    let img = await fetchImage(`https://i.ytimg.com/vi/${id}/${file}`).catch(() => null);
    if (!img && spec.name === 'cover') {
      file = 'hqdefault.jpg';
      img = await fetchImage(`https://i.ytimg.com/vi/${id}/${file}`).catch(() => null);
    }
    if (!img) continue;
    images.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    meta.push({ name: spec.name, at: spec.at, bytes: img.bytes, mimeType: img.mimeType });
  }
  if (!images.length) throw new Error('no_frames_available');
  return { __images: images, meta: { videoId: id, note: '縮圖不是逐格畫面；細字／代碼看不清，只能判斷大致場景與主題', frames: meta } };
}

/* ------------------------------------------------------------------ *
 * Argument coercion
 * ------------------------------------------------------------------ */

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function runTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'yt_search':
      return ytSearch(a.query, toInt(a.days, 7, 0, 3650), toInt(a.limit, 15, 1, 50), a.order ? String(a.order) : undefined);
    case 'yt_channel':
      return ytChannel(a.channel, toInt(a.days, 7, 0, 3650), toInt(a.limit, 15, 1, 50));
    case 'yt_video':
      return ytVideo(a.videoId);
    case 'yt_transcript':
      return ytTranscript(a.videoId, a.lang ? String(a.lang) : undefined);
    case 'yt_asr':
      return ytAsr(a.videoId, a.model ? String(a.model) : undefined);
    case 'yt_frames':
      return ytFrames(a.videoId, a.count);
    default: {
      const err = new Error('unknown_tool');
      err.code = -32602;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 over newline-delimited stdio
 * ------------------------------------------------------------------ */

function writeMessage(message) {
  if (!process.stdout.writable) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: '2.0', id, error });
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const known = TOOLS.some((t) => t.name === name);
  if (!known) {
    replyError(id, -32602, `Unknown tool: ${String(name)}`);
    return;
  }
  try {
    const result = await runTool(name, args);
    if (result && Array.isArray(result.__images)) {
      // 圖片工具：文字 meta + 真正的 image content（模型看得到）
      const { __images, ...rest } = result;
      reply(id, { content: [{ type: 'text', text: JSON.stringify(rest) }, ...__images] });
      return;
    }
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    });
  }
}

async function handleMessage(message) {
  const method = message?.method;
  const id = message?.id;
  const isNotification = id === undefined || id === null;

  if (!method || typeof method !== 'string') {
    if (!isNotification) replyError(id, -32600, 'Invalid Request');
    return;
  }

  if (isNotification) {
    // notifications/initialized, notifications/cancelled, ... -> never answer.
    log('notification', method);
    return;
  }

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      await handleToolsCall(id, message.params);
      return;
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

function start() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      replyError(null, -32700, 'Parse error');
      return;
    }
    if (Array.isArray(message)) {
      replyError(null, -32600, 'Batch requests are not supported');
      return;
    }
    // Serialize handling so concurrent tool calls cannot interleave stdout writes.
    queue = queue
      .then(() => handleMessage(message))
      .catch((e) => {
        log('handler crashed', e && e.stack ? e.stack : e);
        if (message && message.id !== undefined && message.id !== null) {
          replyError(message.id, -32603, 'Internal error');
        }
      });
  });

  rl.on('close', () => {
    log('stdin closed, exiting');
    process.exitCode = 0;
  });

  process.stdout.on('error', (e) => log('stdout error', e.message));
  process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack ? e.stack : e));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack ? e.stack : e));

  log('started', SERVER_NAME, SERVER_VERSION);
}

start();
