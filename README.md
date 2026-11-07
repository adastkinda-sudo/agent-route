# agent-route

按 `tier1` / `tier2` 派发任务，优先调用 Codex，在失败、冷却或额度受限时自动交给 Claude，并记录汇报、验证结果和运行诊断。

## 目录

```text
bin/agent-route                 派发、续跑、状态查询与自测入口
bin/monitor-loop                定时运行命令，识别并转发告警
bin/watch-alert                 等待日志中的新 ALERT 或进程退出
config.json                     共享配置：模型、超时、冷却和日志策略
config.local.json               本机覆盖配置（不入库）
agents.json                     Claude 执行方定义
claude-agents/tier3.md           Claude 前端与视觉执行方定义
claude-skills/agent-route/       Claude 派发与监控 skill
test/selftest.mjs               派发自测
test/codex-stub                 离线执行方替身
test/monitor-loop.test.mjs       监控脚本离线测试
scripts/promote                 同步安装、版本标记、备份和回滚
logs/                           运行日志、任务说明和长报告（不入库）
state/                          默认额度、冷却和 history 目录（不入库）
backup/                         安装目录中的 promote-* 备份（不入库）
VERSION                         安装时生成的版本信息
```

## 安装与本机配置

当前脚本面向 macOS，需 Git、zsh、bash、Node.js（建议 24）、Python 3.11 或更新版本，以及已安装并配置好认证的 `codex` 和 `claude`。Python 用于读取 Codex 配置；CC Switch 集成还使用 Node.js 的 `node:sqlite`。桌面通知使用 macOS 的 `osascript`，无需安装项目依赖包。

```sh
git clone git@github.com:adastkinda-sudo/agent-route.git
cd agent-route
scripts/promote --dry-run
scripts/promote
~/.claude/agent-route/bin/agent-route setup
~/.claude/agent-route/bin/agent-route status
```

`scripts/promote` 默认将 `bin/`、`test/`、`config.json`、`agents.json` 安装到 `~/.claude/agent-route`，另将 `tier3.md` 和 skill 安装到 `~/.claude/agents` 与 `~/.claude/skills/agent-route`。安装前会检查工作区干净、当前提交已推送、没有运行中的线上派发，并运行 selftest；检查失败便停止。

`setup` 重新探测两个程序的可执行文件，将绝对路径写入安装目录的 `config.local.json`。自动探测失败时，在该文件填写 `codexBin`、`claudeBin` 的实际绝对路径。此文件也可覆盖 `config.json` 的其他顶层字段；合并是浅合并，覆盖 `tiers` 等对象时需提供完整对象。

### 共用状态，保留独立日志

在开发仓库的 `config.local.json` 中加入以下键，可与安装版共用额度、冷却和派发历史；若文件已有其他键，保留它们：

```json
{
  "stateDir": "~/.claude/agent-route/state"
}
```

未设置时使用脚本根目录下的 `state/`。`stateDir` 支持 `~` 开头，其他相对路径以脚本根目录为基准。日志始终保存在各自根目录的 `logs/`，不会跟随状态目录移动。开发版的真实派发会更新共用的额度和冷却状态，`status` 会显示实际状态目录、日志目录和版本；没有 `VERSION` 时显示 `version: dev`。

`AGENT_ROUTE_HOME` 仅供自测覆盖配置与运行目录；设置后忽略 `stateDir`。selftest 使用隔离目录和替身，不调用真实模型。

### Codex 流空闲超时

`config.json` 的 `codexStreamIdleTimeoutMs` 当前为 `120000`，单位为毫秒，用于普通派发、续跑、重试和监控。可在 `config.local.json` 覆盖为非负整数；设为 `0` 不覆盖，合并后的配置缺少该键时也不覆盖。

provider 从当前 Codex 配置目录的 `config.toml` 顶层 `model_provider` 读取；未指定时使用 `openai`。配置目录通常为 `$CODEX_HOME`，未设置时为 `~/.codex`，启用 CC Switch 时跟随当前路由的配置目录。对自定义 provider，通过本次命令的 `-c` 设置 `model_providers.<provider>.stream_idle_timeout_ms`；内置 `openai`、`ollama`、`lmstudio` 跳过覆盖并写入日志。不会修改 Codex 的 `config.toml`，流空闲超时与整个派发的 `codexTimeoutMinutes` 分别控制。

