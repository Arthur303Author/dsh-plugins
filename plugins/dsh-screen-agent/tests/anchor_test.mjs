/**
 * First-turn tool anchoring: policy checks.
 *
 * The anchor hides this plugin's tools from the first request of a session that
 * has not made any tool call yet, keeping the prefill of that (uncached, most
 * expensive) request small. Everything must be restored the moment the session
 * is demonstrably in a tool-using loop.
 *
 * Run: node tests/anchor_test.mjs
 */

import { ANCHOR_TOOL, OWN_TOOL_NAMES, anchorAssembly } from '../lib/index.js'

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `   <- ${detail}`))
}

const FOREIGN = ['pwsh', 'read', 'grep', 'glob']
const asm = { tools: [...OWN_TOOL_NAMES, ...FOREIGN].map((name) => ({ name })) }

const first = anchorAssembly(asm, false)
const firstNames = first.tools.map((t) => t.name)
const later = anchorAssembly(asm, true)
const laterNames = later.tools.map((t) => t.name)

check('the anchor is defined', typeof ANCHOR_TOOL === 'string' && ANCHOR_TOOL.length > 0)
check('the plugin declares ten tools', OWN_TOOL_NAMES.length === 10, OWN_TOOL_NAMES.length)

check('first turn keeps the anchor', firstNames.includes(ANCHOR_TOOL))
check(
  'first turn hides every other plugin tool',
  OWN_TOOL_NAMES.filter((n) => n !== ANCHOR_TOOL).every((n) => !firstNames.includes(n)),
  firstNames.join(','),
)
check(
  'first turn leaves foreign tools untouched',
  FOREIGN.every((n) => firstNames.includes(n)),
  firstNames.join(','),
)
check(
  'first-turn surface is exactly anchor + foreign',
  firstNames.length === FOREIGN.length + 1,
  `${firstNames.length}: ${firstNames.join(',')}`,
)

check(
  'later turn restores all six plugin tools',
  OWN_TOOL_NAMES.every((n) => laterNames.includes(n)),
  laterNames.join(','),
)
check('later turn keeps foreign tools', FOREIGN.every((n) => laterNames.includes(n)))
check('later turn returns the identical object', later === asm)

check('a foreign-only session is unaffected', (() => {
  const only = { tools: FOREIGN.map((name) => ({ name })) }
  const out = anchorAssembly(only, false)
  return out.tools.length === FOREIGN.length
})())
check('undefined assembly does not throw', anchorAssembly(undefined, false) === undefined)
check('assembly without tools passes through', (() => {
  const bare = {}
  return anchorAssembly(bare, false) === bare
})())
check('null tools passes through', (() => {
  const bare = { tools: null }
  return anchorAssembly(bare, false) === bare
})())
check('unknown entries are left untouched', (() => {
  // Only this plugin's own non-anchor tool may be removed. Unnamed or malformed
  // entries belong to someone else, so the filter must not touch them.
  const odd = { tools: [{ name: 'screen_click' }, {}, null] }
  const out = anchorAssembly(odd, false)
  return out.tools.length === 2 && !out.tools.some((t) => t?.name === 'screen_click')
})())

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map(([label]) => label).join('; '))
  process.exit(1)
}
console.log('all anchoring checks passed')
