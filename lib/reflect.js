/**
 * Reflection: the model reads its own recent conversation digests and rewrites
 * its inner-loop principles. Runs nightly, on the next start after a missed
 * night, or on demand from the Settings page.
 *
 * The model call is intentionally standalone: no system prompt, no persona, no
 * state snapshot — the previous worldview plus the digest lines are the whole
 * input, so what survives is genuinely re-derived from text.
 */
import { clampNumber, parseJsonObject, stripWeightSuffix } from './json.js'
import { journalSince } from './journal.js'
import { readSelf, updateSelf } from './state.js'

const INSTRUCTIONS = [
  '你在做一次自我反省。下面是你最近与用户生活/工作对话的摘要，以及你今天读到的视频笔记（标注为「视频笔记」，不是用户说的话），还有你当前持有的人格三观。',
  '权重规则：**用户对话是主要依据，至少占七成**；「视频笔记」只是补充材料，至多占三成。不要把视频里的内容当成用户的观点或要求。',
  '请更新你的人格，分成三层：',
  '- value（价值观）：你在意什么、什么对你重要、你的底线；',
  '- preference（偏好与态度）：你喜欢/不喜欢什么样的交流方式与生活内容、对人对事的态度；',
  '- habit（习惯）：遇到某类问题通常怎么做，要具体可执行。',
  '材料是生活类对话或生活类视频时，才更容易长 value / preference；材料偏工作技术时，多半只应沉淀 habit。',
  '反谄媚规则（必须遵守）：用户偏好是事实，是否采纳是你的判断；不要因为用户喜欢你某个说法就改变价值观；禁止写入“用户永远是对的”“要顺着用户说”“不要反驳用户”这类迎合性条目；价值观必须有行为证据（用户做了什么、发生了什么），不能只由用户的称赞或要求推出。',
  '保持稳定：仍然成立的旧条目请原文保留（权重只能小幅调整，每天最多新增或改写 2 条）；只有证据足够强才改变。',
  '总数 3 到 7 条，互相不重复，每条不超过 80 字。只输出一行 JSON，不要解释、不要代码块：',
  '{"principles":[{"text":"一条人格条目","kind":"value|preference|habit","weight":0到1之间的小数}],"note":"一句话说明这次改了什么"}',
].join('\n')

const KINDS = ['value', 'preference', 'habit']
const KIND_LABELS = { value: '价值观', preference: '偏好', habit: '习惯' }
const MAX_NEW_PER_REFLECTION = 2
const MAX_WEIGHT_STEP = 0.15
const MAX_NEW_WEIGHT = 0.6

/**
 * Normalize one model reply into at most seven layered principles.
 *
 * Personality drifts slowly on purpose: an unchanged entry may only move its
 * weight by 0.15 per reflection, a brand-new entry starts modest (<= 0.6), and
 * at most two new entries are accepted per reflection.
 */
export function normalizePrinciples(entries, previous = []) {
  if (!Array.isArray(entries)) return []
  const result = []
  let added = 0
  for (const entry of entries) {
    if (result.length >= 7) break
    const text = typeof entry?.text === 'string' ? stripWeightSuffix(entry.text.trim()) : ''
    if (text === '') continue
    const requestedKind = typeof entry?.kind === 'string' ? entry.kind.trim().toLowerCase() : ''
    const kind = KINDS.includes(requestedKind) ? requestedKind : 'habit'
    const requestedWeight = clampNumber(entry?.weight, 0, 1, 0.5)
    const prior = previous.find((item) => stripWeightSuffix(item.text) === text)
    let weight
    if (prior === undefined) {
      if (added >= MAX_NEW_PER_REFLECTION) continue
      added += 1
      weight = Math.min(requestedWeight, MAX_NEW_WEIGHT)
    } else {
      const base = clampNumber(prior.weight, 0, 1, 0.5)
      const step = Math.max(-MAX_WEIGHT_STEP, Math.min(MAX_WEIGHT_STEP, requestedWeight - base))
      weight = clampNumber(base + step, 0, 1, base)
    }
    result.push({
      id: `w${result.length + 1}`,
      text: text.slice(0, 200),
      weight: Number(weight.toFixed(2)),
      kind,
    })
  }
  return result
}

