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
 * Note for whoever reads the scaffold's own comment block below
 * ---------------------------------------------------------------------------
 * The anchoring mechanism IS implemented — in lib/index.js, not here. See
 * `ANCHOR_TOOL`, `anchorAssembly()`, and the `system-prompt/assemble` listener
 * in `apply()`.
 *
 * Two corrections to what the generated comment claims:
 *
 * 1. It says to read `agent.session.events`. The `Session` class has no such
 *    property; that expression is undefined and the guard silently never fires,
 *    so the anchor quietly does nothing. The real entries are
 *    `session.snapshotEvents()` (includes fork-inherited history) and
 *    `session.ownEvents()`.
 *
 * 2. `inject` must also list `systemPrompt` for this to be reliable, and the
 *    registration has to ride `ctx.effect` so a fiber dispose unregisters the
 *    listener the same way it does for tools.
 */
export {}
