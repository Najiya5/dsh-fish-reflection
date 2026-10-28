/**
 * Minimal Bilibili web-API client: popular list, video metadata, subtitles and
 * top comments. No third-party library and no signature emulation — the public
 * endpoints are called with browser-like headers plus the user's cookies.
 */
import { hasBilibiliCookie } from './options.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const TIMEOUT_MS = 20000

/** Build the cookie request header from the stored raw Cookie string. */
export function cookieHeader(options) {
  const raw = options?.bilibiliCookie
  if (typeof raw === 'string') return raw.trim()
  // Legacy two-field shape, kept for callers that still build it.
  const legacy = raw ?? {}
  const parts = []
  if (typeof legacy.sessdata === 'string' && legacy.sessdata !== '') parts.push(`SESSDATA=${legacy.sessdata}`)
  if (typeof legacy.biliJct === 'string' && legacy.biliJct !== '') parts.push(`bili_jct=${legacy.biliJct}`)
  return parts.join('; ')
}

function requestHeaders(options, extra = {}) {
  const headers = {
    'user-agent': USER_AGENT,
    referer: REFERER,
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    ...extra,
  }
  const cookie = cookieHeader(options)
  if (cookie !== '') headers.cookie = cookie
  return headers
}

/** Fetch one Bilibili API document, translating the API envelope into errors. */
export async function biliJson(url, options, extraHeaders = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: requestHeaders(options, extraHeaders), signal: controller.signal })
    if (!response.ok) {
      const error = new Error(`bilibili HTTP ${response.status}`)
      error.kind = 'http'
      throw error
    }
    const body = await response.json()
    if (body?.code !== 0) {
      const error = new Error(`bilibili code ${body?.code}: ${body?.message ?? ''}`)
      error.kind = 'api'
      error.biliCode = body?.code
      throw error
    }
    return body.data
  } finally {
    clearTimeout(timer)
  }
}

/** Extract a BV id from a BV string, a full URL, or a b23.tv short link. */
export function extractBvid(input) {
  const text = String(input ?? '').trim()
  const direct = /BV[0-9A-Za-z]{10,12}/.exec(text)
  return direct === null ? null : direct[0]
}

/** Resolve a b23.tv short link by following redirects. */
export async function resolveShortLink(input) {
  const text = String(input ?? '').trim()
  if (!/^https?:\/\//.test(text)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(text, { redirect: 'follow', headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal: controller.signal })
    return extractBvid(response.url)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** One page of the public popular feed. */
export async function listPopular(options, limit = 30) {
  const size = Math.min(50, Math.max(1, limit))
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/popular?ps=${size}&pn=1`, options)
  return (data?.list ?? []).map((item) => ({
    bvid: item.bvid,
    title: item.title ?? '',
    aid: item.aid,
    cid: item.cid,
    owner: item?.owner?.name ?? '',
    desc: item.desc ?? '',
    duration: item.duration ?? 0,
    category: item.tname ?? '',
  }))
}

/** Category keywords that count as "life material" when the ranking feed is blocked. */
const LIFE_KEYWORDS = ['生活', '日常', '美食', '旅行', '搞笑', '情感', '动物', '萌宠', '手作', '绘画', '运动', '健身', '家居', '亲子', '三农', '时尚', '穿搭', '美妆', '舞蹈', '音乐', '摄影', 'vlog', 'VLOG']

/** Keep only entries whose category reads like everyday life. */
export function filterLife(items) {
  return items.filter((item) => LIFE_KEYWORDS.some((keyword) => String(item.category ?? '').includes(keyword)))
}

/** One page of the ranking feed (may fail with -352 under risk control). */
export async function listRanking(options, limit = 30, rid = 0) {
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${encodeURIComponent(rid)}&type=all`, options)
  return (data?.list ?? [])
    .slice(0, Math.max(1, limit))
    .map((item) => ({
      bvid: item.bvid,
      title: item.title ?? '',
      aid: item.aid ?? null,
      cid: item.cid ?? null,
      owner: item?.owner?.name ?? '',
      desc: item.desc ?? '',
      duration: item.duration ?? 0,
      category: item.tname ?? '',
    }))
}

/** 生活区 ranking id in the Bilibili taxonomy. */
const LIFE_RANKING_RID = 160

/** List candidates from the configured lane, falling back to the general popular feed. */
export async function listCandidates(options, limit = 40) {
  const life = options?.intakeCategory === 'life'
  if (life) {
    try {
      return { source: 'ranking-life', category: 'life', items: await listRanking(options, limit, LIFE_RANKING_RID) }
    } catch {
      /* the ranking endpoint is the one most exposed to risk control (-352) */
    }
    try {
      const popular = await listPopular(options, Math.max(limit, 50))
      const lifeItems = filterLife(popular)
      if (lifeItems.length > 0) return { source: 'popular-life', category: 'life', items: lifeItems }
      return { source: 'popular', category: 'all', items: popular }
    } catch {
      return { source: 'popular', category: 'all', items: [] }
    }
  }
  if (options?.intakeOnlyPopular !== false) {
    return { source: 'popular', category: 'all', items: await listPopular(options, limit) }
  }
  try {
    return { source: 'ranking', category: 'all', items: await listRanking(options, limit) }
  } catch {
    return { source: 'popular', category: 'all', items: await listPopular(options, limit) }
  }
}

/** Full metadata for one video. */
export async function getVideoInfo(bvid, options) {
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, options)
  const firstPage = Array.isArray(data.pages) && data.pages.length > 0 ? data.pages[0] : null
  return {
    bvid,
    title: data.title ?? '',
    aid: data.aid,
    cid: data.cid ?? firstPage?.cid ?? null,
    desc: data.desc ?? '',
    owner: data?.owner?.name ?? '',
    duration: data.duration ?? 0,
  }
}

