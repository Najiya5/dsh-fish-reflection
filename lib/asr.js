/**
 * Speech recognition adapter: reads the mounted `ctx.speechToText` capability
 * and drives its preparation lifecycle, so the engine itself stays in its own
 * plugin. Nothing here knows how SenseVoice works.
 */
import { toWav16k, downloadAudio, downloadFirst } from './audio.js'

const PREPARE_TIMEOUT_MS = 15 * 60_000
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000
/** Whole-file budget across chunks: a stalled worker must not wedge the intake loop. */
const TOTAL_TRANSCRIBE_BUDGET_MS = 4 * 60_000

/** Read the current recognizer roster without preparing anything. */
export function asrStatus(ctx) {
  const service = ctx.get('speechToText')
  if (service === undefined || service === null) {
    return { available: false, reason: 'speech-service-missing', providers: [] }
  }
  try {
    const snapshot = service.snapshot()
    const providers = (snapshot.providers ?? []).map((provider) => ({
      id: String(provider.id),
      name: provider.name,
      location: provider.location,
      languages: provider.languages ?? [],
      phase: provider.preparation?.phase ?? 'unprepared',
      download: provider.preparation?.download ?? null,
    }))
    return {
      available: providers.length > 0,
      providers,
      selection: snapshot.selection === undefined ? null : {
        providerId: String(snapshot.selection.providerId),
        language: snapshot.selection.language,
      },
    }
  } catch (error) {
    return { available: false, reason: String(error), providers: [] }
  }
}

/** Wait until the selected provider reports ready/standby, preparing it if needed. */
async function ensurePrepared(ctx, providerId, logger) {
  const service = ctx.get('speechToText')
  if (service === undefined || service === null) throw new Error('speech service missing')
  const readPhase = () => {
    const snapshot = service.snapshot()
    const provider = (snapshot.providers ?? []).find((item) => String(item.id) === String(providerId))
      ?? (snapshot.providers ?? [])[0]
    return provider === undefined ? { phase: 'missing' } : { phase: provider.preparation?.phase ?? 'unprepared', download: provider.preparation?.download ?? null }
  }
  const current = readPhase()
  if (current.phase === 'ready' || current.phase === 'standby') return
  service.prepare(providerId)
  const deadline = Date.now() + PREPARE_TIMEOUT_MS
  let lastPhase = ''
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const state = readPhase()
    if (state.phase !== lastPhase) {
      logger?.info?.(`fish-reflection: speech preparation ${state.phase}${state.download ? ` (${state.download.completedBytes}/${state.download.totalBytes ?? '?'})` : ''}`)
      lastPhase = state.phase
    }
    if (state.phase === 'ready' || state.phase === 'standby') return
    if (state.phase === 'failed' || state.phase === 'cancelled') {
      throw new Error(`speech preparation ${state.phase}: ${state.download?.reason ?? 'unknown'}`)
    }
  }
  throw new Error('speech preparation timed out')
}

const MAX_CHUNK_BYTES = 3 * 1024 * 1024
const OVERLAP_BYTES = 32000

/** Build one canonical 16 kHz mono PCM16 WAV header for a body of `dataLength` bytes. */
function wavHeaderFor(dataLength) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataLength, 40)
  return header
}

/**
 * Split a canonical WAV into provider-sized pieces with one second of overlap,
 * because the recognizer's default `maxAudioBytes` is 4 MiB per request.
 */
export function splitWav(wav, maxBytes = MAX_CHUNK_BYTES) {
  if (wav.length <= 44) return []
  const cap = Math.max(32000, maxBytes - (maxBytes % 2))
  if (wav.length <= cap) return [wav]
  const body = wav.subarray(44)
  const step = Math.max(32000, cap - OVERLAP_BYTES)
  const chunks = []
  for (let offset = 0; offset < body.length; offset += step) {
    const end = Math.min(body.length, offset + cap)
    const slice = body.subarray(offset, end)
    chunks.push(Buffer.concat([wavHeaderFor(slice.length), slice]))
    if (end >= body.length) break
  }
  return chunks
}

