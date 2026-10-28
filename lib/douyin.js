/**
 * Douyin guest reader: resolves a share link / video URL to title, author,
 * duration and a playable video URL. Guest mode only — no signature, no feed.
 * Comments and subtitles are not available without login signatures.
 */
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const TIMEOUT_MS = 20000
const BROWSER_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Hosts owned by Douyin/ByteDance. Page requests may carry the user's Douyin
 * Cookie only when the URL stays inside this set, so a pasted "share link" can
 * never forward credentials to an arbitrary server.
 */
const DOUYIN_HOSTS = [
  'douyin.com',
  'iesdouyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'douyincdn.com',
  'snssdk.com',
  'bytecdn.cn',
  'bytedance.com',
]

/** Whether a hostname belongs to Douyin (exact domain or any subdomain). */
export function isDouyinHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  if (host === '') return false
  return DOUYIN_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** Whether a URL string points at a Douyin-owned host over HTTP(S). */
export function isDouyinUrl(value) {
  try {
    const url = new URL(String(value))
    return (url.protocol === 'http:' || url.protocol === 'https:') && isDouyinHost(url.hostname)
  } catch {
    return false
  }
}

/** Find a winget-installed yt-dlp without hardcoding the user name. */
function findWingetYtDlp() {
  const base = process.env.LOCALAPPDATA
  if (typeof base !== 'string' || base === '') return null
  const packages = join(base, 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const entry of readdirSync(packages)) {
      if (!entry.toLowerCase().includes('yt-dlp')) continue
      const candidate = join(packages, entry, 'yt-dlp.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* not installed via winget */
  }
  return null
}

/** Locate yt-dlp: configured path, the winget install, or PATH. */
function ytdlpBinary(options) {
  const configured = typeof options?.ytdlpPath === 'string' ? options.ytdlpPath.trim() : ''
  if (configured !== '') return configured
  const winget = findWingetYtDlp()
  if (winget !== null) return winget
  return 'yt-dlp'
}

/** Convert a raw Cookie header into a Netscape cookie file for yt-dlp. */
function cookieJarText(rawCookie) {
  const lines = ['# Netscape HTTP Cookie File', '']
  const pairs = String(rawCookie ?? '').split(';')
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (name === '' || value === '') continue
    lines.push(`${'.douyin.com'}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`)
    lines.push(`${'.iesdouyin.com'}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`)
  }
  return lines.join('\n')
}

