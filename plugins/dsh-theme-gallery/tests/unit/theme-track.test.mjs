/**
 * theme-track.test.mjs — 主题轨道端到端行为测试。
 *
 * 走真实入口（apply + slot 注册的 Gallery 组件）验证：
 *   - 启动恢复：localStorage 的 theme-gallery-family-v5 → overrideTokens 覆盖；
 *   - token 覆盖契约：overrideTokens('dsh-theme-gallery', family.tokens)，明暗交给官方解析；
 *   - UI 选择：15 张卡片、点击切换、搜索结果、aria 状态；
 *   - slot 注册：settings.general.item / id=theme-gallery / order=11；
 *   - 停止与重启：override 与注入 style 归零、可再 apply；
 *   - 无文档级副作用：不碰 document.body / document.title（皮肤轨道已移除，这里是回归护栏）。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, createStorage, findAll } from './client-harness.mjs'

const active = []
afterEach(() => { while (active.length) active.pop().cleanup?.() })

async function boot(opts = {}) {
  const h = await loadClient(opts)
  active.push(h)
  h.render()
  return h
}

const SCOPE = 'dsh-theme-gallery'
const STORAGE_FAMILY = 'theme-gallery-family-v5'
const familyOf = (h, id) => h.families.find((f) => f.id === id)

describe('主题轨道 — 启动恢复 / token 覆盖', () => {
  test('storage=terracotta → apply 后用该族 tokens 调 overrideTokens(dsh-theme-gallery, …)', async () => {
    const h = await boot({ storageOverride: createStorage({ [STORAGE_FAMILY]: 'terracotta' }) })
    assert.equal(h.theme.overrides.length, 1, '恰好一层 override')
    assert.equal(h.theme.overrides[0].source, SCOPE, 'source 标识为本插件')
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'terracotta').tokens, '应用的是恢复出的族 tokens')
  })

  test('每个 token 都是 { light, dark } 成对字符串（明暗由官方 service 解析）', async () => {
    const h = await boot()
    const tokens = h.theme.overrides[0].tokens
    assert.equal(Object.keys(tokens).length, 24, '24 个 token 名')
    for (const [name, modes] of Object.entries(tokens)) {
      assert.match(name, /^--dsw-(alias|specific)-/, `${name} 属于官方 token 命名空间`)
      assert.equal(typeof modes.light, 'string', `${name}.light`)
      assert.equal(typeof modes.dark, 'string', `${name}.dark`)
      assert.ok(modes.light.length > 0 && modes.dark.length > 0, `${name} 明暗值非空`)
    }
  })

  test('storage 缺失 → 回退 jade 并写入 storage', async () => {
    const h = await boot({ storageOverride: createStorage({}) })
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'jade').tokens)
    assert.equal(h.storage.getItem(STORAGE_FAMILY), 'jade')
  })

  test('storage 非法 → 回退 jade（不抛错、不空 override）', async () => {
    const h = await boot({ storageOverride: createStorage({ [STORAGE_FAMILY]: 'nope' }) })
    assert.equal(h.theme.overrides.length, 1)
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'jade').tokens)
  })

  test('theme service 缺失 → apply 静默返回，不注册 slot、不抛错', async () => {
    const h = await boot({ services: { theme: false } })
    assert.equal(h.theme.overrides.length, 0)
    assert.equal(h.slots.registered.length, 0)
    assert.equal(h.tree(), null)
  })

  test('slots service 缺失 → apply 静默返回，不抛错', async () => {
    const h = await boot({ services: { slots: false } })
    assert.equal(h.theme.overrides.length, 0)
    assert.equal(h.slots.registered.length, 0)
  })
})

describe('主题轨道 — UI 选择', () => {
  test('渲染 15 张卡片，默认选中 jade 且仅一张 active/aria-pressed', async () => {
    const h = await boot()
    const cards = h.cards()
    assert.equal(cards.length, 15, '15 个主题族各一张卡')
    const pressed = cards.filter((c) => c.pressed === true)
    assert.equal(pressed.length, 1, '仅一张卡 aria-pressed=true')
    assert.ok(pressed[0].label.includes('翠玉'), '默认选中 jade（翠玉）')
    assert.ok(pressed[0].active)
  })

  test('点击陶土卡片 → override 换成陶土 tokens、持久化、高亮跟随', async () => {
    const h = await boot()
    h.pick('陶土')
    assert.equal(h.theme.overrides.length, 1, '切换后仍只有一层 override')
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'terracotta').tokens)
    assert.equal(h.storage.getItem(STORAGE_FAMILY), 'terracotta')
    const cards = h.cards()
    const activeCards = cards.filter((c) => c.active)
    assert.equal(activeCards.length, 1)
    assert.ok(activeCards[0].label.includes('陶土'), '高亮跟随新选择')
    assert.equal(activeCards[0].pressed, true)
  })

  test('连续切换不累积 override（旧层被 disposer 清退）', async () => {
    const h = await boot()
    h.pick('jade')
    h.pick('starlight')
    h.pick('紫雾')
    assert.equal(h.theme.overrides.length, 1, '始终只有一层 override')
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'lilac-mist').tokens)
    assert.equal(h.storage.getItem(STORAGE_FAMILY), 'lilac-mist')
  })

  test('按 id 或 label 片段都能选中（UI 卡片与数据一致）', async () => {
    const h = await boot()
    h.pick('amber-retro')
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'amber-retro').tokens)
    h.pick('天际')
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'horizon').tokens)
  })

  test('搜索过滤：命中 1 张卡；无命中渲染空态且无卡片可点', async () => {
    const h = await boot()
    const hit = h.search('翠玉')
    assert.equal(hit.length, 1)
    assert.ok(hit[0].label.includes('翠玉'))

    const none = h.search('zzz-no-such-theme')
    assert.equal(none.length, 0)
    const empty = findAll(h.tree(), (n) => String((n.props && n.props.className) || '').includes('theme-gallery-empty'))
    assert.equal(empty.length, 1, '渲染「没有匹配的主题」空态')
    assert.equal(findAll(h.tree(), (n) => n.type === 'input').length, 1, '搜索框仍在')
  })

  test('搜索大小写与 id 同样可命中', async () => {
    const h = await boot()
    assert.equal(h.search('MONOCHROME').length, 1)
    assert.equal(h.search('blush').length, 1)
  })
})

describe('主题轨道 — slot 注册与样式', () => {
  test('注册 settings.general.item / id=theme-gallery / order=11', async () => {
    const h = await boot()
    assert.equal(h.slots.registered.length, 1)
    assert.deepEqual(h.slots.registered[0].meta, { name: 'settings.general.item', id: 'theme-gallery', order: 11 })
    assert.equal(typeof h.slots.registered[0].component, 'function')
  })

  test('注入唯一带 data-theme-gallery 标记的 style，且不含轨道切换/皮肤规则', async () => {
    const h = await boot()
    assert.equal(h.styleTags().length, 1)
    const css = h.styleTags()[0].textContent
    assert.match(css, /\.theme-gallery-card/)
    assert.doesNotMatch(css, /theme-gallery-tab/, '皮肤/轨道 tab 样式已移除')
    assert.doesNotMatch(css, /data-dsh-|body\[/, '无 body 作用域规则')
  })

  test('渲染树里没有轨道 tab（只剩单一主题轨道）', async () => {
    const h = await boot()
    const tabs = findAll(h.tree(), (n) => String((n.props && n.props.className) || '').includes('theme-gallery-tab'))
    assert.equal(tabs.length, 0)
  })
})

describe('主题轨道 — 停止 / 重启 / 无文档级副作用', () => {
  test('停止钩子清退 override 与注入 style', async () => {
    const h = await boot()
    assert.equal(h.theme.overrides.length, 1)
    assert.equal(h.styleTags().length, 1)
    h.ctx._disposeAll()
    assert.equal(h.theme.overrides.length, 0, '主题 override 已清退')
    assert.equal(h.styleTags().length, 0, '注入 style 已移除')
  })

  test('停止后可重新 apply，恢复同一主题族且不重复覆盖', async () => {
    const h = await boot()
    h.pick('eclipse')
    h.ctx._disposeAll()
    assert.equal(h.theme.overrides.length, 0)

    await h.apply(h.ctx)
    h.render()
    assert.equal(h.theme.overrides.length, 1)
    assert.deepEqual(h.theme.overrides[0].tokens, familyOf(h, 'eclipse').tokens)
  })

  test('全程不碰 document.body / document.title（无文档级状态）', async () => {
    const h = await boot()
    h.pick('azure')
    assert.equal(h.document.body.attributes.size, 0, 'body 无任何属性写入')
    assert.equal(h.document.body.children.length, 0, 'body 无任何子节点插入')
    assert.equal(h.document.title, 'DSH', 'document.title 未被改写')
  })
})
