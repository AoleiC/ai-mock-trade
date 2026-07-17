---
name: journal
description: >
  柚子 AI 的总结与写文档能力：本地状态读写（交易日志、自选池、复盘总结、动态策略）。
  纯本地文件操作，不依赖网络接口。当用户提到交易日志、自选池、复盘总结、
  每日总结、动态策略读写、追加操作记录、追加情绪快照等本地状态持久化操作时，
  使用此 skill。总结上报（submit_summary）属于接口调用，见 mock skill。
compatibility: []
---

# 柚子 AI Skill — 总结与写文档（本地状态读写）

柚子 AI agent 的本地状态持久化入口。负责读写 `data/` 与 `memory/` 下的状态文件，与 mock（接口调用：行情 / 交易 / 总结上报）物理隔离、各自独立 cli。

> **agent 调用本 skill 的唯一方式是 `skills/journal/cli.py`**（见下方「CLI 调用方式」），禁止编写临时 .py 脚本去 import skills.journal——临时脚本写到项目工作目录之外会触发 `external_directory` 权限拦截，整轮中断。

**函数签名、入参、返回字段的权威定义在 `journal.py` 的 docstring**，本文件只做索引。
字段结构、枚举值、默认值——请直接读对应函数的 docstring。

工作区根 = 项目根目录（脚本所在的最外层目录，下载解压即得、可任意重命名）。

## CLI 调用方式（agent 唯一入口）

`skills/journal/cli.py` 是 journal skill 的通用方法调用器：一行命令调用 journal 模块任意方法，结果以 JSON 输出到 stdout。

```
python skills/journal/cli.py <method> [位置参数...] [--key value ...]
python skills/journal/cli.py --list          # 列出全部可用方法
python skills/journal/cli.py --help          # 打印用法
```

> 注意：本 skill 不带 `module.` 前缀（mock 是 `market.get_summary`，journal 是 `read_trade_log`），因为 journal skill 单模块。

**高频调用**：

| 用途 | 命令 |
|------|------|
| 今日交易日志 | `cli.py read_trade_log` |
| 指定日期交易日志 | `cli.py read_trade_log --date 2026-07-04` |
| 自选池 | `cli.py read_watchlist` |
| 昨日复盘 | `cli.py read_daily_summary` |
| 当前动态策略 | `cli.py read_dynamic_strategy` |

**写操作**（参数在调用前校验，未知参数会报错不会误写）：

```
python skills/journal/cli.py append_trade_action buy 603019 中科曙光 45.0 100 "主线龙头符合买点"
python skills/journal/cli.py append_emotion_snapshot 主升 65 5 AI算力
python skills/journal/cli.py write_dynamic_strategy --content '...'
```

**参数与输出约定**：

- 类型按方法签名注解自动转换：`stock_code`（str）保持字符串，`volume`（int）的 `"100"` 转 int；具名参数支持 `--key value` 与 `--key=value`
- 成功：方法返回值原样 JSON 输出；返回 None 时输出 `{"ok": true}`
- 失败：输出结构化错误 JSON（`{code, error, method, ...}`）+ 退出码非零。`code: 400` 参数错、`404` 方法不存在、`500` 执行异常

## 快速开始

```python
from skills.journal.journal import (
    read_trade_log, write_trade_log, append_trade_action,
    read_watchlist, write_watchlist,
    read_daily_summary, write_daily_summary,
    read_dynamic_strategy, write_dynamic_strategy,
)
```

## 认证

本 skill 为纯本地文件读写，**无需认证**，不依赖 cookie / secret_key。
总结上报（HTTP 接口）见 mock skill 的 `report.submit_summary`。

---

## 一、交易日志

读写 `data/trade-log-{date}.json`，含操作记录与情绪快照。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_trade_log(date=None)` | 读当日交易日志 | — |
| `write_trade_log(data: dict, date=None)` | 写当日交易日志 | `data` |
| `append_trade_action(action, stock_code, stock_name, price, volume, reason)` | 追加一条操作记录 | 全部 6 个 |
| `append_emotion_snapshot(phase, zt_count, lb_height, main_line, extra=None)` | 追加情绪快照 | 前 4 个 |

**示例**：
```bash
# 读
cli.py read_trade_log
cli.py read_trade_log --date 2026-07-04

# 追加操作（位置参数顺序：action → code → name → price → volume → reason）
cli.py append_trade_action buy 603019 中科曙光 45.0 100 "主线龙头符合买点"

# 追加情绪快照（顺序：phase → zt_count → lb_height → main_line → [extra JSON]）
cli.py append_emotion_snapshot 主升 65 5 AI算力
cli.py append_emotion_snapshot 主升 65 5 AI算力 --extra='{"note":"开盘放量"}'
```

## 二、自选池

读写 `data/watchlist-{date}.json`。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_watchlist(date=None)` | 读自选池 | — |
| `write_watchlist(data: dict, date=None)` | 写自选池 | `data` |

**示例**：
```bash
cli.py read_watchlist --date 2026-07-05
```

## 三、复盘总结

读写 `data/daily-summary-{date}.json`。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_daily_summary(date=None)` | 读复盘总结 | — |
| `write_daily_summary(data: dict, date=None)` | 写复盘总结 | `data` |

**示例**：
```bash
cli.py read_daily_summary --date 2026-07-04
```

## 四、动态策略

读写 `memory/dynamic-strategy.md`（仅按需改写，复盘不自动写回）。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_dynamic_strategy()` | 读动态策略 | — |
| `write_dynamic_strategy(content: str)` | 改写动态策略 | `content` |

> data/*.json 的字段结构、必填项 → 见 journal.py docstring。

---

## 五、常见调用组合

```python
# 盘前 / 盯盘：读取昨日复盘 + 当前策略 + 今日日志
from skills.journal.journal import read_daily_summary, read_dynamic_strategy, read_trade_log
read_daily_summary()           # 昨日复盘（默认昨天传 --date）
read_dynamic_strategy()        # 当前策略
read_trade_log()               # 今日已发生的操作

# 下单后：追加操作记录
from skills.journal.journal import append_trade_action
append_trade_action("buy", "603019", "中科曙光", 45.0, 100, "主线龙头，符合买点")

# 盘后复盘：写每日总结 + 次日自选池
from skills.journal.journal import write_daily_summary, write_watchlist
write_daily_summary({"profit_loss": 1500.0, "reflection": "...", "next_day_plan": {...}})
write_watchlist({"main_line": "算力/芯片", "stocks": [...]}, date="2026-07-05")
```

> 总结上报到后台（HTTP）不在此 skill：调 mock 的 `report.submit_summary`。

---

## 六、调试

import 自检（`cwd = 项目根目录`，供人类开发者用）：

```bash
python -c "from skills.journal.journal import read_trade_log, write_trade_log, append_trade_action, read_watchlist, write_watchlist, read_daily_summary, write_daily_summary, read_dynamic_strategy, write_dynamic_strategy; print('ok')"
```

CLI runner 自检：

```bash
python skills/journal/cli.py --list            # 列出全部可用方法（验证 import 链）
python skills/journal/cli.py read_trade_log    # 端到端：读今日日志 + JSON 输出
```
