# dsh-tmux-xc

面向 DeepSeek Harness（DSH）的**跨会话远程 tmux** 插件：右侧边栏的 "tmux" 面板以树形展示白名单主机（`主机 → socket/服务器代际 → 会话 → 窗口 → 窗格`），点击 **引用 / Reference** 在当前会话输入框插入一个结构化芯片，把该会话的 agent 绑定到**精确的某个窗格**；配套一组带审批门槛的 agent 工具，让 agent 可以安全、持久地查看并操作该窗格——即使聊天被刷新、DSH 重启、或执行 `/compact` 之后仍然有效。

纯 ESM，无构建步骤。Node ≥ 22。MIT。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **面板** | DSH Web 右侧边栏的 "tmux" 标签页（输入框工具栏还有打开入口图标）。列出 主机 → socket/服务器代际 → 会话 → 窗口 → 窗格，附带前台命令、`cwd`、id（`$N`/`@N`/`%N`）、**已采纳（adopted）** 徽标、最近验证时间。节点操作按钮：**引用（Reference）**、**复制连接命令（Copy attach）**、**忘记（Forget，仅采纳/创建的节点）**。 |
| **引用** | 点击 **引用 / Reference** 在输入框插入原生芯片 `@[label](dsh-tmux:v1/...)`，不发送任何内容、不向 tmux 敲任何键。发送后消息保留该 token，刷新页面后仍渲染为芯片。 |
| **持久绑定** | 会话内提交的引用按会话落盘存储，`/compact` 后会自动向 agent 重新播报，长会话持续可用。 |
| **Agent 工具** | `tmux_xc_*` 工具：list / inspect / resolve / references / capture / create / adopt / send / detach / forget / kill，各自有独立的权限类别。 |
| **审批** | 会改变远程状态的工具（create/send/detach）通过 DSH 原生审批卡片征询（**拒绝 / 允许一次**）。`kill` **始终**征询，并要求精确的 `confirm` 字符串。 |

## 与 DSH 既有能力的关系

复用 DSH 自身原语（右侧边栏插槽、输入触发芯片、`insertReference`、审批卡片、存储域、仅属主可用的连接路由）；**不**复用会话私有的 `dsh-terminal` 句柄，也**不**把仅本地的 `dsh-tmux-cc` 驾驶舱当作运行时依赖——详见 [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md)。

## 环境要求

- DSH 0.2.1-rc.2（Linux Web **已验证**；Windows 桌面版 **预期可用，由用户验证**）。
- Node ≥ 22。
- 远端 **tmux ≥ 3.0a**（3.0a 为已测试下限）的 Linux 主机，通过已有 OpenSSH 别名连接。
- Linux 上的 DSH 也可用 `transport: local` 直连**同一台主机**上的 tmux。

完整矩阵见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 安装（Linux）

```sh
# 三选一：
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc-0.1.0.tgz
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc          # 一个 clone
dsh plugin --profile <profile> add github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.0
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
    sshPath: ''                  # '' -> 在 PATH 上解析 "ssh"（Windows 为 ssh.exe）
    sshConfigFile: ''            # 可选 -F（仅测试用）；'' -> 用户正常配置
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user          # user | profile
    approval:
      create: ask                # ask | allow
      send: ask                  # ask | allow
      detach: ask                # ask | allow
      # kill：始终征询（不可配置）；forget/adopt：allow（仅写注册表）
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

agent 与浏览器只能从该列表中选择 `hostId`/`socketId`，永远无法自行传入 ssh 选项、别名、二进制路径或 socket 路径。

## 30 秒上手

1. 打开 **tmux** 面板，展开到目标窗格。
2. 点 **引用 / Reference** → 芯片出现在当前输入框（未发送任何内容）。
3. 告诉 agent 要做什么（"在该窗格里跑 `git status`"、"抓一下最近的输出"……），按需审批。

会话 A 可以 `create`/`adopt` 一个会话，让会话 B 能找到它；会话 B 引用某个窗格后，agent 只会作用于**那一个**窗格。任务化说明与实例见 [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)。

## Agent 工具

| 工具 | 参数 | 策略 | 用途 |
|---|---|---|---|
| `tmux_xc_list` | `hostId?`, `workspace?`, `all?` | allow | 列出 主机→会话→窗口→窗格，含 id、cwd、cmd、可达性、采纳状态 |
| `tmux_xc_inspect` | `ref` | allow | 解码引用；报告解析码 + 当前名称/cwd/cmd |
| `tmux_xc_resolve` | `ref` | allow | 解析出精确目标串（`kill` 的 `confirm` 要用它） |
| `tmux_xc_references` | — | allow | 列出**本会话**已提交的引用 |
| `tmux_xc_capture` | `ref`, `lines?` | allow | 抓取有界最近输出，净化并围栏标注为不可信 |
| `tmux_xc_adopt` | `hostId`, `socketId?`, `target` | allow（写注册表；远端只读） | 把已有 `$N`/`@N`/`%N` 采纳进注册表 |
| `tmux_xc_create` | `hostId`, `socketId?`, `kind`, `name?`, `parentRef?`, `cwd?`, `horizontal?` | `approval.create`（ask） | 创建 会话/窗口/窗格 并注册 |
| `tmux_xc_send` | `ref`, `text?`, `keys?`, `enter?` | `approval.send`（ask） | 向**单个**窗格发送输入（≤ 16 KiB，十六进制传递） |
| `tmux_xc_detach` | `ref` | `approval.detach`（ask） | 断开客户端（远端进程继续运行） |
| `tmux_xc_forget` | `ref?` 或 `key?` | allow | 仅删除注册表条目——绝不触碰远端 |
| `tmux_xc_kill` | `ref`, `confirm` | **始终 ask** | 销毁 会话/窗口/窗格；`confirm` = 精确目标串 |

在禁用审批（"never"）的权限模式下，这些会改变状态的工具会被**拒绝**，绝不会被自动放行。

## 安全与身份

- **仅白名单。** 主机/socket 全部来自配置；不存储任何凭据，不削弱主机校验（`BatchMode=yes`、`ClearAllForwardings=yes`、不转发 agent/X11、**绝不** `StrictHostKeyChecking=no`）。插件使用你的 ssh 配置与 `known_hosts`。
- **仅属主。** 客户端路由仅 DSH 属主可用；发现/采纳对远端只读。
- **稳定身份。** 引用绑定 主机指纹 + uid + socket + 服务器代际 + `$`/`@`/`%` id。重命名后仍能解析；服务器重启或名字被复用则**失败**（`SERVER_RESTARTED` / `TARGET_GONE`），而不是误定向到别的 shell。
- **动作彼此独立。** detach ≠ forget ≠ kill。开启 `synchronize-panes` 的窗口拒绝输入；抓取的输出经过净化并围栏标注为不可信。

更多见 [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)、[docs/CONTRACTS.md](docs/CONTRACTS.md)。

## 文档索引

| 文档 | 语言 | 内容 |
|---|---|---|
| [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) | 中文 | 安装、配置、验证、卸载 |
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | 中文 | 任务导向使用指南 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | English | 兼容性矩阵 |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | English | 已知限制 |
| [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) | English | 测试结果（单元、真实 ssh 集成、GUI 验收与截图） |
| [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md) | English | 为何不做运行时依赖；fork 说明 |
| [docs/PRD.md](docs/PRD.md) / [docs/DESIGN.md](docs/DESIGN.md) / [docs/CONTRACTS.md](docs/CONTRACTS.md) | English | 产品/设计/契约源头 |

## 许可证

MIT。
