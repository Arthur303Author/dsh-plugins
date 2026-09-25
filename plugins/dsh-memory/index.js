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
// Storage goes through ctx.fs, never node:fs: atomic writes, stale-version
// guards, sandbox policy and `fs/observed` broadcasts are the service's job.
//   user scope    $DSH_HOME/memory/            (~/.dsh/memory/)
//   project scope <session workspace>/.dsh/    (exec.agent.session.header.cwd)
//
// Entry format. Every entry is wrapped in an explicit, human-invisible fence,
// so an entry boundary can never be confused with a `## ` subheading inside a
// note's own body:
//
//   ## 2026-08-15 ui
//   <!-- dsh-memory:entry -->
//   - the note's first line
//   - the note's second line
//   <!-- /dsh-memory:entry -->
//
// Files written by older versions (bare `## ` sections) are still parsed; such
// an entry is upgraded to the fenced form only when it is actually touched.
// Every mutation is an append or a literal span edit, and the index only ever
// gains a line — no operation rewrites a whole file, so hand-written prose
// between entries (and in the index) is never lost.

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'memory';
export const inject = ['tools', 'fs'];

/** Deployment-level configuration of the memory store. */
export const Config = z.object({
  userDir: z.string(),
  userFileName: z.string(),
  projectFile: z.string(),
  defaultScope: z.union(['user', 'project']),
});

const DEFAULT_USER_FILE = 'memory.md';
const DEFAULT_MAX_CHARS = 12000;
const TIMEOUT_MS = 15000;

/** Fence opening one entry block. */
const ENTRY_BEGIN = '<!-- dsh-memory:entry -->';
/** Fence closing one entry block. */
const ENTRY_END = '<!-- /dsh-memory:entry -->';
/** Entry fence on its own line: `[1]` = opening, `[2]` = closing. */
const FENCE_LINE = /^<!--\s*(\/?)\s*dsh-memory:entry\s*-->\s*$/;
/** Legacy entry boundary: a `## ` heading at the start of a line. */
const HEADING_LINE = /^##\s/;
/** A top-level title line, never an entry. */
const TITLE_LINE = /^#\s/;
/** One `- slug=file.md` index line. */
const INDEX_LINE = /^-\s*([a-z0-9\u4e00-\u9fff_-]+)\s*=\s*([a-z0-9\u4e00-\u9fff_.-]+\.md)\s*$/;
/** A category file name (`memory.md` itself is the index, not a category). */
const CATEGORY_FILE = /^memory-[a-z0-9\u4e00-\u9fff_-]+\.md$/;

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

/** Today's date as the entry heading stamp (`YYYY-MM-DD`). */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Expand a leading `~` and make a configured path absolute. */
function expandPath(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error('dsh-memory: configured path must be a non-empty string');
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? join(homedir(), raw.slice(1))
    : raw;
  return resolvePath(expanded);
}

/** The session workspace root for one tool call, or undefined for a non-agent caller. */
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd;
}

/** Guarantee exactly one trailing newline, so an edit's oldString is a prefix. */
function withTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Add the blank separator an appended block needs. */
function appendBlock(text, block) {
  if (text === '') return `${block}\n`;
  return `${withTrailingNewline(text)}${text.endsWith('\n\n') ? '' : '\n'}${block}\n`;
}

/**
 * Reduce a before/after pair to the literal replacement that turns the former
 * into the latter — or `undefined` when the change cannot be expressed as one
 * findable, unambiguous literal span (`editText` then reports
 * FS_AMBIGUOUS_EDIT/FS_EDIT_NOT_FOUND, so the caller falls back to a guarded
 * atomic write instead).
 *
 * The anchor is always the first index where the two texts differ, or one byte
 * earlier when that index would leave an empty `oldString`. For an inner
 * difference, starting strictly before the difference already excludes a second
 * occurrence (it would have to lie inside the identical suffix). A pure append
 * has no differing byte at all, so it anchors on the file's last line instead
 * and relies on the uniqueness check below.
 */
