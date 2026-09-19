# dsh-memory

Claude 风格的个人记忆插件，给 DeepSeek Harness 的 agent 提供跨会话持久记忆。

## 工具

| 工具 | 作用 |
|---|---|
| `remember` | 保存一条持久笔记（事实、偏好、决定、项目上下文）。参数：`content`（必填）、`topic`（可选标题）、`scope`（`user` / `project`，默认 `user`）。 |
| `recall` | 读回记忆。参数：`query`（可选过滤）、`scope`（`user` / `project` / `all`，默认 `all`）、`maxChars`（默认 12000）。 |
| `forget` | 删除内容匹配的条目。参数：`query`（必填）、`scope`（默认 `user`）。 |

## 存储

全部是**普通可编辑的 Markdown**，随时可以手工打开修改或删除：

- 用户级（跨项目共享）：`$DSH_HOME/memory/memory.md`，默认 `~/.dsh/memory/memory.md`
- 项目级（当前工作区）：`<workspace>/.dsh/memory.md`

条目格式：

```markdown
## 2026-08-15 主题
- 内容第一行
- 内容第二行
```

## 安装

```powershell
dsh plugin --profile web add ./plugins/dsh-memory   # 本目录（file: 链接）
# 或发布到 npm 后用包名安装
```

装完需重启 `dsh web` 生效。

## 配置（可选，通过 profile 的 cordis.patch.yml 覆盖）

```yaml
- id: memory
  config:
    userDir: 'C:\path\to\memory'      # 用户级记忆目录
    userFileName: 'memory.md'
    projectFile: 'C:\path\.dsh\memory.md'
    defaultScope: 'user'              # 'user' | 'project'
```

## 说明

- 依赖仅 Node 内置模块；通过 `ctx.tools.register()` 以原生 JSON Schema 注册，与 modsearch 插件同一路径。
- 记忆文件的写入发生在宿主进程内（不经过文件沙箱），与 Claude 的记忆工具行为一致；文件本身是明文 Markdown，请勿存放机密。
