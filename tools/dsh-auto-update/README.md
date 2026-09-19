# dsh-auto-update

在 PowerShell 里输入 `dsh web`（或 `dsh --profile <name>`）时自动完成：

1. **dsh 本体检查**：启动前对比 npm 全局安装的 `@deepseek-ai/dsh` 与镜像 registry
   （默认 npmmirror）上的发布版本。有更高版本时列出候选（自动标注推荐频道，与你本地
   版本同属 rc/latest 线的优先），确认后 `npm install -g` 升级，**升级完自动启动**。
2. **插件检查（只读）**：启动前快速扫描各 profile 的 registry 插件依赖
   （本地 `link:` 包无法远程比对，自动跳过），打印“已装 → 最新”清单。
3. **启动**：原样启动 dsh（参数全部透传），退出码保持一致。
4. **插件出错自愈**：若 dsh 因插件加载失败退出（`plugin tree failed to load` /
   `failed to import loader entry …`），自动解析失败 entry → 写入该 profile 的
   `cordis.patch.yml`（`disabled: true`）→ **自动重启一次**。核心插件
   （dsh-base / dsh-web-app / @deepseek-ai/cordis*）不会被自动禁用。
5. **插件安装**：dsh 正常退出后，若有待更新插件 → 询问确认 → 对该 profile 执行
   `pnpm update`（遵守 `package.json` 的版本范围；超范围的会提示需手动 `--latest`），
   **下次启动生效**。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会把 `updater.mjs` 复制到 `%USERPROFILE%\.dsh\tools\dsh-auto-update\`，生成
`dsh-function.ps1`，并向 PowerShell 的 `$PROFILE`（Windows PowerShell 5.1 与
PowerShell 7 的 profile 文件，谁存在注入谁）注入一个 `dsh` 函数。

之后**新开一个 PowerShell** 再输入 `dsh web` 即生效。函数内部的真正 dsh 通过
npm 全局 shim 的绝对路径调用，不会递归。

### 覆盖哪些启动方式

- PowerShell 里的 `dsh web` / `dsh --profile x` / `dsh headless`：走自动检查。
- PowerShell 里的 `dsh --help`、`dsh --version`、`dsh plugin …`：快速透传，不检查。
- cmd、双击快捷方式、其它终端：不经过本包装（如需覆盖，可把
  `%USERPROFILE%\.dsh\tools\dsh-auto-update\updater.mjs` 的调用做成 .cmd 包装）。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

只移除 `$PROFILE` 中的注入段；工具文件保留（手动移入回收站可彻底删除）。

## 配置

编辑 `%USERPROFILE%\.dsh\tools\dsh-auto-update\updater.mjs` 顶部的 `CONFIG`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mirror` | `https://registry.npmmirror.com` | 本体升级与插件查询的 registry |
| `profiles` | `'all'` | `'all'` 遍历全部 profile，或指定单 profile 名 |
| `fetchTimeoutMs` | `8000` | 单次网络查询超时 |

日志：`%USERPROFILE%\.dsh\tools\dsh-auto-update\logs\updater.log`

## 设计说明与局限

- **为什么插件在退出后才安装**：dsh 运行期间其 node_modules 文件被进程占用，
  Windows 下更新会失败；且正在加载的插件也不会因磁盘变更而生效。退出后安装、
  下次启动生效是最安全的时机。
- **为什么默认只升同频道**：你本地是 `0.1.2-rc.1`（= 镜像 `latest`）。跨频道更高的
  版本（如 `alpha` 线）会列出但需你手动选，避免静默跨线升级。
- **自愈只处理进程级启动失败**：GUI 页面内“Failed to load plugins”这类
  client 端加载错误不会让 dsh 进程退出，包装器无法感知；此类问题需人工处理。
- **被自愈禁用的插件**：会留在 `cordis.patch.yml`（带 `# [dsh-auto-update …]` 注释），
  想恢复就删掉那两行。
- **演练**：`node updater.mjs --dry-run web` 只扫描打印、不升级不启动（本仓库文件
  直接可跑，dry-run 日志写在仓库内 logs/）。

## 插件更新兜底（2026-09-09 起）

- 每次真实启动的插件扫描结果会持久化到 state\pending-plugins.json（DRY 演练不写）。
- dsh 被 Ctrl+C 或关窗口结束时，updater 可能随之中断而走不到退出后安装；此时清单已落盘，
  下一次 dsh web 会在启动前发现并询问上次遗留的更新，装完再启动 dsh（新版插件本次即生效）。
- 跳过安装时清单保留，下次启动会再次提醒；安装成功或确认无更新时自动清空。
- 想手动查看/清除遗留：编辑或删除 state\pending-plugins.json。