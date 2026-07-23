---
name: mock
description: >
  柚子 AI 的接口调用能力：行情查询、模拟交易、总结上报。
  覆盖盯盘、下单、复盘上报全链路。当用户提到大盘、板块、个股、热点、涨停、连板、
  情绪、买卖、持仓、委托、撤单、自选股、总结上报等任何与盯盘交易接口调用相关的操作时，
  使用此 skill。本地状态读写（交易日志 / 自选池 / 复盘总结 / 动态策略）见 journal skill。
compatibility: []
---

# 柚子 AI Skill — 行情、交易、总结上报（接口调用 SDK）

柚子 AI agent 的接口调用层入口（行情 / 交易 / 总结上报）。所有接口已封装为 Python SDK。本地状态读写（交易日志 / 自选池 / 复盘总结 / 动态策略）见 `skills/journal/SKILL.md`。

> **agent 调用 SDK 的唯一方式是 `cli.py`（见下方「CLI 调用方式」），禁止编写临时 .py 脚本去 import skills.mock**——曾因临时脚本写到项目工作目录之外触发 `external_directory` 权限拦截，导致整轮盯盘中断。`import` 形式仅供人类开发者在 REPL / 测试中使用。

**函数签名、入参、返回字段的权威定义在各 .py 的 docstring**，本文件只做索引。
字段表、枚举值、默认值、信封格式——请直接读对应函数的 docstring。

工作区根 = 项目根目录（脚本所在的最外层目录，下载解压即得、可任意重命名）。

## CLI 调用方式（agent 唯一入口）

`skills/mock/cli.py` 是通用方法调用器：一行命令调用 market / trading / report 任意方法，结果以 JSON 输出到 stdout。**agent 盯盘、下单、复盘所需的接口调用都走它**（本地状态读写见下方 journal skill 说明）。

```
python skills/mock/cli.py <module>.<method> [位置参数...] [--key value ...]
python skills/mock/cli.py --list          # 列出全部可用方法
python skills/mock/cli.py --help          # 打印用法
```

**盯盘高频调用**：

| 用途 | 命令 |
|------|------|
| 大盘汇总 | `cli.py market.get_summary` |
| LLM 盘面分析（决策核心） | `cli.py market.get_intraday_analysis` |
| 账号资金 | `cli.py trading.get_account` |
| 当前持仓 | `cli.py trading.get_positions` |
| 持仓分时（涨跌 + 主力，§0.6 加速止盈必需） | `cli.py market.get_stock_minute_trendline 300083` |
| 个股详情（hot_categories / up_reason 板块归属、turn_z 换手） | `cli.py market.get_stock_info 300083` |
| 严重异动禁买名单 | `cli.py market.get_key_watch_stocks` |
| 策略选股（创业板强趋势） | `cli.py market.get_strategy_trend_stocks 6` |
| 策略选股（创业+科创大趋势） | `cli.py market.get_strategy_trend_stocks 10` |
| 策略选股（沪深主板） | `cli.py market.get_strategy_trend_stocks 7` |
| 策略选股（大幅回撤） | `cli.py market.get_strategy_trend_stocks 21` |
| 本地状态读写（交易日志 / 自选池 / 复盘 / 策略） | 见 `skills/journal/SKILL.md`，走 `skills/journal/cli.py` |
| 盯盘 / 复盘总结上报 | `cli.py report.submit_summary watch "..."` |

**下单与记录**（写操作，参数在调用前校验，未知参数不会误下单）：

```
python skills/mock/cli.py trading.buy --stock_code 603019 --price 45.0 --volume 100
python skills/mock/cli.py trading.sell --stock_code 603019 --price 46.0 --volume 100
python skills/journal/cli.py append_trade_action buy 603019 中科曙光 45.0 100 "主线龙头符合买点"
```

**参数与输出约定**：

- 类型按方法签名注解自动转换：`stock_code`（str）的 `"603019"` 保持字符串，`strategy_id`（int）的 `"6"` 转 int；具名参数支持 `--key value` 与 `--key=value`
- 成功：方法返回值原样 JSON 输出（保留信封 `{code,message,data}` 契约）；返回 None 时输出 `{"ok": true}`
- 失败：输出结构化错误 JSON（`{code, error, method, ...}`）+ 退出码非零。`code: 400` 参数错、`404` 方法不存在、`500` 执行异常
- `.env`（`STOCK_SECRET_KEY`）由 `_http.py` 基于 `__file__` 自动加载，与 cwd 无关；`secret_key` 一般不传

