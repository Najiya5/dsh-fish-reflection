/**
 * Vision side of "watching" a video: start the local Ollama service on demand,
 * grab a handful of frames with ffmpeg, and let a local vision model describe
 * them in Chinese.
 *
 * The model engine stays outside the plugin (a portable Ollama install); this
 * module only orchestrates.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ffmpegBinary, mediaRequestHeaders, resolveVideoStream } from './audio.js'

const execFileAsync = promisify(execFile)
const DEFAULT_FRAMES = 6
const MAX_FRAMES = 12
const START_TIMEOUT_MS = 60000
const FRAME_TIMEOUT_MS = 90000
/** Whole-video budget for descriptions, so a slow/contended GPU cannot wedge intake. */
const TOTAL_VISION_BUDGET_MS = 90000
const EXTRACT_TIMEOUT_MS = 60000
const NOTE_CHAR_LIMIT = 1600

/** Common portable/installer locations for Ollama on Windows. */
const OLLAMA_APP_CANDIDATES = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
  'C:/Program Files/Ollama/ollama.exe',
]

function resolveOllamaApp(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return OLLAMA_APP_CANDIDATES.find((path) => path !== '' && existsSync(path)) ?? ''
}

function resolveOllamaModels(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (typeof process.env.OLLAMA_MODELS === 'string' && process.env.OLLAMA_MODELS.trim() !== '') return process.env.OLLAMA_MODELS.trim()
  return join(homedir(), '.ollama', 'models')
}

/** Resolve the effective vision configuration with safe defaults. */
export function visionConfig(options) {
  const source = options ?? {}
  const frames = Number(source.visionFrames)
  return {
    baseUrl: typeof source.ollamaBaseUrl === 'string' && source.ollamaBaseUrl !== ''
      ? source.ollamaBaseUrl.replace(/\/+$/, '')
      : 'http://127.0.0.1:11434',
    model: typeof source.visionModel === 'string' && source.visionModel !== '' ? source.visionModel : 'qwen2.5vl:3b',
    appPath: resolveOllamaApp(source.ollamaAppPath),
    modelsPath: resolveOllamaModels(source.ollamaModelsPath),
    frames: Number.isFinite(frames) && frames > 0 ? Math.min(MAX_FRAMES, Math.max(1, Math.round(frames))) : DEFAULT_FRAMES,
    timeoutMs: FRAME_TIMEOUT_MS,
  }
}

async function httpJson(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Read whether the local service is up and whether the configured model exists. */
export async function ollamaStatus(options) {
  const conf = visionConfig(options)
  const result = {
    baseUrl: conf.baseUrl,
    model: conf.model,
    appPath: conf.appPath,
    appExists: existsSync(conf.appPath),
    running: false,
    models: [],
    modelPresent: false,
    error: null,
  }
  try {
    const tags = await httpJson(`${conf.baseUrl}/api/tags`, {}, 5000)
    result.running = true
    result.models = (tags?.models ?? []).map((entry) => String(entry?.name ?? '')).filter((name) => name !== '')
    result.modelPresent = result.models.some((name) => name === conf.model || name.startsWith(`${conf.model}:`))
  } catch (error) {
    result.error = String(error?.message ?? error)
  }
  return result
}

/** Ensure the service is reachable, starting the portable Ollama when needed. */
export async function ensureOllama(options, logger) {
  const conf = visionConfig(options)
  const first = await ollamaStatus(options)
  if (first.running) {
    if (!first.modelPresent) throw new Error(`Ollama 已运行，但没有模型 ${conf.model}（现有：${first.models.join(', ') || '无'}）`)
    return conf
  }
  if (!first.appExists) {
    throw new Error(conf.appPath === ''
      ? '未找到 Ollama：请安装 Ollama，或在 ~/.dsh/fish-reflection/options.json 里设置 ollamaAppPath'
      : `找不到 Ollama 可执行文件：${conf.appPath}`)
  }
  logger?.info?.(`fish-reflection: starting ollama at ${conf.appPath}`)
  const child = spawn(conf.appPath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OLLAMA_MODELS: conf.modelsPath },
  })
  child.unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const probe = await ollamaStatus(options)
    if (probe.running) {
      if (!probe.modelPresent) throw new Error(`Ollama 已启动，但没有模型 ${conf.model}`)
      return conf
    }
  }
  throw new Error('Ollama 启动超时（60 秒）')
}

function ffmpegHeaderText(options, headers = null) {
  const source = headers ?? mediaRequestHeaders(options)
  return `${Object.entries(source).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n`
}