/** Download and join the Chinese subtitle text, or `null` when unavailable. */
export async function getSubtitleText(bvid, cid, options) {
  if (cid === null || cid === undefined) return null
  const data = await biliJson(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`, options)
  const subtitles = data?.subtitle?.subtitles ?? []
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null
  const chosen = subtitles.find((item) => String(item?.lan ?? '').startsWith('zh')) ?? subtitles[0]
  let url = chosen?.subtitle_url ?? ''
  if (typeof url !== 'string' || url === '') return null
  if (url.startsWith('//')) url = `https:${url}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: REFERER }, signal: controller.signal })
    if (!response.ok) return null
    const body = await response.json()
    const lines = (body?.body ?? []).map((item) => String(item?.content ?? '').trim()).filter((line) => line !== '')
    return lines.length === 0 ? null : lines.join('\n')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Top comments for one video, as short plain-text lines. */
export async function getTopComments(aid, options, limit = 12) {
  const data = await biliJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=${Math.min(20, limit)}`, options)
  const replies = data?.replies ?? []
  return replies
    .map((reply) => String(reply?.content?.message ?? '').replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .slice(0, limit)
}

/** Probe the endpoints the intake pipeline needs; returns per-step results. */
export async function probe(options) {
  const result = { authenticated: hasBilibiliCookie(options), guestMode: !hasBilibiliCookie(options), popular: null, ranking: null, view: null, errors: [] }
  try {
    const list = await listPopular(options, 3)
    result.popular = { ok: true, count: list.length, sample: list.map((item) => item.title).slice(0, 3) }
  } catch (error) {
    result.popular = { ok: false, error: `${error.kind ?? 'error'}: ${error.message}` }
    result.errors.push(`popular: ${error.message}`)
  }
  try {
    const list = await listRanking(options, 3)
    result.ranking = { ok: true, count: list.length, sample: list.map((item) => item.title).slice(0, 3) }
  } catch (error) {
    result.ranking = { ok: false, error: `${error.kind ?? 'error'}: ${error.message}` }
    result.errors.push(`ranking: ${error.message}`)
  }
  try {
    const list = await listRanking(options, 3, LIFE_RANKING_RID)
    result.rankingLife = { ok: true, count: list.length, sample: list.map((item) => `${item.title}（${item.category || '生活'}）`).slice(0, 3) }
  } catch (error) {
    result.rankingLife = { ok: false, error: `${error.kind ?? 'error'}: ${error.message}` }
    result.errors.push(`rankingLife: ${error.message}`)
  }
  try {
    const info = await getVideoInfo('BV1GJ411x7h7', options)
    result.view = { ok: true, title: info.title, cid: info.cid }
  } catch (error) {
    result.view = { ok: false, error: `${error.kind ?? 'error'}: ${error.message}` }
    result.errors.push(`view: ${error.message}`)
  }
  return result
}