## 派发用法

以下摘录自 [bin/agent-route](bin/agent-route) 的 `USAGE`。运行 `bin/agent-route --help` 可看到完整用法；当前实现将其视为未知命令，向标准错误输出用法并返回 `2`。

```sh
# 默认只读，从标准输入读取任务
~/.claude/agent-route/bin/agent-route tier2 --cwd /绝对路径/项目 <<'EOF'
调查指定模块的行为，给出结论及文件位置，不修改文件。
EOF

# 允许修改，从文件读取任务，并在完成后验证（本仓库测试示例）
~/.claude/agent-route/bin/agent-route tier1 --write \
  --cwd /绝对路径/项目 --prompt-file /绝对路径/任务.md \
  --verify 'node --test test/monitor-loop.test.mjs'

# 同一任务补充要求或返工，写任务需再次指定 --write
~/.claude/agent-route/bin/agent-route tier1 --resume <日志id> --write <<'EOF'
补充本轮需要处理的要求。
EOF
```

示例中的项目、任务文件和验证命令需替换为实际路径与命令。`tier1` / `tier2` 的模型与 effort 由 `config.json` 决定；`tier3` 是单独安装的 Claude agent，不是该脚本的派发子命令。

| 参数 | 用法摘要 |
| --- | --- |
| `--write` | 允许改文件；默认只读，前后核对工作目录变化，发现写入时输出 `WARNING`。 |
| `--cwd DIR`、`--prompt-file FILE` | 指定工作目录和任务文件；无任务文件时读标准输入，无工作目录时使用当前目录。 |
| `--resume ID` | 接受日志 id 或会话 UUID；日志 id 默认沿用原目录、要求同一 tier，UUID 必须配合 `--cwd`。跟随原执行方，按本次 `--write` 决定权限。 |
| `--no-claude` | 禁止自动交给 Claude；Codex 失败时输出 `FALLBACK`，额度受限时输出 `LIMIT`。 |
| `--claude` | 直接调用 Claude，不能与 `--resume`、`--no-claude`、`--monitor` 同用。 |
| `--effort LEVEL` | 覆盖本次 Codex 的 effort：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`；不影响 Claude。 |
| `--exclude PATH` | 只读核对时排除相对工作目录的路径，可重复；也支持配置 `readOnlyExclude`。日志与状态目录在工作目录内时自动排除。 |
| `--verify COMMAND`、`--fix-rounds N` | 汇报完成后在工作目录用 `/bin/zsh -lc` 验证，可重复，每条最多 10 分钟。允许写入时验证失败可同线程返工，默认 1 轮，`0` 禁用；只读不返工。 |
| `--progress-doc PATH`、`--label TEXT` | 向已有 Markdown 文件追加最终进度（包括 `ERROR`、`FALLBACK`），可为进度行添加前缀。路径相对工作目录。 |
| `--commit MSG` | 仅配合 `--write`；完成、验证通过且无 `WARNING` 后，只提交派发期间变化的路径，不推送。 |
| `--full-output` | 保留完整终端汇报；默认满足完成、验证与无告警等条件时折叠，日志仍保留完整汇报。 |
| `--monitor` | 供监控使用，Codex 默认改用 `monitorEffort`，不解析普通任务汇报状态。 |

Codex 订阅额度受限时自动转 Claude，额度恢复后重新使用 Codex；服务商额度错误通过实际失败被动识别。Codex 续跑失败会先重试同一会话，再携带原任务和新增要求开新线程，最终失败才冷却并转 Claude；每次尝试写入日志与 history 的 `attempt` 字段。

```sh
~/.claude/agent-route/bin/agent-route status
~/.claude/agent-route/bin/agent-route stats --days 7
~/.claude/agent-route/bin/agent-route clear-cooldown
```

`status` 查看版本、目录、额度、冷却与路由；`stats` 按 tier / 模型汇总，`--days` 只接受正整数；`clear-cooldown` 清空模型冷却及当前 Codex 路由的限额记录。

### 日志与 footer

每次派发在脚本根目录的 `logs/` 写入 `<id>.log`、`<id>.prompt.md`，需要长明细时使用 `<id>.report.md`；history 保存在实际状态目录的 `history.jsonl`。配置 `logMode: "summary"` 时，成功且无 `WARNING` 的派发只保留摘要日志，仍保留完整汇报和最多 20 行重连诊断。

终端 footer 显示实际模型、effort、耗时、token 数、状态和日志 id，并按需追加：

| 字段 | 含义 |
| --- | --- |
| `reconnect N` | Codex 标准错误和事件流中匹配 `Reconnecting`、`stream disconnected`、`retry` 的行数，不区分大小写；同一行多次匹配只计一次。 |
| `capacity N` | 匹配 `at capacity` 的行数；一行可同时计入重连与容量统计。两项均为 `0` 时均不显示，否则同时显示。 |
| `stall N/Xs` | 会话 rollout 中相邻事件间隔至少 60 秒、且对应步骤输出 token 少于 500 的停顿次数与总秒数；只统计本次执行，次数为 `0` 时隐藏，缺少 token 元数据时不推测。 |

history 对应字段为 `reconnect`、`capacity`、`stall`、`stall_seconds`。这些是运行诊断计数；footer 的省略表示该项为零，或本次没有可统计的停顿数据。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 普通派发汇报“完成”；`--monitor` 不解析汇报状态。管理子命令成功也返回 `0`。 |
| `2` | 参数或配置错误；当前 `--help` 输出用法后也返回此码。 |
| `10` | 指定 `--no-claude` 后 Codex 不可用，输出 `FALLBACK`。 |
| `11` | 汇报为“部分完成”“未完成”，或无法解析汇报状态。 |
| `12` | 执行失败、续跑来源错误、防嵌套拦截，或 `setup` 缺少程序等错误。 |
| `13` | `--verify` 最终未通过。 |
| `14` | `--commit` 提交失败。 |
| `15` | 输出 `LIMIT`：指定 `--no-claude` 且 Codex 受限，或 Codex 与 Claude 均受限。 |
| `130` | 收到中断或终止信号。 |

`WARNING` 不单独决定退出码，需同时查看汇报、验证结果和告警内容。

## 开发与同步

在仓库修改后，先完成验证、审阅差异，再提交推送，最后同步安装版：

```sh
bin/agent-route selftest
node --test test/monitor-loop.test.mjs
git diff --check
git diff
git add <本次改动的文件>
git commit -m 'docs(readme): update usage'
git push origin <当前任务分支>
scripts/promote --dry-run
scripts/promote
~/.claude/agent-route/bin/agent-route status
```

`scripts/promote --dry-run` 显示差异并执行前置检查（包括 selftest），不会写入安装目录。正式同步前备份现有文件，写入包含提交、分支、时间和描述的 `VERSION`；安装目录的 `config.local.json`、日志及状态保留。`--skip-push-check` 仅跳过推送检查，`--force` 跳过工作区、推送和运行中派发检查，均不跳过 selftest。

```sh
scripts/promote --rollback --dry-run
scripts/promote --rollback
scripts/promote --rollback <promote-备份目录名>
```

回滚默认选择最近的 `promote-*` 备份，也可指定目录名；恢复前检查没有运行中的线上派发，并备份当前安装。同步或回滚后默认保留最近 10 个 `promote-*` 目录，可用 `AGENT_ROUTE_KEEP_BACKUPS` 调整；其他备份文件不自动删除。`AGENT_ROUTE_DEST`、`CLAUDE_AGENTS_DEST`、`CLAUDE_SKILLS_DEST` 分别覆盖三个安装位置，演练时应同时指向隔离目录。

## 执行方防嵌套

主 agent 负责派发、核对与后续 Git 操作，执行方只处理收到的任务。启动 Codex 或 Claude 时会设置 `AGENT_ROUTE_DEPTH=1`；执行方再次派发 `tier1` / `tier2` 会输出 `ERROR` 并返回 `12`。Claude 执行方还禁用 `agent-route` skill，且 `agents.json` 禁用 `Agent` 工具。执行方应直接完成任务并汇报，由主 agent 决定续跑或新增派发。

定时监控和长作业告警分别使用 `bin/monitor-loop`、`bin/watch-alert`；具体命令与 `ALERT` 约定见 [派发与监控 skill](claude-skills/agent-route/SKILL.md)。
