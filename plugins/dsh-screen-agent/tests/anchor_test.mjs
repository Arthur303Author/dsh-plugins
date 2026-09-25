/**
 * Staged tool release: policy checks.
 *
 * This plugin's surface is released in stages, so the first request of a session
 * (uncached, the most expensive one) offers one tool instead of eleven, and so
 * the model looks or reads before it acts.
 *
 *   stage 0  no tool call yet            -> the anchor alone
 *   stage 1  any tool call               -> + look closer, read, wait, keyboard
 *   stage 2  a stage-1 tool was used     -> + pointer and element actions
 *
 * The policy is pure and returns the DENY list handed to
 * `ctx.tools.restrict({ deny })`, so it is tested here without a live session.
 * Enforcing it through the tool registry (rather than by filtering the assembled
 * prompt) is what keeps presentation, `tools.get()` and dispatch consistent.
 *
 * Run: node tests/anchor_test.mjs
 */

import {
  ANCHOR_TOOL,
  OWN_TOOL_NAMES,
  TOOL_TIERS,
  visibleToolsFor,
  withheldToolsFor,
} from '../lib/index.js'

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `   <- ${detail}`))
}

check('the anchor is defined', typeof ANCHOR_TOOL === 'string' && ANCHOR_TOOL.length > 0)
check('the plugin declares eleven tools', OWN_TOOL_NAMES.length === 11, OWN_TOOL_NAMES.length)
check(
  'the tiers partition the tool surface exactly',
  (() => {
    const flat = TOOL_TIERS.flat()
    if (flat.length !== OWN_TOOL_NAMES.length) return false
    if (new Set(flat).size !== flat.length) return false
    return OWN_TOOL_NAMES.every((name) => flat.includes(name))
  })(),
  JSON.stringify(TOOL_TIERS),
)

// --- stage 0: nothing called yet -------------------------------------------
const stage0Visible = visibleToolsFor([])
const stage0Denied = withheldToolsFor([])
check('stage 0 shows the anchor', stage0Visible.has(ANCHOR_TOOL))
check(
  'stage 0 shows nothing else from this plugin',
  OWN_TOOL_NAMES.filter((n) => n !== ANCHOR_TOOL).every((n) => !stage0Visible.has(n)),
  [...stage0Visible].join(','),
)
check(
  'stage 0 denies every other plugin tool',
  OWN_TOOL_NAMES.filter((n) => n !== ANCHOR_TOOL).every((n) => stage0Denied.includes(n)),
  stage0Denied.join(','),
)
check('stage 0 does not deny the anchor', !stage0Denied.includes(ANCHOR_TOOL))

// --- stage 1: something was called, but nothing was read -------------------
const stage1Denied = withheldToolsFor(['read'])
check(
  "a foreign tool call denies exactly the actuation tier",
  TOOL_TIERS[2].every((n) => stage1Denied.includes(n)) && stage1Denied.length === TOOL_TIERS[2].length,
  stage1Denied.join(','),
)
check(
  'stage 1 opens the reading tier',
  TOOL_TIERS[1].every((n) => !stage1Denied.includes(n)),
  stage1Denied.join(','),
)
check(
  'a look-only session stays at stage 1',
  TOOL_TIERS[2].every((n) => withheldToolsFor(['screen_look']).includes(n)),
)

// --- stage 2: a stage-1 tool was actually used ----------------------------
check(
  'using a stage-1 tool denies nothing',
  withheldToolsFor(['screen_look', 'screen_elements']).length === 0,
  withheldToolsFor(['screen_look', 'screen_elements']).join(','),
)
check(
  'screen_act arrives only with the actuation stage',
  TOOL_TIERS[2].includes('screen_act')
  && withheldToolsFor(['screen_look']).includes('screen_act')
  && !withheldToolsFor(['screen_windows']).includes('screen_act'),
)
check(
  'visible and denied always partition this plugin’s surface',
  (() => {
    const cases = [[], ['read'], ['screen_look'], ['screen_key'], ['screen_elements'], ['x', 'y']]
    return cases.every((calls) => {
      const visible = [...visibleToolsFor(calls)]
      const denied = withheldToolsFor(calls)
      const union = [...visible, ...denied].sort()
      const expected = [...OWN_TOOL_NAMES].sort()
      return union.length === expected.length && union.every((n, i) => n === expected[i])
    })
  })(),
)
check(
  'the deny list follows registration order',
  (() => {
    const denied = withheldToolsFor([])
    const order = OWN_TOOL_NAMES.filter((n) => denied.includes(n))
    return denied.length === order.length && denied.every((n, i) => n === order[i])
  })(),
)

// --- opt-out ---------------------------------------------------------------
check(
  'DSH_SCREEN_AGENT_STAGING=off denies nothing after one call',
  (() => {
    process.env.DSH_SCREEN_AGENT_STAGING = 'off'
    try {
      return withheldToolsFor(['read']).length === 0
    } finally {
      delete process.env.DSH_SCREEN_AGENT_STAGING
    }
  })(),
)
check(
  'staging off still anchors the very first request',
  (() => {
    process.env.DSH_SCREEN_AGENT_STAGING = 'off'
    try {
      const visible = visibleToolsFor([])
      const denied = withheldToolsFor([])
      return visible.size === 1 && visible.has(ANCHOR_TOOL) && denied.length === OWN_TOOL_NAMES.length - 1
    } finally {
      delete process.env.DSH_SCREEN_AGENT_STAGING
    }
  })(),
)

// --- edges -----------------------------------------------------------------
check('a non-array calls argument is tolerated', withheldToolsFor(undefined).length === 10)
check('a null calls argument is tolerated', withheldToolsFor(null).length === 10)
check(
  'unknown tool names in the log change nothing',
  withheldToolsFor(['some_other_plugin_tool']).length === TOOL_TIERS[2].length,
)

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map(([label]) => label).join('; '))
  process.exit(1)
}
console.log('all staging checks passed')
