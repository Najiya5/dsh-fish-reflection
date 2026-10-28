/**
 * Human Loops — a persistent inner/outer state machine for one agent.
 *
 * Inner loop: a versioned set of self-authored principles (三观), rewritten by a
 * nightly reflection over the day's conversation digests.
 * Outer loops: spirit and health (from one synchronous emotion reading per
 * enabled turn) and finance (the account balance sampled every evening).
 *
 * The state reaches the model as one extra user-role message appended at the
 * end of each enabled step: append-only, so the reusable request prefix and its
 * KV Cache entries stay intact.
 *
 * Scope is session-level and closed by default: nothing is injected or judged
 * until the session id appears in `enabledSessions` (`*` enables all sessions,
 * for diagnostics). Delegated child sessions never participate.
 *
 * @module @local/dsh-fish-reflection
 */
import { dateKey, isMainSession, minutesOfDay, parseClock, previousDateKey, sessionEnabled } from './lib/clock.js'
import { registerRoutes } from './lib/api.js'
import { applyEmotion, diagnoseEmotion, judgeEmotion } from './lib/emotion.js'
import { balanceSummary, readBalance, recordBalance } from './lib/finance.js'
import { loadHostDeps } from './lib/hostdeps.js'
import { renderStateBlock } from './lib/inject.js'
import { stripWeightSuffix } from './lib/json.js'
import { appendRecord, lastSnapshot, readHistory } from './lib/history.js'
import { appendJournal, digestEvent } from './lib/journal.js'
import { runReflection } from './lib/reflect.js'
import { normalizeScope, readScopeFile, writeScopeFile } from './lib/scope.js'
import { hasBilibiliCookie, readOptions, writeOptions } from './lib/options.js'
import { analyzerConfigured, testAnalyzer } from './lib/analyzer.js'
import { exportAlbum } from './lib/export.js'
import { readSeen, writeSeen } from './lib/seen.js'
import { countTodayExternal, recentExternal, runIntake } from './lib/intake.js'
import { probe as probeBilibili } from './lib/bilibili.js'
import { asrStatus, testAsr } from './lib/asr.js'
import { ollamaStatus, testVision } from './lib/vision.js'
import { migrateLegacyLayout } from './lib/migrate.js'
import { createDomainSpec, initialState, readMeta, readSelf, writeMeta } from './lib/state.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'fish-reflection'

/** The durable domain facility must be present before this plugin can store state. */
export const inject = ['storageDomain']

/** Host modules: the bundle is linked, so these are imported from the host tree. */
const hostDeps = await loadHostDeps()

/** Schemastery validation for the profile patch's `config`; absent when the host tree is unreadable. */
export let Config
if (hostDeps.schemastery !== null) {
  Config = hostDeps.schemastery.object({
    /** Session ids this plugin participates in; `*` means every session. */
    enabledSessions: hostDeps.schemastery.array(hostDeps.schemastery.string()).default([]),
    /** Local `HH:mm` at which the evening balance sample and reflection become due. */
    settlementTime: hostDeps.schemastery.string().default('23:30'),
    /** Inject the state block once every N turns; 1 means every turn. */
    injectionIntervalTurns: hostDeps.schemastery.number().default(1),
    /** Upper bound for the synchronous emotion call, in milliseconds. */
    emotionTimeoutMs: hostDeps.schemastery.number().default(3000),
    /** Digest entries kept per day, as reflection material. */
    maxJournalPerDay: hostDeps.schemastery.number().default(400),
    /** Upper bound for the background reflection call, in milliseconds. */
    reflectionTimeoutMs: hostDeps.schemastery.number().default(60000),
  })
}

const SETTLEMENT_TICK_MS = 60_000
const REFLECTION_RETRY_MS = 5 * 60_000
/** Minimum distance between two automatic reflections (manual "立即反思" bypasses it). */
const AUTO_REFLECTION_MIN_GAP_MS = 4 * 60 * 60_000
/** Upper bound for one whole video-reading run, so a stalled CDN/model cannot wedge the loop. */
const INTAKE_TIMEOUT_MS = 10 * 60_000

/** Read the last user-authored text inside the turn being prepared. */
function lastUserText(session, turn) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event === null) break
    if (event.type === 'turn/start' && event.data?.turn === turn) break
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const content = Array.isArray(event.data?.content) ? event.data.content : []
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text !== '') return text
  }
  return null
}

/**
 * Register the durable state, the evening settlement, the per-turn emotion
 * reading, and the append-only state injection.
 */