function diffEdit(before, after) {
  if (before === after) return undefined;
  // Compare exactly `before.length` bytes against `after`: stopping at the
  // shorter length would make a pure append look like "the whole file is the
  // common prefix" and collapse the anchor to an empty string.
  let head = 0;
  while (head < before.length && before[head] === after[head]) head += 1;
  let anchor = head;
  if (anchor === before.length) {
    // A pure append has no differing byte to anchor on, so match the last line
    // instead; whether that line is usable is decided by the uniqueness check
    // below, because it need not occur once (every fenced entry ends with the
    // same closing fence).
    anchor = before.lastIndexOf('\n', before.length - 2) + 1;
    if (anchor >= before.length) return undefined;
  } else if (before[anchor] === '\n') {
    // Otherwise the old text would begin with a line break (or be empty when
    // everything is deleted), so keep the boundary character in the match.
    anchor -= 1;
  }
  if (anchor < 0 || before.slice(anchor) === after.slice(anchor)) return undefined;
  const oldString = before.slice(anchor);
  // The edit primitive rejects an ambiguous match (`FS_AMBIGUOUS_EDIT`), and the
  // caller falls back to its guarded atomic write only when this returns
  // `undefined`. Report "no usable span" rather than hand over one that occurs
  // more than once: the append anchor is the file's last line, which repeats as
  // soon as a category holds two fenced entries — the exact shape this plugin
  // writes — and that used to make `remember` fail outright.
  if (before.indexOf(oldString) !== before.lastIndexOf(oldString)) return undefined;
  return { oldString, newString: after.slice(anchor) };
}

/**
 * Tidy the blank lines left behind by a deletion: no run of more than one empty
 * line is created, and no blank line is left at the very start of the file. Only
 * whitespace-only lines between other content are touched — entry text and
 * hand-written prose are preserved byte for byte.
 */
function tidyDeletedWhitespace(text, next) {
  let result = next;
  // ...two or more empty lines -> one...
  result = result.replace(/\n([ \t]*\n){2,}/g, '\n\n');
  // ...a run that runs into the end of file -> one trailing newline...
  result = result.replace(/\n([ \t]*\n)+\s*$/, '\n');
  // ...and a run at the very start of the file -> none.
  result = result.replace(/^(\s*\n)+/, '');
  return result;
}

/** Format one entry block (heading + fenced note). */
function formatEntry(content, topic) {
  const heading = topic === undefined || topic === '' ? `## ${today()}` : `## ${today()} ${topic}`;
  const lines = String(content)
    .split('\n')
    .map((line) => `- ${line}`);
  return `${heading}\n${ENTRY_BEGIN}\n${lines.join('\n')}\n${ENTRY_END}`;
}

/**
 * Parse a category file into ordered entry spans.
 *
 * Boundaries are the explicit fences; a line-start `## ` heading is accepted as
 * a legacy boundary. A heading inside a marked entry is the note's own body
 * text, and a heading immediately followed by an opening fence is that fenced
 * entry's heading — which is exactly the ambiguity the fences exist to remove.
 *
 * @param source - the raw file text.
 * @returns `{ entries }` with each entry `{ text, start, end }`: `text` is the
 *   display form (fences stripped) and `start`/`end` the exact half-open span
 *   in `source`; everything before the first entry is hand-written preamble and
 *   is never returned as an entry.
 */