## 快速开始

```python
from skills.mock.market import get_summary, get_stock_info, get_hot_spot_list
from skills.mock.trading import get_account, get_positions, buy, sell, cancel
from skills.journal.journal import read_trade_log, append_trade_action, read_dynamic_strategy
```

## 认证

- 远程接口（market / trading）通过 cookie 中的 `secret_key` 认证，无需手动传 `account_id`。
- 调用时**通常无需传 `secret_key`**，默认读 `.env` 中的 `STOCK_SECRET_KEY`。
- 需要切换账号时传 `secret_key="..."` 覆盖（仅 trading 写操作常用）。

## 统一响应格式

大部分接口返回**信封格式**：

```python
{"code": 200, "message": "success", "data": <业务数据>}
```

- `code: 200` 成功，`400` 参数错误，`404` 不存在，`500` 服务器错误
- 少数接口（如 `get_summary`、`get_indicator_trendline`、`get_stock_info`、`get_daily_k_data`）直接返回业务数据，无信封包装
- 具体每个接口是否带信封，以 docstring 为为准

---

## 一、行情查询 — `skills.mock.market`

大盘、板块、个股、热点、事件驱动、主题等行情数据，38 个 GET 接口 + 1 个 POST 选股接口。

**签名读法**（以 cli 调用为准）：

- 表中「签名」列直接抄自 `market.py` 函数定义，**位置参数顺序 = 签名顺序**
- 「必填」列只列出**无默认值的参数**（agent 必须显式传入，位置或 `--key` 均可）
- 有默认值的参数省略时自动用默认值；想覆盖就用具名参数 `--key value`
- `Optional[X] = None` 也算有默认值，不算必填

### 大盘 / 指标

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_summary()` | 大盘汇总（含 `stage` 字段，用于状态行展示；盯盘/复盘由外部调度器告知） | — |
| `get_zt_timeline()` | 今日涨停时间轴（盯盘页右上半区时间轴展示，含涨跌停类型 / 板块归属 / 涨停原因） | — |
| `get_indicator_trendline(code: str)` | 指标分时趋势线（平均股价/主力净额/大盘情绪温度等） | `code` |
| `get_daily_indicators_history(days: int = 30)` | 历史指标矩阵（复盘用） | — |

**示例**：
```bash
cli.py market.get_indicator_trendline temperature
cli.py market.get_daily_indicators_history --days 60
```

### 热点

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_hot_spot_list(sort_by="dr_count", sort_order="desc", limit=20)` | 热点分类列表 | — |
| `get_hot_spot_components(name, sort_by="zdf", sort_order="desc")` | 热点成分股（核心股） | `name` |
| `get_hot_spot_eliminated(name)` | 热点被淘汰股（跟风股） | `name` |
| `get_hot_spot_trendline(name)` | 热点主力资金分时趋势线 | `name` |
| `get_hot_spot_daily_stats(date=None)` | 某日热点统计（复盘用） | — |
| `get_hot_spot_daily_stats_batch(name, days=10)` | 多日热点统计 | `name` |
| `get_top_hot_spots(date=None, limit=10)` | 某日排名前 N 热点 | — |
| `get_hot_spot_components_by_date(name, date)` | 热点成分股历史快照 | `name`, `date` |

**示例**：
```bash
cli.py market.get_hot_spot_components 算力芯片                       # 位置参数
cli.py market.get_hot_spot_components 算力芯片 --sort_by main_amount # 位置+具名混用
cli.py market.get_top_hot_spots --date 2026-07-04 --limit 20
```