/** RESOLVE IS IMPLEMENTED BELOW via yt-dlp; keeps the parser honest about failure modes. */
async function resolveWithYtDlp(text, options) {
  if (!isDouyinUrl(text)) throw new Error('不是抖音链接')
  const directory = await mkdtemp(join(tmpdir(), 'fish-douyin-'))
  try {
    const args = ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20']
    const cookie = typeof options?.douyinCookie === 'string' ? options.douyinCookie.trim() : ''
    if (cookie !== '') {
      const cookieFile = join(directory, 'cookies.txt')
      await writeFile(cookieFile, cookieJarText(cookie), 'utf8')
      args.push('--cookies', cookieFile)
    }
    args.push(text)
    let stdout = ''
    try {
      const result = await execFileAsync(ytdlpBinary(options), args, {
        timeout: 90000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      })
      stdout = result.stdout
    } catch (error) {
      const detail = String(error?.stderr ?? '').replace(/\s+/g, ' ').trim()
      if (detail !== '') throw new Error(detail.slice(0, 240))
      throw error
    }
    const data = JSON.parse(stdout)
    const formats = Array.isArray(data?.formats) ? data.formats : []
    const combined = formats
      .filter((item) => item?.url && item.vcodec !== 'none' && item.acodec !== 'none')
      .sort((left, right) => (left.height ?? 0) - (right.height ?? 0))
    const chosen = combined[0] ?? formats.find((item) => item?.url)
    if (chosen === undefined) throw new Error('yt-dlp 没有返回可播放地址')
    return {
      platform: 'douyin',
      bvid: `douyin:${data.id}`,
      aid: null,
      cid: null,
      awemeId: String(data.id ?? ''),
      title: String(data.title ?? '抖音视频').replace(/\s+/g, ' ').trim().slice(0, 120),
      owner: String(data.uploader ?? '未知'),
      duration: Math.round(Number(data.duration) || 0),
      desc: String(data.description ?? '').slice(0, 1200),
      comments: [],
      media: { urls: [chosen.url], headers: douyinMediaHeaders() },
      via: 'yt-dlp',
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Locate the first Douyin-owned URL in pasted text (other links are ignored). */
export function extractDouyinUrl(text) {
  if (typeof text !== 'string') return null
  const matches = text.match(/https?:\/\/[^\s，。、“”'"]+/gu) ?? []
  return matches.find((url) => isDouyinUrl(url)) ?? null
}

/** Normalize a douyin.com URL / share text into a fetchable page URL. */
export function douyinPageUrl(text) {
  const url = extractDouyinUrl(text)
  if (url === null) return null
  return url
}

/** Find `marker = {...}` in HTML and parse the balanced JSON object. */
function readJsObject(html, marker) {
  const start = html.indexOf(marker)
  if (start < 0) return null
  let index = html.indexOf('{', start + marker.length)
  if (index < 0) return null
  const begin = index
  let depth = 0
  let inString = false
  let escaped = false
  for (; index < html.length; index += 1) {
    const char = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(begin, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Walk any JSON tree and collect aweme-like detail objects. */
function collectAwemes(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectAwemes(item, out)
    return out
  }
  const video = node.video
  const playAddr = video?.play_addr ?? video?.playAddr
  const urlList = playAddr?.url_list ?? playAddr?.urlList
  if (typeof node.aweme_id === 'string' && Array.isArray(urlList) && urlList.length > 0) {
    out.push(node)
  }
  for (const value of Object.values(node)) collectAwemes(value, out)
  return out
}

function chooseUrls(aweme) {
  const urls = []
  const video = aweme.video ?? {}
  for (const holder of [video.play_addr, video.playAddr, video.download_addr, video.downloadAddr]) {
    const list = holder?.url_list ?? holder?.urlList
    if (!Array.isArray(list)) continue
    for (const url of list) {
      if (typeof url === 'string' && url.startsWith('http')) urls.push(url.replace(/^http:\/\//, 'https://'))
    }
  }
  return [...new Set(urls)]
}

function describe(aweme, options) {
  const video = aweme.video ?? {}
  const durationMs = Number(video.duration ?? video.duration_ms ?? 0)
  const author = aweme.author ?? {}
  return {
    platform: 'douyin',
    bvid: `douyin:${aweme.aweme_id}`,
    aid: null,
    cid: null,
    awemeId: aweme.aweme_id,
    title: String(aweme.desc ?? aweme.caption ?? '抖音视频').replace(/\s+/g, ' ').trim().slice(0, 120),
    owner: String(author.nickname ?? author.unique_id ?? '未知'),
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    desc: String(aweme.desc ?? '').slice(0, 1200),
    comments: [],
    media: { urls: chooseUrls(aweme), headers: douyinMediaHeaders() },
  }
}

/** Headers for Douyin page/API requests; carries the Cookie only for Douyin hosts. */
export function douyinPageHeaders(options) {
  const headers = { 'user-agent': MOBILE_UA, referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com' }
  const cookie = typeof options?.douyinCookie === 'string' ? options.douyinCookie.trim() : ''
  if (cookie !== '') headers.cookie = cookie
  return headers
}

/** Headers for media CDN requests. Media URLs come from third-party pages, so no Cookie. */
export function douyinMediaHeaders() {
  return { 'user-agent': MOBILE_UA, referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com' }
}

/**
 * Fetch one Douyin page, following redirects manually so the Cookie is never
 * forwarded to a host outside the Douyin allowlist.
 */
async function fetchText(url, options) {
  let current = String(url)
  for (let hop = 0; hop < 6; hop += 1) {
    if (!isDouyinUrl(current)) throw new Error('不是抖音域名，拒绝发送请求')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(current, {
        headers: douyinPageHeaders(options),
        signal: controller.signal,
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') throw new Error('抖音页面跳转缺少地址')
        current = new URL(location, current).href
        continue
      }
      if (!response.ok) throw new Error(`抖音页面 HTTP ${response.status}`)
      return { text: await response.text(), finalUrl: current }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('抖音页面跳转次数过多')
}

function extractAwemeId(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/(?:video|note)\/(\d{8,})/) ?? text.match(/\/(\d{15,})(?:[/?]|$)/) ?? text.match(/^(\d{15,})$/)
  return match === null ? null : match[1]
}

/** Older public guest endpoint: often serves item details without a signature. */
async function fetchItemInfo(awemeId, options) {
  const url = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${encodeURIComponent(awemeId)}`
  const { text } = await fetchText(url, options)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const item = Array.isArray(data?.item_list) ? data.item_list[0] : null
  if (item === null || item === undefined) return null
  return item
}

/** Find an object that looks like an aweme detail anywhere in a JSON tree. */
function findAwemeDetail(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAwemeDetail(item, out)
    return out
  }
  if (typeof node.desc === 'string' && node.desc !== '' && node.video && typeof node.video === 'object') {
    out.push(node)
  }
  for (const value of Object.values(node)) findAwemeDetail(value, out)
  return out
}

/** Run a browser and capture stdout even when it exits non-zero (Edge does). */
function runBrowser(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ stdout, stderr: `${stderr} [timeout]` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }) })
  })
}

/**
 * Last-resort resolver: render the page in a headless Edge/Chrome. The browser
 * executes Douyin's own signature code, so the DOM contains the playable URL.
 */
async function resolveWithBrowser(text, options, awemeIdHint = null) {
  const bin = BROWSER_PATHS.find((path) => existsSync(path))
  if (bin === undefined) throw new Error('没有找到可用的 Edge/Chrome 浏览器')
  // The desktop page embeds the playable URL; the mobile share page does not.
  const awemeId = awemeIdHint ?? extractAwemeId(text) ?? 'unknown'
  const target = awemeId === 'unknown'
    ? (isDouyinUrl(text) ? text : null)
    : `https://www.douyin.com/video/${awemeId}`
  if (target === null) throw new Error('不是抖音链接')
  const profile = await mkdtemp(join(tmpdir(), 'fish-dy-profile-'))
  try {
    const rendered = await runBrowser(bin, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--mute-audio', `--user-data-dir=${profile}`,
      '--virtual-time-budget=15000', '--dump-dom', target,
    ], 90000)
    const html = rendered.stdout
    if (html === '') {
      const detail = rendered.stderr.replace(/\s+/g, ' ').slice(0, 200)
      throw new Error(`浏览器没有输出 DOM（${detail}）`)
    }
    const urls = [...new Set(
      (html.match(/https:\/\/[^"'\s\\]*douyinvod[^"'\s\\]+/g) ?? [])
        .map((url) => url.replace(/^http:\/\//, 'https://').replace(/&amp;/g, '&')),
    )]
    const titleMatch = html.match(/<title>([^<]*)<\/title>/)
    let title = titleMatch === null ? '' : titleMatch[1].replace(/\s*-\s*抖音$/, '').trim()
    let owner = '未知'
    let duration = 0
    let desc = ''
    const renderMatch = html.match(/<script[^>]+id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/)
    if (renderMatch !== null && renderMatch[1] !== '') {
      try {
        const detail = findAwemeDetail(JSON.parse(decodeURIComponent(renderMatch[1])))[0]
        if (detail !== undefined) {
          if (title === '') title = String(detail.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
          owner = String(detail.author?.nickname ?? '未知')
          desc = String(detail.desc ?? '').slice(0, 1200)
          const durationMs = Number(detail.video?.duration ?? 0)
          if (durationMs > 0) duration = Math.round(durationMs / 1000)
        }
      } catch {
        /* fall back to the DOM URL and title */
      }
    }
    if (urls.length === 0) {
      const titleHint = title === '' ? '（无标题）' : title.slice(0, 40)
      const markers = ['douyinvod', 'play_addr', '登录', '验证', 'captcha']
        .filter((marker) => html.includes(marker))
        .join(',')
      throw new Error(`浏览器渲染后没有视频地址（DOM ${html.length} 字节，标题：《${titleHint}》，命中：${markers || '无'}）`)
    }
    if (title === '') title = `抖音视频 ${awemeId}`
    return {
      platform: 'douyin',
      bvid: `douyin:${awemeId}`,
      aid: null,
      cid: null,
      awemeId,
      title: title.slice(0, 120),
      owner,
      duration,
      desc,
      comments: [],
      media: { urls: urls.slice(0, 3), headers: douyinMediaHeaders() },
      via: 'browser',
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

/** Resolve one douyin share link into an intake info object. */
export async function resolveDouyin(text, options) {
  const pageUrl = douyinPageUrl(text)
  if (pageUrl === null) throw new Error('没有找到抖音链接')
  const page = await fetchText(pageUrl, options)
  const awemeId = extractAwemeId(page.finalUrl) ?? extractAwemeId(page.text) ?? extractAwemeId(text)
  const candidates = []
  const routerData = readJsObject(page.text, 'window._ROUTER_DATA')
  if (routerData !== null) collectAwemes(routerData, candidates)
  if (candidates.length === 0) {
    const renderMatch = page.text.match(/<script[^>]+id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/i)
    if (renderMatch !== null) {
      try {
        candidates.push(...collectAwemes(JSON.parse(decodeURIComponent(renderMatch[1]))))
      } catch {
        /* fall through */
      }
    }
  }
  let aweme = candidates[0] ?? null
  if (aweme === null && awemeId !== null) {
    try {
      const item = await fetchItemInfo(awemeId, options)
      if (item !== null) aweme = item
    } catch {
      /* try the desktop page next */
    }
  }
  if (aweme === null && awemeId !== null) {
    try {
      const desktop = await fetchText(`https://www.douyin.com/video/${awemeId}`, options)
      const data = readJsObject(desktop.text, 'window._ROUTER_DATA')
      if (data !== null) {
        const found = []
        collectAwemes(data, found)
        aweme = found[0] ?? null
      }
    } catch {
      /* fall through to the final error */
    }
  }
  if (aweme === null) {
    // The share page is a JS shell; let a headless browser run Douyin's own
    // signature code and read the playable URL from the rendered DOM.
    try {
      return await resolveWithBrowser(page.finalUrl, options, awemeId)
    } catch (browserError) {
      try {
        return await resolveWithYtDlp(page.finalUrl, options)
      } catch (error) {
        const detail = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 200)
        const browserDetail = String(browserError?.message ?? browserError).replace(/\s+/g, ' ').slice(0, 120)
        throw new Error(`抖音解析失败：${detail}（浏览器兜底：${browserDetail}；可在设置里粘贴一条新鲜的抖音 Cookie 再试）`)
      }
    }
  }
  const info = describe(aweme, options)
  if (info.media.urls.length === 0) throw new Error('抖音视频没有可播放地址')
  return info
}
