import assert from 'node:assert/strict'
import { framesForDuration, visionConfig, visionPlan } from '../lib/vision.js'

const local = visionConfig({ visionFramesPerMinute: 1, visionMaxFrames: 30, visionBackend: 'local' })
assert.equal(local.framesPerMinute, 1, 'default rate')
assert.equal(local.maxFrames, 30, 'default cap')
assert.equal(local.backend, 'local', 'default backend is local')
assert.equal(framesForDuration(30, local), 1, 'short video gets one frame')
assert.equal(framesForDuration(60, local), 1, 'one minute gets one frame')
assert.equal(framesForDuration(300, local), 5, 'five minutes gets five frames')
assert.equal(framesForDuration(3600, local), 30, 'long video is capped')

const dense = visionConfig({ visionFramesPerMinute: 2, visionMaxFrames: 10, visionBackend: 'auto' })
assert.equal(framesForDuration(300, dense), 10, 'rate times minutes, capped')
assert.equal(dense.backend, 'auto', 'auto backend preserved')

const clamped = visionConfig({ visionFramesPerMinute: 99, visionMaxFrames: 999, visionBackend: 'api' })
assert.equal(clamped.framesPerMinute, 6, 'rate clamped to 6')
assert.equal(clamped.maxFrames, 120, 'cap clamped to 120')
assert.equal(clamped.backend, 'api', 'api backend preserved')

assert.equal(visionConfig({}).backend, 'local', 'missing backend falls back to local')

const localPlan = visionPlan({ visionBackend: 'local' }, true)
assert.deepEqual(localPlan, { backend: 'local', runLocal: true, analyzerMode: 'never' }, 'local backend never calls the API')
assert.equal(visionPlan({ visionBackend: 'api' }, false).analyzerMode, 'never', 'api backend without config skips the API')
assert.equal(visionPlan({ visionBackend: 'api' }, true).analyzerMode, 'always', 'api backend uses the API')
assert.deepEqual(visionPlan({ visionBackend: 'auto' }, true), { backend: 'auto', runLocal: true, analyzerMode: 'fallback' }, 'auto tries local first')
assert.equal(visionPlan({ visionBackend: 'auto' }, false).analyzerMode, 'never', 'auto without config stays local')
assert.deepEqual(visionPlan({ intakeUseVision: false, visionBackend: 'auto' }, true), { backend: 'auto', runLocal: false, analyzerMode: 'never' }, 'vision toggle disables both paths')

console.log('VISION RATE / BACKEND TESTS OK')
