---
name: mock
description: >
  柚子 AI 的接口调用能力：行情查询、模拟交易、总结上报。
  覆盖盯盘、下单、复盘上报全链路。当用户提到大盘、板块、个股、热点、涨停、连板、
  情绪、买卖、持仓、委托、撤单、总结上报等任何与盯盘交易接口调用相关的操作时，
  使用此 skill。本地状态读写（市场阶段状态机 / 动态策略）见 journal skill。
compatibility: []
---

# 柚子 AI Skill — 行情、交易、总结上报（接口调用 SDK）

柚子 AI agent 的接口调用层入口（行情 / 交易 / 总结上报）。所有接口已封装为 TypeScript SDK。本地状态读写（市场阶段状态机 / 动态策略）见 `skills/journal/SKILL.md`。

> **agent 调用 SDK 的唯一方式是 `node skills/mock/cli.ts`（见下方「CLI 调用方式」），禁止编写临时脚本去 import skills/mock 模块**——曾因临时脚本写到项目工作目录之外触发 `external_directory` 权限拦截，导致整轮盯盘中断。`import` 形式仅供人类开发者在 REPL / 测试中使用。

**函数签名、入参、返回字段的权威定义在各 .ts 源码的 docstring（skills/mock/ 与 skills/journal/）**，本文件只做索引。
字段表、枚举值、默认值、信封格式——请直接读对应函数的 docstring。

工作区根 = 项目根目录（脚本所在的最外层目录，下载解压即得、可任意重命名）。

## CLI 调用方式（agent 唯一入口）

`skills/mock/cli.ts` 是通用方法调用器：一行命令调用 market / trading / report 任意方法，结果以 JSON 输出到 stdout。**agent 盯盘、下单、复盘所需的接口调用都走它**（本地状态读写见下方 journal skill 说明）。

```
node skills/mock/cli.ts <module>.<method> [位置参数...] [--key value ...]
node skills/mock/cli.ts --list          # 列出全部可用方法
node skills/mock/cli.ts --help          # 打印用法
```

**盯盘高频调用**：

| 用途 | 命令 |
|------|------|
| 大盘汇总 | `mock/cli.ts market.get_summary` |
| LLM 盘面分析（决策核心） | `mock/cli.ts market.get_intraday_analysis` |
| **市场节点（盘中第 0 步，云端唯一权威）** | `mock/cli.ts market.read_market_node` |
| 账号资金 | `mock/cli.ts trading.get_account` |
| 当前持仓 | `mock/cli.ts trading.get_positions` |
| 持仓分时（涨跌 + 主力，§0.6 加速止盈必需） | `mock/cli.ts market.get_stock_minute_trendline 300083` |
| 个股详情（hot_categories / up_reason 板块归属、turn_z 换手） | `mock/cli.ts market.get_stock_info 300083` |
| 严重异动禁买名单 | `mock/cli.ts market.get_key_watch_stocks` |
| 策略选股（今日趋势，创业+科创大趋势池） | `mock/cli.ts market.get_strategy_trend_stocks 10` |
| 策略选股（今日异动拉升） | `mock/cli.ts market.get_strategy_trend_stocks 4` |
| 策略选股（近期异动上涨） | `mock/cli.ts market.get_strategy_trend_stocks 5` |
| 策略选股（大幅回撤） | `mock/cli.ts market.get_strategy_trend_stocks 21` |
| 本地状态读写（市场阶段状态机 / 动态策略） | 见 `skills/journal/SKILL.md`，走 `node skills/journal/cli.ts <method>` |
| 盯盘 / 复盘总结上报 | `mock/cli.ts report.submit_summary watch "..."` |

**下单与记录**（写操作，参数在调用前校验，未知参数不会误下单）：

```
node skills/mock/cli.ts trading.buy --stock_code 603019 --price 45.0 --volume 100
node skills/mock/cli.ts trading.sell --stock_code 603019 --price 46.0 --volume 100
```

**参数与输出约定**：

