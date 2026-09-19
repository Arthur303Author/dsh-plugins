# dsh-plugins

自建的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件与工具集合。

| 目录 | 名称 | 用途 | 许可 |
|---|---|---|---|
| [`plugins/dsh-memory`](plugins/dsh-memory) | `dsh-memory` | Claude 风格的个人记忆插件，给 agent 提供跨会话持久记忆（`remember` / `recall` / `forget` 三个工具，存储为可直接编辑的 Markdown） | MIT |
| [`plugins/dsh-screen-agent`](plugins/dsh-screen-agent) | `@dsh-external/dsh-screen-agent` | 屏幕视觉 + 模拟输入：截屏回图给模型、按原生分辨率裁剪读小字、用系统无障碍树拿可点坐标、鼠标点击与键盘注入（含"不许操作自己"的窗口保护） | BSD-3-Clause |
| [`tools/dsh-auto-update`](tools/dsh-auto-update) | `dsh-auto-update` | PowerShell 里 `dsh web` 的包装：启动前检查 dsh 本体与插件更新、插件加载失败时自动禁用并重启自愈 | — |

## 安装

三个部件都支持本地目录安装。

### dsh-memory（DSH 插件）

```powershell
dsh plugin --profile web add link:<本仓库>/plugins/dsh-memory
```

装完重启 `dsh web` 生效。可通过 profile 的 `cordis.patch.yml` 覆盖 `userDir` / `projectFile` / `defaultScope`。

### dsh-screen-agent（DSH 插件）

```powershell
dsh plugin --profile web add link:<本仓库>/plugins/dsh-screen-agent
```

需要 Node 与 PowerShell 5.1（`screen_elements` 走 .NET `UIAutomationClient`，无额外依赖）。重新构建用 `bash scripts/build.sh`。

### dsh-auto-update（PowerShell 工具，非 DSH 插件）

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\dsh-auto-update\install.ps1
```

脚本把 `updater.mjs` 安装到 `%USERPROFILE%\.dsh\tools\dsh-auto-update\`，并向 PowerShell 的 `$PROFILE` 注入一个 `dsh` 函数。卸载加 `-Uninstall`。

## 说明

- `plugins/dsh-screen-agent/lib/` 下的构建产物（含 `screen_tools.py`、`uia_elements.ps1`）随仓库分发，安装后无需再构建。
- `tools/dsh-auto-update/logs/`、`state/` 属于本机运行数据，已在 `.gitignore` 中排除。
