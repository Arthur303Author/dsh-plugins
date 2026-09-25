// no-data-loss regression test for dsh-memory: proves remember(replace:) and forget never remove hand-written prose, an unmatched entry, or a note whose body has its own `## ` subheading.
// Run: node tests/data-loss.test.mjs   (exit 0 = all assertions pass)
// Temporary no-data-loss verification for dsh-memory.
//
// Boots the plugin against a fake ctx whose fs service implements the
// @deepseek-ai/dsh-fs contract (realpath-ish resolve, stat/version tokens,
// atomic-feeling writeText/editText with a stale-version guard and an
// observation requirement for edits), then drives remember/forget over a
// memory file that contains hand-written prose plus a note whose own body
// carries a `## ` subheading — the exact shape that used to shred a file.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const mod = await import(new URL('../index.js', import.meta.url).href);
const { apply } = mod;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};
const assertEq = (label, actual, expected) => {
  const ok = actual === expected;
  check(label, ok, ok ? '' : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
};

// ---------------------------------------------------------------- fake fs

class FakeFs {
  versions = new Map();
  observed = new Map();
  serial = 0;

  key(path) {
    const absolute = resolvePath(path);
    let ancestor = absolute;
    const missing = [];
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      missing.unshift(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
    const real = resolvePath(ancestor);
    return missing.length === 0 ? real : join(real, ...missing);
  }

  versionOf(key) {
    try {
      const info = statSync(key);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return undefined;
    }
  }

  async resolve(path) {
    const key = this.key(path);
    return { targetKey: key, displayPath: key };
  }

  async stat(target) {
    const version = this.versionOf(target.targetKey);
    if (version === undefined) return undefined;
    const info = statSync(target.targetKey);
    return { version, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size };
  }

  async readText(target) {
    return readFileSync(target.targetKey, 'utf8');
  }

  async listDir(target) {
    const { readdirSync } = await import('node:fs');
    return readdirSync(target.targetKey).map((name) => ({
      name,
      type: statSync(join(target.targetKey, name)).isDirectory() ? 'directory' : 'file',
      target: { targetKey: join(target.targetKey, name), displayPath: join(target.targetKey, name) },
    }));
  }

  async writeText(target, content, expected) {
    const current = this.versionOf(target.targetKey);
    if (expected?.kind === 'createIfAbsent' && current !== undefined) {
      throw Object.assign(new Error('already exists'), { code: 'FS_NOT_OBSERVED' });
    }
    if (expected?.kind === 'replaceIfVersion' && expected.version !== current) {
      throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
    }
    mkdirSync(dirname(target.targetKey), { recursive: true });
    const before = current === undefined ? null : readFileSync(target.targetKey, 'utf8');
    writeFileSync(target.targetKey, content, 'utf8');
    // mtime granularity can hide a same-millisecond rewrite; the serial suffix keeps versions distinct.
    this.serial += 1;
    return { operation: current === undefined ? 'create' : 'update', version: `${this.versionOf(target.targetKey)}#${this.serial}`, before, after: content };
  }

  async editText(target, edit, expected) {
    const seen = this.observed.get(target.targetKey);
    if (seen === undefined) throw Object.assign(new Error('not observed'), { code: 'FS_NOT_OBSERVED' });
    if (seen.kind === 'absent') throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
    if (expected !== undefined && expected.version !== seen.version) {
      throw Object.assign(new Error('stale guard'), { code: 'FS_STALE_VERSION' });
    }
    const before = readFileSync(target.targetKey, 'utf8');
    const first = before.indexOf(edit.oldString);
    if (first === -1) throw Object.assign(new Error('edit not found'), { code: 'FS_EDIT_NOT_FOUND' });
    if (!edit.replaceAll && before.indexOf(edit.oldString, first + 1) !== -1) {
      throw Object.assign(new Error('ambiguous edit'), { code: 'FS_AMBIGUOUS_EDIT' });
    }
    const after = before.slice(0, first) + edit.newString + before.slice(first + edit.oldString.length);
    writeFileSync(target.targetKey, after, 'utf8');
    this.serial += 1;
    return { version: `${this.versionOf(target.targetKey)}#${this.serial}`, before, after };
  }
}

// ------------------------------------------------------------------- boot

const tools = new Map();
const fs = new FakeFs();
const ctx = {
  fs,
  tools: { register: (definition) => tools.set(definition.name, definition) },
  emit: (event, target, observation) => {
    if (event === 'fs/observed') fs.observed.set(target.targetKey, observation);
  },
  effect: () => () => {},
};

const workspace = join(tmpdir(), `dsh-memory-verify-${process.pid}`);
const memoryDir = join(workspace, 'memory');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(memoryDir, { recursive: true });

apply(ctx, { userDir: memoryDir });
// Registered identifiers must not change.
check('tools registered (remember/recall/forget)', [...tools.keys()].sort().join(',') === 'forget,recall,remember', [...tools.keys()].join(','));

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } };
const call = (name, args) => tools.get(name).execute(args, exec);

