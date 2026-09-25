/**
 * themes.test.mjs — 主题族目录（src/themes.curated.js）的结构与合规护栏。
 *
 * 主题轨道的正确性依赖两件事，这里逐条守住：
 *   1. 每个族对**每个** token 都提供 `{ light, dark }` 成对值 —— 明暗完全交给官方
 *      theme service 解析，缺一半就会在某种外观下漏出上一种主题的颜色。
 *   2. 用到的 token 名必须都是官方包认识的名字 —— `overrideTokens(source, tokens)` 的
 *      tokens 类型是 `ThemeTokenOverrides = Record<string, ThemeTokenModes>`，
 *      `ThemeTokenModes = { light: string; dark: string }`；写错名字的 token 不会生效，
 *      但也不会报错，所以必须在测试里拦住。
 *
 * OFFICIAL_TOKENS 由官方包 `@deepseek-ai/dsh-client-ui-theme`（lib/client.js 的 token 表）
 * 实测核对：该表共 110 个 `--dsw-*` 名字，本目录只使用其中 24 个。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { extractFamilies } from './client-harness.mjs'

const FAMILY_COUNT = 15

/** 官方包中存在的 token 名（本插件实际使用的 24 个）。 */
const OFFICIAL_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]

const source = await readFile(new URL('../../src/themes.curated.js', import.meta.url), 'utf8')
const families = extractFamilies(source)

describe('主题族目录', () => {
  test(`恰好 ${FAMILY_COUNT} 个族，id 与 label 均唯一`, () => {
    assert.equal(families.length, FAMILY_COUNT)
    assert.equal(new Set(families.map((f) => f.id)).size, FAMILY_COUNT, 'id 唯一')
    assert.equal(new Set(families.map((f) => f.label)).size, FAMILY_COUNT, 'label 唯一')
  })

  test('id 为 kebab-case，label 形如「中文名 / English」', () => {
    for (const family of families) {
      assert.match(family.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${family.id} 为 kebab-case`)
      assert.match(family.label, /^\S.* \/ \S.*$/, `${family.id} label 含中英文`)
    }
  })

  test('gallery 保留 jade 作默认族（localStorage 缺省回退）', () => {
    assert.equal(families[0].id, 'jade')
  })

  test('每个族都有 light / dark 预览色（卡片双色块）', () => {
    for (const family of families) {
      assert.ok(family.preview, `${family.id} 有 preview`)
      for (const mode of ['light', 'dark']) {
        const preview = family.preview[mode]
        assert.ok(preview, `${family.id}.preview.${mode}`)
        assert.match(preview.background, /^#[0-9a-fA-F]{3,8}$/, `${family.id}.preview.${mode}.background`)
        assert.match(preview.accent, /^#[0-9a-fA-F]{3,8}$/, `${family.id}.preview.${mode}.accent`)
      }
    }
  })

  test('15 个族使用完全相同的 token 名集合（明暗切换不丢 token）', () => {
    const reference = Object.keys(families[0].tokens).sort()
    for (const family of families) {
      assert.deepEqual(Object.keys(family.tokens).sort(), reference, `${family.id} token 集与 jade 一致`)
    }
  })

  test('每个 token 都提供非空的 { light, dark } 字符串', () => {
    for (const family of families) {
      for (const [name, modes] of Object.entries(family.tokens)) {
        assert.equal(typeof modes, 'object', `${family.id}/${name} 为对象`)
        assert.equal(typeof modes.light, 'string', `${family.id}/${name}.light`)
        assert.equal(typeof modes.dark, 'string', `${family.id}/${name}.dark`)
        assert.ok(modes.light.length > 0, `${family.id}/${name}.light 非空`)
        assert.ok(modes.dark.length > 0, `${family.id}/${name}.dark 非空`)
      }
    }
  })

  test('token 名全部存在于官方 token 表（写错名字不会报错，必须在这里拦住）', () => {
    const official = new Set(OFFICIAL_TOKENS)
    for (const family of families) {
      for (const name of Object.keys(family.tokens)) {
        assert.ok(official.has(name), `${family.id} 使用了非官方 token 名：${name}`)
      }
    }
  })

  test('目录文件不含皮肤轨道数据（无 body 属性 / skin 清单）', () => {
    assert.doesNotMatch(source, /bodyAttr|__SKIN_|skinId|data-dsh-/)
  })
})
