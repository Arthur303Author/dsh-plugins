/**
 * @dsh-external/dsh-screen-agent — screen vision + synthetic input for DSH.
 *
 * Eleven tools, released in stages:
 *   screen_look     capture the full virtual desktop and return it as an image
 *   screen_zoom     crop a region of the desktop at native resolution
 *   screen_windows  list visible top-level windows
 *   screen_window   focus one window, optionally click/type, then capture it
 *   screen_elements read a window's accessibility elements: actions and state
 *   screen_act      drive one element through its own accessibility action
 *   screen_move     place the cursor, pressing nothing
 *   screen_click    press a button, optionally moving the cursor there first
 *   screen_key      send key combinations (preferred whenever a shortcut exists)
 *   screen_type     send key combinations and/or Unicode text
 *   screen_wait     wait for the screen to change, or to stop changing
 *
 * Movement is split from clicking because a click that moves the cursor can
 * change what is under it (popup menus reposition), which is exactly what broke
 * measured clicks: measure, then press — with the cursor already parked.
 *
 * Vision. The provider resizes every image to roughly an 800x800 equivalent
 * (640,000 px, 384 tokens), so a full 2560x1600 screenshot reaches the model at
 * ~1011x632 and fine detail is gone before it is ever seen. screen_zoom exists
 * for that: it crops from a *native-resolution* grab, and any crop at or below
 * 640k px arrives losslessly. Coordinates are always normalized (0..1) because
 * fractions survive every resize while pixels do not.
 *
 * Acting. click and type return a fresh screenshot so one call closes the
 * see -> think -> act loop. Images reach model context through the durable
 * attachment store and are projected by `output.render` as `{ type: 'image' }`.
 *
 * Deliberately import-free at runtime: no tsc build step and no dependency on
 * any dsh package. The sidecar is plain Python + ctypes (Pillow for capture),
 * and image payloads come back inline as base64 so concurrent calls never race
 * on a temp file.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-screen-agent'

/**
 * Services this plugin needs before it can publish tools.
 *
 * `tools` is a hard dependency: every tool registration goes through it.
 * `agents` is deliberately NOT listed here — it is taken with `ctx.inject()`
 * below, because a profile without it should still get the tools rather than
 * having the plugin stay inactive.
 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, 'screen_tools.py')

/** Provider-side per-image visual budget, mirrored by the sidecar. */
const IMAGE_PIXEL_BUDGET = 640000

// ---------------------------------------------------------------------------
// Python / sidecar plumbing
// ---------------------------------------------------------------------------

let pythonPromise

function pythonCandidates() {
  return [
    process.env.DSH_SCREEN_AGENT_PYTHON,
    'python',
    'python3',
    'F:\\python\\python.exe',
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

/** Probe one interpreter asynchronously; never blocks the host event loop. */
function probeCandidate(candidate) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ok) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const child = execFile(candidate, ['-c', 'import PIL'], { timeout: 8000, windowsHide: true }, (error) => {
        settle(error === null || error === undefined)
      })
      child.on('error', () => settle(false))
    } catch {
      settle(false)
    }
  })
}

/** Resolve (once, cached) an interpreter that can import Pillow. */
function ensurePython() {
  if (pythonPromise === undefined) {
    pythonPromise = (async () => {
      for (const candidate of pythonCandidates()) {
        if (await probeCandidate(candidate)) return candidate
      }
      return null
    })()
  }
  return pythonPromise
}

/**
 * Run one sidecar request.
 * @param request - JSON request; the sidecar answers with one JSON object.
 * @param signal - caller cancellation, forwarded to the child process.
 */
async function runSidecar(request, signal) {
  const python = await ensurePython()
  if (python === null) {
    throw new Error(
      'no Python with Pillow found; set DSH_SCREEN_AGENT_PYTHON to a python.exe that has PIL installed',
    )
  }
  if (signal?.aborted === true) throw new Error('the call was canceled before the sidecar started')

  return await new Promise((resolve, reject) => {
    const child = execFile(python, [SIDECAR], {
      timeout: 60000,
      windowsHide: true,
      // Inline base64 payloads: a 640k-px PNG is well under 1 MiB, so 64 MiB
      // leaves generous headroom for several concurrent calls.
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (error !== null && error !== undefined && error.killed === true) {
        reject(new Error('the screen sidecar timed out after 60s'))
        return
      }
      const out = String(stdout ?? '').trim()
      if (out.length === 0) {
        const detail = String(stderr ?? '').trim() || (error?.message ?? 'no output')
        reject(new Error(`the screen sidecar produced no output: ${detail.slice(0, 500)}`))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(out)
      } catch {
        reject(new Error(`the screen sidecar returned unreadable output: ${out.slice(0, 500)}`))
        return
      }
      if (parsed?.ok !== true) {
        reject(new Error(String(parsed?.error ?? 'the screen sidecar reported an unknown failure')))
        return
      }
      resolve(parsed)
    })

    const onAbort = () => child.kill()
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request), 'utf8')
  })
}

