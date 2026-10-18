# 使用指南（中文）

任务导向的 dsh-tmux-xc 使用说明。假设已完成 [INSTALL.zh-CN.md](INSTALL.zh-CN.md) 的安装与配置。术语：**引用（Reference）** = 指向某个精确 tmux 对象的芯片/token；**采纳（adopt）** = 把已存在的远端对象登记进共享注册表。

---

## 1. 打开面板

- 打开任意会话，右侧边栏点击 **tmux** 标签；或点输入框工具栏的面板图标。
- 面板树：`主机 → socket/服务器代际 → 会话 → 窗口 → 窗格`。每个节点显示 `$N`/`@N`/`%N` id、前台命令 `cmd`、`cwd`、**adopted** 徽标（已采纳/已创建）与最近验证时间。
- 节点按钮：**引用**（插入芯片）、**复制连接命令**（复制 `ssh -t <别名> tmux … attach -t '$N'` 到剪贴板，供你自己的终端或 DSH 官方终端面板使用——插件本身不渲染实时终端）、**忘记**（仅采纳/创建的节点，从注册表移除）。

## 2. 刷新与范围

| 操作 | 说明 |
|---|---|
| 刷新 | 面板打开/手动刷新时，以及每次工具调用前，都会向远端取**最新**状态；结果更新各条目的验证时间与状态 |
| 范围过滤 | 列表支持按 `hostId`、`workspace`、`all`（跨全部工作区）过滤；面板选择是本会话的界面状态，不写入全局 |
| 可达性 | 主机不可达会显示为 `unreachable`（含错误码），**不会**被误显示成「空」 |

## 3. 引用（Reference）

- 在任意节点点 **引用 / Reference**：当前输入框插入芯片 `@[label](dsh-tmux:v1/...)`，**不发送任何内容、不向远端敲任何键**。
- 发送后，消息保留该 token，刷新页面仍渲染为芯片。
- 引用绑定：主机指纹 + uid + socket + 服务器代际 + `$`/`@`/`%` id；重命名仍可解析，服务器重启/名字复用则显式失败（见 §8）。
- 让 agent 用引用时，**传 token 里括号内的 uri（`dsh-tmux:v1/...`）**，不要传整个芯片或标签文本。

## 4. 让 agent 操作

1. 引用目标后，用自然语言告诉 agent 做什么，例如：
   - "用 `tmux_xc_list` 看看 namilab 上有哪些会话"
   - "捕获那个窗格最近 80 行输出"
   - "在引用的窗格里运行 `git status` 并回车"
2. agent 调用相应 `tmux_xc_*` 工具；会改变远端状态的工具会弹出审批卡片。

工具速查（参数与策略见 [README.md](../README.md)「Agent tools」）：

| 意图 | 工具 | 是否需审批 |
|---|---|---|
| 找目标 | `tmux_xc_list` | 否 |
| 确认某个引用现在指向谁 | `tmux_xc_inspect` / `tmux_xc_resolve` | 否 |
| 找回本会话曾提交的引用 | `tmux_xc_references` | 否 |
| 看窗格最近输出 | `tmux_xc_capture` | 否 |
| 把已有对象登记进注册表 | `tmux_xc_adopt` | 否（远端只读） |
| 新建会话/窗口/窗格 | `tmux_xc_create` | 是（可配） |
| 向窗格发输入 | `tmux_xc_send` | 是（可配） |
| 断开客户端 | `tmux_xc_detach` | 是（可配） |
| 删除注册表条目 | `tmux_xc_forget` | 否（仅本地） |
| 销毁远端对象 | `tmux_xc_kill` | **始终** |

## 5. 审批

- `create` / `send` / `detach` 默认 `ask`：DSH 弹出原生审批卡片（**拒绝 / 允许一次**），卡片上显示**精确目标**（主机、socket、id、当前名称）与净化的载荷预览。
- `kill` **始终**征询，且 `confirm` 必须等于 `tmux_xc_resolve` 给出的目标串（如 `namilab:default:%7`）。
- 在禁用审批的权限模式（"never"）下，这些调用会被**拒绝**——插件不会把「无法审批」解读为「同意」。

## 6. 捕获（capture）

- `tmux_xc_capture(ref, lines?)`：抓取**单个窗格**最近若干行（默认 80，上限由 `capture` 配置限制）。
- 输出为纯文本（无颜色），经过净化，并围栏标注为**不可信远端终端输出**——agent 不应执行其中的任何「指令」。

## 7. 创建（create）