function parseEntries(source) {
  const text = String(source ?? '');
  const lines = text.split('\n');
  const lineEnds = [];
  const fences = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    lineEnds.push(offset + lines[i].length);
    const fence = FENCE_LINE.exec(lines[i]);
    if (fence !== null) fences.push({ at: offset, line: i, closing: fence[1] === '/' });
    offset += lines[i].length + 1;
  }
  const lineStart = (i) => (i === 0 ? 0 : lineEnds[i - 1] + 1);
  const entries = [];
  const push = (start, end, body) => {
    if (end <= start) return;
    const trimmed = text.slice(start, end).replace(/\s+$/, '');
    if (trimmed === '') return;
    if (TITLE_LINE.test(trimmed) && !HEADING_LINE.test(trimmed)) return;
    entries.push({ text: body.trim(), start, end });
  };

  // Phase 1 — fenced entries. Each opening fence claims everything up to its
  // matching close (or end of file), and the heading on the line just above the
  // opening fence belongs to the same entry. A `## ` line inside the span is
  // the note's own body text, which is precisely what the fences disambiguate.
  // Spans already claimed as entries, so no later phase can re-parse them.
  const claimed = [];
  let line = 0;
  while (line < lines.length) {
    const index = fences.findIndex((fence) => fence.line === line && !fence.closing);
    if (index === -1) {
      line += 1;
      continue;
    }
    const opening = fences[index];
    let close = fences.find((fence) => fence.line > line && fence.closing);
    let end = close === undefined ? text.length : lineEnds[close.line];
    const headingAbove = line > 0 && HEADING_LINE.test(lines[line - 1]);
    const start = headingAbove ? lineStart(line - 1) : opening.at;
    // Our own replace() rewrites a legacy section as `<old heading> <new fenced
    // entry> <next heading>`; that hybrid record carries the heading twice, which
    // the note text makes detectable. A plain `## ` inside a fenced body is the
    // note's own subheading and must NOT extend the entry (that is the whole
    // point of the fences), so only the double-heading shape is merged.
    const isHybrid = headingAbove
      && line + 1 < lines.length
      && HEADING_LINE.test(lines[line + 1])
      // Inspect only the fenced span itself: an unrelated fenced entry further
      // down must not be mistaken for this one's second heading.
      && text.slice(opening.at, close === undefined ? end : lineEnds[close.line]).includes('\n## ');
    if (isHybrid) {
      const nextHeading = lines.findIndex((candidate, k) => k > line && HEADING_LINE.test(candidate));
      if (nextHeading !== -1 && lineStart(nextHeading) > end) end = lineStart(nextHeading);
      close = fences.find((fence) => fence.line > line && fence.closing);
    }
    const body = text.slice(opening.at, end)
      .replace(/^<!--\s*dsh-memory:entry\s*-->[ \t]*\n?/, '')
      .replace(/\n?[ \t]*<!--\s*\/\s*dsh-memory:entry\s*-->[ \t]*$/, '')
      .trim();
    push(start, end, body);
    claimed.push({ start, end });
    line = (close === undefined ? lines.length : close.line) + 1;
  }

  // Phase 2 — legacy `## ` sections in the gaps the gapped phase did not claim.
  // A section ends at the next `## ` heading line no matter who owns it: a
  // heading inside a fenced entry is that entry's boundary, so the legacy
  // section simply stops there and the fenced span takes over.
  const insideClaimed = (at) => claimed.some((span) => at >= span.start && at < span.end);
  for (let i = 0; i < lines.length; i += 1) {
    if (!HEADING_LINE.test(lines[i])) continue;
    const at = lineStart(i);
    if (insideClaimed(at)) continue;
    let end = text.length;
    for (let k = i + 1; k < lines.length; k += 1) {
      const at = lineStart(k);
      // Whichever boundary line comes first owns the cut: the next `## ` heading,
      // or a fence line. A legacy section therefore never contains a fence.
      if (HEADING_LINE.test(lines[k]) || fences.some((fence) => fence.at === at)) {
        end = at;
        break;
      }
    }
    claimed.push({ start: at, end });
    push(at, end, text.slice(at, end).replace(/\s+$/, '').trim());
  }

  entries.sort((a, b) => a.start - b.start);
  return { entries };
}

/**
 * Single execution's memory store. All mutations of one path are serialized
 * inside the host process, so a read → plan → write sequence cannot interleave
 * with another call's, and every write carries the version the read observed.
 */
class MemoryStore {
  /** Per-absolute-path mutation chain. */
  chains = new Map();

  /**
   * @param ctx - plugin context carrying the filesystem service.
   * @param exec - the current tool execution (session cwd + cancellation).
   */
  constructor(ctx, exec) {
    this.ctx = ctx;
    this.exec = exec;
  }

