#!/usr/bin/env node
/**
 * dsh-auto-update — dsh 本体 + profile 插件 自动检查/升级包装器
 *
 * 由 install.ps1 部署到 ~/.dsh/tools/dsh-auto-update/ 并注入 PowerShell $PROFILE，
 * 之后你在 PowerShell 里输入 `dsh web` 即自动进入本流程（原 dsh 参数原样透传）。
 *
 *   node updater.mjs web [web-app flags...]
 *   node updater.mjs --profile <name> [args...]
 *   node updater.mjs <任何非启动命令>   → 快速透传，不做任何检查
 *   node updater.mjs --dry-run web      → 演练模式：只扫描/打印，不升级不启动
 *
 * 行为（profile 启动类命令）：
 *   1) 检查 dsh 本体（npm 全局）相对镜像 registry 是否有更新 → 有则询问 → 升级 → 继续；
 *   2) 快速扫描各 profile 的 registry 插件，打印待更新清单（只读不升级）；
 *   3) 原样启动 dsh（阻塞直到退出）；
 *   4) dsh 因插件加载失败而退出时：解析坏 entry → 自动写入 profile 的
 *      cordis.patch.yml（disabled）→ 自动重启一次（核心插件除外）；
 *   5) 正常退出后：若有待更新插件 → 询问确认 → pnpm update（遵守 package.json 范围），
 *      下次启动生效。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

// ---------- 配置（按需修改） ----------
const CONFIG = {
  mirror: 'https://registry.npmmirror.com', // 升级使用的镜像 registry（npmmirror）
  profiles: 'all', // 'all' = 遍历 $DSH_HOME/profiles 下全部 pnpm profile
  fetchTimeoutMs: 8000,
};
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(TOOL_DIR, 'logs');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const DRY = process.argv.includes('--dry-run') || process.env.DSH_AUTO_DRY_RUN === '1';
const argv = process.argv.slice(2).filter((a) => a !== '--dry-run');

const log = (...parts) => {
  const line = `[dsh-up ${new Date().toISOString()}] ${parts.join(' ')}`;
  try { appendFileSync(join(LOG_DIR, 'updater.log'), line + '\n'); } catch {}
};
const say = (...parts) => console.log('[dsh-up]', ...parts);

// ---------- 简易 semver（符合 npm 排序：prerelease 短字段优先、数字标识 < 字母标识） ----------
function parseSemver(v) {
  const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}
function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // 正式版 > 预发布
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1; // 少字段 < 多字段（同前缀）
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]); const bn = /^\d+$/.test(b[i]);
    if (an && bn) { if (+a[i] !== +b[i]) return +a[i] < +b[i] ? -1 : 1; }
    else if (an) return 1; // 数字标识 > 字母标识
    else if (bn) return -1;
    else { const c = a[i] < b[i] ? -1 : a[i] > b[i] ? 1 : 0; if (c) return c; }
  }
  return 0;
}
function cmpVersions(x, y) {
  const a = parseSemver(x); const b = parseSemver(y);
  if (!a || !b) return String(x) === String(y) ? 0 : (a ? 1 : -1);
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return cmpPre(a.pre, b.pre);
}
function preidOf(v) { const p = parseSemver(v); return p && p.pre.length && !/^\d+$/.test(p.pre[0]) ? p.pre[0] : null; }
// 粗粒度 range 判定（^ ~ 裸版本；仅用于提示，不阻断）
function satisfiesRough(v, range) {
  const p = parseSemver(v); if (!p || p.pre.length) return false;
  const r = String(range).trim();
  const m = r.match(/^(\^|~|>=|>|=|<=|<)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return false;
  const [, op, M, mi, pa] = m; const major = +M, minor = mi === undefined ? 0 : +mi, patch = pa === undefined ? 0 : +pa;
  if (op === '^') {
    const upper = major > 0 ? [major + 1, 0, 0] : (minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1]);
    return (p.major > major || (p.major === major && p.minor > minor) || (p.major === major && p.minor === minor && p.patch >= patch))
      && (p.major < upper[0] || (p.major === upper[0] && p.minor < upper[1]) || (p.major === upper[0] && p.minor === upper[1] && p.patch < upper[2]));
  }
  if (op === '~') return p.major === major && p.minor === minor && p.patch >= patch;
  if (!op) return p.major === major && (mi === undefined || p.minor === minor) && (pa === undefined || p.patch === patch);
  if (op === '>=') return cmpVersions(v, `${major}.${minor}.${patch}`) >= 0;
  if (op === '>') return cmpVersions(v, `${major}.${minor}.${patch}`) > 0;
  if (op === '<=') return cmpVersions(v, `${major}.${minor}.${patch}`) <= 0;
  if (op === '<') return cmpVersions(v, `${major}.${minor}.${patch}`) < 0;
  return false;
}

// ---------- 基础工具 ----------
function run(cmd, args, opts = {}) {
  log('run:', cmd, ...args);
  let real = [cmd, args];
  if (cmd === 'npm' || cmd === 'pnpm') { real = [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args]]; }
  return spawnSync(real[0], real[1], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: false, ...opts });
}
function npmPrefix() {
  const r = run('npm', ['prefix', '-g']);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return join(process.env.APPDATA || process.env.USERPROFILE, 'npm');
}
function dshShim() { return join(npmPrefix(), 'dsh.cmd'); }
function localDshVersion() {
  try {
    const p = join(npmPrefix(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version;
  } catch { return null; }
}
function profilesDir() { return join(DSH_HOME, 'profiles'); }
async function fetchJson(url, timeoutMs = CONFIG.fetchTimeoutMs) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'dsh-auto-update' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}
function enc(name) { return name.replace('/', '%2F'); }
function pkgUrl(name) { return `${CONFIG.mirror}/${enc(name)}`; }
function installedPluginVersion(profileDir, name) {
  try {
    const p = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version;
  } catch { return null; }
}
async function prompt(question, def = '') {
  if (DRY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a || def;
  } finally { rl.close(); }
}

// ---------- 待更新清单持久化 ----------
// 场景：updater 阻塞等待 dsh 时被 Ctrl+C / 关窗口一起杀掉，走不到“退出后安装”；
// 故每次真实扫描都把待更新持久化到 state 文件，下次启动 dsh 前先补装遗留。
const STATE_FILE = join(TOOL_DIR, 'state', 'pending-plugins.json');
function readPending() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function writePending(list) {
  try {
    if (!Array.isArray(list) || list.length === 0) {
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
      return;
    }
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) { log('state write failed:', String(e)); }
}
// 询问并安装一组插件更新；返回 true 表示本次已安装
async function installPendingList(list, where) {
  if (!list || !list.length) return false;
  say(`共 ${list.length} 个插件可更新（${where}，安装后下次启动生效）：`);
  for (const x of list) say(`  ${x.profile}/${x.name}：${x.installed} → ${x.latest}`);
  const ans = await prompt('现在安装这些插件更新吗？(Y/n) > ', 'y');
  if (ans !== 'y' && ans !== '') return false;
  const byProfile = new Map();
  for (const x of list) {
    if (!byProfile.has(x.profile)) byProfile.set(x.profile, []);
    byProfile.get(x.profile).push(x);
  }
  for (const [pp, l] of byProfile) installPlugins(pp, l);
  say('插件更新完成，下次启动生效。');
  return true;
}

// ---------- 参数 → 目标 profile ----------
function resolveProfile(args) {
  if (args[0] === 'web') return 'web';
  const i = args.indexOf('--profile');
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
  if (['headless', 'tui'].includes(args[0])) return args[0];
  return null; // help/version/plugin/无参数等：快速透传
}
function allProfiles() {
  const out = [];
  try {
    for (const dirent of readdirSync(profilesDir(), { withFileTypes: true })) {
      if (dirent.isDirectory() && dirent.name !== 'node_modules') {
        if (existsSync(join(profilesDir(), dirent.name, 'package.json'))) out.push(dirent.name);
      }
    }
  } catch {}
  return out;
}

// ---------- 1) dsh 本体检查 ----------
async function scanDsh() {
  const local = localDshVersion();
  if (!local) { say('无法读取本机 dsh 版本，跳过本体检查'); return []; }
  say(`本机 dsh 版本：${local}`);
  let pack;
  try { pack = await fetchJson(pkgUrl('@deepseek-ai/dsh')); }
  catch (e) { say(`镜像查询失败（${e.message}），跳过本体检查`); return []; }
  const tags = pack['dist-tags'] || {};
  const higher = [];
  for (const [tag, v] of Object.entries(tags)) {
    if (v && cmpVersions(v, local) > 0) higher.push({ tag, v });
  }
  higher.sort((a, b) => cmpVersions(b.v, a.v));
  if (!higher.length) { say('dsh 本体已是最新（镜像上无更高发布版本）'); return []; }
  say('发现更新的 dsh 发布：');
  const mine = preidOf(local);
  higher.forEach((h, i) => {
    const rec = h.tag === 'latest' || (mine && preidOf(h.v) === mine) ? '  ← 推荐' : '';
    say(`  [${i + 1}] tag=${h.tag}  ${h.v}${rec}`);
  });
  return higher;
}
async function installDsh(v) {
  say(`正在从 ${CONFIG.mirror} 升级 dsh 到 ${v} ...`);
  const args = ['install', '-g', `@deepseek-ai/dsh@${v}`, `--registry=${CONFIG.mirror}`, '--no-audit', '--no-fund'];
  if (DRY) { say(`DRY：npm ${args.join(' ')}`); return true; }
  const r = run('npm', args);
  if (r.status !== 0) {
    say('升级失败。若提示 EPERM/EBUSY/文件占用，多半是当前有 dsh 实例正在运行（请先退出所有 dsh 再重试）。');
    log('npm install failed:', (r.error && r.error.code) || '', (r.stderr || r.stdout || '').slice(0, 1200));
    return false;
  }
  say(`dsh 已升级到 ${localDshVersion()}`);
  return true;
}

// ---------- 2) 插件扫描 ----------
async function scanPlugins(profile) {
  const dir = join(profilesDir(), profile);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch { say(`profile ${profile} 缺少 package.json，跳过插件扫描`); return []; }
  const deps = pkg.dependencies || {};
  const targets = Object.entries(deps).filter(([, v]) =>
    v && !/^(link|file|workspace|\.|\/)/.test(v) && !v.startsWith('npm:'));
  if (!targets.length) { say(`profile ${profile} 无 registry 插件依赖`); return []; }
  const found = [];
  for (const [name, range] of targets) {
    const installed = installedPluginVersion(dir, name);
    if (!installed) continue;
    try {
      const pack = await fetchJson(pkgUrl(name));
      const latest = pack['dist-tags']?.latest;
      if (!latest) continue;
      if (cmpVersions(latest, installed) > 0) {
        found.push({ name, range, installed, latest, inRange: satisfiesRough(latest, range) });
      }
    } catch { /* 单包查询失败静默跳过 */ }
  }
  return found;
}

