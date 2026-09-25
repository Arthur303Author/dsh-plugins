# dsh-memory

Claude 风格的个人记忆插件，给 DeepSeek Harness 的 agent 提供跨会话持久记忆。

## 工具

| 工具 | 作用 |
|---|---|
| `remember` | 保存一条持久笔记（事实、偏好、决定、项目上下文）。参数：`content`（必填）、`topic`（可选分类）、`replace`（可选：替换首个含该文本的条目）、`scope`（`user` / `project`，默认 `user`）。 |
| `recall` | 读回记忆。参数：`query`（可选过滤）、`scope`（`user` / `project` / `all`，默认 `all`）、`maxChars`（默认 12000）。 |
| `forget` | 删除内容匹配的条目。参数：`query`（必填）、`scope`（默认 `user`）。 |

三个工具都经 `defineTool()` 注册，参数在进入 execute 之前就按 JSON Schema 校验；类型或取值不合法（例如 `maxChars` 传字符串、`scope` 传非法值）会直接抛 `ToolArgsError`，不会静默回退。

## 存储

全部是**普通可编辑的 Markdown**，随时可以手工打开修改或删除：

- 用户级（跨项目共享）：`$DSH_HOME/memory/memory.md`，默认 `~/.dsh/memory/memory.md`
- 项目级（当前会话工作区）：`<session workspace>/.dsh/memory.md`

条目格式（`## ` 标题 + 显式围栏，围栏让"条目边界"与笔记正文里的 `## ` 子标题不再混淆）：

```markdown
## 2026-08-15 ui
<!-- dsh-memory:entry -->
- 内容第一行
- 内容第二行
<!-- /dsh-memory:entry -->
```

旧版本写下的裸 `## ` 分节文件仍能正常读取；只有被真正改动的那一条会被升级成围栏格式，其余字节原样保留。

**写入只做「追加」或「精确替换命中片段」**，索引文件只追加一行：因此标题下的手工说明、条目之间的批注、手工编辑过的索引说明都不会被覆盖或删除。

## 配置（可选，通过 profile 的 cordis.patch.yml 覆盖）

```yaml
- id: memory
  config:
    userDir: 'C:\path\to\memory'      # 用户级记忆目录
    userFileName: 'memory.md'
    projectFile: 'C:\path\.dsh\memory.md'
    defaultScope: 'user'              # 'user' | 'project'
```

四项都由 `export const Config`（schemastery）声明，写错会被校验拒绝而不是静默失效。

## 说明

- 文件读写出入 `ctx.fs`（`resolve` / `stat` / `readText` / `writeText` / `editText` / `listDir`），因此拥有原子写入、版本守卫、沙箱策略与 `fs/observed` 广播；不使用 `node:fs`。
- 路径在 `apply()` 内解析；`project` 作用域取当前会话工作区（`exec.agent.session.header.cwd`），不再依赖进程启动目录。
- 文件本身是明文 Markdown，请勿存放机密。