  /** Absolute path a call reads or mutates (relative paths use the session workspace). */
  absolute(path) {
    if (isAbsolute(path)) return resolvePath(path);
    const cwd = sessionCwd(this.exec);
    return cwd === undefined ? resolvePath(path) : resolvePath(cwd, path);
  }

  /** Resolve a path into an fs target. */
  target(path) {
    const cwd = sessionCwd(this.exec);
    return this.ctx.fs.resolve(this.absolute(path), {
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.exec?.signal === undefined ? {} : { signal: this.exec.signal }),
    });
  }

  /**
   * Read one file plus the version a write must still see, recording the
   * observation the fs policy layer requires before a guarded edit.
   * @returns `{ target, text, version, exists }` (`text` is `''` when absent).
   */
  async readFile(path) {
    const target = await this.target(path);
    const info = await this.ctx.fs.stat(target, this.exec?.signal);
    if (info === undefined) {
      this.ctx.emit('fs/observed', target, { kind: 'absent' }, this.exec);
      return { target, text: '', version: undefined, exists: false };
    }
    if (info.type !== 'file') {
      throw new Error(`dsh-memory: "${target.displayPath}" is not a regular file`);
    }
    const text = await this.ctx.fs.readText(target, this.exec?.signal);
    this.ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, this.exec);
    return { target, text, version: info.version, exists: true };
  }

  /** Direct children of a directory; empty when it does not exist yet. */
  async listDir(dir) {
    const target = await this.target(dir);
    try {
      return await this.ctx.fs.listDir(target, this.exec?.signal);
    } catch (error) {
      if (error?.code === 'FS_NOT_FOUND' || error?.code === 'FS_NOT_DIRECTORY') return [];
      throw error;
    }
  }

  /**
   * Run one mutation under a per-path lock. `run` receives a freshly read state
   * and returns the full desired text; the difference is applied as a single
   * literal edit (or one atomic write when the file does not exist yet), so
   * everything the mutation does not touch stays byte-for-byte intact.
   */
  async mutate(path, run) {
    const key = this.absolute(path);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      const state = await this.readFile(path);
      const plan = await run(state);
      if (plan === undefined || plan.next === state.text) {
        return { state, changed: false, result: plan?.result };
      }
      let version = state.version;
      if (!state.exists) {
        version = await this.write(state, plan.next);
      } else {
        const edit = diffEdit(state.text, plan.next);
        // No unambiguous literal span (a purely appended file, or a whole-file
        // replacement): fall back to one guarded atomic write, which still
        // carries the version this mutation observed.
        version = edit === undefined
          ? await this.write(state, plan.next)
          : await this.edit(state, edit.oldString, edit.newString, version);
      }
      return { state, changed: true, version, result: plan.result };
    });
    const settled = task.then(() => undefined, () => undefined);
    this.chains.set(key, settled);
    try {
      return await task;
    } finally {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    }
  }

  /**
   * The per-call sandbox policy, resolved from the session running this tool.
   *
   * This argument is not optional in practice. `dsh-fs-sandbox` computes
   * `sandboxPolicy ?? ctx.sandboxPolicy.resolve()`, and `resolve()` without a
   * session returns the DEPLOYMENT default (`defaultMode`) rather than the
   * session's own `sandbox/mode` override. Omitting it is what made writes here
   * fail with "denied under workspace-write mode" even while the session's mode
   * was `danger-full-access` — the built-in write/edit tools pass this value for
   * exactly this reason. Returns undefined when the service is absent, which
   * restores the previous fallback behaviour.
   */
  policy() {
    // The sandbox service is optional: a profile may run without it, and a test
    // double may not model it at all. Fall back to undefined, which is what the
    // fs layer treats as "resolve the deployment default".
    if (typeof this.ctx.get !== 'function') return undefined;
    const sandboxPolicy = this.ctx.get('sandboxPolicy');
    if (sandboxPolicy === undefined || typeof sandboxPolicy.resolve !== 'function') return undefined;
    const session = this.exec?.agent?.session;
    return sandboxPolicy.resolve(session === undefined ? {} : { session });
  }

  /** Atomically write a whole file (create or replace) and re-broadcast the observation. */
  async write(state, content) {
    const expected = state.version === undefined
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: state.version };
    const outcome = await this.ctx.fs.writeText(
      state.target,
      content,
      expected,
      this.exec?.signal,
      this.policy(),
    );
    this.ctx.emit('fs/observed', state.target, { kind: 'present', version: outcome.version }, this.exec);
    return outcome.version;
  }

  /** Apply one literal edit and re-broadcast the resulting observation. */
  async edit(state, oldString, newString, version) {
    if (oldString === '') return version;
    const outcome = await this.ctx.fs.editText(
      state.target,
      { oldString, newString, replaceAll: false },
      version === undefined ? undefined : { version },
      this.exec?.signal,
      this.policy(),
    );
    this.ctx.emit('fs/observed', state.target, { kind: 'present', version: outcome.version }, this.exec);
    return outcome.version;
  }

  /** Append one entry, creating the file (and its directory) when absent. */
  async append(path, content, topic) {
    const block = formatEntry(content, topic);
    const outcome = await this.mutate(path, (state) => ({
      next: appendBlock(state.text, block),
      result: { count: parseEntries(state.text).entries.length + 1 },
    }));
    return { count: outcome.result?.count ?? 1, created: !outcome.state.exists };
  }

  /**
   * Replace the first entry containing `query` (case-insensitive); append when
   * nothing matches. Only the matched entry's own span is rewritten.
   */
  async replace(path, content, query, topic) {
    const block = formatEntry(content, topic);
    const needle = query.toLowerCase();
    const outcome = await this.mutate(path, (state) => {
      const parsed = parseEntries(state.text);
      const hit = parsed.entries.find((entry) => entry.text.toLowerCase().includes(needle));
      if (hit === undefined) {
        return {
          next: appendBlock(state.text, block),
          result: { replaced: false, count: parsed.entries.length + 1 },
        };
      }
      // A parsed span already covers its own heading and trailing separator, so
      // replacing exactly [start, end) leaves every other byte untouched.
      return {
        next: `${state.text.slice(0, hit.start)}${block}\n${state.text.slice(hit.end)}`,
        result: { replaced: true, count: parsed.entries.length },
      };
    });
    return outcome.result ?? { replaced: false, count: 1 };
  }

  /** Delete every entry containing `query`, one literal span edit per hit. */
  async forget(path, query) {
    const needle = query.toLowerCase();
    const outcome = await this.mutate(path, (state) => {
      const parsed = parseEntries(state.text);
      const hits = parsed.entries.filter((entry) => entry.text.toLowerCase().includes(needle));
      if (hits.length === 0) {
        return { next: state.text, result: { removed: 0, remaining: parsed.entries.length } };
      }
      // Rebuild back-to-front so earlier spans stay valid; the spans are spliced
      // out of the same text the caller is editing, never rewritten.
      let next = state.text;
      for (let index = hits.length - 1; index >= 0; index -= 1) {
        const hit = hits[index];
        if (hit === undefined) continue;
        next = `${next.slice(0, hit.start)}${next.slice(hit.end)}`;
      }
      return {
        next: tidyDeletedWhitespace(state.text, next),
        result: { removed: hits.length, remaining: parsed.entries.length - hits.length },
      };
    });
    return outcome.result ?? { removed: 0, remaining: 0 };
  }
}

