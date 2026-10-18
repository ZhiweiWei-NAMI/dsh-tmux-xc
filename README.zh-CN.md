# dsh-tmux-xc

**在 DeepSeek Harness（DSH）的不同对话中，接续管理远端 tmux 任务。**

查看已配置主机上的任务，在对话中引用精确窗格，让 agent 抓取输出、发送输入或删除已结束的任务。引用保留目标身份，不靠名称猜测；审批与明确的删除范围让操作边界清晰可见。

[English](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/README.md) · [npm](https://www.npmjs.com/package/dsh-tmux-xc) · **0.1.1** · Node ≥ 22

## 使用场景

- 换一个 DSH 对话，继续查看长时间训练任务的最新输出。
- 给正在运行的 CLI agent 一段提示词，再抓取画面确认是否已提交。
- 清理已结束实验的 tmux 会话，不删除文件，也不把其他会话作为目标。
- 点击已发送的聊天引用，回到精确窗格及其最近输出。

## 功能导览

以下是已安装插件的隔离 DSH 实例实拍，使用一次性演示任务，并非生产负载。截图采用英文界面；引用标签仍保留 **窗格** 等中文类型词。

| 任务树 | 审批开关 |
|---|---|
| ![按主机展示的任务树，含别名与不可达主机](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/task-tree.png) | ![插件审批默认开启，并提示宿主规则仍然有效](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/approval-switch.png) |
| 显示别名让子任务更好找；不可达主机仍明确显示。 | 一个开关，默认开启；DSH 宿主规则仍然生效。 |

![已发送的对话引用打开精确窗格与只读抓取结果](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/reference-navigation.png)

点击已发送的引用定位精确窗格；agent 只读演示输出，不发送输入。

<details>
<summary>只读快照与删除确认</summary>

![选中精确窗格，并放大只读快照字号](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/snapshot-preview.png)

A−/A+ 调整快照字号；它是只读快照，不是交互终端，也不流式更新。

![删除会话对话框说明精确范围](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/delete-dialog.png)

删除前列出目标与受影响的进程；不删除文件。

![显式选择远端终止模式后，仍未勾选任何会话的主机移除对话框](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/host-remove-dialog.png)

移除主机默认仅影响插件；图中已主动切到远端模式，仍无预选会话。

</details>

## 安装与快速上手

需要 **Node ≥ 22**、DSH（已测试 **0.2.1-rc.2**）、目标主机上的 **tmux ≥ 3.0a**（已测试 **3.0a**），以及可通过 SSH 别名非交互连接的 OpenSSH。

将 `<profile>` 替换成你的 DSH profile 名称：

```sh
dsh plugin --profile <profile> add dsh-tmux-xc@0.1.1
```

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中加入下列配置，将 `gpu-server` 换成自己的 SSH 别名，显示提示中的会话名换成实际 tmux 名称：

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: gpu
        label: GPU server
        ssh: gpu-server
        aliases:
          - { session: train-llm, alias: "LLM training" }
    approval:
      enabled: true
```

别名提示只改变显示，不创建或重命名远端任务；精确目标的本地别名优先于配置提示。socket 等更多配置见[安装指南](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/INSTALL.zh-CN.md)。

1. **重启 DSH 并刷新页面**：安装及配置不支持热重载。
2. 打开 **tmux**，找到任务并点击 **引用窗格**。等输入框中芯片可见后再发送消息；插入引用不会向 tmux 发送输入。
3. 先试“抓取最近输出，不要发送输入”。点击已发送的芯片即可回到该窗格；确需输入时再让 agent 发送，并按提示审批。

**从 0.1.0 升级：**先执行 `dsh plugin --profile <profile> remove dsh-tmux-xc`，再执行上面的 add 命令，最后重启 DSH。请阅读[迁移说明](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/CHANGELOG.md#migration-010--011)。

## 安全与行为速览

| 项目 | 行为 |
|---|---|
| **审批** | 默认**开启**：agent 创建/发送/删除/分离时询问。**关闭**仅取消已配置且未移除主机上的额外插件审批，不绕过 DSH 宿主规则或 SSH 认证。所有者点击删除/移除时仍需确认。优先级：面板设置 → 显式 `approval.enabled` → 旧版每键 `allow`（仅 create/send/detach）→ 默认开启。 |
| **删除** | 精确终止选中的窗格、窗口或会话，以及其包含的 tmux 资源/进程（遵循 tmux 原生的包含/链接语义；删除最后一个对象可能使该 tmux 服务器退出）。不会执行 `kill-server`，也不会删除文件。请看清范围：折叠任务行可能提供的是**删除会话**，而非删除窗格。 |
| **移除主机** | 默认**仅从插件移除**：隐藏主机，清除其登记与别名，远端 tmux 继续运行。两种模式都需输入主机 ID。终止远端会话还需主动选择该模式并勾选会话（初始为空）；全部所选会话终止成功后才移除主机。不修改 profile 配置；恢复可见性不会恢复已清除的元数据。 |
| **取消登记** | 只移除一条登记记录，不影响远端进程、已登记子项、别名或聊天历史。分离（detach）又是另一回事：只断开客户端，任务继续运行。 |
| **登记与发现** | 插件创建的目标自动登记。shell 创建的目标需通过 `tmux_xc_adopt` 采纳后登记；引用/别名操作也会按需采纳。实时清单覆盖已配置且未移除的主机/socket，不以是否登记或当前工作区为过滤条件。 |
| **发送** | 文本与 Enter 分为两个带守卫的步骤。`delivered` 表示送达，**不等于执行**；`submission.state: cleared` 是启发式结果，**不能证明执行**。恢复前先抓取/检查，切勿盲目重发文本。 |
| **身份** | 引用绑定主机、socket、服务器代际与 tmux ID，不靠显示名称匹配。失效引用明确报错，**绝不改指向**替代目标。 |
| **快照与连接** | 快照是某一时刻的只读文本，查看新输出需刷新；会话/窗口引用抓取其活动窗格。交互操作请用 **复制连接命令** 在外部终端连接；SSH 别名及配置必须存在于粘贴命令的机器上。 |

## 已测试 / 未测试

**已测试：**Linux 上的 DSH **0.2.1-rc.2 Web**、Node 22、tmux **3.0a** 与 OpenSSH。独立 SOL 实操评估及 ASTRA 证据/源码审查接受了运行时基线 `c600ece`；本次发布保持 `lib/` 不变。发送在 shell 与 **Claude Code 2.1.302** 上得到观察验证：Claude 提示词已提交，但未产生成功的模型回复。

**未验证：**Windows / Windows PowerShell 5.1、macOS、其他 DSH 或 tmux 版本，以及被接受运行时上 shell 与 Claude Code 之外的其他 TUI。**不支持 `cmd.exe`；本地传输的 PowerShell 选项已禁用。** Linux 上的 PowerShell 7.6 由管理方验证，不是独立评估者的实测。

[已知限制](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/KNOWN-LIMITATIONS.md) · [兼容性](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/COMPATIBILITY.md) · [使用指南](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/USAGE.zh-CN.md) · [安装指南](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/INSTALL.zh-CN.md) · [更新日志](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/CHANGELOG.md) · [测试结果与证据范围](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/TEST-RESULTS.md)

## 许可证

[MIT](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/LICENSE)。