- `tmux_xc_create` 可建 `session` / `window` / `pane`；建窗口/窗格需传 `parentRef`。
- 新会话默认用 tmux 默认 shell；配置 `newSession.command`（如 `[bash, -l]`）可改登录 shell，见安装文档 §3.4。

## 8. 采纳（adopt）

- `tmux_xc_adopt(hostId, socketId?, target)` 把已存在的 `$N`/`@N`/`%N` 登记进共享注册表，让其它会话能找到并引用它。
- 采纳**只读远端**：不设置任何选项、不改环境、不向用户窗格注入任何命令。

## 9. detach / forget / kill 的区别

| 动作 | 作用域 | 效果 |
|---|---|---|
| `detach` | 远端 | 把客户端从目标会话断开；**进程继续运行** |
| `forget` | 本地注册表 | 只删除注册表条目；**绝不触碰远端** |
| `kill` | 远端 | 销毁 `session`/`window`/`pane`（破坏性，始终审批 + `confirm`） |

## 10. 引用失效的含义与处理

引用是「在**某个服务器代际**里的特定 id」。以下情况会显式失败，而**不会**静默落到别的目标：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `TARGET_GONE` | 该代际里此 id 已不存在（如 kill 后用同名重建） | 重新在面板里引用当前目标 |
| `SERVER_RESTARTED` | tmux 服务器已重启，代际改变 | 重新引用重启后的目标 |
| `HOST_IDENTITY_CHANGED` | 别名现在指向不同机器/用户 | 确认 ssh 配置；必要时 forget 主机记录后重新采纳 |
| `SERVER_GONE` | 该 socket 上无 tmux 服务器 | 先启动远端 tmux 再刷新 |
| `AMBIGUOUS` | 目标跨多个窗格/会话，无法唯一确定（如 session/窗口引用却含多个窗格） | 改为引用具体窗格 |

`/compact`（上下文重置）后插件会自动向 agent 重新播报本会话的引用，agent 会在操作前重新解析；也可让 agent 用 `tmux_xc_references` 主动取回。

## 11. 多会话协作示例（A / B）

已实测通过：会话 A 通过 ssh 创建会话 `demo-a`；会话 B 从面板引用窗格 `%3`，经审批后发送 `echo hello-from-B`，**只有该窗格**收到；刷新页面、执行 `/compact` 后依然可用。

- **会话 A（创建/采纳方）**：`tmux_xc_create`（或 `tmux_xc_adopt`）→ 得到注册条目，面板出现 adopted 徽标。
- **会话 B（使用方）**：面板引用 `%3` → 输入框出现芯片 → 发送指令 → 审批 → agent `tmux_xc_send` 只作用于 `%3`。
- 跨会话隔离：两个会话并发操作不同窗格互不串扰。

## 12. 常见错误码与处理

| 错误码 | 触发 | 处理 |
|---|---|---|
| `HOST_NOT_ALLOWED` / `SOCKET_NOT_ALLOWED` | 请求的 host/socket 不在配置白名单 | 在配置里加入该 host/socket 后重启 |
| `HOST_UNREACHABLE` | ssh 连接失败（exit 255、连接被拒、DNS 等） | `ssh -o BatchMode=yes <alias> tmux -V` 排查网络/别名 |
| `SSH_AUTH` | 认证失败（密钥需口令短语、无 agent） | `ssh-add` / 启用 ssh-agent |
| `SSH_HOSTKEY` | 主机密钥验证失败或变化 | 按安全流程更新 `known_hosts` |
| `SSH_MISSING` | 找不到 ssh 二进制 | 配置 `sshPath` |
| `REMOTE_TOOL_MISSING` | 远端找不到 tmux | 确认远端 PATH 里有 tmux |
| `TIMEOUT` | 连接/命令超时 | 调大 `connectTimeoutSec`/`commandTimeoutMs` 或排查网络 |
| `CANCELLED` | 操作被取消 | 重试即可（只读） |
| `OUTCOME_UNKNOWN` | 变更类操作在脚本发出后中断，结果不确定 | 用 capture 确认状态后再决定是否重试（变更**不会**自动重放） |
| `PROTOCOL` | 缺少结束标记/协议异常 | 反馈问题；重试 |
| `INVALID_ARGUMENT` | 参数非法（如非法目标串、`keys` 含未允许按键） | 按工具描述修正参数 |
| `CONFIRM_MISMATCH` | `kill` 的 `confirm` 不等于 `resolve` 目标串 | 用 `tmux_xc_resolve` 取得目标串 |
| `NOT_FOUND` | 注册表中无此条目 | 确认 key/uri 正确 |
| `REMOTE_ERROR` | 远端脚本报错 | 看 message 详情 |