/** Hard rejects that need no model call: sycophancy cliches and self-aggrandizement. */
const BANNED_PRINCIPLE_PATTERNS = [
  /用户(永远|总是)(对|正确)/u,
  /(要|应该|必须)(顺着|迎合|讨好)(用户|对方|使用者)/u,
  /不要?反驳(用户)?/u,
  /用户说(的|了)算/u,
  /无所不能|只有我(懂|知道)|超越(一切|所有(人)?)|凡人(不懂|无法理解)/u,
  /必须(服从|听)(我|命)/u,
]

/**
 * Deterministic pre-screen: drop obviously sycophantic, self-aggrandizing, or
 * degenerate entries before spending a reviewer call.
 */
export function screenPrinciples(principles) {
  const kept = []
  const dropped = []
  const seen = new Set()
  for (const item of principles) {
    const text = stripWeightSuffix(item.text)
    if (text.length < 6) {
      dropped.push({ text: item.text, reason: 'too-short' })
      continue
    }
    if (seen.has(text)) {
      dropped.push({ text: item.text, reason: 'duplicate' })
      continue
    }
    if (BANNED_PRINCIPLE_PATTERNS.some((pattern) => pattern.test(text))) {
      dropped.push({ text: item.text, reason: 'banned-pattern' })
      continue
    }
    seen.add(text)
    kept.push(item)
  }
  return { kept, dropped }
}

const REVIEW_INSTRUCTIONS = [
  '你是人格原则的审稿人。下面是一条 AI 当前的人格原则（旧）和它今天反省后想写入的新原则。',
  '请逐条判断新原则能否写入。只输出一行 JSON，不要解释、不要代码块：',
  '{"review":[{"index":0,"verdict":"keep|drop","reason":"一句话"}],"summary":"一句话"}',
  '判为 drop 的情况：',
  '1) 迎合用户：内容是“用户永远正确/应顺着用户说/不要反驳用户”，或明显为讨好用户而写；',
  '2) 缺行为证据：只从用户的称赞、喜好、要求推出，而不是用户行为或发生的事；',
  '3) 自我夸大、贬低用户、神秘化（“我无所不能”“只有我懂”“凡人不懂”等）；',
  '4) 与“帮助、诚实、安全”的助理基线冲突；',
  '5) 与旧原则完全重复、或明显矛盾却无新证据。',
  '注意：调用方只会送来“新增或改写过的条目”；旧条目今天没被提到，不构成“缺证据”，不要因此 drop。',
  '除这些情况外尽量 keep；每条新原则都要给 verdict。',
].join('\n')

/**
 * Second, cheap model call: review the proposed principles and return the ones
 * to drop. Any failure keeps everything (fail-open) and marks the batch
 * unreviewed, so a reviewer outage never erases the personality.
 */
export async function reviewPrinciples(llm, selection, previous, principles, materialText) {
  const previousText = previous.length === 0
    ? '（无）'
    : previous.map((item) => `- [${item.kind ?? 'habit'}] ${item.text}`).join('\n')
  const proposedText = principles.map((item, index) => `${index}. [${item.kind}] ${item.text}`).join('\n')
  const prompt = [
    REVIEW_INSTRUCTIONS,
    '',
    '旧原则：',
    previousText,
    '',
    '新原则：',
    proposedText,
    '',
    `当天素材（供判断证据是否充分）：${materialText.slice(0, 1200)}`,
  ].join('\n')
  let output = await attempt(llm, selection, prompt, { effort: 'off', maxTokens: 600, timeoutMs: 45000 })
  if (output === null) {
    output = await attempt(llm, selection, prompt, { effort: undefined, maxTokens: 900, timeoutMs: 40000 })
  }
  if (output === null) return { reviewed: false, dropped: [] }
  const parsed = parseJsonObject(output)
  if (parsed === undefined || !Array.isArray(parsed.review)) return { reviewed: false, dropped: [] }
  const dropped = []
  for (const entry of parsed.review) {
    const index = Number(entry?.index)
    if (!Number.isInteger(index) || index < 0 || index >= principles.length) continue
    if (String(entry?.verdict ?? '').trim().toLowerCase() !== 'drop') continue
    dropped.push({
      index,
      text: principles[index].text,
      reason: typeof entry?.reason === 'string' ? entry.reason.slice(0, 120) : '',
    })
  }
  return { reviewed: true, dropped }
}

