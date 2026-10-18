# 安装与卸载（中文）

本文覆盖 dsh-tmux-xc **0.1.1** 的安装、配置、验证、升级与卸载。目标：DSH 0.2.1-rc.2 桌面/Web 版，Windows 上通过 OpenSSH 别名连接远端 **Linux tmux 3.0a**。

> 兼容性总览见 [COMPATIBILITY.md](COMPATIBILITY.md)；版本变化与 0.1.0 → 0.1.1 迁移见 [CHANGELOG.md](CHANGELOG.md)。本文中标注「已验证」的内容来自管理方在 NaMILab（DSH 0.2.1-rc.2、tmux 3.0a、Node 22）上的真实运行；标注「由用户验证」的内容请按步骤自行确认。

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
npm pack --pack-destination dist   # 生成 dist/dsh-tmux-xc-0.1.1.tgz
```

（`npm run pack:release` 等价。）得到压缩包后，以下任选其一作为 `dsh plugin add` 的参数：

| 形式 | 示例 |
|---|---|
| 本地 tarball（绝对路径） | `/abs/path/dsh-tmux-xc-0.1.1.tgz` |
| 本地 clone（绝对路径） | `/abs/path/dsh-tmux-xc` |
| GitHub tag | `github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.1` |

### 2.2 Linux 安装

```sh
dsh plugin --profile <profile> add /abs/path/dsh-tmux-xc-0.1.1.tgz
```

- 插件包会自动 reconcile 进 `<profile>`，无需手动复制文件。
- `<profile>` 换成你实际使用的 profile 名（DSH Web/桌面版常见的默认名可能是 `desktop` 或 `web`；`ls $DSH_HOME/profiles/` 可查）。

### 2.3 Windows 桌面版安装（由用户验证，按步骤执行）

以下为**操作指引**，非已证实的结论，请自行验证。

1. 确认 Windows OpenSSH 客户端：`ssh -V`（默认路径 `C:\Windows\System32\OpenSSH\ssh.exe`）。
2. 确认别名非交互可用（**在 PowerShell 中**；`cmd.exe` 不是本插件支持的目标环境）：
   ```powershell
   ssh -o BatchMode=yes NaMILab tmux -V
   ```
   需要口令短语密钥时：启用「OpenSSH Authentication Agent」服务并 `ssh-add`，否则 BatchMode 无法交互输入。
3. DSH 目录在 `%USERPROFILE%\.dsh`。确认 profile 名：
   ```powershell
   dir "$env:USERPROFILE\.dsh\profiles\"
   ```
   桌面版应用常用的 profile 名为 `desktop`。
4. 安装（`<p>` 替换为上一步看到的实际 profile 名）：
   ```powershell
   dsh plugin --profile <p> add C:\path\dsh-tmux-xc-0.1.1.tgz
   ```
5. 配置 `hosts` 时使用 `ssh: NaMILab`；若 `ssh` 不在 PATH 上，加 `sshPath: C:\Windows\System32\OpenSSH\ssh.exe`（见 §3）。

> 面板里的 **复制 PowerShell 命令** 已在 Linux 上用 PowerShell 7.6（Standard 与 Legacy 参数传递模式）验证；**Windows PowerShell 5.1 + Windows OpenSSH 未由我们验证**。若命令在 Windows 上表现异常，请反馈具体 PowerShell 版本与参数传递模式。

---

## 3. 配置

编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（Windows 为 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），加入配置块。配置键由插件 schema 校验，完整说明见 [README.zh-CN.md](../README.zh-CN.md) 的「配置」。

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

> `transport: local` 仅适用于「DSH 进程与 tmux 在同一台主机」的场景；`ssh` 字段此时被忽略。此模式下「复制 Bash 命令」只给出本地 tmux 命令（不带 ssh）；「复制 PowerShell 命令」仅适用于 ssh 主机，local 主机上会提示复制失败。

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

### 3.5 显示别名（`hosts[].aliases`）

仅用于面板显示的名称提示，按远端会话名（可选再按远端窗口名）匹配：

```yaml
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
        aliases:
          # 开发者自己的窗格：会话 claude-ready、窗口 work。
          - { session: claude-ready, window: work, alias: "tmux 插件开发" }
          # AC / AeroWorld（占位符换成你的远端会话名）。
          - { session: "<AC 远端会话名>", alias: "AC" }
          - { session: "<AeroWorld 远端会话名>", alias: "AeroWorld" }
```

- 提示**绝不**参与身份推导，也**不重命名远端 tmux**；对精确目标的**本地别名优先**。
- 配置提示写在配置里，**tmux 重启后仍然有效**；本地别名（面板/`tmux_xc_alias`）按精确身份（含服务器代际）存储，重启后可能需要重设。

### 3.6 审批开关

0.1.1 把审批收敛为**一个开关**：

```yaml
    approval:
      enabled: true    # true = 创建/发送/删除/分离 每次询问；false = 放行；不写 = 默认开
