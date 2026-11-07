---
name: agent-route
description: 用 agent-route 派发执行文档中标注了 tier1/tier2/tier3 的步骤、启动定时监控、运行预计超过约 10 分钟的批处理作业时使用。包含派发命令与参数、限额和错误处理、监控与 ALERT 约定、任务说明写法和汇报核对规则。
---

# agent-route 派发与监控

## 派发方式

- tier1/tier2：在一次 Bash 调用里用 heredoc 从 stdin 传入任务说明：`~/.claude/agent-route/bin/agent-route <tier1|tier2> [--write] --cwd <项目目录> <<'EOF'` … `EOF`。
  - 单个派发在前台运行并设 `timeout: 600000`，结果直接返回；超时后会自动转到后台，完成时再唤醒。多个任务并行时才用 `run_in_background`。
  - 需要改文件时加 `--write`；不用 `--effort` 降低 effort；同一任务返工或补充修改时用 `--resume <日志 id>` 接着上次的线程，任务说明只写新增要求。
  - 不调用 Explore 或 codex-rescue。
- tier3：Agent 工具，`subagent_type: "tier3"`。
- 并行派发的任务不改同一批文件。

## 执行方与限额

- 执行方由 agent-route 自动选择：优先 Codex；Codex 出错或处于 5h/周限额时自动改用 Claude，限额结束或提前重置后自动切回 Codex，footer 会注明。主 agent 不需要处理限额，也不用 `--claude`（仅在我要求时使用）。
- 只有 Codex 和 Claude 都受限时才输出 `LIMIT` 块（退出码 15）：告诉我恢复时间，并用 `nohup` 睡到恢复时间后再续跑。
- 输出 `ERROR` 块时，把错误转告我，不自己派 subagent 重试。`ERROR` 提示找不到 claude 或 codex 时，先运行一次 `~/.claude/agent-route/bin/agent-route setup` 重新探测，仍失败再转告我。
- 退出码 11 表示执行方汇报未完成，按汇报中的原因处理；footer 有 `WARNING` 时先核对是否越权写入。
- `agent-route status` 可查看当前额度和路由。

## 减少唤醒

每次后台任务完成都会唤醒主会话一轮，主会话每次调用都要重读整段上下文，所以尽量减少唤醒和工具调用：

- 零碎的小任务合并成一次派发。
- 改文件的阶段带 `--verify <核对命令>` 和 `--progress-doc <执行文档>`；项目约定由主 agent 提交时再加 `--commit "<提交信息>"`。
- 不需要主 agent 判断的连续阶段用 `&&` 串在同一个后台命令里（退出码 0 表示完成、核对通过、提交成功）。
- 执行文档已写清的阶段，任务说明只写"执行 <文档> 的 <阶段>"加增量。

## 任务说明

- 只写本步骤的增量：要读和要改的具体文件、已确认的事实、产出格式和验证命令，并写明不需要了解的范围。项目通用规则已在 AGENTS.md / CLAUDE.md 里，不重复。
- 夹带日志、测试输出、他人汇报等数据时，用 `<data>` 这类标签包起来，和要求分开；短任务不必套用。
- 写明：执行方遇到方案没覆盖的情况时停下汇报，不自行决定。

## 汇报与核对

- 汇报包含：是否完成、改动的文件、验证命令及结果、与方案的偏差、遗留问题，以及 footer 里的实际模型。
- tier2 只读任务直接采信汇报。tier1 或改了文件的任务：`verify: PASS` 时不再另外核对；没有 `--verify` 时只用一条输出简短的命令核对。
- 带 `--progress-doc` 时不再手动记进度。
- 需要细节时才读 `~/.claude/agent-route/logs/<id>.log` 或 `<id>.report.md`。

## 定时监控

- 用 `~/.claude/agent-route/bin/monitor-loop --name <名称> --interval <分钟> --cwd <目录> --log <日志绝对路径> -- <命令>`，通过 Monitor 工具启动。例行结果只写日志和系统通知，只有 `ALERT` 行需要处理。
- 命令自身已输出确定性的 `ok` / `ALERT …` 时加 `--direct`：不经过模型总结，只转发命令的 `ALERT` 行和非零退出。
- `MONITOR_ERROR` 是监控自身故障，不是运行告警。
- 我问进度时读日志的最后几行回答。

## 长批处理作业（预计超过约 10 分钟）

- 脚本里输出 `ALERT <类别> <说明>` 行。作业用 `nohup … > <日志> 2>&1 &` 脱离运行，再用 `run_in_background` 运行 `~/.claude/agent-route/bin/watch-alert <日志> <进程匹配串> [已处理的 ALERT 数]`：它只在出现新的 ALERT 行或作业退出时结束，每个事件只唤醒一次。Monitor 最长 30 分钟，到期要重挂，不适合长作业。
- 环境类故障（连续认证失败、FALLBACK/ERROR）打印 ALERT 后立即中止；结果异常（所有条件都失败、指标全空、耗时远超预期）只告警不中止，由主 agent 判断是否停下。
- 结束时打印 `ALERT done <结果路径>`。