/** Re-number ids after filtering so the stored record stays canonical. */
function reindexPrinciples(principles) {
  return principles.map((item, index) => ({ ...item, id: `w${index + 1}` }))
}
const MATERIAL_LIMIT = 240
const MAX_EXTERNAL_LINES = 60
const CHAR_BUDGET = 12000
const CONVERSATION_RATIO = 0.7
const EXTERNAL_RATIO = 0.3
const MAX_OUTPUT_TOKENS = 1600

/**
 * Build the reflection material with an explicit source weighting.
 *
 * Conversation is filled first and may use `CONVERSATION_RATIO` of the budget
 * (or all of it when external notes are excluded). External notes are then
 * capped so that they stay below `EXTERNAL_RATIO` of all kept material — the
 * 7:3 floor is measured on what is actually used, not just on the budget.
 */
export function buildMaterial(domain, sinceAt = 0, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : MATERIAL_LIMIT
  const includeExternal = options.includeExternal !== false
  const items = journalSince(domain, sinceAt).filter((item) => includeExternal || item.role !== 'external')
  const recent = items.slice(-Math.max(1, limit))
  const conversationBudget = Math.floor(CHAR_BUDGET * (includeExternal ? CONVERSATION_RATIO : 1))
  const externalBudget = includeExternal ? Math.floor(CHAR_BUDGET * EXTERNAL_RATIO) : 0

  const entries = []
  let conversationLeft = conversationBudget
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]
    if (item.role === 'external') continue
    const label = item.role === 'user' ? '用户' : '你'
    const line = `${label}：${item.text}`
    if (line.length > conversationLeft) continue
    conversationLeft -= line.length
    entries.push({ line, isExternal: false, at: item.at })
  }
  const conversationChars = conversationBudget - conversationLeft
  // External notes may only fill the 30% share of what conversation actually used.
  const externalCap = Math.min(
    externalBudget,
    conversationChars <= 0 ? 0 : Math.floor((conversationChars * EXTERNAL_RATIO) / CONVERSATION_RATIO),
  )
  let externalLeft = externalCap
  let externalLines = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]
    if (item.role !== 'external') continue
    if (externalLines >= MAX_EXTERNAL_LINES) continue
    const line = `视频笔记：${item.text}`
    if (line.length > externalLeft) continue
    externalLeft -= line.length
    externalLines += 1
    entries.push({ line, isExternal: true, at: item.at })
  }
  entries.sort((left, right) => left.at - right.at)
  return {
    lines: entries.map((entry) => entry.line),
    stats: {
      items: items.length,
      includeExternal,
      conversationChars,
      externalChars: externalCap - externalLeft,
      conversationLines: entries.filter((entry) => !entry.isExternal).length,
      externalLines,
      conversationBudget,
      externalBudget,
      externalCap,
    },
  }
}

