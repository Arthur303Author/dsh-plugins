# dsh-plugins

自建的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件与工具集合。

## 插件

| 目录 | 名称 | 用途 | 许可 |
|---|---|---|---|
| [`plugins/dsh-screen-agent`](plugins/dsh-screen-agent) | `@dsh-external/dsh-screen-agent` | **屏幕视觉 + UI 元素操作**：截屏回图给模型、按原生分辨率裁剪读小字、用系统无障碍树**读元素（角色 / 可执行动作 / 当前状态 / 值）并按元素操作**（`screen_act`：invoke / set_value / toggle / select / expand …）、鼠标点击与键盘注入，含"不许操作自己"的窗口保护。工具按"看 → 定位 → 操作"三阶段分批放出 | BSD-3-Clause |
| [`plugins/dsh-memory`](plugins/dsh-memory) | `dsh-memory` | **跨会话持久记忆**（`remember` / `recall` / `forget` 三个工具），存储为可直接编辑的 Markdown。参数经 `defineTool` 校验，读写走 `ctx.fs`（原子写 + 版本守卫），改动以"单段字面替换"落盘，不会重写整份文件 | MIT |
| [`plugins/dsh-theme-gallery`](plugins/dsh-theme-gallery) | `dsh-theme-gallery` | **Web GUI 主题画廊**：15 套明暗双模主题，走官方 `overrideTokens` 覆盖 `--dsw-alias-*`；只做主题轨道，不注入 DOM、不碰 `document.body`/`title`/favicon | MIT |
| [`plugins/dsh-enhance`](plugins/dsh-enhance) | `dsh-enhance` | **Web GUI 增强**：官方余额 / 本轮成本 / 用量图表，注册在 `conversation.composer.dock` 与 `shell.overlay`；所有资源经 `ctx.effect` 注册，可随 slot 折叠与热重载干净移除 | MIT |
| [`tools/dsh-auto-update`](tools/dsh-auto-update) | `dsh-auto-update` | PowerShell 里 `dsh web` 的包装：启动前检查 dsh 本体与插件更新、插件加载失败时自动禁用并重启自愈 | — |

## 安装

DSH 插件通过 profile 的 `link:` 依赖**就地引用源码目录**（不复制文件），所以源码目录就是生效目录，改完重启 `dsh web` 即可。

```powershell
dsh plugin --profile web add link:<本仓库>/plugins/<插件目录>
```

> ⚠️ **改 `link:` 依赖时必须三件套一起改**：profile `package.json` 的 `link:` 值、`pnpm-lock.yaml` 里的 `specifier` / `version`、以及 `node_modules` 下的 junction。
> 只改 `package.json` 会触发 pnpm 安装并按**旧 lockfile** 把 junction 装回旧路径；旧目录一旦删除就变成悬空 junction，浏览器端会表现为 `/plugins/<包名>/client.js` **404**（host 反推不到包目录 → 判定该包"没有 client 半" → bundle 不入模块表）。

### dsh-screen-agent

需要 Node 与 PowerShell 5.1（`screen_elements` / `screen_act` 走 .NET `UIAutomationClient`，无额外依赖）。插件本体是**手写 ESM，无需构建**；`src/index.ts` 是早期脚手架产物，不参与运行。

### dsh-memory

重启 `dsh web` 后生效。可通过 profile 的 `cordis.patch.yml` 覆盖 `userDir` / `userFileName` / `projectFile` / `defaultScope`。

### dsh-theme-gallery / dsh-enhance

两者都带浏览器端（`lib/client.js`），改完**刷新页面**即可；`dsh.client.inject` 只用于排序激活。

### dsh-auto-update（PowerShell 工具，非 DSH 插件）

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\dsh-auto-update\install.ps1
```

把 `updater.mjs` 安装到 `%USERPROFILE%\.dsh\tools\dsh-auto-update\`，并向 `$PROFILE` 注入一个 `dsh` 函数。卸载加 `-Uninstall`。

## 测试

| 插件 | 命令 | 状态 |
|---|---|---|
| dsh-screen-agent | `node tests/anchor_test.mjs` | 19 / 19（分批放出策略） |
| | `python tests/test_sidecar.py` | 78 / 78（行为与拒绝路径） |
| | `python tests/test_stability.py` | 14 / 14（负载 / 句柄 / 进程） |
| dsh-memory | `node tests/data-loss.test.mjs` | 33 项断言全通过（**不再丢数据**的回归护栏） |
| dsh-theme-gallery | `npm test` | 26 / 26 |

## 说明

- 本仓库是**源码镜像**：这些插件的实际生效位置在 `~/.dsh/plugins/`，仓库保留一份受 git 管理的历史。
- `plugins/dsh-screen-agent/lib/` 随仓库分发（含 `screen_tools.py`、`uia_snapshot.ps1`、`uia_act.ps1`、`uia_elements.ps1`），安装后无需再构建。
- 该 `lib/` 目录**不能**按"构建产物"忽略——它是手写运行时源码；`.gitignore` 里已显式排除 `lib/` 规则，否则新增的 helper 脚本会被静默漏掉。
- `tools/dsh-auto-update/logs/`、`state/` 属本机运行数据，已在 `.gitignore` 中排除。

## 推送前自检

本仓库是公开的，推送前建议跑一次隐私自检（脚本会扫描**工作树 + 全部历史提交 + 文件路径**）：

```powershell
pwsh -File scripts/privacy-check.ps1
pwsh -File scripts/privacy-check.ps1 -ExtraPattern 'internal-host\.corp'   # 追加项目专有关键词
```

发现命中时，**把值改写成等价的可移植写法，而不是删掉**——删掉等于把功能改坏：

| 命中类型 | 正确改法 |
|---|---|
| 硬编码家目录 | Node：`process.env.DSH_HOME ?? join(homedir(), '.dsh')`；PowerShell：`$env:USERPROFILE` / `~` |
| 凭据 / token | 移到环境变量或本地配置文件，并把该文件写进 `.gitignore` |
| 安装脚本按本机路径生成的产物 | 不提交 + `.gitignore`（例如 `tools/dsh-auto-update/dsh-function.ps1`） |

判据是**改完之后功能仍然可用**（跑一次测试或在真机验证）。

### 自动运行（pre-push hook）

`.git/hooks/` 不被 git 跟踪，所以 hook 模板放在仓库里、每个克隆安装一次：

```powershell
pwsh -File scripts/install-hooks.ps1              # 安装
pwsh -File scripts/install-hooks.ps1 -Uninstall   # 卸载（移入回收站）
```

装好后**每次 `git push` 前自动运行**，命中即中止推送；确实需要绕过某一次用 `git push --no-verify`。

退出码语义：`0` 放行、`1` 有命中、`2` 不在仓库里、`3` **扫描本身失败**（绝不能当成干净）。