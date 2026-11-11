# agent-route

让 Claude 旗舰模型担任规划者，把执行工作交给 GPT（Codex）等模型作为它的 subagent。agent-route 按 `tier1` / `tier2` 派发任务，依次尝试 Codex 官方、Claude 订阅和第三方服务商兜底，并记录汇报、验证结果和运行诊断。

## 目的与工作方式

旗舰模型的规划、判断能力最强，额度也最贵、最紧张。把大量读代码、改文件、跑命令的执行过程放在主会话里，既消耗旗舰模型的额度，也会让主会话的上下文迅速膨胀，每轮重读的成本越来越高。agent-route 把这两件事分开：

- **规划者：Claude 主会话。** 负责调查、拆分任务、写执行文档、标注每一步的 tier，并在每步完成后核对汇报和验证结果。
- **执行者：GPT 等模型。** 主会话通过 [agent-route skill](claude-skills/agent-route/SKILL.md) 调用本脚本，把一步任务说明交给 Codex 执行；执行方在独立进程中完成任务，只把结构化汇报、验证结果和简短 footer 返回主会话，完整过程留在 `logs/`。
- **按任务性质分层。** `tier1` 用于需要思考的任务，`tier2` 用于步骤已写清的机械任务和只读调查，模型与 effort 在 `config.json` 中配置；前端和视觉任务交给 Claude agent [`tier3`](claude-agents/tier3.md)。
- **自动选路与兜底。** 官方 Codex 额度耗尽、熔断或故障时，按配置转到 Claude 订阅或第三方服务商，并对 Claude 用量做每日节奏控制，避免执行工作挤占规划者的额度。
- **结果可核对。** 默认只读并核对工作目录变化；`--verify` 在汇报后运行验证命令，失败可同线程返工；`--commit` 只提交本次派发改动的路径；`status`、`stats` 和 `route --explain` 用于查看额度、花费和选路原因。
- **接入 CC Switch。** 启用 `ccSwitch` 后，以只读方式读取 CC Switch（v4.0.12）的数据库和当前路由：Codex 与 Claude 跟随 CC Switch 当前选择的配置目录和服务商，官方额度保留线沿用 CC Switch 的 `codexQuotaProtection`。兜底服务商从 CC Switch 中读取，由用户在 `codexFallback.providers` 中用 `ccSwitchId` 指定使用哪些服务商，以及各 tier 的候选模型、顺序和价格系数。agent-route 不修改 CC Switch 的选择和配置。

监控和长批处理也走同一套机制：`bin/monitor-loop` 定期运行检查命令，由路由模型判断状态，只把 `ALERT` 转发给主会话。

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

### Codex 流空闲超时与传输方式

`config.json` 的 `codexStreamIdleTimeoutMs` 当前为 `120000`，单位为毫秒，用于普通派发、续跑、重试和监控。可在 `config.local.json` 覆盖为非负整数；设为 `0` 不覆盖，合并后的配置缺少该键时也不覆盖。

`config.json` 的 `codexWebsockets` 当前为 `false`：派发时设置 `supports_websockets=false`，Codex 只用 HTTPS 连接 Responses API，不再经过 WebSocket 重连后回退。设为 `true` 或删除该键时沿用 Codex 自身配置。兜底服务商的路由同样只用 HTTPS。