- 类型按方法签名注解自动转换：`stock_code`（str）的 `"603019"` 保持字符串，`strategy_id`（int）的 `"6"` 转 int；具名参数支持 `--key value` 与 `--key=value`
- **按需取数约束（CLI 层硬闸，注册表 `skills/mock/cli.ts` _PARAM_CONSTRAINTS）**：重数据接口在 CLI 层收敛默认值 / 范围——`get_daily_k_data` days 默认 10（钳 5~15）、`get_stock_daily_history` days 默认 5（钳 1~15）、`get_hot_spot_list` limit 默认 10（钳 1~20）、`get_strategy_trend_stocks` limit 默认 50（钳 1~100）且 **with_intraday CLI 默认 false**（分时占响应 90%+，纯列表选股不传即省）、**with_analysis 默认 true**（附加 ma5/10/20/30、zdf_high/zdf_low、amount_main_ratio 分析辅助字段，LLM 趋势初筛用；纯展示场景可传 false 省流）、`get_trade_history` limit 默认 20（钳 1~50）。**直接按默认调用即可，禁止拼 `| node -e` 管道二次过滤**；显式传参以传入值为准（越界自动钳到范围）；SDK import 形式不受影响
- 分时接口（`get_stock_trendline` / `get_stock_minute_trendline`）已裁掉未到时间点的尾部 null 占位（盘中只返回已到时间的数据）；`get_stock_info` 已剥离 `reason_items` 长文本字段（docstring 未承诺该字段）
- 成功：方法返回值原样 JSON 输出（保留信封 `{code,message,data}` 契约）；返回 None 时输出 `{"ok": true}`
- 失败：输出结构化错误 JSON（`{code, error, method, ...}`）+ 退出码非零。`code: 400` 参数错、`404` 方法不存在、`500` 执行异常
- `.env`（`STOCK_SECRET_KEY`）由 `env.ts` 基于项目根定位自动加载，与 cwd 无关；`secret_key` 一般不传

## 快速开始

```bash
node skills/mock/cli.ts market.get_summary
node skills/mock/cli.ts market.read_market_node   # 市场节点（云端唯一权威）
node skills/mock/cli.ts market.get_stock_info --stock_code 603019
```

## 认证

- 远程接口（market / trading）通过 cookie 中的 `secret_key` 认证，无需手动传 `account_id`。
- 调用时**通常无需传 `secret_key`**，默认读 `.env` 中的 `STOCK_SECRET_KEY`。
- 需要切换账号时传 `secret_key="..."` 覆盖（仅 trading 写操作常用）。

## 统一响应格式

大部分接口返回**信封格式**：

```bash
{"code": 200, "message": "success", "data": <业务数据>}
```

- `code: 200` 成功，`400` 参数错误，`404` 不存在，`500` 服务器错误
- 少数接口（如 `get_summary`、`get_indicator_trendline`、`get_stock_info`、`get_daily_k_data`）直接返回业务数据，无信封包装
- 具体每个接口是否带信封，以 docstring 为为准

---

## 一、行情查询 — `skills.mock.market`

大盘、板块、个股、热点、事件驱动、主题等行情数据，38 个 GET 接口 + 1 个 POST 选股接口。

**签名读法**（以 cli 调用为准）：

- 表中「签名」列直接抄自 `skills/mock/market.ts` 函数定义，**位置参数顺序 = 签名顺序**
- 「必填」列只列出**无默认值的参数**（agent 必须显式传入，位置或 `--key` 均可）
- 有默认值的参数省略时自动用默认值；想覆盖就用具名参数 `--key value`
- `Optional[X] = None` 也算有默认值，不算必填

