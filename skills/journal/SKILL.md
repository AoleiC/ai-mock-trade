---
name: journal
description: >
  柚子 AI 的本地状态读写能力：市场阶段状态机（regime）、动态策略。
  纯本地文件操作，不依赖网络接口。当用户提到动态策略读写、
  市场阶段 / 状态机 / regime / 试错通道资格 / 盘中自愈重建等本地状态
  持久化操作时，使用此 skill。总结上报（submit_summary）属于接口调用，见 mock skill。
compatibility: []
---

# 柚子 AI Skill — 本地状态读写

柚子 AI agent 的本地状态持久化入口。负责读写 `data/regime-state.json` 与 `memory/dynamic-strategy.md`，与 mock（接口调用：行情 / 交易 / 总结上报）物理隔离、各自独立 cli。盯盘 / 复盘总结全文（`data/watch-summary-{date}.md` / `data/review-summary-{date}.md`）由调度器从 run log 自动归档，不经本 skill（总纲 §7.1 / §10.1）。

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

> 注意：本 skill 不带 `module.` 前缀（mock 是 `market.get_summary`，journal 是 `read_regime_state`），因为 journal skill 单模块。

**高频调用**：

| 用途 | 命令 |
|------|------|
| 当日生效阶段（盘中第 0 步） | `cli.py read_regime_state --trade_date 2026-09-09` |
| 当前动态策略 | `cli.py read_dynamic_strategy` |

**写操作**（参数在调用前校验，未知参数会报错不会误写）：

```
python skills/journal/cli.py write_dynamic_strategy --content '...'
python skills/journal/cli.py regime_rebuild --raw @raw.json --write_back true --before_date 2026-09-09
```

**参数与输出约定**：

- 类型按方法签名注解自动转换：dict/list 走 JSON（支持 `@文件路径` 引用）；具名参数支持 `--key value` 与 `--key=value`
- 成功：方法返回值原样 JSON 输出；返回 None 时输出 `{"ok": true}`
- 失败：输出结构化错误 JSON（`{code, error, method, ...}`）+ 退出码非零。`code: 400` 参数错、`404` 方法不存在、`500` 执行异常

## 快速开始

```python
from skills.journal.journal import (
    read_regime_state, regime_advance, regime_rebuild,
    read_dynamic_strategy, write_dynamic_strategy,
)
```

## 认证

本 skill 为纯本地文件读写，**无需认证**，不依赖 cookie / secret_key。
总结上报（HTTP 接口）见 mock skill 的 `report.submit_summary`。

---

## 一、市场阶段状态机（裁决层执行权威）

读写 `data/regime-state.json`（滚动单文件，原子覆盖写，不按日清理）。转移规则人审表述见 `memory/strategies/00-regime-machine.md`，**执行唯一权威是本节三个方法**，agent 只读输出、禁止手工推演转移表。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_regime_state(trade_date=None)` | 盘中每轮第 0 步读当前阶段 + 试错通道资格（A/A2/B 共用）+ 陈旧/长假防御检测 | — |
| `regime_advance(trade_date, s, d=None)` | 手工补推进一个交易日（保留工具；常态推进由盘中自愈 `regime_rebuild` 承担，复盘不再推进；s 缺值传 None 走缺数日规则；**d 建议传接口原文**（如 `"修复(35)"`）——数值落库、标签作乐观转移背书，纯数字传入时标签缺位 = 背书不通过） | `trade_date` / `s` |
| `regime_rebuild(raw: dict, write_back=False, before_date=None)` | 从 `get_daily_indicators_history` 返回结构纯函数重放重建（支持信封自动解包；`before_date` 只重放该日之前，盘中自愈必传当日） | `raw` |

**示例**：
```bash
# 盘中读（defensive_reason 非空或 code != 200 → 当日按防守处理并记录）
cli.py read_regime_state --trade_date 2026-09-07

# 盘后推进（s 为当日收盘短线温度定格值；d 传接口原文，标签用于乐观转移背书——进升温/高潮需大盘 ∈ {修复, 升温}）
cli.py regime_advance 2026-09-04 15 "修复(35)"
cli.py regime_advance 2026-09-05 None "退潮(30)"   # s 缺值日

# 重建（raw 支持 @文件引用与整个接口信封；write_back=true 才写回状态文件）
cli.py regime_rebuild --raw @/tmp/history.json --write_back true
# 盘中自愈：--before_date 传当日，排除当日盘中临时值，只重放到最近已完成交易日
cli.py regime_rebuild --raw '<接口返回JSON>' --write_back true --before_date 2026-09-07
```

## 二、动态策略

读写 `memory/dynamic-strategy.md`（仅按需改写，复盘不自动写回）。

| 函数 | 用途 | 必填 |
|------|------|------|
| `read_dynamic_strategy()` | 读动态策略 | — |
| `write_dynamic_strategy(content: str)` | 改写动态策略 | `content` |

## 三、常见调用组合

```python
# 盘中第 0 步：读当日生效阶段（缺 / 落后即自愈重建）
from skills.journal.journal import read_regime_state, regime_rebuild
```

> 总结上报到后台（HTTP）不在此 skill：调 mock 的 `report.submit_summary`。

---

## 四、调试

import 自检（`cwd = 项目根目录`，供人类开发者用）：

```bash
python -c "from skills.journal.journal import read_regime_state, regime_advance, regime_rebuild, read_dynamic_strategy, write_dynamic_strategy; print('ok')"
```

CLI runner 自检：

```bash
python skills/journal/cli.py --list                              # 列出全部可用方法（验证 import 链）
python skills/journal/cli.py read_regime_state --trade_date 2026-09-09   # 端到端：读当日生效阶段 + JSON 输出
```
