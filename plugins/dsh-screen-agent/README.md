# @dsh-external/dsh-screen-agent

屏幕视觉 + 模拟输入：给 DSH 装一双看得见的眼睛和一只点得动的手。

| 工具 | 作用 |
|---|---|
| `screen_look` | 全屏截图（所有显示器）并作为图片返回 |
| `screen_zoom` | 按原生分辨率裁剪一块区域——读小字、找小控件 |
| `screen_windows` | 列出可见顶层窗口（z 序、标题、尺寸、状态） |
| `screen_window` | 聚焦某个窗口，可选在其中点击/输入，然后只截这个窗口 |
| `screen_elements` | **用系统无障碍树列出窗口元素**：角色、名字、**可执行动作、当前状态/值**，另附可点坐标 |
| `screen_act` | **按元素本身操作**（invoke / set_value / toggle / expand …），不量坐标、不动光标 |
| `screen_move` | **只移动光标，不按任何键**，然后返回截图 |
| `screen_click` | 按鼠标键，可选先移动过去；**不给坐标就是原地按下** |
| `screen_key` | **发送按键组合**（Esc/Tab/方向键/Enter/F1-F24/修饰键组合） |
| `screen_type` | 发送按键组合和/或文本 |
| `screen_wait` | **等屏幕变化 / 等屏幕稳定**，替代固定 sleep |

**选路顺序：`screen_key` > `screen_act` > `screen_elements` + 坐标 > 截图。**
键盘不依赖位置；元素动作不依赖像素；无障碍树给结构；截图那套是最后的兜底。

工具分三批放出（见下文「分批放出」），不是一次全给。

## UI 元素：读结构，按元素操作

`screen_elements` 对窗口跑 UI Automation，给出每个元素的**角色、名字、无障碍 id、可执行动作、当前状态/值**：

```
Button aid=Minimize "最小化 计算器" [Invoke] (0.8222, 0.14759)
Edit   aid=txtInput "" [Value,Scroll,Text] {value="hello"} (0.19539, 0.29081)
CheckBox aid=chkFlag "Flag" [Toggle] {off} (0.2286, 0.25829)
MenuItem "系统" [ExpandCollapse] {collapsed}
```

方括号里是该元素**自己声明能做什么**，花括号里是它**现在的状态**。于是有两条路：

- 要坐标：`(nx, ny)` 直接喂给 `screen_click`（不用截图、不用猜，DPI 缩放和主题切换影响不到）
- 要操作：`screen_act` 按 `name` / `automationId` / `role` 选中它，走它自己的动作

```
screen_act(window="计算器", elementAction="invoke", name="打开导航")
screen_act(window="记事本", elementAction="set_value", automationId="15", value="你好")
```

`screen_act` 支持 `invoke` / `set_value` / `toggle` / `select` / `expand` / `collapse` /
`scroll_into_view` / `focus`。它**不量坐标、不读截图、不动光标**，操作精确落在控件上，
由控件自己的事件处理器执行 —— 元素被遮挡、滚出视口、或窗口在后台都不影响命中。

### 实测：它到底能做到什么，做不到什么

**做到了**（受控实验，宿主每次真实交互都写日志，日志是地面真相）：

| 调用 | 宿主日志 |
|---|---|
| `invoke name=PING` | `BUTTON_CLICKED` |
| `toggle name=Flag` | `CHECK_CHECKED` → `CHECK_UNCHECKED` |
| `set_value aid=txtInput` | `TEXT_CHANGED -> hello-from-act` |

同时测得：**光标全程没有移动**（多次测量坐标恒定）。

**没有做到**：Windows 上**不存在后台元素投递**。实测 WPF 与 UWP 计算器，
`Invoke` / `Toggle` / `Value` 三种 pattern 都会把目标窗口**抬到前台**。
这不是本插件的缺陷，是平台事实 —— OpenAI 官方 Computer Use 文档写的是同一件事：

