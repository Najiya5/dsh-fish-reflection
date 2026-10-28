/**
 * Audio side of "watching" a Bilibili video: resolve the DASH audio stream,
 * download it, and transcode to 16 kHz mono WAV for the speech service.
 *
 * This module only orchestrates; the recognizer itself lives behind
 * `ctx.speechToText` in its own plugin.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { biliJson, cookieHeader } from './bilibili.js'

const execFileAsync = promisify(execFile)
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const REQUEST_TIMEOUT_MS = 60000
const MAX_WAV_SECONDS = 1200

/** Resolve the lowest-bitrate video stream (enough for frame descriptions). */
export async function resolveVideoStream(bvid, cid, options) {
  if (cid === null || cid === undefined) return null
  const data = await biliJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16&fnver=0&fourk=1`,
    options,
  )
  const urls = []
  const dash = data?.dash
  if (Array.isArray(dash?.video)) {
    const sorted = [...dash.video].sort((left, right) => (left.bandwidth ?? 0) - (right.bandwidth ?? 0))
    for (const item of sorted) {
      const base = item.baseUrl ?? item.base_url
      if (typeof base === 'string' && base !== '') urls.push(base)
      for (const backup of item.backupUrl ?? item.backup_url ?? []) {
        if (typeof backup === 'string' && backup !== '') urls.push(backup)
      }
    }
  }
  if (urls.length === 0) return null
  return { urls, durationMs: Number(data?.timelength ?? 0) || 0 }
}

/** Request headers for media CDN downloads. */
export function mediaRequestHeaders(options) {
  return mediaHeaders(options)
}

function mediaHeaders(options) {
  const headers = { 'user-agent': USER_AGENT, referer: REFERER, origin: 'https://www.bilibili.com' }
  const cookie = cookieHeader(options)
  if (cookie !== '') headers.cookie = cookie
  return headers
}

/** Resolve playable audio URLs for one video part. */
export async function resolveAudioStream(bvid, cid, options) {
  if (cid === null || cid === undefined) return null
  const data = await biliJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&fnval=16&fnver=0&fourk=1`,
    options,
  )
  const urls = []
  const dash = data?.dash
  if (Array.isArray(dash?.audio)) {
    const sorted = [...dash.audio].sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))
    for (const item of sorted) {
      const base = item.baseUrl ?? item.base_url
      if (typeof base === 'string' && base !== '') urls.push(base)
      for (const backup of item.backupUrl ?? item.backup_url ?? []) {
        if (typeof backup === 'string' && backup !== '') urls.push(backup)
      }
    }
  }
  if (Array.isArray(data?.durl)) {
    for (const item of data.durl) {
      if (typeof item?.url === 'string' && item.url !== '') urls.push(item.url)
    }
  }
  if (urls.length === 0) return null
  return { urls, durationMs: Number(data?.timelength ?? 0) || 0 }
}

/** Download one media URL into memory. */
async function downloadBytes(url, options, headers = null) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: headers ?? mediaHeaders(options), signal: controller.signal })
    if (!response.ok) throw new Error(`media HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/** Download the first working URL from a platform-neutral media descriptor. */
export async function downloadFirst(urls, options, headers = null) {
  let failure = null
  for (const url of urls.slice(0, 3)) {
    try {
      const bytes = await downloadBytes(url, options, headers)
      if (bytes.length > 2048) return bytes
      failure = new Error('media stream too small')
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error('media download failed')
}

/** Download the best audio stream, trying the backup URLs in order. */
export async function downloadAudio(bvid, cid, options) {
  const stream = await resolveAudioStream(bvid, cid, options)
  if (stream === null) return null
  let failure = null
  for (const url of stream.urls.slice(0, 3)) {
    try {
      const bytes = await downloadBytes(url, options)
      if (bytes.length > 2048) return { bytes, durationMs: stream.durationMs }
      failure = new Error('audio stream too small')
    } catch (error) {
      failure = error
    }
  }
  throw failure ?? new Error('audio download failed')
}

/** ffmpeg executable: configured path, else the one on PATH. */
export function ffmpegBinary(configured) {
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'ffmpeg'
}

/** Transcode any container to 16 kHz mono PCM WAV. */
export async function toWav16k(inputBytes, ffmpegPath, maxSeconds = MAX_WAV_SECONDS) {
  const directory = await mkdtemp(join(tmpdir(), 'fish-reflection-media-'))
  const input = join(directory, 'input.bin')
  const output = join(directory, 'output.wav')
  try {
    await writeFile(input, inputBytes)
    await execFileAsync(
      ffmpegBinary(ffmpegPath),
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(maxSeconds), '-f', 'wav', output],
      { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 * 16 },
    )
    const wav = await readFile(output)
    if (wav.length <= 44) throw new Error('transcoded WAV is empty')
    return wav
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
