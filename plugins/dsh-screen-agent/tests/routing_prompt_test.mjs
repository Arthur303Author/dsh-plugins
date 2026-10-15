/**
 * Routing note: policy checks.
 *
 * The plugin states its routing order — key > element action > element tree >
 * coordinates — as a system-prompt section, because the tool descriptions
 * cannot carry it: staging withholds every tool but `screen_look` on the first
 * request, and that request is the one that sets the trajectory.
 *
 * Two things are worth testing without a live harness:
 *
 *   1. the note says what the plugin actually routes by, and in the right order
 *   2. the registration cannot cost the model its tools when the prompt service
 *      is missing, oddly shaped, or rejects the section
 *
 * `registerRoutingNote()` is therefore exported and driven with a fake context.
 *
 * Run: node tests/routing_prompt_test.mjs
 */

import {
  OWN_TOOL_NAMES,
  ROUTING_ORDER,
  ROUTING_SECTION,
  ROUTING_TEXT,
  registerRoutingNote,
  routingSection,
} from '../lib/index.js'

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `   <- ${detail}`))
}

/** A plugin context that records what the registration path does. */
function fakeContext({ systemPrompt } = {}) {
  const record = { injectCalls: 0, deps: undefined, sections: [], effectLabels: [], disposers: [] }
  const ctx = {
    inject(deps, callback) {
      record.injectCalls += 1
      record.deps = deps
      const promptCtx = {
        systemPrompt,
        effect(fn, label) {
          record.effectLabels.push(label)
          const disposer = fn()
          record.disposers.push(disposer)
          return disposer
        },
      }
      callback(promptCtx)
    },
  }
  return { ctx, record }
}

const sameSection = (a, b) =>
  a !== undefined
  && b !== undefined
  && a.name === b.name
  && a.order === b.order
  && a.text === b.text
  && a.interpolate === b.interpolate

// --- the note itself -------------------------------------------------------

check('the routing section is namespaced', ROUTING_SECTION.startsWith('dsh-screen-agent:'), ROUTING_SECTION)
check('the routing section has a finite order', Number.isFinite(ROUTING_ORDER), String(ROUTING_ORDER))
check('the note is non-empty prose', typeof ROUTING_TEXT === 'string' && ROUTING_TEXT.length > 200, String(ROUTING_TEXT?.length))
check(
  'the note names the fallback chain in order',
  (() => {
    const marks = ['screen_key', 'screen_act', 'screen_elements', 'screen_zoom', 'screen_click']
      .map((name) => ROUTING_TEXT.indexOf(name))
    if (marks.some((at) => at < 0)) return false
    return marks.every((at, i) => i === 0 || marks[i - 1] < at)
  })(),
  (() => {
    const marks = ['screen_key', 'screen_act', 'screen_elements', 'screen_zoom', 'screen_click']
      .map((name) => `${name}@${ROUTING_TEXT.indexOf(name)}`)
    return marks.join(' ')
  })(),
)
check(
  'every tool the note names is a tool this plugin owns',
  ['screen_key', 'screen_act', 'screen_elements', 'screen_zoom', 'screen_click']
    .every((name) => OWN_TOOL_NAMES.includes(name)),
)
check(
  'the note keeps coordinates reachable as a stated fallback',
  /fallback/i.test(ROUTING_TEXT) && /Blender/.test(ROUTING_TEXT),
)
check('the note carries no interpolation braces', !ROUTING_TEXT.includes('{{'))

const section = routingSection()
check('routingSection() is the registered shape', sameSection(section, {
  name: ROUTING_SECTION,
  order: ROUTING_ORDER,
  text: ROUTING_TEXT,
  interpolate: false,
}))
check('the section opts out of interpolation', section.interpolate === false)

// --- registration path -----------------------------------------------------

check(
  'a present service registers exactly one section, through ctx.effect',
  (() => {
    const sections = []
    const { ctx, record } = fakeContext({
      systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    })
    registerRoutingNote(ctx)
    return sections.length === 1
      && sameSection(sections[0], section)
      && record.deps.includes('systemPrompt')
      && record.effectLabels.length === 1
  })(),
)
check(
  'the section disposer is what ctx.effect owns',
  (() => {
    const disposer = () => {}
    const { ctx, record } = fakeContext({ systemPrompt: { section: () => disposer } })
    registerRoutingNote(ctx)
    return record.disposers.length === 1 && record.disposers[0] === disposer
  })(),
)
check(
  'an absent systemPrompt service registers nothing and does not throw',
  (() => {
    const { ctx, record } = fakeContext({})
    registerRoutingNote(ctx)
    return record.injectCalls === 1 && record.effectLabels.length === 0
  })(),
)
check(
  'an oddly shaped service registers nothing and does not throw',
  (() => {
    const { ctx, record } = fakeContext({ systemPrompt: { section: 'not a function' } })
    registerRoutingNote(ctx)
    return record.effectLabels.length === 0
  })(),
)
check(
  'a registry that rejects the section does not throw at the caller',
  (() => {
    const { ctx } = fakeContext({
      systemPrompt: { section: () => { throw new Error('duplicate section name') } },
    })
    try {
      registerRoutingNote(ctx)
      return true
    } catch {
      return false
    }
  })(),
)
check(
  'the opt-out env var skips registration entirely',
  (() => {
    process.env.DSH_SCREEN_AGENT_ROUTING = 'off'
    try {
      const { ctx, record } = fakeContext({ systemPrompt: { section: () => () => {} } })
      registerRoutingNote(ctx)
      return record.injectCalls === 0
    } finally {
      delete process.env.DSH_SCREEN_AGENT_ROUTING
    }
  })(),
)

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map(([label]) => label).join('; '))
  process.exit(1)
}
console.log('all routing-note checks passed')
