/**
 * The model-facing state block. It is appended as one extra user-role message
 * at the end of the step input, so it follows the reusable request prefix and
 * never rewrites the cached system prompt.
 */
import { balanceSummary } from './finance.js'
import { formatStateBlock } from './format.js'
import { readSelf } from './state.js'

/** Render the compact state block for one agent's durable domain. */
export function renderStateBlock(domain) {
  return formatStateBlock(readSelf(domain), balanceSummary(domain, 365))
}