// ---------------------------------------------------------------------------
// Screenshot -> model context
// ---------------------------------------------------------------------------

function shotPath() {
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dir = join(base, 'screen-agent')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'desktop.png')
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits))
}

function describe(meta, action) {
  if (action === 'zoom') {
    const width = round(meta.nx1 - meta.nx0)
    const height = round(meta.ny1 - meta.ny0)
    const quality = meta.lossless
      ? 'full native resolution, nothing lost'
      : `downscaled x${round(meta.scale)} because the rectangle exceeded the ${IMAGE_PIXEL_BUDGET} px budget`
    return `Crop of the ${meta.desktopWidth}x${meta.desktopHeight} desktop: nx ${round(meta.nx0)}-${round(meta.nx1)}, ny ${round(meta.ny0)}-${round(meta.ny1)} (${meta.cropWidth}x${meta.cropHeight} px, ${quality}). `
      + `To click inside this view: nx = ${round(meta.nx0)} + nxLocal*${width}, ny = ${round(meta.ny0)} + nyLocal*${height}.`
  }
  return `Full desktop ${meta.desktopWidth}x${meta.desktopHeight} (all monitors). `
    + 'Click with screen_click using nx/ny as a fraction of this image: 0,0 is top-left, 1,1 is bottom-right.'
}

function describeWindow(meta) {
  const parts = [
    `Window "${meta.title}" (${meta.hwnd}), ${meta.windowWidth}x${meta.windowHeight} at (${meta.windowLeft},${meta.windowTop}).`,
    meta.focused === true
      ? 'It is in the foreground.'
      : 'It could NOT be brought to the foreground.',
  ]
  if (meta.clickedAt !== undefined) {
    parts.push(`Clicked ${meta.clickedAt.button} x${meta.clickedAt.clicks} at window fraction (${round(meta.clickedAt.nx)},${round(meta.clickedAt.ny)}).`)
  }
  if (meta.typed !== undefined) {
    const sent = []
    if (meta.typed.keysPressed > 0) sent.push(`${meta.typed.keysPressed} key combination(s)`)
    if (meta.typed.characters > 0) sent.push(`${meta.typed.characters} character(s)`)
    if (meta.typed.enter === true) sent.push('Enter')
    parts.push(`Sent ${sent.length > 0 ? sent.join(' + ') : 'nothing'} to the window.`)
  }
  if (meta.imageWidth !== undefined) {
    parts.push(meta.captureMethod === 'printwindow'
      ? 'Captured with PrintWindow, which reads the window surface directly, so an occluding window does not appear.'
      : 'Captured from the screen after raising the window (PrintWindow was unavailable for it).')
    parts.push(`Click inside this image with screen_window nx/ny: fractions of the window rectangle, 0,0 top-left, 1,1 bottom-right. A crop of at most ${IMAGE_PIXEL_BUDGET} px arrives lossless; this one is ${meta.lossless === true ? 'lossless' : `downscaled x${round(meta.scale)}`}.`)
  }
  return parts.join(' ')
}

/** Decode the inline PNG payload from a sidecar response. */
function decodePayload(meta) {
  const base64 = meta.pngBase64
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error('the screen sidecar returned no image payload')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) throw new Error('the screen sidecar returned an empty image payload')
  return bytes
}

/** Text-only fallback: the screenshot still lands on disk and is named. */
function textFallback(bytes, note, reason) {
  const out = shotPath()
  writeFileSync(out, bytes)
  return { kind: 'text', note: `${note} ${reason} The screenshot was saved to ${out}.`, path: out }
}

/** Whether the active model route declares image input (so an image is useful). */
async function routeAcceptsImages(ctx, exec) {
  try {
    const llm = ctx.get('llm')
    if (llm === undefined) return true
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (provider === undefined || model === undefined) return true
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (info?.inputModalities === undefined) return true
    return info.inputModalities.includes('image') === true
  } catch {
    return true
  }
}

/**
 * Run one image-producing sidecar action and turn it into a canonical tool value.
 * @returns `{ kind: 'image', image, note }` or a text fallback carrying the path.
 */
