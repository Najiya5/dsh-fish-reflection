/**
 * User-tunable behaviour stored beside the Harness home directory.
 *
 * These are runtime preferences (a button in Settings writes them), so they stay
 * out of the profile patch: changing one never remounts the plugin and never
 * disturbs the settlement loop's in-memory state.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = Object.freeze({
  /** Run one reflection each evening (or on the next start after a missed one). */
  autoReflection: true,
  /** Minimum digest lines before a reflection may rewrite the worldview. */
  minMaterial: 6,
  /** Master switch for the whole Bilibili reading feature. */
  intakeEnabled: true,
  /** Read one unseen popular Bilibili video on a schedule. */
  autoIntake: false,
  /** Minutes between automatic reads. */
  intakeIntervalMinutes: 60,
  /** Hard cap of automatic reads per local day. */
  intakeDailyLimit: 12,
  /** Only pick from the popular feed; when false the ranking feed is preferred. */
  intakeOnlyPopular: true,
  /** Content lane: `all` = general popular, `life` = 生活区 ranking so personality learns from life material. */
  intakeCategory: 'all',
  /** Skip videos longer than this many minutes (0 disables the filter). */
  intakeMaxDurationMinutes: 60,
  /** Read the comment section when no subtitle is available. */
  intakeReadComments: true,
  /** When a video has no subtitle, download the audio and run local speech recognition. */
  intakeUseAsr: true,
  /** Language hint passed to the recognizer: `auto` or a provider-supported code. */
  asrLanguage: 'auto',
  /** Transcribe at most this many seconds of each video (bounds CPU time). */
  asrMaxSeconds: 600,
  /** ffmpeg executable; empty means "use the one on PATH". */
  ffmpegPath: '',
  /** "Watch" the picture too: sample frames and describe them with the local vision model. */
  intakeUseVision: true,
  /** Frames sampled per video (1-12). */
  visionFrames: 6,
  /** Local vision model name in Ollama. */
  visionModel: 'qwen2.5vl:3b',
  /** Local Ollama service address. */
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  /** Portable Ollama executable used when the service is not running. */
  ollamaAppPath: '',
  /** Model directory passed as OLLAMA_MODELS when the plugin starts the service. */
  ollamaModelsPath: '',
  /** Let external notes (video summaries) count as reflection material. */
  includeExternalInReflection: true,
  /**
   * Raw Bilibili Cookie header, e.g. `SESSDATA=...; bili_jct=...; buvid3=...`.
   * Empty means guest mode. Older releases stored two fields; they are migrated.
   */
  bilibiliCookie: '',
  /** Raw Douyin Cookie header; empty means guest mode (share-page resolution only). */
  douyinCookie: '',
  /** Optional yt-dlp executable path; empty auto-detects the winget install or PATH. */
  ytdlpPath: '',
  /** Douyin share links queued by the user; one is consumed per Douyin read. */
  douyinLinks: [],
  /** Which platforms "刷视频" may read: a subset of `bilibili` / `douyin`. */
  feedSources: ['bilibili', 'douyin'],
  /** External multimodal analyzer (OpenAI-compatible chat completions). */
  analyzerBaseUrl: '',
  analyzerApiKey: '',
  analyzerModel: '',
})

/** Compose a cookie header from the older two-field shape. */
export function legacyCookieString(value) {
  if (value === null || value === undefined || typeof value !== 'object') return ''
  const parts = []
  if (typeof value.sessdata === 'string' && value.sessdata.trim() !== '') parts.push(`SESSDATA=${value.sessdata.trim()}`)
  if (typeof value.biliJct === 'string' && value.biliJct.trim() !== '') parts.push(`bili_jct=${value.biliJct.trim()}`)
  return parts.join('; ')
}

/** Normalize a pasted cookie: one line, bounded, no control characters. */
export function normalizeCookie(value) {
  const raw = typeof value === 'string' ? value : legacyCookieString(value)
  // Douyin's web Cookie header easily exceeds 4 KB; keep a generous bound.
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 12288)
}

/** Directory owned by this plugin inside the Harness home. */
function directory() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'fish-reflection')
}

/** Path of the options document. */
export function optionsPath() {
  return join(directory(), 'options.json')
}

/** Read the current options, merged over the defaults. */
export function readOptions(logger = null) {
  const file = optionsPath()
  if (!existsSync(file)) return normalizeOptions({})
  try {
    return normalizeOptions(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    // Never silently reset: keep the unreadable file for the user and warn.
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      renameSync(file, backup)
    } catch {
      /* the original stays in place; still return defaults so the plugin can run */
    }
    logger?.warn?.(`fish-reflection: options.json unreadable, backed up to ${backup}: ${String(error)}`)
    return normalizeOptions({})
  }
}

