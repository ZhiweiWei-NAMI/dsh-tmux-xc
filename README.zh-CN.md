# dsh-tmux-xc

面向 DeepSeek Harness（DSH）的**跨会话远程 tmux** 插件：右侧边栏的 **tmux** 面板按“任务”展示各主机上的会话，输入框芯片（**引用**）把当前会话的 agent 绑定到**精确的某个窗格**；配套一组受审批控制的 agent 工具，让 agent 可以安全、持久地查看并操作该窗格——即使聊天被刷新、DSH 重启、或执行 `/compact` 之后仍然有效。

纯 ESM，无构建步骤。Node ≥ 22。MIT。当前版本 **0.1.1**；被接受的产物是提交 **`c600ece`**、tarball SHA-1 `b39fe0019ebffd6aeb49a78b7f86362bf72dea07`（仅凭版本号不能识别它——更早的 0.1.1 构建在发送与历史芯片导航上失败）。独立 SOL 实测点击验证了修复，独立 ASTRA 评审在该范围内接受该候选；范围与证据见 [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md)。这不代表发布或生产更新授权。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **任务式面板** | DSH Web 右侧边栏的 “tmux” 标签页（输入框工具栏还有打开入口图标）。主机下直接列出**任务**（会话）；只有一个窗口、一个窗格的会话折叠为一行，多窗口/多窗格才展开。任务行标题 = 本地别名或远端会话名；窗格行显示 `窗格 <index> · <cmd>`（有别名则用别名）。折叠的任务若其子项带不同别名，会多出一行 **包含：…** 列出子任务名（因此 `claude-ready` 折叠时也能看到开发者任务）；展开后用各自名称，不重复同一别名。**高级详情** 才显示 socket、服务器代际与 `$N`/`@N`/`%N` id。 |
| **本地别名** | 行内 **别名**（或 agent 工具 `tmux_xc_alias`）设置友好名称。它只是本插件的显示元数据：**绝不重命名远端 tmux**；对未登记的目标设置别名会顺带完成登记。 |
| **复制连接命令** | 提供 **Bash（Linux/macOS/Git Bash）** 与 **PowerShell（Windows）** 两种形式。ssh 形式为 `ssh -t -o ClearAllForwardings=yes '<别名>' '<远端 tmux 命令>'`，精确指定 socket 与会话/窗口/窗格目标。**ssh 别名及其配置必须存在于你粘贴命令的那台机器上**（插件不读取、不内嵌你的 ssh 配置）；`transport: local` 时 Bash 形式为本地 tmux 命令，在 tmux 所在机器上执行，且 **PowerShell 项为禁用状态并附说明**。**不支持 `cmd.exe`**。复制失败时剪贴板不变。 |
| **引用** | 点击 **引用** 在输入框插入原生芯片 `@[label](dsh-tmux:v1/...)`，不发送任何内容、不向 tmux 敲任何键。插入是**异步**的：请**等芯片在输入框可见后再发送**；发送后消息保留该 token，刷新页面后仍渲染为芯片。 |
| **一键导航** | 点击会话里的 tmux 芯片会打开 tmux 面板、重新解析精确身份、选中目标并显示**只读快照**。引用失效时给出明确提示，**绝不**改指向别的目标。已发送历史芯片在受测候选上验证了精确窗格、刷新、同名重建与服务器重启路径；重命名/移动目标未测。 |
| **持久绑定** | 会话内提交的引用按会话落盘存储，`/compact` 后会自动向 agent 重新播报，长会话持续可用。 |
| **Agent 工具** | `tmux_xc_*`：list / inspect / resolve / references / capture / create / adopt / alias / send / detach / forget / kill。 |
| **审批** | 面板里**一个开关**：**插件审批 开/关**，默认 **开**，统一控制 创建 / 发送 / 删除(kill) / 分离。关闭后，对已配置且未被移除的主机，这四类操作**不再弹插件审批**——但这不是授权绕过：DSH 宿主规则与 SSH 认证仍然生效（实测在关闭状态下，独立的 DSH 主机级 deny 仍拒绝了创建）。所有者亲自点击的删除/移除确认是另一套机制，仍然保留。 |
| **可靠发送** | 文本与 `Enter` 拆成两个带守卫的步骤（默认间隔 400 ms），交互式 CLI 收到的是真正的回车而不是整段粘贴。结果返回 `delivered` 与启发式 `submission` 状态——**送达不等于已执行**，`cleared` 也不能证明执行。已在 shell 与真实 Claude Code 2.1.302 上独立验证（提示词已提交，但没有成功的模型回复）；其他 TUI 与平台未验证。 |

## 与 DSH 既有能力的关系

复用 DSH 自身原语（右侧边栏插槽、输入触发芯片、`insertReference`、审批卡片、存储域、仅属主可用的连接路由）；**不**复用会话私有的 `dsh-terminal` 句柄，也**不**把仅本地的 `dsh-tmux-cc` 驾驶舱当作运行时依赖——详见 [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md)。

## 环境要求

