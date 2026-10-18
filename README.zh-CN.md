# dsh-tmux-xc

**对话可以换，远端任务继续。**

在 DeepSeek Harness 中统一看远端 tmux 任务：找到任务、查看输出、引用进任意对话，让 agent 接着操作精确目标，而不是靠名字猜。

[English](README.md) · [GitHub](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc) · [npm](https://www.npmjs.com/package/dsh-tmux-xc) · **1.0.0** · Node ≥ 22

## 不看目录，看任务

只保留主机分组，每个窗格一张卡片。socket、会话、窗口不再逐层展开；优先显示任务别名，精确层级放进“详情”和明确标注范围的操作菜单。

![浅色任务卡片](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v1.0.0/docs/images/cards-light.png)

![深色任务卡片](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v1.0.0/docs/images/cards-dark.png)

以上 1.0.0 截图来自**隔离浏览器中运行的真实插件组件，使用模拟任务清单与输出**。它们展示界面，不代表生产 SSH 连接或安装后的 DSH 端到端验收。

## 能做什么

- **直接打开终端：**点卡片标题或“打开终端”，新建 DSH 原生终端并进入精确 tmux 窗格，可直接输入。SSH 认证如有需要会显示在终端中；每次点击创建新标签，不踢掉其他连接。
- **只读快照：**独立“快照”按钮查看某一时刻的输出，刷新获取新内容，返回回到卡片。
- **引用到对话：**插入精确 tmux 目标，已发送的引用可以点回输出。插入引用本身不会发送远端输入。
- **跨对话接续：**agent 可列出、创建、登记、检查、抓取、发送、分离及删除目标。插件创建的目标自动登记；外部创建的目标需要采纳，引用或设置别名也会按需采纳。
- **快速找到任务：**搜索、本地别名、链接窗格去重，多窗格保持易区分的紧凑标题，不丢精确父级目标。
- **保留控制权：**插件审批默认开启；关闭不绕过 DSH 宿主规则或 SSH 认证。用户点击删除仍需确认。
- **精确清理：**删除窗格、窗口或会话；仅从插件移除主机，或明确选择终止远端会话。确认前列明范围，不删除文件。
- **外部连接：**仍可从“更多 → 复制 Bash / PowerShell 连接命令”使用其他终端。

![输出视图](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v1.0.0/docs/images/output-light.png)

## 安装

需要 DSH（已测试 0.2.1-rc.2）、Node ≥ 22、目标主机 tmux ≥ 3.0a，以及可非交互连接的 OpenSSH 别名。

**1.0.0 通过 GitHub 标签分发，npm 发布另行进行。**不要把 npm 的 latest 当成本仓库版本。

```sh
dsh plugin --profile <profile> add github:ZhiweiWei-NAMI/dsh-tmux-xc#v1.0.0
```

Desktop 使用随应用附带的 `dsh` 启动器，或“插件 → 添加插件 → 安装第三方插件”，不要用无关的 npm 版 CLI。也支持本地发行 tarball。安装后刷新页面；若 DSH 提示需要重启，按提示操作。

在 profile 的 `cordis.patch.yml` 配置主机：

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

别名只影响显示，不创建或改名远端 tmux。SSH 别名必须存在于实际发起连接的机器。

## 安全边界

引用绑定主机、socket、服务器代际与 tmux ID；失效目标报错，不悄悄改指向。发送成功不等于命令执行，发送后先检查/抓取，不盲目重复。会话/窗口快照取其活动窗格。

删除遵循 tmux 原生包含/链接语义，删除最后一个对象可能让服务器退出。移除主机默认仅影响插件与本地元数据，远端任务继续；终止远端需主动选择模式与会话。取消登记不终止进程，也不清除别名。

## 验证范围

1.0.0 更新卡片界面，并新增用户专用的终端准备接口与原生终端启动。565 项单元测试通过；隔离 Chromium 检查覆盖浅色/深色、320px 窄栏、搜索、快照、返回、新建终端、面板卸载、就绪后仅提交一次与提前关闭取消。真实远端的一次性 PTY 验证了精确窗格连接及旧代际拒绝；独立源码复核未发现具体阻断问题。模拟接口验证**不等于安装后的原生 DSH 端到端测试**。

原生启动需要 DSH 终端 bundle，以及探测到的 PowerShell 或 POSIX shell，不支持 cmd/fish；控制字符或不安全的 PowerShell 引号会被拒绝。等待终端可写最多 30 秒，只提交一次，断线不重放。已提交不代表 SSH 认证或 tmux 连接成功；关闭终端仅关闭本地连接，不终止远端 tmux 任务。

历史 0.1.1 实操证据覆盖 Linux DSH 0.2.1-rc.2、Node 22、tmux 3.0a、shell 和 Claude Code 2.1.302，不代表 Windows SSH/PowerShell 或所有 TUI 均已验证。不支持 `cmd.exe`；本地传输的 PowerShell 连接选项禁用。

[更新日志](docs/CHANGELOG.md) · [历史测试证据](docs/TEST-RESULTS.md) · [已知限制](docs/KNOWN-LIMITATIONS.md) · [主机配置](docs/INSTALL.zh-CN.md) · [MIT](LICENSE)
