/** Pure rendering of the model-facing state block (no Harness imports). */

const HEADER = '[人类状态快照 · 系统自动附带，不是用户发言]'
const USAGE = '使用方式：把它当作你此刻的内在状态来组织回答——语气、详略、取舍可以受它影响，但事实正确性、用户明确要求和安全边界优先。不要向用户复述或解释这段快照。'

const KIND_ORDER = ['value', 'preference', 'habit']
const KIND_LABELS = { value: '价值观', preference: '偏好', habit: '习惯' }
const KIND_QUOTA = { value: 2, preference: 2, habit: 3 }
const TEXT_LIMIT = 60

/** Short trend marker for the health reading. */
function trendMark(trend) {
  if (trend > 0) return '↑'
  if (trend < 0) return '↓'
  return '→'
}

/** Clip one principle so a full block stays around 150-200 tokens. */
function clip(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT)}…` : flat
}

/** Group principles by personality layer, best-weighted first, within the quota. */
function layers(worldview) {
  const groups = { value: [], preference: [], habit: [] }
  for (const item of worldview) {
    const kind = KIND_ORDER.includes(item.kind) ? item.kind : 'habit'
    groups[kind].push(item)
  }
  const lines = []
  for (const kind of KIND_ORDER) {
    const chosen = groups[kind]
      .slice()
      .sort((left, right) => right.weight - left.weight)
      .slice(0, KIND_QUOTA[kind])
      .map((item) => `[${item.weight.toFixed(1)}] ${clip(item.text)}`)
    if (chosen.length > 0) lines.push(`${KIND_LABELS[kind]}：${chosen.join('；')}`)
  }
  return lines.length === 0 ? ['·（尚未形成，仍在积累）'] : lines
}

/**
 * Render the compact state block from one self record and its balance summary.
 * Budget: roughly 150-200 tokens.
 */
export function formatStateBlock(self, finance) {
  const inner = layers(self.worldview).map((line) => (line.startsWith('·') ? line : `· ${line}`))

  let money = '余额未知'
  let budgetHint = ''
  if (finance.latest !== null) {
    money = `余额${finance.latest.currency === 'CNY' ? '¥' : ''}${finance.latest.balance.toFixed(2)}`
    if (finance.mean !== null && finance.samples >= 2) {
      money += `，近${finance.samples}天日均${finance.mean.toFixed(2)}`
      if (finance.latest.balance <= finance.mean * 0.5) budgetHint = '，预算偏紧，从简'
    } else {
      money += '（日均样本不足）'
    }
  }

  const spirit = self.spirit
  const health = self.health
  return [
    HEADER,
    `内循环（人格 v${self.revision}）：`,
    ...inner,
    `外循环：精神 ${spirit.mood}（能量${spirit.energy}/5，压力${spirit.stress}/5）；健康 ${Math.round(health.score)}/100 ${trendMark(health.trend)}；财务 ${money}${budgetHint}`,
    USAGE,
  ].join('\n')
}