### 大盘 / 指标

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_summary()` | 大盘汇总（含 `stage` 字段，用于状态行展示；盯盘/复盘由外部调度器告知） | — |
| `get_zt_timeline()` | 今日涨停时间轴（盯盘页右上半区时间轴展示，含涨跌停类型 / 板块归属 / 涨停原因） | — |
| `get_indicator_trendline(code: str)` | 指标分时趋势线（平均股价/主力净额/大盘情绪温度等） | `code` |
| `get_daily_indicators_history()` | 历史指标矩阵（复盘用） | — |
| `get_daily_summary(date=None, since=None)` | 全天异动时间轴（复盘用，`since=HH:MM` 增量拉取） | — |

**示例**：
```bash
mock/cli.ts market.get_indicator_trendline temperature
mock/cli.ts market.get_daily_indicators_history
mock/cli.ts market.get_daily_summary --date 2026-08-13
mock/cli.ts market.get_daily_summary --since 10:30   # 增量：仅返回 time >= 10:30 的时间桶
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
mock/cli.ts market.get_hot_spot_components 算力芯片                       # 位置参数
mock/cli.ts market.get_hot_spot_components 算力芯片 --sort_by main_amount # 位置+具名混用
mock/cli.ts market.get_top_hot_spots --date 2026-07-04 --limit 20
```

### 个股

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_stock_info(stock_code)` | 个股详情（市值/换手/热点标签/涨停原因） | `stock_code` |
| `get_daily_k_data(code, days=30)` | 日 K 线 | `code` |
| `get_stock_trendline(code)` | 个股当日分时 | `code` |
| `get_stock_minute_trendline(code)` | 个股分时多轴（涨跌幅全序列 + 主力净额快照单值） | `code` |
| `get_stock_trendline_history(code, date)` | 个股历史分时（复盘用） | `code`, `date` |
| `get_stock_daily_history(code, days=5)` | 个股近 N 日 daily_stock 全量数据（复盘用字段口径；盘中日 K 判定统一走 `get_daily_k_data`，勿双拉） | `code` |
| `get_batch_stock_zdf(codes)` | 批量实时涨跌幅（逗号分隔代码） | `codes` |

**示例**：
```bash
mock/cli.ts market.get_stock_info 300083
mock/cli.ts market.get_stock_trendline 300083
mock/cli.ts market.get_stock_trendline_history 300083 2026-07-04
mock/cli.ts market.get_batch_stock_zdf --codes 300083,300750,002415
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
| `get_hot_spot_rotation(days=5, top_n=9)` | 热点轮动（客户端组合 daily_stats 组装） | — |
| `get_lianban_stocks(date=None, limit=200)` | 连板股列表 | — |
| `get_key_watch_stocks()` | 严重异动禁买名单 | — |

**示例**：
```bash
mock/cli.ts market.get_key_watch_stocks
mock/cli.ts market.get_lianban_stocks --limit 50
```

### 内置的策略选股

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_strategy_trend_stocks(strategy_id, mode="", limit=50, with_intraday=True, sort_by="")` | 策略选股（需登录；`sort_by="pool"` = 策略池自身顺序，空 = 默认实时涨幅降序。盘中：1 今日大面 / 5 近期异动上涨 / 6 创业板强趋势 / 7 主板趋势 / 9 成交额巨大 / 10 创业科创趋势 / 21 大幅回撤 / 22 百日新高 / 23 今日强势回撤；盘后：2 昨日大面 / 8 涨幅巨大 / 24 最近多板 / 25 近期烂板 / 26 昨日烂板 / 27 昨日断板 / 28 昨日涨停 / 29 昨日强势回撤。**CLI 默认 `with_intraday=false`**（分时占响应 90%+，纯列表选股不传即省；确需分时曲线传 `--with_intraday true`）；**`with_analysis` 默认 true**（附加 ma5/ma10/ma20/ma30 均价、zdf_high/zdf_low 日内区间、amount_main_ratio 主力占比 7 个分析辅助字段，趋势初筛直接用；服务端对盯盘页等纯展示场景默认不下发省流） | `strategy_id` |

**示例**：
```bash
mock/cli.ts market.get_strategy_trend_stocks 10 --limit 50 # 今日趋势（创业+科创大趋势池）
mock/cli.ts market.get_strategy_trend_stocks 21 --limit 30 # 近期大幅回撤
mock/cli.ts market.get_strategy_trend_stocks 22            # 近期百日新高
mock/cli.ts market.get_strategy_trend_stocks 28            # 昨日涨停
```

