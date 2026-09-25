/**
 * client.js — dsh-theme-gallery 浏览器端插件（仅主题轨道）。
 *
 * 单一轨道：token 覆盖型主题画廊（15 个主题族）。
 *   主题族经官方主题服务 `themeService.overrideTokens('dsh-theme-gallery', family.tokens)`
 *   覆盖 `--dsw-alias-*` token，注册在设置页的 `settings.general.item` slot。
 *
 * 明暗完全交给 DSH 原生「外观」设置（浅色 / 深色 / 跟随系统）：每个 token 都以
 * `{ light, dark }` 成对提供，由官方 theme service 按当前外观解析。
 * 本插件不读取、也不改写任何文档级状态：只往 head 里挂一个自己拥有的
 * `<style data-theme-gallery>`（停止时移除），不加页面 body 属性、不改文档标题、
 * 不动图标，也不触碰宿主或其它插件的 DOM。
 *
 * 数据（build.mjs 内联为常量）：THEME_FAMILIES — 主题族清单。
 */

// ---- localStorage ----
const STORAGE_FAMILY = 'theme-gallery-family-v5'

function readStored(key, fallback = '') {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value) } catch {}
}

// ---- 主题轨道状态 ----
let activeThemeService = null // apply 阶段注入
let removeOverride = null // 当前 override 的 disposer
let selectedFamily = initialFamily()

const listeners = new Set()
const notify = () => { for (const listener of listeners) listener(selectedFamily) }
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }

function initialFamily() {
  const stored = readStored(STORAGE_FAMILY, 'jade')
  return THEME_FAMILIES.some((item) => item.id === stored) ? stored : 'jade'
}

/** 清除当前主题 override（若有）。幂等。 */
function clearThemeOverride() {
  if (removeOverride) { removeOverride(); removeOverride = null }
}

/** 选择主题族：替换 override、持久化、通知 UI。 */
const activateFamily = (familyId) => {
  const family = THEME_FAMILIES.find((item) => item.id === familyId) || THEME_FAMILIES[0]
  selectedFamily = family.id
  if (removeOverride) removeOverride()
  removeOverride = activeThemeService.overrideTokens('dsh-theme-gallery', family.tokens)
  writeStored(STORAGE_FAMILY, selectedFamily)
  notify()
}

const CSS = `
  .theme-gallery-root { display: grid; gap: 11px; padding: 4px 0; }
  .theme-gallery-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .theme-gallery-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
  .theme-gallery-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
  .theme-gallery-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }
  .theme-gallery-search { box-sizing: border-box; width: 100%; height: 34px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; outline: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
  .theme-gallery-search:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
  .theme-gallery-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; max-height: 300px; overflow: auto; padding: 2px; contain: content; }
  .theme-gallery-card { display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 8px; min-width: 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; text-align: left; }
  .theme-gallery-card:hover { border-color: var(--dsw-alias-brand-primary); }
  .theme-gallery-card.is-active { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); }
  .theme-gallery-swatches { display: grid; grid-template-columns: 1fr 1fr; width: 30px; height: 22px; overflow: hidden; border-radius: 6px; border: 1px solid rgba(127,127,127,.3); }
  .theme-gallery-swatch { position: relative; min-width: 0; }
  .theme-gallery-swatch span { position: absolute; right: 2px; bottom: 3px; width: 7px; height: 7px; border-radius: 50%; }
  .theme-gallery-copy { min-width: 0; display: grid; gap: 2px; }
  .theme-gallery-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .theme-gallery-meta { color: var(--dsw-alias-label-secondary); font-size: 10px; }
  .theme-gallery-empty { padding: 14px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-secondary); text-align: center; font-size: 12px; }
  @media (max-width: 900px) { .theme-gallery-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 680px) { .theme-gallery-grid { grid-template-columns: 1fr; } }
`

function apply(ctx) {
  const themeService = ctx.get('theme')
  const slots = ctx.get('slots')
  if (themeService === undefined || slots === undefined) return
  activeThemeService = themeService

  // 启动时应用已保存的主题族（默认 jade）。
  activateFamily(selectedFamily)

  // 插件停止：清退主题 override。
  ctx.effect(() => () => clearThemeOverride())

  function Gallery() {
    const [family, setFamily] = React.useState(selectedFamily)
    const [query, setQuery] = React.useState('')
    React.useEffect(() => subscribe(setFamily), [])

    const normalized = query.trim().toLowerCase()
    const visibleFamilies = THEME_FAMILIES.filter((item) => !normalized || (item.label + ' ' + item.id).toLowerCase().includes(normalized))

    return React.createElement('div', { className: 'theme-gallery-root' },
      React.createElement('div', { className: 'theme-gallery-heading' },
        React.createElement('div', { className: 'theme-gallery-title' }, '精选外观'),
        React.createElement('div', { className: 'theme-gallery-count' }, visibleFamilies.length + ' / ' + THEME_FAMILIES.length + ' 主题'),
      ),
      React.createElement('div', { className: 'theme-gallery-hint' }, '明暗模式由 DSH 的“外观”设置统一控制；选择“跟随系统”时主题会自动切换。'),
      React.createElement('input', { className: 'theme-gallery-search', type: 'search', value: query, placeholder: '搜索主题…', 'aria-label': '搜索主题', onChange: (e) => setQuery(e.target.value) }),
      visibleFamilies.length === 0
        ? React.createElement('div', { className: 'theme-gallery-empty' }, '没有匹配的主题')
        : React.createElement('div', { className: 'theme-gallery-grid' }, ...visibleFamilies.map((item) =>
            React.createElement('button', { key: item.id, type: 'button', className: 'theme-gallery-card' + (family === item.id ? ' is-active' : ''), 'aria-pressed': family === item.id, onClick: () => activateFamily(item.id) },
              React.createElement('span', { className: 'theme-gallery-swatches' },
                React.createElement('span', { className: 'theme-gallery-swatch', style: { background: item.preview.light.background } }, React.createElement('span', { style: { background: item.preview.light.accent } })),
                React.createElement('span', { className: 'theme-gallery-swatch', style: { background: item.preview.dark.background } }, React.createElement('span', { style: { background: item.preview.dark.accent } })),
              ),
              React.createElement('span', { className: 'theme-gallery-copy' },
                React.createElement('span', { className: 'theme-gallery-name' }, item.label),
                React.createElement('span', { className: 'theme-gallery-meta' }, '跟随 DSH 外观'),
              ),
            ),
          )),
    )
  }

  ctx.effect(() => {
    const element = document.createElement('style')
    element.setAttribute('data-theme-gallery', '')
    element.textContent = CSS
    document.head.appendChild(element)
    return () => element.remove()
  })

  slots.inject('settings.general.item', () => slots.register(
    { name: 'settings.general.item', id: 'theme-gallery', order: 11 },
    Gallery,
  ))
}
