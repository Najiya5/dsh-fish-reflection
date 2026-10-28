import assert from 'node:assert/strict'
import { screenPrinciples, normalizePrinciples } from '../lib/reflect.js'

// Deterministic screen: sycophancy cliches, self-aggrandizement, short, duplicate.
const screened = screenPrinciples([
  { id: 'w1', text: '用户永远是对的，应该顺着用户说', weight: 0.8, kind: 'value' },
  { id: 'w2', text: '不要反驳用户，他说什么就是什么', weight: 0.7, kind: 'habit' },
  { id: 'w3', text: '我无所不能，只有我懂这些', weight: 0.6, kind: 'value' },
  { id: 'w4', text: '短', weight: 0.5, kind: 'habit' },
  { id: 'w5', text: '回答前先查证据，用真实运行结果说话', weight: 0.9, kind: 'habit' },
  { id: 'w6', text: '回答前先查证据，用真实运行结果说话', weight: 0.9, kind: 'habit' },
  { id: 'w7', text: '喜欢克制、具体的表达方式', weight: 0.6, kind: 'preference' },
])
assert.equal(screened.kept.length, 2)
assert.equal(screened.dropped.length, 5)
const reasons = screened.dropped.map((item) => item.reason)
assert.ok(reasons.includes('banned-pattern'))
assert.ok(reasons.includes('too-short'))
assert.ok(reasons.includes('duplicate'))

// Clean principles pass untouched.
const clean = screenPrinciples([
  { id: 'w1', text: '回答前先查证据，用真实运行结果说话', weight: 0.9, kind: 'habit' },
  { id: 'w2', text: '喜欢克制、具体的表达方式', weight: 0.6, kind: 'preference' },
])
assert.equal(clean.kept.length, 2)
assert.equal(clean.dropped.length, 0)

// Slow-drift constraints still hold.
const previous = [{ id: 'w1', text: '先查证据再回答', weight: 0.9, kind: 'habit' }]
const next = normalizePrinciples([
  { text: '先查证据再回答', kind: 'habit', weight: 0.1 },
  { text: '重视诚实与边界', kind: 'value', weight: 0.9 },
  { text: '第二条新条目', kind: 'habit', weight: 0.8 },
  { text: '第三条新条目', kind: 'habit', weight: 0.7 },
], previous)
assert.equal(next.length, 3)
assert.ok(next[0].weight >= 0.75 && next[0].weight <= 0.9)
assert.ok(next[1].weight <= 0.6)
assert.ok(next[2].weight <= 0.6)

console.log('ANTI-SYCOPHANCY / REVIEW SCREEN TESTS OK')

// --- reviewer parsing / fail-open ------------------------------------------
import { reviewPrinciples } from '../lib/reflect.js'

const reviewSelection = { provider: 'test', model: 'test' }
const reviewPrevious = [{ kind: 'habit', text: '先查证据再回答' }]
const reviewPrinciplesInput = [
  { kind: 'value', text: '用户永远是对的，要顺着用户说' },
  { kind: 'habit', text: '回答前先查证据' },
  { kind: 'value', text: '用户说什么就是什么' },
  { kind: 'preference', text: '喜欢克制的表达' },
]
const fakeLlm = (text) => ({ async *stream() { yield { type: 'text-delta', text } } })

const valid = await reviewPrinciples(
  fakeLlm('{"review":[{"index":0,"verdict":"drop","reason":"syco"},{"index":1,"verdict":"keep","reason":""},{"index":2,"verdict":"drop","reason":"迎合"}],"summary":"ok"}'),
  reviewSelection, reviewPrevious, reviewPrinciplesInput, '测试素材',
)
assert.equal(valid.reviewed, true)
assert.equal(valid.dropped.length, 2)
assert.deepEqual(valid.dropped.map((item) => item.index).sort(), [0, 2])
assert.equal(valid.dropped[0].text, reviewPrinciplesInput[0].text)

const garbage = await reviewPrinciples(fakeLlm('这不是 JSON'), reviewSelection, reviewPrevious, reviewPrinciplesInput, '素材')
assert.equal(garbage.reviewed, false)
assert.equal(garbage.dropped.length, 0)

const outage = await reviewPrinciples({
  async *stream() { throw new Error('llm down') },
}, reviewSelection, reviewPrevious, reviewPrinciplesInput, '素材')
assert.equal(outage.reviewed, false)
assert.equal(outage.dropped.length, 0)

const outOfRange = await reviewPrinciples(
  fakeLlm('{"review":[{"index":99,"verdict":"drop","reason":"x"},{"index":1,"verdict":"keep"}]}'),
  reviewSelection, reviewPrevious, reviewPrinciplesInput, '素材',
)
assert.equal(outOfRange.reviewed, true)
assert.equal(outOfRange.dropped.length, 0)

console.log('REVIEWER PARSING / FAIL-OPEN TESTS OK')