// ---------- 3/4) 启动 dsh + 自愈 ----------
function launchDsh(args, capture = true) {
  const shim = dshShim();
  log('launch:', shim, ...args);
  say('启动 dsh ...');
  const r = run('cmd.exe', ['/d', '/s', '/c', shim, ...args], { stdio: capture ? 'pipe' : 'inherit' });
  const output = (r.stdout || '') + '\n' + (r.stderr || '');
  return { code: r.status, output };
}
function isCorePlugin(name) {
  if (!name) return true;
  const n = name.replace(/^npm:/, '');
  return n === 'dsh-base' || n === '@deepseek-ai/dsh-base'
    || n === 'dsh-web-app' || n === '@deepseek-ai/dsh-web-app'
    || n.startsWith('@deepseek-ai/cordis');
}
function findFailingEntry(output) {
  if (!/failed to load|plugin tree failed|plugin\(s?\) failed to load|failed to apply loader entry/i.test(output)) return null;
  // include 嵌套错误里最内层才是真凶：取最后一个 "loader entry <id> (<name>)"
  const re = /failed to import loader entry ([A-Za-z0-9._@/-]+) \(([^)]+)\)/g;
  let m, last = null;
  while ((m = re.exec(output)) !== null) last = { id: m[1], name: m[2] };
  if (last && !isCorePlugin(last.name)) return last;
  // 兜底：boot 汇总行 "plugin(s) failed to load: A, B"
  const agg = /plugin\(s?\) failed to load:\s*([^\n]+)/i.exec(output);
  if (agg) {
    const names = agg[1].split(',').map((s) => s.trim()).filter((s) => s && !isCorePlugin(s));
    if (names.length) return { id: names[0], name: names[0] };
  }
  return null;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function disableEntry(profile, entry) {
  const patchPath = join(profilesDir(), profile, 'cordis.patch.yml');
  let text = '';
  if (existsSync(patchPath)) text = readFileSync(patchPath, 'utf8');
  if (new RegExp(`(^|\\n)- id: ${escapeRegExp(entry.id)}\\b`).test(text)) return patchPath; // 已存在
  const note = `\n# [dsh-auto-update ${new Date().toISOString().slice(0, 10)}] boot 失败自动禁用: ${entry.name}\n- id: ${entry.id}\n  disabled: true\n`;
  if (DRY) { say(`DRY：将向 ${patchPath} 追加禁用条目 ${entry.id}`); return patchPath; }
  writeFileSync(patchPath, text.trimEnd() + note, 'utf8');
  log('disabled entry in', patchPath, entry.id);
  return patchPath;
}