// ------------------------------------------- ① parameters are really validated

check('remember: missing `content` rejected', await call('remember', {}).then(() => false, (error) => error.name === 'ToolArgsError'), '');
check('remember: wrong `content` type rejected', await call('remember', { content: 42 }).then(() => false, (error) => error.name === 'ToolArgsError'));
check('recall: string maxChars rejected', await call('recall', { maxChars: '5000' }).then(() => false, (error) => error.name === 'ToolArgsError'));
check('recall: invalid scope rejected', await call('recall', { scope: 'everything' }).then(() => false, (error) => error.name === 'ToolArgsError'));
check('forget: missing `query` rejected', await call('forget', {}).then(() => false, (error) => error.name === 'ToolArgsError'));

// --------------------------------------- ② hand-written prose + tricky entry

const categoryFile = join(memoryDir, 'memory-notes.md');
const indexFile = join(memoryDir, 'memory.md');

const PREAMBLE = [
  '# 笔记',
  '',
  '手工说明：这一行是用户自己写的，任何 remember/forget 都不许动它。',
  '',
].join('\n');

// Legacy entry (old format: bare `## ` heading) — `replace` targets this one.
const LEGACY_ENTRY = [
  '## 2025-01-01 legacy',
  '- 旧格式条目：目标内容 LEGACY-TARGET 在这里。',
  '- 第二行。',
  '',
].join('\n');

// Fenced entry whose OWN BODY contains a `## ` subheading — `forget` targets this one.
const FENCED_ENTRY = [
  '## 2026-02-02 计划',
  '<!-- dsh-memory:entry -->',
  '- 多行笔记：DOOMED-MARKER 这一条要被删掉。',
  '## 这是笔记正文里的子标题，不是新条目',
  '- 子标题下面还有一行内容，也必须跟着一起删。',
  '<!-- /dsh-memory:entry -->',
  '',
].join('\n');

const SUFFIX = '手工尾部注释：这一段也必须原样保留。\n';

const originalFile = `${PREAMBLE}${LEGACY_ENTRY}${FENCED_ENTRY}${SUFFIX}`;
writeFileSync(categoryFile, originalFile, 'utf8');
writeFileSync(
  indexFile,
  ['# 记忆索引', '', '手工索引说明：保留我。', '', '- notes=memory-notes.md', ''].join('\n'),
  'utf8',
);

const beforeRead = await call('recall', { scope: 'user' });
check('initial recall sees both entries', beforeRead.entryCount === 2, `entryCount=${beforeRead.entryCount}`);

// replace: only the legacy entry's own span may change.
const replaced = await call('remember', {
  topic: 'notes',
  content: '修正后的内容 REPLACED-BODY。',
  replace: 'LEGACY-TARGET',
  scope: 'user',
});
check('replace hit exactly one entry', replaced.replaced === true && replaced.entryCount === 2, JSON.stringify(replaced));

const afterReplace = readFileSync(categoryFile, 'utf8');
check('[replace] preamble preserved verbatim', afterReplace.startsWith(PREAMBLE));
check('[replace] fenced entry preserved verbatim', afterReplace.includes(FENCED_ENTRY.trimEnd()));
check('[replace] trailing hand-written note preserved', afterReplace.endsWith(SUFFIX));
check('[replace] old legacy body gone', !afterReplace.includes('LEGACY-TARGET'));
check('[replace] new body present', afterReplace.includes('REPLACED-BODY'));