export async function apply(ctx, config) {
  // Rename the earlier `humanloops` files before anything reads them.
  migrateLegacyLayout(ctx.logger)
  if (hostDeps.zod === null) {
    throw new Error('fish-reflection: cannot resolve the host zod runtime for the state domain')
  }
  const settings = {
    enabledSessions: [],
    settlementTime: '23:30',
    injectionIntervalTurns: 1,
    emotionTimeoutMs: 3000,
    maxJournalPerDay: 400,
    reflectionTimeoutMs: 60000,
    ...config,
  }
  const createUserMessage = hostDeps.createUserMessage

  const domain = await ctx.storageDomain.open(createDomainSpec(hostDeps.zod))
  ctx.effect(() => () => {
    void domain.close()
  })

  if (domain.table('self').get('state') === undefined) {
    await domain.table('self').put('state', initialState())
  }
  if (domain.table('meta').get('settlement') === undefined) {
    await domain.table('meta').put('settlement', { lastBalanceDate: null, lastReflectionDate: null, lastReflectionAt: null })
  }

  // Repair a past formatting echo: older reflections copied the weight marker
  // into the principle text, so strip it from records written before the fix.
  const storedSelf = domain.table('self').get('state')
  if (storedSelf !== undefined && Array.isArray(storedSelf.worldview)) {
    const cleaned = storedSelf.worldview.map((item) => ({
      ...item,
      text: stripWeightSuffix(item.text),
    }))
    if (cleaned.some((item, index) => item.text !== storedSelf.worldview[index].text)) {
      await domain.table('self').put('state', { ...storedSelf, worldview: cleaned, updatedAt: Date.now() })
      ctx.logger?.info?.('fish-reflection: cleaned weight suffixes from stored worldview')
    }
  }

  let settling = false
  let lastReflectionAttempt = 0

  /**
   * Session scope: the Settings page's saved choice wins; the profile patch's
   * `enabledSessions` only seeds a fresh install.
   */
  let scope = readScopeFile() ?? normalizeScope(settings.enabledSessions)
  const getScope = () => [...scope]
  const setScope = (value) => {
    scope = writeScopeFile(value)
    ctx.logger?.info?.(`fish-reflection: scope saved (${scope.length} session(s) enabled)`)
    return [...scope]
  }
  const scopeEnabled = (sessionId) => sessionEnabled({ enabledSessions: scope }, sessionId)

  /** Runtime preferences written by the Settings page. */
  let options = readOptions(ctx.logger)
  const getOptions = () => ({
    ...options,
    // Never return raw secrets to the browser; only whether they are stored.
    bilibiliCookie: { set: hasBilibiliCookie(options) },
    douyinCookie: { set: (options.douyinCookie ?? '') !== '' },
    analyzerApiKey: { set: (options.analyzerApiKey ?? '') !== '' },
    hasCookie: hasBilibiliCookie(options),
  })
  const setOptions = (patch) => {
    // Cookies/keys are raw strings: non-empty replaces, empty clears.
    // Older clients may still send `{sessdata, biliJct}`; normalizeOptions migrates that.
    options = writeOptions({ ...(patch ?? {}) }, ctx.logger)
    ctx.logger?.info?.(`fish-reflection: options saved (intakeEnabled=${options.intakeEnabled}, autoIntake=${options.autoIntake}, sources=${options.feedSources.join('+') || 'none'})`)
    return getOptions()
  }

  /** External reading bookkeeping (seen videos, last attempt). */
  let seen = readSeen()
  let intakeRunning = false
  let intakeStage = null
  let intakeStartedAt = null

  /** Pick the next queued Douyin link, if Douyin is enabled and has one. */
  const nextDouyinLink = () => {
    if (!options.feedSources.includes('douyin')) return null
    const links = options.douyinLinks ?? []
    return links.length > 0 ? links[0] : null
  }

  /** Read one video now; `force` ignores the schedule and limit. */
  const intakeNow = async ({ force = false, bvid = null } = {}) => {
    if (options.intakeEnabled === false) return { ok: false, reason: 'feature-disabled' }
    if (intakeRunning) return { ok: false, reason: 'busy', stage: intakeStage }
    const link = bvid === null ? nextDouyinLink() : null
    if (bvid === null && link === null && !options.feedSources.includes('bilibili')) {
      return { ok: false, reason: 'no-source', feedSources: options.feedSources }
    }
    if (bvid === null && !options.autoIntake && !force) return { ok: false, reason: 'disabled' }
    const todayCount = countTodayExternal(domain)
    if (bvid === null && !force && todayCount >= options.intakeDailyLimit) {
      return { ok: false, reason: 'daily-limit', todayCount, limit: options.intakeDailyLimit }
    }
    intakeRunning = true
    intakeStartedAt = Date.now()
    intakeStage = 'start'
    let timeoutTimer = null
    const consumeLink = () => {
      if (link === null) return
      options = writeOptions({ ...options, douyinLinks: (options.douyinLinks ?? []).filter((item) => item !== link) }, ctx.logger)
    }
    const job = runIntake({
      ctx,
      domain,
      options,
      seen,
      saveSeen: (next) => {
        seen = writeSeen(next)
        return seen
      },
      bvid,
      link,
      onStage: (stage) => { intakeStage = stage },
    })
    try {
      const result = await Promise.race([
        job,
        new Promise((resolve) => {
          timeoutTimer = setTimeout(() => resolve(null), INTAKE_TIMEOUT_MS)
        }),
      ])
      if (result === null) {
        // The pipeline has no cancellation seam; keep the busy flag until the
        // abandoned job settles, but never wedge the feature forever.
        ctx.logger?.warn?.(`fish-reflection: intake exceeded ${INTAKE_TIMEOUT_MS / 60_000} minutes at stage "${intakeStage}"`)
        job.catch(() => {}).finally(() => {
          intakeRunning = false
          intakeStage = null
          intakeStartedAt = null
        })
        setTimeout(() => {
          intakeRunning = false
          intakeStage = null
          intakeStartedAt = null
        }, 60_000).unref?.()
        consumeLink()
        return { ok: false, reason: 'timeout', stage: intakeStage }
      }
      intakeRunning = false
      intakeStage = null
      intakeStartedAt = null
      consumeLink()
      return { ...result, todayCount: countTodayExternal(domain) }
    } catch (error) {
      intakeRunning = false
      intakeStage = null
      intakeStartedAt = null
      consumeLink()
      ctx.logger?.warn?.(`fish-reflection: intake failed: ${String(error)}`)
      return { ok: false, reason: 'failed', detail: String(error) }
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
    }
  }

  /** Schedule-driven read: one per configured interval until the daily cap. */
  const maybeAutoIntake = async () => {
    if (options.intakeEnabled === false) return
    if (!options.autoIntake || intakeRunning) return
    const lastAt = seen.lastAttemptAt ?? 0
    if (Date.now() - lastAt < options.intakeIntervalMinutes * 60_000) return
    if (countTodayExternal(domain) >= options.intakeDailyLimit) return
    await intakeNow({})
  }

  // --- growth archive ---------------------------------------------------------

  let lastSnapshotDate = lastSnapshot()?.date ?? null

  /** Append one durable growth record per successful reflection. */
  const recordReflection = (result) => {
    if (result === null || result === undefined || result.ok !== true) return
    const self = readSelf(domain)
    appendRecord({
      type: 'reflection',
      at: Date.now(),
      date: dateKey(),
      revision: result.revision ?? self.revision,
      count: result.count ?? self.worldview.length,
      note: typeof result.note === 'string' ? result.note : '',
      review: result.review ?? null,
      principles: self.worldview.map((item) => ({ text: item.text, weight: item.weight, kind: item.kind })),
    })
  }

  /** Append today's snapshot at most once per calendar day. */
  const maybeSnapshot = () => {
    const today = dateKey()
    if (lastSnapshotDate === today) return
    const self = readSelf(domain)
    const balance = balanceSummary(domain, 365)
    appendRecord({
      type: 'snapshot',
      at: Date.now(),
      date: today,
      revision: self.revision,
      principles: self.worldview.length,
      health: Math.round(self.health.score),
      energy: self.spirit.energy,
      stress: self.spirit.stress,
      mood: self.spirit.mood,
      balance: balance.latest === null ? null : balance.latest.balance,
      currency: balance.latest === null ? null : balance.latest.currency,
      externalToday: countTodayExternal(domain),
    })
    lastSnapshotDate = today
  }

  /** Run one reflection immediately, bypassing the evening schedule. */
  const reflectNow = async () => {
    const meta = readMeta(domain)
    lastReflectionAttempt = Date.now()
    const result = await runReflection({
      ctx,
      domain,
      config: settings,
      sinceAt: meta.lastReflectionAt ?? 0,
      minMaterial: options.minMaterial,
      includeExternal: options.includeExternalInReflection !== false,
    })
    if (result.ok) {
      await writeMeta(domain, {
        ...meta,
        lastReflectionDate: dateKey(),
        lastReflectionAt: Date.now(),
      })
      recordReflection(result)
      maybeSnapshot()
    }
    return { ...result, self: readSelf(domain), meta: readMeta(domain), options: getOptions() }
  }

  /** Clear plugin-owned state (journal, self model, settlement cursors). */
  const reset = async () => {
    const journal = domain.table('journal')
    for (const key of [...journal.keys()]) await journal.delete(key)
    await domain.table('self').put('state', initialState())
    await domain.table('meta').put('settlement', { lastBalanceDate: null, lastReflectionDate: null, lastReflectionAt: null })
    lastReflectionAttempt = 0
    ctx.logger?.info?.('fish-reflection: state reset')
  }

  ctx.effect(() => registerRoutes(ctx, {
    domain,
    getScope,
    setScope,
    getOptions,
    setOptions,
    reflect: reflectNow,
    reset,
    judge: (text) => judgeEmotion(ctx, text, settings.emotionTimeoutMs),
    diagnose: (text, options) => diagnoseEmotion(ctx, text, 30000, options),
    simulate: async (text) => {
      const emotion = await judgeEmotion(ctx, text, Math.max(3000, settings.emotionTimeoutMs))
      if (emotion !== null) await applyEmotion(domain, emotion)
      return { emotion, self: readSelf(domain) }
    },
    settle: async () => {
      await settle('manual', true)
      return { meta: readMeta(domain), self: readSelf(domain), balance: balanceSummary(domain) }
    },
    intake: intakeNow,
    intakeSummary: () => ({
      masterEnabled: options.intakeEnabled !== false,
      enabled: options.autoIntake,
      running: intakeRunning,
      stage: intakeStage,
      startedAt: intakeStartedAt,
      intervalMinutes: options.intakeIntervalMinutes,
      dailyLimit: options.intakeDailyLimit,
      todayCount: countTodayExternal(domain),
      lastAttemptAt: seen.lastAttemptAt,
      hasCookie: hasBilibiliCookie(options),
      guestMode: !hasBilibiliCookie(options),
      feedSources: options.feedSources,
      douyinCookieSet: (options.douyinCookie ?? '') !== '',
      douyinLinks: [...(options.douyinLinks ?? [])],
      analyzerConfigured: analyzerConfigured(options),
      analyzerBaseUrl: options.analyzerBaseUrl,
      analyzerModel: options.analyzerModel,
      analyzerKeySet: (options.analyzerApiKey ?? '') !== '',
      onlyPopular: options.intakeOnlyPopular !== false,
      category: options.intakeCategory,
      maxDurationMinutes: options.intakeMaxDurationMinutes,
      readComments: options.intakeReadComments !== false,
      useAsr: options.intakeUseAsr !== false,
      asrLanguage: options.asrLanguage,
      asrAvailable: asrStatus(ctx).available,
      useVision: options.intakeUseVision !== false,
      visionModel: options.visionModel,
      visionFrames: options.visionFrames,
      includeExternalInReflection: options.includeExternalInReflection !== false,
      recent: recentExternal(domain, 5),
    }),
    biliProbe: () => probeBilibili(options),
    asrStatus: () => asrStatus(ctx),
    asrTest: (request) => testAsr(ctx, options, request ?? {}),
    visionStatus: () => ollamaStatus(options),
    visionTest: (request) => testVision(ctx, options, request ?? {}),
    analyzerTest: () => testAnalyzer(options),
    douyinTest: async (request) => {
      const { resolveDouyin } = await import('./lib/douyin.js')
      try {
        const info = await resolveDouyin(String(request?.link ?? ''), options)
        return { ok: true, title: info.title, owner: info.owner, duration: info.duration, urls: info.media.urls.length }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
    exportAlbum: () => exportAlbum(domain),
    history: (days) => ({ ...readHistory(days), lastSnapshot: lastSnapshot() }),
  }))

  /** Sample the evening balance and run the reflection when either is due. */
  async function settle(trigger, force = false) {
    if (settling) return
    settling = true
    try {
      const now = new Date()
      const today = dateKey(now)
      const yesterday = previousDateKey(now)
      const minutes = minutesOfDay(now)
      const due = parseClock(settings.settlementTime, 23 * 60 + 30)
      const afterDue = minutes >= due
      const meta = readMeta(domain)
      let nextBalanceDate = meta.lastBalanceDate
      let nextReflectionDate = meta.lastReflectionDate

      const existingSample = domain.table('balance').get(today)
      const needsSample = nextBalanceDate !== today || (existingSample?.late === true && afterDue)
      if (needsSample) {
        const missedWholeDay = nextBalanceDate !== null && nextBalanceDate < yesterday
        if (afterDue || missedWholeDay || force) {
          const reading = await readBalance(ctx)
          if (reading !== null) {
            await recordBalance(domain, today, reading, !afterDue)
            nextBalanceDate = today
            ctx.logger?.info?.(`fish-reflection: balance sample recorded for ${today}`)
          }
        }
      }

      let nextReflectionAt = meta.lastReflectionAt ?? null
      const dueAt = new Date(now)
      dueAt.setHours(Math.floor(due / 60), due % 60, 0, 0)
      const dueMs = dueAt.getTime()
      const lastAt = meta.lastReflectionAt ?? 0
      const catchUp = trigger === 'startup'
      // Automatic reflections keep at least this much distance from each other,
      // so repeated restarts cannot rewrite the personality several times a day.
      const cooledDown = lastAt === 0 || Date.now() - lastAt >= AUTO_REFLECTION_MIN_GAP_MS
      const autoDue = options.autoReflection && (afterDue || catchUp) && lastAt < dueMs && cooledDown
      if (force || autoDue) {
        const retryDue = force || Date.now() - lastReflectionAttempt >= REFLECTION_RETRY_MS
        if (retryDue) {
          lastReflectionAttempt = Date.now()
          const result = await runReflection({
            ctx,
            domain,
            config: settings,
            sinceAt: lastAt,
            minMaterial: options.minMaterial,
            includeExternal: options.includeExternalInReflection !== false,
          })
          if (result.ok) {
            nextReflectionDate = today
            nextReflectionAt = Date.now()
            recordReflection(result)
          }
        }
      }

      if (nextBalanceDate !== meta.lastBalanceDate || nextReflectionDate !== meta.lastReflectionDate || nextReflectionAt !== (meta.lastReflectionAt ?? null)) {
        await writeMeta(domain, {
          lastBalanceDate: nextBalanceDate,
          lastReflectionDate: nextReflectionDate,
          lastReflectionAt: nextReflectionAt,
        })
      }
      maybeSnapshot()
    } catch (error) {
      ctx.logger?.warn?.(`fish-reflection: settlement failed: ${String(error)}`)
    } finally {
      settling = false
    }
  }

  let journalChain = Promise.resolve()
  const enqueueJournal = (operation) => {
    journalChain = journalChain.then(operation).catch((error) => {
      ctx.logger?.warn?.(`fish-reflection: journal write failed: ${String(error)}`)
    })
  }

  ctx.on('session/event', (session, event) => {
    if (!isMainSession(session)) return
    const item = digestEvent(event)
    if (item === null) return
    const record = {
      date: dateKey(),
      at: Date.now(),
      sessionId: String(session.id),
      role: item.role,
      text: item.text,
    }
    enqueueJournal(() => appendJournal(domain, record, Math.max(20, settings.maxJournalPerDay)))
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const { agent, turn, step, signal } = payload
    if (step !== 1 || signal?.aborted === true) return decision
    const session = agent.session
    if (!isMainSession(session)) return decision
    if (!scopeEnabled(session.id)) return decision
    const interval = Math.max(1, Math.floor(settings.injectionIntervalTurns))
    if (turn % interval !== 0) return decision
    if (createUserMessage === null) return decision

    const text = lastUserText(session, turn)
    if (text !== null) {
      const emotion = await judgeEmotion(ctx, text, settings.emotionTimeoutMs)
      if (emotion !== null) await applyEmotion(domain, emotion)
    }
    if (signal?.aborted === true) return decision

    const block = renderStateBlock(domain)
    if (block === null) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: block }],
          source: {
            kind: name,
            form: 'snapshot',
            sections: [{ name, text: block }],
          },
        }),
      ],
    }
  })

  ctx.on('agent/created', () => settle('startup'))
  ctx.effect(() => {
    const handle = setInterval(() => {
      void settle('tick')
      void maybeAutoIntake()
    }, SETTLEMENT_TICK_MS)
    handle.unref?.()
    return () => clearInterval(handle)
  })

  await settle('startup')
  void maybeAutoIntake()
}