### 个股

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_stock_info(stock_code)` | 个股详情（市值/换手/热点标签/涨停原因） | `stock_code` |
| `get_daily_k_data(code, days=30)` | 日 K 线 | `code` |
| `get_stock_trendline(code)` | 个股当日分时 | `code` |
| `get_stock_minute_trendline(code)` | 个股分时多轴（涨跌幅 + 主力） | `code` |
| `get_stock_trendline_history(code, date)` | 个股历史分时（复盘用） | `code`, `date` |
| `get_stock_daily_history(code, days=5)` | 个股近 N 日 daily_stock 全量数据（复盘用） | `code` |
| `get_batch_stock_zdf(codes)` | 批量实时涨跌幅（逗号分隔代码） | `codes` |

**示例**：
```bash
cli.py market.get_stock_info 300083
cli.py market.get_stock_trendline 300083
cli.py market.get_stock_trendline_history 300083 2026-07-04
cli.py market.get_batch_stock_zdf --codes 300083,300750,002415
```

### 大盘排行

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_amount_top()` | 成交额前 30 | — |
| `get_large_cap_stocks()` | 大市值高涨幅（涨/跌各 20） | — |
| `get_main_outflow_top()` | 主力净流出前 20 | — |
| `get_main_inflow_top()` | 主力净流入前 20 | — |
| `get_hourly_hot_top(sort_by="rank")` | 小时热度榜前 30 | — |
| `get_consecutive_board_ladder(end_date=None)` | 近四日连板天梯 | — |
| `get_hot_spot_zt_stocks()` | 近三天热点涨停股汇总 | — |
| `get_hot_spot_rotation(days=5, top_n=9)` | 热点轮动 | — |
| `get_lianban_stocks(date=None, limit=200)` | 连板股列表 | — |
| `get_key_watch_stocks()` | 严重异动禁买名单 | — |

**示例**：
```bash
cli.py market.get_key_watch_stocks
cli.py market.get_lianban_stocks --limit 50
```

### 内置的策略选股

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_strategy_trend_stocks(strategy_id, mode="", limit=30)` | 策略选股（6 创业板强趋势 / 10 创业+科创大趋势 / 7 沪深主板 / 21 大幅回撤） | `strategy_id` |

**示例**：
```bash
cli.py market.get_strategy_trend_stocks 6             # 创业板强趋势
cli.py market.get_strategy_trend_stocks 10 --limit 50 # 创业+科创大趋势
cli.py market.get_strategy_trend_stocks 7             # 沪深主板
cli.py market.get_strategy_trend_stocks 21 --limit 30 # 大幅回撤
```

### 盘中 LLM 分析

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_intraday_analysis()` | 最新盘中 LLM 盘面分析（**agent 唯一权威源**，含 `position_limit` / `sentiment_label` / `action_advice` / `risk_warnings` 等完整 schema，见 `market.py#689-` 注释） | — |

**示例**：
```bash
cli.py market.get_intraday_analysis
```

### "今天炒什么"事件

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_jtcsm_events(days=1, limit=30)` | "今天炒什么"事件列表 | — |
| `get_jtcsm_event_stocks(event_id, date)` | 事件关联个股当日行情 | `event_id`, `date` |
| `get_stock_jtcsm_directions(code, days=5)` | 个股近期命中的"今天炒什么"概念 | `code` |
| `get_jtcsm_direction_stocks(event_id, exclude_code="")` | 概念标签下其他个股（实时行情） | `event_id` |

**示例**：
```bash
cli.py market.get_jtcsm_events --days 1 --limit 30
cli.py market.get_jtcsm_event_stocks evt_20260704_xxx 2026-07-04
```

### 主题

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_stock_theme_tags(code)` | 个股命中的"主题"标签 | `code` |
| `get_theme_stocks(theme_code, level2_code="", limit=15)` | 某主题下关联个股（实时行情） | `theme_code` |
| `get_hot_theme_list(limit=20, level_only=True, sort_field="dr_count", keyword="", sort_order="")` | 主题看板列表（按大肉/涨停/主力等排序） | — |
| `get_theme_stock_list(code, field="zdf", sort="desc", limit=15, keyword="")` | 主题看板个股（含分时曲线） | `code` |
| `get_theme_detail(code)` | 主题详情弹窗（分时曲线 + 近 10 日收盘 + 二级子主题） | `code` |

**示例**：
```bash
cli.py market.get_hot_theme_list --sort_field amount_main --limit 30
cli.py market.get_theme_stocks theme_001 --level2_code lvl2_001 --limit 20
cli.py market.get_theme_stock_list theme_001 --field amount_main --sort desc
cli.py market.get_theme_detail theme_001
```

### 选股（POST）

| 函数 | 用途 | 必填 |
|------|------|------|
| `nl_pick(query)` | 自然语言选股（LLM 解析 → DSL → basic/ma/window/concept 四组交集，POST） | `query` |

**示例**：
```bash
cli.py market.nl_pick "20日涨幅>10%且换手率>3%的创业板股"
cli.py market.nl_pick "【AI】，非ST，多头排列，按涨跌幅排序"
cli.py market.nl_pick "【算力】【光模块】，创业板"
```

