import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('.', import.meta.url)
const id = 'dsh-theme-gallery'

/** 去除 ESM `export`/`export default` 前缀，使其可内联进 CJS factory。 */
function stripExports(source) {
  return source
    .replace(/^export\s+default\s+/gm, 'return ')
    .replace(/^export\s+/gm, '')
    .replace(/\bexport\s*\{[^}]*\}\s*$/gm, '')
}

const catalog = await readFile(new URL('./src/themes.curated.js', root), 'utf8')
const source = await readFile(new URL('./src/client.js', root), 'utf8')

const output = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n  var module = { exports: {} }; var exports = module.exports;\n  const React = require('react');\n// ---- curated theme families (token track, build-time embedded) ----\n${catalog}\n// ---- plugin client ----\n${stripExports(source)}\n  module.exports = { apply };\n  return module.exports;\n} });\n`

const outFile = new URL('./lib/client.js', root)
await mkdir(new URL('./lib/', root), { recursive: true })
await writeFile(outFile, output)

if (process.argv.includes('--check')) {
  const generated = await readFile(outFile, 'utf8')
  if (!generated.includes('window.__ModuleLoader__.load')) throw new Error('client wrapper missing')
  if (!generated.includes('module.exports = { apply }')) throw new Error('client export missing')
  if (!generated.includes('const THEME_FAMILIES = [')) throw new Error('theme catalog not embedded')
  const familyCount = (generated.match(/"id":"[a-z0-9-]+"/g) || []).length
  if (familyCount !== 15) throw new Error(`theme family metadata missing (found ${familyCount}, expected 15)`)
  if (!generated.includes('overrideTokens')) throw new Error('theme token override path missing')
  // 回归护栏：产物里不得残留皮肤轨道的任何痕迹。
  for (const banned of ['__SKIN_', 'skin-engine', 'skin-a11y', 'document.body', 'document.title', 'favicon', 'dshRetro', '__TG_', 'skins/']) {
    if (generated.includes(banned)) throw new Error(`skin-track leftover in build output: ${banned}`)
  }
}

const bytes = (await stat(outFile)).size
console.log(`built ${fileURLToPath(outFile)} (${(bytes / 1024).toFixed(1)} KB, 15 theme families, theme track only)`)