### 盘中 LLM 分析与市场节点（决策核心）

| 函数 | 用途 | 必填 |
|------|------|------|
| `get_intraday_analysis()` | 最新盘中 LLM 盘面分析（**agent 唯一权威源**，含 `position_limit` / `sentiment_label` / `action_advice` / `risk_warnings` 等完整 schema，见 `skills/mock/market.ts` `getIntradayAnalysis` docstring）。**云端增强字段**：`market_node`（短线主引擎实时节点，十词：冰点 / 连续冰点 / 冰点回暖 / 升温 / 连续升温 / 高潮 / 连续高潮 / 高潮降温 / 降温 / 连续降温——当日操作语义的唯一节点权威）、`temperature_level`（大盘五档：冰点 / 偏冷 / 常温 / 偏热 / 亢奋——当帧大盘条件的结构化来源，替代标签文本）、`temperature_delta`（当帧 − 昨收差值，机读参考、仅日志） | — |
| `read_market_node()` | **市场节点读取 + 通道资格派生**（盘中每轮第 0 步；云端唯一权威、本地零判定零重放）：拉盘中帧实时节点 + 日级链昨日定格节点 → 无状态组合派生通道资格。返回 `effective_node`（生效节点）、`node_degraded`（当帧缺位降级标记）、`channels`（a_open / a2_open / b_open / c_open / d_open / ef_open——通道资格映射契约见 `memory/strategies/00-market-node.md`）、`forbidden_new_position` / `realize_only`（卖侧基调）、`temperature_level`、`yesterday_node` / `yesterday_score`。`code != 200`（502 防守信封）→ 当日按防守处理并记录，下轮自动重试 | — |
| `get_market_node_series(days=90)` | 双链情绪节点结构化序列（日级 `sentiment_chain: [{date, score, node}]` + `market_chain: [{date, score, level, node, has_alert}]`，倒序；`today_included` 盘中 false / 盘后 true）——复盘叙述与节点链回看源。days 默认 90、CLI 钳 30~120 | — |

**示例**：
```bash
mock/cli.ts market.get_intraday_analysis
mock/cli.ts market.read_market_node        # 市场节点（盘中第 0 步，云端唯一权威）
mock/cli.ts market.get_market_node_series  # 日级节点链（回看 / 复盘叙述）
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
mock/cli.ts market.get_jtcsm_events --days 1 --limit 30
mock/cli.ts market.get_jtcsm_event_stocks evt_20260704_xxx 2026-07-04
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
mock/cli.ts market.get_hot_theme_list --sort_field amount_main --limit 30
mock/cli.ts market.get_theme_stocks theme_001 --level2_code lvl2_001 --limit 20
mock/cli.ts market.get_theme_stock_list theme_001 --field amount_main --sort desc
mock/cli.ts market.get_theme_detail theme_001
```

### 选股（POST）

| 函数 | 用途 | 必填 |
|------|------|------|
| `nl_pick(query)` | 自然语言选股（LLM 解析 → DSL → basic/ma/window/concept 四组交集，POST） | `query` |

**示例**：
```bash
mock/cli.ts market.nl_pick "20日涨幅>10%且换手率>3%的创业板股"
mock/cli.ts market.nl_pick "【AI】，非ST，多头排列，按涨跌幅排序"
mock/cli.ts market.nl_pick "【算力】【光模块】，创业板"
```

> 概念关键词用 `【】` 全角方括号包裹，**本地正则提取不经 LLM**，在主题 / 热点 / 今日炒什么 三个维度合并 LIKE 搜索；多个 `【】` 之间为 AND 关系。限流、DSL 原语与错误信封 code → 见 skills/mock/market.ts `nlPick` docstring。

---

## 二、模拟交易 — `skills.mock.trading`

账号、持仓、委托、买卖、撤单、历史成交，10 个接口。写操作需登录态（cookie 自动携带）。