> On Windows, Computer Use runs on the active desktop. It can't operate in the
> background while you keep using the same Windows session, so expect ChatGPT to
> move the pointer, type, and take over the foreground.

差别在于：它还要**移动指针**，而本插件不动指针，并且操作完**把前台还给你**
（`keepFocus: true` 可关掉归还）。所以定位是「精确、不动光标、省 token，但会短暂抢焦点」，
不是「后台魔法」。

### 实测：覆盖范围与两个必须知道的坑

| 应用 | 元素数 | 说明 |
|---|---|---|
| Microsoft Edge | 首次 **49** → 稳定 **414** | 见下方"惰性构建" |
| 计算器（UWP） | 76 | 1.09 s 完成稳定采样 |
| WPF 应用 | 8 | pattern 完整 |
| Clash Verge（Tauri/WebView2） | 3 | 只暴露外壳，页面内容读不到 |
| 设置（UWP） | **0** | 不暴露无障碍树 |
| Blender | **0** | 自绘 UI，老数据 |

**坑一：Chromium 的无障碍树是惰性构建的。** 第一次 `FindAll` 只返回 49 个外壳元素
（标签栏、地址栏），同一个窗口稍后再读就是 414 个，**页面里的文字才出现**。
原因是 Chromium 在有客户端接入后才开始构建 AX 树。所以单次采样会系统性地漏掉整个页面 ——
`screen_elements` 因此**采样到连续两轮一致才返回**，并在没稳定时明确告诉你"这份列表可能不全"。

**坑二：`IsInvokePatternAvailable` 这类缓存派生属性在 .NET 客户端里读出来是空。**
PowerShell 访问不存在的成员返回 `$null` 而不是抛错，于是"静默地看起来像没有任何 pattern"。
pattern 改为对活动元素调 `GetSupportedPatterns()`；代价是每个元素一次跨进程往返，
所以稳定检测只跑本地缓存属性，pattern 探测只在稳定后做一次。

实现：`lib/uia_snapshot.ps1`（读）与 `lib/uia_act.ps1`（操作），PowerShell 5.1 +
.NET `UIAutomationClient`，无需额外依赖。`lib/uia_elements.ps1` 是旧版扁平实现，保留备用。

元素选择为什么用**指纹**而不是 token：每次工具调用都是新进程，元素对象无法跨进程存活；
而 UI Automation 的 `RuntimeId` 在 .NET 客户端是死路 —— `AutomationElement` 只有
`GetRuntimeId()`，**没有 `FromRuntimeId()`**，COM 的 `IUIAutomation` 从 PowerShell 也够不到
（`New-Object -ComObject UIAutomationClient.CUIAutomation` 直接报 Class not registered）。
按 `automationId`/`name`/`role` 重新查找反而是受支持的路，还有个好处：
UI 变了就报"没找到元素"，而不是拿着过期句柄乱操作。


## 保护窗口：不许操作自己

这个 agent 是被浏览器里的对话驱动的，**点进自己的窗口就是自杀**（开发过程中真的发生过一次）。

现在任何标题命中保护标记的窗口都会拒绝操作：

```
refusing to act on '…DeepSeek Harness…': it matches a protected marker (deepseek harness)
```

- `screen_window` 按标题拦；`screen_click` 用 `WindowFromPoint` **查点击点落在哪个窗口**再拦
- 默认标记 `DeepSeek Harness`，用环境变量 `DSH_SCREEN_AGENT_PROTECT="a,b"` 覆盖（留空即关闭）

## `screen_wait`：等，但别瞎等

固定 `sleep(350)` 是猜；这个是量。用 64×40 灰度指纹比较。

踩到的坑：**"完全相等"在真实桌面上永远不成立**——桌面歌词、时钟、光标闪烁一直动，
第一版 `stable` 模式 18 次轮询全是"仍在变"，直接超时。改成比较**变化格子的比例**
（噪声阈值 12/255，变化阈值 2%）后，同一环境 896 ms 就判定稳定。

