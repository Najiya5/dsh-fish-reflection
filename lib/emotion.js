/**
 * Spirit and health: one synchronous, bounded judgement per enabled turn.
 * A slow or failing model call never blocks the turn — it falls back to the
 * previously recorded state.
 */
import { clampNumber, parseJsonObject } from './json.js'
import { initialState } from './state.js'

const PROMPT = [
  '你是一个情绪分析器。只根据用户这句话，评估用户的情绪状态。',
  '只输出一行 JSON，不要解释、不要代码块：',
  '{"mood":"2到4个中文字符概括的情绪","energy":0到5的整数,"stress":0到5的整数}',
  '',
  '用户这句话：',
].join('\n')

/** One bounded model attempt; returns the normalized reading or `null`. */
async function attempt(ctx, llm, selection, text, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, options.timeoutMs))
  const request = {
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${PROMPT}${String(text).slice(0, 2000)}` }] }],
    maxTokens: options.maxTokens,
    temperature: 0,
    signal: controller.signal,
  }
  if (options.effort !== undefined) request.reasoningEffort = options.effort
  try {
    let output = ''
    for await (const chunk of llm.stream(request)) {
      if (chunk.type === 'text-delta') output += chunk.text
    }
    return normalizeEmotion(parseJsonObject(output))
  } catch (error) {
    ctx.logger?.debug?.(`fish-reflection: emotion attempt failed: ${String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the default model for one emotion reading, bounded by `timeoutMs`.
 *
 * The default selection may be a reasoning model; a reasoning answer would eat
 * the whole budget before any text appears, so the first attempt asks for the
 * adapter's `off` effort (a short, cheap reading). Models without that effort
 * reject it up front, and the second attempt uses the adapter default.
 */
export async function judgeEmotion(ctx, text, timeoutMs = 3000) {
  const llm = ctx.get('llm')
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (llm === undefined || llm === null || selection === undefined || selection === null) return null
  if (typeof text !== 'string' || text.trim() === '') return null

  const deadline = Date.now() + Math.max(1000, timeoutMs)
  const first = await attempt(ctx, llm, selection, text, {
    effort: 'off',
    maxTokens: 200,
    timeoutMs: Math.max(500, deadline - Date.now()),
  })
  if (first !== null) return first
  const remaining = deadline - Date.now()
  if (remaining < 500) return null
  return attempt(ctx, llm, selection, text, {
    effort: undefined,
    maxTokens: 800,
    timeoutMs: remaining,
  })
}

/** Diagnostic twin of {@link judgeEmotion}: report every stage instead of degrading silently. */
export async function diagnoseEmotion(ctx, text, timeoutMs = 8000, options = {}) {
  const info = {
    hasLlm: false,
    selection: null,
    modelInfo: null,
    modelInfoError: null,
    models: [],
    modelsError: null,
    requested: { effort: options.effort ?? null, maxTokens: options.maxTokens ?? 120 },
    chunks: [],
    output: '',
    finish: null,
    error: null,
  }
  const llm = ctx.get('llm')
  info.hasLlm = llm !== undefined && llm !== null
  try {
    info.selection = ctx.get('agentDefaultModel')?.currentSelection() ?? null
  } catch (error) {
    info.error = `selection: ${String(error)}`
    return info
  }
  if (!info.hasLlm || info.selection === null) return info
  try {
    info.modelInfo = await llm.resolveModelInfo(info.selection.provider, info.selection.model)
  } catch (error) {
    info.modelInfoError = String(error)
  }
  try {
    info.models = (await llm.listModels(info.selection.provider)).map((model) => model.id)
  } catch (error) {
    info.modelsError = String(error)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
  const request = {
    provider: info.selection.provider,
    model: info.selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${PROMPT}${String(text).slice(0, 2000)}` }] }],
    maxTokens: Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 120,
    temperature: 0,
    signal: controller.signal,
  }
  if (typeof options.effort === 'string' && options.effort !== '') request.reasoningEffort = options.effort
  try {
    for await (const chunk of llm.stream(request)) {
      info.chunks.push(chunk.type)
      if (chunk.type === 'text-delta') info.output += chunk.text
      if (chunk.type === 'finish') info.finish = chunk.reason ?? null
    }
  } catch (error) {
    info.error = String(error)
  } finally {
    clearTimeout(timer)
  }
  info.normalized = normalizeEmotion(parseJsonObject(info.output))
  info.chunkCounts = info.chunks.reduce((counts, type) => {
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})
  info.chunks = info.chunks.slice(0, 3)
  return info
}

function normalizeEmotion(value) {
  if (value === undefined) return null
  const mood = typeof value.mood === 'string' && value.mood.trim() !== '' ? value.mood.trim().slice(0, 12) : '平静'
  return {
    mood,
    energy: Math.round(clampNumber(value.energy, 0, 5, 3)),
    stress: Math.round(clampNumber(value.stress, 0, 5, 2)),
  }
}

/**
 * Fold one reading into the durable state: spirit changes immediately, health
 * follows as a slow rolling average with a recorded trend.
 */
export async function applyEmotion(domain, emotion) {
  return domain.table('self').update('state', (current) => {
    const base = current ?? initialState()
    const spirit = { ...base.spirit, ...emotion, at: Date.now() }
    const previousHealth = base.health?.score ?? 60
    const target = clampNumber(emotion.energy * 18 - emotion.stress * 3 + 10, 0, 100, previousHealth)
    const score = Math.round(previousHealth * 0.88 + target * 0.12)
    const health = { score, trend: Math.round(score - previousHealth), at: Date.now() }
    return { ...base, spirit, health, updatedAt: Date.now() }
  })
}
