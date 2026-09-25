/**
 * client-harness.mjs — 主题轨道 client.js 的测试底座。
 *
 * client.js 经 build.mjs 拼接注入常量（THEME_FAMILIES / React）后由 __ModuleLoader__ 加载。
 * 本文件在 Node 里复刻该注入（`const THEME_FAMILIES = ...; const React = ...`），并配合
 * fake document / localStorage / ctx / themeService / slots，使测试能够走**真实入口**驱动主题轨道：
 *
 *   1. `apply(ctx)` — 官方 Cordis 生命周期入口（注入 CSS、建立 theme service 引用、启动恢复、
 *      注册 settings.general.item slot、挂停止钩子）；
 *   2. slot 里注册的 Gallery 组件 — 点击真实卡片按钮触发 activateFamily。
 *
 * 生产代码不暴露任何测试注入面（旧的测试专用全局钩子已随皮肤轨道一并删除），测试因此
 * 不能再直接调内部函数；这也是本底座改为「渲染真实组件 + 触发真实 onClick」的原因。
 *
 * React 为最小 no-reconciler stub：createElement 造出纯净的对象树，useState 把状态写进
 * hook 槽（setState 不自动重渲染），useEffect 按 deps 判等只跑一次。测试用 `render()` 显式
 * 重渲染以观察状态变化后的 UI。
 */

import { readFile } from 'node:fs/promises'

const ROOT = new URL('../../', import.meta.url) // plugin root
const readText = (rel) => readFile(new URL(rel, ROOT), 'utf8')

/** null-safe localStorage stub。 */
export function createStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    _map: store,
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
    clear() { store.clear() },
  }
}

/** fake theme service：overrideTokens(source, tokens) 记录调用并返回可逆 disposer。 */
export function createThemeService() {
  const overrides = []
  return {
    overrides,
    overrideTokens(source, tokens) {
      let active = true
      overrides.push({ source, tokens })
      return () => {
        if (!active) return
        active = false
        const i = overrides.findIndex((o) => o.tokens === tokens)
        if (i >= 0) overrides.splice(i, 1)
      }
    },
  }
}

/** fake slots service：inject 立即调用注册函数，register 记录 meta + 组件。 */
export function createSlotsService() {
  const registered = []
  return {
    registered,
    inject(_target, fn) { return typeof fn === 'function' ? fn() : undefined },
    register(meta, component) { registered.push({ meta, component }); return () => {} },
  }
}

/** 从 themes.curated.js 提取 THEME_FAMILIES 数组（该文件为纯常量定义，以 `]` 收束）。 */
export function extractFamilies(src) {
  const m = src.match(/const THEME_FAMILIES = (\[[\s\S]*\])/)
  if (!m) throw new Error('无法解析 THEME_FAMILIES')
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)()
}

// ---- 最小 DOM（只覆盖 client.js 用到的部分：createElement / head.appendChild / remove） ----
function makeElement(tag) {
  const attrs = new Map()
  const node = {
    tag,
    parentNode: null,
    children: [],
    textContent: '',
    setAttribute(k, v) { attrs.set(k, String(v)); node.attributes.set(k, String(v)) },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null },
    hasAttribute(k) { return attrs.has(k) },
    removeAttribute(k) { attrs.delete(k); node.attributes.delete(k) },
    appendChild(el) { el.parentNode = node; node.children.push(el); return el },
    remove() {
      const p = node.parentNode
      if (p) {
        const i = p.children.indexOf(node)
        if (i >= 0) p.children.splice(i, 1)
        node.parentNode = null
      }
    },
    attributes: attrs,
  }
  return node
}

export function createDocument() {
  return {
    head: makeElement('head'),
    body: makeElement('body'),
    title: 'DSH',
    createElement: (tag) => makeElement(tag),
  }
}

// ---- React stub ----
const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

export function createReact() {
  let hooks = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const i = cursor++
      if (i >= hooks.length) hooks.push({ state: typeof initial === 'function' ? initial() : initial })
      const slot = hooks[i]
      return [slot.state, (value) => { slot.state = typeof value === 'function' ? value(slot.state) : value }]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = hooks[i]
      if (prev === undefined || !deps || !depsEqual(prev.deps, deps)) {
        hooks[i] = { deps }
        fn()
      }
    },
  }
  return { React, render: (component, props) => { cursor = 0; return component(props) } }
}