**签名读法**：同行情接口。「必填」列只列无默认值的参数。所有写操作（buy/sell/cancel）的 `secret_key` 都有默认（读 `.env` 的 `STOCK_SECRET_KEY`），一般不传；需要切换账号时用具名参数 `--secret_key ...` 覆盖。

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
mock/cli.ts trading.get_account
mock/cli.ts trading.get_positions
mock/cli.ts trading.get_orders
mock/cli.ts trading.get_orders --start_time 1720166400 --end_time 1720252799
mock/cli.ts trading.get_stock_price 603019
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
mock/cli.ts trading.buy 603019 45.0 100
mock/cli.ts trading.sell 603019 46.0 100

# 具名参数（顺序无关）
mock/cli.ts trading.buy --stock_code 603019 --price 45.0 --volume 100
mock/cli.ts trading.cancel --order_no O20260706143012345678
```

> buy / sell 内部会按 `BUY_PRICE_PREMIUM`（默认 0.6%）小幅上浮委托价以提升撮合优先级。

> 委托状态枚举、返回结构、T+1 与涨跌停约束 → 见 skills/mock/trading.ts docstring。

---

## 三、总结上报 — `skills.mock.report`

把盯盘 / 复盘总结上报到后台（写入 mock_log 表），属于接口调用层（依赖 `http.ts`）。
本地状态读写（市场阶段状态机 / 动态策略）已拆分到独立 skill `skills.journal`，
走 `node skills/journal/cli.ts <method>`（见 `skills/journal/SKILL.md`）。

| 函数 | 用途 | 必填 |
|------|------|------|
| `submit_summary(log_type, content, date=None, secret_key=None)` | 上报盯盘 / 复盘总结到后台（写入 mock_log 表），失败不影响主流程 | `log_type`, `content` |

**示例**：
```bash
# 盯盘总结（log_type=watch）
mock/cli.ts report.submit_summary watch "情绪偏激进，活跃 AI 算力，仓位 65%，买入工业富联"

# 复盘总结（log_type=review）
mock/cli.ts report.submit_summary review "今日盈亏 +1.2%，主线 AI 算力，反思止损执行到位"
mock/cli.ts report.submit_summary watch "..." --date 2026-07-09
```

> `log_type` 仅支持 `watch`（盯盘）/ `review`（复盘）。上报为「尽力而为」：网络 / 服务异常时返回错误信封但不抛异常，不影响已产出的总结内容与下一轮盯盘。

---

## 四、常见调用组合

```bash
# 阶段检测（当前要做盯盘还是复盘由外部调度器告知，此处只取大盘汇总）
from skills.mock.market import get_summary
summary = get_summary()   # 含 stage 等大盘汇总字段，用于状态行展示

# 买入流程：查价 → 下单 → 一笔持仓快照确认成交（善后核验收敛，见总纲 §7.1 第 4 条）
from skills.mock.trading import get_stock_price, buy, get_positions
get_stock_price("603019")
buy(stock_code="603019", price=45.0, volume=100)
get_positions()   # 成交确认以此快照为准；委托状态看下单返回或机械层「当日委托」注入，不再自调 get_orders

# 卖出流程：查持仓（确认 available_volume，当日买入为 0 不可卖）→ 查价 → 限价挂最新价附近下单（撮合由服务端完成，无需关心撮合细节）→ 一笔持仓快照确认
from skills.mock.trading import get_positions, get_stock_price, sell
pos = get_positions()["data"]
get_stock_price("603019")
sell(stock_code="603019", price=46.0, volume=100)

# 读市场节点（云端唯一权威）+ 读策略（动态策略本地读写走 journal skill）
node skills/mock/cli.ts market.read_market_node
node skills/journal/cli.ts read_dynamic_strategy
```

---

## 五、调试

import 自检（`cwd = 项目根目录`，供人类开发者用）：

```bash
node skills/mock/cli.ts --list   # 列出全部可用方法（验证加载链）
```

CLI runner 自检（agent 实际使用的入口）：

```bash
node skills/mock/cli.ts --list            # 列出全部可用方法（验证 import 链）
node skills/mock/cli.ts market.get_summary  # 端到端：真实请求 + JSON 输出
```