/** Extract up to `visionFrames` evenly spaced frames from a media URL. */
export async function extractFrames(videoUrl, durationSeconds, options, headers = null) {
  const conf = visionConfig(options)
  const directory = await mkdtemp(join(tmpdir(), 'fish-vision-'))
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 60
  const frames = conf.frames
  const fps = frames / duration
  try {
    await execFileAsync(
      ffmpegBinary(options.ffmpegPath),
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-headers', ffmpegHeaderText(options, headers),
        '-i', videoUrl,
        '-vf', `fps=${fps.toFixed(6)},scale=480:-2`,
        '-frames:v', String(frames),
        '-q:v', '4',
        join(directory, 'frame-%02d.jpg'),
      ],
      { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
    )
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jpg')).sort()
    const images = []
    for (const name of names) {
      images.push({ name, data: (await readFile(join(directory, name))).toString('base64') })
    }
    return { images, duration }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Describe frames one by one with the local vision model. */
export async function describeFrames(images, options, logger) {
  const conf = await ensureOllama(options, logger)
  const descriptions = []
  const deadline = Date.now() + TOTAL_VISION_BUDGET_MS
  for (const image of images) {
    const budget = deadline - Date.now()
    if (budget <= 5000) {
      logger?.warn?.(`fish-reflection: vision budget exhausted after ${descriptions.length}/${images.length} frames`)
      break
    }
    const body = {
      model: conf.model,
      prompt: '用一到两句中文描述这一帧画面：人物、场景、画面上的文字。只输出描述，不要客套。',
      images: [image.data],
      stream: false,
      options: { temperature: 0.3, num_predict: 160 },
    }
    try {
      const data = await httpJson(`${conf.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, Math.min(conf.timeoutMs, budget))
      const text = String(data?.response ?? '').replace(/\s+/g, ' ').trim()
      if (text !== '') descriptions.push(text)
    } catch (error) {
      logger?.warn?.(`fish-reflection: vision frame failed: ${String(error)}`)
    }
  }
  return descriptions
}

/** Resolve playable video URLs for one intake item (Bilibili or platform media). */
async function videoSources(info, options) {
  if (info.media && Array.isArray(info.media.urls) && info.media.urls.length > 0) {
    return { urls: info.media.urls, headers: info.media.headers ?? null }
  }
  const stream = await resolveVideoStream(info.bvid, info.cid, options)
  if (stream === null) return null
  return { urls: stream.urls, headers: null }
}

/** Frames-only extraction for a video (used by the external analyzer). */
export async function extractVideoFrames(info, options, logger = null) {
  const sources = await videoSources(info, options)
  if (sources === null) return { images: [], duration: info.duration }
  let lastError = null
  for (const url of sources.urls.slice(0, 2)) {
    try {
      const result = await extractFrames(url, info.duration, options, sources.headers)
      if (result.images.length > 0) return result
    } catch (error) {
      lastError = error
      logger?.warn?.(`fish-reflection: frame extraction failed: ${String(error)}`)
    }
  }
  if (lastError !== null) throw lastError
  return { images: [], duration: info.duration }
}

/** Full vision pass for one video; returns a timestamped description or `null`. */
export async function describeVideo(ctx, info, options, logger) {
  await ensureOllama(options, logger)
  const sources = await videoSources(info, options)
  if (sources === null) return null
  let lastError = null
  for (const url of sources.urls.slice(0, 2)) {
    try {
      const { images, duration } = await extractFrames(url, info.duration, options, sources.headers)
      if (images.length === 0) continue
      const descriptions = await describeFrames(images, options, logger)
      if (descriptions.length === 0) continue
      const lines = descriptions.map((text, index) => {
        const at = Math.round((duration * (index + 0.5)) / images.length)
        const minutes = String(Math.floor(at / 60)).padStart(2, '0')
        const seconds = String(at % 60).padStart(2, '0')
        return `${minutes}:${seconds} ${text}`
      })
      return `画面（${descriptions.length} 帧）：${lines.join('；')}`.slice(0, NOTE_CHAR_LIMIT)
    } catch (error) {
      lastError = error
    }
  }
  if (lastError !== null) throw lastError
  return null
}

/** Diagnostic: start the service, extract frames from one video and describe them. */
export async function testVision(ctx, options, request = {}) {
  const bvid = typeof request.bvid === 'string' && request.bvid !== '' ? request.bvid : 'BV1GJ411x7h7'
  const report = { bvid, model: visionConfig(options).model, stages: [], ok: false, descriptions: [] }
  const stage = (name, outcome) => report.stages.push({ name, ...outcome })
  try {
    const { getVideoInfo } = await import('./bilibili.js')
    const info = await getVideoInfo(bvid, options)
    report.title = info.title
    const conf = await ensureOllama(options, ctx.logger)
    stage('ollama', { ok: true, baseUrl: conf.baseUrl })
    const stream = await resolveVideoStream(bvid, info.cid, options)
    stage('playurl', stream === null ? { ok: false, error: 'no video stream' } : { ok: true, urls: stream.urls.length })
    if (stream === null) return report
    const { images, duration } = await extractFrames(stream.urls[0], info.duration, options)
    stage('frames', { ok: images.length > 0, count: images.length, duration })
    const descriptions = await describeFrames(images, options, ctx.logger)
    stage('describe', { ok: descriptions.length > 0, count: descriptions.length })
    report.descriptions = descriptions
    report.ok = descriptions.length > 0
    return report
  } catch (error) {
    stage('error', { ok: false, error: String(error?.message ?? error) })
    return report
  }
}