> 概念关键词用 `【】` 全角方括号包裹，**本地正则提取不经 LLM**，在主题 / 热点 / 今日炒什么 三个维度合并 LIKE 搜索；多个 `【】` 之间为 AND 关系。限流、DSL 原语与错误信封 code → 见 market.py `nl_pick` docstring。

---

## 二、模拟交易 — `skills.mock.trading`

账号、持仓、委托、买卖、撤单、自选管理、历史成交、主题/事件关注管理，26 个接口。写操作需登录态（cookie 自动携带）。

**签名读法**：同行情接口。「必填」列只列无默认值的参数。所有写操作（buy/sell/cancel/add_favorite/...）的 `secret_key` 都有默认（读 `.env` 的 `STOCK_SECRET_KEY`），一般不传；需要切换账号时用具名参数 `--secret_key ...` 覆盖。

### 账号 / 持仓 / 委托

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_account()` | 账号资金（余额/可用/市值/盈亏） | — |
| `get_positions()` | 当前持仓列表 | — |
| `get_orders(secret_key=None, start_time=None, end_time=None)` | 当日委托列表（时间戳为 Unix 秒，`secret_key` 在 SDK 签名首位，**强烈建议用具名参数**） | — |
| `get_trade_history(limit=100)` | 历史成交记录 | — |
| `get_match_logs(stock_code="", order_no="", log_date=0)` | 委托撮合日志（`log_date` 当天 0 点 Unix 秒） | — |
| `get_profit_curve()` | 账号收益率曲线（近 1 年） | — |
| `get_stock_price(stock_code)` | 实时价格（下单前确认） | `stock_code` |

**示例**：
```bash
cli.py trading.get_account
cli.py trading.get_positions
cli.py trading.get_orders
cli.py trading.get_orders --start_time 1720166400 --end_time 1720252799
cli.py trading.get_stock_price 603019
```

### 下单 / 撤单（写操作）

| 函数 | 用途 | 必填 | 位置参数顺序 |
|------|------|------|--------------|
| `buy(stock_code="", price=0, volume=0, secret_key=None)` | 买入下单（数量须 100 整数倍） | `stock_code`, `price`, `volume` | 1.stock_code 2.price 3.volume |
| `sell(stock_code="", price=0, volume=0, secret_key=None)` | 卖出下单（≤ `available_volume`，T+1） | `stock_code`, `price`, `volume` | 1.stock_code 2.price 3.volume |
| `cancel(order_no="", secret_key=None)` | 撤单（仅待报/已报可撤） | `order_no` | 1.order_no |

**示例**：
```bash
# 位置参数（顺序：代码 → 价格 → 数量）
cli.py trading.buy 603019 45.0 100
cli.py trading.sell 603019 46.0 100