// ---- 元素树遍历助手（渲染结果断言用） ----
/** 收集树中所有满足谓词的元素节点。 */
export function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node.type !== 'undefined' && predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

/** 拼接节点下的全部文本。 */
export function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join(' ')
  return (node.children || []).map(flattenText).join(' ')
}

/**
 * 组装并执行 client.js，返回 apply 后的轨道 API。
 * @param {object} opts
 *  - familiesOverride / storageOverride：替换主题族 / localStorage
 *  - services：{ theme: boolean, slots: boolean } 控制 ctx.get 返回 undefined（降级路径测试）
 */
export async function loadClient(opts = {}) {
  const {
    familiesOverride = null,
    storageOverride = null,
    services: serviceOverride = null,
  } = opts
  const services = { theme: true, slots: true, ...(serviceOverride || {}) }

  const families = familiesOverride ?? extractFamilies(await readText('src/themes.curated.js'))
  const storage = storageOverride ?? createStorage()
  const doc = createDocument()
  const { React, render: renderComponent } = createReact()

  const prior = { storage: globalThis.localStorage, document: globalThis.document }
  globalThis.localStorage = storage
  globalThis.document = doc

  // 与 build.mjs 相同的注入：THEME_FAMILIES 常量 + React 依赖 + client 源码，末尾取 module.exports。
  const source = await readText('src/client.js')
  const code = `const THEME_FAMILIES = ${JSON.stringify(families)};\nconst React = __REACT__;\n${source}\nreturn { apply };\n`
  // eslint-disable-next-line no-new-func
  const exported = new Function('__REACT__', code)(React)

  const theme = createThemeService()
  const slots = createSlotsService()
  const disposers = []
  const ctx = {
    get(name) {
      if (name === 'theme') return services.theme ? theme : undefined
      if (name === 'slots') return services.slots ? slots : undefined
      return undefined
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    _disposeAll() { for (let i = disposers.length - 1; i >= 0; i--) { try { disposers[i]() } catch {} } disposers.length = 0 },
  }

  // 触发插件 apply：注入 CSS、建立 theme service 引用、启动恢复、注册 slot、挂停止钩子。
  await exported.apply(ctx)

  const entry = slots.registered.find((item) => item.meta && item.meta.id === 'theme-gallery')
  let tree = null
  const render = () => { tree = entry ? renderComponent(entry.component, {}) : null; return tree }

  /** 当前渲染出的主题卡片（真实 button 节点 + 可点击）。 */
  const cards = () => findAll(tree, (node) => {
    if (node.type !== 'button') return false
    return String((node.props && node.props.className) || '').includes('theme-gallery-card')
  }).map((node) => {
    const nameNode = findAll(node, (n) => n.props && n.props.className === 'theme-gallery-name')[0]
    return {
      label: nameNode ? flattenText(nameNode) : '',
      active: String(node.props.className).includes('is-active'),
      pressed: node.props['aria-pressed'],
      click: () => node.props.onClick(),
    }
  })

  /** 按 family id 或 label 片段点击真实卡片，并重渲染。 */
  const pick = (key) => {
    const family = families.find((f) => f.id === key) || families.find((f) => f.label.includes(key))
    if (family === undefined) throw new Error(`unknown family: ${key}`)
    const card = cards().find((c) => c.label === family.label)
    if (card === undefined) throw new Error(`family card not rendered: ${family.label}`)
    card.click()
    render()
    return family
  }

  /** 在搜索框输入并重渲染，返回新的卡片列表。 */
  const search = (value) => {
    const input = findAll(tree, (node) => node.type === 'input')[0]
    if (input === undefined) throw new Error('search input not rendered')
    input.props.onChange({ target: { value } })
    render()
    return cards()
  }

  return {
    families,
    apply: exported.apply,
    document: doc,
    storage,
    theme,
    slots,
    ctx,
    disposers,
    render,
    cards,
    pick,
    search,
    tree: () => tree,
    /** apply 注册的 style 元素（data-theme-gallery 标记）。 */
    styleTags: () => doc.head.children.filter((el) => el.tag === 'style' && el.hasAttribute('data-theme-gallery')),
    cleanup() {
      globalThis.localStorage = prior.storage
      globalThis.document = prior.document
    },
  }
}