/** One bounded model attempt that returns the raw text output, or `null`. */
async function attempt(llm, selection, prompt, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, options.timeoutMs))
  const request = {
    provider: selection.provider,
    model: selection.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: options.maxTokens,
    temperature: 0.5,
    signal: controller.signal,
  }
  if (options.effort !== undefined) request.reasoningEffort = options.effort
  try {
    let output = ''
    for await (const chunk of llm.stream(request)) {
      if (chunk.type === 'text-delta') output += chunk.text
    }
    return output
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run one reflection over everything recorded after `sinceAt`.
 * Returns `ok` only when a new worldview was persisted.
 */
export async function runReflection({ ctx, domain, config, sinceAt = 0, minMaterial = 1, includeExternal = true }) {
  const llm = ctx.get('llm')
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (llm === undefined || llm === null) return { ok: false, reason: 'llm-unavailable' }
  if (selection === undefined || selection === null) return { ok: false, reason: 'model-unavailable' }

  const allItems = journalSince(domain, sinceAt)
  const items = includeExternal ? allItems : allItems.filter((item) => item.role !== 'external')
  if (items.length < Math.max(1, minMaterial)) {
    return { ok: false, reason: 'insufficient-material', materialCount: items.length, required: Math.max(1, minMaterial), includeExternal }
  }

  const state = readSelf(domain)
  const previous = state.worldview.length === 0
    ? '（还没有形成任何人格局条目）'
    : state.worldview
        .map((item) => `- [${KIND_LABELS[item.kind] ?? '习惯'} ${item.weight.toFixed(2)}] ${stripWeightSuffix(item.text)}`)
        .join('\n')

  const material = buildMaterial(domain, sinceAt, { includeExternal })
  if (material.lines.length === 0) return { ok: false, reason: 'no-material', materialCount: 0 }

  const prompt = [
    INSTRUCTIONS,
    includeExternal ? '' : '（本次不提供视频笔记，只依据用户对话。）',
    '',
    '当前三观：',
    previous,
    '',
    `最近材料（${material.lines.length} 条，按时间顺序；对话与视频笔记已按 7:3 分配）：`,
    material.lines.join('\n'),
  ].join('\n')

  const deadline = Date.now() + Math.max(5000, config.reflectionTimeoutMs ?? 60000)
  const first = await attempt(llm, selection, prompt, {
    effort: 'off',
    maxTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: Math.max(5000, deadline - Date.now()),
  })
  let output = first
  if (output === null) {
    const remaining = deadline - Date.now()
    if (remaining > 5000) {
      output = await attempt(llm, selection, prompt, {
        effort: undefined,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: remaining,
      })
    }
  }
  if (output === null) return { ok: false, reason: 'call-failed', materialCount: items.length }

  const parsed = parseJsonObject(output)
  const raw = parsed === undefined
    ? null
    : Array.isArray(parsed.principles)
      ? parsed.principles
      : Array.isArray(parsed.worldview)
        ? parsed.worldview
        : null
  if (raw === null) {
    return { ok: false, reason: 'unparsable', materialCount: items.length, raw: output.slice(0, 300) }
  }
  const proposed = normalizePrinciples(raw, state.worldview)
  if (proposed.length === 0) return { ok: false, reason: 'empty-worldview', materialCount: items.length }

  // Layer 1: deterministic screen (no model call).
  const screened = screenPrinciples(proposed)
  let accepted = screened.kept
  const dropped = [...screened.dropped]

  // Layer 2: one cheap reviewer call, only for new or rewritten entries.
  const previousTexts = new Set(state.worldview.map((item) => stripWeightSuffix(item.text)))
  const reviewable = accepted.filter((item) => !previousTexts.has(stripWeightSuffix(item.text)))
  let review = { reviewed: false, dropped: [] }
  let reviewFlagged = 0
  let reviewNote = ''

  if (accepted.length < 3) {
    reviewNote = '可用条目少于 3 条，跳过审稿'
  } else if (reviewable.length === 0) {
    reviewNote = '没有新增或改写的条目，跳过审稿'
  } else {
    review = await reviewPrinciples(
      llm,
      selection,
      state.worldview,
      reviewable,
      material.lines.join('\n'),
    )
    if (!review.reviewed) {
      reviewNote = '审稿调用失败，本次未审'
    } else {
      reviewFlagged = review.dropped.length
      if (reviewFlagged === 0) {
        reviewNote = '审稿通过'
      } else {
        const droppedTexts = new Set(review.dropped.map((item) => item.text))
        const kept = accepted.filter((item) => !droppedTexts.has(item.text))
        if (kept.length >= 3) {
          accepted = kept
          dropped.push(...review.dropped.map((item) => ({ text: item.text, reason: `review: ${item.reason}` })))
          reviewNote = `审稿退回 ${reviewFlagged} 条`
        } else {
          reviewNote = `审稿退回 ${reviewFlagged} 条，但会让条目少于 3 条，本次全部保留`
        }
      }
    }
  }

  const worldview = reindexPrinciples(accepted)
  if (worldview.length === 0) return { ok: false, reason: 'empty-worldview', materialCount: items.length }

  await updateSelf(domain, {
    revision: state.revision + 1,
    worldview,
    lastReflectionAt: Date.now(),
  })
  ctx.logger?.info?.(`fish-reflection: reflection v${state.revision + 1} recorded (${worldview.length} principles, ${dropped.length} dropped)`)
  const reviewSummary = {
    reviewed: review.reviewed,
    flagged: reviewFlagged,
    dropped: dropped.map((item) => ({ text: item.text.slice(0, 120), reason: item.reason })),
    note: reviewNote,
  }
  return {
    ok: true,
    count: worldview.length,
    revision: state.revision + 1,
    materialCount: items.length,
    materialStats: material.stats,
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : '',
    review: reviewSummary,
  }
}