- DSH 0.2.1-rc.2（Linux Web **已验证**；Windows 桌面版 **预期可用，用户验证待完成**，不是支持声明）。
- Node ≥ 22。
- 远端 **tmux ≥ 3.0a**（3.0a 为已测试下限）的 Linux 主机，通过已有 OpenSSH 别名连接。该别名与 ssh 配置必须在**连接机器**上存在（复制的命令只是 `ssh <别名> …`）。
- Linux 上的 DSH 也可用 `transport: local` 直连**同一台主机**上的 tmux；本地 Bash 在 tmux 所在机器执行，本地 PowerShell 已禁用。
- Windows/macOS 实际执行、PowerShell 5.1、以及 3.0a 以外的 tmux 版本**未获独立认证**。

完整矩阵见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 安装（Linux）

```sh
# 三选一：
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc-0.1.1.tgz
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc          # 一个 clone
dsh plugin --profile <profile> add github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.1
```

插件包会自动 reconcile 进 profile。然后在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中加入配置块：

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
```

……然后重启 DSH（**宿主代码不支持热重载**）。Windows 安装与卸载见 [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md)。

从 0.1.0 升级：先 `remove` 再 `add`（pnpm 对“版本号与路径都不变”的包会保留旧文件；同版本覆盖的注意事项见安装文档），完成后重启 DSH。迁移说明见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 配置

配置键（由 `lib/index.js` 校验）：

```yaml
- id: tmux-xc
  config:
    hosts:                       # 白名单；agent/浏览器只能从中选择
      - id: namilab              # [a-z0-9][a-z0-9_-]{0,31}；引用中使用的稳定键
        label: NaMILab           # 仅展示用
        ssh: NaMILab             # 用户 ssh 配置中的别名
        # transport: local       # DSH 就运行在 tmux 主机上时：本地执行脚本，不走 ssh
        sockets:                 # 白名单；默认 [{id: default}]
          - { id: default }      # tmux 默认 socket
          - { id: xc, name: xc } # tmux -L xc
          - { id: lab, path: /tmp/tmux-lab/sock } # tmux -S（绝对 POSIX 路径）
        newSession:
          command: []            # 新会话的 argv；[] = tmux 默认 shell
          cwd: ''                # 默认启动目录（'' = tmux 默认）
        aliases:                 # 仅显示用的名称提示；身份绝不从中推导
          - { session: claude-ready, window: work, alias: "tmux 插件开发" }
    sshPath: ''                  # '' -> 在 PATH 上解析 "ssh"（Windows 为 ssh.exe）
    sshConfigFile: ''            # 可选 -F（仅测试用）；'' -> 用户正常配置
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user          # user | profile
    approval:
      enabled: true              # 一个开关；true = 询问，false = 放行。不写 = 默认开启
      # create/send/detach：0.1.0 的每键 'allow' 已弃用，仅在既无面板设置、
      # 又无显式 approval.enabled 时仍然生效。kill 不可单独配置，跟随 enabled。
    send:
      enterDelayMs: 400          # 文本与 Enter 之间的间隔，0..5000 ms
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

agent 与浏览器只能从该列表中选择 `hostId`/`socketId`，永远无法自行传入 ssh 选项、别名、二进制路径或 socket 路径。

### 配置里的显示别名

`hosts[].aliases` 按**远端会话名**（可选再按**远端窗口名**）匹配，只影响面板显示：

```yaml
aliases:
  # 开发者自己的窗格：会话 claude-ready、窗口 work。
  - { session: claude-ready, window: work, alias: "tmux 插件开发" }
  # AC 的会话（把占位符换成你的远端会话名）。
  - { session: "<AC 远端会话名>", alias: "AC" }
  # AeroWorld 的会话。
  - { session: "<AeroWorld 远端会话名>", alias: "AeroWorld" }
```

- 不带 `window` 的提示是会话及其窗口/窗格的兜底；带 `window` 的提示作用于该窗口（及其窗格）。
- 提示仅用于显示，写在配置里，因此 **tmux 重启后仍然有效**；对精确目标的**本地别名优先**于配置提示。
- 本地别名按精确身份（含 tmux 服务器代际）存储；服务器重启后需重新设置本地别名（或改用配置提示）。

## 30 秒上手

1. 打开 **tmux** 面板，找到目标任务（会话）；只有多窗口/多窗格时才需要展开。折叠的任务在子项带不同别名时会显示 **包含：…** 一行。
2. 可选：先设 **别名**，再点 **引用** → **等芯片在输入框可见**（未发送任何内容）。
3. 告诉 agent 要做什么（“在该窗格里跑 `git status`”、“抓一下最近的输出”……），按需审批。

会话 A 可以 `create`/`adopt` 一个会话，让会话 B 能找到它；会话 B 引用某个窗格后，agent 只会作用于**那一个**窗格。`create` 在代码里自动登记结果。agent 通过 shell/终端工具自己起的目标会被 inventory **实时发现**（刷新后即可显示，无需先采纳），但**要登记**（持久元数据、徽标、别名/找回依据）仍需 `tmux_xc_adopt`。任务化说明与实例见 [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)。

## Agent 工具

