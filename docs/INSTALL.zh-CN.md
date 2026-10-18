# 安装与卸载（中文）

本文覆盖 dsh-tmux-xc 0.1.0 的安装、配置、验证与卸载。目标：DSH 0.2.1-rc.2 桌面/Web 版，Windows 上通过 OpenSSH 别名连接远端 **Linux tmux 3.0a**。

> 兼容性总览见 [COMPATIBILITY.md](COMPATIBILITY.md)。本文中标注「已验证」的内容来自管理方在 NaMILab（DSH 0.2.1-rc.2、tmux 3.0a、Node 22）上的真实运行；标注「由用户验证」的内容请按步骤自行确认。

---

## 1. 前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| DSH | 0.2.1-rc.2 | `dsh --version` |
| Node | ≥ 22 | `node --version` |
| 远端 tmux | ≥ 3.0a（3.0a 为已测试下限） | 在远端主机：`tmux -V` |
| SSH 客户端 | OpenSSH | `ssh -V`（Windows：`C:\Windows\System32\OpenSSH\ssh.exe`） |
| SSH 别名 | 已在 `~/.ssh/config` 中配置，可**非交互**登录远端 | 见下方「SSH 别名自检」 |

### SSH 别名自检（必做）

插件以 `BatchMode`（非交互）方式运行 ssh，别名必须在无提示、无密码交互的情况下可用：

```sh
ssh -o BatchMode=yes NaMILab tmux -V
```

- 输出类似 `tmux 3.0a` 即通过。
- 若密钥带口令短语：先把密钥交给 **ssh-agent**（Windows 上启用 OpenSSH Authentication Agent 服务，`ssh-add`），否则 BatchMode 下会得到 `SSH_AUTH`。
- 别名要能直接落地到 `tmux -V`：若你的登录 shell 不是默认 shell，请确保 ssh 的远端命令在默认 shell 下也能找到 `tmux`。

---

## 2. 安装

### 2.1 准备插件包

仓库根目录执行：

```sh
npm pack --pack-destination dist   # 生成 dist/dsh-tmux-xc-0.1.0.tgz
```

（`npm run pack:release` 等价。）得到压缩包后，以下任选其一作为 `dsh plugin add` 的参数：

| 形式 | 示例 |
|---|---|
| 本地 tarball（绝对路径） | `/abs/path/dsh-tmux-xc-0.1.0.tgz` |
| 本地 clone（绝对路径） | `/abs/path/dsh-tmux-xc` |
| GitHub tag | `github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.0` |

### 2.2 Linux 安装

```sh
dsh plugin --profile <profile> add /abs/path/dsh-tmux-xc-0.1.0.tgz
```

- 插件包会自动 reconcile 进 `<profile>`，无需手动复制文件。
- `<profile>` 换成你实际使用的 profile 名（DSH Web/桌面版常见的默认名可能是 `desktop` 或 `web`；`ls $DSH_HOME/profiles/` 可查）。

### 2.3 Windows 桌面版安装（由用户验证，按步骤执行）

以下为**操作指引**，非已证实的结论，请自行验证。

1. 确认 Windows OpenSSH 客户端：`ssh -V`（默认路径 `C:\Windows\System32\OpenSSH\ssh.exe`）。
2. 确认别名非交互可用（**在 PowerShell / cmd 中都试一次**）：
   ```powershell
   ssh -o BatchMode=yes NaMILab tmux -V
   ```
   需要口令短语密钥时：启用「OpenSSH Authentication Agent」服务并 `ssh-add`，否则 BatchMode 无法交互输入。
3. DSH 目录在 `%USERPROFILE%\.dsh`。确认 profile 名：
   ```powershell
   dir "%USERPROFILE%\.dsh\profiles\"
   ```
   桌面版应用常用的 profile 名为 `desktop`。
4. 安装（`<p>` 替换为上一步看到的实际 profile 名）：
   ```powershell
   dsh plugin --profile <p> add C:\path\dsh-tmux-xc-0.1.0.tgz
   ```
5. 配置 `hosts` 时使用 `ssh: NaMILab`；若 `ssh` 不在 PATH 上，加 `sshPath: C:\Windows\System32\OpenSSH\ssh.exe`（见 §3）。

---

## 3. 配置

编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（Windows 为 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），加入配置块。配置键由插件 schema 校验，完整说明见 [README.md](../README.md) 的「Configuration」。

### 3.1 最小配置（一个 SSH 主机，默认 socket）

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
```

### 3.2 多个 socket（默认 / `-L` / `-S`）

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
        sockets:
          - { id: default }
          - { id: xc, name: xc }                # tmux -L xc
          - { id: lab, path: /tmp/tmux-lab/sock } # tmux -S 绝对路径
```