以上两项都按当前 provider 覆盖。provider 从当前 Codex 配置目录的 `config.toml` 顶层 `model_provider` 读取；未指定时使用 `openai`。配置目录通常为 `$CODEX_HOME`，未设置时为 `~/.codex`，启用 CC Switch 时跟随当前路由的配置目录。对自定义 provider，通过本次命令的 `-c` 设置 `model_providers.<provider>.<键>`；内置 `openai`、`ollama`、`lmstudio` 不允许覆盖，跳过并写入日志。不会修改 Codex 的 `config.toml`，流空闲超时与整个派发的 `codexTimeoutMinutes` 分别控制。

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
| `--resume ID` | 接受日志 id 或会话 UUID；日志 id 默认沿用原目录、要求同一 tier，UUID 必须配合 `--cwd`。跟随原执行方，按本次 `--write` 决定权限；原 Claude 任务续跑仍按普通用量线检查，受限时输出 `LIMIT`，确认后再用 `--urgent`。 |
| `--no-claude` | 禁止自动交给 Claude；Codex 失败时输出 `FALLBACK`，额度受限时输出 `LIMIT`。 |
| `--claude` | 直接调用 Claude，不能与 `--resume`、`--no-claude`、`--monitor` 同用。 |
| `--urgent` | 按正常顺序选路；仅当所有路由不可用时动用 Claude 应急保留，周用量上限为 `claudePacing.urgentMaxPercent`（默认 95%）。不能与 `--claude`、`--no-claude`、`--monitor` 同用。 |
| `--reset-credit` | 官方订阅受限（5h、周或保留线）时，跳过 `codexResetCredits` 的阈值规则，直接用最早到期的一张重置券；`auto: false` 时同样生效。未受限、没有可用券或 `forced-test` 模拟限额时不用。不能与 `--claude` 同用。 |
| `--ignore-budget` | 本次允许使用已达兜底服务商每日软上限或缺少单价的模型，花费仍照常记账；不能与 `--claude` 同用。 |
| `--effort LEVEL` | 覆盖本次 Codex 的 effort：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`；不影响 Claude。 |
| `--exclude PATH` | 只读核对时排除相对工作目录的路径，可重复；也支持配置 `readOnlyExclude`。日志与状态目录在工作目录内时自动排除。 |
| `--verify COMMAND`、`--fix-rounds N` | 汇报完成后在工作目录用 `/bin/zsh -lc` 验证，可重复，每条最多 10 分钟。允许写入时验证失败可同线程返工，默认 1 轮，`0` 禁用；只读不返工。 |
| `--progress-doc PATH`、`--label TEXT` | 向已有 Markdown 文件追加最终进度（包括 `ERROR`、`FALLBACK`），可为进度行添加前缀。路径相对工作目录。 |
| `--commit MSG` | 仅配合 `--write`；完成、验证通过且无 `WARNING` 后，只提交派发期间变化的路径，不推送。 |
| `--full-output` | 保留完整终端汇报；默认满足完成、验证与无告警等条件时折叠，日志仍保留完整汇报。 |
| `--monitor` | 供监控使用，Codex 默认改用 `monitorEffort`，不解析普通任务汇报状态。 |

### 路由顺序与限额

普通派发的顺序是 **Codex 官方 → Claude → 兜底服务商**。官方 Codex 按 `tiers.<tier>.codex.models` 的顺序尝试候选模型；兜底服务商按 `codexFallback.providers` 的顺序和各自的候选模型尝试。官方 5h/周限额、保留线和熔断会跳过相应路由，额度或冷却结束后自动恢复。`status` 显示每条路由的熔断剩余时间和兜底服务商当日花费。

官方重置券（`codexResetCredits`，`auto` 为 true 时生效）的用券规则：

- 5h 限额：周用量达到 `weeklyPercentForExpiring`（默认 80%），且券在 `expiringDays`（默认 3 天）内到期，才用券；否则不用。
- 周限额：距官方周额度重置超过 `minWaitHours`（默认 36 小时），且满足以下任一条件才用券：Claude 周用量超过 `claudeWeeklyPercent`（默认 60%）；读不到 Claude 用量或读数已过期；按 `claudePacing` 本次不能用 Claude；没有 Claude 候选（`--no-claude`）或 Claude 不是订阅账号；选中的券在 `expiringDays` 内到期。以上都不满足时不用券，交给 Claude。距重置不超过 `minWaitHours` 时同样不用券。

每次派发最多尝试一次用券，判断在 `route.lock` 内完成，用券后重新读取额度确认已重置；未确认则转下一条路由。日志会写明用券或跳过的原因。

Claude 订阅的正常派发受 `claudePacing` 每日用量线和 5h 上限约束。用量来自一次最小的 `claude -p --output-format stream-json --verbose` 调用中的 `rate_limit_event.rate_limit_info.unifiedWindows`，读取 `five_hour` 和 `seven_day` 的 utilization、resetsAt；这些字段属于 Claude Code 的 **@internal** 数据接口，版本升级可能改名、缺失或改变语义。读数超过 `staleMinutes`（默认 60 分钟）或字段不完整时，普通派发不使用 Claude，并转到兜底服务商；`--claude` 和耗尽时的 `--urgent` 只在能读取到足够的周限额信息时动用应急保留。

兜底服务商的每日花费是软上限，由 `codexFallback.dailyBudgetUsd` 设定。达到上限或模型没有 `codexPricing` 单价时，普通派发跳过该服务商；`--ignore-budget` 可越过这两项限制，但仍记录估算花费，无法估算时记为 `unknown`。兜底服务商的密钥只放在子进程环境变量，日志、history 和状态输出会脱敏。

全部路由不可用时，脚本计算官方额度、熔断、兜底服务商次日预算和 Claude 日线的最早恢复时间。最早恢复在 `claudePacing.maxAutoWaitMinutes`（默认 30 分钟）内会自动等待并重新选路；更久则输出 `LIMIT`、退出码 15，主 agent 应单独向用户确认，必要时再用 `--urgent`。`--no-claude` 不等待，直接输出 `FALLBACK` 或 `LIMIT`。

可观测命令：`status` 显示额度、Claude 日线与剩余、重置券、熔断和兜底服务商花费；`route <tier1|tier2> --explain` 只预演候选顺序与阻塞原因，不派发、不使用重置券；`stats [--days N]` 除模型分组外显示按路由派发次数、用券次数、兜底服务商当日花费和两边周额度剩余；`stats --failures [--days N] [--version SHA]` 按版本和失败类别汇总失败，忽略 status 为空的运行中或中间尝试起始记录，以同一派发的最终 attempt 记录为准，并列出最近 10 次失败及停顿、看门狗续跑统计，`--version` 按前缀筛选。

Codex 续跑失败会先重试同一会话，再携带原任务和新增要求开新线程，最终失败才进入下一条路由；每次尝试写入日志与 history 的 `attempt` 字段。

官方 Codex 默认启用卡住看门狗（`codexStallWatchdog.seconds: 150`、`maxResumes: 2`）。rollout 表明正在等模型且没有进行中的工具调用时，超过阈值会结束当前进程并用同一 session 续跑；每次续跑后的首次等模型阶段不监视，达到续跑上限后停止监视并让 Codex 自身的流空闲超时处理；看门狗主动结束请求不计为失败，也不会触发冷却或转交，续跑后的结果按正常流程处理。兜底服务商不启用。设置 `enabled: false` 可关闭。

### 关键配置

- `tiers.*.codex.models` 按顺序列出官方候选；保留 `model` 单值也兼容。`codexFallback.providers[]` 用 `ccSwitchId` 指定 CC Switch 中的兜底服务商，`models` 列出各 tier 的候选，`retryOfficialMinutes`、`capacityBackoffSeconds` 和 `dailyBudgetUsd` 控制重试、退避和每日软上限。
- `codexCircuit` 控制 capacity、服务端故障和认证故障的连续失败阈值、熔断时长及单次派发的最大切换次数；`codexResetCredits.auto` 控制是否自动使用官方额度重置券；`minWaitHours`、`weeklyPercentForExpiring`、`expiringDays` 和 `claudeWeeklyPercent`（0–100，默认 60）是用券阈值，见上文“路由顺序与限额”。
- `claudePacing` 控制日线起始时间、保留比例、5h 上限、最后 36 小时窗口、`urgentMaxPercent`、过期时间和自动等待上限。未知或过期的 Claude 用量读数不会阻塞 `--claude`，但普通路由会跳过 Claude。
- `codexPricing` 提供兜底服务商花费估算的输入、缓存输入和输出单价；缺少模型单价时只有 `--ignore-budget` 会使用该模型。
- `codexStallWatchdog` 控制官方 rollout 看门狗的开关、无事件阈值秒数和同一派发最多续跑次数。

```sh
~/.claude/agent-route/bin/agent-route status
~/.claude/agent-route/bin/agent-route stats --days 7
~/.claude/agent-route/bin/agent-route route tier2 --explain
~/.claude/agent-route/bin/agent-route clear-cooldown
```

`status` 查看版本、目录、额度、冷却与路由；`stats` 按 tier / 模型和最终路由汇总，`--days` 只接受正整数；`stats --failures` 忽略 status 为空的记录，同一派发有后续 attempt 时按最终记录统计，旧记录缺少版本时显示为 `unknown`；`route <tier> --explain` 只读预演选路；`clear-cooldown` 清空模型冷却及当前 Codex 路由的限额记录。

### 日志与 footer

每次派发在脚本根目录的 `logs/` 写入 `<id>.log`、`<id>.prompt.md`，需要长明细时使用 `<id>.report.md`；history 保存在实际状态目录的 `history.jsonl`，每行记录启动版本的前 7 位提交号（无法确认时为 `null`）。配置 `logMode: "summary"` 时，成功且无 `WARNING` 的派发只保留摘要日志，仍保留完整汇报和最多 20 行重连诊断。

终端 footer 显示实际模型、effort、耗时、token 数、状态和日志 id，并按需追加：

| 字段 | 含义 |
| --- | --- |
| `reconnect N` | Codex 标准错误和事件流中匹配 `Reconnecting`、`stream disconnected`、`retry` 的行数，不区分大小写；同一行多次匹配只计一次。 |
| `capacity N` | 匹配 `at capacity` 的行数；一行可同时计入重连与容量统计。两项均为 `0` 时均不显示，否则同时显示。 |
| `stall N/Xs` | 会话 rollout 中相邻事件间隔至少 60 秒、且对应步骤输出 token 少于 500 的停顿次数与总秒数；只统计本次执行，次数为 `0` 时隐藏，缺少 token 元数据时不推测。 |
| `watchdog N/Xs` | 官方 rollout 看门狗触发的同 session 续跑次数与触发前累计等待秒数；没有触发时隐藏。每次续跑后的首次等模型阶段不计时，达到上限后停止监视；工具调用尚未返回时不会触发。 |

history 对应字段为 `reconnect`、`capacity`、`stall`、`stall_seconds`、`watchdog`、`watchdog_seconds`。这些是运行诊断计数；footer 的省略表示该项为零，或本次没有可统计的停顿数据。

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

## 执行方防嵌套

主 agent 负责派发、核对与后续 Git 操作，执行方只处理收到的任务。启动 Codex 或 Claude 时会设置 `AGENT_ROUTE_DEPTH=1`；执行方再次派发 `tier1` / `tier2` 会输出 `ERROR` 并返回 `12`。Claude 执行方还禁用 `agent-route` skill，且 `agents.json` 禁用 `Agent` 工具。执行方应直接完成任务并汇报，由主 agent 决定续跑或新增派发。

定时监控和长作业告警分别使用 `bin/monitor-loop`、`bin/watch-alert`；具体命令与 `ALERT` 约定见 [派发与监控 skill](claude-skills/agent-route/SKILL.md)。