# 具名参数（顺序无关）
cli.py trading.buy --stock_code 603019 --price 45.0 --volume 100
cli.py trading.cancel --order_no O20260706143012345678
```

> buy / sell 内部会按 `BUY_PRICE_PREMIUM`（默认 0.6%）小幅上浮委托价以提升撮合优先级。

### 自选股

| 函数 | 用途 | 必填 |
|------|------|------|
| `add_favorite(stock_code, stock_name="", add_price=0, remark="")` | 添加自选股 | `stock_code` |
| `remove_favorite(stock_code)` | 移除自选股 | `stock_code` |
| `get_favorite_list()` | 自选股列表（含实时行情） | — |
| `check_favorite(stock_code)` | 是否已在自选 | `stock_code` |
| `search_stocks(keyword)` | 模糊搜索股票（代码/名称） | `keyword` |

**示例**：
```bash
cli.py trading.add_favorite 603019 --stock_name 中科曙光 --add_price 45.0 --remark 主线龙头
cli.py trading.search_stocks 曙光
```

### 关注主题

| 函数 | 用途 | 必填 |
|------|------|------|
| `add_favorite_theme(theme_code, theme_name="")` | 关注主题 | `theme_code` |
| `remove_favorite_theme(theme_code)` | 取消关注主题 | `theme_code` |
| `get_favorite_theme_list()` | 关注主题列表 | — |
| `check_favorite_theme(theme_code)` | 主题是否已关注 | `theme_code` |
| `get_favorite_theme_stocks(field="zdf", sort="desc")` | 各关注主题成分股聚合 | — |
| `get_favorite_theme_block_stocks(theme_code, field="zdf", sort="desc")` | 单个关注主题成分股 | `theme_code` |

**示例**：
```bash
cli.py trading.add_favorite_theme theme_001 --theme_name 算力
cli.py trading.get_favorite_theme_stocks --field amount_main --sort desc
cli.py trading.get_favorite_theme_block_stocks theme_001 --field zdf --sort desc
```

### 关注"今日炒什么"事件

| 函数 | 用途 | 必填 |
|------|------|------|
| `add_favorite_jtcsm(event_id, event_name="", trade_date="")` | 关注事件（trade_date 必填 YYYY-MM-DD） | `event_id`, `trade_date` |
| `remove_favorite_jtcsm(event_id)` | 取消关注事件 | `event_id` |
| `get_favorite_jtcsm_list()` | 关注事件列表 | — |
| `check_favorite_jtcsm(event_id)` | 事件是否已关注 | `event_id` |
| `get_favorite_jtcsm_stocks(field="zdf", sort="desc")` | 各关注事件成分股聚合 | — |
| `get_favorite_jtcsm_block_stocks(event_id, field="zdf", sort="desc")` | 单个关注事件成分股 | `event_id` |

**示例**：
```bash
cli.py trading.add_favorite_jtcsm evt_20260704_xxx --event_name 算力 --trade_date 2026-07-04
cli.py trading.get_favorite_jtcsm_block_stocks evt_20260704_xxx --field amount_main --sort desc
```

> 委托状态枚举、返回结构、T+1 与涨跌停约束 → 见 trading.py docstring。

---

## 三、总结上报 — `skills.mock.report`

把盯盘 / 复盘总结上报到后台（写入 mock_log 表），属于接口调用层（依赖 `_http`）。
本地状态读写（交易日志 / 自选池 / 复盘总结 / 动态策略）已拆分到独立 skill `skills.journal`，
走 `python skills/journal/cli.py <method>`（见 `skills/journal/SKILL.md`）。

| 函数 | 用途 | 必填 |
|------|------|------|
| `submit_summary(log_type, content, date=None, secret_key=None)` | 上报盯盘 / 复盘总结到后台（写入 mock_log 表），失败不影响主流程 | `log_type`, `content` |

**示例**：
```bash
# 盯盘总结（log_type=watch）
cli.py report.submit_summary watch "情绪偏激进，活跃 AI 算力，仓位 65%，买入工业富联"

# 复盘总结（log_type=review）
cli.py report.submit_summary review "今日盈亏 +1.2%，主线 AI 算力，反思止损执行到位"
cli.py report.submit_summary watch "..." --date 2026-07-09
```

> `log_type` 仅支持 `watch`（盯盘）/ `review`（复盘）。上报为「尽力而为」：网络 / 服务异常时返回错误信封但不抛异常，不影响已产出的总结内容与下一轮盯盘。

---

## 四、常见调用组合

```python
# 阶段检测（当前要做盯盘还是复盘由外部调度器告知，此处只取大盘汇总）
from skills.mock.market import get_summary
summary = get_summary()   # 含 stage 等大盘汇总字段，用于状态行展示

# 买入流程：查价 → 查资金 → 下单 → 查委托
from skills.mock.trading import get_stock_price, get_account, buy, get_orders
get_stock_price("603019")
buy(stock_code="603019", price=45.0, volume=100)
get_orders()

# 卖出流程：查持仓（确认 available_volume）→ 查价 → 下单
from skills.mock.trading import get_positions, sell
pos = get_positions()["data"]
sell(stock_code="603019", price=46.0, volume=100)

# 记录一笔操作 + 读策略（本地状态读写走 journal skill）
from skills.journal.journal import append_trade_action, read_dynamic_strategy
append_trade_action("buy", "603019", "中科曙光", 45.0, 100, "主线龙头，符合买点")
read_dynamic_strategy()
```

---

## 五、调试

import 自检（`cwd = 项目根目录`，供人类开发者用）：

```bash
python -c "from skills.mock.market import get_summary, get_hot_theme_list, get_theme_stock_list, nl_pick; from skills.mock.trading import buy, get_profit_curve, add_favorite_theme, add_favorite_jtcsm; from skills.journal.journal import read_trade_log; print('ok')"
```

CLI runner 自检（agent 实际使用的入口）：

```bash
python skills/mock/cli.py --list            # 列出全部可用方法（验证 import 链）
python skills/mock/cli.py market.get_summary  # 端到端：真实请求 + JSON 输出
```