/** Transcribe one WAV buffer with the selected provider, chunking when needed. */
export async function transcribeWav(ctx, wav, options, logger) {
  const service = ctx.get('speechToText')
  if (service === undefined || service === null) throw new Error('speech service missing')
  const snapshot = service.snapshot()
  const providerId = snapshot.selection?.providerId ?? snapshot.providers?.[0]?.id
  if (providerId === undefined) throw new Error('no speech provider registered')
  await ensurePrepared(ctx, providerId, logger)
  const language = typeof options.asrLanguage === 'string' && options.asrLanguage !== '' ? options.asrLanguage : 'auto'
  const chunks = splitWav(wav)
  if (chunks.length === 0) throw new Error('empty audio')
  const texts = []
  let audioSeconds = 0
  const deadline = Date.now() + TOTAL_TRANSCRIBE_BUDGET_MS
  for (const chunk of chunks) {
    const budget = deadline - Date.now()
    if (budget <= 5000) {
      logger?.warn?.(`fish-reflection: asr budget exhausted after ${texts.length}/${chunks.length} chunks`)
      break
    }
    const spec = service.resolve({ audio: new Uint8Array(chunk), language })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(TRANSCRIBE_TIMEOUT_MS, budget))
    try {
      const transcript = await service.transcribe(spec, controller.signal)
      const text = String(transcript?.text ?? '').trim()
      if (text !== '') texts.push(text)
      audioSeconds += Number(transcript?.audioSeconds ?? 0)
    } finally {
      clearTimeout(timer)
    }
  }
  return { text: texts.join('\n').trim(), audioSeconds, chunks: chunks.length }
}

/** Download, transcode and transcribe one video; returns `null` when unusable. */
export async function transcribeVideo(ctx, info, options, logger) {
  let bytes
  if (info.media && Array.isArray(info.media.urls) && info.media.urls.length > 0) {
    bytes = await downloadFirst(info.media.urls, options, info.media.headers ?? null)
  } else {
    const downloaded = await downloadAudio(info.bvid, info.cid, options)
    if (downloaded === null) return null
    bytes = downloaded.bytes
  }
  const maxSeconds = Number.isFinite(Number(options.asrMaxSeconds)) && Number(options.asrMaxSeconds) > 0
    ? Number(options.asrMaxSeconds)
    : 600
  const wav = await toWav16k(bytes, options.ffmpegPath, maxSeconds)
  const transcript = await transcribeWav(ctx, wav, options, logger)
  const text = String(transcript?.text ?? '').trim()
  return text === '' ? null : text
}

/**
 * Full diagnostic: resolve the audio stream, download it, transcode it, and run
 * one transcription. Returns every stage so a failure is attributable.
 */
export async function testAsr(ctx, options, request = {}) {
  const bvid = typeof request.bvid === 'string' && request.bvid !== '' ? request.bvid : 'BV1GJ411x7h7'
  let cid = request.cid ?? null
  const report = { bvid, cid: cid ?? null, stages: [], ok: false, transcript: '' }
  const stage = (name, outcome) => report.stages.push({ name, ...outcome })
  try {
    if (cid === null) {
      const { getVideoInfo } = await import('./bilibili.js')
      const info = await getVideoInfo(bvid, options)
      cid = info.cid
      report.cid = cid
      report.title = info.title
      stage('video-info', { ok: true })
    }
    const stream = await resolveAudioStream(bvid, cid, options)
    stage('playurl', stream === null ? { ok: false, error: 'no audio stream' } : { ok: true, urls: stream.urls.length, durationMs: stream.durationMs })
    if (stream === null) return report
    let downloaded = null
    try {
      downloaded = await downloadAudio(bvid, cid, options)
      stage('download', downloaded === null ? { ok: false, error: 'no stream' } : { ok: true, bytes: downloaded.bytes.length })
    } catch (error) {
      stage('download', { ok: false, error: String(error.message ?? error) })
      return report
    }
    if (downloaded === null) return report
    let wav = null
    try {
      wav = await toWav16k(downloaded.bytes, options.ffmpegPath, Number(options.asrMaxSeconds) || 600)
      stage('transcode', { ok: true, bytes: wav.length })
    } catch (error) {
      stage('transcode', { ok: false, error: String(error.message ?? error) })
      return report
    }
    try {
      const transcript = await transcribeWav(ctx, wav, options, ctx.logger)
      report.transcript = String(transcript?.text ?? '').slice(0, 2000)
      stage('transcribe', { ok: report.transcript !== '', chars: report.transcript.length, audioSeconds: transcript?.audioSeconds ?? null })
      report.ok = report.transcript !== ''
    } catch (error) {
      stage('transcribe', { ok: false, error: String(error.message ?? error) })
    }
    return report
  } catch (error) {
    stage('error', { ok: false, error: String(error.message ?? error) })
    return report
  }
}