// forget: only the fenced entry's span may go, subheading and all.
console.log('\n--- category file BEFORE forget ---\n' + JSON.stringify(readFileSync(categoryFile, 'utf8')) + '\n---\n');
const forgotten = await call('forget', { query: 'DOOMED-MARKER', scope: 'user' });
check('forget removed exactly one entry', forgotten.removed === 1 && forgotten.remaining === 1, JSON.stringify(forgotten));

const afterForget = readFileSync(categoryFile, 'utf8');
console.log('\n--- category file after forget ---\n' + JSON.stringify(afterForget) + '\n---\n');
check('[forget] preamble still preserved verbatim', afterForget.startsWith(PREAMBLE));
check('[forget] trailing hand-written note still preserved', afterForget.endsWith(SUFFIX));
check('[forget] fenced entry fully removed (subheading included)', !afterForget.includes('子标题') && !afterForget.includes('DOOMED-MARKER'));
check('[forget] untouched entry still intact', afterForget.includes('REPLACED-BODY'));
check('[forget] no entry was shredded into a headless fragment', !afterForget.includes('## 这是笔记正文里的子标题'));

const finalRead = await call('recall', { scope: 'user' });
check('final recall reports one entry', finalRead.entryCount === 1, `entryCount=${finalRead.entryCount}`);

// index: the hand-written line must survive a new category being added.
const indexBefore = readFileSync(indexFile, 'utf8');
await call('remember', { topic: 'brand-new-topic', content: '新分类的一条笔记。', scope: 'user' });
const indexAfter = readFileSync(indexFile, 'utf8');
console.log('\n--- index before ---\n' + JSON.stringify(indexBefore) + '\n--- index after ---\n' + JSON.stringify(indexAfter) + '\n---\n');
check('[index] hand-written index prose preserved', indexAfter.includes('手工索引说明：保留我。'));
check('[index] original line preserved', indexAfter.includes('- notes=memory-notes.md'));
check('[index] new line appended', indexAfter.includes('- brand-new-topic=memory-brand-new-topic.md'));
check('[index] old prefix untouched', indexAfter.startsWith(indexBefore.trimEnd()));

// append to an existing category: still only a tail append.
const beforeAppend = readFileSync(categoryFile, 'utf8');
const appended = await call('remember', { topic: 'notes', content: '追加的一条笔记。', scope: 'user' });
const afterAppend = readFileSync(categoryFile, 'utf8');
check('append reports 2 entries', appended.entryCount === 2, `entryCount=${appended.entryCount}`);
check('[append] previous content preserved verbatim', afterAppend.startsWith(beforeAppend.trimEnd()));
check('[append] preamble preserved verbatim', afterAppend.startsWith(PREAMBLE));
check('[append] new entry present', afterAppend.includes('追加的一条笔记。'));

// new category file gets the fenced format.
const brandNew = readFileSync(join(memoryDir, 'memory-brand-new-topic.md'), 'utf8');
check('[new file] entry is fenced', brandNew.includes('<!-- dsh-memory:entry -->') && brandNew.includes('<!-- /dsh-memory:entry -->'));
check('[new file] keeps the documented `## <date> <topic>` heading shape', /^## \d{4}-\d{2}-\d{2} brand-new-topic$/m.test(brandNew));

// backwards compatibility: a pure legacy file still parses and can be forgotten.
const legacyOnly = join(memoryDir, 'memory-legacy-only.md');
writeFileSync(legacyOnly, '# 老文件\n\n## 2025-03-03 a\n- keep me\n\n## 2025-04-04 b\n- delete me\n', 'utf8');
const legacyForget = await call('forget', { query: 'delete me', scope: 'user' });
check('legacy file: one entry removed', legacyForget.removed === 1, JSON.stringify(legacyForget));
const legacyAfter = readFileSync(legacyOnly, 'utf8');
check('legacy file: untouched entry intact', legacyAfter.includes('- keep me'));
check('legacy file: removed entry gone', !legacyAfter.includes('delete me'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
