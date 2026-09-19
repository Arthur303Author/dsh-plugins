// dsh-memory — categorized persistent memory for DeepSeek Harness.
//
// Registers three tools (remember / recall / forget) that store notes as
// plain editable markdown, organized by CATEGORY instead of one flat file:
//
//   <memory-dir>/memory.md          the INDEX: one "slug=filename" line per category
//   <memory-dir>/memory-<slug>.md   one file per category (the notes themselves)
//
// remember(content, topic, scope) looks the topic up in the index (slugified),
// appends to that category file, and adds a new index line when the category
// is new — so a fresh note lands next to the notes it belongs with instead of
// in one ever-growing list. recall/forget walk the index + category files.
// This mirrors how Claude Code keeps a top-level index plus topic files.
//
// Storage:
//   user scope    $DSH_HOME/memory/            (~/.dsh/memory/)
//   project scope <workspace>/.dsh/            (cwd at launch)
//
// Dependency-free (node builtins only), registered as raw JSON-Schema tools,
// the same developer-preview path the modsearch plugin uses.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';

export const name = 'memory';
export const inject = ['tools'];

const DEFAULT_USER_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory');
const DEFAULT_USER_FILE = 'memory.md';
const DEFAULT_PROJECT_FILE = join(process.cwd(), '.dsh', 'memory.md');
const DEFAULT_MAX_CHARS = 12000;
const TIMEOUT_MS = 15000;

/** Slug for a category name (keeps CJK, alphanumerics, `_` and `-`). */
function slugify(topic) {
  const s = String(topic ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'general';
}

/** Parse the index file into { slug -> absolute category file path }. */
function readIndex(dir) {
  const file = join(dir, 'memory.md');
  const map = {};
  if (!existsSync(file)) return map;
  const text = readFileSync(file, 'utf8');
  const re = /^-\s*([a-z0-9\u4e00-\u9fff_-]+)\s*=\s*([a-z0-9\u4e00-\u9fff_-]+\.md)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    map[m[1]] = join(dir, m[2]);
  }
  return map;
}

/** Rewrite the index file from the category map. */
function writeIndex(dir, map) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'memory.md');
  const lines = [
    '# 记忆索引',
    '',
    '每个分类一行：`slug=文件名`；分类文件命名为 `memory-<slug>.md`。',
    '',
  ];
  for (const slug of Object.keys(map).sort()) {
    const base = map[slug].split(/[\\/]/).pop();
    lines.push(`- ${slug}=${base}`);
  }
  lines.push('');
  writeFileSync(file, lines.join('\n'), 'utf8');
}

/** Category file path for a slug. */
function categoryFile(dir, slug) {
  return join(dir, `memory-${slug}.md`);
}

/** Append one dated entry to a category file; returns the new entry count. */
function appendEntry(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const lines = content.split('\n').map((line) => `- ${line}`);
  const block = `\n## ${today}\n${lines.join('\n')}\n`;
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const prefix = original === '' || original.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${prefix}${block}`);
  return original === '' ? 1 : splitEntries(original).length + 1;
}

/**
 * Replace the FIRST entry containing `query` (case-insensitive) in place with
 * `content`, keeping the category title and the entry's position. Falls back
 * to appending when the file is missing or no entry matches. Returns
 * `{ replaced, count }`.
 */
function replaceEntry(file, content, query) {
  if (!existsSync(file)) {
    return { replaced: false, count: appendEntry(file, content) };
  }
  const original = readFileSync(file, 'utf8');
  const title = original.match(/^#\s.*$/m);
  const head = title ? title[0].trim() : null;
  const sections = splitEntries(original);
  const q = query.toLowerCase();
  const idx = sections.findIndex((section) => section.toLowerCase().includes(q));
  if (idx === -1) {
    return { replaced: false, count: appendEntry(file, content) };
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = content.split('\n').map((line) => `- ${line}`);
  sections[idx] = `## ${today}\n${lines.join('\n')}`;
  const body = head ? `${head}\n\n${sections.join('\n\n')}` : sections.join('\n\n');
  writeFileSync(file, body.trimEnd() + '\n', 'utf8');
  return { replaced: true, count: sections.length };
}

