---
name: journal
description: >
  柚子 AI 的本地状态读写能力：出手台账（当日买入 / 否决记录）、动态策略。
  纯本地文件操作，不依赖网络接口。当用户提到动态策略读写、出手台账 /
  买入否决记录等本地状态持久化操作时，使用此 skill。
  市场节点判定已云端化（market.read_market_node，见 mock skill）；总结上报
  （submit_summary）属于接口调用，亦见 mock skill。
compatibility: []
---

# 柚子 AI Skill — 本地状态读写

柚子 AI agent 的本地状态持久化入口。负责读写 `data/trade-journal-{date}.json` 与 `memory/dynamic-strategy.md`，与 mock（接口调用：行情 / 交易 / 市场节点 / 总结上报）物理隔离、各自独立 cli。盯盘 / 复盘总结全文（`data/watch-summary-{date}.md` / `data/review-summary-{date}.md`）由调度器从 run log 自动归档，不经本 skill（总纲 §7.1 / §10.1）。

> **agent 调用本 skill 的唯一方式是 `node skills/journal/cli.ts <method>`**（见下方「CLI 调用方式」），禁止编写临时脚本去 import skills/journal 模块——临时脚本写到项目工作目录之外会触发 `external_directory` 权限拦截，整轮中断。

**函数签名、入参、返回字段的权威定义在 `skills/journal/journal.ts` 的 docstring**，本文件只做索引。
字段结构、枚举值、默认值——请直接读对应函数的 docstring。

工作区根 = 项目根目录（脚本所在的最外层目录，下载解压即得、可任意重命名）。

> **市场节点判定不在本 skill**：本地 regime 阶段状态机（regime-state.json / read_regime_state / regime_advance / regime_rebuild）已于 2026-11-14 云端化改造中整体退役——节点唯一权威 = `mock/cli.ts market.read_market_node`（云端盘中实时节点 + 日级链组合，见 mock skill 与 `memory/strategies/00-market-node.md`）。

## CLI 调用方式（agent 唯一入口）

`skills/journal/cli.ts` 是 journal skill 的通用方法调用器：一行命令调用 journal 模块任意方法，结果以 JSON 输出到 stdout。

```
node skills/journal/cli.ts <method> [位置参数...] [--key value ...]
node skills/journal/cli.ts --list          # 列出全部可用方法
node skills/journal/cli.ts --help          # 打印用法
```

> 注意：本 skill 不带 `module.` 前缀（mock 是 `market.get_summary`，journal 是 `read_dynamic_strategy`），因为 journal skill 单模块。

**高频调用**：

| 用途 | 命令 |
|------|------|
| 当前动态策略 | `journal/cli.ts read_dynamic_strategy` |
| 市场节点（盘中第 0 步，云端权威） | `mock/cli.ts market.read_market_node`（见 mock skill） |

**写操作**（参数在调用前校验，未知参数会报错不会误写）：

```
node skills/journal/cli.ts write_dynamic_strategy --content '...'
```

**参数与输出约定**：

- 类型按方法签名注解自动转换：dict/list 走 JSON（支持 `@文件路径` 引用）；具名参数支持 `--key value` 与 `--key=value`
- 成功：方法返回值原样 JSON 输出；返回 None 时输出 `{"ok": true}`
- 失败：输出结构化错误 JSON（`{code, error, method, ...}`）+ 退出码非零。`code: 400` 参数错、`404` 方法不存在、`500` 执行异常

## 快速开始

```bash
node skills/journal/cli.ts --list
```

## 认证

本 skill 为纯本地文件读写，**无需认证**，不依赖 cookie / secret_key。
总结上报（HTTP 接口）见 mock skill 的 `report.submit_summary`。

---

## 一、出手台账（当日买入 / 否决记录，跨轮记忆层）

读写 `data/trade-journal-{date}.json`（按日滚动）。agent 每轮 headless 独立上下文，当日否决过谁、已出手几笔全靠本台账；「否决一致性」纪律的唯一数据源（买入记录另供复盘与持仓买入溯源）。机械层（watch_context）每轮对账后随注入块供给预聚合结果，agent 常态直接消费注入，不重复调用。

| 函数 | 用途 | 必填 |
|------|------|------|
| `record_decision(trade_date, action, stock_code, stock_name="", direction=None, price=0, volume=0, reason="", time_str=None, source="agent", stop_loss_pct=None, status="filled")` | 追加一条当日决策记录：买入成交后记 buy（含方向归属、理由与止损计划）、否决候选后记 veto（含否决理由——复买须推翻此理由） | `trade_date` / `action` / `stock_code` |
| `update_decision(trade_date, action, stock_code, patch={}, opts={})` | 原地更新一条已有记录（成交升级 pending→filled / 方向补正 / 止损计划补记） | `trade_date` / `action` / `stock_code` |
| `read_decisions(trade_date=None)` | 读当日台账（预聚合：buy_count / buy_by_direction / veto_list） | — |

**示例**：

```bash
# 买入成交后落账（买入流程硬步骤）
journal/cli.ts record_decision --trade_date 2026-10-28 --action buy --stock_code 002747 \
  --stock_name 埃斯顿 --direction 机器人 --price 30.31 --volume 300 --reason "共振成立、方向内中军"

# 否决候选后落账（当日复买须推翻此理由）
journal/cli.ts record_decision --trade_date 2026-10-28 --action veto --stock_code 603859 \
  --stock_name 能科科技 --direction 机器人 --reason "辨识度弱、主力净流入仅2150万"

# 读当日台账（agent 兜底用；常态消费机械层注入块）
journal/cli.ts read_decisions --trade_date 2026-10-28
```

## 二、动态策略

读写 `memory/dynamic-strategy.md`（仅按需改写，复盘不自动写回）。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_dynamic_strategy()` | 读动态策略 | — |
| `write_dynamic_strategy(content: str)` | 改写动态策略 | `content` |

## 三、常见调用组合

```bash
# 出手流程：买入成交 / 否决候选后落台账（跨轮记忆）
node skills/journal/cli.ts record_decision --trade_date 2026-11-14 --action buy --stock_code 002747 --stock_name 埃斯顿 --direction 机器人 --price 30.31 --volume 300 --reason "..."

# 市场节点（盘中第 0 步）：云端唯一权威，见 mock skill
node skills/mock/cli.ts market.read_market_node
```

> 总结上报到后台（HTTP）不在此 skill：调 mock 的 `report.submit_summary`。

---

## 四、调试

CLI runner 自检：

```bash
node skills/journal/cli.ts --list                              # 列出全部可用方法（验证加载链）
node skills/journal/cli.ts read_decisions --trade_date 2026-11-14   # 端到端：读台账 + JSON 输出
```