async function imageValue(ctx, exec, request, describeFn = describe) {
  const meta = await runSidecar({ ...request, inline: true }, exec?.signal)
  const bytes = decodePayload(meta)
  const note = describeFn(meta, request.action)

  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    return textFallback(bytes, note, 'No attachment store is mounted, so no image reached model context.')
  }
  if (!(await routeAcceptsImages(ctx, exec))) {
    return textFallback(bytes, note, 'The active model route declares no image input, so no image reached model context.')
  }

  const refs = await attachments.saveImages([{
    data: new Uint8Array(bytes),
    mediaType: 'image/png',
    name: request.name ?? 'screen.png',
  }])
  return { kind: 'image', image: refs[0], note }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Shared output contract
// ---------------------------------------------------------------------------

const SCREENSHOT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['image', 'text'] },
      note: { type: 'string' },
      path: { type: 'string' },
      image: { type: 'object', additionalProperties: true },
    },
    required: ['kind', 'note'],
    additionalProperties: false,
  },
  render: (_args, value) => {
    const blocks = []
    if (value?.kind === 'image' && value.image !== undefined) {
      blocks.push({ type: 'image', attachment: value.image })
    }
    blocks.push({ type: 'text', text: String(value?.note ?? '') })
    return blocks
  },
}

/** Key-combination parameter shared by the text-capable tools. */
const KEY_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: 'Key combinations to press in order before any text, e.g. ["esc"], ["ctrl+z"], ["f3", "enter"]. A modifier may prefix a key with "+": ctrl, shift, alt, win. Letters, digits, F1-F24, and names like esc/tab/enter/space/home/end/delete/arrows are accepted.',
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const lookTool = {
  name: 'screen_look',
  description: 'Screenshot the full desktop (all monitors) and return it as an image. Address spots on it with normalized nx/ny coordinates.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  output: SCREENSHOT_OUTPUT,
  async execute(_args, exec, ctx) {
    return await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
  },
}

