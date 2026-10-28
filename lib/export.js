/**
 * "pass by" archive: dump the live state, growth history and video-reading
 * notes into the `pass by/` folder so the settings page can stay short.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAll, lastSnapshot } from './history.js'
import { journalSince } from './journal.js'
import { balanceSummary } from './finance.js'
import { readMeta, readSelf } from './state.js'

const ALBUM_DIR = fileURLToPath(new URL('../pass by/', import.meta.url))

function stamp(value) {
  if (!value) return '—'
  const date = new Date(value)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function kindLabel(kind) {
  if (kind === 'value') return '价值观'
  if (kind === 'preference') return '偏好'
  return '习惯'
}

function renderStatus(domain) {
  const self = readSelf(domain)
  const meta = readMeta(domain)
  const balance = balanceSummary(domain, 365)
  const latestText = balance.latest === null ? '样本不足' : `¥${Number(balance.latest.balance).toFixed(2)}（${balance.latest.date}）`
  const meanText = balance.mean === null ? '样本不足' : `¥${Number(balance.mean).toFixed(2)}`
  const lines = [
    '# 当前状态',
    '',
    `- 人格版本：v${self.revision}`,
    `- 上次反省：${stamp(meta.lastReflectionAt)}`,
    `- 情绪：${self.spirit.mood}（精力 ${self.spirit.energy}/5，压力 ${self.spirit.stress}/5）`,
    `- 健康：${self.health.score}/100（趋势 ${self.health.trend >= 0 ? '+' : ''}${self.health.trend}）`,
    `- 余额：${latestText}，近一年日均：${meanText}`,
    '',
    '## 人格三观',
    '',
    self.worldview.length === 0 ? '（还没有写入任何原则）' : '',
    '| 层 | 权重 | 内容 |',
    '|---|---|---|',
    ...self.worldview.map((item) => `| ${kindLabel(item.kind)} | ${item.weight} | ${String(item.text).replace(/\|/g, '｜')} |`),
    '',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

function renderArchive() {
  const records = readAll()
  const lines = ['# 成长档案', '', `快照与反省共 ${records.length} 条记录。`, '']
  let currentDate = ''
  for (const record of records) {
    const date = record.date ?? ''
    if (date !== currentDate) {
      currentDate = date
      lines.push(`## ${date}`, '')
    }
    if (record.type === 'snapshot') {
      lines.push(`- **快照**：v${record.revision ?? '—'}，${record.count ?? 0} 条原则；健康 ${record.health ?? '—'}；余额 ${record.balance ?? '样本不足'}`)
    } else if (record.type === 'reflection') {
      lines.push(`- **反省 v${record.revision ?? '—'}**：${record.note || '（无说明）'}`)
      if (record.review?.dropped?.length > 0) {
        for (const drop of record.review.dropped) lines.push(`  - 审稿退回：${drop.text}（${drop.reason || '未说明'}）`)
      }
    }
  }
  const snapshot = lastSnapshot()
  if (snapshot) lines.push('', `最近快照：${snapshot.date} v${snapshot.revision ?? '—'}`)
  return lines.join('\n')
}

function renderVideoNotes(domain) {
  const entries = journalSince(domain, 0)
    .filter((item) => item.role === 'external')
    .sort((left, right) => right.at - left.at)
  const lines = ['# 刷视频心得', '', `共 ${entries.length} 条。`, '']
  for (const item of entries) {
    lines.push(`- ${stamp(item.at)}：${String(item.text).replace(/\n/g, ' ').slice(0, 600)}`)
  }
  return lines.join('\n')
}

/** Write the three archive files; returns their absolute paths. */
export async function exportAlbum(domain) {
  await mkdir(ALBUM_DIR, { recursive: true })
  const files = [
    { name: 'current-status.md', text: renderStatus(domain) },
    { name: 'growth-archive.md', text: renderArchive() },
    { name: 'video-notes.md', text: renderVideoNotes(domain) },
  ]
  const written = []
  for (const file of files) {
    const target = join(ALBUM_DIR, file.name)
    await writeFile(target, `${file.text}\n`, 'utf8')
    written.push(target)
  }
  return { dir: ALBUM_DIR, files: written }
}

export { ALBUM_DIR }