### 3.3 DSH 运行在 tmux 主机本机（Linux/macOS）

不需要 ssh，用 `transport: local`：

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: local
        transport: local
```

> `transport: local` 仅适用于「DSH 进程与 tmux 在同一台主机」的场景；`ssh` 字段此时被忽略。

### 3.4 新会话 shell 初始化

`newSession.command` 指定新会话的 argv（默认 `[]` = tmux 默认 shell）：

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
        newSession:
          command: [bash, -l]   # 登录 shell → 会 source ~/.bash_profile / .profile
          cwd: ''
```

- 说明：使用登录 shell 可能有助于依赖登录初始化（`~/.bash_profile`/`.profile`）的环境——例如此前有 CLI 在 tmux 内无法登录的场景。**但请注意：此前「Claude 无法登录」问题的根因尚未被确认**，此配置只是可尝试的手段，不是已证实的修复。
- 约束：**绝不**在配置里复制任何 token/密钥，也**绝不**开启任何绕过审批的权限模式。

### 3.5 可选键

```yaml
    sshPath: ''            # 空 = PATH 上解析 ssh；Windows 可写 C:\Windows\System32\OpenSSH\ssh.exe
    sshConfigFile: ''      # 可选 -F，仅测试用；空 = 用户正常 ssh 配置
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user    # user | profile
    approval: { create: ask, send: ask, detach: ask }  # kill 始终 ask，不可配置
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

---

## 4. 生效与验证

1. **重启 DSH**。宿主代码**不支持热重载**——改动配置、安装/升级插件后必须重启 DSH（并刷新页面）。
2. 打开任意会话，右侧边栏应出现 **tmux** 标签页；输入框工具栏出现打开面板的图标。
3. 面板应展示 主机 → socket/服务器代际 → 会话 → 窗口 → 窗格 树，节点含 cmd、cwd、id（`$N`/`@N`/`%N`）、**adopted** 徽标与验证时间。
4. 点某个窗格的 **引用 / Reference**：当前输入框应出现芯片，且未发送任何内容。
5. 发送后刷新页面：历史消息中的 token `@[label](dsh-tmux:v1/...)` 应重新渲染为芯片。

### 验证清单（Windows GUI，由用户执行）

- [ ] `ssh -o BatchMode=yes NaMILab tmux -V` 非交互成功。
- [ ] `dsh plugin --profile <p> add …` 成功，且 bundle 已 reconcile 进 profile。
- [ ] 配置块已写入 `%USERPROFILE%\.dsh\profiles\<p>\cordis.patch.yml`。
- [ ] 重启 DSH 后，面板出现 "tmux" 标签并列出远端主机。
- [ ] 引用芯片插入正常；发送后刷新仍为芯片。
- [ ] agent 执行一次只读工具（如 `tmux_xc_list`）成功返回远端列表。

---

## 5. 卸载

```sh
dsh plugin --profile <profile> remove dsh-tmux-xc
```

然后：

1. 删除 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中的 `- id: tmux-xc` 配置块。
2. 重启 DSH（并刷新页面）。

### 清除注册表数据

插件把注册表（采纳/创建的条目、会话引用）存在 `$DSH_HOME/storages/dsh_tmux_xc/`（`registryScope: profile` 时为 `dsh_tmux_xc_p_<profile>`）。

- 删除该目录 = 忘记所有已采纳/创建的条目与会话引用记录。
- **卸载不会触碰远端 tmux**：远端会话、窗口、窗格与进程都不受影响。

---

## 6. 常见问题

| 症状 | 可能原因 / 处理 |
|---|---|
| 重启后没有 "tmux" 标签 | 未重启 DSH，或配置块写错（YAML 缩进 / 键名）；检查 profile 的 `cordis.patch.yml` 后重启 |
| 面板显示主机「unreachable」 | 别名不可达：先跑 `ssh -o BatchMode=yes <alias> tmux -V` 排查 |
| `SSH_AUTH` | 密钥带口令短语且 ssh-agent 未加载：`ssh-add`（Windows 启用 OpenSSH Authentication Agent 服务） |
| `SSH_HOSTKEY` | known_hosts 中主机指纹变化/不符；按你的安全流程更新 `known_hosts` |
| `REMOTE_TOOL_MISSING` | 远端未安装 tmux，或别名落地的 PATH 找不到 tmux |
| 审批卡片不出现、工具被拒 | 当前权限模式禁用了审批（"never"）；插件不会把「无法审批」当作「允许」，请在权限设置中允许审批 |
