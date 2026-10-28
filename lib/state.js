/**
 * Durable state domain: one record for the self model, one record per settled
 * day of account balance, conversation digests for reflection, and the
 * settlement bookkeeping record.
 *
 * The spec is built from the host's own zod instance, so the domain facility
 * validates records with exactly the schema runtime it already uses.
 */

export const DOMAIN_NAME = 'fish_reflection'

/** Build the domain declaration against the host's zod runtime. */
export function createDomainSpec(zod) {
  const principle = zod.object({
    id: zod.string(),
    text: zod.string(),
    weight: zod.number(),
    /** Personality layer: `value` | `preference` | `habit`; older records omit it. */
    kind: zod.string().optional(),
  })

  const selfSchema = zod.object({
    version: zod.number(),
    revision: zod.number(),
    worldview: zod.array(principle),
    spirit: zod.object({
      mood: zod.string(),
      energy: zod.number(),
      stress: zod.number(),
      at: zod.number(),
    }),
    health: zod.object({
      score: zod.number(),
      trend: zod.number(),
      at: zod.number(),
    }),
    updatedAt: zod.number(),
    lastReflectionAt: zod.number().nullable(),
  })

  const balanceSchema = zod.object({
    date: zod.string(),
    currency: zod.string(),
    balance: zod.number(),
    wallets: zod.array(zod.object({ currency: zod.string(), balance: zod.string() })),
    recordedAt: zod.number(),
    late: zod.boolean(),
  })

  const journalSchema = zod.object({
    date: zod.string(),
    at: zod.number(),
    sessionId: zod.string(),
    role: zod.string(),
    text: zod.string(),
  })

  const metaSchema = zod.object({
    lastBalanceDate: zod.string().nullable(),
    lastReflectionDate: zod.string().nullable(),
    lastReflectionAt: zod.number().nullable().optional(),
  })

  return {
    name: DOMAIN_NAME,
    version: 1,
    layout: 'single',
    invalidRecords: 'backup-and-skip',
    tables: {
      self: { valueSchema: selfSchema },
      balance: { valueSchema: balanceSchema },
      journal: { valueSchema: journalSchema },
      meta: { valueSchema: metaSchema },
    },
  }
}

/** The state a fresh install starts from: no worldview yet, calm spirit, neutral health. */
export function initialState(now = Date.now()) {
  return {
    version: 1,
    revision: 0,
    worldview: [],
    spirit: { mood: '平静', energy: 3, stress: 2, at: now },
    health: { score: 60, trend: 0, at: now },
    updatedAt: now,
    lastReflectionAt: null,
  }
}

/** Read the self record, or the initial state when the install is fresh. */
export function readSelf(domain) {
  return domain.table('self').get('state') ?? initialState()
}

/**
 * Apply one synchronous patch to the self record and persist it.
 * The domain serializes writes, so concurrent emotion and reflection updates
 * cannot lose each other's fields.
 */
export function updateSelf(domain, patch) {
  return domain.table('self').update('state', (current) => ({
    ...(current ?? initialState()),
    ...patch,
    updatedAt: Date.now(),
  }))
}

/** Read settlement bookkeeping. */
export function readMeta(domain) {
  const stored = domain.table('meta').get('settlement')
  if (stored === undefined) {
    return { lastBalanceDate: null, lastReflectionDate: null, lastReflectionAt: null }
  }
  return { lastReflectionAt: null, ...stored }
}

/** Persist settlement bookkeeping. */
export function writeMeta(domain, meta) {
  return domain.table('meta').put('settlement', meta)
}
