/**
 * External intake: read one video (Bilibili or a Douyin share link) as text +
 * frames, compress it into a short note, and file that note into the same
 * journal the nightly reflection reads.
 *
 * Content priority: subtitles (what was said) → local ASR → description/comments,
 * plus frame descriptions or a configured external multimodal analyzer.
 */
import { getSubtitleText, getTopComments, getVideoInfo, listCandidates } from './bilibili.js'
import { resolveDouyin } from './douyin.js'
import { transcribeVideo } from './asr.js'
import { describeVideo, extractVideoFrames } from './vision.js'
import { analyzeWithApi, analyzerConfigured } from './analyzer.js'
import { dateKey } from './clock.js'
import { appendJournal } from './journal.js'

const SUBTITLE_BUDGET = 12000
const COMMENT_COUNT = 12
const NOTE_CHAR_LIMIT = 1200
const EXTERNAL_ROLE = 'external'

/** Ask the default model for a compact reading note; `null` when it fails. */
async function summarize(ctx, title, material, timeoutMs = 60000) {
  const llm = ctx.get('llm')
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (llm === undefined || llm === null || selection === undefined || selection === null) return null
  const prompt = [
    `你在为未来的自己记一条阅读笔记。视频标题：《${title}》。`,
    '以下是这个视频的文本内容（字幕/语音转写优先，另有画面描述与简介评论）：',
    material,
    '',
    '请用 10–15 行中文写下：1) 这个视频在讲什么；2) 核心观点或信息 3–6 条；3) 值得记住的一句话。',
    '只输出笔记本身，不要客套、不要复述原文。',
  ].join('\n')

  const runAttempt = async (effort, maxTokens, budget) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(5000, budget))
    const request = {
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature: 0.4,
      signal: controller.signal,
    }
    if (effort !== undefined) request.reasoningEffort = effort
    try {
      let output = ''
      for await (const chunk of llm.stream(request)) {
        if (chunk.type === 'text-delta') output += chunk.text
      }
      const text = output.trim()
      return text === '' ? null : text
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const deadline = Date.now() + timeoutMs
  const first = await runAttempt('off', 900, Math.max(5000, deadline - Date.now()))
  if (first !== null) return first
  const remaining = deadline - Date.now()
  if (remaining < 5000) return null
  return runAttempt(undefined, 1600, remaining)
}

/** How many external notes were filed today. */
export function countTodayExternal(domain) {
  const today = dateKey()
  let count = 0
  for (const [, item] of domain.table('journal').entries()) {
    if (item.role === EXTERNAL_ROLE && item.date === today) count += 1
  }
  return count
}

/** Most recent external notes, newest first (for the Settings page). */
export function recentExternal(domain, limit = 5) {
  const items = []
  for (const [, item] of domain.table('journal').entries()) {
    if (item.role === EXTERNAL_ROLE) items.push(item)
  }
  items.sort((left, right) => right.at - left.at)
  return items.slice(0, Math.max(1, limit)).map((item) => ({
    at: item.at,
    bvid: item.sessionId.startsWith('bilibili:') ? item.sessionId.slice('bilibili:'.length) : '',
    text: item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text,
  }))
}