## 为什么把"移动"和"点击"拆开

原先 `screen_click` 一步完成"移动 + 按下"。这有个隐蔽后果：

```
SetCursorPos(目标)    ← 先把光标挪过去
SendInput(按下/抬起)   ← 再按
```

于是"测量 → 点击"之间**必然发生一次光标移动**。而当目标是个浮层菜单，
**菜单会随光标重新定位**——你测到的位置，在你按下的那一刻已经失效了。
表现形式就是稳定地"点偏一行"。

拆开之后流程变成：

```
1. screen_move 到目标      ← 光标就位，UI 稳定
2. 截图确认                ← 此刻光标静止，读数与按下时同源
3. screen_click（不给坐标） ← 原地按下，零移动
```

实测验证（窗口标题栏）：

```
step1_move : Cursor placed at desktop (896,108); nothing was pressed.
step2_click: Clicked left x1 in place at the current cursor (896,108).
```

两次坐标完全一致——**按下时没有发生任何位移**。

`screen_click` 还接受 `move: false`：给了坐标但要求不要移动，用于"目标
已经就在光标下"的情况。

**只给一半坐标（有 nx 没 ny）会直接报错**，不会退化成"在原地按一下"——
后者等于朝着没人指定过的地方开火。

## 分批放出（默认开启）

完整工具面实测 84 个，本插件占 11 个。首个请求没有前缀缓存可命中，prefill 最贵，
而且它决定整条会话的策略轨迹。但一次全给也不理想：schema 每个请求都要付费，
菜单太长还会让选择变难。所以按**任务实际发生的顺序**分三批：

| 阶段 | 何时解锁 | 本插件暴露的工具 |
|---|---|---|
| 0 看 | 还没有任何 `tool/call` | `screen_look` |
| 1 读 | 已有任意 `tool/call` | + `screen_zoom` `screen_windows` `screen_window` `screen_elements` `screen_wait` `screen_key` |
| 2 操作 | **用过任一阶段 1 的工具** | + `screen_move` `screen_click` `screen_type` `screen_act` |

顺序也是本插件的选路哲学：键盘 → 元素 → 截图坐标。阶段 2 刻意排在一次真实读取之后 ——
没看过就按坐标点、或去操作一个从没列出来的元素，正是误点的来源。

工具数以源码 `OWN_TOOL_NAMES` / `TOOL_TIERS` 为准（当前 11 个），可复核：

```
node -e "import('./lib/index.js').then(m => { console.log(m.OWN_TOOL_NAMES.length); console.log(JSON.stringify(m.TOOL_TIERS)) })"
```

判断依据是 `agent.session.snapshotEvents()` 里 `tool/call` 事件的 **`data.name`**
（会话事件的负载在 `data` 字段下；写成 `event.name` 会静默取到空值，表现为永远停在阶段 1 —— 踩过）。

**实测证据**（新会话，日志抓取；该次观测时本插件为 **6** 个工具，故 `hidden=5`）：

```
events=6   toolCalls=0    toolsBefore=84  toolsAfter=79   hidden=5   ← 首轮
events=20  toolCalls=1    toolsBefore=84  toolsAfter=84   hidden=0   ← 调用一次之后
```

然后 `screen_windows` 在该会话内实际调用成功，返回了真实的窗口列表。

**实现走的是工具注册表，不是提示词。** 早期版本在 `system-prompt/assemble` 里过滤工具列表，
但那只改了模型看到的那一份：工具仍然可调用，`Tool.listTools` 也照样报告全部 11 个（实测确认）。
现在改为在 `agent/created`（以及插件激活时已存在的 agent）上调用
`agent.ctx.tools.restrict({ deny })`，由注册表**唯一的可见性解析器**统一决定 schema 展示、
`tools.get()` 与派发，三者保持一致。per-agent 注册挂在 `agent.ctx` 上，其 disposer 同时保存在插件
自己的 effect 里 —— 卸载插件不会自动销毁 `agent.ctx` 上的注册。

