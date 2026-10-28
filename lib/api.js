/**
 * Same-origin JSON API for the Settings page.
 *
 * The page is served by the Harness web shell, so it can call these routes with
 * ordinary `fetch`; the routes are registered on the same listener that serves
 * the application. They expose only the plugin's own state and its scope list.
 */
import { balanceSummary } from './finance.js'
import { journalSince } from './journal.js'
import { readSelf } from './state.js'

const PREFIX = '/fish-reflection/api/'
const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSIONS_LISTED = 120

/** Write one JSON response. */
function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Reject cross-origin callers; same-origin requests may omit the header. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Read and parse one bounded JSON request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Build the payload the Settings page renders. */
async function overviewPayload(ctx, domain, apiOptions) {
  const scope = apiOptions.getScope()
  const options = apiOptions.getOptions()
  const self = readSelf(domain)
  const meta = domain.table('meta').get('settlement') ?? {}
  const sinceAt = meta.lastReflectionAt ?? self.lastReflectionAt ?? 0
  const payload = {
    scope,
    options,
    sessions: [],
    self: {
      revision: self.revision,
      worldview: self.worldview,
      spirit: self.spirit,
      health: self.health,
      lastReflectionAt: self.lastReflectionAt ?? null,
    },
    reflection: {
      lastAt: meta.lastReflectionAt ?? null,
      lastDate: meta.lastReflectionDate ?? null,
      materialSinceLast: journalSince(domain, sinceAt).length,
      minMaterial: options.minMaterial,
    },
    intake: apiOptions.intakeSummary ? apiOptions.intakeSummary() : null,
    history: apiOptions.history ? apiOptions.history(30) : null,
    balance: balanceSummary(domain, 365),
    serverTime: Date.now(),
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined || query === null) return payload
  try {
    const records = await query.listSessions()
    const main = records
      .filter((record) => record?.header?.origin !== 'subagent')
      .filter((record) => (record?.header?.delegationDepth ?? 0) === 0)
      .slice(0, MAX_SESSIONS_LISTED)
    const titles = new Map()
    try {
      const observed = await query.readTitleSnapshots(main.map((record) => record.header.id))
      for (const item of observed) {
        if (item?.status === 'fulfilled' && item.value?.title?.title) {
          titles.set(String(item.sessionId), item.value.title.title)
        }
      }
    } catch {
      /* titles are decoration; ids and directories still render */
    }
    payload.sessions = main.map((record) => ({
      id: String(record.header.id),
      cwd: typeof record.header.cwd === 'string' ? record.header.cwd : '',
      createdAt: record.header.createdAt,
      live: record.live === true,
      title: titles.get(String(record.header.id)) ?? '',
    }))
  } catch (error) {
    ctx.logger?.warn?.(`fish-reflection: session listing failed: ${String(error)}`)
  }
  return payload
}

/**
 * Register the plugin's API routes.
 * Returns a disposer, or a no-op when the web server is absent.
 */
export function registerRoutes(ctx, options) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null) return () => {}
  const disposers = []

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}overview`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        send(res, 200, await overviewPayload(ctx, options.domain, options))
      } catch (error) {
        send(res, 500, { error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}scope`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        const scope = options.setScope(body?.enabledSessions)
        send(res, 200, { ok: true, scope })
      } catch (error) {
        send(res, 400, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}reset`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        await options.reset()
        send(res, 200, { ok: true })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}judge`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (text.trim() === '') {
          send(res, 400, { ok: false, error: 'text is required' })
          return
        }
        const result = await options.diagnose(text, { effort: body?.effort, maxTokens: body?.maxTokens })
        send(res, 200, { ok: true, result })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}simulate`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (text.trim() === '') {
          send(res, 400, { ok: false, error: 'text is required' })
          return
        }
        send(res, 200, { ok: true, ...(await options.simulate(text)) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}settle`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(await options.settle()) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}reflect`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(await options.reflect()) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}options`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        if (req.method === 'GET') {
          send(res, 200, { ok: true, options: options.getOptions() })
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readJson(req)
        send(res, 200, { ok: true, options: options.setOptions(body ?? {}) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}intake`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        const bvid = typeof body?.bvid === 'string' && body.bvid.trim() !== '' ? body.bvid.trim() : null
        send(res, 200, { ok: true, ...(await options.intake({ force: body?.force === true, bvid })) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}bili-test`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(await options.biliProbe()) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}history`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const days = Number(url.searchParams.get('days') ?? 90)
        send(res, 200, { ok: true, days, ...(options.history ? options.history(days) : { snapshots: [], reflections: [] }) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}asr-status`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(options.asrStatus ? options.asrStatus() : { available: false }) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}asr-test`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        send(res, 200, { ok: true, ...(await options.asrTest(body ?? {})) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}vision-status`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(options.visionStatus ? await options.visionStatus() : { running: false }) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}vision-test`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        send(res, 200, { ok: true, ...(await options.visionTest(body ?? {})) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}analyzer-test`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(options.analyzerTest ? await options.analyzerTest() : { configured: false }) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}douyin-test`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readJson(req)
        send(res, 200, { ok: true, ...(await options.douyinTest(body ?? {})) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}export`,
    handler: async (req, res) => {
      if (!sameOrigin(req)) {
        send(res, 403, { error: 'cross-origin request rejected' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        send(res, 200, { ok: true, ...(await options.exportAlbum()) })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error) })
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