```

- 面板里的开关**优先**于配置文件；面板 **恢复默认** 会清除面板覆盖，回落到这里。
- 0.1.0 的 `approval.create/send/detach: allow` 仍被识别但**已弃用**：仅当既无面板设置、又无显式 `approval.enabled` 时，该键单独放行。迁移时建议删掉旧的每键配置，改用 `enabled`。
- `kill` 不再单独配置，跟随 `enabled`；但工具调用仍要求精确的 `confirm` 目标串。
- 这个开关只控制插件自己的审批提示：**DSH 宿主权限规则与 SSH 认证失败仍然生效**。

### 3.7 其它可选键

```yaml
    sshPath: ''            # 空 = PATH 上解析 ssh；Windows 可写 C:\Windows\System32\OpenSSH\ssh.exe
    sshConfigFile: ''      # 可选 -F，仅测试用；空 = 用户正常 ssh 配置
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user    # user | profile
    send:
      enterDelayMs: 400    # 文本与 Enter 之间的守卫间隔，0..5000 ms
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

- `send.enterDelayMs`：0.1.1 新增。文本/按键与 Enter 是两个独立步骤；这个间隔让 raw-mode 的交互式 CLI 把 Enter 当作真正的提交，而不是把 `text\r` 当成一次粘贴。一般无需修改；终端响应慢时可适当调大。
- 别名长度限制：清理控制/双向字符后 1..40 个字符，不能含 `[ ] ( )`（面板与 `tmux_xc_alias` 相同）。

---

## 4. 生效与验证

1. **重启 DSH**。宿主代码**不支持热重载**——改动配置、安装/升级插件后必须重启 DSH（并刷新页面）。
2. 打开任意会话，右侧边栏应出现 **tmux** 标签页；输入框工具栏出现打开面板的图标。
3. 面板按任务展示：`主机 → 会话（任务）`，单窗口/单窗格会话折叠为一行；点 **高级详情** 才显示 socket、服务器代际与 `$N`/`@N`/`%N` id。
4. 检查审批：头部 **插件审批：开/关** 默认为 **开**；点开可看到来源（面板/配置/默认）与 **恢复默认**。
5. 点某个窗格的 **引用**：当前输入框应出现芯片，且未发送任何内容。
6. 发送后刷新页面：历史消息中的 token `@[label](dsh-tmux:v1/...)` 应重新渲染为芯片；点击芯片应打开面板并显示只读快照。
7. 试一次 **别名**：保存后行标题变为别名，远端会话名作为次要信息显示；远端 `tmux ls` 名称不变。
8. 试一次 **复制连接命令**：菜单应有两项（Bash / PowerShell），提示写明 `cmd.exe` 不支持；可先复制到文本编辑器核对 `-o ClearAllForwardings=yes` 与精确目标。

### 验证清单（Windows GUI，由用户执行）

- [ ] `ssh -o BatchMode=yes NaMILab tmux -V` 在 PowerShell 中非交互成功。
- [ ] `dsh plugin --profile <p> add …` 成功，且 bundle 已 reconcile 进 profile。
- [ ] 配置块已写入 `%USERPROFILE%\.dsh\profiles\<p>\cordis.patch.yml`。
- [ ] 重启 DSH 后，面板出现 "tmux" 标签并列出远端主机。
- [ ] 引用芯片插入正常；发送后刷新仍为芯片；点击芯片打开只读快照。
- [ ] 审批开关显示默认 **开**，切换后刷新页面仍保持。
- [ ] 别名可保存，远端 tmux 名称未被修改。
- [ ] 复制 PowerShell 命令能在本机 PowerShell 5.1 + Windows OpenSSH 下连接（**未由插件作者验证**，请记录结果）。
- [ ] agent 执行一次只读工具（如 `tmux_xc_list`）成功返回远端列表。

---

## 5. 升级与 0.1.0 → 0.1.1 迁移

### 5.1 升级步骤

```sh
dsh plugin --profile <profile> remove dsh-tmux-xc
dsh plugin --profile <profile> add /abs/path/dsh-tmux-xc-0.1.1.tgz
```

然后**重启 DSH** 并刷新页面。

- 为什么先 `remove`：`dsh plugin add` 底层是 pnpm；若重新打包的版本号与路径不变，pnpm 会认为“已安装”而保留旧文件。`remove` 会从 profile 的 `dsh.profile.bundles` 移除，`add` 会自动加回；你的 `- id: tmux-xc` 配置块与 `storages/dsh_tmux_xc/` 注册表数据都不受影响。
- 也可以先提升 `package.json` 的 `version` 再打包，避免同版本覆盖问题。

### 5.2 行为变化（迁移要点）