**实测证据**：改造前同一会话的 `Tool.listTools` 恒定报告 11 个 `screen_*`（过滤只影响模型视图）；
改造后按阶段变化 —— 全新会话见到 `screen_look` 一个，调用过一次工具后 7 个，
再调用过一次阶段 1 工具后 11 个。

改分批或关掉：`lib/index.js` 的 `TOOL_TIERS` 与 `withheldToolsFor()`；
设 `DSH_SCREEN_AGENT_STAGING=off` 可退回"一次调用后全给"。
单元测试：`node tests/anchor_test.mjs`（19 项，含三阶段、划分完整性与边界）。

### 工具入参校验的取舍

本插件的 11 个工具走**裸 `ctx.tools.register()`**，没有用官方的 `defineTool()`，因此
`parameters` 不由注册表校验。这是刻意的：本插件坚持运行时**不 import 任何 dsh 包**
（`defineTool` / `validateJsonSchemaValue` 都在 `@deepseek-ai/dsh-tools` 里），
以避免多一个加载失败点。

代价是多了一层校验责任，由 **Python sidecar 承担**：越界、负值、倒置、缺失、非数字、
`null` 坐标、非法 button、非整数 clicks、超长文本等一律在动作之前中止（`tests/test_sidecar.py`
78 项覆盖）。参数形状合法但值不合法时，模型收到的是 sidecar 的明确错误，而不是静默回落。

### 两个坑，都踩过

**API 陷阱**：`Session` 类**没有** `.events` 属性。早期脚手架模板写的是
`agent.session.events.some(...)`，照抄会**静默失效**——条件恒为假、锚定永不生效、
且不报任何错。正确入口是 `snapshotEvents()`（含 fork 继承的历史）或 `ownEvents()`。

**模型自省不可靠**：实测中 subagent 报告"`screen_windows` 未声明"，但被要求
真的发出调用后**完全成功**。锚定会让首轮看不到部分工具，模型可能在后续轮次
仍误以为它们不存在；若它选择"不尝试"，就会绕开能力。这是模型侧现象，不是插件
缺陷，但如果观察到模型"忘了"用某个工具，这是可能的原因。

## 被遮挡的窗口也能看见

`screen_look` 截的是合成后的桌面，被别的窗口盖住的窗口就是看不到。
`screen_window` 走另一条路：`PrintWindow` + `PW_RENDERFULLCONTENT` 直接读
**窗口自己的绘制表面**，所以遮挡物不出现在图里。

实测：Blender 窗口被 Edge 完全盖住时，`screen_window` 仍拿到完整的 Blender
界面，且 `focused: false`——全程没抢用户焦点。返回里的 `captureMethod` 说明走
哪条路：

- `printwindow`——直接读窗口表面，与遮挡无关（首选）
- `screen-fallback`——窗口拒绝 PrintWindow 或返回纯色时，退化为「抬起窗口 +
  从屏幕读取矩形」；若调用者传了 `focus: false`，截完会把前台还给原窗口

## 聚焦

前台锁会拒绝后台进程的 `SetForegroundWindow`。逐级升级直到成功：

1. 直接请求
2. 合成一次 ALT 按键——前台锁真正检查的是「谁拥有最后一次输入」
3. `AttachThreadInput` 附加到前台线程的输入队列
4. `SwitchToThisWindow`

两个已修的坑：

- `SetForegroundWindow` **不是同步的**，窗口管理器几毫秒后才生效。最初立即检查
  `GetForegroundWindow` 会把成功报成失败，导致模型误判聚焦失败。现在轮询等待。
- 回退路径为了读屏必须抬起窗口；`focus: false` 时截完会把前台还回去。

## 坐标：为什么是归一化而不是像素

