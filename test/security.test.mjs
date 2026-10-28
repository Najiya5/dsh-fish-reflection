import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- Douyin URL allowlist (fix N1: Cookie must never leave Douyin hosts) ---
const douyin = await import('../lib/douyin.js')

assert.equal(douyin.isDouyinUrl('https://v.douyin.com/abc/'), true)
assert.equal(douyin.isDouyinUrl('https://www.douyin.com/video/7692364672040783119'), true)
assert.equal(douyin.isDouyinUrl('https://v26-weba.douyinvod.com/a.mp4'), true)
assert.equal(douyin.isDouyinUrl('https://p3-sign.douyinpic.com/x'), true)
assert.equal(douyin.isDouyinUrl('http://evil.example/x'), false)
assert.equal(douyin.isDouyinUrl('https://douyin.com.evil.example/x'), false)
assert.equal(douyin.isDouyinUrl('https://evil-douyin.example/x'), false)
assert.equal(douyin.isDouyinUrl('ftp://v.douyin.com/abc/'), false)

assert.equal(douyin.extractDouyinUrl('看看 http://evil.example/x 和 https://v.douyin.com/abc/'), 'https://v.douyin.com/abc/')
assert.equal(douyin.extractDouyinUrl('http://evil.example/x'), null)
assert.equal(douyin.extractDouyinUrl('没有链接'), null)

// --- options.json: atomic write + corruption backup (fix credential loss) ---
const home = mkdtempSync(join(tmpdir(), 'fish-options-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
try {
  const options = await import('../lib/options.js')
  const dir = join(home, 'fish-reflection')

  options.writeOptions({ autoIntake: true, bilibiliCookie: 'SESSDATA=SECRET; buvid3=x' })
  const filesAfterWrite = readdirSync(dir)
  assert.deepEqual(filesAfterWrite, ['options.json'], `unexpected files: ${filesAfterWrite.join(',')}`)
  const stored = JSON.parse(readFileSync(options.optionsPath(), 'utf8'))
  assert.equal(stored.autoIntake, true)
  assert.match(stored.bilibiliCookie, /SESSDATA=SECRET/)

  const reloaded = options.readOptions()
  assert.equal(reloaded.autoIntake, true)

  // Simulate a half-written / corrupted file.
  writeFileSync(options.optionsPath(), '{"autoIntake": true, "cook', 'utf8')
  const warnings = []
  const defaults = options.readOptions({ warn: (message) => warnings.push(message) })
  assert.equal(defaults.bilibiliCookie, '')
  assert.equal(defaults.autoIntake, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /options\.json unreadable/)

  const backups = readdirSync(dir).filter((name) => name.startsWith('options.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.match(readFileSync(join(dir, backups[0]), 'utf8'), /"autoIntake"/)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}

console.log('SECURITY TESTS OK: douyin allowlist + atomic options')