/** Parse an index file's `- slug=file.md` lines into absolute category paths. */
function parseIndex(dir, text) {
  const map = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = INDEX_LINE.exec(line.trim());
    if (match === null) continue;
    map[match[1]] = join(dir, match[2]);
  }
  return map;
}

export function apply(ctx, config = {}) {
  const userDir = expandPath(
    config.userDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory'),
  );
  const userFileName = config.userFileName || DEFAULT_USER_FILE;
  const configuredProjectFile = typeof config.projectFile === 'string' && config.projectFile.trim() !== ''
    ? expandPath(config.projectFile)
    : undefined;
  const defaultScope = config.defaultScope === 'project' ? 'project' : 'user';

  const storeFor = (exec) => new MemoryStore(ctx, exec);

  /** The project memory file for one call: configured, else <session cwd>/.dsh/memory.md. */
  const projectFileFor = (exec) => {
    if (configuredProjectFile !== undefined) return configuredProjectFile;
    const root = sessionCwd(exec);
    if (root === undefined) {
      throw new Error(
        'dsh-memory: project scope needs an agent session workspace; no session cwd is available for this call',
      );
    }
    return join(root, '.dsh', 'memory.md');
  };

  /** Index file plus its directory for one scope. */
  const indexFor = (exec, scope) => {
    if (scope === 'project') {
      const file = projectFileFor(exec);
      return { index: file, dir: dirname(file) };
    }
    return { index: join(userDir, userFileName), dir: userDir };
  };

  /** Read the index (tolerating a missing directory) plus its slug → path map. */
  const readIndex = async (store, index) => {
    const state = await store.readFile(index);
    return { state, map: parseIndex(dirname(store.absolute(index)), state.text) };
  };

  /**
   * Add one `- slug=file.md` line to the index, creating the index (and its
   * directory) only when absent. Hand-written index content is never rewritten.
   */
  const appendIndexLine = async (store, index, slug, base) => {
    const { map } = await readIndex(store, index);
    if (Object.hasOwn(map, slug)) return;
    const line = `- ${slug}=${base}`;
    // Plan inside the lock, from the state the lock just read: the outer read
    // only decides whether the line is needed at all.
    await store.mutate(index, (state) => {
      if (!state.exists || state.text.trim() === '') {
        const seed = ['# 记忆索引', '', '每个分类一行：`slug=文件名`；分类文件命名为 `memory-<slug>.md`。', '', line, ''].join('\n');
        return { next: seed };
      }
      return { next: appendBlock(state.text.replace(/\s+$/, ''), line) };
    });
  };

  /** Every category file under one scope: index entries plus a directory scan. */
  const categoryFiles = async (store, index) => {
    const dir = dirname(store.absolute(index));
    const { map } = await readIndex(store, index);
    const seen = new Set(Object.values(map));
    for (const entry of await store.listDir(dir)) {
      if (CATEGORY_FILE.test(entry.name)) seen.add(join(dir, entry.name));
    }
    return [...seen];
  };

  ctx.tools.register(defineTool({
    name: 'remember',
    description:
      'Save a durable note to persistent memory, organized by category. Notes are plain editable markdown; ' +
      '`topic` is the CATEGORY (e.g. "ui", "plugins", "prefs") and the note is appended to that category file ' +
      '(`memory-<slug>.md`); a new category is added to the memory index (`memory.md`) automatically, and an ' +
      'existing category receives the note in place. `user` scope lives in ~/.dsh/memory/ (shared across projects), ' +
      '`project` scope lives in <workspace>/.dsh/. Recall them later with the recall tool.',
    parameters: {
      content: {
        type: 'string',
        required: true,
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          entryCount: { type: 'number', required: true },
          replaced: { type: 'boolean', required: true },
        },
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
      const content = args.content.trim();
      if (content === '') throw new Error('remember needs a non-empty string "content".');
      const scope = args.scope ?? defaultScope;
      const topic = args.topic !== undefined && args.topic.trim() !== '' ? args.topic.trim() : 'general';
      const replace = args.replace !== undefined && args.replace.trim() !== '' ? args.replace.trim() : null;
      const store = storeFor(exec);
      const { dir, index } = indexFor(exec, scope);
      const slug = slugify(topic);
      const { map } = await readIndex(store, index);
      let file = map[slug];
      if (file === undefined) {
        const base = `memory-${slug}.md`;
        file = join(dir, base);
        // Index line first: a category file with no index line would be invisible
        // to the index-driven path, and the directory scan still finds the file.
        await appendIndexLine(store, index, slug, base);
      }
      if (replace !== null) {
        const result = await store.replace(file, content, replace, topic);
        return { ok: true, file, scope, entryCount: result.count, replaced: result.replaced };
      }
      const result = await store.append(file, content, topic);
      return { ok: true, file, scope, entryCount: result.count, replaced: false };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'recall',
    description:
      'Read back persistent memory, organized by category. Use it at the start of a task when the user\u2019s ' +
      'preferences, setup, or project context may have been saved earlier. Returns the memory index plus every ' +
      'category file; optionally filter with a query (matched per entry). Reads `user` memory (~/.dsh/memory/) and ' +
      '`project` memory (<workspace>/.dsh/).',
    parameters: {
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
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          text: { type: 'string', required: true },
          entryCount: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
        },
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
      const scope = args.scope ?? 'all';
      const query = args.query !== undefined && args.query.trim() !== '' ? args.query.trim().toLowerCase() : '';
      const maxChars = args.maxChars === undefined ? DEFAULT_MAX_CHARS : Math.floor(args.maxChars);
      const store = storeFor(exec);
      const scopes = scope === 'all' ? ['user', 'project'] : [scope];
      const parts = [];
      const files = [];
      let entryCount = 0;
      for (const which of scopes) {
        let pair;
        try {
          pair = indexFor(exec, which);
        } catch {
          // Project scope without a session workspace: skip it rather than fail
          // the user-scope read that does work.
          continue;
        }
        const { state, map } = await readIndex(store, pair.index);
        const label = (path) => `${which}: ${path}`;
        if (state.exists && state.text.trim() !== '' && (query === '' || state.text.toLowerCase().includes(query))) {
          parts.push({ text: state.text.trim() });
          files.push(label(state.target.displayPath));
        }
        const dir = dirname(store.absolute(pair.index));
        const names = new Set(Object.keys(map).map((slug) => `memory-${slug}.md`));
        for (const entry of await store.listDir(dir)) {
          if (CATEGORY_FILE.test(entry.name)) names.add(entry.name);
        }
        for (const entryName of [...names].sort()) {
          const path = join(dir, entryName);
          const category = await store.readFile(path);
          if (!category.exists) continue;
          const { entries } = parseEntries(category.text);
          const kept = query === ''
            ? entries
            : entries.filter((entry) => entry.text.toLowerCase().includes(query));
          if (kept.length === 0) continue;
          entryCount += kept.length;
          files.push(label(category.target.displayPath));
          parts.push({ text: kept.map((entry) => entry.text).join('\n\n') });
        }
      }
      if (parts.length === 0) {
        return {
          file: scopes.join(', '),
          scope,
          text: query === '' ? '(memory is empty — nothing saved yet)' : `(no memory entries match "${query}")`,
          entryCount: 0,
          truncated: false,
        };
      }
      const combined = parts.map((part) => part.text).join('\n\n');
      const truncated = combined.length > maxChars;
      return {
        file: files.join(', '),
        scope,
        text: truncated ? combined.slice(0, maxChars) : combined,
        entryCount,
        truncated,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'forget',
    description:
      'Delete memory entries whose content matches a query (like Claude\u2019s memory delete). Searches every category ' +
      'file and removes matching entries. Use when the user asks to remove or update an outdated saved fact. ' +
      'Prefer remembering a corrected note right after forgetting the old one.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Case-insensitive text that identifies the entries to remove.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project'],
        description: 'Which memory to edit: user (default) or project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          removed: { type: 'number', required: true },
          remaining: { type: 'number', required: true },
        },
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
      const query = args.query.trim().toLowerCase();
      if (query === '') throw new Error('forget needs a non-empty string "query".');
      const scope = args.scope ?? defaultScope;
      const store = storeFor(exec);
      const { dir, index } = indexFor(exec, scope);
      const files = await categoryFiles(store, index);
      let removed = 0;
      let remaining = 0;
      for (const file of files) {
        const result = await store.forget(file, query);
        removed += result.removed;
        remaining += result.remaining;
      }
      return { file: dir, scope, removed, remaining };
    },
  }));
}