图在传输和 provider 两侧都会被缩放，模型在自己视图上量出的像素必然偏。
所以全部工具收**归一化坐标** `0..1`——比例不随任何缩放变化。

- `screen_click`：`nx` / `ny`，全屏比例
- `screen_zoom`：`nx0` / `ny0` / `nx1` / `ny1` 四边
- `screen_window`：`nx` / `ny`，**窗口矩形**的比例（0,0 是该窗口左上角）
- 精度：2560 宽下 0.001 ≈ 2.6 像素

窗口用 index、标题子串或 hwnd 指定。**index 会随窗口抬起而变化**，操作时优先用
标题子串；`screen_windows` 的输出里两者都有。

## 为什么不把整屏切成多页

provider 对每张图有固定预算：任何尺寸都被归一到约 800×800 等效（640,000 像素，
384 token），超出部分在服务端丢弃——调大 `imagePixelBudget` 也没用。所以
「单张全屏图无损」做不到。

但 640k 像素以内的图是**无损**的。`screen_zoom` 与 `screen_window` 都从原生
分辨率取图，因此小区域是原生像素直送。这比固定切 8 页省得多：定位用一张全屏图
（384 token），需要细节时再取一块（384 token），而固定分页每次都要 ~3072 token，
且跨块目标会被切断。

## 实现

- 截图：Pillow `ImageGrab`（全屏 + per-monitor DPI aware）
- 窗口：`EnumWindows`、`PrintWindow`、DWM 扩展边框
- 输入：`ctypes` → `user32!SendInput`，真实鼠标键盘事件，**无 pyautogui 依赖**
- 图片进上下文：`ctx.get('attachments').saveImages()` → `output.render` 返回 `{type:'image'}`
- 图走 **base64 内存传递**，不落临时文件（并发安全、无磁盘残留）
- 插件本体是手写 ESM（`lib/index.js`）：**不需要编译**，不 import 任何 dsh 包

## 稳定性与安全

三套测试，全部可独立运行：

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `python tests/test_sidecar.py` | 正确性与拒绝路径 | **78/78** |
| `python tests/test_stability.py` | 持续负载、句柄、进程、并发 | **14/14** |
| `node tests/anchor_test.mjs` | 分批放出策略 | **23/23** |

`test_sidecar.py` 里窗口相关的用例会**跳过受保护窗口**再挑目标：开发机上最顶层常常
就是 DSH 自己的浏览器窗口，而它按设计被拒绝操作 —— 直接取"窗口 0"会让整套测试
莫名其妙地红掉（踩过）。

### 实测数据

**持续负载**：30 次连续截图全部成功，中位 0.22s / 最大 0.25s，首尾四分位无漂移
（延迟不随时间增长，说明没有状态累积）。

**并发**：16 路混合动作（截图 / 裁剪 / 窗口列表）全部成功；8 路并发截图的 payload
全部是可解码的完整 PNG；host 侧 4 路并发调度 313ms 完成，三张图各持独立的
attachment id（互不串扰）。

**句柄**：同一进程内连续 60 次窗口截图，GDI 对象与 USER 对象**零增长**——验证
`print_window_image` 的 `finally` 释放路径确实有效（GDI 句柄是进程级有限的，
泄漏会拖垮长时间运行的宿主）。`capture_window` 对当前桌面上每一个可见窗口
逐一调用均成功。

**进程**：12 次调用后无孤儿 `python.exe`（对比调用前后的 PID 集合）。

**边界**：整帧裁剪仍在像素预算内；发丝级裁剪被拒绝而不是崩溃；角落碎片正常处理。

其余覆盖：

- **并发安全**：图走 base64 内存传递，不落临时文件（旧固定文件名方案会在并发时竞态）
- **输入校验**：越界/负值/倒置/缺失/非数字/`null` 坐标一律拒绝且**不触碰鼠标**；
  非法 button、非整数 clicks、超长文本、非字符串 text 同样在动作前中止
