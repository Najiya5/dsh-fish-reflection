/** Lenient JSON extraction for model output that may be wrapped in prose or fences. */

/**
 * Parse the first JSON object found in `text`.
 * Returns `undefined` when no balanced object parses.
 */
export function parseJsonObject(text) {
  const source = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidates = []
  if (fenced !== null) candidates.push(fenced[1])
  candidates.push(source)
  for (const candidate of candidates) {
    const direct = tryParse(candidate)
    if (direct !== undefined) return direct
    const extracted = extractBalanced(candidate)
    if (extracted !== undefined) {
      const parsed = tryParse(extracted)
      if (parsed !== undefined) return parsed
    }
  }
  return undefined
}

function tryParse(text) {
  try {
    const value = JSON.parse(text.trim())
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function extractBalanced(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Clamp a numeric field into a range, falling back when it is not a finite number. */
export function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Remove a trailing "（权重 0.90）" style marker from a stored principle.
 * Older reflections echoed the weight annotation back into the text; the
 * annotation belongs to the record, not to the sentence.
 */
export function stripWeightSuffix(text) {
  return String(text ?? '')
    .replace(/[（(]\s*权重\s*[0-9]+(?:\.[0-9]+)?\s*[）)]\s*$/u, '')
    .trim()
}