/** Read one video and file the note; `bvid` forces a specific video, `link` a Douyin share link. */
export async function runIntake({ ctx, domain, options, seen, saveSeen, bvid = null, link = null, onStage = null }) {
  const stage = (name) => {
    try {
      onStage?.(name)
    } catch {
      /* diagnostics must never break the pipeline */
    }
  }
  stage('start')
  const state = { bvids: [...seen.bvids], lastAttemptAt: Date.now() }
  const commit = (extra) => {
    state.lastAttemptAt = Date.now()
    const saved = saveSeen(state)
    return { ...extra, seenCount: saved.bvids.length }
  }

  let target = bvid
  let listSource = 'explicit'
  let category = options.intakeCategory === 'life' ? 'life' : 'all'
  let durationRelaxed = false
  let candidates = 0
  if (target === null) {
    let listed
    stage('list-candidates')
    try {
      listed = await listCandidates(options, 40)
    } catch (error) {
      return commit({ ok: false, reason: 'popular-failed', detail: String(error.message ?? error) })
    }
    listSource = listed.source
    category = listed.category ?? category
    const unseen = listed.items.filter((item) => !state.bvids.includes(item.bvid))
    const maxDuration = options.intakeMaxDurationMinutes > 0 ? options.intakeMaxDurationMinutes * 60 : 0
    const withinDuration = maxDuration > 0
      ? unseen.filter((item) => !item.duration || item.duration <= maxDuration)
      : unseen
    candidates = unseen.length
    if (unseen.length === 0) return commit({ ok: false, reason: 'no-unseen-video', source: listSource, popular: listed.items.length })
    durationRelaxed = withinDuration.length === 0
    target = (withinDuration.length > 0 ? withinDuration[0] : unseen[0]).bvid
  }

  let info
  const startedAt = Date.now()
  const platform = link === null ? 'bilibili' : 'douyin'
  if (link !== null) {
    stage('douyin-resolve')
    try {
      info = await resolveDouyin(link, options)
    } catch (error) {
      return commit({ ok: false, reason: 'douyin-failed', detail: String(error.message ?? error) })
    }
  } else {
    stage('video-info')
    try {
      info = await getVideoInfo(target, options)
    } catch (error) {
      return commit({ ok: false, reason: 'video-failed', bvid: target, detail: String(error.message ?? error) })
    }
  }
  ctx.logger?.info?.(`fish-reflection: intake[${platform}] ${info.bvid} “${info.title}” duration=${info.duration}s list=${listSource}`)

  let source = platform === 'douyin' ? 'asr' : 'subtitle'
  let material = ''
  if (platform === 'bilibili') {
    try {
      stage('subtitle')
      const subtitle = await getSubtitleText(info.bvid, info.cid, options)
      if (subtitle !== null) {
        material = subtitle.length > SUBTITLE_BUDGET ? subtitle.slice(0, SUBTITLE_BUDGET) : subtitle
      }
    } catch {
      /* fall through to description and comments */
    }
  }

  if (material.trim() === '' && options.intakeUseAsr !== false) {
    source = 'asr'
    try {
      stage('asr')
      const transcript = await transcribeVideo(ctx, info, options, ctx.logger)
      if (transcript !== null) {
        material = transcript.length > SUBTITLE_BUDGET ? transcript.slice(0, SUBTITLE_BUDGET) : transcript
      }
    } catch (error) {
      ctx.logger?.warn?.(`fish-reflection: asr failed for ${info.bvid}: ${String(error)}`)
    }
  }

  if (material.trim() === '' && platform === 'bilibili') {
    source = 'comments'
    stage('comments')
    const parts = []
    if (info.desc.trim() !== '') parts.push(`视频简介：${info.desc.trim().slice(0, 600)}`)
    if (options.intakeReadComments !== false) {
      try {
        const comments = await getTopComments(info.aid, options, COMMENT_COUNT)
        if (comments.length > 0) parts.push(`热门评论：\n${comments.map((line) => `- ${line}`).join('\n')}`)
      } catch {
        /* description alone may still be enough */
      }
    }
    material = parts.join('\n\n')
  } else if (material.trim() === '' && platform === 'douyin') {
    material = `视频简介：${info.desc}`.trim()
    if (material.trim() !== '') source = 'comments'
  }

  const primaryText = material
  let visionText = null
  let apiNotes = null
  const useAnalyzer = analyzerConfigured(options)
  if (useAnalyzer) {
    // External analyzer: frames are still sampled locally, the API writes the note.
    stage('analyzer')
    try {
      const frames = await extractVideoFrames(info, options, ctx.logger)
      if (frames.images.length > 0) {
        apiNotes = await analyzeWithApi({
          info,
          material,
          images: frames.images,
          options,
          logger: ctx.logger,
        })
      }
    } catch (error) {
      ctx.logger?.warn?.(`fish-reflection: analyzer failed for ${info.bvid}: ${String(error)}`)
    }
  } else if (options.intakeUseVision !== false) {
    try {
      stage('vision')
      visionText = await describeVideo(ctx, info, options, ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`fish-reflection: vision failed for ${info.bvid}: ${String(error)}`)
    }
  }
  if (visionText !== null && visionText !== '') {
    if (material.trim() === '') {
      source = 'vision'
      material = visionText
    } else {
      material = `${material}\n\n${visionText}`
    }
  }
  ctx.logger?.info?.(`fish-reflection: intake material ready source=${source} vision=${visionText !== null} analyzer=${apiNotes !== null} chars=${material.length} after ${Date.now() - startedAt}ms`)

  const markSeen = () => {
    if (!state.bvids.includes(info.bvid)) state.bvids.push(info.bvid)
  }

  if (material.trim().length < 80 && apiNotes === null) {
    markSeen()
    return commit({ ok: false, reason: 'empty-content', bvid: info.bvid, title: info.title, source })
  }

  stage('summarize')
  const notes = apiNotes ?? await summarize(ctx, info.title, material)
  if (notes === null) {
    return commit({ ok: false, reason: 'summarize-failed', bvid: info.bvid, title: info.title, source })
  }

  const lane = platform === 'douyin'
    ? '[抖音]'
    : category === 'life' ? '[B站·生活]' : '[B站]'
  stage('journal')
  const text = `${lane}《${info.title}》（${platform === 'douyin' ? '作者' : 'UP'}：${info.owner || '未知'}）${notes}`.slice(0, NOTE_CHAR_LIMIT)
  await appendJournal(domain, {
    date: dateKey(),
    at: Date.now(),
    sessionId: `${platform === 'douyin' ? 'douyin' : 'bilibili'}:${info.bvid}`,
    role: EXTERNAL_ROLE,
    text,
  }, 400)
  markSeen()
  ctx.logger?.info?.(`fish-reflection: read ${info.bvid} (${source})`)
  return commit({
    ok: true,
    platform,
    bvid: info.bvid,
    title: info.title,
    owner: info.owner,
    durationSeconds: info.duration,
    listSource,
    category,
    durationRelaxed,
    candidates,
    heardPreview: primaryText.replace(/\s+/g, ' ').trim().slice(0, 400),
    visionPreview: visionText === null ? '' : visionText.slice(0, 400),
    source,
    vision: visionText !== null,
    analyzer: apiNotes !== null,
    materialChars: material.length,
    notes,
  })
}