- **窗口定位**：index / 标题子串 / hwnd 三条路径必须解析到同一窗口；越界索引、
  无匹配标题、空标题、布尔值全部拒绝
- **资源上限**：text ≤ 20000 字符，clicks ≤ 10，holdMs ≤ 5000ms，子进程 60s 超时，
  stdout 64 MiB 上限，裁剪区域自动收敛到像素预算
- **取消传播**：工具取消信号会 kill 子进程；启动前已取消则直接返回
- **无注入面**：`execFile` 以参数数组调用，不经 shell；数据走 stdin JSON
- **不阻塞事件循环**：解释器探测与截屏全部异步，且在 `apply()` 时预热
- **热重载**：反复 reload 后 10 个工具与锚定监听器均正常，注册无重复无丢失
- **半坐标**：`nx` 与 `ny` 必须成对出现；只给一半直接报错，绝不退化成原地点击

写测试时踩到的坑（记下来免得重犯）：`GetGuiResources` 不声明 `argtypes` 时
ctypes 会把伪句柄当 32 位整数传，函数静默返回 0——和「还没有 GDI 对象」
完全无法区分，会让泄漏检查悄悄变成永远通过。

需要注意的：

- **点击有前置保护**：窗口没能抬到前台时**拒绝点击/输入**，因为屏幕坐标此时属于
  压在它上面的窗口。这是正确性保护，不是限流
- **无安全阈值**：全屏 `screen_click` / `screen_type` 调用即真实点击/打字。
  `screen_type` 打进的是**当前焦点窗口**，别在 DSH 输入框聚焦时调用
- 截图会作为附件持久化到 `~/.dsh/attachments/`（图片进上下文必须落库），屏幕上
  的敏感内容会留在那里
- 需要带 Pillow 的 Python（自动探测 `python` / `python3` / `F:\python\python.exe`，
  可用 `DSH_SCREEN_AGENT_PYTHON` 覆盖）
- 切到纯文本模型（`deepseek-v4-flash` / `deepseek-v4-pro`）时，图片工具自动降级为
  返回截图落盘路径，而不是图片

## 装配

**本插件是普通插件（toolkit），不是 bundle。** 当前通过注入器加载。

现状：

- profile `web` 的 `dependencies` 有 `link:` 指向本目录
- `node_modules/@dsh-external/dsh-screen-agent` junction 存在
- `dsh.profile.bundles` **不含**本包，`cordis.patch.yml` 也没有条目

### 教训：一次真实的启动事故

2026-09-14，用 `dev_install_package` 装配本插件，它把包名写进了
`dsh.profile.bundles`。但本包的 `package.json` **没有 `dsh` 声明字段**，
不具备 bundle 资格——`dsh-app-boot` 在 profile 组装阶段断言失败，
**整个 DSH 起不来**（服务未监听 3080）。移除那一项后恢复。

用错工具是根因：

| 工具 | 面向 | 副作用 |
|---|---|---|
| `dev_inject_plugin` | 普通插件 | junction + loader.create，**不碰 profile 配置** |
| `dev_install_package` | **bundle** | 写 `dsh.profile.bundles`，要求包有 bundle 声明 |

当时还把工具返回里的"重启后由 bundles 列表正常装配"当成已验证的保证、
照抄进了文档。**没有验证过的事不该写成结论。**

### 要持久化到重启，二选一

**方案 A — 保持普通插件**，在 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: screen-agent
      name: '@dsh-external/dsh-screen-agent'
```

**方案 B — 转正为 bundle**：先给本包 `package.json` 补上 bundle 声明字段，
**确认声明有效之后**，才能进 `dsh.profile.bundles`。

顺序不能颠倒：`bundles` 是启动路径，写错就是起不来。

重新加载改动：`dev_reload_package {"packageName": "dsh-screen-agent"}`
