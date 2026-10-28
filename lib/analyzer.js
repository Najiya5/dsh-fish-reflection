/**
 * External video analyzer: an OpenAI-compatible multimodal chat endpoint.
 * The plugin still extracts frames locally (and ASR transcript when possible),
 * then asks the configured API to turn them into a reading note.
 *
 * UI notes: the endpoint must support multimodal image input AND speech-to-text
 * if the provider is expected to handle audio itself; this adapter always sends
 * frames plus the local transcript as text.
 */
const TIMEOUT_MS = 120000

export function analyzerConfig(options) {
  const source = options ?? {}
  return {
    baseUrl: typeof source.analyzerBaseUrl === 'string' ? source.analyzerBaseUrl.trim().replace(/\/+$/, '') : '',
    apiKey: typeof source.analyzerApiKey === 'string' ? source.analyzerApiKey.trim() : '',
    model: typeof source.analyzerModel === 'string' ? source.analyzerModel.trim() : '',
  }
}

export function analyzerConfigured(options) {
  const conf = analyzerConfig(options)
  return conf.baseUrl !== '' && conf.model !== ''
}

function buildPrompt(info, material) {
  return [
    `请分析这个视频并写一条 10–15 行中文笔记。标题：《${info.title}》，作者：${info.owner || '未知'}，时长约 ${Math.round(info.duration || 0)} 秒。`,
    '材料包括：若干画面帧（图片）、一段语音转写文本、以及可能的简介/评论。',
    '请输出：1) 视频在讲什么；2) 核心观点或信息 3–6 条；3) 值得记住的一句话。',
    '只输出笔记本身，不要客套、不要复述原文。',
    '以下是已知文本材料：',
    material.slice(0, 8000),
  ].join('\n')
}

/** Call the configured API; returns the note text or `null` when it fails. */
export async function analyzeWithApi({ info, material, images, options, logger }) {
  const conf = analyzerConfig(options)
  if (!analyzerConfigured(options)) return null
  const content = [{ type: 'text', text: buildPrompt(info, material) }]
  for (const image of images.slice(0, 8)) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.data}` } })
  }
  const body = {
    model: conf.model,
    messages: [
      { role: 'system', content: '你是一个严谨的视频内容分析器，只依据给定画面与文本作答。' },
      { role: 'user', content },
    ],
    temperature: 0.3,
    max_tokens: 1200,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${conf.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(conf.apiKey !== '' ? { authorization: `Bearer ${conf.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${detail.slice(0, 160)}`)
    }
    const data = await response.json()
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    return text === '' ? null : text.slice(0, 1600)
  } catch (error) {
    logger?.warn?.(`fish-reflection: analyzer API failed: ${String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Diagnostic: verify endpoint/model reachability with a tiny image request. */
export async function testAnalyzer(options) {
  const conf = analyzerConfig(options)
  const report = {
    configured: analyzerConfigured(options),
    baseUrl: conf.baseUrl,
    model: conf.model,
    hasKey: conf.apiKey !== '',
    ok: false,
    error: null,
  }
  if (!report.configured) return report
  // 16x16 blue PNG: some providers (e.g. Ark) reject images below 14 px.
  const pixels = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGNkYPjHQApgIUk1w6gG4gALkergYFQDMYDkUAIAaRMBPMpWW/QAAAAASUVORK5CYII='
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(`${conf.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(conf.apiKey !== '' ? { authorization: `Bearer ${conf.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: conf.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '只回复 ok' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pixels}` } },
        ] }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    })
    report.httpStatus = response.status
    report.ok = response.ok
    if (!response.ok) report.error = (await response.text().catch(() => '')).slice(0, 200)
  } catch (error) {
    report.error = String(error?.message ?? error)
  } finally {
    clearTimeout(timer)
  }
  return report
}