/** Split a file into "## " headed sections. */
function splitEntries(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return trimmed
    .split(/\n(?=## )/)
    .map((section) => section.trimEnd())
    .filter((section) => section !== '' && !section.startsWith('# '));
}

/** Every category file under a memory dir (index + disk scan). */
function listCategoryFiles(dir) {
  const seen = new Set();
  for (const file of Object.values(readIndex(dir))) {
    if (existsSync(file)) seen.add(file);
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!/^memory-[a-z0-9\u4e00-\u9fff_-]+\.md$/.test(name)) continue;
      seen.add(join(dir, name));
    }
  } catch {
    // dir missing — no category files yet
  }
  return [...seen];
}

export function apply(ctx, config = {}) {
  const userFile = join(config.userDir || DEFAULT_USER_DIR, config.userFileName || DEFAULT_USER_FILE);
  const projectFile = config.projectFile || DEFAULT_PROJECT_FILE;
  const defaultScope = config.defaultScope === 'project' ? 'project' : 'user';
  const dirOf = (scope) => (scope === 'project' ? dirname(projectFile) : dirname(userFile));

  ctx.tools.register({
    name: 'remember',
    description:
      'Save a durable note to persistent memory, organized by category. Notes are plain editable markdown; ' +
      '`topic` is the CATEGORY (e.g. "ui", "plugins", "prefs") and the note is appended to that category file ' +
      '(`memory-<slug>.md`); a new category is added to the memory index (`memory.md`) automatically, and an ' +
      'existing category receives the note in place. `user` scope lives in ~/.dsh/memory/ (shared across projects), ' +
      '`project` scope lives in <workspace>/.dsh/. Recall them later with the recall tool.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'The note to save, as one or more concise complete sentences (e.g. "User prefers tabs over spaces; Python 3.12 is the required runtime.").',
        },
        topic: {
          type: 'string',
          description:
            'Category name for this note (e.g. "ui", "plugins", "prefs", "皮肤", "插件需求"). Notes of the same category accumulate in one file. Defaults to "general".',
        },
        replace: {
          type: 'string',
          description:
            'Optional. When provided, replace the FIRST existing entry containing this text (case-insensitive) in place with `content`, instead of appending. Use it to correct an outdated note. When no entry matches, the note is appended.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'project'],
          description:
            'user = global memory shared across all projects (default); project = this workspace only.',
        },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          scope: { type: 'string' },
          entryCount: { type: 'number' },
          replaced: { type: 'boolean' },
        },
        required: ['ok', 'file'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.ok === false
              ? `remember failed: ${value.file}`
              : value.replaced
                ? `Replaced an entry in ${value.file} (${value.entryCount} entries in this category).`
                : `Saved to ${value.file} (${value.entryCount} entries in this category).`,
        },
      ],
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('remember aborted');
      const content = typeof args?.content === 'string' ? args.content.trim() : '';
      if (content === '') throw new Error('remember needs a non-empty string "content".');
      const scope = args?.scope === 'project' || args?.scope === 'user' ? args.scope : defaultScope;
      const topic = typeof args?.topic === 'string' && args.topic.trim() !== '' ? args.topic.trim() : 'general';
      const replace = typeof args?.replace === 'string' && args.replace.trim() !== '' ? args.replace.trim() : null;
      const slug = slugify(topic);
      const dir = dirOf(scope);
      const map = readIndex(dir);
      let file = map[slug];
      if (file === undefined) {
        file = categoryFile(dir, slug);
        map[slug] = file;
        writeIndex(dir, map);
        if (!existsSync(file)) writeFileSync(file, `# ${topic}\n\n`, 'utf8');
      }
      if (replace !== null) {
        const result = replaceEntry(file, content, replace);
        return { ok: true, file, scope, entryCount: result.count, replaced: result.replaced };
      }
      const entryCount = appendEntry(file, content);
      return { ok: true, file, scope, entryCount, replaced: false };
    },
  });

  ctx.tools.register({
    name: 'recall',
    description:
      'Read back persistent memory, organized by category. Use it at the start of a task when the user\u2019s ' +
      'preferences, setup, or project context may have been saved earlier. Returns the memory index plus every ' +
      'category file; optionally filter with a query (matched per entry). Reads `user` memory (~/.dsh/memory/) and ' +
      '`project` memory (<workspace>/.dsh/).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive keyword to filter entries with (matched against each entry). Omit to return everything.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'project', 'all'],
          description: 'Which memory to read: user, project, or both (default: all).',
        },
        maxChars: {
          type: 'number',
          description: 'Maximum characters of memory to return (default 12000).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          scope: { type: 'string' },
          text: { type: 'string' },
          entryCount: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        required: ['file', 'text'],
      },
      render: (_args, value) => {
        const lines = [`--- memory (${value.entryCount} entries)`];
        if (value.text !== '') lines.push(value.text);
        if (value.truncated) lines.push('… (truncated — narrow the query or raise maxChars)');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    timeoutMs: TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('recall aborted');
      const scope = ['user', 'project'].includes(args?.scope) ? args.scope : 'all';
      const query = typeof args?.query === 'string' && args.query.trim() !== '' ? args.query.trim().toLowerCase() : '';
      const maxChars =
        typeof args?.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
          ? Math.floor(args.maxChars)
          : DEFAULT_MAX_CHARS;
      const dirs = scope === 'all' ? [dirOf('user'), dirOf('project')] : [dirOf(scope)];
      const parts = [];
      let entryCount = 0;
      for (const dir of dirs) {
        const files = [join(dir, 'memory.md'), ...listCategoryFiles(dir)];
        for (const file of files) {
          if (!existsSync(file)) continue;
          let text = readFileSync(file, 'utf8');
          if (query !== '') {
            if (/^memory-[^\\/]+\.md$/.test(file.split(/[\\/]/).pop() ?? '')) {
              const kept = splitEntries(text).filter((entry) => entry.toLowerCase().includes(query));
              text = kept.join('\n\n');
              entryCount += kept.length;
            } else {
              // index file: keep it only when it matches, as context
              text = text.toLowerCase().includes(query) ? text : '';
            }
          } else if (/^memory-[^\\/]+\.md$/.test(file.split(/[\\/]/).pop() ?? '')) {
            entryCount += splitEntries(text).length;
          }
          if (text.trim() !== '') parts.push({ file, text: text.trim() });
        }
      }
      if (parts.length === 0) {
        return {
          file: dirs.join(', '),
          scope,
          text: query === '' ? '(memory is empty — nothing saved yet)' : `(no memory entries match "${query}")`,
          entryCount: 0,
          truncated: false,
        };
      }
      const combined = parts.map((part) => part.text).join('\n\n');
      const truncated = combined.length > maxChars;
      return {
        file: parts.map((part) => part.file).join(', '),
        scope,
        text: truncated ? combined.slice(0, maxChars) : combined,
        entryCount,
        truncated,
      };
    },
  });

  ctx.tools.register({
    name: 'forget',
    description:
      'Delete memory entries whose content matches a query (like Claude\u2019s memory delete). Searches every category ' +
      'file and removes matching entries. Use when the user asks to remove or update an outdated saved fact. ' +
      'Prefer remembering a corrected note right after forgetting the old one.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive text that identifies the entries to remove.',
        },
        scope: {
          type: 'string',
          enum: ['user', 'project'],
          description: 'Which memory to edit: user (default) or project.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          scope: { type: 'string' },
          removed: { type: 'number' },
          remaining: { type: 'number' },
        },
        required: ['removed'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Removed ${value.removed} entr${value.removed === 1 ? 'y' : 'ies'} from ${value.file} (${value.remaining} remain).`,
        },
      ],
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('forget aborted');
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      if (query === '') throw new Error('forget needs a non-empty string "query".');
      const scope = args?.scope === 'project' || args?.scope === 'user' ? args.scope : defaultScope;
      const dir = dirOf(scope);
      const files = listCategoryFiles(dir);
      if (files.length === 0) return { file: dir, scope, removed: 0, remaining: 0 };
      let removed = 0;
      let remaining = 0;
      for (const file of files) {
        if (!existsSync(file)) continue;
        const original = readFileSync(file, 'utf8');
        const sections = splitEntries(original);
        const kept = sections.filter((section) => !section.toLowerCase().includes(query));
        const r = sections.length - kept.length;
        if (r > 0) {
          const title = original.match(/^#\s.*$/m);
          const head = title ? `${title[0].trim()}\n\n` : '';
          writeFileSync(file, head + (kept.length > 0 ? kept.join('\n\n').trimEnd() + '\n' : ''));
        }
        removed += r;
        remaining += kept.length;
      }
      return { file: dir, scope, removed, remaining };
    },
  });
}
