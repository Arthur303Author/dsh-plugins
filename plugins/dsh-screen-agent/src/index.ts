/**
 * This package ships PREBUILT, uncompiled JavaScript — there is no tsc step.
 *
 * The real implementation lives in:
 *   lib/index.js         tool definitions + attachment plumbing + first-turn anchoring
 *   lib/screen_tools.py  capture / window / input sidecar (Pillow + ctypes)
 *   tests/               sidecar adversarial suite + anchoring policy checks
 *
 * dev_scaffold_plugin generated this src/ tree for a TypeScript build. That path
 * is deliberately unused here: scripts/build.sh needs DSH_CHECKOUT pointing at a
 * dsh *source* checkout (one with packages/), and this machine only has the
 * installed npm bundle. Hand-written ESM in lib/ needs neither tsc nor a
 * checkout, and avoids a build step on every edit.
 *
 * If you ever do want the TS build back: point DSH_CHECKOUT at a source
 * checkout, run `npm run build`, then aim package.json "main" at the compiled
 * lib/index.js. Nothing else depends on src/.
 *
 * ---------------------------------------------------------------------------
 * Where the real mechanisms live (corrected: this block used to be wrong)
 * ---------------------------------------------------------------------------
 * Tool staging: `ANCHOR_TOOL`, `TOOL_TIERS`, `visibleToolsFor()`,
 * `withheldToolsFor()`, and the `agent/created` + `session/event` listeners in
 * `apply()`. Enforced through `agent.ctx.tools.restrict()`, not by filtering an
 * assembled prompt.
 *
 * Routing note: `ROUTING_SECTION` / `ROUTING_ORDER` / `ROUTING_TEXT` and
 * `registerRoutingNote()`, which contributes a system-prompt section through the
 * optional `systemPrompt` service. `ctx.systemPrompt.section()` is the
 * documented way to add prompt text.
 *
 * There is deliberately NO `anchorAssembly()` and NO `system-prompt/assemble`
 * listener here: an earlier revision of this comment claimed both existed. An
 * assemble listener replaces the whole assembly and would have to preserve every
 * other plugin's contribution, which is exactly what the harness plugin
 * practices warn against for adding text.
 *
 * One correction to the generated comment below that still holds: it says to
 * read `agent.session.events`. The `Session` class has no such property — that
 * expression is undefined and a guard on it silently never fires. The real
 * entries are `session.snapshotEvents()` (includes fork-inherited history) and
 * `session.ownEvents()`.
 */
export {}