// ---------- 5) 插件安装 ----------
function installPlugins(profile, list) {
  const dir = join(profilesDir(), profile);
  const names = list.map((x) => x.name);
  const outOfRange = list.filter((x) => !x.inRange);
  say(`正在更新 profile ${profile} 的插件（遵守 package.json 范围）...`);
  if (DRY) { say(`DRY：pnpm --dir ${dir} update ${names.join(' ')} --registry=${CONFIG.mirror}`); }
  else {
    const r = run('pnpm', ['--dir', dir, 'update', ...names, `--registry=${CONFIG.mirror}`]);
    if (r.status !== 0) say('插件更新命令失败，详情见上方输出');
  }
  if (outOfRange.length) {
    say('以下插件最新版超出当前声明范围，本次未升级（如需大版本升级请手动执行 pnpm --latest）：');
    for (const x of outOfRange) say(`  ${x.name}：声明 ${x.range}，最新 ${x.latest}`);
  }
}

// ---------- 快速透传 ----------
function passthrough(args) {
  const r = run('cmd.exe', ['/d', '/s', '/c', dshShim(), ...args], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

// ---------- main ----------
const profile = resolveProfile(argv);
if (!profile) { say('非 profile 启动命令，直接透传'); passthrough(argv); }

say(`==== dsh 自动检查（profile=${profile}）====`);
log('boot profile', profile, 'argv', JSON.stringify(argv));

// 1) 本体
const dshCandidates = await scanDsh();
if (dshCandidates.length) {
  const mine = preidOf(localDshVersion());
  const sameChannel = dshCandidates.filter((h) => h.tag === 'latest' || h.tag === 'next' || (mine && preidOf(h.v) === mine));
  const def = sameChannel.length ? sameChannel[0] : null;
  const cross = dshCandidates.filter((h) => !sameChannel.includes(h));
  if (cross.length) {
    say('警告：以下候选与当前 dsh 不同频道（预发布/跨线），可能不兼容现有插件（如 auto-mode 的版本门禁），不会作为默认推荐：');
    for (const c of cross) say(`  tag=${c.tag}  ${c.v}`);
  }
  const hint = def ? '回车 = 升级同频道版，' : '回车 = 跳过，';
  const ans = (await prompt(`是否升级 dsh 本体？(${hint}数字 = 选上方列表项，n = 跳过) > `, def ? '' : 'n')).trim().toLowerCase();
  let picked = null;
  if (ans === '') {
    picked = def;
  } else if (ans !== 'n') {
    const n = parseInt(ans, 10);
    if (Number.isFinite(n) && n >= 1 && n <= dshCandidates.length) picked = dshCandidates[n - 1];
  }
  if (picked) {
    const ok = await installDsh(picked.v);
    if (!ok) {
      const cont = await prompt('本体升级失败。仍要继续启动 dsh 吗？(y/N) > ', 'n');
      if (cont !== 'y') process.exit(1);
    }
  }
}

// 1.5) 上次遗留的插件更新：无论上次如何退出 dsh，这次启动前补装（真实运行时才处理，DRY 不碰 state）
if (!DRY) {
  const stale = readPending();
  if (stale.length) {
    say('发现上次未完成的插件更新清单：');
    if (await installPendingList(stale, '上次遗留')) writePending([]);
  }
}

// 2) 插件快速扫描（只读）
const pendingPlugins = [];
for (const p of (CONFIG.profiles === 'all' ? allProfiles() : [profile])) {
  const list = await scanPlugins(p);
  if (list.length) {
    say(`profile ${p} 有可更新插件：`);
    for (const x of list) say(`  ${x.name}：已装 ${x.installed} → 最新 ${x.latest}（声明 ${x.range}${x.inRange ? '' : '，超范围' }）`);
    pendingPlugins.push(...list.map((x) => ({ ...x, profile: p })));
  } else {
    say(`profile ${p} 插件均无更新`);
  }
}

if (DRY) { say('DRY：演练结束（不启动 dsh）'); process.exit(0); }
writePending(pendingPlugins); // 持久化本次扫描结果；空清单会清掉 state

// 3) 启动
let { code, output } = launchDsh(argv);
log('dsh exited code', code);

// 4) 自愈
if (code !== 0) {
  const entry = findFailingEntry(output);
  if (entry) {
    say(`检测到插件加载失败（${entry.id} / ${entry.name}），自动禁用后重试一次...`);
    disableEntry(profile, entry);
    ({ code, output } = launchDsh(argv));
    if (code === 0) say(`已自动禁用导致启动失败的插件 ${entry.id}，本次启动成功（如需恢复请删除 ${join(profilesDir(), profile, 'cordis.patch.yml')} 中对应行）`);
    else say('禁用后仍启动失败，请查看上方输出；patch 中的禁用条目保留，可人工排查。');
  }
}

// 5) 插件安装（dsh 正常退出后；若 updater 随 Ctrl+C 一起中断，清单已持久化，下次启动的 1.5 步兜底）
if (code === 0 && pendingPlugins.length) {
  if (await installPendingList(pendingPlugins, '本次扫描发现')) writePending([]);
  else say('已跳过插件安装（清单已保留，下次启动前会再次提醒）。');
}

process.exit(code === null ? 1 : code);
