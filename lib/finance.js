/**
 * Financial outer loop: account balance read through the Host account service,
 * one evening sample per day, and the rolling average the model is shown.
 */

const CLIENT = Object.freeze({
  version: '1.0.0',
  locale: 'zh-CN',
})

/** Identity metadata the account service requires from a Host caller. */
function clientMetadata() {
  return {
    ...CLIENT,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Read the current account balance once.
 * Returns `null` while signed out, unsupported, or when the platform query fails.
 */
export async function readBalance(ctx) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null) return null
  try {
    const balance = await account.getBalance(clientMetadata())
    if (balance === null || balance === undefined || balance.status !== 'ready') return null
    const wallets = balance.value.map((wallet) => ({
      currency: String(wallet.currency),
      balance: String(wallet.balance),
    }))
    if (wallets.length === 0) return null
    const chosen = wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0]
    const amount = Number(chosen.balance)
    if (!Number.isFinite(amount)) return null
    return { currency: chosen.currency, balance: amount, wallets }
  } catch (error) {
    ctx.logger?.warn?.(`fish-reflection: balance read failed: ${String(error)}`)
    return null
  }
}

/** Every stored balance sample, oldest first. */
function samples(domain) {
  const items = []
  for (const [, value] of domain.table('balance').entries()) items.push(value)
  items.sort((left, right) => left.date.localeCompare(right.date))
  return items
}

/**
 * Summarize the balance ledger for the model: latest reading, mean of the
 * most recent `days` samples, and how many samples back the mean.
 */
export function balanceSummary(domain, days = 365) {
  const all = samples(domain)
  if (all.length === 0) return { latest: null, mean: null, samples: 0 }
  const window = all.slice(-Math.max(1, Math.min(365, days)))
  const mean = window.reduce((sum, item) => sum + item.balance, 0) / window.length
  return {
    latest: all[all.length - 1],
    mean,
    samples: window.length,
  }
}

/** Persist one day's sample. */
export async function recordBalance(domain, date, reading, late) {
  await domain.table('balance').put(date, {
    date,
    currency: reading.currency,
    balance: reading.balance,
    wallets: reading.wallets,
    recordedAt: Date.now(),
    late,
  })
}