const zoomTool = {
  name: 'screen_zoom',
  description: `Crop a region of the desktop at native resolution and return it as an image. Use it to read small text or find small controls that a full screenshot renders too coarsely. A crop of at most ${IMAGE_PIXEL_BUDGET} px arrives lossless; larger ones are downscaled.`,
  parameters: {
    type: 'object',
    properties: {
      nx0: { type: 'number', description: 'Left edge as a fraction of screen width, 0 (left) to 1 (right).' },
      ny0: { type: 'number', description: 'Top edge as a fraction of screen height, 0 (top) to 1 (bottom).' },
      nx1: { type: 'number', description: 'Right edge; must exceed nx0.' },
      ny1: { type: 'number', description: 'Bottom edge; must exceed ny0.' },
    },
    required: ['nx0', 'ny0', 'nx1', 'ny1'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    return await imageValue(ctx, exec, {
      action: 'zoom',
      nx0: args.nx0,
      ny0: args.ny0,
      nx1: args.nx1,
      ny1: args.ny1,
      name: 'crop.png',
    })
  },
}

const windowsTool = {
  name: 'screen_windows',
  description: 'List visible top-level windows in z-order (topmost first) with an index, title, size, position, and state. Use it to choose the window for screen_window.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  output: SCREENSHOT_OUTPUT,
  async execute(_args, exec) {
    const meta = await runSidecar({ action: 'windows' }, exec?.signal)
    const lines = Array.isArray(meta.lines) ? meta.lines : []
    const header = `${meta.count} visible top-level window(s), topmost first. `
      + 'Pass an index, a title substring, or an hwnd to screen_window. Indices shift as windows are raised, so prefer a title substring when you act on one.'
    return { kind: 'text', note: `${header}\n${lines.join('\n')}` }
  },
}

const windowTool = {
  name: 'screen_window',
  description: 'Focus one window, optionally click or type inside it, then return a screenshot of that window alone. Works while the window is occluded, unlike screen_look. Pass nx/ny only to click; pass text only to type.',
  parameters: {
    type: 'object',
    properties: {
      window: {
        oneOf: [{ type: 'integer' }, { type: 'string' }],
        description: 'Window to act on: an index from screen_windows, a title substring, or an hwnd like 0x00123456.',
      },
      focus: { type: 'boolean', description: 'Bring the window to the foreground first; defaults to true.' },
      nx: { type: 'number', description: 'Horizontal position to click, as a fraction of the window rectangle, 0 to 1.' },
      ny: { type: 'number', description: 'Vertical position to click, as a fraction of the window rectangle, 0 to 1.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for nx/ny; defaults to left.' },
      clicks: { type: 'integer', description: 'Click count for nx/ny; defaults to 1.' },
      text: { type: 'string', description: 'Text to type into the focused window.' },
      keys: KEY_PARAM,
      enter: { type: 'boolean', description: 'Press Enter after the text; defaults to false.' },
      capture: { type: 'boolean', description: 'Return a screenshot of the window; defaults to true.' },
    },
    required: ['window'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const request = {
      action: 'window',
      window: args.window,
      focus: args.focus !== false,
      capture: args.capture !== false,
    }
    if (args.nx !== undefined && args.ny !== undefined) {
      request.nx = args.nx
      request.ny = args.ny
      request.button = args.button ?? 'left'
      request.clicks = args.clicks ?? 1
    }
    if (args.text !== undefined || args.keys !== undefined) {
      request.text = args.text
      request.keys = args.keys
      request.enter = args.enter === true
    }

    if (request.capture === false) {
      const meta = await runSidecar(request, exec?.signal)
      return { kind: 'text', note: describeWindow(meta) }
    }
    return await imageValue(ctx, exec, request, describeWindow)
  },
}

const moveTool = {
  name: 'screen_move',
  description: 'Move the cursor to a position WITHOUT pressing anything, then return a screenshot. Use it to place the cursor and let the UI settle before measuring or before an in-place click.',
  parameters: {
    type: 'object',
    properties: {
      nx: { type: 'number', description: 'Horizontal position as a fraction of screen width, 0 (left) to 1 (right).' },
      ny: { type: 'number', description: 'Vertical position as a fraction of screen height, 0 (top) to 1 (bottom).' },
      capture: { type: 'boolean', description: 'Return a screenshot after moving; defaults to true.' },
    },
    required: ['nx', 'ny'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const meta = await runSidecar({ action: 'move', nx: args.nx, ny: args.ny }, exec?.signal)
    const note = `Cursor placed at desktop (${meta.cursorX},${meta.cursorY}); nothing was pressed.`
      + (meta.warning === undefined ? '' : ` ${meta.warning}.`)
    if (args.capture === false) return { kind: 'text', note }

    // Give hover states and popup repositioning time to settle before reading
    // the screen back, otherwise the screenshot shows the pre-move frame.
    await sleep(250)
    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${note} ${shot.note}` }
  },
}

const keyTool = {
  name: 'screen_key',
  description: 'Send key combinations to the focused window (Esc, Tab, arrows, Enter, F1-F24, ctrl/shift/alt/win combos), then return a screenshot. Prefer this over any mouse tool when the target application has a shortcut: keyboard actions do not depend on where anything is on screen.',
  parameters: {
    type: 'object',
    properties: {
      keys: KEY_PARAM,
      delayMs: { type: 'integer', description: 'Milliseconds to wait after each combination; defaults to 0. Raise it when a UI needs time to react between steps.' },
      capture: { type: 'boolean', description: 'Return a verification screenshot; defaults to true.' },
    },
    required: ['keys'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const meta = await runSidecar({
      action: 'key',
      keys: args.keys,
      delayMs: args.delayMs,
    }, exec?.signal)

    const action = `Pressed ${meta.keysPressed} key combination(s) into the focused window.`
    if (args.capture === false) return { kind: 'text', note: action }

    await sleep(350)
    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${action} ${shot.note}` }
  },
}

const clickTool = {
  name: 'screen_click',
  description: 'Press a mouse button, then return a screenshot. Pass nx/ny to move there first. Omit them — or follow a screen_move with move:false — to press exactly where the cursor already is, with no movement between measuring and clicking.',
  parameters: {
    type: 'object',
    properties: {
      nx: { type: 'number', description: 'Horizontal position to move to first, as a fraction of screen width. Omit to press where the cursor already is.' },
      ny: { type: 'number', description: 'Vertical position to move to first, as a fraction of screen height. Omit to press where the cursor already is.' },
      move: { type: 'boolean', description: 'Move the cursor to nx/ny before pressing; defaults to true. Set false to press in place after a screen_move, so nothing shifts in between.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
      clicks: { type: 'integer', description: 'Click count; defaults to 1. Use 2 for a double click.' },
      capture: { type: 'boolean', description: 'Return a verification screenshot; defaults to true.' },
    },
    required: [],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const request = {
      action: 'click',
      button: args.button ?? 'left',
      clicks: args.clicks ?? 1,
    }
    // Forward whichever halves were given: the sidecar rejects a half-supplied
    // coordinate rather than silently pressing wherever the cursor happens to be.
    if (args.nx !== undefined) request.nx = args.nx
    if (args.ny !== undefined) request.ny = args.ny
    if (args.nx !== undefined && args.ny !== undefined) {
      request.move = args.move !== false
    }

    const meta = await runSidecar(request, exec?.signal)
    const where = meta.inPlace === true
      ? `in place at the current cursor (${meta.cursorX},${meta.cursorY})`
      : `${meta.movedCursor === true ? 'after moving to' : 'at'} desktop (${meta.desktopX},${meta.desktopY})`
    const action = `Clicked ${meta.button} x${meta.clicks} ${where}.`
    if (args.capture === false) return { kind: 'text', note: action }

    await sleep(350)
    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${action} ${shot.note}` }
  },
}

const elementsTool = {
  name: 'screen_elements',
  description: 'List a window\'s elements from the OS accessibility tree, with the actions each element supports and its live state. Prefer this over reading a screenshot whenever the application exposes an accessibility tree: it is immune to DPI scaling, theming and layout drift, costs no image tokens, and pairs with screen_act to operate an element directly. The tree is sampled until two consecutive reads agree, because Chromium and others build it lazily — a single early read returns only the window shell and none of the page. Custom-drawn UIs (Blender and similar) expose nothing — fall back to screen_zoom there.',
  parameters: {
    type: 'object',
    properties: {
      window: {
        oneOf: [{ type: 'integer' }, { type: 'string' }],
        description: 'Window to inspect: an index from screen_windows, a title substring, or an hwnd like 0x00123456.',
      },
      filter: { type: 'string', description: 'Only return elements whose name contains this text.' },
      limit: { type: 'integer', description: 'Maximum elements to return; defaults to 200.' },
    },
    required: ['window'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec) {
    const meta = await runSidecar({
      action: 'elements',
      window: args.window,
      filter: args.filter,
      limit: args.limit,
    }, exec?.signal)

    const lines = (meta.elements ?? []).map((element) => {
      const id = element.automationId ? ` aid=${element.automationId}` : ''
      const acts = Array.isArray(element.patterns) && element.patterns.length > 0
        ? ` [${element.patterns.join(',')}]`
        : ''
      const state = []
      if (element.enabled === false) state.push('disabled')
      if (element.offscreen === true) state.push('offscreen')
      if (element.focused === true) state.push('focused')
      if (element.toggleState !== undefined && element.toggleState !== '') state.push(String(element.toggleState).toLowerCase())
      if (element.expandState !== undefined && element.expandState !== '') state.push(String(element.expandState).toLowerCase())
      if (element.selected === true) state.push('selected')
      if (element.value !== undefined && element.value !== '') state.push(`value="${element.value}"`)
      const mark = state.length > 0 ? ` {${state.join(' ')}}` : ''
      const where = element.nx !== undefined ? ` (${element.nx}, ${element.ny})` : ''
      return `${element.role}${id} "${element.name}"${acts}${mark}${where}`
    })

    const stability = meta.stable === true
      ? ''
      : ` The tree had not settled after ${meta.rounds} sample(s), so this list may be incomplete — read it again.`
    const header = meta.count === 0
      ? `No accessibility elements in "${meta.window}" — this app draws its own UI, so use screen_zoom plus coordinates instead.${stability}`
      : `${meta.count} element(s) in "${meta.window}". Format: role [aid=...] "name" [actions] {state} (nx, ny). Act on one with screen_act (name/automationId/role), or pass its nx/ny to screen_click.${stability}`
    return { kind: 'text', note: `${header}\n${lines.join('\n')}` }
  },
}

const actTool = {
  name: 'screen_act',
  description: 'Act on an element reported by screen_elements through that element\'s own accessibility action — invoke, set_value, toggle, expand, select — instead of clicking a coordinate. Select it by automationId, name and/or role. The action lands exactly on the control, needs no screenshot and never moves the cursor. On Windows it does raise the target window to the foreground (there is no background element delivery in Windows), so the foreground is handed back to the previously active window afterwards unless keepFocus is set. A screen_elements snapshot taken before the change may no longer match: if the element is reported missing, take a fresh snapshot.',
  parameters: {
    type: 'object',
    properties: {
      window: {
        oneOf: [{ type: 'integer' }, { type: 'string' }],
        description: 'Window holding the element: an index from screen_windows, a title substring, or an hwnd like 0x00123456.',
      },
      elementAction: {
        type: 'string',
        enum: ['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll_into_view', 'focus'],
        description: 'invoke = activate a button/menu item; set_value = write text into an edit field (needs value); toggle = flip a checkbox; select = select a list/tab item; expand/collapse = open or close a tree or combo item; scroll_into_view = bring an offscreen element into view; focus = give it keyboard focus.',
      },
      name: { type: 'string', description: 'Element name, as printed by screen_elements. Exact matches win over substring matches.' },
      automationId: { type: 'string', description: 'Element automation id (aid=... in screen_elements output). The most precise selector when present.' },
      role: { type: 'string', description: 'Element role, e.g. Button, Edit, CheckBox. Narrows the match when several elements share a name.' },
      occurrence: { type: 'integer', description: 'Which match to use, 1-based; defaults to 1. screen_elements prints the same order.' },
      value: { type: 'string', description: 'Text to write; required by set_value.' },
      keepFocus: { type: 'boolean', description: 'Leave the target window in the foreground afterwards; defaults to false, which hands it back.' },
      capture: { type: 'boolean', description: 'Return a verification screenshot afterwards; defaults to true.' },
    },
    required: ['window', 'elementAction'],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const meta = await runSidecar({
      action: 'act',
      window: args.window,
      elementAction: args.elementAction,
      name: args.name,
      automationId: args.automationId,
      role: args.role,
      occurrence: args.occurrence,
      value: args.value,
      keepFocus: args.keepFocus === true,
    }, exec?.signal)

    const target = meta.automationId
      ? `${meta.role} "${meta.name}" (${meta.automationId})`
      : `${meta.role} "${meta.name}"`
    const parts = [`${meta.elementAction} on ${target}: ${meta.outcome}.`]
    if (typeof meta.matched === 'number' && meta.matched > 1) {
      parts.push(`${meta.matched} elements matched that selector, so occurrence ${meta.occurrence} was used.`)
    }
    parts.push(meta.focusRestored
      ? 'The foreground was handed back to the previously active window.'
      : 'The target window now holds the foreground.')
    parts.push('A delivered action is not proof of the outcome; check the result in a fresh screen_elements or screenshot before relying on it.')
    const note = parts.join(' ')
    if (args.capture === false) return { kind: 'text', note }

    await sleep(350)
    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${note} ${shot.note}` }
  },
}

const waitTool = {
  name: 'screen_wait',
  description: 'Wait for the screen to change, or for it to stop changing, instead of sleeping a fixed guess. Use it after an action that triggers loading or animation.',
  parameters: {
    type: 'object',
    properties: {
      for: {
        type: 'string',
        enum: ['change', 'stable'],
        description: '"change" waits for any visible change; "stable" waits until the screen stops changing. Defaults to change.',
      },
      timeoutMs: { type: 'integer', description: 'Give up after this many milliseconds; defaults to 10000.' },
      intervalMs: { type: 'integer', description: 'Poll interval in milliseconds; defaults to 250.' },
      capture: { type: 'boolean', description: 'Also return a screenshot of the settled state; defaults to false.' },
    },
    required: [],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const meta = await runSidecar({
      action: 'wait',
      for: args.for,
      timeoutMs: args.timeoutMs,
      intervalMs: args.intervalMs,
    }, exec?.signal)

    const what = meta.mode === 'change' ? 'changed' : 'settled'
    const note = meta.settled
      ? `Screen ${what} after ${meta.elapsedMs} ms (${meta.polls} poll(s)).`
      : `Timed out after ${meta.elapsedMs} ms: the screen never ${what} (${meta.polls} poll(s)).`
    if (args.capture !== true) return { kind: 'text', note }

    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${note} ${shot.note}` }
  },
}

const typeTool = {
  name: 'screen_type',
  description: 'Send keys and/or text to the focused window, then return a fresh screenshot showing the result. Use keys for Escape, Tab, arrows, function keys, and modifier combos, which plain text cannot express.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to type. A newline presses Enter.' },
      keys: KEY_PARAM,
      enter: { type: 'boolean', description: 'Press Enter after the text; defaults to false.' },
      capture: { type: 'boolean', description: 'Return a verification screenshot; defaults to true.' },
    },
    required: [],
    additionalProperties: false,
  },
  output: SCREENSHOT_OUTPUT,
  async execute(args, exec, ctx) {
    const meta = await runSidecar({
      action: 'type',
      text: args.text,
      keys: args.keys,
      enter: args.enter === true,
    }, exec?.signal)

    const parts = []
    if (meta.keysPressed > 0) parts.push(`Pressed ${meta.keysPressed} key combination(s)`)
    if (meta.characters > 0) parts.push(`typed ${meta.characters} character(s)`)
    if (meta.enter === true) parts.push('pressed Enter')
    const action = `${parts.length > 0 ? parts.join(', ') : 'Sent nothing'} into the focused window.`
    if (args.capture === false) return { kind: 'text', note: action }

    await sleep(350)
    const shot = await imageValue(ctx, exec, { action: 'capture', name: 'desktop.png' })
    return { ...shot, note: `${action} ${shot.note}` }
  },
}

// ---------------------------------------------------------------------------
// First-turn tool anchoring
// ---------------------------------------------------------------------------

/**
 * Tool names this plugin owns.
 * @type {readonly string[]}
 */
export const OWN_TOOL_NAMES = [
  'screen_look',
  'screen_zoom',
  'screen_windows',
  'screen_window',
  'screen_elements',
  'screen_act',
  'screen_move',
  'screen_click',
  'screen_key',
  'screen_type',
  'screen_wait',
]

/**
 * The tool surface, released in stages rather than all at once.
 *
 * Every schema costs prefill on each request, and a large menu also makes the
 * choice harder. The stages follow the order a task actually happens in, which
 * is also this plugin's routing philosophy (keyboard, then accessibility tree,
 * then screenshot + coordinates):
 *
 *   0  look       — before the session has called anything at all
 *   1  read       — once it is demonstrably in a tool-using loop: see closer,
 *                   list windows, read the element tree, wait, and press keys
 *   2  actuate    — once it has actually used a stage-1 tool, i.e. it has looked
 *                   or read something first: pointer coordinates and element
 *                   actions
 *
 * Stage 2 deliberately follows a real read. Acting on coordinates without
 * having looked, or on an element that was never listed, is how mis-clicks
 * happen.
 *
 * @type {readonly string[][]}
 */
export const TOOL_TIERS = [
  ['screen_look'],
  ['screen_zoom', 'screen_windows', 'screen_window', 'screen_elements', 'screen_wait', 'screen_key'],
  ['screen_move', 'screen_click', 'screen_type', 'screen_act'],
]

/**
 * The one tool visible before the session has made any tool call.
 *
 * Every tool schema this plugin registers costs real prefill on the first
 * request, which is the most expensive one (no cache to hit) and the one that
 * sets the trajectory. Before the first tool call the model only needs the way
 * in — looking — so the rest of this plugin's surface is withheld until the
 * session is demonstrably in a tool-using loop.
 */
export const ANCHOR_TOOL = 'screen_look'

/** Set DSH_SCREEN_AGENT_STAGING=off to release the whole surface after one call. */
function stagingEnabled() {
  return process.env.DSH_SCREEN_AGENT_STAGING !== 'off'
}

/**
 * Which of this plugin's tools the session may see, given what it has called.
 *
 * Pure and exported so the policy can be tested without a live session.
 *
 * @param calls - names of every tool the session has already called.
 * @returns the set of visible tool names.
 */
export function visibleToolsFor(calls) {
  const called = Array.isArray(calls) ? calls : []
  if (called.length === 0) return new Set(TOOL_TIERS[0])
  if (!stagingEnabled()) return new Set(TOOL_TIERS.flat())
  const usedReading = called.some((name) => TOOL_TIERS[1].includes(name))
  const stages = usedReading ? TOOL_TIERS.length : 2
  return new Set(TOOL_TIERS.slice(0, stages).flat())
}

/**
 * Which of this plugin's tools the session must NOT see yet.
 *
 * This value goes into `ctx.tools.restrict({ deny })`. The tool registry has one
 * visibility resolver that feeds schema presentation, `tools.get()` and dispatch
 * alike, so a tool withheld this way is consistently absent — unlike filtering
 * the assembled prompt, which only thinned the model's copy of the list while
 * the tool stayed callable and stayed visible to `Tool.listTools`.
 *
 * An empty result means nothing is withheld (and `restrict` rejects an empty
 * filter, so callers must skip the call in that case).
 *
 * Pure and exported so the policy can be tested without a live session.
 *
 * @param calls - names of every tool the session has already called.
 * @returns the tool names to deny, in registration order.
 */
export function withheldToolsFor(calls) {
  const visible = visibleToolsFor(calls)
  return OWN_TOOL_NAMES.filter((name) => !visible.has(name))
}

/**
 * Tool names a session has already called, read from its own log.
 *
 * `snapshotEvents()` — not an `events` property, which does not exist — is the
 * session log, and it includes fork-inherited history, which is exactly what the
 * model has already seen. That makes it the honest input for "has this session
 * used a tool yet".
 *
 * @param session - the agent's session.
 * @returns called tool names, possibly empty.
 */
function callsOf(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  if (!Array.isArray(events)) return []
  return events
    .filter((event) => event?.type === 'tool/call')
    // A session event carries its payload under `data` — dsh-session's own
    // invariant reads `event.data.turn` / `event.data.step` — so the tool name
    // is `event.data.name`, NOT `event.name`. Reading the wrong field yields an
    // empty name, which silently pins the session at stage 1 forever.
    .map((event) => String(event?.data?.name ?? ''))
    .filter((name) => name.length > 0)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // Warm the interpreter probe in the background so the first tool call does
  // not pay for it.
  void ensurePython().catch(() => {})

  const tools = [
    [lookTool, 'screen_look'],
    [zoomTool, 'screen_zoom'],
    [windowsTool, 'screen_windows'],
    [windowTool, 'screen_window'],
    [elementsTool, 'screen_elements'],
    [actTool, 'screen_act'],
    [moveTool, 'screen_move'],
    [clickTool, 'screen_click'],
    [keyTool, 'screen_key'],
    [typeTool, 'screen_type'],
    [waitTool, 'screen_wait'],
  ]
  for (const [tool, label] of tools) {
    // Every registration rides ctx.effect so a fiber dispose (hot reload,
    // uninject) unregisters it with no residue.
    ctx.effect(() => ctx.tools.register({
      ...tool,
      execute: (args, exec) => tool.execute(args, exec, ctx),
    }), `@dsh-external/dsh-screen-agent: ${label}`)
  }

  // Staged release of this plugin's tools, one agent at a time.
  //
  // `ctx.tools.restrict()` is the supported mechanism: the registry resolves
  // visibility once, so a denied tool disappears from the model's schema, from
  // `tools.get()`, and from dispatch together. The previous implementation
  // filtered `system-prompt/assemble` instead, which only thinned the model's
  // copy of the list — the tool remained callable and `Tool.listTools` still
  // reported all eleven.
  //
  // Registrations made through `agent.ctx` are NOT disposed when this plugin
  // unloads, so every per-agent disposer is held here as well.
  const stagedAgents = new Map()

  const stageAgent = (agent) => {
    if (agent === undefined || agent.ctx === undefined) return
    stagedAgents.get(agent.id)?.()
    stagedAgents.delete(agent.id)

    const dispose = agent.ctx.effect(function* () {
      let lift = null
      const sync = () => {
        if (lift !== null) { lift(); lift = null }
        const deny = withheldToolsFor(callsOf(agent.session))
        // An empty filter is rejected, so nothing to do once every stage is open.
        if (deny.length === 0) return
        try {
          lift = agent.ctx.tools.restrict({ deny })
        } catch {
          // A name the registry does not know (a partially failed load) or a
          // scope without a tools service must not break the agent.
          lift = null
        }
      }
      sync()
      // Re-evaluate when this session logs a call, which is what opens the next
      // stage. Registering on agent.ctx scopes the listener to this agent.
      const sessionId = agent.session?.id
      yield ctx.on('session/event', (session, event) => {
        // Compare by id when both sides expose one: the event can hand back a
        // different wrapper for the same session. Recomputing is idempotent, so
        // an unknown id is preferable to silently dropping the event.
        if (sessionId !== undefined && session?.id !== undefined && session.id !== sessionId) return
        if (event?.type !== 'tool/call') return
        sync()
      })
      yield () => { if (lift !== null) { lift(); lift = null } }
    }, 'staged tool release')
    stagedAgents.set(agent.id, dispose)
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    stageAgent(agent)
  }), '@dsh-external/dsh-screen-agent: staged release')

  // Cover agents that already exist when this plugin activates — on hot reload,
  // or when a profile patch adds it mid-session. Without this the staging would
  // silently apply to no one until each session restarted.
  ctx.inject(['agents'], (agentsCtx) => {
    for (const agent of agentsCtx.agents.list()) stageAgent(agent)
  })

  // Unloading this plugin must lift every restriction it placed.
  ctx.effect(() => () => {
    for (const dispose of stagedAgents.values()) {
      try { dispose() } catch { /* teardown must not throw */ }
    }
    stagedAgents.clear()
  }, '@dsh-external/dsh-screen-agent: staged release teardown')
}