/** Write JSON via a same-directory temp file + rename, so a crash cannot truncate it. */
function writeJsonAtomic(file, value, logger = null) {
  const text = JSON.stringify(value, null, 2)
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporary, text, 'utf8')
  try {
    renameSync(temporary, file)
  } catch (error) {
    // Some Windows setups refuse replacing an existing file; fall back to a direct write.
    writeFileSync(file, text, 'utf8')
    logger?.warn?.(`fish-reflection: atomic rename failed, wrote options in place: ${String(error)}`)
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Merge one patch into the stored options and persist the result. */
export function writeOptions(patch, logger = null) {
  const next = normalizeOptions({ ...readOptions(logger), ...(patch ?? {}) })
  mkdirSync(directory(), { recursive: true })
  writeJsonAtomic(optionsPath(), next, logger)
  return next
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Normalize pasted links: trim, dedupe, bound count and length. */
export function normalizeLinks(value) {
  if (!Array.isArray(value)) return []
  const links = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const link = item.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
    if (link === '' || links.includes(link)) continue
    links.push(link)
    if (links.length >= 50) break
  }
  return links
}

function normalizeFeedSources(value) {
  const allowed = ['bilibili', 'douyin']
  if (!Array.isArray(value)) return [...DEFAULTS.feedSources]
  const picked = allowed.filter((item) => value.includes(item))
  return picked.length === 0 ? [] : picked
}

/** Validate and clamp one options object. */
export function normalizeOptions(value) {
  const source = value ?? {}
  return {
    autoReflection: source.autoReflection !== false,
    minMaterial: boundedInteger(source.minMaterial, DEFAULTS.minMaterial, 1, 200),
    intakeEnabled: source.intakeEnabled !== false,
    autoIntake: source.autoIntake === true,
    intakeIntervalMinutes: boundedInteger(source.intakeIntervalMinutes, DEFAULTS.intakeIntervalMinutes, 5, 24 * 60),
    intakeDailyLimit: boundedInteger(source.intakeDailyLimit, DEFAULTS.intakeDailyLimit, 1, 48),
    intakeOnlyPopular: source.intakeOnlyPopular !== false,
    intakeCategory: source.intakeCategory === 'life' ? 'life' : 'all',
    intakeMaxDurationMinutes: boundedInteger(source.intakeMaxDurationMinutes, DEFAULTS.intakeMaxDurationMinutes, 0, 12 * 60),
    intakeReadComments: source.intakeReadComments !== false,
    intakeUseAsr: source.intakeUseAsr !== false,
    asrLanguage: typeof source.asrLanguage === 'string' && source.asrLanguage.trim() !== '' ? source.asrLanguage.trim() : 'auto',
    asrMaxSeconds: boundedInteger(source.asrMaxSeconds, DEFAULTS.asrMaxSeconds, 30, 3600),
    ffmpegPath: typeof source.ffmpegPath === 'string' ? source.ffmpegPath.trim() : '',
    intakeUseVision: source.intakeUseVision !== false,
    visionFrames: boundedInteger(source.visionFrames, DEFAULTS.visionFrames, 1, 12),
    visionModel: typeof source.visionModel === 'string' && source.visionModel.trim() !== '' ? source.visionModel.trim() : DEFAULTS.visionModel,
    ollamaBaseUrl: typeof source.ollamaBaseUrl === 'string' && source.ollamaBaseUrl.trim() !== '' ? source.ollamaBaseUrl.trim() : DEFAULTS.ollamaBaseUrl,
    ollamaAppPath: typeof source.ollamaAppPath === 'string' && source.ollamaAppPath.trim() !== '' ? source.ollamaAppPath.trim() : DEFAULTS.ollamaAppPath,
    ollamaModelsPath: typeof source.ollamaModelsPath === 'string' && source.ollamaModelsPath.trim() !== '' ? source.ollamaModelsPath.trim() : DEFAULTS.ollamaModelsPath,
    includeExternalInReflection: source.includeExternalInReflection !== false,
    bilibiliCookie: normalizeCookie(source.bilibiliCookie),
    douyinCookie: normalizeCookie(source.douyinCookie),
    ytdlpPath: typeof source.ytdlpPath === 'string' ? source.ytdlpPath.trim().slice(0, 300) : '',
    douyinLinks: normalizeLinks(source.douyinLinks),
    feedSources: normalizeFeedSources(source.feedSources),
    analyzerBaseUrl: typeof source.analyzerBaseUrl === 'string' ? source.analyzerBaseUrl.trim().slice(0, 300) : '',
    analyzerApiKey: typeof source.analyzerApiKey === 'string' ? source.analyzerApiKey.trim().slice(0, 500) : '',
    analyzerModel: typeof source.analyzerModel === 'string' ? source.analyzerModel.trim().slice(0, 120) : '',
  }
}

/** Whether a stored Cookie carries a login session. */
export function hasBilibiliCookie(options) {
  return /(?:^|;\s*)SESSDATA=[^;\s]/.test(options?.bilibiliCookie ?? '')
}