| 项目 | 0.1.0 | 0.1.1 |
|---|---|---|
| 审批 | 每键 `approval.create/send/detach`（默认 ask），`kill` 始终 ask | **一个开关** `approval.enabled`（默认 **开**）；开 = 四类操作都问，关 = 都放行；`kill` 跟随开关 |
| 旧每键配置 | 生效 | **已弃用**；仅当没有面板设置、也没有显式 `approval.enabled` 时，该键的 `allow` 仍生效 |
| 面板结构 | 主机 → socket/代际 → 会话 → 窗口 → 窗格 | 主机 → **任务（会话）**；单窗口/单窗格折叠；socket/代际/id 收进 **高级详情** |
| 「忘记」 | 节点按钮 | 改名为 **取消登记**，收进 **⋯**（只删记录） |
| 工作区过滤 | 面板有「当前工作区/全部」 | **已移除**；总是显示全部工作区 |
| 删除 | 仅 agent `kill` | 面板新增 **删除窗格/窗口/会话**（点击确认，精确范围）与 **移除主机**（仅插件 / 终止所选会话） |
| 发送 | 文本与 Enter 一次发出 | 拆成两个守卫步骤（`send.enterDelayMs`，默认 400 ms），返回 `delivered`/`submission` |
| 别名 | 无 | 面板 **别名** / `tmux_xc_alias`；配置 `hosts[].aliases` 显示提示 |
| 导航 | 无 | 点击芯片打开面板 + 只读快照；失效引用明确报错 |

- **审批迁移建议**：先决定要“默认询问”还是“默认放行”，把它写成 `approval.enabled: true/false`，并删掉 0.1.0 的每键 `allow`，避免“面板/配置未设置时旧键仍生效”的意外。面板只在**当前实际生效**的旧键上显示「旧版每键配置仍生效：…」提示；一旦写了显式 `approval.enabled`，旧键即被忽略。
- 注册表数据格式向后兼容，无需手动迁移；已采纳/创建的条目、会话引用继续可读。
- 审批策略在**每次调用时读取**，改面板开关无需重启；但安装/升级插件本身仍需重启 DSH。

---

## 6. 卸载

```sh
dsh plugin --profile <profile> remove dsh-tmux-xc
```

然后：

1. 删除 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中的 `- id: tmux-xc` 配置块。
2. 重启 DSH（并刷新页面）。

### 清除注册表数据

插件把注册表（采纳/创建的条目、别名、设置、会话引用）存在 `$DSH_HOME/storages/dsh_tmux_xc/`（`registryScope: profile` 时为 `dsh_tmux_xc_p_<profile>`）。

- 删除该目录 = 忘记所有已采纳/创建的条目、别名与会话引用记录。
- **卸载不会触碰远端 tmux**：远端会话、窗口、窗格与进程都不受影响。
- 面板里的 **移除主机** 也**不会**修改 profile 配置文件；要永久去掉主机，必须自己删除配置块（见 [USAGE.zh-CN.md](USAGE.zh-CN.md) §8）。

---

## 7. 常见问题

| 症状 | 可能原因 / 处理 |
|---|---|
| 重启后没有 "tmux" 标签 | 未重启 DSH，或配置块写错（YAML 缩进 / 键名）；检查 profile 的 `cordis.patch.yml` 后重启 |
| 面板显示主机「不可达」 | 别名不可达：先跑 `ssh -o BatchMode=yes <alias> tmux -V` 排查 |
| `SSH_AUTH` | 密钥带口令短语且 ssh-agent 未加载：`ssh-add`（Windows 启用 OpenSSH Authentication Agent 服务） |
| `SSH_HOSTKEY` | known_hosts 中主机指纹变化/不符；按你的安全流程更新 `known_hosts` |
| `REMOTE_TOOL_MISSING` | 远端未安装 tmux，或别名落地的 PATH 找不到 tmux |
| 审批卡片不出现、工具被拒 | 当前权限模式没有审批通道；DSH 会用自己的消息拒绝（`requires approval, but no approval channel is available`），插件不会把「无法审批」当作「允许」 |
| 改开关后行为没变 | 看面板显示的来源：`配置文件` 表示没有面板覆盖；先用开关写入或点 **恢复默认** 清除覆盖。已移除的主机即使关掉审批也不会被工具放行 |
| 旧版每键 `allow` 还在生效 | 面板会提示；删掉配置里的 `approval.create/send/detach`，改用 `approval.enabled` |
| 别名重启后不见了 | 本地别名按精确身份（含服务器代际）存储；tmux 重启后重新设置（必要时先重新登记），或改用 `hosts[].aliases` 配置提示（跨重启有效） |
| 主机被移除后想恢复 | **高级详情 → 已移除的主机 → 恢复**；只恢复主机可见性，被清除的登记与别名不会回来 |
| 同版本重装仍是旧代码 | pnpm 对未变化的版本+路径保留旧文件；`remove` 后 `add`，或提升版本号 |
| 删除/终止结果里某个会话失败 | 远端主机可能已变化；看逐条错误码。远程移除只有在**所有**所选会话都成功时才移除主机，可改用「仅从插件移除」 |
| `cmd.exe` 里粘贴复制的命令失败 | `cmd.exe` **不支持**；请用 PowerShell |
| 发送显示 `pending` | 文本可能还在目标程序输入框；再发 `keys: ["Enter"]`，然后 `tmux_xc_capture` 核实（见 USAGE §10） |
