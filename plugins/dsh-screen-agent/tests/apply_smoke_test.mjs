/**
 * apply() smoke test: loading the plugin registers the routing note.
 *
 * `routing_prompt_test.mjs` covers the registration function in isolation.
 * This covers the seam it sits on: the plugin's real entry point, driven with a
 * fake context, so a mistake in `apply()` itself — a bad argument, a call placed
 * where a throwing service stops the loop — is caught here rather than by a user
 * whose eleven screen tools silently failed to load.
 *
 * The context is fake, so nothing here needs a live harness, a real prompt
 * registry, or an agent. `ensurePython()` still warms a subprocess in the
 * background; the explicit exit at the end keeps that from holding the process.
 *
 * Run: node tests/apply_smoke_test.mjs
 */

import {
  OWN_TOOL_NAMES,
  ROUTING_SECTION,
  apply,
} from '../lib/index.js'

const checks = []
const check = (label, ok, detail = '') => {
  checks.push([label, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `   <- ${detail}`))
}

const seen = { sections: [], tools: [], listeners: [], effects: 0, agentsInjected: 0 }

const promptCtx = {
  systemPrompt: { section: (s) => { seen.sections.push(s); return () => {} } },
  effect(fn) { seen.effects += 1; const d = fn(); return typeof d === 'function' ? d : () => {} },
}

const ctx = {
  inject(deps, callback) {
    if (deps.includes('systemPrompt')) {
      callback(promptCtx)
      return
    }
    if (deps.includes('agents')) {
      seen.agentsInjected += 1
      callback({ agents: { list: () => [] } })
      return
    }
    throw new Error(`unexpected inject: ${deps.join(',')}`)
  },
  effect(fn) {
    seen.effects += 1
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on(event) {
    seen.listeners.push(event)
    return () => {}
  },
  tools: {
    register(def) {
      seen.tools.push(def.name)
      return () => {}
    },
  },
}

let threw
try {
  apply(ctx)
} catch (error) {
  threw = error
}

check('apply() does not throw with a well-formed context', threw === undefined, String(threw))
check(
  'apply() registers all eleven tools',
  seen.tools.length === OWN_TOOL_NAMES.length
    && OWN_TOOL_NAMES.every((name) => seen.tools.includes(name)),
  seen.tools.join(','),
)
check(
  'apply() registers the routing note through the prompt service',
  seen.sections.length === 1 && seen.sections[0]?.name === ROUTING_SECTION,
  JSON.stringify(seen.sections.map((s) => s.name)),
)
check(
  'apply() takes the optional prompt service with ctx.inject, not the static inject list',
  seen.agentsInjected === 1,
)
check(
  'apply() subscribes to agent/created',
  seen.listeners.includes('agent/created'),
  seen.listeners.join(','),
)
check('apply() routes every registration through ctx.effect', seen.effects >= 12, String(seen.effects))

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map(([label]) => label).join('; '))
  process.exit(1)
}
console.log('apply() smoke checks passed')
process.exit(0)