| 工具 | 参数 | 策略 | 用途 |
|---|---|---|---|
| `tmux_xc_list` | `hostId?`, `workspace?`, `all?` | allow | 列出 主机→会话→窗口→窗格，含 id、cwd、cmd、可达性、采纳状态 |
| `tmux_xc_inspect` | `ref` | allow | 解码引用；报告解析码 + 当前名称/cwd/cmd |
| `tmux_xc_resolve` | `ref` | allow | 解析出精确目标串（`kill` 的 `confirm` 要用它） |
| `tmux_xc_references` | — | allow | 列出**本会话**已提交的引用（持久找回；**不要**按名称/id 猜目标） |
| `tmux_xc_capture` | `ref`, `lines?` | allow | 抓取有界最近输出，净化并围栏标注为不可信 |
| `tmux_xc_adopt` | `hostId`, `socketId?`, `target` | allow（写注册表；远端只读） | 把已有 `$N`/`@N`/`%N` 采纳进注册表 |
| `tmux_xc_alias` | `ref`, `alias`（字符串或 `null`） | allow（本地元数据） | 设置/清除本地别名；必要时先登记；绝不重命名远端 tmux |
| `tmux_xc_create` | `hostId`, `socketId?`, `kind`, `name?`, `parentRef?`, `cwd?`, `horizontal?` | 审批开关（create） | 创建 会话/窗口/窗格；代码内自动登记结果 |
| `tmux_xc_send` | `ref`, `text?`, `keys?`, `enter?` | 审批开关（send） | 向**单个**窗格发送输入（≤ 16 KiB，十六进制传递）；文本与 Enter 分两步且各自带守卫 |
| `tmux_xc_detach` | `ref` | 审批开关（detach） | 断开客户端（远端进程继续运行） |
| `tmux_xc_forget` | `ref?` 或 `key?` | allow | 仅删除**一条**注册表条目——绝不触碰远端，也不级联子项（面板中称 **取消登记**） |
| `tmux_xc_kill` | `ref`, `confirm` | 审批开关（delete/kill） | 只销毁一个 会话/窗口/窗格；`confirm` = 精确目标串；绝不动服务器、绝不删文件 |

插件审批开启时，四类变更工具走 DSH 原生审批卡片；关闭时，对已配置且未被移除的主机直接执行，**不再有额外插件审批卡**。DSH 自身的权限/主机 deny 是独立一层，仍然生效（实测：开关关闭时，独立安装的 DSH 主机 deny 仍拒绝了创建）。面板里由所有者亲自点击的删除/移除确认属于 UI 操作，不是插件审批卡。若 DSH 当前权限模式没有审批通道且确实需要询问，由 DSH 自己给出拒绝消息，插件绝不会把它解释为同意。

## 安全与身份

- **仅白名单。** 主机/socket 全部来自配置；不存储任何凭据，不削弱主机校验（`BatchMode=yes`、`ClearAllForwardings=yes`、不转发 agent/X11、**绝不** `StrictHostKeyChecking=no`）。插件使用你的 ssh 配置与 `known_hosts`。
- **仅属主。** 客户端路由仅 DSH 属主可用；发现/采纳对远端只读。
- **稳定身份。** 引用绑定 主机指纹 + uid + socket + 服务器代际 + `$`/`@`/`%` id。重命名后仍能解析；服务器重启或名字被复用则**失败**（`SERVER_RESTARTED` / `TARGET_GONE`），而不是误定向到别的 shell。
- **动作彼此独立。** detach ≠ 取消登记（原「忘记」）≠ kill。面板的 **删除窗格/窗口/会话** 是点击确认、范围精确的单对象销毁，绝不杀 tmux 服务器、绝不删文件。**取消登记** 只删除**这一条**登记记录，不级联到已登记的子项，也不清除别名或聊天历史。**移除主机** 默认仅清本地登记/别名（远端不动；在 **高级详情** 恢复，但登记/别名不会恢复）；终止远端会话需要**显式切换模式**并**显式勾选会话**（初始为空），且同样绝不动服务器；仅当全部所选会话终止成功才移除主机；**绝不修改** profile 配置文件。
- 开启 `synchronize-panes` 的窗口拒绝输入；抓取的输出经过净化并围栏标注为不可信。

更多见 [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)、[docs/CONTRACTS.md](docs/CONTRACTS.md)。

## 文档索引

| 文档 | 语言 | 内容 |
|---|---|---|
| [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) | 中文 | 安装、配置、验证、升级、卸载 |
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | 中文 | 任务导向使用指南（面板、别名、审批、发送、删除、错误码） |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | English | 版本历史与 0.1.0 → 0.1.1 迁移说明 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | English | 兼容性矩阵（含复制连接命令的 shell 验证范围） |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | English | 已知限制 |
| [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) | English | 测试结果（单元、真实 ssh 集成、GUI 验收） |
| [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md) | English | 为何不做运行时依赖；fork 说明 |
| [docs/PRD.md](docs/PRD.md) / [docs/DESIGN.md](docs/DESIGN.md) / [docs/CONTRACTS.md](docs/CONTRACTS.md) | English | 产品/设计/契约源头 |

## 许可证

MIT。
